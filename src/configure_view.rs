//! Paper, ink, and one accent for the configure screen.
//!
//! Indexed colors so a 16-color terminal can fall back toward white, black, and red:
//! paper `#ffffd7`, ink `#262626`, brick `#875f5f`.

use ratatui::layout::Rect;
use ratatui::style::{Color, Modifier, Style};
use ratatui::text::{Line, Span};
use ratatui::widgets::{Block, Paragraph};
use ratatui::Frame;
use toml::Value;

use crate::configure::{display_setting, fields_for, lookup, View, SECTIONS};

/// Warm paper. Falls back near white.
pub(crate) const PAPER: Color = Color::Indexed(230);
/// Brick accent for the selection bar and a rejected value. Falls back near red.
pub(crate) const ACCENT: Color = Color::Indexed(95);
/// Ink. Falls back near black.
const INK: Color = Color::Indexed(235);

const NAME_COLUMN: usize = 22;

const MENU_HINT: &str = "arrows or j/k move · enter opens · esc leaves · q or Done finishes";
const SECTION_HINT: &str = "arrows or j/k move · enter edits · s skips · esc leaves · q finishes";
const EDIT_HINT: &str = "enter commits · empty or skip keeps it · esc cancels";

pub(crate) struct Screen<'a> {
    pub view: View,
    pub config: &'a Value,
    pub menu_index: usize,
    pub section_index: usize,
    pub field_index: usize,
    pub buffer: &'a str,
    pub fresh: bool,
    pub notice: &'a str,
}

pub(crate) fn paint(frame: &mut Frame, screen: &Screen) {
    let area = frame.area();
    frame.render_widget(Block::new().style(sheet()), area);
    let page = inset(area);
    if page.width == 0 || page.height == 0 {
        return;
    }
    let (body, footer) = split_footer(page);
    let width = body.width as usize;
    let mut built = build(screen, width);
    let range = viewport(built.lines.len(), body.height as usize, &built.focus);
    if let Some(editor) = built.editor {
        if !range.contains(&editor.item) && range.contains(&editor.line) {
            let value = if screen.buffer.is_empty() {
                " "
            } else {
                screen.buffer
            };
            built.lines[editor.line] = place(editor.label, value, width, selected());
        }
    }
    if body.height > 0 && width > 0 {
        let lines: Vec<Line> = built
            .lines
            .into_iter()
            .skip(range.start)
            .take(range.len())
            .collect();
        frame.render_widget(Paragraph::new(lines).style(sheet()), body);
    }
    if footer.height > 0 && footer.width > 0 {
        let line = footer_line(screen, footer.width as usize);
        frame.render_widget(Paragraph::new(line).style(sheet()), footer);
    }
}

/// Value placed in the field when an edit opens. Empty subscription and host
/// lists show `none`. Booleans show `on` or `off`. Both round-trip through the parser.
pub(crate) fn edit_seed(config: &Value, key: &str) -> String {
    let shown = display_setting(config, key);
    match key {
        "subscription" | "peer_heuristic.allowed_hosts" | "peer_heuristic.blocked_hosts"
            if shown.is_empty() =>
        {
            "none".into()
        }
        _ => match lookup(config, key) {
            Some(Value::Boolean(true)) => "on".into(),
            Some(Value::Boolean(false)) => "off".into(),
            _ => shown,
        },
    }
}

fn sheet() -> Style {
    Style::default().fg(INK).bg(PAPER)
}

fn title() -> Style {
    sheet().add_modifier(Modifier::BOLD)
}

fn selected() -> Style {
    Style::default()
        .fg(PAPER)
        .bg(ACCENT)
        .add_modifier(Modifier::BOLD)
}

fn mark() -> Style {
    Style::default()
        .fg(PAPER)
        .bg(ACCENT)
        .add_modifier(Modifier::BOLD)
}

fn hint() -> Style {
    sheet().add_modifier(Modifier::DIM | Modifier::ITALIC)
}

