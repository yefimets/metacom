use anyhow::{Context, Result, anyhow, bail, ensure};
use reqwest::Url;
use serde_json::{Map, Value};
use std::env;
use std::fmt;
use std::fs::{self, File, OpenOptions};
use std::io::{Read, Write};
#[cfg(unix)]
use std::os::unix::fs::{DirBuilderExt, OpenOptionsExt, PermissionsExt};
use std::path::{Path, PathBuf};

const MAX_CONFIG_BYTES: u64 = 1024 * 1024;

#[derive(Clone)]
pub struct Config {
    pub url: String,
    pub token: Option<String>,
    pub agent_token: Option<String>,
    pub room: String,
    pub name: String,
    pub herdr_session: Option<String>,
}

impl fmt::Debug for Config {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        let public_url = Url::parse(&self.url).ok().map(|mut url| {
            let _ = url.set_username("");
            let _ = url.set_password(None);
            url.set_query(None);
            url.set_fragment(None);
            url
        });
        f.debug_struct("Config")
            .field(
                "url",
                &public_url
                    .as_ref()
                    .map(Url::as_str)
                    .unwrap_or("[invalid URL]"),
            )
            .field("token", &self.token.as_ref().map(|_| "[redacted]"))
            .field(
                "agent_token",
                &self.agent_token.as_ref().map(|_| "[redacted]"),
            )
            .field("room", &self.room)
            .field("name", &self.name)
            .field("herdr_session", &self.herdr_session)
            .finish()
    }
}

impl Config {
    pub fn load() -> Result<Self> {
        let stored = read_object(&config_path()?)?;
        let setting = |key: &str, variable: &str| -> Result<Option<String>> {
            match env::var(variable) {
                Ok(value) => Ok(Some(value)),
                Err(env::VarError::NotPresent) => stored_string(&stored, key),
                Err(env::VarError::NotUnicode(_)) => bail!("{variable} must be valid Unicode"),
            }
        };
        let url = setting("url", "MC_HUB_URL")?.unwrap_or_else(|| "ws://127.0.0.1:8900/".into());
        Ok(Self {
            url: websocket_url(&url)?.into(),
            token: setting("token", "MC_TOKEN")?,
            agent_token: setting("agentToken", "MC_AGENT_TOKEN")?,
            room: setting("room", "MC_ROOM")?.unwrap_or_else(|| "default".into()),
            name: setting("name", "MC_NAME")?
                .or_else(|| env::var("USER").ok().filter(|name| !name.is_empty()))
                .unwrap_or_else(|| "human".into()),
            herdr_session: setting("herdrSession", "MC_HERDR_SESSION")?,
        })
    }

    pub fn save(&self) -> Result<()> {
        let path = config_path()?;
        let parent = path
            .parent()
            .filter(|p| !p.as_os_str().is_empty())
            .unwrap_or(Path::new("."));
        // An override may name a file directly in an existing shared directory.
        // Secure newly created directories without chmod'ing that shared parent.
        if env::var_os("MC_CONFIG").is_some() {
            create_private_dir(parent)?;
        } else {
            ensure_private_dir(parent)?;
        }
        let mut stored = read_object(&path)?;
        stored.insert(
            "url".into(),
            Value::String(websocket_url(&self.url)?.into()),
        );
        stored.insert(
            "token".into(),
            self.token.clone().map(Value::String).unwrap_or(Value::Null),
        );
        stored.insert(
            "agentToken".into(),
            self.agent_token
                .clone()
                .map(Value::String)
                .unwrap_or(Value::Null),
        );
        stored.insert("room".into(), Value::String(self.room.clone()));
        stored.insert("name".into(), Value::String(self.name.clone()));
        stored.insert(
            "herdrSession".into(),
            self.herdr_session
                .clone()
                .map(Value::String)
                .unwrap_or(Value::Null),
        );
        let mut bytes =
            serde_json::to_vec_pretty(&stored).context("cannot encode banda configuration")?;
        bytes.push(b'\n');
        atomic_private_write(&path, &bytes).context("cannot save banda configuration")
    }

    pub fn owner_token(&self) -> Result<&str> {
        self.token
            .as_deref()
            .filter(|token| !token.trim().is_empty())
            .ok_or_else(|| anyhow!("No owner token configured; run banda login or set MC_TOKEN"))
    }

    pub fn agent_token(&self) -> Result<&str> {
        self.agent_token.as_deref().filter(|token| !token.trim().is_empty())
            .ok_or_else(|| anyhow!("No agent token configured; save an agent token or set MC_AGENT_TOKEN (the owner token is never used for agents)"))
    }
}

pub fn config_path() -> Result<PathBuf> {
    if let Some(path) = env::var_os("MC_CONFIG") {
        ensure!(!path.is_empty(), "MC_CONFIG must not be empty");
        let path = PathBuf::from(path);
        ensure!(path.file_name().is_some(), "MC_CONFIG must name a file");
        return Ok(path);
    }
    Ok(home()?.join(".config/metacom-hub/config.json"))
}

