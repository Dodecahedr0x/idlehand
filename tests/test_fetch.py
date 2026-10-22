import os
import stat
from pathlib import Path

from fossah.fetch import classify_clone_url, clone_repository, git_env, redact_clone_url


def test_classify_refuses_ssh_and_embedded_credentials() -> None:
    refused = {
        "": "empty",
        "git@github.com:org/repo.git": "SSH",
        "ssh://git@github.com/org/repo.git": "SSH",
        "git://github.com/org/repo.git": "SSH",
        "https://user:secret@github.com/org/repo.git": "credentials",
        "https://github.com/org/repo.git?access_token=sekret": "credentials",
        "https://github.com/only-one-segment": "not a git repository",
        "https://github.com": "not a git repository",
        "relative/repo": "not a public git URL",
    }
    for url, snippet in refused.items():
        allowed, reason = classify_clone_url(url)
        assert allowed is None
        assert snippet in reason


def test_fragment_credentials_are_refused_and_redacted() -> None:
    refused = classify_clone_url("https://github.com/org/repo.git#access_token=sekret")
    assert refused == (None, "repository URL embeds credentials")
    shown = redact_clone_url("https://github.com/org/repo.git#access_token=sekret")
    assert "sekret" not in shown
    assert shown == "https://github.com/org/repo.git"
    kept, _reason = classify_clone_url("https://github.com/org/repo.git#readme")
    assert kept == "https://github.com/org/repo.git#readme"
    assert redact_clone_url("https://github.com/org/repo.git#readme") == "https://github.com/org/repo.git#readme"


def test_redact_clone_url_strips_userinfo_and_token_query() -> None:
    from fossah.fetch import redact_clone_url

    assert redact_clone_url("https://user:secret@github.com/org/repo.git") == "https://github.com/org/repo.git"
    assert redact_clone_url("https://user:secret@[::1]:443/fossah/publish") == "https://[::1]:443/fossah/publish"
    assert "sekret" not in redact_clone_url("https://github.com/org/repo.git?access_token=sekret")
    assert redact_clone_url("file:///tmp/repo") == "file:///tmp/repo"
    assert redact_clone_url("https://github.com/org/repo.git") == "https://github.com/org/repo.git"


def test_classify_allows_public_and_configured_local_urls() -> None:
    allowed, reason = classify_clone_url("https://github.com/org/repo.git")
    assert allowed == "https://github.com/org/repo.git"
    assert reason == "public clone"
    local, local_reason = classify_clone_url("file:///tmp/repo")
    assert local == "file:///tmp/repo"
    assert "local" in local_reason
    absolute, _ = classify_clone_url("/tmp/repo")
    assert absolute == "/tmp/repo"


def test_credential_url_does_not_call_git(tmp_path: Path) -> None:
    marker = tmp_path / "git-was-called"
    git = tmp_path / "git"
    git.write_text(f"#!/bin/sh\ntouch '{marker}'\nexit 1\n", encoding="utf-8")
    git.chmod(git.stat().st_mode | stat.S_IEXEC)
    result = clone_repository(
        "https://user:secret@github.com/org/repo.git",
        tmp_path / "work",
        git_executable=str(git),
    )
    assert result.cloned is False
    assert "credentials" in result.reason
    assert not marker.exists()


def test_git_environment_drops_home_and_credentials(tmp_path: Path, monkeypatch) -> None:
    monkeypatch.setenv("ANTHROPIC_API_KEY", "sk-test")
    monkeypatch.setenv("GH_TOKEN", "gh-test")
    monkeypatch.setenv("HOME", "/tmp/should-not-leak")
    recorded = tmp_path / "env"
    cwd_file = tmp_path / "cwd"
    git = tmp_path / "git"
    git.write_text(
        "#!/bin/sh\n"
        f"env > '{recorded}'\n"
        f"pwd > '{cwd_file}'\n"
        "exit 1\n",
        encoding="utf-8",
    )
    git.chmod(git.stat().st_mode | stat.S_IEXEC)
    result = clone_repository(
        "https://github.com/org/repo.git",
        tmp_path / "work",
        git_executable=str(git),
    )
    assert result.cloned is False
    text = recorded.read_text(encoding="utf-8")
    assert "ANTHROPIC_API_KEY" not in text
    assert "GH_TOKEN" not in text
    assert "sk-test" not in text
    assert "HOME=/tmp/should-not-leak" not in text
    assert "GIT_CONFIG_GLOBAL=/dev/null" in text
    assert "GIT_TERMINAL_PROMPT=0" in text
    assert "SSH_AUTH_SOCK=" in text
    cwd = cwd_file.read_text(encoding="utf-8").strip()
    assert cwd != str(Path.home())
    assert "fossah-fetch-" in cwd
    assert not Path(cwd).exists()
    dumped = git_env(tmp_path / "empty")
    assert "ANTHROPIC_API_KEY" not in dumped
    assert os.environ["ANTHROPIC_API_KEY"] == "sk-test"


