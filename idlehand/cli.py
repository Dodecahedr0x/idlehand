"""Command line for the IdleHand node."""

from __future__ import annotations

import argparse
import sys
from pathlib import Path

from idlehand import __version__
from idlehand.analytics import render_json, render_text
from idlehand.config import (
    DEFAULT_SPENDING_LIMIT_TOKENS,
    ensure_home,
    load_config,
    load_peers,
    load_sources,
    save_config,
    sources_path,
)
from idlehand.forge import (
    ForgeResult,
    create_issue,
    create_pull_request,
    delegate_repo,
    delegation_status,
    list_manageable,
    load_delegated,
    parse_number,
    registered_forges,
    revoke_repo,
    send_issue_draft,
    send_pull_request_draft,
    update_issue,
    update_pull_request,
)
from idlehand.handler import register_protocol_handler
from idlehand.radicle import (
    create_issue as create_rad_issue,
    delegate_rid,
    node_running,
    open_patch,
    remember_identity,
    review_patch,
    revoke_rid,
    send_issue_draft as send_rad_issue,
    send_patch_draft,
    update_issue as update_rad_issue,
    update_patch,
)
from idlehand.home import resolve_home
from idlehand.links import LinkError, apply_link
from idlehand.node import serve
from idlehand.peers import user_add_peer
from idlehand.process import alive_pid, start_node, stop_node
from idlehand.sandbox import build_container_argv, detect_runtime, probe_command, run, sandbox_limits
from idlehand.subscriptions import SUBSCRIPTION_NAMES, inspect_subscription

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
    print(f"Spending limit: {limit} tokens. Run `idlehand demo` for a dry loop.")


def cmd_init(args: argparse.Namespace) -> int:
    home = _home(args)
    ensure_home(home)
    handler = register_protocol_handler()
    print(f"IdleHand home: {home}")
    print(f"Source list: {sources_path(home)}")
    print(f"Protocol handler: {handler}")
    print(f"Default spending limit: {DEFAULT_SPENDING_LIMIT_TOKENS} tokens")
    nid, detail = remember_identity(home)
    if nid:
        print(f"Radicle node id: {nid}")
    else:
        print(f"{detail}. This node id stays local.")
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
    print(f"IdleHand node is up (pid {pid})")
    return 0


def cmd_stop(args: argparse.Namespace) -> int:
    home = _home(args)
    if stop_node(home):
        print("IdleHand node stopped")
    else:
        print("IdleHand node was not running")
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
        print("IdleHand will fetch that URL directly. This does not add repositories.")
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
            limits = sandbox_limits(
                config["sandbox"].get("image", "python:3.12-slim"),
                config["sandbox"].get("memory", "512m"),
                config["sandbox"].get("cpus", "1"),
            )
            if limits is None:
                print("sandbox limit is unreadable")
            else:
                image, memory, cpus = limits
                workspace = home / "workspaces" / "spec"
                argv = build_container_argv(
                    shown,
                    workspace,
                    probe_command(shown),
                    image=image,
                    memory=memory,
                    cpus=cpus,
                )
                print(" ".join(argv))
        elif shown == "namespace":
            print("namespace jail: private copy of the command, workspace mounted at /work, no network, empty environment")
        elif shown == "bwrap":
            print("bubblewrap: read-only /usr, workspace mounted at /work, no home mount")
        else:
            print("no sandbox runtime is available; IdleHand will not run repo commands on the host")
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


def _finish(result: ForgeResult) -> int:
    print(result.detail, file=sys.stdout if result.ok else sys.stderr)
    return 0 if result.ok else 1


def _body_text(args: argparse.Namespace) -> tuple[bool, str]:
    path_text = getattr(args, "body_file", "") or ""
    inline = getattr(args, "body", None)
    if path_text and inline is not None:
        print("pass either --body or --body-file", file=sys.stderr)
        return False, ""
    if not path_text:
        return True, inline or ""
    path = Path(path_text)
    if path.is_symlink() or not path.is_file():
        print("the body file is unreadable", file=sys.stderr)
        return False, ""
    try:
        if path.stat().st_size > 65_000:
            print("the body is too long", file=sys.stderr)
            return False, ""
        return True, path.read_text(encoding="utf-8")
    except (OSError, UnicodeError):
        print("the body file is unreadable", file=sys.stderr)
        return False, ""


