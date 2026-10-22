"""Clone a repository into a workspace without the user's credentials.

The clone runs on the trusted side because it needs the network. The sandbox
stays offline. Public http(s) URLs are cloned with a throwaway home and no
credential helper. A local path or file URL is cloned only when the source
list already names it. SSH and embedded passwords are refused.
"""

from __future__ import annotations

import os
import shutil
import subprocess
import tempfile
import urllib.parse
from dataclasses import dataclass
from pathlib import Path


@dataclass(frozen=True)
class FetchResult:
    cloned: bool
    reason: str

    def as_dict(self) -> dict[str, object]:
        return {"cloned": self.cloned, "reason": self.reason}


CREDENTIAL_QUERY_KEYS = frozenset({"token", "password", "access_token", "auth"})


def _has_credential_key(text: str) -> bool:
    keys = {key.lower() for key, _value in urllib.parse.parse_qsl(text, keep_blank_values=True)}
    return bool(keys & CREDENTIAL_QUERY_KEYS)


def _without_credential_keys(text: str) -> str:
    pairs = urllib.parse.parse_qsl(text, keep_blank_values=True)
    kept = [(key, value) for key, value in pairs if key.lower() not in CREDENTIAL_QUERY_KEYS]
    return urllib.parse.urlencode(kept)


def embeds_credentials(url: str) -> bool:
    """True when a URL carries userinfo or a credential query or fragment key."""
    parsed = urllib.parse.urlsplit(url.strip())
    if parsed.username or parsed.password:
        return True
    return _has_credential_key(parsed.query) or _has_credential_key(parsed.fragment)


def redact_clone_url(url: str) -> str:
    """Drop userinfo and credential query keys before a URL is written down."""
    parsed = urllib.parse.urlsplit(url.strip())
    host = parsed.hostname or ""
    if parsed.port:
        host = f"{host}:{parsed.port}"
    if parsed.username or parsed.password:
        parsed = parsed._replace(netloc=host)
    if _has_credential_key(parsed.query):
        parsed = parsed._replace(query=_without_credential_keys(parsed.query))
    if _has_credential_key(parsed.fragment):
        parsed = parsed._replace(fragment=_without_credential_keys(parsed.fragment))
    return urllib.parse.urlunsplit(parsed)


def classify_clone_url(url: str) -> tuple[str | None, str]:
    """Return the URL git may clone, and the reason it is or is not allowed."""
    raw = url.strip()
    if not raw or any(character in raw for character in "\r\n\x00"):
        return None, "repository URL is empty"
    if raw.startswith("git@") or raw.startswith("ssh://"):
        return None, "public clones do not use SSH keys"
    parsed = urllib.parse.urlparse(raw)
    if embeds_credentials(raw):
        return None, "repository URL embeds credentials"
    scheme = parsed.scheme.lower()
    if scheme in {"ssh", "git"}:
        return None, "public clones do not use SSH keys"
    if scheme in {"https", "http"}:
        parts = [part for part in parsed.path.split("/") if part]
        if not parsed.hostname or len(parts) < 2:
            return None, "repository URL is not a git repository URL"
        return raw, "public clone"
    if scheme == "file" or (scheme == "" and raw.startswith("/")):
        return raw, "local repository from the source list"
    return None, "repository URL is not a public git URL"


def resolve_git() -> str | None:
    system = Path("/usr/bin/git")
    if system.is_file() and os.access(system, os.X_OK):
        return str(system)
    found = shutil.which("git")
    return found or None


def git_env(empty_home: Path) -> dict[str, str]:
    """Environment for git. Nothing from the user's environment is copied."""
    return {
        "PATH": "/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin",
        "HOME": str(empty_home),
        "TMPDIR": "/tmp",
        "GIT_CONFIG_GLOBAL": "/dev/null",
        "GIT_CONFIG_NOSYSTEM": "1",
        "GIT_TERMINAL_PROMPT": "0",
        "GIT_ASKPASS": "true",
        "SSH_AUTH_SOCK": "",
        "GIT_SSH_COMMAND": "false",
        "LANG": "C",
    }


def _clear_workspace(workspace: Path) -> str | None:
    if workspace.is_symlink() or workspace.parent.is_symlink():
        return "refusing to follow a workspace symlink"
    root = workspace.parent.resolve()
    if workspace.exists():
        resolved = workspace.resolve()
        if not resolved.is_relative_to(root):
            return "refusing to replace a workspace outside its parent"
        shutil.rmtree(resolved)
    return None


def _remove_failed_clone(workspace: Path) -> None:
    root = workspace.parent.resolve()
    if workspace.is_symlink():
        return
    if workspace.exists():
        resolved = workspace.resolve()
        if resolved.is_relative_to(root):
            shutil.rmtree(resolved, ignore_errors=True)


def clone_repository(
    url: str,
    workspace: Path,
    *,
    git_executable: str | None = None,
    timeout: float = 30,
) -> FetchResult:
    allowed, reason = classify_clone_url(url)
    if allowed is None:
        return FetchResult(False, reason)
    git = git_executable or resolve_git()
    if not git:
        return FetchResult(False, "git is not installed")
    blocked = _clear_workspace(workspace)
    if blocked:
        return FetchResult(False, blocked)
    workspace.parent.mkdir(parents=True, exist_ok=True)
    scheme = urllib.parse.urlparse(allowed).scheme.lower()
    command = [git, "-c", "credential.helper=", "-c", "core.askPass="]
    if scheme in {"file", ""}:
        command.extend(["-c", "protocol.file.allow=always"])
    command.extend(["clone", "--depth", "1", "--no-tags", "--", allowed, str(workspace)])
    empty_home = Path(tempfile.mkdtemp(prefix="fossah-fetch-"))
    try:
        try:
            completed = subprocess.run(
                command,
                env=git_env(empty_home),
                cwd=empty_home,
                capture_output=True,
                text=True,
                timeout=timeout,
                check=False,
            )
        except subprocess.TimeoutExpired:
            _remove_failed_clone(workspace)
            return FetchResult(False, "clone timed out")
        except OSError as exc:
            _remove_failed_clone(workspace)
            return FetchResult(False, f"could not run git: {exc}")
    finally:
        shutil.rmtree(empty_home, ignore_errors=True)
    if completed.returncode != 0 or not (workspace / ".git").exists():
        detail = (completed.stderr or completed.stdout or "git clone failed").strip().splitlines()
        summary = detail[-1][:200] if detail else "git clone failed"
        _remove_failed_clone(workspace)
        return FetchResult(False, summary)
    return FetchResult(True, reason)
