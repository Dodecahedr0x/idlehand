//! IdleHand links add repositories to the local source list.

use std::fs;
use std::io::{Read, Write};
use std::net::TcpStream;
use std::path::Path;
use std::time::Duration;

use serde_json::Value;

use crate::config::{self, load_sources, save_sources, Source};
use crate::fetch::{contains_control_break, embeds_credentials, public_url};
use crate::home::HomeLock;
use crate::trust::{decision, remember};
use crate::VERSION;

pub const MAX_LIST_BYTES: usize = 1_000_000;
const CATALOG_PARAMS: &[&str] = &["catalog", "directory", "registry"];

#[derive(Debug)]
pub struct LinkError(pub String);

impl std::fmt::Display for LinkError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(&self.0)
    }
}

#[derive(Debug, Default)]
pub struct ParsedLink {
    pub repos: Vec<String>,
    pub list_url: String,
}

#[derive(Debug)]
pub struct LinkApply {
    pub added: Vec<String>,
    pub decisions: Vec<Value>,
}

pub fn parse_idlehand_link(url: &str) -> Result<ParsedLink, LinkError> {
    let raw = url.trim();
    if !raw.to_ascii_lowercase().starts_with("idlehand:") {
        return Err(LinkError("not an IdleHand link".into()));
    }
    let rest = &raw["idlehand:".len()..];
    let (before_query, query) = match rest.split_once('?') {
        Some((left, query)) => (left, query),
        None => (rest, ""),
    };
    let authority = before_query.trim_start_matches("//").trim_start_matches('/');
    let action = authority.split('/').next().unwrap_or("").to_string();
    let pairs = parse_qs(query);
    for blocked in CATALOG_PARAMS {
        if pairs.iter().any(|(key, _)| key == blocked) {
            return Err(LinkError("IdleHand does not resolve links through a catalog".into()));
        }
    }
    if !action.is_empty() && action != "add" {
        return Err(LinkError(format!("unsupported IdleHand link action{}", action_label(&action))));
    }
    let mut repos = Vec::new();
    for (key, value) in &pairs {
        if key == "repo" || key == "repos" {
            repos.extend(split_repo_field(value));
        }
    }
    let lists: Vec<&str> = pairs.iter().filter(|(key, _)| key == "list").map(|(_, value)| value.as_str()).collect();
    if lists.len() > 1 {
        return Err(LinkError("an IdleHand link can name only one list file".into()));
    }
    let list_url = lists.first().map(|s| s.trim().to_string()).unwrap_or_default();
    if !list_url.is_empty() {
        validate_list_url(&list_url)?;
    }
    if repos.is_empty() && list_url.is_empty() {
        return Err(LinkError("the link has no repos and no list file".into()));
    }
    Ok(ParsedLink { repos, list_url })
}

fn parse_qs(query: &str) -> Vec<(String, String)> {
    if query.is_empty() {
        return Vec::new();
    }
    query
        .split('&')
        .filter_map(|pair| {
            let (key, value) = pair.split_once('=').unwrap_or((pair, ""));
            if value.is_empty() && !pair.contains('=') {
                return None;
            }
            Some((percent_decode(key), percent_decode(value)))
        })
        .collect()
}

fn percent_decode(text: &str) -> String {
    crate::fetch::percent_decode(text)
}

fn split_repo_field(value: &str) -> Vec<String> {
    value.split(',').map(str::trim).filter(|part| !part.is_empty()).map(str::to_string).collect()
}

fn action_label(action: &str) -> String {
    if !action.is_empty()
        && action.len() <= 32
        && action.chars().next().unwrap().is_ascii_alphabetic()
        && action.chars().all(|c| c.is_ascii_alphanumeric() || matches!(c, '+' | '.' | '-'))
    {
        format!(": {action}")
    } else {
        String::new()
    }
}

fn shown_url(url: &str) -> String {
    let shown = public_url(url);
    if shown.is_empty() || shown.contains("PRIVATE KEY") || shown.chars().any(|c| c == '\r' || c == '\n' || c == '\t' || c == ' ') || shown.len() > 200 || !shown.contains("://") {
        String::new()
    } else {
        shown
    }
}

fn with_url(problem: &str, url: &str) -> String {
    let shown = shown_url(url);
    if shown.is_empty() {
        problem.to_string()
    } else {
        format!("{problem}: {shown}")
    }
}