def cmd_rad(args: argparse.Namespace) -> int:
    home = _home(args)
    ensure_home(home)
    action = args.rad_action
    if action == "status":
        nid, identity_detail = remember_identity(home)
        if identity_detail == "rad is not installed":
            print("rad is not installed", file=sys.stderr)
            return 1
        running = node_running()
        if nid:
            print(f"Radicle node id: {nid}")
        else:
            print(identity_detail, file=sys.stderr)
        print(running.detail, file=sys.stdout if running.ok else sys.stderr)
        return 0 if nid and running.ok else 1
    if action == "delegated":
        rows = load_delegated(home)
        if rows is None:
            print("the delegation list is unreadable", file=sys.stderr)
            return 1
        mine = [name for provider, name in rows if provider == "radicle"]
        if not mine:
            print("No repositories are delegated.")
            return 0
        for name in mine:
            print(f"radicle {name}")
        return 0
    if action == "delegate":
        return _finish(delegate_rid(home, args.repo))
    if action == "revoke":
        return _finish(revoke_rid(home, args.repo))
    if action in {"issue-create", "issue-update", "patch-update", "patch-open"}:
        ok, body = _body_text(args)
        if not ok:
            return 1
        title = getattr(args, "title", "") or ""
        if action == "issue-create":
            return _finish(create_rad_issue(home, args.repo, title, body))
        if action == "issue-update":
            return _finish(update_rad_issue(home, args.repo, args.cob_id, title, body))
        if action == "patch-open":
            return _finish(open_patch(home, args.repo, title, body, args.checkout))
        return _finish(update_patch(home, args.repo, args.cob_id, title, body))
    if action == "patch-check":
        return _finish(review_patch(home, args.repo, args.cob_id, args.checkout))
    if action == "issue-send":
        return _finish(send_rad_issue(home, args.repo))
    if action == "patch-send":
        return _finish(send_patch_draft(home, args.repo, args.cob_id))
    print("IdleHand has no Radicle command for that", file=sys.stderr)
    return 1


def cmd_github(args: argparse.Namespace) -> int:
    home = _home(args)
    ensure_home(home)
    provider = args.provider
    action = args.forge_action
    if action == "status":
        account = delegation_status(provider)
        print(account.detail, file=sys.stdout if account.connected else sys.stderr)
        return 0 if account.connected else 1
    if action == "repos":
        repos, detail = list_manageable(provider)
        if repos is None:
            print(detail, file=sys.stderr)
            return 1
        if not repos:
            print("No owned or administered repositories.")
        for repo in repos:
            print(f"{repo.name}  {repo.role}")
        if detail:
            print(detail)
        return 0
    if action == "delegated":
        rows = load_delegated(home)
        if rows is None:
            print("the delegation list is unreadable", file=sys.stderr)
            return 1
        mine = [row for row in rows if row[0] == provider]
        if not mine:
            print("No repositories are delegated.")
            return 0
        for item_provider, name in mine:
            print(f"{item_provider} {name}")
        return 0
    if action == "delegate":
        return _finish(delegate_repo(home, provider, args.repo))
    if action == "revoke":
        return _finish(revoke_repo(home, provider, args.repo))
    if action in {"issue-create", "issue-update", "pr-create", "pr-update"}:
        ok, body = _body_text(args)
        if not ok:
            return 1
        title = getattr(args, "title", "") or ""
        if action == "issue-create":
            return _finish(create_issue(home, provider, args.repo, title, body))
        if action == "pr-create":
            return _finish(
                create_pull_request(home, provider, args.repo, title, body, args.head, args.base or "")
            )
        number = parse_number(args.number)
        if number is None:
            label = "issue" if action == "issue-update" else "pull request"
            print(f"the {label} number is unreadable", file=sys.stderr)
            return 1
        if action == "issue-update":
            return _finish(update_issue(home, provider, args.repo, number, title, body))
        return _finish(update_pull_request(home, provider, args.repo, number, title, body))
    if action == "issue-send":
        return _finish(send_issue_draft(home, provider, args.repo))
    if action == "pr-send":
        return _finish(send_pull_request_draft(home, provider, args.repo, args.head, args.base or ""))
    print("IdleHand has no forge provider for that name", file=sys.stderr)
    return 1


