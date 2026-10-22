"""Peer lists and the peers-of-peers heuristic.

A node publishes its own peers and repos. Direct peers are fetched from the
URL the user (or a previous heuristic decision) already stored. Second-degree
peers may be added. Their repo lists are not imported.
"""

from __future__ import annotations

import json
import urllib.parse
from dataclasses import dataclass
from pathlib import Path
from typing import Any

from idlehand.config import load_peers, save_peers
from idlehand.fetch import contains_control_break, embeds_credentials, public_url
from idlehand.home import home_lock
from idlehand.links import LinkError, fetch_text
from idlehand.trust import decision, public_subject

LOOPBACK_HOSTS = {"localhost", "127.0.0.1", "::1"}


def _scheme_label(scheme: str) -> str:
    """A scheme safe to show. Anything else is omitted so the raw URL is not stored."""
    if scheme and scheme[0].isalpha() and all(character.islower() or character.isdigit() or character in "+.-" for character in scheme):
        return f": {scheme}"
    return ""


@dataclass(frozen=True)
class PeerCandidate:
    url: str
    peer_id: str
    endorsements: int


def normalize_peer_url(url: str) -> str:
    raw = url.strip()
    if contains_control_break(raw):
        raise ValueError("peer URLs cannot contain a newline")
    parsed = urllib.parse.urlsplit(raw)
    if embeds_credentials(raw):
        raise ValueError("peer URLs cannot embed credentials")
    scheme = parsed.scheme.lower()
    if scheme not in {"https", "http", "file"}:
        raise ValueError(f"unsupported peer URL scheme{_scheme_label(scheme)}")
    host = (parsed.hostname or "").lower()
    if scheme in {"https", "http"} and not host:
        raise ValueError("peer URL needs a host")
    netloc = f"[{host}]" if ":" in host else host
    if parsed.port:
        netloc = f"{netloc}:{parsed.port}"
    path = parsed.path or ""
    if scheme != "file" and path != "/" and path.endswith("/"):
        path = path[:-1]
    return urllib.parse.urlunsplit((scheme, netloc, path, parsed.query, ""))


def _host_of(url: str) -> str:
    return (urllib.parse.urlsplit(url).hostname or "").lower()


def _scheme_of(url: str) -> str:
    return urllib.parse.urlsplit(url).scheme.lower()


def _heuristic_count(value: object) -> int | None:
    if isinstance(value, bool) or not isinstance(value, int) or value < 0:
        return None
    return value


def explain_peer_url(url: str, heuristic: dict[str, Any]) -> tuple[bool, str]:
    """Whether a second-degree peer URL may be stored, and the reason."""
    try:
        normalized = normalize_peer_url(url)
    except ValueError as exc:
        return False, str(exc)
    scheme = _scheme_of(normalized)
    host = _host_of(normalized)
    allow_loopback = heuristic.get("allow_insecure_loopback", True)
    require_https = heuristic.get("require_https", True)
    blocked_raw = heuristic.get("blocked_hosts", [])
    allowed_raw = heuristic.get("allowed_hosts", [])
    hosts_ok = (
        isinstance(blocked_raw, list)
        and isinstance(allowed_raw, list)
        and all(isinstance(item, str) for item in [*blocked_raw, *allowed_raw])
    )
    if not isinstance(allow_loopback, bool) or not isinstance(require_https, bool) or not hosts_ok:
        return False, "peer heuristic is unreadable"
    if scheme == "file":
        return False, "second-degree file URLs are not added"
    blocked = {item.lower() for item in blocked_raw}
    if host in blocked:
        return False, "host is blocked"
    allowed = {item.lower() for item in allowed_raw}
    if allowed and host not in allowed:
        return False, "host is not in allowed_hosts"
    loopback = host in LOOPBACK_HOSTS
    if scheme == "https":
        return True, "https peer URL"
    if scheme == "http" and loopback and allow_loopback:
        return True, "http is allowed for loopback"
    if scheme == "http" and not require_https:
        return True, "http peer URL"
    if scheme == "http":
        return False, "second-degree peers must use https"
    return False, f"unsupported peer URL scheme{_scheme_label(scheme)}"


def peer_url_allowed(url: str, heuristic: dict[str, Any]) -> bool:
    """Whether a second-degree peer URL may be stored."""
    return explain_peer_url(url, heuristic)[0]


