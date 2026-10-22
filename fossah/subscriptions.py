"""Detect subscription CLIs and build the command that would run.

The command is recorded for the user. This slice does not execute it.
The subscription CLI stays on the trusted side of the node, outside the sandbox.
"""

from __future__ import annotations

import shutil
from dataclasses import dataclass

SUBSCRIPTION_NAMES = ("claude", "codex", "cursor")

# Cursor's agent CLI is installed as cursor-agent and as agent.
CURSOR_BINARIES = ("cursor-agent", "agent", "cursor")


@dataclass(frozen=True)
class SubscriptionStatus:
    name: str
    connected: bool
    binary: str
    detail: str

    def as_dict(self) -> dict[str, str | bool]:
        return {
            "name": self.name,
            "connected": self.connected,
            "binary": self.binary,
            "detail": self.detail,
        }


def binary_names(subscription: str) -> tuple[str, ...]:
    if subscription == "cursor":
        return CURSOR_BINARIES
    if subscription in ("claude", "codex"):
        return (subscription,)
    return ()


def find_binary(subscription: str) -> str:
    for name in binary_names(subscription):
        found = shutil.which(name)
        if found:
            return found
    return ""


def inspect_subscription(subscription: str) -> SubscriptionStatus:
    if not subscription:
        return SubscriptionStatus(
            name="",
            connected=False,
            binary="",
            detail="no subscription is configured",
        )
    if subscription not in SUBSCRIPTION_NAMES:
        return SubscriptionStatus(
            name=subscription,
            connected=False,
            binary="",
            detail=f"{subscription} is not a known subscription",
        )
    binary = find_binary(subscription)
    if not binary:
        expected = ", ".join(binary_names(subscription))
        return SubscriptionStatus(
            name=subscription,
            connected=False,
            binary="",
            detail=f"subscription is not connected ({expected} was not found on PATH)",
        )
    return SubscriptionStatus(
        name=subscription,
        connected=True,
        binary=binary,
        detail=f"connected via {binary}",
    )


def contribution_prompt(repo_url: str, action: str) -> str:
    verbs = {
        "test": "Test the project",
        "audit": "Audit the code",
        "issue": "Open an issue",
        "pull_request": "Open a pull request",
    }
    verb = verbs.get(action, "Contribute")
    return (
        f"{verb} for {repo_url}. "
        "Repository code, builds, tests, and other repo commands must run only in the Fossah sandbox. "
        "The sandbox has no home directory and no credentials. "
        "Do not read or copy credentials. "
        "This subscription CLI stays outside that sandbox."
    )


def subscription_command(subscription: str, binary: str, repo_url: str, action: str) -> list[str]:
    """Real non-interactive command for this subscription. Not executed."""
    prompt = contribution_prompt(repo_url, action)
    executable = binary or (binary_names(subscription)[0] if binary_names(subscription) else subscription)
    if subscription == "codex":
        return [executable, "exec", prompt]
    # claude -p and cursor-agent/agent/cursor -p are the print/non-interactive paths.
    return [executable, "-p", prompt]
