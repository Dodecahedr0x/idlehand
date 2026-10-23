//! Clone a repository into a workspace without the user's credentials.

use std::fs;
use std::path::{Path, PathBuf};
use std::process::Command;
use std::time::Duration;

use regex::Regex;

use crate::procutil::{self, ProcOut};

#[derive(Debug, Clone)]
pub struct FetchResult {
    pub cloned: bool,
    pub reason: String,
}

const CREDENTIAL_KEYS: &[&str] = &["token", "password", "access_token", "auth"];

pub fn percent_decode(text: &str) -> String {
    let mut current = text.to_string();
    for _ in 0..text.len().max(1) {
        let decoded = unquote(&current);
        if decoded == current {
            break;
        }
        current = decoded;
    }
    current
}

fn unquote(text: &str) -> String {
    let bytes = text.as_bytes();
    let mut out = Vec::new();
    let mut index = 0;
    while index < bytes.len() {
        if bytes[index] == b'%'
            && index + 2 < bytes.len()
            && bytes[index + 1].is_ascii_hexdigit()
            && bytes[index + 2].is_ascii_hexdigit()
        {
            let hex = std::str::from_utf8(&bytes[index + 1..index + 3]).unwrap_or("");
            if let Ok(value) = u8::from_str_radix(hex, 16) {
                out.push(value);
                index += 3;
                continue;
            }
        }
        out.push(bytes[index]);
        index += 1;
    }
    String::from_utf8_lossy(&out).into_owned()
}

pub fn contains_control_break(text: &str) -> bool {
    for form in [text, percent_decode(text).as_str()] {
        if form.chars().any(|c| c == '\r' || c == '\n' || c == '\0') {
            return true;
        }
    }
    false
}

#[derive(Debug, Clone)]
struct SplitUrl {
    scheme: String,
    path: String,
    query: String,
    fragment: String,
    username: String,
    password: String,
    hostname: String,
    port: Option<u16>,
}

fn split_url(raw: &str) -> SplitUrl {
    let (left, fragment) = match raw.split_once('#') {
        Some((left, fragment)) => (left, fragment.to_string()),
        None => (raw, String::new()),
    };
    let (left, query) = match left.split_once('?') {
        Some((left, query)) => (left, query.to_string()),
        None => (left, String::new()),
    };
    let (scheme, rest) = split_scheme(left);
    let (netloc, path) = if let Some(rest) = rest.strip_prefix("//") {
        match rest.find(['/', '?', '#']) {
            Some(index) => (rest[..index].to_string(), rest[index..].to_string()),
            None => (rest.to_string(), String::new()),
        }
    } else {
        (String::new(), rest)
    };
    let (username, password, hostport) = split_userinfo(&netloc);
    let (hostname, port) = split_host(&hostport);
    SplitUrl {
        scheme,
        path,
        query,
        fragment,
        username,
        password,
        hostname,
        port,
    }
}

fn split_scheme(text: &str) -> (String, String) {
    if let Some(index) = text.find(':') {
        let scheme = &text[..index];
        if !scheme.is_empty()
            && scheme.chars().next().unwrap().is_ascii_alphabetic()
            && scheme
                .chars()
                .all(|c| c.is_ascii_alphanumeric() || matches!(c, '+' | '.' | '-'))
        {
            return (scheme.to_string(), text[index + 1..].to_string());
        }
    }
    (String::new(), text.to_string())
}

fn split_userinfo(netloc: &str) -> (String, String, String) {
    let Some(index) = netloc.rfind('@') else {
        return (String::new(), String::new(), netloc.to_string());
    };
    let userinfo = &netloc[..index];
    let host = &netloc[index + 1..];
    match userinfo.split_once(':') {
        Some((user, password)) => (user.to_string(), password.to_string(), host.to_string()),
        None => (userinfo.to_string(), String::new(), host.to_string()),
    }
}

