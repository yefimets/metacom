use super::UiEvent;
use crate::{
    config::Config,
    hub::{Hub, HubEvent},
    model::{Member, Room, RoomMessage},
};
use anyhow::{Context, Result, bail};
use serde_json::json;
use std::time::Duration;
use tokio::sync::{broadcast, mpsc, watch};

pub(super) struct Snapshot {
    pub hub: Hub,
    pub room: String,
    pub rooms: Vec<Room>,
    pub members: Vec<Member>,
    pub messages: Vec<RoomMessage>,
}

async fn snapshot(hub: &Hub, room: String) -> Result<Snapshot> {
    hub.call_timeout("room/join", json!({"room": room}), Duration::from_secs(15))
        .await?;
    let messages = hub
        .call_timeout(
            "room/history",
            json!({"room": room, "limit": 500}),
            Duration::from_secs(15),
        )
        .await?;
    let rooms = hub
        .call_timeout("room/list", json!({}), Duration::from_secs(15))
        .await?;
    let members = hub
        .call_timeout("agents/list", json!({}), Duration::from_secs(15))
        .await?;
    Ok(Snapshot {
        hub: hub.clone(),
        room,
        rooms: serde_json::from_value(rooms).context("Invalid room list")?,
        members: serde_json::from_value(members).context("Invalid member list")?,
        messages: serde_json::from_value(messages).context("Invalid room history")?,
    })
}

pub(super) async fn supervise(
    config: Config,
    name: String,
    registration_room: String,
    mut room: watch::Receiver<String>,
    tx: mpsc::Sender<UiEvent>,
) {
    let mut delay = 1;
    loop {
        let result = connection(&config, &name, &registration_room, &mut room, &tx).await;
        if tx.is_closed() {
            return;
        }
        let error = result
            .err()
            .map_or_else(|| "Connection closed".to_owned(), |e| format!("{e:#}"));
        if tx
            .send(UiEvent::Offline(format!(
                "{error} · reconnecting in {delay}s"
            )))
            .await
            .is_err()
        {
            return;
        }
        tokio::select! {
            _ = tx.closed() => return,
            _ = tokio::time::sleep(Duration::from_secs(delay)) => {},
        }
        delay = (delay * 2).min(15);
    }
}

async fn connection(
    config: &Config,
    name: &str,
    registration_room: &str,
    room: &mut watch::Receiver<String>,
    tx: &mpsc::Sender<UiEvent>,
) -> Result<()> {
    let hub = Hub::connect(&config.url, config.owner_token()?).await?;
    let mut events = hub.subscribe();
    let identity = hub
        .call_timeout("auth/whoami", json!({}), Duration::from_secs(15))
        .await?;
    if identity.get("role").and_then(|v| v.as_str()) != Some("owner") {
        bail!("banda's interactive viewer requires an owner token; no agent credentials were used");
    }
    hub.call_timeout(
        "agents/register",
        json!({"name": name, "room": registration_room, "kind": "human"}),
        Duration::from_secs(15),
    )
    .await?;
    let mut desired = room.borrow_and_update().clone();
    loop {
        let state = snapshot(&hub, desired.clone()).await?;
        tx.send(UiEvent::Snapshot(state)).await?;
        // The receiver has existed since before register/join/history. Replaying it
        // merges UUIDs into history, so events during bootstrap are never dropped.
        loop {
            tokio::select! {
                _ = tx.closed() => return Ok(()),
                changed = room.changed() => {
                    changed?;
                    desired = room.borrow_and_update().clone();
                    break;
                },
                event = events.recv() => {
                    match event {
                        Ok(HubEvent { name, data }) if name == "__disconnected" => bail!("Hub disconnected: {data}"),
                        Ok(event) => { tx.send(UiEvent::Hub(event)).await?; },
                        Err(broadcast::error::RecvError::Lagged(n)) => bail!("Missed {n} live events; resynchronizing history"),
                        Err(broadcast::error::RecvError::Closed) => bail!("Hub connection closed"),
                    }
                }
            }
        }
    }
}
