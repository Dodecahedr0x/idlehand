//! Section menu for `idlehand configure`, in the shape of Hermes Agent setup.
//!
//! Hermes calls this `hermes setup` (and `hermes tools` for its live menu).
//! Each prompt shows the current value. An empty answer keeps it. `skip` does
//! too. A bad answer is refused and the prompt repeats. Nothing is written
//! until the user picks Done, and Done does not start the node.

use std::io::Write;
use std::path::Path;

use toml::Value;

use crate::config::{load_config, save_config};
use crate::sandbox::sandbox_limits;

const SECTIONS: &[(&str, &str)] = &[
    ("subscription", "Subscription"),
    ("spending", "Spending"),
    ("rules", "Rules"),
    ("sandbox", "Sandbox"),
    ("publish", "Publish"),
    ("peers", "Peers"),
];

const SECTION_FIELDS: &[(&str, &[&str])] = &[
    ("subscription", &["subscription", "demo"]),
    (
        "spending",
        &[
            "spending_limit_tokens",
            "estimate_tokens_per_cycle",
            "loop_interval_seconds",
        ],
    ),
    (
        "rules",
        &[
            "rules.auto_start",
            "rules.allow_test",
            "rules.allow_audit",
            "rules.allow_issues",
            "rules.allow_pull_requests",
        ],
    ),
    (
        "sandbox",
        &[
            "sandbox.runtime",
            "sandbox.execute",
            "sandbox.image",
            "sandbox.memory",
            "sandbox.cpus",
        ],
    ),
    (
        "publish",
        &[
            "publish.listen",
            "publish.host",
            "publish.port",
            "publish.peer_fetch_interval_seconds",
        ],
    ),
    (
        "peers",
        &[
            "peer_heuristic.min_endorsements",
            "peer_heuristic.max_new_peers_per_cycle",
            "peer_heuristic.max_peers",
            "peer_heuristic.require_https",
            "peer_heuristic.allow_insecure_loopback",
            "peer_heuristic.allowed_hosts",
            "peer_heuristic.blocked_hosts",
        ],
    ),
];

pub fn setting_keys() -> &'static [&'static str] {
    &[
        "subscription",
        "demo",
        "spending_limit_tokens",
        "estimate_tokens_per_cycle",
        "loop_interval_seconds",
        "rules.auto_start",
        "rules.allow_test",
        "rules.allow_audit",
        "rules.allow_issues",
        "rules.allow_pull_requests",
        "sandbox.runtime",
        "sandbox.execute",
        "sandbox.image",
        "sandbox.memory",
        "sandbox.cpus",
        "publish.listen",
        "publish.host",
        "publish.port",
        "publish.peer_fetch_interval_seconds",
        "peer_heuristic.min_endorsements",
        "peer_heuristic.max_new_peers_per_cycle",
        "peer_heuristic.max_peers",
        "peer_heuristic.require_https",
        "peer_heuristic.allow_insecure_loopback",
        "peer_heuristic.allowed_hosts",
        "peer_heuristic.blocked_hosts",
    ]
}

pub fn run_configure(
    home: &Path,
    mut next_line: impl FnMut(&str) -> Option<String>,
    out: &mut dyn Write,
    err: &mut dyn Write,
) -> Result<(), String> {
    let _ = crate::config::ensure_home(home)?;
    let original = load_config(home)?;
    let mut config = original.clone();
    let mut dirty = false;
    writeln!(out, "IdleHand configuration").map_err(|e| e.to_string())?;
    writeln!(
        out,
        "Pick a section. Enter keeps the shown value. skip does the same. Done saves and leaves the node stopped."
    )
    .map_err(|e| e.to_string())?;
    loop {
        let prompt = menu_prompt();
        let answer = match next_line(&prompt) {
            Some(line) => line,
            None => return Err("configure cancelled".into()),
        };
        let choice = answer.trim();
        if choice.is_empty() || choice.eq_ignore_ascii_case("done") || choice == "7" {
            writeln!(out, "Skipped (keeping current)").ok();
            break;
        }
        let section = match resolve_section(choice) {
            Some(section) => section,
            None => {
                writeln!(err, "rejected: unknown section").ok();
                continue;
            }
        };
        let fields = fields_for(section);
        writeln!(out, "─── {section} ───").ok();
        let mut index = 0;
        while index < fields.len() {
            let key = fields[index];
            let current = display_setting(&config, key);
            let prompt = field_prompt(key, &current);
            let line = match next_line(&prompt) {
                Some(line) => line,
                None => return Err("configure cancelled".into()),
            };
            let typed = line.trim();
            if typed.eq_ignore_ascii_case("back") {
                writeln!(out, "Returning to the section menu.").ok();
                break;
            }
            match parse_setting(key, typed) {
                Ok(None) => {
                    writeln!(out, "Skipped (keeping current)").ok();
                    index += 1;
                }
                Ok(Some(value)) => {
                    set_setting(&mut config, key, value);
                    dirty = true;
                    index += 1;
                }
                Err(message) => {
                    writeln!(err, "rejected: {message}").ok();
                }
            }
        }
    }
    if dirty {
        save_config(home, &config)?;
    }
    Ok(())
}

