"""Enter a Linux namespace jail and exec one command.

The command sees a private copy of its own binary and libraries, a tmpfs /tmp,
null/zero/urandom, and the repo workspace mounted at /work. The user's home,
credentials, and the rest of the host filesystem are not mounted. There is no
network. The environment is replaced before exec.

This process must be started on its own, not forked from the multithreaded node.
"""

from __future__ import annotations

import ctypes
import ctypes.util
import os
import shutil
import subprocess
import sys
from pathlib import Path

MS_BIND = 4096
MS_REC = 16384
MS_RDONLY = 1
MS_NOSUID = 2
MS_NODEV = 4
MS_NOEXEC = 8
MS_REMOUNT = 32
MS_PRIVATE = 1 << 18
MNT_DETACH = 2
PIVOT_ROOT = {"x86_64": 155, "aarch64": 41, "armv7l": 218, "armv6l": 218}
PR_SET_NO_NEW_PRIVS = 38

_LIBC = ctypes.CDLL(ctypes.util.find_library("c"), use_errno=True)
_LIBC.mount.argtypes = [ctypes.c_char_p, ctypes.c_char_p, ctypes.c_char_p, ctypes.c_ulong, ctypes.c_void_p]
_LIBC.mount.restype = ctypes.c_int
_LIBC.umount2.argtypes = [ctypes.c_char_p, ctypes.c_int]
_LIBC.umount2.restype = ctypes.c_int
_LIBC.syscall.restype = ctypes.c_long
_LIBC.prctl.argtypes = [ctypes.c_int, ctypes.c_ulong, ctypes.c_ulong, ctypes.c_ulong, ctypes.c_ulong]
_LIBC.prctl.restype = ctypes.c_int


class JailError(RuntimeError):
    pass


def _mount(src: str | None, target: str, fstype: str | None, flags: int, data: str | None = None) -> None:
    result = _LIBC.mount(
        None if src is None else src.encode(),
        target.encode(),
        None if fstype is None else fstype.encode(),
        flags,
        None if data is None else data.encode(),
    )
    if result != 0:
        err = ctypes.get_errno()
        raise JailError(f"mount {src} -> {target} failed: {os.strerror(err)}")


def _stage_lookup(root: Path, path: Path, seen: set[str] | None = None) -> None:
    seen = seen if seen is not None else set()
    path = Path(os.path.normpath(str(path)))
    if str(path) in seen:
        return
    seen.add(str(path))
    current = Path("/")
    for part in path.parts[1:]:
        current = current / part
        dest = root / current.relative_to("/")
        if current.is_symlink():
            dest.parent.mkdir(parents=True, exist_ok=True)
            link = os.readlink(current)
            if not dest.is_symlink() and not dest.exists():
                dest.symlink_to(link)
            target = Path(link) if link.startswith("/") else current.parent / link
            rest = path.parts[len(current.parts) :]
            if rest:
                target = target.joinpath(*rest)
            _stage_lookup(root, target, seen)
            return
        if current.is_dir():
            if not dest.is_symlink():
                dest.mkdir(parents=True, exist_ok=True)
            continue
        if current.is_file():
            dest.parent.mkdir(parents=True, exist_ok=True)
            if not dest.exists():
                shutil.copy2(current, dest)
            return
        raise JailError(f"cannot stage missing path {current}")


def _ldd_paths(binary: Path) -> list[Path]:
    try:
        output = subprocess.check_output(
            ["ldd", str(binary)],
            text=True,
            stderr=subprocess.DEVNULL,
            env={"PATH": "/usr/bin:/bin", "LANG": "C"},
        )
    except (subprocess.CalledProcessError, FileNotFoundError):
        return []
    paths: list[Path] = []
    for line in output.splitlines():
        line = line.strip()
        if "=>" in line:
            part = line.split("=>", 1)[1].strip().split()[0]
            if part.startswith("/"):
                paths.append(Path(part))
        elif line.startswith("/"):
            paths.append(Path(line.split()[0]))
    return paths


def _stdlib_path(binary: Path) -> Path | None:
    name = binary.name
    if "python" not in name:
        return None
    env = {"PATH": "/usr/bin:/bin", "PYTHONNOUSERSITE": "1", "HOME": "/tmp", "LANG": "C"}
    try:
        output = subprocess.check_output(
            [str(binary), "-c", "import sysconfig; print(sysconfig.get_path('stdlib'))"],
            text=True,
            env=env,
        )
    except (subprocess.CalledProcessError, FileNotFoundError, OSError):
        return None
    path = Path(output.strip())
    if path.is_dir() and str(path).startswith("/usr/"):
        return path
    return None