def _add_text_flags(parser: argparse.ArgumentParser, *, title_required: bool) -> None:
    if title_required:
        parser.add_argument("--title", required=True)
    else:
        parser.add_argument("--title", default="")
    parser.add_argument("--body", default=None)
    parser.add_argument("--body-file", default="")


def _add_rad_parser(sub: argparse._SubParsersAction[argparse.ArgumentParser]) -> None:
    rad = sub.add_parser("rad", help="delegate Radicle repositories this identity controls")
    commands = rad.add_subparsers(dest="rad_group", required=True)

    status = commands.add_parser("status", help="show the Radicle node id and whether the node is running")
    status.set_defaults(func=cmd_rad, rad_action="status")

    delegated = commands.add_parser("delegated", help="list Radicle repositories explicitly delegated to this node")
    delegated.set_defaults(func=cmd_rad, rad_action="delegated")

    delegate = commands.add_parser("delegate", help="delegate management of one repository by RID")
    delegate.add_argument("repo")
    delegate.set_defaults(func=cmd_rad, rad_action="delegate")

    revoke = commands.add_parser("revoke", help="revoke management of one repository by RID")
    revoke.add_argument("repo")
    revoke.set_defaults(func=cmd_rad, rad_action="revoke")

    issue = commands.add_parser("issue", help="open, edit, or send an issue on a delegated repository")
    issue_commands = issue.add_subparsers(dest="issue_action", required=True)
    issue_create = issue_commands.add_parser("create")
    issue_create.add_argument("repo")
    _add_text_flags(issue_create, title_required=True)
    issue_create.set_defaults(func=cmd_rad, rad_action="issue-create")
    issue_update = issue_commands.add_parser("update")
    issue_update.add_argument("repo")
    issue_update.add_argument("cob_id")
    _add_text_flags(issue_update, title_required=False)
    issue_update.set_defaults(func=cmd_rad, rad_action="issue-update")
    issue_send = issue_commands.add_parser("send", help="send the local issue draft")
    issue_send.add_argument("repo")
    issue_send.set_defaults(func=cmd_rad, rad_action="issue-send")

    patch = commands.add_parser("patch", help="open, review, or edit a patch")
    patch_commands = patch.add_subparsers(dest="patch_action", required=True)
    patch_open = patch_commands.add_parser("open", help="open a patch with git push rad on the trusted side")
    patch_open.add_argument("repo")
    patch_open.add_argument("--path", dest="checkout", required=True)
    _add_text_flags(patch_open, title_required=True)
    patch_open.set_defaults(func=cmd_rad, rad_action="patch-open")
    patch_check = patch_commands.add_parser("check", help="sandbox a contributor patch, then accept or refuse it")
    patch_check.add_argument("repo")
    patch_check.add_argument("cob_id")
    patch_check.add_argument("--path", dest="checkout", required=True)
    patch_check.set_defaults(func=cmd_rad, rad_action="patch-check")
    patch_update = patch_commands.add_parser("update", help="edit the title and description of an existing patch")
    patch_update.add_argument("repo")
    patch_update.add_argument("cob_id")
    _add_text_flags(patch_update, title_required=True)
    patch_update.set_defaults(func=cmd_rad, rad_action="patch-update")
    patch_send = patch_commands.add_parser("send", help="edit an existing patch from the local draft")
    patch_send.add_argument("repo")
    patch_send.add_argument("cob_id")
    patch_send.set_defaults(func=cmd_rad, rad_action="patch-send")


