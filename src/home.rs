//! IdleHand home directory, file lock, and TOML helpers.

use std::fs::{self, File, OpenOptions};
use std::io::{self, Write};
use std::os::unix::io::AsRawFd;
use std::path::{Component, Path, PathBuf};

use serde_json::Value as Json;
use toml::Value as Toml;

pub struct HomeLock {
    file: File,
}

impl HomeLock {
    pub fn acquire(home: &Path) -> io::Result<Self> {
        fs::create_dir_all(home)?;
        let file = OpenOptions::new()
            .create(true)
            .read(true)
            .write(true)
            .open(home.join(".lock"))?;
        let rc = unsafe { libc::flock(file.as_raw_fd(), libc::LOCK_EX) };
        if rc != 0 {
            return Err(io::Error::last_os_error());
        }
        Ok(Self { file })
    }
}

impl Drop for HomeLock {
    fn drop(&mut self) {
        unsafe {
            libc::flock(self.file.as_raw_fd(), libc::LOCK_UN);
        }
    }
}

pub fn resolve_home(explicit: Option<&str>) -> PathBuf {
    if let Some(value) = explicit.map(str::trim).filter(|value| !value.is_empty()) {
        return absolute_path(&expand_user(Path::new(value)));
    }
    if let Some(env) = std::env::var_os("IDLEHAND_HOME") {
        let text = env.to_string_lossy();
        if !text.trim().is_empty() {
            return absolute_path(&expand_user(Path::new(text.as_ref())));
        }
    }
    absolute_path(&home_dir().join(".idlehand"))
}

pub fn home_dir() -> PathBuf {
    std::env::var_os("HOME")
        .map(PathBuf::from)
        .filter(|path| !path.as_os_str().is_empty())
        .unwrap_or_else(|| PathBuf::from("/tmp"))
}

fn expand_user(path: &Path) -> PathBuf {
    let raw = path.to_string_lossy();
    if raw == "~" {
        return home_dir();
    }
    if let Some(rest) = raw.strip_prefix("~/") {
        return home_dir().join(rest);
    }
    path.to_path_buf()
}

fn absolute_path(path: &Path) -> PathBuf {
    let joined = if path.is_absolute() {
        path.to_path_buf()
    } else {
        std::env::current_dir()
            .unwrap_or_else(|_| PathBuf::from("/"))
            .join(path)
    };
    let mut out = PathBuf::new();
    for component in joined.components() {
        match component {
            Component::CurDir => {}
            Component::ParentDir => {
                out.pop();
            }
            other => out.push(other),
        }
    }
    if out.as_os_str().is_empty() {
        PathBuf::from("/")
    } else {
        out
    }
}

pub fn atomic_write(path: &Path, text: &str) -> io::Result<()> {
    if let Some(parent) = path.parent() {
        if !parent.as_os_str().is_empty() {
            fs::create_dir_all(parent)?;
        }
    }
    let temporary = tmp_sibling(path);
    if temporary
        .symlink_metadata()
        .map(|meta| meta.file_type().is_symlink())
        .unwrap_or(false)
    {
        fs::remove_file(&temporary)?;
    }
    {
        let mut file = OpenOptions::new()
            .create(true)
            .write(true)
            .truncate(true)
            .open(&temporary)?;
        file.write_all(text.as_bytes())?;
        file.sync_all()?;
    }
    fs::rename(&temporary, path)?;
    Ok(())
}

fn tmp_sibling(path: &Path) -> PathBuf {
    let name = path
        .file_name()
        .map(|value| value.to_string_lossy().to_string())
        .unwrap_or_else(|| "idlehand".into());
    let suffix = path
        .extension()
        .map(|ext| format!(".{ext}.tmp", ext = ext.to_string_lossy()))
        .unwrap_or_else(|| ".tmp".into());
    let stem = path
        .file_stem()
        .map(|value| value.to_string_lossy().to_string())
        .unwrap_or(name);
    // Python Path.with_suffix(suffix + ".tmp") replaces the existing suffix.
    // state.json -> state.json.tmp, and a suffix-less name becomes name.tmp.
    let file_name = if path.extension().is_some() {
        format!(
            "{stem}{suffix}",
            stem = path
                .file_stem()
                .map(|v| v.to_string_lossy().to_string())
                .unwrap_or(stem),
            suffix = format!(".{}.tmp", path.extension().unwrap().to_string_lossy())
        )
    } else {
        format!("{stem}.tmp")
    };
    match path.parent() {
        Some(parent) if !parent.as_os_str().is_empty() => parent.join(file_name),
        _ => PathBuf::from(file_name),
    }
}

