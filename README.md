# metacom (cli)

The `metacom` command (alias `mc`): joins a coding agent, or you, to a
[metacom](https://github.com/metacomdev/metacom) organisation. It wraps any terminal program
so the room sees its live status and can type into it, gives Claude Code, Codex and opencode
the room's MCP tools so they can talk to it and to each other, and is the terminal chat for
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
sees the real screen. Status is `starting`, `working`, `waiting`, `blocked` (a permission or
question dialog) or `stopped`. Instructions from the room are typed in only when it is
`waiting`, as `[metacom Misha] …`, never into a dialog; control commands (`!cancel`, `!keys
enter`, `!type`, `!stop`) act at once. The agent always gets a plain `xterm-256color`
environment, so running the wrapper inside tmux does not hide Claude Code's progress state.

## Agents it configures

Wrapping, status, typing, control commands and encryption work with **any** terminal program.
On top of that, three harnesses get the room's MCP tools — `mc_agents` (who is here, status,
whose commands each takes), `mc_read` (the room), `mc_say` (post), `mc_send` (a command or
note to another agent), `mc_wait` (next message), `mc_wait_agent` (until an agent is ready) —
and a briefing that explains which lines in their terminal are the owner's instructions and
which are other agents' notes:

| Command | Tools via | Briefing via |
| --- | --- | --- |
| `claude` | `--mcp-config` | `--append-system-prompt` |
| `codex` | `-c mcp_servers.metacom.…`, merged over your `~/.codex/config.toml` | the MCP server's own `instructions` |
| `opencode` | `OPENCODE_CONFIG_CONTENT`, merged over your `opencode.json` (model, providers and your own MCP servers are kept) | an `instructions` file, written to `~/.local/share/metacom/` |
| anything else | — | — |

Nothing in your config files is modified: both merges happen in the environment of that one
child process. `--no-mcp` turns the tools off; an unwrapped harness still joins the room, is
watched and can be typed into, it just cannot speak on its own.

`--accept` says whose commands this agent takes (any by default; the owner always may).

Status comes from the terminal title and progress escapes when a harness emits them (Claude
Code does), otherwise from output activity. A question on screen is detected by shape —
Claude Code's dialogs, Codex approvals, opencode's *Permission required* — and shows as
`blocked` with the question. `MC_BLOCKED='your regex'` adds a pattern for a harness whose
prompt is not recognised (`|||` separates several).

## The chat

`metacom <room> -n <name>` with no command is an [Ink](https://github.com/vadimdemedes/ink)
app built from [termcn](https://termcn.dev) components (`src/`, TypeScript through tsx, no
build). The conversation goes to the terminal's own scrollback; a live region holds the
status line: who is active on the left, freshest and most in need of a look first, and who
you are with the room on the right. Below it a multi-line input and a popup. `@` opens the
member list wherever you type it, `/` the commands. The first `@Name` in a message addresses
that agent — at the front it is the address and comes off the text, in the middle of a
sentence it stays part of what you wrote; with no mention the message goes to the room. `/read`, `/wait`, `/cancel`, `/keys`,
`/attach`, `/theme` (default, catppuccin, dracula, github, gruvbox, nord, one-dark, rose-pine,
solarized, tokyo-night). `--plain` is a readline version for pipes.

**Markdown.** Agents write in it, so the chat draws it: headings and `**bold**` in bold,
`` `code` `` in the accent colour, numbered and bulleted lists with a hanging indent so a long
step stays a block, `>` quotes and `---` rules muted, fenced blocks kept verbatim. The marks
themselves come off, and what is left is exactly what a selection copies. The whole chat keeps
a two-column gutter down its left, so nothing starts hard against the terminal edge.

Enter sends; **shift+enter**, option+enter, ctrl+j or a trailing `\` start a new line. A
plain terminal reports shift+enter as an ordinary carriage return, so the chat turns on the
kitty keyboard protocol to tell them apart; where that is not supported (Terminal.app), use
option+enter or ctrl+j.

**Scrolling.** The conversation is a window the chat draws, not the terminal's scrollback, so
the input stays at the bottom: the wheel and page up/down move the history, a message arriving
while you are reading back does not yank the view, and sending returns to the newest line. The
chat runs on the alternate screen, so leaving it gives your terminal back as it was.

**Clicking.** A click on a name — in the status line or in a message header — puts `@name `
at the front of the input. Under every message sits a muted row: **↩ reply** addresses its
author and quotes the line it answers, **↪ forward** asks who for and then sends it on under
your own name marked `↪ [forwarded from X]`, so an agent reads where it came from.
**Selecting.** A terminal hands the mouse to one owner at a time, so a program that wants
clicks has to draw the selection itself. The chat does: drag over the conversation and the
text lights up, let go and it is on the clipboard — `pbcopy`, `wl-copy` or `xclip` locally,
and OSC 52 when there is none, so a selection made in a chat running over ssh lands on the
machine in front of you. A press and release in the same place is a click, so names and the
action row still work. `ctrl+t` (or `/mouse`) hands the mouse back to the terminal if you
would rather use its own selection, and the status line shows `click` while the chat holds
it. Only what is on screen can be selected: scroll a line into view first.

**Pasting.** `ctrl+v` pastes whatever is on the clipboard: an image is attached as
`[image 1.png]` and uploaded with the message, a file path becomes an attachment the same
way, anything else is inserted as text. For **cmd+v** to do that, bind it to `^V` (hex 16)
— iTerm2: *Send Hex Code* `0x16`; Ghostty: `keybind = cmd+v=text:\x16`; Terminal.app: `\026`.
That replaces the terminal's own paste, which is the point: a terminal cannot paste an image
into a text stream, and text still arrives through the same key.

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

## Keeping it up to date

```
metacom update            # git checkout: fast-forward the branch, npm install when the lockfile moved
                          # installed from npm: npm install -g @metacomdev/cli@latest
metacom update --check    # only say what is waiting, and list the commits
```

`metacom --version` prints the version and the commit it is running, and the chat's banner
says the same — a running chat keeps the code it started with, so that is how you see whether
a restart picked the update up.

It never forces anything: a checkout with uncommitted changes, with commits of its own, or on
a detached HEAD is reported and left for you. Restart the chat and any wrapped agents
afterwards — a running agent keeps the code it started with.

## Development

```bash
npm test                          # harness wiring and screen classification
npm run typecheck                 # the chat's TypeScript
npm run test:tui                  # drives the chat in a pty against a running server
node scripts/termcn-sync.js <item…>   # pull termcn components into src/ verbatim
```

`npm test` also checks that `codex` and `opencode` really accept what the wrapper builds,
when they are installed: `npm i @openai/codex opencode-ai` somewhere and run
`MC_TEST_AGENTS=<that>/node_modules/.bin npm test`; without it those two cases are skipped.
