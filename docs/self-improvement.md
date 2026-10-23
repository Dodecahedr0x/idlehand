# Two local nodes on this repository

This is a way to run IdleHand, and a showcase of it. Two nodes on one machine track only this repository. Each node has its own IdleHand home and its own Radicle home. The homes below are paths you create. They are empty until `idlehand init` and `rad auth`.

| | Owner | Contributor |
| --- | --- | --- |
| `IDLEHAND_HOME` | `~/.idlehand-owner` | `~/.idlehand-contributor` |
| `RAD_HOME` | `~/.radicle-owner` | `~/.radicle-contributor` |
| Publish | `127.0.0.1:47321` | `127.0.0.1:47322` |
| Radicle listen | `127.0.0.1:8776` | `127.0.0.1:8777` |

The RID is `rad:z2Re3kVxLJjoaAXKG1mJCFbGrSr42`. That is the id on this checkout's `rad` remote (`rad://z2Re3kVxLJjoaAXKG1mJCFbGrSr42` is the remote URL; IdleHand takes the `rad:z…` form). GitHub origin is `https://github.com/Dodecahedr0x/idlehand`. GitHub is optional. This scenario does not use it. Radicle is the forge the two nodes use.

`idlehand` does not set `RAD_HOME`. Every `rad` command and every `idlehand` command that calls `rad` (`init`, `start`, `rad`) needs the `RAD_HOME` of that node. The blocks below export both variables. `rules` and `configure` need the IdleHand home. They do not call `rad`.

IdleHand does not create a Radicle identity and does not edit delegates. `rad auth` creates a new profile in that `RAD_HOME`. `idlehand rad delegate` records the RID only when `rad inspect --identity rad:z2Re3kVxLJjoaAXKG1mJCFbGrSr42` lists this profile's DID (`did:key:` plus the node id) or the node id in `delegates`. A new profile is not a delegate of this RID. Until it is, `idlehand rad delegate` and `idlehand rad patch check` stop, and they neither accept nor refuse a patch. `rad seed --from` fetches from the owner node only when that node has the repository in its storage.

## Owner

`RAD_HOME=~/.radicle-owner` for every command in this section. The IdleHand home is `~/.idlehand-owner`.

```bash
export RAD_HOME=~/.radicle-owner
export IDLEHAND_HOME=~/.idlehand-owner
rad auth --alias owner
rad node start -- --listen 127.0.0.1:8776
rad self --nid
```

`rad self --nid` prints the owner node id. The contributor uses it as `<owner-nid>`.

```bash
idlehand init
idlehand configure
```

At the menu, move to Publish and press Enter. Skip listen and host with `s`. On `publish.port`, type `47321` and press Enter. Skip the fetch interval. Press `q` or move to Done. The default port is already 47321. Done saves and leaves the node stopped.

```bash
idlehand rules set allow_issues false
idlehand rules set allow_pull_requests false
idlehand rules show
```

`allow_test` and `allow_audit` stay on. `allow_issues` and `allow_pull_requests` are off. The owner files no issues and opens no patches.

Replace `sources.toml` so the only entry is this RID:

```toml
[[repos]]
url = "rad:z2Re3kVxLJjoaAXKG1mJCFbGrSr42"
note = "This repository."
```

```bash
idlehand sources
idlehand rad status
idlehand rad delegate rad:z2Re3kVxLJjoaAXKG1mJCFbGrSr42
idlehand rad delegated
idlehand start
idlehand status
```

`rad status` uses this `RAD_HOME`. `delegate` uses it too. `start` inherits it.

After the contributor node is up, connect to it. `<contributor-nid>` is `rad self --nid` from the contributor shell.

```bash
rad node connect <contributor-nid>@127.0.0.1:8777
rad seed rad:z2Re3kVxLJjoaAXKG1mJCFbGrSr42
```

## Contributor

`RAD_HOME=~/.radicle-contributor` for every command in this section. The IdleHand home is `~/.idlehand-contributor`.

```bash
export RAD_HOME=~/.radicle-contributor
export IDLEHAND_HOME=~/.idlehand-contributor
rad auth --alias contributor
rad node start -- --listen 127.0.0.1:8777
rad self --nid
rad node connect <owner-nid>@127.0.0.1:8776
```

