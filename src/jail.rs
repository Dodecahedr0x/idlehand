//! Linux namespace jail. On other systems the command is refused.

use std::io::{self, Write};
use std::path::Path;

pub fn jail_main(args: &[String]) -> i32 {
    let Some(split) = args.iter().position(|arg| arg == "--") else {
        eprintln!("usage: idlehand jail --workspace PATH -- COMMAND...");
        return 2;
    };
    let options = &args[..split];
    let command = &args[split + 1..];
    if command.is_empty() {
        eprintln!("idlehand-sandbox-setup: missing command");
        return 97;
    }
    let workspace = match options.iter().position(|arg| arg == "--workspace").and_then(|index| options.get(index + 1)) {
        Some(path) => path,
        None => {
            eprintln!("idlehand-sandbox-setup: missing workspace");
            return 97;
        }
    };
    match enter_and_exec(Path::new(workspace), command) {
        Ok(()) => {
            eprintln!("idlehand-sandbox-setup: exec returned");
            97
        }
        Err(err) => {
            eprintln!("idlehand-sandbox-setup: {err}");
            97
        }
    }
}

#[cfg(not(target_os = "linux"))]
fn enter_and_exec(_workspace: &Path, _command: &[String]) -> Result<(), String> {
    Err("this system cannot create a namespace jail".into())
}

#[cfg(target_os = "linux")]
fn enter_and_exec(workspace: &Path, command: &[String]) -> Result<(), String> {
    linux::enter(workspace, command)
}

#[cfg(target_os = "linux")]
mod linux {
    use super::*;
    use std::fs::{self, File};
    use std::os::unix::fs::PermissionsExt;
    use std::process::Command;

    const MS_BIND: u64 = 4096;
    const MS_REC: u64 = 16384;
    const MS_RDONLY: u64 = 1;
    const MS_NOSUID: u64 = 2;
    const MS_NODEV: u64 = 4;
    const MS_NOEXEC: u64 = 8;
    const MS_REMOUNT: u64 = 32;
    const MS_PRIVATE: u64 = 1 << 18;
    const MNT_DETACH: i32 = 2;
    const PR_SET_NO_NEW_PRIVS: i32 = 38;
    const CLONE_NEWNS: i32 = 0x0002_0000;
    const CLONE_NEWUTS: i32 = 0x0400_0000;
    const CLONE_NEWIPC: i32 = 0x0800_0000;
    const CLONE_NEWUSER: i32 = 0x1000_0000;
    const CLONE_NEWPID: i32 = 0x2000_0000;
    const CLONE_NEWNET: i32 = 0x4000_0000;