fn validate_repo_url(url: &str) -> Result<String, LinkError> {
    let cleaned = url.trim();
    if contains_control_break(cleaned) {
        return Err(LinkError("repository URL must be http or https".into()));
    }
    if embeds_credentials(cleaned) {
        return Err(LinkError("repository URLs cannot embed credentials".into()));
    }
    let parsed = split_simple(cleaned);
    if !matches!(parsed.0.as_str(), "https" | "http") || parsed.1.is_empty() {
        return Err(LinkError(with_url("repository URL must be http or https", cleaned)));
    }
    if parsed.2.is_empty() || parsed.2 == "/" {
        return Err(LinkError(with_url("repository URL needs a path", cleaned)));
    }
    Ok(cleaned.to_string())
}

fn validate_list_url(url: &str) -> Result<(), LinkError> {
    if contains_control_break(url) {
        return Err(LinkError("a list file must be http, https, or file".into()));
    }
    if embeds_credentials(url) {
        return Err(LinkError("list URLs cannot embed credentials".into()));
    }
    let parsed = split_simple(url);
    if !matches!(parsed.0.as_str(), "https" | "http" | "file") {
        return Err(LinkError("a list file must be http, https, or file".into()));
    }
    if matches!(parsed.0.as_str(), "https" | "http") && parsed.1.is_empty() {
        return Err(LinkError("the list URL needs a host".into()));
    }
    Ok(())
}

fn split_simple(url: &str) -> (String, String, String) {
    let (scheme, rest) = url.split_once(':').map(|(s, r)| (s.to_ascii_lowercase(), r.to_string())).unwrap_or_else(|| (String::new(), url.to_string()));
    let rest = rest.trim_start_matches("//");
    if scheme == "file" {
        return (scheme, String::new(), rest.to_string());
    }
    let (host, path) = match rest.find('/') {
        Some(index) => (rest[..index].to_string(), rest[index..].to_string()),
        None => (rest.to_string(), String::new()),
    };
    let host = host.split('@').next_back().unwrap_or("").to_string();
    (scheme, host, path.split(['?', '#']).next().unwrap_or("").to_string())
}

pub fn judge_repo_url(url: &str) -> (bool, String, String) {
    match validate_repo_url(url) {
        Ok(cleaned) => {
            let scheme = split_simple(&cleaned).0;
            (true, cleaned, format!("{scheme} git repository URL"))
        }
        Err(err) => (false, url.trim().to_string(), err.0),
    }
}

pub fn judge_list_text(text: &str) -> Result<Vec<(bool, String, String)>, LinkError> {
    let stripped = text.trim();
    if stripped.is_empty() {
        return Ok(Vec::new());
    }
    if stripped.starts_with('{') || stripped.starts_with('[') {
        let payload: Value = serde_json::from_str(stripped).map_err(|err| LinkError(format!("list file is not valid JSON: {err}")))?;
        let values = if let Some(object) = payload.as_object() {
            object.get("repos").cloned().unwrap_or(Value::Null)
        } else if payload.is_array() {
            payload
        } else {
            return Err(LinkError("list file JSON must be a list or an object with repos".into()));
        };
        let Some(values) = values.as_array() else {
            return Err(LinkError("list file JSON must be a list or an object with repos".into()));
        };
        let mut judged = Vec::new();
        for item in values {
            if let Some(text) = item.as_str() {
                judged.push(judge_repo_url(text));
            } else if let Some(url) = item.get("url").and_then(Value::as_str) {
                judged.push(judge_repo_url(url));
            } else {
                judged.push((false, String::new(), "each repo in the list file needs a URL".into()));
            }
        }
        return Ok(judged);
    }
    let mut judged = Vec::new();
    for line in text.lines() {
        let line = line.trim();
        if line.is_empty() || line.starts_with('#') {
            continue;
        }
        judged.push(judge_repo_url(line));
    }
    Ok(judged)
}

