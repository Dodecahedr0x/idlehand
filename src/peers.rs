//! Peer lists and the peers-of-peers heuristic.

use std::collections::{BTreeMap, BTreeSet};
use std::path::Path;
use std::time::Duration;

use serde_json::Value;

use crate::config::{self, load_peers, save_peers, Peer};
use crate::fetch::{contains_control_break, embeds_credentials, public_url, scrub_secrets};
use crate::home::HomeLock;
use crate::links::{fetch_text, LinkError};
use crate::trust::{decision, public_subject};

const LOOPBACK_HOSTS: &[&str] = &["localhost", "127.0.0.1", "::1"];

#[derive(Debug, Clone)]
pub struct PeerCandidate {
    pub url: String,
    pub peer_id: String,
    pub endorsements: i64,
}

fn scheme_label(scheme: &str) -> String {
    if !scheme.is_empty()
        && scheme.chars().next().unwrap().is_ascii_alphabetic()
        && scheme
            .chars()
            .all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || matches!(c, '+' | '.' | '-'))
    {
        format!(": {scheme}")
    } else {
        String::new()
    }
}

pub fn normalize_peer_url(url: &str) -> Result<String, String> {
    let raw = url.trim();
    if contains_control_break(raw) {
        return Err("peer URLs cannot contain a newline".into());
    }
    if embeds_credentials(raw) {
        return Err("peer URLs cannot embed credentials".into());
    }
    let parsed = split_peer(raw);
    let scheme = parsed.scheme.to_ascii_lowercase();
    if !matches!(scheme.as_str(), "https" | "http" | "file") {
        return Err(format!(
            "unsupported peer URL scheme{}",
            scheme_label(&scheme)
        ));
    }
    if matches!(scheme.as_str(), "https" | "http") && parsed.host.is_empty() {
        return Err("peer URL needs a host".into());
    }
    let mut netloc = if parsed.host.contains(':') {
        format!("[{}]", parsed.host)
    } else {
        parsed.host.clone()
    };
    if let Some(port) = parsed.port {
        netloc = format!("{netloc}:{port}");
    }
    let mut path = parsed.path.clone();
    if scheme != "file" && path != "/" && path.ends_with('/') {
        path.pop();
    }
    let mut out = format!("{scheme}://{netloc}{path}");
    if !parsed.query.is_empty() {
        out.push('?');
        out.push_str(&parsed.query);
    }
    Ok(out)
}

struct PeerParts {
    scheme: String,
    host: String,
    port: Option<u16>,
    path: String,
    query: String,
}

fn split_peer(raw: &str) -> PeerParts {
    let (left, _fragment) = raw.split_once('#').unwrap_or((raw, ""));
    let (left, query) = left
        .split_once('?')
        .map(|(l, q)| (l, q.to_string()))
        .unwrap_or((left, String::new()));
    let (scheme, rest) = left
        .split_once(':')
        .map(|(s, r)| (s.to_string(), r.to_string()))
        .unwrap_or_else(|| (String::new(), left.to_string()));
    let rest = rest.trim_start_matches("//");
    let (authority, path) = match rest.find('/') {
        Some(index) => (rest[..index].to_string(), rest[index..].to_string()),
        None => (rest.to_string(), String::new()),
    };
    let authority = authority.rsplit('@').next().unwrap_or("");
    let (host, port) = if let Some(rest) = authority.strip_prefix('[') {
        let (host, after) = rest.split_once(']').unwrap_or((rest, ""));
        let port = after.strip_prefix(':').and_then(|p| p.parse().ok());
        (host.to_ascii_lowercase(), port)
    } else if let Some((host, port)) = authority.rsplit_once(':') {
        if port.chars().all(|c| c.is_ascii_digit()) {
            (host.to_ascii_lowercase(), port.parse().ok())
        } else {
            (authority.to_ascii_lowercase(), None)
        }
    } else {
        (authority.to_ascii_lowercase(), None)
    };
    PeerParts {
        scheme,
        host,
        port,
        path,
        query,
    }
}

fn host_of(url: &str) -> String {
    split_peer(url).host
}

fn scheme_of(url: &str) -> String {
    split_peer(url).scheme.to_ascii_lowercase()
}

