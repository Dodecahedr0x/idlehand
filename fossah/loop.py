"""One tick of the node: peer fetch, then at most one contribution cycle.

The clone runs outside the config lock, on the trusted side, because it needs
the network. The repository command then runs in the sandbox. A contribution
is recorded only after that command has actually run.
"""

from __future__ import annotations

import hashlib
import os
import time
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

from fossah.actions import action_command
from fossah.config import (
    append_log,
    load_config,
    load_peers,
    load_sources,
    publish_path,
    save_peers,
    state_path,
)
from fossah.fetch import clone_repository, redact_clone_url
from fossah.home import home_lock, read_json, write_json
from fossah.peers import (
    PeerCandidate,
    count_remote_repos,
    load_peer_document,
    normalize_peer_url,
    normalize_safe,
    publish_document,
    review_second_degree,
)
from fossah.sandbox import detect_runtime, run
from fossah.subscriptions import inspect_subscription, subscription_command
from fossah.trust import extend_trust
from fossah.usage import claude_argv, plan_with_claude

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
        metering = ledger.get("metering")
        if metering in {"local-estimate", "reported", "mixed"}:
            state["ledger"]["metering"] = metering
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
    if state["ledger"]["metering"] not in {"local-estimate", "reported", "mixed"}:
        state["ledger"]["metering"] = "local-estimate"
    return state


def _enabled_actions(rules: dict[str, Any]) -> list[str]:
    return [name for name, flag in ACTIONS if rules.get(flag, False)]


def _workspace(home: Path, repo_url: str) -> Path:
    slug = hashlib.sha256(repo_url.encode()).hexdigest()[:16]
    return home / "workspaces" / slug


def _keep_drafts(home: Path, workspace: Path, repo_url: str) -> None:
    """Copy sandbox drafts out of the clone before the next cycle replaces it."""
    produced = workspace / ".fossah"
    if not produced.is_dir() or produced.is_symlink():
        return
    try:
        if not produced.resolve().is_relative_to(workspace.resolve()):
            return
    except OSError:
        return
    destination = home / "drafts" / hashlib.sha256(repo_url.encode()).hexdigest()[:16]
    destination.mkdir(parents=True, exist_ok=True)
    for name in ("audit.txt", "issue-draft.md", "pr-draft.md"):
        source = produced / name
        if not source.is_file() or source.is_symlink():
            continue
        try:
            if not source.resolve().is_relative_to(workspace.resolve()):
                continue
            if source.stat().st_size > 1_000_000:
                continue
            payload = source.read_bytes()
        except OSError:
            continue
        (destination / name).write_bytes(payload)


def _write_publish(home: Path, config: dict[str, Any], peers: list[dict[str, Any]], repos: list[dict[str, str]], listen_url: str) -> None:
    document = publish_document(
        node_id=str(config.get("node_id", "")),
        listen_url=listen_url,
        peers=peers,
        repos=repos,
    )
    write_json(publish_path(home), document)


def _not_run(runtime: str | None, reason: str) -> dict[str, Any]:
    return {
        "runtime": runtime or "none",
        "invoked": False,
        "ok": False,
        "exit_code": None,
        "stdout": "",
        "stderr": "",
        "reason": reason,
        "argv": [],
    }


def _fetch_peers(
    peers: list[dict[str, Any]],
    *,
    config: dict[str, Any],
    listen_url: str,
    home: Path,
) -> tuple[list[PeerCandidate], int, list[str], dict[str, str], list[dict[str, Any]]]:
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
    additions, trust_decisions = review_second_degree(
        self_id=str(config.get("node_id", "")),
        self_urls=self_urls,
        direct_peers=peers,
        documents=documents,
        existing_urls=set(existing),
        heuristic=config["peer_heuristic"],
    )
    return additions, ignored, errors, id_updates, trust_decisions


