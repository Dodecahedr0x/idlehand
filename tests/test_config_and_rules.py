from pathlib import Path

from fossah.config import (
    DEFAULT_SPENDING_LIMIT_TOKENS,
    ensure_home,
    load_config,
    load_sources,
    save_config,
)


def test_defaults_are_open_and_small(tmp_path: Path) -> None:
    home = tmp_path / "home"
    config = ensure_home(home)
    assert config["spending_limit_tokens"] == DEFAULT_SPENDING_LIMIT_TOKENS == 10_000
    assert config["estimate_tokens_per_cycle"] == 2_500
    assert config["rules"] == {
        "auto_start": True,
        "allow_test": True,
        "allow_audit": True,
        "allow_issues": True,
        "allow_pull_requests": True,
    }
    assert "owned" not in config["rules"]
    repos = load_sources(home)
    assert len(repos) == 2
    assert all(repo["url"].startswith("https://example.com/fossah/") for repo in repos)


def test_limit_roundtrip(tmp_path: Path) -> None:
    home = tmp_path / "home"
    config = ensure_home(home)
    config["spending_limit_tokens"] = 2500
    config["peer_heuristic"]["allowed_hosts"] = ["peers.example"]
    config["peer_heuristic"]["min_endorsements"] = 2
    save_config(home, config)
    loaded = load_config(home)
    assert loaded["spending_limit_tokens"] == 2500
    assert loaded["peer_heuristic"]["allowed_hosts"] == ["peers.example"]
    assert loaded["peer_heuristic"]["min_endorsements"] == 2
    assert loaded["rules"]["allow_pull_requests"] is True


def test_source_has_no_ownership_gate() -> None:
    root = Path(__file__).resolve().parents[1] / "fossah"
    text = "\n".join(path.read_text(encoding="utf-8") for path in root.rglob("*.py"))
    assert "unowned" not in text
    assert "allow_issues_on_unowned" not in text
    assert "allow_prs_on_unowned" not in text