fn split_host(hostport: &str) -> (String, Option<u16>) {
    if hostport.is_empty() {
        return (String::new(), None);
    }
    if let Some(rest) = hostport.strip_prefix('[') {
        if let Some(end) = rest.find(']') {
            let host = rest[..end].to_ascii_lowercase();
            let after = &rest[end + 1..];
            if let Some(port) = after.strip_prefix(':') {
                return (host, port.parse().ok());
            }
            return (host, None);
        }
    }
    if let Some((host, port)) = hostport.rsplit_once(':') {
        if !host.is_empty() && port.chars().all(|c| c.is_ascii_digit()) {
            return (host.to_ascii_lowercase(), port.parse().ok());
        }
    }
    (hostport.to_ascii_lowercase(), None)
}

fn parse_qsl(text: &str) -> Vec<(String, String)> {
    if text.is_empty() {
        return Vec::new();
    }
    text.split(['&', ';'])
        .map(|pair| match pair.split_once('=') {
            Some((key, value)) => (key.to_string(), value.to_string()),
            None => (pair.to_string(), String::new()),
        })
        .collect()
}

fn has_credential_key(text: &str) -> bool {
    parse_qsl(text)
        .into_iter()
        .any(|(key, _)| CREDENTIAL_KEYS.contains(&key.to_ascii_lowercase().as_str()))
}

fn without_credential_keys(text: &str) -> String {
    let kept: Vec<(String, String)> = parse_qsl(text)
        .into_iter()
        .filter(|(key, _)| !CREDENTIAL_KEYS.contains(&key.to_ascii_lowercase().as_str()))
        .collect();
    kept.into_iter()
        .map(|(k, v)| {
            if v.is_empty() && !text.contains('=') {
                k
            } else {
                format!("{k}={v}")
            }
        })
        .collect::<Vec<_>>()
        .join("&")
}

fn assigned_credential() -> Regex {
    Regex::new(r"(?i)(?:token|password|access_token|auth)=[^/\s?#&]*").unwrap()
}

pub fn embeds_credentials(url: &str) -> bool {
    for form in [url.trim().to_string(), percent_decode(url.trim())] {
        let parsed = split_url(&form);
        if !parsed.username.is_empty() || !parsed.password.is_empty() {
            return true;
        }
        if has_credential_key(&parsed.query) || has_credential_key(&parsed.fragment) {
            return true;
        }
        if assigned_credential().is_match(&form) {
            return true;
        }
    }
    false
}

pub fn redact_clone_url(url: &str) -> String {
    let mut parsed = split_url(url.trim());
    let mut host = parsed.hostname.clone();
    if host.contains(':') {
        host = format!("[{host}]");
    }
    if let Some(port) = parsed.port {
        host = format!("{host}:{port}");
    }
    if !parsed.username.is_empty() || !parsed.password.is_empty() {
        parsed.username.clear();
        parsed.password.clear();
    }
    if has_credential_key(&parsed.query) {
        parsed.query = without_credential_keys(&parsed.query);
    }
    if has_credential_key(&parsed.fragment) {
        parsed.fragment = without_credential_keys(&parsed.fragment);
    }
    let mut out = String::new();
    if !parsed.scheme.is_empty() {
        out.push_str(&parsed.scheme);
        out.push(':');
    }
    if !host.is_empty()
        || parsed.scheme == "file"
        || parsed.scheme == "https"
        || parsed.scheme == "http"
    {
        if parsed.scheme == "file"
            || parsed.scheme == "https"
            || parsed.scheme == "http"
            || parsed.scheme == "ssh"
        {
            out.push_str("//");
        }
        out.push_str(&host);
    }
    out.push_str(&parsed.path);
    if !parsed.query.is_empty() {
        out.push('?');
        out.push_str(&parsed.query);
    }
    if !parsed.fragment.is_empty() {
        out.push('#');
        out.push_str(&parsed.fragment);
    }
    out
}

