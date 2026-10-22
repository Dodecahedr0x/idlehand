import json
import subprocess
from pathlib import Path

from idlehand.analytics import render_text
from idlehand.config import ensure_home, load_sources, save_config, save_peers, save_sources
from idlehand.loop import _workspace, tick
from tests.support import BROKEN_FILES, KEY_FILES, SAMPLE_FILES, make_repo


def _ready(home: Path, **updates):
    config = ensure_home(home)
    config["sandbox"]["execute"] = False
    config["publish"]["peer_fetch_interval_seconds"] = 0
    config["loop_interval_seconds"] = 0.01
    config.update(updates)
    save_config(home, config)
    return config


def _connect(home: Path, tmp_path: Path, monkeypatch, name: str = "claude"):
    bin_dir = tmp_path / "bin"
    bin_dir.mkdir(exist_ok=True)
    invoked = tmp_path / f"{name}-invoked"
    script = bin_dir / name
    script.write_text(f"#!/bin/sh\necho hit >> '{invoked}'\npwd >> '{invoked}'\n", encoding="utf-8")
    script.chmod(0o755)
    monkeypatch.setenv("PATH", f"{bin_dir}:/usr/bin:/bin")
    monkeypatch.setenv("ANTHROPIC_API_KEY", "sk-anthropic")
    monkeypatch.setenv("GH_TOKEN", "gh-secret")
    return invoked


def _local_source(home: Path, tmp_path: Path, files: dict[str, str] | None = None) -> str:
    url = make_repo(tmp_path / "sample", files or SAMPLE_FILES)
    save_sources(home, [{"url": url, "note": "local"}])
    return url


def test_connected_loop_runs_sandboxed_actions_without_the_cli(tmp_path: Path, monkeypatch) -> None:
    home = tmp_path / "home"
    invoked = _connect(home, tmp_path, monkeypatch)
    config = _ready(home)
    config["subscription"] = "claude"
    config["spending_limit_tokens"] = 400
    config["estimate_tokens_per_cycle"] = 100
    config["sandbox"]["execute"] = True
    config["sandbox"]["runtime"] = "namespace"
    save_config(home, config)
    url = _local_source(home, tmp_path)
    source_head = subprocess.check_output(
        ["git", "rev-parse", "HEAD"],
        cwd=tmp_path / "sample",
        text=True,
    ).strip()
    state = {}
    for _ in range(4):
        state = tick(home)
    assert state["subscription"]["connected"] is True
    assert [plan["action"] for plan in state["plans"]] == ["test", "audit", "issue", "pull_request"]
    assert state["ledger"]["estimated_tokens"] == 400
    assert state["ledger"]["metering"] == "local-estimate"
    assert state["loop"]["status"] == "stopped"
    assert state["contributions_pushed"] == 0
    assert all(plan["contributed"] is True for plan in state["plans"])
    assert all(plan["pushed"] is False for plan in state["plans"])
    assert all(plan["subscription_executed"] is True for plan in state["plans"])
    assert all(plan["usage"] == "estimate" for plan in state["plans"])
    assert all(plan["upstream_cloned"] is True for plan in state["plans"])
    assert all(plan["sandbox"]["invoked"] is True for plan in state["plans"])
    assert "owned" not in json.dumps(state["plans"])
    assert "sk-anthropic" not in json.dumps(state["plans"])
    pull = state["plans"][-1]
    command = pull["subscription_command"]
    assert command[1] == "-p"
    rendered = " ".join(command)
    assert "pull request" in rendered
    assert command[command.index("--tools") + 1] == ""
    assert "mcp__*" in command
    assert "*" in command
    assert "plan" in command
    assert "dangerously" not in rendered
    assert str(home / "workspaces") not in rendered
    assert pull["sandbox"]["argv"][0] == "/usr/bin/python3"
    assert str(home) not in " ".join(pull["sandbox"]["argv"])
    planner_dir = (home / "planner").resolve()
    recorded = invoked.read_text(encoding="utf-8").splitlines()
    assert recorded[0::2] == ["hit", "hit", "hit", "hit"]
    assert {Path(line).resolve() for line in recorded[1::2]} == {planner_dir}
    assert "idlehand-action=test" in state["plans"][0]["sandbox"]["stdout"]
    assert "tests_run=1" in state["plans"][0]["sandbox"]["stdout"]
    assert state["plans"][0]["sandbox"]["ok"] is True
    assert "idlehand-action=issue" in state["plans"][2]["sandbox"]["stdout"]
    assert "idlehand-action=pull_request" in pull["sandbox"]["stdout"]
    draft = _workspace(home, url) / ".idlehand" / "pr-draft.md"
    assert "not pushed" in draft.read_text(encoding="utf-8")
    kept = list((home / "drafts").rglob("issue-draft.md"))
    assert kept
    assert "not sent" in kept[0].read_text(encoding="utf-8")
    after = subprocess.check_output(["git", "rev-parse", "HEAD"], cwd=tmp_path / "sample", text=True).strip()
    assert after == source_head
    stopped = tick(home)
    assert len(stopped["plans"]) == 4
    assert stopped["ledger"]["estimated_tokens"] == 400
    text = render_text(home)
    assert "contributions recorded: 4" in text
    assert "contributions pushed: 0" in text
    assert "nothing was contributed" not in text
    assert "local estimate, not billed usage" in text
    assert "command (ran on the trusted side):" in text
    assert "contributed=yes" in text


def test_kept_drafts_do_not_follow_a_symlink(tmp_path: Path) -> None:
    from idlehand.loop import _keep_drafts

    home = tmp_path / "home"
    workspace = tmp_path / "work"
    (workspace / ".idlehand").mkdir(parents=True)
    secret = tmp_path / "secret"
    secret.write_text("host-secret", encoding="utf-8")
    (workspace / ".idlehand" / "issue-draft.md").symlink_to(secret)
    _keep_drafts(home, workspace, "https://github.com/org/repo")
    assert secret.read_text(encoding="utf-8") == "host-secret"
    assert not (home / "drafts").exists() or not list((home / "drafts").rglob("issue-draft.md"))


def test_unreadable_spending_limit_does_not_start_a_cycle(tmp_path: Path, monkeypatch) -> None:
    home = tmp_path / "home"
    invoked = _connect(home, tmp_path, monkeypatch)
    config = _ready(home)
    config["subscription"] = "claude"
    config["spending_limit_tokens"] = "lots"
    config["estimate_tokens_per_cycle"] = 100
    config["sandbox"]["execute"] = True
    config["sandbox"]["runtime"] = "namespace"
    save_config(home, config)
    _local_source(home, tmp_path)
    state = tick(home)
    assert state["plans"] == []
    assert state["loop"]["status"] == "stopped"
    assert state["loop"]["reason"] == "spending limit is unreadable"
    assert state["ledger"]["estimated_tokens"] == 0
    assert not invoked.exists()
    assert not (home / "workspaces").exists() or not any((home / "workspaces").iterdir())
    again = tick(home)
    assert again["plans"] == []
    assert again["loop"]["reason"] == "spending limit is unreadable"


def test_non_positive_estimate_does_not_start_a_cycle(tmp_path: Path, monkeypatch) -> None:
    home = tmp_path / "home"
    invoked = _connect(home, tmp_path, monkeypatch)
    config = _ready(home)
    config["subscription"] = "claude"
    config["spending_limit_tokens"] = 100
    config["estimate_tokens_per_cycle"] = 0
    config["sandbox"]["execute"] = True
    config["sandbox"]["runtime"] = "namespace"
    save_config(home, config)
    _local_source(home, tmp_path)
    state = tick(home)
    assert state["plans"] == []
    assert state["loop"]["status"] == "stopped"
    assert state["loop"]["reason"] == "the per-cycle estimate must be positive"
    assert state["ledger"]["estimated_tokens"] == 0
    assert not invoked.exists()
    config["estimate_tokens_per_cycle"] = -50
    save_config(home, config)
    again = tick(home)
    assert again["plans"] == []
    assert again["ledger"]["estimated_tokens"] == 0
    assert again["loop"]["reason"] == "the per-cycle estimate must be positive"
    assert not (home / "workspaces").exists() or not any((home / "workspaces").iterdir())


def test_bad_peer_clock_does_not_skip_the_spending_stop(tmp_path: Path, monkeypatch) -> None:
    from idlehand.config import state_path
    from idlehand.home import write_json

    home = tmp_path / "home"
    invoked = _connect(home, tmp_path, monkeypatch)
    config = _ready(home)
    config["subscription"] = "claude"
    config["spending_limit_tokens"] = 0
    config["estimate_tokens_per_cycle"] = 100
    save_config(home, config)
    _local_source(home, tmp_path)
    write_json(state_path(home), {"peers_runtime": {"last_fetch_epoch": "no"}, "plans": []})
    state = tick(home)
    assert state["plans"] == []
    assert state["loop"]["status"] == "stopped"
    assert state["loop"]["reason"] == "spending limit reached"
    assert not invoked.exists()