    pub fn enter(workspace: &Path, command: &[String]) -> Result<(), String> {
        if crate::home::is_symlink(workspace) {
            return Err("refusing to follow a workspace symlink".into());
        }
        let workspace = workspace.canonicalize().map_err(|_| format!("workspace does not exist: {}", workspace.display()))?;
        if !workspace.is_dir() {
            return Err(format!("workspace does not exist: {}", workspace.display()));
        }
        let pivot = match std::env::consts::ARCH {
            "x86_64" => 155,
            "aarch64" => 41,
            "arm" => 218,
            _ => return Err(format!("no pivot_root syscall for {}", std::env::consts::ARCH)),
        };
        let uid = unsafe { libc::getuid() };
        let gid = unsafe { libc::getgid() };
        let jail = std::path::PathBuf::from(format!("/tmp/idlehand-jail-{}", std::process::id()));
        fs::create_dir(&jail).map_err(|err| err.to_string())?;
        let _ = fs::set_permissions(&jail, fs::Permissions::from_mode(0o700));
        let flags = CLONE_NEWUSER | CLONE_NEWNS | CLONE_NEWNET | CLONE_NEWIPC | CLONE_NEWUTS | CLONE_NEWPID;
        if unsafe { libc::unshare(flags) } != 0 {
            return Err(io::Error::last_os_error().to_string());
        }
        fs::write("/proc/self/setgroups", "deny").map_err(|err| err.to_string())?;
        fs::write("/proc/self/uid_map", format!("0 {uid} 1\n")).map_err(|err| err.to_string())?;
        fs::write("/proc/self/gid_map", format!("0 {gid} 1\n")).map_err(|err| err.to_string())?;
        raise_loopback()?;
        let child = unsafe { libc::fork() };
        if child < 0 {
            return Err("fork failed".into());
        }
        if child > 0 {
            let mut status = 0;
            unsafe { libc::waitpid(child, &mut status, 0) };
            let code = if libc::WIFEXITED(status) { libc::WEXITSTATUS(status) } else { 1 };
            std::process::exit(code);
        }
        mount(None, "/", None, MS_REC | MS_PRIVATE, None)?;
        mount(Some("tmpfs"), &jail.to_string_lossy(), Some("tmpfs"), MS_NOSUID | MS_NODEV, Some("size=512m"))?;
        stage_runtime(&jail, command)?;
        for name in ["work", "tmp", "var", "proc", "oldroot", "dev"] {
            fs::create_dir_all(jail.join(name)).ok();
        }
        mount(Some("proc"), &jail.join("proc").to_string_lossy(), Some("proc"), MS_NOSUID | MS_NODEV | MS_NOEXEC, None)?;
        fs::create_dir_all(jail.join("var/tmp")).ok();
        mount(Some("tmpfs"), &jail.join("tmp").to_string_lossy(), Some("tmpfs"), MS_NOSUID | MS_NODEV | MS_NOEXEC, Some("size=64m"))?;
        mount(Some("tmpfs"), &jail.join("var/tmp").to_string_lossy(), Some("tmpfs"), MS_NOSUID | MS_NODEV, Some("size=256m"))?;
        mount(Some(&workspace.to_string_lossy()), &jail.join("work").to_string_lossy(), None, MS_BIND, None)?;
        for device in ["null", "zero", "urandom"] {
            let target = jail.join("dev").join(device);
            File::create(&target).ok();
            mount(Some(&format!("/dev/{device}")), &target.to_string_lossy(), None, MS_BIND, None)?;
        }
        remount_readonly(&jail.join("usr"))?;
        std::env::set_current_dir(&jail).map_err(|err| err.to_string())?;
        let dot = std::ffi::CString::new(".").unwrap();
        let old = std::ffi::CString::new("oldroot").unwrap();
        let pivoted = unsafe { libc::syscall(pivot, dot.as_ptr(), old.as_ptr()) };
        if pivoted != 0 {
            return Err(format!("pivot_root failed: {}", io::Error::last_os_error()));
        }
        if unsafe { libc::chroot(dot.as_ptr()) } != 0 {
            return Err(io::Error::last_os_error().to_string());
        }
        std::env::set_current_dir("/").ok();
        let oldroot = std::ffi::CString::new("/oldroot").unwrap();
        if unsafe { libc::umount2(oldroot.as_ptr(), MNT_DETACH) } != 0 {
            return Err(format!("umount of old root failed: {}", io::Error::last_os_error()));
        }
        let _ = fs::remove_dir("/oldroot");
        std::env::set_current_dir("/work").ok();
        unsafe { libc::prctl(PR_SET_NO_NEW_PRIVS, 1, 0, 0, 0) };
        let program = std::ffi::CString::new(command[0].as_str()).map_err(|_| "bad command".to_string())?;
        let mut c_args: Vec<std::ffi::CString> = command.iter().map(|arg| std::ffi::CString::new(arg.as_str()).unwrap_or_default()).collect();
        let mut argv: Vec<*const libc::c_char> = c_args.iter_mut().map(|arg| arg.as_ptr()).collect();
        argv.push(std::ptr::null());
        let env_items = [
            std::ffi::CString::new("PATH=/usr/bin:/bin").unwrap(),
            std::ffi::CString::new("HOME=/home/idlehand").unwrap(),
            std::ffi::CString::new("TMPDIR=/var/tmp").unwrap(),
            std::ffi::CString::new("PYTHONDONTWRITEBYTECODE=1").unwrap(),
        ];
        let mut envp: Vec<*const libc::c_char> = env_items.iter().map(|item| item.as_ptr()).collect();
        envp.push(std::ptr::null());
        unsafe { libc::execve(program.as_ptr(), argv.as_ptr(), envp.as_ptr()) };
        Err(io::Error::last_os_error().to_string())
    }

