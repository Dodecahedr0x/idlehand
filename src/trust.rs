//! Visible accept and refuse decisions for links and second-degree peers.

use std::path::Path;
use std::time::{SystemTime, UNIX_EPOCH};

use serde_json::{json, Value};

use crate::fetch::{contains_control_break, scrub_secrets};
use crate::home::{self, read_json, write_json, HomeLock};

pub const MAX_DECISIONS: usize = 20;

pub fn now_iso() -> String {
    let seconds = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0);
    format_unix(seconds)
}

fn format_unix(seconds: u64) -> String {
    let days = seconds / 86_400;
    let time = seconds % 86_400;
    let (year, month, day) = civil_from_days(days as i64);
    let hour = time / 3600;
    let minute = (time % 3600) / 60;
    let second = time % 60;
    format!("{year:04}-{month:02}-{day:02}T{hour:02}:{minute:02}:{second:02}+00:00")
}

fn civil_from_days(days: i64) -> (i64, u32, u32) {
    let z = days + 719_468;
    let era = if z >= 0 { z } else { z - 146_096 } / 146_097;
    let doe = (z - era * 146_097) as u64;
    let yoe = (doe - doe / 1460 + doe / 36524 - doe / 146_096) / 365;
    let y = yoe as i64 + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let day = doy - (153 * mp + 2) / 5 + 1;
    let month = if mp < 10 { mp + 3 } else { mp - 9 };
    let year = if month <= 2 { y + 1 } else { y };
    (year, month as u32, day as u32)
}

pub fn trust_path(home: &Path) -> std::path::PathBuf {
    home.join("trust.json")
}

pub fn public_subject(url: &str) -> String {
    if contains_control_break(url) {
        return "list entry".into();
    }
    let text = scrub_secrets(url)
        .replace(['\n', '\r'], " ")
        .trim()
        .to_string();
    if text.is_empty() || text.contains("PRIVATE KEY") || text.len() > 500 || !text.contains("://")
    {
        return "list entry".into();
    }
    text
}

pub fn public_reason(reason: &str) -> String {
    let text = scrub_secrets(reason)
        .replace(['\n', '\r'], " ")
        .trim()
        .to_string();
    if text.is_empty() || text.contains("PRIVATE KEY") {
        return "refused".into();
    }
    text.chars().take(500).collect()
}

fn read_trust(home: &Path) -> (Vec<Value>, bool) {
    let path = trust_path(home);
    if home::is_symlink(&path) {
        return (Vec::new(), false);
    }
    if !path.exists() {
        return (Vec::new(), true);
    }
    match read_json(&path) {
        Ok(Some(Value::Array(items))) => (
            items.into_iter().filter(|item| item.is_object()).collect(),
            true,
        ),
        Ok(Some(_)) => (Vec::new(), false),
        Ok(None) => (Vec::new(), true),
        Err(_) => (Vec::new(), false),
    }
}

pub fn load_trust(home: &Path) -> Vec<Value> {
    read_trust(home).0
}

pub fn trust_is_readable(home: &Path) -> bool {
    read_trust(home).1
}

pub fn decision(kind: &str, subject: &str, accepted: bool, reason: &str) -> Value {
    json!({
        "at": now_iso(),
        "kind": kind,
        "subject": if subject.is_empty() { "list entry".into() } else { public_subject(subject) },
        "accepted": accepted,
        "reason": public_reason(reason),
    })
}

fn extend(home: &Path, items: &[Value]) -> Result<(), String> {
    let mut current = load_trust(home);
    for item in items {
        let duplicate = current.iter().any(|existing| {
            existing.get("subject") == item.get("subject")
                && existing.get("accepted") == item.get("accepted")
                && existing.get("reason") == item.get("reason")
                && existing.get("kind") == item.get("kind")
        });
        if !duplicate {
            current.push(item.clone());
        }
    }
    let start = current.len().saturating_sub(MAX_DECISIONS);
    write_json(&trust_path(home), &Value::Array(current[start..].to_vec()))
        .map_err(|e| e.to_string())
}

pub fn extend_trust(home: &Path, items: &[Value]) -> Result<(), String> {
    if items.is_empty() {
        return Ok(());
    }
    extend(home, items)
}

pub fn remember(home: &Path, items: &[Value]) -> Result<(), String> {
    if items.is_empty() {
        return Ok(());
    }
    let _lock = HomeLock::acquire(home).map_err(|e| e.to_string())?;
    extend(home, items)
}
