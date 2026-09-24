use super::{
    Action, App, COMMANDS, Focus, Hits,
    composer::{clip, safe_text, wrap},
};
use ratatui::{
    Frame,
    layout::Rect,
    style::{Color, Modifier, Style},
    text::Span,
    widgets::{Block, BorderType, Borders, Clear, Paragraph},
};
use unicode_segmentation::UnicodeSegmentation;
use unicode_width::UnicodeWidthStr;

fn dim() -> Style {
    Style::default().fg(Color::DarkGray)
}
fn accent() -> Style {
    Style::default().fg(Color::Cyan)
}
fn row(frame: &mut Frame, area: Rect, text: impl Into<String>, style: Style) {
    if area.width > 0 && area.height > 0 {
        frame.render_widget(
            Paragraph::new(clip(&safe_text(&text.into()), area.width as usize)).style(style),
            Rect::new(area.x, area.y, area.width, 1),
        );
    }
}
fn hit(app: &mut App, area: Rect, action: Action) {
    if area.width > 0 && area.height > 0 {
        app.hits.actions.push((area, action));
    }
}
fn status_style(status: &str, connected: bool) -> Style {
    if !connected {
        return dim();
    }
    Style::default().fg(match status {
        "blocked" | "unknown" | "starting" => Color::Yellow,
        "working" => Color::Cyan,
        "waiting" | "done" => Color::Green,
        "failed" => Color::Red,
        _ => Color::Reset,
    })
}

pub(super) fn draw(frame: &mut Frame, app: &mut App) {
    app.hits = Hits::default();
    let area = frame.area();
    app.narrow = area.width < 80;
    if area.width == 0 || area.height == 0 {
        return;
    }
    let body = Rect::new(area.x, area.y, area.width, area.height.saturating_sub(1));
    let footer = Rect::new(area.x, area.bottom().saturating_sub(1), area.width, 1);
    let nav = app.sidebar && (!app.narrow || app.focus != Focus::Composer);
    let content = !app.narrow || !nav;
    let mut main = body;
    if nav {
        let width = if content {
            app.sidebar_width.min(body.width.saturating_sub(2))
        } else {
            body.width
        };
        let sidebar = Rect::new(
            body.x,
            body.y + u16::from(content && body.height > 0),
            width.saturating_sub(u16::from(content)),
            body.height.saturating_sub(u16::from(content)),
        );
        sidebar_view(frame, app, sidebar);
        if content {
            let x = body.x + width;
            app.hits.divider = Rect::new(x.saturating_sub(1), body.y, 2, body.height);
            for y in body.y..body.bottom() {
                row(
                    frame,
                    Rect::new(x, y, 1, 1),
                    "│",
                    if app.dragging { accent() } else { dim() },
                );
            }
            main = Rect::new(
                x + 1,
                body.y,
                body.width.saturating_sub(width + 1),
                body.height,
            );
        }
    }
    if content {
        main_view(frame, app, main);
    }
    footer_view(frame, app, footer);
    if app.help {
        help(frame, app, area);
    } else if app.picker.is_some() {
        picker(frame, app, area);
    }
}