def test_zero_limit_does_not_start_a_cycle(tmp_path: Path, monkeypatch) -> None:
    home = tmp_path / "home"
    invoked = _connect(home, tmp_path, monkeypatch)
    config = _ready(home)
    config["subscription"] = "claude"
    config["spending_limit_tokens"] = 0
    config["estimate_tokens_per_cycle"] = 100
    config["sandbox"]["execute"] = True
    config["sandbox"]["runtime"] = "namespace"
    save_config(home, config)
    _local_source(home, tmp_path)
    state = tick(home)
    assert state["plans"] == []
    assert state["loop"]["status"] == "stopped"
    assert state["loop"]["reason"] == "spending limit reached"
    assert state["ledger"]["estimated_tokens"] == 0
    assert state["contributions_pushed"] == 0
    assert not (home / "workspaces").exists() or not any((home / "workspaces").iterdir())
    assert not invoked.exists()


def test_missing_cli_does_not_pretend_to_contribute(tmp_path: Path, monkeypatch) -> None:
    home = tmp_path / "home"
    monkeypatch.setenv("PATH", "/usr/bin:/bin")
    config = _ready(home)
    config["subscription"] = "codex"
    config["sandbox"]["execute"] = True
    config["sandbox"]["runtime"] = "namespace"
    save_config(home, config)
    _local_source(home, tmp_path)
    state = tick(home)
    assert state["subscription"]["connected"] is False
    assert "not connected" in state["subscription"]["detail"]
    assert state["plans"] == []
    assert state["loop"]["status"] == "idle"
    assert state["contributions_pushed"] == 0
    assert state["ledger"]["estimated_tokens"] == 0
    assert "nothing was contributed" in render_text(home)


def test_limit_resumes_when_raised(tmp_path: Path, monkeypatch) -> None:
    home = tmp_path / "home"
    _connect(home, tmp_path, monkeypatch, name="codex")
    config = _ready(home)
    config["subscription"] = "codex"
    config["spending_limit_tokens"] = 100
    config["estimate_tokens_per_cycle"] = 100
    config["sandbox"]["execute"] = True
    config["sandbox"]["runtime"] = "namespace"
    save_config(home, config)
    _local_source(home, tmp_path)
    first = tick(home)
    assert first["ledger"]["estimated_tokens"] == 100
    assert first["plans"][0]["contributed"] is True
    assert first["loop"]["status"] == "stopped"
    config = _ready(home)
    config["subscription"] = "codex"
    config["spending_limit_tokens"] = 300
    config["estimate_tokens_per_cycle"] = 100
    config["sandbox"]["execute"] = True
    config["sandbox"]["runtime"] = "namespace"
    save_config(home, config)
    second = tick(home)
    assert second["ledger"]["estimated_tokens"] == 200
    assert second["loop"]["status"] == "running"
    assert second["plans"][1]["subscription_executed"] is False
    assert second["plans"][1]["subscription_command"][1] == "exec"


def test_peer_fetch_adds_peers_not_repos(tmp_path: Path) -> None:
    home = tmp_path / "home"
    _ready(home)
    before = [repo["url"] for repo in load_sources(home)]
    document = {
        "idlehand": 1,
        "node_id": "peer-b",
        "peers": [{"url": "https://second.example/idlehand/publish", "id": "second"}],
        "repos": [{"url": "https://github.com/someone/not-imported"}],
    }
    peer_file = tmp_path / "peer.json"
    peer_file.write_text(json.dumps(document), encoding="utf-8")
    save_peers(home, [{"url": peer_file.as_uri(), "id": "", "source": "user", "endorsements": 1}])
    state = tick(home)
    peers_file = (home / "peers.toml").read_text(encoding="utf-8")
    assert "https://second.example/idlehand/publish" in peers_file
    assert "peers-of-peers" in peers_file
    assert [repo["url"] for repo in load_sources(home)] == before
    assert "https://github.com/someone/not-imported" not in (home / "sources.toml").read_text(encoding="utf-8")
    assert state["peers_runtime"]["ignored_remote_repos"] == 1
    published = json.loads((home / "publish.json").read_text(encoding="utf-8"))
    assert "subscription" not in published
    assert "ledger" not in published
    assert "trust" not in published
    assert published["repos"]
    text = render_text(home)
    assert "accepted peer https://second.example/idlehand/publish — https peer URL" in text
    assert "https://github.com/someone/not-imported" not in (home / "trust.json").read_text(encoding="utf-8")


def test_non_utf8_peer_document_does_not_crash_or_leak(tmp_path: Path) -> None:
    home = tmp_path / "home"
    _ready(home)
    peer = tmp_path / "peer.json"
    peer.write_bytes(b"\xffsekret")
    save_peers(home, [{"url": peer.as_uri(), "id": "", "source": "user", "endorsements": 1}])
    state = tick(home)
    recorded = json.dumps(state)
    assert "sekret" not in recorded
    assert "UTF-8" in state["peers_runtime"]["last_error"]
    assert state["plans"] == []


def test_unreadable_peer_heuristic_does_not_skip_the_cycle(tmp_path: Path, monkeypatch) -> None:
    from idlehand.trust import load_trust

    home = tmp_path / "home"
    _connect(home, tmp_path, monkeypatch)
    config = _ready(home)
    config["subscription"] = "claude"
    config["sandbox"]["execute"] = True
    config["sandbox"]["runtime"] = "namespace"
    config["estimate_tokens_per_cycle"] = 30
    config["peer_heuristic"]["min_endorsements"] = "no"
    config["rules"]["allow_audit"] = False
    config["rules"]["allow_issues"] = False
    config["rules"]["allow_pull_requests"] = False
    save_config(home, config)
    _local_source(home, tmp_path)
    peer = tmp_path / "peer.json"
    peer.write_text('{"peers":["https://second.example/idlehand/publish"],"repos":[]}\n', encoding="utf-8")
    save_peers(home, [{"url": peer.as_uri(), "id": "", "source": "user", "endorsements": 1}])
    state = tick(home)
    assert state["plans"][0]["contributed"] is True
    assert any(
        item["reason"] == "peer heuristic is unreadable" and item["accepted"] is False for item in load_trust(home)
    )
    assert "peer heuristic is unreadable" in render_text(home)
    assert "https://second.example/idlehand/publish" not in (home / "peers.toml").read_text(encoding="utf-8")


def test_credential_peer_url_is_not_fetched_or_published(tmp_path: Path) -> None:
    home = tmp_path / "home"
    _ready(home)
    save_peers(
        home,
        [{"url": "https://user:sekret@peer.example/idlehand/publish", "id": "", "source": "user", "endorsements": 1}],
    )
    save_sources(home, [{"url": "https://github.com/org/repo.git?token=othersecret", "note": "typed"}])
    state = tick(home)
    published = (home / "publish.json").read_text(encoding="utf-8")
    recorded = published + json.dumps(state)
    assert "sekret" not in recorded
    assert "othersecret" not in published
    assert state["peers_runtime"]["last_error"] == "peer URLs cannot embed credentials"
    assert state["plans"] == []


def test_demo_clone_is_not_a_contribution(tmp_path: Path, monkeypatch) -> None:
    home = tmp_path / "home"
    monkeypatch.setenv("PATH", "/usr/bin:/bin")
    monkeypatch.setenv("OPENAI_API_KEY", "sk-openai")
    config = _ready(home)
    config["demo"] = True
    config["sandbox"]["execute"] = True
    config["sandbox"]["runtime"] = "namespace"
    config["spending_limit_tokens"] = 2500
    config["estimate_tokens_per_cycle"] = 2500
    save_config(home, config)
    _local_source(home, tmp_path)
    state = tick(home)
    plan = state["plans"][0]
    assert plan["demo"] is True
    assert plan["action"] == "test"
    assert plan["contributed"] is False
    assert plan["upstream_cloned"] is True
    assert plan["sandbox"]["ok"] is True
    assert "idlehand-action=test" in plan["sandbox"]["stdout"]
    assert "tests_run=1" in plan["sandbox"]["stdout"]
    assert "sk-openai" not in json.dumps(plan["sandbox"])
    assert state["contributions_pushed"] == 0
    assert state["ledger"]["estimated_tokens"] == 2500
    assert "nothing was contributed" in render_text(home)
    assert "contributed=no" in render_text(home)


def test_failed_fetch_is_not_a_contribution_and_rotates(tmp_path: Path, monkeypatch) -> None:
    home = tmp_path / "home"
    invoked = _connect(home, tmp_path, monkeypatch)
    config = _ready(home)
    config["subscription"] = "claude"
    config["sandbox"]["execute"] = True
    config["sandbox"]["runtime"] = "namespace"
    config["estimate_tokens_per_cycle"] = 100
    save_config(home, config)
    good = make_repo(tmp_path / "good", SAMPLE_FILES)
    save_sources(
        home,
        [
            {"url": "https://user:secret@github.com/org/repo.git", "note": "credentials"},
            {"url": "ssh://git@github.com/org/other.git", "note": "ssh"},
            {"url": good, "note": "local"},
        ],
    )
    first = tick(home)
    assert not invoked.exists()
    assert first["plans"][0]["contributed"] is False
    assert first["plans"][0]["upstream_cloned"] is False
    assert "credentials" in first["plans"][0]["fetch"]["reason"]
    assert first["ledger"]["estimated_tokens"] == 0
    assert first["loop"]["cycles"] == 1
    second = tick(home)
    assert "SSH" in second["plans"][1]["fetch"]["reason"]
    assert second["plans"][1]["contributed"] is False
    assert second["ledger"]["estimated_tokens"] == 0
    third = tick(home)
    assert third["plans"][2]["contributed"] is True
    assert third["plans"][2]["upstream_cloned"] is True
    assert third["ledger"]["estimated_tokens"] == 100
    assert "secret" not in json.dumps(third["plans"])


