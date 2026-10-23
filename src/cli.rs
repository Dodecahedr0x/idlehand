//! Command line for the IdleHand node.

use std::io::{self, BufRead, Write};
use std::path::Path;

use crate::analytics::{render_json, render_text};
use crate::config::{self, ensure_home, load_config, load_peers, load_sources, save_config, sources_path};
use crate::configure::{self, parse_bool};
use crate::forge::{self, registered_forges};
use crate::handler::register_protocol_handler;
use crate::home::resolve_home;
use crate::jail::jail_main;
use crate::links::{apply_link, LinkApply};
use crate::node::serve;
use crate::peers::user_add_peer;
use crate::process::{alive_pid, start_node, stop_node};
use crate::radicle::{self, remember_identity};
use crate::sandbox::{self, probe_command};
use crate::subscriptions::inspect_subscription;
use crate::VERSION;

const RULE_KEYS: &[&str] = &["auto_start", "allow_test", "allow_audit", "allow_issues", "allow_pull_requests"];

pub fn entry() -> i32 {
    let args: Vec<String> = std::env::args().skip(1).collect();
    main(&args)
}

pub fn main(args: &[String]) -> i32 {
    if args.len() == 1 && args[0].starts_with("idlehand:") {
        let home = resolve_home(None);
        if ensure_home(&home).is_err() {
            return 1;
        }
        return match apply_link(&home, &args[0]) {
            Ok(added) => {
                print_link(&added);
                0
            }
            Err(err) => {
                eprintln!("{err}");
                1
            }
        };
    }
    let mut home_arg = None;
    let mut rest = Vec::new();
    let mut index = 0;
    while index < args.len() {
        if args[index] == "--home" {
            let Some(value) = args.get(index + 1) else {
                eprintln!("idlehand: --home needs a path");
                return 2;
            };
            home_arg = Some(value.clone());
            index += 2;
            continue;
        }
        if args[index] == "--version" || args[index] == "-V" {
            println!("idlehand {VERSION}");
            return 0;
        }
        if args[index] == "--help" || args[index] == "-h" {
            print_help();
            return 0;
        }
        rest.push(args[index].clone());
        index += 1;
    }
    let Some(command) = rest.first() else {
        print_help();
        return 2;
    };
    let home = resolve_home(home_arg.as_deref());
    let tail = &rest[1..];
    match command.as_str() {
        "init" => cmd_init(&home),
        "configure" => cmd_configure(&home),
        "demo" => cmd_demo(&home),
        "start" => cmd_start(&home),
        "stop" => cmd_stop(&home),
        "status" => { print!("{}", render_text(&home)); 0 }
        "analytics" => cmd_analytics(&home, tail),
        "limit" => cmd_limit(&home, tail),
        "link" => cmd_link(&home, tail),
        "rules" => cmd_rules(&home, tail),
        "peer" => cmd_peer(&home, tail),
        "sources" => cmd_sources(&home),
        "sandbox" => cmd_sandbox(&home, tail),
        "rad" => cmd_rad(&home, tail),
        "github" => cmd_github(&home, "github", tail),
        "node" => cmd_node(&home),
        "jail" => jail_main(tail),
        "connect" => {
            eprintln!("idlehand: unknown command connect");
            2
        }
        other => {
            eprintln!("idlehand: unknown command {other}");
            2
        }
    }
}

fn print_help() {
    println!("usage: idlehand [--home PATH] <command>");
    println!("commands: init configure demo start stop status analytics limit link rules peer sources sandbox rad github node");
}

fn cmd_init(home: &Path) -> i32 {
    if ensure_home(home).is_err() { return 1 }
    let handler = register_protocol_handler();
    println!("IdleHand home: {}", home.display());
    println!("Source list: {}", sources_path(home).display());
    println!("Protocol handler: {handler}");
    println!("Default spending limit: {} tokens", config::DEFAULT_SPENDING_LIMIT_TOKENS);
    let (nid, detail) = remember_identity(home);
    if nid.is_empty() { println!("{detail}. This node id stays local."); } else { println!("Radicle node id: {nid}"); }
    0
}

