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


def test_file_list_and_json(tmp_path: Path) -> None:
    listing = tmp_path / "repos.json"
    listing.write_text(json.dumps({"repos": [{"url": "https://github.com/encode/httpx"}]}), encoding="utf-8")
    home = tmp_path / "home"
    ensure_home(home)
    added = apply_link(home, f"fossah://add?list={listing.as_uri()}")
    assert added == ["https://github.com/encode/httpx"]
