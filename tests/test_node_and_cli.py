import json
import os
import time
from pathlib import Path

from fossah.analytics import render_text
from fossah.config import ensure_home, load_config, save_config, save_sources, state_path
from fossah.handler import register_protocol_handler
from fossah.home import read_json
from fossah.process import alive_pid, start_node, stop_node
from tests.support import SAMPLE_FILES, make_repo


def _configure(home: Path) -> None:
    config = ensure_home(home)
    config["spending_limit_tokens"] = 400
    config["estimate_tokens_per_cycle"] = 100
    config["loop_interval_seconds"] = 0.05
    config["sandbox"]["execute"] = False
    config["publish"]["port"] = 0
    config["publish"]["peer_fetch_interval_seconds"] = 3600
    save_config(home, config)


def _wait_for(home: Path, predicate, timeout: float = 10):
    deadline = time.time() + timeout
    last = {}
    while time.time() < deadline:
        last = read_json(state_path(home)) or {}
        if predicate(last):
            return last
        time.sleep(0.05)
    raise AssertionError(f"timed out; state={last}; log={(home / 'node.log').read_text(encoding='utf-8') if (home / 'node.log').exists() else ''}")


def test_node_stays_up_after_the_limit(tmp_path: Path, monkeypatch) -> None:
    home = tmp_path / "home"
    bin_dir = tmp_path / "bin"
    bin_dir.mkdir()
    invoked = tmp_path / "claude-invoked"
    script = bin_dir / "claude"
    script.write_text(f"#!/bin/sh\necho hit >> '{invoked}'\npwd >> '{invoked}'\n", encoding="utf-8")
    script.chmod(0o755)
    monkeypatch.setenv("PATH", f"{bin_dir}{os.pathsep}/usr/bin:/bin")
    monkeypatch.setenv("FOSSAH_HOME", str(home))
    monkeypatch.setenv("ANTHROPIC_API_KEY", "sk-node-secret")
    _configure(home)
    config = load_config(home)
    config["subscription"] = "claude"
    config["sandbox"]["execute"] = True
    config["sandbox"]["runtime"] = "namespace"
    save_config(home, config)
    save_sources(home, [{"url": make_repo(tmp_path / "sample", SAMPLE_FILES), "note": "local"}])
    pid = start_node(home)
    try:
        state = _wait_for(
            home,
            lambda item: item.get("loop", {}).get("status") == "stopped"
            and item.get("ledger", {}).get("estimated_tokens") == 400,
            timeout=60,
        )
        assert alive_pid(home) == pid
        assert state["contributions_pushed"] == 0
        assert [plan["action"] for plan in state["plans"]] == ["test", "audit", "issue", "pull_request"]
        assert all(plan["contributed"] is True for plan in state["plans"])
        assert all(plan["subscription_executed"] is True for plan in state["plans"])
        assert all(plan["usage"] == "estimate" for plan in state["plans"])
        assert all(plan["upstream_cloned"] is True for plan in state["plans"])
        assert state["plans"][0]["sandbox"]["ok"] is True
        assert "sk-node-secret" not in json.dumps(state)
        recorded = invoked.read_text(encoding="utf-8").splitlines()
        assert "hit" in recorded
        assert {Path(line).resolve() for line in recorded if line != "hit"} == {(home / "planner").resolve()}
        assert str(tmp_path / "sample") not in " ".join(state["plans"][0]["sandbox"]["argv"])
        text = render_text(home)
        assert "contributions recorded: 4" in text
        assert "contributions pushed: 0" in text
        assert "nothing was contributed" not in text
        assert "claude" in text
        assert "local estimate, not billed usage" in text
    finally:
        stop_node(home)
    assert alive_pid(home) is None


def test_node_stays_up_when_the_clone_is_refused(tmp_path: Path, monkeypatch) -> None:
    home = tmp_path / "home"
    bin_dir = tmp_path / "bin"
    bin_dir.mkdir()
    invoked = tmp_path / "claude-invoked"
    script = bin_dir / "claude"
    script.write_text(f"#!/bin/sh\necho hit >> '{invoked}'\n", encoding="utf-8")
    script.chmod(0o755)
    monkeypatch.setenv("PATH", f"{bin_dir}{os.pathsep}/usr/bin:/bin")
    monkeypatch.setenv("FOSSAH_HOME", str(home))
    _configure(home)
    config = load_config(home)
    config["subscription"] = "claude"
    config["sandbox"]["execute"] = True
    config["sandbox"]["runtime"] = "namespace"
    save_config(home, config)
    save_sources(home, [{"url": "https://user:secret@github.com/org/repo.git", "note": "credentials"}])
    start_node(home)
    try:
        state = _wait_for(home, lambda item: int((item.get("loop") or {}).get("cycles") or 0) >= 1)
        assert alive_pid(home) is not None
        assert state["ledger"]["estimated_tokens"] == 0
        assert state["ledger"]["metered_tokens"] == 0
        assert state["plans"][0]["contributed"] is False
        assert state["plans"][0]["upstream_cloned"] is False
        assert "credentials" in state["plans"][0]["fetch"]["reason"]
        assert not invoked.exists()
        blob = json.dumps(state)
        assert "secret" not in blob
        assert "nothing was contributed" in render_text(home)
    finally:
        stop_node(home)


