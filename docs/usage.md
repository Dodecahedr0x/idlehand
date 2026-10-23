# Using IdleHand

Commands are `idlehand [--home PATH] <command>`. `--home` overrides `IDLEHAND_HOME`. Both override `~/.idlehand`. `idlehand --help` lists `init`, `configure`, `demo`, `start`, `stop`, `status`, `analytics`, `limit`, `link`, `rules`, `peer`, `sources`, `sandbox`, `rad`, `github`, and `node`.

`connect` is not a command.

The home holds `config.toml`, `sources.toml`, `peers.toml`, `delegated.toml`, `state.json`, `publish.json`, `node.pid`, `node.log`, `workspaces/`, and `drafts/`. Radicle keys stay in `RAD_HOME`. They are not copied into the sandbox, the publish document, or analytics.

## Configure

```text
Select a section [Done]:
  1. Subscription (subscription)
  2. Spending (spending)
  3. Rules (rules)
  4. Sandbox (sandbox)
  5. Publish (publish)
  6. Peers (peers)
  7. Done
```

Type a number, the section key, or the label. Each field prints its current value. Enter or `skip` keeps it. `back` returns to the menu. Enter, `done`, or `7` on the menu saves changed fields and exits. Nothing is written until then, and the node is not started.

`none` clears `subscription`, `peer_heuristic.allowed_hosts`, and `peer_heuristic.blocked_hosts`. Subscription names are `claude`, `codex`, and `cursor`. Booleans accept `true`, `false`, `yes`, `no`, `on`, `off`, `1`, and `0`. A rejected value stays on that prompt and is not stored.

Fields:

| Section | Keys |
| --- | --- |
| Subscription | `subscription`, `demo` |
| Spending | `spending_limit_tokens`, `estimate_tokens_per_cycle`, `loop_interval_seconds` |
| Rules | `rules.auto_start`, `rules.allow_test`, `rules.allow_audit`, `rules.allow_issues`, `rules.allow_pull_requests` |
| Sandbox | `sandbox.runtime`, `sandbox.execute`, `sandbox.image`, `sandbox.memory`, `sandbox.cpus` |
| Publish | `publish.listen`, `publish.host`, `publish.port`, `publish.peer_fetch_interval_seconds` |
| Peers | `peer_heuristic.min_endorsements`, `peer_heuristic.max_new_peers_per_cycle`, `peer_heuristic.max_peers`, `peer_heuristic.require_https`, `peer_heuristic.allow_insecure_loopback`, `peer_heuristic.allowed_hosts`, `peer_heuristic.blocked_hosts` |

`sandbox.runtime` is `auto`, `none`, `docker`, `podman`, `namespace`, or `bwrap`. `publish.port` is 0 through 65535. Host lists are comma-separated hostnames.

## Admin page

The node serves `/idlehand/admin` on the publish listener. With the defaults that is `http://127.0.0.1:47321/idlehand/admin`. `idlehand status` prints the admin URL when the publish URL host is `127.0.0.1`, `localhost`, or `::1`.

A TCP client that is not a loopback address receives `403` and `admin is loopback only`. The form's empty field keeps the stored value. `none` clears the subscription or a host list. Save applies every field together. One bad value returns `rejected: …` and writes nothing.

`/idlehand/publish` is the public document. It does not include the subscription, the spending limit, or the home path.

## Spending limit

Defaults in `config.toml`: `spending_limit_tokens` 10000, `estimate_tokens_per_cycle` 2500, `loop_interval_seconds` 5.

```bash
idlehand limit
idlehand limit 20000
```

With no argument, `limit` prints the integer. The argument is a non-negative integer. The loop adds reported Claude tokens when the planner returns them. Otherwise a cycle that actually ran the sandbox adds the per-cycle estimate. The total is labeled `reported`, `local-estimate`, or `mixed`. The ledger is not cleared when the subscription changes.

Before a cycle, if the total is already at the limit, or the total plus the per-cycle estimate would pass it, the loop status is `stopped` and the reason is `spending limit reached`. Raise the limit and later cycles can run.

## Rules

```bash
idlehand rules show
idlehand rules set allow_issues false
```

Keys: `auto_start`, `allow_test`, `allow_audit`, `allow_issues`, `allow_pull_requests`. The value is `true` or `false` (the same boolean words as configure). Defaults are all `true`.