def test_public_clone_argv_disables_credentials_and_file_protocol(tmp_path: Path) -> None:
    argv_file = tmp_path / "argv"
    git = tmp_path / "git"
    git.write_text(
        "#!/bin/sh\n"
        f"printf '%s\\n' \"$@\" > '{argv_file}'\n"
        "exit 1\n",
        encoding="utf-8",
    )
    git.chmod(git.stat().st_mode | stat.S_IEXEC)
    clone_repository(
        "https://github.com/org/repo.git",
        tmp_path / "work",
        git_executable=str(git),
    )
    argv = argv_file.read_text(encoding="utf-8").splitlines()
    assert "credential.helper=" in argv
    assert "protocol.file.allow=always" not in argv
    assert "--depth" in argv
    assert "1" in argv
    assert argv[-2] == "https://github.com/org/repo.git"


def test_clone_timeout_removes_a_partial_workspace(tmp_path: Path) -> None:
    git = tmp_path / "git"
    git.write_text(
        "#!/usr/bin/python3\n"
        "import sys\n"
        "import time\n"
        "from pathlib import Path\n"
        "args = sys.argv[1:]\n"
        "dest = Path(args[args.index('--') + 2])\n"
        "dest.mkdir(parents=True)\n"
        "(dest / 'partial').write_text('partial', encoding='utf-8')\n"
        "time.sleep(5)\n",
        encoding="utf-8",
    )
    git.chmod(git.stat().st_mode | stat.S_IEXEC)
    workspace = tmp_path / "workspaces" / "repo"
    result = clone_repository(
        "https://github.com/org/repo.git",
        workspace,
        git_executable=str(git),
        timeout=0.2,
    )
    assert result.cloned is False
    assert result.reason == "clone timed out"
    assert not workspace.exists()


def test_symlink_workspace_is_not_replaced(tmp_path: Path) -> None:
    outside = tmp_path / "outside"
    outside.mkdir()
    (outside / "keep").write_text("safe", encoding="utf-8")
    called = tmp_path / "called"
    git = tmp_path / "git"
    git.write_text(f"#!/bin/sh\ntouch '{called}'\nexit 1\n", encoding="utf-8")
    git.chmod(git.stat().st_mode | stat.S_IEXEC)
    workspace = tmp_path / "workspaces" / "slug"
    workspace.parent.mkdir()
    workspace.symlink_to(outside)
    result = clone_repository(
        "https://github.com/org/repo.git",
        workspace,
        git_executable=str(git),
    )
    assert result.cloned is False
    assert "symlink" in result.reason
    assert not called.exists()
    assert (outside / "keep").read_text(encoding="utf-8") == "safe"
    parent = tmp_path / "linked-parent"
    parent.symlink_to(outside)
    parent_result = clone_repository(
        "https://github.com/org/repo.git",
        parent / "slug",
        git_executable=str(git),
    )
    assert parent_result.cloned is False
    assert "symlink" in parent_result.reason
    assert not called.exists()
    assert not (outside / "slug").exists()


def test_replacing_a_workspace_does_not_delete_through_an_internal_symlink(tmp_path: Path) -> None:
    from tests.support import SAMPLE_FILES, make_repo

    outside = tmp_path / "outside"
    outside.mkdir()
    marker = outside / "keep.txt"
    marker.write_text("keep", encoding="utf-8")
    workspace = tmp_path / "workspaces" / "sample"
    workspace.mkdir(parents=True)
    (workspace / "leak").symlink_to(outside)
    result = clone_repository(make_repo(tmp_path / "repo", SAMPLE_FILES), workspace)
    assert result.cloned is True
    assert marker.read_text(encoding="utf-8") == "keep"
    assert outside.is_dir()
    assert not (outside / ".git").exists()


def test_successful_exit_without_git_dir_is_not_a_clone(tmp_path: Path) -> None:
    git = tmp_path / "git"
    git.write_text(
        "#!/usr/bin/python3\n"
        "import sys\n"
        "from pathlib import Path\n"
        "args = sys.argv[1:]\n"
        "dest = Path(args[args.index('--') + 2])\n"
        "dest.mkdir(parents=True)\n"
        "(dest / 'readme').write_text('no git dir', encoding='utf-8')\n",
        encoding="utf-8",
    )
    git.chmod(git.stat().st_mode | stat.S_IEXEC)
    workspace = tmp_path / "workspaces" / "empty"
    result = clone_repository(
        "https://github.com/org/repo.git",
        workspace,
        git_executable=str(git),
    )
    assert result.cloned is False
    assert not workspace.exists()


