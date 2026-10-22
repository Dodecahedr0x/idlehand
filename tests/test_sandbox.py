import os
from pathlib import Path

from fossah.sandbox import build_bwrap_argv, build_container_argv, run, run_namespace


def test_namespace_hides_home_credentials_and_network(tmp_path: Path, monkeypatch) -> None:
    secret = tmp_path / "secret.txt"
    secret.write_text("topsecret", encoding="utf-8")
    workspace = tmp_path / "work"
    workspace.mkdir()
    (workspace / "marker.txt").write_text("workspace\n", encoding="utf-8")
    monkeypatch.setenv("ANTHROPIC_API_KEY", "sk-test-secret")
    monkeypatch.setenv("GH_TOKEN", "gh-secret")
    code = f"""
import os, pathlib, socket
print("MARKER", pathlib.Path("/work/marker.txt").read_text().strip())
print("HOME_DIR", pathlib.Path("/home").exists())
print("ETC", pathlib.Path("/etc").exists())
print("SECRET_ENV", "ANTHROPIC_API_KEY" in os.environ or "GH_TOKEN" in os.environ)
print("HOST_SECRET", pathlib.Path({str(secret)!r}).exists())
print("ROOT", ",".join(sorted(os.listdir("/"))))
try:
    pathlib.Path("/usr/bin/pwned-fossah").write_text("x")
    print("USR_WRITE", "yes")
except Exception as exc:
    print("USR_WRITE", type(exc).__name__)
sock = socket.socket()
sock.settimeout(1)
try:
    sock.connect(("1.1.1.1", 80))
    print("NET", "yes")
except Exception as exc:
    print("NET", type(exc).__name__)
pathlib.Path("/work/out.txt").write_text("ok\\n", encoding="utf-8")
print("fossah-sandbox-ok")
"""
    result = run_namespace(workspace, ["/usr/bin/python3", "-c", code])
    assert result.ok, result.stderr
    assert "MARKER workspace" in result.stdout
    assert "HOME_DIR False" in result.stdout
    assert "ETC False" in result.stdout
    assert "SECRET_ENV False" in result.stdout
    assert "HOST_SECRET False" in result.stdout
    assert "sk-test-secret" not in result.stdout
    assert "USR_WRITE yes" not in result.stdout
    assert "NET yes" not in result.stdout
    assert "fossah-sandbox-ok" in result.stdout
    assert (workspace / "out.txt").read_text(encoding="utf-8") == "ok\n"
    assert not Path("/usr/bin/pwned-fossah").exists()
    assert secret.read_text(encoding="utf-8") == "topsecret"


def test_symlink_workspace_is_not_mounted(tmp_path: Path) -> None:
    outside = tmp_path / "outside"
    outside.mkdir()
    marker = outside / "keep.txt"
    marker.write_text("keep", encoding="utf-8")
    link = tmp_path / "work"
    link.symlink_to(outside)
    result = run(
        link,
        ["/usr/bin/python3", "-c", "open('/work/keep.txt','w').write('changed')"],
        runtime="namespace",
    )
    assert result.invoked is False
    assert "symlink" in result.reason
    assert marker.read_text(encoding="utf-8") == "keep"


def test_missing_workspace_does_not_run_on_the_host(tmp_path: Path) -> None:
    sentinel = tmp_path / "sentinel"
    result = run(
        tmp_path / "missing",
        ["/usr/bin/python3", "-c", f"open(r'{sentinel}', 'w').write('x')"],
        runtime="namespace",
    )
    assert result.ok is False
    assert not sentinel.exists()


def test_runtime_none_refuses_the_host(tmp_path: Path) -> None:
    workspace = tmp_path / "work"
    sentinel = tmp_path / "sentinel"
    result = run(
        workspace,
        ["/usr/bin/python3", "-c", f"open(r'{sentinel}', 'w').write('x')"],
        runtime="none",
    )
    assert result.invoked is False
    assert "refused" in result.reason
    assert not sentinel.exists()


def test_command_outside_usr_or_workspace_is_refused(tmp_path: Path) -> None:
    workspace = tmp_path / "work"
    workspace.mkdir()
    outside = tmp_path / "evil"
    outside.write_text("#!/bin/sh\necho no\n", encoding="utf-8")
    outside.chmod(0o755)
    result = run_namespace(workspace, [str(outside)])
    assert result.invoked is False
    assert not (workspace / "sandbox-ok.txt").exists()


def test_container_argv_mounts_only_the_workspace(tmp_path: Path) -> None:
    workspace = tmp_path / "work"
    workspace.mkdir()
    argv = build_container_argv(
        "docker",
        workspace,
        ["python", "-c", "print(1)"],
        image="python:3.12-slim",
        memory="512m",
        cpus="1",
    )
    text = " ".join(argv)
    assert "--network" in argv and "none" in argv
    assert "--cap-drop" in argv and "ALL" in argv
    assert "no-new-privileges" in text
    assert "--privileged" not in argv
    assert "docker.sock" not in text
    assert "--env-file" not in argv
    mounts = [part for part in argv if part.startswith("type=bind,source=")]
    assert mounts == [f"type=bind,source={workspace.resolve()},target=/work"]
    assert f"source={Path.home()}" not in text
    env_flags = [argv[index + 1] for index, part in enumerate(argv) if part == "-e"]
    assert env_flags == ["HOME=/tmp", "TMPDIR=/tmp", "PATH=/usr/local/bin:/usr/bin:/bin"]


def test_bwrap_argv_does_not_bind_home(tmp_path: Path) -> None:
    workspace = tmp_path / "work"
    workspace.mkdir()
    argv = build_bwrap_argv(workspace, ["/usr/bin/python3", "-c", "print(1)"])
    binds: list[str] = []
    for index, part in enumerate(argv):
        if part in {"--bind", "--ro-bind"}:
            binds.append(argv[index + 1])
    assert "/usr" in binds
    assert str(workspace.resolve()) in binds
    assert str(Path.home()) not in binds
    assert "--clearenv" in argv


def test_fake_docker_is_not_asked_to_run_on_the_host(tmp_path: Path, monkeypatch) -> None:
    bin_dir = tmp_path / "bin"
    bin_dir.mkdir()
    log = tmp_path / "docker-args"
    script = bin_dir / "docker"
    script.write_text(f"#!/bin/sh\nprintf '%s\\n' \"$@\" > '{log}'\n", encoding="utf-8")
    script.chmod(0o755)
    monkeypatch.setenv("PATH", f"{bin_dir}{os.pathsep}/usr/bin:/bin")
    sentinel = tmp_path / "inner-ran"
    workspace = tmp_path / "work"
    result = run(
        workspace,
        ["/usr/bin/python3", "-c", f"open(r'{sentinel}', 'w').write('x')"],
        runtime="docker",
    )
    assert result.ok, result.stderr
    assert not sentinel.exists()
    recorded = log.read_text(encoding="utf-8")
    assert "none" in recorded
    assert str(workspace.resolve()) in recorded
    assert "docker.sock" not in recorded
