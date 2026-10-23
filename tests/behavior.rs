//! Behavioral checks for the settings menu, the admin page, and the security gates.

use std::io::{Read, Write};
use std::net::TcpStream;
use std::path::PathBuf;
use std::time::{Duration, Instant};

use idlehand::config::{self, ensure_home, load_config, save_config, save_sources, Source};
use idlehand::engine::tick;
use idlehand::fetch::{classify_clone_url, redact_clone_url, scrub_secrets};
use idlehand::forge::{self, checked_text};
use idlehand::links::apply_link;
use idlehand::peers::publish_document;
use idlehand::process::{alive_pid, start_node, stop_node};
use idlehand::publish::{client_may_admin, start_publish_server};
use idlehand::radicle::{cob_from, review_patch};
use idlehand::sandbox::{self, SandboxResult};
use serde_json::Value;

fn temp_home(name: &str) -> PathBuf {
    let path = std::env::temp_dir().join(format!(
        "idlehand-{name}-{}-{}",
        std::process::id(),
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_nanos())
            .unwrap_or(0)
    ));
    let _ = std::fs::remove_dir_all(&path);
    path
}

fn http(addr: std::net::SocketAddr, request: &str) -> (u16, String) {
    let mut stream = TcpStream::connect(addr).unwrap();
    stream.set_read_timeout(Some(Duration::from_secs(2))).ok();
    stream.write_all(request.as_bytes()).unwrap();
    let mut buf = Vec::new();
    let _ = stream.read_to_end(&mut buf);
    let text = String::from_utf8_lossy(&buf).into_owned();
    let status = text
        .split_whitespace()
        .nth(1)
        .unwrap_or("0")
        .parse()
        .unwrap_or(0);
    (status, text)
}

#[test]
fn connect_is_not_a_command() {
    let code = idlehand::cli::main(&["connect".into(), "claude".into()]);
    assert_eq!(code, 2);
}

#[test]
fn classify_refuses_ssh_and_embedded_credentials() {
    for (url, snippet) in [
        ("", "empty"),
        ("git@github.com:org/repo.git", "SSH"),
        ("ssh://git@github.com/org/repo.git", "SSH"),
        ("https://user:secret@github.com/org/repo.git", "credentials"),
        (
            "https://github.com/org/repo.git?access_token=sekret",
            "credentials",
        ),
    ] {
        let (allowed, reason) = classify_clone_url(url);
        assert!(allowed.is_none(), "{url}");
        assert!(reason.contains(snippet), "{reason}");
    }
    let scrubbed = scrub_secrets("https://user:sekret@github.com/org/repo.git\nfiles=1\n");
    assert_eq!(scrubbed, "https://github.com/org/repo.git\nfiles=1");
    assert_eq!(redact_clone_url("file:///tmp/repo"), "file:///tmp/repo");
    assert_eq!(
        redact_clone_url("https://user:secret@[::1]:443/idlehand/publish"),
        "https://[::1]:443/idlehand/publish"
    );
    assert!(
        !redact_clone_url("https://github.com/org/repo.git#access_token=sekret").contains("sekret")
    );
}

#[test]
fn spending_limit_stops_before_the_next_cycle() {
    let home = temp_home("limit");
    let mut config = ensure_home(&home).unwrap();
    config["subscription"] = toml::Value::String("claude".into());
    config["spending_limit_tokens"] = toml::Value::Integer(0);
    config["estimate_tokens_per_cycle"] = toml::Value::Integer(100);
    config["sandbox"]["execute"] = toml::Value::Boolean(true);
    config["sandbox"]["runtime"] = toml::Value::String("namespace".into());
    save_config(&home, &config).unwrap();
    save_sources(
        &home,
        &[Source {
            url: "https://example.com/org/repo.git".into(),
            note: String::new(),
        }],
    )
    .unwrap();
    let state = tick(&home);
    assert_eq!(state["plans"].as_array().map(|items| items.len()), Some(0));
    assert_eq!(state["loop"]["status"], "stopped");
    assert_eq!(state["loop"]["reason"], "spending limit reached");
    assert_eq!(state["ledger"]["estimated_tokens"], 0);
    let _ = std::fs::remove_dir_all(&home);
}

#[test]
fn runtime_none_refuses_the_host() {
    let home = temp_home("sandbox");
    let workspace = home.join("work");
    let result = sandbox::run(
        &workspace,
        &["/bin/echo".into(), "ran".into()],
        "none",
        "python:3.12-slim",
        "512m",
        "1",
        Duration::from_secs(5),
    );
    assert!(!result.invoked);
    assert!(result.reason.contains("refused to run on the host"));
    assert!(!workspace.join("ran").exists());
    let _ = std::fs::remove_dir_all(&home);
}