def test_refused_sandbox_is_not_a_contribution(tmp_path: Path, monkeypatch) -> None:
    home = tmp_path / "home"
    invoked = _connect(home, tmp_path, monkeypatch)
    config = _ready(home)
    config["subscription"] = "claude"
    config["sandbox"]["execute"] = False
    config["estimate_tokens_per_cycle"] = 100
    save_config(home, config)
    url = _local_source(home, tmp_path)
    state = tick(home)
    plan = state["plans"][0]
    assert plan["contributed"] is False
    assert plan["sandbox"]["invoked"] is False
    assert plan["sandbox"]["reason"] == "sandbox execution is off"
    assert state["ledger"]["estimated_tokens"] == 0
    assert state["loop"]["cycles"] == 1
    assert not _workspace(home, url).exists()
    assert not invoked.exists()
    config["sandbox"]["execute"] = True
    config["sandbox"]["runtime"] = "none"
    save_config(home, config)
    refused = tick(home)
    assert refused["plans"][1]["contributed"] is False
    assert "refused" in refused["plans"][1]["sandbox"]["reason"]
    assert refused["ledger"]["estimated_tokens"] == 0


def test_syntax_error_still_counts_after_the_command_runs(tmp_path: Path, monkeypatch) -> None:
    home = tmp_path / "home"
    _connect(home, tmp_path, monkeypatch)
    config = _ready(home)
    config["subscription"] = "claude"
    config["sandbox"]["execute"] = True
    config["sandbox"]["runtime"] = "namespace"
    config["estimate_tokens_per_cycle"] = 80
    config["rules"]["allow_audit"] = False
    config["rules"]["allow_issues"] = False
    config["rules"]["allow_pull_requests"] = False
    save_config(home, config)
    _local_source(home, tmp_path, BROKEN_FILES)
    state = tick(home)
    plan = state["plans"][0]
    assert plan["action"] == "test"
    assert plan["upstream_cloned"] is True
    assert plan["sandbox"]["invoked"] is True
    assert plan["sandbox"]["ok"] is False
    assert plan["contributed"] is True
    assert "syntax" in plan["sandbox"]["stdout"]
    assert state["ledger"]["estimated_tokens"] == 80
    assert state["contributions_pushed"] == 0


def test_audit_and_issue_drafts_stay_local(tmp_path: Path, monkeypatch) -> None:
    home = tmp_path / "home"
    _connect(home, tmp_path, monkeypatch)
    config = _ready(home)
    config["subscription"] = "claude"
    config["sandbox"]["execute"] = True
    config["sandbox"]["runtime"] = "namespace"
    config["rules"]["allow_test"] = False
    config["rules"]["allow_pull_requests"] = False
    save_config(home, config)
    url = _local_source(home, tmp_path, KEY_FILES)
    first = tick(home)
    audit = first["plans"][0]
    assert audit["action"] == "audit"
    assert audit["contributed"] is True
    assert "private key" in audit["sandbox"]["stdout"]
    report = (_workspace(home, url) / ".idlehand" / "audit.txt").read_text(encoding="utf-8")
    assert "private key" in report
    second = tick(home)
    issue = second["plans"][1]
    assert issue["action"] == "issue"
    assert issue["contributed"] is True
    draft = (_workspace(home, url) / ".idlehand" / "issue-draft.md").read_text(encoding="utf-8")
    assert "not filed" in draft
    assert "private key" in draft
    kept_audit = list((home / "drafts").rglob("audit.txt"))
    assert kept_audit and "private key" in kept_audit[0].read_text(encoding="utf-8")
    assert second["contributions_pushed"] == 0


def test_sandbox_setup_failure_is_not_a_contribution(tmp_path: Path, monkeypatch) -> None:
    from idlehand.sandbox import SandboxResult

    home = tmp_path / "home"
    _connect(home, tmp_path, monkeypatch)
    config = _ready(home)
    config["subscription"] = "claude"
    config["sandbox"]["execute"] = True
    config["sandbox"]["runtime"] = "namespace"
    config["estimate_tokens_per_cycle"] = 50
    save_config(home, config)
    _local_source(home, tmp_path)

    def exploded(*args, **kwargs):
        return SandboxResult(
            runtime="namespace",
            invoked=False,
            ok=False,
            exit_code=97,
            stdout="",
            stderr="sandbox setup failed",
            reason="sandbox setup failed",
            argv=["/usr/bin/python3", "-c", "print(1)"],
        )

    monkeypatch.setattr("idlehand.loop.run", exploded)
    state = tick(home)
    plan = state["plans"][0]
    assert plan["upstream_cloned"] is True
    assert plan["sandbox"]["invoked"] is False
    assert plan["sandbox"]["exit_code"] == 97
    assert plan["contributed"] is False
    assert state["ledger"]["estimated_tokens"] == 0


def test_fetch_exception_is_not_a_contribution(tmp_path: Path, monkeypatch) -> None:
    home = tmp_path / "home"
    _connect(home, tmp_path, monkeypatch)
    config = _ready(home)
    config["subscription"] = "claude"
    config["sandbox"]["execute"] = True
    config["sandbox"]["runtime"] = "namespace"
    save_config(home, config)
    _local_source(home, tmp_path)

    def boom(url, workspace, **kwargs):
        raise RuntimeError("fetch blew up")

    monkeypatch.setattr("idlehand.loop.clone_repository", boom)
    state = tick(home)
    plan = state["plans"][0]
    assert plan["contributed"] is False
    assert plan["upstream_cloned"] is False
    assert "fetch blew up" in plan["fetch"]["reason"]
    assert state["ledger"]["estimated_tokens"] == 0
    assert state["loop"]["cycles"] == 1
    assert state["node"]["status"] == "up"


def _reporter(tmp_path: Path, monkeypatch, stdout: str) -> Path:
    bin_dir = tmp_path / "bin"
    bin_dir.mkdir(exist_ok=True)
    invoked = tmp_path / "claude-invoked"
    script = bin_dir / "claude"
    script.write_text(
        "#!/bin/sh\n"
        f"pwd >> '{invoked}'\n"
        "cat <<'EOF'\n"
        f"{stdout}\n"
        "EOF\n",
        encoding="utf-8",
    )
    script.chmod(0o755)
    monkeypatch.setenv("PATH", f"{bin_dir}:/usr/bin:/bin")
    return invoked


def test_reported_usage_is_metered_without_adding_the_estimate(tmp_path: Path, monkeypatch) -> None:
    home = tmp_path / "home"
    stdout = (
        '{"type":"result","result":"touch /tmp/idlehand-do-not-run sk-planner-secret",'
        '"usage":{"input_tokens":30,"output_tokens":12}}'
    )
    invoked = _reporter(tmp_path, monkeypatch, stdout)
    config = _ready(home)
    config["subscription"] = "claude"
    config["sandbox"]["execute"] = True
    config["sandbox"]["runtime"] = "namespace"
    config["spending_limit_tokens"] = 100
    config["estimate_tokens_per_cycle"] = 80
    config["rules"]["allow_audit"] = False
    config["rules"]["allow_issues"] = False
    config["rules"]["allow_pull_requests"] = False
    save_config(home, config)
    _local_source(home, tmp_path)
    first = tick(home)
    assert first["plans"][0]["contributed"] is True
    assert first["plans"][0]["usage"] == "reported"
    assert first["plans"][0]["metered_tokens"] == 42
    assert first["plans"][0]["estimated_tokens"] == 0
    assert first["ledger"]["metered_tokens"] == 42
    assert first["ledger"]["estimated_tokens"] == 0
    assert first["ledger"]["metering"] == "reported"
    assert first["plans"][0]["subscription_executed"] is True
    assert Path(invoked.read_text(encoding="utf-8").strip()).resolve() == (home / "planner").resolve()
    assert "touch /tmp/idlehand-do-not-run" not in json.dumps(first["plans"])
    assert "sk-planner-secret" not in (home / "state.json").read_text(encoding="utf-8")
    assert not Path("/tmp/idlehand-do-not-run").exists()
    text = render_text(home)
    assert "reported by the subscription" in text
    assert "local estimate, not billed usage" not in text
    second = tick(home)
    assert len(second["plans"]) == 1
    assert second["loop"]["status"] == "stopped"
    assert invoked.read_text(encoding="utf-8").count("\n") == 1


