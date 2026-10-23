# IdleHand

IdleHand is a local node. It keeps your config, a spending limit, and a contribution loop, and it can call the Claude, Codex, or Cursor CLI already on the machine. It does not bill a separate API. Discovery stays on this machine. There is no IdleHand catalog.

The node id is the Radicle node id when `rad self --nid` prints one. GitHub is optional. Init, configure, and the loop do not need it. The GitHub repository for this code is not a forge IdleHand manages unless you delegate it.

## Install

```bash
cargo install --path .
```

Or build in place with `cargo build --release` and run `target/release/idlehand`. The binary calls `git`, and optionally `rad`, `gh`, Docker, Podman, or `bwrap`.

## Home

The home is `~/.idlehand`. `--home PATH` wins, then `IDLEHAND_HOME` when that variable is non-empty. A leading `~` in either path is expanded. `rad` is separate: IdleHand does not set `RAD_HOME`. Any command that runs `rad` uses the `RAD_HOME` of that shell, and `idlehand start` passes that environment to the node process.

```bash
idlehand init
idlehand configure
idlehand start
idlehand status
idlehand analytics
idlehand stop
```

`init` creates the home, `config.toml`, `sources.toml` (two example repository URLs), `peers.toml`, and `workspaces/`. On Linux it registers an `x-scheme-handler/idlehand` handler when the XDG directories can be written. Elsewhere init prints that the handler was not registered. When `rad` can report an identity, init stores that node id.

`start` leaves the node running and prints its pid. `stop` sends SIGTERM and then SIGKILL if the process is still alive after five seconds. `configure` does not start the node.

## Configure

`idlehand configure` is a section menu: Subscription, Spending, Rules, Sandbox, Publish, Peers, and Done. Enter, `done`, or `7` leaves the menu and writes whatever you changed. `skip` or Enter on a field keeps the shown value. `back` returns to the menu. `none` clears the subscription, or a host list. A bad answer is rejected and is not written. Done leaves the node stopped.

Subscription is empty, `claude`, `codex`, or `cursor`.

While the node is running, the same settings are at `http://127.0.0.1:47321/idlehand/admin` when publish is still on the default address. `idlehand status` prints that URL when the publish host is loopback. A client that is not loopback gets 403. An empty field keeps the stored value. One bad value refuses the whole save.

`idlehand status` and `idlehand analytics` print the same text report. `idlehand analytics --json` prints JSON.

## What the loop does

`idlehand start` starts the loop when `rules.auto_start` is on, the source list has an entry, a contribution rule is on, and the next cycle's estimate would still fit under the spending limit. The default limit is 10,000 tokens (`idlehand limit 20000` changes it). The default estimate is 2,500 tokens per cycle. The loop stops before a cycle that would pass the limit. Changing the subscription does not reset the ledger.

Each cycle clones one source-list URL and runs one sandbox action: test, audit, issue, or pull request, in that order, for the rules that are on. The clone accepts a public `http` or `https` URL, or a local path the source list already names. SSH URLs and URLs with embedded credentials are refused.

Codex and Cursor are not executed. Claude is a planner only: tools disabled, and the reply is not executed. Issue and pull-request drafts are copied into the home and are not sent. `contributions pushed` stays at 0 until an explicit send.

The rest of the operation is in [docs/usage.md](docs/usage.md): spending limit, rules, the source list and `idlehand:` links, peers and the publish document, sandbox order, Radicle delegation and the contributor path, and GitHub.

Two local nodes that track only this repository are in [docs/self-improvement.md](docs/self-improvement.md).

## Tests

```bash
cargo test
```