fn sidebar_view(frame: &mut Frame, app: &mut App, area: Rect) {
    app.hits.sidebar = area;
    if area.height == 0 || area.width == 0 {
        return;
    }
    let room_count = app.rooms.len();
    let room_height = if app.rooms_folded {
        0
    } else {
        room_count.min((area.height / 2).saturating_sub(1).max(1) as usize)
    };
    let heading = format!(" {} Rooms", if app.rooms_folded { "▸" } else { "▾" });
    row(
        frame,
        Rect::new(area.x, area.y, area.width, 1),
        heading,
        accent(),
    );
    app.room_cursor = app.room_cursor.min(room_count.saturating_sub(1));
    if app.room_cursor < app.room_offset {
        app.room_offset = app.room_cursor;
    }
    if room_height > 0 && app.room_cursor >= app.room_offset + room_height {
        app.room_offset = app.room_cursor + 1 - room_height;
    }
    let rooms: Vec<_> = app
        .rooms
        .iter()
        .skip(app.room_offset)
        .take(room_height)
        .cloned()
        .collect();
    for (index, room) in rooms.into_iter().enumerate() {
        let y = area.y + 1 + index as u16;
        if y >= area.bottom() {
            break;
        }
        let selected = app.focus == Focus::Rooms && app.room_cursor == index + app.room_offset;
        let active = room == app.room;
        let attention = app
            .members
            .values()
            .filter(|m| m.room == room && (m.attention || m.status == "blocked"))
            .count();
        let label = format!(
            "{}   {}{}",
            if active { "▎" } else { " " },
            room,
            if attention > 0 {
                format!("  !{attention}")
            } else {
                String::new()
            }
        );
        let style = if selected {
            Style::default().bg(Color::DarkGray)
        } else if active {
            Style::default().add_modifier(Modifier::BOLD)
        } else {
            Style::default()
        };
        let rect = Rect::new(area.x, y, area.width, 1);
        row(frame, rect, label, style);
        hit(app, rect, Action::Room(room));
    }
    let separator = area.y + 1 + room_height as u16;
    if separator < area.bottom() {
        row(
            frame,
            Rect::new(area.x, separator, area.width, 1),
            "─".repeat(area.width as usize),
            dim(),
        );
    }
    let agents_y = separator + 1;
    if agents_y >= area.bottom() {
        return;
    }
    row(
        frame,
        Rect::new(area.x, agents_y, area.width, 1),
        format!(" Agents · {}", app.room),
        accent(),
    );
    let agents = app.local_agents();
    let available = area.bottom().saturating_sub(agents_y + 1) as usize;
    let rows = if available >= 4 { 2 } else { 1 };
    let count = available / rows;
    app.agent_cursor = app.agent_cursor.min(agents.len().saturating_sub(1));
    if app.agent_cursor < app.agent_offset {
        app.agent_offset = app.agent_cursor;
    }
    if count > 0 && app.agent_cursor >= app.agent_offset + count {
        app.agent_offset = app.agent_cursor + 1 - count;
    }
    if agents.is_empty() && available > 0 {
        row(
            frame,
            Rect::new(area.x, agents_y + 1, area.width, 1),
            " No agents in this room",
            dim(),
        );
        if available > 1 {
            let rect = Rect::new(area.x, agents_y + 2, area.width, 1);
            row(frame, rect, " + /new or /bind", dim());
            hit(app, rect, Action::New);
        }
    }
    for (index, name) in agents.iter().skip(app.agent_offset).take(count).enumerate() {
        let member = &app.members[name];
        let y = agents_y + 1 + (index * rows) as u16;
        let selected = app.focus == Focus::Agents && app.agent_cursor == app.agent_offset + index;
        let style = if selected {
            Style::default().bg(Color::DarkGray)
        } else {
            status_style(&member.status, member.connected && app.hub.is_some())
        };
        let marker = if member.attention || member.status == "blocked" {
            "!"
        } else if member.connected {
            "·"
        } else {
            "○"
        };
        let local = if app.bindings.contains_key(name) {
            "local"
        } else {
            "remote"
        };
        let label = format!(" {marker} {name}");
        let metadata = format!(
            "   {}{} · {local}{}",
            if app.hub.is_none() { "stale · " } else { "" },
            if member.connected {
                member.status.as_str()
            } else {
                "offline"
            },
            member
                .reason
                .as_ref()
                .map(|r| format!(" · {r}"))
                .unwrap_or_default()
        );
        let rect = Rect::new(area.x, y, area.width, rows as u16);
        row(
            frame,
            rect,
            if rows == 1 {
                format!("{label} · {}", member.status)
            } else {
                label
            },
            style,
        );
        if rows == 2 {
            row(
                frame,
                Rect::new(area.x, y + 1, area.width, 1),
                metadata,
                if selected { style } else { dim() },
            );
        }
        hit(app, rect, Action::Agent(name.clone()));
    }
}

