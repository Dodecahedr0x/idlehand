//! Text and JSON views of the local node.

use std::path::Path;

use serde_json::{json, Value};

use crate::config::{self, load_config, load_peers, load_sources};
use crate::forge::load_delegated;
use crate::home::read_json;
use crate::process::alive_pid;
use crate::trust::{load_trust, trust_is_readable};

fn whole(value: Option<&Value>) -> (i64, bool) {
    match value {
        None => (0, true),
        Some(Value::String(text)) if text.is_empty() => (0, true),
        Some(Value::Number(number)) => number.as_i64().filter(|n| *n >= 0).map(|n| (n, true)).unwrap_or((0, false)),
        Some(_) => (0, false),
    }
}

pub fn admin_url(state: &Value) -> Option<String> {
    let url = state.get("publish").and_then(|publish| publish.get("url")).and_then(Value::as_str)?;
    let rest = url.strip_prefix("http://")?;
    let (authority, path) = rest.split_once('/').unwrap_or((rest, ""));
    if path != "idlehand/publish" && !url.ends_with("/idlehand/publish") {
        return None;
    }
    let host = authority.rsplit_once(':').map(|(host, _)| host).unwrap_or(authority);
    let host = host.trim_matches(['[', ']']);
    if !matches!(host, "127.0.0.1" | "localhost" | "::1") {
        return None;
    }
    Some(url.trim_end_matches("/idlehand/publish").to_string() + "/idlehand/admin")
}

pub fn snapshot(home: &Path) -> Value {
    let config_exists = home.join("config.toml").exists();
    let (config, config_readable) = if config_exists {
        match load_config(home) {
            Ok(config) => (Some(config), true),
            Err(_) => (None, false),
        }
    } else {
        (None, true)
    };
    let (sources, sources_readable) = match load_sources(home) {
        Ok(sources) => (sources, true),
        Err(_) => (Vec::new(), false),
    };
    let (peers, peers_readable) = match load_peers(home) {
        Ok(peers) => (peers, true),
        Err(_) => (Vec::new(), false),
    };
    let state_file = config::state_path(home);
    let (state, state_readable) = if crate::home::is_symlink(&state_file) {
        (json!({}), false)
    } else {
        match read_json(&state_file) {
            Ok(Some(Value::Object(object))) => (Value::Object(object), true),
            Ok(Some(_)) => (json!({}), false),
            Ok(None) => (json!({}), true),
            Err(_) => (json!({}), false),
        }
    };
    let delegated = load_delegated(home);
    let pid = alive_pid(home);
    let sources_json: Vec<Value> = sources.iter().map(|repo| json!({"url": repo.url, "note": repo.note})).collect();
    let peers_json: Vec<Value> = peers.iter().map(|peer| json!({"url": peer.url, "id": peer.id, "source": peer.source, "endorsements": peer.endorsements})).collect();
    let delegated_json = delegated.as_ref().map(|rows| rows.iter().map(|(provider, name)| json!([provider, name])).collect::<Vec<_>>());
    json!({
        "home": home.display().to_string(),
        "pid": pid.map(|pid| json!(pid)).unwrap_or(Value::Null),
        "node_running": pid.is_some(),
        "config_present": config.as_ref().map(|cfg| !cfg.as_table().map(|t| t.is_empty()).unwrap_or(true)).unwrap_or(false) || (config_exists && !config_readable),
        "config_readable": config_readable,
        "spending_limit_tokens": config.as_ref().and_then(|cfg| cfg.get("spending_limit_tokens")).map(|value| match value { toml::Value::Integer(n) => json!(n), toml::Value::String(text) => json!(text), toml::Value::Boolean(flag) => json!(flag), toml::Value::Float(n) => json!(n), _ => Value::Null }).unwrap_or(Value::Null),
        "rules": config.as_ref().and_then(|cfg| cfg.get("rules")).map(toml_to_json).unwrap_or(json!({})),
        "sources": sources_json,
        "sources_readable": sources_readable,
        "peers": peers_json,
        "peers_readable": peers_readable,
        "trust": load_trust(home),
        "trust_readable": trust_is_readable(home),
        "delegated": delegated_json.clone().unwrap_or_default(),
        "delegated_readable": delegated.is_some(),
        "state": state,
        "state_readable": state_readable,
    })
}

fn toml_to_json(value: &toml::Value) -> Value {
    match value {
        toml::Value::String(text) => json!(text),
        toml::Value::Integer(n) => json!(n),
        toml::Value::Float(n) => json!(n),
        toml::Value::Boolean(flag) => json!(flag),
        toml::Value::Array(items) => Value::Array(items.iter().map(toml_to_json).collect()),
        toml::Value::Table(table) => {
            let mut map = serde_json::Map::new();
            for (key, value) in table { map.insert(key.clone(), toml_to_json(value)); }
            Value::Object(map)
        }
        toml::Value::Datetime(value) => json!(value.to_string()),
    }
}

