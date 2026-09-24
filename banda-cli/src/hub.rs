use anyhow::{Result, anyhow, bail, ensure};
use futures_util::{SinkExt, StreamExt};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use std::collections::HashMap;
use std::fmt;
use std::sync::Arc;
use std::time::Duration;
use tokio::net::TcpStream;
use tokio::sync::{Notify, broadcast, mpsc, oneshot};
use tokio::time::{Instant, MissedTickBehavior};
use tokio_tungstenite::tungstenite::{Error as WsError, Message, protocol::WebSocketConfig};
use tokio_tungstenite::{MaybeTlsStream, WebSocketStream, connect_async_with_config};

const DEFAULT_TIMEOUT: Duration = Duration::from_secs(630);
const CONNECT_TIMEOUT: Duration = Duration::from_secs(20);
const WRITE_TIMEOUT: Duration = Duration::from_secs(10);
const HEARTBEAT_INTERVAL: Duration = Duration::from_secs(30);
const HEARTBEAT_DEADLINE: Duration = Duration::from_secs(90);
const MAX_PENDING: usize = 256;
const COMMAND_CAPACITY: usize = 64;
const EVENT_CAPACITY: usize = 512;

type Socket = WebSocketStream<MaybeTlsStream<TcpStream>>;
type Reply = oneshot::Sender<Result<Value>>;

#[derive(Clone, Debug)]
pub struct HubEvent {
    pub name: String,
    pub data: Value,
}

#[derive(Clone, Debug, Deserialize)]
pub struct RpcError {
    pub code: i64,
    pub message: String,
}

impl fmt::Display for RpcError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "Hub error {}: {}", self.code, self.message)
    }
}

impl std::error::Error for RpcError {}

#[derive(Clone)]
pub struct Hub {
    inner: Arc<Inner>,
}

struct Inner {
    commands: mpsc::Sender<Command>,
    events: broadcast::Sender<HubEvent>,
    cancelled: Arc<Notify>,
    shutdown: Option<oneshot::Sender<()>>,
}

impl Drop for Inner {
    fn drop(&mut self) {
        if let Some(shutdown) = self.shutdown.take() {
            let _ = shutdown.send(());
        }
    }
}

struct Command {
    method: String,
    args: Value,
    deadline: Instant,
    reply: Reply,
}

struct Pending {
    reply: Reply,
}

// A dropped call wakes the actor even when the hub will never answer that call.
// Notifications coalesce, so cancellation itself cannot fill an unbounded queue.
struct CancelOnDrop(Arc<Notify>);

impl Drop for CancelOnDrop {
    fn drop(&mut self) {
        self.0.notify_one();
    }
}

#[derive(Serialize)]
struct CallPacket<'a> {
    #[serde(rename = "type")]
    kind: &'static str,
    id: &'a str,
    method: &'a str,
    args: &'a Value,
}

#[derive(Deserialize)]
#[serde(tag = "type")]
enum Packet {
    #[serde(rename = "callback")]
    Callback {
        id: String,
        #[serde(default)]
        result: Value,
        error: Option<RpcError>,
    },
    #[serde(rename = "event")]
    Event {
        name: String,
        #[serde(default)]
        data: Value,
    },
}

impl Hub {
    pub async fn connect(url: &str, token: &str) -> Result<Self> {
        ensure!(!token.trim().is_empty(), "A hub token is required");
        let url = crate::config::websocket_url(url)?;
        let limits = WebSocketConfig::default()
            .max_message_size(Some(8 * 1024 * 1024))
            .max_frame_size(Some(8 * 1024 * 1024));
        let (socket, _) = tokio::time::timeout(
            CONNECT_TIMEOUT,
            connect_async_with_config(url.as_str(), Some(limits), true),
        )
        .await
        .map_err(|_| anyhow!("Hub connection timed out"))?
        .map_err(socket_error)?;
        let (commands, receiver) = mpsc::channel(COMMAND_CAPACITY);
        let (events, _) = broadcast::channel(EVENT_CAPACITY);
        let cancelled = Arc::new(Notify::new());
        let (shutdown, stop) = oneshot::channel();
        tokio::spawn(run_actor(
            socket,
            receiver,
            events.clone(),
            cancelled.clone(),
            stop,
        ));
        let hub = Self {
            inner: Arc::new(Inner {
                commands,
                events,
                cancelled,
                shutdown: Some(shutdown),
            }),
        };
        // Raw Metacom calls do not need JS API introspection/scaffolding.
        hub.call_timeout("auth/signin", json!({"token": token}), CONNECT_TIMEOUT)
            .await?;
        Ok(hub)
    }