fn rejected() -> Style {
    sheet().fg(ACCENT).add_modifier(Modifier::BOLD)
}

struct Editor {
    item: usize,
    line: usize,
    label: &'static str,
}

struct Built {
    lines: Vec<Line<'static>>,
    focus: Vec<usize>,
    editor: Option<Editor>,
}

fn build(screen: &Screen, width: usize) -> Built {
    if width == 0 {
        return Built {
            lines: Vec::new(),
            focus: Vec::new(),
            editor: None,
        };
    }
    match screen.view {
        View::Menu => menu(screen, width),
        View::Section | View::Edit => section(screen, width),
    }
}

fn menu(screen: &Screen, width: usize) -> Built {
    let mut lines = vec![Line::styled(pad("IdleHand", width), title())];
    let mut focus = Vec::new();
    for (index, (key, label)) in SECTIONS.iter().enumerate() {
        if index == screen.menu_index {
            focus.push(lines.len());
        }
        let style = if index == screen.menu_index {
            selected()
        } else {
            sheet()
        };
        lines.push(place(label, &summary(screen.config, key), width, style));
    }
    lines.push(Line::styled(pad("", width), sheet()));
    if screen.menu_index == SECTIONS.len() {
        focus.push(lines.len());
    }
    let style = if screen.menu_index == SECTIONS.len() {
        selected()
    } else {
        sheet()
    };
    lines.push(place("Done", "", width, style));
    if focus.is_empty() {
        focus.push(0);
    }
    Built {
        lines,
        focus,
        editor: None,
    }
}

fn section(screen: &Screen, width: usize) -> Built {
    let section_index = screen.section_index.min(SECTIONS.len().saturating_sub(1));
    let (key, label) = SECTIONS[section_index];
    let fields = fields_for(key);
    let mut lines = vec![Line::styled(pad(label, width), title())];
    let mut focus = Vec::new();
    let mut editor = None;
    if fields.is_empty() {
        focus.push(0);
        return Built {
            lines,
            focus,
            editor,
        };
    }
    let field_index = screen.field_index.min(fields.len() - 1);
    let editing = screen.view == View::Edit;
    for (index, field) in fields.iter().enumerate() {
        if index == field_index {
            focus.push(lines.len());
        }
        let style = if index == field_index {
            selected()
        } else {
            sheet()
        };
        lines.push(place(
            field_label(field),
            &edit_seed(screen.config, field),
            width,
            style,
        ));
        if index == field_index && editing {
            let line = lines.len();
            focus.push(line);
            lines.push(editor_line(screen.buffer, screen.fresh, width));
            editor = Some(Editor {
                item: line - 1,
                line,
                label: field_label(field),
            });
        }
    }
    Built {
        lines,
        focus,
        editor,
    }
}

fn summary(config: &Value, section: &str) -> String {
    match section {
        "subscription" => subscription_summary(config),
        "spending" => format!(
            "{} tokens",
            grouped(number(config, "spending_limit_tokens"))
        ),
        "rules" => rules_summary(config),
        "sandbox" => sandbox_summary(config),
        "publish" => publish_summary(config),
        "peers" => {
            let max = number(config, "peer_heuristic.max_peers");
            if max == 1 {
                "1 peer".into()
            } else {
                format!("{max} peers")
            }
        }
        _ => String::new(),
    }
}

fn subscription_summary(config: &Value) -> String {
    let name = display_setting(config, "subscription");
    let demo = flag(config, "demo");
    match (name.is_empty(), demo) {
        (true, false) => "none".into(),
        (true, true) => "demo".into(),
        (false, false) => name,
        (false, true) => format!("{name}, demo"),
    }
}

fn rules_summary(config: &Value) -> String {
    let flags = [
        ("rules.auto_start", "auto-start"),
        ("rules.allow_test", "test"),
        ("rules.allow_audit", "audit"),
        ("rules.allow_issues", "issues"),
        ("rules.allow_pull_requests", "pull requests"),
    ];
    let on: Vec<&str> = flags
        .iter()
        .filter(|(key, _)| flag(config, key))
        .map(|(_, name)| *name)
        .collect();
    if on.len() == flags.len() {
        "all on".into()
    } else if on.is_empty() {
        "all off".into()
    } else {
        on.join(", ")
    }
}