fn cmd_configure(home: &Path) -> i32 {
    let stdin = io::stdin();
    let mut lines = stdin.lock();
    let mut out = io::stdout();
    let mut err = io::stderr();
    match configure::run_configure(home, |prompt| {
        print!("{prompt}");
        let _ = io::stdout().flush();
        let mut line = String::new();
        match lines.read_line(&mut line) {
            Ok(0) => None,
            Ok(_) => Some(line.trim_end_matches(['\n', '\r']).to_string()),
            Err(_) => None,
        }
    }, &mut out, &mut err) {
        Ok(()) => 0,
        Err(err) => { eprintln!("{err}"); 1 }
    }
}

fn cmd_demo(home: &Path) -> i32 {
    let Ok(mut config) = ensure_home(home) else { return 1 };
    if let Some(table) = config.as_table_mut() { table.insert("demo".into(), toml::Value::Boolean(true)); }
    if save_config(home, &config).is_err() { return 1 }
    if let Err(err) = start_node(home, std::time::Duration::from_secs(20)) {
        eprintln!("{err}");
        return 1;
    }
    println!("Demo dry loop is running. Plans are local. Nothing is contributed, and token totals are estimates.");
    0
}

fn cmd_start(home: &Path) -> i32 {
    if ensure_home(home).is_err() { return 1 }
    match start_node(home, std::time::Duration::from_secs(20)) {
        Ok(pid) => { println!("IdleHand node is up (pid {pid})"); 0 }
        Err(err) => { eprintln!("{err}"); 1 }
    }
}

fn cmd_stop(home: &Path) -> i32 {
    if stop_node(home, std::time::Duration::from_secs(5)) { println!("IdleHand node stopped"); } else { println!("IdleHand node was not running"); }
    0
}

fn cmd_analytics(home: &Path, args: &[String]) -> i32 {
    if args.iter().any(|arg| arg == "--json") { print!("{}", render_json(home)); } else { print!("{}", render_text(home)); }
    0
}

fn cmd_limit(home: &Path, args: &[String]) -> i32 {
    let Ok(mut config) = ensure_home(home) else { return 1 };
    let Some(raw) = args.first() else {
        println!("{}", config.get("spending_limit_tokens").and_then(toml::Value::as_integer).unwrap_or(0));
        return 0;
    };
    let Ok(tokens) = raw.parse::<i64>() else { eprintln!("the spending limit cannot be negative"); return 1 };
    if tokens < 0 { eprintln!("the spending limit cannot be negative"); return 1 }
    if let Some(table) = config.as_table_mut() { table.insert("spending_limit_tokens".into(), toml::Value::Integer(tokens)); }
    if save_config(home, &config).is_err() { return 1 }
    println!("Spending limit set to {tokens} tokens");
    0
}

fn print_link(added: &LinkApply) {
    for item in &added.decisions {
        if item.get("accepted").and_then(serde_json::Value::as_bool) != Some(true) {
            eprintln!("refused {}: {}", item.get("subject").and_then(serde_json::Value::as_str).unwrap_or(""), item.get("reason").and_then(serde_json::Value::as_str).unwrap_or(""));
        }
    }
    if added.added.is_empty() {
        println!("Those repos were already in the local source list.");
    } else {
        println!("Added to the local source list:");
        for url in &added.added { println!("  {url}"); }
    }
}

fn cmd_link(home: &Path, args: &[String]) -> i32 {
    if ensure_home(home).is_err() { return 1 }
    let Some(url) = args.first() else { eprintln!("usage: idlehand link URL"); return 2 };
    match apply_link(home, url) {
        Ok(added) => { print_link(&added); 0 }
        Err(err) => { eprintln!("{err}"); 1 }
    }
}

