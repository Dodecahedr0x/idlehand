import hashlib
import json
import subprocess
from pathlib import Path

from idlehand.analytics import render_text
from idlehand.cli import main
from idlehand.config import DEFAULT_CONFIG, load_config
from idlehand.forge import load_delegated
from idlehand.loop import tick
from idlehand.peers import publish_document, review_second_degree
from idlehand.sandbox import build_container_argv

NID = "z6MknSLrJoTcukLrE435hVNQT4JUhbvWLX4kUzqkEStBU8Vi"
RID = "rad:z3gqcJUoA1n9HaHKufZs5FCSGazv5"
ISSUE = "e4255cc2a0a65b543c2b5badac14bf9e0d9f409f"
PATCH = "89f7afb1511b976482b21f6b2f39aef7f4fb88a2"
OTHER = "z6Mkt67GdsW7715MEfRuP4pSZxJRJh6kj6Y48WRqVv4N1tRk"

_RAD = """#!/bin/sh
printf '%s\\n' "$*" >> "$IDLEHAND_RAD_LOG"
mode="${IDLEHAND_RAD_FAKE:-ok}"
if [ "$1" = "self" ] && [ "$2" = "--nid" ]; then
  printf '%s\\n' "$IDLEHAND_RAD_NID"
  exit 0
fi
if [ "$1" = "self" ] && [ "$2" = "--did" ]; then
  printf '%s\\n' "did:key:$IDLEHAND_RAD_NID"
  exit 0
fi
if [ "$1" = "node" ] && [ "$2" = "status" ]; then
  if [ "$mode" = "stopped" ]; then
    printf '%s\\n' "Node is stopped."
    exit 0
  fi
  printf '%s\\n' "Node is running with Node ID $IDLEHAND_RAD_NID"
  exit 0
fi
if [ "$1" = "inspect" ]; then
  if [ "$mode" = "outsider" ]; then
    printf '%s\\n' '{"delegates":["did:key:__OTHER__"],"threshold":1}'
    exit 0
  fi
  if [ "$mode" = "garbage" ]; then
    printf '%s\\n' "not json"
    exit 0
  fi
  printf '%s\\n' "{\\"delegates\\":[\\"did:key:$IDLEHAND_RAD_NID\\"],\\"threshold\\":1}"
  exit 0
fi
if [ "$1" = "issue" ] && [ "$2" = "open" ]; then
  if [ "$mode" = "fail" ]; then
    printf '%s\\n' "RAD_PASSPHRASE=sekret" >&2
    exit 1
  fi
  if [ "$mode" = "silent" ]; then
    exit 0
  fi
  printf '%s\\n' "Issue __ISSUE__"
  exit 0
fi
if [ "$1" = "issue" ] && [ "$2" = "edit" ]; then
  printf '%s\\n' "Issue $3"
  exit 0
fi
if [ "$1" = "patch" ] && [ "$2" = "edit" ]; then
  exit 0
fi
if [ "$1" = "." ]; then
  printf '%s\\n' "$IDLEHAND_RAD_RID"
  exit 0
fi
if [ "$1" = "patch" ] && [ "$2" = "checkout" ]; then
  exit 0
fi
if [ "$1" = "patch" ] && [ "$2" = "review" ]; then
  exit 0
fi
exit 1
"""


def _rad(tmp_path: Path, monkeypatch) -> Path:
    log = tmp_path / "rad-args"
    bin_dir = tmp_path / "bin"
    bin_dir.mkdir()
    script = bin_dir / "rad"
    body = _RAD.replace("__OTHER__", OTHER).replace("__ISSUE__", ISSUE)
    script.write_text(body, encoding="utf-8")
    script.chmod(0o755)
    monkeypatch.setenv("PATH", f"{bin_dir}:/usr/bin:/bin")
    monkeypatch.setenv("IDLEHAND_RAD_LOG", str(log))
    monkeypatch.setenv("IDLEHAND_RAD_NID", NID)
    monkeypatch.setenv("IDLEHAND_RAD_RID", RID)
    monkeypatch.setenv("IDLEHAND_RAD_FAKE", "ok")
    monkeypatch.setenv("RAD_PASSPHRASE", "rad-passphrase-sekret")
    return log


