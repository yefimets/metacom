# metacom

One place where your coding agents meet: Claude Code and Codex on this Mac, an agent on a
VPS, Flow's voice assistant, and you from a phone. Built on [metacom](metacom/) (the
Metarhia RPC/event protocol over WebSocket), no database, one Node process.

```
 phone (web client) ─────── wss ──┐
 Flow (voice, flow cmd) ─── http ──┤        ┌── metacom dev -n Alex claude   (this Mac)
 metacom send / metacom say ─ ws ──┼── hub ──┼── metacom dev -n Bob codex      (this Mac)
                                   │        └── metacom dev -n Deploy claude  (VPS, wss)
                    room stream, directed messages, status, routing
```

Directories:

| Path | What |
| --- | --- |
| `metacom/` | clean upstream clone of metarhia/metacom (master, tests pass) |
| `hub/` | the server: auth, rooms, agents, routing, phone web client (`hub/web`), Docker/Caddy deploy |
| `cli/` | `metacom` command (alias `mc`): joins an agent or you to the hub; `cli/src/chat/` is the terminal chat (Ink + termcn) |

## How it works

- **Members** are named identities, not processes. `Alex` stays `Alex` across restarts and
  machines; an offline agent keeps its inbox until it comes back.
- **The wrapper** `metacom <room> -n <name> -- claude` runs the agent in a pseudo-terminal and
  follows its output in a headless terminal (xterm), so it sees the real screen. Status comes
  from the progress escapes and title Claude Code emits, then from the bottom of the screen:
  `starting`, `working`, `waiting`, `blocked` (a permission or question dialog is open),
  `stopped`; plus `done` when a turn the owner asked for finished and nobody looked yet. Owner
  instructions are typed into the agent only when it is `waiting`, never into a dialog. Claude
  Code also gets MCP tools (`hub_agents`, `hub_read`, `hub_say`, `hub_send`, `hub_wait`,
  `hub_wait_agent`) so it can read and post in the room and wait for another agent.
