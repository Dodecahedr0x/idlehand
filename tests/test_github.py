import hashlib
import json
from pathlib import Path

from idlehand.analytics import render_text
from idlehand.cli import main
from idlehand.config import ensure_home, save_sources
from idlehand.forge import forge_for, registered_forges
from idlehand.loop import tick
from idlehand.peers import publish_document


def _gh(tmp_path: Path, monkeypatch, body: str) -> Path:
    log = tmp_path / "gh-args"
    bin_dir = tmp_path / "bin"
    bin_dir.mkdir()
    script = bin_dir / "gh"
    script.write_text(body.replace("__LOG__", str(log)), encoding="utf-8")
    script.chmod(0o755)
    monkeypatch.setenv("PATH", f"{bin_dir}:/usr/bin:/bin")
    monkeypatch.setenv("GH_TOKEN", "gho_supersecrettoken")
    return log


_LOGGED_IN = """#!/bin/sh
printf '%s\\n' "$*" >> '__LOG__'
if [ "$1" = "api" ]; then
  for arg in "$@"; do
    if [ "$arg" = "user" ]; then
      printf '%s\\n' octocat
      exit 0
    fi
    case "$arg" in
      *user/repos*)
        printf '%s\\n' '{"full_name":"octocat/hello","owner":"octocat","admin":true}'
        printf '%s\\n' '{"full_name":"acme/tools","owner":"acme","admin":true}'
        printf '%s\\n' '{"full_name":"acme/read","owner":"acme","admin":false}'
        exit 0
        ;;
    esac
  done
  exit 1
fi
prev=""
for arg in "$@"; do
  if [ "$prev" = "--body-file" ]; then
    printf '%s\\n' "BODY" >> '__LOG__'
    cat "$arg" >> '__LOG__'
  fi
  prev="$arg"
done
if [ "$1" = "issue" ] && [ "$2" = "create" ]; then
  printf '%s\\n' 'https://github.com/octocat/hello/issues/7'
  exit 0
fi
if [ "$1" = "issue" ] && [ "$2" = "edit" ]; then
  printf '%s\\n' 'https://github.com/octocat/hello/issues/7'
  exit 0
fi
if [ "$1" = "pr" ] && [ "$2" = "create" ]; then
  printf '%s\\n' 'https://github.com/octocat/hello/pull/4'
  exit 0
fi
if [ "$1" = "pr" ] && [ "$2" = "edit" ]; then
  exit 0
fi
exit 1
"""


def test_only_github_is_registered() -> None:
    assert registered_forges() == ("github",)
    assert forge_for("github") is not None
    assert forge_for("gitlab") is None


def test_missing_gh_does_not_delegate(tmp_path: Path, monkeypatch, capsys) -> None:
    empty = tmp_path / "empty-bin"
    empty.mkdir()
    monkeypatch.setenv("PATH", str(empty))
    home = tmp_path / "home"
    assert main(["--home", str(home), "github", "status"]) == 1
    assert main(["--home", str(home), "github", "delegate", "octocat/hello"]) == 1
    captured = capsys.readouterr()
    assert "gh is not installed" in captured.err
    assert "delegated" not in captured.out
    assert not (home / "delegated.toml").exists()


def test_logged_out_gh_does_not_delegate_or_send(tmp_path: Path, monkeypatch, capsys) -> None:
    log = _gh(tmp_path, monkeypatch, "#!/bin/sh\nprintf '%s\\n' \"$*\" >> '__LOG__'\nexit 1\n")
    home = tmp_path / "home"
    assert main(["--home", str(home), "github", "status"]) == 1
    assert main(["--home", str(home), "github", "repos"]) == 1
    assert main(["--home", str(home), "github", "delegate", "octocat/hello"]) == 1
    assert main(["--home", str(home), "github", "issue", "create", "octocat/hello", "--title", "T", "--body", "B"]) == 1
    captured = capsys.readouterr()
    assert "gh is not logged in" in captured.err
    assert "created issue" not in captured.out
    assert "delegated octocat/hello" not in captured.out
    assert not (home / "delegated.toml").exists()
    assert "issue create" not in log.read_text(encoding="utf-8")


def test_list_does_not_delegate_and_delegate_is_one_repo(tmp_path: Path, monkeypatch, capsys) -> None:
    _gh(tmp_path, monkeypatch, _LOGGED_IN)
    home = tmp_path / "home"
    assert main(["--home", str(home), "github", "status"]) == 0
    assert main(["--home", str(home), "github", "repos"]) == 0
    assert not (home / "delegated.toml").exists()
    listed = capsys.readouterr().out
    assert "octocat/hello  owner" in listed
    assert "acme/tools  admin" in listed
    assert "acme/read" not in listed
    assert main(["--home", str(home), "github", "delegate", "https://github.com/acme/tools.git"]) == 0
    assert main(["--home", str(home), "github", "delegate", "acme/read"]) == 1
    text = (home / "delegated.toml").read_text(encoding="utf-8")
    assert text.count("[[repos]]") == 1
    assert 'repo = "acme/tools"' in text
    assert "acme/read" not in text
    assert "gho_supersecrettoken" not in text
    refused = capsys.readouterr()
    assert "not owned or administered" in refused.err
    assert main(["--home", str(home), "github", "delegate", "acme/tools"]) == 0
    assert "already delegated" in capsys.readouterr().out
    assert (home / "delegated.toml").read_text(encoding="utf-8").count("[[repos]]") == 1


