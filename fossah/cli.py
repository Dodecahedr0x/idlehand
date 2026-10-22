"""Command line for the Fossah node."""

from __future__ import annotations

import argparse
import sys
from pathlib import Path

from fossah import __version__
from fossah.analytics import render_json, render_text
from fossah.config import (
    DEFAULT_SPENDING_LIMIT_TOKENS,
    ensure_home,
    load_config,
    load_peers,
    load_sources,
    save_config,
    sources_path,
)
from fossah.handler import register_protocol_handler
from fossah.home import resolve_home
from fossah.links import LinkError, apply_link
from fossah.node import serve
from fossah.peers import user_add_peer
from fossah.process import alive_pid, start_node, stop_node
from fossah.sandbox import build_container_argv, detect_runtime, probe_command, run
from fossah.subscriptions import SUBSCRIPTION_NAMES, inspect_subscription

RULE_KEYS = (
    "auto_start",
    "allow_test",
    "allow_audit",
    "allow_issues",
    "allow_pull_requests",
)


def _home(args: argparse.Namespace) -> Path:
    return resolve_home(getattr(args, "home", None))


def _print_connection(home: Path) -> None:
    config = load_config(home)
    status = inspect_subscription(str(config.get("subscription", "")))
    limit = config["spending_limit_tokens"]
    if status.connected:
        print(
            f"Connected {status.name} ({status.binary}). "
            f"The node is up and the contribution loop is running under {limit} tokens."
        )
        return
    print(f"Node is up. {status.detail}. Nothing will be contributed.")
    print(f"Spending limit: {limit} tokens. Run `fossah demo` for a dry loop.")


def cmd_init(args: argparse.Namespace) -> int:
    home = _home(args)
    ensure_home(home)
    handler = register_protocol_handler()
    print(f"Fossah home: {home}")
    print(f"Source list: {sources_path(home)}")
    print(f"Protocol handler: {handler}")
    print(f"Default spending limit: {DEFAULT_SPENDING_LIMIT_TOKENS} tokens")
    return 0


def cmd_connect(args: argparse.Namespace) -> int:
    home = _home(args)
    config = ensure_home(home)
    config["subscription"] = args.subscription
    config["demo"] = False
    save_config(home, config)
    register_protocol_handler()
    try:
        start_node(home)
    except RuntimeError as exc:
        print(str(exc), file=sys.stderr)
        return 1
    _print_connection(home)
    return 0


def cmd_demo(args: argparse.Namespace) -> int:
    home = _home(args)
    config = ensure_home(home)
    config["demo"] = True
    save_config(home, config)
    try:
        start_node(home)
    except RuntimeError as exc:
        print(str(exc), file=sys.stderr)
        return 1
    print(
        "Demo dry loop is running. Plans are local. "
        "Nothing is contributed, and token totals are estimates."
    )
    return 0


def cmd_start(args: argparse.Namespace) -> int:
    home = _home(args)
    ensure_home(home)
    try:
        pid = start_node(home)
    except RuntimeError as exc:
        print(str(exc), file=sys.stderr)
        return 1
    print(f"Fossah node is up (pid {pid})")
    return 0


def cmd_stop(args: argparse.Namespace) -> int:
    home = _home(args)
    if stop_node(home):
        print("Fossah node stopped")
    else:
        print("Fossah node was not running")
    return 0


def cmd_status(args: argparse.Namespace) -> int:
    print(render_text(_home(args)), end="")
    return 0


def cmd_analytics(args: argparse.Namespace) -> int:
    home = _home(args)
    if args.json:
        print(render_json(home), end="")
    else:
        print(render_text(home), end="")
    return 0


def cmd_limit(args: argparse.Namespace) -> int:
    home = _home(args)
    config = ensure_home(home)
    if args.tokens is None:
        print(config["spending_limit_tokens"])
        return 0
    if args.tokens < 0:
        print("the spending limit cannot be negative", file=sys.stderr)
        return 1
    config["spending_limit_tokens"] = args.tokens
    save_config(home, config)
    print(f"Spending limit set to {args.tokens} tokens")
    return 0


