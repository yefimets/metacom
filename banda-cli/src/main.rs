mod bridge;
mod config;
mod herdr;
mod hub;
mod mcp;
mod media;
mod model;
mod tui;

use anyhow::{Context, Result, bail};
use clap::{Args, Parser, Subcommand};
use config::Config;
use hub::Hub;
use serde_json::{Value, json};
use std::{
    collections::{HashSet, VecDeque},
    path::PathBuf,
    time::Duration,
};

#[derive(Parser)]
#[command(
    name = "banda",
    version,
    about = "Private rooms and persistent coding agents in your terminal"
)]
struct Cli {
    #[arg(long, global = true)]
    url: Option<String>,
    #[arg(short, long, global = true)]
    room: Option<String>,
    #[arg(short, long, global = true)]
    name: Option<String>,
    #[arg(long, global = true)]
    json: bool,
    #[command(subcommand)]
    command: Option<Command>,
}

#[derive(Subcommand)]
enum Command {
    /// Open the room-first terminal interface (the default).
    #[command(alias = "tui")]
    Chat,
    /// Authenticate and save the existing Metacom configuration.
    Login {
        url: String,
        /// Prefer --token-stdin to avoid putting a token in shell history.
        token: Option<String>,
        #[arg(long, conflicts_with = "token")]
        token_stdin: bool,
        #[arg(long)]
        agent_token: Option<String>,
    },
    Rooms,
    Agents {
        #[arg(long)]
        all: bool,
    },
    Say {
        #[arg(required_unless_present = "file")]
        text: Vec<String>,
        #[arg(long = "file")]
        file: Vec<PathBuf>,
    },
    Send {
        to: String,
        #[arg(required_unless_present = "file")]
        text: Vec<String>,
        #[arg(long, default_value = "command", value_parser = ["command", "info"])]
        kind: String,
        #[arg(long)]
        wait: bool,
        #[arg(long, default_value_t = 120, value_parser = clap::value_parser!(u64).range(1..=600))]
        timeout: u64,
        #[arg(long = "file")]
        file: Vec<PathBuf>,
    },
    Read {
        agent: String,
        #[arg(long, default_value_t = 80, value_parser = clap::value_parser!(u16).range(1..=500))]
        lines: u16,
    },
    Wait {
        agent: String,
        #[arg(long, value_parser = ["starting", "working", "waiting", "blocked", "unknown", "stopped"])]
        until: Vec<String>,
        #[arg(long, default_value_t = 120, value_parser = clap::value_parser!(u64).range(1..=600))]
        timeout: u64,
    },
    Seen {
        agent: String,
    },
    History {
        #[arg(long, default_value_t = 50, value_parser = clap::value_parser!(u16).range(1..=500))]
        limit: u16,
    },
    /// Follow room messages, reconciling recent history after disconnects.
    Tail,
    Tokens,
    Token {
        label: String,
        #[arg(long, default_value = "agent", value_parser = ["agent", "owner"])]
        role: String,
        /// Save a newly created agent credential for managed local agents.
        #[arg(long)]
        save: bool,
    },
    Revoke {
        id: String,
    },
    #[command(subcommand)]
    Agent(AgentCommand),
    #[command(subcommand)]
    Bridge(BridgeCommand),
    /// Agent-facing MCP server; stdout is reserved for JSON-RPC.
    Mcp,
}

#[derive(Subcommand)]
enum AgentCommand {
    /// Start a supported agent in its own herdr workspace and publish it to the room.
    #[command(alias = "launch")]
    Start(StartArgs),
    /// Publish an existing recognized local herdr agent without taking pane ownership.
    Bind {
        agent: String,
        target: String,
        #[arg(long)]
        session: Option<String>,
    },
    /// List local runtime bindings (not the remote hub roster).
    List,
    /// Stop publishing this agent; its process is left running.
    Unbind {
        agent: String,
    },
    /// Attach to the real local agent terminal; Ctrl+B Q returns to banda.
    Attach {
        agent: String,
    },
    Cancel {
        agent: String,
    },
    Keys {
        agent: String,
        #[arg(required = true)]
        keys: Vec<String>,
    },
    /// Request stopping a still-verified banda-owned terminal, never the herdr server.
    Stop {
        agent: String,
    },
    /// Inspect local delivery outcomes and blocked/uncertain message IDs.
    Inspect {
        agent: String,
    },
    /// Resolve a delivery explicitly; retry may duplicate a previously submitted prompt.
    Resolve {
        agent: String,
        message: String,
        #[arg(value_parser = ["retry", "discard"])]
        action: String,
        #[arg(long, required_if_eq("action", "retry"))]
        accept_duplicate_risk: bool,
    },
}

