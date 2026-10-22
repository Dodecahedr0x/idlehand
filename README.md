# IdleHand

People who still have credits on Claude, Codex, or Cursor can point those subscriptions at open source. IdleHand runs a local node. The node holds your config, watches a spending limit, and keeps a contribution loop. It uses the credits on the CLI you already have. It does not bill a separate API.

Discovery stays on your machine. There is no IdleHand catalog.

IdleHand is a layer on Radicle. The node id is the Radicle node id when `rad self --nid` can report one. GitHub interop is optional, and init, connect, and the contribution loop do not need it. The GitHub repository that holds this code is not the forge IdleHand manages.

## Install

```bash
python3 -m pip install -e .
```

Python 3.11 or newer is enough. The package has no runtime dependencies. If the `idlehand` script is not on your `PATH`, run `python3 -m idlehand` instead.

## Basic path

```bash
idlehand init
idlehand connect claude
idlehand analytics
```

`connect` accepts `claude`, `codex`, or `cursor`. It starts the node and leaves it running. As soon as that CLI is on `PATH`, the contribution loop starts under the default spending limit.

```bash
idlehand status
idlehand stop
```

The home directory is `~/.idlehand`, or `$IDLEHAND_HOME` if that is set.

If `claude`, `codex`, `cursor-agent`, `agent`, or `cursor` is not installed, the node still stays up. `idlehand analytics` says the subscription is not connected, and it does not record a contribution. A dry loop is available:

```bash
idlehand demo
idlehand analytics
idlehand stop
```

Demo plans are labeled demo. A demo cycle can clone a repository and run the sandboxed command, and it still does not record a contribution. It also does not invoke the subscription CLI. When Claude reports token usage, analytics shows that reported total. When it does not, the total is labeled as a local estimate. Codex and Cursor are not invoked.

## Defaults

| Setting | Default |
| --- | --- |
| Spending limit | 10,000 tokens (`idlehand limit 20000` changes it) |
| Estimate per cycle | 2,500 tokens |
| Contribution rules | open: test, audit, issues, and pull requests |
| Ownership gate | none |
| Loop | starts when a subscription is connected |
| Source list | `sources.toml` in the IdleHand home, two example repos you can replace |
| Listen address | `127.0.0.1:47321`, path `/idlehand/publish` |
| Peer heuristic | add a second-degree peer after 1 endorsement, at most 5 new peers per cycle, at most 50 peers |
| Sandbox | Docker, then Podman, then the built-in namespace jail, then bubblewrap |

The loop stops before another cycle would pass the spending limit. Raise the limit and the loop continues. The estimate is not reset when you connect.

Rules can be turned off:

```bash
idlehand rules show
idlehand rules set allow_issues false
```

## Discovery

Three local mechanisms. None of them asks an IdleHand service.

**Source list.** `idlehand sources` prints `sources.toml`. Edit it. The node reloads it.

**Links add repos.** The link carries the repos, or it points at a file the publisher hosts:

```bash
idlehand link 'idlehand://add?repo=https://github.com/pallets/click&repo=https://github.com/encode/httpx'
idlehand link 'idlehand://add?list=https://example.com/idlehand-repos.txt'
```

A bare `idlehand:` URL works too, which is what a desktop handler passes. On Linux, `idlehand init` registers an `x-scheme-handler/idlehand` handler when the XDG directories can be written. A `list` URL is fetched from the host in the link. Redirects are not followed. One bad repository URL does not drop the others. `idlehand analytics` shows whether each URL was accepted or refused, and why.

A list file is one repository URL per line (`#` starts a comment), or JSON: `{"repos": ["https://github.com/org/name"]}`.

**Peers add peers.** This path does not add repos.

```bash
idlehand peer add 'https://peer.example/idlehand/publish'
idlehand peer list
```

The node publishes its own peer list and repo list at `/idlehand/publish`. It fetches that document from peers you already have. A second-degree peer is added only when the heuristic says so:

- `min_endorsements` (1): distinct direct peers that must list them
- `max_new_peers_per_cycle` (5)
- `max_peers` (50)
- `require_https` (true)
- `allow_insecure_loopback` (true): `http` is allowed only for `localhost`, `127.0.0.1`, and `::1`
- `allowed_hosts` (empty): if you set it, the host must be listed
- `blocked_hosts` (empty)

Second-degree `file:` URLs are ignored. URLs with a username or password are rejected. Repo lists found on peers are counted and left out of `sources.toml`. The same analytics view shows why a second-degree peer was accepted or refused. The knobs are in `config.toml` under `peer_heuristic`. There is no plugin system.

The listen port is bound to loopback until you change `publish.host`.

## Radicle

Management is separate from the contribution loop, and nothing is delegated automatically. IdleHand delegates a repository by its RID, and only when `rad inspect --identity` shows that the local Radicle identity is a delegate. Issues and patch text go through `rad` on the trusted side.

