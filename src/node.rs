//! The IdleHand node process. It stays up until it is stopped.

use std::fs;
use std::io::Write;
use std::path::Path;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::thread;
use std::time::Duration;

use serde_json::{json, Value};

use crate::config::{self, ensure_home, load_config, load_peers, load_sources};
use crate::engine::{self, load_state, now_iso};
use crate::home::{read_json, write_json, HomeLock};
use crate::peers::publish_document;
use crate::publish::start_publish_server;
use crate::radicle::remember_identity;

static STOPPED: AtomicBool = AtomicBool::new(false);

fn loop_interval(config: &toml::Value) -> f64 {
    match config.get("loop_interval_seconds") {
        Some(toml::Value::Integer(n)) if *n > 0 => *n as f64,
        Some(toml::Value::Float(n)) if n.is_finite() && *n > 0.0 => *n,
        _ => 5.0,
    }
}

fn listen_address(config: &toml::Value) -> (String, u16, bool) {
    let publish = config.get("publish");
    let host = publish
        .and_then(|v| v.get("host"))
        .and_then(toml::Value::as_str)
        .map(str::trim)
        .filter(|host| !host.is_empty())
        .unwrap_or("127.0.0.1");
    let port = match publish.and_then(|v| v.get("port")) {
        Some(toml::Value::Integer(port)) if (0..=65535).contains(port) => *port as u16,
        _ => config::DEFAULT_LISTEN_PORT as u16,
    };
    let listen = match publish.and_then(|v| v.get("listen")) {
        Some(toml::Value::Boolean(value)) => *value,
        _ => true,
    };
    (host.to_string(), port, listen)
}

fn note_tick_error(home: &Path, message: &str) {
    let message = message.chars().take(500).collect::<String>();
    let Ok(_lock) = HomeLock::acquire(home) else {
        return;
    };
    match load_config(home) {
        Err(_) => {
            let Ok(Some(mut raw)) = read_json(&config::state_path(home)) else {
                return;
            };
            if !raw.is_object() {
                return;
            }
            if !raw.get("node").map(|n| n.is_object()).unwrap_or(false) {
                raw["node"] = json!({});
            }
            raw["node"]["last_error"] = json!(message);
            raw["node"]["heartbeat_at"] = json!(now_iso());
            let _ = write_json(&config::state_path(home), &raw);
        }
        Ok(config) => {
            let mut state = load_state(home, &config);
            state["node"]["last_error"] = json!(message);
            state["node"]["heartbeat_at"] = json!(now_iso());
            let _ = write_json(&config::state_path(home), &state);
        }
    }
}

pub fn serve(home: &Path) {
    let config = match ensure_home(home) {
        Ok(config) => config,
        Err(_) => return,
    };
    let _ = remember_identity(home);
    STOPPED.store(false, Ordering::SeqCst);
    let flag = Arc::new(AtomicBool::new(false));
    let term = flag.clone();
    let _ = signal_hook::flag::register(signal_hook::consts::SIGTERM, term);
    let intr = flag.clone();
    let _ = signal_hook::flag::register(signal_hook::consts::SIGINT, intr);
    let (host, port, listen) = listen_address(&config);
    let server = if listen {
        start_publish_server(home, &host, port)
    } else {
        None
    };
    let (listen_host, listen_port) = server
        .as_ref()
        .map(|server| {
            let addr = server.address();
            (addr.ip().to_string(), addr.port())
        })
        .unwrap_or((host, port));
    let listen_url = if server.is_some() {
        format!("http://{listen_host}:{listen_port}/idlehand/publish")
    } else {
        String::new()
    };
    if let Ok(_lock) = HomeLock::acquire(home) {
        if let Ok(config) = load_config(home) {
            let mut state = load_state(home, &config);
            state["node"]["pid"] = json!(std::process::id());
            state["node"]["status"] = json!("up");
            let started = state["node"]["started_at"].as_str().unwrap_or("");
            if started.is_empty() {
                state["node"]["started_at"] = json!(now_iso());
            }
            state["publish"]["url"] = json!(listen_url);
            state["publish"]["port"] = if server.is_some() {
                json!(listen_port)
            } else {
                Value::Null
            };
            let _ = write_json(&config::state_path(home), &state);
            let peers = load_peers(home).unwrap_or_default();
            let repos = load_sources(home).unwrap_or_default();
            let node_id = load_config(home)
                .ok()
                .and_then(|cfg| {
                    cfg.get("node_id")
                        .and_then(toml::Value::as_str)
                        .map(str::to_string)
                })
                .unwrap_or_default();
            let _ = write_json(
                &config::publish_path(home),
                &publish_document(&node_id, &listen_url, &peers, &repos),
            );
        }
    }
    let pid_file = config::pid_path(home);
    if crate::home::is_symlink(&pid_file) {
        let _ = fs::remove_file(&pid_file);
    }
    if let Ok(mut file) = fs::File::create(&pid_file) {
        let _ = write!(file, "{}", std::process::id());
    }
    while !flag.load(Ordering::SeqCst) && !STOPPED.load(Ordering::SeqCst) {
        let _ = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| engine::tick(home)));
        let interval = load_config(home)
            .map(|cfg| loop_interval(&cfg))
            .unwrap_or(5.0);
        let slices = ((interval * 10.0).ceil() as u64).max(1);
        for _ in 0..slices {
            if flag.load(Ordering::SeqCst) {
                break;
            }
            thread::sleep(Duration::from_millis(100));
        }
    }
    if let Some(server) = server {
        server.shutdown();
    }
    if let Ok(_lock) = HomeLock::acquire(home) {
        let mut state = match load_config(home) {
            Ok(config) => load_state(home, &config),
            Err(_) => read_json(&config::state_path(home))
                .ok()
                .flatten()
                .filter(Value::is_object)
                .unwrap_or_else(|| json!({"node": {}})),
        };
        if !state.get("node").map(Value::is_object).unwrap_or(false) {
            state["node"] = json!({});
        }
        state["node"]["status"] = json!("stopped");
        state["node"]["heartbeat_at"] = json!(now_iso());
        let _ = write_json(&config::state_path(home), &state);
    }
    let _ = fs::remove_file(config::pid_path(home));
    let _ = note_tick_error;
}
