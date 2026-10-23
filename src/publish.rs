//! Serve the public peer document and the loopback admin page.

use std::io::{Read, Write};
use std::net::{IpAddr, SocketAddr, TcpListener, TcpStream};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::thread::{self, JoinHandle};
use std::time::Duration;

use crate::config::{self, load_config, save_config};
use crate::configure::{self, display_setting, setting_keys};
use crate::home::{self, HomeLock};

pub struct PublishServer {
    shutdown: Arc<AtomicBool>,
    address: SocketAddr,
    join: Option<JoinHandle<()>>,
}

impl PublishServer {
    pub fn address(&self) -> SocketAddr {
        self.address
    }

    pub fn shutdown(mut self) {
        self.shutdown.store(true, Ordering::SeqCst);
        let _ = TcpStream::connect_timeout(&self.address, Duration::from_millis(200));
        if let Some(join) = self.join.take() {
            let _ = join.join();
        }
    }
}

pub fn client_may_admin(addr: SocketAddr) -> bool {
    match addr.ip() {
        IpAddr::V4(ip) => ip.is_loopback(),
        IpAddr::V6(ip) => ip.is_loopback(),
    }
}

pub fn start_publish_server(home: &Path, host: &str, port: u16) -> Option<PublishServer> {
    let listener = TcpListener::bind((host, port)).ok()?;
    let address = listener.local_addr().ok()?;
    let shutdown = Arc::new(AtomicBool::new(false));
    let flag = shutdown.clone();
    let home = home.to_path_buf();
    let token = admin_token();
    let join = thread::spawn(move || serve_loop(listener, home, token, flag));
    Some(PublishServer { shutdown, address, join: Some(join) })
}

fn admin_token() -> String {
    let mut bytes = [0u8; 16];
    if std::fs::File::open("/dev/urandom").and_then(|mut file| std::io::Read::read_exact(&mut file, &mut bytes)).is_err() {
        bytes = std::process::id().to_le_bytes().repeat(4).try_into().unwrap_or([1; 16]);
    }
    bytes.iter().map(|byte| format!("{byte:02x}")).collect()
}

fn serve_loop(listener: TcpListener, home: PathBuf, token: String, shutdown: Arc<AtomicBool>) {
    listener.set_nonblocking(false).ok();
    while !shutdown.load(Ordering::SeqCst) {
        let Ok((mut stream, peer)) = listener.accept() else { break };
        if shutdown.load(Ordering::SeqCst) {
            break;
        }
        let _ = stream.set_read_timeout(Some(Duration::from_secs(5)));
        let _ = stream.set_write_timeout(Some(Duration::from_secs(5)));
        if let Ok((method, path, body)) = read_request(&mut stream) {
            let response = route(&home, &token, peer, &method, &path, &body);
            let _ = stream.write_all(&response);
        }
    }
}

fn read_request(stream: &mut TcpStream) -> std::io::Result<(String, String, Vec<u8>)> {
    let mut buf = Vec::new();
    let mut tmp = [0u8; 2048];
    loop {
        let n = stream.read(&mut tmp)?;
        if n == 0 { break }
        buf.extend_from_slice(&tmp[..n]);
        if buf.windows(4).any(|window| window == b"\r\n\r\n") || buf.len() > 1_000_000 { break }
    }
    let text = String::from_utf8_lossy(&buf);
    let Some((head, rest)) = text.split_once("\r\n\r\n") else {
        return Ok((String::new(), String::new(), Vec::new()));
    };
    let mut lines = head.lines();
    let request = lines.next().unwrap_or("");
    let mut parts = request.split_whitespace();
    let method = parts.next().unwrap_or("").to_string();
    let path = parts.next().unwrap_or("").split('?').next().unwrap_or("").to_string();
    let length = lines.find_map(|line| {
        let (name, value) = line.split_once(':')?;
        name.eq_ignore_ascii_case("content-length").then(|| value.trim().parse::<usize>().ok()).flatten()
    }).unwrap_or(0);
    let mut body = rest.as_bytes().to_vec();
    while body.len() < length && body.len() < 1_000_000 {
        let n = stream.read(&mut tmp)?;
        if n == 0 { break }
        body.extend_from_slice(&tmp[..n]);
    }
    body.truncate(length);
    Ok((method, path, body))
}