def test_management_requires_delegation_and_confirmation(tmp_path: Path, monkeypatch, capsys) -> None:
    log = _gh(tmp_path, monkeypatch, _LOGGED_IN)
    home = tmp_path / "home"
    assert main(["--home", str(home), "github", "issue", "create", "octocat/hello", "--title", "T", "--body", "B"]) == 1
    assert "not delegated" in capsys.readouterr().err
    assert not log.exists()
    assert main(["--home", str(home), "github", "delegate", "octocat/hello"]) == 0
    log.write_text("", encoding="utf-8")
    assert main(["--home", str(home), "github", "issue", "create", "octocat/hello", "--title", "Broken link", "--body", "The README link 404s."]) == 0
    created = capsys.readouterr().out
    assert "created issue on octocat/hello: https://github.com/octocat/hello/issues/7" in created
    recorded = log.read_text(encoding="utf-8")
    assert "issue create --repo octocat/hello --title Broken link" in recorded
    assert "The README link 404s." in recorded
    assert "gho_supersecrettoken" not in recorded
    assert "--push" not in recorded
    log.write_text("", encoding="utf-8")
    assert main(["--home", str(home), "github", "issue", "update", "octocat/hello", "7", "--body", "Still broken."]) == 0
    assert "updated issue 7 on octocat/hello" in capsys.readouterr().out
    assert "issue edit 7 --repo octocat/hello" in log.read_text(encoding="utf-8")
    log.write_text("", encoding="utf-8")
    assert (
        main(
            [
                "--home",
                str(home),
                "github",
                "pr",
                "create",
                "octocat/hello",
                "--title",
                "Fix the link",
                "--body",
                "Updates the README.",
                "--head",
                "fix-link",
                "--base",
                "main",
            ]
        )
        == 0
    )
    assert "created pull request on octocat/hello: https://github.com/octocat/hello/pull/4" in capsys.readouterr().out
    pr_log = log.read_text(encoding="utf-8")
    assert "pr create --repo octocat/hello --title Fix the link --head fix-link --base main" in pr_log
    assert "--push" not in pr_log
    assert "Updates the README." in pr_log
    log.write_text("", encoding="utf-8")
    assert main(["--home", str(home), "github", "pr", "update", "octocat/hello", "4", "--title", "Fix the link"]) == 0
    assert "updated pull request 4 on octocat/hello" in capsys.readouterr().out
    assert "pr edit 4 --repo octocat/hello --title Fix the link" in log.read_text(encoding="utf-8")


def test_local_draft_is_sent_only_for_a_delegated_repo(tmp_path: Path, monkeypatch, capsys) -> None:
    log = _gh(tmp_path, monkeypatch, _LOGGED_IN)
    home = tmp_path / "home"
    ensure_home(home)
    url = "https://github.com/octocat/hello.git"
    save_sources(home, [{"url": url, "note": "local"}])
    slug = hashlib.sha256(url.encode()).hexdigest()[:16]
    draft = home / "drafts" / slug
    draft.mkdir(parents=True)
    (draft / "issue-draft.md").write_text(
        "# Broken link in the README\n\nThe README link 404s.\n",
        encoding="utf-8",
    )
    (draft / "pr-draft.md").write_text(
        "# Fix the link\n\nUpdates the README.\n",
        encoding="utf-8",
    )
    assert main(["--home", str(home), "github", "issue", "send", "octocat/hello"]) == 1
    assert "not delegated" in capsys.readouterr().err
    assert not log.exists()
    assert main(["--home", str(home), "github", "delegate", "octocat/hello"]) == 0
    log.write_text("", encoding="utf-8")
    assert main(["--home", str(home), "github", "issue", "send", "octocat/hello"]) == 0
    sent = log.read_text(encoding="utf-8")
    assert "issue create --repo octocat/hello --title Broken link in the README" in sent
    assert "The README link 404s." in sent
    assert "created issue" in capsys.readouterr().out
    log.write_text("", encoding="utf-8")
    assert main(["--home", str(home), "github", "pr", "send", "octocat/hello", "--head", "fix-link"]) == 0
    assert "pr create --repo octocat/hello --title Fix the link --head fix-link" in log.read_text(encoding="utf-8")
    assert "--push" not in log.read_text(encoding="utf-8")


