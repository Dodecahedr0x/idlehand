//! Configuration screen for `idlehand configure`.
//!
//! The screen lists subscription, spending, rules, sandbox, publish, and peers,
//! plus Done. Arrows or j/k move, enter chooses, esc leaves a section, s skips
//! a value, and q or Done finishes. An edit opens with the current value
//! selected. Invalid values are rejected and not written. Done saves only when
//! something changed, and it does not start the node.
//! `run_configure_events` applies the same keys without opening a terminal.

use std::path::Path;

use crossterm::event::{Event, KeyCode, KeyEventKind, KeyModifiers};
use ratatui::Frame;
use toml::Value;

use crate::config::{load_config, save_config};
use crate::sandbox::sandbox_limits;

pub(crate) const SECTIONS: &[(&str, &str)] = &[
    ("subscription", "Subscription"),
    ("spending", "Spending"),
    ("rules", "Rules"),
    ("sandbox", "Sandbox"),
    ("publish", "Publish"),
    ("peers", "Peers"),
];

const SECTION_FIELDS: &[(&str, &[&str])] = &[
    ("subscription", &["subscription", "demo"]),
    (
        "spending",
        &[
            "spending_limit_tokens",
            "estimate_tokens_per_cycle",
            "loop_interval_seconds",
        ],
    ),
    (
        "rules",
        &[
            "rules.auto_start",
            "rules.allow_test",
            "rules.allow_audit",
            "rules.allow_issues",
            "rules.allow_pull_requests",
        ],
    ),
    (
        "sandbox",
        &[
            "sandbox.runtime",
            "sandbox.execute",
            "sandbox.image",
            "sandbox.memory",
            "sandbox.cpus",
        ],
    ),
    (
        "publish",
        &[
            "publish.listen",
            "publish.host",
            "publish.port",
            "publish.peer_fetch_interval_seconds",
        ],
    ),
    (
        "peers",
        &[
            "peer_heuristic.min_endorsements",
            "peer_heuristic.max_new_peers_per_cycle",
            "peer_heuristic.max_peers",
            "peer_heuristic.require_https",
            "peer_heuristic.allow_insecure_loopback",
            "peer_heuristic.allowed_hosts",
            "peer_heuristic.blocked_hosts",
        ],
    ),
];

pub fn setting_keys() -> &'static [&'static str] {
    &[
        "subscription",
        "demo",
        "spending_limit_tokens",
        "estimate_tokens_per_cycle",
        "loop_interval_seconds",
        "rules.auto_start",
        "rules.allow_test",
        "rules.allow_audit",
        "rules.allow_issues",
        "rules.allow_pull_requests",
        "sandbox.runtime",
        "sandbox.execute",
        "sandbox.image",
        "sandbox.memory",
        "sandbox.cpus",
        "publish.listen",
        "publish.host",
        "publish.port",
        "publish.peer_fetch_interval_seconds",
        "peer_heuristic.min_endorsements",
        "peer_heuristic.max_new_peers_per_cycle",
        "peer_heuristic.max_peers",
        "peer_heuristic.require_https",
        "peer_heuristic.allow_insecure_loopback",
        "peer_heuristic.allowed_hosts",
        "peer_heuristic.blocked_hosts",
    ]
}

pub const NEEDS_TERMINAL: &str = "configure needs a terminal";

const KEPT: &str = "keeping the stored value";

pub fn require_terminal(tty: bool) -> Result<(), &'static str> {
    if tty {
        Ok(())
    } else {
        Err(NEEDS_TERMINAL)
    }
}

/// Apply key events without drawing. `Ok` is the rejection text. The stream
/// must finish with q or Done; otherwise nothing is written.
pub fn run_configure_events(home: &Path, events: &[Key]) -> Result<String, String> {
    let _ = crate::config::ensure_home(home)?;
    let mut session = Session::new(load_config(home)?);
    let mut finished = false;
    for key in events {
        session.on_key(*key);
        if session.finished {
            finished = true;
            break;
        }
    }
    if !finished {
        return Err("configure cancelled".into());
    }
    if session.dirty {
        save_config(home, &session.config)?;
    }
    Ok(session.rejections.join("\n"))
}

