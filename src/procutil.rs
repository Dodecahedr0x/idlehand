//! Small process helpers. The environment is either inherited or replaced whole.

use std::collections::HashMap;
use std::fs;
use std::io::{Read, Write};
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::thread;
use std::time::{Duration, Instant};

#[derive(Debug, Clone)]
pub struct ProcOut {
    pub code: i32,
    pub stdout: String,
    pub stderr: String,
}

pub fn which(name: &str) -> Option<PathBuf> {
    let path = std::env::var_os("PATH")?;
    for dir in std::env::split_paths(&path) {
        let candidate = dir.join(name);
        if is_executable(&candidate) {
            return Some(candidate);
        }
    }
    None
}

pub fn is_executable(path: &Path) -> bool {
    let Ok(meta) = fs::metadata(path) else {
        return false;
    };
    if !meta.is_file() {
        return false;
    }
    use std::os::unix::fs::PermissionsExt;
    meta.permissions().mode() & 0o111 != 0
}

pub fn run_inherited(argv: &[String], cwd: Option<&Path>, timeout: Duration) -> ProcOut {
    run(argv, cwd, None, timeout)
}

pub fn run(
    argv: &[String],
    cwd: Option<&Path>,
    env: Option<HashMap<String, String>>,
    timeout: Duration,
) -> ProcOut {
    if argv.is_empty() {
        return ProcOut {
            code: 127,
            stdout: String::new(),
            stderr: "empty command".into(),
        };
    }
    let mut command = Command::new(&argv[0]);
    command
        .args(&argv[1..])
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    if let Some(dir) = cwd {
        command.current_dir(dir);
    }
    if let Some(env) = env {
        command.env_clear();
        command.envs(env);
    }
    let mut child = match command.spawn() {
        Ok(child) => child,
        Err(_) => {
            return ProcOut {
                code: 127,
                stdout: String::new(),
                stderr: format!("{} is not installed", argv[0]),
            };
        }
    };
    let mut stdout = child.stdout.take().unwrap();
    let mut stderr = child.stderr.take().unwrap();
    let out_handle = thread::spawn(move || {
        let mut buf = Vec::new();
        let _ = stdout.read_to_end(&mut buf);
        String::from_utf8_lossy(&buf).into_owned()
    });
    let err_handle = thread::spawn(move || {
        let mut buf = Vec::new();
        let _ = stderr.read_to_end(&mut buf);
        String::from_utf8_lossy(&buf).into_owned()
    });
    let started = Instant::now();
    let status = loop {
        match child.try_wait() {
            Ok(Some(status)) => break status,
            Ok(None) if started.elapsed() >= timeout => {
                let _ = child.kill();
                let _ = child.wait();
                let _ = out_handle.join();
                let _ = err_handle.join();
                return ProcOut {
                    code: 124,
                    stdout: String::new(),
                    stderr: "timed out".into(),
                };
            }
            Ok(None) => thread::sleep(Duration::from_millis(20)),
            Err(_) => {
                let _ = child.kill();
                return ProcOut {
                    code: 127,
                    stdout: String::new(),
                    stderr: "could not wait for process".into(),
                };
            }
        }
    };
    let stdout = out_handle.join().unwrap_or_default();
    let stderr = err_handle.join().unwrap_or_default();
    ProcOut {
        code: status.code().unwrap_or(1),
        stdout,
        stderr,
    }
}

pub fn run_group(
    argv: &[String],
    cwd: Option<&Path>,
    env: Option<HashMap<String, String>>,
    timeout: Duration,
) -> ProcOut {
    if argv.is_empty() {
        return ProcOut {
            code: 127,
            stdout: String::new(),
            stderr: "empty command".into(),
        };
    }
    let mut command = Command::new(&argv[0]);
    command
        .args(&argv[1..])
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    if let Some(dir) = cwd {
        command.current_dir(dir);
    }
    if let Some(env) = env {
        command.env_clear();
        command.envs(env);
    }
    #[cfg(unix)]
    {
        use std::os::unix::process::CommandExt;
        command.process_group(0);
    }
    let mut child = match command.spawn() {
        Ok(child) => child,
        Err(err) => {
            return ProcOut {
                code: 127,
                stdout: String::new(),
                stderr: err.to_string(),
            };
        }
    };
    let mut stdout = child.stdout.take().unwrap();
    let mut stderr = child.stderr.take().unwrap();
    let out_handle = thread::spawn(move || {
        let mut buf = Vec::new();
        let _ = stdout.read_to_end(&mut buf);
        String::from_utf8_lossy(&buf).into_owned()
    });
    let err_handle = thread::spawn(move || {
        let mut buf = Vec::new();
        let _ = stderr.read_to_end(&mut buf);
        String::from_utf8_lossy(&buf).into_owned()
    });
    let started = Instant::now();
    let pid = child.id() as i32;
    let status = loop {
        match child.try_wait() {
            Ok(Some(status)) => break Some(status),
            Ok(None) if started.elapsed() >= timeout => {
                unsafe {
                    libc::killpg(pid, libc::SIGKILL);
                }
                let _ = child.wait();
                let _ = out_handle.join();
                let _ = err_handle.join();
                return ProcOut {
                    code: 124,
                    stdout: String::new(),
                    stderr: "sandbox timed out".into(),
                };
            }
            Ok(None) => thread::sleep(Duration::from_millis(20)),
            Err(_) => break None,
        }
    };
    let stdout = out_handle.join().unwrap_or_default();
    let stderr = err_handle.join().unwrap_or_default();
    ProcOut {
        code: status.and_then(|status| status.code()).unwrap_or(1),
        stdout,
        stderr,
    }
}

pub fn write_executable(path: &Path, body: &str) -> std::io::Result<()> {
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent)?;
    }
    let mut file = fs::File::create(path)?;
    file.write_all(body.as_bytes())?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let mut perms = file.metadata()?.permissions();
        perms.set_mode(0o755);
        fs::set_permissions(path, perms)?;
    }
    Ok(())
}

pub fn current_executable() -> PathBuf {
    std::env::current_exe().unwrap_or_else(|_| PathBuf::from("idlehand"))
}
