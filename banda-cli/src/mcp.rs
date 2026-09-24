use std::{collections::HashMap, fmt::Write as _, sync::Arc, time::Duration};

use anyhow::{Context, Result, bail, ensure};
use futures_util::{
    FutureExt, StreamExt,
    future::{AbortHandle, Abortable, Aborted, BoxFuture},
    stream::FuturesUnordered,
};
use serde::Deserialize;
use serde_json::{Map, Value, json};
use tokio::{
    io::{AsyncBufRead, AsyncBufReadExt, AsyncWrite, AsyncWriteExt, BufReader},
    sync::{broadcast, watch},
    time::{Instant, sleep, timeout, timeout_at},
};

use crate::{
    config::Config,
    hub::{Hub, HubEvent, RpcError},
    media,
    model::{Identity, Member, RoomMessage},
};

const PROTOCOL_VERSIONS: &[&str] = &[
    "2025-11-25",
    "2025-06-18",
    "2025-03-26",
    "2024-11-05",
    "2024-10-07",
];
const RPC_TIMEOUT: Duration = Duration::from_secs(15);

type Pending = BoxFuture<'static, (RequestId, std::result::Result<Value, Aborted>)>;

#[derive(Clone)]
enum Connection {
    Starting,
    Online(Hub),
    Offline(String),
}

struct Client {
    config: Config,
    name: String,
    room: String,
    connection: watch::Receiver<Connection>,
}

/// The MCP side only observes an already registered runtime identity. It never
/// reports execution status, acknowledges inbox entries, or answers screen reads.
pub async fn run(mut config: Config, name: String, room: String) -> Result<()> {
    config.agent_token()?;
    // Shared media downloads must never fall back to the owner's credentials.
    config.token = None;
    let (sender, receiver) = watch::channel(Connection::Starting);
    let client = Arc::new(Client {
        config,
        name,
        room,
        connection: receiver,
    });
    serve(
        BufReader::new(tokio::io::stdin()),
        tokio::io::stdout(),
        client,
        sender,
    )
    .await
}

async fn connect_observer(client: &Client) -> Result<(Hub, broadcast::Receiver<HubEvent>)> {
    let hub = Hub::connect(&client.config.url, client.config.agent_token()?).await?;
    let events = hub.subscribe();
    let identity: Identity = serde_json::from_value(
        hub.call_timeout("auth/whoami", json!({}), RPC_TIMEOUT)
            .await?,
    )
    .context("Invalid hub identity response")?;
    ensure!(
        identity.role == "agent",
        "banda mcp requires an agent-role token, not an owner token"
    );

    // Agent processes can start their MCP child just before the bridge registers.
    // Only the explicit missing-member error is safe to retry here.
    let deadline = Instant::now() + Duration::from_secs(5);
    loop {
        let registered = timeout_at(
            deadline,
            hub.call_timeout(
                "agents/register",
                json!({"name": client.name, "room": client.room, "mode": "observer"}),
                RPC_TIMEOUT,
            ),
        )
        .await
        .with_context(|| {
            format!(
                "Agent {:?} is not registered; start or bind its runtime before banda mcp",
                client.name
            )
        })?;
        match registered {
            Ok(member) => {
                ensure!(
                    member.get("room").and_then(Value::as_str) == Some(client.room.as_str()),
                    "Agent {:?} is registered in a different room than {:?}",
                    client.name,
                    client.room
                );
                return Ok((hub, events));
            }
            Err(error)
                if error
                    .downcast_ref::<RpcError>()
                    .is_some_and(|error| error.code == 404) =>
            {
                if Instant::now() + Duration::from_millis(200) >= deadline {
                    return Err(error).with_context(|| {
                        format!("Agent {:?} has no registered runtime", client.name)
                    });
                }
                sleep(Duration::from_millis(200)).await;
            }
            Err(error) => return Err(error).context("Cannot associate MCP observer"),
        }
    }
}

