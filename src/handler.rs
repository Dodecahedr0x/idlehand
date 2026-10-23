//! Register the idlehand: URL scheme when the desktop environment allows it.

use std::fs;
use std::path::PathBuf;
use std::process::Command;
use std::time::Duration;

use crate::procutil::{self, which};

fn desktop_quote(value: &str) -> String {
    if value.chars().any(|c| c == ' ' || c == '\t' || c == '"') {
        format!("\"{}\"", value.replace('\\', "\\\\").replace('"', "\\\""))
    } else {
        value.to_string()
    }
}

pub fn handler_exec() -> String {
    if let Some(found) = which("idlehand") {
        return format!("{} %u", desktop_quote(&found.display().to_string()));
    }
    let exe = procutil::current_executable();
    format!("{} %u", desktop_quote(&exe.display().to_string()))
}

pub fn desktop_file_text() -> String {
    format!(
        "[Desktop Entry]\nName=IdleHand\nComment=Add repositories from an IdleHand link\nExec={}\nType=Application\nTerminal=false\nNoDisplay=true\nMimeType=x-scheme-handler/idlehand;\n",
        handler_exec()
    )
}

fn data_home() -> PathBuf {
    std::env::var_os("XDG_DATA_HOME")
        .map(PathBuf::from)
        .unwrap_or_else(|| crate::home::home_dir().join(".local/share"))
}

fn config_home() -> PathBuf {
    std::env::var_os("XDG_CONFIG_HOME")
        .map(PathBuf::from)
        .unwrap_or_else(|| crate::home::home_dir().join(".config"))
}

fn merge_mimeapps(path: &std::path::Path) -> Result<(), String> {
    let key = "x-scheme-handler/idlehand=idlehand.desktop";
    let existing = if path.exists() {
        fs::read_to_string(path).map_err(|e| e.to_string())?
    } else {
        String::new()
    };
    if existing.contains(key) {
        return Ok(());
    }
    let text = if existing.contains("[Default Applications]") {
        let mut updated = Vec::new();
        let mut inserted = false;
        for line in existing.lines() {
            updated.push(line.to_string());
            if line.trim() == "[Default Applications]" && !inserted {
                updated.push(key.to_string());
                inserted = true;
            }
        }
        let mut text = updated.join("\n");
        if !text.ends_with('\n') {
            text.push('\n');
        }
        text
    } else {
        let mut text = existing;
        if !text.is_empty() && !text.ends_with('\n') {
            text.push('\n');
        }
        text.push_str("[Default Applications]\n");
        text.push_str(key);
        text.push('\n');
        text
    };
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }
    fs::write(path, text).map_err(|e| e.to_string())
}

pub fn register_protocol_handler() -> String {
    if !cfg!(target_os = "linux") {
        return "not registered: protocol handlers are registered on Linux".into();
    }
    let result = (|| {
        let desktop_dir = data_home().join("applications");
        fs::create_dir_all(&desktop_dir).map_err(|e| e.to_string())?;
        fs::write(desktop_dir.join("idlehand.desktop"), desktop_file_text())
            .map_err(|e| e.to_string())?;
        merge_mimeapps(&config_home().join("mimeapps.list"))?;
        if let Some(xdg) = which("xdg-mime") {
            let _ = Command::new(xdg)
                .args(["default", "idlehand.desktop", "x-scheme-handler/idlehand"])
                .output();
            let _ = Duration::from_secs(5);
        }
        Ok::<(), String>(())
    })();
    match result {
        Ok(()) => "registered".into(),
        Err(err) => format!("not registered: {err}"),
    }
}