`auto_start` false leaves the loop `idle` with reason `auto start is off`. `idlehand demo` sets `demo` true, starts the node, and still runs cycles when auto start is off. Demo plans are labeled demo. A demo cycle can clone and run the sandbox. It does not record a contribution and it does not invoke a subscription CLI.

The loop rotates through the enabled actions in this order: test, audit, issue, pull request. All four off leaves the loop idle with reason `every contribution action is turned off`.

## Source list and links

`sources.toml` is local. `idlehand sources` prints its path and each URL. The node reloads the file. Init writes two `https://example.com/idlehand/…` examples. Replace them by editing the file. There is no command that sets the list in one shot.

```toml
[[repos]]
url = "https://github.com/Dodecahedr0x/idlehand"
note = ""
```

A `rad:z…` id is a valid list entry for the Radicle commands below. The loop's clone does not fetch it. Clone URLs are public `http` or `https` with a host and a path, or a `file:` URL or absolute path already named in the list.

`idlehand link` adds repositories from an `idlehand:` URL. A bare URL is what a desktop handler passes. One argument that is itself an `idlehand:` URL is enough (`idlehand 'idlehand:…'`).

```bash
idlehand link 'idlehand://add?repo=https://github.com/pallets/click&repo=https://github.com/encode/httpx'
idlehand link 'idlehand://add?list=https://example.com/idlehand-repos.txt'
```

`repo` and `repos` add URLs. `list` fetches one file. Catalog, directory, and registry parameters are rejected. Repository URLs in a link must be `http` or `https` and must have a path. A list file is `http`, `https`, or `file`. Redirects are not followed. The file is at most 1MB. One bad repository URL does not drop the others. `idlehand analytics` shows each URL as accepted or refused, and why.

A list file is one URL per line. Empty lines and lines starting with `#` are comments. JSON may be a list of strings or `{"repos": ["https://github.com/org/name"]}`.

## Peers and the publish document

```bash
idlehand peer add 'https://peer.example/idlehand/publish'
idlehand peer list
```

`peer add` fetches that URL directly. It does not add repositories. `peer list` prints the URL, source, and endorsement count. An empty list prints `No peers yet.`

The node writes `publish.json` and serves it at `/idlehand/publish`:

```json
{
  "idlehand": 1,
  "node_id": "",
  "listen_url": "http://127.0.0.1:47321/idlehand/publish",
  "peers": [{ "url": "https://peer.example/idlehand/publish", "id": "" }],
  "repos": [{ "url": "https://github.com/Dodecahedr0x/idlehand" }]
}
```

The listen port binds `127.0.0.1` until you change `publish.host`. Set `publish.listen` false and the node does not open the port.

Each cycle can fetch peers you already have. A second-degree peer is added only when the heuristic says so:

- `min_endorsements` (1): distinct direct peers that list them
- `max_new_peers_per_cycle` (5)
- `max_peers` (50)
- `require_https` (true)
- `allow_insecure_loopback` (true): `http` is allowed only for `localhost`, `127.0.0.1`, and `::1`
- `allowed_hosts` (empty): if you set it, the host must be listed
- `blocked_hosts` (empty)

Second-degree `file:` URLs are not added. URLs with a username or password are rejected. Repository URLs found on peers are counted and left out of `sources.toml`. Analytics shows why a second-degree peer was accepted or refused. The knobs are `peer_heuristic` in `config.toml`.

## Sandbox

`sandbox.runtime` `auto` picks the first runtime it can use: `docker`, then `podman`, then on Linux the built-in namespace jail, then `bwrap` when that binary is on `PATH`. `none` and a machine with none of those runtimes refuse the command. IdleHand does not run the repository command on the host.

The namespace jail uses a private copy of the command and its libraries, mounts the workspace at `/work`, and starts with an empty environment. Loopback inside the jail is up so a test can bind `127.0.0.1`. That address is not the host. Home, credentials, and the rest of the host filesystem are not mounted. Bubblewrap mounts `/usr` read-only and the workspace at `/work`, and does not mount the home directory.

Container defaults are image `python:3.12-slim`, memory `512m`, and `1` CPU. `sandbox.execute` false refuses the run.

