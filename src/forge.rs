//! Optional GitHub interop and the shared delegation file.
//!
//! Radicle is the primary path and delegates by RID. GitHub rows are owner/name.
//! No token and no Radicle key is written here.

use std::path::Path;

use regex::Regex;

use crate::config::load_sources;
use crate::fetch::{contains_control_break, embeds_credentials};
use crate::github::GitHub;
use crate::home::{self, atomic_write, dump_toml, read_toml, HomeLock};

const DELEGATED_HEADER: &str = "\
# Repos this node may manage. IdleHand adds one only when you delegate it.
# A Radicle row is a RID. A GitHub row is owner/name.
# rad keys and gh credentials are not written here.
";

const PRIVATE_KEY: &[&str] = &[
    "BEGIN PRIVATE KEY",
    "BEGIN RSA PRIVATE KEY",
    "BEGIN OPENSSH PRIVATE KEY",
    "BEGIN EC PRIVATE KEY",
    "BEGIN DSA PRIVATE KEY",
];

#[derive(Debug, Clone)]
pub struct ForgeAccount {
    pub connected: bool,
    pub detail: String,
    pub login: String,
}

#[derive(Debug, Clone)]
pub struct ManageableRepo {
    pub name: String,
    pub role: String,
}

#[derive(Debug, Clone)]
pub struct ForgeResult {
    pub ok: bool,
    pub detail: String,
    pub output: String,
}

impl ForgeResult {
    pub fn new(ok: bool, detail: impl Into<String>) -> Self {
        Self { ok, detail: detail.into(), output: String::new() }
    }
    pub fn with_output(ok: bool, detail: impl Into<String>, output: impl Into<String>) -> Self {
        Self { ok, detail: detail.into(), output: output.into() }
    }
}

pub fn registered_forges() -> &'static [&'static str] {
    &["github"]
}

pub fn provider_label(name: &str) -> String {
    let re = Regex::new(r"^[a-z][a-z0-9-]{0,20}$").unwrap();
    if re.is_match(name) { name.to_string() } else { String::new() }
}

pub fn parse_rid(value: &str) -> Option<String> {
    let text = value.trim();
    if text.is_empty() || contains_control_break(text) || embeds_credentials(text) {
        return None;
    }
    let re = Regex::new(r"^rad:z[1-9A-HJ-NP-Za-km-z]{20,40}$").unwrap();
    re.is_match(text).then(|| text.to_string())
}

pub fn canonical_repo(provider: &str, repo: &str) -> Option<String> {
    match provider {
        "github" => parse_repo_name(repo),
        "radicle" => parse_rid(repo),
        _ => None,
    }
}

pub fn parse_repo_name(value: &str) -> Option<String> {
    let mut text = value.trim().to_string();
    if text.is_empty() || contains_control_break(&text) || embeds_credentials(&text) {
        return None;
    }
    if text.contains("://") || text.starts_with("git@") {
        if text.starts_with("git@") {
            return None;
        }
        let (scheme, rest) = text.split_once("://")?;
        if scheme != "https" && scheme != "http" {
            return None;
        }
        let rest = rest.split(['?', '#']).next().unwrap_or(rest);
        let (host, path) = match rest.find('/') {
            Some(index) => (&rest[..index], &rest[index..]),
            None => (rest, ""),
        };
        let host = host.rsplit('@').next().unwrap_or(host).split(':').next().unwrap_or(host);
        if !host.eq_ignore_ascii_case("github.com") {
            return None;
        }
        let parts: Vec<&str> = path.split('/').filter(|part| !part.is_empty()).collect();
        if parts.len() < 2 {
            return None;
        }
        let name = parts[1].strip_suffix(".git").unwrap_or(parts[1]);
        text = format!("{}/{}", parts[0], name);
    }
    if text.matches('/').count() != 1 {
        return None;
    }
    let (owner, name) = text.split_once('/')?;
    let part = Regex::new(r"^[A-Za-z0-9_][A-Za-z0-9_.-]{0,99}$").unwrap();
    if !part.is_match(owner) || !part.is_match(name) || owner.contains("..") || name.contains("..") {
        return None;
    }
    Some(format!("{owner}/{name}"))
}

