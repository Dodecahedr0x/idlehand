"""Visible accept and refuse decisions for links and second-degree peers.

The rules are the ones the node already uses. This file only stores the
decision and the reason so analytics can show it.
"""

from __future__ import annotations

from datetime import datetime, timezone
from pathlib import Path
from typing import Any

from fossah.fetch import scrub_secrets
from fossah.home import home_lock, read_json, write_json

MAX_DECISIONS = 20


def now_iso() -> str:
    return datetime.now(timezone.utc).replace(microsecond=0).isoformat()


def trust_path(home: Path) -> Path:
    return home / "trust.json"


def public_subject(url: str) -> str:
    """A subject safe to store and show. Secrets and huge lines are not kept."""
    if any(character in url for character in "\r\n\x00"):
        return "list entry"
    text = scrub_secrets(url).replace("\n", " ").replace("\r", " ").strip()
    if not text or "PRIVATE KEY" in text or len(text) > 500 or "://" not in text:
        return "list entry"
    return text


def public_reason(reason: str) -> str:
    text = scrub_secrets(reason).replace("\n", " ").replace("\r", " ").strip()
    if not text or "PRIVATE KEY" in text:
        return "refused"
    return text[:500]


def _read_trust(home: Path) -> tuple[list[dict[str, Any]], bool]:
    """Decisions, and whether the file could be read. A symlink is not followed."""
    path = trust_path(home)
    if path.is_symlink():
        return [], False
    if not path.exists():
        return [], True
    try:
        raw = read_json(path)
    except (OSError, UnicodeError, ValueError):
        return [], False
    if not isinstance(raw, list):
        return [], False
    return [item for item in raw if isinstance(item, dict)], True


def load_trust(home: Path) -> list[dict[str, Any]]:
    items, _readable = _read_trust(home)
    return items


def trust_is_readable(home: Path) -> bool:
    _items, readable = _read_trust(home)
    return readable


def decision(kind: str, subject: str, accepted: bool, reason: str) -> dict[str, Any]:
    return {
        "at": now_iso(),
        "kind": kind,
        "subject": public_subject(subject) if subject else "list entry",
        "accepted": accepted,
        "reason": public_reason(reason),
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
