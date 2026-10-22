"""Text and JSON views of the local node."""

from __future__ import annotations

import json
import shlex
from pathlib import Path
from typing import Any

from fossah.config import load_config, load_peers, load_sources, state_path
from fossah.home import read_json
from fossah.process import alive_pid
from fossah.trust import load_trust


def _whole(value: object) -> tuple[int, bool]:
    if value is None or value == "":
        return 0, True
    if isinstance(value, bool) or not isinstance(value, int) or value < 0:
        return 0, False
    return value, True


def snapshot(home: Path) -> dict[str, Any]:
    config = load_config(home) if (home / "config.toml").exists() else {}
    try:
        state = read_json(state_path(home))
    except (OSError, UnicodeError, ValueError):
        state = {}
    if not isinstance(state, dict):
        state = {}
    pid = alive_pid(home)
    return {
        "home": str(home),
        "pid": pid,
        "node_running": pid is not None,
        "config_present": bool(config),
        "spending_limit_tokens": config.get("spending_limit_tokens"),
        "rules": config.get("rules", {}),
        "sources": load_sources(home) if (home / "sources.toml").exists() else [],
        "peers": load_peers(home) if (home / "peers.toml").exists() else [],
        "trust": load_trust(home),
        "state": state,
    }


def _command(command: list[str] | None) -> str:
    if not command:
        return ""
    return " ".join(shlex.quote(part) for part in command)


def render_text(home: Path) -> str:
    snap = snapshot(home)
    state = snap["state"]
    node = state.get("node", {}) if isinstance(state, dict) else {}
    subscription = state.get("subscription", {}) if isinstance(state, dict) else {}
    loop = state.get("loop", {}) if isinstance(state, dict) else {}
    ledger = state.get("ledger", {}) if isinstance(state, dict) else {}
    peers_runtime = state.get("peers_runtime", {}) if isinstance(state, dict) else {}
    plans = state.get("plans", []) if isinstance(state, dict) else []
    if not isinstance(plans, list):
        plans = []
    if snap["node_running"]:
        node_line = f"up (pid {snap['pid']})"
    elif node.get("status") == "stopped":
        node_line = "stopped"
    elif not snap["config_present"]:
        node_line = "not initialized"
    else:
        node_line = "not running"
    if not subscription:
        sub_line = "not configured"
    elif subscription.get("connected"):
        sub_line = f"{subscription.get('name')} connected ({subscription.get('binary')})"
    else:
        sub_line = subscription.get("detail") or "subscription is not connected"
    estimated, estimated_ok = _whole(ledger.get("estimated_tokens", 0))
    metered, metered_ok = _whole(ledger.get("metered_tokens", 0))
    spent = estimated + metered
    limit = ledger.get("limit_tokens", snap["spending_limit_tokens"])
    metering = ledger.get("metering") or "local-estimate"
    if not estimated_ok or not metered_ok:
        spending_detail = "spending ledger is unreadable"
    elif metering == "reported":
        spending_detail = "reported by the subscription"
    elif metering == "mixed":
        spending_detail = f"{estimated} estimated, {metered} reported"
    else:
        spending_detail = "local estimate, not billed usage"
    pushed, _pushed_ok = _whole(state.get("contributions_pushed", 0) if isinstance(state, dict) else 0)
    recorded = sum(1 for plan in plans if isinstance(plan, dict) and plan.get("contributed"))
    direct = snap["peers"]
    learned = [peer for peer in direct if peer.get("source") == "peers-of-peers"]
    lines = [
        "Fossah",
        f"  node: {node_line}",
        f"  subscription: {sub_line}",
        f"  loop: {loop.get('status', 'idle')} — {loop.get('reason', '')}".rstrip(" —"),
        f"  spending: {spent} / {limit} tokens ({spending_detail})",
        f"  contributions recorded: {recorded}",
        f"  contributions pushed: {pushed}",
        f"  repos: {len(snap['sources'])} in the local source list",
        f"  peers: {len(direct)} direct, {len(learned)} added from peers of peers",
        f"  remote repo lists ignored: {peers_runtime.get('ignored_remote_repos', 0)}",
    ]
    if recorded == 0:
        lines.append("  nothing was contributed")
    trust = snap.get("trust") or []
    if isinstance(trust, list) and trust:
        lines.append("  trust:")
        for item in trust[-8:]:
            if not isinstance(item, dict):
                continue
            mark = "accepted" if item.get("accepted") else "refused"
            lines.append(f"    {mark} {item.get('kind', '')} {item.get('subject', '')} — {item.get('reason', '')}")
    if peers_runtime.get("last_error"):
        lines.append(f"  peer fetch: {peers_runtime['last_error']}")
    if not plans:
        lines.append("  plans: 0")
    else:
        lines.append(f"  plans: {len(plans)} (latest)")
        for plan in plans[-5:]:
            if not isinstance(plan, dict):
                continue
            demo = " demo" if plan.get("demo") else ""
            sandbox = plan.get("sandbox") or {}
            fetch = plan.get("fetch") or {}
            contributed = "yes" if plan.get("contributed") else "no"
            if not plan.get("upstream_cloned") and fetch.get("reason"):
                detail = fetch.get("reason")
            else:
                detail = sandbox.get("reason") or fetch.get("reason") or ""
            cloned = "yes" if plan.get("upstream_cloned") else "no"
            lines.append(
                f"    {plan.get('action')}{demo} {plan.get('repo')} "
                f"contributed={contributed} cloned={cloned} {detail}".rstrip()
            )
            command = _command(plan.get("subscription_command"))
            if command:
                ran = "ran on the trusted side" if plan.get("subscription_executed") else "not run"
                lines.append(f"      command ({ran}): {command}")
    return "\n".join(lines) + "\n"


def render_json(home: Path) -> str:
    return json.dumps(snapshot(home), indent=2, sort_keys=True) + "\n"