fn menu_prompt() -> String {
    let mut text = String::from("Select a section [Done]:\n");
    for (index, (key, label)) in SECTIONS.iter().enumerate() {
        text.push_str(&format!("  {}. {} ({key})\n", index + 1, label));
    }
    text.push_str("  7. Done\n> ");
    text
}

fn resolve_section(choice: &str) -> Option<&'static str> {
    if let Ok(number) = choice.parse::<usize>() {
        return SECTIONS.get(number.saturating_sub(1)).map(|(key, _)| *key);
    }
    SECTIONS
        .iter()
        .find(|(key, label)| choice.eq_ignore_ascii_case(key) || choice.eq_ignore_ascii_case(label))
        .map(|(key, _)| *key)
}

fn fields_for(section: &str) -> &'static [&'static str] {
    SECTION_FIELDS
        .iter()
        .find(|(key, _)| *key == section)
        .map(|(_, fields)| *fields)
        .unwrap_or(&[])
}

fn field_prompt(key: &str, current: &str) -> String {
    if current.is_empty() {
        format!("{key}: ")
    } else {
        format!("{key} [{current}]: ")
    }
}

pub fn display_setting(config: &Value, key: &str) -> String {
    match lookup(config, key) {
        Some(Value::String(text)) => text.clone(),
        Some(Value::Boolean(value)) => {
            if *value {
                "true".into()
            } else {
                "false".into()
            }
        }
        Some(Value::Integer(value)) => value.to_string(),
        Some(Value::Float(value)) => value.to_string(),
        Some(Value::Array(items)) => items
            .iter()
            .filter_map(Value::as_str)
            .collect::<Vec<_>>()
            .join(", "),
        _ => String::new(),
    }
}

fn lookup<'a>(config: &'a Value, key: &str) -> Option<&'a Value> {
    let mut cursor = config;
    for part in key.split('.') {
        cursor = cursor.get(part)?;
    }
    Some(cursor)
}

fn set_setting(config: &mut Value, key: &str, value: Value) {
    let parts: Vec<&str> = key.split('.').collect();
    let mut cursor = config;
    for part in &parts[..parts.len() - 1] {
        let table = cursor.as_table_mut().expect("config table");
        cursor = table.get_mut(*part).expect("nested table");
    }
    if let Some(table) = cursor.as_table_mut() {
        table.insert((*parts.last().unwrap()).to_string(), value);
    }
}

/// Apply form or menu updates. An empty answer or `skip` keeps the stored value.
/// `none` clears subscription and host lists. On any invalid value the returned
/// config is unchanged.
pub fn apply_updates(config: &Value, updates: &[(&str, &str)]) -> Result<Value, String> {
    let mut next = config.clone();
    for (key, raw) in updates {
        if !setting_keys().contains(key) {
            return Err(format!("unknown setting {key}"));
        }
        match parse_setting(key, raw.trim())? {
            Some(value) => set_setting(&mut next, key, value),
            None => {}
        }
    }
    Ok(next)
}

