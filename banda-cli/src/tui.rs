mod composer;
mod session;
mod view;

use crate::{
    bridge::{self, Binding, LaunchOptions},
    config::Config,
    hub::{Hub, HubEvent},
    media,
    model::{Media, Member, RoomMessage},
};
use anyhow::{Context, Result, bail};
use composer::{Composer, safe_text};
use crossterm::{
    cursor,
    event::{
        self, DisableBracketedPaste, DisableMouseCapture, EnableBracketedPaste, EnableMouseCapture,
        Event, KeyCode, KeyEvent, KeyEventKind, KeyModifiers, MouseButton, MouseEventKind,
    },
    execute,
    terminal::{self, EnterAlternateScreen, LeaveAlternateScreen},
};
use ratatui::{Terminal, backend::CrosstermBackend, layout::Rect};
use serde_json::{Value, json};
use std::{
    collections::{BTreeMap, BTreeSet, HashSet},
    io::{self, IsTerminal},
    path::PathBuf,
    time::Duration,
};
use tokio::{
    sync::{mpsc, watch},
    task::{JoinHandle, JoinSet},
};

const COMMANDS: &[(&str, &str)] = &[
    ("/help", "Keys and all commands"),
    ("/room ROOM", "Switch room; keep draft and scroll"),
    ("/say TEXT", "Literal room message, even starting @ or /"),
    ("/read NAME", "Read real agent screen without attaching"),
    ("/wait NAME", "Wait for agent readiness in background"),
    ("/seen NAME", "Explicitly clear agent attention"),
    ("/cancel NAME", "Send escape to agent"),
    ("/keys NAME KEY...", "Explicit terminal key input"),
    ("/attach-file PATH", "Upload a file into this room's draft"),
    ("/detach-files", "Remove files from draft"),
    (
        "/terminal NAME",
        "Attach local herdr terminal; detach returns here",
    ),
    ("/new NAME KIND [cwd]", "Launch and publish a local agent"),
    ("/bind NAME TARGET", "Publish an existing local herdr agent"),
    ("/rooms", "Focus room navigation"),
    ("/agents", "Focus room-local agents"),
    ("/quit", "Leave viewer; agents keep running"),
];

#[derive(Clone, Copy, PartialEq, Eq)]
enum Focus {
    Rooms,
    Agents,
    Composer,
}

#[derive(Default)]
struct RoomState {
    messages: Vec<RoomMessage>,
    ids: HashSet<String>,
    draft: Composer,
    files: Vec<Media>,
    pending: bool,
    anchor: Option<(String, usize)>,
    history_loaded: bool,
    history_limit: bool,
}

struct Detail {
    name: String,
    text: String,
    loading: bool,
    scroll: usize,
}
struct Picker {
    query: Composer,
    selected: usize,
}
#[derive(Clone)]
enum Choice {
    Room(String),
    Agent(String),
    Command(String),
}
#[derive(Clone)]
enum Action {
    Toggle,
    Help,
    Palette,
    Room(String),
    Agent(String),
    Composer,
    Read(String),
    Attach(String),
    Back,
    New,
    Bind,
    Seen(String),
    Picker(usize),
}
#[derive(Default)]
struct Hits {
    actions: Vec<(Rect, Action)>,
    sidebar: Rect,
    transcript: Rect,
    divider: Rect,
    modal: Option<Rect>,
}

enum UiEvent {
    Snapshot(session::Snapshot),
    Hub(HubEvent),
    Offline(String),
    Send {
        room: String,
        revision: u64,
        result: std::result::Result<Value, String>,
    },
    Read {
        name: String,
        result: std::result::Result<String, String>,
    },
    Notice(std::result::Result<String, String>),
    Files {
        room: String,
        result: std::result::Result<Vec<Media>, String>,
    },
    Bindings(std::result::Result<Vec<Binding>, String>),
    Launched(std::result::Result<Binding, String>),
}

struct App {
    config: Config,
    name: String,
    room: String,
    rooms: BTreeSet<String>,
    members: BTreeMap<String, Member>,
    states: BTreeMap<String, RoomState>,
    bindings: BTreeMap<String, Binding>,
    hub: Option<Hub>,
    connected_room: Option<String>,
    connection: String,
    focus: Focus,
    sidebar: bool,
    sidebar_width: u16,
    dragging: bool,
    room_cursor: usize,
    agent_cursor: usize,
    room_offset: usize,
    agent_offset: usize,
    rooms_folded: bool,
    detail: Option<Detail>,
    picker: Option<Picker>,
    help: bool,
    help_scroll: usize,
    notice: String,
    notice_error: bool,
    hits: Hits,
    narrow: bool,
    scroll_keys: Vec<(String, usize)>,
    scroll_top: usize,
    scroll_height: usize,
    attach: Option<String>,
    quit: bool,
    tx: mpsc::Sender<UiEvent>,
    room_tx: watch::Sender<String>,
    jobs: JoinSet<()>,
}