fn sandbox_summary(config: &Value) -> String {
    let runtime = {
        let value = display_setting(config, "sandbox.runtime");
        if value.is_empty() {
            "auto".into()
        } else {
            value
        }
    };
    if !flag(config, "sandbox.execute") {
        return format!("{runtime}, off");
    }
    let image = display_setting(config, "sandbox.image");
    if image.is_empty() {
        runtime
    } else {
        format!("{runtime}, {image}")
    }
}

fn publish_summary(config: &Value) -> String {
    if !flag(config, "publish.listen") {
        return "off".into();
    }
    let host = display_setting(config, "publish.host");
    let port = number(config, "publish.port");
    if host.is_empty() {
        port.to_string()
    } else {
        format!("{host}:{port}")
    }
}

fn field_label(key: &str) -> &'static str {
    match key {
        "subscription" => "subscription",
        "demo" => "demo",
        "spending_limit_tokens" => "token limit",
        "estimate_tokens_per_cycle" => "tokens per cycle",
        "loop_interval_seconds" => "interval seconds",
        "rules.auto_start" => "auto start",
        "rules.allow_test" => "test",
        "rules.allow_audit" => "audit",
        "rules.allow_issues" => "issues",
        "rules.allow_pull_requests" => "pull requests",
        "sandbox.runtime" => "runtime",
        "sandbox.execute" => "execute",
        "sandbox.image" => "image",
        "sandbox.memory" => "memory",
        "sandbox.cpus" => "cpus",
        "publish.listen" => "listen",
        "publish.host" => "host",
        "publish.port" => "port",
        "publish.peer_fetch_interval_seconds" => "fetch interval",
        "peer_heuristic.min_endorsements" => "min endorsements",
        "peer_heuristic.max_new_peers_per_cycle" => "new peers per cycle",
        "peer_heuristic.max_peers" => "max peers",
        "peer_heuristic.require_https" => "require https",
        "peer_heuristic.allow_insecure_loopback" => "insecure loopback",
        "peer_heuristic.allowed_hosts" => "allowed hosts",
        "peer_heuristic.blocked_hosts" => "blocked hosts",
        _ => "setting",
    }
}

fn editor_line(buffer: &str, fresh: bool, width: usize) -> Line<'static> {
    let name_w = name_column(width).min(width);
    let mut spans = Vec::new();
    if name_w > 0 {
        spans.push(Span::styled(" ".repeat(name_w), sheet()));
    }
    let rest = width - name_w;
    if rest == 0 {
        return Line::from(spans);
    }
    if fresh {
        let shown = if buffer.is_empty() {
            " ".to_string()
        } else {
            clip_ellipsis(buffer, rest)
        };
        let painted = shown.chars().count().min(rest);
        let shown = clip_end(&shown, painted);
        spans.push(Span::styled(shown, mark()));
        if rest > painted {
            spans.push(Span::styled(" ".repeat(rest - painted), sheet()));
        }
    } else {
        let room = rest.saturating_sub(1);
        let shown = clip_tail(buffer, room);
        let painted = shown.chars().count();
        spans.push(Span::styled(shown, sheet()));
        spans.push(Span::styled(" ", mark()));
        let filled = painted + 1;
        if rest > filled {
            spans.push(Span::styled(" ".repeat(rest - filled), sheet()));
        }
    }
    Line::from(spans)
}

fn footer_line(screen: &Screen, width: usize) -> Line<'static> {
    let (text, style) = if screen.notice.starts_with("rejected:") {
        (screen.notice, rejected())
    } else if !screen.notice.is_empty() {
        (screen.notice, hint())
    } else {
        let words = match screen.view {
            View::Menu => MENU_HINT,
            View::Section => SECTION_HINT,
            View::Edit => EDIT_HINT,
        };
        (words, hint())
    };
    Line::styled(pad(&clip_ellipsis(text, width), width), style)
}

