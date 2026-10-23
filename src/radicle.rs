//! Radicle identity, delegation, issues, and patch review.
//!
//! `rad` runs on the trusted side. The passphrase is never placed in argv.
//! A patch is accepted or refused only after the sandbox ran tests.

use std::path::{Path, PathBuf};
use std::time::Duration;

use regex::Regex;
use serde_json::Value;

use crate::actions::action_command;
use crate::config::{self, load_config, load_sources, save_config};
use crate::fetch::{resolve_git, scrub_secrets};
use crate::forge::{self, checked_text, load_delegated, parse_rid, save_delegated, ForgeResult};
use crate::home::HomeLock;
use crate::procutil::{self, which};
use crate::sandbox::{self, SandboxResult};

const NOT_INSTALLED: &str = "rad is not installed";
const NOT_RUNNING: &str = "the Radicle node is not running";
const NO_IDENTITY: &str = "rad did not report a node id";

pub fn parse_node_id(value: &str) -> Option<String> {
    let text = value.trim();
    let re = Regex::new(r"^z6Mk[1-9A-HJ-NP-Za-km-z]{44}$").unwrap();
    re.is_match(text).then(|| text.to_string())
}

pub fn parse_cob_id(value: &str) -> Option<String> {
    let text = value.trim();
    let re = Regex::new(r"^[0-9a-f]{40}$").unwrap();
    re.is_match(text).then(|| text.to_string())
}

fn plain(text: &str) -> String {
    Regex::new(r"\x1b\[[0-9;]*[A-Za-z]")
        .unwrap()
        .replace_all(text, "")
        .into_owned()
}

fn show(text: &str) -> String {
    let cleaned = scrub_secrets(&plain(text));
    let secret = std::env::var("RAD_PASSPHRASE").unwrap_or_default();
    for line in cleaned.lines() {
        let stripped = line.trim();
        if stripped.is_empty()
            || stripped.contains("PRIVATE KEY")
            || stripped.contains("RAD_PASSPHRASE")
        {
            continue;
        }
        if !secret.is_empty() && stripped.contains(&secret) {
            continue;
        }
        return stripped.chars().take(200).collect();
    }
    String::new()
}

fn rad_run(args: &[String], timeout: Duration, cwd: Option<&Path>) -> procutil::ProcOut {
    let Some(binary) = which("rad") else {
        return procutil::ProcOut {
            code: 127,
            stdout: String::new(),
            stderr: NOT_INSTALLED.into(),
        };
    };
    let owned = cwd.is_none();
    let work = if owned {
        let path = std::env::temp_dir().join(format!(
            "idlehand-rad-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .map(|d| d.as_nanos())
                .unwrap_or(0)
        ));
        let _ = std::fs::create_dir_all(&path);
        path
    } else {
        cwd.unwrap().to_path_buf()
    };
    let mut command = vec![binary.display().to_string()];
    command.extend(args.iter().cloned());
    let mut result = procutil::run_inherited(&command, Some(&work), timeout);
    if owned {
        let _ = std::fs::remove_dir_all(&work);
    }
    if result.code == 124 {
        result.stderr = "rad timed out".into();
        result.stdout.clear();
    }
    result
}

fn failure(fallback: &str, result: &procutil::ProcOut) -> String {
    let detail = show(if result.stderr.is_empty() {
        &result.stdout
    } else {
        &result.stderr
    });
    if detail.is_empty() || detail == NOT_INSTALLED {
        fallback.to_string()
    } else {
        format!("{fallback}: {detail}")
    }
}

fn one_line(result: &procutil::ProcOut) -> String {
    if result.code != 0 {
        return String::new();
    }
    let text = plain(&result.stdout).trim().to_string();
    if text.is_empty() || text.contains('\n') || text.len() > 200 {
        String::new()
    } else {
        text
    }
}