def test_reported_zero_does_not_also_charge_the_estimate(tmp_path: Path, monkeypatch) -> None:
    home = tmp_path / "home"
    _reporter(tmp_path, monkeypatch, '{"type":"result","usage":{"input_tokens":0,"output_tokens":0}}')
    config = _ready(home)
    config["subscription"] = "claude"
    config["sandbox"]["execute"] = True
    config["sandbox"]["runtime"] = "namespace"
    config["spending_limit_tokens"] = 500
    config["estimate_tokens_per_cycle"] = 100
    config["rules"]["allow_audit"] = False
    config["rules"]["allow_issues"] = False
    config["rules"]["allow_pull_requests"] = False
    save_config(home, config)
    _local_source(home, tmp_path)
    state = tick(home)
    assert state["plans"][0]["usage"] == "reported"
    assert state["ledger"]["metered_tokens"] == 0
    assert state["ledger"]["estimated_tokens"] == 0
    assert state["ledger"]["metering"] == "reported"
    assert state["plans"][0]["contributed"] is True
    assert "reported by the subscription" in render_text(home)


def test_overshoot_stops_the_next_cycle(tmp_path: Path, monkeypatch) -> None:
    home = tmp_path / "home"
    _reporter(tmp_path, monkeypatch, '{"type":"result","usage":{"input_tokens":250,"output_tokens":0}}')
    config = _ready(home)
    config["subscription"] = "claude"
    config["sandbox"]["execute"] = True
    config["sandbox"]["runtime"] = "namespace"
    config["spending_limit_tokens"] = 100
    config["estimate_tokens_per_cycle"] = 100
    config["rules"]["allow_audit"] = False
    config["rules"]["allow_issues"] = False
    config["rules"]["allow_pull_requests"] = False
    save_config(home, config)
    _local_source(home, tmp_path)
    first = tick(home)
    assert first["ledger"]["metered_tokens"] == 250
    assert first["loop"]["status"] == "stopped"
    second = tick(home)
    assert len(second["plans"]) == 1
    assert second["ledger"]["metered_tokens"] == 250
    assert "250 / 100" in render_text(home)


def test_mixed_metering_labels_estimate_and_reported(tmp_path: Path, monkeypatch) -> None:
    home = tmp_path / "home"
    invoked = _reporter(tmp_path, monkeypatch, '{"type":"result","usage":{"input_tokens":15,"output_tokens":0}}')
    config = _ready(home)
    config["subscription"] = "claude"
    config["sandbox"]["execute"] = True
    config["sandbox"]["runtime"] = "namespace"
    config["estimate_tokens_per_cycle"] = 40
    config["rules"]["allow_audit"] = False
    config["rules"]["allow_issues"] = False
    config["rules"]["allow_pull_requests"] = False
    save_config(home, config)
    _local_source(home, tmp_path)
    tick(home)
    invoked.write_text("", encoding="utf-8")
    script = tmp_path / "bin" / "claude"
    script.write_text(f"#!/bin/sh\npwd >> '{invoked}'\n", encoding="utf-8")
    script.chmod(0o755)
    second = tick(home)
    assert second["ledger"]["metered_tokens"] == 15
    assert second["ledger"]["estimated_tokens"] == 40
    assert second["ledger"]["metering"] == "mixed"
    assert second["plans"][0]["usage"] == "reported"
    assert second["plans"][1]["usage"] == "estimate"
    assert "40 estimated, 15 reported" in render_text(home)


def test_demo_and_other_clis_do_not_run_on_the_host(tmp_path: Path, monkeypatch) -> None:
    home = tmp_path / "home"
    bin_dir = tmp_path / "bin"
    bin_dir.mkdir()
    markers = {}
    for name in ("claude", "codex", "cursor-agent"):
        marker = tmp_path / f"{name}-hit"
        markers[name] = marker
        script = bin_dir / name
        script.write_text(f"#!/bin/sh\ntouch '{marker}'\n", encoding="utf-8")
        script.chmod(0o755)
    monkeypatch.setenv("PATH", f"{bin_dir}:/usr/bin:/bin")
    config = _ready(home)
    config["demo"] = True
    config["subscription"] = "claude"
    config["sandbox"]["execute"] = True
    config["sandbox"]["runtime"] = "namespace"
    config["estimate_tokens_per_cycle"] = 25
    config["rules"]["allow_audit"] = False
    config["rules"]["allow_issues"] = False
    config["rules"]["allow_pull_requests"] = False
    save_config(home, config)
    _local_source(home, tmp_path)
    demo = tick(home)
    assert demo["plans"][0]["demo"] is True
    assert demo["plans"][0]["contributed"] is False
    assert demo["plans"][0]["subscription_executed"] is False
    assert demo["plans"][0]["usage"] == "estimate"
    assert demo["ledger"]["estimated_tokens"] == 25
    assert not markers["claude"].exists()
    config["demo"] = False
    config["subscription"] = "codex"
    save_config(home, config)
    codex = tick(home)
    assert codex["plans"][1]["subscription_executed"] is False
    assert codex["plans"][1]["usage"] == "estimate"
    assert codex["plans"][1]["subscription_command"][1] == "exec"
    assert not markers["codex"].exists()
    config["subscription"] = "cursor"
    save_config(home, config)
    cursor = tick(home)
    assert cursor["plans"][2]["subscription_executed"] is False
    assert cursor["plans"][2]["usage"] == "estimate"
    assert not markers["cursor-agent"].exists()
    assert cursor["ledger"]["metering"] == "local-estimate"


def test_planner_timeout_keeps_the_estimate(tmp_path: Path, monkeypatch) -> None:
    home = tmp_path / "home"
    invoked = tmp_path / "claude-invoked"
    script = tmp_path / "bin" / "claude"
    script.parent.mkdir()
    script.write_text(
        "#!/bin/sh\n"
        f"echo started >> '{invoked}'\n"
        "printf 'sk-timeout-secret' > \"$PWD/leak.txt\"\n"
        "sleep 5\n"
        f"echo finished >> '{invoked}'\n",
        encoding="utf-8",
    )
    script.chmod(0o755)
    monkeypatch.setenv("PATH", f"{script.parent}:/usr/bin:/bin")
    monkeypatch.setattr("idlehand.usage.PLAN_TIMEOUT", 0.2)
    config = _ready(home)
    config["subscription"] = "claude"
    config["sandbox"]["execute"] = True
    config["sandbox"]["runtime"] = "namespace"
    config["estimate_tokens_per_cycle"] = 17
    config["rules"]["allow_audit"] = False
    config["rules"]["allow_issues"] = False
    config["rules"]["allow_pull_requests"] = False
    save_config(home, config)
    _local_source(home, tmp_path)
    state = tick(home)
    text = invoked.read_text(encoding="utf-8")
    assert "started" in text
    assert "finished" not in text
    assert state["plans"][0]["subscription_executed"] is True
    assert state["plans"][0]["usage"] == "estimate"
    assert state["ledger"]["estimated_tokens"] == 17
    assert state["ledger"]["metered_tokens"] == 0
    assert state["plans"][0]["contributed"] is True
    assert "sk-timeout-secret" not in (home / "state.json").read_text(encoding="utf-8")
    assert not (home / "planner").exists()
    leftover = " ".join(
        path.read_text(encoding="utf-8", errors="ignore")
        for path in home.rglob("*")
        if path.is_file() and not path.is_symlink()
    )
    assert "sk-timeout-secret" not in leftover


def test_sandbox_timeout_still_records_the_command_that_started(tmp_path: Path, monkeypatch) -> None:
    import idlehand.loop as loop_module

    home = tmp_path / "home"
    _connect(home, tmp_path, monkeypatch)
    config = _ready(home)
    config["subscription"] = "claude"
    config["sandbox"]["execute"] = True
    config["sandbox"]["runtime"] = "namespace"
    config["estimate_tokens_per_cycle"] = 19
    config["rules"]["allow_audit"] = False
    config["rules"]["allow_issues"] = False
    config["rules"]["allow_pull_requests"] = False
    save_config(home, config)
    _local_source(
        home,
        tmp_path,
        {
            "test_slow.py": (
                "import time\n"
                "import unittest\n"
                "class Slow(unittest.TestCase):\n"
                "    def test_slow(self):\n"
                "        time.sleep(30)\n"
            ),
        },
    )
    original = loop_module.run

    def limited(workspace, command, **kwargs):
        kwargs["timeout"] = 0.2
        return original(workspace, command, **kwargs)

    monkeypatch.setattr(loop_module, "run", limited)
    state = tick(home)
    plan = state["plans"][0]
    assert plan["sandbox"]["invoked"] is True
    assert plan["sandbox"]["reason"] == "sandbox timed out"
    assert plan["contributed"] is True
    assert plan["pushed"] is False
    assert plan["usage"] == "estimate"
    assert state["ledger"]["estimated_tokens"] == 19


