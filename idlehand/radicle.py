"""Radicle is the repository IdleHand manages.

The local `rad` CLI is the identity, the delegation check, and the way issues
and patch text are published. GitHub is a separate, optional interop. Nothing
here is delegated automatically. `rad` runs on the trusted side, outside the
sandbox. Its keys stay in the Radicle home: they are not written into the
delegation file, the publish feed, or analytics.

A node whose source list names a RID may open an issue and a patch on it.
Opening that patch runs `git push rad HEAD:refs/patches` on the trusted side.
A host who delegates the RID reviews the patch, runs the sandbox check, and
accepts or refuses it. A missing `rad`, a stopped node, or a sandbox that did
not run is not an acceptance and is not a refusal.
"""

from __future__ import annotations

import hashlib
import json
import os
import re
import shutil
import subprocess
import tempfile
from pathlib import Path

from idlehand.actions import action_command
from idlehand.config import load_config, load_sources, save_config
from idlehand.fetch import resolve_git, scrub_secrets
from idlehand.sandbox import detect_runtime, run as run_sandbox
from idlehand.forge import (
    ForgeResult,
    _checked_text,
    load_delegated,
    parse_rid,
    save_delegated,
)
from idlehand.home import home_lock

_NID = re.compile(r"z6Mk[1-9A-HJ-NP-Za-km-z]{44}")
_COB = re.compile(r"\b[0-9a-f]{40}\b")
_ANSI = re.compile(r"\x1b\[[0-9;]*[A-Za-z]")
_NOT_INSTALLED = "rad is not installed"
_NOT_RUNNING = "the Radicle node is not running"
_NO_IDENTITY = "rad did not report a node id"


def parse_node_id(value: str) -> str | None:
    """A Radicle NodeId. A peer record may store one of these."""
    text = value.strip()
    if _NID.fullmatch(text) is None:
        return None
    return text


def parse_cob_id(value: str) -> str | None:
    text = value.strip()
    if not re.fullmatch(r"[0-9a-f]{40}", text):
        return None
    return text


def _plain(text: str) -> str:
    return _ANSI.sub("", text)


def _show(text: str) -> str:
    cleaned = scrub_secrets(_plain(text))
    secret = os.environ.get("RAD_PASSPHRASE", "")
    kept: list[str] = []
    for line in cleaned.splitlines():
        stripped = line.strip()
        if not stripped:
            continue
        if "PRIVATE KEY" in stripped or "RAD_PASSPHRASE" in stripped:
            continue
        if secret and secret in stripped:
            continue
        kept.append(stripped)
    if not kept:
        return ""
    return kept[0][:200]


def _run(
    args: list[str],
    timeout: int = 30,
    cwd: Path | None = None,
) -> subprocess.CompletedProcess[str]:
    binary = shutil.which("rad")
    if binary is None:
        return subprocess.CompletedProcess(args, 127, "", _NOT_INSTALLED)
    owned = cwd is None
    work = Path(tempfile.mkdtemp(prefix="idlehand-rad-")) if owned else cwd
    command = [binary, *args]
    try:
        try:
            return subprocess.run(
                command,
                cwd=work,
                env=os.environ.copy(),
                capture_output=True,
                text=True,
                timeout=timeout,
                check=False,
            )
        except subprocess.TimeoutExpired:
            return subprocess.CompletedProcess(command, 124, "", "rad timed out")
        except OSError:
            return subprocess.CompletedProcess(command, 127, "", _NOT_INSTALLED)
    finally:
        if owned:
            shutil.rmtree(work, ignore_errors=True)


def _failure(fallback: str, result: subprocess.CompletedProcess[str]) -> str:
    detail = _show(result.stderr or result.stdout or "")
    if not detail or detail == _NOT_INSTALLED:
        return fallback
    return f"{fallback}: {detail}"


def _one_line(result: subprocess.CompletedProcess[str]) -> str:
    if result.returncode != 0:
        return ""
    text = _plain(result.stdout or "").strip()
    if not text or "\n" in text or len(text) > 200:
        return ""
    return text


def identity() -> tuple[str, str] | ForgeResult:
    """Local Radicle node id and DID. This does not mean the node is running."""
    if shutil.which("rad") is None:
        return ForgeResult(False, _NOT_INSTALLED)
    nid = parse_node_id(_one_line(_run(["self", "--nid"], timeout=10))) or ""
    did = _one_line(_run(["self", "--did"], timeout=10))
    if not nid or did != f"did:key:{nid}":
        return ForgeResult(False, _NO_IDENTITY)
    return nid, did


