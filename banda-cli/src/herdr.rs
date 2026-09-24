use anyhow::{Context, Result, bail, ensure};
use serde_json::{Value, json};
use std::{path::PathBuf, process::Stdio, sync::Arc, time::Duration};
use tokio::{
    io::{AsyncBufReadExt, AsyncWriteExt, BufReader},
    net::UnixStream,
    process::Command,
    sync::OnceCell,
};

/// The local, public herdr socket protocol. No mutation is ever retried here.
#[derive(Clone, Debug)]
pub struct Herdr {
    session: Option<String>,
    socket: Arc<OnceCell<PathBuf>>,
}

impl Herdr {
    pub fn new(session: Option<String>) -> Self {
        Self {
            session,
            socket: Arc::new(OnceCell::new()),
        }
    }

    pub fn at_socket(session: Option<String>, socket: PathBuf) -> Self {
        Self {
            session,
            socket: Arc::new(OnceCell::new_with(Some(socket))),
        }
    }
    pub async fn socket_path(&self) -> Result<&PathBuf> {
        self.socket
            .get_or_try_init(|| async {
                if let Some(path) = std::env::var_os("MC_HERDR_SOCKET")
                    .or_else(|| std::env::var_os("HERDR_SOCKET_PATH"))
                {
                    return Ok(PathBuf::from(path));
                }
                // Let the installed CLI resolve its config/session paths instead of duplicating them.
                let output = self
                    .command()
                    .args(["status", "--json"])
                    .output()
                    .await
                    .context("locate herdr socket (install herdr first)")?;
                ensure!(
                    output.status.success(),
                    "herdr status failed: {}",
                    String::from_utf8_lossy(&output.stderr)
                );
                let value: Value = serde_json::from_slice(&output.stdout)?;
                let path = value
                    .pointer("/server/socket")
                    .and_then(Value::as_str)
                    .context("herdr status did not expose server.socket")?;
                Ok(PathBuf::from(path))
            })
            .await
    }

    fn command(&self) -> Command {
        let mut command = Command::new("herdr");
        if let Some(session) = &self.session {
            command.args(["--session", session]);
        }
        if let Some(socket) = std::env::var_os("MC_HERDR_SOCKET") {
            command.env("HERDR_SOCKET_PATH", socket);
        }
        if let Some(socket) = self.socket.get() {
            command.env("HERDR_SOCKET_PATH", socket);
        }
        command
    }

    pub async fn call(&self, method: &str, params: Value) -> Result<Value> {
        let timeout = if method == "agent.start" { 315 } else { 20 };
        tokio::time::timeout(Duration::from_secs(timeout), async {
            let mut stream = UnixStream::connect(self.socket_path().await?)
                .await
                .context("connect to herdr")?;
            let id = uuid::Uuid::new_v4().to_string();
            send_request(&mut stream, &id, method, params).await?;
            let mut reader = BufReader::new(stream);
            loop {
                let response = read_frame(&mut reader).await?;
                if response["id"].as_str() == Some(&id) {
                    return response_result(response);
                }
            }
        })
        .await
        .context("herdr RPC deadline exceeded; mutation outcome may be uncertain")?
    }

    pub async fn ensure_running(&self) -> Result<()> {
        if self.call("ping", json!({})).await.is_ok() {
            return Ok(());
        }
        let mut command = self.command();
        command
            .arg("server")
            .env_remove("MC_TOKEN")
            .env_remove("MC_AGENT_TOKEN")
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null());
        detach(&mut command);
        let mut child = command.spawn().context("start persistent herdr server")?;
        for _ in 0..100 {
            tokio::time::sleep(Duration::from_millis(100)).await;
            if self.call("ping", json!({})).await.is_ok() {
                tokio::spawn(async move {
                    let _ = child.wait().await;
                });
                return Ok(());
            }
            if let Some(status) = child.try_wait()? {
                bail!(
                    "herdr server exited ({status}); inspect herdr server logs; no existing server was stopped"
                );
            }
        }
        bail!("herdr server did not become ready; it was not stopped, inspect herdr logs")
    }

    pub async fn attach(&self, target: &str) -> Result<()> {
        let group = unsafe { libc::tcgetpgrp(libc::STDIN_FILENO) };
        ensure!(
            group > 0,
            "native terminal attachment requires a controlling terminal"
        );
        let mut foreground = ForegroundGroup {
            previous: group,
            restored: false,
        };
        let mut command = self.command();
        command
            .args(["terminal", "attach", target])
            .process_group(0)
            .kill_on_drop(true)
            .stdin(Stdio::inherit())
            .stdout(Stdio::inherit())
            .stderr(Stdio::inherit());
        // The child claims foreground before exec/read. Ctrl+C is then delivered only to the
        // attached client, including the cooked/raw-mode transition, never to the banda viewer.
        unsafe {
            command.pre_exec(|| foreground_group(libc::getpgrp()));
        }
        let status = command.status().await?;
        foreground.restore()?;
        ensure!(
            status.success(),
            "herdr terminal attach exited with {status}"
        );
        Ok(())
    }

    pub async fn subscribe(&self, pane_id: &str) -> Result<BufReader<UnixStream>> {
        let mut stream = UnixStream::connect(self.socket_path().await?).await?;
        let id = uuid::Uuid::new_v4().to_string();
        send_request(
            &mut stream,
            &id,
            "events.subscribe",
            json!({"subscriptions": [
                {"type":"pane.agent_status_changed", "pane_id":pane_id},
                {"type":"pane.agent_detected"}, {"type":"pane.exited"},
                {"type":"pane.closed"}, {"type":"pane.moved"}
            ]}),
        )
        .await?;
        let mut reader = BufReader::new(stream);
        let response =
            tokio::time::timeout(Duration::from_secs(10), read_frame(&mut reader)).await??;
        response_result(response)?;
        Ok(reader)
    }
}

