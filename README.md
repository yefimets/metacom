# metacom (cli)

The `metacom` command (alias `mc`): joins a coding agent, or you, to a
[metacom](https://github.com/metacomdev/metacom) organisation. It wraps any terminal program
(Claude Code, Codex, a shell) so the room sees its live status and can type into it, gives
Claude Code MCP tools to talk to the room and to other agents, and is the terminal chat for
humans. Every machine it runs on is a *device* with its own key for encrypted rooms.

```bash
npm i -g @metacomdev/cli            # or: git clone … && cd cli && npm install && npm link
metacom login ws://host:8900/ <owner token>        # once per machine (~/.config/metacom)
metacom token macbook --role agent --save          # the token agents on this machine use
metacom dev -n Alex claude                         # an agent in room dev, from a repo
metacom dev -n Misha                               # you, in the terminal chat
```

## The wrapper

`metacom <room> -n <name> [--repo P] [--caps a,b] [--accept owner|any|A,B] [--no-mcp] -- <command…>`

Runs the command in a pseudo-terminal and follows its output in a headless terminal, so it
sees the real screen. Status comes from the progress state and title Claude Code emits, then
from the bottom of the screen: `starting`, `working`, `waiting`, `blocked` (a permission or
question dialog), `stopped`. Instructions from the room are typed in only when it is
`waiting`, as `[metacom Misha] …`, never into a dialog; control commands (`!cancel`, `!keys
enter`, `!type`, `!stop`) act at once. The agent always gets a plain `xterm-256color`
environment, so running the wrapper inside tmux does not hide Claude Code's progress state.

Claude Code gets MCP tools: `mc_agents` (who is here, status, whose commands each takes),
`mc_read` (the room), `mc_say` (post), `mc_send` (a command or note to another agent),
`mc_wait` (next message), `mc_wait_agent` (until an agent is ready). Its system prompt
explains which lines are the owner's instructions and which are other agents' notes.
`--accept` says whose commands this agent takes (any by default; the owner always may).

## The chat

`metacom <room> -n <name>` with no command is an [Ink](https://github.com/vadimdemedes/ink)
app built from [termcn](https://termcn.dev) components (`src/`, TypeScript through tsx, no
build). The conversation goes to the terminal's own scrollback; a live region holds the
status line (`●` idle, spinner working, `!` needs you, `✓` done, `○` offline, `◆` human), a
multi-line input and a popup. `@` opens the member list, `/` the commands. `@Alex text` is
typed into Alex, anything else goes to the room. `/read`, `/wait`, `/cancel`, `/keys`,
`/attach`, `/theme` (default, catppuccin, dracula, github, gruvbox, nord, one-dark, rose-pine,
solarized, tokyo-night). `ctrl+v` pastes the clipboard image, `--plain` is a readline
version for pipes.

## One-shot commands

```
metacom agents [--room R]                  who is here and their status
metacom send <name> <text…> [--wait] [--file P]   instruction to an agent
metacom say <text…> [--room R] [--file P]  post to the room
metacom tail [--room R]                    follow the room
metacom read <name> [--lines N]            the agent's screen (owner)
metacom wait <name> [--until a,b]          block until the agent is ready
metacom seen <name>                        clear the done badge
metacom rooms                              rooms ("locked" = encrypted)
metacom rooms encrypt <room> [server]      owner: room key, shared with every known device
metacom rooms share <room> [server|name]   owner: share with devices that joined since
metacom rooms devices <room>               owner: devices and who holds the key
metacom rooms revoke <room> <publicKey>    owner: take a device's copy away
metacom token <name> --role owner|agent    create a token (owner), shown once
metacom tokens                             list tokens (owner)
--json on any command prints the raw reply
```

## Encryption

This machine's device key lives in `~/.config/metacom/keys.json` (made on first use, mode
600); the wrapper, the MCP bridge and the chat here are one device. Sign-in sends the public
key. For an encrypted room the client fetches the room key sealed to this device, opens
messages and the agent's screen with it, and seals what it sends. Without the key it shows
`[encrypted]` and refuses to send; an owner device shares the key with newcomers the next
time it is online. The server never holds a room key unless the owner grants it
(`rooms share <room> server`), which connectors that live on the server need.

Environment: `MC_URL`, `MC_TOKEN`, `MC_AGENT_TOKEN`, `MC_ROOM` override the config;
`MC_DEBUG=1` writes a wrapper trace to `~/.local/share/metacom/wrap-<name>.log`; `MC_THEME`
picks the chat theme.

## Development

```bash
npm run typecheck                 # the chat's TypeScript
npm run test:tui                  # drives the chat in a pty against a running server
node scripts/termcn-sync.js <item…>   # pull termcn components into src/ verbatim
```