#[test]
fn credential_link_is_refused_and_not_stored() {
    let home = temp_home("link");
    ensure_home(&home).unwrap();
    let err = apply_link(
        &home,
        "idlehand://add?repo=https://user:secret@github.com/org/repo.git",
    )
    .unwrap_err();
    assert!(err.0.contains("credentials") || err.0.contains("refused") || !err.0.is_empty());
    let sources = std::fs::read_to_string(home.join("sources.toml")).unwrap();
    assert!(!sources.contains("secret"));
    let trust = std::fs::read_to_string(home.join("trust.json")).unwrap_or_default();
    assert!(!trust.contains("secret"));
    let _ = std::fs::remove_dir_all(&home);
}

#[test]
fn private_key_draft_is_not_a_github_issue() {
    let refused = checked_text("title", "-----BEGIN PRIVATE KEY-----\nabc", true, true).unwrap();
    assert!(!refused.ok);
    assert!(refused.detail.contains("private key"));
    assert!(forge::parse_repo_name("https://user:secret@github.com/org/repo").is_none());
    assert!(forge::parse_rid("rad:z3gqcJUoA1n9HaHKufZs5FCSGazv5").is_some());
}

#[test]
fn labeled_issue_id_wins() {
    let text = "noise e4255cc2a0a65b543c2b5badac14bf9e0d9f409f\nIssue 89f7afb1511b976482b21f6b2f39aef7f4fb88a2 later";
    assert_eq!(
        cob_from(text, ""),
        "89f7afb1511b976482b21f6b2f39aef7f4fb88a2"
    );
    assert_eq!(
        cob_from("only 89f7afb1511b976482b21f6b2f39aef7f4fb88a2", ""),
        ""
    );
}

#[test]
fn patch_check_without_a_sandbox_does_not_accept_or_refuse() {
    let home = temp_home("patch");
    let mut config = ensure_home(&home).unwrap();
    config["sandbox"]["runtime"] = toml::Value::String("none".into());
    save_config(&home, &config).unwrap();
    let result = review_patch(
        &home,
        "not-a-rid",
        "89f7afb1511b976482b21f6b2f39aef7f4fb88a2",
        "/tmp",
    );
    assert!(!result.ok);
    assert!(!result.detail.contains("accepted"));
    assert!(!result.detail.contains("refused patch"));
    let _ = std::fs::remove_dir_all(&home);
}

#[test]
fn review_with_injected_sandbox_still_needs_delegation() {
    let home = temp_home("review");
    ensure_home(&home).unwrap();
    let result = idlehand::radicle::review_patch_using(
        &home,
        "rad:z3gqcJUoA1n9HaHKufZs5FCSGazv5",
        "89f7afb1511b976482b21f6b2f39aef7f4fb88a2",
        "/tmp",
        |_, _, _, _, _, _| SandboxResult {
            runtime: "namespace".into(),
            invoked: true,
            ok: true,
            exit_code: Some(0),
            stdout: "tests_run=1\n".into(),
            stderr: String::new(),
            reason: "sandbox command finished".into(),
            argv: Vec::new(),
        },
    );
    assert!(!result.ok);
    assert!(result.detail.contains("not delegated"));
    let _ = std::fs::remove_dir_all(&home);
}

#[test]
fn publish_document_omits_subscription_spending_and_home() {
    let home = temp_home("publish-doc");
    let config = ensure_home(&home).unwrap();
    let doc = publish_document(
        config["node_id"].as_str().unwrap(),
        "http://127.0.0.1:9/idlehand/publish",
        &[],
        &[],
    );
    let text = doc.to_string();
    assert!(!text.contains("subscription"));
    assert!(!text.contains("spending"));
    assert!(!text.contains(&home.display().to_string()));
    assert!(!text.contains("RAD_PASSPHRASE"));
    let _ = std::fs::remove_dir_all(&home);
}