fn cmd_rules(home: &Path, args: &[String]) -> i32 {
    let Ok(mut config) = ensure_home(home) else { return 1 };
    match args.first().map(String::as_str) {
        Some("set") => {
            let (Some(key), Some(value)) = (args.get(1), args.get(2)) else { eprintln!("usage: idlehand rules set KEY VALUE"); return 2 };
            if !RULE_KEYS.contains(&key.as_str()) {
                eprintln!("unknown rule {key}");
                eprintln!("rules: {}", RULE_KEYS.join(", "));
                return 1;
            }
            let Some(flag) = parse_bool(value) else { eprintln!("value must be true or false"); return 1 };
            if let Some(rules) = config.get_mut("rules").and_then(toml::Value::as_table_mut) {
                rules.insert(key.clone(), toml::Value::Boolean(flag));
            }
            if save_config(home, &config).is_err() { return 1 }
        }
        Some("show") | None => {}
        Some(_) => { eprintln!("usage: idlehand rules show|set"); return 2 }
    }
    for key in RULE_KEYS {
        let value = config.get("rules").and_then(|rules| rules.get(*key)).and_then(toml::Value::as_bool).unwrap_or(false);
        println!("{key} = {}", if value { "true" } else { "false" });
    }
    0
}

fn cmd_peer(home: &Path, args: &[String]) -> i32 {
    if ensure_home(home).is_err() { return 1 }
    match args.first().map(String::as_str) {
        Some("add") => {
            let Some(url) = args.get(1) else { eprintln!("usage: idlehand peer add URL"); return 2 };
            match user_add_peer(home, url) {
                Ok(url) => {
                    println!("Added peer {url}");
                    println!("IdleHand will fetch that URL directly. This does not add repositories.");
                    0
                }
                Err(err) => { eprintln!("{err}"); 1 }
            }
        }
        Some("list") | None => {
            let Ok(peers) = load_peers(home) else { eprintln!("the peer list is unreadable"); return 1 };
            if peers.is_empty() { println!("No peers yet."); return 0 }
            for peer in peers {
                println!("{}  source={}  endorsements={}", peer.url, peer.source, peer.endorsements);
            }
            0
        }
        Some(_) => { eprintln!("usage: idlehand peer list|add"); 2 }
    }
}

fn cmd_sources(home: &Path) -> i32 {
    if ensure_home(home).is_err() { return 1 }
    println!("{}", sources_path(home).display());
    match load_sources(home) {
        Ok(repos) => { for repo in repos { println!("{}", repo.url); } 0 }
        Err(err) => { eprintln!("{err}"); 1 }
    }
}

fn cmd_sandbox(home: &Path, args: &[String]) -> i32 {
    let Ok(config) = ensure_home(home) else { return 1 };
    let runtime_name = config.get("sandbox").and_then(|s| s.get("runtime")).and_then(toml::Value::as_str).unwrap_or("auto");
    let runtime = sandbox::detect_runtime(runtime_name);
    match args.first().map(String::as_str) {
        Some("spec") => {
            let shown = runtime.clone().unwrap_or_else(|| "none".into());
            println!("runtime: {shown}");
            if shown == "docker" || shown == "podman" {
                let limits = sandbox::sandbox_limits(
                    config.get("sandbox").and_then(|s| s.get("image")).and_then(toml::Value::as_str).unwrap_or("python:3.12-slim"),
                    config.get("sandbox").and_then(|s| s.get("memory")).and_then(toml::Value::as_str).unwrap_or("512m"),
                    config.get("sandbox").and_then(|s| s.get("cpus")).and_then(toml::Value::as_str).unwrap_or("1"),
                );
                match limits {
                    None => println!("sandbox limit is unreadable"),
                    Some((image, memory, cpus)) => {
                        let argv = sandbox::build_container_argv(&shown, &home.join("workspaces/spec"), &probe_command(&shown), &image, &memory, &cpus);
                        println!("{}", argv.join(" "));
                    }
                }
            } else if shown == "namespace" {
                println!("namespace jail: private copy of the command, workspace mounted at /work, no network, empty environment");
            } else if shown == "bwrap" {
                println!("bubblewrap: read-only /usr, workspace mounted at /work, no home mount");
            } else {
                println!("no sandbox runtime is available; IdleHand will not run repo commands on the host");
            }
            0
        }
        Some("run") => {
            let chosen = runtime.unwrap_or_else(|| "namespace".into());
            let result = sandbox::run(
                &home.join("workspaces/manual"),
                &probe_command(&chosen),
                runtime_name,
                config.get("sandbox").and_then(|s| s.get("image")).and_then(toml::Value::as_str).unwrap_or("python:3.12-slim"),
                config.get("sandbox").and_then(|s| s.get("memory")).and_then(toml::Value::as_str).unwrap_or("512m"),
                config.get("sandbox").and_then(|s| s.get("cpus")).and_then(toml::Value::as_str).unwrap_or("1"),
                std::time::Duration::from_secs(30),
            );
            if !result.stdout.is_empty() { println!("{}", result.stdout.trim_end()); }
            if !result.ok { eprintln!("{}", result.reason); return 1 }
            println!("sandbox {} finished. This was not a contribution.", result.runtime);
            0
        }
        _ => { eprintln!("usage: idlehand sandbox spec|run"); 2 }
    }
}

