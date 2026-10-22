"""Meter token usage reported by the subscription CLI.

Only the Claude CLI is invoked, and only as a planner. It runs on the trusted
side, in an empty directory under the IdleHand home, with tools turned off.
Codex and Cursor are not invoked: those CLIs run repository commands on the
host. The planner's reply is not executed. A missing or unreadable report is
not a number; the caller keeps the local estimate.
"""

from __future__ import annotations

import json
import os
import shutil
import subprocess
from pathlib import Path

PLAN_TIMEOUT = 20.0

_TOKEN_KEYS = (
    "input_tokens",
    "output_tokens",
    "cache_creation_input_tokens",
    "cache_read_input_tokens",
)


def claude_argv(binary: str, repo_url: str, action: str) -> list[str]:
    verbs = {
        "test": "test",
        "audit": "audit",
        "issue": "issue",
        "pull_request": "pull request",
    }
    verb = verbs.get(action, action)
    prompt = (
        f"In one sentence, describe a {verb} for {repo_url}. "
        "Do not use tools. Do not read or write files. Do not run commands."
    )
    return [
        binary,
        "-p",
        "--output-format",
        "json",
        "--tools",
        "",
        "--disallowedTools",
        "*",
        "--disallowedTools",
        "mcp__*",
        "--permission-mode",
        "plan",
        prompt,
    ]


def _usage_total(usage: dict[str, object]) -> int | None:
    total = 0
    found = False
    for key in _TOKEN_KEYS:
        value = usage.get(key)
        if isinstance(value, bool) or not isinstance(value, int) or value < 0:
            continue
        found = True
        total += value
    if found:
        return total
    fallback = usage.get("total_tokens")
    if isinstance(fallback, bool) or not isinstance(fallback, int) or fallback < 0:
        return None
    return fallback


def _collect(node: object) -> tuple[list[int], list[int]]:
    reported: list[int] = []
    other: list[int] = []
    if isinstance(node, dict) and "usage" not in node and _usage_total(node) is not None:
        other.append(_usage_total(node) or 0)
        return reported, other

    def walk(value: object, in_result: bool) -> None:
        if isinstance(value, dict):
            here = in_result or value.get("type") == "result"
            usage = value.get("usage")
            if isinstance(usage, dict):
                total = _usage_total(usage)
                if total is not None:
                    (reported if here else other).append(total)
            for child in value.values():
                walk(child, here)
        elif isinstance(value, list):
            for child in value:
                walk(child, in_result)

    walk(node, False)
    return reported, other


def parse_reported_tokens(text: str) -> int | None:
    """Return reported tokens, or None when the CLI did not report usage.

    Zero is a real report. The last result usage wins so a JSONL transcript
    is not added up twice. A huge or deeply nested document is not a report.
    """
    raw = text.strip()
    if not raw or len(raw) > 1_000_000:
        return None
    documents: list[object] = []
    try:
        try:
            documents.append(json.loads(raw))
        except json.JSONDecodeError:
            for line in raw.splitlines():
                piece = line.strip()
                if not piece:
                    continue
                try:
                    documents.append(json.loads(piece))
                except json.JSONDecodeError:
                    continue
    except RecursionError:
        return None
    result_totals: list[int] = []
    other_totals: list[int] = []
    try:
        for document in documents:
            found, other = _collect(document)
            result_totals.extend(found)
            other_totals.extend(other)
    except RecursionError:
        return None
    if result_totals:
        return result_totals[-1]
    if other_totals:
        return other_totals[-1]
    return None


def _empty_planner_dir(home: Path) -> Path | None:
    root = home.resolve()
    path = root / "planner"
    if path.is_symlink():
        return None
    if path.exists():
        resolved = path.resolve()
        if not resolved.is_relative_to(root):
            return None
        shutil.rmtree(resolved)
    path.mkdir(parents=True, exist_ok=True)
    return path


def _discard_planner_dir(home: Path, cwd: Path | None) -> None:
    """Remove files the planner wrote. Do not follow a symlink out of the home."""
    if cwd is None or cwd.is_symlink():
        return
    try:
        if cwd.resolve().is_relative_to(home.resolve()):
            shutil.rmtree(cwd, ignore_errors=True)
    except OSError:
        return


def plan_with_claude(binary: str, repo_url: str, action: str, home: Path) -> dict[str, object]:
    argv = claude_argv(binary, repo_url, action)
    cwd = _empty_planner_dir(home)
    if cwd is None:
        return {
            "executed": False,
            "tokens": None,
            "argv": argv,
            "reason": "refusing to plan outside the IdleHand home",
        }
    try:
        try:
            completed = subprocess.run(
                argv,
                cwd=cwd,
                env=os.environ.copy(),
                capture_output=True,
                text=True,
                timeout=PLAN_TIMEOUT,
                check=False,
            )
        except subprocess.TimeoutExpired:
            return {
                "executed": True,
                "tokens": None,
                "argv": argv,
                "reason": "subscription planner timed out",
            }
        except OSError as exc:
            return {
                "executed": False,
                "tokens": None,
                "argv": argv,
                "reason": f"could not run the subscription CLI: {exc}",
            }
    finally:
        _discard_planner_dir(home, cwd)
    tokens = parse_reported_tokens(completed.stdout or "")
    if tokens is None:
        return {
            "executed": True,
            "tokens": None,
            "argv": argv,
            "reason": "subscription CLI did not report token usage",
        }
    return {
        "executed": True,
        "tokens": tokens,
        "argv": argv,
        "reason": "subscription CLI reported token usage",
    }