```bash
idlehand rad status
idlehand rad delegate rad:z3gqcJUoA1n9HaHKufZs5FCSGazv5
idlehand rad revoke rad:z3gqcJUoA1n9HaHKufZs5FCSGazv5
idlehand rad delegated
idlehand rad issue create rad:z3gqcJUoA1n9HaHKufZs5FCSGazv5 --title "Broken link" --body "The README link 404s."
idlehand rad issue update rad:z3gqcJUoA1n9HaHKufZs5FCSGazv5 e4255cc2a0a65b543c2b5badac14bf9e0d9f409f --body "Still broken."
idlehand rad issue send rad:z3gqcJUoA1n9HaHKufZs5FCSGazv5
idlehand rad patch update rad:z3gqcJUoA1n9HaHKufZs5FCSGazv5 89f7afb1511b976482b21f6b2f39aef7f4fb88a2 --title "Fix the link" --body "Updates the README."
idlehand rad patch send rad:z3gqcJUoA1n9HaHKufZs5FCSGazv5 89f7afb1511b976482b21f6b2f39aef7f4fb88a2
```

A contributor node lists the repository and does not have to delegate it. `rad issue open` creates the issue locally. `rad patch open` runs `git push rad HEAD:refs/patches` on the trusted side, and only for that listed RID or a delegated one. IdleHand records the issue, the patch, or a review only after `rad sync` reports that another node received the repository.

```bash
idlehand rad issue create rad:z3gqcJUoA1n9HaHKufZs5FCSGazv5 --title "Broken link" --body "The README link 404s."
idlehand rad patch open rad:z3gqcJUoA1n9HaHKufZs5FCSGazv5 --path /path/to/checkout --title "Fix the link" --body "Updates the README."
```

The host delegates the RID, checks the patch out, and runs the sandbox test. That check runs the repository's own tests, the same ones pytest runs, including a `tests` directory with no `__init__.py`. A check that ran tests and passed accepts the patch. A check that ran tests and failed refuses it. IdleHand records that verdict only after `rad sync` replicates it. If `rad` is missing, the node is stopped, the sync reaches no other node, the sandbox does not run, or the check discovers no tests, IdleHand does not accept the patch and does not refuse it.

```bash
idlehand rad patch check rad:z3gqcJUoA1n9HaHKufZs5FCSGazv5 89f7afb1511b976482b21f6b2f39aef7f4fb88a2 --path /path/to/checkout
```

`rad patch edit` changes the title and description of a patch that already exists. If `rad` does not confirm a result, the command says so and stops.

`rad` keys stay in the Radicle home. They are not copied into the sandbox, the publish feed, or analytics.

## GitHub interop

GitHub is optional. IdleHand uses the `gh` login already on the machine. It does not store a token, and it does not require `gh` for init, connect, or the contribution loop.

```bash
idlehand github status
idlehand github repos
idlehand github delegate octocat/hello
idlehand github revoke octocat/hello
idlehand github delegated
idlehand github issue create octocat/hello --title "Broken link" --body "The README link 404s."
idlehand github pr create octocat/hello --title "Fix the link" --body "Updates the README." --head fix-link
```

`github repos` lists repositories that login owns or administers and does not delegate them. Issues and pull requests run `gh` only for a delegated `owner/name`. `pr create` opens a pull request for a branch already on GitHub. It does not push. If `gh` is missing, not logged in, or does not confirm the result, the command says so and stops.

## Sandbox

Repository commands run in a container when Docker or Podman is installed. Otherwise IdleHand uses a Linux namespace jail: a private copy of the command and its libraries, the workspace mounted at `/work`, no route outside the jail, and a cleared environment. Loopback inside the jail is up so a test can bind `127.0.0.1`; that address is not the host. Home, credentials, and the rest of the host filesystem are not mounted. The test command runs the repository's tests. A run that discovers none is not a pass. If no runtime can start, IdleHand refuses the command instead of running it on the host.

The contribution loop clones one repository from the local source list, then runs the action in that sandbox. The clone itself stays outside the sandbox: public http(s) URLs, or a local path the source list already names. SSH URLs and URLs with embedded credentials are refused. Subscription CLIs stay outside the sandbox. Their credentials are not copied into it.

```bash
idlehand sandbox spec
idlehand sandbox run
```

`sandbox run` executes a local probe. It does not clone a repository and it is not a contribution.

## What this slice does

Real:

- local CLI and a node process that stays up
- config for the subscription, source list, rules, spending limit, and peers
- one clone per cycle from the local source list, then test, audit, issue, and pull request commands in the sandbox
- a contribution recorded only after that sandboxed command has run
- a 10,000 token limit that stops the loop before the next cycle's estimate would pass it
- Claude usage metered when that CLI reports it, otherwise a labeled local estimate
- `idlehand analytics`
- the loop starting after a subscription CLI is connected
- `idlehand:` links, including a direct fetch of a publisher list file
- Linux protocol-handler registration
- peer publish endpoint, direct fetch, and the peers-of-peers heuristic
- container command line, and the namespace jail when Docker and Podman are absent
- explicit Radicle delegation by RID, with issues and patch edits through the local `rad` CLI
- optional GitHub delegation through the `gh` login already on the machine

Not done in this slice:

- Codex and Cursor are not invoked. Claude is invoked only as a planner with tools disabled, and its reply is not executed.
- The contribution loop copies issue and pull request drafts into the IdleHand home and does not send them. `contributions pushed` stays at 0. Sending a draft is explicit: `idlehand rad issue send` or `patch send` for a delegated RID, or `idlehand github issue send` or `pr send` for a delegated GitHub repository.
- Forges other than the Radicle path and the optional GitHub interop.
- Demo output is not a contribution.

## Tests

```bash
python3 -m pip install -e ".[dev]"
python3 -m pytest
```