/// Open the configuration screen. The caller has to check for a terminal first.
pub fn run_configure_tui(home: &Path) -> Result<(), String> {
    let _ = crate::config::ensure_home(home)?;
    let mut session = Session::new(load_config(home)?);
    let mut terminal = match ratatui::try_init() {
        Ok(terminal) => terminal,
        Err(err) => {
            ratatui::restore();
            return Err(err.to_string());
        }
    };
    let result = (|| -> Result<(), String> {
        loop {
            terminal
                .draw(|frame| session.draw(frame))
                .map_err(|err| err.to_string())?;
            let event = crossterm::event::read().map_err(|err| err.to_string())?;
            if let Event::Key(key) = event {
                if key.kind == KeyEventKind::Release {
                    continue;
                }
                if key.modifiers.contains(KeyModifiers::CONTROL) {
                    if matches!(key.code, KeyCode::Char('c' | 'C')) {
                        return Err("configure cancelled".into());
                    }
                    continue;
                }
                if key.modifiers.contains(KeyModifiers::ALT) {
                    continue;
                }
                if let Some(decoded) = decode_key(key.code) {
                    session.on_key(decoded);
                }
            }
            if session.finished {
                break;
            }
        }
        Ok(())
    })();
    ratatui::restore();
    result?;
    if session.dirty {
        save_config(home, &session.config)?;
    }
    Ok(())
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Key {
    Up,
    Down,
    Enter,
    Esc,
    Backspace,
    Char(char),
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum View {
    Menu,
    Section,
    Edit,
}

struct Session {
    config: Value,
    dirty: bool,
    view: View,
    menu_index: usize,
    section_index: usize,
    field_index: usize,
    buffer: String,
    fresh: bool,
    notice: String,
    rejections: Vec<String>,
    finished: bool,
}

impl Session {
    fn new(config: Value) -> Self {
        Self {
            config,
            dirty: false,
            view: View::Menu,
            menu_index: 0,
            section_index: 0,
            field_index: 0,
            buffer: String::new(),
            fresh: false,
            notice: String::new(),
            rejections: Vec::new(),
            finished: false,
        }
    }

    fn on_key(&mut self, key: Key) {
        if self.finished {
            return;
        }
        self.notice.clear();
        match self.view {
            View::Menu => self.on_menu(key),
            View::Section => self.on_section(key),
            View::Edit => self.on_edit(key),
        }
    }

    fn on_menu(&mut self, key: Key) {
        let last = SECTIONS.len();
        match key {
            Key::Up => self.menu_index = self.menu_index.saturating_sub(1),
            Key::Down => {
                if self.menu_index < last {
                    self.menu_index += 1;
                }
            }
            Key::Enter => {
                if self.menu_index == last {
                    self.finished = true;
                } else {
                    self.section_index = self.menu_index;
                    self.field_index = 0;
                    self.notice.clear();
                    self.view = View::Section;
                }
            }
            Key::Char(ch) => match ch.to_ascii_lowercase() {
                'k' => self.menu_index = self.menu_index.saturating_sub(1),
                'j' => {
                    if self.menu_index < last {
                        self.menu_index += 1;
                    }
                }
                'q' => self.finished = true,
                _ => {}
            },
            _ => {}
        }
    }

    fn on_section(&mut self, key: Key) {
        let count = fields_for(SECTIONS[self.section_index].0).len();
        if count == 0 {
            self.leave_section(key);
            return;
        }
        if self.field_index >= count {
            self.field_index = count - 1;
        }
        let last = count - 1;
        match key {
            Key::Up => self.field_index = self.field_index.saturating_sub(1),
            Key::Down => {
                if self.field_index < last {
                    self.field_index += 1;
                }
            }
            Key::Enter => {
                if let Some(key) = self.current_field() {
                    self.buffer = crate::configure_view::edit_seed(&self.config, key);
                    self.fresh = true;
                    self.view = View::Edit;
                }
            }
            Key::Char(ch) => match ch.to_ascii_lowercase() {
                'k' => self.field_index = self.field_index.saturating_sub(1),
                'j' => {
                    if self.field_index < last {
                        self.field_index += 1;
                    }
                }
                's' => self.notice = KEPT.into(),
                'q' => self.finished = true,
                _ => {}
            },
            Key::Esc => {
                self.notice.clear();
                self.view = View::Menu;
            }
            _ => {}
        }
    }

    fn leave_section(&mut self, key: Key) {
        if matches!(key, Key::Esc) {
            self.view = View::Menu;
        } else if matches!(key, Key::Char(ch) if ch.eq_ignore_ascii_case(&'q')) {
            self.finished = true;
        }
    }

    fn on_edit(&mut self, key: Key) {
        match key {
            Key::Char(ch) => {
                if self.fresh {
                    self.buffer.clear();
                    self.fresh = false;
                }
                self.buffer.push(ch);
            }
            Key::Backspace => {
                if self.fresh {
                    self.buffer.clear();
                    self.fresh = false;
                } else {
                    self.buffer.pop();
                }
            }
            Key::Esc => {
                self.buffer.clear();
                self.fresh = false;
                self.view = View::Section;
            }
            Key::Enter => self.commit_edit(),
            _ => {}
        }
    }

    fn commit_edit(&mut self) {
        let Some(key) = self.current_field() else {
            self.view = View::Section;
            return;
        };
        match parse_setting(key, self.buffer.trim()) {
            Ok(None) => {
                self.notice = KEPT.into();
                self.buffer.clear();
                self.fresh = false;
                self.view = View::Section;
            }
            Ok(Some(value)) => {
                if lookup(&self.config, key) != Some(&value) {
                    set_setting(&mut self.config, key, value);
                    self.dirty = true;
                }
                self.buffer.clear();
                self.fresh = false;
                self.view = View::Section;
            }
            Err(message) => {
                let text = format!("rejected: {message}");
                self.notice = text.clone();
                self.rejections.push(text);
                self.fresh = false;
            }
        }
    }

    fn current_field(&self) -> Option<&'static str> {
        fields_for(SECTIONS[self.section_index].0)
            .get(self.field_index)
            .copied()
    }

    fn draw(&self, frame: &mut Frame) {
        crate::configure_view::paint(
            frame,
            &crate::configure_view::Screen {
                view: self.view,
                config: &self.config,
                menu_index: self.menu_index,
                section_index: self.section_index,
                field_index: self.field_index,
                buffer: &self.buffer,
                fresh: self.fresh,
                notice: &self.notice,
            },
        );
    }
}

fn decode_key(code: KeyCode) -> Option<Key> {
    Some(match code {
        KeyCode::Up => Key::Up,
        KeyCode::Down => Key::Down,
        KeyCode::Enter => Key::Enter,
        KeyCode::Esc => Key::Esc,
        KeyCode::Backspace | KeyCode::Delete => Key::Backspace,
        KeyCode::Char(ch) => Key::Char(ch),
        _ => return None,
    })
}

pub(crate) fn fields_for(section: &str) -> &'static [&'static str] {
    SECTION_FIELDS
        .iter()
        .find(|(key, _)| *key == section)
        .map(|(_, fields)| *fields)
        .unwrap_or(&[])
}