def _draft(home: Path, filename: str, text: str) -> None:
    slug = hashlib.sha256(RID.encode()).hexdigest()[:16]
    directory = home / "drafts" / slug
    directory.mkdir(parents=True, exist_ok=True)
    (directory / filename).write_text(text, encoding="utf-8")


def test_missing_rad_does_not_delegate_or_block_init(tmp_path: Path, monkeypatch, capsys) -> None:
    empty = tmp_path / "empty-bin"
    empty.mkdir()
    monkeypatch.setenv("PATH", str(empty))
    monkeypatch.setenv("XDG_DATA_HOME", str(tmp_path / "xdg-data"))
    monkeypatch.setenv("XDG_CONFIG_HOME", str(tmp_path / "xdg-config"))
    home = tmp_path / "home"
    assert main(["--home", str(home), "init"]) == 0
    captured = capsys.readouterr()
    assert "rad is not installed" in captured.out
    assert "stays local" in captured.out
    assert "Radicle node id" not in captured.out
    node_id = load_config(home)["node_id"]
    assert node_id and not str(node_id).startswith("z6Mk")
    assert main(["--home", str(home), "rad", "delegate", RID]) == 1
    captured = capsys.readouterr()
    assert "rad is not installed" in captured.err
    assert "delegated" not in captured.out
    assert not (home / "delegated.toml").exists()
    assert main(["--home", str(home), "rad", "issue", "create", RID, "--title", "T", "--body", "B"]) == 1
    captured = capsys.readouterr()
    assert "not delegated" in captured.err
    assert "opened issue" not in captured.out


def test_a_stopped_node_or_another_delegates_repo_is_not_delegated(tmp_path: Path, monkeypatch, capsys) -> None:
    log = _rad(tmp_path, monkeypatch)
    home = tmp_path / "home"
    monkeypatch.setenv("IDLEHAND_RAD_FAKE", "stopped")
    assert main(["--home", str(home), "rad", "delegate", RID]) == 1
    captured = capsys.readouterr()
    assert "not running" in captured.err
    assert "delegated" not in captured.out
    assert not (home / "delegated.toml").exists()
    assert "issue" not in log.read_text(encoding="utf-8")

    monkeypatch.setenv("IDLEHAND_RAD_FAKE", "outsider")
    assert main(["--home", str(home), "rad", "delegate", RID]) == 1
    assert "does not control" in capsys.readouterr().err
    assert not (home / "delegated.toml").exists()

    monkeypatch.setenv("IDLEHAND_RAD_FAKE", "garbage")
    assert main(["--home", str(home), "rad", "delegate", RID]) == 1
    assert "could not show" in capsys.readouterr().err
    assert not (home / "delegated.toml").exists()
    assert main(["--home", str(home), "rad", "delegate", "octocat/hello"]) == 1
    assert "rad:z" in capsys.readouterr().err