def test_reported_tokens_stay_on_the_ledger_when_the_sandbox_fails(tmp_path: Path, monkeypatch) -> None:
    from idlehand.sandbox import SandboxResult

    home = tmp_path / "home"
    _reporter(tmp_path, monkeypatch, '{"type":"result","usage":{"input_tokens":9,"output_tokens":0}}')
    config = _ready(home)
    config["subscription"] = "claude"
    config["sandbox"]["execute"] = True
    config["sandbox"]["runtime"] = "namespace"
    config["estimate_tokens_per_cycle"] = 100
    config["rules"]["allow_audit"] = False
    config["rules"]["allow_issues"] = False
    config["rules"]["allow_pull_requests"] = False
    save_config(home, config)
    _local_source(home, tmp_path)

    def refused(*args, **kwargs):
        return SandboxResult(
            runtime="namespace",
            invoked=False,
            ok=False,
            exit_code=97,
            stdout="",
            stderr="sandbox setup failed",
            reason="sandbox setup failed",
            argv=["/usr/bin/python3"],
        )

    monkeypatch.setattr("idlehand.loop.run", refused)
    state = tick(home)
    plan = state["plans"][0]
    assert plan["contributed"] is False
    assert plan["usage"] == "reported"
    assert plan["metered_tokens"] == 9
    assert state["ledger"]["metered_tokens"] == 9
    assert state["ledger"]["estimated_tokens"] == 0
    assert state["ledger"]["metering"] == "reported"
    assert state["contributions_pushed"] == 0


def test_zero_report_and_refused_sandbox_is_not_a_contribution(tmp_path: Path, monkeypatch) -> None:
    from idlehand.sandbox import SandboxResult

    home = tmp_path / "home"
    _reporter(tmp_path, monkeypatch, '{"type":"result","usage":{"input_tokens":0,"output_tokens":0}}')
    config = _ready(home)
    config["subscription"] = "claude"
    config["sandbox"]["execute"] = True
    config["sandbox"]["runtime"] = "namespace"
    config["estimate_tokens_per_cycle"] = 80
    config["spending_limit_tokens"] = 200
    config["rules"]["allow_audit"] = False
    config["rules"]["allow_issues"] = False
    config["rules"]["allow_pull_requests"] = False
    save_config(home, config)
    _local_source(home, tmp_path)

    def refused(*args, **kwargs):
        return SandboxResult(
            runtime="namespace",
            invoked=False,
            ok=False,
            exit_code=97,
            stdout="",
            stderr="sandbox setup failed",
            reason="sandbox setup failed",
            argv=["/usr/bin/python3"],
        )

    monkeypatch.setattr("idlehand.loop.run", refused)
    first = tick(home)
    second = tick(home)
    assert [plan["contributed"] for plan in second["plans"]] == [False, False]
    assert [plan["usage"] for plan in second["plans"]] == ["reported", "reported"]
    assert second["ledger"]["metered_tokens"] == 0
    assert second["ledger"]["estimated_tokens"] == 0
    assert second["ledger"]["metering"] == "reported"
    assert second["loop"]["status"] == "running"
    assert first["plans"][0]["metered_tokens"] == 0
    text = render_text(home)
    assert "reported by the subscription" in text
    assert "nothing was contributed" in text


def test_usage_on_stderr_is_not_treated_as_a_report(tmp_path: Path, monkeypatch) -> None:
    home = tmp_path / "home"
    invoked = tmp_path / "claude-invoked"
    script = tmp_path / "bin" / "claude"
    script.parent.mkdir()
    script.write_text(
        "#!/bin/sh\n"
        f"echo hit >> '{invoked}'\n"
        "echo '{\"usage\":{\"input_tokens\":99,\"output_tokens\":1}}' >&2\n",
        encoding="utf-8",
    )
    script.chmod(0o755)
    monkeypatch.setenv("PATH", f"{script.parent}:/usr/bin:/bin")
    config = _ready(home)
    config["subscription"] = "claude"
    config["sandbox"]["execute"] = True
    config["sandbox"]["runtime"] = "namespace"
    config["estimate_tokens_per_cycle"] = 11
    config["rules"]["allow_audit"] = False
    config["rules"]["allow_issues"] = False
    config["rules"]["allow_pull_requests"] = False
    save_config(home, config)
    _local_source(home, tmp_path)
    state = tick(home)
    assert state["plans"][0]["usage"] == "estimate"
    assert state["ledger"]["estimated_tokens"] == 11
    assert state["ledger"]["metered_tokens"] == 0
    assert "99" not in json.dumps(state["ledger"])


def test_zero_report_then_estimate_is_mixed(tmp_path: Path, monkeypatch) -> None:
    home = tmp_path / "home"
    invoked = _reporter(tmp_path, monkeypatch, '{"type":"result","usage":{"input_tokens":0,"output_tokens":0}}')
    config = _ready(home)
    config["subscription"] = "claude"
    config["sandbox"]["execute"] = True
    config["sandbox"]["runtime"] = "namespace"
    config["estimate_tokens_per_cycle"] = 40
    config["rules"]["allow_audit"] = False
    config["rules"]["allow_issues"] = False
    config["rules"]["allow_pull_requests"] = False
    save_config(home, config)
    _local_source(home, tmp_path)
    first = tick(home)
    assert first["ledger"]["metering"] == "reported"
    assert first["ledger"]["metered_tokens"] == 0
    script = tmp_path / "bin" / "claude"
    script.write_text(f"#!/bin/sh\necho hit >> '{invoked}'\n", encoding="utf-8")
    script.chmod(0o755)
    second = tick(home)
    assert second["ledger"]["estimated_tokens"] == 40
    assert second["ledger"]["metered_tokens"] == 0
    assert second["ledger"]["metering"] == "mixed"
    assert "40 estimated, 0 reported" in render_text(home)


def test_workspace_symlink_is_not_cloned_or_charged(tmp_path: Path, monkeypatch) -> None:
    home = tmp_path / "home"
    invoked = _connect(home, tmp_path, monkeypatch)
    config = _ready(home)
    config["subscription"] = "claude"
    config["sandbox"]["execute"] = True
    config["sandbox"]["runtime"] = "namespace"
    config["rules"]["allow_audit"] = False
    config["rules"]["allow_issues"] = False
    config["rules"]["allow_pull_requests"] = False
    save_config(home, config)
    url = _local_source(home, tmp_path)
    outside = tmp_path / "outside"
    outside.mkdir()
    (outside / "keep").write_text("safe", encoding="utf-8")
    workspace = _workspace(home, url)
    workspace.parent.mkdir(parents=True, exist_ok=True)
    workspace.symlink_to(outside)
    state = tick(home)
    plan = state["plans"][0]
    assert plan["contributed"] is False
    assert plan["upstream_cloned"] is False
    assert plan["subscription_executed"] is False
    assert state["ledger"]["estimated_tokens"] == 0
    assert state["ledger"]["metered_tokens"] == 0
    assert (outside / "keep").read_text(encoding="utf-8") == "safe"
    assert not invoked.exists()


def test_link_cycle_reports_trust_and_usage_together(tmp_path: Path, monkeypatch) -> None:
    from idlehand.links import apply_link

    home = tmp_path / "home"
    _reporter(tmp_path, monkeypatch, '{"type":"result","usage":{"input_tokens":5,"output_tokens":2}}')
    config = _ready(home)
    config["subscription"] = "claude"
    config["sandbox"]["execute"] = True
    config["sandbox"]["runtime"] = "namespace"
    config["rules"]["allow_audit"] = False
    config["rules"]["allow_issues"] = False
    config["rules"]["allow_pull_requests"] = False
    save_config(home, config)
    ensure_home(home)
    url = make_repo(tmp_path / "linked", SAMPLE_FILES)
    added = apply_link(
        home,
        "idlehand://add?repo=https://github.com/pallets/click&repo=git@github.com:org/nope.git",
    )
    assert added == ["https://github.com/pallets/click"]
    save_sources(home, [{"url": url, "note": "local cycle"}])
    state = tick(home)
    assert state["plans"][0]["contributed"] is True
    assert state["plans"][0]["upstream_cloned"] is True
    assert state["ledger"]["metered_tokens"] == 7
    assert state["ledger"]["estimated_tokens"] == 0
    assert state["contributions_pushed"] == 0
    text = render_text(home)
    assert "accepted link" in text
    assert "refused link" in text
    assert "git repository URL" in text
    assert "contributions recorded: 1" in text
    assert "reported by the subscription" in text
    assert "nothing was contributed" not in text


def test_repo_test_output_does_not_keep_a_credential_or_a_private_key(tmp_path: Path, monkeypatch) -> None:
    home = tmp_path / "home"
    _connect(home, tmp_path, monkeypatch)
    config = _ready(home)
    config["subscription"] = "claude"
    config["sandbox"]["execute"] = True
    config["sandbox"]["runtime"] = "namespace"
    config["rules"]["allow_audit"] = False
    config["rules"]["allow_issues"] = False
    config["rules"]["allow_pull_requests"] = False
    save_config(home, config)
    _local_source(
        home,
        tmp_path,
        {
            "test_print.py": (
                "import unittest\n"
                "class Leak(unittest.TestCase):\n"
                "    def test_print(self):\n"
                "        print('https://user:sekret@github.com/org/repo.git')\n"
                "        print('-----BEGIN OPENSSH PRIVATE KEY-----')\n"
            ),
        },
    )
    state = tick(home)
    plan = state["plans"][0]
    assert plan["contributed"] is True
    assert plan["sandbox"]["ok"] is True
    blob = (home / "state.json").read_text(encoding="utf-8")
    log = (home / "node.log").read_text(encoding="utf-8") if (home / "node.log").exists() else ""
    assert "sekret" not in blob
    assert "sekret" not in log
    assert "BEGIN OPENSSH PRIVATE KEY" not in blob
    assert "private key material omitted" in plan["sandbox"]["stdout"]
    assert "idlehand-action=test" in plan["sandbox"]["stdout"]


