//! Command line for the IdleHand node.

use std::io::{self, IsTerminal};
use std::path::Path;

use clap::{Args, Parser, Subcommand};

use crate::analytics::{render_json, render_text};
use crate::config::{self, ensure_home, load_peers, load_sources, save_config, sources_path};
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

const RULE_KEYS: &[&str] = &[
    "auto_start",
    "allow_test",
    "allow_audit",
    "allow_issues",
    "allow_pull_requests",
];

#[derive(Debug, Parser)]
#[command(
    name = "idlehand",
    version,
    about = "A local node that spends leftover subscription credits on open source",
    arg_required_else_help = true,
    propagate_version = true
)]
struct Cli {
    /// Override IDLEHAND_HOME and ~/.idlehand.
    #[arg(long, global = true, value_name = "PATH")]
    home: Option<String>,

    #[command(subcommand)]
    command: Command,
}

#[derive(Debug, Subcommand)]
enum Command {
    /// Create the home directory and default files.
    Init,
    /// Open the configuration screen.
    ///
    /// Arrows or j/k move, enter chooses, esc leaves a section, s skips a setting, and q or Done finishes.
    /// Done saves only changed settings and does not start the node.
    Configure,
    /// Start a local demo loop.
    Demo,
    /// Start the node.
    Start,
    /// Stop the node.
    Stop,
    /// Print the text report.
    Status,
    /// Print the text report, or JSON.
    Analytics {
        /// Print the report as JSON.
        #[arg(long)]
        json: bool,
    },
    /// Print or set the spending limit.
    Limit {
        /// Non-negative token limit.
        #[arg(value_name = "TOKENS")]
        tokens: Option<String>,
    },
    /// Add repositories from an idlehand: URL.
    Link {
        #[arg(value_name = "URL")]
        url: String,
    },
    /// Show or set contribution rules.
    Rules {
        #[command(subcommand)]
        action: Option<RulesCommand>,
    },
    /// List peers or add one.
    Peer {
        #[command(subcommand)]
        action: Option<PeerCommand>,
    },
    /// Print the source list.
    Sources,
    /// Show or run the sandbox.
    Sandbox {
        #[command(subcommand)]
        action: SandboxCommand,
    },
    /// Radicle delegation and contributions.
    Rad {
        #[command(subcommand)]
        action: RadCommand,
    },
    /// GitHub delegation and contributions.
    Github {
        #[command(subcommand)]
        action: GithubCommand,
    },
    /// Run the node in the foreground.
    Node,
    /// Namespace jail helper.
    #[command(hide = true)]
    Jail {
        /// Workspace directory.
        #[arg(long, value_name = "PATH")]
        workspace: Option<String>,
        /// Command to run after --.
        #[arg(last = true, allow_hyphen_values = true, value_name = "COMMAND")]
        command: Vec<String>,
    },
}

#[derive(Debug, Subcommand)]
enum RulesCommand {
    /// Print the rules.
    Show,
    /// Set one rule to true or false.
    Set { key: String, value: String },
}

#[derive(Debug, Subcommand)]
enum PeerCommand {
    /// Print peers.
    List,
    /// Fetch a peer URL and store it.
    Add {
        #[arg(value_name = "URL")]
        url: String,
    },
}

#[derive(Debug, Subcommand)]
enum SandboxCommand {
    /// Print the sandbox runtime.
    Spec,
    /// Run a local sandbox probe.
    Run,
}

#[derive(Debug, Subcommand)]
enum RadCommand {
    /// Print the Radicle node id and whether the node is running.
    Status,
    /// Print delegated Radicle repositories.
    Delegated,
    /// Record a delegated RID.
    Delegate { rid: Option<String> },
    /// Remove a delegated RID.
    Revoke { rid: Option<String> },
    /// Open, update, or send an issue.
    Issue {
        #[command(subcommand)]
        action: RadIssueCommand,
    },
    /// Open, check, update, or send a patch.
    Patch {
        #[command(subcommand)]
        action: RadPatchCommand,
    },
}

#[derive(Debug, Subcommand)]
enum RadIssueCommand {
    Create {
        rid: Option<String>,
        #[arg(long)]
        title: Option<String>,
        #[command(flatten)]
        body: TextBody,
    },
    Update {
        #[arg(num_args = 0..=2, value_names = ["RID", "ID"])]
        rid_and_id: Vec<String>,
        #[arg(long)]
        title: Option<String>,
        #[command(flatten)]
        body: TextBody,
    },
    Send {
        rid: Option<String>,
    },
}