impl App {
    fn new(
        config: Config,
        room: String,
        name: String,
        tx: mpsc::Sender<UiEvent>,
        room_tx: watch::Sender<String>,
    ) -> Self {
        Self {
            config,
            name,
            room: room.clone(),
            rooms: BTreeSet::from([room.clone()]),
            members: BTreeMap::new(),
            states: BTreeMap::from([(room, RoomState::default())]),
            bindings: BTreeMap::new(),
            hub: None,
            connected_room: None,
            connection: "Connecting…".into(),
            focus: Focus::Composer,
            sidebar: true,
            sidebar_width: 32,
            dragging: false,
            room_cursor: 0,
            agent_cursor: 0,
            room_offset: 0,
            agent_offset: 0,
            rooms_folded: false,
            detail: None,
            picker: None,
            help: false,
            help_scroll: 0,
            notice:
                "Ordinary text stays in the room. @Name sends work; @auto asks the hub to route."
                    .into(),
            notice_error: false,
            hits: Hits::default(),
            narrow: false,
            scroll_keys: vec![],
            scroll_top: 0,
            scroll_height: 0,
            attach: None,
            quit: false,
            tx,
            room_tx,
            jobs: JoinSet::new(),
        }
    }
    fn state(&self) -> &RoomState {
        &self.states[&self.room]
    }
    fn state_mut(&mut self) -> &mut RoomState {
        self.states.entry(self.room.clone()).or_default()
    }
    fn note(&mut self, text: impl Into<String>, error: bool) {
        self.notice = text.into();
        self.notice_error = error;
    }
    fn local_agents(&self) -> Vec<String> {
        self.members
            .values()
            .filter(|m| m.room == self.room && m.kind == "agent")
            .map(|m| m.name.clone())
            .collect()
    }
    fn remember_room(&mut self, room: String) {
        if self.rooms.contains(&room) {
            return;
        }
        let selected = self.rooms.iter().nth(self.room_cursor).cloned();
        self.rooms.insert(room);
        if let Some(selected) = selected {
            self.room_cursor = self.rooms.iter().position(|r| r == &selected).unwrap_or(0);
        }
    }
    fn switch_room(&mut self, room: String) {
        if room.is_empty() {
            self.note("Room name cannot be empty", true);
            return;
        }
        self.rooms.insert(room.clone());
        self.states.entry(room.clone()).or_default();
        self.room = room.clone();
        self.detail = None;
        self.focus = Focus::Composer;
        self.agent_cursor = 0;
        self.agent_offset = 0;
        self.room_cursor = self.rooms.iter().position(|r| r == &room).unwrap_or(0);
        self.room_tx.send_replace(room);
    }
    fn merge(&mut self, message: RoomMessage) {
        self.remember_room(message.room.clone());
        let state = self.states.entry(message.room.clone()).or_default();
        if state.ids.insert(message.id.clone()) {
            let at = state
                .messages
                .partition_point(|m| (&m.ts, &m.id) <= (&message.ts, &message.id));
            state.messages.insert(at, message);
        }
    }
    fn members(&mut self, members: Vec<Member>) {
        let selected = self.local_agents().get(self.agent_cursor).cloned();
        for m in &members {
            self.remember_room(m.room.clone());
        }
        self.members = members.into_iter().map(|m| (m.name.clone(), m)).collect();
        let agents = self.local_agents();
        self.agent_cursor = selected
            .and_then(|name| agents.iter().position(|n| n == &name))
            .unwrap_or(self.agent_cursor.min(agents.len().saturating_sub(1)));
    }
    fn event(&mut self, event: UiEvent) {
        match event {
            UiEvent::Snapshot(s) => {
                self.hub = Some(s.hub);
                self.connected_room = Some(s.room.clone());
                self.connection = "Connected".into();
                for r in s.rooms {
                    self.remember_room(r.room);
                }
                self.members(s.members);
                let limit = s.messages.len() >= 500;
                for message in s.messages {
                    self.merge(message);
                }
                let state = self.states.entry(s.room).or_default();
                state.history_loaded = true;
                state.history_limit = limit;
            }
            UiEvent::Hub(event) => match event.name.as_str() {
                "room/message" | "agents/message" => match serde_json::from_value(event.data) {
                    Ok(message) => self.merge(message),
                    Err(error) => self.note(format!("Invalid live message: {error}"), true),
                },
                "agents/changed" => match serde_json::from_value(
                    event.data.get("members").cloned().unwrap_or(Value::Null),
                ) {
                    Ok(members) => self.members(members),
                    Err(error) => self.note(format!("Invalid live roster: {error}"), true),
                },
                _ => {}
            },
            UiEvent::Offline(error) => {
                self.hub = None;
                self.connected_room = None;
                self.connection = error;
            }
            UiEvent::Send {
                room,
                revision,
                result,
            } => {
                let state = self.states.entry(room.clone()).or_default();
                state.pending = false;
                match result {
                    Ok(value) => {
                        let changed = state.draft.revision != revision;
                        if !changed { state.draft.replace(String::new()); state.files.clear(); }
                        if value.get("from").is_some() {
                            if let Ok(message) = serde_json::from_value(value.clone()) { self.merge(message); }
                        }
                        let outcome = if value.get("queued").and_then(Value::as_bool) == Some(true) { "accepted by hub; queued, not executed" }
                            else if value.get("to").is_some() || value.get("agent").is_some() { "accepted by hub; execution is not confirmed" }
                            else { "posted to room" };
                        self.note(format!("{room}: {outcome}{}", if changed { " · edited draft retained; review before sending again" } else { "" }), false);
                    }
                    Err(error) => self.note(format!("{room}: send NOT CONFIRMED; draft kept. It may have reached the hub—check history before retrying. {error}"), true),
                }
            }
            UiEvent::Read { name, result } => match result {
                Ok(text) => {
                    if let Some(detail) = self.detail.as_mut().filter(|d| d.name == name) {
                        detail.text = safe_text(&text);
                        detail.loading = false;
                        detail.scroll = 0;
                    }
                    self.note(
                        format!("Read {name}'s screen · passive snapshot; attention is unchanged"),
                        false,
                    );
                }
                Err(error) => {
                    if let Some(detail) = self.detail.as_mut().filter(|d| d.name == name) {
                        detail.loading = false;
                        detail.text = format!("Screen read failed: {error}");
                    }
                    self.note(error, true);
                }
            },
            UiEvent::Notice(result) => match result {
                Ok(text) => self.note(text, false),
                Err(error) => self.note(error, true),
            },
            UiEvent::Files { room, result } => match result {
                Ok(files) => {
                    let state = self.states.entry(room.clone()).or_default();
                    if state.files.len() + files.len() <= 8 {
                        state.files.extend(files);
                        state.draft.revision = state.draft.revision.wrapping_add(1);
                        self.note(
                            format!("File attached to {room}'s draft; Enter sends it"),
                            false,
                        );
                    } else {
                        self.note(
                            "At most eight files per message; uploaded file was not attached",
                            true,
                        );
                    }
                }
                Err(error) => self.note(format!("Attachment failed: {error}"), true),
            },
            UiEvent::Bindings(result) => match result {
                Ok(bindings) => {
                    self.bindings = bindings.into_iter().map(|b| (b.name.clone(), b)).collect()
                }
                Err(error) => self.note(
                    format!("Local bindings unavailable: {error}. Remote agents remain usable."),
                    true,
                ),
            },
            UiEvent::Launched(result) => match result {
                Ok(binding) => {
                    self.note(
                        format!(
                            "{} bound locally in {} · /terminal {} to attach",
                            binding.name, binding.room, binding.name
                        ),
                        false,
                    );
                    self.bindings.insert(binding.name.clone(), binding);
                }
                Err(error) => self.note(error, true),
            },
        }
    }
    fn reload_bindings(&mut self) {
        let tx = self.tx.clone();
        self.jobs.spawn(async move {
            let result = tokio::task::spawn_blocking(bridge::bindings)
                .await
                .map_err(|e| e.to_string())
                .and_then(|r| r.map_err(|e| format!("{e:#}")));
            let _ = tx.send(UiEvent::Bindings(result)).await;
        });
    }
    fn read_agent(&mut self, name: String) {
        if let Some(index) = self.local_agents().iter().position(|agent| agent == &name) {
            self.agent_cursor = index;
        }
        self.detail = Some(Detail {
            name: name.clone(),
            text: String::new(),
            loading: true,
            scroll: 0,
        });
        self.focus = Focus::Composer;
        let Some(hub) = self.hub.clone() else {
            if let Some(d) = &mut self.detail {
                d.loading = false;
                d.text = "Offline; screen cannot be read. Press r when connected.".into();
            }
            return;
        };
        let tx = self.tx.clone();
        self.note(format!("Reading {name}…"), false);
        self.jobs.spawn(async move {
            let result = hub
                .call_timeout(
                    "agents/read",
                    json!({"name":name,"lines":500}),
                    Duration::from_secs(30),
                )
                .await
                .and_then(|v| {
                    v.get("text")
                        .and_then(Value::as_str)
                        .map(str::to_owned)
                        .context("Hub returned no screen text")
                })
                .map_err(|e| format!("{e:#}"));
            let _ = tx.send(UiEvent::Read { name, result }).await;
        });
    }
    fn choices(&self) -> Vec<(String, Choice)> {
        let query = self
            .picker
            .as_ref()
            .map_or("", |p| p.query.text.as_str())
            .to_lowercase();
        let mut choices: Vec<_> = self
            .rooms
            .iter()
            .map(|r| (format!("Room  {r}"), Choice::Room(r.clone())))
            .collect();
        choices.extend(
            self.members
                .values()
                .filter(|m| m.kind == "agent")
                .map(|m| {
                    (
                        format!("Agent  {} · {} · {}", m.name, m.room, m.status),
                        Choice::Agent(m.name.clone()),
                    )
                }),
        );
        choices.extend(COMMANDS.iter().map(|(cmd, description)| {
            (
                format!("{cmd}  {description}"),
                Choice::Command(cmd.split_whitespace().next().unwrap_or(cmd).to_owned()),
            )
        }));
        choices
            .into_iter()
            .filter(|(label, _)| label.to_lowercase().contains(&query))
            .collect()
    }
    fn pick(&mut self, index: usize) {
        let choice = self.choices().get(index).cloned();
        self.picker = None;
        match choice.map(|(_, c)| c) {
            Some(Choice::Room(room)) => self.switch_room(room),
            Some(Choice::Agent(name)) => {
                if let Some(m) = self.members.get(&name) {
                    self.switch_room(m.room.clone());
                }
                self.read_agent(name);
            }
            Some(Choice::Command(cmd)) if cmd == "/help" => self.help = true,
            Some(Choice::Command(cmd)) => {
                self.detail = None;
                self.focus = Focus::Composer;
                self.state_mut().draft.insert(&format!("{cmd} "));
            }
            None => {}
        }
    }
    fn action(&mut self, action: Action) {
        match action {
            Action::Toggle => self.toggle(),
            Action::Help => self.help = true,
            Action::Palette => {
                self.picker = Some(Picker {
                    query: Composer::default(),
                    selected: 0,
                })
            }
            Action::Room(room) => self.switch_room(room),
            Action::Agent(name) | Action::Read(name) => self.read_agent(name),
            Action::Composer => {
                self.focus = Focus::Composer;
            }
            Action::Attach(name) => self.request_attach(name),
            Action::Back => self.detail = None,
            Action::New | Action::Bind => {
                self.detail = None;
                self.focus = Focus::Composer;
                self.state_mut()
                    .draft
                    .insert(if matches!(action, Action::New) {
                        "/new "
                    } else {
                        "/bind "
                    });
            }
            Action::Seen(name) => self.rpc_notice(
                "agents/seen",
                json!({"name":name}),
                format!("Attention cleared for {name}"),
            ),
            Action::Picker(index) => self.pick(index),
        }
    }
    fn toggle(&mut self) {
        if self.narrow {
            self.sidebar = true;
            self.focus = if self.focus == Focus::Composer {
                Focus::Rooms
            } else {
                Focus::Composer
            };
        } else {
            self.sidebar = !self.sidebar;
            if !self.sidebar {
                self.focus = Focus::Composer;
            }
        }
    }
    fn cycle(&mut self, reverse: bool) {
        if !self.sidebar && !self.narrow {
            self.focus = Focus::Composer;
            return;
        }
        self.focus = match (self.focus, reverse) {
            (Focus::Rooms, false) | (Focus::Composer, true) => Focus::Agents,
            (Focus::Agents, false) | (Focus::Rooms, true) => Focus::Composer,
            _ => Focus::Rooms,
        };
    }
    fn scroll(&mut self, delta: isize) {
        if let Some(detail) = &mut self.detail {
            detail.scroll = detail.scroll.saturating_add_signed(delta);
            return;
        }
        let max = self.scroll_keys.len().saturating_sub(self.scroll_height);
        let next = self.scroll_top.saturating_add_signed(delta).min(max);
        self.state_mut().anchor = if next == max {
            None
        } else {
            self.scroll_keys.get(next).cloned()
        };
    }
    fn request_attach(&mut self, name: String) {
        if !self.bindings.contains_key(&name) {
            self.note(format!("{name} has no local binding. Hub screen read works remotely; terminal attach requires a local herdr binding."), true);
            return;
        }
        self.attach = Some(name);
    }
    fn rpc_notice(&mut self, method: &'static str, args: Value, success: String) {
        let Some(hub) = self.hub.clone() else {
            self.note("Offline; action was not sent", true);
            return;
        };
        let tx = self.tx.clone();
        self.note(format!("{method} pending…"), false);
        self.jobs.spawn(async move {
            let result = hub
                .call(method, args)
                .await
                .map(|value| {
                    if method == "agents/wait" {
                        format!(
                            "{}{}",
                            if value.get("timeout").and_then(Value::as_bool) == Some(true) {
                                "Wait timed out: "
                            } else {
                                "Wait returned: "
                            },
                            value
                        )
                    } else {
                        success
                    }
                })
                .map_err(|e| format!("Action not confirmed (do not blindly retry): {e:#}"));
            let _ = tx.send(UiEvent::Notice(result)).await;
        });
    }
    fn submit(&mut self) {
        let text = self.state().draft.text.clone();
        let trimmed = text.trim();
        let literal = trimmed
            .split_once(char::is_whitespace)
            .filter(|(command, _)| *command == "/say")
            .map(|(_, body)| body.trim());
        if trimmed.starts_with('/') && literal.is_none() {
            if let Err(error) = self.command(trimmed) {
                self.note(format!("{error:#}"), true);
            }
            return;
        }
        if self.state().pending {
            self.note(
                "This room already has a send awaiting confirmation; draft is retained",
                true,
            );
            return;
        }
        if trimmed.is_empty() && self.state().files.is_empty() {
            return;
        }
        let Some(hub) = self.hub.clone() else {
            self.note("Offline; nothing sent. Draft retained.", true);
            return;
        };
        let room = self.room.clone();
        let files = self.state().files.clone();
        let mut method = "room/say";
        let mut args = json!({"room":room,"text":literal.unwrap_or(trimmed),"media":files});
        if let Some(directed) = trimmed.strip_prefix('@') {
            let (to, body) = directed
                .split_once(char::is_whitespace)
                .unwrap_or((directed, ""));
            let body = body.trim();
            if body.is_empty() && files.is_empty() {
                self.note("Write a message after @Name", true);
                return;
            }
            if to == "auto" {
                method = "agents/dispatch";
                args = json!({"room":room,"text":body,"media":files});
            } else if let Some(member) = self.members.get(to) {
                if member.room != room {
                    self.note(
                        format!(
                            "{to} belongs to {}; switch rooms before sending directed work",
                            member.room
                        ),
                        true,
                    );
                    return;
                }
                method = "agents/send";
                args = json!({"to":to,"text":body,"kind":if member.kind == "agent" {"command"} else {"info"},"media":files});
            } else {
                self.note(format!("Unknown exact target @{to}; nothing sent. Use /say for literal mention text."), true);
                return;
            }
        }
        self.send(hub, method, args);
    }
    fn send(&mut self, hub: Hub, method: &'static str, args: Value) {
        let room = self.room.clone();
        let revision = self.state().draft.revision;
        self.state_mut().pending = true;
        self.note("Sending to hub… draft retained until confirmation", false);
        let tx = self.tx.clone();
        self.jobs.spawn(async move {
            let result = hub
                .call_timeout(method, args, Duration::from_secs(90))
                .await
                .map_err(|e| format!("{e:#}"));
            let _ = tx
                .send(UiEvent::Send {
                    room,
                    revision,
                    result,
                })
                .await;
        });
    }
    fn command(&mut self, text: &str) -> Result<()> {
        let (command, arg) = text.split_once(char::is_whitespace).unwrap_or((text, ""));
        let arg = arg.trim();
        let one = || -> Result<String> {
            if arg.is_empty() {
                bail!("Usage: {command} NAME");
            }
            Ok(arg.to_owned())
        };
        match command {
            "/quit" => self.quit = true,
            "/help" => self.help = true,
            "/room" => {
                let target = one()?;
                self.state_mut().draft.replace(String::new());
                self.switch_room(target);
                return Ok(());
            }
            "/rooms" => {
                self.sidebar = true;
                self.focus = Focus::Rooms;
            }
            "/agents" => {
                self.sidebar = true;
                self.focus = Focus::Agents;
            }
            "/read" => self.read_agent(one()?),
            "/terminal" => {
                let name = one()?;
                self.request_attach(name);
            }
            "/wait" => {
                let name = one()?;
                self.rpc_notice(
                    "agents/wait",
                    json!({"name":name,"timeoutMs":600000}),
                    String::new(),
                );
            }
            "/seen" => {
                let name = one()?;
                self.rpc_notice(
                    "agents/seen",
                    json!({"name":name}),
                    format!("Attention cleared for {name}"),
                );
            }
            "/cancel" | "/keys" => {
                let (name, keys) = arg.split_once(char::is_whitespace).unwrap_or((arg, ""));
                if name.is_empty() || (command == "/keys" && keys.trim().is_empty()) {
                    bail!(
                        "Usage: {command} NAME{}",
                        if command == "/keys" { " KEY..." } else { "" }
                    );
                }
                if !self.members.contains_key(name) {
                    bail!("Unknown agent {name}");
                }
                let body = if command == "/cancel" {
                    "!cancel".to_owned()
                } else {
                    format!("!keys {}", keys.trim())
                };
                if self.state().pending {
                    bail!("This room already has a send awaiting confirmation");
                }
                let hub = self
                    .hub
                    .clone()
                    .context("Offline; control was not sent and draft was retained")?;
                self.send(
                    hub,
                    "agents/send",
                    json!({"to":name,"text":body,"kind":"command"}),
                );
                return Ok(());
            }
            "/attach-file" | "/attach" => {
                if arg.is_empty() {
                    bail!("Usage: /attach-file PATH (quotes supported)");
                }
                if self.state().files.len() >= 8 {
                    bail!("At most eight files per draft");
                }
                let words = words(arg)?;
                if words.len() != 1 {
                    bail!("Quote paths containing spaces");
                }
                let path = expand_path(&words[0]);
                let config = self.config.clone();
                let room = self.room.clone();
                let tx = self.tx.clone();
                self.jobs.spawn(async move {
                    let result = media::upload(&config, &[path])
                        .await
                        .map_err(|e| format!("{e:#}"));
                    let _ = tx.send(UiEvent::Files { room, result }).await;
                });
                self.note("Uploading file in background…", false);
            }
            "/detach-files" => self.state_mut().files.clear(),
            "/new" => {
                let args = words(arg)?;
                if !(2..=3).contains(&args.len()) {
                    bail!("Usage: /new NAME KIND [cwd] (quote paths with spaces)");
                }
                let options = LaunchOptions {
                    name: args[0].clone(),
                    kind: args[1].clone(),
                    room: self.room.clone(),
                    cwd: args
                        .get(2)
                        .map(|s| expand_path(s))
                        .unwrap_or(std::env::current_dir()?),
                    session: self.config.herdr_session.clone(),
                    accept: "owner".into(),
                    args: vec![],
                };
                let config = self.config.clone();
                let tx = self.tx.clone();
                self.jobs.spawn(async move {
                    let result = bridge::launch(&config, options)
                        .await
                        .map_err(|e| format!("{e:#}"));
                    let _ = tx.send(UiEvent::Launched(result)).await;
                });
                self.note("Launching local agent in background…", false);
            }
            "/bind" => {
                let args = words(arg)?;
                if args.len() != 2 {
                    bail!("Usage: /bind NAME TARGET");
                }
                let config = self.config.clone();
                let room = self.room.clone();
                let tx = self.tx.clone();
                self.jobs.spawn(async move {
                    let result = bridge::bind(
                        &config,
                        &args[0],
                        &room,
                        &args[1],
                        config.herdr_session.clone(),
                    )
                    .await
                    .map_err(|e| format!("{e:#}"));
                    let _ = tx.send(UiEvent::Launched(result)).await;
                });
                self.note("Binding local agent in background…", false);
            }
            "/say" => bail!("Usage: /say TEXT"),
            _ => bail!("Unknown command {command}; /help lists commands"),
        }
        self.state_mut().draft.replace(String::new());
        Ok(())
    }
    fn key(&mut self, key: KeyEvent) {
        if key.kind == KeyEventKind::Release {
            return;
        }
        let control = key.modifiers.contains(KeyModifiers::CONTROL);
        if control && matches!(key.code, KeyCode::Char('q') | KeyCode::Char('c')) {
            self.quit = true;
            return;
        }
        if self.help {
            match key.code {
                KeyCode::Esc | KeyCode::F(1) | KeyCode::Char('?') => self.help = false,
                KeyCode::Down | KeyCode::Char('j') => self.help_scroll += 1,
                KeyCode::Up | KeyCode::Char('k') => {
                    self.help_scroll = self.help_scroll.saturating_sub(1)
                }
                KeyCode::PageDown => self.help_scroll += 10,
                KeyCode::PageUp => self.help_scroll = self.help_scroll.saturating_sub(10),
                _ => {}
            }
            return;
        }
        if self.picker.is_some() {
            let len = self.choices().len();
            let picker = self.picker.as_mut().unwrap();
            match key.code {
                KeyCode::Esc => self.picker = None,
                KeyCode::Down => picker.selected = (picker.selected + 1).min(len.saturating_sub(1)),
                KeyCode::Up => picker.selected = picker.selected.saturating_sub(1),
                KeyCode::Enter => {
                    let index = picker.selected;
                    self.pick(index);
                }
                _ => {
                    edit_key(&mut picker.query, key, false);
                    picker.selected = 0;
                }
            }
            return;
        }
        if control {
            match key.code {
                KeyCode::Char('b') => {
                    self.toggle();
                    return;
                }
                KeyCode::Char('p') => {
                    self.action(Action::Palette);
                    return;
                }
                _ => {}
            }
        }
        match key.code {
            KeyCode::F(1) => {
                self.help = true;
                return;
            }
            KeyCode::Tab => {
                self.cycle(false);
                return;
            }
            KeyCode::BackTab => {
                self.cycle(true);
                return;
            }
            KeyCode::PageUp => {
                self.scroll(-(self.scroll_height.max(3) as isize));
                return;
            }
            KeyCode::PageDown => {
                self.scroll(self.scroll_height.max(3) as isize);
                return;
            }
            KeyCode::Esc => {
                if self.detail.take().is_none() {
                    self.focus = if self.focus == Focus::Composer {
                        Focus::Rooms
                    } else {
                        Focus::Composer
                    };
                    self.sidebar = true;
                }
                return;
            }
            _ => {}
        }
        if self.focus != Focus::Composer {
            let agents = self.local_agents();
            let (cursor, len) = if self.focus == Focus::Rooms {
                (&mut self.room_cursor, self.rooms.len())
            } else {
                (&mut self.agent_cursor, agents.len())
            };
            match key.code {
                KeyCode::Down | KeyCode::Char('j') => {
                    *cursor = (*cursor + 1).min(len.saturating_sub(1))
                }
                KeyCode::Up | KeyCode::Char('k') => *cursor = cursor.saturating_sub(1),
                KeyCode::Home | KeyCode::Char('g') => *cursor = 0,
                KeyCode::End | KeyCode::Char('G') => *cursor = len.saturating_sub(1),
                KeyCode::Char(' ') if self.focus == Focus::Rooms => {
                    self.rooms_folded = !self.rooms_folded
                }
                KeyCode::Enter | KeyCode::Right | KeyCode::Char('l') => {
                    if self.focus == Focus::Rooms {
                        if let Some(room) = self.rooms.iter().nth(self.room_cursor).cloned() {
                            self.switch_room(room);
                        }
                    } else if let Some(name) = agents.get(self.agent_cursor) {
                        self.read_agent(name.clone());
                    }
                }
                KeyCode::Char('t') if self.focus == Focus::Agents => {
                    if let Some(name) = agents.get(self.agent_cursor) {
                        self.request_attach(name.clone());
                    }
                }
                KeyCode::Char('/') => self.action(Action::Palette),
                KeyCode::Char('?') => self.help = true,
                _ => {}
            }
            return;
        }
        if let Some(detail) = &self.detail {
            let name = detail.name.clone();
            match key.code {
                KeyCode::Char('r') => self.read_agent(name),
                KeyCode::Char('t') => self.request_attach(name),
                KeyCode::Char('s') => self.action(Action::Seen(name)),
                KeyCode::Down | KeyCode::Char('j') => self.scroll(1),
                KeyCode::Up | KeyCode::Char('k') => self.scroll(-1),
                KeyCode::Char('i') => {
                    self.detail = None;
                    self.state_mut().draft.insert(&format!("@{name} "));
                }
                _ => {}
            }
            return;
        }
        if key.code == KeyCode::Enter
            && !key.modifiers.contains(KeyModifiers::ALT)
            && !key.modifiers.contains(KeyModifiers::SHIFT)
        {
            self.submit();
        } else {
            edit_key(&mut self.state_mut().draft, key, true);
        }
    }
    fn mouse(&mut self, mouse: event::MouseEvent) {
        let point = (mouse.column, mouse.row);
        if self.help || self.picker.is_some() {
            if mouse.kind == MouseEventKind::Down(MouseButton::Left) {
                if let Some((_, action)) = self
                    .hits
                    .actions
                    .iter()
                    .rev()
                    .find(|(rect, _)| contains(*rect, point))
                    .cloned()
                {
                    self.action(action);
                } else if !self.hits.modal.is_some_and(|r| contains(r, point)) {
                    self.help = false;
                    self.picker = None;
                }
            } else if self.help {
                match mouse.kind {
                    MouseEventKind::ScrollDown => self.help_scroll += 3,
                    MouseEventKind::ScrollUp => {
                        self.help_scroll = self.help_scroll.saturating_sub(3)
                    }
                    _ => {}
                }
            }
            return;
        }
        match mouse.kind {
            MouseEventKind::Down(MouseButton::Left) if contains(self.hits.divider, point) => {
                self.dragging = true
            }
            MouseEventKind::Drag(MouseButton::Left) if self.dragging => {
                self.sidebar_width = mouse.column.clamp(24, 48)
            }
            MouseEventKind::Up(MouseButton::Left) => self.dragging = false,
            MouseEventKind::Down(MouseButton::Left) => {
                if let Some((_, action)) = self
                    .hits
                    .actions
                    .iter()
                    .rev()
                    .find(|(rect, _)| contains(*rect, point))
                    .cloned()
                {
                    self.action(action);
                }
            }
            MouseEventKind::ScrollUp | MouseEventKind::ScrollDown => {
                let delta = if mouse.kind == MouseEventKind::ScrollUp {
                    -3
                } else {
                    3
                };
                if contains(self.hits.transcript, point) {
                    self.scroll(delta);
                } else if contains(self.hits.sidebar, point) {
                    let row = self
                        .hits
                        .actions
                        .iter()
                        .find(|(r, a)| {
                            contains(*r, point) && matches!(a, Action::Agent(_) | Action::Room(_))
                        })
                        .map(|(_, a)| a);
                    if matches!(row, Some(Action::Agent(_))) {
                        self.focus = Focus::Agents;
                        self.agent_cursor = self
                            .agent_cursor
                            .saturating_add_signed(delta)
                            .min(self.local_agents().len().saturating_sub(1));
                    } else {
                        self.focus = Focus::Rooms;
                        self.room_cursor = self
                            .room_cursor
                            .saturating_add_signed(delta)
                            .min(self.rooms.len().saturating_sub(1));
                    }
                }
            }
            _ => {}
        }
    }
}