pub fn identity() -> Result<(String, String), ForgeResult> {
    if which("rad").is_none() {
        return Err(ForgeResult::new(false, NOT_INSTALLED));
    }
    let nid = parse_node_id(&one_line(&rad_run(
        &["self".into(), "--nid".into()],
        Duration::from_secs(10),
        None,
    )))
    .unwrap_or_default();
    let did = one_line(&rad_run(
        &["self".into(), "--did".into()],
        Duration::from_secs(10),
        None,
    ));
    if nid.is_empty() || did != format!("did:key:{nid}") {
        return Err(ForgeResult::new(false, NO_IDENTITY));
    }
    Ok((nid, did))
}

pub fn remember_identity(home: &Path) -> (String, String) {
    let (nid, _did) = match identity() {
        Ok(found) => found,
        Err(result) => return (String::new(), result.detail),
    };
    let Ok(config) = load_config(home) else {
        return (String::new(), "config is unreadable".into());
    };
    if config.get("node_id").and_then(toml::Value::as_str) == Some(nid.as_str()) {
        return (nid, String::new());
    }
    let Ok(_lock) = HomeLock::acquire(home) else {
        return (String::new(), "config is unreadable".into());
    };
    let Ok(mut current) = load_config(home) else {
        return (String::new(), "config is unreadable".into());
    };
    if let Some(table) = current.as_table_mut() {
        table.insert("node_id".into(), toml::Value::String(nid.clone()));
    }
    if save_config(home, &current).is_err() {
        return (String::new(), "config is unreadable".into());
    }
    (nid, String::new())
}

pub fn node_running() -> ForgeResult {
    if which("rad").is_none() {
        return ForgeResult::new(false, NOT_INSTALLED);
    }
    let result = rad_run(
        &["node".into(), "status".into()],
        Duration::from_secs(10),
        None,
    );
    if result.stdout.len() > 1_000_000 || result.stderr.len() > 1_000_000 {
        return ForgeResult::new(false, NOT_RUNNING);
    }
    let text = plain(&format!("{}\n{}", result.stdout, result.stderr));
    let running_at = text.find("Node is running").map(|n| n as i64).unwrap_or(-1);
    let stopped_at = text.find("Node is stopped").map(|n| n as i64).unwrap_or(-1);
    if result.code == 0 && running_at >= 0 && (stopped_at < 0 || running_at < stopped_at) {
        ForgeResult::new(true, "The Radicle node is running.")
    } else {
        ForgeResult::new(false, NOT_RUNNING)
    }
}

fn controls(rid: &str, did: &str) -> ForgeResult {
    let result = rad_run(
        &["inspect".into(), "--identity".into(), rid.into()],
        Duration::from_secs(15),
        None,
    );
    if result.code != 0 || result.stdout.len() > 1_000_000 {
        return ForgeResult::new(
            false,
            "rad could not show whether this identity controls that repository",
        );
    }
    let plain_text = plain(&result.stdout);
    let Some(start) = plain_text.find('{') else {
        return ForgeResult::new(
            false,
            "rad could not show whether this identity controls that repository",
        );
    };
    let Some(end) = plain_text.rfind('}') else {
        return ForgeResult::new(
            false,
            "rad could not show whether this identity controls that repository",
        );
    };
    let Ok(document) = serde_json::from_str::<Value>(&plain_text[start..=end]) else {
        return ForgeResult::new(
            false,
            "rad could not show whether this identity controls that repository",
        );
    };
    let Some(delegates) = document.get("delegates").and_then(Value::as_array) else {
        return ForgeResult::new(
            false,
            "rad could not show whether this identity controls that repository",
        );
    };
    let nid = did.trim_start_matches("did:key:");
    if delegates
        .iter()
        .any(|item| item.as_str() == Some(did) || item.as_str() == Some(nid))
    {
        ForgeResult::new(true, "")
    } else {
        ForgeResult::new(false, "this identity does not control that repository")
    }
}

fn ready(rid: &str) -> Result<(String, String), ForgeResult> {
    let running = node_running();
    if !running.ok {
        return Err(running);
    }
    let (nid, did) = identity()?;
    let controlled = controls(rid, &did);
    if !controlled.ok {
        return Err(controlled);
    }
    Ok((nid, did))
}