fn finish(result: forge::ForgeResult) -> i32 {
    if !result.output.is_empty() { println!("{}", result.output.trim_end()); }
    if result.ok { println!("{}", result.detail); 0 } else { eprintln!("{}", result.detail); 1 }
}

fn body_text(args: &[String]) -> Result<String, i32> {
    let mut body = None;
    let mut body_file = String::new();
    let mut index = 0;
    while index < args.len() {
        if args[index] == "--body" {
            body = Some(args.get(index + 1).cloned().unwrap_or_default());
            index += 2;
            continue;
        }
        if args[index] == "--body-file" {
            body_file = args.get(index + 1).cloned().unwrap_or_default();
            index += 2;
            continue;
        }
        index += 1;
    }
    if !body_file.is_empty() && body.is_some() { eprintln!("pass either --body or --body-file"); return Err(1) }
    if body_file.is_empty() { return Ok(body.unwrap_or_default()) }
    let path = Path::new(&body_file);
    if crate::home::is_symlink(path) || !path.is_file() { eprintln!("the body file is unreadable"); return Err(1) }
    match std::fs::metadata(path).and_then(|meta| if meta.len() > 65_000 { Err(std::io::Error::other("long")) } else { std::fs::read_to_string(path) }) {
        Ok(text) => Ok(text),
        Err(err) if err.to_string() == "long" => { eprintln!("the body is too long"); Err(1) }
        Err(_) => { eprintln!("the body file is unreadable"); Err(1) }
    }
}

fn flag<'a>(args: &'a [String], name: &str) -> Option<&'a str> {
    args.windows(2).find(|pair| pair[0] == name).map(|pair| pair[1].as_str())
}

fn cmd_rad(home: &Path, args: &[String]) -> i32 {
    if ensure_home(home).is_err() { return 1 }
    let Some(action) = args.first().map(String::as_str) else { eprintln!("usage: idlehand rad <command>"); return 2 };
    match action {
        "status" => {
            let (nid, detail) = remember_identity(home);
            if detail == "rad is not installed" { eprintln!("rad is not installed"); return 1 }
            let running = radicle::node_running();
            if nid.is_empty() { eprintln!("{detail}"); } else { println!("Radicle node id: {nid}"); }
            if running.ok { println!("{}", running.detail); } else { eprintln!("{}", running.detail); }
            if !nid.is_empty() && running.ok { 0 } else { 1 }
        }
        "delegated" => {
            let Some(rows) = forge::load_delegated(home) else { eprintln!("the delegation list is unreadable"); return 1 };
            let mine: Vec<_> = rows.into_iter().filter(|(provider, _)| provider == "radicle").collect();
            if mine.is_empty() { println!("No repositories are delegated."); return 0 }
            for (_, name) in mine { println!("radicle {name}"); }
            0
        }
        "delegate" => finish(radicle::delegate_rid(home, args.get(1).map(String::as_str).unwrap_or(""))),
        "revoke" => finish(radicle::revoke_rid(home, args.get(1).map(String::as_str).unwrap_or(""))),
        "issue" => cmd_rad_issue(home, &args[1..]),
        "patch" => cmd_rad_patch(home, &args[1..]),
        _ => { eprintln!("IdleHand has no Radicle command for that"); 1 }
    }
}