pub fn parse_setting(key: &str, raw: &str) -> Result<Option<Value>, String> {
    if raw.is_empty() || raw.eq_ignore_ascii_case("skip") {
        return Ok(None);
    }
    let value = match key {
        "subscription" => Value::String(parse_subscription(raw)?),
        "demo" | "rules.auto_start" | "rules.allow_test" | "rules.allow_audit" | "rules.allow_issues"
        | "rules.allow_pull_requests" | "sandbox.execute" | "publish.listen"
        | "peer_heuristic.require_https" | "peer_heuristic.allow_insecure_loopback" => {
            Value::Boolean(parse_bool(raw).ok_or_else(|| format!("{key} must be true or false"))?)
        }
        "spending_limit_tokens" => Value::Integer(parse_int(raw, 0, i64::MAX, key)?),
        "estimate_tokens_per_cycle" => Value::Integer(parse_int(raw, 1, i64::MAX, key)?),
        "peer_heuristic.min_endorsements" | "peer_heuristic.max_new_peers_per_cycle"
        | "peer_heuristic.max_peers" => Value::Integer(parse_int(raw, 0, i64::MAX, key)?),
        "publish.port" => Value::Integer(parse_int(raw, 0, 65535, key)?),
        "loop_interval_seconds" => parse_finite(raw, true)?,
        "publish.peer_fetch_interval_seconds" => parse_finite(raw, false)?,
        "sandbox.runtime" => Value::String(parse_runtime(raw)?),
        "sandbox.image" => Value::String(parse_image(raw)?),
        "sandbox.memory" => Value::String(parse_memory(raw)?),
        "sandbox.cpus" => Value::String(parse_cpus(raw)?),
        "publish.host" => {
            let host = raw.trim();
            if host.is_empty() {
                return Err("publish.host must be a non-empty string".into());
            }
            Value::String(host.to_string())
        }
        "peer_heuristic.allowed_hosts" | "peer_heuristic.blocked_hosts" => {
            Value::Array(parse_hosts(raw)?.into_iter().map(Value::String).collect())
        }
        _ => return Err(format!("unknown setting {key}")),
    };
    Ok(Some(value))
}

fn parse_subscription(raw: &str) -> Result<String, String> {
    if raw.eq_ignore_ascii_case("none") {
        return Ok(String::new());
    }
    if matches!(raw, "claude" | "codex" | "cursor") {
        return Ok(raw.to_string());
    }
    Err("subscription must be empty, claude, codex, cursor, or none".into())
}

pub fn parse_bool(raw: &str) -> Option<bool> {
    match raw.to_ascii_lowercase().as_str() {
        "1" | "true" | "yes" | "on" => Some(true),
        "0" | "false" | "no" | "off" => Some(false),
        _ => None,
    }
}

fn parse_int(raw: &str, min: i64, max: i64, key: &str) -> Result<i64, String> {
    let text = raw.trim();
    let digits = text.strip_prefix('+').unwrap_or(text);
    if digits.is_empty() || !digits.chars().all(|c| c.is_ascii_digit()) {
        return Err(format!("{key} must be an integer"));
    }
    let number: i64 = text.parse().map_err(|_| format!("{key} must be an integer"))?;
    if number < min || number > max {
        return Err(format!("{key} is out of range"));
    }
    Ok(number)
}

fn parse_finite(raw: &str, strictly_positive: bool) -> Result<Value, String> {
    let number: f64 = raw.trim().parse().map_err(|_| "must be a finite number".to_string())?;
    if !number.is_finite() {
        return Err("must be a finite number".into());
    }
    if strictly_positive && number <= 0.0 {
        return Err("must be greater than 0".into());
    }
    if !strictly_positive && number < 0.0 {
        return Err("must be 0 or greater".into());
    }
    if !raw.contains(['.', 'e', 'E']) {
        if let Ok(integer) = raw.trim().parse::<i64>() {
            return Ok(Value::Integer(integer));
        }
    }
    Ok(Value::Float(number))
}

fn parse_runtime(raw: &str) -> Result<String, String> {
    if matches!(raw, "auto" | "none" | "docker" | "podman" | "namespace" | "bwrap") {
        Ok(raw.to_string())
    } else {
        Err("sandbox.runtime must be auto, none, docker, podman, namespace, or bwrap".into())
    }
}