#[derive(Args)]
struct StartArgs {
    agent: String,
    #[arg(long, default_value = "claude")]
    kind: String,
    #[arg(long, default_value = ".")]
    cwd: PathBuf,
    #[arg(long)]
    session: Option<String>,
    #[arg(long, default_value = "owner")]
    accept: String,
    #[arg(last = true)]
    args: Vec<String>,
}

#[derive(Subcommand)]
enum BridgeCommand {
    Start,
    /// Run in the foreground; normal clients use bridge start.
    Run,
    /// Stop the bridge only; agent processes remain in herdr.
    Stop,
    Status,
}

#[tokio::main]
async fn main() {
    if let Err(error) = run().await {
        eprintln!("banda: {error:#}");
        std::process::exit(1);
    }
}

async fn run() -> Result<()> {
    let cli = Cli::parse();
    let mut config = Config::load()?;
    if let Some(url) = &cli.url {
        config.url = normalize_url(url)?;
    }
    if let Some(room) = &cli.room {
        config.room = room.clone();
    }
    if let Some(name) = &cli.name {
        config.name = name.clone();
    }
    match cli.command.unwrap_or(Command::Chat) {
        Command::Chat => tui::run(config, cli.room, cli.name).await,
        Command::Login {
            url,
            token,
            token_stdin,
            agent_token,
        } => {
            let token = if token_stdin {
                use tokio::io::AsyncBufReadExt;
                let mut line = String::new();
                tokio::io::BufReader::new(tokio::io::stdin())
                    .read_line(&mut line)
                    .await?;
                line.trim().to_owned()
            } else {
                token.context("provide a token or --token-stdin")?
            };
            config.url = normalize_url(&url)?;
            let client = Hub::connect(&config.url, &token).await?;
            let identity = client.call("auth/whoami", json!({})).await?;
            if identity["role"] != "owner" {
                bail!(
                    "login requires an owner token; agent credentials belong in agentToken / MC_AGENT_TOKEN"
                );
            }
            if let Some(agent_token) = agent_token {
                let agent = Hub::connect(&config.url, &agent_token).await?;
                if agent.call("auth/whoami", json!({})).await?["role"] != "agent" {
                    bail!("--agent-token must have the agent role");
                }
                config.agent_token = Some(agent_token);
            }
            config.token = Some(token);
            config.save()?;
            print_value(
                &json!({"authenticated":identity,"url":config.url,"config":config::config_path()?}),
                cli.json,
            );
            Ok(())
        }
        Command::Agent(command) => agent_command(&config, command, cli.json).await,
        Command::Bridge(command) => {
            match command {
                BridgeCommand::Start => {
                    bridge::start(&config).await?;
                    print_value(&bridge::status().await?, cli.json);
                }
                BridgeCommand::Run => bridge::run(config).await?,
                BridgeCommand::Stop => {
                    bridge::stop().await?;
                    println!("bridge stopped; herdr agents were not stopped");
                }
                BridgeCommand::Status => print_value(&bridge::status().await?, cli.json),
            }
            Ok(())
        }
        Command::Mcp => {
            let name = config.name.clone();
            let room = config.room.clone();
            mcp::run(config, name, room).await
        }
        Command::Tail => tail(&config, cli.json).await,
        command => hub_command(&mut config, command, cli.json).await,
    }
}

fn normalize_url(value: &str) -> Result<String> {
    let mut url = reqwest::Url::parse(value).context("invalid hub URL")?;
    match url.scheme() {
        "http" => {
            url.set_scheme("ws")
                .map_err(|_| anyhow::anyhow!("invalid URL scheme"))?;
        }
        "https" => {
            url.set_scheme("wss")
                .map_err(|_| anyhow::anyhow!("invalid URL scheme"))?;
        }
        "ws" | "wss" => {}
        _ => bail!("hub URL must use ws, wss, http or https"),
    }
    if !url.username().is_empty() || url.password().is_some() {
        bail!("hub credentials belong in config, not the URL");
    }
    Ok(url.to_string())
}