fn edit_key(input: &mut Composer, key: KeyEvent, multiline: bool) {
    let control = key.modifiers.contains(KeyModifiers::CONTROL);
    match key.code {
        KeyCode::Char('j') if control && multiline => input.insert("\n"),
        KeyCode::Char('a') if control => input.home(),
        KeyCode::Char('e') if control => input.end(),
        KeyCode::Char('u') if control => input.replace(String::new()),
        KeyCode::Char(c) if !control && !key.modifiers.contains(KeyModifiers::ALT) => {
            input.insert(&c.to_string())
        }
        KeyCode::Enter if multiline => input.insert("\n"),
        KeyCode::Left => input.left(),
        KeyCode::Right => input.right(),
        KeyCode::Home => input.home(),
        KeyCode::End => input.end(),
        KeyCode::Backspace => input.backspace(),
        KeyCode::Delete => input.delete(),
        KeyCode::Up if multiline => input.vertical(false),
        KeyCode::Down if multiline => input.vertical(true),
        _ => {}
    }
}
fn contains(rect: Rect, point: (u16, u16)) -> bool {
    point.0 >= rect.x && point.1 >= rect.y && point.0 < rect.right() && point.1 < rect.bottom()
}
fn expand_path(path: &str) -> PathBuf {
    if let Some(rest) = path.strip_prefix("~/") {
        if let Some(home) = dirs::home_dir() {
            return home.join(rest);
        }
    }
    PathBuf::from(path)
}
fn words(text: &str) -> Result<Vec<String>> {
    let mut words = Vec::new();
    let mut word = String::new();
    let mut quote = None;
    let mut escaped = false;
    for c in text.chars() {
        if escaped {
            word.push(c);
            escaped = false;
            continue;
        }
        if c == '\\' && quote != Some('\'') {
            escaped = true;
            continue;
        }
        if let Some(q) = quote {
            if c == q {
                quote = None;
            } else {
                word.push(c);
            }
        } else if c == '\'' || c == '"' {
            quote = Some(c);
        } else if c.is_whitespace() {
            if !word.is_empty() {
                words.push(std::mem::take(&mut word));
            }
        } else {
            word.push(c);
        }
    }
    if escaped || quote.is_some() {
        bail!("Unfinished quote or escape");
    }
    if !word.is_empty() {
        words.push(word);
    }
    Ok(words)
}