def _stage_runtime(root: Path, command: list[str]) -> None:
    binary = Path(command[0])
    if not binary.is_absolute():
        raise JailError("the jailed command must be an absolute path")
    # Workspace commands are already visible through the /work mount.
    try:
        binary.resolve().relative_to(Path("/work"))
        return
    except ValueError:
        pass
    if not (str(binary).startswith("/usr/") or str(binary).startswith("/bin/")):
        raise JailError(f"refusing to stage {binary} from outside /usr or /bin")
    resolved = binary.resolve()
    _stage_lookup(root, binary)
    for library in _ldd_paths(resolved):
        _stage_lookup(root, library)
    stdlib = _stdlib_path(resolved if "python" in resolved.name else binary)
    if stdlib is not None:
        destination = root / stdlib.relative_to("/")
        shutil.copytree(stdlib, destination, symlinks=True, dirs_exist_ok=True)


def _remount_readonly(path: Path) -> None:
    if not path.exists() or path.is_symlink():
        return
    _mount(str(path), str(path), None, MS_BIND)
    _mount(None, str(path), None, MS_BIND | MS_REMOUNT | MS_RDONLY)


def enter_and_exec(workspace: Path, command: list[str]) -> None:
    """Replace this process with command inside the jail. Does not return on success."""
    if workspace.is_symlink():
        raise JailError("refusing to follow a workspace symlink")
    workspace = workspace.resolve()
    if not workspace.is_dir():
        raise JailError(f"workspace does not exist: {workspace}")
    if not hasattr(os, "unshare"):
        raise JailError("this system cannot create a namespace jail")
    machine = os.uname().machine
    if machine not in PIVOT_ROOT:
        raise JailError(f"no pivot_root syscall for {machine}")
    uid = os.getuid()
    gid = os.getgid()
    jail = Path(os.path.abspath(os.path.join(os.sep, "tmp", f"idlehand-jail-{os.getpid()}")))
    jail.mkdir(mode=0o700, exist_ok=False)
    try:
        flags = os.CLONE_NEWUSER | os.CLONE_NEWNS | os.CLONE_NEWNET | os.CLONE_NEWIPC | os.CLONE_NEWUTS
        os.unshare(flags)
        with open("/proc/self/setgroups", "w", encoding="utf-8") as handle:
            handle.write("deny")
        with open("/proc/self/uid_map", "w", encoding="utf-8") as handle:
            handle.write(f"0 {uid} 1\n")
        with open("/proc/self/gid_map", "w", encoding="utf-8") as handle:
            handle.write(f"0 {gid} 1\n")
        _mount(None, "/", None, MS_REC | MS_PRIVATE)
        _mount("tmpfs", str(jail), "tmpfs", MS_NOSUID | MS_NODEV, "size=512m")
        _stage_runtime(jail, command)
        for name in ("work", "tmp", "oldroot", "dev"):
            (jail / name).mkdir(exist_ok=True)
        _mount("tmpfs", str(jail / "tmp"), "tmpfs", MS_NOSUID | MS_NODEV | MS_NOEXEC, "size=64m")
        _mount(str(workspace), str(jail / "work"), None, MS_BIND)
        for device in ("null", "zero", "urandom"):
            target = jail / "dev" / device
            target.touch()
            _mount(f"/dev/{device}", str(target), None, MS_BIND)
        _remount_readonly(jail / "usr")
        os.chdir(jail)
        result = _LIBC.syscall(PIVOT_ROOT[machine], b".", b"oldroot")
        if result != 0:
            err = ctypes.get_errno()
            raise JailError(f"pivot_root failed: {os.strerror(err)}")
        os.chroot(".")
        os.chdir("/")
        if _LIBC.umount2(b"/oldroot", MNT_DETACH) != 0:
            err = ctypes.get_errno()
            raise JailError(f"umount of old root failed: {os.strerror(err)}")
        os.rmdir("/oldroot")
        os.chdir("/work")
        _LIBC.prctl(PR_SET_NO_NEW_PRIVS, 1, 0, 0, 0)
        env = {
            "PATH": "/usr/bin:/bin",
            "HOME": "/tmp",
            "TMPDIR": "/tmp",
            "PYTHONDONTWRITEBYTECODE": "1",
        }
        os.execve(command[0], command, env)
    except JailError:
        raise
    except OSError as exc:
        raise JailError(str(exc)) from exc


def main(argv: list[str] | None = None) -> int:
    args = list(sys.argv[1:] if argv is None else argv)
    if "--" not in args or "--workspace" not in args:
        print("usage: python -m idlehand.jail --workspace PATH -- COMMAND...", file=sys.stderr)
        return 2
    split = args.index("--")
    options = args[:split]
    command = args[split + 1 :]
    if not command:
        print("idlehand-sandbox-setup: missing command", file=sys.stderr)
        return 97
    try:
        workspace_flag = options.index("--workspace")
        workspace = Path(options[workspace_flag + 1])
    except (ValueError, IndexError):
        print("idlehand-sandbox-setup: missing workspace", file=sys.stderr)
        return 97
    try:
        enter_and_exec(workspace, command)
    except JailError as exc:
        print(f"idlehand-sandbox-setup: {exc}", file=sys.stderr)
        return 97
    print("idlehand-sandbox-setup: exec returned", file=sys.stderr)
    return 96


if __name__ == "__main__":
    raise SystemExit(main())