    fn mount(src: Option<&str>, target: &str, fstype: Option<&str>, flags: u64, data: Option<&str>) -> Result<(), String> {
        let src_c = src.map(|value| std::ffi::CString::new(value).unwrap());
        let target_c = std::ffi::CString::new(target).unwrap();
        let type_c = fstype.map(|value| std::ffi::CString::new(value).unwrap());
        let data_c = data.map(|value| std::ffi::CString::new(value).unwrap());
        let result = unsafe {
            libc::mount(
                src_c.as_ref().map(|v| v.as_ptr()).unwrap_or(std::ptr::null()),
                target_c.as_ptr(),
                type_c.as_ref().map(|v| v.as_ptr()).unwrap_or(std::ptr::null()),
                flags,
                data_c.as_ref().map(|v| v.as_ptr() as *const libc::c_void).unwrap_or(std::ptr::null()),
            )
        };
        if result != 0 {
            Err(format!("mount {src:?} -> {target} failed: {}", io::Error::last_os_error()))
        } else {
            Ok(())
        }
    }

    fn remount_readonly(path: &Path) -> Result<(), String> {
        if !path.exists() || crate::home::is_symlink(path) {
            return Ok(());
        }
        let text = path.to_string_lossy().to_string();
        mount(Some(&text), &text, None, MS_BIND, None)?;
        mount(None, &text, None, MS_BIND | MS_REMOUNT | MS_RDONLY, None)
    }

    fn raise_loopback() -> Result<(), String> {
        let sock = unsafe { libc::socket(libc::AF_INET, libc::SOCK_DGRAM, 0) };
        if sock < 0 {
            return Err("loopback did not come up".into());
        }
        let mut request = [0u8; 40];
        request[..2].copy_from_slice(b"lo");
        let current = unsafe { libc::ioctl(sock, 0x8913, request.as_mut_ptr()) };
        if current < 0 {
            unsafe { libc::close(sock) };
            return Err(format!("loopback did not come up: {}", io::Error::last_os_error()));
        }
        let flags = u16::from_ne_bytes([request[16], request[17]]);
        let mut updated = [0u8; 40];
        updated[..2].copy_from_slice(b"lo");
        updated[16..18].copy_from_slice(&(flags | 1).to_ne_bytes());
        let result = unsafe { libc::ioctl(sock, 0x8914, updated.as_mut_ptr()) };
        unsafe { libc::close(sock) };
        if result < 0 {
            Err(format!("loopback did not come up: {}", io::Error::last_os_error()))
        } else {
            Ok(())
        }
    }

    fn stage_runtime(root: &Path, command: &[String]) -> Result<(), String> {
        let binary = Path::new(&command[0]);
        if !binary.is_absolute() {
            return Err("the jailed command must be an absolute path".into());
        }
        if binary.starts_with("/work") {
            return Ok(());
        }
        let text = binary.to_string_lossy();
        if !text.starts_with("/usr/") && !text.starts_with("/bin/") {
            return Err(format!("refusing to stage {text} from outside /usr or /bin"));
        }
        stage_lookup(root, binary, &mut std::collections::BTreeSet::new())?;
        let resolved = binary.canonicalize().unwrap_or_else(|_| binary.to_path_buf());
        for library in ldd_paths(&resolved) {
            stage_lookup(root, &library, &mut std::collections::BTreeSet::new())?;
        }
        if let Some(stdlib) = stdlib_path(if resolved.file_name().and_then(|n| n.to_str()).unwrap_or("").contains("python") {
            &resolved
        } else {
            binary
        }) {
            let destination = root.join(stdlib.strip_prefix("/").unwrap_or(&stdlib));
            let _ = Command::new("cp").args(["-a", &stdlib.to_string_lossy(), &destination.to_string_lossy()]).status();
            stage_git(root);
        }
        Ok(())
    }