struct TerminalGuard {
    active: bool,
}
impl TerminalGuard {
    fn enter() -> Result<Self> {
        let mut guard = Self { active: true };
        if let Err(error) = guard.resume() {
            guard.restore();
            return Err(error);
        }
        Ok(guard)
    }
    fn resume(&mut self) -> Result<()> {
        self.active = true;
        terminal::enable_raw_mode()?;
        execute!(
            io::stdout(),
            EnterAlternateScreen,
            EnableMouseCapture,
            EnableBracketedPaste,
            cursor::Hide
        )?;
        Ok(())
    }
    fn restore(&mut self) {
        if self.active {
            let _ = execute!(
                io::stdout(),
                DisableMouseCapture,
                DisableBracketedPaste,
                cursor::Show,
                cursor::SetCursorStyle::DefaultUserShape,
                LeaveAlternateScreen
            );
            let _ = terminal::disable_raw_mode();
            self.active = false;
        }
    }
}
impl Drop for TerminalGuard {
    fn drop(&mut self) {
        self.restore();
    }
}
struct AbortOnDrop(JoinHandle<()>);
impl Drop for AbortOnDrop {
    fn drop(&mut self) {
        self.0.abort();
    }
}

pub async fn run(config: Config, room: Option<String>, name: Option<String>) -> Result<()> {
    if !io::stdin().is_terminal() || !io::stdout().is_terminal() {
        bail!(
            "banda's interactive viewer requires a terminal; use banda --help for noninteractive commands"
        );
    }
    config.owner_token()?;
    let room = room.unwrap_or_else(|| config.room.clone());
    let name = name.unwrap_or_else(|| config.name.clone());
    let (tx, mut rx) = mpsc::channel(1024);
    let (room_tx, room_rx) = watch::channel(room.clone());
    let network = AbortOnDrop(tokio::spawn(session::supervise(
        config.clone(),
        name.clone(),
        room.clone(),
        room_rx,
        tx.clone(),
    )));
    let mut app = App::new(config, room, name, tx, room_tx);
    app.reload_bindings();
    let previous = std::panic::take_hook();
    std::panic::set_hook(Box::new(move |info| {
        let _ = execute!(
            io::stdout(),
            DisableMouseCapture,
            DisableBracketedPaste,
            cursor::Show,
            LeaveAlternateScreen
        );
        let _ = terminal::disable_raw_mode();
        previous(info);
    }));
    let mut guard = TerminalGuard::enter()?;
    let mut term = Terminal::new(CrosstermBackend::new(io::stdout()))?;
    term.clear()?;
    let mut tick = tokio::time::interval(Duration::from_millis(33));
    tick.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Skip);
    #[cfg(unix)]
    let mut terminate = tokio::signal::unix::signal(tokio::signal::unix::SignalKind::terminate())?;
    #[cfg(unix)]
    let mut hangup = tokio::signal::unix::signal(tokio::signal::unix::SignalKind::hangup())?;
    #[cfg(unix)]
    let mut interrupt = tokio::signal::unix::signal(tokio::signal::unix::SignalKind::interrupt())?;
    let mut dirty = true;
    loop {
        if dirty {
            term.draw(|frame| view::draw(frame, &mut app))?;
            dirty = false;
        }
        if app.quit {
            break;
        }
        if let Some(name) = app.attach.take() {
            // No background terminal reader exists: the inherited attach owns stdin
            // while cooked mode/main screen are restored, and UI state stays intact.
            guard.restore();
            let result = tokio::select! {
                result = bridge::attach(&name) => result,
                _ = exit_signal(&mut terminate, &mut hangup, &mut interrupt) => break,
            };
            guard.resume()?;
            term.clear()?;
            match result {
                Ok(()) => app.note(format!("Returned from {name}; agent keeps running"), false),
                Err(error) => app.note(format!("Attach failed: {error:#}"), true),
            }
            app.reload_bindings();
            dirty = true;
            continue;
        }
        tokio::select! {
            Some(event) = rx.recv() => { app.event(event); dirty = true; },
            _ = tick.tick() => {
                // Poll only already-available input; never leave a reader holding stdin
                // during native terminal attach. Limit bursts so RPC events get time.
                for _ in 0..64 {
                    if !event::poll(Duration::ZERO)? { break; }
                    dirty = true;
                    match event::read()? {
                        Event::Key(key) => app.key(key), Event::Mouse(mouse) => app.mouse(mouse),
                        Event::Paste(text) => {
                            if let Some(picker) = &mut app.picker { picker.query.insert(&text.replace(['\n', '\r'], " ")); picker.selected = 0; }
                            else if !app.help && app.detail.is_none() && app.focus == Focus::Composer { app.state_mut().draft.insert(&text); }
                        },
                        Event::Resize(_, _) => {}, _ => {},
                    }
                    if app.quit || app.attach.is_some() { break; }
                }
                while app.jobs.try_join_next().is_some() {}
            },
            _ = exit_signal(&mut terminate, &mut hangup, &mut interrupt) => break,
        }
    }
    drop(network);
    drop(app);
    guard.restore();
    Ok(())
}

#[cfg(unix)]
async fn exit_signal(
    terminate: &mut tokio::signal::unix::Signal,
    hangup: &mut tokio::signal::unix::Signal,
    interrupt: &mut tokio::signal::unix::Signal,
) {
    tokio::select! { _ = terminate.recv() => {}, _ = hangup.recv() => {}, _ = interrupt.recv() => {} }
}