fn stored(home: &Path, rid: &str) -> Result<String, ForgeResult> {
    let Some(rows) = load_delegated(home) else {
        return Err(ForgeResult::new(false, "the delegation list is unreadable"));
    };
    rows.into_iter()
        .find(|(provider, name)| provider == "radicle" && name == rid)
        .map(|(_, name)| name)
        .ok_or_else(|| ForgeResult::new(false, "that repository is not delegated"))
}

pub fn delegate_rid(home: &Path, raw: &str) -> ForgeResult {
    let Some(rid) = parse_rid(raw) else {
        return ForgeResult::new(false, "repository must look like rad:z…");
    };
    let Some(mut rows) = load_delegated(home) else {
        return ForgeResult::new(false, "the delegation list is unreadable");
    };
    if rows
        .iter()
        .any(|(provider, name)| provider == "radicle" && name == &rid)
    {
        return ForgeResult::new(true, format!("{rid} is already delegated"));
    }
    if let Err(blocked) = ready(&rid) {
        return blocked;
    }
    rows.push(("radicle".into(), rid.clone()));
    if !save_delegated(home, &rows) {
        return ForgeResult::new(false, "the delegation list is unreadable");
    }
    ForgeResult::new(true, format!("delegated {rid}"))
}

pub fn revoke_rid(home: &Path, raw: &str) -> ForgeResult {
    let Some(rid) = parse_rid(raw) else {
        return ForgeResult::new(false, "repository must look like rad:z…");
    };
    let Some(rows) = load_delegated(home) else {
        return ForgeResult::new(false, "the delegation list is unreadable");
    };
    if !rows
        .iter()
        .any(|(provider, name)| provider == "radicle" && name == &rid)
    {
        return ForgeResult::new(false, "that repository is not delegated");
    }
    let kept: Vec<_> = rows
        .into_iter()
        .filter(|(provider, name)| !(provider == "radicle" && name == &rid))
        .collect();
    if !save_delegated(home, &kept) {
        return ForgeResult::new(false, "the delegation list is unreadable");
    }
    ForgeResult::new(true, format!("revoked {rid}"))
}

fn delegated_ready(home: &Path, rid: &str) -> Option<ForgeResult> {
    if let Err(blocked) = stored(home, rid) {
        return Some(blocked);
    }
    ready(rid).err()
}

fn listed(home: &Path, rid: &str) -> bool {
    load_sources(home)
        .ok()
        .map(|sources| {
            sources
                .iter()
                .any(|source| parse_rid(&source.url).as_deref() == Some(rid))
        })
        .unwrap_or(false)
}

fn work_ready(home: &Path, rid: &str) -> Option<ForgeResult> {
    let Some(rows) = load_delegated(home) else {
        return Some(ForgeResult::new(false, "the delegation list is unreadable"));
    };
    let delegated = rows
        .iter()
        .any(|(provider, name)| provider == "radicle" && name == rid);
    if !delegated && !listed(home, rid) {
        return Some(ForgeResult::new(false, "that repository is not delegated"));
    }
    if which("rad").is_none() {
        return Some(ForgeResult::new(false, NOT_INSTALLED));
    }
    let running = node_running();
    if !running.ok {
        return Some(running);
    }
    let found = match identity() {
        Ok(found) => found,
        Err(result) => return Some(result),
    };
    if delegated {
        let controlled = controls(rid, &found.1);
        if !controlled.ok {
            return Some(controlled);
        }
    }
    None
}

pub fn cob_from(stdout: &str, stderr: &str) -> String {
    let text = plain(&format!("{stdout}\n{stderr}"));
    Regex::new(r"(?m)^[^\n]*\bIssue\s+([0-9a-f]{40})\b")
        .unwrap()
        .captures(&text)
        .map(|c| c.get(1).unwrap().as_str().to_string())
        .unwrap_or_default()
}