```bash
idlehand init
idlehand configure
```

Open Publish, skip listen and host with `s`, set `publish.port` to `47322`, then press `q` or Done. Configure does not start the node.

```bash
idlehand rules set allow_test false
idlehand rules set allow_audit false
idlehand rules show
```

`allow_issues` and `allow_pull_requests` stay on. `allow_test` and `allow_audit` are off. Do not delegate the RID. `idlehand rad delegated` prints `No repositories are delegated.`

Use the same `sources.toml` as the owner, and only that RID:

```toml
[[repos]]
url = "rad:z2Re3kVxLJjoaAXKG1mJCFbGrSr42"
note = "This repository."
```

Seed from the owner, then clone a checkout this profile owns:

```bash
rad seed rad:z2Re3kVxLJjoaAXKG1mJCFbGrSr42 --from <owner-nid>
rad clone rad:z2Re3kVxLJjoaAXKG1mJCFbGrSr42 ~/idlehand-contributor-checkout --seed <owner-nid>
idlehand start
idlehand status
```

After `start`, `status` prints `http://127.0.0.1:47322/idlehand/admin`. The page is served while that node is listening.

Open an issue and a patch from that checkout. Both commands use this `RAD_HOME`. The RID is listed, so these two commands do not need a delegation. The checkout's HEAD is what `git push rad HEAD:refs/patches` sends. `rad .` in the checkout must print this RID.

```bash
idlehand rad issue create rad:z2Re3kVxLJjoaAXKG1mJCFbGrSr42 \
  --title "Broken link" \
  --body "The README link 404s."
idlehand rad patch open rad:z2Re3kVxLJjoaAXKG1mJCFbGrSr42 \
  --path ~/idlehand-contributor-checkout \
  --title "Fix the link" \
  --body "Updates the README."
```

IdleHand prints `opened issue <id>` or `opened patch <id>` only after `rad sync rad:z2Re3kVxLJjoaAXKG1mJCFbGrSr42 --announce --replicas 1 --timeout 20s` reports that another node received the repository. If that sync reaches no other node, the command stops and does not report the issue or the patch.

## Owner check

Still `RAD_HOME=~/.radicle-owner` and `IDLEHAND_HOME=~/.idlehand-owner`.

Clone a checkout the check is allowed to move. `patch check` runs `rad patch checkout <patch-id> --force` in `--path`.

```bash
rad clone rad:z2Re3kVxLJjoaAXKG1mJCFbGrSr42 ~/idlehand-owner-checkout
idlehand rad patch check rad:z2Re3kVxLJjoaAXKG1mJCFbGrSr42 <patch-id> \
  --path ~/idlehand-owner-checkout
```

`<patch-id>` is the 40 hex digits from `opened patch`. The RID must be delegated by this profile, and the Radicle node must be running.

The sandbox runs the test program from the node: it collects `test_*.py` and `*_test.py` inside the checkout. It does not run `cargo test`. This repository's tests are Rust (`cargo test` in the working tree). A check that finds no Python tests prints no accept and no refuse.

When the program prints `tests_run` of at least 1:

- a passing run accepts the patch (`accepted patch <id> on rad:z…`)
- a failing run refuses it (`refused patch <id> on rad:z…`)

Those lines are printed only after `rad sync` reports that the other node received the repository. If `rad` is missing, the Radicle node is stopped, the sync reaches no other node, the sandbox does not run, or the check discovers no tests, IdleHand does not accept the patch and does not refuse it.

## What stays local

The loop does not send drafts. On these source lists the loop also does not clone the RID: a `rad:` URL is not a public git URL, so a cycle does not fetch this repository and does not record a contribution for it. Owner cycles are test and audit. Contributor cycles are issue and pull request. Both only write drafts in the home, and only after a clone the loop accepts. Sending is explicit, and the contributor commands above are that send. Configure does not start either node. `idlehand start` does.

Stop one node without touching the other:

```bash
# owner shell
export RAD_HOME=~/.radicle-owner
export IDLEHAND_HOME=~/.idlehand-owner
idlehand stop
rad node stop

# contributor shell
export RAD_HOME=~/.radicle-contributor
export IDLEHAND_HOME=~/.idlehand-contributor
idlehand stop
rad node stop
```
