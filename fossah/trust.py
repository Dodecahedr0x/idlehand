"""Visible accept and refuse decisions for links and second-degree peers.

The rules are the ones the node already uses. This file only stores the
decision and the reason so analytics can show it.
"""

from __future__ import annotations

import re
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

from fossah.fetch import redact_clone_url
from fossah.home import home_lock, read_json, write_json

MAX_DECISIONS = 20
_USERINFO = re.compile(r"://[^/\s:@]+:[^/\s@]+@")


def now_iso() -> str:
    return datetime.now(timezone.utc).replace(microsecond=0).isoformat()


def trust_path(home: Path) -> Path:
    return home / "trust.json"


def public_subject(url: str) -> str:
    text = _USERINFO.sub("://", redact_clone_url(url))
    return text or "link"


def load_trust(home: Path) -> list[dict[str, Any]]:
    raw = read_json(trust_path(home))
    if not isinstance(raw, list):
        return []
    return [item for item in raw if isinstance(item, dict)]


def decision(kind: str, subject: str, accepted: bool, reason: str) -> dict[str, Any]:
    return {
        "at": now_iso(),
        "kind": kind,
        "subject": public_subject(subject) if subject else "list entry",
        "accepted": accepted,
        "reason": reason,
    }


def _extend(home: Path, items: list[dict[str, Any]]) -> None:
    current = load_trust(home)
    for item in items:
        if any(
            existing.get("subject") == item.get("subject")
            and existing.get("accepted") == item.get("accepted")
            and existing.get("reason") == item.get("reason")
            and existing.get("kind") == item.get("kind")
            for existing in current
        ):
            continue
        current.append(item)
    write_json(trust_path(home), current[-MAX_DECISIONS:])


def extend_trust(home: Path, items: list[dict[str, Any]]) -> None:
    """Append decisions. The caller must already hold the home lock."""
    if items:
        _extend(home, items)


def remember(home: Path, items: list[dict[str, Any]]) -> None:
    if not items:
        return
    with home_lock(home):
        _extend(home, items)
