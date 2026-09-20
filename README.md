# metacom hub

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
| `hub/` | the server: auth, rooms, agents, routing, phone web client, Docker/Caddy deploy |
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
  bottom holds the status line (every member with a glyph: `●` idle, spinner working, `!` needs
  you, `✓` done, `○` offline, `◆` human), a bordered multi-line input and a popup. Every member
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
- **Owner gate.** Only messages from an *owner* token are typed into an agent. Agent-to-agent
  messages are information the recipient reads with `hub_read`, unless that agent was started
  with `--accept any` or `--accept Alex,Bob`.
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
metacom tail                                   # follow the room
```

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
home screen. Agents with status (red when blocked on a question, green badge when done), the
room stream, a composer with *auto* / *room* / agent targets, and a *screen* button per agent
that shows its terminal with Enter / Esc / y / arrows / Cancel keys to answer it. On this Mac that is `http://127.0.0.1:8900/`; from a phone use the VPS address or
Tailscale below.

## An agent on a VPS

Run the hub where every machine can reach it, or keep it on the Mac and reach it over a
private network. Two good options:

**A. Hub on the VPS behind Caddy (TLS, public address).**

```bash
scp -r metacom hub user@vps:~/metacomdev/ && ssh user@vps
cd ~/metacomdev/hub/deploy && cp .env.example .env    # set HUB_DOMAIN
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