pub(crate) fn detach(command: &mut Command) {
    // setsid gives the daemon neither the viewer's controlling terminal nor its process group.
    unsafe {
        command.pre_exec(|| {
            if libc::setsid() == -1 {
                return Err(std::io::Error::last_os_error());
            }
            Ok(())
        });
    }
}

struct ForegroundGroup {
    previous: libc::pid_t,
    restored: bool,
}

impl ForegroundGroup {
    fn restore(&mut self) -> std::io::Result<()> {
        foreground_group(self.previous)?;
        self.restored = true;
        Ok(())
    }
}

impl Drop for ForegroundGroup {
    fn drop(&mut self) {
        if !self.restored {
            let _ = foreground_group(self.previous);
        }
    }
}

fn foreground_group(group: libc::pid_t) -> std::io::Result<()> {
    // A background process cannot tcsetpgrp unless SIGTTOU is blocked. Keep the block local
    // to this synchronous operation and restore the exact previous signal mask.
    unsafe {
        let mut blocked: libc::sigset_t = std::mem::zeroed();
        let mut previous: libc::sigset_t = std::mem::zeroed();
        libc::sigemptyset(&mut blocked);
        libc::sigaddset(&mut blocked, libc::SIGTTOU);
        let code = libc::pthread_sigmask(libc::SIG_BLOCK, &blocked, &mut previous);
        if code != 0 {
            return Err(std::io::Error::from_raw_os_error(code));
        }
        let result = libc::tcsetpgrp(libc::STDIN_FILENO, group);
        let error = if result == -1 {
            Some(std::io::Error::last_os_error())
        } else {
            None
        };
        let code = libc::pthread_sigmask(libc::SIG_SETMASK, &previous, std::ptr::null_mut());
        if let Some(error) = error {
            return Err(error);
        }
        if code != 0 {
            return Err(std::io::Error::from_raw_os_error(code));
        }
        Ok(())
    }
}

async fn send_request(
    stream: &mut UnixStream,
    id: &str,
    method: &str,
    params: Value,
) -> Result<()> {
    let mut bytes = serde_json::to_vec(&json!({"id":id,"method":method,"params":params}))?;
    bytes.push(b'\n');
    stream.write_all(&bytes).await?;
    Ok(())
}

pub(crate) async fn read_frame<R: tokio::io::AsyncBufRead + Unpin>(
    reader: &mut R,
) -> Result<Value> {
    let mut bytes = Vec::new();
    loop {
        let available = reader.fill_buf().await?;
        ensure!(!available.is_empty(), "local socket closed");
        let end = available.iter().position(|byte| *byte == b'\n');
        let count = end.map_or(available.len(), |index| index + 1);
        ensure!(
            bytes.len() + count <= 8 * 1024 * 1024,
            "local socket frame exceeds 8 MiB"
        );
        bytes.extend_from_slice(&available[..count]);
        reader.consume(count);
        if end.is_some() {
            return Ok(serde_json::from_slice(&bytes)?);
        }
    }
}

fn response_result(response: Value) -> Result<Value> {
    if let Some(error) = response.get("error") {
        bail!(
            "herdr {}: {}",
            error["code"].as_str().unwrap_or("error"),
            error["message"].as_str().unwrap_or("unknown error")
        );
    }
    response
        .get("result")
        .cloned()
        .context("missing herdr response result")
}