#[derive(Debug, Subcommand)]
enum RadPatchCommand {
    Open {
        rid: Option<String>,
        #[arg(long)]
        path: Option<String>,
        #[arg(long)]
        title: Option<String>,
        #[command(flatten)]
        body: TextBody,
    },
    Check {
        #[arg(num_args = 0..=2, value_names = ["RID", "PATCH"])]
        rid_and_patch: Vec<String>,
        #[arg(long)]
        path: Option<String>,
    },
    Update {
        #[arg(num_args = 0..=2, value_names = ["RID", "PATCH"])]
        rid_and_patch: Vec<String>,
        #[arg(long)]
        title: Option<String>,
        #[command(flatten)]
        body: TextBody,
    },
    Send {
        #[arg(num_args = 0..=2, value_names = ["RID", "PATCH"])]
        rid_and_patch: Vec<String>,
    },
}

#[derive(Debug, Subcommand)]
enum GithubCommand {
    /// Print whether gh is logged in.
    Status,
    /// List repositories this login can administer.
    Repos,
    /// Print delegated GitHub repositories.
    Delegated,
    /// Record a delegated repository.
    Delegate { repo: Option<String> },
    /// Remove a delegated repository.
    Revoke { repo: Option<String> },
    /// Open, update, or send an issue.
    Issue {
        #[command(subcommand)]
        action: GithubIssueCommand,
    },
    /// Open, update, or send a pull request.
    Pr {
        #[command(subcommand)]
        action: GithubPrCommand,
    },
}

#[derive(Debug, Subcommand)]
enum GithubIssueCommand {
    Create {
        repo: Option<String>,
        #[arg(long)]
        title: Option<String>,
        #[command(flatten)]
        body: TextBody,
    },
    Update {
        #[arg(num_args = 0..=2, value_names = ["REPO", "NUMBER"])]
        repo_and_number: Vec<String>,
        #[arg(long)]
        title: Option<String>,
        #[command(flatten)]
        body: TextBody,
    },
    Send {
        repo: Option<String>,
    },
}

#[derive(Debug, Subcommand)]
enum GithubPrCommand {
    Create {
        repo: Option<String>,
        #[arg(long)]
        head: Option<String>,
        #[arg(long)]
        title: Option<String>,
        #[arg(long)]
        base: Option<String>,
        #[command(flatten)]
        body: TextBody,
    },
    Update {
        #[arg(num_args = 0..=2, value_names = ["REPO", "NUMBER"])]
        repo_and_number: Vec<String>,
        #[arg(long)]
        title: Option<String>,
        #[command(flatten)]
        body: TextBody,
    },
    Send {
        repo: Option<String>,
        #[arg(long)]
        head: Option<String>,
        #[arg(long)]
        base: Option<String>,
    },
}

#[derive(Debug, Args)]
struct TextBody {
    /// Body text.
    #[arg(long)]
    body: Option<String>,
    /// Read the body from a regular file of at most 65000 bytes.
    #[arg(long, value_name = "PATH")]
    body_file: Option<String>,
}

pub fn entry() -> i32 {
    let args: Vec<String> = std::env::args().skip(1).collect();
    main(&args)
}

pub fn main(args: &[String]) -> i32 {
    main_tty(
        args,
        io::stdin().is_terminal() && io::stdout().is_terminal(),
    )
}