The test action runs a Python program in the sandbox. It collects `test_*.py` and `*_test.py`, including a `tests` directory with no `__init__.py`, and it provides `tmp_path`, `monkeypatch`, `capsys`, `pytest.raises`, and `pytest.mark.parametrize`. It prints `tests_run=N`. A run that discovers none exits non-zero. That program does not run `cargo test`.

The audit action writes `.idlehand/audit.txt` in the workspace when it can. The issue and pull-request actions write `.idlehand/issue-draft.md` and `.idlehand/pr-draft.md`. After a sandbox run, those files are copied to `drafts/<slug>/` in the home. The drafts say they were not filed and were not pushed.

Subscription CLIs stay outside the sandbox. The loop records a contribution only when the sandbox command was invoked and the cycle is not a demo. `contributions pushed` counts plans with `pushed` true. The loop sets `pushed` false.

```bash
idlehand sandbox spec
idlehand sandbox run
```

`sandbox spec` prints the runtime and, for Docker or Podman, the container command. `sandbox run` executes a local probe under `workspaces/manual`. It does not clone a repository and it is not a contribution.

## What the loop does not do

Codex and Cursor are not executed. When one of those subscriptions is configured and its binary is on `PATH`, analytics shows the command as not run. Cursor binaries are `cursor-agent`, then `agent`, then `cursor`. Codex is the `codex` binary. Claude is the `claude` binary.

Claude is a planner only. The loop calls it with tools disabled (`--tools` empty, `--disallowedTools *`, `--permission-mode plan`) and a one-sentence prompt. The reply is not executed. When Claude is missing, the node still stays up, analytics says the subscription is not connected, and the sandbox can still run.

Drafts are not sent. Sending is a separate command, below.

## Radicle

IdleHand does not set `RAD_HOME` and does not create a Radicle identity. `rad` runs on the trusted side with the shell's environment. The passphrase is not placed in argv. Set `RAD_HOME` in the shell you use for that profile. `idlehand init`, `idlehand start`, and `idlehand rad` then see that profile. `rad self --nid` must print one line, a `z6Mk…` id, and `rad self --did` must print `did:key:` plus that id, or IdleHand keeps a local id.

Management is separate from the loop. Nothing is delegated automatically.

```bash
idlehand rad status
idlehand rad delegated
idlehand rad delegate rad:z2Re3kVxLJjoaAXKG1mJCFbGrSr42
idlehand rad revoke rad:z2Re3kVxLJjoaAXKG1mJCFbGrSr42
```

`delegate` stores the RID in `delegated.toml` when three checks pass: `rad node status` reports the node running, `rad self` reports an identity, and `rad inspect --identity RID` has that DID or node id in `delegates`. IdleHand does not edit the identity document. A profile that is absent from `delegates` is refused with `this identity does not control that repository`. `revoke` only removes the local record.

An RID has the form `rad:z` plus 20 to 40 characters. `rad://z…` is not accepted. This repository's `rad` remote uses `rad://z2Re3kVxLJjoaAXKG1mJCFbGrSr42`; the IdleHand argument is `rad:z2Re3kVxLJjoaAXKG1mJCFbGrSr42`.

A contributor lists that RID in `sources.toml` and does not have to delegate it. These commands run when the RID is delegated or listed, the Radicle node is running, and `rad` is installed. A delegated RID must also still show this identity in `delegates`.

```bash
idlehand rad issue create rad:z2Re3kVxLJjoaAXKG1mJCFbGrSr42 --title "Broken link" --body "The README link 404s."
idlehand rad patch open rad:z2Re3kVxLJjoaAXKG1mJCFbGrSr42 --path /path/to/checkout --title "Fix the link" --body "Updates the README."
```

`issue create` runs `rad issue open --repo RID --title … --description … --no-announce`. The issue id is the 40 hex digits on the line `rad` labels `Issue`. `patch open` checks that `rad .` in `--path` prints the same RID, then in that checkout runs `git push rad` with `-o patch.message=<title>`, another `-o patch.message=<body>` when the body is non-empty, and the refspec `HEAD:refs/patches`. The patch id is the 40 hex digits in `Patch <id> opened`.

`--body-file PATH` reads the body from a regular file of at most 65000 bytes. A symlink is refused. Pass `--body` or `--body-file`, not both.

