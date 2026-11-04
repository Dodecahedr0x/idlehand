#!/usr/bin/env python3
"""Run one shell command in the Idlehand verification sandbox.

The command's exit code is passed through. Two codes belong to this script:

  86  the sandbox did not start, or the command timed out
  87  the command was rejected and did not run

A failing command (exit 1, a test failure, a crash) is a result. It is not
exit 86. Stdout is the command's stdout. The launch marker is stripped.
"""

from __future__ import annotations

import argparse
import json
import os
import re
import shutil
import signal
import subprocess
import sys
import tempfile
import uuid
from pathlib import Path

BUN_SUBCOMMANDS = (
    "install|add|remove|update|upgrade|link|unlink|pm|build|create|init|"
    "x|repl|exec|outdated|why|audit|info|publish|pack|patch|run"
)

REJECT = (
    (re.compile(r"\brm\s+-rf\s+[/~]"), "refuses to run rm -rf on an absolute or home path"),
    (re.compile(r"\b(sudo|doas)\b"), "refuses to run sudo"),
    (re.compile(r"\bgit\s+push\b|\bgh\s+(pr|issue|release|repo)\b"), "reproduction commands may not push or talk to GitHub"),
    (re.compile(r"curl[^|]*\|\s*(ba)?sh\b"), "refuses to pipe a download into a shell"),
    (re.compile(r"\b(shutdown|reboot|mkfs|dd\s+if=)"), "refuses obviously destructive commands"),
)


def rejection(command: str) -> str | None:
    if not command.strip():
        return "empty command"
    for pattern, reason in REJECT:
        if pattern.search(command):
            return reason
    return None


def jsx_import_source(root: Path) -> str | None:
    for name in ("tsconfig.json", "jsconfig.json"):
        path = root / name
        if not path.is_file():
            continue
        try:
            text = path.read_text()
        except OSError:
            return None
        match = re.search(r'"jsxImportSource"\s*:\s*"([^"\s`$\\]+)"', text)
        return match.group(1) if match else None
    return None


def write_bun_shim(scratch: Path, bun: str, source: str | None) -> None:
    preload = scratch / "tmpdir-preload.ts"
    preload.write_text(
        f"process.env.TMPDIR ??= {json.dumps(str(scratch))};\n"
        "process.env.TMP ??= process.env.TMPDIR;\n"
        "process.env.TEMP ??= process.env.TMPDIR;\n"
    )
    quoted_bun = json.dumps(bun)
    quoted_preload = json.dumps(str(preload))
    jsx = f" --jsx-import-source {json.dumps(source)}" if source else ""
    fallback = f"exec {quoted_bun}{jsx} \"$@\"" if source else f"exec {quoted_bun} \"$@\""
    script = (
        "#!/bin/sh\n"
        'case "$1" in\n'
        "  test)\n"
        "    shift\n"
        f"    exec {quoted_bun} test{jsx} --preload {quoted_preload} \"$@\"\n"
        "    ;;\n"
        f"  {BUN_SUBCOMMANDS})\n"
        f"    exec {quoted_bun} \"$@\"\n"
        "    ;;\n"
        "esac\n"
        f"{fallback}\n"
    )
    path = scratch / "bun"
    path.write_text(script)
    path.chmod(0o755)


def runtime_bins() -> list[str]:
    found: list[str] = []
    for name in ("bun", "node", "git", "python3"):
        path = shutil.which(name)
        if not path:
            continue
        real = str(Path(path).resolve())
        if real not in found:
            found.append(real)
    return found


def darwin_argv(root: str, runtimes: list[str], shell: list[str]) -> list[str]:
    def subpath(path: str) -> str:
        return f"(subpath {json.dumps(path)})"

    reads = [root, "/System", "/Library", "/usr", "/bin", "/sbin", "/opt/homebrew", "/opt/local", "/dev", "/etc", "/private/etc"]
    literals = " ".join(f"(literal {json.dumps(path)})" for path in runtimes)
    profile = "\n".join(
        [
            "(version 1)",
            "(deny default)",
            "(allow process-exec process-fork)",
            "(allow signal (target children))",
            "(allow sysctl-read)",
            '(allow mach-lookup (global-name "com.apple.system.logger"))',
            f"(allow file-read* {' '.join(subpath(path) for path in reads)} (literal \"/\") {literals})",
            "(allow file-read-metadata)",
            f"(allow file-write* {subpath(root)} (literal \"/dev/null\"))",
            "(allow system-socket)",
            "(allow mach-lookup "
            '(global-name "com.apple.trustd") (global-name "com.apple.trustd.agent") '
            '(global-name "com.apple.securityd") (global-name "com.apple.securityd.xpc") '
            '(global-name "com.apple.ocspd") (global-name "com.apple.mDNSResponder") '
            '(global-name "com.apple.mDNSResponder.reconfirm") '
            '(global-name "com.apple.CoreServices.launchservicesd") '
            '(global-name "com.apple.coreservices.launchservicesd") '
            '(global-name "com.apple.lsd.mapdb") '
            '(global-name "com.apple.distributed_notifications@Uv3") '
            '(global-name "com.apple.system.notification_center") '
            '(global-name "com.apple.bsd.dirhelper") '
            '(global-name "com.apple.system.DirectoryService.libinfo_v1") '
            '(global-name "com.apple.system.DirectoryService.membership_v1"))',
            '(deny network-outbound (remote ip "localhost:*"))',
            '(deny network-outbound (remote tcp "localhost:*"))',
            '(deny network-inbound (local ip "localhost:*"))',
            "(allow network*)",
        ]
    )
    return ["/usr/bin/sandbox-exec", "-p", profile, *shell]