fn shell_quote(part: &str) -> String {
    if part.is_empty() { return "''".into() }
    if part.chars().all(|c| c.is_ascii_alphanumeric() || matches!(c, '-' | '_' | '.' | '/' | ':' | '=')) {
        part.to_string()
    } else {
        format!("'{}'", part.replace('\'', "'\\''"))
    }
}

pub fn render_text(home: &Path) -> String {
    let snap = snapshot(home);
    let state = snap.get("state").cloned().unwrap_or(json!({}));
    let node = state.get("node").cloned().unwrap_or(json!({}));
    let subscription = state.get("subscription").cloned().unwrap_or(json!({}));
    let loop_value = state.get("loop").cloned().unwrap_or(json!({}));
    let ledger = state.get("ledger").cloned().unwrap_or(json!({}));
    let peers_runtime = state.get("peers_runtime").cloned().unwrap_or(json!({}));
    let plans = state.get("plans").and_then(Value::as_array).cloned().unwrap_or_default();
    let node_line = if snap.get("node_running").and_then(Value::as_bool) == Some(true) {
        format!("up (pid {})", snap.get("pid").and_then(Value::as_u64).unwrap_or(0))
    } else if node.get("status").and_then(Value::as_str) == Some("stopped") {
        "stopped".into()
    } else if snap.get("config_present").and_then(Value::as_bool) != Some(true) {
        "not initialized".into()
    } else {
        "not running".into()
    };
    let sub_line = if subscription.as_object().map(|o| o.is_empty()).unwrap_or(true) {
        "not configured".to_string()
    } else if subscription.get("connected").and_then(Value::as_bool) == Some(true) {
        format!("{} connected ({})", subscription.get("name").and_then(Value::as_str).unwrap_or(""), subscription.get("binary").and_then(Value::as_str).unwrap_or(""))
    } else {
        subscription.get("detail").and_then(Value::as_str).unwrap_or("subscription is not connected").to_string()
    };
    let (estimated, estimated_ok) = whole(ledger.get("estimated_tokens").or(Some(&json!(0))));
    let (metered, metered_ok) = whole(ledger.get("metered_tokens").or(Some(&json!(0))));
    let spent = estimated + metered;
    let limit = ledger.get("limit_tokens").cloned().unwrap_or_else(|| snap.get("spending_limit_tokens").cloned().unwrap_or(Value::Null));
    let metering = ledger.get("metering").and_then(Value::as_str).unwrap_or("local-estimate");
    let spending_detail = if snap.get("state_readable").and_then(Value::as_bool) == Some(false) || !estimated_ok || !metered_ok {
        "spending ledger is unreadable".to_string()
    } else if metering == "reported" {
        "reported by the subscription".into()
    } else if metering == "mixed" {
        format!("{estimated} estimated, {metered} reported")
    } else {
        "local estimate, not billed usage".into()
    };
    let (pushed, _) = whole(state.get("contributions_pushed").or(Some(&json!(0))));
    let recorded = plans.iter().filter(|plan| plan.get("contributed").and_then(Value::as_bool) == Some(true)).count();
    let direct = snap.get("peers").and_then(Value::as_array).cloned().unwrap_or_default();
    let learned = direct.iter().filter(|peer| peer.get("source").and_then(Value::as_str) == Some("peers-of-peers")).count();
    let mut lines = vec![
        "IdleHand".into(),
        format!("  node: {node_line}"),
        format!("  subscription: {sub_line}"),
        format!("  loop: {} — {}", loop_value.get("status").and_then(Value::as_str).unwrap_or("idle"), loop_value.get("reason").and_then(Value::as_str).unwrap_or("")).trim_end_matches(" —").to_string(),
        format!("  spending: {spent} / {limit} tokens ({spending_detail})"),
        format!("  contributions recorded: {recorded}"),
        format!("  contributions pushed: {pushed}"),
        format!("  repos: {} in the local source list", snap.get("sources").and_then(Value::as_array).map(|v| v.len()).unwrap_or(0)),
        format!("  peers: {} direct, {learned} added from peers of peers", direct.len()),
        format!("  remote repo lists ignored: {}", peers_runtime.get("ignored_remote_repos").and_then(Value::as_i64).unwrap_or(0)),
    ];
    if let Some(url) = admin_url(&state) {
        lines.push(format!("  admin: {url}"));
    }
    if snap.get("delegated_readable").and_then(Value::as_bool) == Some(false) {
        lines.push("  delegation list is unreadable".into());
    } else {
        let rows = snap.get("delegated").and_then(Value::as_array).cloned().unwrap_or_default();
        lines.push(format!("  delegated: {}", rows.len()));
        for row in rows {
            if let Some(pair) = row.as_array() {
                lines.push(format!("    {} {}", pair.first().and_then(Value::as_str).unwrap_or(""), pair.get(1).and_then(Value::as_str).unwrap_or("")));
            }
        }
    }
    if snap.get("config_readable").and_then(Value::as_bool) == Some(false) { lines.push("  config is unreadable".into()); }
    if snap.get("sources_readable").and_then(Value::as_bool) == Some(false) { lines.push("  the local source list is unreadable".into()); }
    if snap.get("peers_readable").and_then(Value::as_bool) == Some(false) { lines.push("  the peer list is unreadable".into()); }
    if recorded == 0 { lines.push("  nothing was contributed".into()); }
    if snap.get("trust_readable").and_then(Value::as_bool) == Some(false) {
        lines.push("  trust: trust record is unreadable".into());
    } else if let Some(trust) = snap.get("trust").and_then(Value::as_array) {
        if !trust.is_empty() {
            lines.push("  trust:".into());
            for item in trust.iter().rev().take(8).collect::<Vec<_>>().into_iter().rev() {
                if !item.is_object() { continue }
                let mark = if item.get("accepted").and_then(Value::as_bool) == Some(true) { "accepted" } else { "refused" };
                lines.push(format!("    {mark} {} {} — {}", item.get("kind").and_then(Value::as_str).unwrap_or(""), item.get("subject").and_then(Value::as_str).unwrap_or(""), item.get("reason").and_then(Value::as_str).unwrap_or("")));
            }
        }
    }
    if let Some(error) = peers_runtime.get("last_error").and_then(Value::as_str) {
        if !error.is_empty() { lines.push(format!("  peer fetch: {error}")); }
    }
    if plans.is_empty() {
        lines.push("  plans: 0".into());
    } else {
        lines.push(format!("  plans: {} (latest)", plans.len()));
        for plan in plans.iter().rev().take(5).collect::<Vec<_>>().into_iter().rev() {
            let demo = if plan.get("demo").and_then(Value::as_bool) == Some(true) { " demo" } else { "" };
            let contributed = if plan.get("contributed").and_then(Value::as_bool) == Some(true) { "yes" } else { "no" };
            let fetch = plan.get("fetch").cloned().unwrap_or(json!({}));
            let sandbox = plan.get("sandbox").cloned().unwrap_or(json!({}));
            let detail = if plan.get("upstream_cloned").and_then(Value::as_bool) != Some(true) && fetch.get("reason").and_then(Value::as_str).is_some() {
                fetch.get("reason").and_then(Value::as_str).unwrap_or("")
            } else {
                sandbox.get("reason").and_then(Value::as_str).or_else(|| fetch.get("reason").and_then(Value::as_str)).unwrap_or("")
            };
            let cloned = if plan.get("upstream_cloned").and_then(Value::as_bool) == Some(true) { "yes" } else { "no" };
            lines.push(format!("    {}{demo} {} contributed={contributed} cloned={cloned} {detail}", plan.get("action").and_then(Value::as_str).unwrap_or(""), plan.get("repo").and_then(Value::as_str).unwrap_or("")).trim_end().to_string());
            if let Some(command) = plan.get("subscription_command").and_then(Value::as_array) {
                let rendered = command.iter().filter_map(Value::as_str).map(shell_quote).collect::<Vec<_>>().join(" ");
                if !rendered.is_empty() {
                    let ran = if plan.get("subscription_executed").and_then(Value::as_bool) == Some(true) { "ran on the trusted side" } else { "not run" };
                    lines.push(format!("      command ({ran}): {rendered}"));
                }
            }
        }
    }
    lines.join("\n") + "\n"
}

pub fn render_json(home: &Path) -> String {
    let mut value = snapshot(home);
    sort_json(&mut value);
    serde_json::to_string_pretty(&value).unwrap_or_else(|_| "{}".into()) + "\n"
}

fn sort_json(value: &mut Value) {
    match value {
        Value::Object(map) => {
            let mut entries: Vec<_> = map.iter().map(|(k, v)| (k.clone(), v.clone())).collect();
            entries.sort_by(|a, b| a.0.cmp(&b.0));
            map.clear();
            for (key, mut child) in entries {
                sort_json(&mut child);
                map.insert(key, child);
            }
        }
        Value::Array(items) => items.iter_mut().for_each(sort_json),
        _ => {}
    }
}