    pub async fn call(&self, method: &str, args: Value) -> Result<Value> {
        self.call_timeout(method, args, DEFAULT_TIMEOUT).await
    }

    pub async fn call_timeout(
        &self,
        method: &str,
        args: Value,
        timeout: Duration,
    ) -> Result<Value> {
        let Some((unit, procedure)) = method.split_once('/') else {
            bail!("RPC method must be unit/method");
        };
        ensure!(
            !unit.is_empty() && !procedure.is_empty() && !procedure.contains('/'),
            "RPC method must be unit/method"
        );
        ensure!(!timeout.is_zero(), "RPC timeout must be greater than zero");
        let deadline = Instant::now()
            .checked_add(timeout)
            .ok_or_else(|| anyhow!("RPC timeout is too large"))?;
        let _cancel = CancelOnDrop(self.inner.cancelled.clone());
        let (reply, response) = oneshot::channel();
        let command = Command {
            method: method.into(),
            args,
            deadline,
            reply,
        };
        tokio::time::timeout_at(deadline, async {
            self.inner
                .commands
                .send(command)
                .await
                .map_err(|_| disconnected())?;
            response.await.map_err(|_| disconnected())?
        })
        .await
        .map_err(|_| timed_out())?
    }

    pub fn subscribe(&self) -> broadcast::Receiver<HubEvent> {
        self.inner.events.subscribe()
    }
}

fn disconnected() -> anyhow::Error {
    anyhow!("Hub disconnected; an in-flight action may have completed, so it was not retried")
}

fn timed_out() -> anyhow::Error {
    anyhow!("Hub call timed out; an in-flight action may have completed, so it was not retried")
}

fn prune_pending(pending: &mut HashMap<String, Pending>) {
    pending.retain(|_, call| !call.reply.is_closed());
}

async fn run_actor(
    mut socket: Socket,
    mut commands: mpsc::Receiver<Command>,
    events: broadcast::Sender<HubEvent>,
    cancelled: Arc<Notify>,
    mut shutdown: oneshot::Receiver<()>,
) {
    let mut pending: HashMap<String, Pending> = HashMap::new();
    let mut heartbeat =
        tokio::time::interval_at(Instant::now() + HEARTBEAT_INTERVAL, HEARTBEAT_INTERVAL);
    heartbeat.set_missed_tick_behavior(MissedTickBehavior::Delay);
    let mut last_received = Instant::now();
    let reason = loop {
        tokio::select! {
            _ = &mut shutdown => break "Hub client closed".to_owned(),
            _ = cancelled.notified() => prune_pending(&mut pending),
            incoming = socket.next() => {
                match incoming {
                    Some(Ok(message)) => {
                        last_received = Instant::now();
                        match message {
                            Message::Text(text) => {
                                let packet = match serde_json::from_str::<Packet>(&text) {
                                    Ok(packet) => packet,
                                    Err(_) => break "Hub sent an invalid RPC packet".to_owned(),
                                };
                                match packet {
                                    Packet::Callback { id, result, error } => {
                                        if let Some(call) = pending.remove(&id) {
                                            let result = match error {
                                                Some(error) => Err(error.into()),
                                                None => Ok(result),
                                            };
                                            let _ = call.reply.send(result);
                                        }
                                        // Late responses to cancelled/timed-out calls are expected.
                                    }
                                    Packet::Event { name, data } => {
                                        let _ = events.send(HubEvent { name, data });
                                    }
                                }
                            }
                            Message::Ping(payload) => {
                                if let Err(error) = send_frame(&mut socket, Message::Pong(payload), &mut shutdown).await {
                                    break error.to_string();
                                }
                            }
                            Message::Pong(_) => {}
                            Message::Close(_) => break "Hub closed the connection".to_owned(),
                            Message::Binary(_) | Message::Frame(_) => {
                                break "Hub sent an unsupported binary RPC packet".to_owned();
                            }
                        }
                    }
                    Some(Err(error)) => break socket_error(error).to_string(),
                    None => break "Hub connection ended".to_owned(),
                }
            }
            command = commands.recv() => {
                let Some(command) = command else { break "Hub client closed".to_owned() };
                if command.reply.is_closed() {
                    continue;
                }
                if command.deadline <= Instant::now() {
                    let _ = command.reply.send(Err(timed_out()));
                    continue;
                }
                prune_pending(&mut pending);
                if pending.len() >= MAX_PENDING {
                    let _ = command.reply.send(Err(anyhow!("Too many concurrent hub calls; request was not sent")));
                    continue;
                }
                let id = uuid::Uuid::new_v4().to_string();
                let packet = match serde_json::to_string(&CallPacket {
                    kind: "call", id: &id, method: &command.method, args: &command.args,
                }) {
                    Ok(packet) => packet,
                    Err(_) => {
                        let _ = command.reply.send(Err(anyhow!("Cannot encode hub call; request was not sent")));
                        continue;
                    }
                };
                pending.insert(id, Pending { reply: command.reply });
                if let Err(error) = send_frame(&mut socket, Message::Text(packet.into()), &mut shutdown).await {
                    break error.to_string();
                }
            }
            _ = heartbeat.tick() => {
                prune_pending(&mut pending);
                if last_received.elapsed() >= HEARTBEAT_DEADLINE {
                    break "Hub stopped responding to websocket heartbeats".to_owned();
                }
                if let Err(error) = send_frame(&mut socket, Message::Ping(Default::default()), &mut shutdown).await {
                    break error.to_string();
                }
            }
        }
    };
    commands.close();
    for (_, call) in pending {
        let _ = call.reply.send(Err(disconnected()));
    }
    while let Ok(command) = commands.try_recv() {
        let _ = command.reply.send(Err(disconnected()));
    }
    let _ = events.send(HubEvent {
        name: "__disconnected".into(),
        data: json!({"reason": reason}),
    });
    // Close handshakes must not keep the last client/socket alive indefinitely.
    let _ = tokio::time::timeout(Duration::from_secs(1), socket.close(None)).await;
}

