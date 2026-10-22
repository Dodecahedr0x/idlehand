"""Run a command in a container or the namespace jail.

The subscription CLIs are not sandbox commands. Callers pass the repo command
only. If no runtime is available, the command is not run on the host.
"""

from __future__ import annotations

import os
import shutil
import subprocess
import sys
from dataclasses import dataclass
from pathlib import Path

from idlehand.fetch import scrub_secrets


def _stored_output(text: str, limit: int) -> str:
    """Drop credential URLs and private-key lines before output is written down."""
    lines = []
    for line in scrub_secrets(text).splitlines():
        if "PRIVATE KEY" in line:
            lines.append("private key material omitted")
        else:
            lines.append(line)
    return "\n".join(lines)[-limit:]


class SandboxError(RuntimeError):
    pass


@dataclass
class SandboxResult:
    runtime: str
    invoked: bool
    ok: bool
    exit_code: int | None
    stdout: str
    stderr: str
    reason: str
    argv: list[str]

    def as_dict(self) -> dict[str, object]:
        return {
            "runtime": self.runtime,
            "invoked": self.invoked,
            "ok": self.ok,
            "exit_code": self.exit_code,
            "stdout": _stored_output(self.stdout, 500),
            "stderr": _stored_output(self.stderr, 500),
            "reason": _stored_output(self.reason, 300),
            "argv": self.argv,
        }


_KNOWN_RUNTIMES = {"auto", "none", "docker", "podman", "namespace", "bwrap"}


def detect_runtime(configured: str = "auto") -> str | None:
    if not isinstance(configured, str):
        return None
    choice = configured or "auto"
    if choice == "none":
        return None
    if choice != "auto":
        if choice not in _KNOWN_RUNTIMES:
            return None
        return choice
    for name in ("docker", "podman"):
        if shutil.which(name):
            return name
    if sys.platform.startswith("linux") and hasattr(os, "unshare"):
        return "namespace"
    if shutil.which("bwrap"):
        return "bwrap"
    return None


def probe_script() -> str:
    return (
        "from pathlib import Path\n"
        "Path('sandbox-ok.txt').write_text('ok\\n')\n"
        "print('idlehand-sandbox-ok')\n"
    )


def probe_command(runtime: str) -> list[str]:
    script = probe_script()
    if runtime in {"docker", "podman"}:
        return ["python", "-c", script]
    return ["/usr/bin/python3", "-c", script]


def prepare_host_command(argv: list[str], workspace: Path) -> list[str]:
    """Map a command to a path that is legal inside the namespace jail."""
    if not argv:
        raise SandboxError("empty command")
    workspace = workspace.resolve()
    raw = argv[0]
    if not raw.startswith("/"):
        in_workspace = workspace / raw
        if in_workspace.exists():
            resolved = in_workspace.resolve()
            resolved.relative_to(workspace)
            return [str(Path("/work") / resolved.relative_to(workspace)), *argv[1:]]
        found = shutil.which(raw)
        if not found:
            raise SandboxError(f"{raw} was not found on PATH")
        raw = found
    path = Path(raw)
    if path.exists():
        try:
            resolved = path.resolve()
            resolved.relative_to(workspace)
            return [str(Path("/work") / resolved.relative_to(workspace)), *argv[1:]]
        except ValueError:
            pass
    text = str(path)
    if text.startswith(("/usr/", "/bin/", "/lib/", "/lib64/")):
        return [text, *argv[1:]]
    raise SandboxError(f"refusing to run {text} outside the sandbox")


def _clean_helper_env() -> dict[str, str]:
    root = str(Path(__file__).resolve().parents[1])
    return {
        "PATH": "/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin",
        "PYTHONPATH": root,
        "PYTHONNOUSERSITE": "1",
        "HOME": "/tmp",
        "TMPDIR": "/tmp",
        "LANG": "C",
    }


def build_container_argv(
    runtime: str,
    workspace: Path,
    command: list[str],
    *,
    image: str,
    memory: str,
    cpus: str,
) -> list[str]:
    workspace = workspace.resolve()
    return [
        runtime,
        "run",
        "--rm",
        "--network",
        "none",
        "--read-only",
        "--cap-drop",
        "ALL",
        "--security-opt",
        "no-new-privileges",
        "--pids-limit",
        "128",
        "--memory",
        memory,
        "--cpus",
        cpus,
        "--user",
        "65534:65534",
        "--mount",
        f"type=bind,source={workspace},target=/work",
        "--workdir",
        "/work",
        "--tmpfs",
        "/tmp:rw,noexec,nosuid,size=64m",
        "-e",
        "HOME=/tmp",
        "-e",
        "TMPDIR=/tmp",
        "-e",
        "PATH=/usr/local/bin:/usr/bin:/bin",
        image,
        *command,
    ]


