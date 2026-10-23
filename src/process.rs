//! Start and stop the long-running node process.

use std::fs;
use std::os::unix::process::CommandExt;
use std::path::Path;
use std::process::Command;
use std::thread;
use std::time::{Duration, Instant};

use serde_json::Value;

use crate::config::{self, ensure_home};
use crate::home::read_json;
use crate::procutil;

pub fn cmdline(pid: u32) -> String {
    let proc_path = format!("/proc/{pid}/cmdline");
    if let Ok(raw) = fs::read(&proc_path) {
        if !raw.is_empty() {
            return String::from_utf8_lossy(&raw).replace('\0', " ");
        }
    }
    let completed = procutil::run(
        &[
            "ps".into(),
            "-p".into(),
            pid.to_string(),
            "-o".into(),
            "command=".into(),
        ],
        None,
        None,
        Duration::from_secs(2),
    );
    if completed.code != 0 {
        return String::new();
    }
    completed.stdout.trim().to_string()
}

pub fn alive_pid(home: &Path) -> Option<u32> {
    let path = config::pid_path(home);
    if !path.exists() {
        return None;
    }
    let text = fs::read_to_string(&path).ok()?;
    let pid: u32 = text.trim().parse().ok()?;
    if unsafe { libc::kill(pid as i32, 0) } != 0 {
        return None;
    }
    if !cmdline(pid).contains("idlehand") {
        return None;
    }
    Some(pid)
}

fn node_binary() -> std::path::PathBuf {
    let current = procutil::current_executable();
    if current.file_name().and_then(|name| name.to_str()) == Some("idlehand") {
        return current;
    }
    if let Some(from_cargo) = std::env::var_os("CARGO_BIN_EXE_idlehand") {
        return std::path::PathBuf::from(from_cargo);
    }
    current
}

pub fn start_node(home: &Path, timeout: Duration) -> Result<u32, String> {
    if let Some(existing) = alive_pid(home) {
        return Ok(existing);
    }
    ensure_home(home)?;
    let log = fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(config::log_path(home))
        .map_err(|err| err.to_string())?;
    let err_log = log.try_clone().map_err(|err| err.to_string())?;
    let mut command = Command::new(node_binary());
    command
        .arg("node")
        .env("IDLEHAND_HOME", home)
        .current_dir(home)
        .stdin(std::process::Stdio::null())
        .stdout(std::process::Stdio::from(log))
        .stderr(std::process::Stdio::from(err_log));
    unsafe {
        command.pre_exec(|| {
            libc::setsid();
            Ok(())
        });
    }
    command.spawn().map_err(|err| err.to_string())?;
    let deadline = Instant::now() + timeout;
    while Instant::now() < deadline {
        let pid = alive_pid(home);
        let state = read_json(&config::state_path(home)).ok().flatten();
        let heartbeat = state
            .as_ref()
            .and_then(|value| value.get("node"))
            .and_then(|node| node.get("heartbeat_at"))
            .and_then(Value::as_str)
            .is_some_and(|text| !text.is_empty());
        if pid.is_some() && heartbeat {
            return Ok(pid.unwrap());
        }
        thread::sleep(Duration::from_millis(50));
    }
    alive_pid(home).ok_or_else(|| "the IdleHand node did not stay up".into())
}

pub fn stop_node(home: &Path, timeout: Duration) -> bool {
    let Some(pid) = alive_pid(home) else {
        let _ = fs::remove_file(config::pid_path(home));
        return false;
    };
    unsafe {
        libc::kill(pid as i32, libc::SIGTERM);
    }
    let deadline = Instant::now() + timeout;
    while Instant::now() < deadline {
        if alive_pid(home).is_none() {
            let _ = fs::remove_file(config::pid_path(home));
            return true;
        }
        thread::sleep(Duration::from_millis(50));
    }
    if alive_pid(home).is_some() {
        unsafe {
            libc::kill(pid as i32, libc::SIGKILL);
        }
    }
    let _ = fs::remove_file(config::pid_path(home));
    true
}