fn place(name: &str, value: &str, width: usize, style: Style) -> Line<'static> {
    if width == 0 {
        return Line::from("");
    }
    let name_w = name_column(width);
    let label = clip_end(name, name_w.saturating_sub(1));
    let mut text = label;
    while text.chars().count() < name_w {
        text.push(' ');
    }
    let value_w = width.saturating_sub(text.chars().count());
    text.push_str(&clip_ellipsis(value, value_w));
    while text.chars().count() < width {
        text.push(' ');
    }
    if text.chars().count() > width {
        text = clip_end(&text, width);
    }
    Line::styled(text, style)
}

fn name_column(width: usize) -> usize {
    if width == 0 {
        0
    } else if width <= 16 {
        width / 2
    } else {
        NAME_COLUMN.min(width - 8)
    }
}

fn pad(text: &str, width: usize) -> String {
    let mut out = clip_end(text, width);
    while out.chars().count() < width {
        out.push(' ');
    }
    out
}

fn clip_end(text: &str, width: usize) -> String {
    text.chars().take(width).collect()
}

fn clip_tail(text: &str, width: usize) -> String {
    let count = text.chars().count();
    if count <= width {
        text.to_string()
    } else {
        text.chars().skip(count - width).collect()
    }
}

fn clip_ellipsis(text: &str, width: usize) -> String {
    if width == 0 {
        return String::new();
    }
    let count = text.chars().count();
    if count <= width {
        return text.to_string();
    }
    if width < 3 {
        return clip_end(text, width);
    }
    let mut out: String = text.chars().take(width - 3).collect();
    out.push_str("...");
    out
}

fn grouped(value: i64) -> String {
    let negative = value < 0;
    let digits = value.unsigned_abs().to_string();
    let mut out = String::new();
    for (index, ch) in digits.chars().rev().enumerate() {
        if index > 0 && index % 3 == 0 {
            out.push(',');
        }
        out.push(ch);
    }
    let mut text: String = out.chars().rev().collect();
    if negative {
        text.insert(0, '-');
    }
    text
}

fn number(config: &Value, key: &str) -> i64 {
    lookup(config, key).and_then(Value::as_integer).unwrap_or(0)
}

fn flag(config: &Value, key: &str) -> bool {
    lookup(config, key)
        .and_then(Value::as_bool)
        .unwrap_or(false)
}

fn inset(area: Rect) -> Rect {
    let mx = u16::from(area.width >= 8);
    let my = u16::from(area.height >= 6);
    Rect {
        x: area.x + mx,
        y: area.y + my,
        width: area.width.saturating_sub(mx * 2),
        height: area.height.saturating_sub(my * 2),
    }
}

fn split_footer(area: Rect) -> (Rect, Rect) {
    if area.height <= 1 {
        return (
            area,
            Rect {
                x: area.x,
                y: area.y,
                width: area.width,
                height: 0,
            },
        );
    }
    (
        Rect {
            x: area.x,
            y: area.y,
            width: area.width,
            height: area.height - 1,
        },
        Rect {
            x: area.x,
            y: area.y + area.height - 1,
            width: area.width,
            height: 1,
        },
    )
}

fn viewport(len: usize, height: usize, focus: &[usize]) -> std::ops::Range<usize> {
    if height == 0 || len == 0 {
        return 0..0;
    }
    let height = height.min(len);
    if focus.is_empty() {
        return 0..height;
    }
    let first = focus.iter().copied().min().unwrap().min(len - 1);
    let last = focus.iter().copied().max().unwrap().min(len - 1);
    if last < height {
        return 0..height;
    }
    let mut start = first.saturating_sub(1);
    if last >= start + height {
        start = last + 1 - height;
    }
    if start + height > len {
        start = len - height;
    }
    start..start + height
}