fn main_view(frame: &mut Frame, app: &mut App, area: Rect) {
    if area.height == 0 || area.width == 0 {
        return;
    }
    let connected = app.hub.is_some();
    let title = format!(
        " banda  / {}{}",
        app.room,
        if connected {
            ""
        } else {
            "  [offline · stale]"
        }
    );
    row(
        frame,
        Rect::new(area.x, area.y, area.width, 1),
        title,
        Style::default().add_modifier(Modifier::BOLD),
    );
    let padding = if app.narrow { 1 } else { 2 };
    let inner = Rect::new(
        area.x + padding.min(area.width),
        area.y + 1,
        area.width.saturating_sub(2 * padding),
        area.height.saturating_sub(1),
    );
    if inner.width == 0 || inner.height == 0 {
        return;
    }
    if app.detail.is_some() {
        detail_view(frame, app, inner);
        return;
    }
    let text = app.state().draft.text.clone();
    let cursor = app.state().draft.cursor;
    let (draft_lines, cursor_line, cursor_column) =
        composer_lines(&text, cursor, inner.width as usize);
    let composer_height = (draft_lines.len().max(1) as u16)
        .min(6)
        .min(inner.height.saturating_sub(2).max(1));
    let notice_height = if inner.height >= 5 { 2 } else { 0 };
    let files_height = u16::from(
        !app.state().files.is_empty() && inner.height > composer_height + notice_height + 2,
    );
    let transcript_height = inner
        .height
        .saturating_sub(composer_height + notice_height + files_height + 1);
    let transcript = Rect::new(inner.x, inner.y, inner.width, transcript_height);
    transcript_view(frame, app, transcript);
    let mut y = inner.y + transcript_height;
    if notice_height > 0 {
        let pending = if app.state().pending {
            "Sending · draft retained · "
        } else {
            ""
        };
        let text = format!("{pending}{}", app.notice);
        let lines = wrap(&safe_text(&text), inner.width as usize);
        for (index, text) in lines.into_iter().take(notice_height as usize).enumerate() {
            row(
                frame,
                Rect::new(inner.x, y + index as u16, inner.width, 1),
                text,
                Style::default().fg(if app.notice_error {
                    Color::Red
                } else if app.state().pending {
                    Color::Yellow
                } else {
                    Color::DarkGray
                }),
            );
        }
        y += notice_height;
    }
    if files_height > 0 {
        let names: Vec<_> = app.state().files.iter().map(|m| m.name.as_str()).collect();
        row(
            frame,
            Rect::new(inner.x, y, inner.width, 1),
            format!("Files: {} · /detach-files", names.join(", ")),
            Style::default().fg(Color::Yellow),
        );
        y += 1;
    }
    let attention = app
        .members
        .values()
        .filter(|m| m.room == app.room && (m.attention || m.status == "blocked"))
        .map(|m| m.name.as_str())
        .collect::<Vec<_>>();
    let label = if !attention.is_empty() {
        format!("! {} need attention · /read NAME", attention.join(", "))
    } else if let Some(directed) = text.trim_start().strip_prefix('@') {
        format!(
            "To @{} · Enter sends work",
            directed.split_whitespace().next().unwrap_or("")
        )
    } else {
        format!(
            "{} → {} · Enter send · Alt+Enter newline",
            app.name, app.room
        )
    };
    row(
        frame,
        Rect::new(inner.x, y, inner.width, 1),
        label,
        if attention.is_empty() {
            accent()
        } else {
            Style::default().fg(Color::Yellow)
        },
    );
    y += 1;
    if y >= inner.bottom() {
        return;
    }
    let composer_area = Rect::new(
        inner.x,
        y,
        inner.width,
        composer_height.min(inner.bottom() - y),
    );
    hit(app, composer_area, Action::Composer);
    let start = cursor_line.saturating_sub(composer_area.height.saturating_sub(1) as usize);
    for (index, line) in draft_lines
        .iter()
        .skip(start)
        .take(composer_area.height as usize)
        .enumerate()
    {
        row(
            frame,
            Rect::new(
                composer_area.x,
                composer_area.y + index as u16,
                composer_area.width,
                1,
            ),
            line.clone(),
            Style::default(),
        );
    }
    if app.focus == Focus::Composer && app.picker.is_none() && !app.help {
        frame.set_cursor_position((
            composer_area.x + (cursor_column as u16).min(composer_area.width.saturating_sub(1)),
            composer_area.y + (cursor_line - start) as u16,
        ));
    }
}