pub fn parse_number(value: &str) -> Option<i64> {
    let re = Regex::new(r"^[1-9][0-9]{0,9}$").unwrap();
    if !re.is_match(value) { None } else { value.parse().ok() }
}

pub fn parse_ref(value: &str) -> Option<String> {
    let text = value.trim();
    if text.is_empty() || contains_control_break(text) || text.contains("..") || text.starts_with('-') {
        return None;
    }
    let re = Regex::new(r"^[A-Za-z0-9_][A-Za-z0-9_.-]{0,99}(?::[A-Za-z0-9_][A-Za-z0-9_./-]{0,150})?$").unwrap();
    re.is_match(text).then(|| text.to_string())
}

pub fn delegated_path(home: &Path) -> std::path::PathBuf {
    home.join("delegated.toml")
}

pub fn load_delegated(home: &Path) -> Option<Vec<(String, String)>> {
    let path = delegated_path(home);
    if home::is_symlink(&path) {
        return None;
    }
    if !path.exists() {
        return Some(Vec::new());
    }
    let data = read_toml(&path).ok()?;
    let rows = match data.get("repos") {
        None => return Some(Vec::new()),
        Some(toml::Value::Array(rows)) => rows,
        Some(_) => return None,
    };
    let mut cleaned = Vec::new();
    for row in rows {
        let table = row.as_table()?;
        let provider = table.get("provider")?.as_str()?;
        let repo = table.get("repo")?.as_str()?;
        let name = canonical_repo(provider, repo)?;
        cleaned.push((provider.to_string(), name));
    }
    Some(cleaned)
}

pub fn save_delegated(home: &Path, rows: &[(String, String)]) -> bool {
    let path = delegated_path(home);
    if home::is_symlink(&path) {
        return false;
    }
    let mut items = Vec::new();
    for (provider, repo) in rows {
        let mut row = toml::map::Map::new();
        row.insert("provider".into(), toml::Value::String(provider.clone()));
        row.insert("repo".into(), toml::Value::String(repo.clone()));
        items.push(toml::Value::Table(row));
    }
    let mut root = toml::map::Map::new();
    root.insert("repos".into(), toml::Value::Array(items));
    let Ok(text) = dump_toml(&toml::Value::Table(root), DELEGATED_HEADER) else {
        return false;
    };
    let Ok(_lock) = HomeLock::acquire(home) else { return false };
    if home::is_symlink(&path) {
        return false;
    }
    atomic_write(&path, &text).is_ok()
}

fn known<'a>(rows: &'a [(String, String)], provider: &str, repo: &str) -> Option<&'a str> {
    for (item_provider, name) in rows {
        if item_provider != provider {
            continue;
        }
        if provider == "github" && name.eq_ignore_ascii_case(repo) {
            return Some(name);
        }
        if provider != "github" && name == repo {
            return Some(name);
        }
    }
    None
}

pub fn delegation_status(provider: &str) -> ForgeAccount {
    if provider != "github" {
        let label = provider_label(provider);
        let suffix = if label.is_empty() { String::new() } else { format!(" named {label}") };
        return ForgeAccount { connected: false, detail: format!("IdleHand has no forge provider{suffix}"), login: String::new() };
    }
    GitHub.account()
}

pub fn list_manageable(provider: &str) -> (Option<Vec<ManageableRepo>>, String) {
    if provider != "github" {
        let account = delegation_status(provider);
        return (None, account.detail);
    }
    let account = GitHub.account();
    if !account.connected {
        return (None, account.detail);
    }
    GitHub.manageable_repos(&account.login)
}