def _prepare_cycle(
    home: Path,
    config: dict[str, Any],
    sources: list[dict[str, str]],
    state: dict[str, Any],
    *,
    demo: bool,
) -> dict[str, Any] | None:
    rules = config["rules"]
    cycles = int(state["loop"]["cycles"])
    spent = int(state["ledger"]["estimated_tokens"]) + int(state["ledger"]["metered_tokens"])
    limit = int(config["spending_limit_tokens"])
    cost = int(config["estimate_tokens_per_cycle"])
    state["ledger"]["limit_tokens"] = limit
    if spent >= limit or spent + cost > limit:
        state["loop"]["status"] = "stopped"
        state["loop"]["reason"] = "spending limit reached"
        return None
    if not demo and not rules.get("auto_start", True):
        state["loop"]["status"] = "idle"
        state["loop"]["reason"] = "auto start is off"
        return None
    actions = _enabled_actions(rules)
    if not sources:
        state["loop"]["status"] = "idle"
        state["loop"]["reason"] = "the local source list is empty"
        return None
    if not actions:
        state["loop"]["status"] = "idle"
        state["loop"]["reason"] = "every contribution action is turned off"
        return None
    repo_url = sources[cycles % len(sources)]["url"]
    recorded_url = redact_clone_url(repo_url)
    action = actions[cycles % len(actions)]
    status = inspect_subscription(str(config.get("subscription", "")))
    command = None
    if status.connected and status.binary:
        if status.name == "claude":
            command = claude_argv(status.binary, recorded_url, action)
        else:
            command = subscription_command(status.name, status.binary, recorded_url, action)
    configured_runtime = str(config["sandbox"]["runtime"])
    runtime = detect_runtime(configured_runtime)
    refusal = ""
    if not config["sandbox"].get("execute", True):
        refusal = "sandbox execution is off"
    elif runtime is None:
        refusal = "no sandbox runtime is available; refused to run on the host"
    return {
        "repo_url": repo_url,
        "recorded_url": recorded_url,
        "action": action,
        "demo": demo,
        "command": command,
        "runtime": runtime,
        "configured_runtime": configured_runtime,
        "image": config["sandbox"]["image"],
        "memory": config["sandbox"]["memory"],
        "cpus": config["sandbox"]["cpus"],
        "workspace": _workspace(home, repo_url),
        "planner_home": home,
        "plan_cli": status.binary if status.name == "claude" and status.connected and not demo and not refusal else "",
        "refusal": refusal,
    }


def _skipped(runtime: str | None, fetch: dict[str, Any], *, cloned: bool, sandbox: dict[str, Any] | None = None) -> dict[str, Any]:
    return {
        "fetch": fetch,
        "sandbox": sandbox or _not_run(runtime, "not run; repository was not fetched"),
        "cloned": cloned,
        "planner": None,
    }


def _run_job(job: dict[str, Any]) -> dict[str, Any]:
    runtime = job["runtime"] if isinstance(job["runtime"], str) else None
    if job["refusal"]:
        return _skipped(
            runtime,
            {"cloned": False, "reason": "not fetched; sandbox refused"},
            cloned=False,
            sandbox=_not_run(runtime, job["refusal"]),
        )
    try:
        fetch = clone_repository(str(job["repo_url"]), job["workspace"])
    except Exception as exc:  # noqa: BLE001 — a fetch failure is a skipped cycle
        return _skipped(runtime, {"cloned": False, "reason": str(exc)[:300]}, cloned=False)
    if not fetch.cloned:
        return _skipped(runtime, fetch.as_dict(), cloned=False)
    planner = None
    if job.get("plan_cli"):
        planner = plan_with_claude(str(job["plan_cli"]), str(job["recorded_url"]), str(job["action"]), job["planner_home"])
    try:
        result = run(
            job["workspace"],
            action_command(str(job["action"]), runtime or "namespace"),
            runtime=str(job["configured_runtime"]),
            image=str(job["image"]),
            memory=str(job["memory"]),
            cpus=str(job["cpus"]),
        )
    except Exception as exc:  # noqa: BLE001 — the node stays up
        return {
            "fetch": fetch.as_dict(),
            "sandbox": _not_run(runtime, str(exc)[:300]),
            "cloned": True,
            "planner": planner,
        }
    if result.invoked:
        _keep_drafts(job["planner_home"], job["workspace"], str(job["repo_url"]))
    return {"fetch": fetch.as_dict(), "sandbox": result.as_dict(), "cloned": True, "planner": planner}


def _apply_usage(state: dict[str, Any], source: str) -> None:
    estimated = int(state["ledger"]["estimated_tokens"])
    metered = int(state["ledger"]["metered_tokens"])
    current = state["ledger"].get("metering") or "local-estimate"
    if source == "reported":
        state["ledger"]["metering"] = "mixed" if estimated > 0 or current == "mixed" else "reported"
    elif source == "estimate":
        state["ledger"]["metering"] = "mixed" if metered > 0 or current in {"reported", "mixed"} else "local-estimate"