fn scrub_line(line: &str) -> String {
    let decoded = percent_decode(line);
    let redacted = redact_clone_url(&decoded);
    let userinfo = Regex::new(r"://[^/\s:@]+:[^/\s@]+@").unwrap();
    let nested = Regex::new(r"(?i)[?&#](?:token|password|access_token|auth)=[^&\s#]*").unwrap();
    let mut cleaned = userinfo.replace_all(&redacted, "://").into_owned();
    cleaned = nested.replace_all(&cleaned, "").into_owned();
    cleaned = assigned_credential().replace_all(&cleaned, "").into_owned();
    let collapse = Regex::new(r"\?&+").unwrap();
    cleaned = collapse.replace_all(&cleaned, "?").into_owned();
    let trail = Regex::new(r"[?&]+$").unwrap();
    trail.replace_all(&cleaned, "").into_owned()
}

pub fn scrub_secrets(text: &str) -> String {
    text.lines().map(scrub_line).collect::<Vec<_>>().join("\n")
}

pub fn public_url(url: &str) -> String {
    if contains_control_break(url) {
        return String::new();
    }
    let text = scrub_secrets(url)
        .replace(['\n', '\r'], " ")
        .trim()
        .to_string();
    if text.is_empty()
        || text.contains("PRIVATE KEY")
        || text.len() > 500
        || contains_control_break(&text)
    {
        return String::new();
    }
    text
}

pub fn classify_clone_url(url: &str) -> (Option<String>, String) {
    let raw = url.trim();
    if raw.is_empty() || contains_control_break(raw) {
        return (None, "repository URL is empty".into());
    }
    if raw.starts_with("git@") || raw.starts_with("ssh://") {
        return (None, "public clones do not use SSH keys".into());
    }
    let parsed = split_url(raw);
    if embeds_credentials(raw) {
        return (None, "repository URL embeds credentials".into());
    }
    let scheme = parsed.scheme.to_ascii_lowercase();
    if scheme == "ssh" || scheme == "git" {
        return (None, "public clones do not use SSH keys".into());
    }
    if scheme == "https" || scheme == "http" {
        let parts: Vec<&str> = parsed
            .path
            .split('/')
            .filter(|part| !part.is_empty())
            .collect();
        if parsed.hostname.is_empty() || parts.len() < 2 {
            return (None, "repository URL is not a git repository URL".into());
        }
        return (Some(raw.to_string()), "public clone".into());
    }
    if scheme == "file" || (scheme.is_empty() && raw.starts_with('/')) {
        return (
            Some(raw.to_string()),
            "local repository from the source list".into(),
        );
    }
    (None, "repository URL is not a public git URL".into())
}

pub fn resolve_git() -> Option<String> {
    let system = PathBuf::from("/usr/bin/git");
    if system.is_file() && procutil::is_executable(&system) {
        return Some(system.display().to_string());
    }
    procutil::which("git").map(|path| path.display().to_string())
}

pub fn git_env(empty_home: &Path) -> std::collections::HashMap<String, String> {
    let home = empty_home.display().to_string();
    [
        (
            "PATH",
            "/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin",
        ),
        ("HOME", home.as_str()),
        ("TMPDIR", "/tmp"),
        ("GIT_CONFIG_GLOBAL", "/dev/null"),
        ("GIT_CONFIG_NOSYSTEM", "1"),
        ("GIT_TERMINAL_PROMPT", "0"),
        ("GIT_ASKPASS", "true"),
        ("SSH_AUTH_SOCK", ""),
        ("GIT_SSH_COMMAND", "false"),
        ("LANG", "C"),
    ]
    .into_iter()
    .map(|(k, v)| (k.to_string(), v.to_string()))
    .collect()
}

fn clear_workspace(workspace: &Path) -> Result<(), String> {
    if crate::home::is_symlink(workspace) || workspace.parent().is_some_and(crate::home::is_symlink)
    {
        return Err("refusing to follow a workspace symlink".into());
    }
    let Some(parent) = workspace.parent() else {
        return Err("refusing to replace a workspace outside its parent".into());
    };
    let root = parent
        .canonicalize()
        .unwrap_or_else(|_| parent.to_path_buf());
    if workspace.exists() {
        let resolved = workspace
            .canonicalize()
            .unwrap_or_else(|_| workspace.to_path_buf());
        if !resolved.starts_with(&root) {
            return Err("refusing to replace a workspace outside its parent".into());
        }
        fs::remove_dir_all(&resolved).map_err(|e| e.to_string())?;
    }
    Ok(())
}

