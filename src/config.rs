//! Node configuration, the local repo list, and the peer list.

use std::fs::{self, File};
use std::io::Read;
use std::path::Path;

use toml::Value;

use crate::home::{atomic_write, dump_toml, read_toml, HomeLock};

pub const DEFAULT_SPENDING_LIMIT_TOKENS: i64 = 10_000;
pub const ESTIMATE_TOKENS_PER_CYCLE: i64 = 2_500;
pub const DEFAULT_LISTEN_PORT: i64 = 47321;

pub const CONFIG_HEADER: &str = "\
# IdleHand node configuration. This file is yours.
# The spending limit counts usage the Claude CLI reports. Otherwise it is a local estimate, not a bill from a provider.
";

pub const SOURCES_HEADER: &str = "\
# Local discovery list. This file is yours.
# IdleHand reads it from disk. It is not fetched from a catalog.
# Add repos by editing this file or by opening an idlehand: link.
";

pub const PEERS_HEADER: &str = "\
# Peers this node already has. IdleHand fetches each URL directly.
# Peers of these peers can be added by the heuristic in config.toml.
# This list is not a catalog, and it does not add repositories.
";

pub fn default_config() -> Value {
    let mut root = toml::map::Map::new();
    root.insert("node_id".into(), Value::String(String::new()));
    root.insert("subscription".into(), Value::String(String::new()));
    root.insert("demo".into(), Value::Boolean(false));
    root.insert("spending_limit_tokens".into(), Value::Integer(DEFAULT_SPENDING_LIMIT_TOKENS));
    root.insert("estimate_tokens_per_cycle".into(), Value::Integer(ESTIMATE_TOKENS_PER_CYCLE));
    root.insert("loop_interval_seconds".into(), Value::Integer(5));

    let mut rules = toml::map::Map::new();
    rules.insert("auto_start".into(), Value::Boolean(true));
    rules.insert("allow_test".into(), Value::Boolean(true));
    rules.insert("allow_audit".into(), Value::Boolean(true));
    rules.insert("allow_issues".into(), Value::Boolean(true));
    rules.insert("allow_pull_requests".into(), Value::Boolean(true));
    root.insert("rules".into(), Value::Table(rules));

    let mut sandbox = toml::map::Map::new();
    sandbox.insert("runtime".into(), Value::String("auto".into()));
    sandbox.insert("execute".into(), Value::Boolean(true));
    sandbox.insert("image".into(), Value::String("python:3.12-slim".into()));
    sandbox.insert("memory".into(), Value::String("512m".into()));
    sandbox.insert("cpus".into(), Value::String("1".into()));
    root.insert("sandbox".into(), Value::Table(sandbox));

    let mut publish = toml::map::Map::new();
    publish.insert("listen".into(), Value::Boolean(true));
    publish.insert("host".into(), Value::String("127.0.0.1".into()));
    publish.insert("port".into(), Value::Integer(DEFAULT_LISTEN_PORT));
    publish.insert("peer_fetch_interval_seconds".into(), Value::Integer(60));
    root.insert("publish".into(), Value::Table(publish));

    let mut heuristic = toml::map::Map::new();
    heuristic.insert("min_endorsements".into(), Value::Integer(1));
    heuristic.insert("max_new_peers_per_cycle".into(), Value::Integer(5));
    heuristic.insert("max_peers".into(), Value::Integer(50));
    heuristic.insert("require_https".into(), Value::Boolean(true));
    heuristic.insert("allow_insecure_loopback".into(), Value::Boolean(true));
    heuristic.insert("allowed_hosts".into(), Value::Array(Vec::new()));
    heuristic.insert("blocked_hosts".into(), Value::Array(Vec::new()));
    root.insert("peer_heuristic".into(), Value::Table(heuristic));
    Value::Table(root)
}

pub fn default_repos() -> Vec<(String, String)> {
    vec![
        (
            "https://example.com/idlehand/sample-alpha".into(),
            "Example. Replace this with a repository you want IdleHand to work on.".into(),
        ),
        (
            "https://example.com/idlehand/sample-beta".into(),
            "Example. Replace this with a repository you want IdleHand to work on.".into(),
        ),
    ]
}