pub fn delegate_repo(home: &Path, provider: &str, raw_repo: &str) -> ForgeResult {
    if provider != "github" {
        return ForgeResult::new(false, delegation_status(provider).detail);
    }
    let Some(repo) = parse_repo_name(raw_repo) else {
        return ForgeResult::new(false, "repository must look like owner/name");
    };
    let Some(mut rows) = load_delegated(home) else {
        return ForgeResult::new(false, "the delegation list is unreadable");
    };
    if let Some(existing) = known(&rows, provider, &repo) {
        return ForgeResult::new(true, format!("{existing} is already delegated"));
    }
    let account = GitHub.account();
    if !account.connected {
        return ForgeResult::new(false, account.detail);
    }
    let (found, detail) = GitHub.manageable_repos(&account.login);
    let Some(found) = found else { return ForgeResult::new(false, detail) };
    let Some(matched) = found.into_iter().find(|item| item.name.eq_ignore_ascii_case(&repo)) else {
        return ForgeResult::new(false, "that repository is not owned or administered by the gh login");
    };
    rows.push((provider.to_string(), matched.name.clone()));
    if !save_delegated(home, &rows) {
        return ForgeResult::new(false, "the delegation list is unreadable");
    }
    ForgeResult::new(true, format!("delegated {}", matched.name))
}

pub fn revoke_repo(home: &Path, provider: &str, raw_repo: &str) -> ForgeResult {
    if provider != "github" {
        return ForgeResult::new(false, delegation_status(provider).detail);
    }
    let Some(repo) = parse_repo_name(raw_repo) else {
        return ForgeResult::new(false, "repository must look like owner/name");
    };
    let Some(rows) = load_delegated(home) else {
        return ForgeResult::new(false, "the delegation list is unreadable");
    };
    let Some(existing) = known(&rows, provider, &repo).map(str::to_string) else {
        return ForgeResult::new(false, "that repository is not delegated");
    };
    let kept: Vec<_> = rows.into_iter().filter(|(item, name)| !(item == provider && name == &existing)).collect();
    if !save_delegated(home, &kept) {
        return ForgeResult::new(false, "the delegation list is unreadable");
    }
    ForgeResult::new(true, format!("revoked {existing}"))
}

fn delegated_name(home: &Path, provider: &str, raw_repo: &str) -> Result<String, ForgeResult> {
    if provider != "github" {
        return Err(ForgeResult::new(false, delegation_status(provider).detail));
    }
    let Some(repo) = parse_repo_name(raw_repo) else {
        return Err(ForgeResult::new(false, "repository must look like owner/name"));
    };
    let Some(rows) = load_delegated(home) else {
        return Err(ForgeResult::new(false, "the delegation list is unreadable"));
    };
    let Some(existing) = known(&rows, provider, &repo).map(str::to_string) else {
        return Err(ForgeResult::new(false, "that repository is not delegated"));
    };
    let account = GitHub.account();
    if !account.connected {
        return Err(ForgeResult::new(false, account.detail));
    }
    let (found, detail) = GitHub.manageable_repos(&account.login);
    let Some(found) = found else { return Err(ForgeResult::new(false, detail)) };
    found.into_iter().find(|item| item.name.eq_ignore_ascii_case(&existing)).map(|item| item.name).ok_or_else(|| ForgeResult::new(false, "that repository is not owned or administered by the gh login"))
}

pub fn checked_text(title: &str, body: &str, require_title: bool, require_body: bool) -> Option<ForgeResult> {
    if PRIVATE_KEY.iter().any(|marker| title.contains(marker) || body.contains(marker)) {
        return Some(ForgeResult::new(false, "the draft contains private key material"));
    }
    if title.contains('\0') || body.contains('\0') || title.contains('\r') || body.contains('\r') || title.contains('\n') {
        return Some(ForgeResult::new(false, "the title or body is unreadable"));
    }
    if require_title && title.trim().is_empty() {
        return Some(ForgeResult::new(false, "the title is empty"));
    }
    if title.len() > 256 {
        return Some(ForgeResult::new(false, "the title is too long"));
    }
    if require_body && body.trim().is_empty() {
        return Some(ForgeResult::new(false, "the body is empty"));
    }
    if body.as_bytes().len() > 65_000 {
        return Some(ForgeResult::new(false, "the body is too long"));
    }
    None
}

pub fn create_issue(home: &Path, provider: &str, raw_repo: &str, title: &str, body: &str) -> ForgeResult {
    if let Some(refused) = checked_text(title, body, true, true) {
        return refused;
    }
    let repo = match delegated_name(home, provider, raw_repo) {
        Ok(repo) => repo,
        Err(result) => return result,
    };
    GitHub.create_issue(&repo, title.trim(), body)
}