fn cmd_rad_issue(home: &Path, args: &[String]) -> i32 {
    match args.first().map(String::as_str) {
        Some("create") => {
            let body = match body_text(args) { Ok(body) => body, Err(code) => return code };
            let title = flag(args, "--title").unwrap_or("");
            if title.is_empty() { eprintln!("a title is required"); return 2 }
            finish(radicle::create_issue(home, args.get(1).map(String::as_str).unwrap_or(""), title, &body))
        }
        Some("update") => {
            let body = match body_text(args) { Ok(body) => body, Err(code) => return code };
            finish(radicle::update_issue(home, args.get(1).map(String::as_str).unwrap_or(""), args.get(2).map(String::as_str).unwrap_or(""), flag(args, "--title").unwrap_or(""), &body))
        }
        Some("send") => finish(radicle::send_issue_draft(home, args.get(1).map(String::as_str).unwrap_or(""))),
        _ => { eprintln!("usage: idlehand rad issue create|update|send"); 2 }
    }
}

fn cmd_rad_patch(home: &Path, args: &[String]) -> i32 {
    match args.first().map(String::as_str) {
        Some("open") => {
            let body = match body_text(args) { Ok(body) => body, Err(code) => return code };
            let title = flag(args, "--title").unwrap_or("");
            let checkout = flag(args, "--path").unwrap_or("");
            if title.is_empty() || checkout.is_empty() { eprintln!("usage: idlehand rad patch open RID --path PATH --title TITLE"); return 2 }
            finish(radicle::open_patch(home, args.get(1).map(String::as_str).unwrap_or(""), title, &body, checkout))
        }
        Some("check") => finish(radicle::review_patch(home, args.get(1).map(String::as_str).unwrap_or(""), args.get(2).map(String::as_str).unwrap_or(""), flag(args, "--path").unwrap_or(""))),
        Some("update") => {
            let body = match body_text(args) { Ok(body) => body, Err(code) => return code };
            let title = flag(args, "--title").unwrap_or("");
            if title.is_empty() { eprintln!("a title is required"); return 2 }
            finish(radicle::update_patch(home, args.get(1).map(String::as_str).unwrap_or(""), args.get(2).map(String::as_str).unwrap_or(""), title, &body))
        }
        Some("send") => finish(radicle::send_patch_draft(home, args.get(1).map(String::as_str).unwrap_or(""), args.get(2).map(String::as_str).unwrap_or(""))),
        _ => { eprintln!("usage: idlehand rad patch open|check|update|send"); 2 }
    }
}

