"""Commands that run inside the sandbox against a cloned repository.

Each command is a Python program. The jail has no network, no home, and no
credentials. These commands prepare local results. They do not push.
"""

from __future__ import annotations

TEST_SCRIPT = """
import pathlib, sys, unittest
root = pathlib.Path("/work")
syntax_errors = 0
for path in root.rglob("*.py"):
    if path.is_symlink() or any(part in {".git", ".fossah"} for part in path.parts):
        continue
    try:
        compile(path.read_text(encoding="utf-8", errors="replace"), str(path), "exec")
    except SyntaxError as exc:
        syntax_errors += 1
        print(f"syntax {path.relative_to(root)}: {exc}")
    except OSError:
        continue
print(f"syntax_errors={syntax_errors}")
suite = unittest.defaultTestLoader.discover("/work", pattern="test*.py", top_level_dir="/work")
result = unittest.TextTestRunner(verbosity=1).run(suite)
print(f"tests_run={result.testsRun}")
print("fossah-action=test")
sys.exit(0 if syntax_errors == 0 and result.wasSuccessful() else 1)
"""

AUDIT_SCRIPT = """
import pathlib, sys
root = pathlib.Path("/work")
findings = []
files = 0
for path in root.rglob("*"):
    if path.is_symlink() or not path.is_file() or any(part in {".git", ".fossah"} for part in path.parts):
        continue
    files += 1
    try:
        if path.stat().st_size > 1_000_000:
            continue
        text = path.read_text(encoding="utf-8", errors="ignore")
    except OSError:
        continue
    markers = (
        "BEGIN PRIVATE KEY",
        "BEGIN RSA PRIVATE KEY",
        "BEGIN OPENSSH PRIVATE KEY",
        "BEGIN EC PRIVATE KEY",
        "BEGIN DSA PRIVATE KEY",
    )
    if any(marker in text for marker in markers):
        findings.append(f"private key material in {path.relative_to(root)}")
out = root / ".fossah"
body = [f"files={files}", f"findings={len(findings)}", *findings]
if not out.is_symlink():
    try:
        if out.exists() and not out.is_dir():
            raise OSError("not a directory")
        out.mkdir(exist_ok=True)
        (out / "audit.txt").write_text("\\n".join(body) + "\\n", encoding="utf-8")
    except OSError:
        pass
print("\\n".join(body))
print("fossah-action=audit")
sys.exit(0)
"""

ISSUE_SCRIPT = """
import pathlib, sys
root = pathlib.Path("/work")
findings = []
for path in root.rglob("*"):
    if path.is_symlink() or not path.is_file() or any(part in {".git", ".fossah"} for part in path.parts):
        continue
    try:
        if path.suffix == ".py":
            compile(path.read_text(encoding="utf-8", errors="replace"), str(path), "exec")
        if path.stat().st_size > 1_000_000:
            continue
        text = path.read_text(encoding="utf-8", errors="ignore")
    except SyntaxError as exc:
        findings.append(f"syntax error in {path.relative_to(root)}: {exc}")
        continue
    except OSError:
        continue
    markers = (
        "BEGIN PRIVATE KEY",
        "BEGIN RSA PRIVATE KEY",
        "BEGIN OPENSSH PRIVATE KEY",
        "BEGIN EC PRIVATE KEY",
        "BEGIN DSA PRIVATE KEY",
    )
    if any(marker in text for marker in markers):
        findings.append(f"private key material in {path.relative_to(root)}")
out = root / ".fossah"
if not out.is_symlink():
    try:
        if out.exists() and not out.is_dir():
            raise OSError("not a directory")
        out.mkdir(exist_ok=True)
    except OSError:
        out = None
if out is not None and findings:
    lines = ["# Review findings", "", "Prepared locally. This draft was not filed on the forge.", ""]
    lines.extend(f"- {item}" for item in findings)
else:
    lines = [
        "# No issue prepared",
        "",
        "The local scan found nothing to file. This draft was not sent.",
    ]
if out is not None:
    try:
        (out / "issue-draft.md").write_text("\\n".join(lines) + "\\n", encoding="utf-8")
    except OSError:
        pass
print(f"issue_findings={len(findings)}")
print("fossah-action=issue")
sys.exit(0)
"""

PULL_REQUEST_SCRIPT = """
import pathlib, sys
root = pathlib.Path("/work")
names = []
for path in root.rglob("*"):
    if path.is_symlink() or not path.is_file() or any(part in {".git", ".fossah"} for part in path.parts):
        continue
    names.append(str(path.relative_to(root)))
names.sort()
out = root / ".fossah"
wrote = False
if not out.is_symlink():
    try:
        if out.exists() and not out.is_dir():
            raise OSError("not a directory")
        out.mkdir(exist_ok=True)
        wrote = True
    except OSError:
        wrote = False
lines = [
    "# Local pull request draft",
    "",
    "Prepared in the Fossah sandbox. This draft was not pushed.",
    "",
    "## Files",
    "",
]
lines.extend(f"- {name}" for name in names[:50])
if wrote:
    try:
        (out / "pr-draft.md").write_text("\\n".join(lines) + "\\n", encoding="utf-8")
    except OSError:
        pass
print(f"pr_files={len(names)}")
print("fossah-action=pull_request")
sys.exit(0)
"""

SCRIPTS = {
    "test": TEST_SCRIPT,
    "audit": AUDIT_SCRIPT,
    "issue": ISSUE_SCRIPT,
    "pull_request": PULL_REQUEST_SCRIPT,
}


def action_command(action: str, runtime: str) -> list[str]:
    script = SCRIPTS[action]
    if runtime in {"docker", "podman"}:
        return ["python", "-c", script]
    return ["/usr/bin/python3", "-c", script]