pub fn explain_peer_url(url: &str, heuristic: &toml::Value) -> (bool, String) {
    let normalized = match normalize_peer_url(url) {
        Ok(url) => url,
        Err(err) => return (false, err),
    };
    let scheme = scheme_of(&normalized);
    let host = host_of(&normalized);
    let allow_loopback = heuristic
        .get("allow_insecure_loopback")
        .and_then(toml::Value::as_bool);
    let require_https = heuristic
        .get("require_https")
        .and_then(toml::Value::as_bool);
    let blocked_raw = heuristic
        .get("blocked_hosts")
        .and_then(toml::Value::as_array);
    let allowed_raw = heuristic
        .get("allowed_hosts")
        .and_then(toml::Value::as_array);
    let hosts_ok = blocked_raw
        .zip(allowed_raw)
        .map(|(blocked, allowed)| {
            blocked
                .iter()
                .chain(allowed)
                .all(|item| item.as_str().is_some())
        })
        .unwrap_or(false);
    let (Some(allow_loopback), Some(require_https)) = (allow_loopback, require_https) else {
        return (false, "peer heuristic is unreadable".into());
    };
    if !hosts_ok {
        return (false, "peer heuristic is unreadable".into());
    }
    if scheme == "file" {
        return (false, "second-degree file URLs are not added".into());
    }
    let blocked: BTreeSet<String> = blocked_raw
        .unwrap()
        .iter()
        .filter_map(|i| i.as_str().map(|s| s.to_ascii_lowercase()))
        .collect();
    if blocked.contains(&host) {
        return (false, "host is blocked".into());
    }
    let allowed: BTreeSet<String> = allowed_raw
        .unwrap()
        .iter()
        .filter_map(|i| i.as_str().map(|s| s.to_ascii_lowercase()))
        .collect();
    if !allowed.is_empty() && !allowed.contains(&host) {
        return (false, "host is not in allowed_hosts".into());
    }
    let loopback = LOOPBACK_HOSTS.contains(&host.as_str());
    if scheme == "https" {
        return (true, "https peer URL".into());
    }
    if scheme == "http" && loopback && allow_loopback {
        return (true, "http is allowed for loopback".into());
    }
    if scheme == "http" && !require_https {
        return (true, "http peer URL".into());
    }
    if scheme == "http" {
        return (false, "second-degree peers must use https".into());
    }
    (
        false,
        format!("unsupported peer URL scheme{}", scheme_label(&scheme)),
    )
}

pub fn review_second_degree(
    self_id: &str,
    self_urls: &BTreeSet<String>,
    direct_peers: &[Peer],
    documents: &BTreeMap<String, Value>,
    existing_urls: &BTreeSet<String>,
    heuristic: &toml::Value,
) -> (Vec<PeerCandidate>, Vec<Value>) {
    let min_endorsements = match heuristic.get("min_endorsements") {
        Some(toml::Value::Integer(n)) if *n >= 0 => Some(*n),
        Some(_) => None,
        None => Some(1),
    };
    let max_new = match heuristic.get("max_new_peers_per_cycle") {
        Some(toml::Value::Integer(n)) if *n >= 0 => Some(*n),
        Some(_) => None,
        None => Some(5),
    };
    let max_peers = match heuristic.get("max_peers") {
        Some(toml::Value::Integer(n)) if *n >= 0 => Some(*n),
        Some(_) => None,
        None => Some(50),
    };
    let (Some(min_endorsements), Some(max_new), Some(max_peers)) =
        (min_endorsements, max_new, max_peers)
    else {
        return (
            Vec::new(),
            vec![decision(
                "peer",
                "idlehand://peer-heuristic",
                false,
                "peer heuristic is unreadable",
            )],
        );
    };
    let _ = min_endorsements;
    let room = (max_peers - existing_urls.len() as i64).max(0);
    let limit = max_new.min(room);
    let mut direct_urls = BTreeSet::new();
    for peer in direct_peers {
        if let Ok(url) = normalize_peer_url(&peer.url) {
            direct_urls.insert(url);
        }
    }
    let self_norm: BTreeSet<String> = self_urls.iter().map(|url| normalize_safe(url)).collect();
    let mut known = existing_urls.clone();
    known.extend(direct_urls);
    let mut decisions = Vec::new();
    let mut seen_decisions = BTreeSet::new();
    let mut add_decision = |subject: &str, accepted: bool, reason: &str| {
        let shown = public_subject(subject);
        let key = format!("{shown}\0{accepted}\0{reason}");
        if seen_decisions.insert(key) {
            decisions.push(decision("peer", &shown, accepted, reason));
        }
    };
    let mut endorsements: BTreeMap<String, BTreeSet<String>> = BTreeMap::new();
    let mut ids: BTreeMap<String, String> = BTreeMap::new();
    let mut allow_reason: BTreeMap<String, String> = BTreeMap::new();
    for (direct_url, document) in documents {
        let Some(peers) = document.get("peers").and_then(Value::as_array) else {
            continue;
        };
        let mut seen_here = BTreeSet::new();
        for entry in peers {
            let (raw, peer_id) = if let Some(text) = entry.as_str() {
                (text.to_string(), String::new())
            } else if let Some(url) = entry.get("url").and_then(Value::as_str) {
                (
                    url.to_string(),
                    public_label(entry.get("id").and_then(Value::as_str).unwrap_or("")),
                )
            } else {
                continue;
            };
            let (allowed, reason) = explain_peer_url(&raw, heuristic);
            if !allowed {
                add_decision(&raw, false, &reason);
                continue;
            }
            let url = match normalize_peer_url(&raw) {
                Ok(url) => url,
                Err(err) => {
                    add_decision(&raw, false, &err);
                    continue;
                }
            };
            if !seen_here.insert(url.clone()) {
                continue;
            }
            if known.contains(&url) {
                add_decision(&url, false, "already a peer");
                continue;
            }
            if self_norm.contains(&url)
                || (!peer_id.is_empty() && !self_id.is_empty() && peer_id == self_id)
            {
                add_decision(&url, false, "this is the local node");
                continue;
            }
            endorsements
                .entry(url.clone())
                .or_default()
                .insert(direct_url.clone());
            allow_reason.entry(url.clone()).or_insert(reason);
            if !peer_id.is_empty() {
                ids.entry(url).or_insert(peer_id);
            }
        }
    }
    let mut ranked: Vec<PeerCandidate> = endorsements
        .iter()
        .filter(|(_, sources)| sources.len() as i64 >= min_endorsements)
        .map(|(url, sources)| PeerCandidate {
            url: url.clone(),
            peer_id: ids.get(url).cloned().unwrap_or_default(),
            endorsements: sources.len() as i64,
        })
        .collect();
    for (url, sources) in &endorsements {
        if (sources.len() as i64) < min_endorsements {
            add_decision(
                url,
                false,
                &format!(
                    "needs {min_endorsements} endorsements, has {}",
                    sources.len()
                ),
            );
        }
    }
    ranked.sort_by(|a, b| b.endorsements.cmp(&a.endorsements).then(a.url.cmp(&b.url)));
    let chosen_count = if limit > 0 {
        (limit as usize).min(ranked.len())
    } else {
        0
    };
    for candidate in ranked.iter().skip(chosen_count) {
        add_decision(&candidate.url, false, "the peer cap was reached");
    }
    let chosen = ranked.into_iter().take(chosen_count).collect::<Vec<_>>();
    for candidate in &chosen {
        let reason = allow_reason
            .get(&candidate.url)
            .map(String::as_str)
            .unwrap_or("https peer URL");
        add_decision(&candidate.url, true, reason);
    }
    (chosen, decisions)
}

