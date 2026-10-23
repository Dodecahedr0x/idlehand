//! One tick of the node: peer fetch, then at most one contribution cycle.

use std::collections::{BTreeMap, BTreeSet};
use std::fs;
use std::path::{Path, PathBuf};
use std::time::{SystemTime, UNIX_EPOCH};

use serde_json::{json, Value};

use crate::actions::action_command;
use crate::config::{self, load_config, load_peers, load_sources, save_peers, Peer, Source};
use crate::fetch::{self, clone_repository, embeds_credentials, public_url, scrub_secrets};
use crate::home::{read_json, write_json, HomeLock};
use crate::peers::{
    self, count_remote_repos, load_peer_document, normalize_peer_url, normalize_safe, public_label,
    publish_document, review_second_degree,
};
use crate::sandbox::{self, detect_runtime, sandbox_limits};
use crate::subscriptions::{inspect_subscription, subscription_command};
use crate::trust::{self, extend_trust};
use crate::usage::{claude_argv, plan_with_claude};

const ACTIONS: &[(&str, &str)] = &[
    ("test", "allow_test"),
    ("audit", "allow_audit"),
    ("issue", "allow_issues"),
    ("pull_request", "allow_pull_requests"),
];

pub fn now_iso() -> String {
    trust::now_iso()
}

fn ledger_count(value: Option<&Value>) -> Option<i64> {
    match value {
        Some(Value::Number(number)) => number.as_i64().filter(|n| *n >= 0),
        Some(Value::Bool(_)) | None => None,
        _ => None,
    }
}

fn counter(value: Option<&Value>) -> i64 {
    ledger_count(value).unwrap_or(0)
}

fn limit_of(config: &toml::Value) -> Option<i64> {
    match config.get("spending_limit_tokens") {
        Some(toml::Value::Integer(n)) if *n >= 0 => Some(*n),
        _ => None,
    }
}

fn fetch_interval(value: Option<&toml::Value>) -> Option<f64> {
    match value {
        Some(toml::Value::Integer(n)) if *n >= 0 => Some(*n as f64),
        Some(toml::Value::Float(n)) if n.is_finite() && *n >= 0.0 => Some(*n),
        _ => None,
    }
}

fn rule_flag(rules: Option<&toml::Value>, name: &str, default: bool) -> Option<bool> {
    let Some(rules) = rules.and_then(toml::Value::as_table) else {
        return Some(default);
    };
    match rules.get(name) {
        None => Some(default),
        Some(toml::Value::Boolean(value)) => Some(*value),
        Some(_) => None,
    }
}

pub fn fresh_state(config: &toml::Value) -> Value {
    json!({
        "node": {"status": "up", "pid": std::process::id(), "started_at": "", "heartbeat_at": "", "last_error": ""},
        "subscription": {"name": "", "connected": false, "binary": "", "detail": ""},
        "loop": {"status": "idle", "reason": "", "cycles": 0},
        "ledger": {
            "estimated_tokens": 0,
            "metered_tokens": 0,
            "limit_tokens": limit_of(config).unwrap_or(0),
            "metering": "local-estimate"
        },
        "plans": [],
        "contributions_pushed": 0,
        "publish": {"url": "", "port": Value::Null},
        "peers_runtime": {"last_fetch_at": "", "last_fetch_epoch": 0, "last_error": "", "added": 0, "ignored_remote_repos": 0}
    })
}

fn mark_unreadable(home: &Path, reason: &str) -> Value {
    let mut raw = match read_json(&config::state_path(home)) {
        Ok(Some(Value::Object(_))) => read_json(&config::state_path(home)).ok().flatten().unwrap(),
        _ => fresh_state(&toml::Value::Table({
            let mut map = toml::map::Map::new();
            map.insert("spending_limit_tokens".into(), toml::Value::Integer(0));
            map
        })),
    };
    let loop_value = raw.get_mut("loop").and_then(Value::as_object_mut);
    if loop_value.is_none() {
        raw["loop"] = json!({});
    }
    if let Some(object) = raw.get_mut("loop").and_then(Value::as_object_mut) {
        object.insert("status".into(), json!("stopped"));
        object.insert("reason".into(), json!(reason));
    }
    let _ = write_json(&config::state_path(home), &raw);
    raw
}

