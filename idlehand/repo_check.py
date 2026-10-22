"""Run a repository's tests inside the sandbox.

This is the program the jail executes. It does not import IdleHand, and it
does not need pytest installed: the jail has only the Python standard library.
Collection matches pytest's defaults (``test_*.py`` and ``*_test.py``,
including directories with no ``__init__.py``). ``tmp_path``, ``monkeypatch``,
``capsys``, ``pytest.raises``, and ``pytest.mark.parametrize`` are the fixture
and mark surface this project's tests use.

A run that discovers no tests exits 1. That is not a passing check.
"""

from __future__ import annotations

import importlib
import inspect
import io
import os
import re
import shutil
import sys
import tempfile
import traceback
import types
import unittest
from pathlib import Path

_SKIP_DIRS = {
    ".git",
    ".idlehand",
    ".pytest_cache",
    ".venv",
    "__pycache__",
    "build",
    "dist",
    "node_modules",
    "venv",
}
_MISSING = object()


class _Raises:
    def __init__(self, expected: type[BaseException] | tuple[type[BaseException], ...], match: str | None = None) -> None:
        self.expected = expected
        self.match = match
        self.value: BaseException | None = None

    def __enter__(self) -> _Raises:
        return self

    def __exit__(self, exc_type, exc, _tb) -> bool:  # noqa: ANN001
        if exc is None:
            raise AssertionError(f"DID NOT RAISE {self.expected}")
        if not isinstance(exc, self.expected):
            return False
        if self.match is not None and re.search(self.match, str(exc)) is None:
            raise AssertionError(f"pattern {self.match!r} does not match {exc}")
        self.value = exc
        return True


class _Mark:
    def parametrize(self, names, values, ids=None):  # noqa: ANN001
        if isinstance(names, str):
            argnames = [part.strip() for part in names.split(",") if part.strip()]
        else:
            argnames = [str(part) for part in names]

        def decorate(func):
            stored = list(getattr(func, "_idlehand_params", []))
            stored.append((argnames, list(values)))
            func._idlehand_params = stored
            return func

        return decorate

    def __getattr__(self, _name: str):
        def decorate(*args, **_kwargs):
            if len(args) == 1 and callable(args[0]):
                return args[0]

            def inner(func):
                return func

            return inner

        return decorate


def _install_pytest() -> None:
    if "pytest" in sys.modules:
        return
    module = types.ModuleType("pytest")
    module.raises = _Raises
    module.mark = _Mark()
    sys.modules["pytest"] = module


class _Monkey:
    def __init__(self) -> None:
        self._undo: list = []

    def _remember(self, callback) -> None:
        self._undo.append(callback)

    def setattr(self, target, name, value=_MISSING, raising: bool = True):  # noqa: ANN001
        if value is _MISSING:
            value = name
            owner, name = _resolve(target)
            target = owner
        if not hasattr(target, name):
            if raising:
                raise AttributeError(name)
            setattr(target, name, value)
            self._remember(lambda target=target, name=name: delattr(target, name))
            return
        old = getattr(target, name)
        setattr(target, name, value)
        self._remember(lambda target=target, name=name, old=old: setattr(target, name, old))

    def setenv(self, name: str, value: str, prepend: str | None = None) -> None:
        if prepend:
            current = os.environ.get(name, "")
            value = value + prepend + current
        had = name in os.environ
        old = os.environ.get(name)
        os.environ[name] = str(value)

        def undo(name: str = name, had: bool = had, old: str | None = old) -> None:
            if had and old is not None:
                os.environ[name] = old
            else:
                os.environ.pop(name, None)

        self._remember(undo)

    def delenv(self, name: str, raising: bool = True) -> None:
        if name not in os.environ:
            if raising:
                raise KeyError(name)
            return
        old = os.environ[name]
        del os.environ[name]
        self._remember(lambda name=name, old=old: os.environ.__setitem__(name, old))

    def undo(self) -> None:
        while self._undo:
            self._undo.pop()()


class _Capture:
    def __init__(self) -> None:
        self._out = io.StringIO()
        self._err = io.StringIO()
        self._saved = (sys.stdout, sys.stderr)
        sys.stdout = self._out
        sys.stderr = self._err

    def readouterr(self):
        out, err = self._out.getvalue(), self._err.getvalue()
        self._out.seek(0)
        self._out.truncate(0)
        self._err.seek(0)
        self._err.truncate(0)
        return types.SimpleNamespace(out=out, err=err)

    def undo(self) -> None:
        sys.stdout, sys.stderr = self._saved


def _resolve(dotted: str):
    parts = dotted.split(".")
    for index in range(len(parts) - 1, 0, -1):
        try:
            module = importlib.import_module(".".join(parts[:index]))
        except ImportError:
            continue
        owner = module
        for part in parts[index:-1]:
            owner = getattr(owner, part)
        return owner, parts[-1]
    raise ImportError(dotted)