fn main_tty(args: &[String], tty: bool) -> i32 {
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
    let cli = match Cli::try_parse_from(
        std::iter::once(String::from("idlehand")).chain(args.iter().cloned()),
    ) {
        Ok(cli) => cli,
        Err(err) => {
            let code = err.exit_code();
            let _ = err.print();
            return code;
        }
    };
    if matches!(cli.command, Command::Configure) {
        if let Err(message) = configure::require_terminal(tty) {
            eprintln!("{message}");
            return 1;
        }
    }
    let home = resolve_home(cli.home.as_deref());
    match cli.command {
        Command::Init => cmd_init(&home),
        Command::Configure => match configure::run_configure_tui(&home) {
            Ok(()) => 0,
            Err(err) => {
                eprintln!("{err}");
                1
            }
        },
        Command::Demo => cmd_demo(&home),
        Command::Start => cmd_start(&home),
        Command::Stop => cmd_stop(&home),
        Command::Status => {
            print!("{}", render_text(&home));
            0
        }
        Command::Analytics { json } => {
            if json {
                print!("{}", render_json(&home));
            } else {
                print!("{}", render_text(&home));
            }
            0
        }
        Command::Limit { tokens } => cmd_limit(&home, tokens.as_deref()),
        Command::Link { url } => cmd_link(&home, &url),
        Command::Rules { action } => cmd_rules(&home, action),
        Command::Peer { action } => cmd_peer(&home, action),
        Command::Sources => cmd_sources(&home),
        Command::Sandbox { action } => cmd_sandbox(&home, action),
        Command::Rad { action } => cmd_rad(&home, action),
        Command::Github { action } => cmd_github(&home, "github", action),
        Command::Node => cmd_node(&home),
        Command::Jail { workspace, command } => cmd_jail(args, workspace, command),
    }
}

fn cmd_init(home: &Path) -> i32 {
    if ensure_home(home).is_err() {
        return 1;
    }
    let handler = register_protocol_handler();
    println!("IdleHand home: {}", home.display());
    println!("Source list: {}", sources_path(home).display());
    println!("Protocol handler: {handler}");
    println!(
        "Default spending limit: {} tokens",
        config::DEFAULT_SPENDING_LIMIT_TOKENS
    );
    let (nid, detail) = remember_identity(home);
    if nid.is_empty() {
        println!("{detail}. This node id stays local.");
    } else {
        println!("Radicle node id: {nid}");
    }
    0
}

fn cmd_demo(home: &Path) -> i32 {
    let Ok(mut config) = ensure_home(home) else {
        return 1;
    };
    if let Some(table) = config.as_table_mut() {
        table.insert("demo".into(), toml::Value::Boolean(true));
    }
    if save_config(home, &config).is_err() {
        return 1;
    }
    if let Err(err) = start_node(home, std::time::Duration::from_secs(20)) {
        eprintln!("{err}");
        return 1;
    }
    println!("Demo dry loop is running. Plans are local. Nothing is contributed, and token totals are estimates.");
    0
}

fn cmd_start(home: &Path) -> i32 {
    if ensure_home(home).is_err() {
        return 1;
    }
    match start_node(home, std::time::Duration::from_secs(20)) {
        Ok(pid) => {
            println!("IdleHand node is up (pid {pid})");
            0
        }
        Err(err) => {
            eprintln!("{err}");
            1
        }
    }
}

fn cmd_stop(home: &Path) -> i32 {
    if stop_node(home, std::time::Duration::from_secs(5)) {
        println!("IdleHand node stopped");
    } else {
        println!("IdleHand node was not running");
    }
    0
}

fn cmd_limit(home: &Path, raw: Option<&str>) -> i32 {
    let Ok(mut config) = ensure_home(home) else {
        return 1;
    };
    let Some(raw) = raw else {
        println!(
            "{}",
            config
                .get("spending_limit_tokens")
                .and_then(toml::Value::as_integer)
                .unwrap_or(0)
        );
        return 0;
    };
    let Ok(tokens) = raw.parse::<i64>() else {
        eprintln!("the spending limit cannot be negative");
        return 1;
    };
    if tokens < 0 {
        eprintln!("the spending limit cannot be negative");
        return 1;
    }
    if let Some(table) = config.as_table_mut() {
        table.insert("spending_limit_tokens".into(), toml::Value::Integer(tokens));
    }
    if save_config(home, &config).is_err() {
        return 1;
    }
    println!("Spending limit set to {tokens} tokens");
    0
}

fn print_link(added: &LinkApply) {
    for item in &added.decisions {
        if item.get("accepted").and_then(serde_json::Value::as_bool) != Some(true) {
            eprintln!(
                "refused {}: {}",
                item.get("subject")
                    .and_then(serde_json::Value::as_str)
                    .unwrap_or(""),
                item.get("reason")
                    .and_then(serde_json::Value::as_str)
                    .unwrap_or("")
            );
        }
    }
    if added.added.is_empty() {
        println!("Those repos were already in the local source list.");
    } else {
        println!("Added to the local source list:");
        for url in &added.added {
            println!("  {url}");
        }
    }
}

