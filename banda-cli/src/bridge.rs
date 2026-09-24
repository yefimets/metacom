mod identity;
mod store;
mod worker;

use crate::{
    config::Config,
    herdr::{Herdr, detach, read_frame},
    hub::Hub,
};
use anyhow::{Context, Result, bail, ensure};
use identity::ProcessIdentity;
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use std::{
    collections::HashMap,
    fs::{self, OpenOptions},
    os::unix::fs::{OpenOptionsExt, PermissionsExt},
    path::PathBuf,
    process::Stdio,
    sync::Arc,
    time::Duration,
};
use store::Journal;
use tokio::{
    io::AsyncWriteExt,
    net::{UnixListener, UnixStream},
    process::Command,
    sync::Mutex,
    task::JoinHandle,
};

type SharedJournal = Arc<Mutex<Journal>>;
type Health = Arc<Mutex<Value>>;

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct Binding {
    pub name: String,
    pub room: String,
    pub kind: String,
    pub pane_id: String,
    pub terminal_id: String,
    pub session: Option<String>,
    pub run_id: String,
    pub executor_id: String,
    pub cwd: PathBuf,
    pub owned: bool,
    pub socket_path: PathBuf,
    pub native_name: Option<String>,
    pub native_session: Value,
    pub process: ProcessIdentity,
    pub accept: Value,
    pub hub_url: String,
}

impl Binding {
    fn herdr(&self) -> Herdr {
        Herdr::at_socket(self.session.clone(), self.socket_path.clone())
    }
}

pub struct LaunchOptions {
    pub name: String,
    pub kind: String,
    pub room: String,
    pub cwd: PathBuf,
    pub session: Option<String>,
    pub accept: String,
    pub args: Vec<String>,
}

fn validate_name(name: &str) -> Result<()> {
    ensure!(
        !name.is_empty()
            && name.len() <= 32
            && name
                .bytes()
                .all(|c| c.is_ascii_alphanumeric() || b"._-".contains(&c)),
        "name requires 1–32 letters, digits, dots, dashes or underscores"
    );
    Ok(())
}

fn acceptance(value: &str) -> Result<Value> {
    if value == "owner" || value == "any" {
        return Ok(json!(value));
    }
    let names: Vec<_> = value
        .split(',')
        .map(str::trim)
        .filter(|name| !name.is_empty())
        .collect();
    ensure!(
        !names.is_empty(),
        "accept must be owner, any, or comma-separated names"
    );
    for name in &names {
        validate_name(name)?;
    }
    Ok(json!(names))
}

pub(crate) async fn agent_hub(config: &Config) -> Result<Hub> {
    let hub = Hub::connect(&config.url, config.agent_token()?).await?;
    let identity = hub.call("auth/whoami", json!({})).await?;
    ensure!(
        identity["role"].as_str() == Some("agent"),
        "MC_AGENT_TOKEN must authenticate with the agent role; owner credentials are never used for runtime execution"
    );
    Ok(hub)
}

pub fn bindings() -> Result<Vec<Binding>> {
    store::bindings()
}

