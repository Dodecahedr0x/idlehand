import json
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import urlparse

import pytest

from fossah.config import ensure_home, load_sources
from fossah.links import LinkError, apply_link, parse_fossah_link


def test_inline_link_adds_repos_locally(tmp_path: Path) -> None:
    home = tmp_path / "home"
    ensure_home(home)
    added = apply_link(
        home,
        "fossah://add?repo=https://github.com/pallets/click&repo=https://github.com/encode/httpx",
    )
    assert added == [
        "https://github.com/pallets/click",
        "https://github.com/encode/httpx",
    ]
    urls = [repo["url"] for repo in load_sources(home)]
    assert "https://github.com/pallets/click" in urls
    again = apply_link(home, "fossah://add?repos=https://github.com/pallets/click")
    assert again == []


@pytest.mark.parametrize(
    ("url", "match"),
    [
        ("fossah://remove?repo=https://github.com/a/b", "unsupported"),
        ("fossah://add?list=https://a.example/one&list=https://a.example/two", "only one list"),
        ("fossah://add?repo=https://example.com", "needs a path"),
        ("https://github.com/a/b", "not a Fossah link"),
    ],
)
def test_structural_link_refusals_are_recorded(tmp_path: Path, url: str, match: str) -> None:
    from fossah.trust import load_trust

    home = tmp_path / "home"
    ensure_home(home)
    before = [repo["url"] for repo in load_sources(home)]
    with pytest.raises(LinkError, match=match):
        apply_link(home, url)
    assert [repo["url"] for repo in load_sources(home)] == before
    assert any(match in item["reason"] and item["accepted"] is False for item in load_trust(home))
    assert "secret" not in (home / "trust.json").read_text(encoding="utf-8")


def test_catalog_parameter_is_rejected() -> None:
    with pytest.raises(LinkError, match="catalog"):
        parse_fossah_link("fossah://add?catalog=https://fossah.example/directory&repo=https://github.com/a/b")


def test_publisher_list_is_fetched_directly(tmp_path: Path) -> None:
    seen: list[str] = []

    class Handler(BaseHTTPRequestHandler):
        def do_GET(self) -> None:  # noqa: N802
            seen.append(self.path)
            body = b"https://github.com/Textualize/rich\n# note\nhttps://github.com/pallets/flask\n"
            self.send_response(200)
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)

        def log_message(self, fmt: str, *args: object) -> None:
            return

    server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    port = server.server_address[1]
    try:
        home = tmp_path / "home"
        ensure_home(home)
        added = apply_link(home, f"fossah://add?list=http://127.0.0.1:{port}/fossah-repos.txt")
    finally:
        server.shutdown()
        server.server_close()
    assert seen == ["/fossah-repos.txt"]
    assert added == [
        "https://github.com/Textualize/rich",
        "https://github.com/pallets/flask",
    ]
    assert urlparse(f"http://127.0.0.1:{port}/fossah-repos.txt").hostname == "127.0.0.1"


def test_one_bad_repo_does_not_drop_the_rest_and_analytics_shows_why(tmp_path: Path) -> None:
    from fossah.analytics import render_text
    from fossah.trust import load_trust

    home = tmp_path / "home"
    ensure_home(home)
    added = apply_link(
        home,
        "fossah://add?repo=https://user:secret@github.com/a/b&repo=https://github.com/pallets/click&repo=not-a-repo",
    )
    assert added == ["https://github.com/pallets/click"]
    stored = (home / "trust.json").read_text(encoding="utf-8")
    assert "secret" not in stored
    decisions = {item["subject"]: item for item in load_trust(home)}
    assert decisions["https://github.com/pallets/click"]["accepted"] is True
    assert "git repository URL" in decisions["https://github.com/pallets/click"]["reason"]
    refused = [item for item in load_trust(home) if not item["accepted"]]
    assert len(refused) == 2
    assert any("credentials" in item["reason"] for item in refused)
    assert any("http or https" in item["reason"] for item in refused)
    text = render_text(home)
    assert "accepted link https://github.com/pallets/click" in text
    assert "refused link" in text
    assert "secret" not in text
    with pytest.raises(LinkError):
        apply_link(home, "fossah://add?repo=not-a-repo")
    assert "https://github.com/pallets/click" in [repo["url"] for repo in load_sources(home)]