async fn hub_command(config: &mut Config, command: Command, as_json: bool) -> Result<()> {
    let client = Hub::connect(&config.url, config.owner_token()?).await?;
    let result = match command {
        Command::Rooms => client.call("room/list", json!({})).await?,
        Command::Agents { all } => {
            client
                .call(
                    "agents/list",
                    if all {
                        json!({})
                    } else {
                        json!({"room":config.room})
                    },
                )
                .await?
        }
        Command::Say { text, file } => {
            let media = media::upload(config, &file).await?;
            client
                .call(
                    "room/say",
                    json!({"room":config.room,"text":text.join(" "),"media":media}),
                )
                .await?
        }
        Command::Send {
            to,
            text,
            kind,
            wait,
            timeout,
            file,
        } => {
            if to == "auto" && wait {
                bail!("auto routing has no command-correlated wait; choose an agent for --wait");
            }
            if to == "auto" && kind != "command" {
                bail!(
                    "auto routing only accepts commands; choose an agent for informational messages"
                );
            }
            let media = media::upload(config, &file).await?;
            if to == "auto" {
                client
                    .call(
                        "agents/dispatch",
                        json!({"room":config.room,"text":text.join(" "),"media":media}),
                    )
                    .await?
            } else {
                let mut args = json!({"to":to,"text":text.join(" "),"kind":kind,"media":media});
                if wait {
                    args["wait"] = json!({"timeoutMs":timeout * 1000});
                }
                client
                    .call_timeout("agents/send", args, Duration::from_secs(timeout + 80))
                    .await?
            }
        }
        Command::Read { agent, lines } => {
            let result = client
                .call("agents/read", json!({"name":agent,"lines":lines}))
                .await?;
            if !as_json {
                println!("{}", result["text"].as_str().unwrap_or_default());
                return Ok(());
            }
            result
        }
        Command::Wait {
            agent,
            until,
            timeout,
        } => {
            let mut args = json!({"name":agent,"timeoutMs":timeout * 1000});
            if !until.is_empty() {
                args["until"] = json!(until);
            }
            client
                .call_timeout("agents/wait", args, Duration::from_secs(timeout + 10))
                .await?
        }
        Command::Seen { agent } => client.call("agents/seen", json!({"name":agent})).await?,
        Command::History { limit } => {
            client
                .call("room/history", json!({"room":config.room,"limit":limit}))
                .await?
        }
        Command::Tokens => client.call("admin/tokens", json!({})).await?,
        Command::Token { label, role, save } => {
            if save && role != "agent" {
                bail!("--save is only supported for agent credentials");
            }
            let result = client
                .call("admin/createToken", json!({"name":label,"role":role}))
                .await?;
            if save {
                config.agent_token = Some(
                    result["token"]
                        .as_str()
                        .context("hub returned no token")?
                        .to_owned(),
                );
                config.save()?;
                json!({"saved":true,"record":result["record"]})
            } else {
                result
            }
        }
        Command::Revoke { id } => client.call("admin/revokeToken", json!({"id":id})).await?,
        _ => unreachable!("local commands dispatch before opening a hub connection"),
    };
    print_value(&result, as_json);
    Ok(())
}

