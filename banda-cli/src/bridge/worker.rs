use super::{Binding, Health, SharedJournal, agent_hub, identity, store};
use crate::{
    config::Config,
    herdr::{Herdr, read_frame},
    hub::Hub,
    model::Media,
};
use anyhow::{Context, Result, bail, ensure};
use serde_json::{Value, json};
use std::time::Duration;
use tokio::{
    sync::{broadcast, mpsc},
    task::JoinHandle,
};

struct Subscription(JoinHandle<()>);
impl Drop for Subscription {
    fn drop(&mut self) {
        self.0.abort();
    }
}

pub async fn run(config: Config, binding: Binding, journal: SharedJournal, health: Health) {
    let mut delay = 1u64;
    loop {
        if store::bindings()
            .is_ok_and(|items| !items.iter().any(|item| item.run_id == binding.run_id))
        {
            return;
        }
        let result = connected(&config, &binding, &journal, &health).await;
        if let Err(error) = result {
            *health.lock().await =
                json!({"connected":false,"status":"unknown","reason":format!("{error:#}")});
            eprintln!("{}: {error:#}", binding.name);
        }
        tokio::time::sleep(Duration::from_secs(delay)).await;
        delay = (delay * 2).min(30);
    }
}

async fn connected(
    config: &Config,
    binding: &Binding,
    journal: &SharedJournal,
    health: &Health,
) -> Result<()> {
    let hub = agent_hub(config).await?;
    let mut events = hub.subscribe();
    let registration = hub.call("agents/register",json!({"name":binding.name,"room":binding.room,"kind":"agent","repo":binding.cwd,"command":binding.kind,"accept":binding.accept,"executorId":binding.executor_id,"runId":binding.run_id,"caps":["read","keys","herdr"]})).await?;
    ensure!(
        registration["runId"].as_str() == Some(&binding.run_id),
        "hub lacks managed executor/run fencing; no terminal input permitted"
    );
    if acknowledge(&hub, binding, journal).await? {
        return Ok(());
    }
    pull(&hub, binding, journal).await?;
    let herdr = binding.herdr();
    let (changed_tx, mut changed_rx) = mpsc::channel(1);
    let event_herdr = herdr.clone();
    let pane = binding.pane_id.clone();
    let _subscription = Subscription(tokio::spawn(async move {
        loop {
            match event_herdr.subscribe(&pane).await {
                Ok(mut reader) => {
                    while read_frame(&mut reader).await.is_ok() {
                        let _ = changed_tx.try_send(());
                    }
                }
                Err(_) => {}
            }
            let _ = changed_tx.try_send(());
            tokio::time::sleep(Duration::from_secs(3)).await;
        }
    }));
    let mut tick = tokio::time::interval(Duration::from_secs(2));
    tick.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Skip);
    let mut reported = Value::Null;
    let mut inbox_tick = 0u8;
    loop {
        tokio::select! {
            _ = tick.tick() => {
                inbox_tick += 1;
                if inbox_tick >= 15 { pull(&hub,binding,journal).await?; inbox_tick = 0; }
            }
            _ = changed_rx.recv() => {}
            event = events.recv() => {
                match event {
                    Ok(event) if event.name == "__disconnected" => bail!("hub disconnected; terminal state is not inferred from network state"),
                    Ok(event) if event.name == "agents/message" => journal.lock().await.receive(event.data,binding)?,
                    Ok(event) if event.name == "agents/readRequest" => {
                        let id = event.data["id"].clone();
                        let lines = event.data["lines"].as_u64().unwrap_or(80).clamp(1,500);
                        let text = match read_screen(binding,&herdr,lines).await { Ok(text) => text, Err(error) => format!("[banda runtime read unavailable: {error:#}]") };
                        hub.call("agents/readReply",json!({"id":id,"text":text})).await?;
                    }
                    Ok(_) => continue,
                    Err(broadcast::error::RecvError::Lagged(_)) => pull(&hub,binding,journal).await?,
                    Err(broadcast::error::RecvError::Closed) => bail!("hub event stream closed"),
                }
            }
        }
        // A fresh agent/process snapshot is authoritative, including after lost state events.
        let current = identity::verify(binding, &herdr).await;
        let (status, reason) = match &current {
            Ok(agent) => {
                let status = if agent["launch_pending"].as_bool().unwrap_or(false) {
                    "starting"
                } else {
                    match agent["agent_status"].as_str().unwrap_or("unknown") {
                        "idle" | "done" => "waiting",
                        "working" => "working",
                        "blocked" => "blocked",
                        _ => "unknown",
                    }
                };
                (status, None)
            }
            Err(error) => ("unknown", Some(format!("{error:#}"))),
        };
        let pending_reason = {
            let journal = journal.lock().await;
            journal
                .entries
                .iter()
                .find(|entry| entry.phase == "uncertain" || entry.phase == "rejected")
                .map(|entry| {
                    format!(
                        "delivery {} {}: {} — banda agent resolve {} {} retry|discard",
                        entry.id,
                        entry.phase,
                        entry.reason.as_deref().unwrap_or("requires inspection"),
                        binding.name,
                        entry.id
                    )
                })
                .or_else(|| (journal.entries.len() >= 2048 && journal.entries.iter().all(|entry| entry.phase != "acked"))
                    .then(|| "delivery journal is full; inspect and resolve pending messages before accepting more".into()))
        };
        let status = if pending_reason.is_some() {
            "unknown"
        } else {
            status
        };
        let state = json!({"status":status,"reason":reason.or(pending_reason)});
        if state != reported {
            hub.call("agents/status", state.clone()).await?;
            reported = state.clone();
        }
        *health.lock().await =
            json!({"connected":true,"status":state["status"],"reason":state["reason"]});
        // Acks are safe to repeat: they never submit input. Submitted journal records are durable.
        if acknowledge(&hub, binding, journal).await? {
            return Ok(());
        }
        if let Ok(current) = current {
            if deliver(config, &hub, binding, &herdr, journal, &current).await? {
                return Ok(());
            }
        }
    }
}