pub fn create_issue(home: &Path, raw: &str, title: &str, body: &str) -> ForgeResult {
    if let Some(refused) = checked_text(title, body, true, true) {
        return refused;
    }
    let Some(rid) = parse_rid(raw) else {
        return ForgeResult::new(false, "repository must look like rad:z…");
    };
    if let Some(blocked) = work_ready(home, &rid) {
        return blocked;
    }
    let result = rad_run(
        &[
            "issue".into(),
            "open".into(),
            "--repo".into(),
            rid.clone(),
            "--title".into(),
            title.trim().into(),
            "--description".into(),
            body.into(),
            "--no-announce".into(),
        ],
        Duration::from_secs(30),
        None,
    );
    let issue_id = cob_from(&result.stdout, &result.stderr);
    if result.code != 0 || issue_id.is_empty() {
        return ForgeResult::new(
            false,
            failure("rad did not confirm that the issue was opened", &result),
        );
    }
    if let Some(blocked) = replicate(&rid) {
        return blocked;
    }
    ForgeResult::new(true, format!("opened issue {issue_id} on {rid}"))
}

pub fn update_issue(home: &Path, raw: &str, raw_id: &str, title: &str, body: &str) -> ForgeResult {
    let Some(issue_id) = parse_cob_id(raw_id) else {
        return ForgeResult::new(false, "the issue id is unreadable");
    };
    if title.trim().is_empty() && body.trim().is_empty() {
        return ForgeResult::new(false, "nothing to update");
    }
    if let Some(refused) = checked_text(title, body, false, false) {
        return refused;
    }
    let Some(rid) = parse_rid(raw) else {
        return ForgeResult::new(false, "repository must look like rad:z…");
    };
    if let Some(blocked) = delegated_ready(home, &rid) {
        return blocked;
    }
    let mut command = vec![
        "issue".into(),
        "edit".into(),
        issue_id.clone(),
        "--repo".into(),
        rid.clone(),
    ];
    if !title.trim().is_empty() {
        command.extend(["--title".into(), title.trim().into()]);
    }
    if !body.trim().is_empty() {
        command.extend(["--description".into(), body.into()]);
    }
    command.push("--no-announce".into());
    let result = rad_run(&command, Duration::from_secs(30), None);
    let combined = plain(&format!("{}{}", result.stdout, result.stderr));
    if result.code != 0 || !combined.contains(&issue_id) {
        return ForgeResult::new(
            false,
            failure("rad did not confirm that the issue was updated", &result),
        );
    }
    if let Some(blocked) = replicate(&rid) {
        return blocked;
    }
    ForgeResult::new(true, format!("updated issue {issue_id} on {rid}"))
}

pub fn update_patch(home: &Path, raw: &str, raw_id: &str, title: &str, body: &str) -> ForgeResult {
    let Some(patch_id) = parse_cob_id(raw_id) else {
        return ForgeResult::new(false, "the patch id is unreadable");
    };
    if title.trim().is_empty() {
        return ForgeResult::new(false, "a patch update needs a title");
    }
    if let Some(refused) = checked_text(title, body, true, false) {
        return refused;
    }
    let Some(rid) = parse_rid(raw) else {
        return ForgeResult::new(false, "repository must look like rad:z…");
    };
    if let Some(blocked) = delegated_ready(home, &rid) {
        return blocked;
    }
    let mut command = vec![
        "patch".into(),
        "edit".into(),
        patch_id.clone(),
        "--repo".into(),
        rid.clone(),
        "--message".into(),
        title.trim().into(),
    ];
    if !body.trim().is_empty() {
        command.extend(["--message".into(), body.into()]);
    }
    command.push("--no-announce".into());
    let result = rad_run(&command, Duration::from_secs(30), None);
    if result.code != 0 {
        return ForgeResult::new(
            false,
            failure("rad did not confirm that the patch was updated", &result),
        );
    }
    if let Some(blocked) = replicate(&rid) {
        return blocked;
    }
    ForgeResult::new(true, format!("updated patch {patch_id} on {rid}"))
}