def _commit_cycle(
    home: Path,
    config: dict[str, Any],
    state: dict[str, Any],
    job: dict[str, Any],
    outcome: dict[str, Any],
) -> None:
    cycles = int(state["loop"]["cycles"])
    cost = int(config["estimate_tokens_per_cycle"])
    limit = int(config["spending_limit_tokens"])
    sandbox = outcome["sandbox"]
    planner = outcome.get("planner") if isinstance(outcome.get("planner"), dict) else None
    invoked = bool(sandbox.get("invoked"))
    reported = planner.get("tokens") if planner else None
    if isinstance(reported, bool) or not isinstance(reported, int):
        reported = None
    executed = bool(planner and planner.get("executed"))
    usage = "none"
    charged_estimate = 0
    charged_metered = 0
    if reported is not None:
        usage = "reported"
        charged_metered = reported
    elif invoked:
        usage = "estimate"
        charged_estimate = cost
    if charged_estimate:
        state["ledger"]["estimated_tokens"] = int(state["ledger"]["estimated_tokens"]) + charged_estimate
    if reported is not None:
        state["ledger"]["metered_tokens"] = int(state["ledger"]["metered_tokens"]) + charged_metered
    if usage != "none":
        _apply_usage(state, usage)
    command = planner.get("argv") if planner and planner.get("argv") else job["command"]
    plan = {
        "id": cycles + 1,
        "at": now_iso(),
        "repo": job["recorded_url"],
        "action": job["action"],
        "demo": job["demo"],
        "contributed": bool(invoked and not job["demo"]),
        "pushed": False,
        "upstream_cloned": bool(outcome["cloned"]),
        "estimated_tokens": charged_estimate,
        "metered_tokens": charged_metered,
        "usage": usage,
        "subscription_command": command,
        "subscription_executed": executed,
        "fetch": outcome["fetch"],
        "sandbox": sandbox,
    }
    spent = int(state["ledger"]["estimated_tokens"]) + int(state["ledger"]["metered_tokens"])
    state["plans"] = [*state["plans"], plan][-30:]
    state["loop"]["cycles"] = cycles + 1
    state["ledger"]["limit_tokens"] = limit
    if spent >= limit:
        state["loop"]["status"] = "stopped"
        state["loop"]["reason"] = "spending limit reached"
    else:
        state["loop"]["status"] = "running"
        if invoked and job["demo"]:
            reason = "demo dry loop"
        elif invoked:
            reason = "sandboxed command ran"
        elif job["refusal"]:
            reason = str(job["refusal"])
        else:
            reason = str(outcome["fetch"].get("reason") or sandbox.get("reason") or "cycle skipped")
        state["loop"]["reason"] = reason
    mark = "yes" if plan["contributed"] else "no"
    append_log(
        home,
        f"{plan['at']} {plan['action']} {plan['repo']} "
        f"cloned={str(plan['upstream_cloned']).lower()} contributed={mark} "
        f"usage={usage} {spent}/{limit} {sandbox.get('reason', '')}",
    )


def _stamp_node(state: dict[str, Any], status: Any) -> None:
    state["subscription"] = status.as_dict()
    state["node"]["pid"] = os.getpid()
    state["node"]["status"] = "up"
    state["node"]["heartbeat_at"] = now_iso()


def _persist(home: Path, config: dict[str, Any], peers: list[dict[str, Any]], sources: list[dict[str, str]], state: dict[str, Any]) -> dict[str, Any]:
    state["contributions_pushed"] = sum(1 for plan in state["plans"] if plan.get("pushed"))
    state["ledger"]["limit_tokens"] = int(config["spending_limit_tokens"])
    write_json(state_path(home), state)
    _write_publish(home, config, peers, sources, str(state.get("publish", {}).get("url", "")))
    return state


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
    trust_decisions: list[dict[str, Any]] = []
    fetched = False
    if peers and epoch - last >= interval:
        fetched = True
        additions, ignored, errors, id_updates, trust_decisions = _fetch_peers(
            peers, config=config, listen_url=listen_url, home=home
        )
    job: dict[str, Any] | None = None
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
            extend_trust(home, trust_decisions)
        save_peers(home, peers)
        status = inspect_subscription(str(config.get("subscription", "")))
        _stamp_node(state, status)
        demo = bool(config.get("demo"))
        if demo or status.connected:
            job = _prepare_cycle(home, config, sources, state, demo=demo)
            if job is not None and not job["refusal"]:
                state["loop"]["status"] = "running"
                state["loop"]["reason"] = "fetching repository"
        else:
            state["loop"]["status"] = "idle"
            state["loop"]["reason"] = status.detail
        if job is None or job["refusal"]:
            if job is not None:
                _commit_cycle(home, config, state, job, _run_job(job))
            return _persist(home, config, peers, sources, state)
        _persist(home, config, peers, sources, state)

    outcome = _run_job(job)
    with home_lock(home):
        config = load_config(home)
        sources = load_sources(home)
        peers = load_peers(home)
        state = load_state(home, config)
        status = inspect_subscription(str(config.get("subscription", "")))
        _stamp_node(state, status)
        _commit_cycle(home, config, state, job, outcome)
        return _persist(home, config, peers, sources, state)
