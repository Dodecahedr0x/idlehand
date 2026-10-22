"""Fossah links add repositories to the local source list.

A link either carries repo URLs or names a list file the publisher hosts.
The fetch goes to that publisher URL. There is no Fossah directory.
"""

from __future__ import annotations

import json
import urllib.error
import urllib.parse
import urllib.request
from dataclasses import dataclass, field
from pathlib import Path

from fossah import __version__
from fossah.config import load_sources, save_sources
from fossah.fetch import embeds_credentials, redact_clone_url
from fossah.home import home_lock
from fossah.trust import decision, remember

MAX_LIST_BYTES = 1_000_000
USER_AGENT = f"fossah/{__version__}"
CATALOG_PARAMS = ("catalog", "directory", "registry")


class LinkError(ValueError):
    pass


@dataclass
class ParsedLink:
    repos: list[str] = field(default_factory=list)
    list_url: str = ""


def parse_fossah_link(url: str) -> ParsedLink:
    raw = url.strip()
    if not raw.lower().startswith("fossah:"):
        raise LinkError("not a Fossah link")
    parsed = urllib.parse.urlparse(raw)
    if parsed.scheme.lower() != "fossah":
        raise LinkError("not a Fossah link")
    query = urllib.parse.parse_qs(parsed.query, keep_blank_values=False)
    for blocked in CATALOG_PARAMS:
        if blocked in query:
            raise LinkError("Fossah does not resolve links through a catalog")
    action = (parsed.netloc or parsed.path.lstrip("/")).split("/")[0]
    if action not in {"", "add"}:
        raise LinkError(f"unsupported Fossah link action: {action}")
    repos: list[str] = []
    for value in query.get("repo", []):
        repos.extend(_split_repo_field(value))
    for value in query.get("repos", []):
        repos.extend(_split_repo_field(value))
    lists = query.get("list", [])
    if len(lists) > 1:
        raise LinkError("a Fossah link can name only one list file")
    list_url = lists[0].strip() if lists else ""
    if list_url:
        _validate_list_url(list_url)
    if not repos and not list_url:
        raise LinkError("the link has no repos and no list file")
    return ParsedLink(repos=repos, list_url=list_url)


def _split_repo_field(value: str) -> list[str]:
    return [part.strip() for part in value.split(",") if part.strip()]


def judge_repo_url(url: str) -> tuple[bool, str, str]:
    """Accept or refuse one repository URL from a Fossah link."""
    try:
        cleaned = _validate_repo_url(url)
    except LinkError as exc:
        return False, url.strip(), str(exc)
    scheme = urllib.parse.urlparse(cleaned).scheme
    return True, cleaned, f"{scheme} git repository URL"


def judge_list_text(text: str) -> list[tuple[bool, str, str]]:
    """Judge each repo in a publisher list. One bad line does not reject the rest."""
    stripped = text.strip()
    if not stripped:
        return []
    if stripped.startswith("{") or stripped.startswith("["):
        try:
            payload = json.loads(stripped)
        except json.JSONDecodeError as exc:
            raise LinkError(f"list file is not valid JSON: {exc}") from exc
        if isinstance(payload, dict):
            values = payload.get("repos", [])
        elif isinstance(payload, list):
            values = payload
        else:
            raise LinkError("list file JSON must be a list or an object with repos")
        if not isinstance(values, list):
            raise LinkError("list file JSON must be a list or an object with repos")
        judged: list[tuple[bool, str, str]] = []
        for item in values:
            if isinstance(item, str):
                judged.append(judge_repo_url(item))
            elif isinstance(item, dict) and isinstance(item.get("url"), str):
                judged.append(judge_repo_url(item["url"]))
            else:
                judged.append((False, "", "each repo in the list file needs a URL"))
        return judged
    judged = []
    for line in text.splitlines():
        line = line.strip()
        if not line or line.startswith("#"):
            continue
        judged.append(judge_repo_url(line))
    return judged


def _shown_url(url: str) -> str:
    """A URL that may appear in a refusal. Omit lines that are not a URL."""
    shown = redact_clone_url(url.strip())
    if (
        not shown
        or "PRIVATE KEY" in shown
        or any(character in shown for character in "\r\n\t ")
        or len(shown) > 200
        or "://" not in shown
    ):
        return ""
    return shown


def _with_url(problem: str, url: str) -> str:
    shown = _shown_url(url)
    if not shown:
        return problem
    return f"{problem}: {shown}"


def _control_characters(url: str) -> bool:
    return any(character in url for character in "\r\n\x00")


def _validate_repo_url(url: str) -> str:
    cleaned = url.strip()
    if _control_characters(cleaned):
        raise LinkError("repository URL must be http or https")
    if embeds_credentials(cleaned):
        raise LinkError("repository URLs cannot embed credentials")
    parsed = urllib.parse.urlparse(cleaned)
    if parsed.scheme not in {"https", "http"} or not parsed.netloc:
        raise LinkError(_with_url("repository URL must be http or https", cleaned))
    if parsed.path in {"", "/"}:
        raise LinkError(_with_url("repository URL needs a path", cleaned))
    return cleaned


def _validate_list_url(url: str) -> None:
    if _control_characters(url):
        raise LinkError("a list file must be http, https, or file")
    if embeds_credentials(url):
        raise LinkError("list URLs cannot embed credentials")
    parsed = urllib.parse.urlparse(url)
    if parsed.scheme not in {"https", "http", "file"}:
        raise LinkError("a list file must be http, https, or file")
    if parsed.scheme in {"https", "http"} and not parsed.netloc:
        raise LinkError("the list URL needs a host")