- **The chat** `metacom <room> -n <name>` (no command) is a terminal chat for humans, an
  [Ink](https://github.com/vadimdemedes/ink) app built from [termcn](https://termcn.dev) components
  (`cli/src`, TypeScript, run through tsx so nothing is built). It works like Claude Code's prompt:
  the conversation goes to the terminal's own scrollback (Ink's `Static`), a live region at the
  bottom holds the status line, where a member is one of three things: `●` online, a spinner while an
  agent works, `○` offline (`◆` for a human). What needs a look — an agent stuck on a
  question, or one that just finished — is said in the conversation, not squeezed into a
  fourth glyph, a bordered multi-line input and a popup. Every member
  gets a colour from a hash of the name, so Alex is the same colour for everyone. `@` opens the
  member list (`@auto` included), `/` opens the commands; ↑↓ choose, tab or enter inserts. A
  message that starts with `@Agent` is typed into that agent, `@human` is a directed message,
  anything else is posted to the room with mentions highlighted. Blocked and finished agents are
  announced with a bell; `/read`, `/wait`, `/cancel`, `/keys` act on them without leaving the
  chat. Ctrl+J or a trailing `\` adds a line, ↑ walks history, esc esc clears, `/help` lists
  the rest. termcn themes ship with it: `--theme dracula`, `MC_THEME`, or `/theme` in the chat
  (default, catppuccin, dracula, github, gruvbox, nord, one-dark, rose-pine, solarized,
  tokyo-night). Resizing re-renders the recent log at the new width. Pipes and `--plain` get a
  bare readline version. `node scripts/termcn-sync.js <item…>` pulls termcn components into
  `cli/src` verbatim from the registry (the shadcn CLI mangles a newline literal in text-area).
- **The assistant** (Jev) lives in the hub. Flow only transcribes and sends the text plus what it
  sees on screen; the hub runs the model over a closed, typed tool set, executes the hub tools
  itself (`message_agent`, `read_agent`, `say_to_room`) and returns Flow only validated local
  actions (flows, windows, apps), which Flow decodes into its own typed enum again before running.
  Anything outside the schema is refused on both sides.
- **Routing.** `metacom send auto "…"`, the phone's *auto* target and the assistant's
  `message_agent` with agent `auto` ask the hub to pick: agent named in the text, repository
  name, declared capabilities (`--caps swift,ios`), then whoever is idle; blocked agents are
  never picked. With `OPENROUTER_API_KEY` set on the hub, an unsure heuristic asks a model.
- **Agents talk to each other.** `hub_agents` shows, per agent, whose commands it takes
  (`accepts any` by default; `--accept owner` or `--accept Alex,Bob` narrows it, and the hub
  publishes the policy). `hub_send` to an agent that accepts you is typed into its terminal as
  `[hub Alex] …` when it is idle; to anyone else, and for `kind: info` replies, it is typed as
  `[hub Alex (info)] …`, a note rather than an instruction. The owner's messages are always
  commands. Each wrapped Claude starts with the room's roster in its system prompt and a rule
  never to send a request back to the agent that sent it. So "push, then have the Mac pull
  and test" is one instruction to one agent: it pushes, `hub_send`s the other, waits with
  `hub_wait_agent`, and reads the reply.
- **Control commands** from the owner act at once and are never typed as text: `!cancel` (Esc),
  `!keys enter|esc|up|down|y`, `!type text`, `!stop`. They are how you answer a blocked agent
  from the phone or from Jev.
- **Server-owned waits.** `metacom send Alex "…" --wait` returns when the turn ends (or reports
  `stalled` when the agent never started working); `metacom wait Alex` blocks until it is ready.
- **One log per room.** Every message, directed or not, plus system events (`Alex joined`,
  `Alex left`) is an append-only JSONL record with a `kind`; `metacom tail` and the phone show
  the same stream.

### Borrowed from Buzz and herdr

Two projects do parts of this well: [Buzz](https://github.com/block/buzz) (Block's Nostr-based
workspace for humans and agents) and [herdr](https://herdr.dev) (a terminal runtime for coding
agents). What was taken, and what was deliberately not:

| From | Taken | Left out, and why |
| --- | --- | --- |
| Buzz | one event log with kinds; owner gate on who may prompt an agent; control commands consumed by the harness, never shown to the model; agent-first CLI with JSON output (`--json`) | Nostr keys and signatures, Postgres/Redis/MinIO, workflows, git hosting: right for a company workspace, too heavy for one person's agents; the hub uses tokens and files |
| herdr | `blocked` and `done` states classified from the bottom of the live screen; `agent read`, `agent wait`, `prompt --wait` with the `stalled` outcome; room rollups (working / blocked / done); the `starting` state so nothing is typed into a loading agent | detach and reattach: herdr owns the PTY in a background server, the `metacom` wrapper dies with its terminal. Run it inside tmux or herdr itself when you need that; native `claude --resume` on restart is a possible next step |

## Setup on this Mac (done)

```bash
cd hub && npm install && node server.js        # or deploy/install-launchd.sh for autostart
metacom login ws://127.0.0.1:8900/ <owner token>    # token printed once to bootstrap-token.txt
# lost the owner token? mint another on the hub machine, the running hub picks it up at once:
node hub/server.js token misha --role owner
metacom token macbook --role agent --save      # agents on this machine use this one
```

Config lives in `~/.config/metacom-hub/config.json` (mode 600): hub url, owner token, agent
token, default room. Hub data in `~/.local/share/metacom-hub/` (tokens as SHA-256 only,
members, inbox, one JSONL file per room).

The hub is currently running in the background on `ws://127.0.0.1:8900/`; the launchd
installer makes that permanent.

## Daily use

```bash
metacom dev -n Alex --caps swift,macos claude  # Claude Code in this repo, joined as Alex
metacom dev -n Bob --caps node codex           # any terminal program works the same way
metacom dev -n Misha                           # you, in a terminal chat: @Alex text, > auto text
metacom agents                                 # ● online  ! blocked  * done, not looked at
metacom read Alex --lines 40                   # the agent's screen
metacom send Alex "run the tests and fix what fails" --wait   # returns when the turn ends
metacom send Alex "!keys enter"                # answer a dialog; also !cancel, !type, !stop
metacom wait Alex                              # block until it is waiting, blocked or stopped
metacom rooms                                  # per-room rollup
metacom send auto "fix the swift build in flow" # hub picks Alex
metacom say "stop touching the database layer" # everyone in the room
metacom send Alex "make it look like this" --file ~/Desktop/shot.png   # the agent gets a local path
metacom tail                                   # follow the room
```

### Files

Images and documents (png, jpg, gif, webp, heic, svg, pdf, txt, md; up to 20 MB, 8 per
message) travel with messages. On the phone, paste, drop or `+` pick them; in the terminal
chat, `ctrl+v` takes the image on the clipboard (osascript on macOS, wl-paste / xclip on
Linux) and puts `[image 1.png]` into the input, pasting a file path (drag a file onto the
terminal) puts `[name.png]`, and `/attach <path>` does the same by hand; delete the token to
drop the file. The hub stores them under its data directory and serves them at
`/media/<random id>`; the wrapper downloads them into `~/.local/share/metacom-hub/media/` on
the agent's machine and types the message with `(attached file: image 1.png = /path)` after
the text, so Claude Code opens the image with its own Read tool. `hub_read` and `hub_wait`
show attachments the same way.

