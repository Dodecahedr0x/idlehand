"""Register the idlehand: URL scheme when the desktop environment allows it."""

from __future__ import annotations

import os
import shutil
import subprocess
import sys
from pathlib import Path


def _desktop_quote(value: str) -> str:
    if any(character in value for character in ' \t"'):
        return '"' + value.replace("\\", "\\\\").replace('"', '\\"') + '"'
    return value


def handler_exec() -> str:
    found = shutil.which("idlehand")
    if found:
        return f"{_desktop_quote(found)} %u"
    return f"{_desktop_quote(sys.executable)} -m idlehand %u"


def desktop_file_text() -> str:
    return (
        "[Desktop Entry]\n"
        "Name=IdleHand\n"
        "Comment=Add repositories from an IdleHand link\n"
        f"Exec={handler_exec()}\n"
        "Type=Application\n"
        "Terminal=false\n"
        "NoDisplay=true\n"
        "MimeType=x-scheme-handler/idlehand;\n"
    )


def _data_home() -> Path:
    return Path(os.environ.get("XDG_DATA_HOME", Path.home() / ".local" / "share"))


def _config_home() -> Path:
    return Path(os.environ.get("XDG_CONFIG_HOME", Path.home() / ".config"))


def _merge_mimeapps(path: Path) -> None:
    key = "x-scheme-handler/idlehand=idlehand.desktop"
    existing = path.read_text(encoding="utf-8") if path.exists() else ""
    if key in existing:
        return
    if "[Default Applications]" in existing:
        lines = existing.splitlines()
        updated: list[str] = []
        inserted = False
        for line in lines:
            updated.append(line)
            if line.strip() == "[Default Applications]" and not inserted:
                updated.append(key)
                inserted = True
        text = "\n".join(updated)
        if not text.endswith("\n"):
            text += "\n"
    else:
        text = existing
        if text and not text.endswith("\n"):
            text += "\n"
        text += "[Default Applications]\n" + key + "\n"
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(text, encoding="utf-8")


def register_protocol_handler() -> str:
    """Write the XDG handler. Returns a short status string. Never raises."""
    if not sys.platform.startswith("linux"):
        return "not registered: protocol handlers are registered on Linux"
    try:
        desktop_dir = _data_home() / "applications"
        desktop_dir.mkdir(parents=True, exist_ok=True)
        desktop = desktop_dir / "idlehand.desktop"
        desktop.write_text(desktop_file_text(), encoding="utf-8")
        _merge_mimeapps(_config_home() / "mimeapps.list")
        xdg = shutil.which("xdg-mime")
        if xdg:
            subprocess.run(
                [xdg, "default", "idlehand.desktop", "x-scheme-handler/idlehand"],
                check=False,
                capture_output=True,
                text=True,
                timeout=5,
            )
    except (OSError, subprocess.SubprocessError) as exc:
        return f"not registered: {exc}"
    return "registered"