pub fn load_state(home: &Path, config: &toml::Value) -> Value {
    let mut broken = false;
    let raw = match read_json(&config::state_path(home)) {
        Ok(value) => value,
        Err(_) => {
            broken = true;
            None
        }
    };
    let mut state = fresh_state(config);
    let limit = limit_of(config).unwrap_or(0);
    if broken || raw.as_ref().is_some_and(|value| !value.is_object()) {
        state["ledger"]["estimated_tokens"] = json!(limit);
        state["loop"]["status"] = json!("stopped");
        state["loop"]["reason"] = json!("spending ledger is unreadable");
        return state;
    }
    let Some(raw) = raw else { return state };
    if let Some(plans) = raw.get("plans").and_then(Value::as_array) {
        state["plans"] = Value::Array(
            plans
                .iter()
                .filter(|item| item.is_object())
                .cloned()
                .collect(),
        );
    }
    if let Some(ledger) = raw.get("ledger").and_then(Value::as_object) {
        let estimated = ledger_count(ledger.get("estimated_tokens").or(Some(&json!(0))));
        let metered = ledger_count(ledger.get("metered_tokens").or(Some(&json!(0))));
        if estimated.is_none() || metered.is_none() {
            state["ledger"]["estimated_tokens"] = json!(limit);
            state["ledger"]["metered_tokens"] = json!(metered.unwrap_or(0));
            state["loop"]["status"] = json!("stopped");
            state["loop"]["reason"] = json!("spending ledger is unreadable");
        } else {
            state["ledger"]["estimated_tokens"] = json!(estimated.unwrap());
            state["ledger"]["metered_tokens"] = json!(metered.unwrap());
        }
        if let Some(metering) = ledger.get("metering").and_then(Value::as_str) {
            if matches!(metering, "local-estimate" | "reported" | "mixed") {
                state["ledger"]["metering"] = json!(metering);
            }
        }
    }
    if let Some(loop_value) = raw.get("loop").and_then(Value::as_object) {
        let cycles = loop_value
            .get("cycles")
            .and_then(Value::as_i64)
            .filter(|n| *n >= 0)
            .unwrap_or(0);
        state["loop"]["cycles"] = json!(cycles);
        if state["loop"]["reason"].as_str() != Some("spending ledger is unreadable") {
            state["loop"]["status"] = json!(loop_value
                .get("status")
                .and_then(Value::as_str)
                .unwrap_or("idle"));
            state["loop"]["reason"] = json!(loop_value
                .get("reason")
                .and_then(Value::as_str)
                .unwrap_or(""));
        }
    }
    if let Some(started) = raw
        .get("node")
        .and_then(|n| n.get("started_at"))
        .and_then(Value::as_str)
    {
        if !started.is_empty() {
            state["node"]["started_at"] = json!(started);
        }
    }
    if let Some(publish) = raw.get("publish").and_then(Value::as_object) {
        if let Some(url) = publish.get("url").and_then(Value::as_str) {
            if !url.is_empty() {
                state["publish"]["url"] = json!(url);
            }
        }
        if let Some(port) = publish.get("port") {
            if !port.is_null() {
                state["publish"]["port"] = port.clone();
            }
        }
    }
    if let Some(runtime) = raw.get("peers_runtime").and_then(Value::as_object) {
        if let Some(object) = state
            .get_mut("peers_runtime")
            .and_then(Value::as_object_mut)
        {
            for (key, value) in runtime {
                object.insert(key.clone(), value.clone());
            }
        }
    }
    state["ledger"]["limit_tokens"] = json!(limit);
    state
}

fn enabled_actions(rules: Option<&toml::Value>) -> (Vec<String>, bool) {
    let mut enabled = Vec::new();
    let mut unreadable = false;
    for (name, flag) in ACTIONS {
        match rule_flag(rules, flag, false) {
            None => unreadable = true,
            Some(true) => enabled.push((*name).to_string()),
            Some(false) => {}
        }
    }
    (enabled, unreadable)
}

fn workspace(home: &Path, repo_url: &str) -> PathBuf {
    home.join("workspaces").join(forge_slug(repo_url))
}

fn forge_slug(text: &str) -> String {
    crate::forge::draft_slug(text)
}

