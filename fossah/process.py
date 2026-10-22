"""Start and stop the long-running node process."""

from __future__ import annotations

import os
import signal
import subprocess
import sys
import time
from pathlib import Path

from fossah.config import ensure_home, log_path, pid_path, state_path
from fossah.home import read_json


def cmdline(pid: int) -> str:
    try:
        raw = Path(f"/proc/{pid}/cmdline").read_bytes()
    except OSError:
        return ""
    return raw.replace(b"\x00", b" ").decode(errors="replace")


def alive_pid(home: Path) -> int | None:
    path = pid_path(home)
    if not path.exists():
        return None
    try:
        pid = int(path.read_text(encoding="utf-8").strip())
    except ValueError:
        return None
    try:
        os.kill(pid, 0)
    except OSError:
        return None
    if "fossah" not in cmdline(pid):
        return None
    return pid


def _node_env(home: Path) -> dict[str, str]:
    env = os.environ.copy()
    env["FOSSAH_HOME"] = str(home)
    root = str(Path(__file__).resolve().parents[1])
    current = env.get("PYTHONPATH", "")
    env["PYTHONPATH"] = root if not current else root + os.pathsep + current
    env["PYTHONNOUSERSITE"] = "1"
    return env


def start_node(home: Path, timeout: float = 20) -> int:
    existing = alive_pid(home)
    if existing:
        return existing
    ensure_home(home)
    log = log_path(home).open("a", encoding="utf-8")
    try:
        subprocess.Popen(
            [sys.executable, "-m", "fossah", "node"],
            env=_node_env(home),
            cwd=str(home),
            stdout=log,
            stderr=subprocess.STDOUT,
            stdin=subprocess.DEVNULL,
            start_new_session=True,
        )
    finally:
        log.close()
    deadline = time.time() + timeout
    while time.time() < deadline:
        pid = alive_pid(home)
        state = read_json(state_path(home))
        heartbeat = isinstance(state, dict) and bool((state.get("node") or {}).get("heartbeat_at"))
        if pid and heartbeat:
            return pid
        time.sleep(0.05)
    pid = alive_pid(home)
    if pid:
        return pid
    raise RuntimeError("the Fossah node did not stay up")


def stop_node(home: Path, timeout: float = 5) -> bool:
    pid = alive_pid(home)
    if pid is None:
        pid_path(home).unlink(missing_ok=True)
        return False
    os.kill(pid, signal.SIGTERM)
    deadline = time.time() + timeout
    while time.time() < deadline:
        if alive_pid(home) is None:
            pid_path(home).unlink(missing_ok=True)
            return True
        time.sleep(0.05)
    if alive_pid(home):
        os.kill(pid, signal.SIGKILL)
    pid_path(home).unlink(missing_ok=True)
    return True