#[test]
fn admin_page_saves_a_valid_value_and_rejects_a_bad_one() {
    let home = temp_home("admin");
    ensure_home(&home).unwrap();
    let server = start_publish_server(&home, "127.0.0.1", 0).unwrap();
    let addr = server.address();
    idlehand::home::write_json(
        &config::publish_path(&home),
        &serde_json::json!({"idlehand": 1, "peers": [], "repos": []}),
    )
    .unwrap();
    let (status, page) = http(
        addr,
        &format!("GET /idlehand/admin HTTP/1.1\r\nHost: 127.0.0.1\r\nConnection: close\r\n\r\n"),
    );
    assert_eq!(status, 200);
    assert!(page.contains("spending_limit_tokens"));
    assert!(page.contains("value=\"10000\""));
    assert!(!page.contains("node_id"));
    assert!(!page.contains("RAD_PASSPHRASE"));
    let token = page
        .split("name=\"csrf\" value=\"")
        .nth(1)
        .unwrap()
        .split('"')
        .next()
        .unwrap()
        .to_string();
    let bad = format!("csrf={token}&spending_limit_tokens=-1");
    let (status, body) = http(addr, &format!("POST /idlehand/admin HTTP/1.1\r\nHost: 127.0.0.1\r\nContent-Type: application/x-www-form-urlencoded\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{bad}", bad.len()));
    assert_eq!(status, 400);
    assert!(body.contains("rejected"));
    assert_eq!(
        load_config(&home).unwrap()["spending_limit_tokens"].as_integer(),
        Some(10_000)
    );
    let good = format!("csrf={token}&spending_limit_tokens=5000");
    let (status, body) = http(addr, &format!("POST /idlehand/admin HTTP/1.1\r\nHost: 127.0.0.1\r\nContent-Type: application/x-www-form-urlencoded\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{good}", good.len()));
    assert_eq!(status, 200, "{body}");
    assert!(body.contains("saved"));
    let saved = load_config(&home).unwrap();
    assert_eq!(saved["spending_limit_tokens"].as_integer(), Some(5000));
    assert_eq!(saved["subscription"].as_str(), Some(""));
    assert_eq!(saved["estimate_tokens_per_cycle"].as_integer(), Some(2500));
    let (status, published) = http(
        addr,
        "GET /idlehand/publish HTTP/1.1\r\nHost: 127.0.0.1\r\nConnection: close\r\n\r\n",
    );
    assert_eq!(status, 200);
    assert!(!published.contains("subscription"));
    assert!(!published.contains("spending"));
    assert!(!published.contains("5000"));
    assert!(!published.contains(&home.display().to_string()));
    assert!(!client_may_admin("8.8.8.8:1".parse().unwrap()));
    server.shutdown();
    let _ = std::fs::remove_dir_all(&home);
}

#[test]
fn status_links_the_loopback_admin_page() {
    let home = temp_home("status");
    ensure_home(&home).unwrap();
    let mut state = idlehand::engine::fresh_state(&load_config(&home).unwrap());
    state["publish"]["url"] = Value::String("http://127.0.0.1:47321/idlehand/publish".into());
    state["publish"]["port"] = serde_json::json!(47321);
    idlehand::home::write_json(&config::state_path(&home), &state).unwrap();
    let text = idlehand::analytics::render_text(&home);
    assert!(
        text.contains("admin: http://127.0.0.1:47321/idlehand/admin"),
        "{text}"
    );
    let _ = std::fs::remove_dir_all(&home);
}

#[test]
fn unreadable_config_does_not_clear_the_ledger() {
    let home = temp_home("unreadable");
    let mut config = ensure_home(&home).unwrap();
    config["spending_limit_tokens"] = toml::Value::Integer(400);
    save_config(&home, &config).unwrap();
    let state = tick(&home);
    assert_eq!(state["ledger"]["limit_tokens"], 400);
    std::fs::write(home.join("config.toml"), "{\n").unwrap();
    let state = tick(&home);
    assert_eq!(state["loop"]["reason"], "config is unreadable");
    assert_eq!(state["ledger"]["limit_tokens"], 400);
    assert_eq!(state["ledger"]["estimated_tokens"], 0);
    let _ = std::fs::remove_dir_all(&home);
}