pub async fn launch(config: &Config, options: LaunchOptions) -> Result<Binding> {
    validate_name(&options.name)?;
    let accept = acceptance(&options.accept)?;
    let cwd = options
        .cwd
        .canonicalize()
        .context("launch directory does not exist")?;
    ensure!(cwd.is_dir(), "launch cwd is not a directory");
    let hub = agent_hub(config).await?;
    check_running_config(config).await?;
    let _launch_lock = store::lock("launch.lock")?;
    ensure!(
        !bindings()?
            .iter()
            .any(|binding| binding.name == options.name),
        "{} is already bound",
        options.name
    );
    // herdr validates the installed supported executable and never substitutes a fake process.
    let run_id = uuid::Uuid::new_v4().to_string();
    let executor_id = uuid::Uuid::new_v4().to_string();
    let registration = hub.call("agents/register", json!({"name":options.name,"room":options.room,"kind":"agent","executorId":executor_id,"runId":run_id,"accept":accept})).await?;
    ensure!(
        registration["runId"].as_str() == Some(&run_id),
        "hub lacks managed executor/run fencing; upgrade hub before launching"
    );
    let herdr = Herdr::new(
        options
            .session
            .clone()
            .or_else(|| config.herdr_session.clone()),
    );
    herdr.ensure_running().await?;
    let session = options
        .session
        .clone()
        .or_else(|| config.herdr_session.clone());
    let mut args = options.args;
    if options.kind == "claude" {
        let mcp_path = store::directory()?.join(format!("mcp-{run_id}.json"));
        store::atomic(
            &mcp_path,
            &json!({"mcpServers":{"banda":{"command":std::env::current_exe()?,"args":["mcp","--name",options.name,"--room",options.room],"env":{"MC_HUB_URL":config.url,"MC_AGENT_TOKEN":config.agent_token()?,"MC_TOKEN":""}}}}),
        )?;
        args.extend(["--mcp-config".into(), mcp_path.to_string_lossy().into_owned(), "--append-system-prompt".into(), format!("You are {} in private collaboration room {}. Messages prefixed [hub NAME] are directed requests. (info) marks context, not an instruction. Use the banda MCP room tools to coordinate and report progress.",options.name,options.room)]);
    }
    let workspace = herdr.call("workspace.create", json!({"cwd":cwd,"label":format!("banda · {}",options.name),"focus":false,"env":{"MC_HUB_URL":config.url,"MC_AGENT_TOKEN":config.agent_token()?,"MC_TOKEN":"","MC_ROOM":options.room,"MC_NAME":options.name}})).await?;
    let pane_id = workspace
        .pointer("/root_pane/pane_id")
        .and_then(Value::as_str)
        .context("herdr workspace creation omitted root pane")?
        .to_owned();
    let native_name = format!("banda-{}", &run_id[..20]);
    // A newly created shell needs its first prompt before agent.start will accept it.
    tokio::time::sleep(Duration::from_millis(500)).await;
    let launched = herdr.call("agent.start", json!({"name":native_name,"kind":options.kind,"pane_id":pane_id,"args":args,"timeout_ms":30000})).await;
    // The native start response and process detection may settle on adjacent ticks.
    // Observe that one launch; never repeat a possibly successful start request.
    let deadline = tokio::time::Instant::now() + Duration::from_secs(5);
    let current = loop {
        if let Ok(current) = identity::agent(&herdr, &pane_id).await {
            if current["agent"].as_str() == Some(&options.kind)
                && current["name"].as_str() == Some(&native_name)
                && identity::foreground(&herdr, &pane_id).await.is_ok()
            {
                break current;
            }
        }
        if tokio::time::Instant::now() >= deadline {
            let outcome = launched
                .err()
                .map(|error| format!("{error:#}"))
                .unwrap_or_else(|| {
                    "native launch returned, but the expected foreground agent was not observed"
                        .into()
                });
            bail!(
                "launch could not be bound: {outcome}; owned pane {pane_id} remains in herdr for inspection; no launch was retried"
            );
        }
        tokio::time::sleep(Duration::from_millis(100)).await;
    };
    let binding = Binding {
        name: options.name,
        room: options.room,
        kind: options.kind,
        pane_id,
        terminal_id: current["terminal_id"]
            .as_str()
            .context("missing terminal identity")?
            .into(),
        session,
        run_id,
        executor_id,
        cwd,
        owned: true,
        socket_path: herdr.socket_path().await?.clone(),
        native_name: Some(native_name),
        native_session: current["agent_session"].clone(),
        process: identity::foreground(&herdr, current["pane_id"].as_str().context("missing pane")?)
            .await?,
        accept,
        hub_url: config.url.clone(),
    };
    identity::verify(&binding, &herdr).await?;
    store::insert(&binding)?;
    drop(hub);
    start(config)
        .await
        .context("agent is safely bound, but bridge could not start; run banda bridge start")?;
    Ok(binding)
}

pub async fn bind(
    config: &Config,
    name: &str,
    room: &str,
    target: &str,
    session: Option<String>,
) -> Result<Binding> {
    validate_name(name)?;
    let hub = agent_hub(config).await?;
    check_running_config(config).await?;
    let _launch_lock = store::lock("launch.lock")?;
    let session = session.or_else(|| config.herdr_session.clone());
    let herdr = Herdr::new(session.clone());
    let current = identity::agent(&herdr, target).await?;
    let pane_id = current["pane_id"]
        .as_str()
        .context("missing pane identity")?
        .to_owned();
    let binding = Binding {
        name: name.into(),
        room: room.into(),
        kind: current["agent"]
            .as_str()
            .context("not a recognized agent")?
            .into(),
        pane_id: pane_id.clone(),
        terminal_id: current["terminal_id"]
            .as_str()
            .context("missing terminal identity")?
            .into(),
        session,
        run_id: uuid::Uuid::new_v4().to_string(),
        executor_id: uuid::Uuid::new_v4().to_string(),
        cwd: PathBuf::from(
            current["foreground_cwd"]
                .as_str()
                .or_else(|| current["cwd"].as_str())
                .context("agent cwd unavailable")?,
        ),
        owned: false,
        socket_path: herdr.socket_path().await?.clone(),
        native_name: current["name"].as_str().map(str::to_owned),
        native_session: current["agent_session"].clone(),
        process: identity::foreground(&herdr, &pane_id).await?,
        accept: json!("owner"),
        hub_url: config.url.clone(),
    };
    identity::verify(&binding, &herdr).await?;
    let registration = hub.call("agents/register", json!({"name":name,"room":room,"kind":"agent","executorId":binding.executor_id,"runId":binding.run_id,"accept":binding.accept})).await?;
    ensure!(
        registration["runId"].as_str() == Some(&binding.run_id),
        "hub lacks managed executor/run fencing; upgrade hub before binding"
    );
    store::insert(&binding)?;
    drop(hub);
    start(config).await?;
    Ok(binding)
}