pub fn normalize_safe(url: &str) -> String {
    normalize_peer_url(url).unwrap_or_else(|_| url.trim().to_string())
}

pub fn count_remote_repos(document: &Value) -> usize {
    document
        .get("repos")
        .and_then(Value::as_array)
        .map(|items| items.len())
        .unwrap_or(0)
}

pub fn load_peer_document(url: &str, timeout: Duration) -> Result<Value, String> {
    let text = fetch_text(url, timeout).map_err(|LinkError(err)| err)?;
    let payload: Value =
        serde_json::from_str(&text).map_err(|err| format!("peer document is not JSON: {err}"))?;
    if !payload.is_object() {
        return Err("peer document must be a JSON object".into());
    }
    Ok(payload)
}

pub fn public_label(value: &str) -> String {
    if contains_control_break(value) {
        return String::new();
    }
    let text = scrub_secrets(value)
        .replace(['\n', '\r'], " ")
        .trim()
        .to_string();
    if text.is_empty()
        || text.contains("PRIVATE KEY")
        || text.len() > 200
        || contains_control_break(&text)
    {
        return String::new();
    }
    text
}

pub fn publish_document(
    node_id: &str,
    listen_url: &str,
    peers: &[Peer],
    repos: &[config::Source],
) -> Value {
    let peers = peers
        .iter()
        .filter_map(|peer| {
            let shown = public_url(&peer.url);
            if shown.is_empty() {
                None
            } else {
                Some(serde_json::json!({"url": shown, "id": public_label(&peer.id)}))
            }
        })
        .collect::<Vec<_>>();
    let repos = repos
        .iter()
        .filter_map(|repo| {
            let shown = public_url(&repo.url);
            if shown.is_empty() {
                None
            } else {
                Some(serde_json::json!({"url": shown}))
            }
        })
        .collect::<Vec<_>>();
    serde_json::json!({
        "idlehand": 1,
        "node_id": public_label(node_id),
        "listen_url": public_url(listen_url),
        "peers": peers,
        "repos": repos,
    })
}

pub fn user_add_peer(home: &Path, url: &str) -> Result<String, String> {
    let normalized = normalize_peer_url(url)?;
    let _lock = HomeLock::acquire(home).map_err(|e| e.to_string())?;
    let mut peers = load_peers(home)?;
    if peers
        .iter()
        .any(|peer| normalize_safe(&peer.url) == normalized)
    {
        return Ok(normalized);
    }
    peers.push(Peer {
        url: normalized.clone(),
        id: String::new(),
        source: "user".into(),
        endorsements: 1,
    });
    save_peers(home, &peers)?;
    Ok(normalized)
}
