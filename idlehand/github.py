"""GitHub through the `gh` login already on this machine.

IdleHand does not store a token and does not start an OAuth flow. `gh` runs
on the trusted side, outside the sandbox, with the user's environment so it
can see that login. Command output is not written into the publish feed.
"""

from __future__ import annotations

import json
import os
import re
import shutil
import subprocess
import tempfile
from pathlib import Path

from idlehand.fetch import scrub_secrets
from idlehand.forge import ForgeAccount, ForgeResult, ManageableRepo, parse_repo_name

_LOGIN = re.compile(r"[A-Za-z0-9](?:[A-Za-z0-9-]{0,37}[A-Za-z0-9])?")
_GH_TOKEN = re.compile(r"(?:gho_|github_pat_|ghp_|ghu_|ghs_|ghr_)[A-Za-z0-9_]+")
_CONFIRMED = re.compile(
    r"https://github\.com/[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+/(?:issues|pull)/[1-9][0-9]*"
)
_LIST_CAP = 200
_REPOS_PATH = "user/repos?per_page=100&affiliation=owner,organization_member"
_REPOS_JQ = ".[] | {full_name:.full_name,owner:.owner.login,admin:.permissions.admin}"


def _show(text: str, limit: int = 300) -> str:
    cleaned = _GH_TOKEN.sub("github-token-omitted", scrub_secrets(text))
    lines = [line.strip() for line in cleaned.splitlines() if line.strip()]
    if not lines:
        return ""
    return lines[0][:limit]


def _confirmed_url(text: str) -> str:
    cleaned = _GH_TOKEN.sub("github-token-omitted", scrub_secrets(text))
    found = list(_CONFIRMED.finditer(cleaned))
    if not found:
        return ""
    return found[-1].group(0)


class GitHub:
    name = "github"

    def account(self) -> ForgeAccount:
        if shutil.which("gh") is None:
            return ForgeAccount(False, "gh is not installed", "")
        result = _run(["api", "user", "--jq", ".login"])
        if result.returncode != 0:
            return ForgeAccount(False, "gh is not logged in", "")
        login = (result.stdout or "").strip()
        if "\n" in login or _LOGIN.fullmatch(login) is None:
            return ForgeAccount(False, "gh is not logged in", "")
        return ForgeAccount(True, f"gh is logged in as {login}", login)

    def manageable_repos(self, login: str) -> tuple[list[ManageableRepo] | None, str]:
        result = _run(["api", "--paginate", _REPOS_PATH, "--jq", _REPOS_JQ])
        if result.returncode != 0:
            return None, "gh could not list repositories"
        if len(result.stdout or "") > 1_000_000:
            return None, "gh could not list repositories"
        records = _records(result.stdout or "")
        if records is None:
            return None, "gh could not list repositories"
        note = ""
        if len(records) > _LIST_CAP:
            records = records[:_LIST_CAP]
            note = "stopped after 200 repositories"
        repos: list[ManageableRepo] = []
        seen: set[str] = set()
        for item in records:
            full = item.get("full_name")
            owner = item.get("owner")
            if not isinstance(full, str) or not isinstance(owner, str):
                continue
            full = parse_repo_name(full) or ""
            if not full:
                continue
            if full.lower() in seen:
                continue
            role = ""
            if owner.lower() == login.lower():
                role = "owner"
            elif item.get("admin") is True:
                role = "admin"
            if not role:
                continue
            seen.add(full.lower())
            repos.append(ManageableRepo(full, role))
        return repos, note

    def create_issue(self, repo: str, title: str, body: str) -> ForgeResult:
        result = _run(
            ["issue", "create", "--repo", repo, "--title", title],
            body=body,
        )
        url = _confirmed_url(result.stdout or "")
        if result.returncode != 0 or not url:
            return ForgeResult(False, _failure("gh did not confirm that the issue was created", result))
        return ForgeResult(True, f"created issue on {repo}: {url}")

    def update_issue(self, repo: str, number: int, title: str, body: str) -> ForgeResult:
        args = ["issue", "edit", str(number), "--repo", repo]
        if title:
            args.extend(["--title", title])
        result = _run(args, body=body or None)
        if result.returncode != 0:
            return ForgeResult(False, _failure("gh did not confirm that the issue was updated", result))
        url = _confirmed_url(result.stdout or "")
        suffix = f": {url}" if url else ""
        return ForgeResult(True, f"updated issue {number} on {repo}{suffix}")

    def create_pull_request(
        self,
        repo: str,
        title: str,
        body: str,
        head: str,
        base: str,
    ) -> ForgeResult:
        args = ["pr", "create", "--repo", repo, "--title", title, "--head", head]
        if base:
            args.extend(["--base", base])
        result = _run(args, body=body)
        url = _confirmed_url(result.stdout or "")
        if result.returncode != 0 or not url:
            return ForgeResult(False, _failure("gh did not confirm that the pull request was created", result))
        return ForgeResult(True, f"created pull request on {repo}: {url}")

    def update_pull_request(self, repo: str, number: int, title: str, body: str) -> ForgeResult:
        args = ["pr", "edit", str(number), "--repo", repo]
        if title:
            args.extend(["--title", title])
        result = _run(args, body=body or None)
        if result.returncode != 0:
            return ForgeResult(False, _failure("gh did not confirm that the pull request was updated", result))
        url = _confirmed_url(result.stdout or "")
        suffix = f": {url}" if url else ""
        return ForgeResult(True, f"updated pull request {number} on {repo}{suffix}")


def _failure(fallback: str, result: subprocess.CompletedProcess[str]) -> str:
    detail = _show(result.stderr or result.stdout or "")
    if not detail or detail == "github-token-omitted":
        return fallback
    return f"{fallback}: {detail}"


def _records(text: str) -> list[dict[str, object]] | None:
    raw = text.strip()
    if not raw:
        return []
    parsed: object | None
    try:
        parsed = json.loads(raw)
    except json.JSONDecodeError:
        parsed = None
    if isinstance(parsed, list):
        return [item for item in parsed if isinstance(item, dict)]
    if isinstance(parsed, dict):
        return [parsed]
    records: list[dict[str, object]] = []
    for line in raw.splitlines():
        piece = line.strip()
        if not piece:
            continue
        try:
            item = json.loads(piece)
        except json.JSONDecodeError:
            return None
        if isinstance(item, dict):
            records.append(item)
        elif isinstance(item, list):
            if not all(isinstance(entry, dict) for entry in item):
                return None
            records.extend(item)
        else:
            return None
    return records


def _run(args: list[str], body: str | None = None) -> subprocess.CompletedProcess[str]:
    binary = shutil.which("gh")
    if binary is None:
        return subprocess.CompletedProcess(args, 127, "", "gh is not installed")
    cwd = Path(tempfile.mkdtemp(prefix="idlehand-gh-"))
    command = [binary, *args]
    if body is not None:
        (cwd / "body.md").write_text(body, encoding="utf-8")
        command.extend(["--body-file", str(cwd / "body.md")])
    try:
        try:
            return subprocess.run(
                command,
                cwd=cwd,
                env=os.environ.copy(),
                capture_output=True,
                text=True,
                timeout=30,
                check=False,
            )
        except subprocess.TimeoutExpired:
            return subprocess.CompletedProcess(command, 124, "", "gh timed out")
        except OSError:
            return subprocess.CompletedProcess(command, 127, "", "gh is not installed")
    finally:
        shutil.rmtree(cwd, ignore_errors=True)