pub fn config_path(home: &Path) -> std::path::PathBuf {
    home.join("config.toml")
}
pub fn sources_path(home: &Path) -> std::path::PathBuf {
    home.join("sources.toml")
}
pub fn peers_path(home: &Path) -> std::path::PathBuf {
    home.join("peers.toml")
}
pub fn state_path(home: &Path) -> std::path::PathBuf {
    home.join("state.json")
}
pub fn publish_path(home: &Path) -> std::path::PathBuf {
    home.join("publish.json")
}
pub fn pid_path(home: &Path) -> std::path::PathBuf {
    home.join("node.pid")
}
pub fn log_path(home: &Path) -> std::path::PathBuf {
    home.join("node.log")
}

pub fn merge_defaults(defaults: &Value, loaded: &Value) -> Value {
    let Some(default_table) = defaults.as_table() else {
        return loaded.clone();
    };
    let loaded_table = loaded.as_table();
    let mut merged = toml::map::Map::new();
    for (key, value) in default_table {
        if let Some(found) = loaded_table.and_then(|table| table.get(key)) {
            merged.insert(key.clone(), merge_defaults(value, found));
        } else {
            merged.insert(key.clone(), value.clone());
        }
    }
    if let Some(table) = loaded_table {
        for (key, value) in table {
            if !merged.contains_key(key) {
                merged.insert(key.clone(), value.clone());
            }
        }
    }
    Value::Table(merged)
}

pub fn load_config(home: &Path) -> Result<Value, String> {
    Ok(merge_defaults(&default_config(), &read_toml(&config_path(home))?))
}

pub fn save_config(home: &Path, config: &Value) -> Result<(), String> {
    let text = dump_toml(config, CONFIG_HEADER)?;
    atomic_write(&config_path(home), &text).map_err(|err| err.to_string())
}

#[derive(Debug, Clone)]
pub struct Source {
    pub url: String,
    pub note: String,
}

pub fn load_sources(home: &Path) -> Result<Vec<Source>, String> {
    let data = read_toml(&sources_path(home))?;
    let Some(repos) = data.get("repos").and_then(Value::as_array) else {
        return Ok(Vec::new());
    };
    let mut cleaned = Vec::new();
    for repo in repos {
        let Some(table) = repo.as_table() else {
            continue;
        };
        let Some(url) = table.get("url").and_then(Value::as_str) else {
            continue;
        };
        let note = match table.get("note") {
            Some(Value::String(note)) => note.clone(),
            Some(other) => scalar_string(other),
            None => String::new(),
        };
        cleaned.push(Source { url: url.to_string(), note });
    }
    Ok(cleaned)
}

fn scalar_string(value: &Value) -> String {
    match value {
        Value::String(text) => text.clone(),
        Value::Integer(value) => value.to_string(),
        Value::Float(value) => value.to_string(),
        Value::Boolean(value) => value.to_string(),
        _ => String::new(),
    }
}

pub fn save_sources(home: &Path, repos: &[Source]) -> Result<(), String> {
    let mut rows = Vec::new();
    for repo in repos {
        let mut row = toml::map::Map::new();
        row.insert("url".into(), Value::String(repo.url.clone()));
        row.insert("note".into(), Value::String(repo.note.clone()));
        rows.push(Value::Table(row));
    }
    let mut root = toml::map::Map::new();
    root.insert("repos".into(), Value::Array(rows));
    let text = dump_toml(&Value::Table(root), SOURCES_HEADER)?;
    atomic_write(&sources_path(home), &text).map_err(|err| err.to_string())
}

#[derive(Debug, Clone)]
pub struct Peer {
    pub url: String,
    pub id: String,
    pub source: String,
    pub endorsements: i64,
}