fn route(home: &Path, token: &str, peer: SocketAddr, method: &str, path: &str, body: &[u8]) -> Vec<u8> {
    if path == "/idlehand/publish" && method == "GET" {
        return publish_body(home);
    }
    if path == "/idlehand/admin" {
        if !client_may_admin(peer) {
            return http(403, "text/plain; charset=utf-8", b"admin is loopback only\n");
        }
        if method == "GET" {
            return http(200, "text/html; charset=utf-8", &admin_page(home, token, None));
        }
        if method == "POST" {
            return admin_post(home, token, body);
        }
    }
    http(404, "text/plain; charset=utf-8", b"not found\n")
}

fn publish_body(home: &Path) -> Vec<u8> {
    let path = config::publish_path(home);
    if home::is_symlink(&path) || !path.is_file() {
        return http(404, "text/plain; charset=utf-8", b"not found\n");
    }
    match std::fs::read(&path) {
        Ok(body) => http(200, "application/json", &body),
        Err(_) => http(404, "text/plain; charset=utf-8", b"not found\n"),
    }
}

fn admin_post(home: &Path, token: &str, body: &[u8]) -> Vec<u8> {
    let fields = form_pairs(&String::from_utf8_lossy(body));
    if fields.iter().find(|(key, _)| key == "csrf").map(|(_, value)| value.as_str()) != Some(token) {
        return http(403, "text/html; charset=utf-8", &admin_page(home, token, Some("the form token did not match")));
    }
    let Ok(current) = load_config(home) else {
        return http(400, "text/html; charset=utf-8", &admin_page(home, token, Some("config is unreadable")));
    };
    let updates: Vec<(&str, &str)> = setting_keys().iter().map(|key| (*key, fields.iter().find(|(name, _)| name == key).map(|(_, value)| value.as_str()).unwrap_or(""))).collect();
    match configure::apply_updates(&current, &updates) {
        Ok(next) => {
            if next.to_string() != current.to_string() {
                let Ok(_lock) = HomeLock::acquire(home) else {
                    return http(400, "text/html; charset=utf-8", &admin_page(home, token, Some("config is unreadable")));
                };
                if save_config(home, &next).is_err() {
                    return http(400, "text/html; charset=utf-8", &admin_page(home, token, Some("config is unreadable")));
                }
            }
            http(200, "text/html; charset=utf-8", &admin_page(home, token, Some("saved")))
        }
        Err(err) => http(400, "text/html; charset=utf-8", &admin_page(home, token, Some(&format!("rejected: {err}")))),
    }
}

fn admin_page(home: &Path, token: &str, notice: Option<&str>) -> Vec<u8> {
    let config = load_config(home).unwrap_or_else(|_| toml::Value::Table(toml::map::Map::new()));
    let mut html = String::from("<!doctype html><html><head><meta charset=\"utf-8\"><title>IdleHand admin</title></head><body><h1>IdleHand admin</h1><p>Loopback only. Empty fields keep the stored value. <code>none</code> clears the subscription or a host list.</p>");
    if let Some(notice) = notice {
        html.push_str(&format!("<p>{}</p>", escape(notice)));
    }
    html.push_str("<form method=\"post\" action=\"/idlehand/admin\">");
    html.push_str(&format!("<input type=\"hidden\" name=\"csrf\" value=\"{}\">", escape(token)));
    for key in setting_keys() {
        let current = display_setting(&config, key);
        html.push_str(&format!("<p><label>{}<br><input name=\"{}\" value=\"{}\" autocomplete=\"off\"></label></p>", escape(key), escape(key), escape(&current)));
    }
    html.push_str("<button type=\"submit\">Save</button></form></body></html>");
    html.into_bytes()
}

fn form_pairs(body: &str) -> Vec<(String, String)> {
    body.split('&').filter(|pair| !pair.is_empty()).map(|pair| {
        let (key, value) = pair.split_once('=').unwrap_or((pair, ""));
        (percent_decode(key), percent_decode(value))
    }).collect()
}

fn percent_decode(text: &str) -> String {
    let text = text.replace('+', " ");
    crate::fetch::percent_decode(&text)
}

fn escape(text: &str) -> String {
    text.replace('&', "&amp;").replace('<', "&lt;").replace('>', "&gt;").replace('"', "&quot;")
}

fn http(status: u16, content_type: &str, body: &[u8]) -> Vec<u8> {
    let reason = match status { 200 => "OK", 400 => "Bad Request", 403 => "Forbidden", 404 => "Not Found", _ => "OK" };
    let mut out = format!("HTTP/1.1 {status} {reason}\r\nContent-Type: {content_type}\r\nContent-Length: {}\r\nConnection: close\r\n\r\n", body.len()).into_bytes();
    out.extend_from_slice(body);
    out
}