fn cmd_github(home: &Path, provider: &str, args: &[String]) -> i32 {
    if !registered_forges().contains(&provider) { eprintln!("IdleHand has no forge provider for that name"); return 1 }
    if ensure_home(home).is_err() { return 1 }
    let Some(action) = args.first().map(String::as_str) else { eprintln!("usage: idlehand github <command>"); return 2 };
    match action {
        "status" => {
            let account = forge::delegation_status(provider);
            if account.connected { println!("{}", account.detail); 0 } else { eprintln!("{}", account.detail); 1 }
        }
        "repos" => {
            let (repos, detail) = forge::list_manageable(provider);
            let Some(repos) = repos else { eprintln!("{detail}"); return 1 };
            if repos.is_empty() { println!("No owned or administered repositories."); }
            for repo in repos { println!("{}  {}", repo.name, repo.role); }
            if !detail.is_empty() { println!("{detail}"); }
            0
        }
        "delegated" => {
            let Some(rows) = forge::load_delegated(home) else { eprintln!("the delegation list is unreadable"); return 1 };
            let mine: Vec<_> = rows.into_iter().filter(|(item, _)| item == provider).collect();
            if mine.is_empty() { println!("No repositories are delegated."); return 0 }
            for (item, name) in mine { println!("{item} {name}"); }
            0
        }
        "delegate" => finish(forge::delegate_repo(home, provider, args.get(1).map(String::as_str).unwrap_or(""))),
        "revoke" => finish(forge::revoke_repo(home, provider, args.get(1).map(String::as_str).unwrap_or(""))),
        "issue" => cmd_github_issue(home, provider, &args[1..]),
        "pr" => cmd_github_pr(home, provider, &args[1..]),
        _ => { eprintln!("IdleHand has no forge provider for that name"); 1 }
    }
}

fn cmd_github_issue(home: &Path, provider: &str, args: &[String]) -> i32 {
    match args.first().map(String::as_str) {
        Some("create") => {
            let body = match body_text(args) { Ok(body) => body, Err(code) => return code };
            let title = flag(args, "--title").unwrap_or("");
            if title.is_empty() { eprintln!("a title is required"); return 2 }
            finish(forge::create_issue(home, provider, args.get(1).map(String::as_str).unwrap_or(""), title, &body))
        }
        Some("update") => {
            let body = match body_text(args) { Ok(body) => body, Err(code) => return code };
            let Some(number) = args.get(2).and_then(|raw| forge::parse_number(raw)) else { eprintln!("the issue number is unreadable"); return 1 };
            finish(forge::update_issue(home, provider, args.get(1).map(String::as_str).unwrap_or(""), number, flag(args, "--title").unwrap_or(""), &body))
        }
        Some("send") => finish(forge::send_issue_draft(home, provider, args.get(1).map(String::as_str).unwrap_or(""))),
        _ => { eprintln!("usage: idlehand github issue create|update|send"); 2 }
    }
}

fn cmd_github_pr(home: &Path, provider: &str, args: &[String]) -> i32 {
    match args.first().map(String::as_str) {
        Some("create") => {
            let body = match body_text(args) { Ok(body) => body, Err(code) => return code };
            let title = flag(args, "--title").unwrap_or("");
            let head = flag(args, "--head").unwrap_or("");
            if title.is_empty() || head.is_empty() { eprintln!("usage: idlehand github pr create REPO --head REF --title TITLE"); return 2 }
            finish(forge::create_pull_request(home, provider, args.get(1).map(String::as_str).unwrap_or(""), title, &body, head, flag(args, "--base").unwrap_or("")))
        }
        Some("update") => {
            let body = match body_text(args) { Ok(body) => body, Err(code) => return code };
            let Some(number) = args.get(2).and_then(|raw| forge::parse_number(raw)) else { eprintln!("the pull request number is unreadable"); return 1 };
            finish(forge::update_pull_request(home, provider, args.get(1).map(String::as_str).unwrap_or(""), number, flag(args, "--title").unwrap_or(""), &body))
        }
        Some("send") => {
            let head = flag(args, "--head").unwrap_or("");
            if head.is_empty() { eprintln!("usage: idlehand github pr send REPO --head REF"); return 2 }
            finish(forge::send_pull_request_draft(home, provider, args.get(1).map(String::as_str).unwrap_or(""), head, flag(args, "--base").unwrap_or("")))
        }
        _ => { eprintln!("usage: idlehand github pr create|update|send"); 2 }
    }
}

fn cmd_node(home: &Path) -> i32 {
    if alive_pid(home).is_some() { eprintln!("IdleHand node is already running"); return 1 }
    serve(home);
    0
}

#[allow(dead_code)]
fn _status_keep() {
    let _ = inspect_subscription;
    let _ = load_config;
}