fn cmd_link(home: &Path, url: &str) -> i32 {
    if ensure_home(home).is_err() {
        return 1;
    }
    match apply_link(home, url) {
        Ok(added) => {
            print_link(&added);
            0
        }
        Err(err) => {
            eprintln!("{err}");
            1
        }
    }
}

fn cmd_rules(home: &Path, action: Option<RulesCommand>) -> i32 {
    let Ok(mut config) = ensure_home(home) else {
        return 1;
    };
    if let Some(RulesCommand::Set { key, value }) = &action {
        if !RULE_KEYS.contains(&key.as_str()) {
            eprintln!("unknown rule {key}");
            eprintln!("rules: {}", RULE_KEYS.join(", "));
            return 1;
        }
        let Some(flag) = parse_bool(value) else {
            eprintln!("value must be true or false");
            return 1;
        };
        if let Some(rules) = config.get_mut("rules").and_then(toml::Value::as_table_mut) {
            rules.insert(key.clone(), toml::Value::Boolean(flag));
        }
        if save_config(home, &config).is_err() {
            return 1;
        }
    }
    for key in RULE_KEYS {
        let value = config
            .get("rules")
            .and_then(|rules| rules.get(*key))
            .and_then(toml::Value::as_bool)
            .unwrap_or(false);
        println!("{key} = {}", if value { "true" } else { "false" });
    }
    0
}

fn cmd_peer(home: &Path, action: Option<PeerCommand>) -> i32 {
    if ensure_home(home).is_err() {
        return 1;
    }
    match action {
        Some(PeerCommand::Add { url }) => match user_add_peer(home, &url) {
            Ok(url) => {
                println!("Added peer {url}");
                println!("IdleHand will fetch that URL directly. This does not add repositories.");
                0
            }
            Err(err) => {
                eprintln!("{err}");
                1
            }
        },
        Some(PeerCommand::List) | None => {
            let Ok(peers) = load_peers(home) else {
                eprintln!("the peer list is unreadable");
                return 1;
            };
            if peers.is_empty() {
                println!("No peers yet.");
                return 0;
            }
            for peer in peers {
                println!(
                    "{}  source={}  endorsements={}",
                    peer.url, peer.source, peer.endorsements
                );
            }
            0
        }
    }
}

fn cmd_sources(home: &Path) -> i32 {
    if ensure_home(home).is_err() {
        return 1;
    }
    println!("{}", sources_path(home).display());
    match load_sources(home) {
        Ok(repos) => {
            for repo in repos {
                println!("{}", repo.url);
            }
            0
        }
        Err(err) => {
            eprintln!("{err}");
            1
        }
    }
}