def remember_identity(home: Path) -> tuple[str, str]:
    """Store the Radicle node id when `rad self --nid` reports one.

    A missing `rad` leaves the local id alone and does not claim it is a NodeId.
    """
    found = identity()
    if isinstance(found, ForgeResult):
        return "", found.detail
    nid, _did = found
    try:
        config = load_config(home)
    except (OSError, UnicodeError, ValueError):
        return "", "config is unreadable"
    if config.get("node_id") == nid:
        return nid, ""
    config["node_id"] = nid
    try:
        with home_lock(home):
            current = load_config(home)
            current["node_id"] = nid
            save_config(home, current)
    except (OSError, UnicodeError, ValueError):
        return "", "config is unreadable"
    return nid, ""


def node_running() -> ForgeResult:
    """Whether `rad node status` says the node is running.

    A stopped node still exits 0. The status line is the signal, not the exit code.
    """
    if shutil.which("rad") is None:
        return ForgeResult(False, _NOT_INSTALLED)
    result = _run(["node", "status"], timeout=10)
    if len(result.stdout or "") > 1_000_000 or len(result.stderr or "") > 1_000_000:
        return ForgeResult(False, _NOT_RUNNING)
    text = _plain((result.stdout or "") + "\n" + (result.stderr or ""))
    running_at = text.find("Node is running")
    stopped_at = text.find("Node is stopped")
    if result.returncode == 0 and running_at >= 0 and (stopped_at < 0 or running_at < stopped_at):
        return ForgeResult(True, "The Radicle node is running.")
    return ForgeResult(False, _NOT_RUNNING)


def _controls(rid: str, did: str) -> ForgeResult:
    result = _run(["inspect", "--identity", rid], timeout=15)
    if result.returncode != 0:
        return ForgeResult(False, "rad could not show whether this identity controls that repository")
    raw = result.stdout or ""
    if len(raw) > 1_000_000:
        return ForgeResult(False, "rad could not show whether this identity controls that repository")
    plain = _plain(raw)
    start = plain.find("{")
    end = plain.rfind("}")
    if start < 0 or end < start:
        return ForgeResult(False, "rad could not show whether this identity controls that repository")
    try:
        document = json.loads(plain[start : end + 1])
    except json.JSONDecodeError:
        return ForgeResult(False, "rad could not show whether this identity controls that repository")
    delegates = document.get("delegates") if isinstance(document, dict) else None
    if not isinstance(delegates, list):
        return ForgeResult(False, "rad could not show whether this identity controls that repository")
    nid = did.removeprefix("did:key:")
    for item in delegates:
        if item == did or item == nid:
            return ForgeResult(True, "")
    return ForgeResult(False, "this identity does not control that repository")


def _ready(rid: str) -> tuple[str, str] | ForgeResult:
    running = node_running()
    if not running.ok:
        return running
    found = identity()
    if isinstance(found, ForgeResult):
        return found
    nid, did = found
    controlled = _controls(rid, did)
    if not controlled.ok:
        return controlled
    return nid, did


def _stored(home: Path, rid: str) -> str | ForgeResult:
    rows = load_delegated(home)
    if rows is None:
        return ForgeResult(False, "the delegation list is unreadable")
    for provider, name in rows:
        if provider == "radicle" and name == rid:
            return name
    return ForgeResult(False, "that repository is not delegated")


def delegate_rid(home: Path, raw: str) -> ForgeResult:
    rid = parse_rid(raw)
    if rid is None:
        return ForgeResult(False, "repository must look like rad:z…")
    rows = load_delegated(home)
    if rows is None:
        return ForgeResult(False, "the delegation list is unreadable")
    if any(provider == "radicle" and name == rid for provider, name in rows):
        return ForgeResult(True, f"{rid} is already delegated")
    ready = _ready(rid)
    if isinstance(ready, ForgeResult):
        return ready
    rows.append(("radicle", rid))
    if not save_delegated(home, rows):
        return ForgeResult(False, "the delegation list is unreadable")
    return ForgeResult(True, f"delegated {rid}")