async fn maintain_connection(client: Arc<Client>, sender: watch::Sender<Connection>) -> Result<()> {
    let (mut hub, mut events) = connect_observer(&client).await?;
    loop {
        sender.send_replace(Connection::Online(hub.clone()));
        loop {
            match events.recv().await {
                Ok(event) if event.name != "__disconnected" => continue,
                // Lag may hide a disconnect, so rebuild the observer association.
                _ => break,
            }
        }
        sender.send_replace(Connection::Offline(
            "Hub disconnected; reconnecting. Calls are not automatically retried.".into(),
        ));
        drop(hub);
        loop {
            sleep(Duration::from_secs(1)).await;
            match connect_observer(&client).await {
                Ok((connected, subscription)) => {
                    hub = connected;
                    events = subscription;
                    break;
                }
                Err(error) => {
                    sender.send_replace(Connection::Offline(format!(
                        "Hub is unavailable: {error:#}"
                    )));
                }
            }
        }
    }
}

impl Client {
    async fn hub(&self) -> Result<Hub> {
        let mut connection = self.connection.clone();
        loop {
            match connection.borrow_and_update().clone() {
                Connection::Online(hub) => return Ok(hub),
                Connection::Offline(error) => bail!("{error}"),
                Connection::Starting => {}
            }
            connection
                .changed()
                .await
                .context("Hub connection closed")?;
        }
    }

    async fn message(&self, mut message: RoomMessage) -> Result<String> {
        if !message.media.is_empty() {
            let paths = media::download(&self.config, &message.media)
                .await
                .with_context(|| format!("Downloading attachments for message {}", message.id))?;
            ensure!(
                paths.len() == message.media.len(),
                "Hub media download returned an incomplete attachment list"
            );
            for (attachment, path) in message.media.iter_mut().zip(paths) {
                attachment.url = path.to_string_lossy().into_owned();
            }
        }
        Ok(message_line(&message))
    }

    async fn call(&self, call: ToolCall) -> Result<String> {
        let hub = self.hub().await?;
        match call {
            ToolCall::Agents => {
                let members: Vec<Member> =
                    serde_json::from_value(hub.call("agents/list", json!({})).await?)
                        .context("Invalid hub agent list")?;
                if members.is_empty() {
                    return Ok("nobody".into());
                }
                Ok(members
                    .iter()
                    .map(member_line)
                    .collect::<Vec<_>>()
                    .join("\n"))
            }
            ToolCall::Read { limit } => {
                let messages: Vec<RoomMessage> = serde_json::from_value(
                    hub.call("room/history", json!({"room": self.room, "limit": limit}))
                        .await?,
                )
                .context("Invalid hub room history")?;
                if messages.is_empty() {
                    return Ok("(empty)".into());
                }
                let mut lines = Vec::with_capacity(messages.len());
                for message in messages {
                    lines.push(self.message(message).await?);
                }
                Ok(lines.join("\n"))
            }
            ToolCall::Say { text } => {
                let message = hub
                    .call("room/say", json!({"room": self.room, "text": text}))
                    .await?;
                let id = message
                    .get("id")
                    .and_then(Value::as_str)
                    .context("Hub posted a message without returning its id")?;
                Ok(format!("posted {id}"))
            }
            ToolCall::Send { to, text, kind } => {
                let sent: SendResult = serde_json::from_value(
                    hub.call("agents/send", json!({"to": to, "text": text, "kind": kind}))
                        .await?,
                )
                .context("Invalid hub send result; do not blindly retry the message")?;
                let how = if sent.kind == "command" {
                    "as a command".into()
                } else if sent.downgraded {
                    format!("as a note ({} does not take commands from you)", sent.to)
                } else {
                    "as a note".into()
                };
                if sent.delivered {
                    Ok(format!("delivered to {} {how}", sent.to))
                } else {
                    Ok(format!("{} is offline, queued {how}", sent.to))
                }
            }
            ToolCall::Wait { seconds } => {
                let mut events = hub.subscribe();
                let next = timeout(Duration::from_secs(seconds), async {
                    loop {
                        let event = events.recv().await.context(
                            "Hub event stream closed or messages were missed; use hub_read to resync",
                        )?;
                        if event.name == "__disconnected" {
                            bail!("Hub disconnected while waiting; use hub_read after reconnecting");
                        }
                        if event.name != "room/message" {
                            continue;
                        }
                        let message: RoomMessage = serde_json::from_value(event.data)
                            .context("Invalid hub room message")?;
                        if other_room_message(&message, &self.room, &self.name) {
                            return Ok::<_, anyhow::Error>(message);
                        }
                    }
                })
                .await;
                match next {
                    Ok(message) => self.message(message?).await,
                    Err(_) => Ok("timeout".into()),
                }
            }
            ToolCall::WaitAgent { name, seconds } => {
                let state: WaitResult = serde_json::from_value(
                    hub.call_timeout(
                        "agents/wait",
                        json!({"name": name, "timeoutMs": seconds * 1000}),
                        Duration::from_secs(seconds + 10),
                    )
                    .await?,
                )
                .context("Invalid hub wait result")?;
                if state.timeout {
                    return Ok(format!(
                        "timeout waiting for {name}; no requested ready state was observed"
                    ));
                }
                let reason = state
                    .reason
                    .filter(|reason| !reason.is_empty())
                    .map(|reason| format!(" ({reason})"))
                    .unwrap_or_default();
                let status = state
                    .status
                    .context("Hub wait completed without a status")?;
                Ok(format!("{name} is {status}{reason}"))
            }
        }
    }
}

