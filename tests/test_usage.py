from pathlib import Path

from fossah.usage import parse_reported_tokens, plan_with_claude


def test_parse_reported_tokens_from_a_result_object() -> None:
    text = """
    {"type":"result","usage":{"input_tokens":3,"output_tokens":4,
    "cache_creation_input_tokens":2,"cache_read_input_tokens":1}}
    """
    assert parse_reported_tokens(text) == 10


def test_zero_is_a_report_and_missing_usage_is_not() -> None:
    assert parse_reported_tokens('{"type":"result","usage":{"input_tokens":0,"output_tokens":0}}') == 0
    assert parse_reported_tokens("") is None
    assert parse_reported_tokens("not json") is None
    assert parse_reported_tokens('{"type":"result","result":"hello"}') is None


def test_jsonl_uses_the_last_result_instead_of_adding_every_line() -> None:
    text = "\n".join(
        [
            '{"type":"assistant","message":{"usage":{"input_tokens":1,"output_tokens":1}}}',
            '{"type":"result","usage":{"input_tokens":5,"output_tokens":7}}',
        ]
    )
    assert parse_reported_tokens(text) == 12


def test_bool_and_negative_tokens_are_ignored() -> None:
    assert parse_reported_tokens('{"usage":{"input_tokens":true,"output_tokens":4}}') == 4
    assert parse_reported_tokens('{"usage":{"input_tokens":-3,"total_tokens":9}}') == 9
    assert parse_reported_tokens('{"input_tokens":2,"output_tokens":2}') == 4


def test_planner_refuses_a_symlink_and_does_not_start_the_cli(tmp_path: Path) -> None:
    home = tmp_path / "home"
    outside = tmp_path / "outside"
    outside.mkdir()
    (outside / "keep").write_text("safe", encoding="utf-8")
    home.mkdir()
    (home / "planner").symlink_to(outside)
    called = tmp_path / "called"
    binary = tmp_path / "claude"
    binary.write_text(f"#!/bin/sh\ntouch '{called}'\n", encoding="utf-8")
    binary.chmod(0o755)
    result = plan_with_claude(str(binary), "https://github.com/org/repo", "test", home)
    assert result["executed"] is False
    assert not called.exists()
    assert (outside / "keep").read_text(encoding="utf-8") == "safe"


def test_planner_does_not_leave_a_file_behind(tmp_path: Path) -> None:
    home = tmp_path / "home"
    home.mkdir()
    binary = tmp_path / "claude"
    binary.write_text(
        "#!/bin/sh\n"
        "printf 'sk-left-behind' > \"$PWD/leak.txt\"\n"
        "printf '%s' '{\"type\":\"result\",\"usage\":{\"input_tokens\":1,\"output_tokens\":1}}'\n",
        encoding="utf-8",
    )
    binary.chmod(0o755)
    result = plan_with_claude(str(binary), "https://github.com/org/repo", "audit", home)
    assert result["tokens"] == 2
    assert result["executed"] is True
    assert not (home / "planner").exists()
    leftover = " ".join(path.read_text(encoding="utf-8", errors="ignore") for path in home.rglob("*") if path.is_file())
    assert "sk-left-behind" not in leftover


def test_huge_or_deep_usage_is_not_a_report() -> None:
    assert parse_reported_tokens("x" * 1_000_001) is None
    nested = '{"a":' * 2000 + "1" + "}" * 2000
    assert parse_reported_tokens(nested) is None
    assert parse_reported_tokens('{"type":"result","usage":{"input_tokens":3,"output_tokens":1}}') == 4


def test_total_tokens_is_only_a_fallback() -> None:
    assert parse_reported_tokens('{"usage":{"input_tokens":2,"output_tokens":2,"total_tokens":99}}') == 4
    assert parse_reported_tokens('{"usage":{"total_tokens":9}}') == 9