pub fn update_issue(home: &Path, provider: &str, raw_repo: &str, number: i64, title: &str, body: &str) -> ForgeResult {
    if number < 1 {
        return ForgeResult::new(false, "the issue number is unreadable");
    }
    if title.trim().is_empty() && body.trim().is_empty() {
        return ForgeResult::new(false, "nothing to update");
    }
    if let Some(refused) = checked_text(title, body, false, false) {
        return refused;
    }
    let repo = match delegated_name(home, provider, raw_repo) {
        Ok(repo) => repo,
        Err(result) => return result,
    };
    GitHub.update_issue(&repo, number, title.trim(), body)
}

pub fn create_pull_request(home: &Path, provider: &str, raw_repo: &str, title: &str, body: &str, head: &str, base: &str) -> ForgeResult {
    let Some(checked_head) = parse_ref(head) else {
        return ForgeResult::new(false, "the branch name is unreadable");
    };
    let checked_base = if base.is_empty() {
        String::new()
    } else {
        match parse_ref(base) {
            Some(value) => value,
            None => return ForgeResult::new(false, "the branch name is unreadable"),
        }
    };
    if let Some(refused) = checked_text(title, body, true, true) {
        return refused;
    }
    let repo = match delegated_name(home, provider, raw_repo) {
        Ok(repo) => repo,
        Err(result) => return result,
    };
    GitHub.create_pull_request(&repo, title.trim(), body, &checked_head, &checked_base)
}

pub fn update_pull_request(home: &Path, provider: &str, raw_repo: &str, number: i64, title: &str, body: &str) -> ForgeResult {
    if number < 1 {
        return ForgeResult::new(false, "the pull request number is unreadable");
    }
    if title.trim().is_empty() && body.trim().is_empty() {
        return ForgeResult::new(false, "nothing to update");
    }
    if let Some(refused) = checked_text(title, body, false, false) {
        return refused;
    }
    let repo = match delegated_name(home, provider, raw_repo) {
        Ok(repo) => repo,
        Err(result) => return result,
    };
    GitHub.update_pull_request(&repo, number, title.trim(), body)
}

fn draft_urls(home: &Path, repo: &str) -> Vec<String> {
    let Some((owner, name)) = repo.split_once('/') else { return Vec::new() };
    let mut urls = vec![
        format!("https://github.com/{owner}/{name}"),
        format!("https://github.com/{owner}/{name}.git"),
        format!("https://github.com/{owner}/{name}/"),
        format!("http://github.com/{owner}/{name}"),
        format!("http://github.com/{owner}/{name}.git"),
    ];
    if let Ok(sources) = load_sources(home) {
        for source in sources {
            if parse_repo_name(&source.url).as_deref().is_some_and(|parsed| parsed.eq_ignore_ascii_case(repo)) {
                urls.push(source.url);
            }
        }
    }
    urls
}

fn read_draft(path: &Path) -> Option<String> {
    if !path.is_file() || home::is_symlink(path) {
        return None;
    }
    let meta = path.metadata().ok()?;
    if meta.len() > 65_000 {
        return None;
    }
    std::fs::read_to_string(path).ok()
}

pub fn find_draft(home: &Path, repo: &str, filename: &str) -> Option<(String, String)> {
    let root = home.join("drafts");
    if home::is_symlink(&root) || !root.is_dir() {
        return None;
    }
    for url in draft_urls(home, repo) {
        let slug = draft_slug(&url);
        if let Some(text) = read_draft(&root.join(slug).join(filename)) {
            if let Some(parsed) = split_draft(&text) {
                return Some(parsed);
            }
        }
    }
    None
}

fn split_draft(text: &str) -> Option<(String, String)> {
    let lines: Vec<&str> = text.split('\n').collect();
    if lines.is_empty() || lines[0].trim().is_empty() {
        return None;
    }
    let title = if let Some(rest) = lines[0].strip_prefix("# ") { rest.trim().to_string() } else { lines[0].trim().to_string() };
    if title.is_empty() {
        return None;
    }
    let mut body_lines = &lines[1..];
    if body_lines.first().is_some_and(|line| line.trim().is_empty()) {
        body_lines = &body_lines[1..];
    }
    Some((title, body_lines.join("\n").trim().to_string()))
}