def test_sandbox_does_not_follow_a_symlink_to_a_host_secret(tmp_path: Path, monkeypatch) -> None:
    home = tmp_path / "home"
    _connect(home, tmp_path, monkeypatch)
    config = _ready(home)
    config["subscription"] = "claude"
    config["sandbox"]["execute"] = True
    config["sandbox"]["runtime"] = "namespace"
    config["rules"]["allow_test"] = False
    config["rules"]["allow_issues"] = False
    config["rules"]["allow_pull_requests"] = False
    save_config(home, config)
    url = _local_source(home, tmp_path, {"readme.txt": "hello\n"})
    secret = tmp_path / "host-secret"
    secret.write_text("BEGIN PRIVATE KEY\nhost-only-material\n", encoding="utf-8")
    leak = tmp_path / "sample" / "leak.txt"
    leak.symlink_to(secret)
    subprocess.run(
        ["git", "add", "leak.txt"],
        cwd=tmp_path / "sample",
        check=True,
        capture_output=True,
        env={
            "PATH": "/usr/bin:/bin",
            "HOME": str(tmp_path),
            "GIT_CONFIG_GLOBAL": "/dev/null",
            "GIT_CONFIG_NOSYSTEM": "1",
            "GIT_AUTHOR_NAME": "idlehand",
            "GIT_AUTHOR_EMAIL": "idlehand@example.com",
            "GIT_COMMITTER_NAME": "idlehand",
            "GIT_COMMITTER_EMAIL": "idlehand@example.com",
        },
    )
    subprocess.run(
        ["git", "commit", "-m", "leak"],
        cwd=tmp_path / "sample",
        check=True,
        capture_output=True,
        env={
            "PATH": "/usr/bin:/bin",
            "HOME": str(tmp_path),
            "GIT_CONFIG_GLOBAL": "/dev/null",
            "GIT_CONFIG_NOSYSTEM": "1",
            "GIT_AUTHOR_NAME": "idlehand",
            "GIT_AUTHOR_EMAIL": "idlehand@example.com",
            "GIT_COMMITTER_NAME": "idlehand",
            "GIT_COMMITTER_EMAIL": "idlehand@example.com",
        },
    )
    state = tick(home)
    plan = state["plans"][0]
    blob = json.dumps(plan["sandbox"])
    assert "host-only-material" not in blob
    assert secret.read_text(encoding="utf-8").startswith("BEGIN PRIVATE KEY")
    assert url.startswith("file:")


def test_missing_git_is_not_a_contribution(tmp_path: Path, monkeypatch) -> None:
    home = tmp_path / "home"
    _connect(home, tmp_path, monkeypatch)
    config = _ready(home)
    config["subscription"] = "claude"
    config["sandbox"]["execute"] = True
    config["sandbox"]["runtime"] = "namespace"
    save_config(home, config)
    _local_source(home, tmp_path)
    monkeypatch.setattr("idlehand.fetch.resolve_git", lambda: None)
    state = tick(home)
    plan = state["plans"][0]
    assert plan["contributed"] is False
    assert plan["upstream_cloned"] is False
    assert plan["fetch"]["reason"] == "git is not installed"
    assert state["ledger"]["estimated_tokens"] == 0
    assert state["loop"]["status"] == "running"


def test_corrupt_plan_entry_does_not_skip_the_spending_stop(tmp_path: Path, monkeypatch) -> None:
    from idlehand.config import state_path
    from idlehand.home import write_json
    from idlehand.trust import decision, remember

    home = tmp_path / "home"
    invoked = _connect(home, tmp_path, monkeypatch)
    config = _ready(home)
    config["subscription"] = "claude"
    config["spending_limit_tokens"] = 0
    config["estimate_tokens_per_cycle"] = 100
    save_config(home, config)
    _local_source(home, tmp_path)
    remember(home, [decision("link", "https://github.com/pallets/click", True, "https git repository URL")])
    write_json(
        state_path(home),
        {"plans": ["no", {"pushed": "yes", "contributed": True}], "ledger": {"estimated_tokens": 0, "metered_tokens": 0}},
    )
    assert "accepted link https://github.com/pallets/click" in render_text(home)
    state = tick(home)
    assert all(isinstance(plan, dict) for plan in state["plans"])
    assert state["contributions_pushed"] == 0
    assert state["loop"]["status"] == "stopped"
    assert state["loop"]["reason"] == "spending limit reached"
    assert not invoked.exists()
    assert "accepted link https://github.com/pallets/click" in render_text(home)


def test_unreadable_ledger_stops_before_a_cycle_and_analytics_keeps_trust(tmp_path: Path, monkeypatch) -> None:
    from idlehand.analytics import render_text
    from idlehand.config import state_path
    from idlehand.trust import decision, remember

    home = tmp_path / "home"
    invoked = _connect(home, tmp_path, monkeypatch)
    config = _ready(home)
    config["subscription"] = "claude"
    config["spending_limit_tokens"] = 100
    config["estimate_tokens_per_cycle"] = 40
    config["sandbox"]["execute"] = True
    config["sandbox"]["runtime"] = "namespace"
    save_config(home, config)
    _local_source(home, tmp_path)
    remember(home, [decision("link", "https://github.com/pallets/click", True, "https git repository URL")])
    state_path(home).write_text(
        json.dumps(
            {
                "ledger": {"estimated_tokens": -40, "metered_tokens": "no", "metering": "reported"},
                "loop": {"cycles": "no", "status": "running", "reason": "sandboxed command ran"},
                "contributions_pushed": "no",
                "plans": [],
            }
        ),
        encoding="utf-8",
    )
    text = render_text(home)
    assert "spending ledger is unreadable" in text
    assert "accepted link https://github.com/pallets/click" in text
    state_path(home).write_text("{", encoding="utf-8")
    assert "accepted link https://github.com/pallets/click" in render_text(home)
    state = tick(home)
    assert state["plans"] == []
    assert state["loop"]["status"] == "stopped"
    assert state["loop"]["reason"] == "spending ledger is unreadable"
    assert state["ledger"]["estimated_tokens"] >= 100
    assert not invoked.exists()
    assert not (home / "workspaces").exists() or not any((home / "workspaces").iterdir())
    again = tick(home)
    assert again["plans"] == []
    assert again["loop"]["reason"] == "spending ledger is unreadable"
    state_path(home).write_text("[]", encoding="utf-8")
    listed = tick(home)
    assert listed["plans"] == []
    assert listed["loop"]["reason"] == "spending ledger is unreadable"
    assert listed["ledger"]["estimated_tokens"] >= 100
    assert not invoked.exists()


def test_kept_drafts_drop_credential_urls_and_private_key_lines(tmp_path: Path) -> None:
    from idlehand.loop import _keep_drafts

    home = tmp_path / "home"
    workspace = tmp_path / "work"
    (workspace / ".idlehand").mkdir(parents=True)
    (workspace / ".idlehand" / "audit.txt").write_text(
        "https://user:sekret@github.com/org/repo.git\n-----BEGIN OPENSSH PRIVATE KEY-----\nfiles=1\n",
        encoding="utf-8",
    )
    _keep_drafts(home, workspace, "https://github.com/org/repo")
    kept = list((home / "drafts").rglob("audit.txt"))
    assert len(kept) == 1
    text = kept[0].read_text(encoding="utf-8")
    assert "sekret" not in text
    assert "BEGIN OPENSSH PRIVATE KEY" not in text
    assert "private key material omitted" in text
    assert "files=1" in text


def test_kept_drafts_do_not_write_through_a_directory_symlink(tmp_path: Path) -> None:
    from idlehand.loop import _keep_drafts

    home = tmp_path / "home"
    home.mkdir()
    outside = tmp_path / "outside"
    outside.mkdir()
    marker = outside / "marker"
    marker.write_text("keep", encoding="utf-8")
    (home / "drafts").symlink_to(outside)
    workspace = tmp_path / "work"
    (workspace / ".idlehand").mkdir(parents=True)
    (workspace / ".idlehand" / "audit.txt").write_text("finding\n", encoding="utf-8")
    _keep_drafts(home, workspace, "https://github.com/org/repo")
    assert marker.read_text(encoding="utf-8") == "keep"
    assert list(outside.rglob("audit.txt")) == []
    assert not (home / "drafts").is_dir() or (home / "drafts").is_symlink()


