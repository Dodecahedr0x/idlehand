//! Run a command in a container or the namespace jail.
//!
//! Subscription CLIs are not sandbox commands. If no runtime is available, the
//! command is not run on the host.

use std::fs;
use std::path::{Path, PathBuf};
use std::process::Command;
use std::time::Duration;

use regex::Regex;
use serde_json::{json, Value};

use crate::fetch::scrub_secrets;
use crate::procutil::{self, which, ProcOut};

#[derive(Debug, Clone)]
pub struct SandboxResult {
    pub runtime: String,
    pub invoked: bool,
    pub ok: bool,
    pub exit_code: Option<i32>,
    pub stdout: String,
    pub stderr: String,
    pub reason: String,
    pub argv: Vec<String>,
}

impl SandboxResult {
    pub fn as_json(&self) -> Value {
        json!({
            "runtime": self.runtime,
            "invoked": self.invoked,
            "ok": self.ok,
            "exit_code": self.exit_code,
            "stdout": stored_output(&self.stdout, 500),
            "stderr": stored_output(&self.stderr, 500),
            "reason": stored_output(&self.reason, 300),
            "argv": self.argv,
        })
    }
}

fn stored_output(text: &str, limit: usize) -> String {
    let lines: Vec<String> = scrub_secrets(text)
        .lines()
        .map(|line| {
            if line.contains("PRIVATE KEY") {
                "private key material omitted".into()
            } else {
                line.to_string()
            }
        })
        .collect();
    let joined = lines.join("\n");
    let start = joined.len().saturating_sub(limit);
    joined[start..].to_string()
}

const KNOWN: &[&str] = &["auto", "none", "docker", "podman", "namespace", "bwrap"];

pub fn sandbox_limits(image: &str, memory: &str, cpus: &str) -> Option<(String, String, String)> {
    let image_re = Regex::new(r"^[A-Za-z0-9][A-Za-z0-9._:/-]{0,199}$").ok()?;
    let memory_re = Regex::new(r"^[1-9][0-9]{0,5}[kKmMgG]?$").ok()?;
    let cpus_re = Regex::new(r"^[0-9]{1,2}(?:\.[0-9]{1,3})?$").ok()?;
    if !image_re.is_match(image) || image.contains("..") {
        return None;
    }
    if !memory_re.is_match(memory) || !cpus_re.is_match(cpus) {
        return None;
    }
    Some((image.to_string(), memory.to_string(), cpus.to_string()))
}

pub fn detect_runtime(configured: &str) -> Option<String> {
    let choice = if configured.is_empty() { "auto" } else { configured };
    if choice == "none" {
        return None;
    }
    if choice != "auto" {
        return KNOWN.contains(&choice).then(|| choice.to_string());
    }
    for name in ["docker", "podman"] {
        if which(name).is_some() {
            return Some(name.to_string());
        }
    }
    if cfg!(target_os = "linux") {
        return Some("namespace".into());
    }
    if which("bwrap").is_some() {
        return Some("bwrap".into());
    }
    None
}

pub fn probe_script() -> String {
    "from pathlib import Path\nPath('sandbox-ok.txt').write_text('ok\\n')\nprint('idlehand-sandbox-ok')\n".into()
}

pub fn probe_command(runtime: &str) -> Vec<String> {
    let script = probe_script();
    if runtime == "docker" || runtime == "podman" {
        vec!["python".into(), "-c".into(), script]
    } else {
        vec!["/usr/bin/python3".into(), "-c".into(), script]
    }
}

pub fn prepare_host_command(argv: &[String], workspace: &Path) -> Result<Vec<String>, String> {
    if argv.is_empty() {
        return Err("empty command".into());
    }
    let workspace = workspace.canonicalize().unwrap_or_else(|_| workspace.to_path_buf());
    let mut raw = argv[0].clone();
    if !raw.starts_with('/') {
        let in_workspace = workspace.join(&raw);
        if in_workspace.exists() {
            let resolved = in_workspace.canonicalize().map_err(|e| e.to_string())?;
            let relative = resolved.strip_prefix(&workspace).map_err(|_| "refusing to run outside the sandbox".to_string())?;
            let mut mapped = vec![Path::new("/work").join(relative).to_string_lossy().to_string()];
            mapped.extend(argv[1..].iter().cloned());
            return Ok(mapped);
        }
        raw = which(&raw).map(|p| p.to_string_lossy().to_string()).ok_or_else(|| format!("{raw} was not found on PATH"))?;
    }
    let path = PathBuf::from(&raw);
    if path.exists() {
        if let Ok(resolved) = path.canonicalize() {
            if let Ok(relative) = resolved.strip_prefix(&workspace) {
                let mut mapped = vec![Path::new("/work").join(relative).to_string_lossy().to_string()];
                mapped.extend(argv[1..].iter().cloned());
                return Ok(mapped);
            }
        }
    }
    if raw.starts_with("/usr/") || raw.starts_with("/bin/") || raw.starts_with("/lib/") || raw.starts_with("/lib64/") {
        let mut mapped = vec![raw];
        mapped.extend(argv[1..].iter().cloned());
        return Ok(mapped);
    }
    Err(format!("refusing to run {raw} outside the sandbox"))
}