def test_clone_ignores_a_global_gitconfig(tmp_path: Path, monkeypatch) -> None:
    from tests.support import SAMPLE_FILES, make_repo

    marker = tmp_path / "hook-ran"
    hooks = tmp_path / "hooks"
    hooks.mkdir()
    post = hooks / "post-checkout"
    post.write_text(f"#!/bin/sh\ntouch '{marker}'\n", encoding="utf-8")
    post.chmod(post.stat().st_mode | stat.S_IEXEC)
    gitconfig = tmp_path / "gitconfig"
    gitconfig.write_text(f"[core]\n\thooksPath = {hooks}\n", encoding="utf-8")
    monkeypatch.setenv("GIT_CONFIG_GLOBAL", str(gitconfig))
    monkeypatch.setenv("HOME", str(Path.home()))
    url = make_repo(tmp_path / "sample", SAMPLE_FILES)
    result = clone_repository(url, tmp_path / "workspaces" / "sample")
    assert result.cloned is True
    assert not marker.exists()


def test_absolute_local_path_clones_and_a_relative_path_does_not(tmp_path: Path) -> None:
    from tests.support import SAMPLE_FILES, make_repo

    make_repo(tmp_path / "sample", SAMPLE_FILES)
    cloned = clone_repository(str((tmp_path / "sample").resolve()), tmp_path / "workspaces" / "abs")
    assert cloned.cloned is True
    refused = clone_repository("relative/repo", tmp_path / "workspaces" / "rel")
    assert refused.cloned is False
    assert "not a public git URL" in refused.reason
    assert not (tmp_path / "workspaces" / "rel").exists()


def test_publish_document_redacts_embedded_credentials() -> None:
    import json

    from fossah.peers import publish_document

    document = publish_document(
        node_id="n",
        listen_url="http://127.0.0.1:9/fossah/publish",
        peers=[{"url": "https://user:secret@peer.example/fossah/publish", "id": "p"}],
        repos=[{"url": "https://github.com/org/repo.git?access_token=sekret"}],
    )
    blob = json.dumps(document)
    assert "secret" not in blob
    assert "sekret" not in blob
    assert document["repos"] == [{"url": "https://github.com/org/repo.git"}]
    assert document["peers"] == [{"url": "https://peer.example/fossah/publish", "id": "p"}]


def test_publish_body_does_not_include_trust_or_ledger(tmp_path: Path) -> None:
    import json
    import threading
    import urllib.error
    import urllib.request
    from http.server import ThreadingHTTPServer

    from fossah.home import write_json
    from fossah.publish import PublishHandler

    home = tmp_path / "home"
    home.mkdir()
    write_json(
        home / "publish.json",
        {"fossah": 1, "peers": [], "repos": [{"url": "https://github.com/org/name"}]},
    )
    write_json(home / "trust.json", [{"subject": "secret-decision", "reason": "hidden"}])
    write_json(home / "state.json", {"ledger": {"metered_tokens": 99}, "subscription": {"binary": "claude"}})
    server = ThreadingHTTPServer(("127.0.0.1", 0), PublishHandler)
    server.publish_file = str(home / "publish.json")  # type: ignore[attr-defined]
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    port = server.server_address[1]
    try:
        with urllib.request.urlopen(f"http://127.0.0.1:{port}/fossah/publish", timeout=2) as response:
            body = response.read().decode("utf-8")
        try:
            urllib.request.urlopen(f"http://127.0.0.1:{port}/trust.json", timeout=2)
            missing_code = 200
        except urllib.error.HTTPError as exc:
            missing_code = exc.code
    finally:
        server.shutdown()
        server.server_close()
    payload = json.loads(body)
    assert payload["fossah"] == 1
    assert "secret-decision" not in body
    assert "metered_tokens" not in body
    assert missing_code == 404


def test_local_clone_and_non_repo(tmp_path: Path) -> None:
    from tests.support import SAMPLE_FILES, make_repo

    url = make_repo(tmp_path / "sample", SAMPLE_FILES)
    workspace = tmp_path / "workspaces" / "sample"
    result = clone_repository(url, workspace)
    assert result.cloned is True
    assert (workspace / "sample.py").is_file()
    assert (workspace / ".git").exists()
    plain = tmp_path / "plain"
    plain.mkdir()
    (plain / "readme.txt").write_text("nope", encoding="utf-8")
    missed = clone_repository(plain.resolve().as_uri(), tmp_path / "workspaces" / "plain")
    assert missed.cloned is False
    assert not (tmp_path / "workspaces" / "plain").exists()