def test_kept_draft_file_symlink_and_oversized_draft_are_left_alone(tmp_path: Path) -> None:
    from idlehand.loop import _keep_drafts

    home = tmp_path / "home"
    workspace = tmp_path / "work"
    (workspace / ".idlehand").mkdir(parents=True)
    (workspace / ".idlehand" / "audit.txt").write_text("finding\n", encoding="utf-8")
    (workspace / ".idlehand" / "issue-draft.md").write_bytes(b"x" * 1_000_001)
    repo = "https://github.com/org/repo"
    _keep_drafts(home, workspace, repo)
    kept = list((home / "drafts").rglob("audit.txt"))
    assert len(kept) == 1
    assert kept[0].read_text(encoding="utf-8") == "finding\n"
    assert list((home / "drafts").rglob("issue-draft.md")) == []
    secret = tmp_path / "secret"
    secret.write_text("do-not-touch", encoding="utf-8")
    kept[0].unlink()
    kept[0].symlink_to(secret)
    (workspace / ".idlehand" / "audit.txt").write_text("replacement\n", encoding="utf-8")
    _keep_drafts(home, workspace, repo)
    assert secret.read_text(encoding="utf-8") == "do-not-touch"
    assert kept[0].is_symlink()


def test_audit_still_runs_when_idlehand_dir_is_a_file(tmp_path: Path, monkeypatch) -> None:
    home = tmp_path / "home"
    _connect(home, tmp_path, monkeypatch)
    config = _ready(home)
    config["subscription"] = "claude"
    config["sandbox"]["execute"] = True
    config["sandbox"]["runtime"] = "namespace"
    config["rules"]["allow_test"] = False
    config["rules"]["allow_issues"] = False
    config["rules"]["allow_pull_requests"] = False
    save_config(home, config)
    _local_source(
        home,
        tmp_path,
        {
            "readme.txt": "hello\n",
            "secret.pem": "-----BEGIN OPENSSH PRIVATE KEY-----\nHOSTKEYMATERIAL\n-----END OPENSSH PRIVATE KEY-----\n",
            ".idlehand": "not a directory\n",
        },
    )
    state = tick(home)
    plan = state["plans"][0]
    assert plan["contributed"] is True
    assert plan["sandbox"]["invoked"] is True
    assert plan["sandbox"]["ok"] is True
    assert "private key material" in plan["sandbox"]["stdout"]
    assert "HOSTKEYMATERIAL" not in plan["sandbox"]["stdout"]
    assert "idlehand-action=audit" in plan["sandbox"]["stdout"]


def test_unreadable_peer_fetch_interval_still_contributes(tmp_path: Path, monkeypatch) -> None:
    home = tmp_path / "home"
    _connect(home, tmp_path, monkeypatch)
    config = _ready(home)
    config["subscription"] = "claude"
    config["sandbox"]["execute"] = True
    config["sandbox"]["runtime"] = "namespace"
    config["estimate_tokens_per_cycle"] = 30
    config["publish"]["peer_fetch_interval_seconds"] = "soon"
    config["rules"]["allow_audit"] = False
    config["rules"]["allow_issues"] = False
    config["rules"]["allow_pull_requests"] = False
    save_config(home, config)
    _local_source(home, tmp_path)
    save_peers(
        home,
        [{"url": "https://user:sekret@peer.example/idlehand/publish", "id": "", "source": "user", "endorsements": 1}],
    )
    state = tick(home)
    assert state["plans"][0]["contributed"] is True
    assert state["peers_runtime"]["last_error"] == "peer fetch interval is unreadable"
    recorded = json.dumps(state) + (home / "publish.json").read_text(encoding="utf-8")
    assert "sekret" not in recorded
    assert "peer.example" in (home / "peers.toml").read_text(encoding="utf-8")


def test_non_finite_peer_interval_still_contributes(tmp_path: Path, monkeypatch) -> None:
    from idlehand.loop import _fetch_interval

    assert _fetch_interval(float("nan")) is None
    assert _fetch_interval(float("inf")) is None
    assert _fetch_interval(1.5) == 1.5
    home = tmp_path / "home"
    _connect(home, tmp_path, monkeypatch)
    config = _ready(home)
    config["subscription"] = "claude"
    config["sandbox"]["execute"] = True
    config["sandbox"]["runtime"] = "namespace"
    config["estimate_tokens_per_cycle"] = 30
    config["publish"]["peer_fetch_interval_seconds"] = float("nan")
    config["rules"]["allow_audit"] = False
    config["rules"]["allow_issues"] = False
    config["rules"]["allow_pull_requests"] = False
    save_config(home, config)
    _local_source(home, tmp_path)
    state = tick(home)
    assert state["plans"][0]["contributed"] is True
    assert state["peers_runtime"]["last_error"] == "peer fetch interval is unreadable"


def test_encoded_credential_in_the_source_list_is_not_recorded(tmp_path: Path, monkeypatch) -> None:
    home = tmp_path / "home"
    _connect(home, tmp_path, monkeypatch)
    config = _ready(home)
    config["subscription"] = "claude"
    config["sandbox"]["execute"] = True
    config["sandbox"]["runtime"] = "namespace"
    config["estimate_tokens_per_cycle"] = 30
    save_config(home, config)
    save_sources(home, [{"url": "https://github.com/org/repo.git%3Ftoken%3Dsekret", "note": "encoded"}])
    state = tick(home)
    plan = state["plans"][0]
    assert plan["contributed"] is False
    assert plan["upstream_cloned"] is False
    assert plan["repo"] == "https://github.com/org/repo.git"
    assert state["ledger"]["estimated_tokens"] == 0
    blob = json.dumps(state) + (home / "publish.json").read_text(encoding="utf-8")
    if (home / "node.log").exists():
        blob += (home / "node.log").read_text(encoding="utf-8")
    assert "sekret" not in blob
    assert "token=" not in blob


def test_non_integer_peer_counters_do_not_stop_the_cycle(tmp_path: Path, monkeypatch) -> None:
    from idlehand.config import state_path
    from idlehand.home import write_json
    from idlehand.loop import load_state

    home = tmp_path / "home"
    _connect(home, tmp_path, monkeypatch)
    config = _ready(home)
    config["subscription"] = "claude"
    config["sandbox"]["execute"] = True
    config["sandbox"]["runtime"] = "namespace"
    config["estimate_tokens_per_cycle"] = 30
    config["rules"]["allow_audit"] = False
    config["rules"]["allow_issues"] = False
    config["rules"]["allow_pull_requests"] = False
    save_config(home, config)
    _local_source(home, tmp_path)
    document = {
        "idlehand": 1,
        "node_id": "peer-b",
        "peers": [{"url": "https://second.example/idlehand/publish", "id": "second"}],
        "repos": [{"url": "https://github.com/someone/not-imported"}],
    }
    peer_file = tmp_path / "peer.json"
    peer_file.write_text(json.dumps(document), encoding="utf-8")
    save_peers(home, [{"url": peer_file.as_uri(), "id": "", "source": "user", "endorsements": 1}])
    stored = load_state(home, config)
    stored["peers_runtime"]["added"] = "no"
    stored["peers_runtime"]["ignored_remote_repos"] = "no"
    write_json(state_path(home), stored)
    state = tick(home)
    assert state["plans"][0]["contributed"] is True
    assert state["peers_runtime"]["added"] == 1
    assert state["peers_runtime"]["ignored_remote_repos"] == 1
    assert "https://github.com/someone/not-imported" not in (home / "sources.toml").read_text(encoding="utf-8")


def test_unreadable_trust_file_does_not_skip_the_cycle(tmp_path: Path, monkeypatch) -> None:
    home = tmp_path / "home"
    _connect(home, tmp_path, monkeypatch)
    config = _ready(home)
    config["subscription"] = "claude"
    config["sandbox"]["execute"] = True
    config["sandbox"]["runtime"] = "namespace"
    config["estimate_tokens_per_cycle"] = 30
    config["rules"]["allow_audit"] = False
    config["rules"]["allow_issues"] = False
    config["rules"]["allow_pull_requests"] = False
    save_config(home, config)
    _local_source(home, tmp_path)
    peer = tmp_path / "peer.json"
    peer.write_text(
        '{"peers":[{"url":"https://second.example/idlehand/publish","id":"second"}],"repos":[]}\n',
        encoding="utf-8",
    )
    save_peers(home, [{"url": peer.as_uri(), "id": "", "source": "user", "endorsements": 1}])
    (home / "trust.json").write_text("{\n", encoding="utf-8")
    before = render_text(home)
    assert "trust record is unreadable" in before
    assert "spending:" in before
    state = tick(home)
    assert state["plans"][0]["contributed"] is True
    text = render_text(home)
    assert "trust record is unreadable" not in text
    assert "accepted peer https://second.example/idlehand/publish" in text
    assert "spending:" in text
    loaded = json.loads((home / "trust.json").read_text(encoding="utf-8"))
    assert isinstance(loaded, list) and loaded


