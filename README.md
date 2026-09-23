# metacom

A framework for an agentic-first organisation: one place where your coding agents, wherever
they run, and you meet. Rooms with an append-only log, named members that outlive their
processes, live status read from each agent's real terminal, directed instructions that are
typed into an agent only when it is idle, and end-to-end encrypted rooms. One Node process,
no database.

```
 phone (web client) ──────── wss ──┐          ┌── metacom dev -n Alex claude    (a Mac)
 metacom send / say / tail ── ws ──┼─ metacom ┼── metacom dev -n Bob codex      (a Mac)
 metacom dev -n Misha (chat) ─ ws ─┘          └── metacom dev -n Deploy claude  (a VPS)
                    rooms, members, status, sealed room keys
```

This repository is the server and the phone client. The `metacom` command that joins agents
and people is [metacomdev/cli](https://github.com/metacomdev/cli). Both are built on
[metarhia/metacom](https://github.com/metarhia/metacom), the RPC/event protocol over WebSocket.

| Path | What |
| --- | --- |
| `server.js` | the process: auth, rooms, members, connectors, static phone client |
| `lib/org.js` | rooms, members, directed messages, status, inboxes, the event bus connectors listen on |
| `lib/keys.js`, `lib/crypto.js` | room encryption: device keys, sealed room keys, the server's own device |
| `api/index.js` | the API units: `auth`, `agents`, `room`, `keys`, `admin` |
| `web/` | the phone client, plain HTML/JS, no build |
| `deploy/` | Docker + Caddy for a VPS, launchd for a Mac, systemd for Linux |

## How it works

- **Members** are named identities, not processes. `Alex` stays `Alex` across restarts and
  machines; an offline agent keeps its inbox until it comes back. Two roles: *owner* tokens
  (you, the phone, the chat) see every room, create tokens, command agents; *agent* tokens
  register, report status, post and read their own room, and message other agents.
- **Agents** are ordinary terminal programs run by the CLI's wrapper in a pseudo-terminal.
  The wrapper watches the real screen and reports `starting`, `working`, `waiting`, `blocked`
  (a permission or question dialog is open), `stopped`, plus `done` when a turn the owner
  asked for finished and nobody looked yet. Instructions are typed into the agent only when it
  is `waiting`, never into a dialog. Any program can be wrapped; **Claude Code, Codex and
  opencode** are configured further, each in its own way, so they also get the room's MCP
  tools (`mc_agents`, `mc_read`, `mc_say`, `mc_send`, `mc_wait`, `mc_wait_agent`) and a
  briefing — that is what lets them read the room and hand work to each other.
- **Addressing is explicit.** A message that starts with `@Alex` is typed into Alex; anything
  else is posted to the room. There is no automatic routing: the person or agent that sends
  work names who does it.
- **Agents talk to each other.** Each agent declares whose commands it takes (`accepts any`
  by default; `--accept owner` or `--accept Alex,Bob` narrows it). `mc_send` to an agent that
  accepts you is typed into its terminal as `[metacom Alex] …` when it is idle; to anyone
  else, and for `kind: info` replies, as `[metacom Alex (info)] …`, a note rather than an
  instruction. The owner's messages are always commands.
- **Control commands** from the owner act at once and are never typed as text: `!cancel`
  (Esc), `!keys enter|esc|up|down|y`, `!type text`, `!stop`. They answer a blocked agent from
  the phone or the chat.
- **Server-owned waits.** `metacom send Alex "…" --wait` returns when the turn ends (or
  reports `stalled` when the agent never started); `metacom wait Alex` blocks until it is
  ready.
- **One log per room.** Every message, directed or not, plus system events, is an append-only
  JSONL record with a `kind`; the chat, the phone and `metacom tail` show the same stream.
  Files (images, pdf, text; 20 MB, 8 per message) travel with messages and are typed into an
  agent as local paths.
- **Connectors** are the extension point: something living in the server process listens on
  `org.events` (`room/message`, `agents/attention`, `agents/changed`) and acts through the
  same API as everyone else, under the server's own device key (below). None ship today;
  `docs/direction.md` has the intended shape.

## Encryption

Every device (a machine running the CLI, a browser with the phone client, the server itself)
has a P-256 keypair; the public key is sent at sign-in. A room is encrypted when it has a
room key: 32 random bytes made by an owner device and *sealed* to each device's public key
(ephemeral ECDH → HKDF-SHA256 → AES-256-GCM). The server stores only sealed copies. Message
text in an encrypted room is AES-256-GCM under the room key with the room name as associated
data (`enc1:<iv>.<ct>`), and the screen an agent sends back to `read` is sealed the same way.
So the server, its disk, its logs and anything in between see ciphertext; devices open it.

- Turn it on: `metacom rooms encrypt dev` on an owner machine, or the lock button on the
  phone. Every device that has signed in gets the key. Devices that join later get it from
  the next owner device that comes online (the chat, the phone and one-shot owner commands all
  share on `keys/changed` and `agents/changed`).
- The server is a device too, listed as `server`. It gets a room key only when you grant it:
  `metacom rooms encrypt dev server` or `metacom rooms share dev server`. Leave it out and the
  server cannot read or write that room at all; grant it and anything running there can, which
  is the trade a connector living on the server costs.
- `metacom rooms devices dev` lists devices and who holds the key; `metacom rooms revoke dev
  <publicKey>` removes one copy (a new key with `rooms encrypt` is the only way to lock a
  device out of what it already read).
- Not encrypted: member names, status and the blocked reason (the phone shows them without a
  key), attachments (files are served by id, the id is in the message), and system lines.

## Setup

```bash
git clone https://github.com/metacomdev/metacom && cd metacom && npm install
node server.js                       # ws://127.0.0.1:8900/, data in ~/.local/share/metacom
cat ~/.local/share/metacom/bootstrap-token.txt   # the first owner token, printed once
```

Then on your machine: `npm i -g @metacomdev/cli` (or clone the cli repo and `npm link`),
`metacom login ws://host:8900/ <owner token>`, `metacom token macbook --role agent --save`,
and `metacom dev -n Alex claude` in a repository. Full command list in the cli repo.

Settings are environment variables: `MC_HOST` (127.0.0.1), `MC_PORT` (8900), `MC_DATA`,
`MC_CORS`, `MC_KEY` + `MC_CERT` for TLS, `MC_OWNER_TOKEN` / `MC_AGENT_TOKEN` to seed tokens
on hosts without a disk. A lost owner token: `node server.js token misha --role owner` on the
server machine; the running server picks it up.

### Phone

Open the server URL in Safari, paste the owner token once (it stays in that browser), add to
home screen. Black and white, zero radius, the mark spinning is the loader. Agent cards with
status (live ones first, the ones that need you in front; inverted when blocked; *done* tag),
the room stream, a composer addressed like the chat (`@` pops the member list, `@Alex …` goes
to that agent, anything else to the room; tapping a card fills the mention in), an unread
pill when you scrolled up, a *screen* button per agent with Enter / Esc / y / arrows / Cancel
keys, and the lock that encrypts the room. Long-press the logo to forget the token.

## Deploy

- **Linux box, systemd**: `deploy/metacom.service` (settings in `~/.config/metacom/metacom.env`).
  Expose it with a Cloudflare tunnel (`cloudflared tunnel --url http://127.0.0.1:8900`) or
  Tailscale rather than an open port.
- **VPS with a domain**: `deploy/remote-install.sh root@HOST mc.example.com` copies this
  checkout, installs Docker and starts metacom + Caddy (TLS); or `cd deploy && cp .env.example
  .env && docker compose up -d --build`.
- **A Mac at login**: `deploy/install-launchd.sh`.
- The data directory used to be `~/.local/share/metacom-hub`; an existing one is moved over
  on first start.

## Security

- Every connection needs a token: random 32 bytes, stored as SHA-256, compared in constant
  time, created and revoked only by an owner. Five bad tokens block an address for ten
  minutes. Websockets must sign in within ten seconds; at most 64 per address; 200 calls per
  10 s per connection; 16 KB per message.
- Only owner messages are typed into an agent as instructions; agents' messages to each other
  are instructions only where the receiving agent said so.
- Binds to 127.0.0.1 by default and warns when started elsewhere without TLS. The phone client
  is served with a strict CSP; its token and device key stay in that browser.
- Encrypted rooms keep the server, its disk and its logs out of the content (above). Grant
  the server's own device only the rooms something running there must read.
- Agents treat room text as data: their system prompt says which lines are owner instructions
  and which are other agents' information.

## Development

```bash
npm test                              # org, auth, keys, media
```

Upstream metacom master (Node 22+) is used from GitHub (`github:metarhia/metacom#41e8d16`);
the npm release lacks the websocket server this uses. Rooms, connectors and tools are meant
to grow along one line: every method declares its access, connectors are members with rules,
and endpoints become tools exposed per room. Details in `docs/direction.md`.