pub fn display_setting(config: &Value, key: &str) -> String {
    match lookup(config, key) {
        Some(Value::String(text)) => text.clone(),
        Some(Value::Boolean(value)) => {
            if *value {
                "true".into()
            } else {
                "false".into()
            }
        }
        Some(Value::Integer(value)) => value.to_string(),
        Some(Value::Float(value)) => value.to_string(),
        Some(Value::Array(items)) => items
            .iter()
            .filter_map(Value::as_str)
            .collect::<Vec<_>>()
            .join(", "),
        _ => String::new(),
    }
}

pub(crate) fn lookup<'a>(config: &'a Value, key: &str) -> Option<&'a Value> {
    let mut cursor = config;
    for part in key.split('.') {
        cursor = cursor.get(part)?;
    }
    Some(cursor)
}

fn set_setting(config: &mut Value, key: &str, value: Value) {
    let parts: Vec<&str> = key.split('.').collect();
    let mut cursor = config;
    for part in &parts[..parts.len() - 1] {
        let table = cursor.as_table_mut().expect("config table");
        cursor = table.get_mut(*part).expect("nested table");
    }
    if let Some(table) = cursor.as_table_mut() {
        table.insert((*parts.last().unwrap()).to_string(), value);
    }
}

/// Apply form or menu updates. An empty answer or `skip` keeps the stored value.
/// `none` clears subscription and host lists. On any invalid value the returned
/// config is unchanged.
pub fn apply_updates(config: &Value, updates: &[(&str, &str)]) -> Result<Value, String> {
    let mut next = config.clone();
    for (key, raw) in updates {
        if !setting_keys().contains(key) {
            return Err(format!("unknown setting {key}"));
        }
        match parse_setting(key, raw.trim())? {
            Some(value) => set_setting(&mut next, key, value),
            None => {}
        }
    }
    Ok(next)
}