pub async fn attach(name: &str) -> Result<()> {
    let binding = bindings()?
        .into_iter()
        .find(|binding| binding.name == name)
        .context("no local binding; remote terminal attachment is not available through the hub")?;
    identity::verify(&binding, &binding.herdr()).await?;
    binding.herdr().attach(&binding.terminal_id).await
}

pub async fn unbind(name: &str) -> Result<()> {
    store::remove(name)?;
    // Wait for actor teardown when the bridge is alive; do not kill its terminal.
    if control(json!({"method":"status"})).await.is_ok() {
        control(json!({"method":"reload"})).await?;
    }
    Ok(())
}

async fn control(request: Value) -> Result<Value> {
    tokio::time::timeout(Duration::from_secs(10), async {
        let mut stream = UnixStream::connect(store::directory()?.join("bridge.sock"))
            .await
            .context("banda bridge is not running")?;
        let mut bytes = serde_json::to_vec(&request)?;
        bytes.push(b'\n');
        stream.write_all(&bytes).await?;
        let value = read_frame(&mut tokio::io::BufReader::new(stream)).await?;
        if let Some(error) = value["error"].as_str() {
            bail!("{error}");
        }
        Ok(value)
    })
    .await
    .context("bridge control deadline exceeded")?
}

pub async fn status() -> Result<Value> {
    match control(json!({"method":"status"})).await {
        Ok(value) => Ok(value),
        Err(error) => {
            if store::lock("bridge.lock").is_ok() {
                Ok(json!({"running":false,"bindings":bindings()?,"reason":error.to_string()}))
            } else {
                Err(error.context(
                    "bridge lock is held but control socket is unavailable; inspect bridge.log",
                ))
            }
        }
    }
}

pub async fn inspect(name: &str) -> Result<Value> {
    control(json!({"method":"inspect","name":name})).await
}
pub async fn resolve(name: &str, id: &str, action: &str) -> Result<Value> {
    control(json!({"method":"resolve","name":name,"id":id,"action":action})).await
}
pub async fn stop() -> Result<()> {
    control(json!({"method":"stop"})).await?;
    Ok(())
}

async fn check_running_config(config: &Config) -> Result<bool> {
    if control(json!({"method":"status"})).await.is_err() {
        return Ok(false);
    }
    control(json!({
        "method":"check_config",
        "hubUrl":config.url,
        "agentToken":config.agent_token()?
    }))
    .await?;
    Ok(true)
}

pub async fn start(config: &Config) -> Result<()> {
    if check_running_config(config).await? {
        control(json!({"method":"reload"})).await?;
        return Ok(());
    }
    agent_hub(config).await?;
    let dir = store::directory()?;
    let log = OpenOptions::new()
        .create(true)
        .append(true)
        .mode(0o600)
        .open(dir.join("bridge.log"))?;
    let mut command = Command::new(std::env::current_exe()?);
    command
        .args(["bridge", "run"])
        .env("MC_HUB_URL", &config.url)
        .env("MC_AGENT_TOKEN", config.agent_token()?)
        .env_remove("MC_TOKEN")
        .stdin(Stdio::null())
        .stdout(Stdio::from(log.try_clone()?))
        .stderr(Stdio::from(log));
    detach(&mut command);
    let mut child = command.spawn().context("spawn detached banda bridge")?;
    for _ in 0..100 {
        tokio::time::sleep(Duration::from_millis(100)).await;
        if control(json!({"method":"status"})).await.is_ok() {
            tokio::spawn(async move {
                let _ = child.wait().await;
            });
            return Ok(());
        }
        if let Some(exit) = child.try_wait()? {
            // A simultaneous starter may own the lock now.
            if control(json!({"method":"status"})).await.is_ok() {
                return Ok(());
            }
            bail!(
                "banda bridge exited ({exit}); inspect {}",
                dir.join("bridge.log").display()
            );
        }
    }
    bail!(
        "bridge startup deadline exceeded; inspect {}",
        dir.join("bridge.log").display()
    )
}

struct Actor {
    binding: Binding,
    journal: SharedJournal,
    health: Health,
    task: JoinHandle<()>,
}

