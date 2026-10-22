"""The IdleHand node process. It stays up until it is stopped."""

from __future__ import annotations

import math
import os
import signal
import threading
import time
from pathlib import Path

from idlehand.config import (
    DEFAULT_LISTEN_PORT,
    ensure_home,
    load_config,
    load_peers,
    load_sources,
    pid_path,
    publish_path,
    state_path,
)
from idlehand.home import home_lock, read_json, write_json
from idlehand.loop import load_state, now_iso, tick
from idlehand.peers import publish_document
from idlehand.publish import start_publish_server


def _sleep(seconds: float, stopped: list[bool]) -> None:
    deadline = time.time() + seconds
    while time.time() < deadline:
        if stopped[0]:
            return
        time.sleep(min(0.1, max(0, deadline - time.time())))


def _loop_interval(config: dict) -> float:
    """Seconds to wait between ticks. A bad setting stays at five seconds."""
    value = config.get("loop_interval_seconds", 5)
    if isinstance(value, bool) or not isinstance(value, (int, float)) or not math.isfinite(value) or value <= 0:
        return 5.0
    return float(value)


def _note_tick_error(home: Path, exc: BaseException) -> None:
    """Record a tick failure. An unreadable config must not exit the node."""
    message = str(exc)[:500]
    try:
        with home_lock(home):
            try:
                config = load_config(home)
            except (OSError, UnicodeError, ValueError):
                raw = read_json(state_path(home))
                if not isinstance(raw, dict):
                    return
                node = raw.get("node")
                if not isinstance(node, dict):
                    node = {}
                    raw["node"] = node
                node["last_error"] = message
                node["heartbeat_at"] = now_iso()
                write_json(state_path(home), raw)
                return
            state = load_state(home, config)
            state["node"]["last_error"] = message
            state["node"]["heartbeat_at"] = now_iso()
            write_json(state_path(home), state)
    except (OSError, UnicodeError, ValueError):
        return


def _listen_address(config: dict) -> tuple[str, int, bool]:
    """Host, port, and whether to listen. A bad port does not stop the node."""
    publish = config.get("publish")
    if not isinstance(publish, dict):
        publish = {}
    host = publish.get("host", "127.0.0.1")
    if not isinstance(host, str) or not host.strip():
        host = "127.0.0.1"
    port = publish.get("port", DEFAULT_LISTEN_PORT)
    if isinstance(port, bool) or not isinstance(port, int) or port < 0 or port > 65535:
        port = DEFAULT_LISTEN_PORT
    listen = publish.get("listen", True)
    if not isinstance(listen, bool):
        listen = True
    return host, port, listen


def serve(home: Path) -> None:
    config = ensure_home(home)
    stopped = [False]

    def handle(signum: int, frame: object) -> None:
        stopped[0] = True

    signal.signal(signal.SIGTERM, handle)
    signal.signal(signal.SIGINT, handle)
    server = None
    thread = None
    host, port, listen = _listen_address(config)
    if listen:
        server = start_publish_server(home, host, port)
        if server is not None:
            thread = threading.Thread(target=server.serve_forever, name="idlehand-publish", daemon=True)
            thread.start()
            host, port = server.server_address[0], int(server.server_address[1])
    listen_url = f"http://{host}:{port}/idlehand/publish" if server is not None else ""
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
    pid_file = pid_path(home)
    if pid_file.is_symlink():
        pid_file.unlink()
    pid_file.write_text(str(os.getpid()), encoding="utf-8")
    try:
        while not stopped[0]:
            try:
                tick(home)
            except Exception as exc:  # noqa: BLE001 — the node stays up
                _note_tick_error(home, exc)
            try:
                interval = _loop_interval(load_config(home))
            except (OSError, UnicodeError, ValueError):
                interval = 5.0
            _sleep(interval, stopped)
    finally:
        if server is not None:
            server.shutdown()
            server.server_close()
        if thread is not None:
            thread.join(timeout=2)
        try:
            with home_lock(home):
                try:
                    state = load_state(home, load_config(home))
                except (OSError, UnicodeError, ValueError):
                    raw = read_json(state_path(home))
                    state = raw if isinstance(raw, dict) else {"node": {}}
                    if not isinstance(state.get("node"), dict):
                        state["node"] = {}
                state["node"]["status"] = "stopped"
                state["node"]["heartbeat_at"] = now_iso()
                write_json(state_path(home), state)
        except (OSError, UnicodeError, ValueError):
            pass
        pid_path(home).unlink(missing_ok=True)