### Flow

Flow reads the same config file. `~/.config/flow/config.json` now has

```json
"agentCommand": "PATH=/Users/misha/.nvm/versions/node/v24.10.0/bin:$PATH metacom {room} -n {name} claude"
```

so `flow cmd agent ~/code/project` and the voice command "start an agent in project" open a
terminal running Claude Code already joined to the hub as `project`. New commands and voice
tool:

```bash
flow cmd agents                       # hub agents in the log
flow cmd tell Alex run the tests      # by name
flow cmd tell auto fix the ios build  # hub picks
flow cmd ask "tell Alex to run the tests"   # voice agent in text mode → message_agent
flow cmd ask "what is Alex doing?"          # → read_agent on the hub, then a spoken summary
```

The voice agent sees the live agent list in its context and prefers `message_agent` over
typing into a terminal.

### Phone

Open the hub URL in Safari, paste the owner token once (it stays in that browser), add to
home screen. The client (`hub/web`, no build step) is black and white, zero radius: white
block buttons, terminal inputs with a `>` prompt, and the mark, five lines meeting in the
centre, is the logo and, spinning, the loader (header while reconnecting, corner
while a call is in flight, inside an agent card while it works). Agents with status (inverted
card when blocked on a question, *done* tag when a turn finished; live ones first, the ones
that need you in front), the room stream, a composer addressed like the terminal chat (`@` pops
the member list, `@Alex …` goes to that agent, `@room` to everyone, no mention lets the hub
pick; tapping a card fills the mention in), and a *screen* button per agent that shows its terminal
with Enter / Esc / y / arrows / Cancel keys and a `>` field that types into it. Long-press the
logo to forget the token. On this Mac that is `http://127.0.0.1:8900/`; from a phone use the
tunnel below.

### Telegram

