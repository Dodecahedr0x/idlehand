//! GitHub through the `gh` login already on this machine.
//!
//! IdleHand does not store a token. `gh` runs on the trusted side.

use std::path::Path;
use std::time::Duration;

use regex::Regex;
use serde_json::Value;

use crate::fetch::scrub_secrets;
use crate::forge::{parse_repo_name, ForgeAccount, ForgeResult, ManageableRepo};
use crate::procutil::{self, which};

const LIST_CAP: usize = 200;
const REPOS_PATH: &str = "user/repos?per_page=100&affiliation=owner,organization_member";
const REPOS_JQ: &str = ".[] | {full_name:.full_name,owner:.owner.login,admin:.permissions.admin}";

fn show(text: &str, limit: usize) -> String {
    let re = Regex::new(r"(?:gho_|github_pat_|ghp_|ghu_|ghs_|ghr_)[A-Za-z0-9_]+").unwrap();
    let scrubbed = scrub_secrets(text);
    let cleaned = re.replace_all(&scrubbed, "github-token-omitted");
    cleaned
        .lines()
        .map(str::trim)
        .find(|line| !line.is_empty())
        .unwrap_or("")
        .chars()
        .take(limit)
        .collect()
}

fn confirmed_url(text: &str) -> String {
    let re_token = Regex::new(r"(?:gho_|github_pat_|ghp_|ghu_|ghs_|ghr_)[A-Za-z0-9_]+").unwrap();
    let scrubbed = scrub_secrets(text);
    let cleaned = re_token.replace_all(&scrubbed, "github-token-omitted");
    let re = Regex::new(
        r"https://github\.com/[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+/(?:issues|pull)/[1-9][0-9]*",
    )
    .unwrap();
    re.find_iter(&cleaned)
        .last()
        .map(|m| m.as_str().to_string())
        .unwrap_or_default()
}

pub struct GitHub;

impl GitHub {
    pub fn account(&self) -> ForgeAccount {
        if which("gh").is_none() {
            return ForgeAccount {
                connected: false,
                detail: "gh is not installed".into(),
                login: String::new(),
            };
        }
        let result = gh_run(
            &["api".into(), "user".into(), "--jq".into(), ".login".into()],
            None,
        );
        if result.code != 0 {
            return ForgeAccount {
                connected: false,
                detail: "gh is not logged in".into(),
                login: String::new(),
            };
        }
        let login = result.stdout.trim();
        let re = Regex::new(r"^[A-Za-z0-9](?:[A-Za-z0-9-]{0,37}[A-Za-z0-9])?$").unwrap();
        if login.contains('\n') || !re.is_match(login) {
            return ForgeAccount {
                connected: false,
                detail: "gh is not logged in".into(),
                login: String::new(),
            };
        }
        ForgeAccount {
            connected: true,
            detail: format!("gh is logged in as {login}"),
            login: login.to_string(),
        }
    }

    pub fn manageable_repos(&self, login: &str) -> (Option<Vec<ManageableRepo>>, String) {
        let result = gh_run(
            &[
                "api".into(),
                "--paginate".into(),
                REPOS_PATH.into(),
                "--jq".into(),
                REPOS_JQ.into(),
            ],
            None,
        );
        if result.code != 0 || result.stdout.len() > 1_000_000 {
            return (None, "gh could not list repositories".into());
        }
        let Some(records) = records(&result.stdout) else {
            return (None, "gh could not list repositories".into());
        };
        let note = if records.len() > LIST_CAP {
            "stopped after 200 repositories".to_string()
        } else {
            String::new()
        };
        let mut repos = Vec::new();
        let mut seen = std::collections::BTreeSet::new();
        for item in records.into_iter().take(LIST_CAP) {
            let Some(full) = item.get("full_name").and_then(Value::as_str) else {
                continue;
            };
            let Some(owner) = item.get("owner").and_then(Value::as_str) else {
                continue;
            };
            let Some(full) = parse_repo_name(full) else {
                continue;
            };
            if !seen.insert(full.to_ascii_lowercase()) {
                continue;
            }
            let role = if owner.eq_ignore_ascii_case(login) {
                "owner"
            } else if item.get("admin").and_then(Value::as_bool) == Some(true) {
                "admin"
            } else {
                continue;
            };
            repos.push(ManageableRepo {
                name: full,
                role: role.into(),
            });
        }
        (Some(repos), note)
    }

    pub fn create_issue(&self, repo: &str, title: &str, body: &str) -> ForgeResult {
        let result = gh_run(
            &[
                "issue".into(),
                "create".into(),
                "--repo".into(),
                repo.into(),
                "--title".into(),
                title.into(),
            ],
            Some(body),
        );
        let url = confirmed_url(&result.stdout);
        if result.code != 0 || url.is_empty() {
            return ForgeResult::new(
                false,
                failure(
                    "gh did not confirm that the issue was created",
                    &result.stderr,
                    &result.stdout,
                ),
            );
        }
        ForgeResult::new(true, format!("created issue on {repo}: {url}"))
    }