fn checkout(raw: &str) -> Result<PathBuf, ForgeResult> {
    if raw.is_empty() || raw.contains(['\n', '\0', '\r']) {
        return Err(ForgeResult::new(false, "the checkout is unreadable"));
    }
    let path = Path::new(raw);
    if crate::home::is_symlink(path) {
        return Err(ForgeResult::new(false, "the checkout is unreadable"));
    }
    let resolved = path
        .canonicalize()
        .map_err(|_| ForgeResult::new(false, "the checkout is unreadable"))?;
    if !resolved.is_dir() {
        return Err(ForgeResult::new(false, "the checkout is unreadable"));
    }
    let git_dir = resolved.join(".git");
    if crate::home::is_symlink(&git_dir) || !git_dir.exists() {
        return Err(ForgeResult::new(
            false,
            "that checkout is not a git repository",
        ));
    }
    Ok(resolved)
}

fn checkout_rid(path: &Path) -> Result<String, ForgeResult> {
    let result = rad_run(&[".".into()], Duration::from_secs(15), Some(path));
    if result.code != 0 {
        return Err(ForgeResult::new(
            false,
            "that checkout is not a Radicle repository",
        ));
    }
    for line in plain(&result.stdout).lines() {
        if let Some(rid) = parse_rid(line.trim()) {
            return Ok(rid);
        }
    }
    Err(ForgeResult::new(
        false,
        "that checkout is not a Radicle repository",
    ))
}

fn other_node_received(text: &str) -> bool {
    let seeds = Regex::new(r"(?:Synced with|already in sync with) ([0-9]+) seed").unwrap();
    if seeds.captures_iter(text).any(|cap| {
        cap.get(1)
            .and_then(|m| m.as_str().parse::<i64>().ok())
            .unwrap_or(0)
            >= 1
    }) {
        return true;
    }
    let nid = Regex::new(r"z6Mk[1-9A-HJ-NP-Za-km-z]{44}").unwrap();
    text.lines()
        .any(|line| line.contains("Synced with") && nid.is_match(line))
}

fn replicate(rid: &str) -> Option<ForgeResult> {
    let result = rad_run(
        &[
            "sync".into(),
            rid.into(),
            "--announce".into(),
            "--replicas".into(),
            "1".into(),
            "--timeout".into(),
            "20s".into(),
        ],
        Duration::from_secs(40),
        None,
    );
    let plain_text = plain(&format!("{}\n{}", result.stdout, result.stderr));
    if result.code == 0 && other_node_received(&plain_text) {
        return None;
    }
    let detail = show(&plain_text);
    Some(if detail.is_empty() {
        ForgeResult::new(false, "rad did not replicate that repository")
    } else {
        ForgeResult::new(
            false,
            format!("rad did not replicate that repository: {detail}"),
        )
    })
}

pub fn open_patch(
    home: &Path,
    raw: &str,
    title: &str,
    body: &str,
    checkout_path: &str,
) -> ForgeResult {
    if let Some(refused) = checked_text(title, body, true, false) {
        return refused;
    }
    let Some(rid) = parse_rid(raw) else {
        return ForgeResult::new(false, "repository must look like rad:z…");
    };
    if let Some(blocked) = work_ready(home, &rid) {
        return blocked;
    }
    let path = match checkout(checkout_path) {
        Ok(path) => path,
        Err(result) => return result,
    };
    let reported = match checkout_rid(&path) {
        Ok(rid) => rid,
        Err(result) => return result,
    };
    if reported != rid {
        return ForgeResult::new(false, "that checkout is not this repository");
    }
    let result = git_push(&path, title.trim(), body);
    let plain_text = plain(&format!("{}\n{}", result.stdout, result.stderr));
    let opened = Regex::new(r"Patch ([0-9a-f]{40}) opened")
        .unwrap()
        .captures(&plain_text)
        .map(|c| c.get(1).unwrap().as_str().to_string());
    let Some(patch_id) = opened.filter(|_| result.code == 0) else {
        return ForgeResult::new(
            false,
            failure("rad did not confirm that the patch was opened", &result),
        );
    };
    if let Some(blocked) = replicate(&rid) {
        return blocked;
    }
    ForgeResult::new(true, format!("opened patch {patch_id} on {rid}"))
}

