use super::Binding;
use anyhow::{Context, Result, ensure};
use fs2::FileExt;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::{
    fs::{self, File, OpenOptions},
    io::Write,
    os::unix::fs::{OpenOptionsExt, PermissionsExt},
    path::{Path, PathBuf},
};

pub fn directory() -> Result<PathBuf> {
    let dir = crate::config::state_dir()?;
    fs::create_dir_all(&dir)?;
    fs::set_permissions(&dir, fs::Permissions::from_mode(0o700))?;
    Ok(dir)
}

pub fn lock(name: &str) -> Result<File> {
    let file = OpenOptions::new()
        .read(true)
        .write(true)
        .create(true)
        .truncate(false)
        .mode(0o600)
        .open(directory()?.join(name))?;
    file.try_lock_exclusive()
        .with_context(|| format!("banda {name} is busy"))?;
    Ok(file)
}

pub fn atomic<T: Serialize + ?Sized>(path: &Path, value: &T) -> Result<()> {
    let parent = path.parent().context("state path has no parent")?;
    let temp = parent.join(format!(".{}.tmp", uuid::Uuid::new_v4()));
    let result = (|| -> Result<()> {
        let mut file = OpenOptions::new()
            .write(true)
            .create_new(true)
            .mode(0o600)
            .open(&temp)?;
        serde_json::to_writer(&mut file, value)?;
        file.write_all(b"\n")?;
        file.sync_all()?;
        fs::rename(&temp, path)?;
        File::open(parent)?.sync_all()?;
        Ok(())
    })();
    if result.is_err() {
        let _ = fs::remove_file(temp);
    }
    result
}

pub fn bindings() -> Result<Vec<Binding>> {
    let path = directory()?.join("bindings.json");
    match fs::read(path) {
        Ok(bytes) => {
            serde_json::from_slice(&bytes).context("invalid banda bindings; refusing to overwrite")
        }
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(Vec::new()),
        Err(error) => Err(error.into()),
    }
}

pub fn insert(binding: &Binding) -> Result<()> {
    let _lock = lock("bindings.lock")?;
    let mut values = bindings()?;
    ensure!(
        !values.iter().any(|b| b.name == binding.name),
        "{} is already bound; unbind explicitly first",
        binding.name
    );
    ensure!(
        !values
            .iter()
            .any(|b| b.socket_path == binding.socket_path && b.terminal_id == binding.terminal_id),
        "terminal already has a banda executor"
    );
    values.push(binding.clone());
    atomic(&directory()?.join("bindings.json"), &values)
}

pub fn remove(name: &str) -> Result<()> {
    let _lock = lock("bindings.lock")?;
    let mut values = bindings()?;
    let before = values.len();
    values.retain(|binding| binding.name != name);
    ensure!(values.len() != before, "no local binding named {name}");
    atomic(&directory()?.join("bindings.json"), &values)
}

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct Delivery {
    pub id: String,
    pub phase: String,
    pub message: Value,
    pub reason: Option<String>,
}

#[derive(Default, Serialize, Deserialize)]
pub struct Journal {
    pub entries: Vec<Delivery>,
}

impl Journal {
    pub fn load(binding: &Binding) -> Result<Self> {
        let path = Self::path(binding)?;
        let mut journal: Self = match fs::read(path) {
            Ok(bytes) => serde_json::from_slice(&bytes)
                .context("invalid delivery journal; refusing all input")?,
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => Self::default(),
            Err(error) => return Err(error.into()),
        };
        for entry in &mut journal.entries {
            if entry.phase == "preparing" {
                entry.phase = "uncertain".into();
                entry.reason = Some("Bridge interrupted during input; inspect the terminal and resolve retry/discard explicitly".into());
            }
        }
        journal.save(binding)?;
        Ok(journal)
    }

    fn path(binding: &Binding) -> Result<PathBuf> {
        Ok(directory()?.join(format!("delivery-{}.json", binding.run_id)))
    }

    pub fn save(&self, binding: &Binding) -> Result<()> {
        atomic(&Self::path(binding)?, self)
    }

    pub fn receive(&mut self, message: Value, binding: &Binding) -> Result<()> {
        let id = message["id"].as_str().context("hub delivery missing id")?;
        if self.entries.iter().any(|entry| entry.id == id) {
            return Ok(());
        }
        // Only acknowledged tombstones can be evicted; unresolved deliveries are never forgotten.
        if self.entries.len() >= 2048 {
            if let Some(index) = self.entries.iter().position(|entry| entry.phase == "acked") {
                self.entries.remove(index);
            } else {
                // Leave the message unacknowledged at the hub. The worker must
                // keep draining/resolving existing entries, not reconnect-loop.
                return Ok(());
            }
        }
        self.entries.push(Delivery {
            id: id.into(),
            phase: "queued".into(),
            message,
            reason: None,
        });
        self.save(binding)
    }

    pub fn resolve(&mut self, binding: &Binding, id: &str, action: &str) -> Result<Value> {
        let entry = self
            .entries
            .iter_mut()
            .find(|entry| entry.id == id)
            .context("unknown delivery ID")?;
        ensure!(
            ["uncertain", "rejected", "queued"].contains(&entry.phase.as_str()),
            "delivery is {}; it cannot be resolved",
            entry.phase
        );
        match action {
            "retry" => {
                ensure!(
                    entry
                        .message
                        .get("runId")
                        .and_then(Value::as_str)
                        .is_none_or(|run| run == binding.run_id),
                    "stale run; send a new message rather than retry"
                );
                entry.phase = "queued".into();
                entry.reason = None;
            }
            "discard" => {
                entry.phase = "discarded".into();
                entry.reason = Some("Explicitly discarded; no further input will be submitted. Prior uncertain input may already have executed.".into());
            }
            _ => anyhow::bail!("resolution must be retry or discard"),
        }
        let result = serde_json::to_value(&*entry)?;
        self.save(binding)?;
        Ok(result)
    }
}