def _add_forge_parser(sub: argparse._SubParsersAction[argparse.ArgumentParser], name: str) -> None:
    forge = sub.add_parser(name, help=f"delegate and manage {name} repositories you own or administer")
    commands = forge.add_subparsers(dest="forge_group", required=True)

    status = commands.add_parser("status", help="show whether the forge CLI is logged in")
    status.set_defaults(func=cmd_github, provider=name, forge_action="status")

    repos = commands.add_parser("repos", help="list repositories this login owns or administers")
    repos.set_defaults(func=cmd_github, provider=name, forge_action="repos")

    delegated = commands.add_parser("delegated", help="list repositories explicitly delegated to this node")
    delegated.set_defaults(func=cmd_github, provider=name, forge_action="delegated")

    delegate = commands.add_parser("delegate", help="delegate management of one repository")
    delegate.add_argument("repo")
    delegate.set_defaults(func=cmd_github, provider=name, forge_action="delegate")

    revoke = commands.add_parser("revoke", help="revoke management of one repository")
    revoke.add_argument("repo")
    revoke.set_defaults(func=cmd_github, provider=name, forge_action="revoke")

    issue = commands.add_parser("issue", help="create, update, or send an issue on a delegated repository")
    issue_commands = issue.add_subparsers(dest="issue_action", required=True)
    issue_create = issue_commands.add_parser("create")
    issue_create.add_argument("repo")
    _add_text_flags(issue_create, title_required=True)
    issue_create.set_defaults(func=cmd_github, provider=name, forge_action="issue-create")
    issue_update = issue_commands.add_parser("update")
    issue_update.add_argument("repo")
    issue_update.add_argument("number")
    _add_text_flags(issue_update, title_required=False)
    issue_update.set_defaults(func=cmd_github, provider=name, forge_action="issue-update")
    issue_send = issue_commands.add_parser("send", help="send the local issue draft")
    issue_send.add_argument("repo")
    issue_send.set_defaults(func=cmd_github, provider=name, forge_action="issue-send")

    pull = commands.add_parser("pr", help="create, update, or send a pull request on a delegated repository")
    pull_commands = pull.add_subparsers(dest="pull_action", required=True)
    pull_create = pull_commands.add_parser("create")
    pull_create.add_argument("repo")
    pull_create.add_argument("--head", required=True)
    pull_create.add_argument("--base", default="")
    _add_text_flags(pull_create, title_required=True)
    pull_create.set_defaults(func=cmd_github, provider=name, forge_action="pr-create")
    pull_update = pull_commands.add_parser("update")
    pull_update.add_argument("repo")
    pull_update.add_argument("number")
    _add_text_flags(pull_update, title_required=False)
    pull_update.set_defaults(func=cmd_github, provider=name, forge_action="pr-update")
    pull_send = pull_commands.add_parser("send", help="send the local pull request draft")
    pull_send.add_argument("repo")
    pull_send.add_argument("--head", required=True)
    pull_send.add_argument("--base", default="")
    pull_send.set_defaults(func=cmd_github, provider=name, forge_action="pr-send")


def cmd_node(args: argparse.Namespace) -> int:
    home = _home(args)
    if alive_pid(home):
        print("IdleHand node is already running", file=sys.stderr)
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
        prog="idlehand",
        description="Run a local IdleHand node that contributes to open source with your subscription CLIs.",
    )
    parser.add_argument("--home", help="IdleHand home. Defaults to $IDLEHAND_HOME or ~/.idlehand")
    parser.add_argument("--version", action="version", version=f"idlehand {__version__}")
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

    link = sub.add_parser("link", help="add repos from an idlehand: link to the local source list")
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

    _add_rad_parser(sub)
    for forge_name in registered_forges():
        _add_forge_parser(sub, forge_name)

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
    if len(args_list) == 1 and args_list[0].startswith("idlehand:"):
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
