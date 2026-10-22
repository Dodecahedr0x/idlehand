"""Optional GitHub interop.

IdleHand's repository management is Radicle, through the local `rad` CLI.
This module is the extra GitHub path: `gh` already logged in on the machine,
explicit delegation of `owner/name`, and issues and pull requests. It does not
store a token and does not run an OAuth broker.

A further forge would implement `Forge` and add its name in `registered_forges`.
Radicle is not that forge. It is the primary path, and it delegates by RID.
"""

from __future__ import annotations

import hashlib
import re
from dataclasses import dataclass
from pathlib import Path
from typing import Protocol
from urllib.parse import urlsplit

from idlehand.config import load_sources
from idlehand.fetch import contains_control_break, embeds_credentials
from idlehand.home import atomic_write, dump_toml, home_lock, read_toml

_PART = re.compile(r"[A-Za-z0-9_][A-Za-z0-9_.-]{0,99}")
_PROVIDER = re.compile(r"[a-z][a-z0-9-]{0,20}")
_BASE58 = r"[1-9A-HJ-NP-Za-km-z]"
_RID = re.compile(rf"rad:z{_BASE58}{{20,40}}")
_PRIVATE_KEY = (
    "BEGIN PRIVATE KEY",
    "BEGIN RSA PRIVATE KEY",
    "BEGIN OPENSSH PRIVATE KEY",
    "BEGIN EC PRIVATE KEY",
    "BEGIN DSA PRIVATE KEY",
)

DELEGATED_HEADER = """# Repos this node may manage. IdleHand adds one only when you delegate it.
# A Radicle row is a RID. A GitHub row is owner/name.
# rad keys and gh credentials are not written here.
"""


@dataclass(frozen=True)
class ForgeAccount:
    connected: bool
    detail: str
    login: str


@dataclass(frozen=True)
class ManageableRepo:
    name: str
    role: str


@dataclass(frozen=True)
class ForgeResult:
    ok: bool
    detail: str


class Forge(Protocol):
    name: str

    def account(self) -> ForgeAccount:
        """Whether the forge CLI is installed and already logged in."""

    def manageable_repos(self, login: str) -> tuple[list[ManageableRepo] | None, str]:
        """Repos this login owns or administers. None means the list is not real."""

    def create_issue(self, repo: str, title: str, body: str) -> ForgeResult:
        """Create an issue. ok is true only when the forge confirms it."""

    def update_issue(self, repo: str, number: int, title: str, body: str) -> ForgeResult:
        """Update an issue. An empty title or body is left unchanged."""

    def create_pull_request(
        self,
        repo: str,
        title: str,
        body: str,
        head: str,
        base: str,
    ) -> ForgeResult:
        """Open a pull request for a branch already on the forge. This does not push."""

    def update_pull_request(self, repo: str, number: int, title: str, body: str) -> ForgeResult:
        """Update a pull request. An empty title or body is left unchanged."""


def registered_forges() -> tuple[str, ...]:
    return ("github",)


def forge_for(name: str) -> Forge | None:
    if name == "github":
        from idlehand.github import GitHub

        return GitHub()
    return None


def provider_label(name: str) -> str:
    if _PROVIDER.fullmatch(name):
        return name
    return ""


def parse_rid(value: str) -> str | None:
    """A Radicle repository id, `rad:z…`. Nothing else."""
    text = value.strip()
    if not text or contains_control_break(text) or embeds_credentials(text):
        return None
    if _RID.fullmatch(text) is None:
        return None
    return text


def canonical_repo(provider: str, repo: str) -> str | None:
    """The stored form of a delegated repo, or None when this provider cannot name it."""
    if provider == "github":
        return parse_repo_name(repo)
    if provider == "radicle":
        return parse_rid(repo)
    return None