pub fn load_peers(home: &Path) -> Result<Vec<Peer>, String> {
    let data = read_toml(&peers_path(home))?;
    let Some(peers) = data.get("peers").and_then(Value::as_array) else {
        return Ok(Vec::new());
    };
    let mut cleaned = Vec::new();
    for peer in peers {
        let Some(table) = peer.as_table() else {
            continue;
        };
        let Some(url) = table.get("url").and_then(Value::as_str) else {
            continue;
        };
        let count = match table.get("endorsements") {
            Some(Value::Integer(value)) if *value >= 0 => *value,
            _ => 1,
        };
        cleaned.push(Peer {
            url: url.to_string(),
            id: table.get("id").and_then(Value::as_str).unwrap_or("").to_string(),
            source: table.get("source").and_then(Value::as_str).unwrap_or("user").to_string(),
            endorsements: count,
        });
    }
    Ok(cleaned)
}

pub fn save_peers(home: &Path, peers: &[Peer]) -> Result<(), String> {
    let mut rows = Vec::new();
    for peer in peers {
        let mut row = toml::map::Map::new();
        row.insert("url".into(), Value::String(peer.url.clone()));
        row.insert("id".into(), Value::String(peer.id.clone()));
        row.insert("source".into(), Value::String(peer.source.clone()));
        row.insert("endorsements".into(), Value::Integer(peer.endorsements));
        rows.push(Value::Table(row));
    }
    let mut root = toml::map::Map::new();
    root.insert("peers".into(), Value::Array(rows));
    let text = dump_toml(&Value::Table(root), PEERS_HEADER)?;
    atomic_write(&peers_path(home), &text).map_err(|err| err.to_string())
}

fn random_node_id() -> String {
    let mut bytes = [0u8; 16];
    if File::open("/dev/urandom").and_then(|mut file| file.read_exact(&mut bytes)).is_err() {
        let nanos = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|duration| duration.as_nanos())
            .unwrap_or(1);
        bytes = nanos.to_le_bytes();
    }
    bytes[6] = (bytes[6] & 0x0f) | 0x40;
    bytes[8] = (bytes[8] & 0x3f) | 0x80;
    bytes.iter().map(|byte| format!("{byte:02x}")).collect()
}

pub fn ensure_home(home: &Path) -> Result<Value, String> {
    let _lock = HomeLock::acquire(home).map_err(|err| err.to_string())?;
    fs::create_dir_all(home).map_err(|err| err.to_string())?;
    fs::create_dir_all(home.join("workspaces")).map_err(|err| err.to_string())?;
    if !config_path(home).exists() {
        let mut config = default_config();
        if let Some(table) = config.as_table_mut() {
            table.insert("node_id".into(), Value::String(random_node_id()));
        }
        save_config(home, &config)?;
    } else {
        let mut config = load_config(home)?;
        let missing = config.get("node_id").and_then(Value::as_str).map(|id| id.is_empty()).unwrap_or(true);
        if missing {
            if let Some(table) = config.as_table_mut() {
                table.insert("node_id".into(), Value::String(random_node_id()));
            }
            save_config(home, &config)?;
        }
    }
    if !sources_path(home).exists() {
        let repos = default_repos()
            .into_iter()
            .map(|(url, note)| Source { url, note })
            .collect::<Vec<_>>();
        save_sources(home, &repos)?;
    }
    if !peers_path(home).exists() {
        save_peers(home, &[])?;
    }
    load_config(home)
}

pub fn append_log(home: &Path, line: &str) {
    let path = log_path(home);
    if crate::home::is_symlink(&path) {
        return;
    }
    if let Some(parent) = path.parent() {
        let _ = fs::create_dir_all(parent);
    }
    if let Ok(mut file) = fs::OpenOptions::new().create(true).append(true).open(path) {
        let _ = std::io::Write::write_all(&mut file, line.trim_end_matches(['\n', '\r']).as_bytes());
        let _ = std::io::Write::write_all(&mut file, b"\n");
    }
}

pub fn table_get<'a>(value: &'a Value, key: &str) -> Option<&'a Value> {
    value.get(key)
}

pub fn as_nonneg_int(value: Option<&Value>) -> Option<i64> {
    match value {
        Some(Value::Integer(number)) if *number >= 0 => Some(*number),
        _ => None,
    }
}

pub fn as_bool(value: Option<&Value>) -> Option<bool> {
    value.and_then(Value::as_bool)
}