fn parse_image(raw: &str) -> Result<String, String> {
    match sandbox_limits(raw, "512m", "1") {
        Some((image, _, _)) => Ok(image),
        None => Err("sandbox.image is not a plain image name".into()),
    }
}

fn parse_memory(raw: &str) -> Result<String, String> {
    match sandbox_limits("python:3.12-slim", raw, "1") {
        Some((_, memory, _)) => Ok(memory),
        None => Err("sandbox.memory is not a plain limit".into()),
    }
}

fn parse_cpus(raw: &str) -> Result<String, String> {
    match sandbox_limits("python:3.12-slim", "512m", raw) {
        Some((_, _, cpus)) => Ok(cpus),
        None => Err("sandbox.cpus is not a plain limit".into()),
    }
}

fn parse_hosts(raw: &str) -> Result<Vec<String>, String> {
    if raw.eq_ignore_ascii_case("none") {
        return Ok(Vec::new());
    }
    let mut hosts = Vec::new();
    for part in raw.split(',') {
        let host = part.trim();
        if host.is_empty()
            || host.chars().any(char::is_whitespace)
            || host.contains("://")
            || host.contains('@')
            || host.contains('/')
            || host.contains('?')
            || host.contains('#')
        {
            return Err("host lists are comma-separated hostnames".into());
        }
        hosts.push(host.to_string());
    }
    Ok(hosts)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::config::{ensure_home, load_config};
    use std::collections::VecDeque;

    fn feed(home: &Path, lines: &[&str]) -> Result<String, String> {
        let mut lines: VecDeque<String> = lines.iter().map(|line| (*line).to_string()).collect();
        let mut out = Vec::new();
        let mut err = Vec::new();
        let result = run_configure(home, |_| lines.pop_front(), &mut out, &mut err);
        result.map(|_| String::from_utf8_lossy(&err).into_owned())
    }

    #[test]
    fn done_immediately_leaves_config_unchanged() {
        let home = std::env::temp_dir().join(format!("idlehand-cfg-skip-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&home);
        let before = ensure_home(&home).unwrap();
        let bytes = std::fs::read(home.join("config.toml")).unwrap();
        feed(&home, &["done"]).unwrap();
        let after = load_config(&home).unwrap();
        assert_eq!(before.to_string(), after.to_string());
        assert_eq!(bytes, std::fs::read(home.join("config.toml")).unwrap());
        let _ = std::fs::remove_dir_all(&home);
    }

    #[test]
    fn changing_subscription_and_limit_writes_only_those() {
        let home = std::env::temp_dir().join(format!("idlehand-cfg-set-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&home);
        ensure_home(&home).unwrap();
        feed(
            &home,
            &["subscription", "claude", "skip", "spending", "5000", "skip", "skip", "done"],
        )
        .unwrap();
        let config = load_config(&home).unwrap();
        assert_eq!(config.get("subscription").and_then(Value::as_str), Some("claude"));
        assert_eq!(config.get("spending_limit_tokens").and_then(Value::as_integer), Some(5000));
        assert_eq!(config.get("estimate_tokens_per_cycle").and_then(Value::as_integer), Some(2500));
        assert_eq!(config.get("demo").and_then(Value::as_bool), Some(false));
        assert!(config.get("node_id").and_then(Value::as_str).unwrap_or("").len() > 8);
        let _ = std::fs::remove_dir_all(&home);
    }

    #[test]
    fn invalid_value_is_rejected_and_not_saved() {
        let home = std::env::temp_dir().join(format!("idlehand-cfg-bad-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&home);
        ensure_home(&home).unwrap();
        let before = std::fs::read(home.join("config.toml")).unwrap();
        let err = feed(&home, &["spending", "-1", "skip", "skip", "skip", "done"]).unwrap();
        assert!(err.contains("rejected"));
        assert_eq!(before, std::fs::read(home.join("config.toml")).unwrap());
        assert_eq!(
            load_config(&home).unwrap().get("spending_limit_tokens").and_then(Value::as_integer),
            Some(10_000)
        );
        let _ = std::fs::remove_dir_all(&home);
    }
}