    pub fn update_issue(&self, repo: &str, number: i64, title: &str, body: &str) -> ForgeResult {
        let mut args = vec![
            "issue".into(),
            "edit".into(),
            number.to_string(),
            "--repo".into(),
            repo.into(),
        ];
        if !title.is_empty() {
            args.extend(["--title".into(), title.into()]);
        }
        let result = gh_run(&args, if body.is_empty() { None } else { Some(body) });
        if result.code != 0 {
            return ForgeResult::new(
                false,
                failure(
                    "gh did not confirm that the issue was updated",
                    &result.stderr,
                    &result.stdout,
                ),
            );
        }
        let url = confirmed_url(&result.stdout);
        let suffix = if url.is_empty() {
            String::new()
        } else {
            format!(": {url}")
        };
        ForgeResult::new(true, format!("updated issue {number} on {repo}{suffix}"))
    }

    pub fn create_pull_request(
        &self,
        repo: &str,
        title: &str,
        body: &str,
        head: &str,
        base: &str,
    ) -> ForgeResult {
        let mut args = vec![
            "pr".into(),
            "create".into(),
            "--repo".into(),
            repo.into(),
            "--title".into(),
            title.into(),
            "--head".into(),
            head.into(),
        ];
        if !base.is_empty() {
            args.extend(["--base".into(), base.into()]);
        }
        let result = gh_run(&args, Some(body));
        let url = confirmed_url(&result.stdout);
        if result.code != 0 || url.is_empty() {
            return ForgeResult::new(
                false,
                failure(
                    "gh did not confirm that the pull request was created",
                    &result.stderr,
                    &result.stdout,
                ),
            );
        }
        ForgeResult::new(true, format!("created pull request on {repo}: {url}"))
    }

    pub fn update_pull_request(
        &self,
        repo: &str,
        number: i64,
        title: &str,
        body: &str,
    ) -> ForgeResult {
        let mut args = vec![
            "pr".into(),
            "edit".into(),
            number.to_string(),
            "--repo".into(),
            repo.into(),
        ];
        if !title.is_empty() {
            args.extend(["--title".into(), title.into()]);
        }
        let result = gh_run(&args, if body.is_empty() { None } else { Some(body) });
        if result.code != 0 {
            return ForgeResult::new(
                false,
                failure(
                    "gh did not confirm that the pull request was updated",
                    &result.stderr,
                    &result.stdout,
                ),
            );
        }
        let url = confirmed_url(&result.stdout);
        let suffix = if url.is_empty() {
            String::new()
        } else {
            format!(": {url}")
        };
        ForgeResult::new(
            true,
            format!("updated pull request {number} on {repo}{suffix}"),
        )
    }
}

fn failure(fallback: &str, stderr: &str, stdout: &str) -> String {
    let detail = show(if stderr.is_empty() { stdout } else { stderr }, 300);
    if detail.is_empty() || detail == "github-token-omitted" {
        fallback.to_string()
    } else {
        format!("{fallback}: {detail}")
    }
}

fn records(text: &str) -> Option<Vec<Value>> {
    let raw = text.trim();
    if raw.is_empty() {
        return Some(Vec::new());
    }
    if let Ok(parsed) = serde_json::from_str::<Value>(raw) {
        if let Some(items) = parsed.as_array() {
            return Some(
                items
                    .iter()
                    .filter(|item| item.is_object())
                    .cloned()
                    .collect(),
            );
        }
        if parsed.is_object() {
            return Some(vec![parsed]);
        }
    }
    let mut records = Vec::new();
    for line in raw.lines() {
        let piece = line.trim();
        if piece.is_empty() {
            continue;
        }
        let item: Value = serde_json::from_str(piece).ok()?;
        if item.is_object() {
            records.push(item);
        } else if let Some(list) = item.as_array() {
            if !list.iter().all(Value::is_object) {
                return None;
            }
            records.extend(list.iter().cloned());
        } else {
            return None;
        }
    }
    Some(records)
}

fn gh_run(args: &[String], body: Option<&str>) -> procutil::ProcOut {
    let Some(binary) = which("gh") else {
        return procutil::ProcOut {
            code: 127,
            stdout: String::new(),
            stderr: "gh is not installed".into(),
        };
    };
    let dir = std::env::temp_dir().join(format!(
        "idlehand-gh-{}-{}",
        std::process::id(),
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_nanos())
            .unwrap_or(0)
    ));
    let _ = std::fs::create_dir_all(&dir);
    let mut command = vec![binary.display().to_string()];
    command.extend(args.iter().cloned());
    if let Some(body) = body {
        let path = dir.join("body.md");
        if std::fs::write(&path, body).is_err() {
            let _ = std::fs::remove_dir_all(&dir);
            return procutil::ProcOut {
                code: 1,
                stdout: String::new(),
                stderr: "could not write the body file".into(),
            };
        }
        command.push("--body-file".into());
        command.push(path.display().to_string());
    }
    let result = procutil::run_inherited(&command, Some(&dir), Duration::from_secs(30));
    let _ = std::fs::remove_dir_all(&dir);
    if result.code == 124 {
        return procutil::ProcOut {
            code: 124,
            stdout: String::new(),
            stderr: "gh timed out".into(),
        };
    }
    result
}

#[allow(dead_code)]
fn _path_keep(path: &Path) {
    let _ = path;
}
