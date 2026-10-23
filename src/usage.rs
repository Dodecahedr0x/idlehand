//! Meter token usage reported by the Claude planner.
//!
//! Only the Claude CLI is invoked, and only as a planner with tools disabled.
//! Its reply is not executed. Codex and Cursor are not invoked.

use std::fs;
use std::path::{Path, PathBuf};
use std::time::Duration;

use serde_json::Value;

use crate::procutil;

const PLAN_TIMEOUT: Duration = Duration::from_secs(20);
const HUGE_REPORT: i64 = 1 << 62;
const TOKEN_KEYS: &[&str] = &[
    "input_tokens",
    "output_tokens",
    "cache_creation_input_tokens",
    "cache_read_input_tokens",
];

pub fn claude_argv(binary: &str, repo_url: &str, action: &str) -> Vec<String> {
    let verb = match action {
        "test" => "test",
        "audit" => "audit",
        "issue" => "issue",
        "pull_request" => "pull request",
        other => other,
    };
    let prompt = format!("In one sentence, describe a {verb} for {repo_url}. Do not use tools. Do not read or write files. Do not run commands.");
    vec![
        binary.into(),
        "-p".into(),
        "--output-format".into(),
        "json".into(),
        "--tools".into(),
        String::new(),
        "--disallowedTools".into(),
        "*".into(),
        "--disallowedTools".into(),
        "mcp__*".into(),
        "--permission-mode".into(),
        "plan".into(),
        prompt,
    ]
}

fn count_field(value: &Value) -> Option<i64> {
    match value {
        Value::Bool(_) => None,
        Value::Number(number) => {
            if let Some(int) = number.as_i64() {
                return (int >= 0).then_some(int);
            }
            if let Some(uint) = number.as_u64() {
                return i64::try_from(uint).ok().or(Some(HUGE_REPORT));
            }
            let float = number.as_f64()?;
            if float.is_nan() {
                return Some(HUGE_REPORT);
            }
            if float < 0.0 {
                return None;
            }
            if !float.is_finite() || float >= HUGE_REPORT as f64 {
                return Some(HUGE_REPORT);
            }
            Some(float.ceil() as i64)
        }
        Value::String(text) if text.is_ascii() && text.chars().all(|c| c.is_ascii_digit()) => {
            if text.len() > 18 {
                Some(HUGE_REPORT)
            } else {
                text.parse().ok()
            }
        }
        _ => None,
    }
}

fn usage_total(usage: &Value) -> Option<i64> {
    let Some(object) = usage.as_object() else {
        return None;
    };
    let mut total: i128 = 0;
    let mut found = false;
    for key in TOKEN_KEYS {
        if let Some(count) = object.get(*key).and_then(count_field) {
            found = true;
            total += count as i128;
        }
    }
    if found {
        return Some(clamp_i64(total));
    }
    object.get("total_tokens").and_then(count_field)
}

fn clamp_i64(value: i128) -> i64 {
    if value > i64::MAX as i128 {
        i64::MAX
    } else if value < i64::MIN as i128 {
        i64::MIN
    } else {
        value as i64
    }
}

fn collect(node: &Value) -> (Vec<i64>, Vec<i64>) {
    if let Some(object) = node.as_object() {
        if !object.contains_key("usage") {
            if let Some(total) = usage_total(node) {
                return (Vec::new(), vec![total]);
            }
        }
    }
    let mut reported = Vec::new();
    let mut other = Vec::new();
    walk(node, false, &mut reported, &mut other);
    (reported, other)
}

fn walk(value: &Value, in_result: bool, reported: &mut Vec<i64>, other: &mut Vec<i64>) {
    match value {
        Value::Object(object) => {
            let here = in_result || object.get("type").and_then(Value::as_str) == Some("result");
            if let Some(total) = object.get("usage").and_then(usage_total) {
                if here {
                    reported.push(total);
                } else {
                    other.push(total);
                }
            }
            for child in object.values() {
                walk(child, here, reported, other);
            }
        }
        Value::Array(items) => {
            for child in items {
                walk(child, in_result, reported, other);
            }
        }
        _ => {}
    }
}