pub fn parse_setting(key: &str, raw: &str) -> Result<Option<Value>, String> {
    if raw.is_empty() || raw.eq_ignore_ascii_case("skip") {
        return Ok(None);
    }
    let value = match key {
        "subscription" => Value::String(parse_subscription(raw)?),
        "demo"
        | "rules.auto_start"
        | "rules.allow_test"
        | "rules.allow_audit"
        | "rules.allow_issues"
        | "rules.allow_pull_requests"
        | "sandbox.execute"
        | "publish.listen"
        | "peer_heuristic.require_https"
        | "peer_heuristic.allow_insecure_loopback" => {
            Value::Boolean(parse_bool(raw).ok_or_else(|| format!("{key} must be true or false"))?)
        }
        "spending_limit_tokens" => Value::Integer(parse_int(raw, 0, i64::MAX, key)?),
        "estimate_tokens_per_cycle" => Value::Integer(parse_int(raw, 1, i64::MAX, key)?),
        "peer_heuristic.min_endorsements"
        | "peer_heuristic.max_new_peers_per_cycle"
        | "peer_heuristic.max_peers" => Value::Integer(parse_int(raw, 0, i64::MAX, key)?),
        "publish.port" => Value::Integer(parse_int(raw, 0, 65535, key)?),
        "loop_interval_seconds" => parse_finite(raw, true)?,
        "publish.peer_fetch_interval_seconds" => parse_finite(raw, false)?,
        "sandbox.runtime" => Value::String(parse_runtime(raw)?),
        "sandbox.image" => Value::String(parse_image(raw)?),
        "sandbox.memory" => Value::String(parse_memory(raw)?),
        "sandbox.cpus" => Value::String(parse_cpus(raw)?),
        "publish.host" => {
            let host = raw.trim();
            if host.is_empty() {
                return Err("publish.host must be a non-empty string".into());
            }
            Value::String(host.to_string())
        }
        "peer_heuristic.allowed_hosts" | "peer_heuristic.blocked_hosts" => {
            Value::Array(parse_hosts(raw)?.into_iter().map(Value::String).collect())
        }
        _ => return Err(format!("unknown setting {key}")),
    };
    Ok(Some(value))
}

fn parse_subscription(raw: &str) -> Result<String, String> {
    if raw.eq_ignore_ascii_case("none") {
        return Ok(String::new());
    }
    if matches!(raw, "claude" | "codex" | "cursor") {
        return Ok(raw.to_string());
    }
    Err("subscription must be empty, claude, codex, cursor, or none".into())
}

pub fn parse_bool(raw: &str) -> Option<bool> {
    match raw.to_ascii_lowercase().as_str() {
        "1" | "true" | "yes" | "on" => Some(true),
        "0" | "false" | "no" | "off" => Some(false),
        _ => None,
    }
}

fn parse_int(raw: &str, min: i64, max: i64, key: &str) -> Result<i64, String> {
    let text = raw.trim();
    let digits = text.strip_prefix('+').unwrap_or(text);
    if digits.is_empty() || !digits.chars().all(|c| c.is_ascii_digit()) {
        return Err(format!("{key} must be an integer"));
    }
    let number: i64 = text
        .parse()
        .map_err(|_| format!("{key} must be an integer"))?;
    if number < min || number > max {
        return Err(format!("{key} is out of range"));
    }
    Ok(number)
}

fn parse_finite(raw: &str, strictly_positive: bool) -> Result<Value, String> {
    let number: f64 = raw
        .trim()
        .parse()
        .map_err(|_| "must be a finite number".to_string())?;
    if !number.is_finite() {
        return Err("must be a finite number".into());
    }
    if strictly_positive && number <= 0.0 {
        return Err("must be greater than 0".into());
    }
    if !strictly_positive && number < 0.0 {
        return Err("must be 0 or greater".into());
    }
    if !raw.contains(['.', 'e', 'E']) {
        if let Ok(integer) = raw.trim().parse::<i64>() {
            return Ok(Value::Integer(integer));
        }
    }
    Ok(Value::Float(number))
}