pub(crate) fn draft_slug(text: &str) -> String {
    let digest = sha256(text.as_bytes());
    digest[..8].iter().map(|b| format!("{b:02x}")).collect()
}

fn sha256(bytes: &[u8]) -> [u8; 32] {
    // Compact SHA-256 so draft directories match the Python node.
    const K: [u32; 64] = [
        0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
        0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
        0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
        0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
        0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
        0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
        0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
        0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
    ];
    let mut h: [u32; 8] = [0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19];
    let bit_len = (bytes.len() as u64) * 8;
    let mut data = bytes.to_vec();
    data.push(0x80);
    while (data.len() % 64) != 56 {
        data.push(0);
    }
    data.extend_from_slice(&bit_len.to_be_bytes());
    for chunk in data.chunks(64) {
        let mut w = [0u32; 64];
        for i in 0..16 {
            w[i] = u32::from_be_bytes(chunk[i * 4..i * 4 + 4].try_into().unwrap());
        }
        for i in 16..64 {
            let s0 = w[i - 15].rotate_right(7) ^ w[i - 15].rotate_right(18) ^ (w[i - 15] >> 3);
            let s1 = w[i - 2].rotate_right(17) ^ w[i - 2].rotate_right(19) ^ (w[i - 2] >> 10);
            w[i] = w[i - 16].wrapping_add(s0).wrapping_add(w[i - 7]).wrapping_add(s1);
        }
        let mut a = h;
        for i in 0..64 {
            let s1 = a[4].rotate_right(6) ^ a[4].rotate_right(11) ^ a[4].rotate_right(25);
            let ch = (a[4] & a[5]) ^ (!a[4] & a[6]);
            let t1 = a[7].wrapping_add(s1).wrapping_add(ch).wrapping_add(K[i]).wrapping_add(w[i]);
            let s0 = a[0].rotate_right(2) ^ a[0].rotate_right(13) ^ a[0].rotate_right(22);
            let maj = (a[0] & a[1]) ^ (a[0] & a[2]) ^ (a[1] & a[2]);
            let t2 = s0.wrapping_add(maj);
            a[7] = a[6];
            a[6] = a[5];
            a[5] = a[4];
            a[4] = a[3].wrapping_add(t1);
            a[3] = a[2];
            a[2] = a[1];
            a[1] = a[0];
            a[0] = t1.wrapping_add(t2);
        }
        for i in 0..8 {
            h[i] = h[i].wrapping_add(a[i]);
        }
    }
    let mut out = [0u8; 32];
    for (i, word) in h.iter().enumerate() {
        out[i * 4..i * 4 + 4].copy_from_slice(&word.to_be_bytes());
    }
    out
}

pub fn send_issue_draft(home: &Path, provider: &str, raw_repo: &str) -> ForgeResult {
    let Some(repo) = parse_repo_name(raw_repo) else {
        return ForgeResult::new(false, "repository must look like owner/name");
    };
    let Some((title, body)) = find_draft(home, &repo, "issue-draft.md") else {
        return ForgeResult::new(false, "there is no local issue draft for that repository");
    };
    if body.is_empty() {
        return ForgeResult::new(false, "the draft has no body");
    }
    create_issue(home, provider, &repo, &title, &body)
}

pub fn send_pull_request_draft(home: &Path, provider: &str, raw_repo: &str, head: &str, base: &str) -> ForgeResult {
    let Some(repo) = parse_repo_name(raw_repo) else {
        return ForgeResult::new(false, "repository must look like owner/name");
    };
    let Some((title, body)) = find_draft(home, &repo, "pr-draft.md") else {
        return ForgeResult::new(false, "there is no local pull request draft for that repository");
    };
    if body.is_empty() {
        return ForgeResult::new(false, "the draft has no body");
    }
    create_pull_request(home, provider, &repo, &title, &body, head, base)
}
