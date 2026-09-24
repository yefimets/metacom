use super::Binding;
use crate::herdr::Herdr;
use anyhow::{Context, Result, ensure};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
pub struct ProcessIdentity {
    pub pid: u32,
    pub start: String,
}

pub async fn foreground(herdr: &Herdr, pane: &str) -> Result<ProcessIdentity> {
    let value = herdr
        .call("pane.process_info", json!({"pane_id":pane}))
        .await?;
    let info = &value["process_info"];
    let pid = info["foreground_process_group_id"]
        .as_u64()
        .context("herdr cannot establish foreground process identity on this platform")?;
    ensure!(
        pid > 0 && pid <= u32::MAX as u64,
        "invalid foreground process group"
    );
    ensure!(
        info["shell_pid"].as_u64() != Some(pid),
        "pane is at its shell, not a foreground agent"
    );
    ensure!(
        info["foreground_processes"]
            .as_array()
            .is_some_and(|list| list
                .iter()
                .any(|process| process["pid"].as_u64() == Some(pid))),
        "foreground process group leader is absent; refusing ambiguous incarnation"
    );
    Ok(ProcessIdentity {
        pid: pid as u32,
        start: process_start(pid as u32).await?,
    })
}

#[cfg(target_os = "linux")]
async fn process_start(pid: u32) -> Result<String> {
    let stat = tokio::fs::read_to_string(format!("/proc/{pid}/stat"))
        .await
        .context("read foreground process start identity")?;
    let rest = stat
        .rsplit_once(')')
        .context("invalid /proc process identity")?
        .1;
    let start = rest
        .split_whitespace()
        .nth(19)
        .context("missing /proc process start ticks")?;
    let boot = tokio::fs::read_to_string("/proc/sys/kernel/random/boot_id").await?;
    Ok(format!("{}:{}", boot.trim(), start))
}

#[cfg(target_os = "macos")]
async fn process_start(pid: u32) -> Result<String> {
    let output = tokio::process::Command::new("ps")
        .args(["-p", &pid.to_string(), "-o", "lstart="])
        .env("LC_ALL", "C")
        .output()
        .await?;
    ensure!(output.status.success(), "foreground process disappeared");
    let start = String::from_utf8(output.stdout)?.trim().to_owned();
    ensure!(!start.is_empty(), "missing foreground process start time");
    Ok(start)
}

#[cfg(not(any(target_os = "linux", target_os = "macos")))]
async fn process_start(_pid: u32) -> Result<String> {
    anyhow::bail!("foreground process verification is supported only on Linux and macOS")
}

pub async fn agent(herdr: &Herdr, target: &str) -> Result<Value> {
    let value = herdr.call("agent.get", json!({"target":target})).await?;
    value
        .get("agent")
        .filter(|agent| agent.is_object())
        .cloned()
        .context("herdr did not return a recognized agent")
}

pub async fn verify(binding: &Binding, herdr: &Herdr) -> Result<Value> {
    let current = agent(herdr, &binding.pane_id).await?;
    ensure!(
        current["terminal_id"].as_str() == Some(&binding.terminal_id),
        "terminal incarnation changed; unbind and explicitly bind the replacement"
    );
    ensure!(
        current["agent"].as_str() == Some(&binding.kind),
        "foreground agent kind changed; old input is fenced"
    );
    if let Some(name) = &binding.native_name {
        ensure!(
            current["name"].as_str() == Some(name),
            "native agent launch identity changed; old input is fenced"
        );
    }
    if !binding.native_session.is_null() {
        ensure!(
            current["agent_session"] == binding.native_session,
            "native agent session changed; old input is fenced"
        );
    }
    ensure!(
        foreground(herdr, &binding.pane_id).await? == binding.process,
        "foreground process incarnation changed; old input is fenced"
    );
    Ok(current)
}