def test_delegate_is_explicit_and_issues_and_patches_use_rad(tmp_path: Path, monkeypatch, capsys) -> None:
    log = _rad(tmp_path, monkeypatch)
    monkeypatch.setenv("XDG_DATA_HOME", str(tmp_path / "xdg-data"))
    monkeypatch.setenv("XDG_CONFIG_HOME", str(tmp_path / "xdg-config"))
    home = tmp_path / "home"
    assert main(["--home", str(home), "init"]) == 0
    assert load_config(home)["node_id"] == NID
    assert f"Radicle node id: {NID}" in capsys.readouterr().out

    assert main(["--home", str(home), "rad", "issue", "create", RID, "--title", "T", "--body", "Body"]) == 1
    assert "not delegated" in capsys.readouterr().err
    assert "issue open" not in log.read_text(encoding="utf-8")

    assert main(["--home", str(home), "rad", "status"]) == 0
    assert main(["--home", str(home), "rad", "delegate", RID]) == 0
    assert "delegated " + RID in capsys.readouterr().out
    text = (home / "delegated.toml").read_text(encoding="utf-8")
    assert text.count("[[repos]]") == 1
    assert 'provider = "radicle"' in text
    assert f'repo = "{RID}"' in text
    assert "rad-passphrase-sekret" not in text
    assert main(["--home", str(home), "rad", "delegate", RID]) == 0
    assert "already delegated" in capsys.readouterr().out
    assert (home / "delegated.toml").read_text(encoding="utf-8").count("[[repos]]") == 1

    log.write_text("", encoding="utf-8")
    assert (
        main(
            ["--home", str(home), "rad", "issue", "create", RID, "--title", "Broken link", "--body", "The README link 404s."]
        )
        == 0
    )
    recorded = log.read_text(encoding="utf-8")
    assert f"issue open --repo {RID} --title Broken link --description The README link 404s." in recorded
    assert "opened issue " + ISSUE in capsys.readouterr().out
    assert (
        main(["--home", str(home), "rad", "issue", "update", RID, ISSUE, "--body", "Still broken."])
        == 0
    )
    assert f"issue edit {ISSUE} --repo {RID} --description Still broken." in log.read_text(encoding="utf-8")

    log.write_text("", encoding="utf-8")
    _draft(home, "issue-draft.md", "# Draft title\n\nDraft body.\n")
    assert main(["--home", str(home), "rad", "issue", "send", RID]) == 0
    assert "issue open --repo" in log.read_text(encoding="utf-8")
    assert "Draft title" in log.read_text(encoding="utf-8")

    log.write_text("", encoding="utf-8")
    assert (
        main(
            [
                "--home",
                str(home),
                "rad",
                "patch",
                "update",
                RID,
                PATCH,
                "--title",
                "Fix the link",
                "--body",
                "Updates the README.",
            ]
        )
        == 0
    )
    recorded = log.read_text(encoding="utf-8")
    assert f"patch edit {PATCH} --repo {RID} --message Fix the link --message Updates the README." in recorded
    assert "git push" not in recorded
    assert "--push" not in recorded
    _draft(home, "pr-draft.md", "# Patch draft\n\nPatch body.\n")
    assert main(["--home", str(home), "rad", "patch", "send", RID, PATCH]) == 0
    assert "Patch draft" in log.read_text(encoding="utf-8")

    log.write_text("", encoding="utf-8")
    assert (
        main(
            [
                "--home",
                str(home),
                "rad",
                "issue",
                "create",
                RID,
                "--title",
                "T",
                "--body",
                "-----BEGIN OPENSSH PRIVATE KEY-----\nabc\n",
            ]
        )
        == 1
    )
    assert "private key" in capsys.readouterr().err
    assert log.read_text(encoding="utf-8") == ""


def test_unconfirmed_rad_does_not_say_the_issue_was_opened(tmp_path: Path, monkeypatch, capsys) -> None:
    _rad(tmp_path, monkeypatch)
    home = tmp_path / "home"
    assert main(["--home", str(home), "rad", "delegate", RID]) == 0
    monkeypatch.setenv("IDLEHAND_RAD_FAKE", "silent")
    assert main(["--home", str(home), "rad", "issue", "create", RID, "--title", "T", "--body", "B"]) == 1
    captured = capsys.readouterr()
    assert "did not confirm" in captured.err
    assert "opened issue" not in captured.out
    monkeypatch.setenv("IDLEHAND_RAD_FAKE", "fail")
    assert main(["--home", str(home), "rad", "issue", "create", RID, "--title", "T", "--body", "B"]) == 1
    captured = capsys.readouterr()
    assert "did not confirm" in captured.err
    assert "sekret" not in captured.err
    assert "RAD_PASSPHRASE" not in captured.err
    blob = (home / "delegated.toml").read_text(encoding="utf-8")
    assert "sekret" not in blob