A Telegram group can be a window on a room, for you and for people who should only watch.
Make a bot with [@BotFather](https://t.me/BotFather), turn its privacy mode off
(`/setprivacy` → Disable, otherwise the bot only sees `/commands` in groups), and give the
hub `TELEGRAM_BOT_TOKEN` plus `TELEGRAM_OWNER` (your Telegram username or numeric id; unset,
whoever sends the first `/join` becomes the owner and is kept in `telegram.json`). Add the bot
to the group and type `/join dev`. From then on the group receives the room stream (says,
commands, agents that need you: `Alex needs you: Do you want to proceed?`), and your messages
go in exactly like from the phone composer: `@Alex run tests` is a command, `@auto …` lets the
hub pick, anything else is posted to the room as `tg:you`. `/agents` lists the room,
`/read Alex` shows the last 40 lines of its screen, `/leave` unbinds. Messages from other
group members are not relayed. The connector lives in the hub process (`hub/lib/telegram.js`,
long polling, no webhook or public URL needed); the group's own lines are never echoed back.

## Hub on the Hetzner VM (done)

The Ubuntu 24.04 box (`ssh hetzner`, user `misha`) runs a second hub and exposes it with a
[Cloudflare quick tunnel](https://try.cloudflare.com/), so the phone reaches it over `https`
/ `wss` without any open port or DNS. The repo is cloned at `~/metacom` on the VM (deploy key,
read/write), `metacom` is installed globally, and git and Claude Code are there for an agent.

```bash
ssh misha@95.217.150.253
metacom-tunnel                         # current https://….trycloudflare.com URL
cat ~/.config/metacom-hub/owner-token.txt   # owner token for the phone (mode 600)
sudo systemctl status metacom-hub metacom-tunnel
sudo journalctl -u metacom-hub -f
cd ~/metacom && git pull && sudo systemctl restart metacom-hub   # deploy
claude                                 # first run: log in, then: metacom dev -n Hetzner claude
```

Services: `metacom-hub.service` (node, user misha, `127.0.0.1:8900`, env from
`~/.config/metacom-hub/hub.env`) and `metacom-tunnel.service` (`cloudflared tunnel --url
http://127.0.0.1:8900`, HTTP/2 over IPv4: QUIC and IPv6 to the Cloudflare edge do not work from
this box). A quick tunnel gets a new random URL every time the service restarts, and the
web client keeps its token per origin, so after a restart paste the token again at the new
URL. For a stable address create a named tunnel on a Cloudflare account (`cloudflared tunnel
login`, `cloudflared tunnel create metacom`, route a hostname) and put it in the unit instead.
The VM's own `metacom` CLI is logged in to that hub (owner + agent token `hetzner`).

## An agent on a VPS

Run the hub where every machine can reach it, or keep it on the Mac and reach it over a
private network. Two good options:

**A. Hub on the VPS behind Caddy (TLS, public address).**

```bash
scp -r metacom hub user@vps:~/metacom/ && ssh user@vps
cd ~/metacom/hub/deploy && cp .env.example .env    # set HUB_DOMAIN
docker compose up -d --build
docker compose exec hub cat /data/bootstrap-token.txt  # then: docker compose exec hub rm /data/bootstrap-token.txt
```

On the Mac: `metacom login wss://hub.example.com/ <owner token>`, then `metacom token macbook
--role agent --save` and `metacom token vps --role agent`. On the VPS: `npm install -g ./cli`
(or `npm link`), `metacom login wss://hub.example.com/ <vps agent token>`, then
`metacom dev -n Deploy claude`.
Flow needs its config reloaded (`flow cmd reload`).

**B. Hub stays on the Mac, everything joins over Tailscale.** Install Tailscale on the Mac,
the VPS and the phone; run the hub with `HUB_HOST=<tailscale ip>` (see
`deploy/install-launchd.sh`), and use `ws://<tailscale ip>:8900/` everywhere. Nothing is
public; Tailscale encrypts the link. Simplest and strongest when you own all the devices.

## Where this goes: connectors and declared tools

Telegram is the first *connector*: a room member that is not a terminal but a bridge, living
in the hub and listening on `hub.events` (`room/message`, `agents/attention`, `agents/changed`).
The intended shape, so the next ones fit the same mould:

- **Methods carry their access.** Today `hub/api/index.js` is one file, every method is
  `access: 'public'` and the real checks (`owner()`, "Not your room") sit inside `hub.js`.
  Impress conventions fix that: `api/<unit>/<method>.js` exporting `{ access, roles, rooms,
  parameters, method }`, arguments validated against the schema at the door, and
  `system/introspect` answering each caller with only what it may call. The conventions can
  be adopted without the Impress runtime, keeping one process and no database; running on
  Impress proper (sessions, scheduler, static, plugins) is the later option.
- **A connector is a member with rules.** `{ name, kind: 'connector', url | in-process,
  secret, rules: { rooms, events, from } }`: outbound, the hub delivers matching events (for
  an external URL, signed and only to declared addresses); inbound, the connector calls the
  ordinary API under its own token, so `accept` rules and the owner gate apply unchanged.
  Telegram, Slack, a cron, Flow: all the same shape, rules decide what leaves a room.
- **Endpoints are tools with declared permission.** The assistant's `tools.js` and the agents'
  MCP list in `cli/lib/mcp.js` are hand-written today. A method (or a connector's remote
  endpoint) that declares `tool: { description }`, `parameters` and `access: { roles, rooms,
  groups }` is exposed automatically as an MCP tool to agents in those rooms, as an assistant
  tool, and in introspect; groups are named member sets a room grants tools to. The hub
  validates every call before forwarding, so the closed, typed tool set stays closed, only
  declared per room instead of hard-coded.
- **Anything from outside is data.** Tool results and connector messages are shown to agents
  as text, never as instructions; per-room allowlists stay small; agents never fetch arbitrary
  URLs, only declared connectors do.

Order: method metadata + schema validation + filtered introspect; MCP tools generated from
it; connectors with outbound rules (Telegram already has the in-process half); remote tools.

## Security

- Every connection needs a token. Tokens are random 32 bytes, stored as SHA-256, compared
  in constant time, created and revoked only by an owner (`metacom token`, `metacom tokens`, or the
  `admin/*` API). Five bad tokens block an address for ten minutes.
- Websockets must sign in within ten seconds and may send nothing but the sign-in and the
  API introspection before that; at most 64 sockets per address; 200 calls per 10 s per
  connection; 16 KB per message.
- Two roles. *Owner* tokens (you, Flow, the phone) can dispatch, create tokens and see all
  rooms. *Agent* tokens can register, report status, post and read their own room, and message
  other agents as information. Only owner messages get typed into an agent.
- The hub binds to 127.0.0.1 by default and warns when started on another address without
  TLS. For remote use put it behind Caddy (compose file) or Tailscale.
- The web client is served with a strict CSP; the token is kept in that browser only.
- Agents treat room text as data: the system prompt tells Claude which lines are owner
  instructions and which are other agents' information. Keep that in mind when giving an
  agent token to a machine you do not fully control: it can speak in the room, not command
  other agents.

## Development

```bash
cd hub && npm test                 # router, auth, tools and hub unit tests
cd metacom && npm test             # upstream metacom suite
```

metacom master (unreleased, Node 22+) is used through `file:../metacom`; the npm release 3.2.6
lacks the standalone `Server` and `Metacom.connect` this depends on.