pub fn read_toml(path: &Path) -> Result<Toml, String> {
    if !path.exists() {
        return Ok(Toml::Table(toml::map::Map::new()));
    }
    let text = fs::read_to_string(path).map_err(|err| err.to_string())?;
    let loaded: Toml = toml::from_str(&text).map_err(|err| err.to_string())?;
    if !loaded.is_table() {
        return Err(format!("{} must be a TOML table", path.display()));
    }
    Ok(loaded)
}

pub fn write_json(path: &Path, payload: &Json) -> io::Result<()> {
    let mut text = serde_json::to_string_pretty(payload).map_err(io::Error::other)?;
    text.push('\n');
    atomic_write(path, &text)
}

pub fn read_json(path: &Path) -> Result<Option<Json>, String> {
    let meta = match path.symlink_metadata() {
        Ok(meta) => meta,
        Err(err) if err.kind() == io::ErrorKind::NotFound => return Ok(None),
        Err(err) => return Err(err.to_string()),
    };
    if meta.file_type().is_symlink() {
        return Err("refusing to follow a symlink".into());
    }
    let text = fs::read_to_string(path).map_err(|err| err.to_string())?;
    serde_json::from_str(&text)
        .map(Some)
        .map_err(|err| err.to_string())
}

pub fn toml_string(value: &str) -> String {
    format!("\"{}\"", value.replace('\\', "\\\\").replace('"', "\\\""))
}

fn toml_scalar(value: &Toml) -> Result<String, String> {
    match value {
        Toml::Boolean(true) => Ok("true".into()),
        Toml::Boolean(false) => Ok("false".into()),
        Toml::Integer(value) => Ok(value.to_string()),
        Toml::Float(value) => Ok(format_float(*value)),
        Toml::String(value) => Ok(toml_string(value)),
        Toml::Array(items) => {
            if items.is_empty() {
                return Ok("[]".into());
            }
            let mut parts = Vec::new();
            for item in items {
                match item {
                    Toml::String(text) => parts.push(toml_string(text)),
                    _ => return Err("only lists of strings can be TOML inline arrays".into()),
                }
            }
            Ok(format!("[{}]", parts.join(", ")))
        }
        Toml::Datetime(value) => Ok(toml_string(&value.to_string())),
        other => Err(format!("cannot encode {other} as TOML")),
    }
}

fn format_float(value: f64) -> String {
    if !value.is_finite() {
        return "0".into();
    }
    let text = format!("{value}");
    if text.contains('.') || text.contains('e') || text.contains('E') {
        text
    } else {
        text
    }
}

fn is_array_of_tables(value: &Toml) -> bool {
    match value {
        Toml::Array(items) if !items.is_empty() => items.iter().all(|item| item.is_table()),
        _ => false,
    }
}

pub fn dump_toml(data: &Toml, header: &str) -> Result<String, String> {
    let table = data.as_table().ok_or("TOML root must be a table")?;
    let mut lines = Vec::new();
    if !header.is_empty() {
        lines.push(header.trim_end().to_string());
        lines.push(String::new());
    }
    let mut tables = Vec::new();
    let mut arrays = Vec::new();
    for (key, value) in table {
        if value.is_table() {
            tables.push((key, value));
        } else if is_array_of_tables(value) {
            arrays.push((key, value));
        } else {
            lines.push(format!("{key} = {}", toml_scalar(value)?));
        }
    }
    for (name, value) in tables {
        lines.push(String::new());
        lines.push(format!("[{name}]"));
        let nested = value.as_table().unwrap();
        for (key, item) in nested {
            if item.is_table() || is_array_of_tables(item) {
                return Err(format!("nested table {name}.{key} is not supported"));
            }
            lines.push(format!("{key} = {}", toml_scalar(item)?));
        }
    }
    for (name, value) in arrays {
        for row in value.as_array().unwrap() {
            lines.push(String::new());
            lines.push(format!("[[{name}]]"));
            let row = row.as_table().unwrap();
            for (key, item) in row {
                lines.push(format!("{key} = {}", toml_scalar(item)?));
            }
        }
    }
    lines.push(String::new());
    Ok(lines.join("\n"))
}

pub fn is_symlink(path: &Path) -> bool {
    path.symlink_metadata()
        .map(|meta| meta.file_type().is_symlink())
        .unwrap_or(false)
}

pub fn within(path: &Path, root: &Path) -> bool {
    let Ok(path) = std::fs::canonicalize(path) else {
        return false;
    };
    let Ok(root) = std::fs::canonicalize(root) else {
        return false;
    };
    path.starts_with(root)
}