def build_bwrap_argv(workspace: Path, command: list[str]) -> list[str]:
    workspace = workspace.resolve()
    argv = [
        "bwrap",
        "--unshare-all",
        "--die-with-parent",
        "--new-session",
        "--ro-bind",
        "/usr",
        "/usr",
        "--tmpfs",
        "/tmp",
        "--dev",
        "/dev",
        "--bind",
        str(workspace),
        "/work",
        "--chdir",
        "/work",
        "--clearenv",
        "--setenv",
        "PATH",
        "/usr/bin:/bin",
        "--setenv",
        "HOME",
        "/tmp",
        "--setenv",
        "TMPDIR",
        "/tmp",
    ]
    for name in ("bin", "lib", "lib64"):
        host = Path("/") / name
        if host.is_symlink():
            argv.extend(["--symlink", os.readlink(host), f"/{name}"])
    argv.append("--")
    argv.extend(command)
    return argv


def _refused(runtime: str, reason: str, argv: list[str] | None = None) -> SandboxResult:
    return SandboxResult(
        runtime=runtime or "none",
        invoked=False,
        ok=False,
        exit_code=None,
        stdout="",
        stderr="",
        reason=reason,
        argv=argv or [],
    )


def _from_process(runtime: str, argv: list[str], completed: subprocess.CompletedProcess[str]) -> SandboxResult:
    stdout = completed.stdout or ""
    stderr = completed.stderr or ""
    ok = completed.returncode == 0
    reason = "sandbox command finished" if ok else (stderr.strip() or f"sandbox exited {completed.returncode}")
    return SandboxResult(
        runtime=runtime,
        invoked=True,
        ok=ok,
        exit_code=completed.returncode,
        stdout=stdout,
        stderr=stderr,
        reason=reason.splitlines()[0][:300],
        argv=argv,
    )


def run_namespace(workspace: Path, command: list[str], timeout: float = 30) -> SandboxResult:
    if workspace.is_symlink():
        return _refused("namespace", "refusing to follow a workspace symlink", command)
    try:
        mapped = prepare_host_command(command, workspace)
    except SandboxError as exc:
        return _refused("namespace", str(exc), command)
    argv = [sys.executable, "-m", "idlehand.jail", "--workspace", str(workspace.resolve()), "--", *mapped]
    process = subprocess.Popen(
        argv,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        text=True,
        env=_clean_helper_env(),
    )
    scratch = Path(f"/tmp/idlehand-jail-{process.pid}")
    try:
        stdout, stderr = process.communicate(timeout=timeout)
    except subprocess.TimeoutExpired:
        process.kill()
        process.communicate()
        shutil.rmtree(scratch, ignore_errors=True)
        return SandboxResult(
            runtime="namespace",
            invoked=True,
            ok=False,
            exit_code=None,
            stdout="",
            stderr="sandbox timed out",
            reason="sandbox timed out",
            argv=mapped,
        )
    finally:
        shutil.rmtree(scratch, ignore_errors=True)
    completed = subprocess.CompletedProcess(argv, process.returncode, stdout, stderr)
    result = _from_process("namespace", mapped, completed)
    if completed.returncode == 97:
        result.invoked = False
        result.reason = (completed.stderr or "sandbox setup failed").strip().splitlines()[-1][:300]
    return result


def run_external(runtime: str, argv: list[str], timeout: float = 30) -> SandboxResult:
    binary = shutil.which(argv[0]) or argv[0]
    if shutil.which(argv[0]) is None and not Path(argv[0]).exists():
        return _refused(runtime, f"{runtime} is not on PATH", argv)
    try:
        completed = subprocess.run(
            [binary, *argv[1:]],
            capture_output=True,
            text=True,
            timeout=timeout,
            env=_clean_helper_env(),
            check=False,
        )
    except subprocess.TimeoutExpired:
        return SandboxResult(
            runtime=runtime,
            invoked=True,
            ok=False,
            exit_code=None,
            stdout="",
            stderr="sandbox timed out",
            reason="sandbox timed out",
            argv=argv,
        )
    return _from_process(runtime, argv, completed)


def run(
    workspace: Path,
    command: list[str],
    *,
    runtime: str = "auto",
    image: str = "python:3.12-slim",
    memory: str = "512m",
    cpus: str = "1",
    timeout: float = 30,
) -> SandboxResult:
    chosen = detect_runtime(runtime)
    if chosen is None:
        label = runtime if isinstance(runtime, str) and runtime in _KNOWN_RUNTIMES else "none"
        return _refused(label, "no sandbox runtime is available; refused to run on the host", command)
    if workspace.is_symlink() or workspace.parent.is_symlink():
        return _refused(runtime, "refusing to follow a workspace symlink", command)
    workspace.mkdir(parents=True, exist_ok=True)
    if chosen == "namespace":
        return run_namespace(workspace, command, timeout=timeout)
    if chosen in {"docker", "podman"}:
        os.chmod(workspace, 0o777)
        argv = build_container_argv(chosen, workspace, command, image=image, memory=memory, cpus=cpus)
        return run_external(chosen, argv, timeout=timeout)
    if chosen == "bwrap":
        try:
            mapped = prepare_host_command(command, workspace)
        except SandboxError as exc:
            return _refused("bwrap", str(exc), command)
        return run_external("bwrap", build_bwrap_argv(workspace, mapped), timeout=timeout)
    return _refused("none", "sandbox runtime is unreadable", command)