async fn reconcile(config: &Config, actors: &mut HashMap<String, Actor>) -> Result<()> {
    let current = bindings()?;
    let removed: Vec<_> = actors
        .iter()
        .filter(|(name, actor)| {
            !current
                .iter()
                .any(|binding| &binding.name == *name && binding.run_id == actor.binding.run_id)
        })
        .map(|(name, _)| name.clone())
        .collect();
    for name in removed {
        if let Some(actor) = actors.remove(&name) {
            actor.task.abort();
            let _ = actor.task.await;
        }
    }
    for binding in current {
        if actors.contains_key(&binding.name) {
            continue;
        }
        ensure!(
            binding.hub_url == config.url,
            "binding {} belongs to another hub",
            binding.name
        );
        let journal = Arc::new(Mutex::new(Journal::load(&binding)?));
        let health = Arc::new(Mutex::new(json!({"connected":false,"status":"starting"})));
        let task = tokio::spawn(worker::run(
            config.clone(),
            binding.clone(),
            journal.clone(),
            health.clone(),
        ));
        actors.insert(
            binding.name.clone(),
            Actor {
                binding,
                journal,
                health,
                task,
            },
        );
    }
    Ok(())
}

pub async fn run(mut config: Config) -> Result<()> {
    config.token = None;
    let _singleton = store::lock("bridge.lock")
        .context("another banda bridge already owns this state directory")?;
    let socket = store::directory()?.join("bridge.sock");
    if socket.exists() {
        fs::remove_file(&socket)?;
    }
    let listener = UnixListener::bind(&socket)?;
    fs::set_permissions(&socket, fs::Permissions::from_mode(0o600))?;
    let mut actors = HashMap::new();
    let mut reconcile_error: Option<String> = None;
    let mut interval = tokio::time::interval(Duration::from_secs(2));
    let result = async {
        loop {
            tokio::select! {
                _ = interval.tick() => {
                    reconcile_error = reconcile(&config,&mut actors).await.err().map(|error| format!("{error:#}"));
                    if let Some(error) = &reconcile_error { eprintln!("bridge reconcile: {error}"); }
                }
                accepted = listener.accept() => {
                    let (stream,_) = accepted?;
                    let mut reader = tokio::io::BufReader::new(stream);
                    let request = tokio::time::timeout(Duration::from_secs(2), read_frame(&mut reader)).await;
                    let request = match request { Ok(Ok(value)) => value, _ => continue };
                    let stopping = request["method"] == "stop";
                    let response: Result<Value> = async {
                        match request["method"].as_str().unwrap_or("") {
                            "stop" => Ok(json!({"stopped":true,"terminalsPreserved":true})),
                            "check_config" => {
                                ensure!(request["hubUrl"].as_str() == Some(&config.url), "bridge belongs to another hub; stop it before changing configuration");
                                ensure!(request["agentToken"].as_str() == Some(config.agent_token()?), "bridge uses a different agent credential; stop it before changing credentials (existing bindings retain their hub ownership)");
                                Ok(json!({"compatible":true}))
                            }
                            "reload" => { reconcile(&config,&mut actors).await?; Ok(json!({"reloaded":true})) }
                            "status" => {
                                let mut members = Vec::new();
                                for actor in actors.values() { members.push(json!({"binding":actor.binding,"health":*actor.health.lock().await})); }
                                Ok(json!({"running":true,"pid":std::process::id(),"hubUrl":config.url,"agents":members,"reason":reconcile_error}))
                            }
                            "inspect" | "resolve" => {
                                let name = request["name"].as_str().context("name required")?;
                                let actor = actors.get(name).context("no active local binding")?;
                                let mut journal = actor.journal.try_lock().context("executor is processing a delivery; inspect/resolve again when it settles")?;
                                if request["method"] == "resolve" {
                                    journal.resolve(&actor.binding,request["id"].as_str().context("id required")?,request["action"].as_str().context("action required")?)
                                } else { Ok(json!({"binding":actor.binding,"health":*actor.health.lock().await,"deliveries":journal.entries})) }
                            }
                            _ => bail!("unknown local bridge method"),
                        }
                    }.await;
                    let value = match response { Ok(value) => value, Err(error) => json!({"error":format!("{error:#}")}) };
                    let mut bytes = serde_json::to_vec(&value)?; bytes.push(b'\n');
                    let _ = reader.get_mut().write_all(&bytes).await;
                    if stopping { break; }
                }
                _ = tokio::signal::ctrl_c() => break,
            }
        }
        Ok::<_,anyhow::Error>(())
    }.await;
    for (_, actor) in actors {
        actor.task.abort();
        let _ = actor.task.await;
    }
    drop(listener);
    fs::remove_file(socket)?;
    result
}