    fn stage_git(root: &Path) {
        for program in [
            "/usr/bin/git", "/bin/sh", "/bin/bash", "/usr/bin/env", "/bin/cat", "/usr/bin/true", "/bin/false", "/bin/mkdir",
            "/bin/rm", "/usr/bin/touch", "/bin/ls", "/bin/sleep",
        ] {
            let _ = stage_lookup(root, Path::new(program), &mut std::collections::BTreeSet::new());
        }
    }

    fn stdlib_path(binary: &Path) -> Option<std::path::PathBuf> {
        let name = binary.file_name()?.to_str()?;
        if !name.contains("python") {
            return None;
        }
        let output = Command::new(binary)
            .arg("-c")
            .arg("import sysconfig; print(sysconfig.get_path('stdlib'))")
            .env_clear()
            .env("PATH", "/usr/bin:/bin")
            .env("PYTHONNOUSERSITE", "1")
            .env("HOME", "/tmp")
            .env("LANG", "C")
            .output()
            .ok()?;
        if !output.status.success() {
            return None;
        }
        let path = std::path::PathBuf::from(String::from_utf8_lossy(&output.stdout).trim());
        if path.is_dir() && path.starts_with("/usr/") { Some(path) } else { None }
    }

    fn ldd_paths(binary: &Path) -> Vec<std::path::PathBuf> {
        let output = Command::new("ldd").arg(binary).env_clear().env("PATH", "/usr/bin:/bin").env("LANG", "C").output().ok();
        let Some(output) = output else { return Vec::new() };
        let text = String::from_utf8_lossy(&output.stdout);
        let mut paths = Vec::new();
        for line in text.lines() {
            let line = line.trim();
            if let Some((_, right)) = line.split_once("=>") {
                let part = right.split_whitespace().next().unwrap_or("");
                if part.starts_with('/') {
                    paths.push(std::path::PathBuf::from(part));
                }
            } else if let Some(part) = line.split_whitespace().next() {
                if part.starts_with('/') {
                    paths.push(std::path::PathBuf::from(part));
                }
            }
        }
        paths
    }

    fn stage_lookup(root: &Path, path: &Path, seen: &mut std::collections::BTreeSet<String>) -> Result<(), String> {
        let path = std::path::PathBuf::from(path.components().collect::<std::path::PathBuf>());
        let key = path.display().to_string();
        if !seen.insert(key) {
            return Ok(());
        }
        let mut current = std::path::PathBuf::from("/");
        for part in path.components().skip(1) {
            current.push(part);
            let dest = root.join(current.strip_prefix("/").unwrap_or(&current));
            if current.is_symlink() {
                if let Some(parent) = dest.parent() {
                    fs::create_dir_all(parent).ok();
                }
                if let Ok(link) = fs::read_link(&current) {
                    if !dest.exists() && !dest.symlink_metadata().is_ok() {
                        let _ = std::os::unix::fs::symlink(&link, &dest);
                    }
                    let target = if link.is_absolute() { link } else { current.parent().unwrap_or(Path::new("/")).join(link) };
                    return stage_lookup(root, &target, seen);
                }
            }
            if current.is_dir() {
                if !crate::home::is_symlink(&dest) {
                    fs::create_dir_all(&dest).ok();
                }
                continue;
            }
            if current.is_file() {
                if let Some(parent) = dest.parent() {
                    fs::create_dir_all(parent).ok();
                }
                if !dest.exists() {
                    fs::copy(&current, &dest).map_err(|err| err.to_string())?;
                }
                return Ok(());
            }
            return Err(format!("cannot stage missing path {}", current.display()));
        }
        Ok(())
    }
}

#[allow(dead_code)]
fn _keep_write(err: &mut dyn Write) {
    let _ = err;
}