#[derive(Deserialize)]
struct SendResult {
    to: String,
    kind: String,
    delivered: bool,
    #[serde(default)]
    downgraded: bool,
}

#[derive(Deserialize)]
struct WaitResult {
    status: Option<String>,
    reason: Option<String>,
    #[serde(default)]
    timeout: bool,
}

fn other_room_message(message: &RoomMessage, room: &str, name: &str) -> bool {
    message.room == room && message.from.name != name
}

fn message_line(message: &RoomMessage) -> String {
    let time = message.ts.get(11..19).unwrap_or("");
    if message.kind == "system" {
        return format!("{time} · {}", message.text);
    }
    let mut line = format!("{time} {}", message.from.name);
    if let Some(to) = &message.to {
        let _ = write!(line, " → {to}");
    }
    if message.kind != "say" {
        let _ = write!(line, " [{}]", message.kind);
    }
    line.push_str(": ");
    line.push_str(&message.text);
    for attachment in &message.media {
        if !line.ends_with(' ') {
            line.push(' ');
        }
        let _ = write!(line, "[{}: {}]", attachment.name, attachment.url);
    }
    line
}

fn member_line(member: &Member) -> String {
    let status = if !member.connected {
        "stopped"
    } else if member.attention && member.status != "blocked" {
        "done"
    } else {
        &member.status
    };
    let mark = if status == "blocked" {
        '!'
    } else if member.attention {
        '*'
    } else if member.connected {
        '+'
    } else {
        '-'
    };
    let mut line = format!("{mark} {:14} {status:8} {}", member.name, member.room);
    if let Some(host) = member.host.as_deref().filter(|host| !host.is_empty()) {
        let _ = write!(line, " @{host}");
    }
    if let Some(repo) = member.repo.as_deref().filter(|repo| !repo.is_empty()) {
        let _ = write!(line, " {repo}");
    }
    if !member.caps.is_empty() {
        line.push_str(" [");
        for (index, cap) in member.caps.iter().enumerate() {
            if index != 0 {
                line.push(',');
            }
            line.push_str(cap);
        }
        line.push(']');
    }
    if member.kind == "agent" {
        line.push_str(" accepts ");
        match &member.accept {
            Value::String(accept) => line.push_str(accept),
            Value::Array(names) => {
                for (index, name) in names.iter().filter_map(Value::as_str).enumerate() {
                    if index != 0 {
                        line.push(',');
                    }
                    line.push_str(name);
                }
            }
            _ => line.push_str("owner"),
        }
    }
    if matches!(status, "working" | "blocked") {
        if let Some(reason) = member.reason.as_deref().filter(|reason| !reason.is_empty()) {
            let _ = write!(line, " ({reason})");
        }
    }
    line
}

#[derive(Debug)]
enum ToolCall {
    Agents,
    Read {
        limit: u64,
    },
    Say {
        text: String,
    },
    Send {
        to: String,
        text: String,
        kind: String,
    },
    Wait {
        seconds: u64,
    },
    WaitAgent {
        name: String,
        seconds: u64,
    },
}

impl ToolCall {
    fn parse(name: &str, arguments: &Map<String, Value>) -> Result<Self> {
        Ok(match name {
            "hub_agents" => Self::Agents,
            "hub_read" => Self::Read {
                limit: bounded_integer(arguments, "limit", 30, 200)?,
            },
            "hub_say" => Self::Say {
                text: message_argument(arguments)?,
            },
            "hub_send" => {
                let kind = match arguments.get("kind") {
                    None => "command",
                    Some(Value::String(kind)) if kind == "info" || kind == "command" => kind,
                    _ => bail!("kind must be 'info' or 'command'"),
                };
                Self::Send {
                    to: string_argument(arguments, "to")?,
                    text: message_argument(arguments)?,
                    kind: kind.into(),
                }
            }
            "hub_wait" => Self::Wait {
                seconds: bounded_integer(arguments, "seconds", 60, 600)?,
            },
            "hub_wait_agent" => Self::WaitAgent {
                name: string_argument(arguments, "name")?,
                seconds: bounded_integer(arguments, "seconds", 120, 600)?,
            },
            _ => bail!("Unknown tool: {name}"),
        })
    }
}