def review_second_degree(
    *,
    self_id: str,
    self_urls: set[str],
    direct_peers: list[dict[str, Any]],
    documents: dict[str, dict[str, Any]],
    existing_urls: set[str],
    heuristic: dict[str, Any],
) -> tuple[list[PeerCandidate], list[dict[str, Any]]]:
    """Choose second-degree peers and record why each candidate was kept or dropped.

    Repository lists on those documents are ignored here.
    """
    min_endorsements = _heuristic_count(heuristic.get("min_endorsements", 1))
    max_new = _heuristic_count(heuristic.get("max_new_peers_per_cycle", 5))
    max_peers = _heuristic_count(heuristic.get("max_peers", 50))
    if min_endorsements is None or max_new is None or max_peers is None:
        return [], [decision("peer", "idlehand://peer-heuristic", False, "peer heuristic is unreadable")]
    room = max(0, max_peers - len(existing_urls))
    limit = min(max_new, room)
    direct_urls: set[str] = set()
    for peer in direct_peers:
        try:
            direct_urls.add(normalize_peer_url(str(peer.get("url", ""))))
        except ValueError:
            continue
    self_norm = {normalize_safe(url) for url in self_urls}
    known = set(existing_urls) | direct_urls
    decisions: list[dict[str, Any]] = []
    seen_decisions: set[tuple[str, bool, str]] = set()

    def add_decision(subject: str, accepted: bool, reason: str) -> None:
        shown = public_subject(subject)
        key = (shown, accepted, reason)
        if key in seen_decisions:
            return
        seen_decisions.add(key)
        decisions.append(decision("peer", shown, accepted, reason))

    endorsements: dict[str, set[str]] = {}
    ids: dict[str, str] = {}
    allow_reason: dict[str, str] = {}
    for direct_url, document in documents.items():
        peers = document.get("peers", [])
        if not isinstance(peers, list):
            continue
        seen_here: set[str] = set()
        for entry in peers:
            if isinstance(entry, str):
                raw = entry
                peer_id = ""
            elif isinstance(entry, dict) and isinstance(entry.get("url"), str):
                raw = entry["url"]
                peer_id = str(entry.get("id", ""))
            else:
                continue
            allowed, reason = explain_peer_url(raw, heuristic)
            if not allowed:
                add_decision(raw, False, reason)
                continue
            try:
                url = normalize_peer_url(raw)
            except ValueError as exc:
                add_decision(raw, False, str(exc))
                continue
            if url in seen_here:
                continue
            seen_here.add(url)
            if url in known:
                add_decision(url, False, "already a peer")
                continue
            if url in self_norm or (peer_id and self_id and peer_id == self_id):
                add_decision(url, False, "this is the local node")
                continue
            endorsements.setdefault(url, set()).add(direct_url)
            allow_reason.setdefault(url, reason)
            if peer_id and url not in ids:
                ids[url] = peer_id
    ranked = [
        PeerCandidate(url=url, peer_id=ids.get(url, ""), endorsements=len(sources))
        for url, sources in endorsements.items()
        if len(sources) >= min_endorsements
    ]
    for url, sources in endorsements.items():
        if len(sources) < min_endorsements:
            add_decision(url, False, f"needs {min_endorsements} endorsements, has {len(sources)}")
    ranked.sort(key=lambda item: (-item.endorsements, item.url))
    chosen = ranked[:limit] if limit > 0 else []
    for candidate in ranked[len(chosen) :]:
        add_decision(candidate.url, False, "the peer cap was reached")
    for candidate in chosen:
        add_decision(candidate.url, True, allow_reason.get(candidate.url, "https peer URL"))
    return chosen, decisions


def select_second_degree(
    *,
    self_id: str,
    self_urls: set[str],
    direct_peers: list[dict[str, Any]],
    documents: dict[str, dict[str, Any]],
    existing_urls: set[str],
    heuristic: dict[str, Any],
) -> list[PeerCandidate]:
    """Choose second-degree peers. Does not look at repositories."""
    chosen, _decisions = review_second_degree(
        self_id=self_id,
        self_urls=self_urls,
        direct_peers=direct_peers,
        documents=documents,
        existing_urls=existing_urls,
        heuristic=heuristic,
    )
    return chosen


def normalize_safe(url: str) -> str:
    try:
        return normalize_peer_url(url)
    except ValueError:
        return url.strip()


def count_remote_repos(document: dict[str, Any]) -> int:
    repos = document.get("repos", [])
    if not isinstance(repos, list):
        return 0
    return len(repos)


def load_peer_document(url: str, timeout: float = 5) -> dict[str, Any]:
    try:
        text = fetch_text(url, timeout=timeout)
    except LinkError as exc:
        raise ValueError(str(exc)) from exc
    try:
        payload = json.loads(text)
    except json.JSONDecodeError as exc:
        raise ValueError(f"peer document is not JSON: {exc}") from exc
    if not isinstance(payload, dict):
        raise ValueError("peer document must be a JSON object")
    return payload


def publish_document(
    *,
    node_id: str,
    listen_url: str,
    peers: list[dict[str, Any]],
    repos: list[dict[str, str]],
) -> dict[str, Any]:
    """Public document. No subscription, spending, or home path."""
    return {
        "idlehand": 1,
        "node_id": node_id,
        "listen_url": listen_url,
        "peers": [
            {"url": shown, "id": peer.get("id", "")}
            for peer in peers
            if (shown := public_url(str(peer["url"])))
        ],
        "repos": [{"url": shown} for repo in repos if (shown := public_url(str(repo["url"])))],
    }


def user_add_peer(home: Path, url: str) -> str:
    normalized = normalize_peer_url(url)
    with home_lock(home):
        peers = load_peers(home)
        known = {normalize_safe(peer["url"]) for peer in peers}
        if normalized in known:
            return normalized
        peers.append({"url": normalized, "id": "", "source": "user", "endorsements": 1})
        save_peers(home, peers)
        return normalized