def test_keys_stay_out_of_analytics_publish_and_the_loop(tmp_path: Path, monkeypatch) -> None:
    log = _rad(tmp_path, monkeypatch)
    home = tmp_path / "home"
    assert main(["--home", str(home), "rad", "delegate", RID]) == 0
    text = render_text(home)
    assert "delegated: 1" in text
    assert f"radicle {RID}" in text
    assert "rad-passphrase-sekret" not in text
    document = publish_document(
        node_id=NID,
        listen_url="http://127.0.0.1:9/idlehand/publish",
        peers=[{"url": "https://peer.example/idlehand/publish", "id": NID}],
        repos=[],
    )
    encoded = json.dumps(document)
    assert NID in encoded
    assert "delegated" not in document
    assert "rad-passphrase-sekret" not in encoded
    chosen, _decisions = review_second_degree(
        self_id="self",
        self_urls=set(),
        direct_peers=[{"url": "https://direct.example/p"}],
        documents={"https://direct.example/p": {"peers": [{"url": "https://second.example/p", "id": NID}]}},
        existing_urls=set(),
        heuristic=DEFAULT_CONFIG["peer_heuristic"],
    )
    assert chosen[0].peer_id == NID
    log.write_text("", encoding="utf-8")
    tick(home)
    assert log.read_text(encoding="utf-8") == ""
    blob = "\n".join(path.read_text(encoding="utf-8") for path in home.rglob("*") if path.is_file())
    assert "rad-passphrase-sekret" not in blob
    workspace = tmp_path / "workspace"
    workspace.mkdir()
    argv = build_container_argv(
        "docker",
        workspace,
        ["python3", "-c", "print(1)"],
        image="python:3.12-slim",
        memory="512m",
        cpus="1",
    )
    joined = " ".join(argv)
    assert "RAD_HOME" not in joined
    assert "RAD_PASSPHRASE" not in joined
    assert "GH_TOKEN" not in joined


def test_revoke_is_local_and_a_symlink_is_not_followed(tmp_path: Path, monkeypatch, capsys) -> None:
    _rad(tmp_path, monkeypatch)
    home = tmp_path / "home"
    assert main(["--home", str(home), "rad", "delegate", RID]) == 0
    empty = tmp_path / "empty-bin"
    empty.mkdir()
    monkeypatch.setenv("PATH", str(empty))
    assert main(["--home", str(home), "rad", "revoke", RID]) == 0
    assert RID not in (home / "delegated.toml").read_text(encoding="utf-8")

    outside = tmp_path / "outside.toml"
    outside.write_text("untouched\n", encoding="utf-8")
    link = home / "delegated.toml"
    link.unlink()
    link.symlink_to(outside)
    monkeypatch.setenv("PATH", f"{tmp_path / 'bin'}:/usr/bin:/bin")
    assert main(["--home", str(home), "rad", "delegate", RID]) == 1
    assert "unreadable" in capsys.readouterr().err
    assert outside.read_text(encoding="utf-8") == "untouched\n"


def _git_dir(tmp_path: Path) -> Path:
    checkout = tmp_path / "checkout"
    checkout.mkdir()
    (checkout / ".git").mkdir()
    return checkout


def test_a_listed_repo_can_open_an_issue_and_a_patch(tmp_path: Path, monkeypatch, capsys) -> None:
    from idlehand.config import ensure_home, save_sources

    _rad(tmp_path, monkeypatch)
    home = tmp_path / "home"
    ensure_home(home)
    save_sources(home, [{"url": RID, "note": "IdleHand"}])
    checkout = _git_dir(tmp_path)
    calls: list[tuple[str, str]] = []

    def push(path: Path, title: str, body: str) -> subprocess.CompletedProcess[str]:
        calls.append((title, body))
        return subprocess.CompletedProcess(["git"], 0, "", f"Patch {PATCH} opened\n")

    monkeypatch.setattr("idlehand.radicle._git_push", push)
    assert main(["--home", str(home), "rad", "issue", "create", RID, "--title", "Broken link", "--body", "The README link 404s."]) == 0
    assert not (home / "delegated.toml").exists()
    assert main(["--home", str(home), "rad", "patch", "open", RID, "--path", str(checkout), "--title", "Fix the link", "--body", "Updates the README."]) == 0
    captured = capsys.readouterr()
    assert f"opened patch {PATCH}" in captured.out
    assert calls == [("Fix the link", "Updates the README.")]
    assert "rad-passphrase-sekret" not in captured.out
    calls.clear()
    other = "rad:z42hL2jL4XNk6K8oHQaSWfMgCL7ji"
    assert main(["--home", str(home), "rad", "patch", "open", other, "--path", str(checkout), "--title", "No", "--body", "No."]) == 1
    assert "not delegated" in capsys.readouterr().err
    assert calls == []
    assert main(
        [
            "--home",
            str(home),
            "rad",
            "patch",
            "open",
            RID,
            "--path",
            str(checkout),
            "--title",
            "T",
            "--body",
            "-----BEGIN OPENSSH PRIVATE KEY-----\nabc\n",
        ]
    ) == 1
    assert calls == []