fn string_argument(arguments: &Map<String, Value>, key: &str) -> Result<String> {
    arguments
        .get(key)
        .and_then(Value::as_str)
        .map(str::to_owned)
        .with_context(|| format!("{key} must be a string"))
}

fn message_argument(arguments: &Map<String, Value>) -> Result<String> {
    let text = string_argument(arguments, "text")?;
    // Match the existing JS tool's z.string().min(1).max(16000) semantics.
    ensure!(
        (1..=16_000).contains(&text.encode_utf16().count()),
        "text must contain between 1 and 16000 UTF-16 code units"
    );
    Ok(text)
}

fn bounded_integer(
    arguments: &Map<String, Value>,
    key: &str,
    default: u64,
    max: u64,
) -> Result<u64> {
    let Some(value) = arguments.get(key) else {
        return Ok(default);
    };
    let number = value
        .as_f64()
        .filter(|number| number.fract() == 0.0 && *number >= 1.0 && *number <= max as f64)
        .with_context(|| format!("{key} must be an integer between 1 and {max}"))?;
    Ok(number as u64)
}

fn tools(room: &str) -> Value {
    let seconds = json!({"type": "integer", "minimum": 1, "maximum": 600});
    let text = json!({"type": "string", "minLength": 1, "maxLength": 16000});
    json!({"tools": [
        {
            "name": "hub_agents",
            "description": "List agents and humans with status, room, host, repo, and whose commands each agent accepts (owner, any, or names).",
            "inputSchema": {"type": "object", "properties": {}}
        },
        {
            "name": "hub_read",
            "description": format!("Read the last messages of room {room:?}: what the owner and other agents said, and directed messages. This reads room history, not terminal screens. Attachments are downloaded to local files."),
            "inputSchema": {"type": "object", "properties": {"limit": {"type": "integer", "minimum": 1, "maximum": 200, "description": "How many, default 30"}}}
        },
        {
            "name": "hub_say",
            "description": "Post a short message to the room. Everyone in the room and the owner see it. Use it to report an outcome or a decision that affects others.",
            "inputSchema": {"type": "object", "properties": {"text": text}, "required": ["text"]}
        },
        {
            "name": "hub_send",
            "description": "Send a directed message to another agent by name. kind 'command' (default) becomes an instruction when it is idle if it accepts commands from you (see hub_agents); otherwise it arrives as a note. kind 'info' is a note or reply. Use hub_wait_agent to know when it finished and hub_read or hub_wait for its reply.",
            "inputSchema": {"type": "object", "properties": {"to": {"type": "string"}, "text": text, "kind": {"type": "string", "enum": ["info", "command"]}}, "required": ["to", "text"]}
        },
        {
            "name": "hub_wait",
            "description": "Wait for the next message in the room from someone else (up to seconds, default 60, maximum 600). Returns it, or 'timeout'.",
            "inputSchema": {"type": "object", "properties": {"seconds": seconds}}
        },
        {
            "name": "hub_wait_agent",
            "description": "Wait until another agent is ready (waiting, blocked or stopped), for up to seconds (default 120, maximum 600). Returns its status. Use after hub_send to collect a result.",
            "inputSchema": {"type": "object", "properties": {"name": {"type": "string"}, "seconds": seconds}, "required": ["name"]}
        }
    ]})
}

#[derive(Clone, Debug, Eq, Hash, PartialEq)]
enum RequestId {
    Text(String),
    Number(i64),
}

impl RequestId {
    fn parse(value: &Value) -> Option<Self> {
        match value {
            Value::String(text) => Some(Self::Text(text.clone())),
            Value::Number(number) => {
                let number = number.as_f64()?;
                // MCP SDKs represent request IDs as safe JSON integers. Normalize
                // 1 and 1.0 for cancellation while echoing the original wire ID.
                (number.fract() == 0.0 && number.abs() <= 9_007_199_254_740_991.0)
                    .then_some(Self::Number(number as i64))
            }
            _ => None,
        }
    }
}