fn draft_dir(home: &Path, repo_url: &str) -> Option<PathBuf> {
    let root = home.canonicalize().unwrap_or_else(|_| home.to_path_buf());
    let drafts = home.join("drafts");
    if crate::home::is_symlink(&drafts) {
        return None;
    }
    let destination = drafts.join(forge_slug(repo_url));
    if crate::home::is_symlink(&destination) {
        return None;
    }
    fs::create_dir_all(&destination).ok()?;
    let resolved = destination.canonicalize().ok()?;
    resolved.starts_with(&root).then_some(destination)
}

fn keep_drafts(home: &Path, workspace: &Path, repo_url: &str) {
    let produced = workspace.join(".idlehand");
    if !produced.is_dir() || crate::home::is_symlink(&produced) {
        return;
    }
    let Some(destination) = draft_dir(home, repo_url) else {
        return;
    };
    for name in ["audit.txt", "issue-draft.md", "pr-draft.md"] {
        let source = produced.join(name);
        let target = destination.join(name);
        let temporary = destination.join(format!(".{name}.tmp"));
        if !source.is_file()
            || crate::home::is_symlink(&source)
            || crate::home::is_symlink(&target)
            || crate::home::is_symlink(&temporary)
        {
            continue;
        }
        let Ok(meta) = source.metadata() else {
            continue;
        };
        if meta.len() > 1_000_000 {
            continue;
        }
        let Ok(text) = fs::read_to_string(&source) else {
            continue;
        };
        let lines = scrub_secrets(&text)
            .lines()
            .map(|line| {
                if line.contains("PRIVATE KEY") {
                    "private key material omitted".to_string()
                } else {
                    line.to_string()
                }
            })
            .collect::<Vec<_>>()
            .join("\n");
        if fs::write(&temporary, format!("{lines}\n")).is_ok() {
            let _ = fs::rename(&temporary, &target);
        }
    }
}

fn write_publish(
    home: &Path,
    config: &toml::Value,
    peers: &[Peer],
    repos: &[Source],
    listen_url: &str,
) {
    let document = publish_document(
        config
            .get("node_id")
            .and_then(toml::Value::as_str)
            .unwrap_or(""),
        listen_url,
        peers,
        repos,
    );
    let _ = write_json(&config::publish_path(home), &document);
}

fn not_run(runtime: Option<&str>, reason: &str) -> Value {
    json!({"runtime": runtime.unwrap_or("none"), "invoked": false, "ok": false, "exit_code": Value::Null, "stdout": "", "stderr": "", "reason": reason, "argv": []})
}

fn fetch_peers(
    peers: &[Peer],
    config: &toml::Value,
    listen_url: &str,
    home: &Path,
) -> (
    Vec<peers::PeerCandidate>,
    i64,
    Vec<String>,
    BTreeMap<String, String>,
    Vec<Value>,
) {
    let mut documents = BTreeMap::new();
    let mut ignored = 0i64;
    let mut errors = Vec::new();
    let mut id_updates = BTreeMap::new();
    for peer in peers {
        if embeds_credentials(&peer.url) {
            errors.push("peer URLs cannot embed credentials".into());
            continue;
        }
        match load_peer_document(&peer.url, std::time::Duration::from_secs(10))
            .and_then(|document| normalize_peer_url(&peer.url).map(|key| (key, document)))
        {
            Ok((key, document)) => {
                ignored += count_remote_repos(&document) as i64;
                if let Some(label) = document
                    .get("node_id")
                    .and_then(Value::as_str)
                    .map(public_label)
                    .filter(|label| !label.is_empty())
                {
                    id_updates.insert(key.clone(), label);
                }
                documents.insert(key, document);
            }
            Err(err) => errors.push(
                scrub_secrets(&format!("{}: {err}", peer.url))
                    .chars()
                    .take(300)
                    .collect(),
            ),
        }
    }
    let existing: BTreeSet<String> = peers
        .iter()
        .filter_map(|peer| normalize_peer_url(&peer.url).ok())
        .collect();
    let mut self_urls = BTreeSet::new();
    if !listen_url.is_empty() {
        self_urls.insert(normalize_safe(listen_url));
    }
    if let Ok(path) = (home.join("publish.json")).canonicalize() {
        self_urls.insert(path_to_uri(&path));
    }
    let heuristic = config
        .get("peer_heuristic")
        .cloned()
        .unwrap_or(toml::Value::Table(toml::map::Map::new()));
    let (additions, decisions) = review_second_degree(
        config
            .get("node_id")
            .and_then(toml::Value::as_str)
            .unwrap_or(""),
        &self_urls,
        peers,
        &documents,
        &existing,
        &heuristic,
    );
    (additions, ignored, errors, id_updates, decisions)
}

