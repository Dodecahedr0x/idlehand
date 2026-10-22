"""One tick of the node: peer fetch, then at most one contribution cycle."""

from __future__ import annotations

import hashlib
import os
import time
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

from fossah.config import (
    append_log,
    load_config,
    load_peers,
    load_sources,
    publish_path,
    save_peers,
    state_path,
)
from fossah.home import home_lock, read_json, write_json
from fossah.peers import (
    PeerCandidate,
    count_remote_repos,
    load_peer_document,
    normalize_peer_url,
    normalize_safe,
    publish_document,
    select_second_degree,
)
from fossah.sandbox import detect_runtime, probe_command, run
from fossah.subscriptions import inspect_subscription, subscription_command

ACTIONS = (
    ("test", "allow_test"),
    ("audit", "allow_audit"),
    ("issue", "allow_issues"),
    ("pull_request", "allow_pull_requests"),
)


def now_iso() -> str:
    return datetime.now(timezone.utc).replace(microsecond=0).isoformat()


def fresh_state(config: dict[str, Any]) -> dict[str, Any]:
    return {
        "node": {
            "status": "up",
            "pid": os.getpid(),
            "started_at": "",
            "heartbeat_at": "",
            "last_error": "",
        },
        "subscription": {"name": "", "connected": False, "binary": "", "detail": ""},
        "loop": {"status": "idle", "reason": "", "cycles": 0},
        "ledger": {
            "estimated_tokens": 0,
            "metered_tokens": 0,
            "limit_tokens": int(config["spending_limit_tokens"]),
            "metering": "local-estimate",
        },
        "plans": [],
        "contributions_pushed": 0,
        "publish": {"url": "", "port": None},
        "peers_runtime": {
            "last_fetch_at": "",
            "last_fetch_epoch": 0,
            "last_error": "",
            "added": 0,
            "ignored_remote_repos": 0,
        },
    }


def load_state(home: Path, config: dict[str, Any]) -> dict[str, Any]:
    raw = read_json(state_path(home))
    state = fresh_state(config)
    if not isinstance(raw, dict):
        return state
    if isinstance(raw.get("plans"), list):
        state["plans"] = raw["plans"]
    ledger = raw.get("ledger")
    if isinstance(ledger, dict):
        state["ledger"]["estimated_tokens"] = int(ledger.get("estimated_tokens", 0) or 0)
        state["ledger"]["metered_tokens"] = int(ledger.get("metered_tokens", 0) or 0)
    loop = raw.get("loop")
    if isinstance(loop, dict):
        state["loop"]["cycles"] = int(loop.get("cycles", 0) or 0)
        state["loop"]["status"] = loop.get("status") or "idle"
        state["loop"]["reason"] = loop.get("reason") or ""
    node = raw.get("node")
    if isinstance(node, dict) and node.get("started_at"):
        state["node"]["started_at"] = node["started_at"]
    publish = raw.get("publish")
    if isinstance(publish, dict):
        if publish.get("url"):
            state["publish"]["url"] = publish["url"]
        if publish.get("port") is not None:
            state["publish"]["port"] = publish["port"]
    peers_runtime = raw.get("peers_runtime")
    if isinstance(peers_runtime, dict):
        state["peers_runtime"].update(peers_runtime)
    state["ledger"]["limit_tokens"] = int(config["spending_limit_tokens"])
    state["ledger"]["metering"] = "local-estimate"
    return state


def _enabled_actions(rules: dict[str, Any]) -> list[str]:
    return [name for name, flag in ACTIONS if rules.get(flag, False)]


def _workspace(home: Path, repo_url: str) -> Path:
    slug = hashlib.sha256(repo_url.encode()).hexdigest()[:16]
    path = home / "workspaces" / slug
    path.mkdir(parents=True, exist_ok=True)
    return path


def _write_publish(home: Path, config: dict[str, Any], peers: list[dict[str, Any]], repos: list[dict[str, str]], listen_url: str) -> None:
    document = publish_document(
        node_id=str(config.get("node_id", "")),
        listen_url=listen_url,
        peers=peers,
        repos=repos,
    )
    write_json(publish_path(home), document)


