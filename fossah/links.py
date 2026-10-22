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
from fossah.home import home_lock

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
    repos = [_validate_repo_url(repo) for repo in repos]
    if not repos and not list_url:
        raise LinkError("the link has no repos and no list file")
    return ParsedLink(repos=repos, list_url=list_url)


def _split_repo_field(value: str) -> list[str]:
    return [part.strip() for part in value.split(",") if part.strip()]


def _validate_repo_url(url: str) -> str:
    parsed = urllib.parse.urlparse(url.strip())
    if parsed.scheme not in {"https", "http"} or not parsed.netloc:
        raise LinkError(f"repository URL must be http or https: {url}")
    if parsed.username or parsed.password:
        raise LinkError("repository URLs cannot embed credentials")
    if parsed.path in {"", "/"}:
        raise LinkError(f"repository URL needs a path: {url}")
    return url.strip()


def _validate_list_url(url: str) -> None:
    parsed = urllib.parse.urlparse(url)
    if parsed.scheme not in {"https", "http", "file"}:
        raise LinkError("a list file must be http, https, or file")
    if parsed.scheme in {"https", "http"} and not parsed.netloc:
        raise LinkError("the list URL needs a host")
    if parsed.username or parsed.password:
        raise LinkError("list URLs cannot embed credentials")


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
        return data.decode("utf-8")
    if parsed.scheme not in {"https", "http"}:
        raise LinkError(f"cannot fetch {parsed.scheme} URLs")
    request = urllib.request.Request(url, headers={"User-Agent": USER_AGENT})
    opener = urllib.request.build_opener(_NoRedirect)
    try:
        with opener.open(request, timeout=timeout) as response:
            data = response.read(MAX_LIST_BYTES + 1)
    except urllib.error.URLError as exc:
        raise LinkError(f"could not fetch {url}: {exc.reason}") from exc
    if len(data) > MAX_LIST_BYTES:
        raise LinkError("list file is larger than 1MB")
    return data.decode("utf-8")


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


def apply_link(home: Path, url: str) -> list[str]:
    parsed = parse_fossah_link(url)
    repos = list(parsed.repos)
    if parsed.list_url:
        repos.extend(repos_from_list_text(fetch_text(parsed.list_url)))
    return add_repos(home, repos)