class _NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):  # noqa: ANN001
        raise LinkError(f"refusing to follow a redirect from {req.full_url}")


def fetch_text(url: str, timeout: float = 10) -> str:
    """Fetch a publisher or peer document directly. Redirects are not followed."""
    parsed = urllib.parse.urlparse(url)
    if parsed.scheme == "file":
        path = Path(urllib.request.url2pathname(parsed.path))
        if not path.is_file():
            raise LinkError(f"list file not found: {path}")
        data = path.read_bytes()
        if len(data) > MAX_LIST_BYTES:
            raise LinkError("list file is larger than 1MB")
        return _decode_text(data)
    if parsed.scheme not in {"https", "http"}:
        raise LinkError(f"cannot fetch {parsed.scheme} URLs")
    request = urllib.request.Request(url, headers={"User-Agent": USER_AGENT})
    opener = urllib.request.build_opener(_NoRedirect)
    try:
        with opener.open(request, timeout=timeout) as response:
            data = response.read(MAX_LIST_BYTES + 1)
    except urllib.error.URLError as exc:
        raise LinkError(f"could not fetch {redact_clone_url(url)}: {exc.reason}") from exc
    if len(data) > MAX_LIST_BYTES:
        raise LinkError("list file is larger than 1MB")
    return _decode_text(data)


def _decode_text(data: bytes) -> str:
    try:
        return data.decode("utf-8")
    except UnicodeDecodeError as exc:
        raise LinkError("document is not UTF-8") from exc


def repos_from_list_text(text: str) -> list[str]:
    stripped = text.strip()
    if not stripped:
        return []
    if stripped.startswith("{") or stripped.startswith("["):
        return _repos_from_json(stripped)
    repos: list[str] = []
    for line in text.splitlines():
        line = line.strip()
        if not line or line.startswith("#"):
            continue
        repos.append(_validate_repo_url(line))
    return repos


def _repos_from_json(text: str) -> list[str]:
    try:
        payload = json.loads(text)
    except json.JSONDecodeError as exc:
        raise LinkError(f"list file is not valid JSON: {exc}") from exc
    values: list[object]
    if isinstance(payload, dict):
        values = payload.get("repos", [])
    elif isinstance(payload, list):
        values = payload
    else:
        raise LinkError("list file JSON must be a list or an object with repos")
    repos: list[str] = []
    for item in values:
        if isinstance(item, str):
            repos.append(_validate_repo_url(item))
        elif isinstance(item, dict) and isinstance(item.get("url"), str):
            repos.append(_validate_repo_url(item["url"]))
        else:
            raise LinkError("each repo in the list file needs a URL")
    return repos


def _normalize_repo(url: str) -> str:
    parsed = urllib.parse.urlparse(url.strip())
    path = parsed.path.rstrip("/") or parsed.path
    return urllib.parse.urlunparse(parsed._replace(path=path))


def add_repos(home: Path, urls: list[str]) -> list[str]:
    """Append repos to the local source list. Returns the URLs that were new."""
    with home_lock(home):
        current = load_sources(home)
        known = {_normalize_repo(repo["url"]) for repo in current}
        added: list[str] = []
        for url in urls:
            validated = _validate_repo_url(url)
            key = _normalize_repo(validated)
            if key in known:
                continue
            current.append({"url": validated, "note": "Added from a Fossah link."})
            known.add(key)
            added.append(validated)
        save_sources(home, current)
        return added


class LinkApply(list[str]):
    """Repos added by a link, plus the accept and refuse decisions."""

    def __init__(self, added: list[str], decisions: list[dict[str, object]]):
        super().__init__(added)
        self.decisions = decisions


def apply_link(home: Path, url: str) -> LinkApply:
    try:
        parsed = parse_fossah_link(url)
    except LinkError as exc:
        choices = [decision("link", url, False, str(exc))]
        remember(home, choices)
        raise
    judged: list[tuple[bool, str, str]] = [judge_repo_url(repo) for repo in parsed.repos]
    decisions: list[dict[str, object]] = []
    if parsed.list_url:
        try:
            listed = judge_list_text(fetch_text(parsed.list_url))
        except LinkError as exc:
            decisions.append(decision("link", parsed.list_url, False, str(exc)))
        else:
            if not listed:
                decisions.append(decision("link", parsed.list_url, False, "the list file has no repositories"))
            judged.extend(listed)
    known = {_normalize_repo(repo["url"]) for repo in load_sources(home)}
    fresh: list[str] = []
    for accepted, cleaned, reason in judged:
        if not accepted:
            decisions.append(decision("link", cleaned, False, reason))
            continue
        if _normalize_repo(cleaned) in known:
            decisions.append(decision("link", cleaned, True, "already in the local source list"))
            continue
        decisions.append(decision("link", cleaned, True, reason))
        fresh.append(cleaned)
        known.add(_normalize_repo(cleaned))
    added = add_repos(home, fresh) if fresh else []
    remember(home, decisions)
    if not any(item["accepted"] for item in decisions):
        reason = str(decisions[-1]["reason"]) if decisions else "the link added no repositories"
        raise LinkError(reason)
    return LinkApply(added, decisions)