def test_trust_symlink_and_object_are_not_shown(tmp_path: Path) -> None:
    from idlehand.trust import decision, remember

    home = tmp_path / "home"
    ensure_home(home)
    (home / "trust.json").write_text('{"reason": "sekret"}\n', encoding="utf-8")
    hidden = render_text(home)
    assert "sekret" not in hidden
    assert "trust record is unreadable" in hidden
    assert "spending:" in hidden
    outside = tmp_path / "outside.json"
    outside.write_text(
        '[{"kind":"link","subject":"https://sekret.example/a","accepted":true,"reason":"sekret"}]\n',
        encoding="utf-8",
    )
    trust = home / "trust.json"
    trust.unlink()
    trust.symlink_to(outside)
    linked = render_text(home)
    assert "sekret" not in linked
    assert "trust record is unreadable" in linked
    remember(home, [decision("link", "https://github.com/org/repo", False, "repository URL embeds credentials")])
    assert "sekret" in outside.read_text(encoding="utf-8")
    assert not trust.is_symlink()
    stored = trust.read_text(encoding="utf-8")
    assert "sekret" not in stored
    assert "credentials" in stored
    assert "trust record is unreadable" not in render_text(home)


def test_atomic_write_does_not_follow_a_temp_symlink(tmp_path: Path) -> None:
    from idlehand.home import atomic_write

    home = tmp_path / "home"
    home.mkdir()
    outside = tmp_path / "outside"
    outside.write_text("sekret", encoding="utf-8")
    target = home / "state.json"
    temporary = home / "state.json.tmp"
    temporary.symlink_to(outside)
    atomic_write(target, '{"ok": true}\n')
    assert outside.read_text(encoding="utf-8") == "sekret"
    assert not temporary.exists()
    assert target.read_text(encoding="utf-8") == '{"ok": true}\n'
    destination = tmp_path / "destination"
    destination.write_text("keep-dest", encoding="utf-8")
    target.unlink()
    target.symlink_to(destination)
    atomic_write(target, '{"ok": true}\n')
    assert destination.read_text(encoding="utf-8") == "keep-dest"
    assert not target.is_symlink()
    assert target.read_text(encoding="utf-8") == '{"ok": true}\n'


def test_unreadable_config_stops_before_a_clone(tmp_path: Path, monkeypatch) -> None:
    from idlehand.config import state_path
    from idlehand.home import write_json
    from idlehand.loop import load_state

    home = tmp_path / "home"
    _connect(home, tmp_path, monkeypatch)
    config = _ready(home)
    config["subscription"] = "claude"
    config["sandbox"]["execute"] = True
    config["sandbox"]["runtime"] = "namespace"
    config["estimate_tokens_per_cycle"] = 30
    save_config(home, config)
    _local_source(home, tmp_path)
    stored = load_state(home, config)
    stored["ledger"]["estimated_tokens"] = 25
    write_json(state_path(home), stored)
    (home / "config.toml").write_text("{\nsekret\n", encoding="utf-8")
    state = tick(home)
    assert state["loop"]["reason"] == "config is unreadable"
    assert state["loop"]["status"] == "stopped"
    assert state["ledger"]["estimated_tokens"] == 25
    assert state["plans"] == []
    assert "sekret" not in json.dumps(state)
    assert list((home / "workspaces").iterdir()) == []


def test_unreadable_source_list_does_not_clone(tmp_path: Path, monkeypatch) -> None:
    home = tmp_path / "home"
    _connect(home, tmp_path, monkeypatch)
    config = _ready(home)
    config["subscription"] = "claude"
    config["sandbox"]["execute"] = True
    config["sandbox"]["runtime"] = "namespace"
    config["estimate_tokens_per_cycle"] = 30
    save_config(home, config)
    _local_source(home, tmp_path)
    (home / "sources.toml").write_text("{\nsekret\n", encoding="utf-8")
    state = tick(home)
    assert state["loop"]["reason"] == "the local source list is unreadable"
    assert state["plans"] == []
    assert state["ledger"]["estimated_tokens"] == 0
    assert "sekret" not in json.dumps(state)
    assert "sekret" in (home / "sources.toml").read_text(encoding="utf-8")
    assert list((home / "workspaces").iterdir()) == []


def test_unreadable_peer_list_still_contributes(tmp_path: Path, monkeypatch) -> None:
    home = tmp_path / "home"
    _connect(home, tmp_path, monkeypatch)
    config = _ready(home)
    config["subscription"] = "claude"
    config["sandbox"]["execute"] = True
    config["sandbox"]["runtime"] = "namespace"
    config["estimate_tokens_per_cycle"] = 30
    config["rules"]["allow_audit"] = False
    config["rules"]["allow_issues"] = False
    config["rules"]["allow_pull_requests"] = False
    save_config(home, config)
    _local_source(home, tmp_path)
    (home / "peers.toml").write_text("{\nsekret\n", encoding="utf-8")
    state = tick(home)
    assert state["plans"][0]["contributed"] is True
    assert state["peers_runtime"]["last_error"] == "the peer list is unreadable"
    assert "sekret" not in json.dumps(state)
    assert "sekret" in (home / "peers.toml").read_text(encoding="utf-8")
    assert not (home / "publish.json").exists()


def test_analytics_shows_spending_and_trust_when_lists_are_unreadable(tmp_path: Path) -> None:
    from idlehand.analytics import render_json
    from idlehand.config import state_path
    from idlehand.home import write_json

    home = tmp_path / "home"
    ensure_home(home)
    (home / "config.toml").write_text("{\nsekret\n", encoding="utf-8")
    (home / "sources.toml").write_text("{\nsekret\n", encoding="utf-8")
    (home / "peers.toml").write_text("{\nsekret\n", encoding="utf-8")
    write_json(
        state_path(home),
        {
            "ledger": {
                "estimated_tokens": 10,
                "metered_tokens": 0,
                "limit_tokens": 100,
                "metering": "local-estimate",
            },
            "plans": [],
            "loop": {"status": "stopped", "reason": "config is unreadable"},
        },
    )
    (home / "trust.json").write_text(
        json.dumps(
            [
                {
                    "kind": "link",
                    "subject": "https://github.com/org/repo",
                    "accepted": False,
                    "reason": "repository URL embeds credentials",
                }
            ]
        ),
        encoding="utf-8",
    )
    text = render_text(home)
    assert "spending: 10 / 100" in text
    assert "config is unreadable" in text
    assert "the local source list is unreadable" in text
    assert "the peer list is unreadable" in text
    assert "refused link https://github.com/org/repo — repository URL embeds credentials" in text
    rendered = text + render_json(home)
    assert "sekret" not in rendered


def test_state_symlink_does_not_reset_the_ledger(tmp_path: Path, monkeypatch) -> None:
    home = tmp_path / "home"
    _connect(home, tmp_path, monkeypatch)
    config = _ready(home)
    config["subscription"] = "claude"
    config["sandbox"]["execute"] = True
    config["sandbox"]["runtime"] = "namespace"
    config["spending_limit_tokens"] = 100
    config["estimate_tokens_per_cycle"] = 30
    save_config(home, config)
    _local_source(home, tmp_path)
    (home / "trust.json").write_text(
        json.dumps(
            [
                {
                    "kind": "link",
                    "subject": "https://github.com/org/repo",
                    "accepted": False,
                    "reason": "repository URL embeds credentials",
                }
            ]
        ),
        encoding="utf-8",
    )
    outside = tmp_path / "outside.json"
    outside.write_text(
        json.dumps(
            {
                "ledger": {
                    "estimated_tokens": 0,
                    "metered_tokens": 0,
                    "metering": "local-estimate",
                },
                "plans": [{"repo": "sekret", "contributed": True, "pushed": False}],
                "loop": {"cycles": 0, "status": "running", "reason": ""},
            }
        ),
        encoding="utf-8",
    )
    state_file = home / "state.json"
    if state_file.exists() or state_file.is_symlink():
        state_file.unlink()
    state_file.symlink_to(outside)
    before = render_text(home)
    assert "sekret" not in before
    assert "spending ledger is unreadable" in before
    assert "refused link https://github.com/org/repo" in before
    state = tick(home)
    assert outside.read_text(encoding="utf-8").count("sekret") == 1
    assert not state_file.is_symlink()
    assert state["loop"]["reason"] == "spending ledger is unreadable"
    assert state["ledger"]["estimated_tokens"] == 100
    assert state["plans"] == []
    assert "sekret" not in json.dumps(state)
    assert list((home / "workspaces").iterdir()) == []


def test_node_log_symlink_is_not_appended(tmp_path: Path, monkeypatch) -> None:
    home = tmp_path / "home"
    _connect(home, tmp_path, monkeypatch)
    config = _ready(home)
    config["subscription"] = "claude"
    config["sandbox"]["execute"] = True
    config["sandbox"]["runtime"] = "namespace"
    config["estimate_tokens_per_cycle"] = 30
    config["rules"]["allow_audit"] = False
    config["rules"]["allow_issues"] = False
    config["rules"]["allow_pull_requests"] = False
    save_config(home, config)
    _local_source(home, tmp_path)
    outside = tmp_path / "outside.log"
    outside.write_text("sekret\n", encoding="utf-8")
    log = home / "node.log"
    log.symlink_to(outside)
    state = tick(home)
    assert state["plans"][0]["contributed"] is True
    assert log.is_symlink()
    assert outside.read_text(encoding="utf-8") == "sekret\n"
    assert "sekret" not in json.dumps(state)