async fn send_frame(
    socket: &mut Socket,
    frame: Message,
    shutdown: &mut oneshot::Receiver<()>,
) -> Result<()> {
    tokio::select! {
        biased;
        _ = shutdown => Err(anyhow!("Hub client closed")),
        result = tokio::time::timeout(WRITE_TIMEOUT, socket.send(frame)) => {
            result.map_err(|_| anyhow!("Hub websocket write timed out"))?.map_err(socket_error)
        }
    }
}

fn socket_error(error: WsError) -> anyhow::Error {
    // Handshake errors can contain URLs, headers or entire response bodies.
    // Never forward those diagnostics (or arbitrary close reasons) to a UI/log.
    match error {
        WsError::Io(error) => anyhow!("Hub websocket I/O failure ({:?})", error.kind()),
        WsError::Http(response) => anyhow!(
            "Hub websocket handshake failed (HTTP {})",
            response.status()
        ),
        WsError::Tls(_) => anyhow!("Hub websocket TLS handshake failed"),
        WsError::ConnectionClosed | WsError::AlreadyClosed => disconnected(),
        WsError::Capacity(_) => anyhow!("Hub websocket frame exceeds the size limit"),
        _ => anyhow!("Hub websocket protocol error"),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use tokio::net::TcpListener;
    use tokio_tungstenite::accept_async;

    type ServerSocket = WebSocketStream<TcpStream>;

    async fn accept_client(listener: TcpListener) -> ServerSocket {
        let (socket, _) = listener.accept().await.unwrap();
        let mut socket = accept_async(socket).await.unwrap();
        let signin = next_call(&mut socket).await;
        assert_eq!(signin["method"], "auth/signin");
        socket.send(Message::Text(json!({
            "type": "callback", "id": signin["id"], "result": {"name": "owner", "role": "owner"}
        }).to_string().into())).await.unwrap();
        socket
    }

    async fn next_call(socket: &mut ServerSocket) -> Value {
        loop {
            match socket.next().await.unwrap().unwrap() {
                Message::Text(text) => return serde_json::from_str(&text).unwrap(),
                Message::Ping(payload) => socket.send(Message::Pong(payload)).await.unwrap(),
                message => panic!("unexpected message: {message:?}"),
            }
        }
    }

    async fn listen() -> (TcpListener, String) {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let url = format!("ws://{}/", listener.local_addr().unwrap());
        (listener, url)
    }

    #[tokio::test]
    async fn long_call_does_not_block_events_or_ping_and_preserves_rpc_code() {
        tokio::time::timeout(Duration::from_secs(5), async {
            let (listener, url) = listen().await;
            let server =
                tokio::spawn(async move {
                    let mut socket = accept_client(listener).await;
                    let call = next_call(&mut socket).await;
                    socket
                        .send(Message::Ping(b"alive".to_vec().into()))
                        .await
                        .unwrap();
                    socket.send(Message::Text(json!({
                    "type": "event", "name": "room/message", "data": {"text": "still live"}
                }).to_string().into())).await.unwrap();
                    match socket.next().await.unwrap().unwrap() {
                        Message::Pong(payload) => assert_eq!(payload.as_ref(), b"alive"),
                        message => panic!("ping was not answered: {message:?}"),
                    }
                    socket
                        .send(Message::Text(
                            json!({
                                "type": "callback", "id": call["id"],
                                "error": {"code": 403, "message": "Agent access denied"}
                            })
                            .to_string()
                            .into(),
                        ))
                        .await
                        .unwrap();
                });
            let hub = Hub::connect(&url, "test-token").await.unwrap();
            let mut events = hub.subscribe();
            let other = hub.clone();
            let call = tokio::spawn(async move {
                other
                    .call(
                        "agents/wait",
                        json!({"name": "worker", "timeoutMs": 620000}),
                    )
                    .await
            });
            let event = events.recv().await.unwrap();
            assert_eq!(event.name, "room/message");
            assert_eq!(event.data["text"], "still live");
            let error = call.await.unwrap().unwrap_err();
            let rpc = error.downcast_ref::<RpcError>().unwrap();
            assert_eq!(rpc.code, 403);
            assert_eq!(rpc.message, "Agent access denied");
            server.await.unwrap();
        })
        .await
        .unwrap();
    }

    #[tokio::test]
    async fn cancelled_calls_release_capacity_and_late_responses_are_ignored() {
        tokio::time::timeout(Duration::from_secs(10), async {
            let (listener, url) = listen().await;
            let (seen, mut received) = mpsc::channel(1);
            let server =
                tokio::spawn(async move {
                    let mut socket = accept_client(listener).await;
                    let mut first_id = None;
                    for _ in 0..MAX_PENDING + 4 {
                        let call = next_call(&mut socket).await;
                        first_id.get_or_insert_with(|| call["id"].clone());
                        seen.send(()).await.unwrap();
                    }
                    let probe = next_call(&mut socket).await;
                    socket.send(Message::Text(json!({
                    "type": "callback", "id": first_id.unwrap(), "result": {"late": true}
                }).to_string().into())).await.unwrap();
                    socket
                        .send(Message::Text(
                            json!({
                                "type": "callback", "id": probe["id"], "result": {"online": true}
                            })
                            .to_string()
                            .into(),
                        ))
                        .await
                        .unwrap();
                });
            let hub = Hub::connect(&url, "test-token").await.unwrap();
            for _ in 0..MAX_PENDING + 4 {
                let other = hub.clone();
                let call = tokio::spawn(async move { other.call("agents/wait", json!({})).await });
                received.recv().await.unwrap();
                call.abort();
                assert!(call.await.unwrap_err().is_cancelled());
            }
            let result = hub.call("room/list", json!({})).await.unwrap();
            assert_eq!(result["online"], true);
            server.await.unwrap();
        })
        .await
        .unwrap();
    }

    #[tokio::test]
    async fn socket_loss_fails_all_pending_calls_and_emits_disconnect() {
        tokio::time::timeout(Duration::from_secs(5), async {
            let (listener, url) = listen().await;
            let server = tokio::spawn(async move {
                let mut socket = accept_client(listener).await;
                next_call(&mut socket).await;
                next_call(&mut socket).await;
                socket.close(None).await.unwrap();
            });
            let hub = Hub::connect(&url, "test-token").await.unwrap();
            let mut events = hub.subscribe();
            let (first, second) = tokio::join!(
                hub.call("agents/wait", json!({"name": "first"})),
                hub.call("agents/wait", json!({"name": "second"})),
            );
            assert!(first.unwrap_err().to_string().contains("disconnected"));
            assert!(second.unwrap_err().to_string().contains("disconnected"));
            assert_eq!(events.recv().await.unwrap().name, "__disconnected");
            server.await.unwrap();
        })
        .await
        .unwrap();
    }

    #[tokio::test]
    async fn dropping_the_last_client_closes_the_connection() {
        tokio::time::timeout(Duration::from_secs(5), async {
            let (listener, url) = listen().await;
            let server = tokio::spawn(async move {
                let mut socket = accept_client(listener).await;
                assert!(matches!(
                    socket.next().await,
                    Some(Ok(Message::Close(_))) | None
                ));
            });
            let hub = Hub::connect(&url, "test-token").await.unwrap();
            let last = hub.clone();
            drop(hub);
            drop(last);
            server.await.unwrap();
        })
        .await
        .unwrap();
    }
}