def _print_link(added: list[str]) -> None:
    decisions = getattr(added, "decisions", [])
    for item in decisions:
        if not item.get("accepted"):
            print(f"refused {item.get('subject', '')}: {item.get('reason', '')}", file=sys.stderr)
    if added:
        print("Added to the local source list:")
        for url in added:
            print(f"  {url}")
    else:
        print("Those repos were already in the local source list.")


def cmd_link(args: argparse.Namespace) -> int:
    home = _home(args)
    ensure_home(home)
    try:
        added = apply_link(home, args.url)
    except LinkError as exc:
        print(str(exc), file=sys.stderr)
        return 1
    _print_link(added)
    return 0


def cmd_rules(args: argparse.Namespace) -> int:
    home = _home(args)
    config = ensure_home(home)
    if args.action == "set":
        if args.key not in RULE_KEYS:
            print(f"unknown rule {args.key}", file=sys.stderr)
            print("rules: " + ", ".join(RULE_KEYS), file=sys.stderr)
            return 1
        value = _parse_bool(args.value)
        if value is None:
            print("value must be true or false", file=sys.stderr)
            return 1
        config["rules"][args.key] = value
        save_config(home, config)
    for key in RULE_KEYS:
        print(f"{key} = {'true' if config['rules'][key] else 'false'}")
    return 0


def cmd_peer(args: argparse.Namespace) -> int:
    home = _home(args)
    ensure_home(home)
    if args.action == "add":
        try:
            url = user_add_peer(home, args.url)
        except ValueError as exc:
            print(str(exc), file=sys.stderr)
            return 1
        print(f"Added peer {url}")
        print("Fossah will fetch that URL directly. This does not add repositories.")
        return 0
    peers = load_peers(home)
    if not peers:
        print("No peers yet.")
        return 0
    for peer in peers:
        print(f"{peer['url']}  source={peer.get('source', 'user')}  endorsements={peer.get('endorsements', 1)}")
    return 0


def cmd_sources(args: argparse.Namespace) -> int:
    home = _home(args)
    ensure_home(home)
    print(sources_path(home))
    for repo in load_sources(home):
        print(repo["url"])
    return 0


def cmd_sandbox(args: argparse.Namespace) -> int:
    home = _home(args)
    config = ensure_home(home)
    runtime = detect_runtime(config["sandbox"]["runtime"])
    if args.action == "spec":
        shown = runtime or "none"
        print(f"runtime: {shown}")
        if shown in {"docker", "podman"}:
            workspace = home / "workspaces" / "spec"
            argv = build_container_argv(
                shown,
                workspace,
                probe_command(shown),
                image=config["sandbox"]["image"],
                memory=config["sandbox"]["memory"],
                cpus=config["sandbox"]["cpus"],
            )
            print(" ".join(argv))
        elif shown == "namespace":
            print("namespace jail: private copy of the command, workspace mounted at /work, no network, empty environment")
        elif shown == "bwrap":
            print("bubblewrap: read-only /usr, workspace mounted at /work, no home mount")
        else:
            print("no sandbox runtime is available; Fossah will not run repo commands on the host")
        return 0
    workspace = home / "workspaces" / "manual"
    chosen = runtime or "namespace"
    result = run(
        workspace,
        probe_command(chosen),
        runtime=config["sandbox"]["runtime"],
        image=config["sandbox"]["image"],
        memory=config["sandbox"]["memory"],
        cpus=config["sandbox"]["cpus"],
    )
    if result.stdout:
        print(result.stdout, end="" if result.stdout.endswith("\n") else "\n")
    if not result.ok:
        print(result.reason, file=sys.stderr)
        return 1
    print(f"sandbox {result.runtime} finished. This was not a contribution.")
    return 0


def cmd_node(args: argparse.Namespace) -> int:
    home = _home(args)
    if alive_pid(home):
        print("Fossah node is already running", file=sys.stderr)
        return 1
    serve(home)
    return 0