fn rpc_result(id: &Value, result: Value) -> Value {
    json!({"jsonrpc": "2.0", "id": id, "result": result})
}

fn rpc_error(id: Option<&Value>, code: i64, message: impl Into<String>) -> Value {
    let mut error = json!({"jsonrpc": "2.0", "error": {"code": code, "message": message.into()}});
    // MCP's error schema omits id when no valid request ID is available.
    if let Some(id) = id {
        error["id"] = id.clone();
    }
    error
}

fn tool_result(result: Result<String>) -> Value {
    match result {
        Ok(text) => json!({"content": [{"type": "text", "text": text}], "isError": false}),
        Err(error) => {
            json!({"content": [{"type": "text", "text": format!("{error:#}")}], "isError": true})
        }
    }
}

fn initialize(params: &Value) -> Result<Value> {
    let version = params
        .get("protocolVersion")
        .and_then(Value::as_str)
        .context("initialize requires protocolVersion")?;
    ensure!(
        params.get("capabilities").is_some_and(Value::is_object)
            && params
                .pointer("/clientInfo/name")
                .is_some_and(Value::is_string)
            && params
                .pointer("/clientInfo/version")
                .is_some_and(Value::is_string),
        "initialize requires capabilities and clientInfo with name and version"
    );
    let version = if PROTOCOL_VERSIONS.contains(&version) {
        version
    } else {
        PROTOCOL_VERSIONS[0]
    };
    Ok(json!({
        "protocolVersion": version,
        "capabilities": {"tools": {"listChanged": false}},
        "serverInfo": {"name": "banda", "version": env!("CARGO_PKG_VERSION")}
    }))
}

async fn write_message(writer: &mut (impl AsyncWrite + Unpin), message: &Value) -> Result<()> {
    let mut bytes = serde_json::to_vec(message)?;
    bytes.push(b'\n');
    writer.write_all(&bytes).await?;
    writer.flush().await?;
    Ok(())
}