def linux_argv(root: str, runtimes: list[str], shell: list[str]) -> list[str]:
    bwrap = next((candidate for candidate in ("/usr/bin/bwrap", "/bin/bwrap") if os.path.exists(candidate)), None)
    if bwrap is None:
        which = shutil.which("bwrap")
        bwrap = str(Path(which).resolve()) if which else None
    if bwrap is None:
        raise RuntimeError("install bubblewrap (bwrap) to enable verification")
    argv = [
        bwrap,
        "--unshare-user",
        "--unshare-ipc",
        "--unshare-pid",
        "--unshare-uts",
        "--unshare-cgroup",
        "--die-with-parent",
        "--new-session",
        "--cap-drop",
        "ALL",
    ]
    for path in ("/usr", "/bin", "/sbin", "/lib", "/lib64", "/opt", "/etc"):
        if os.path.exists(path):
            argv.extend(["--ro-bind", path, path])
    argv.extend(["--proc", "/proc", "--dev", "/dev"])
    for runtime in runtimes:
        if not runtime.startswith(("/usr/", "/bin/", "/sbin/", "/opt/")):
            argv.extend(["--ro-bind", runtime, runtime])
    argv.extend(["--bind", root, root, "--chdir", root, *shell])
    return argv


def sandboxed(command: str, cwd: str, timeout: float) -> int:
    root = str(Path(cwd).resolve())
    scratch_path = Path(tempfile.mkdtemp(prefix=".idlehand-sandbox-", dir=root))
    scratch = str(scratch_path)
    try:
        runtimes = runtime_bins()
        bun = next((path for path in runtimes if path.endswith("/bun") or path.endswith("\\bun")), None)
        if bun:
            write_bun_shim(scratch_path, bun, jsx_import_source(Path(root)))
        path = ":".join(
            [*( [scratch] if bun else [] ), *{str(Path(runtime).parent) for runtime in runtimes}]
        )
        path = f"{path}:/usr/local/bin:/opt/homebrew/bin:/usr/bin:/bin:/usr/sbin:/sbin"
        env = {
            "PATH": path,
            "HOME": scratch,
            "TMPDIR": scratch,
            "TMP": scratch,
            "TEMP": scratch,
            "CI": "1",
            "FORCE_COLOR": "0",
            "NO_COLOR": "1",
            "TERM": "dumb",
            "LANG": "C",
        }
        marker = f"idlehand-sandbox-{uuid.uuid4()}\n"
        shell = ["/bin/sh", "-c", 'printf "%s" "$0"; exec /bin/sh -c "$1"', marker, command]
        if sys.platform == "darwin":
            argv = darwin_argv(root, runtimes, shell)
        elif sys.platform == "linux":
            argv = linux_argv(root, runtimes, shell)
        else:
            raise RuntimeError(f"verification sandbox is unsupported on {sys.platform}")
        proc = subprocess.Popen(
            argv,
            cwd=root,
            env=env,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            start_new_session=True,
        )
        try:
            out, err = proc.communicate(timeout=timeout)
        except subprocess.TimeoutExpired:
            os.killpg(proc.pid, signal.SIGKILL)
            proc.communicate()
            print(f"sandbox-timeout: command timed out after {timeout:g}s", file=sys.stderr)
            return 86
        stdout = out.decode(errors="replace")
        if not stdout.startswith(marker):
            detail = err.decode(errors="replace").strip() or f"exit {proc.returncode}"
            print(f"sandbox-unavailable: could not start the enforced sandbox: {detail}", file=sys.stderr)
            return 86
        sys.stdout.write(stdout[len(marker) :])
        sys.stderr.write(err.decode(errors="replace"))
        return proc.returncode if proc.returncode is not None else 1
    finally:
        shutil.rmtree(scratch_path, ignore_errors=True)


def main() -> int:
    parser = argparse.ArgumentParser(description="Run one command in the Idlehand verification sandbox.")
    parser.add_argument("--cwd", required=True)
    parser.add_argument("--timeout", type=float, required=True)
    parser.add_argument("command")
    args = parser.parse_args()
    reason = rejection(args.command)
    if reason:
        print(f"rejected: {reason}", file=sys.stderr)
        return 87
    if args.timeout <= 0:
        print("rejected: timeout must be positive", file=sys.stderr)
        return 87
    try:
        return sandboxed(args.command, args.cwd, args.timeout)
    except Exception as error:  # noqa: BLE001 — fail closed, never fall back to a plain shell
        print(f"sandbox-unavailable: {error}", file=sys.stderr)
        return 86


if __name__ == "__main__":
    sys.exit(main())