fn path_to_uri(path: &Path) -> String {
    format!("file://{}", path.display())
}

struct Job {
    repo_url: String,
    recorded_url: String,
    action: String,
    demo: bool,
    command: Option<Vec<String>>,
    runtime: Option<String>,
    configured_runtime: String,
    image: String,
    memory: String,
    cpus: String,
    workspace: PathBuf,
    plan_cli: String,
    refusal: String,
}

fn prepare_cycle(
    home: &Path,
    config: &toml::Value,
    sources: &[Source],
    state: &mut Value,
    demo: bool,
) -> Option<Job> {
    let cycles = state["loop"]["cycles"].as_i64().unwrap_or(0);
    let spent = state["ledger"]["estimated_tokens"].as_i64().unwrap_or(0)
        + state["ledger"]["metered_tokens"].as_i64().unwrap_or(0);
    let Some(limit) = limit_of(config) else {
        state["loop"]["status"] = json!("stopped");
        state["loop"]["reason"] = json!("spending limit is unreadable");
        state["ledger"]["limit_tokens"] = json!(0);
        return None;
    };
    let cost = match config.get("estimate_tokens_per_cycle") {
        Some(toml::Value::Integer(n)) if *n > 0 => Some(*n),
        _ => None,
    };
    state["ledger"]["limit_tokens"] = json!(limit);
    let Some(cost) = cost else {
        state["loop"]["status"] = json!("stopped");
        state["loop"]["reason"] = json!("the per-cycle estimate must be positive");
        return None;
    };
    if state["loop"]["reason"].as_str() == Some("spending ledger is unreadable") {
        state["loop"]["status"] = json!("stopped");
        return None;
    }
    if spent >= limit || spent + cost > limit {
        state["loop"]["status"] = json!("stopped");
        state["loop"]["reason"] = json!("spending limit reached");
        return None;
    }
    let auto = rule_flag(config.get("rules"), "auto_start", true);
    if !demo && auto != Some(true) {
        state["loop"]["status"] = json!(if auto == Some(false) {
            "idle"
        } else {
            "stopped"
        });
        state["loop"]["reason"] = json!(if auto == Some(false) {
            "auto start is off"
        } else {
            "auto start is unreadable"
        });
        return None;
    }
    let (actions, unreadable) = enabled_actions(config.get("rules"));
    if sources.is_empty() {
        state["loop"]["status"] = json!("idle");
        state["loop"]["reason"] = json!("the local source list is empty");
        return None;
    }
    if actions.is_empty() {
        state["loop"]["status"] = json!(if unreadable { "stopped" } else { "idle" });
        state["loop"]["reason"] = json!(if unreadable {
            "a contribution rule is unreadable"
        } else {
            "every contribution action is turned off"
        });
        return None;
    }
    let repo_url = sources[(cycles as usize) % sources.len()].url.clone();
    let recorded_url = {
        let shown = public_url(&repo_url);
        if shown.is_empty() {
            "list entry".into()
        } else {
            shown
        }
    };
    let action = actions[(cycles as usize) % actions.len()].clone();
    let status = inspect_subscription(
        config
            .get("subscription")
            .and_then(toml::Value::as_str)
            .unwrap_or(""),
    );
    let command = if status.connected && !status.binary.is_empty() {
        Some(if status.name == "claude" {
            claude_argv(&status.binary, &recorded_url, &action)
        } else {
            subscription_command(&status.name, &status.binary, &recorded_url, &action)
        })
    } else {
        None
    };
    let sandbox_cfg = config.get("sandbox");
    let (runtime_known, configured_runtime) = match sandbox_cfg {
        Some(table) if table.get("runtime").is_none() => (true, "auto".to_string()),
        Some(table) => match table.get("runtime").and_then(toml::Value::as_str) {
            Some("") => (true, "auto".to_string()),
            Some(value)
                if matches!(
                    value,
                    "auto" | "none" | "docker" | "podman" | "namespace" | "bwrap"
                ) =>
            {
                (true, value.to_string())
            }
            Some(_) => (false, "auto".to_string()),
            None => (false, "auto".to_string()),
        },
        None => (false, "auto".to_string()),
    };
    let runtime = if runtime_known {
        detect_runtime(&configured_runtime)
    } else {
        None
    };
    let mut refusal = String::new();
    match rule_flag(sandbox_cfg, "execute", true) {
        None => refusal = "sandbox execution is unreadable".into(),
        Some(false) => refusal = "sandbox execution is off".into(),
        Some(true) if !runtime_known => refusal = "sandbox runtime is unreadable".into(),
        Some(true) if runtime.is_none() => {
            refusal = "no sandbox runtime is available; refused to run on the host".into()
        }
        _ => {}
    }
    let limits = sandbox_cfg.and_then(|cfg| {
        sandbox_limits(
            cfg.get("image")
                .and_then(toml::Value::as_str)
                .unwrap_or("python:3.12-slim"),
            cfg.get("memory")
                .and_then(toml::Value::as_str)
                .unwrap_or("512m"),
            cfg.get("cpus").and_then(toml::Value::as_str).unwrap_or("1"),
        )
    });
    if refusal.is_empty() && limits.is_none() {
        refusal = "sandbox limit is unreadable".into();
    }
    let (image, memory, cpus) =
        limits.unwrap_or(("python:3.12-slim".into(), "512m".into(), "1".into()));
    let _ = cost;
    Some(Job {
        repo_url: repo_url.clone(),
        recorded_url,
        action,
        demo,
        command,
        runtime,
        configured_runtime,
        image,
        memory,
        cpus,
        workspace: workspace(home, &repo_url),
        plan_cli: if status.name == "claude" && status.connected && !demo && refusal.is_empty() {
            status.binary
        } else {
            String::new()
        },
        refusal,
    })
}

