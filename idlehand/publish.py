"""Serve this node's peer list and repo list for peers it already has.

The listener is this node. It is not a directory for the rest of IdleHand.
"""

from __future__ import annotations

from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import urlsplit

from idlehand.config import publish_path


class PublishHandler(BaseHTTPRequestHandler):
    def do_GET(self) -> None:  # noqa: N802
        if urlsplit(self.path).path != "/idlehand/publish":
            self.send_error(404)
            return
        path = Path(self.server.publish_file)  # type: ignore[attr-defined]
        if path.is_symlink() or not path.is_file():
            self.send_error(404)
            return
        body = path.read_bytes()
        self.send_response(200)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def log_message(self, fmt: str, *args: object) -> None:
        return


def start_publish_server(home: Path, host: str, port: int) -> ThreadingHTTPServer | None:
    try:
        server = ThreadingHTTPServer((host, port), PublishHandler)
    except OSError:
        return None
    server.publish_file = str(publish_path(home))  # type: ignore[attr-defined]
    return server