async fn pull(hub: &Hub, binding: &Binding, journal: &SharedJournal) -> Result<()> {
    let pending = hub.call("agents/inbox", json!({})).await?;
    let messages = pending.as_array().context("hub inbox was not an array")?;
    let mut journal = journal.lock().await;
    for message in messages {
        journal.receive(message.clone(), binding)?;
    }
    Ok(())
}

async fn acknowledge(hub: &Hub, binding: &Binding, journal: &SharedJournal) -> Result<bool> {
    let mut journal = journal.lock().await;
    let ids: Vec<_> = journal
        .entries
        .iter()
        .filter(|entry| entry.phase == "submitted" || entry.phase == "discarded")
        .map(|entry| entry.id.clone())
        .collect();
    if !ids.is_empty() {
        hub.call("agents/ack", json!({"ids":ids})).await?;
        for entry in &mut journal.entries {
            if ids.contains(&entry.id) {
                entry.phase = "acked".into();
            }
        }
        journal.save(binding)?;
    }
    let stopped = binding.owned
        && journal.entries.iter().any(|entry| {
            entry.phase == "acked"
                && entry.reason.is_none()
                && entry.message["kind"] == "control"
                && entry.message["text"]
                    .as_str()
                    .is_some_and(|text| text.split_whitespace().next() == Some("!stop"))
        });
    if stopped {
        hub.call(
            "agents/status",
            json!({"status":"stopped","reason":"Owned pane closed by verified owner control"}),
        )
        .await?;
        store::remove(&binding.name)?;
    }
    Ok(stopped)
}