fn git_push(checkout: &Path, title: &str, body: &str) -> procutil::ProcOut {
    let Some(git) = resolve_git() else {
        return procutil::ProcOut {
            code: 127,
            stdout: String::new(),
            stderr: "git is not installed".into(),
        };
    };
    let mut command = vec![
        git,
        "push".into(),
        "rad".into(),
        "-o".into(),
        format!("patch.message={title}"),
    ];
    if !body.trim().is_empty() {
        command.extend(["-o".into(), format!("patch.message={body}")]);
    }
    command.push("HEAD:refs/patches".into());
    let mut env: std::collections::HashMap<String, String> = std::env::vars().collect();
    if let Some(rad_bin) = which("rad") {
        if let Some(parent) = rad_bin.parent() {
            let current = env.get("PATH").cloned().unwrap_or_default();
            env.insert(
                "PATH".into(),
                format!("{}{}{current}", parent.display(), std::path::MAIN_SEPARATOR),
            );
        }
    }
    env.insert("GIT_TERMINAL_PROMPT".into(), "0".into());
    let result = procutil::run(
        &command,
        Some(checkout),
        Some(env),
        Duration::from_secs(120),
    );
    if result.code == 124 {
        procutil::ProcOut {
            code: 124,
            stdout: String::new(),
            stderr: "git push timed out".into(),
        }
    } else {
        result
    }
}

fn tests_ran(stdout: &str) -> Option<i64> {
    Regex::new(r"(?m)^tests_run=([0-9]+)\s*$")
        .unwrap()
        .captures_iter(stdout)
        .last()
        .and_then(|c| c.get(1).unwrap().as_str().parse().ok())
}

fn check_report(stdout: &str) -> String {
    let secret = std::env::var("RAD_PASSPHRASE").unwrap_or_default();
    scrub_secrets(&plain(stdout))
        .lines()
        .filter(|line| {
            !line.contains("PRIVATE KEY")
                && !line.contains("RAD_PASSPHRASE")
                && (secret.is_empty() || !line.contains(&secret))
        })
        .collect::<Vec<_>>()
        .join("\n")
}

pub fn review_patch(home: &Path, raw: &str, raw_id: &str, checkout_path: &str) -> ForgeResult {
    review_patch_using(
        home,
        raw,
        raw_id,
        checkout_path,
        |workspace, command, runtime, image, memory, cpus| {
            sandbox::run(
                workspace,
                command,
                runtime,
                image,
                memory,
                cpus,
                Duration::from_secs(180),
            )
        },
    )
}