struct Outcome {
    fetch: Value,
    sandbox: Value,
    cloned: bool,
    planner: Option<Value>,
}

fn run_job(job: &Job, home: &Path) -> Outcome {
    if !job.refusal.is_empty() {
        return Outcome {
            fetch: json!({"cloned": false, "reason": "not fetched; sandbox refused"}),
            sandbox: not_run(job.runtime.as_deref(), &job.refusal),
            cloned: false,
            planner: None,
        };
    }
    let fetch = clone_repository(
        &job.repo_url,
        &job.workspace,
        None,
        std::time::Duration::from_secs(60),
    );
    if !fetch.cloned {
        return Outcome {
            fetch: json!({"cloned": false, "reason": fetch.reason}),
            sandbox: not_run(
                job.runtime.as_deref(),
                "not run; repository was not fetched",
            ),
            cloned: false,
            planner: None,
        };
    }
    let planner = if job.plan_cli.is_empty() {
        None
    } else {
        Some(plan_with_claude(
            &job.plan_cli,
            &job.recorded_url,
            &job.action,
            home,
        ))
    };
    let result = sandbox::run(
        &job.workspace,
        &action_command(&job.action, job.runtime.as_deref().unwrap_or("namespace")),
        &job.configured_runtime,
        &job.image,
        &job.memory,
        &job.cpus,
        std::time::Duration::from_secs(120),
    );
    if result.invoked {
        keep_drafts(home, &job.workspace, &job.repo_url);
    }
    Outcome {
        fetch: json!({"cloned": true, "reason": fetch.reason}),
        sandbox: result.as_json(),
        cloned: true,
        planner,
    }
}

fn apply_usage(state: &mut Value, source: &str) {
    let estimated = state["ledger"]["estimated_tokens"].as_i64().unwrap_or(0);
    let metered = state["ledger"]["metered_tokens"].as_i64().unwrap_or(0);
    let current = state["ledger"]["metering"]
        .as_str()
        .unwrap_or("local-estimate");
    let next = if source == "reported" {
        if estimated > 0 || current == "mixed" {
            "mixed"
        } else {
            "reported"
        }
    } else if metered > 0 || current == "reported" || current == "mixed" {
        "mixed"
    } else {
        "local-estimate"
    };
    state["ledger"]["metering"] = json!(next);
}