fn relax_json(text: &str) -> String {
    let replaced = text.replace("-Infinity", "-1.0").replace("Infinity", "1e308").replace("NaN", "1e308");
    let re = regex::Regex::new(r"(?i)\b[0-9]+(?:\.[0-9]+)?[eE]\+?[0-9]{3,}").unwrap();
    re.replace_all(&replaced, "1e308").into_owned()
}

fn parse_json_lenient(text: &str) -> Option<Value> {
    serde_json::from_str(text).ok().or_else(|| serde_json::from_str(&relax_json(text)).ok())
}

pub fn parse_reported_tokens(text: &str) -> Option<i64> {
    let raw = text.trim();
    if raw.is_empty() || raw.len() > 1_000_000 {
        return None;
    }
    let mut documents = Vec::new();
    if let Some(document) = parse_json_lenient(raw) {
        documents.push(document);
    } else {
        for line in raw.lines() {
            let piece = line.trim();
            if piece.is_empty() {
                continue;
            }
            if let Some(document) = parse_json_lenient(piece) {
                documents.push(document);
            }
        }
    }
    if documents.is_empty() {
        return None;
    }
    let mut result_totals = Vec::new();
    let mut other_totals = Vec::new();
    for document in &documents {
        let (found, other) = collect(document);
        result_totals.extend(found);
        other_totals.extend(other);
    }
    result_totals.last().copied().or_else(|| other_totals.last().copied())
}

fn empty_planner_dir(home: &Path) -> Option<PathBuf> {
    let root = home.canonicalize().unwrap_or_else(|_| home.to_path_buf());
    let path = home.join("planner");
    if crate::home::is_symlink(&path) {
        return None;
    }
    if path.exists() {
        let resolved = path.canonicalize().ok()?;
        if !resolved.starts_with(&root) {
            return None;
        }
        fs::remove_dir_all(&resolved).ok()?;
    }
    fs::create_dir_all(&path).ok()?;
    Some(path)
}

fn discard_planner_dir(home: &Path, cwd: Option<&Path>) {
    let Some(cwd) = cwd else { return };
    if crate::home::is_symlink(cwd) {
        return;
    }
    if let Ok(resolved) = cwd.canonicalize() {
        if let Ok(root) = home.canonicalize() {
            if resolved.starts_with(root) {
                let _ = fs::remove_dir_all(resolved);
            }
        }
    }
}

pub fn plan_with_claude(binary: &str, repo_url: &str, action: &str, home: &Path) -> serde_json::Value {
    let argv = claude_argv(binary, repo_url, action);
    let cwd = empty_planner_dir(home);
    let Some(cwd) = cwd else {
        return serde_json::json!({
            "executed": false,
            "tokens": Value::Null,
            "argv": argv,
            "reason": "refusing to plan outside the IdleHand home",
        });
    };
    let completed = procutil::run_inherited(&argv, Some(&cwd), PLAN_TIMEOUT);
    discard_planner_dir(home, Some(&cwd));
    if completed.code == 124 {
        return serde_json::json!({
            "executed": true,
            "tokens": Value::Null,
            "argv": argv,
            "reason": "subscription planner timed out",
        });
    }
    if completed.code == 127 && completed.stderr.contains("is not installed") {
        return serde_json::json!({
            "executed": false,
            "tokens": Value::Null,
            "argv": argv,
            "reason": format!("could not run the subscription CLI: {}", completed.stderr),
        });
    }
    match parse_reported_tokens(&completed.stdout) {
        Some(tokens) => serde_json::json!({
            "executed": true,
            "tokens": tokens,
            "argv": argv,
            "reason": "subscription CLI reported token usage",
        }),
        None => serde_json::json!({
            "executed": true,
            "tokens": Value::Null,
            "argv": argv,
            "reason": "subscription CLI did not report token usage",
        }),
    }
}