def test_uninstalled_subscription_stays_up(tmp_path: Path, monkeypatch) -> None:
    home = tmp_path / "home"
    monkeypatch.setenv("PATH", "/usr/bin:/bin")
    monkeypatch.setenv("FOSSAH_HOME", str(home))
    _configure(home)
    config = load_config(home)
    config["subscription"] = "cursor"
    save_config(home, config)
    start_node(home)
    try:
        state = _wait_for(home, lambda item: item.get("subscription", {}).get("name") == "cursor")
        assert state["subscription"]["connected"] is False
        assert "not connected" in state["subscription"]["detail"]
        assert state["plans"] == []
        assert alive_pid(home) is not None
        assert "not connected" in render_text(home)
    finally:
        stop_node(home)


def test_cli_link_limit_and_handler(tmp_path: Path, monkeypatch) -> None:
    home = tmp_path / "home"
    data = tmp_path / "share"
    config_dir = tmp_path / "config"
    monkeypatch.setenv("FOSSAH_HOME", str(home))
    monkeypatch.setenv("XDG_DATA_HOME", str(data))
    monkeypatch.setenv("XDG_CONFIG_HOME", str(config_dir))
    monkeypatch.setenv("PATH", "/usr/bin:/bin")
    from fossah.cli import main

    assert main(["--home", str(home), "init"]) == 0
    assert main(["--home", str(home), "limit", "1500"]) == 0
    assert load_config(home)["spending_limit_tokens"] == 1500
    assert main(["--home", str(home), "link", "fossah://add?repo=https://github.com/pallets/click"]) == 0
    assert "https://github.com/pallets/click" in (home / "sources.toml").read_text(encoding="utf-8")
    desktop = (data / "applications" / "fossah.desktop").read_text(encoding="utf-8")
    assert "x-scheme-handler/fossah" in desktop
    assert "%u" in desktop
    mime = (config_dir / "mimeapps.list").read_text(encoding="utf-8")
    assert "x-scheme-handler/fossah=fossah.desktop" in mime
    status = register_protocol_handler()
    assert status == "registered"


def test_cli_link_keeps_good_repos_and_fails_when_all_are_refused(tmp_path: Path, monkeypatch) -> None:
    home = tmp_path / "home"
    monkeypatch.setenv("FOSSAH_HOME", str(home))
    monkeypatch.setenv("XDG_DATA_HOME", str(tmp_path / "share"))
    monkeypatch.setenv("XDG_CONFIG_HOME", str(tmp_path / "config"))
    from fossah.cli import main
    from fossah.trust import load_trust

    mixed = main(
        [
            "--home",
            str(home),
            "link",
            "fossah://add?repo=https://github.com/pallets/click&repo=https://user:secret@github.com/org/hidden",
        ]
    )
    assert mixed == 0
    assert "https://github.com/pallets/click" in (home / "sources.toml").read_text(encoding="utf-8")
    assert "secret" not in (home / "trust.json").read_text(encoding="utf-8")
    assert any(item["accepted"] for item in load_trust(home))
    assert any(not item["accepted"] and "credentials" in item["reason"] for item in load_trust(home))
    refused = main(["--home", str(home), "link", "fossah://add?repo=not-a-repo"])
    assert refused == 1
    bare = main(["fossah://add?repo=git@github.com:org/nope.git"])
    assert bare == 1
    assert "https://github.com/pallets/click" in (home / "sources.toml").read_text(encoding="utf-8")


def test_bare_fossah_url(tmp_path: Path, monkeypatch) -> None:
    home = tmp_path / "home"
    monkeypatch.setenv("FOSSAH_HOME", str(home))
    monkeypatch.setenv("XDG_DATA_HOME", str(tmp_path / "share"))
    monkeypatch.setenv("XDG_CONFIG_HOME", str(tmp_path / "config"))
    from fossah.cli import main

    assert main(["fossah://add?repo=https://github.com/encode/httpx"]) == 0
    assert "https://github.com/encode/httpx" in (home / "sources.toml").read_text(encoding="utf-8")