fn transcript_view(frame: &mut Frame, app: &mut App, area: Rect) {
    app.hits.transcript = area;
    app.scroll_height = area.height as usize;
    let mut lines: Vec<(String, usize, String, Style)> = Vec::new();
    let state = app.state();
    let history_status = if !state.history_loaded {
        "Loading room history…"
    } else if state.history_limit {
        "Recent history: hub returns at most 500 messages; earlier gaps may remain after reconnect."
    } else {
        "Room history"
    };
    for (i, text) in wrap(history_status, area.width as usize)
        .into_iter()
        .enumerate()
    {
        lines.push(("__history".into(), i, text, dim()));
    }
    for message in &state.messages {
        let mut offset = 0;
        let time = message.ts.get(11..19).unwrap_or(&message.ts);
        let target = message
            .to
            .as_ref()
            .map(|to| format!(" → {to}"))
            .unwrap_or_default();
        let header = safe_text(&format!(
            "{}{}  {} · {}",
            message.from.name, target, time, message.kind
        ));
        for text in wrap(&header, area.width as usize) {
            lines.push((
                message.id.clone(),
                offset,
                text,
                if message.from.name == app.name {
                    Style::default().fg(Color::Green)
                } else {
                    accent()
                },
            ));
            offset += 1;
        }
        for text in wrap(&safe_text(&message.text), area.width as usize) {
            lines.push((
                message.id.clone(),
                offset,
                text,
                if message.kind == "system" {
                    dim()
                } else {
                    Style::default()
                },
            ));
            offset += 1;
        }
        for media in &message.media {
            for text in wrap(
                &safe_text(&format!(
                    "  [{} · {} bytes] {}",
                    media.name, media.size, media.url
                )),
                area.width as usize,
            ) {
                lines.push((
                    message.id.clone(),
                    offset,
                    text,
                    Style::default().fg(Color::Yellow),
                ));
                offset += 1;
            }
        }
        lines.push((message.id.clone(), offset, String::new(), Style::default()));
    }
    let bottom = lines.len().saturating_sub(area.height as usize);
    let top = state
        .anchor
        .as_ref()
        .and_then(|(id, offset)| {
            lines
                .iter()
                .position(|(key, index, _, _)| key == id && index == offset)
        })
        .unwrap_or(bottom)
        .min(bottom);
    app.scroll_top = top;
    app.scroll_keys = lines
        .iter()
        .map(|(id, offset, _, _)| (id.clone(), *offset))
        .collect();
    for (index, (_, _, text, style)) in lines
        .into_iter()
        .skip(top)
        .take(area.height as usize)
        .enumerate()
    {
        row(
            frame,
            Rect::new(area.x, area.y + index as u16, area.width, 1),
            text,
            style,
        );
    }
}

fn detail_view(frame: &mut Frame, app: &mut App, area: Rect) {
    let detail = app.detail.as_ref().unwrap();
    let name = detail.name.clone();
    let member = app.members.get(&name);
    let local = app.bindings.get(&name);
    let status = member
        .map(|m| {
            format!(
                "{} · {}{}",
                m.status,
                if app.hub.is_none() {
                    "stale; viewer offline"
                } else if m.connected {
                    "executor online"
                } else {
                    "executor offline"
                },
                m.reason
                    .as_ref()
                    .map(|r| format!(" · {r}"))
                    .unwrap_or_default()
            )
        })
        .unwrap_or_else(|| "No live roster entry".into());
    let location = local
        .map(|b| format!("local · terminal {} · {}", b.terminal_id, b.cwd.display()))
        .unwrap_or_else(|| "remote · hub screen only; no local terminal binding".into());
    let metadata = [format!("Agent {name} · {status}"), location];
    let mut y = area.y;
    for text in metadata {
        if y >= area.bottom() {
            return;
        }
        row(frame, Rect::new(area.x, y, area.width, 1), text, dim());
        y += 1;
    }
    if y >= area.bottom() {
        return;
    }
    let actions = [
        (" Esc room ", Action::Back),
        (" r read ", Action::Read(name.clone())),
        (" s seen ", Action::Seen(name.clone())),
    ];
    let mut x = area.x;
    for (label, action) in actions {
        let width = (UnicodeWidthStr::width(label) as u16).min(area.right().saturating_sub(x));
        let rect = Rect::new(x, y, width, 1);
        row(frame, rect, label, accent());
        hit(app, rect, action);
        x += width;
    }
    if app.bindings.contains_key(&name) {
        let rect = Rect::new(x, y, area.right().saturating_sub(x), 1);
        row(frame, rect, " t terminal ", accent());
        hit(app, rect, Action::Attach(name.clone()));
    }
    y += 1;
    let notice_height = area.bottom().saturating_sub(y).min(2);
    let notice_y = area.bottom().saturating_sub(notice_height);
    for (index, text) in wrap(&safe_text(&app.notice), area.width as usize)
        .into_iter()
        .take(notice_height as usize)
        .enumerate()
    {
        row(
            frame,
            Rect::new(area.x, notice_y + index as u16, area.width, 1),
            text,
            Style::default().fg(if app.notice_error {
                Color::Red
            } else {
                Color::DarkGray
            }),
        );
    }
    let detail = app.detail.as_mut().unwrap();
    let lines = wrap(
        if detail.loading {
            "Reading screen… (room navigation remains available)"
        } else if detail.text.is_empty() {
            "Screen returned no visible text."
        } else {
            &detail.text
        },
        area.width as usize,
    );
    let viewport = Rect::new(area.x, y, area.width, notice_y.saturating_sub(y));
    app.hits.transcript = viewport;
    app.scroll_height = viewport.height as usize;
    detail.scroll = detail
        .scroll
        .min(lines.len().saturating_sub(viewport.height as usize));
    for (index, text) in lines
        .into_iter()
        .skip(detail.scroll)
        .take(viewport.height as usize)
        .enumerate()
    {
        row(
            frame,
            Rect::new(viewport.x, viewport.y + index as u16, viewport.width, 1),
            text,
            Style::default(),
        );
    }
}