pub fn fetch_text(url: &str, timeout: Duration) -> Result<String, LinkError> {
    let parsed = split_simple(url);
    if parsed.0 == "file" {
        let path = file_path(url);
        if !path.is_file() {
            return Err(LinkError(format!("list file not found: {}", path.display())));
        }
        let data = fs::read(&path).map_err(|err| LinkError(err.to_string()))?;
        if data.len() > MAX_LIST_BYTES {
            return Err(LinkError("list file is larger than 1MB".into()));
        }
        return decode_text(&data);
    }
    if parsed.0 != "https" && parsed.0 != "http" {
        return Err(LinkError(format!("cannot fetch {} URLs", parsed.0)));
    }
    if parsed.0 == "https" {
        return fetch_https(url, timeout);
    }
    fetch_http(url, timeout)
}

fn file_path(url: &str) -> std::path::PathBuf {
    let rest = url.split_once(':').map(|(_, rest)| rest).unwrap_or(url);
    let rest = rest.trim_start_matches("//");
    let path = rest.split(['?', '#']).next().unwrap_or(rest);
    std::path::PathBuf::from(percent_decode(path))
}

fn decode_text(data: &[u8]) -> Result<String, LinkError> {
    String::from_utf8(data.to_vec()).map_err(|_| LinkError("document is not UTF-8".into()))
}

fn fetch_http(url: &str, timeout: Duration) -> Result<String, LinkError> {
    let (host, port, path) = http_parts(url)?;
    let mut stream = TcpStream::connect_timeout(&format!("{host}:{port}").parse().map_err(|_| LinkError(format!("could not fetch {}: bad address", public_url(url))))?, timeout)
        .map_err(|err| LinkError(format!("could not fetch {}: {err}", public_or_list(url))))?;
    stream.set_read_timeout(Some(timeout)).ok();
    stream.set_write_timeout(Some(timeout)).ok();
    let request = format!("GET {path} HTTP/1.1\r\nHost: {host}:{port}\r\nUser-Agent: idlehand/{VERSION}\r\nConnection: close\r\nAccept: */*\r\n\r\n");
    stream.write_all(request.as_bytes()).map_err(|err| LinkError(format!("could not fetch {}: {err}", public_or_list(url))))?;
    let mut data = Vec::new();
    let mut buf = [0u8; 8192];
    while data.len() <= MAX_LIST_BYTES + 1 {
        match stream.read(&mut buf) {
            Ok(0) => break,
            Ok(n) => data.extend_from_slice(&buf[..n]),
            Err(err) => return Err(LinkError(format!("could not fetch {}: {err}", public_or_list(url)))),
        }
    }
    let text = String::from_utf8_lossy(&data);
    let (head, body) = text.split_once("\r\n\r\n").ok_or_else(|| LinkError(format!("could not fetch {}: short response", public_or_list(url))))?;
    let status: u16 = head.lines().next().and_then(|line| line.split_whitespace().nth(1)).and_then(|code| code.parse().ok()).unwrap_or(0);
    if (300..400).contains(&status) {
        return Err(LinkError(format!("refusing to follow a redirect from {url}")));
    }
    if !(200..300).contains(&status) {
        return Err(LinkError(format!("could not fetch {}: HTTP {status}", public_or_list(url))));
    }
    let body = body.as_bytes();
    if body.len() > MAX_LIST_BYTES {
        return Err(LinkError("list file is larger than 1MB".into()));
    }
    decode_text(body)
}

fn fetch_https(url: &str, timeout: Duration) -> Result<String, LinkError> {
    let agent = ureq::AgentBuilder::new().timeout(timeout).redirects(0).build();
    let response = agent.get(url).set("User-Agent", &format!("idlehand/{VERSION}")).call();
    match response {
        Ok(response) => {
            if (300..400).contains(&response.status()) {
                return Err(LinkError(format!("refusing to follow a redirect from {url}")));
            }
            let mut buf = Vec::new();
            response.into_reader().take(MAX_LIST_BYTES as u64 + 1).read_to_end(&mut buf).map_err(|err| LinkError(err.to_string()))?;
            if buf.len() > MAX_LIST_BYTES {
                return Err(LinkError("list file is larger than 1MB".into()));
            }
            decode_text(&buf)
        }
        Err(ureq::Error::Status(code, _)) if (300..400).contains(&code) => Err(LinkError(format!("refusing to follow a redirect from {url}"))),
        Err(err) => Err(LinkError(format!("could not fetch {}: {err}", public_or_list(url)))),
    }
}