fn remove_failed(workspace: &Path) {
    if crate::home::is_symlink(workspace) {
        return;
    }
    if let Some(parent) = workspace.parent() {
        let root = parent
            .canonicalize()
            .unwrap_or_else(|_| parent.to_path_buf());
        if workspace.exists() {
            if let Ok(resolved) = workspace.canonicalize() {
                if resolved.starts_with(&root) {
                    let _ = fs::remove_dir_all(resolved);
                }
            }
        }
    }
}

pub fn clone_repository(
    url: &str,
    workspace: &Path,
    git_executable: Option<&str>,
    timeout: Duration,
) -> FetchResult {
    let (allowed, reason) = classify_clone_url(url);
    let Some(allowed) = allowed else {
        return FetchResult {
            cloned: false,
            reason,
        };
    };
    let Some(git) = git_executable.map(|s| s.to_string()).or_else(resolve_git) else {
        return FetchResult {
            cloned: false,
            reason: "git is not installed".into(),
        };
    };
    if let Err(blocked) = clear_workspace(workspace) {
        return FetchResult {
            cloned: false,
            reason: blocked,
        };
    }
    if let Some(parent) = workspace.parent() {
        let _ = fs::create_dir_all(parent);
    }
    let scheme = split_url(&allowed).scheme.to_ascii_lowercase();
    let mut command = vec![
        git,
        "-c".into(),
        "credential.helper=".into(),
        "-c".into(),
        "core.askPass=".into(),
    ];
    if scheme == "file" || scheme.is_empty() {
        command.extend(["-c".into(), "protocol.file.allow=always".into()]);
    }
    command.extend([
        "clone".into(),
        "--depth".into(),
        "1".into(),
        "--no-tags".into(),
        "--".into(),
        allowed,
        workspace.display().to_string(),
    ]);
    let empty_home = std::env::temp_dir().join(format!("idlehand-fetch-{}", std::process::id()));
    let _ = fs::create_dir_all(&empty_home);
    let unique = empty_home.join(format!(
        "{}",
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_nanos())
            .unwrap_or(0)
    ));
    let _ = fs::create_dir_all(&unique);
    let completed = run_git(&command, &unique, timeout);
    let _ = fs::remove_dir_all(&unique);
    match completed {
        GitRun::Timeout => {
            remove_failed(workspace);
            FetchResult {
                cloned: false,
                reason: "clone timed out".into(),
            }
        }
        GitRun::Error(err) => {
            remove_failed(workspace);
            FetchResult {
                cloned: false,
                reason: format!("could not run git: {err}"),
            }
        }
        GitRun::Done(proc) => {
            if proc.code != 0 || !workspace.join(".git").exists() {
                let detail = if !proc.stderr.trim().is_empty() {
                    proc.stderr
                } else {
                    proc.stdout
                };
                let summary = detail.trim().lines().last().unwrap_or("git clone failed");
                let summary = scrub_secrets(summary).chars().take(200).collect::<String>();
                let summary = if summary.is_empty() {
                    "git clone failed".into()
                } else {
                    summary
                };
                remove_failed(workspace);
                FetchResult {
                    cloned: false,
                    reason: summary,
                }
            } else {
                FetchResult {
                    cloned: true,
                    reason,
                }
            }
        }
    }
}

enum GitRun {
    Done(ProcOut),
    Timeout,
    Error(String),
}

fn run_git(command: &[String], cwd: &Path, timeout: Duration) -> GitRun {
    let env = git_env(cwd);
    let proc = procutil::run(command, Some(cwd), Some(env), timeout);
    if proc.code == 124 && proc.stderr == "timed out" {
        return GitRun::Timeout;
    }
    if proc.code == 127 && proc.stderr.contains("is not installed") {
        return GitRun::Error(proc.stderr);
    }
    GitRun::Done(proc)
}

#[allow(dead_code)]
fn _keep_command() {
    let _ = Command::new("true");
}