async fn agent_command(config: &Config, command: AgentCommand, as_json: bool) -> Result<()> {
    match command {
        AgentCommand::Start(args) => {
            let binding = bridge::launch(
                config,
                bridge::LaunchOptions {
                    name: args.agent,
                    kind: args.kind,
                    room: config.room.clone(),
                    cwd: args.cwd.canonicalize().context("agent working directory")?,
                    session: args.session.or_else(|| config.herdr_session.clone()),
                    accept: args.accept,
                    args: args.args,
                },
            )
            .await?;
            print_value(&serde_json::to_value(binding)?, as_json);
        }
        AgentCommand::Bind {
            agent,
            target,
            session,
        } => {
            let binding = bridge::bind(
                config,
                &agent,
                &config.room,
                &target,
                session.or_else(|| config.herdr_session.clone()),
            )
            .await?;
            print_value(&serde_json::to_value(binding)?, as_json);
        }
        AgentCommand::List => print_value(&serde_json::to_value(bridge::bindings()?)?, as_json),
        AgentCommand::Unbind { agent } => {
            bridge::unbind(&agent).await?;
            println!("{agent} unbound; its herdr terminal is still running");
        }
        AgentCommand::Attach { agent } => bridge::attach(&agent).await?,
        AgentCommand::Cancel { agent } => control(config, &agent, "!cancel", as_json).await?,
        AgentCommand::Keys { agent, keys } => {
            control(
                config,
                &agent,
                &format!("!keys {}", keys.join(" ")),
                as_json,
            )
            .await?
        }
        AgentCommand::Stop { agent } => control(config, &agent, "!stop", as_json).await?,
        AgentCommand::Inspect { agent } => print_value(&bridge::inspect(&agent).await?, as_json),
        AgentCommand::Resolve {
            agent,
            message,
            action,
            accept_duplicate_risk: _,
        } => {
            if action == "retry" {
                eprintln!(
                    "banda: explicitly retrying; the previous submission may already have executed"
                );
            }
            print_value(&bridge::resolve(&agent, &message, &action).await?, as_json);
        }
    }
    Ok(())
}

async fn control(config: &Config, agent: &str, text: &str, as_json: bool) -> Result<()> {
    let client = Hub::connect(&config.url, config.owner_token()?).await?;
    let result = client
        .call("agents/send", json!({"to":agent,"text":text}))
        .await?;
    print_value(&result, as_json);
    Ok(())
}

fn print_value(value: &Value, as_json: bool) {
    if as_json {
        println!("{value}");
    } else {
        println!(
            "{}",
            serde_json::to_string_pretty(value).expect("JSON value serialization")
        );
    }
}

async fn tail(config: &Config, as_json: bool) -> Result<()> {
    let mut seen = HashSet::new();
    let mut recent = VecDeque::new();
    loop {
        let connection = tokio::select! {
            result = Hub::connect(&config.url, config.owner_token()?) => result,
            _ = tokio::signal::ctrl_c() => return Ok(()),
        };
        let client = match connection {
            Ok(client) => client,
            Err(error) => {
                eprintln!("banda: disconnected: {error}; reconnecting");
                tokio::select! { _ = tokio::time::sleep(Duration::from_secs(2)) => {}, _ = tokio::signal::ctrl_c() => return Ok(()) }
                continue;
            }
        };
        let mut events = client.subscribe();
        let history = client
            .call("room/history", json!({"room":config.room,"limit":500}))
            .await?;
        for message in history.as_array().context("invalid room history")? {
            print_message_once(message, as_json, &mut seen, &mut recent);
        }
        loop {
            tokio::select! {
                _ = tokio::signal::ctrl_c() => return Ok(()),
                event = events.recv() => match event {
                    Ok(event) if event.name == "__disconnected" => break,
                    Ok(event) if event.name == "room/message" && event.data["room"] == config.room => print_message_once(&event.data, as_json, &mut seen, &mut recent),
                    Ok(_) => {},
                    Err(_) => { eprintln!("banda: stream interrupted; reconciling recent history"); break; }
                }
            }
        }
    }
}

fn print_message_once(
    message: &Value,
    as_json: bool,
    seen: &mut HashSet<String>,
    recent: &mut VecDeque<String>,
) {
    let Some(id) = message["id"].as_str() else {
        return;
    };
    if !seen.insert(id.to_owned()) {
        return;
    }
    recent.push_back(id.to_owned());
    if recent.len() > 2000 {
        if let Some(old) = recent.pop_front() {
            seen.remove(&old);
        }
    }
    if as_json {
        println!("{message}");
    } else {
        let to = message["to"]
            .as_str()
            .map(|name| format!(" → {name}"))
            .unwrap_or_default();
        println!(
            "{} {}{}: {}",
            message["ts"].as_str().unwrap_or_default(),
            message["from"]["name"].as_str().unwrap_or("hub"),
            to,
            message["text"].as_str().unwrap_or_default()
        );
    }
}