async fn read_screen(binding: &Binding, herdr: &Herdr, lines: u64) -> Result<String> {
    let current = identity::verify(binding, herdr).await?;
    let source = if current["agent_status"] == "blocked" || current["agent_status"] == "working" {
        "visible"
    } else {
        "recent_unwrapped"
    };
    // pane.read is passive: unlike agent.read it never scrolls an application's own history.
    let result = herdr.call("pane.read",json!({"pane_id":binding.pane_id,"source":source,"format":"text","strip_ansi":true,"lines":lines})).await?;
    Ok(result
        .pointer("/read/text")
        .and_then(Value::as_str)
        .context("herdr read omitted text")?
        .into())
}

fn rejection(binding: &Binding, message: &Value) -> Option<String> {
    if message["runId"]
        .as_str()
        .is_some_and(|run| run != binding.run_id)
    {
        return Some("message belongs to a previous agent run; send a new request".into());
    }
    if message["kind"] == "control" {
        if message.pointer("/from/role").and_then(Value::as_str) != Some("owner") {
            return Some("terminal controls require owner identity".into());
        }
        if message["runId"].as_str() != Some(&binding.run_id) {
            return Some("control lacks the matching runId; stale controls never execute".into());
        }
        let text = message["text"].as_str().unwrap_or("");
        let command = text.split_whitespace().next().unwrap_or("");
        if !["!cancel", "!esc", "!keys", "!type", "!stop"].contains(&command) {
            return Some("unsupported terminal control".into());
        }
        if command == "!stop" && !binding.owned {
            return Some("!stop refuses to destroy an externally bound pane; unbind locally or stop it yourself in herdr".into());
        }
        if ["!keys", "!type"].contains(&command) && text[command.len()..].trim().is_empty() {
            return Some("control requires a nonempty argument".into());
        }
    } else if message["kind"] != "command" && message["kind"] != "info" {
        return Some("unsupported directed message kind".into());
    }
    None
}

async fn deliver(
    config: &Config,
    hub: &Hub,
    binding: &Binding,
    herdr: &Herdr,
    shared: &SharedJournal,
    current: &Value,
) -> Result<bool> {
    let mut journal = shared.lock().await;
    // Controls deliberately bypass queued prompts: a blocked agent must remain recoverable.
    let control = journal
        .entries
        .iter()
        .position(|entry| entry.phase == "queued" && entry.message["kind"] == "control");
    let index = control.or_else(|| {
        journal
            .entries
            .iter()
            .position(|entry| !["acked", "submitted", "discarded"].contains(&entry.phase.as_str()))
    });
    let Some(index) = index else {
        return Ok(false);
    };
    if journal.entries[index].phase != "queued" {
        return Ok(false);
    }
    let message = journal.entries[index].message.clone();
    if let Some(reason) = rejection(binding, &message) {
        journal.entries[index].phase = "rejected".into();
        journal.entries[index].reason = Some(reason.clone());
        journal.save(binding)?;
        hub.call("room/say",json!({"room":binding.room,"text":format!("{}: rejected delivery {}: {}",binding.name,journal.entries[index].id,reason)})).await?;
        return Ok(false);
    }
    let is_control = message["kind"] == "control";
    if !is_control {
        ensure!(
            current["agent"].as_str() == Some(&binding.kind),
            "unexpected current agent"
        );
        if !["idle", "done"].contains(&current["agent_status"].as_str().unwrap_or("unknown"))
            || !current["interactive_ready"].as_bool().unwrap_or(false)
            || current["launch_pending"].as_bool().unwrap_or(false)
        {
            return Ok(false);
        }
    }
    let text = if is_control {
        message["text"].as_str().unwrap_or("").to_owned()
    } else {
        prompt(config, binding, &message).await?
    };
    // Recheck immediately before the durable intent record and the write. The installed API has
    // no compare-and-submit primitive; server agent targeting supplies its additional live check.
    let fresh = identity::verify(binding, herdr).await?;
    if !is_control
        && (!["idle", "done"].contains(&fresh["agent_status"].as_str().unwrap_or("unknown"))
            || !fresh["interactive_ready"].as_bool().unwrap_or(false))
    {
        return Ok(false);
    }
    journal.entries[index].phase = "preparing".into();
    if let Err(error) = journal.save(binding) {
        journal.entries[index].phase = "uncertain".into();
        journal.entries[index].reason =
            Some(format!("intent persistence failed before write: {error:#}"));
        return Err(error);
    }
    let outcome = if is_control {
        control_input(binding, herdr, &text).await
    } else {
        herdr.call("agent.prompt",json!({"target":binding.native_name.as_deref().unwrap_or(&binding.pane_id),"text":text,"wait":{"until":["working","blocked"],"timeout_ms":8000}})).await.map(|_| ())
    };
    match outcome {
        Ok(()) => {
            journal.entries[index].phase = "submitted".into();
            journal.entries[index].reason = None;
            if let Err(error) = journal.save(binding) {
                journal.entries[index].phase = "uncertain".into();
                journal.entries[index].reason = Some(format!(
                    "input completed but durable receipt failed: {error:#}"
                ));
                return Err(error);
            }
            drop(journal);
            acknowledge(hub, binding, shared).await
        }
        Err(error) => {
            let reason = format!(
                "input outcome uncertain: {error:#}; inspect terminal before retry/discard"
            );
            journal.entries[index].phase = "uncertain".into();
            journal.entries[index].reason = Some(reason.clone());
            journal.save(binding)?;
            hub.call("room/say",json!({"room":binding.room,"text":format!("{}: delivery {}: {}",binding.name,journal.entries[index].id,reason)})).await?;
            Ok(false)
        }
    }
}

