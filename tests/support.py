"""Local git repositories for contribution-loop tests."""

from __future__ import annotations

import subprocess
from pathlib import Path

SAMPLE_FILES = {
    "sample.py": "def add(left, right):\n    return left + right\n",
    "test_sample.py": (
        "import os\n"
        "import unittest\n"
        "from pathlib import Path\n"
        "\n"
        "class Isolation(unittest.TestCase):\n"
        "    def test_sandbox_hides_home_and_credentials(self):\n"
        "        self.assertFalse(Path('/home').exists())\n"
        "        self.assertNotIn('ANTHROPIC_API_KEY', os.environ)\n"
        "        self.assertNotIn('GH_TOKEN', os.environ)\n"
        "        self.assertEqual(Path.cwd().as_posix(), '/work')\n"
    ),
}

BROKEN_FILES = {
    "broken.py": "def broken(\n",
}

KEY_FILES = {
    "readme.txt": "hello\n",
    "secret.pem": "-----BEGIN OPENSSH PRIVATE KEY-----\nabc\n-----END OPENSSH PRIVATE KEY-----\n",
}


def make_repo(path: Path, files: dict[str, str]) -> str:
    path.mkdir(parents=True, exist_ok=True)
    for name, body in files.items():
        destination = path / name
        destination.parent.mkdir(parents=True, exist_ok=True)
        destination.write_text(body, encoding="utf-8")
    home = path.parent / f"{path.name}-git-home"
    home.mkdir(parents=True, exist_ok=True)
    env = {
        "PATH": "/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin",
        "HOME": str(home),
        "GIT_CONFIG_GLOBAL": "/dev/null",
        "GIT_CONFIG_NOSYSTEM": "1",
        "GIT_AUTHOR_NAME": "fossah",
        "GIT_AUTHOR_EMAIL": "fossah@example.com",
        "GIT_COMMITTER_NAME": "fossah",
        "GIT_COMMITTER_EMAIL": "fossah@example.com",
    }
    for args in (["init"], ["add", "."], ["commit", "-m", "init"]):
        subprocess.run(
            ["git", *args],
            cwd=path,
            env=env,
            check=True,
            capture_output=True,
            text=True,
        )
    return path.resolve().as_uri()