fn commit_cycle(
    home: &Path,
    config: &toml::Value,
    state: &mut Value,
    job: &Job,
    outcome: &Outcome,
) {
    let cycles = state["loop"]["cycles"].as_i64().unwrap_or(0);
    let cost = match config.get("estimate_tokens_per_cycle") {
        Some(toml::Value::Integer(n)) if *n > 0 => *n,
        _ => 0,
    };
    let limit = limit_of(config).unwrap_or(0);
    let invoked = outcome
        .sandbox
        .get("invoked")
        .and_then(Value::as_bool)
        .unwrap_or(false);
    let reported = outcome
        .planner
        .as_ref()
        .and_then(|planner| planner.get("tokens"))
        .and_then(Value::as_i64);
    let executed = outcome
        .planner
        .as_ref()
        .and_then(|planner| planner.get("executed"))
        .and_then(Value::as_bool)
        .unwrap_or(false);
    let (usage, charged_estimate, charged_metered) = if let Some(reported) = reported {
        ("reported", 0, reported)
    } else if invoked {
        ("estimate", cost, 0)
    } else {
        ("none", 0, 0)
    };
    if charged_estimate != 0 {
        let current = state["ledger"]["estimated_tokens"].as_i64().unwrap_or(0);
        state["ledger"]["estimated_tokens"] = json!(current + charged_estimate);
    }
    if reported.is_some() {
        let current = state["ledger"]["metered_tokens"].as_i64().unwrap_or(0);
        state["ledger"]["metered_tokens"] = json!(current + charged_metered);
    }
    if usage != "none" {
        apply_usage(state, usage);
    }
    let command = outcome
        .planner
        .as_ref()
        .and_then(|planner| planner.get("argv").cloned())
        .filter(|value| !value.is_null())
        .or_else(|| job.command.as_ref().map(|command| json!(command)));
    let plan = json!({
        "id": cycles + 1,
        "at": now_iso(),
        "repo": job.recorded_url,
        "action": job.action,
        "demo": job.demo,
        "contributed": invoked && !job.demo,
        "pushed": false,
        "upstream_cloned": outcome.cloned,
        "estimated_tokens": charged_estimate,
        "metered_tokens": charged_metered,
        "usage": usage,
        "subscription_command": command.unwrap_or(Value::Null),
        "subscription_executed": executed,
        "fetch": outcome.fetch,
        "sandbox": outcome.sandbox,
    });
    let spent = state["ledger"]["estimated_tokens"].as_i64().unwrap_or(0)
        + state["ledger"]["metered_tokens"].as_i64().unwrap_or(0);
    let mut plans = state["plans"].as_array().cloned().unwrap_or_default();
    plans.push(plan.clone());
    if plans.len() > 30 {
        plans = plans[plans.len() - 30..].to_vec();
    }
    state["plans"] = Value::Array(plans);
    state["loop"]["cycles"] = json!(cycles + 1);
    state["ledger"]["limit_tokens"] = json!(limit);
    if spent >= limit {
        state["loop"]["status"] = json!("stopped");
        state["loop"]["reason"] = json!("spending limit reached");
    } else {
        state["loop"]["status"] = json!("running");
        let reason = if invoked && job.demo {
            "demo dry loop".to_string()
        } else if invoked {
            "sandboxed command ran".into()
        } else if !job.refusal.is_empty() {
            job.refusal.clone()
        } else {
            outcome
                .fetch
                .get("reason")
                .and_then(Value::as_str)
                .or_else(|| outcome.sandbox.get("reason").and_then(Value::as_str))
                .unwrap_or("cycle skipped")
                .to_string()
        };
        state["loop"]["reason"] = json!(reason);
    }
    let mark = if plan["contributed"].as_bool() == Some(true) {
        "yes"
    } else {
        "no"
    };
    config::append_log(
        home,
        &format!(
            "{} {} {} cloned={} contributed={mark} usage={usage} {spent}/{limit} {}",
            plan["at"].as_str().unwrap_or(""),
            job.action,
            job.recorded_url,
            if outcome.cloned { "true" } else { "false" },
            outcome
                .sandbox
                .get("reason")
                .and_then(Value::as_str)
                .unwrap_or("")
        ),
    );
}