def _fetch_peers(
    peers: list[dict[str, Any]],
    *,
    config: dict[str, Any],
    listen_url: str,
    home: Path,
) -> tuple[list[PeerCandidate], int, list[str], dict[str, str]]:
    documents: dict[str, dict[str, Any]] = {}
    ignored = 0
    errors: list[str] = []
    id_updates: dict[str, str] = {}
    for peer in peers:
        url = str(peer.get("url", ""))
        try:
            document = load_peer_document(url)
            key = normalize_peer_url(url)
        except ValueError as exc:
            errors.append(f"{url}: {exc}")
            continue
        documents[key] = document
        ignored += count_remote_repos(document)
        node_id = document.get("node_id")
        if isinstance(node_id, str) and node_id:
            id_updates[key] = node_id
    existing = []
    for peer in peers:
        try:
            existing.append(normalize_peer_url(str(peer["url"])))
        except ValueError:
            continue
    self_urls = {normalize_safe(listen_url)} if listen_url else set()
    self_urls.add((home / "publish.json").resolve().as_uri())
    additions = select_second_degree(
        self_id=str(config.get("node_id", "")),
        self_urls=self_urls,
        direct_peers=peers,
        documents=documents,
        existing_urls=set(existing),
        heuristic=config["peer_heuristic"],
    )
    return additions, ignored, errors, id_updates


def _sandbox_for(action: str, home: Path, repo_url: str, config: dict[str, Any]) -> dict[str, Any]:
    if action not in {"test", "audit"}:
        return {
            "runtime": detect_runtime(config["sandbox"]["runtime"]) or "none",
            "invoked": False,
            "ok": False,
            "reason": "issue and pull request commands are recorded and not sent in this slice",
            "argv": [],
        }
    if not config["sandbox"].get("execute", True):
        return {
            "runtime": detect_runtime(config["sandbox"]["runtime"]) or "none",
            "invoked": False,
            "ok": False,
            "reason": "sandbox execution is off",
            "argv": [],
        }
    runtime = detect_runtime(config["sandbox"]["runtime"]) or "namespace"
    workspace = _workspace(home, repo_url)
    result = run(
        workspace,
        probe_command(runtime if runtime != "none" else "namespace"),
        runtime=config["sandbox"]["runtime"],
        image=config["sandbox"]["image"],
        memory=config["sandbox"]["memory"],
        cpus=config["sandbox"]["cpus"],
    )
    payload = result.as_dict()
    payload["upstream_cloned"] = False
    return payload


def _plan_cycle(
    home: Path,
    config: dict[str, Any],
    sources: list[dict[str, str]],
    state: dict[str, Any],
    *,
    demo: bool,
) -> None:
    rules = config["rules"]
    cycles = int(state["loop"]["cycles"])
    spent = int(state["ledger"]["estimated_tokens"]) + int(state["ledger"]["metered_tokens"])
    limit = int(config["spending_limit_tokens"])
    cost = int(config["estimate_tokens_per_cycle"])
    state["ledger"]["limit_tokens"] = limit
    if spent >= limit or spent + cost > limit:
        state["loop"]["status"] = "stopped"
        state["loop"]["reason"] = "spending limit reached"
        return
    if not demo and not rules.get("auto_start", True):
        state["loop"]["status"] = "idle"
        state["loop"]["reason"] = "auto start is off"
        return
    actions = _enabled_actions(rules)
    if not sources:
        state["loop"]["status"] = "idle"
        state["loop"]["reason"] = "the local source list is empty"
        return
    if not actions:
        state["loop"]["status"] = "idle"
        state["loop"]["reason"] = "every contribution action is turned off"
        return
    repo = sources[cycles % len(sources)]
    action = actions[cycles % len(actions)]
    status = inspect_subscription(str(config.get("subscription", "")))
    command = None
    if status.connected and status.binary:
        command = subscription_command(status.name, status.binary, repo["url"], action)
    try:
        sandbox = _sandbox_for(action, home, repo["url"], config)
    except Exception as exc:  # noqa: BLE001 — a sandbox failure must not stop the node
        sandbox = {"runtime": "none", "invoked": False, "ok": False, "reason": str(exc), "argv": []}
    plan = {
        "id": cycles + 1,
        "at": now_iso(),
        "repo": repo["url"],
        "action": action,
        "demo": demo,
        "contributed": False,
        "upstream_cloned": False,
        "estimated_tokens": cost,
        "subscription_command": command,
        "subscription_executed": False,
        "sandbox": sandbox,
    }
    state["plans"] = [*state["plans"], plan][-30:]
    state["ledger"]["estimated_tokens"] = spent + cost
    state["loop"]["cycles"] = cycles + 1
    state["contributions_pushed"] = 0
    if spent + cost >= limit:
        state["loop"]["status"] = "stopped"
        state["loop"]["reason"] = "spending limit reached"
    else:
        state["loop"]["status"] = "running"
        state["loop"]["reason"] = "demo dry loop" if demo else "planning under the spending limit"
    append_log(
        home,
        f"{plan['at']} plan {action} {repo['url']} estimated {spent + cost}/{limit} "
        f"sandbox={sandbox.get('reason', '')} contributed=no",
    )


