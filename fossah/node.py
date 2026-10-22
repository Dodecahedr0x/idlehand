"""The Fossah node process. It stays up until it is stopped."""

from __future__ import annotations

import os
import signal
import threading
import time
from pathlib import Path

from fossah.config import ensure_home, load_config, load_peers, load_sources, pid_path, publish_path, state_path
from fossah.home import home_lock, write_json
from fossah.loop import load_state, now_iso, tick
from fossah.peers import publish_document
from fossah.publish import start_publish_server


def _sleep(seconds: float, stopped: list[bool]) -> None:
    deadline = time.time() + seconds
    while time.time() < deadline:
        if stopped[0]:
            return
        time.sleep(min(0.1, max(0, deadline - time.time())))


def serve(home: Path) -> None:
    config = ensure_home(home)
    stopped = [False]

    def handle(signum: int, frame: object) -> None:
        stopped[0] = True

    signal.signal(signal.SIGTERM, handle)
    signal.signal(signal.SIGINT, handle)
    server = None
    thread = None
    host = str(config["publish"]["host"])
    port = int(config["publish"]["port"])
    if config["publish"].get("listen", True):
        server = start_publish_server(home, host, port)
        if server is not None:
            thread = threading.Thread(target=server.serve_forever, name="fossah-publish", daemon=True)
            thread.start()
            host, port = server.server_address[0], int(server.server_address[1])
    listen_url = f"http://{host}:{port}/fossah/publish" if server is not None else ""
    with home_lock(home):
        state = load_state(home, load_config(home))
        state["node"]["pid"] = os.getpid()
        state["node"]["status"] = "up"
        state["node"]["started_at"] = state["node"].get("started_at") or now_iso()
        state["publish"]["url"] = listen_url
        state["publish"]["port"] = port if server is not None else None
        write_json(state_path(home), state)
        peers = load_peers(home)
        repos = load_sources(home)
        write_json(
            publish_path(home),
            publish_document(
                node_id=str(load_config(home).get("node_id", "")),
                listen_url=listen_url,
                peers=peers,
                repos=repos,
            ),
        )
    pid_path(home).write_text(str(os.getpid()), encoding="utf-8")
    try:
        while not stopped[0]:
            try:
                tick(home)
            except Exception as exc:  # noqa: BLE001 — the node stays up
                with home_lock(home):
                    state = load_state(home, load_config(home))
                    state["node"]["last_error"] = str(exc)[:500]
                    state["node"]["heartbeat_at"] = now_iso()
                    write_json(state_path(home), state)
            interval = float(load_config(home).get("loop_interval_seconds", 5))
            _sleep(interval, stopped)
    finally:
        if server is not None:
            server.shutdown()
            server.server_close()
        if thread is not None:
            thread.join(timeout=2)
        with home_lock(home):
            state = load_state(home, load_config(home))
            state["node"]["status"] = "stopped"
            state["node"]["heartbeat_at"] = now_iso()
            write_json(state_path(home), state)
        pid_path(home).unlink(missing_ok=True)