fn footer_view(frame: &mut Frame, app: &mut App, area: Rect) {
    let toggle = Rect::new(area.x, area.y, area.width.min(4), 1);
    row(
        frame,
        toggle,
        if app.sidebar && (!app.narrow || app.focus != Focus::Composer) {
            " «« "
        } else {
            " »» "
        },
        dim(),
    );
    hit(app, toggle, Action::Toggle);
    let mut x = toggle.right();
    let connection = if app.hub.is_none() {
        app.connection.clone()
    } else if app.connected_room.as_ref() != Some(&app.room) {
        "Loading room…".into()
    } else {
        "Connected".into()
    };
    let status_width =
        (UnicodeWidthStr::width(connection.as_str()) as u16).min(area.width.saturating_sub(4));
    let status_x = area.right().saturating_sub(status_width);
    for (label, action) in [
        (" ^P pick ", Action::Palette),
        (" F1 help ", Action::Help),
        (" new ", Action::New),
        (" bind ", Action::Bind),
    ] {
        let width = UnicodeWidthStr::width(label) as u16;
        if x + width + 2 > status_x {
            break;
        }
        let rect = Rect::new(x, area.y, width, 1);
        row(frame, rect, label, dim());
        hit(app, rect, action);
        x += width;
    }
    row(
        frame,
        Rect::new(status_x, area.y, status_width, 1),
        connection,
        Style::default().fg(if app.hub.is_some() {
            Color::Green
        } else {
            Color::Yellow
        }),
    );
}

fn modal(
    frame: &mut Frame,
    app: &mut App,
    area: Rect,
    title: &str,
    width: u16,
    height: u16,
) -> Rect {
    let width = width.min(area.width);
    let height = height.min(area.height);
    let outer = Rect::new(
        area.x + (area.width - width) / 2,
        area.y + (area.height - height) / 2,
        width,
        height,
    );
    app.hits.actions.clear();
    app.hits.modal = Some(outer);
    frame.render_widget(Clear, outer);
    let block = Block::default()
        .borders(Borders::ALL)
        .border_type(BorderType::Rounded)
        .border_style(accent())
        .title(Span::styled(title.to_owned(), dim()));
    let inner = block.inner(outer);
    frame.render_widget(block, outer);
    inner
}