fn public_or_list(url: &str) -> String {
    let shown = public_url(url);
    if shown.is_empty() { "list file".into() } else { shown }
}

fn http_parts(url: &str) -> Result<(String, u16, String), LinkError> {
    let rest = url.split_once("://").map(|(_, rest)| rest).unwrap_or(url);
    let (authority, path) = match rest.find('/') {
        Some(index) => (rest[..index].to_string(), rest[index..].to_string()),
        None => (rest.to_string(), "/".into()),
    };
    let authority = authority.split('@').next_back().unwrap_or("").to_string();
    let (host, port) = if let Some(host) = authority.strip_prefix('[') {
        let (host, rest) = host.split_once(']').unwrap_or((host, ""));
        let port = rest.strip_prefix(':').and_then(|p| p.parse().ok()).unwrap_or(80);
        (host.to_string(), port)
    } else if let Some((host, port)) = authority.rsplit_once(':') {
        (host.to_string(), port.parse().unwrap_or(80))
    } else {
        (authority, 80)
    };
    let path = if path.is_empty() { "/".into() } else { path };
    Ok((host, port, path))
}

fn normalize_repo(url: &str) -> String {
    let (scheme, host, path) = split_simple(url.trim());
    let path = path.trim_end_matches('/');
    if scheme.is_empty() {
        return url.trim().to_string();
    }
    format!("{scheme}://{host}{path}")
}

pub fn add_repos(home: &Path, urls: &[String]) -> Result<Vec<String>, LinkError> {
    let _lock = HomeLock::acquire(home).map_err(|err| LinkError(err.to_string()))?;
    let mut current = load_sources(home).map_err(|err| LinkError(err.to_string()))?;
    let mut known: Vec<String> = current.iter().map(|repo| normalize_repo(&repo.url)).collect();
    let mut added = Vec::new();
    for url in urls {
        let validated = validate_repo_url(url)?;
        let key = normalize_repo(&validated);
        if known.iter().any(|item| item == &key) {
            continue;
        }
        current.push(Source { url: validated.clone(), note: "Added from an IdleHand link.".into() });
        known.push(key);
        added.push(validated);
    }
    save_sources(home, &current).map_err(|err| LinkError(err.to_string()))?;
    Ok(added)
}

pub fn apply_link(home: &Path, url: &str) -> Result<LinkApply, LinkError> {
    let parsed = match parse_idlehand_link(url) {
        Ok(parsed) => parsed,
        Err(err) => {
            let choices = vec![decision("link", url, false, &err.0)];
            let _ = remember(home, &choices);
            return Err(err);
        }
    };
    let mut judged: Vec<(bool, String, String)> = parsed.repos.iter().map(|repo| judge_repo_url(repo)).collect();
    let mut decisions = Vec::new();
    if !parsed.list_url.is_empty() {
        match fetch_text(&parsed.list_url, Duration::from_secs(10)).and_then(|text| judge_list_text(&text)) {
            Err(err) => decisions.push(decision("link", &parsed.list_url, false, &err.0)),
            Ok(listed) if listed.is_empty() => decisions.push(decision("link", &parsed.list_url, false, "the list file has no repositories")),
            Ok(listed) => judged.extend(listed),
        }
    }
    let mut known: Vec<String> = load_sources(home).unwrap_or_default().iter().map(|repo| normalize_repo(&repo.url)).collect();
    let mut fresh = Vec::new();
    for (accepted, cleaned, reason) in judged {
        if !accepted {
            decisions.push(decision("link", &cleaned, false, &reason));
            continue;
        }
        let key = normalize_repo(&cleaned);
        if known.iter().any(|item| item == &key) {
            decisions.push(decision("link", &cleaned, true, "already in the local source list"));
            continue;
        }
        decisions.push(decision("link", &cleaned, true, &reason));
        fresh.push(cleaned);
        known.push(key);
    }
    let added = if fresh.is_empty() { Vec::new() } else { add_repos(home, &fresh)? };
    let _ = remember(home, &decisions);
    if !decisions.iter().any(|item| item.get("accepted").and_then(Value::as_bool) == Some(true)) {
        let reason = decisions.last().and_then(|item| item.get("reason")).and_then(Value::as_str).unwrap_or("the link added no repositories");
        return Err(LinkError(reason.to_string()));
    }
    Ok(LinkApply { added, decisions })
}