def _parse_bool(value: str) -> bool | None:
    lowered = value.lower()
    if lowered in {"1", "true", "yes", "on"}:
        return True
    if lowered in {"0", "false", "no", "off"}:
        return False
    return None


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        prog="fossah",
        description="Run a local Fossah node that contributes to open source with your subscription CLIs.",
    )
    parser.add_argument("--home", help="Fossah home. Defaults to $FOSSAH_HOME or ~/.fossah")
    parser.add_argument("--version", action="version", version=f"fossah {__version__}")
    sub = parser.add_subparsers(dest="command", required=True)

    init = sub.add_parser("init", help="create the local home, source list, and URL handler")
    init.set_defaults(func=cmd_init)

    connect = sub.add_parser("connect", help="connect a subscription CLI and start the node")
    connect.add_argument("subscription", choices=SUBSCRIPTION_NAMES)
    connect.set_defaults(func=cmd_connect)

    demo = sub.add_parser("demo", help="run a dry contribution loop without claiming work")
    demo.set_defaults(func=cmd_demo)

    start = sub.add_parser("start", help="start the node and leave it running")
    start.set_defaults(func=cmd_start)

    stop = sub.add_parser("stop", help="stop the node")
    stop.set_defaults(func=cmd_stop)

    status = sub.add_parser("status", help="show the node, subscription, and spending")
    status.set_defaults(func=cmd_status)

    analytics = sub.add_parser("analytics", help="show local analytics")
    analytics.add_argument("--json", action="store_true")
    analytics.set_defaults(func=cmd_analytics)

    limit = sub.add_parser("limit", help="show or set the spending limit in tokens")
    limit.add_argument("tokens", nargs="?", type=int)
    limit.set_defaults(func=cmd_limit)

    link = sub.add_parser("link", help="add repos from a fossah: link to the local source list")
    link.add_argument("url")
    link.set_defaults(func=cmd_link)

    rules = sub.add_parser("rules", help="show or change contribution rules")
    rule_sub = rules.add_subparsers(dest="action", required=True)
    show = rule_sub.add_parser("show")
    show.set_defaults(func=cmd_rules, action="show")
    set_rule = rule_sub.add_parser("set")
    set_rule.add_argument("key")
    set_rule.add_argument("value")
    set_rule.set_defaults(func=cmd_rules, action="set")

    peer = sub.add_parser("peer", help="list peers or add one direct peer")
    peer_sub = peer.add_subparsers(dest="action", required=True)
    peer_list = peer_sub.add_parser("list")
    peer_list.set_defaults(func=cmd_peer, action="list")
    peer_add = peer_sub.add_parser("add")
    peer_add.add_argument("url")
    peer_add.set_defaults(func=cmd_peer, action="add")

    sources = sub.add_parser("sources", help="print the local source list")
    sources.set_defaults(func=cmd_sources)

    sandbox = sub.add_parser("sandbox", help="show or run the repo sandbox")
    sand_sub = sandbox.add_subparsers(dest="action", required=True)
    spec = sand_sub.add_parser("spec")
    spec.set_defaults(func=cmd_sandbox, action="spec")
    sand_run = sand_sub.add_parser("run")
    sand_run.set_defaults(func=cmd_sandbox, action="run")

    node = sub.add_parser("node", help="run the node in the foreground")
    node.set_defaults(func=cmd_node)
    return parser


def main(argv: list[str] | None = None) -> int:
    args_list = list(sys.argv[1:] if argv is None else argv)
    if len(args_list) == 1 and args_list[0].startswith("fossah:"):
        home = resolve_home(None)
        ensure_home(home)
        try:
            added = apply_link(home, args_list[0])
        except LinkError as exc:
            print(str(exc), file=sys.stderr)
            return 1
        _print_link(added)
        return 0
    parser = build_parser()
    args = parser.parse_args(args_list)
    return int(args.func(args))