def parse_repo_name(value: str) -> str | None:
    """An owner/name, or a github.com URL that names one. Nothing else."""
    text = value.strip()
    if not text or contains_control_break(text) or embeds_credentials(text):
        return None
    if "://" in text or text.startswith("git@"):
        if text.startswith("git@"):
            return None
        parsed = urlsplit(text)
        if parsed.scheme not in {"https", "http"}:
            return None
        if (parsed.hostname or "").lower() != "github.com":
            return None
        parts = [part for part in parsed.path.split("/") if part]
        if len(parts) < 2:
            return None
        owner, name = parts[0], parts[1]
        if name.endswith(".git"):
            name = name[:-4]
        text = f"{owner}/{name}"
    if text.count("/") != 1:
        return None
    owner, name = text.split("/", 1)
    if not _PART.fullmatch(owner) or not _PART.fullmatch(name):
        return None
    if ".." in owner or ".." in name:
        return None
    return f"{owner}/{name}"


def parse_number(value: str) -> int | None:
    if not re.fullmatch(r"[1-9][0-9]{0,9}", value):
        return None
    return int(value)


def parse_ref(value: str) -> str | None:
    text = value.strip()
    if not text or contains_control_break(text) or ".." in text or text.startswith("-"):
        return None
    if not re.fullmatch(r"[A-Za-z0-9_][A-Za-z0-9_.-]{0,99}(?::[A-Za-z0-9_][A-Za-z0-9_./-]{0,150})?", text):
        return None
    return text


def delegated_path(home: Path) -> Path:
    return home / "delegated.toml"


def load_delegated(home: Path) -> list[tuple[str, str]] | None:
    """Delegated (provider, repo) rows. None means the file cannot be trusted."""
    path = delegated_path(home)
    if path.is_symlink():
        return None
    if not path.exists():
        return []
    try:
        data = read_toml(path)
    except (OSError, UnicodeError, ValueError):
        return None
    rows = data.get("repos", [])
    if rows is None:
        return []
    if not isinstance(rows, list):
        return None
    cleaned: list[tuple[str, str]] = []
    for row in rows:
        if not isinstance(row, dict):
            return None
        provider = row.get("provider")
        repo = row.get("repo")
        if not isinstance(provider, str) or not isinstance(repo, str):
            return None
        name = canonical_repo(provider, repo)
        if name is None:
            return None
        cleaned.append((provider, name))
    return cleaned


def save_delegated(home: Path, rows: list[tuple[str, str]]) -> bool:
    path = delegated_path(home)
    if path.is_symlink():
        return False
    payload = {"repos": [{"provider": provider, "repo": repo} for provider, repo in rows]}
    with home_lock(home):
        if path.is_symlink():
            return False
        atomic_write(path, dump_toml(payload, DELEGATED_HEADER))
    return True


def _known(rows: list[tuple[str, str]], provider: str, repo: str) -> str | None:
    for item_provider, name in rows:
        if item_provider != provider:
            continue
        if provider == "github" and name.lower() == repo.lower():
            return name
        if provider != "github" and name == repo:
            return name
    return None


def delegation_status(provider: str) -> ForgeAccount:
    forge = forge_for(provider)
    if forge is None:
        label = provider_label(provider)
        suffix = f" named {label}" if label else ""
        return ForgeAccount(False, f"IdleHand has no forge provider{suffix}", "")
    return forge.account()


def list_manageable(provider: str) -> tuple[list[ManageableRepo] | None, str]:
    forge = forge_for(provider)
    if forge is None:
        account = delegation_status(provider)
        return None, account.detail
    account = forge.account()
    if not account.connected:
        return None, account.detail
    return forge.manageable_repos(account.login)


def delegate_repo(home: Path, provider: str, raw_repo: str) -> ForgeResult:
    forge = forge_for(provider)
    if forge is None:
        return ForgeResult(False, delegation_status(provider).detail)
    repo = parse_repo_name(raw_repo)
    if repo is None:
        return ForgeResult(False, "repository must look like owner/name")
    rows = load_delegated(home)
    if rows is None:
        return ForgeResult(False, "the delegation list is unreadable")
    existing = _known(rows, provider, repo)
    if existing is not None:
        return ForgeResult(True, f"{existing} is already delegated")
    account = forge.account()
    if not account.connected:
        return ForgeResult(False, account.detail)
    found, detail = forge.manageable_repos(account.login)
    if found is None:
        return ForgeResult(False, detail)
    match = next((item for item in found if item.name.lower() == repo.lower()), None)
    if match is None:
        return ForgeResult(False, "that repository is not owned or administered by the gh login")
    rows.append((provider, match.name))
    if not save_delegated(home, rows):
        return ForgeResult(False, "the delegation list is unreadable")
    return ForgeResult(True, f"delegated {match.name}")