def test_list_file_keeps_good_lines_and_catalog_is_recorded(tmp_path: Path) -> None:
    from fossah.trust import MAX_DECISIONS, load_trust, remember, decision

    listing = tmp_path / "repos.txt"
    listing.write_text(
        "https://github.com/pallets/flask\n"
        "https://user:secret@github.com/hidden/repo\n"
        "not-a-repo\n",
        encoding="utf-8",
    )
    home = tmp_path / "home"
    ensure_home(home)
    added = apply_link(home, f"fossah://add?list={listing.as_uri()}")
    assert added == ["https://github.com/pallets/flask"]
    stored = (home / "trust.json").read_text(encoding="utf-8")
    assert "secret" not in stored
    reasons = [item["reason"] for item in load_trust(home)]
    assert any("credentials" in reason for reason in reasons)
    assert any("http or https" in reason for reason in reasons)
    with pytest.raises(LinkError, match="catalog"):
        apply_link(home, "fossah://add?catalog=https://fossah.example/directory&repo=https://github.com/a/b")
    assert any("catalog" in item["reason"] for item in load_trust(home))
    assert "https://github.com/a/b" not in [repo["url"] for repo in load_sources(home)]
    for index in range(MAX_DECISIONS + 5):
        remember(home, [decision("link", f"https://github.com/org/repo-{index}", True, f"note {index}")])
    kept = load_trust(home)
    assert len(kept) == MAX_DECISIONS
    assert kept[-1]["subject"] == f"https://github.com/org/repo-{MAX_DECISIONS + 4}"
    remember(home, [decision("link", kept[-1]["subject"], True, kept[-1]["reason"])])
    assert len(load_trust(home)) == MAX_DECISIONS


def test_empty_list_and_mixed_json_are_visible(tmp_path: Path) -> None:
    from fossah.trust import load_trust

    empty = tmp_path / "empty.txt"
    empty.write_text("# nothing here\n\n", encoding="utf-8")
    home = tmp_path / "home"
    ensure_home(home)
    before = [repo["url"] for repo in load_sources(home)]
    with pytest.raises(LinkError, match="no repositories"):
        apply_link(home, f"fossah://add?list={empty.as_uri()}")
    assert [repo["url"] for repo in load_sources(home)] == before
    assert any(item["reason"] == "the list file has no repositories" for item in load_trust(home))
    mixed = tmp_path / "mixed.json"
    mixed.write_text(
        json.dumps({"repos": [{"url": "https://github.com/encode/httpx"}, {"name": "missing"}, "ftp://example.com/nope"]}),
        encoding="utf-8",
    )
    added = apply_link(home, f"fossah://add?list={mixed.as_uri()}")
    assert added == ["https://github.com/encode/httpx"]
    reasons = [item["reason"] for item in load_trust(home) if not item["accepted"]]
    assert any("needs a URL" in reason for reason in reasons)
    assert any("http or https" in reason for reason in reasons)


def test_credential_list_url_and_oversized_list_are_refused(tmp_path: Path) -> None:
    from fossah.trust import load_trust

    home = tmp_path / "home"
    ensure_home(home)
    before = [repo["url"] for repo in load_sources(home)]
    with pytest.raises(LinkError, match="credentials"):
        apply_link(home, "fossah://add?list=https://user:secret@example.com/repos.txt")
    stored = (home / "trust.json").read_text(encoding="utf-8")
    assert "secret" not in stored
    assert any("credentials" in item["reason"] for item in load_trust(home))
    big = tmp_path / "big.txt"
    big.write_bytes(b"https://github.com/org/name\n" * 80_000)
    with pytest.raises(LinkError, match="1MB"):
        apply_link(home, f"fossah://add?list={big.as_uri()}")
    assert [repo["url"] for repo in load_sources(home)] == before
    array = tmp_path / "array.json"
    array.write_text(json.dumps(["https://github.com/pallets/jinja", {"url": "notaurl"}]), encoding="utf-8")
    added = apply_link(home, f"fossah://add?list={array.as_uri()}")
    assert added == ["https://github.com/pallets/jinja"]


def test_redirected_list_is_refused(tmp_path: Path) -> None:
    from fossah.trust import load_trust

    class Handler(BaseHTTPRequestHandler):
        def do_GET(self) -> None:  # noqa: N802
            self.send_response(302)
            self.send_header("Location", "https://example.com/elsewhere")
            self.end_headers()

        def log_message(self, fmt: str, *args: object) -> None:
            return

    server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    port = server.server_address[1]
    home = tmp_path / "home"
    ensure_home(home)
    before = [repo["url"] for repo in load_sources(home)]
    try:
        with pytest.raises(LinkError, match="redirect"):
            apply_link(home, f"fossah://add?list=http://127.0.0.1:{port}/list.txt")
    finally:
        server.shutdown()
        server.server_close()
    assert [repo["url"] for repo in load_sources(home)] == before
    assert any("redirect" in item["reason"] and item["accepted"] is False for item in load_trust(home))


def test_file_list_and_json(tmp_path: Path) -> None:
    listing = tmp_path / "repos.json"
    listing.write_text(json.dumps({"repos": [{"url": "https://github.com/encode/httpx"}]}), encoding="utf-8")
    home = tmp_path / "home"
    ensure_home(home)
    added = apply_link(home, f"fossah://add?list={listing.as_uri()}")
    assert added == ["https://github.com/encode/httpx"]