def revoke_rid(home: Path, raw: str) -> ForgeResult:
    rid = parse_rid(raw)
    if rid is None:
        return ForgeResult(False, "repository must look like rad:z…")
    rows = load_delegated(home)
    if rows is None:
        return ForgeResult(False, "the delegation list is unreadable")
    if not any(provider == "radicle" and name == rid for provider, name in rows):
        return ForgeResult(False, "that repository is not delegated")
    kept = [(provider, name) for provider, name in rows if not (provider == "radicle" and name == rid)]
    if not save_delegated(home, kept):
        return ForgeResult(False, "the delegation list is unreadable")
    return ForgeResult(True, f"revoked {rid}")


def _delegated_ready(home: Path, rid: str) -> ForgeResult | None:
    stored = _stored(home, rid)
    if isinstance(stored, ForgeResult):
        return stored
    ready = _ready(rid)
    if isinstance(ready, ForgeResult):
        return ready
    return None


def _listed(home: Path, rid: str) -> bool:
    try:
        sources = load_sources(home)
    except (OSError, UnicodeError, ValueError):
        return False
    return any(parse_rid(str(source.get("url", ""))) == rid for source in sources)


def _work_ready(home: Path, rid: str) -> ForgeResult | None:
    """A listed repository or a delegated one, with the Radicle node running.

    Delegation still requires that this identity controls the RID. A source
    list entry is how a contributor works on a repository they do not control.
    An unreadable delegation file stops the command.
    """
    rows = load_delegated(home)
    if rows is None:
        return ForgeResult(False, "the delegation list is unreadable")
    delegated = any(provider == "radicle" and name == rid for provider, name in rows)
    if not delegated and not _listed(home, rid):
        return ForgeResult(False, "that repository is not delegated")
    if shutil.which("rad") is None:
        return ForgeResult(False, _NOT_INSTALLED)
    running = node_running()
    if not running.ok:
        return running
    found = identity()
    if isinstance(found, ForgeResult):
        return found
    if delegated:
        controlled = _controls(rid, found[1])
        if not controlled.ok:
            return controlled
    return None


def _cob_from(result: subprocess.CompletedProcess[str]) -> str:
    found = _COB.findall(_plain((result.stdout or "") + "\n" + (result.stderr or "")))
    if not found:
        return ""
    return found[-1]


def create_issue(home: Path, raw: str, title: str, body: str) -> ForgeResult:
    refused = _checked_text(title, body, require_title=True, require_body=True)
    if refused is not None:
        return refused
    rid = parse_rid(raw)
    if rid is None:
        return ForgeResult(False, "repository must look like rad:z…")
    blocked = _work_ready(home, rid)
    if blocked is not None:
        return blocked
    result = _run(
        ["issue", "open", "--repo", rid, "--title", title.strip(), "--description", body],
    )
    issue_id = _cob_from(result)
    if result.returncode != 0 or not issue_id:
        return ForgeResult(False, _failure("rad did not confirm that the issue was opened", result))
    return ForgeResult(True, f"opened issue {issue_id} on {rid}")


def update_issue(home: Path, raw: str, raw_id: str, title: str, body: str) -> ForgeResult:
    issue_id = parse_cob_id(raw_id)
    if issue_id is None:
        return ForgeResult(False, "the issue id is unreadable")
    if not title.strip() and not body.strip():
        return ForgeResult(False, "nothing to update")
    refused = _checked_text(title, body, require_title=False, require_body=False)
    if refused is not None:
        return refused
    rid = parse_rid(raw)
    if rid is None:
        return ForgeResult(False, "repository must look like rad:z…")
    blocked = _delegated_ready(home, rid)
    if blocked is not None:
        return blocked
    command = ["issue", "edit", issue_id, "--repo", rid]
    if title.strip():
        command.extend(["--title", title.strip()])
    if body.strip():
        command.extend(["--description", body])
    result = _run(command)
    if result.returncode != 0 or issue_id not in _plain((result.stdout or "") + (result.stderr or "")):
        return ForgeResult(False, _failure("rad did not confirm that the issue was updated", result))
    return ForgeResult(True, f"updated issue {issue_id} on {rid}")