fn stamp_node(state: &mut Value, status: &crate::subscriptions::SubscriptionStatus) {
    state["subscription"] = status.as_json();
    state["node"]["pid"] = json!(std::process::id());
    state["node"]["status"] = json!("up");
    state["node"]["heartbeat_at"] = json!(now_iso());
}

fn persist(
    home: &Path,
    config: &toml::Value,
    peers: &[Peer],
    sources: &[Source],
    state: &mut Value,
    write_publish_file: bool,
) -> Value {
    let pushed = state["plans"]
        .as_array()
        .map(|plans| {
            plans
                .iter()
                .filter(|plan| plan.get("pushed").and_then(Value::as_bool) == Some(true))
                .count() as i64
        })
        .unwrap_or(0);
    state["contributions_pushed"] = json!(pushed);
    state["ledger"]["limit_tokens"] = json!(limit_of(config).unwrap_or(0));
    let _ = write_json(&config::state_path(home), state);
    if write_publish_file {
        write_publish(
            home,
            config,
            peers,
            sources,
            state["publish"]["url"].as_str().unwrap_or(""),
        );
    }
    state.clone()
}

pub fn tick(home: &Path) -> Value {
    let epoch = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs_f64())
        .unwrap_or(0.0);
    let (config, mut peers, mut state, listen_url) = {
        let Ok(_lock) = HomeLock::acquire(home) else {
            return json!({"loop": {"status": "stopped", "reason": "config is unreadable"}});
        };
        let config = match load_config(home) {
            Ok(config) => config,
            Err(_) => return mark_unreadable(home, "config is unreadable"),
        };
        let (peers, peers_ok) = match load_peers(home) {
            Ok(peers) => (peers, true),
            Err(_) => (Vec::new(), false),
        };
        let state = load_state(home, &config);
        let listen_url = state["publish"]["url"].as_str().unwrap_or("").to_string();
        let _ = peers_ok;
        (config, peers, state, listen_url)
    };
    let interval = fetch_interval(
        config
            .get("publish")
            .and_then(|p| p.get("peer_fetch_interval_seconds")),
    );
    let raw_last = state["peers_runtime"]["last_fetch_epoch"]
        .as_f64()
        .or_else(|| {
            state["peers_runtime"]["last_fetch_epoch"]
                .as_i64()
                .map(|n| n as f64)
        })
        .unwrap_or(0.0);
    let mut fetched = false;
    let mut additions = Vec::new();
    let mut ignored = 0;
    let mut errors = Vec::new();
    let mut id_updates = BTreeMap::new();
    let mut trust_decisions = Vec::new();
    let peers_were_ok = load_peers(home).is_ok();
    if peers_were_ok
        && interval.is_some()
        && !peers.is_empty()
        && epoch - raw_last >= interval.unwrap_or(0.0)
    {
        fetched = true;
        let fetched_peers = fetch_peers(&peers, &config, &listen_url, home);
        additions = fetched_peers.0;
        ignored = fetched_peers.1;
        errors = fetched_peers.2;
        id_updates = fetched_peers.3;
        trust_decisions = fetched_peers.4;
    }
    let Ok(_lock) = HomeLock::acquire(home) else {
        return mark_unreadable(home, "config is unreadable");
    };
    let config = match load_config(home) {
        Ok(config) => config,
        Err(_) => return mark_unreadable(home, "config is unreadable"),
    };
    let (sources, sources_ok) = match load_sources(home) {
        Ok(sources) => (sources, true),
        Err(_) => (Vec::new(), false),
    };
    let (loaded_peers, peers_ok) = match load_peers(home) {
        Ok(peers) => (peers, true),
        Err(_) => (Vec::new(), false),
    };
    peers = loaded_peers;
    state = load_state(home, &config);
    if peers_ok && !id_updates.is_empty() {
        for peer in &mut peers {
            if let Ok(key) = normalize_peer_url(&peer.url) {
                if peer.id.is_empty() {
                    if let Some(label) = id_updates.get(&key) {
                        peer.id = label.clone();
                    }
                }
            }
        }
    }
    let mut added = 0i64;
    if peers_ok && !additions.is_empty() {
        let mut known: BTreeSet<String> = peers
            .iter()
            .filter_map(|peer| normalize_peer_url(&peer.url).ok())
            .collect();
        for candidate in &additions {
            if known.contains(&candidate.url) {
                continue;
            }
            peers.push(Peer {
                url: candidate.url.clone(),
                id: candidate.peer_id.clone(),
                source: "peers-of-peers".into(),
                endorsements: candidate.endorsements,
            });
            known.insert(candidate.url.clone());
            added += 1;
        }
        let current = counter(state["peers_runtime"].get("added"));
        state["peers_runtime"]["added"] = json!(current + added);
    }
    if !peers_ok {
        state["peers_runtime"]["last_error"] = json!("the peer list is unreadable");
    } else if interval.is_none() {
        state["peers_runtime"]["last_error"] = json!("peer fetch interval is unreadable");
    } else if fetched {
        state["peers_runtime"]["last_fetch_epoch"] = json!(epoch);
        state["peers_runtime"]["last_fetch_at"] = json!(now_iso());
        state["peers_runtime"]["ignored_remote_repos"] =
            json!(counter(state["peers_runtime"].get("ignored_remote_repos")) + ignored);
        state["peers_runtime"]["last_error"] =
            json!(errors.join("; ").chars().take(500).collect::<String>());
        let _ = extend_trust(home, &trust_decisions);
    }
    if peers_ok {
        let _ = save_peers(home, &peers);
    }
    if !sources_ok {
        state["loop"]["status"] = json!("stopped");
        state["loop"]["reason"] = json!("the local source list is unreadable");
        return persist(home, &config, &peers, &sources, &mut state, false);
    }
    let status = inspect_subscription(
        config
            .get("subscription")
            .and_then(toml::Value::as_str)
            .unwrap_or(""),
    );
    stamp_node(&mut state, &status);
    let demo = match config.get("demo") {
        Some(toml::Value::Boolean(value)) => *value,
        _ => {
            state["loop"]["status"] = json!("stopped");
            state["loop"]["reason"] = json!("demo is unreadable");
            return persist(
                home,
                &config,
                &peers,
                &sources,
                &mut state,
                peers_ok && sources_ok,
            );
        }
    };
    let job = if demo || status.connected {
        let job = prepare_cycle(home, &config, &sources, &mut state, demo);
        if job.as_ref().is_some_and(|job| job.refusal.is_empty()) {
            state["loop"]["status"] = json!("running");
            state["loop"]["reason"] = json!("fetching repository");
        }
        job
    } else {
        state["loop"]["status"] = json!("idle");
        state["loop"]["reason"] = json!(status.detail);
        None
    };
    let early = match &job {
        None => true,
        Some(job) if !job.refusal.is_empty() => {
            let outcome = run_job(job, home);
            commit_cycle(home, &config, &mut state, job, &outcome);
            true
        }
        Some(_) => false,
    };
    if early {
        return persist(home, &config, &peers, &sources, &mut state, peers_ok);
    }
    let job = job.unwrap();
    persist(home, &config, &peers, &sources, &mut state, peers_ok);
    drop(_lock);
    let outcome = run_job(&job, home);
    let Ok(_lock) = HomeLock::acquire(home) else {
        return mark_unreadable(home, "config is unreadable");
    };
    let config = match load_config(home) {
        Ok(config) => config,
        Err(_) => return mark_unreadable(home, "config is unreadable"),
    };
    let (sources, sources_ok) = match load_sources(home) {
        Ok(v) => (v, true),
        Err(_) => (Vec::new(), false),
    };
    let (peers, peers_ok) = match load_peers(home) {
        Ok(v) => (v, true),
        Err(_) => (Vec::new(), false),
    };
    let mut state = load_state(home, &config);
    let status = inspect_subscription(
        config
            .get("subscription")
            .and_then(toml::Value::as_str)
            .unwrap_or(""),
    );
    stamp_node(&mut state, &status);
    commit_cycle(home, &config, &mut state, &job, &outcome);
    persist(
        home,
        &config,
        &peers,
        &sources,
        &mut state,
        peers_ok && sources_ok,
    )
}

#[allow(dead_code)]
fn _fetch_keep() {
    let _ = fetch::classify_clone_url;
}