These commands require a delegated RID. Listing the RID in `sources.toml` is not enough.

```bash
idlehand rad issue update rad:z2Re3kVxLJjoaAXKG1mJCFbGrSr42 e4255cc2a0a65b543c2b5badac14bf9e0d9f409f --body "Still broken."
idlehand rad patch update rad:z2Re3kVxLJjoaAXKG1mJCFbGrSr42 89f7afb1511b976482b21f6b2f39aef7f4fb88a2 --title "Fix the link" --body "Updates the README."
idlehand rad patch check rad:z2Re3kVxLJjoaAXKG1mJCFbGrSr42 89f7afb1511b976482b21f6b2f39aef7f4fb88a2 --path /path/to/checkout
```

`patch update` runs `rad patch edit`. `patch check` runs `rad patch checkout PATCH --force` in `--path`, then the sandbox test program. A check that prints `tests_run` of at least 1 and exits 0 runs `rad patch review --accept`. A check that ran tests and failed runs `rad patch review --reject`. `--path` is required. The checkout is a git directory, not a symlink, and `rad .` there must print this RID.

After an issue is opened, a patch is opened, an issue or patch is updated, or a review is submitted, IdleHand runs:

```text
rad sync RID --announce --replicas 1 --timeout 20s
```

It reports the result only when that command exits 0 and the output says it synced with at least one seed, is already in sync with at least one seed, or a line contains `Synced with` and a node id. Otherwise the command stops and does not report the issue, the patch, or the review.

If `rad` is missing, the Radicle node is stopped, sync reaches no other node, the sandbox does not run, or the check discovers no tests, a patch check does not accept the patch and does not refuse it. Those stops happen before `rad patch review`, except a failed sync, which happens after `rad patch review` and still withholds the accept and refuse lines.

Explicit sends read drafts the loop copied into the home. They do not run as part of the loop.

```bash
idlehand rad issue send rad:z2Re3kVxLJjoaAXKG1mJCFbGrSr42
idlehand rad patch send rad:z2Re3kVxLJjoaAXKG1mJCFbGrSr42 89f7afb1511b976482b21f6b2f39aef7f4fb88a2
```

`issue send` opens `drafts/…/issue-draft.md` through `issue create`. The RID may be delegated or listed. `patch send` applies `drafts/…/pr-draft.md` with `patch update` to a patch id that already exists. That RID must be delegated. Neither command pushes a new patch branch. If `rad` does not confirm a result, the command says so and stops.

## GitHub

GitHub is optional. IdleHand uses the `gh` login already on the machine. It does not store a token. This repository's GitHub origin is `https://github.com/Dodecahedr0x/idlehand`.

```bash
idlehand github status
idlehand github repos
idlehand github delegate Dodecahedr0x/idlehand
idlehand github revoke Dodecahedr0x/idlehand
idlehand github delegated
```

`github repos` lists repositories that login owns or administers and does not delegate them. `delegate` records `owner/name` only when `gh` shows that login owns or administers it.

Issues and pull requests run `gh` only for a delegated `owner/name`.

```bash
idlehand github issue create Dodecahedr0x/idlehand --title "Broken link" --body "The README link 404s."
idlehand github issue update Dodecahedr0x/idlehand 1 --title "Broken link" --body "Still broken."
idlehand github issue send Dodecahedr0x/idlehand
idlehand github pr create Dodecahedr0x/idlehand --title "Fix the link" --body "Updates the README." --head fix-link
idlehand github pr update Dodecahedr0x/idlehand 1 --title "Fix the link" --body "Updates the README."
idlehand github pr send Dodecahedr0x/idlehand --head fix-link
```

`pr create` takes `--head` and an optional `--base`. It opens a pull request for a branch already on GitHub. It does not push. `pr send` reads the local pull-request draft and also takes `--head`. If `gh` is missing, not logged in, or does not confirm the result, the command says so and stops.

## Status

`idlehand status` and `idlehand analytics` print the node, the subscription, the loop status and reason, spending, contributions recorded, contributions pushed, the source-list count, peers, the delegation list, recent trust decisions, and the latest plans. A plan line includes whether the subscription command ran. `idlehand analytics --json` prints the same snapshot as JSON.