def update_patch(home: Path, raw: str, raw_id: str, title: str, body: str) -> ForgeResult:
    patch_id = parse_cob_id(raw_id)
    if patch_id is None:
        return ForgeResult(False, "the patch id is unreadable")
    if not title.strip():
        return ForgeResult(False, "a patch update needs a title")
    refused = _checked_text(title, body, require_title=True, require_body=False)
    if refused is not None:
        return refused
    rid = parse_rid(raw)
    if rid is None:
        return ForgeResult(False, "repository must look like rad:z…")
    blocked = _delegated_ready(home, rid)
    if blocked is not None:
        return blocked
    command = ["patch", "edit", patch_id, "--repo", rid, "--message", title.strip()]
    if body.strip():
        command.extend(["--message", body])
    result = _run(command)
    if result.returncode != 0:
        return ForgeResult(False, _failure("rad did not confirm that the patch was updated", result))
    return ForgeResult(True, f"updated patch {patch_id} on {rid}")


def _checkout(raw: str) -> Path | ForgeResult:
    if not raw or "\n" in raw or "\x00" in raw or "\r" in raw:
        return ForgeResult(False, "the checkout is unreadable")
    path = Path(raw)
    if path.is_symlink():
        return ForgeResult(False, "the checkout is unreadable")
    try:
        resolved = path.resolve(strict=True)
    except OSError:
        return ForgeResult(False, "the checkout is unreadable")
    if not resolved.is_dir():
        return ForgeResult(False, "the checkout is unreadable")
    git_dir = resolved / ".git"
    if git_dir.is_symlink() or not git_dir.exists():
        return ForgeResult(False, "that checkout is not a git repository")
    return resolved


def _checkout_rid(path: Path) -> str | ForgeResult:
    result = _run(["."], cwd=path, timeout=15)
    if result.returncode != 0:
        return ForgeResult(False, "that checkout is not a Radicle repository")
    for line in _plain(result.stdout or "").splitlines():
        rid = parse_rid(line.strip())
        if rid:
            return rid
    return ForgeResult(False, "that checkout is not a Radicle repository")


def _git_push(checkout: Path, title: str, body: str) -> subprocess.CompletedProcess[str]:
    """Push a patch ref. The Radicle key stays in the environment, not in argv."""
    git = resolve_git()
    if git is None:
        return subprocess.CompletedProcess(["git"], 127, "", "git is not installed")
    command = [git, "push", "rad", "-o", f"patch.message={title}"]
    if body.strip():
        command.extend(["-o", f"patch.message={body}"])
    command.append("HEAD:refs/patches")
    env = os.environ.copy()
    rad_bin = shutil.which("rad")
    if rad_bin:
        bin_dir = str(Path(rad_bin).resolve().parent)
        env["PATH"] = bin_dir + os.pathsep + env.get("PATH", "")
    env["GIT_TERMINAL_PROMPT"] = "0"
    try:
        return subprocess.run(
            command,
            cwd=checkout,
            env=env,
            capture_output=True,
            text=True,
            timeout=120,
            check=False,
        )
    except subprocess.TimeoutExpired:
        return subprocess.CompletedProcess(command, 124, "", "git push timed out")
    except OSError:
        return subprocess.CompletedProcess(command, 127, "", "git is not installed")


_OPENED = re.compile(r"Patch ([0-9a-f]{40}) opened")


def open_patch(home: Path, raw: str, title: str, body: str, checkout: str) -> ForgeResult:
    refused = _checked_text(title, body, require_title=True, require_body=False)
    if refused is not None:
        return refused
    rid = parse_rid(raw)
    if rid is None:
        return ForgeResult(False, "repository must look like rad:z…")
    blocked = _work_ready(home, rid)
    if blocked is not None:
        return blocked
    path = _checkout(checkout)
    if isinstance(path, ForgeResult):
        return path
    reported = _checkout_rid(path)
    if isinstance(reported, ForgeResult):
        return reported
    if reported != rid:
        return ForgeResult(False, "that checkout is not this repository")
    result = _git_push(path, title.strip(), body)
    plain = _plain((result.stdout or "") + "\n" + (result.stderr or ""))
    match = _OPENED.search(plain)
    if result.returncode != 0 or match is None:
        return ForgeResult(False, _failure("rad did not confirm that the patch was opened", result))
    return ForgeResult(True, f"opened patch {match.group(1)} on {rid}")