def test_unconfirmed_gh_does_not_count_as_sent(tmp_path: Path, monkeypatch, capsys) -> None:
    home = tmp_path / "home"
    delegated = home / "delegated.toml"
    delegated.parent.mkdir(parents=True)
    delegated.write_text('[[repos]]\nprovider = "github"\nrepo = "octocat/hello"\n', encoding="utf-8")
    script = """#!/bin/sh
printf '%s\\n' "$*" >> '__LOG__'
if [ "$1" = "api" ]; then
  for arg in "$@"; do
    if [ "$arg" = "user" ]; then
      printf '%s\\n' octocat
      exit 0
    fi
    case "$arg" in
      *user/repos*)
        printf '%s\\n' '{"full_name":"octocat/hello","owner":"octocat","admin":true}'
        exit 0
        ;;
    esac
  done
fi
printf '%s\\n' 'token=sekret gho_abcdefghijklmnopqrstuvwxyz' >&2
exit 1
"""
    _gh(tmp_path, monkeypatch, script)
    assert main(["--home", str(home), "github", "issue", "create", "octocat/hello", "--title", "T", "--body", "B"]) == 1
    captured = capsys.readouterr()
    assert "created issue" not in captured.out
    assert "did not confirm" in captured.err
    assert "sekret" not in captured.err
    assert "gho_" not in captured.err
    assert "gho_supersecrettoken" not in delegated.read_text(encoding="utf-8")


def test_credentials_stay_out_of_analytics_publish_and_the_loop(tmp_path: Path, monkeypatch) -> None:
    log = _gh(tmp_path, monkeypatch, _LOGGED_IN)
    home = tmp_path / "home"
    assert main(["--home", str(home), "github", "delegate", "octocat/hello"]) == 0
    text = render_text(home)
    assert "delegated: 1" in text
    assert "github octocat/hello" in text
    assert "gho_supersecrettoken" not in text
    document = publish_document(node_id="n", listen_url="http://127.0.0.1:9/idlehand/publish", peers=[], repos=[])
    assert "gho_" not in json.dumps(document)
    assert "delegated" not in document
    log.write_text("", encoding="utf-8")
    tick(home)
    assert log.read_text(encoding="utf-8") == ""
    blob = "\n".join(path.read_text(encoding="utf-8") for path in home.rglob("*") if path.is_file())
    assert "gho_supersecrettoken" not in blob


def test_revoke_and_a_symlinked_delegation_file(tmp_path: Path, monkeypatch, capsys) -> None:
    log = _gh(tmp_path, monkeypatch, _LOGGED_IN)
    home = tmp_path / "home"
    assert main(["--home", str(home), "github", "delegate", "octocat/hello"]) == 0
    assert main(["--home", str(home), "github", "revoke", "octocat/hello"]) == 0
    assert "revoked octocat/hello" in capsys.readouterr().out
    assert "octocat/hello" not in (home / "delegated.toml").read_text(encoding="utf-8")
    log.write_text("", encoding="utf-8")
    assert main(["--home", str(home), "github", "issue", "create", "octocat/hello", "--title", "T", "--body", "B"]) == 1
    assert not log.exists() or "issue create" not in log.read_text(encoding="utf-8")
    outside = tmp_path / "outside.toml"
    outside.write_text('repo = "token=sekret"\n', encoding="utf-8")
    link = home / "delegated.toml"
    link.unlink()
    link.symlink_to(outside)
    assert main(["--home", str(home), "github", "delegate", "acme/tools"]) == 1
    assert "unreadable" in capsys.readouterr().err
    assert outside.read_text(encoding="utf-8") == 'repo = "token=sekret"\n'
    assert "sekret" not in render_text(home)


def test_a_bad_branch_and_a_private_key_draft_are_not_sent(tmp_path: Path, monkeypatch, capsys) -> None:
    log = _gh(tmp_path, monkeypatch, _LOGGED_IN)
    home = tmp_path / "home"
    assert main(["--home", str(home), "github", "delegate", "octocat/hello"]) == 0
    log.write_text("", encoding="utf-8")
    assert (
        main(
            [
                "--home",
                str(home),
                "github",
                "pr",
                "create",
                "octocat/hello",
                "--title",
                "T",
                "--body",
                "B",
                "--head",
                "../main",
            ]
        )
        == 1
    )
    assert "unreadable" in capsys.readouterr().err
    assert "pr create" not in log.read_text(encoding="utf-8")
    url = "https://github.com/octocat/hello"
    slug = hashlib.sha256(url.encode()).hexdigest()[:16]
    draft = home / "drafts" / slug
    draft.mkdir(parents=True)
    (draft / "issue-draft.md").write_text("# Key\n\nBEGIN PRIVATE KEY\nsecret\n", encoding="utf-8")
    assert main(["--home", str(home), "github", "issue", "send", "octocat/hello"]) == 1
    assert "private key" in capsys.readouterr().err
    assert "issue create" not in log.read_text(encoding="utf-8")