async fn prompt(config: &Config, binding: &Binding, message: &Value) -> Result<String> {
    let owner = message.pointer("/from/role").and_then(Value::as_str) == Some("owner");
    let from = message
        .pointer("/from/name")
        .and_then(Value::as_str)
        .unwrap_or("unknown");
    let accepts = owner
        || binding.accept == "any"
        || binding
            .accept
            .as_array()
            .is_some_and(|names| names.iter().any(|name| name.as_str() == Some(from)));
    let info = message["kind"] == "info" || !accepts;
    let mut text = format!(
        "[hub {from}{}] {}",
        if info { " (info)" } else { "" },
        message["text"].as_str().unwrap_or("")
    );
    if let Some(items) = message["media"]
        .as_array()
        .filter(|items| !items.is_empty())
    {
        let media: Vec<Media> = serde_json::from_value(Value::Array(items.clone()))?;
        let files = crate::media::download(config, &media).await?;
        for (item, path) in media.iter().zip(files) {
            text.push_str(&format!(
                "\n(attached file: {} = {})",
                item.name,
                path.display()
            ));
        }
    }
    Ok(text)
}

async fn control_input(binding: &Binding, herdr: &Herdr, text: &str) -> Result<()> {
    let trimmed = text.trim_start();
    let command = trimmed.split_whitespace().next().context("empty control")?;
    let arg = trimmed[command.len()..].trim_start();
    let target = binding.native_name.as_deref().unwrap_or(&binding.pane_id);
    match command {
        "!esc" | "!cancel" => {
            herdr
                .call("agent.send_keys", json!({"target":target,"keys":["esc"]}))
                .await?;
        }
        "!keys" => {
            let keys: Vec<_> = arg.split_whitespace().collect();
            ensure!(!keys.is_empty(), "!keys needs logical key names");
            // Herdr validates the entire list before emitting any bytes; no raw-key fallback.
            herdr
                .call("agent.send_keys", json!({"target":target,"keys":keys}))
                .await?;
        }
        "!type" => {
            herdr
                .call(
                    "pane.send_text",
                    json!({"pane_id":binding.pane_id,"text":arg}),
                )
                .await?;
        }
        "!stop" => {
            ensure!(binding.owned, "external panes cannot be closed");
            identity::verify(binding, herdr).await?;
            herdr
                .call("pane.close", json!({"pane_id":binding.pane_id}))
                .await?;
        }
        _ => bail!("unknown owner control"),
    }
    Ok(())
}