fn parse_runtime(raw: &str) -> Result<String, String> {
    if matches!(
        raw,
        "auto" | "none" | "docker" | "podman" | "namespace" | "bwrap"
    ) {
        Ok(raw.to_string())
    } else {
        Err("sandbox.runtime must be auto, none, docker, podman, namespace, or bwrap".into())
    }
}

fn parse_image(raw: &str) -> Result<String, String> {
    match sandbox_limits(raw, "512m", "1") {
        Some((image, _, _)) => Ok(image),
        None => Err("sandbox.image is not a plain image name".into()),
    }
}

fn parse_memory(raw: &str) -> Result<String, String> {
    match sandbox_limits("python:3.12-slim", raw, "1") {
        Some((_, memory, _)) => Ok(memory),
        None => Err("sandbox.memory is not a plain limit".into()),
    }
}

fn parse_cpus(raw: &str) -> Result<String, String> {
    match sandbox_limits("python:3.12-slim", "512m", raw) {
        Some((_, _, cpus)) => Ok(cpus),
        None => Err("sandbox.cpus is not a plain limit".into()),
    }
}

fn parse_hosts(raw: &str) -> Result<Vec<String>, String> {
    if raw.eq_ignore_ascii_case("none") {
        return Ok(Vec::new());
    }
    let mut hosts = Vec::new();
    for part in raw.split(',') {
        let host = part.trim();
        if host.is_empty()
            || host.chars().any(char::is_whitespace)
            || host.contains("://")
            || host.contains('@')
            || host.contains('/')
            || host.contains('?')
            || host.contains('#')
        {
            return Err("host lists are comma-separated hostnames".into());
        }
        hosts.push(host.to_string());
    }
    Ok(hosts)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::config::{ensure_home, load_config};

    fn feed(home: &Path, events: &[Key]) -> Result<String, String> {
        run_configure_events(home, events)
    }

    fn chars(text: &str) -> Vec<Key> {
        text.chars().map(Key::Char).collect()
    }

    fn render_text(session: &Session) -> String {
        let backend = ratatui::backend::TestBackend::new(80, 24);
        let mut terminal = ratatui::Terminal::new(backend).expect("test backend");
        terminal.draw(|frame| session.draw(frame)).expect("draw");
        let buffer = terminal.backend().buffer();
        let area = *buffer.area();
        let mut out = String::new();
        for y in 0..area.height {
            for x in 0..area.width {
                if let Some(cell) = buffer.cell((x, y)) {
                    out.push_str(cell.symbol());
                }
            }
            out.push('\n');
        }
        out
    }

    #[test]
    fn done_immediately_leaves_config_unchanged() {
        let home = std::env::temp_dir().join(format!("idlehand-cfg-skip-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&home);
        let before = ensure_home(&home).unwrap();
        let bytes = std::fs::read(home.join("config.toml")).unwrap();
        let mut events = vec![Key::Down; SECTIONS.len()];
        events.push(Key::Enter);
        feed(&home, &events).unwrap();
        let after = load_config(&home).unwrap();
        assert_eq!(before.to_string(), after.to_string());
        assert_eq!(bytes, std::fs::read(home.join("config.toml")).unwrap());
        let _ = std::fs::remove_dir_all(&home);
    }

    #[test]
    fn changing_subscription_and_limit_writes_only_those() {
        let home = std::env::temp_dir().join(format!("idlehand-cfg-set-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&home);
        ensure_home(&home).unwrap();
        let mut events = vec![Key::Enter, Key::Enter];
        events.extend(chars("claude"));
        events.extend([
            Key::Enter,
            Key::Down,
            Key::Char('s'),
            Key::Esc,
            Key::Down,
            Key::Enter,
            Key::Enter,
        ]);
        events.extend(chars("5000"));
        events.extend([
            Key::Enter,
            Key::Down,
            Key::Char('s'),
            Key::Down,
            Key::Char('s'),
            Key::Esc,
            Key::Char('q'),
        ]);
        feed(&home, &events).unwrap();
        let config = load_config(&home).unwrap();
        assert_eq!(
            config.get("subscription").and_then(Value::as_str),
            Some("claude")
        );
        assert_eq!(
            config
                .get("spending_limit_tokens")
                .and_then(Value::as_integer),
            Some(5000)
        );
        assert_eq!(
            config
                .get("estimate_tokens_per_cycle")
                .and_then(Value::as_integer),
            Some(2500)
        );
        assert_eq!(config.get("demo").and_then(Value::as_bool), Some(false));
        assert!(
            config
                .get("node_id")
                .and_then(Value::as_str)
                .unwrap_or("")
                .len()
                > 8
        );
        let _ = std::fs::remove_dir_all(&home);
    }

    #[test]
    fn invalid_value_is_rejected_and_not_saved() {
        let home = std::env::temp_dir().join(format!("idlehand-cfg-bad-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&home);
        ensure_home(&home).unwrap();
        let before = std::fs::read(home.join("config.toml")).unwrap();
        let mut events = vec![Key::Down, Key::Enter, Key::Enter];
        events.extend(chars("-1"));
        events.extend([Key::Enter, Key::Esc, Key::Char('q')]);
        let err = feed(&home, &events).unwrap();
        assert!(err.contains("rejected"), "{err}");
        assert_eq!(before, std::fs::read(home.join("config.toml")).unwrap());
        assert_eq!(
            load_config(&home)
                .unwrap()
                .get("spending_limit_tokens")
                .and_then(Value::as_integer),
            Some(10_000)
        );
        let _ = std::fs::remove_dir_all(&home);
    }

    #[test]
    fn configure_without_a_terminal_is_refused() {
        let err = require_terminal(false).unwrap_err();
        assert!(err.contains("terminal"));
        assert!(require_terminal(true).is_ok());
    }

    #[test]
    fn menu_and_section_show_keys_and_skip_node_id() {
        let mut session = Session::new(crate::config::default_config());
        let menu = render_text(&session);
        for word in [
            "IdleHand",
            "Subscription",
            "Spending",
            "Rules",
            "Sandbox",
            "Publish",
            "Peers",
            "Done",
            "none",
            "10,000 tokens",
            "j/k",
            "enter",
            "esc",
            "arrows",
            "q",
        ] {
            assert!(menu.contains(word), "{word} missing from menu:\n{menu}");
        }
        assert!(!menu.contains("node_id"), "{menu}");
        session.on_key(Key::Enter);
        let section = render_text(&session);
        for word in ["subscription", "demo", "skip", "esc", "j/k"] {
            assert!(
                section.contains(word),
                "{word} missing from section:\n{section}"
            );
        }
        assert!(!section.contains("node_id"), "{section}");
    }

    fn draw_size(session: &Session, width: u16, height: u16) -> ratatui::buffer::Buffer {
        let backend = ratatui::backend::TestBackend::new(width, height);
        let mut terminal = ratatui::Terminal::new(backend).expect("test backend");
        terminal.draw(|frame| session.draw(frame)).expect("draw");
        terminal.backend().buffer().clone()
    }

    fn row_text(buffer: &ratatui::buffer::Buffer, y: u16) -> String {
        let width = buffer.area().width;
        let mut out = String::new();
        for x in 0..width {
            if let Some(cell) = buffer.cell((x, y)) {
                out.push_str(cell.symbol());
            }
        }
        out
    }

    #[test]
    fn edit_opens_on_the_stored_value_and_enter_keeps_it() {
        let mut session = Session::new(crate::config::default_config());
        session.on_key(Key::Enter);
        session.on_key(Key::Enter);
        assert_eq!(session.buffer, "none");
        assert!(session.fresh);
        session.on_key(Key::Enter);
        assert!(!session.dirty);
        assert_eq!(session.view, View::Section);
        assert_eq!(display_setting(&session.config, "subscription"), "");

        session.on_key(Key::Esc);
        session.on_key(Key::Down);
        session.on_key(Key::Enter);
        session.on_key(Key::Enter);
        assert_eq!(session.buffer, "10000");
        let buffer = draw_size(&session, 80, 24);
        let text = (0..buffer.area().height)
            .map(|y| row_text(&buffer, y))
            .collect::<Vec<_>>()
            .join("\n");
        assert!(text.contains("10000"), "{text}");
        assert!(text.contains("token limit"), "{text}");
        assert!(text.contains("enter commits"), "{text}");
        let rows: Vec<u16> = (0..buffer.area().height)
            .filter(|y| row_text(&buffer, *y).contains("10000"))
            .collect();
        assert!(rows.len() >= 2, "{text}");
        let field = row_text(&buffer, rows[1]);
        let digit = field.find('1').expect("digit") as u16;
        assert_eq!(
            buffer.cell((digit, rows[1])).expect("field").bg,
            crate::configure_view::ACCENT
        );
        assert_eq!(
            buffer.cell((digit - 1, rows[1])).expect("gap").bg,
            crate::configure_view::PAPER
        );
    }

    #[test]
    fn selection_bar_spans_the_page_and_the_margin_stays_paper() {
        let session = Session::new(crate::config::default_config());
        let buffer = draw_size(&session, 80, 24);
        let paper = crate::configure_view::PAPER;
        let accent = crate::configure_view::ACCENT;
        assert_eq!(buffer.cell((0, 0)).expect("corner").bg, paper);
        assert_eq!(buffer.cell((1, 1)).expect("title").symbol(), "I");
        let mut selected = None;
        for y in 0..buffer.area().height {
            if row_text(&buffer, y).contains("Subscription") {
                selected = Some(y);
                break;
            }
        }
        let y = selected.expect("subscription row");
        for x in 1..79 {
            assert_eq!(buffer.cell((x, y)).expect("bar").bg, accent, "x={x}");
        }
        assert_eq!(buffer.cell((0, y)).expect("left").bg, paper);
        assert_eq!(buffer.cell((79, y)).expect("right").bg, paper);
        let mut hint_row = None;
        for row in 0..buffer.area().height {
            if row_text(&buffer, row).contains("arrows") {
                hint_row = Some(row);
            }
        }
        let hint = buffer
            .cell((1, hint_row.expect("hint")))
            .expect("hint cell");
        assert!(hint.modifier.contains(ratatui::style::Modifier::DIM));
        assert!(hint.modifier.contains(ratatui::style::Modifier::ITALIC));
    }

    #[test]
    fn short_terminal_keeps_the_selection_and_the_footer() {
        let session = Session::new(crate::config::default_config());
        let buffer = draw_size(&session, 40, 5);
        let text = (0..buffer.area().height)
            .map(|y| row_text(&buffer, y))
            .collect::<Vec<_>>()
            .join("\n");
        assert!(text.contains("Subscription"), "{text}");
        assert!(text.contains("arrows"), "{text}");
        let _ = draw_size(&session, 8, 2);
        let _ = draw_size(&session, 1, 1);
    }

    #[test]
    fn rejection_replaces_the_hint_until_the_next_key() {
        let mut session = Session::new(crate::config::default_config());
        session.on_key(Key::Down);
        session.on_key(Key::Enter);
        session.on_key(Key::Enter);
        session.on_key(Key::Char('-'));
        session.on_key(Key::Char('1'));
        session.on_key(Key::Enter);
        assert_eq!(session.buffer, "-1");
        let rejected_buffer = draw_size(&session, 80, 24);
        let rejected = (0..rejected_buffer.area().height)
            .map(|y| row_text(&rejected_buffer, y))
            .collect::<Vec<_>>()
            .join("\n");
        assert!(rejected.contains("rejected:"), "{rejected}");
        assert!(!rejected.contains("arrows"), "{rejected}");
        assert!(!rejected.contains("enter commits"), "{rejected}");
        let mut rejection_row = None;
        for y in 0..rejected_buffer.area().height {
            if row_text(&rejected_buffer, y).contains("rejected:") {
                rejection_row = Some(y);
            }
        }
        let rejection = rejected_buffer
            .cell((1, rejection_row.expect("rejection")))
            .expect("rejection cell");
        assert_eq!(rejection.fg, crate::configure_view::ACCENT);
        assert_eq!(rejection.bg, crate::configure_view::PAPER);
        session.on_key(Key::Backspace);
        let restored = render_text(&session);
        assert!(!restored.contains("rejected:"), "{restored}");
        assert!(restored.contains("esc"), "{restored}");
        assert!(!session.dirty);
    }
}