def revoke_repo(home: Path, provider: str, raw_repo: str) -> ForgeResult:
    if forge_for(provider) is None:
        return ForgeResult(False, delegation_status(provider).detail)
    repo = parse_repo_name(raw_repo)
    if repo is None:
        return ForgeResult(False, "repository must look like owner/name")
    rows = load_delegated(home)
    if rows is None:
        return ForgeResult(False, "the delegation list is unreadable")
    existing = _known(rows, provider, repo)
    if existing is None:
        return ForgeResult(False, "that repository is not delegated")
    kept = [(item_provider, name) for item_provider, name in rows if not (item_provider == provider and name == existing)]
    if not save_delegated(home, kept):
        return ForgeResult(False, "the delegation list is unreadable")
    return ForgeResult(True, f"revoked {existing}")


def _delegated_name(home: Path, provider: str, raw_repo: str) -> tuple[Forge, str] | ForgeResult:
    forge = forge_for(provider)
    if forge is None:
        return ForgeResult(False, delegation_status(provider).detail)
    repo = parse_repo_name(raw_repo)
    if repo is None:
        return ForgeResult(False, "repository must look like owner/name")
    rows = load_delegated(home)
    if rows is None:
        return ForgeResult(False, "the delegation list is unreadable")
    existing = _known(rows, provider, repo)
    if existing is None:
        return ForgeResult(False, "that repository is not delegated")
    account = forge.account()
    if not account.connected:
        return ForgeResult(False, account.detail)
    found, detail = forge.manageable_repos(account.login)
    if found is None:
        return ForgeResult(False, detail)
    match = next((item for item in found if item.name.lower() == existing.lower()), None)
    if match is None:
        return ForgeResult(False, "that repository is not owned or administered by the gh login")
    return forge, match.name


def _checked_text(title: str, body: str, *, require_title: bool, require_body: bool) -> ForgeResult | None:
    if any(marker in title or marker in body for marker in _PRIVATE_KEY):
        return ForgeResult(False, "the draft contains private key material")
    if "\x00" in title or "\x00" in body or "\r" in title or "\r" in body or "\n" in title:
        return ForgeResult(False, "the title or body is unreadable")
    if require_title and not title.strip():
        return ForgeResult(False, "the title is empty")
    if len(title) > 256:
        return ForgeResult(False, "the title is too long")
    if require_body and not body.strip():
        return ForgeResult(False, "the body is empty")
    if len(body.encode("utf-8")) > 65_000:
        return ForgeResult(False, "the body is too long")
    return None


def create_issue(home: Path, provider: str, raw_repo: str, title: str, body: str) -> ForgeResult:
    refused = _checked_text(title, body, require_title=True, require_body=True)
    if refused is not None:
        return refused
    ready = _delegated_name(home, provider, raw_repo)
    if isinstance(ready, ForgeResult):
        return ready
    forge, repo = ready
    return forge.create_issue(repo, title.strip(), body)


def update_issue(
    home: Path,
    provider: str,
    raw_repo: str,
    number: int,
    title: str,
    body: str,
) -> ForgeResult:
    if number < 1:
        return ForgeResult(False, "the issue number is unreadable")
    if not title.strip() and not body.strip():
        return ForgeResult(False, "nothing to update")
    refused = _checked_text(title, body, require_title=False, require_body=False)
    if refused is not None:
        return refused
    ready = _delegated_name(home, provider, raw_repo)
    if isinstance(ready, ForgeResult):
        return ready
    forge, repo = ready
    return forge.update_issue(repo, number, title.strip(), body)