fn cmd_sandbox(home: &Path, action: SandboxCommand) -> i32 {
    let Ok(config) = ensure_home(home) else {
        return 1;
    };
    let runtime_name = config
        .get("sandbox")
        .and_then(|s| s.get("runtime"))
        .and_then(toml::Value::as_str)
        .unwrap_or("auto");
    let runtime = sandbox::detect_runtime(runtime_name);
    match action {
        SandboxCommand::Spec => {
            let shown = runtime.clone().unwrap_or_else(|| "none".into());
            println!("runtime: {shown}");
            if shown == "docker" || shown == "podman" {
                let limits = sandbox::sandbox_limits(
                    config
                        .get("sandbox")
                        .and_then(|s| s.get("image"))
                        .and_then(toml::Value::as_str)
                        .unwrap_or("python:3.12-slim"),
                    config
                        .get("sandbox")
                        .and_then(|s| s.get("memory"))
                        .and_then(toml::Value::as_str)
                        .unwrap_or("512m"),
                    config
                        .get("sandbox")
                        .and_then(|s| s.get("cpus"))
                        .and_then(toml::Value::as_str)
                        .unwrap_or("1"),
                );
                match limits {
                    None => println!("sandbox limit is unreadable"),
                    Some((image, memory, cpus)) => {
                        let argv = sandbox::build_container_argv(
                            &shown,
                            &home.join("workspaces/spec"),
                            &probe_command(&shown),
                            &image,
                            &memory,
                            &cpus,
                        );
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
        SandboxCommand::Run => {
            let chosen = runtime.unwrap_or_else(|| "namespace".into());
            let result = sandbox::run(
                &home.join("workspaces/manual"),
                &probe_command(&chosen),
                runtime_name,
                config
                    .get("sandbox")
                    .and_then(|s| s.get("image"))
                    .and_then(toml::Value::as_str)
                    .unwrap_or("python:3.12-slim"),
                config
                    .get("sandbox")
                    .and_then(|s| s.get("memory"))
                    .and_then(toml::Value::as_str)
                    .unwrap_or("512m"),
                config
                    .get("sandbox")
                    .and_then(|s| s.get("cpus"))
                    .and_then(toml::Value::as_str)
                    .unwrap_or("1"),
                std::time::Duration::from_secs(30),
            );
            if !result.stdout.is_empty() {
                println!("{}", result.stdout.trim_end());
            }
            if !result.ok {
                eprintln!("{}", result.reason);
                return 1;
            }
            println!(
                "sandbox {} finished. This was not a contribution.",
                result.runtime
            );
            0
        }
    }
}

fn finish(result: forge::ForgeResult) -> i32 {
    if !result.output.is_empty() {
        println!("{}", result.output.trim_end());
    }
    if result.ok {
        println!("{}", result.detail);
        0
    } else {
        eprintln!("{}", result.detail);
        1
    }
}

fn body_text(body: &TextBody) -> Result<String, i32> {
    if body.body.is_some() && body.body_file.is_some() {
        eprintln!("pass either --body or --body-file");
        return Err(1);
    }
    let Some(body_file) = body.body_file.as_deref().filter(|path| !path.is_empty()) else {
        return Ok(body.body.clone().unwrap_or_default());
    };
    let path = Path::new(body_file);
    if crate::home::is_symlink(path) || !path.is_file() {
        eprintln!("the body file is unreadable");
        return Err(1);
    }
    match std::fs::metadata(path).and_then(|meta| {
        if meta.len() > 65_000 {
            Err(std::io::Error::other("long"))
        } else {
            std::fs::read_to_string(path)
        }
    }) {
        Ok(text) => Ok(text),
        Err(err) if err.to_string() == "long" => {
            eprintln!("the body is too long");
            Err(1)
        }
        Err(_) => {
            eprintln!("the body file is unreadable");
            Err(1)
        }
    }
}

fn one(value: &Option<String>) -> &str {
    value.as_deref().unwrap_or("")
}

fn two(values: &[String]) -> (&str, &str) {
    (
        values.first().map(String::as_str).unwrap_or(""),
        values.get(1).map(String::as_str).unwrap_or(""),
    )
}

fn cmd_rad(home: &Path, action: RadCommand) -> i32 {
    if ensure_home(home).is_err() {
        return 1;
    }
    match action {
        RadCommand::Status => {
            let (nid, detail) = remember_identity(home);
            if detail == "rad is not installed" {
                eprintln!("rad is not installed");
                return 1;
            }
            let running = radicle::node_running();
            if nid.is_empty() {
                eprintln!("{detail}");
            } else {
                println!("Radicle node id: {nid}");
            }
            if running.ok {
                println!("{}", running.detail);
            } else {
                eprintln!("{}", running.detail);
            }
            if !nid.is_empty() && running.ok {
                0
            } else {
                1
            }
        }
        RadCommand::Delegated => {
            let Some(rows) = forge::load_delegated(home) else {
                eprintln!("the delegation list is unreadable");
                return 1;
            };
            let mine: Vec<_> = rows
                .into_iter()
                .filter(|(provider, _)| provider == "radicle")
                .collect();
            if mine.is_empty() {
                println!("No repositories are delegated.");
                return 0;
            }
            for (_, name) in mine {
                println!("radicle {name}");
            }
            0
        }
        RadCommand::Delegate { rid } => finish(radicle::delegate_rid(home, one(&rid))),
        RadCommand::Revoke { rid } => finish(radicle::revoke_rid(home, one(&rid))),
        RadCommand::Issue { action } => cmd_rad_issue(home, action),
        RadCommand::Patch { action } => cmd_rad_patch(home, action),
    }
}

fn cmd_rad_issue(home: &Path, action: RadIssueCommand) -> i32 {
    match action {
        RadIssueCommand::Create { rid, title, body } => {
            let body = match body_text(&body) {
                Ok(body) => body,
                Err(code) => return code,
            };
            let title = one(&title);
            if title.is_empty() {
                eprintln!("a title is required");
                return 2;
            }
            finish(radicle::create_issue(home, one(&rid), title, &body))
        }
        RadIssueCommand::Update {
            rid_and_id,
            title,
            body,
        } => {
            let body = match body_text(&body) {
                Ok(body) => body,
                Err(code) => return code,
            };
            let (rid, id) = two(&rid_and_id);
            finish(radicle::update_issue(home, rid, id, one(&title), &body))
        }
        RadIssueCommand::Send { rid } => finish(radicle::send_issue_draft(home, one(&rid))),
    }
}

fn cmd_rad_patch(home: &Path, action: RadPatchCommand) -> i32 {
    match action {
        RadPatchCommand::Open {
            rid,
            path,
            title,
            body,
        } => {
            let body = match body_text(&body) {
                Ok(body) => body,
                Err(code) => return code,
            };
            let title = one(&title);
            let checkout = one(&path);
            if title.is_empty() || checkout.is_empty() {
                eprintln!("usage: idlehand rad patch open RID --path PATH --title TITLE");
                return 2;
            }
            finish(radicle::open_patch(home, one(&rid), title, &body, checkout))
        }
        RadPatchCommand::Check {
            rid_and_patch,
            path,
        } => {
            let (rid, patch) = two(&rid_and_patch);
            finish(radicle::review_patch(home, rid, patch, one(&path)))
        }
        RadPatchCommand::Update {
            rid_and_patch,
            title,
            body,
        } => {
            let body = match body_text(&body) {
                Ok(body) => body,
                Err(code) => return code,
            };
            let title = one(&title);
            if title.is_empty() {
                eprintln!("a title is required");
                return 2;
            }
            let (rid, patch) = two(&rid_and_patch);
            finish(radicle::update_patch(home, rid, patch, title, &body))
        }
        RadPatchCommand::Send { rid_and_patch } => {
            let (rid, patch) = two(&rid_and_patch);
            finish(radicle::send_patch_draft(home, rid, patch))
        }
    }
}

fn cmd_github(home: &Path, provider: &str, action: GithubCommand) -> i32 {
    if !registered_forges().contains(&provider) {
        eprintln!("IdleHand has no forge provider for that name");
        return 1;
    }
    if ensure_home(home).is_err() {
        return 1;
    }
    match action {
        GithubCommand::Status => {
            let account = forge::delegation_status(provider);
            if account.connected {
                println!("{}", account.detail);
                0
            } else {
                eprintln!("{}", account.detail);
                1
            }
        }
        GithubCommand::Repos => {
            let (repos, detail) = forge::list_manageable(provider);
            let Some(repos) = repos else {
                eprintln!("{detail}");
                return 1;
            };
            if repos.is_empty() {
                println!("No owned or administered repositories.");
            }
            for repo in repos {
                println!("{}  {}", repo.name, repo.role);
            }
            if !detail.is_empty() {
                println!("{detail}");
            }
            0
        }
        GithubCommand::Delegated => {
            let Some(rows) = forge::load_delegated(home) else {
                eprintln!("the delegation list is unreadable");
                return 1;
            };
            let mine: Vec<_> = rows
                .into_iter()
                .filter(|(item, _)| item == provider)
                .collect();
            if mine.is_empty() {
                println!("No repositories are delegated.");
                return 0;
            }
            for (item, name) in mine {
                println!("{item} {name}");
            }
            0
        }
        GithubCommand::Delegate { repo } => {
            finish(forge::delegate_repo(home, provider, one(&repo)))
        }
        GithubCommand::Revoke { repo } => finish(forge::revoke_repo(home, provider, one(&repo))),
        GithubCommand::Issue { action } => cmd_github_issue(home, provider, action),
        GithubCommand::Pr { action } => cmd_github_pr(home, provider, action),
    }
}

fn cmd_github_issue(home: &Path, provider: &str, action: GithubIssueCommand) -> i32 {
    match action {
        GithubIssueCommand::Create { repo, title, body } => {
            let body = match body_text(&body) {
                Ok(body) => body,
                Err(code) => return code,
            };
            let title = one(&title);
            if title.is_empty() {
                eprintln!("a title is required");
                return 2;
            }
            finish(forge::create_issue(
                home,
                provider,
                one(&repo),
                title,
                &body,
            ))
        }
        GithubIssueCommand::Update {
            repo_and_number,
            title,
            body,
        } => {
            let body = match body_text(&body) {
                Ok(body) => body,
                Err(code) => return code,
            };
            let (repo, number) = two(&repo_and_number);
            let Some(number) = forge::parse_number(number) else {
                eprintln!("the issue number is unreadable");
                return 1;
            };
            finish(forge::update_issue(
                home,
                provider,
                repo,
                number,
                one(&title),
                &body,
            ))
        }
        GithubIssueCommand::Send { repo } => {
            finish(forge::send_issue_draft(home, provider, one(&repo)))
        }
    }
}

fn cmd_github_pr(home: &Path, provider: &str, action: GithubPrCommand) -> i32 {
    match action {
        GithubPrCommand::Create {
            repo,
            head,
            title,
            base,
            body,
        } => {
            let body = match body_text(&body) {
                Ok(body) => body,
                Err(code) => return code,
            };
            let title = one(&title);
            let head = one(&head);
            if title.is_empty() || head.is_empty() {
                eprintln!("usage: idlehand github pr create REPO --head REF --title TITLE");
                return 2;
            }
            finish(forge::create_pull_request(
                home,
                provider,
                one(&repo),
                title,
                &body,
                head,
                one(&base),
            ))
        }
        GithubPrCommand::Update {
            repo_and_number,
            title,
            body,
        } => {
            let body = match body_text(&body) {
                Ok(body) => body,
                Err(code) => return code,
            };
            let (repo, number) = two(&repo_and_number);
            let Some(number) = forge::parse_number(number) else {
                eprintln!("the pull request number is unreadable");
                return 1;
            };
            finish(forge::update_pull_request(
                home,
                provider,
                repo,
                number,
                one(&title),
                &body,
            ))
        }
        GithubPrCommand::Send { repo, head, base } => {
            let head = one(&head);
            if head.is_empty() {
                eprintln!("usage: idlehand github pr send REPO --head REF");
                return 2;
            }
            finish(forge::send_pull_request_draft(
                home,
                provider,
                one(&repo),
                head,
                one(&base),
            ))
        }
    }
}

fn cmd_node(home: &Path) -> i32 {
    if alive_pid(home).is_some() {
        eprintln!("IdleHand node is already running");
        return 1;
    }
    serve(home);
    0
}

fn cmd_jail(argv: &[String], workspace: Option<String>, command: Vec<String>) -> i32 {
    let mut seen_jail = false;
    let mut has_separator = false;
    for arg in argv {
        if !seen_jail {
            if arg == "jail" {
                seen_jail = true;
            }
            continue;
        }
        if arg == "--" {
            has_separator = true;
            break;
        }
    }
    if !has_separator {
        eprintln!("usage: idlehand jail --workspace PATH -- COMMAND...");
        return 2;
    }
    let mut raw = Vec::new();
    if let Some(workspace) = workspace {
        raw.push("--workspace".into());
        raw.push(workspace);
    }
    raw.push("--".into());
    raw.extend(command);
    jail_main(&raw)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn plain(err: &clap::Error) -> String {
        let text = err.to_string();
        let mut out = String::new();
        let mut chars = text.chars().peekable();
        while let Some(ch) = chars.next() {
            if ch == '\u{1b}' {
                for next in chars.by_ref() {
                    if next == 'm' {
                        break;
                    }
                }
            } else {
                out.push(ch);
            }
        }
        out
    }

    #[test]
    fn help_lists_commands_and_omits_connect_and_jail() {
        let err = Cli::try_parse_from(["idlehand", "--help"]).unwrap_err();
        assert_eq!(err.exit_code(), 0);
        let text = plain(&err);
        for name in [
            "init",
            "configure",
            "demo",
            "start",
            "stop",
            "status",
            "analytics",
            "limit",
            "link",
            "rules",
            "peer",
            "sources",
            "sandbox",
            "rad",
            "github",
            "node",
            "--home",
        ] {
            assert!(text.contains(name), "{name} missing from {text}");
        }
        assert!(!text.contains("connect"), "{text}");
        assert!(!text.contains("jail"), "{text}");
    }

    #[test]
    fn version_matches_the_crate() {
        let err = Cli::try_parse_from(["idlehand", "--version"]).unwrap_err();
        assert_eq!(err.exit_code(), 0);
        assert_eq!(
            plain(&err).trim(),
            format!("idlehand {}", env!("CARGO_PKG_VERSION"))
        );
    }

    #[test]
    fn command_help_comes_from_clap() {
        let err = Cli::try_parse_from(["idlehand", "analytics", "--help"]).unwrap_err();
        assert_eq!(err.exit_code(), 0);
        let text = plain(&err);
        assert!(text.contains("analytics"), "{text}");
        assert!(text.contains("--json"), "{text}");
    }

    #[test]
    fn missing_command_is_usage() {
        let err = Cli::try_parse_from(["idlehand"]).unwrap_err();
        assert_eq!(err.exit_code(), 2);
    }

    #[test]
    fn home_flag_works_after_the_command() {
        let cli =
            Cli::try_parse_from(["idlehand", "status", "--home", "/tmp/idlehand-home"]).unwrap();
        assert_eq!(cli.home.as_deref(), Some("/tmp/idlehand-home"));
        assert!(matches!(cli.command, Command::Status));
    }

    #[test]
    fn rad_patch_open_parses_flags() {
        let cli = Cli::try_parse_from([
            "idlehand",
            "rad",
            "patch",
            "open",
            "rad:zabc",
            "--path",
            "/tmp/checkout",
            "--title",
            "Fix the link",
            "--body",
            "Updates the README.",
        ])
        .unwrap();
        match cli.command {
            Command::Rad {
                action:
                    RadCommand::Patch {
                        action:
                            RadPatchCommand::Open {
                                rid,
                                path,
                                title,
                                body,
                            },
                    },
            } => {
                assert_eq!(rid.as_deref(), Some("rad:zabc"));
                assert_eq!(path.as_deref(), Some("/tmp/checkout"));
                assert_eq!(title.as_deref(), Some("Fix the link"));
                assert_eq!(body.body.as_deref(), Some("Updates the README."));
                assert!(body.body_file.is_none());
            }
            other => panic!("unexpected {other:?}"),
        }
    }

    #[test]
    fn github_pr_send_parses_head() {
        let cli = Cli::try_parse_from([
            "idlehand",
            "github",
            "pr",
            "send",
            "Dodecahedr0x/idlehand",
            "--head",
            "fix-link",
        ])
        .unwrap();
        match cli.command {
            Command::Github {
                action:
                    GithubCommand::Pr {
                        action: GithubPrCommand::Send { repo, head, base },
                    },
            } => {
                assert_eq!(repo.as_deref(), Some("Dodecahedr0x/idlehand"));
                assert_eq!(head.as_deref(), Some("fix-link"));
                assert!(base.is_none());
            }
            other => panic!("unexpected {other:?}"),
        }
    }

    #[test]
    fn jail_keeps_the_workspace_and_the_command_after_the_separator() {
        let cli = Cli::try_parse_from([
            "idlehand",
            "jail",
            "--workspace",
            "/tmp/w",
            "--",
            "echo",
            "hi",
            "--flag",
        ])
        .unwrap();
        match cli.command {
            Command::Jail { workspace, command } => {
                assert_eq!(workspace.as_deref(), Some("/tmp/w"));
                assert_eq!(command, ["echo", "hi", "--flag"]);
            }
            other => panic!("unexpected {other:?}"),
        }
    }

    #[test]
    fn unknown_rad_command_is_usage() {
        let err = Cli::try_parse_from(["idlehand", "rad", "nope"]).unwrap_err();
        assert_eq!(err.exit_code(), 2);
    }

    #[test]
    fn body_and_body_file_together_fail() {
        let result = body_text(&TextBody {
            body: Some("a".into()),
            body_file: Some("b".into()),
        });
        assert_eq!(result, Err(1));
    }

    #[test]
    fn configure_without_a_terminal_exits_without_creating_a_home() {
        let home = std::env::temp_dir().join(format!(
            "idlehand-cfg-notty-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .map(|d| d.as_nanos())
                .unwrap_or(0)
        ));
        let _ = std::fs::remove_dir_all(&home);
        let code = main_tty(
            &[
                "--home".into(),
                home.display().to_string(),
                "configure".into(),
            ],
            false,
        );
        assert_eq!(code, 1);
        assert!(!home.exists());
    }

    #[test]
    fn configure_help_does_not_need_a_terminal() {
        assert_eq!(main_tty(&["configure".into(), "--help".into()], false), 0);
    }
}