fn clean_env() -> std::collections::HashMap<String, String> {
    [
        ("PATH", "/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin"),
        ("HOME", "/tmp"),
        ("TMPDIR", "/tmp"),
        ("LANG", "C"),
    ]
    .into_iter()
    .map(|(k, v)| (k.to_string(), v.to_string()))
    .collect()
}

pub fn build_container_argv(runtime: &str, workspace: &Path, command: &[String], image: &str, memory: &str, cpus: &str) -> Vec<String> {
    let workspace = workspace.canonicalize().unwrap_or_else(|_| workspace.to_path_buf());
    let mut argv = vec![
        runtime.to_string(),
        "run".into(),
        "--rm".into(),
        "--network".into(),
        "none".into(),
        "--read-only".into(),
        "--cap-drop".into(),
        "ALL".into(),
        "--security-opt".into(),
        "no-new-privileges".into(),
        "--pids-limit".into(),
        "128".into(),
        "--memory".into(),
        memory.into(),
        "--cpus".into(),
        cpus.into(),
        "--user".into(),
        "65534:65534".into(),
        "--mount".into(),
        format!("type=bind,source={},target=/work", workspace.display()),
        "--workdir".into(),
        "/work".into(),
        "--tmpfs".into(),
        "/tmp:rw,noexec,nosuid,size=64m".into(),
        "-e".into(),
        "HOME=/tmp".into(),
        "-e".into(),
        "TMPDIR=/tmp".into(),
        "-e".into(),
        "PATH=/usr/local/bin:/usr/bin:/bin".into(),
        image.into(),
    ];
    argv.extend(command.iter().cloned());
    argv
}

pub fn build_bwrap_argv(workspace: &Path, command: &[String]) -> Vec<String> {
    let workspace = workspace.canonicalize().unwrap_or_else(|_| workspace.to_path_buf());
    let mut argv = vec![
        "bwrap".into(),
        "--unshare-all".into(),
        "--die-with-parent".into(),
        "--new-session".into(),
        "--ro-bind".into(),
        "/usr".into(),
        "/usr".into(),
        "--tmpfs".into(),
        "/tmp".into(),
        "--dev".into(),
        "/dev".into(),
        "--bind".into(),
        workspace.display().to_string(),
        "/work".into(),
        "--chdir".into(),
        "/work".into(),
        "--clearenv".into(),
        "--setenv".into(),
        "PATH".into(),
        "/usr/bin:/bin".into(),
        "--setenv".into(),
        "HOME".into(),
        "/tmp".into(),
        "--setenv".into(),
        "TMPDIR".into(),
        "/tmp".into(),
    ];
    for name in ["bin", "lib", "lib64"] {
        let host = Path::new("/").join(name);
        if host.symlink_metadata().map(|m| m.file_type().is_symlink()).unwrap_or(false) {
            if let Ok(link) = fs::read_link(&host) {
                argv.extend(["--symlink".into(), link.display().to_string(), format!("/{name}")]);
            }
        }
    }
    argv.push("--".into());
    argv.extend(command.iter().cloned());
    argv
}

fn refused(runtime: &str, reason: &str, argv: &[String]) -> SandboxResult {
    SandboxResult {
        runtime: if runtime.is_empty() { "none".into() } else { runtime.into() },
        invoked: false,
        ok: false,
        exit_code: None,
        stdout: String::new(),
        stderr: String::new(),
        reason: reason.into(),
        argv: argv.to_vec(),
    }
}