def create_pull_request(
    home: Path,
    provider: str,
    raw_repo: str,
    title: str,
    body: str,
    head: str,
    base: str,
) -> ForgeResult:
    checked_head = parse_ref(head)
    checked_base = parse_ref(base) if base else ""
    if checked_head is None or (base and checked_base is None):
        return ForgeResult(False, "the branch name is unreadable")
    refused = _checked_text(title, body, require_title=True, require_body=True)
    if refused is not None:
        return refused
    ready = _delegated_name(home, provider, raw_repo)
    if isinstance(ready, ForgeResult):
        return ready
    forge, repo = ready
    return forge.create_pull_request(repo, title.strip(), body, checked_head, checked_base or "")


def update_pull_request(
    home: Path,
    provider: str,
    raw_repo: str,
    number: int,
    title: str,
    body: str,
) -> ForgeResult:
    if number < 1:
        return ForgeResult(False, "the pull request number is unreadable")
    if not title.strip() and not body.strip():
        return ForgeResult(False, "nothing to update")
    refused = _checked_text(title, body, require_title=False, require_body=False)
    if refused is not None:
        return refused
    ready = _delegated_name(home, provider, raw_repo)
    if isinstance(ready, ForgeResult):
        return ready
    forge, repo = ready
    return forge.update_pull_request(repo, number, title.strip(), body)


def _draft_urls(home: Path, repo: str) -> list[str]:
    owner, name = repo.split("/", 1)
    urls = [
        f"https://github.com/{owner}/{name}",
        f"https://github.com/{owner}/{name}.git",
        f"https://github.com/{owner}/{name}/",
        f"http://github.com/{owner}/{name}",
        f"http://github.com/{owner}/{name}.git",
    ]
    try:
        sources = load_sources(home)
    except (OSError, UnicodeError, ValueError):
        sources = []
    for source in sources:
        url = source.get("url", "")
        parsed = parse_repo_name(url)
        if parsed is not None and parsed.lower() == repo.lower():
            urls.append(url)
    return urls


def _read_draft(path: Path) -> str | None:
    if not path.is_file() or path.is_symlink():
        return None
    try:
        if path.stat().st_size > 65_000:
            return None
        return path.read_text(encoding="utf-8")
    except (OSError, UnicodeError):
        return None


def find_draft(home: Path, repo: str, filename: str) -> tuple[str, str] | None:
    root = home / "drafts"
    if root.is_symlink() or not root.is_dir():
        return None
    for url in _draft_urls(home, repo):
        slug = hashlib.sha256(url.encode()).hexdigest()[:16]
        path = root / slug / filename
        text = _read_draft(path)
        if text is None:
            continue
        lines = text.splitlines()
        if not lines or not lines[0].strip():
            continue
        title = lines[0][2:].strip() if lines[0].startswith("# ") else lines[0].strip()
        body_lines = lines[1:]
        if body_lines and not body_lines[0].strip():
            body_lines = body_lines[1:]
        body = "\n".join(body_lines).strip()
        if title:
            return title, body
    return None


def send_issue_draft(home: Path, provider: str, raw_repo: str) -> ForgeResult:
    repo = parse_repo_name(raw_repo)
    if repo is None:
        return ForgeResult(False, "repository must look like owner/name")
    found = find_draft(home, repo, "issue-draft.md")
    if found is None:
        return ForgeResult(False, "there is no local issue draft for that repository")
    title, body = found
    if not body:
        return ForgeResult(False, "the draft has no body")
    return create_issue(home, provider, repo, title, body)


def send_pull_request_draft(home: Path, provider: str, raw_repo: str, head: str, base: str) -> ForgeResult:
    repo = parse_repo_name(raw_repo)
    if repo is None:
        return ForgeResult(False, "repository must look like owner/name")
    found = find_draft(home, repo, "pr-draft.md")
    if found is None:
        return ForgeResult(False, "there is no local pull request draft for that repository")
    title, body = found
    if not body:
        return ForgeResult(False, "the draft has no body")
    return create_pull_request(home, provider, repo, title, body, head, base)
