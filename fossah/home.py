"""Fossah home directory, file lock, and TOML helpers."""

from __future__ import annotations

import fcntl
import json
import os
import tomllib
from contextlib import contextmanager
from pathlib import Path
from typing import Any, Iterator


def resolve_home(explicit: str | None = None) -> Path:
    if explicit:
        return Path(explicit).expanduser().resolve()
    env = os.environ.get("FOSSAH_HOME")
    if env:
        return Path(env).expanduser().resolve()
    return (Path.home() / ".fossah").resolve()


@contextmanager
def home_lock(home: Path) -> Iterator[None]:
    home.mkdir(parents=True, exist_ok=True)
    handle = (home / ".lock").open("a+")
    try:
        fcntl.flock(handle.fileno(), fcntl.LOCK_EX)
        yield
    finally:
        fcntl.flock(handle.fileno(), fcntl.LOCK_UN)
        handle.close()


def atomic_write(path: Path, text: str) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = path.with_suffix(path.suffix + ".tmp")
    if temporary.is_symlink():
        temporary.unlink()
    temporary.write_text(text, encoding="utf-8")
    os.replace(temporary, path)


def read_toml(path: Path) -> dict[str, Any]:
    if not path.exists():
        return {}
    loaded = tomllib.loads(path.read_text(encoding="utf-8"))
    if not isinstance(loaded, dict):
        raise ValueError(f"{path} must be a TOML table")
    return loaded


def write_json(path: Path, payload: Any) -> None:
    atomic_write(path, json.dumps(payload, indent=2, sort_keys=True) + "\n")


def read_json(path: Path) -> Any:
    if not path.exists():
        return None
    return json.loads(path.read_text(encoding="utf-8"))


def toml_string(value: str) -> str:
    escaped = value.replace("\\", "\\\\").replace('"', '\\"')
    return f'"{escaped}"'


def _toml_value(value: Any) -> str:
    if isinstance(value, bool):
        return "true" if value else "false"
    if isinstance(value, int):
        return str(value)
    if isinstance(value, float):
        return format(value, "g")
    if isinstance(value, str):
        return toml_string(value)
    if isinstance(value, list):
        if not value:
            return "[]"
        if not all(isinstance(item, str) for item in value):
            raise TypeError("only lists of strings can be TOML inline arrays")
        return "[" + ", ".join(toml_string(item) for item in value) + "]"
    raise TypeError(f"cannot encode {type(value).__name__} as TOML")


def dump_toml(data: dict[str, Any], header: str = "") -> str:
    """Encode one level of tables and arrays of tables."""
    lines: list[str] = []
    if header:
        lines.append(header.rstrip())
        lines.append("")
    tables: list[tuple[str, dict[str, Any]]] = []
    arrays: list[tuple[str, list[dict[str, Any]]]] = []
    for key, value in data.items():
        if isinstance(value, dict):
            tables.append((key, value))
        elif isinstance(value, list) and value and isinstance(value[0], dict):
            arrays.append((key, value))
        else:
            lines.append(f"{key} = {_toml_value(value)}")
    for name, table in tables:
        lines.append("")
        lines.append(f"[{name}]")
        for key, value in table.items():
            if isinstance(value, (dict, list)) and (not isinstance(value, list) or (value and isinstance(value[0], dict))):
                raise TypeError(f"nested table {name}.{key} is not supported")
            lines.append(f"{key} = {_toml_value(value)}")
    for name, rows in arrays:
        for row in rows:
            lines.append("")
            lines.append(f"[[{name}]]")
            for key, value in row.items():
                lines.append(f"{key} = {_toml_value(value)}")
    lines.append("")
    return "\n".join(lines)