def test_patch_check_needs_a_sandbox_and_a_delegation(tmp_path: Path, monkeypatch, capsys) -> None:
    from idlehand.sandbox import SandboxResult

    log = _rad(tmp_path, monkeypatch)
    home = tmp_path / "home"
    checkout = _git_dir(tmp_path)
    assert main(["--home", str(home), "rad", "patch", "check", RID, PATCH, "--path", str(checkout)]) == 1
    assert "not delegated" in capsys.readouterr().err
    assert not log.exists() or "patch review" not in log.read_text(encoding="utf-8")
    assert main(["--home", str(home), "rad", "delegate", RID]) == 0

    def refused(*_args: object, **_kwargs: object) -> SandboxResult:
        return SandboxResult("namespace", False, False, None, "", "", "refused to run on the host", [])

    monkeypatch.setattr("idlehand.radicle.run_sandbox", refused)
    log.write_text("", encoding="utf-8")
    assert main(["--home", str(home), "rad", "patch", "check", RID, PATCH, "--path", str(checkout)]) == 1
    captured = capsys.readouterr()
    assert "did not run" in captured.err
    assert "accepted" not in captured.out
    assert "refused patch" not in captured.out
    assert "patch review" not in log.read_text(encoding="utf-8")

    def failed(*_args: object, **_kwargs: object) -> SandboxResult:
        return SandboxResult("namespace", True, False, 1, "", "nope", "sandbox exited 1", ["python"])

    monkeypatch.setattr("idlehand.radicle.run_sandbox", failed)
    log.write_text("", encoding="utf-8")
    assert main(["--home", str(home), "rad", "patch", "check", RID, PATCH, "--path", str(checkout)]) == 0
    captured = capsys.readouterr()
    assert f"refused patch {PATCH}" in captured.out
    assert "accepted" not in captured.out
    recorded = log.read_text(encoding="utf-8")
    assert "--reject" in recorded
    assert "--accept" not in recorded

    def passed(*_args: object, **_kwargs: object) -> SandboxResult:
        return SandboxResult("namespace", True, True, 0, "idlehand-action=test\n", "", "sandbox command finished", ["python"])

    monkeypatch.setattr("idlehand.radicle.run_sandbox", passed)
    log.write_text("", encoding="utf-8")
    assert main(["--home", str(home), "rad", "patch", "check", RID, PATCH, "--path", str(checkout)]) == 0
    assert f"accepted patch {PATCH}" in capsys.readouterr().out
    recorded = log.read_text(encoding="utf-8")
    assert "--accept" in recorded
    assert "rad-passphrase-sekret" not in recorded
    assert "patch checkout" in recorded


def test_git_push_keeps_the_passphrase_out_of_argv(monkeypatch) -> None:
    from idlehand.radicle import _git_push

    monkeypatch.setenv("RAD_PASSPHRASE", "idlehand-dev")
    seen: dict[str, object] = {}

    def fake_run(command: list[str], **kwargs: object) -> subprocess.CompletedProcess[str]:
        seen["command"] = command
        seen["env"] = kwargs.get("env")
        return subprocess.CompletedProcess(command, 0, "", "")

    monkeypatch.setattr("idlehand.radicle.subprocess.run", fake_run)
    monkeypatch.setattr("idlehand.radicle.resolve_git", lambda: "/usr/bin/git")
    _git_push(Path("/tmp"), "Title", "Body")
    command = seen["command"]
    assert isinstance(command, list)
    assert "HEAD:refs/patches" in command
    assert "idlehand-dev" not in command
    assert "patch.message=Title" in command
    env = seen["env"]
    assert isinstance(env, dict)
    assert env.get("RAD_PASSPHRASE") == "idlehand-dev"


def test_github_and_radicle_rows_share_the_delegation_file(tmp_path: Path) -> None:
    home = tmp_path / "home"
    home.mkdir()
    (home / "delegated.toml").write_text(
        '[[repos]]\nprovider = "github"\nrepo = "octocat/hello"\n\n'
        f'[[repos]]\nprovider = "radicle"\nrepo = "{RID}"\n',
        encoding="utf-8",
    )
    assert load_delegated(home) == [("github", "octocat/hello"), ("radicle", RID)]
    (home / "delegated.toml").write_text(
        '[[repos]]\nprovider = "radicle"\nrepo = "octocat/hello"\n',
        encoding="utf-8",
    )
    assert load_delegated(home) is None