pub fn review_patch_using(
    home: &Path,
    raw: &str,
    raw_id: &str,
    checkout_path: &str,
    run: impl FnOnce(&Path, &[String], &str, &str, &str, &str) -> SandboxResult,
) -> ForgeResult {
    let Some(patch_id) = parse_cob_id(raw_id) else {
        return ForgeResult::new(false, "the patch id is unreadable");
    };
    let Some(rid) = parse_rid(raw) else {
        return ForgeResult::new(false, "repository must look like rad:z…");
    };
    if let Some(blocked) = delegated_ready(home, &rid) {
        return blocked;
    }
    let path = match checkout(checkout_path) {
        Ok(path) => path,
        Err(result) => return result,
    };
    let reported = match checkout_rid(&path) {
        Ok(rid) => rid,
        Err(result) => return result,
    };
    if reported != rid {
        return ForgeResult::new(false, "that checkout is not this repository");
    }
    let checked_out = rad_run(
        &[
            "patch".into(),
            "checkout".into(),
            patch_id.clone(),
            "--force".into(),
        ],
        Duration::from_secs(60),
        Some(&path),
    );
    if checked_out.code != 0 {
        return ForgeResult::new(
            false,
            failure("rad did not check out the patch", &checked_out),
        );
    }
    let Ok(config) = load_config(home) else {
        return ForgeResult::new(false, "config is unreadable");
    };
    let sandbox_cfg = config.get("sandbox");
    let runtime_name = sandbox_cfg
        .and_then(|v| v.get("runtime"))
        .and_then(toml::Value::as_str)
        .unwrap_or("auto");
    let Some(runtime) = sandbox::detect_runtime(runtime_name) else {
        return ForgeResult::new(false, "the sandbox did not run the check");
    };
    let image = sandbox_cfg
        .and_then(|v| v.get("image"))
        .and_then(toml::Value::as_str)
        .unwrap_or("python:3.12-slim");
    let memory = sandbox_cfg
        .and_then(|v| v.get("memory"))
        .and_then(toml::Value::as_str)
        .unwrap_or("512m");
    let cpus = sandbox_cfg
        .and_then(|v| v.get("cpus"))
        .and_then(toml::Value::as_str)
        .unwrap_or("1");
    let command = action_command("test", &runtime);
    let outcome = run(&path, &command, &runtime, image, memory, cpus);
    if !outcome.invoked {
        return ForgeResult::new(false, "the sandbox did not run the check");
    }
    let report = check_report(&outcome.stdout);
    let ran = tests_ran(&outcome.stdout);
    if ran.is_none() || ran.unwrap_or(0) < 1 {
        return ForgeResult::with_output(false, "the sandbox check did not run any tests", report);
    }
    let verdict = if outcome.ok { "accept" } else { "reject" };
    let message = if outcome.ok {
        "sandbox check passed"
    } else {
        "sandbox check failed"
    };
    let reviewed = rad_run(
        &[
            "patch".into(),
            "review".into(),
            patch_id.clone(),
            "--repo".into(),
            rid.clone(),
            format!("--{verdict}"),
            "--message".into(),
            message.into(),
            "--no-announce".into(),
        ],
        Duration::from_secs(60),
        Some(&path),
    );
    if reviewed.code != 0 {
        return ForgeResult::new(false, failure("rad did not confirm the review", &reviewed));
    }
    if let Some(blocked) = replicate(&rid) {
        return blocked;
    }
    if verdict == "accept" {
        ForgeResult::with_output(true, format!("accepted patch {patch_id} on {rid}"), report)
    } else {
        ForgeResult::with_output(true, format!("refused patch {patch_id} on {rid}"), report)
    }
}

fn draft(home: &Path, rid: &str, filename: &str) -> Option<(String, String)> {
    let root = home.join("drafts");
    if crate::home::is_symlink(&root) || !root.is_dir() {
        return None;
    }
    let path = root.join(forge::draft_slug(rid)).join(filename);
    if !path.is_file() || crate::home::is_symlink(&path) {
        return None;
    }
    if path.metadata().ok()?.len() > 65_000 {
        return None;
    }
    let text = std::fs::read_to_string(path).ok()?;
    let lines: Vec<&str> = text.lines().collect();
    if lines.is_empty() || lines[0].trim().is_empty() {
        return None;
    }
    let title = lines[0]
        .strip_prefix("# ")
        .unwrap_or(lines[0])
        .trim()
        .to_string();
    if title.is_empty() {
        return None;
    }
    let mut body_lines = &lines[1..];
    if body_lines
        .first()
        .is_some_and(|line| line.trim().is_empty())
    {
        body_lines = &body_lines[1..]
    }
    Some((title, body_lines.join("\n").trim().to_string()))
}

pub fn send_issue_draft(home: &Path, raw: &str) -> ForgeResult {
    let Some(rid) = parse_rid(raw) else {
        return ForgeResult::new(false, "repository must look like rad:z…");
    };
    let Some((title, body)) = draft(home, &rid, "issue-draft.md") else {
        return ForgeResult::new(false, "there is no local issue draft for that repository");
    };
    if body.is_empty() {
        return ForgeResult::new(false, "the draft has no body");
    }
    create_issue(home, &rid, &title, &body)
}

pub fn send_patch_draft(home: &Path, raw: &str, raw_id: &str) -> ForgeResult {
    let Some(rid) = parse_rid(raw) else {
        return ForgeResult::new(false, "repository must look like rad:z…");
    };
    let Some((title, body)) = draft(home, &rid, "pr-draft.md") else {
        return ForgeResult::new(false, "there is no local patch draft for that repository");
    };
    update_patch(home, &rid, raw_id, &title, &body)
}

#[allow(dead_code)]
fn _config_keep() {
    let _ = config::state_path;
}