def _walk_py(root: Path):
    for path in root.rglob("*.py"):
        if path.is_symlink():
            continue
        if any(part in _SKIP_DIRS or part.startswith(".") for part in path.relative_to(root).parts):
            continue
        yield path


def _is_test_file(path: Path) -> bool:
    name = path.name
    return name.startswith("test_") or name.endswith("_test.py")


def _cases(func) -> tuple[list[str], list[tuple]]:
    params = getattr(func, "_idlehand_params", [])
    names: list[str] = []
    rows: list[tuple] = [()]
    for argnames, values in params:
        names.extend(argnames)
        grown: list[tuple] = []
        for prefix in rows:
            for value in values:
                if len(argnames) == 1:
                    item = value if isinstance(value, tuple) else (value,)
                    if len(item) != 1:
                        item = (value,)
                else:
                    item = tuple(value)
                grown.append(prefix + item)
        rows = grown
    return names, rows


def _call(func, fixtures: dict, extra_names: list[str], extra_values: tuple) -> None:
    signature = inspect.signature(func)
    extras = dict(zip(extra_names, extra_values, strict=True))
    kwargs = {}
    for name, parameter in signature.parameters.items():
        if name in extras:
            kwargs[name] = extras[name]
            continue
        if name in fixtures:
            kwargs[name] = fixtures[name]
            continue
        if parameter.kind in (inspect.Parameter.VAR_POSITIONAL, inspect.Parameter.VAR_KEYWORD):
            continue
        if parameter.default is not inspect.Signature.empty:
            continue
        raise TypeError(f"unsupported fixture {name}")
    func(**kwargs)


def main() -> int:
    _install_pytest()
    root = Path("/work")
    if not root.is_dir():
        print("tests_run=0")
        print("idlehand-action=test")
        return 1
    sys.path.insert(0, str(root))
    os.chdir(root)
    real_out, real_err = sys.stdout, sys.stderr
    syntax_errors = 0
    for path in _walk_py(root):
        try:
            compile(path.read_text(encoding="utf-8", errors="replace"), str(path), "exec")
        except SyntaxError as exc:
            syntax_errors += 1
            print(f"syntax {path.relative_to(root)}: {exc}", file=real_out)
        except OSError:
            continue
    print(f"syntax_errors={syntax_errors}", file=real_out)

    tests_run = 0
    failures = 0
    for path in sorted(_walk_py(root)):
        if not _is_test_file(path):
            continue
        rel = path.relative_to(root)
        modname = ".".join(rel.with_suffix("").parts)
        node = rel.as_posix()
        try:
            module = importlib.import_module(modname)
        except Exception as exc:  # noqa: BLE001 — a collection error fails the check
            tests_run += 1
            failures += 1
            print(f"FAIL {node}", file=real_out)
            print(f"{type(exc).__name__}: {exc}", file=real_out)
            continue
        functions = []
        cases = []
        for name, obj in vars(module).items():
            if getattr(obj, "__module__", None) != module.__name__:
                continue
            if isinstance(obj, type) and issubclass(obj, unittest.TestCase):
                for method in unittest.defaultTestLoader.getTestCaseNames(obj):
                    cases.append((obj, method))
                continue
            if name.startswith("test_") and callable(obj):
                functions.append((name, obj))
        for name, func in functions:
            extra_names, rows = _cases(func)
            for index, row in enumerate(rows):
                suffix = "" if len(rows) == 1 else f"[{index}]"
                label = f"{node}::{name}{suffix}"
                tests_run += 1
                monkey = _Monkey()
                capture = _Capture()
                folder = Path(tempfile.mkdtemp(prefix="idlehand-test-"))
                try:
                    _call(
                        func,
                        {"tmp_path": folder, "monkeypatch": monkey, "capsys": capture},
                        extra_names,
                        row,
                    )
                    print(f"PASS {label}", file=real_out)
                except Exception as exc:  # noqa: BLE001 — report the test and keep going
                    failures += 1
                    print(f"FAIL {label}", file=real_out)
                    print(f"{type(exc).__name__}: {exc}", file=real_out)
                    traceback.print_exc(file=real_err)
                finally:
                    capture.undo()
                    monkey.undo()
                    shutil.rmtree(folder, ignore_errors=True)
        for cls, method in cases:
            label = f"{node}::{cls.__name__}::{method}"
            tests_run += 1
            suite = unittest.defaultTestLoader.loadTestsFromName(method, cls)
            stream = io.StringIO()
            result = unittest.TextTestRunner(stream=stream, verbosity=0).run(suite)
            if result.wasSuccessful():
                print(f"PASS {label}", file=real_out)
            else:
                failures += 1
                print(f"FAIL {label}", file=real_out)
                print(stream.getvalue().strip(), file=real_out)
    print(f"tests_run={tests_run}", file=real_out)
    print(f"failures={failures}", file=real_out)
    print("idlehand-action=test", file=real_out)
    if syntax_errors or failures or tests_run == 0:
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