async fn serve(
    reader: impl AsyncBufRead + Unpin,
    mut writer: impl AsyncWrite + Unpin,
    client: Arc<Client>,
    sender: watch::Sender<Connection>,
) -> Result<()> {
    let connection = maintain_connection(client.clone(), sender);
    tokio::pin!(connection);
    let mut lines = reader.lines();
    let mut pending = FuturesUnordered::<Pending>::new();
    let mut cancellations = HashMap::<RequestId, AbortHandle>::new();
    let mut negotiated = false;
    let mut initialized = false;
    loop {
        tokio::select! {
            result = &mut connection => return result,
            Some((key, result)) = pending.next(), if !pending.is_empty() => {
                cancellations.remove(&key);
                if let Ok(message) = result {
                    write_message(&mut writer, &message).await?;
                }
            }
            line = lines.next_line() => {
                let Some(line) = line? else {
                    // Dropping the manager and in-flight futures closes all hub
                    // handles and cancels waits, including pending startup.
                    return Ok(());
                };
                if line.trim().is_empty() {
                    continue;
                }
                let message: Value = match serde_json::from_str(&line) {
                    Ok(message) => message,
                    Err(_) => {
                        write_message(&mut writer, &rpc_error(None, -32700, "Parse error")).await?;
                        continue;
                    }
                };
                let id = message.get("id");
                let key = id.and_then(RequestId::parse);
                let method = message.get("method").and_then(Value::as_str);
                if message.get("jsonrpc").and_then(Value::as_str) != Some("2.0")
                    || method.is_none()
                    || (id.is_some() && key.is_none())
                {
                    write_message(&mut writer, &rpc_error(id.filter(|_| key.is_some()), -32600, "Invalid request")).await?;
                    continue;
                }
                let method = method.expect("validated method");
                let params = message.get("params").cloned().unwrap_or_else(|| json!({}));
                let Some(id) = id else {
                    // Notifications never receive responses, including unknown
                    // notifications and cancellation of a completed request.
                    if method == "notifications/initialized" && negotiated && params.is_object() {
                        initialized = true;
                    } else if method == "notifications/cancelled" {
                        if let Some(key) = params.get("requestId").and_then(RequestId::parse) {
                            if let Some(cancel) = cancellations.get(&key) {
                                cancel.abort();
                            }
                        }
                    }
                    continue;
                };
                let key = key.expect("validated request id");
                if cancellations.contains_key(&key) {
                    write_message(&mut writer, &rpc_error(Some(id), -32600, "Request id is already active")).await?;
                    continue;
                }
                if !params.is_object() {
                    write_message(&mut writer, &rpc_error(Some(id), -32602, "params must be an object")).await?;
                    continue;
                }
                let immediate = match method {
                    "initialize" if !negotiated => {
                        match initialize(&params) {
                            Ok(result) => {
                                negotiated = true;
                                rpc_result(id, result)
                            }
                            Err(error) => rpc_error(Some(id), -32602, error.to_string()),
                        }
                    }
                    "initialize" => rpc_error(Some(id), -32600, "Already initialized"),
                    "ping" => rpc_result(id, json!({})),
                    _ if !initialized => rpc_error(Some(id), -32000, "Client has not completed initialization"),
                    "tools/list" => rpc_result(id, tools(&client.room)),
                    "tools/call" => {
                        let Some(name) = params.get("name").and_then(Value::as_str) else {
                            write_message(&mut writer, &rpc_error(Some(id), -32602, "Tool name is required")).await?;
                            continue;
                        };
                        if !matches!(name, "hub_agents" | "hub_read" | "hub_say" | "hub_send" | "hub_wait" | "hub_wait_agent") {
                            write_message(&mut writer, &rpc_error(Some(id), -32602, format!("Unknown tool: {name}"))).await?;
                            continue;
                        }
                        let empty = Map::new();
                        let arguments = match params.get("arguments") {
                            None => &empty,
                            Some(Value::Object(arguments)) => arguments,
                            _ => {
                                write_message(&mut writer, &rpc_error(Some(id), -32602, "Tool arguments must be an object")).await?;
                                continue;
                            }
                        };
                        let call = match ToolCall::parse(name, arguments) {
                            Ok(call) => call,
                            Err(error) => {
                                write_message(&mut writer, &rpc_result(id, tool_result(Err(error)))).await?;
                                continue;
                            }
                        };
                        let id = id.clone();
                        let client = client.clone();
                        let (cancel, registration) = AbortHandle::new_pair();
                        cancellations.insert(key.clone(), cancel);
                        pending.push(async move {
                            let response = Abortable::new(async move {
                                rpc_result(&id, tool_result(client.call(call).await))
                            }, registration).await;
                            (key, response)
                        }.boxed());
                        continue;
                    }
                    _ => rpc_error(Some(id), -32601, format!("Method not found: {method}")),
                };
                write_message(&mut writer, &immediate).await?;
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn wait_arguments_reject_unbounded_or_fractional_durations() {
        for value in [
            json!(0),
            json!(601),
            json!(-1),
            json!(1.5),
            json!(null),
            json!("60"),
        ] {
            let args = json!({"seconds": value});
            assert!(ToolCall::parse("hub_wait", args.as_object().unwrap()).is_err());
        }
        for value in [json!(1), json!(600), json!(600.0)] {
            let args = json!({"seconds": value});
            assert!(matches!(
                ToolCall::parse("hub_wait", args.as_object().unwrap()).unwrap(),
                ToolCall::Wait { seconds: 1 | 600 }
            ));
        }
    }

    #[test]
    fn request_ids_keep_string_and_number_cancellations_separate() {
        assert_ne!(RequestId::parse(&json!("0")), RequestId::parse(&json!(0)));
        assert_eq!(RequestId::parse(&json!(0)), Some(RequestId::Number(0)));
        assert_eq!(RequestId::parse(&json!(1.0)), RequestId::parse(&json!(1)));
        for value in [json!(null), json!(true), json!(1.5), json!([]), json!({})] {
            assert_eq!(RequestId::parse(&value), None);
        }
    }

    #[test]
    fn room_wait_ignores_self_and_unrelated_rooms() {
        let mut message: RoomMessage = serde_json::from_value(json!({
            "id": "event", "room": "work", "from": {"name": "peer"},
            "text": "result", "kind": "say", "ts": "2026-09-24T12:00:00Z"
        }))
        .unwrap();
        assert!(other_room_message(&message, "work", "me"));
        message.from.name = "me".into();
        assert!(!other_room_message(&message, "work", "me"));
        message.from.name = "peer".into();
        message.room = "elsewhere".into();
        assert!(!other_room_message(&message, "work", "me"));
    }
}