def tick(home: Path) -> dict[str, Any]:
    epoch = time.time()
    with home_lock(home):
        config = load_config(home)
        peers = load_peers(home)
        state = load_state(home, config)
        listen_url = str(state.get("publish", {}).get("url", ""))
    interval = float(config["publish"]["peer_fetch_interval_seconds"])
    last = float(state["peers_runtime"].get("last_fetch_epoch") or 0)
    additions: list[PeerCandidate] = []
    ignored = 0
    errors: list[str] = []
    id_updates: dict[str, str] = {}
    fetched = False
    if peers and epoch - last >= interval:
        fetched = True
        additions, ignored, errors, id_updates = _fetch_peers(
            peers, config=config, listen_url=listen_url, home=home
        )
    with home_lock(home):
        config = load_config(home)
        sources = load_sources(home)
        peers = load_peers(home)
        state = load_state(home, config)
        if id_updates:
            for peer in peers:
                try:
                    key = normalize_peer_url(str(peer["url"]))
                except ValueError:
                    continue
                if key in id_updates and not peer.get("id"):
                    peer["id"] = id_updates[key]
        added = 0
        if additions:
            known = set()
            for peer in peers:
                try:
                    known.add(normalize_peer_url(str(peer["url"])))
                except ValueError:
                    continue
            for candidate in additions:
                if candidate.url in known:
                    continue
                peers.append(
                    {
                        "url": candidate.url,
                        "id": candidate.peer_id,
                        "source": "peers-of-peers",
                        "endorsements": candidate.endorsements,
                    }
                )
                known.add(candidate.url)
                added += 1
            state["peers_runtime"]["added"] = int(state["peers_runtime"].get("added") or 0) + added
        if fetched:
            state["peers_runtime"]["last_fetch_epoch"] = epoch
            state["peers_runtime"]["last_fetch_at"] = now_iso()
            state["peers_runtime"]["ignored_remote_repos"] = int(
                state["peers_runtime"].get("ignored_remote_repos") or 0
            ) + ignored
            state["peers_runtime"]["last_error"] = "; ".join(errors)[:500]
        save_peers(home, peers)
        status = inspect_subscription(str(config.get("subscription", "")))
        state["subscription"] = status.as_dict()
        state["node"]["pid"] = os.getpid()
        state["node"]["status"] = "up"
        state["node"]["heartbeat_at"] = now_iso()
        demo = bool(config.get("demo"))
        if demo or status.connected:
            _plan_cycle(home, config, sources, state, demo=demo)
        else:
            state["loop"]["status"] = "idle"
            state["loop"]["reason"] = status.detail
        state["contributions_pushed"] = sum(1 for plan in state["plans"] if plan.get("contributed"))
        state["ledger"]["limit_tokens"] = int(config["spending_limit_tokens"])
        write_json(state_path(home), state)
        _write_publish(home, config, peers, sources, str(state.get("publish", {}).get("url", "")))
        return state
