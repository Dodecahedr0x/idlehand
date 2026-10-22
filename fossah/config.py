"""Node configuration, the local repo list, and the peer list."""

from __future__ import annotations

import uuid
from copy import deepcopy
from pathlib import Path
from typing import Any

from fossah.home import atomic_write, dump_toml, home_lock, read_toml

DEFAULT_SPENDING_LIMIT_TOKENS = 10_000
ESTIMATE_TOKENS_PER_CYCLE = 2_500
DEFAULT_LISTEN_PORT = 47321

DEFAULT_REPOS = [
    {
        "url": "https://example.com/fossah/sample-alpha",
        "note": "Example. Replace this with a repository you want Fossah to work on.",
    },
    {
        "url": "https://example.com/fossah/sample-beta",
        "note": "Example. Replace this with a repository you want Fossah to work on.",
    },
]

CONFIG_HEADER = """# Fossah node configuration. This file is yours.
# The spending limit counts usage the Claude CLI reports. Otherwise it is a local estimate, not a bill from a provider.
"""

SOURCES_HEADER = """# Local discovery list. This file is yours.
# Fossah reads it from disk. It is not fetched from a catalog.
# Add repos by editing this file or by opening a fossah: link.
"""

PEERS_HEADER = """# Peers this node already has. Fossah fetches each URL directly.
# Peers of these peers can be added by the heuristic in config.toml.
# This list is not a catalog, and it does not add repositories.
"""

DEFAULT_CONFIG: dict[str, Any] = {
    "node_id": "",
    "subscription": "",
    "demo": False,
    "spending_limit_tokens": DEFAULT_SPENDING_LIMIT_TOKENS,
    "estimate_tokens_per_cycle": ESTIMATE_TOKENS_PER_CYCLE,
    "loop_interval_seconds": 5,
    "rules": {
        "auto_start": True,
        "allow_test": True,
        "allow_audit": True,
        "allow_issues": True,
        "allow_pull_requests": True,
    },
    "sandbox": {
        "runtime": "auto",
        "execute": True,
        "image": "python:3.12-slim",
        "memory": "512m",
        "cpus": "1",
    },
    "publish": {
        "listen": True,
        "host": "127.0.0.1",
        "port": DEFAULT_LISTEN_PORT,
        "peer_fetch_interval_seconds": 60,
    },
    "peer_heuristic": {
        "min_endorsements": 1,
        "max_new_peers_per_cycle": 5,
        "max_peers": 50,
        "require_https": True,
        "allow_insecure_loopback": True,
        "allowed_hosts": [],
        "blocked_hosts": [],
    },
}


def config_path(home: Path) -> Path:
    return home / "config.toml"


def sources_path(home: Path) -> Path:
    return home / "sources.toml"


def peers_path(home: Path) -> Path:
    return home / "peers.toml"


def state_path(home: Path) -> Path:
    return home / "state.json"


def publish_path(home: Path) -> Path:
    return home / "publish.json"


def pid_path(home: Path) -> Path:
    return home / "node.pid"


def log_path(home: Path) -> Path:
    return home / "node.log"


def merge_defaults(defaults: Any, loaded: Any) -> Any:
    if isinstance(defaults, dict):
        loaded_dict = loaded if isinstance(loaded, dict) else {}
        merged: dict[str, Any] = {}
        for key, value in defaults.items():
            if key in loaded_dict:
                merged[key] = merge_defaults(value, loaded_dict[key])
            else:
                merged[key] = deepcopy(value)
        for key, value in loaded_dict.items():
            if key not in merged:
                merged[key] = value
        return merged
    return loaded


def load_config(home: Path) -> dict[str, Any]:
    return merge_defaults(DEFAULT_CONFIG, read_toml(config_path(home)))


def save_config(home: Path, config: dict[str, Any]) -> None:
    atomic_write(config_path(home), dump_toml(config, CONFIG_HEADER))


def load_sources(home: Path) -> list[dict[str, str]]:
    data = read_toml(sources_path(home))
    repos = data.get("repos", [])
    if not isinstance(repos, list):
        return []
    cleaned: list[dict[str, str]] = []
    for repo in repos:
        if isinstance(repo, dict) and isinstance(repo.get("url"), str):
            cleaned.append({"url": repo["url"], "note": str(repo.get("note", ""))})
    return cleaned


def save_sources(home: Path, repos: list[dict[str, str]]) -> None:
    atomic_write(sources_path(home), dump_toml({"repos": repos}, SOURCES_HEADER))


def load_peers(home: Path) -> list[dict[str, Any]]:
    data = read_toml(peers_path(home))
    peers = data.get("peers", [])
    if not isinstance(peers, list):
        return []
    cleaned: list[dict[str, Any]] = []
    for peer in peers:
        if isinstance(peer, dict) and isinstance(peer.get("url"), str):
            cleaned.append(
                {
                    "url": peer["url"],
                    "id": str(peer.get("id", "")),
                    "source": str(peer.get("source", "user")),
                    "endorsements": int(peer.get("endorsements", 1) or 1),
                }
            )
    return cleaned


def save_peers(home: Path, peers: list[dict[str, Any]]) -> None:
    atomic_write(peers_path(home), dump_toml({"peers": peers}, PEERS_HEADER))


def ensure_home(home: Path) -> dict[str, Any]:
    """Create the home directory and default files without overwriting them."""
    with home_lock(home):
        home.mkdir(parents=True, exist_ok=True)
        (home / "workspaces").mkdir(exist_ok=True)
        if not config_path(home).exists():
            config = deepcopy(DEFAULT_CONFIG)
            config["node_id"] = uuid.uuid4().hex
            save_config(home, config)
        else:
            config = load_config(home)
            if not config.get("node_id"):
                config["node_id"] = uuid.uuid4().hex
                save_config(home, config)
        if not sources_path(home).exists():
            save_sources(home, deepcopy(DEFAULT_REPOS))
        if not peers_path(home).exists():
            save_peers(home, [])
        return load_config(home)


def append_log(home: Path, line: str) -> None:
    path = log_path(home)
    path.parent.mkdir(parents=True, exist_ok=True)
    with path.open("a", encoding="utf-8") as handle:
        handle.write(line.rstrip() + "\n")