fn from_process(runtime: &str, argv: &[String], completed: &ProcOut) -> SandboxResult {
    let ok = completed.code == 0;
    let reason_source = if ok {
        "sandbox command finished".to_string()
    } else if !completed.stderr.trim().is_empty() {
        completed.stderr.trim().to_string()
    } else {
        format!("sandbox exited {}", completed.code)
    };
    let reason = reason_source.lines().next().unwrap_or("").chars().take(300).collect();
    SandboxResult {
        runtime: runtime.into(),
        invoked: true,
        ok,
        exit_code: Some(completed.code),
        stdout: completed.stdout.clone(),
        stderr: completed.stderr.clone(),
        reason,
        argv: argv.to_vec(),
    }
}

pub fn run_namespace(workspace: &Path, command: &[String], timeout: Duration) -> SandboxResult {
    if crate::home::is_symlink(workspace) {
        return refused("namespace", "refusing to follow a workspace symlink", command);
    }
    let mapped = match prepare_host_command(command, workspace) {
        Ok(mapped) => mapped,
        Err(err) => return refused("namespace", &err, command),
    };
    let exe = procutil::current_executable();
    let mut argv = vec![exe.to_string_lossy().to_string(), "jail".into(), "--workspace".into(), workspace.canonicalize().unwrap_or_else(|_| workspace.to_path_buf()).display().to_string(), "--".into()];
    argv.extend(mapped.iter().cloned());
    let completed = procutil::run_group(&argv, None, Some(clean_env()), timeout);
    let mut result = from_process("namespace", &mapped, &completed);
    if completed.code == 97 {
        result.invoked = false;
        let detail = if completed.stderr.trim().is_empty() {
            "sandbox setup failed".to_string()
        } else {
            completed.stderr.trim().lines().last().unwrap_or("sandbox setup failed").chars().take(300).collect()
        };
        result.reason = detail;
    }
    let _ = fs::remove_dir_all(format!("/tmp/idlehand-jail-{}", std::process::id()));
    result
}

pub fn run_external(runtime: &str, argv: &[String], timeout: Duration) -> SandboxResult {
    if argv.is_empty() {
        return refused(runtime, "empty command", argv);
    }
    let binary = which(&argv[0]);
    if binary.is_none() && !Path::new(&argv[0]).exists() {
        return refused(runtime, &format!("{runtime} is not on PATH"), argv);
    }
    let mut command = argv.to_vec();
    if let Some(binary) = binary {
        command[0] = binary.to_string_lossy().to_string();
    }
    let completed = procutil::run(&command, None, Some(clean_env()), timeout);
    if completed.code == 124 && completed.stderr.contains("timed out") {
        return SandboxResult {
            runtime: runtime.into(),
            invoked: true,
            ok: false,
            exit_code: None,
            stdout: String::new(),
            stderr: "sandbox timed out".into(),
            reason: "sandbox timed out".into(),
            argv: argv.to_vec(),
        };
    }
    from_process(runtime, argv, &completed)
}

pub fn run(workspace: &Path, command: &[String], runtime: &str, image: &str, memory: &str, cpus: &str, timeout: Duration) -> SandboxResult {
    let chosen = detect_runtime(runtime);
    let Some(chosen) = chosen else {
        let label = if KNOWN.contains(&runtime) { runtime } else { "none" };
        return refused(label, "no sandbox runtime is available; refused to run on the host", command);
    };
    let Some((image, memory, cpus)) = sandbox_limits(image, memory, cpus) else {
        return refused(&chosen, "sandbox limit is unreadable", command);
    };
    if crate::home::is_symlink(workspace) || workspace.parent().is_some_and(crate::home::is_symlink) {
        return refused(runtime, "refusing to follow a workspace symlink", command);
    }
    if let Err(err) = fs::create_dir_all(workspace) {
        return refused(&chosen, &err.to_string(), command);
    }
    if chosen == "namespace" {
        return run_namespace(workspace, command, timeout);
    }
    if chosen == "docker" || chosen == "podman" {
        let _ = fs::set_permissions(workspace, fs::Permissions::from(std::os::unix::fs::PermissionsExt::from_mode(0o777)));
        let argv = build_container_argv(&chosen, workspace, command, &image, &memory, &cpus);
        return run_external(&chosen, &argv, timeout);
    }
    if chosen == "bwrap" {
        let mapped = match prepare_host_command(command, workspace) {
            Ok(mapped) => mapped,
            Err(err) => return refused("bwrap", &err, command),
        };
        return run_external("bwrap", &build_bwrap_argv(workspace, &mapped), timeout);
    }
    refused("none", "sandbox runtime is unreadable", command)
}

#[allow(dead_code)]
fn _command_unused() {
    let _ = Command::new("true");
}