pub fn state_dir() -> Result<PathBuf> {
    let path = if let Some(path) = env::var_os("MC_STATE_DIR") {
        ensure!(!path.is_empty(), "MC_STATE_DIR must not be empty");
        PathBuf::from(path)
    } else {
        let root = match env::var_os("XDG_STATE_HOME").filter(|value| !value.is_empty()) {
            Some(root) => PathBuf::from(root),
            None => home()?.join(".local/state"),
        };
        root.join("banda")
    };
    ensure!(
        path.file_name().is_some(),
        "Banda state directory must not be a filesystem root or dot directory"
    );
    ensure_private_dir(&path)?;
    Ok(path)
}

fn home() -> Result<PathBuf> {
    dirs::home_dir()
        .ok_or_else(|| anyhow!("Cannot locate home directory; set MC_CONFIG and MC_STATE_DIR"))
}

fn stored_string(object: &Map<String, Value>, key: &str) -> Result<Option<String>> {
    match object.get(key) {
        None | Some(Value::Null) => Ok(None),
        Some(Value::String(value)) => Ok(Some(value.clone())),
        Some(_) => bail!("Configuration field {key} must be a string or null"),
    }
}

fn read_object(path: &Path) -> Result<Map<String, Value>> {
    let file = match File::open(path) {
        Ok(file) => file,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(Map::new()),
        Err(error) => return Err(error).context("cannot read banda configuration"),
    };
    ensure!(
        file.metadata()?.is_file(),
        "Configuration must be a regular file"
    );
    let mut bytes = Vec::new();
    file.take(MAX_CONFIG_BYTES + 1).read_to_end(&mut bytes)?;
    ensure!(
        bytes.len() as u64 <= MAX_CONFIG_BYTES,
        "Configuration exceeds 1 MiB"
    );
    // Do not include serde's potentially secret-bearing input in diagnostics.
    let value: Value =
        serde_json::from_slice(&bytes).map_err(|_| anyhow!("Configuration is not valid JSON"))?;
    match value {
        Value::Object(object) => Ok(object),
        _ => bail!("Configuration must be a JSON object"),
    }
}

pub(crate) fn websocket_url(raw: &str) -> Result<Url> {
    let mut url = Url::parse(raw).map_err(|_| anyhow!("Hub URL is invalid"))?;
    let scheme = match url.scheme() {
        "http" | "ws" => "ws",
        "https" | "wss" => "wss",
        _ => bail!("Hub URL must use http, https, ws or wss"),
    };
    ensure!(url.host_str().is_some(), "Hub URL must include a host");
    ensure!(
        url.username().is_empty() && url.password().is_none(),
        "Hub URL must not contain credentials; use a token instead"
    );
    ensure!(
        url.fragment().is_none(),
        "Hub URL must not contain a fragment"
    );
    url.set_scheme(scheme)
        .map_err(|_| anyhow!("Hub URL scheme is invalid"))?;
    Ok(url)
}

pub(crate) fn ensure_private_dir(path: &Path) -> Result<()> {
    create_private_dir(path)?;
    #[cfg(unix)]
    fs::set_permissions(path, fs::Permissions::from_mode(0o700))
        .context("cannot make banda state directory private")?;
    Ok(())
}

fn create_private_dir(path: &Path) -> Result<()> {
    let mut builder = fs::DirBuilder::new();
    builder.recursive(true);
    #[cfg(unix)]
    builder.mode(0o700);
    builder
        .create(path)
        .context("cannot create banda directory")?;
    let metadata = fs::symlink_metadata(path)?;
    ensure!(
        metadata.is_dir() && !metadata.file_type().is_symlink(),
        "Banda directory must be a real directory, not a symlink"
    );
    Ok(())
}

pub(crate) fn atomic_private_write(path: &Path, bytes: &[u8]) -> Result<()> {
    let parent = path
        .parent()
        .filter(|p| !p.as_os_str().is_empty())
        .unwrap_or(Path::new("."));
    let temporary = parent.join(format!(".banda-{}.tmp", uuid::Uuid::new_v4()));
    let mut options = OpenOptions::new();
    options.write(true).create_new(true);
    #[cfg(unix)]
    options.mode(0o600);
    let mut file = options
        .open(&temporary)
        .context("cannot create private temporary file")?;
    let result = (|| -> Result<()> {
        file.write_all(bytes)?;
        file.sync_all()?;
        fs::rename(&temporary, path)?;
        File::open(parent)?.sync_all()?;
        Ok(())
    })();
    if result.is_err() {
        let _ = fs::remove_file(&temporary);
    }
    result
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn tokens_are_role_separated_and_redacted() {
        let config = Config {
            url: "ws://localhost/".into(),
            token: Some("owner-secret".into()),
            agent_token: None,
            room: "default".into(),
            name: "human".into(),
            herdr_session: None,
        };
        assert!(config.agent_token().is_err());
        assert_eq!(config.owner_token().unwrap(), "owner-secret");
        assert!(!format!("{config:?}").contains("owner-secret"));
        let agent = Config {
            token: None,
            agent_token: Some("agent-secret".into()),
            ..config
        };
        assert!(agent.owner_token().is_err());
        assert_eq!(agent.agent_token().unwrap(), "agent-secret");
        assert!(!format!("{agent:?}").contains("agent-secret"));
    }

    #[test]
    fn credentials_in_urls_are_rejected_without_echoing_them() {
        let error = websocket_url("https://owner:secret@host/")
            .unwrap_err()
            .to_string();
        assert!(!error.contains("secret"));
        assert_eq!(
            websocket_url("https://host/path").unwrap().as_str(),
            "wss://host/path"
        );
    }
}
