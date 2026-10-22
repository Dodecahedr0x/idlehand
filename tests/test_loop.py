import json
from pathlib import Path

from fossah.config import ensure_home, load_sources, save_config, save_peers
from fossah.loop import tick


def _ready(home: Path, **updates):
    config = ensure_home(home)
    config["sandbox"]["execute"] = False
    config["publish"]["peer_fetch_interval_seconds"] = 0
    config["loop_interval_seconds"] = 0.01
    config.update(updates)
    save_config(home, config)
    return config


def test_connected_loop_plans_issue_and_pr_without_running_the_cli(tmp_path: Path, monkeypatch) -> None:
    home = tmp_path / "home"
    bin_dir = tmp_path / "bin"
    bin_dir.mkdir()
    invoked = tmp_path / "claude-invoked"
    script = bin_dir / "claude"
    script.write_text(f"#!/bin/sh\necho hit >> '{invoked}'\n", encoding="utf-8")
    script.chmod(0o755)
    monkeypatch.setenv("PATH", f"{bin_dir}:/usr/bin:/bin")
    config = _ready(home)
    config["subscription"] = "claude"
    config["spending_limit_tokens"] = 400
    config["estimate_tokens_per_cycle"] = 100
    save_config(home, config)
    state = {}
    for _ in range(4):
        state = tick(home)
    assert state["subscription"]["connected"] is True
    assert [plan["action"] for plan in state["plans"]] == ["test", "audit", "issue", "pull_request"]
    assert state["ledger"]["estimated_tokens"] == 400
    assert state["loop"]["status"] == "stopped"
    assert state["contributions_pushed"] == 0
    assert all(plan["contributed"] is False for plan in state["plans"])
    assert all(plan["subscription_executed"] is False for plan in state["plans"])
    assert all(plan["upstream_cloned"] is False for plan in state["plans"])
    assert "owned" not in json.dumps(state["plans"])
    pull = state["plans"][-1]
    assert pull["subscription_command"][1] == "-p"
    assert "pull request" in pull["subscription_command"][2].lower()
    assert not invoked.exists()
    stopped = tick(home)
    assert len(stopped["plans"]) == 4
    assert stopped["ledger"]["estimated_tokens"] == 400


def test_missing_cli_does_not_pretend_to_contribute(tmp_path: Path, monkeypatch) -> None:
    home = tmp_path / "home"
    monkeypatch.setenv("PATH", "/usr/bin:/bin")
    config = _ready(home)
    config["subscription"] = "codex"
    save_config(home, config)
    state = tick(home)
    assert state["subscription"]["connected"] is False
    assert "not connected" in state["subscription"]["detail"]
    assert state["plans"] == []
    assert state["loop"]["status"] == "idle"
    assert state["contributions_pushed"] == 0


def test_limit_resumes_when_raised(tmp_path: Path, monkeypatch) -> None:
    home = tmp_path / "home"
    bin_dir = tmp_path / "bin"
    bin_dir.mkdir()
    (bin_dir / "codex").write_text("#!/bin/sh\nexit 0\n", encoding="utf-8")
    (bin_dir / "codex").chmod(0o755)
    monkeypatch.setenv("PATH", f"{bin_dir}:/usr/bin:/bin")
    config = _ready(home)
    config["subscription"] = "codex"
    config["spending_limit_tokens"] = 100
    config["estimate_tokens_per_cycle"] = 100
    save_config(home, config)
    first = tick(home)
    assert first["ledger"]["estimated_tokens"] == 100
    assert first["loop"]["status"] == "stopped"
    config = _ready(home)
    config["subscription"] = "codex"
    config["spending_limit_tokens"] = 300
    config["estimate_tokens_per_cycle"] = 100
    save_config(home, config)
    second = tick(home)
    assert second["ledger"]["estimated_tokens"] == 200
    assert second["loop"]["status"] == "running"


def test_peer_fetch_adds_peers_not_repos(tmp_path: Path) -> None:
    home = tmp_path / "home"
    _ready(home)
    before = [repo["url"] for repo in load_sources(home)]
    document = {
        "fossah": 1,
        "node_id": "peer-b",
        "peers": [{"url": "https://second.example/fossah/publish", "id": "second"}],
        "repos": [{"url": "https://github.com/someone/not-imported"}],
    }
    peer_file = tmp_path / "peer.json"
    peer_file.write_text(json.dumps(document), encoding="utf-8")
    save_peers(home, [{"url": peer_file.as_uri(), "id": "", "source": "user", "endorsements": 1}])
    state = tick(home)
    peers_file = (home / "peers.toml").read_text(encoding="utf-8")
    assert "https://second.example/fossah/publish" in peers_file
    assert "peers-of-peers" in peers_file
    assert [repo["url"] for repo in load_sources(home)] == before
    assert "https://github.com/someone/not-imported" not in (home / "sources.toml").read_text(encoding="utf-8")
    assert state["peers_runtime"]["ignored_remote_repos"] == 1
    published = json.loads((home / "publish.json").read_text(encoding="utf-8"))
    assert "subscription" not in published
    assert "ledger" not in published
    assert published["repos"]


def test_sandbox_probe_is_not_a_contribution(tmp_path: Path, monkeypatch) -> None:
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
    state = tick(home)
    plan = state["plans"][0]
    assert plan["demo"] is True
    assert plan["action"] == "test"
    assert plan["contributed"] is False
    assert plan["sandbox"]["ok"] is True
    assert "fossah-sandbox-ok" in plan["sandbox"]["stdout"]
    assert "sk-openai" not in json.dumps(plan["sandbox"])
    assert state["contributions_pushed"] == 0