fn help(frame: &mut Frame, app: &mut App, area: Rect) {
    let inner = modal(frame, app, area, " banda · help · Esc closes ", 88, 34);
    let mut lines = vec![
        "ROOMS FIRST · conversation and agent execution are separate".to_owned(),
        "Enter sends · Alt+Enter / Ctrl+J newline · paste preserves multiline text".into(),
        "Left/Right/Backspace/Delete edit whole Unicode graphemes".into(),
        "Home/End, Ctrl+A/E line edges · Ctrl+U clears current input".into(),
        "Tab / Shift+Tab cycles Rooms → Agents → Composer".into(),
        "Ctrl+B sidebar toggle · below 80 cells it switches focused panel".into(),
        "Sidebar: ↑↓ / j k select · Enter activates · space folds Rooms".into(),
        "Ctrl+P room/agent/command picker · F1 help · Esc back/focus".into(),
        "PageUp/PageDown scroll; wheel scrolls pane under pointer".into(),
        "Click rooms/agents/actions · drag divider to 24–48 columns".into(),
        "Agent screen: r refresh · s seen · i compose to agent · t local terminal".into(),
        "Terminal: native herdr detach returns here; leaving banda does not stop agents".into(),
        "Ctrl+Q / Ctrl+C quits viewer (not a signal forwarded to agents)".into(),
        "@ExactName TEXT directs work · @auto TEXT asks hub to route".into(),
        "Unknown targets are rejected. Plain room messages do not start agents.".into(),
        "Read is passive. Seen and terminal controls are explicit owner actions.".into(),
        "Send failures may be uncertain; inspect history before retrying.".into(),
        "Hub history is limited to 500 records per refresh; no invented transcript.".into(),
        String::new(),
    ];
    lines.extend(
        COMMANDS
            .iter()
            .map(|(command, help)| format!("{command}  — {help}")),
    );
    lines.push("/attach PATH is an alias for /attach-file, never terminal attach.".into());
    let wrapped: Vec<_> = lines
        .iter()
        .flat_map(|s| wrap(s, inner.width as usize))
        .collect();
    app.help_scroll = app
        .help_scroll
        .min(wrapped.len().saturating_sub(inner.height as usize));
    for (index, text) in wrapped
        .into_iter()
        .skip(app.help_scroll)
        .take(inner.height as usize)
        .enumerate()
    {
        row(
            frame,
            Rect::new(inner.x, inner.y + index as u16, inner.width, 1),
            text,
            Style::default(),
        );
    }
}

fn picker(frame: &mut Frame, app: &mut App, area: Rect) {
    let inner = modal(
        frame,
        app,
        area,
        " Pick room, agent, command · Esc closes ",
        76,
        18,
    );
    if inner.width == 0 || inner.height == 0 {
        return;
    }
    let choices = app.choices();
    let picker = app.picker.as_mut().unwrap();
    picker.selected = picker.selected.min(choices.len().saturating_sub(1));
    let query = format!("> {}", picker.query.text);
    row(
        frame,
        Rect::new(inner.x, inner.y, inner.width, 1),
        query,
        accent(),
    );
    let cursor_width = UnicodeWidthStr::width(&picker.query.text[..picker.query.cursor]) + 2;
    frame.set_cursor_position((
        inner.x + (cursor_width as u16).min(inner.width.saturating_sub(1)),
        inner.y,
    ));
    let selected = picker.selected;
    let available = inner.height.saturating_sub(2) as usize;
    let offset = selected.saturating_sub(available.saturating_sub(1));
    for (index, (label, _)) in choices.into_iter().enumerate().skip(offset).take(available) {
        let rect = Rect::new(
            inner.x,
            inner.y + 2 + (index - offset) as u16,
            inner.width,
            1,
        );
        row(
            frame,
            rect,
            label,
            if index == selected {
                Style::default().bg(Color::DarkGray)
            } else {
                Style::default()
            },
        );
        hit(app, rect, Action::Picker(index));
    }
}

fn composer_lines(text: &str, cursor: usize, width: usize) -> (Vec<String>, usize, usize) {
    let width = width.max(1);
    let mut lines = vec![String::new()];
    let mut cells = 0;
    let mut caret = (0, 0);
    for (index, grapheme) in text.grapheme_indices(true) {
        if grapheme == "\n" {
            if index == cursor {
                caret = (lines.len() - 1, cells);
            }
            lines.push(String::new());
            cells = 0;
            continue;
        }
        let grapheme = if grapheme == "\t" { "    " } else { grapheme };
        let size = UnicodeWidthStr::width(grapheme);
        if cells > 0 && cells + size > width {
            lines.push(String::new());
            cells = 0;
        }
        if index == cursor {
            caret = (lines.len() - 1, cells);
        }
        lines.last_mut().unwrap().push_str(grapheme);
        cells += size;
    }
    if cursor == text.len() {
        if cells >= width {
            lines.push(String::new());
            cells = 0;
        }
        caret = (lines.len() - 1, cells);
    }
    (lines, caret.0, caret.1)
}