def review_patch(home: Path, raw: str, raw_id: str, checkout: str) -> ForgeResult:
    """Run the sandbox check on a contributor patch, then accept or refuse it.

    The Radicle key is not passed into the sandbox. A sandbox that does not
    run does not accept the patch and does not refuse it.
    """
    patch_id = parse_cob_id(raw_id)
    if patch_id is None:
        return ForgeResult(False, "the patch id is unreadable")
    rid = parse_rid(raw)
    if rid is None:
        return ForgeResult(False, "repository must look like rad:z…")
    blocked = _delegated_ready(home, rid)
    if blocked is not None:
        return blocked
    path = _checkout(checkout)
    if isinstance(path, ForgeResult):
        return path
    reported = _checkout_rid(path)
    if isinstance(reported, ForgeResult):
        return reported
    if reported != rid:
        return ForgeResult(False, "that checkout is not this repository")
    # Heartwood 1.10 rejects `rad patch checkout --repo` even inside a working
    # copy. The RID was already confirmed with `rad .` in this directory.
    checked_out = _run(["patch", "checkout", patch_id, "--force"], cwd=path, timeout=60)
    if checked_out.returncode != 0:
        return ForgeResult(False, _failure("rad did not check out the patch", checked_out))
    try:
        config = load_config(home)
    except (OSError, UnicodeError, ValueError):
        return ForgeResult(False, "config is unreadable")
    sandbox_cfg = config.get("sandbox") if isinstance(config.get("sandbox"), dict) else {}
    runtime = detect_runtime(str(sandbox_cfg.get("runtime", "auto")))
    if runtime is None:
        return ForgeResult(False, "the sandbox did not run the check")
    outcome = run_sandbox(
        path,
        action_command("test", runtime),
        runtime=runtime,
        image=str(sandbox_cfg.get("image", "python:3.12-slim")),
        memory=str(sandbox_cfg.get("memory", "512m")),
        cpus=str(sandbox_cfg.get("cpus", "1")),
        timeout=180,
    )
    if not outcome.invoked:
        return ForgeResult(False, "the sandbox did not run the check")
    verdict = "accept" if outcome.ok else "reject"
    message = "sandbox check passed" if outcome.ok else "sandbox check failed"
    reviewed = _run(
        ["patch", "review", patch_id, "--repo", rid, f"--{verdict}", "--message", message],
        cwd=path,
        timeout=60,
    )
    if reviewed.returncode != 0:
        return ForgeResult(False, _failure("rad did not confirm the review", reviewed))
    if verdict == "accept":
        return ForgeResult(True, f"accepted patch {patch_id} on {rid}")
    return ForgeResult(True, f"refused patch {patch_id} on {rid}")


def _draft(home: Path, rid: str, filename: str) -> tuple[str, str] | None:
    root = home / "drafts"
    if root.is_symlink() or not root.is_dir():
        return None
    slug = hashlib.sha256(rid.encode()).hexdigest()[:16]
    path = root / slug / filename
    if not path.is_file() or path.is_symlink():
        return None
    try:
        if path.stat().st_size > 65_000:
            return None
        text = path.read_text(encoding="utf-8")
    except (OSError, UnicodeError):
        return None
    lines = text.splitlines()
    if not lines or not lines[0].strip():
        return None
    title = lines[0][2:].strip() if lines[0].startswith("# ") else lines[0].strip()
    body_lines = lines[1:]
    if body_lines and not body_lines[0].strip():
        body_lines = body_lines[1:]
    body = "\n".join(body_lines).strip()
    if not title:
        return None
    return title, body


def send_issue_draft(home: Path, raw: str) -> ForgeResult:
    rid = parse_rid(raw)
    if rid is None:
        return ForgeResult(False, "repository must look like rad:z…")
    found = _draft(home, rid, "issue-draft.md")
    if found is None:
        return ForgeResult(False, "there is no local issue draft for that repository")
    title, body = found
    if not body:
        return ForgeResult(False, "the draft has no body")
    return create_issue(home, rid, title, body)


def send_patch_draft(home: Path, raw: str, raw_id: str) -> ForgeResult:
    rid = parse_rid(raw)
    if rid is None:
        return ForgeResult(False, "repository must look like rad:z…")
    found = _draft(home, rid, "pr-draft.md")
    if found is None:
        return ForgeResult(False, "there is no local patch draft for that repository")
    title, body = found
    return update_patch(home, rid, raw_id, title, body)