#[test]
fn reported_tokens_follow_the_planner_rules() {
    use idlehand::usage::parse_reported_tokens;
    let text = r#"{"type":"result","usage":{"input_tokens":3,"output_tokens":4,"cache_creation_input_tokens":2,"cache_read_input_tokens":1}}"#;
    assert_eq!(parse_reported_tokens(text), Some(10));
    assert_eq!(
        parse_reported_tokens(r#"{"type":"result","usage":{"input_tokens":0,"output_tokens":0}}"#),
        Some(0)
    );
    assert_eq!(parse_reported_tokens(""), None);
    assert_eq!(parse_reported_tokens("not json"), None);
    let jsonl = "{\"type\":\"assistant\",\"message\":{\"usage\":{\"input_tokens\":1,\"output_tokens\":1}}}\n{\"type\":\"result\",\"usage\":{\"input_tokens\":5,\"output_tokens\":7}}";
    assert_eq!(parse_reported_tokens(jsonl), Some(12));
    assert_eq!(
        parse_reported_tokens(r#"{"usage":{"input_tokens":true,"output_tokens":4}}"#),
        Some(4)
    );
    assert_eq!(
        parse_reported_tokens(r#"{"usage":{"input_tokens":2.2}}"#),
        Some(3)
    );
    assert!(parse_reported_tokens(&"x".repeat(1_000_001)).is_none());
}

#[test]
fn container_and_bwrap_argv_do_not_mount_home() {
    let workspace = temp_home("argv").join("work");
    std::fs::create_dir_all(&workspace).unwrap();
    let argv = sandbox::build_container_argv(
        "docker",
        &workspace,
        &["python".into(), "-c".into(), "print(1)".into()],
        "python:3.12-slim",
        "512m",
        "1",
    );
    let text = argv.join(" ");
    assert!(argv
        .windows(2)
        .any(|pair| pair[0] == "--network" && pair[1] == "none"));
    assert!(text.contains("no-new-privileges"));
    assert!(!argv.iter().any(|part| part == "--privileged"));
    assert!(!text.contains("docker.sock"));
    let home = std::env::var("HOME").unwrap_or_default();
    if !home.is_empty() {
        assert!(!text.contains(&home));
    }
    let bwrap = sandbox::build_bwrap_argv(
        &workspace,
        &["/usr/bin/python3".into(), "-c".into(), "print(1)".into()],
    );
    assert!(bwrap.iter().any(|part| part == "--clearenv"));
    if !home.is_empty() {
        assert!(!bwrap.iter().any(|part| part == &home));
    }
    let bad = sandbox::run(
        &workspace,
        &["/usr/bin/python3".into(), "-c".into(), "print('no')".into()],
        "docker",
        "password=sekret",
        "512m",
        "1",
        Duration::from_secs(2),
    );
    assert!(!bad.invoked);
    assert_eq!(bad.reason, "sandbox limit is unreadable");
    assert!(!bad.as_json().to_string().contains("sekret"));
}

#[test]
fn node_replaces_a_symlink_pid_and_stays_up_when_config_breaks() {
    let home = temp_home("node");
    let mut config = ensure_home(&home).unwrap();
    config["demo"] = toml::Value::Boolean(true);
    config["sandbox"]["execute"] = toml::Value::Boolean(false);
    config["loop_interval_seconds"] = toml::Value::Float(0.2);
    config["publish"]["port"] = toml::Value::Integer(0);
    save_config(&home, &config).unwrap();
    let outside = home.join("outside.pid");
    std::fs::write(&outside, "sekret\n").unwrap();
    std::os::unix::fs::symlink(&outside, config::pid_path(&home)).unwrap();
    let pid = start_node(&home, Duration::from_secs(20)).expect("node stayed up");
    let pid_text = std::fs::read_to_string(config::pid_path(&home)).unwrap();
    assert_eq!(std::fs::read_to_string(&outside).unwrap(), "sekret\n");
    assert!(!config::pid_path(&home)
        .symlink_metadata()
        .unwrap()
        .file_type()
        .is_symlink());
    assert_eq!(pid_text.trim(), pid.to_string());
    assert_eq!(alive_pid(&home), Some(pid));
    std::fs::write(home.join("config.toml"), "{\n").unwrap();
    let deadline = Instant::now() + Duration::from_secs(8);
    let mut reason = String::new();
    while Instant::now() < deadline {
        if let Ok(Some(state)) = idlehand::home::read_json(&config::state_path(&home)) {
            reason = state["loop"]["reason"].as_str().unwrap_or("").to_string();
            if reason == "config is unreadable" && alive_pid(&home) == Some(pid) {
                break;
            }
        }
        std::thread::sleep(Duration::from_millis(50));
    }
    assert_eq!(reason, "config is unreadable");
    assert_eq!(alive_pid(&home), Some(pid));
    assert!(stop_node(&home, Duration::from_secs(5)));
    assert_eq!(std::fs::read_to_string(&outside).unwrap(), "sekret\n");
    let _ = std::fs::remove_dir_all(&home);
}
