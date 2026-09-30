# Collecting agent sessions on the hub

Design note, 30 September 2026. How every agent's Claude Code, Codex or Grok session reaches one
folder on the hub, for a team-lead agent to read. Collection only: the digest, the signals and
the lead agent come after it and read what it writes.

## What there is to collect

| Tool | Where the session lives | Shape |
| --- | --- | --- |
| Claude Code | `~/.claude/projects/` `<folder>/<id>.jsonl`, one file per conversation; `/clear` starts a new file | append-only JSON lines; this server alone: 76 sessions, 262 MB in 10 days |
| Codex 0.156 | a local app-server daemon with "paginated thread history"; the old `~/.codex/sessions/…/` `rollout-*.jsonl` are "legacy" (`codex migrate-rollouts`) | changes between versions: read it through `codex` itself, not its files |
| Grok CLI | not installed here: to find out | — |

Agents run on this server, on misha's Mac and on roma's `arc`. The Mac and `arc` sit behind NAT
and reach the hub only through the tunnel (HTTPS/WebSocket), which is how everything below must
travel.

## The recommended flow: the wrapper pushes, by offset

```
 agent machine (Mac, arc, this server)                          hub (this server)
┌──────────────────────────────────────────────┐        ┌───────────────────────────────────────┐
│ claude / codex (TUI)                         │        │ POST /sessions                        │
│   writes its session file ──────────┐        │        │   token → member → may write only     │
│   SessionStart hook → session id ─┐ │        │        │   sessions/<member>/…                 │
│                                   ▼ ▼        │        │   offset == size on disk? append      │
│ metacom dev (wrapper)                        │ HTTPS  │   else 409 {size} → client resends    │
│   knows: agent, machine, folder, tool, id    │ tunnel │                                       │
│   on "turn finished", on exit, every 5 min:  │───────▶│ sessions/<agent>/<tool>/<id>.jsonl    │
│   read the file from the last offset ───────────────▶ │ sessions/index.json  (who, where,     │
│   send only the new bytes + offset           │        │   when, size, first request)          │
│   remember the new offset (~/.local/share/…) │◀───────│ 200 {size}                            │
└──────────────────────────────────────────────┘        └──────────────────┬────────────────────┘
                                                                           │ new bytes
                                                                           ▼
                                                        digest + redaction → signals → lead agent
```

- **Only new bytes travel.** A session file only grows, so the wrapper keeps an offset per file
  and sends what comes after it. A turn is a few KB; the tunnel barely notices.
- **Nothing is lost when the hub is away.** An unsent part stays on disk; the next push starts
  from the hub's own size (a 409 answers with it), so a missed or doubled push repairs itself.
- **Identity comes for free.** The wrapper already holds the agent's token, name, machine, folder
  and tool; the hub files the bytes under the member the token belongs to, so an agent cannot
  write into another's folder, and only the owner (and a read-only lead) can read.
- **The exact session** comes from the SessionStart hook the wrapper passes to Claude (built on
  `feature/thread-sessions`): no guessing which file in a folder belongs to this agent.

## The alternatives, and what is wrong with each

| | How it works | For | Against |
| --- | --- | --- | --- |
| **A. Wrapper push** (recommended) | `metacom dev` sends new bytes after each turn | knows the agent and the session; works through NAT and the tunnel; one place for every tool; offsets make it cheap and safe | only sessions started through `metacom dev`; one small adapter per tool; a wrapper killed with `-9` sends the rest only next time |
| **B. Tool hooks** | Claude's `Stop` / `SessionEnd` hook runs `metacom sessions push <file>`; Codex's own notify | also catches sessions started without the wrapper | set up per tool and per machine; Grok may have none; a global hook also collects your personal, non-agent sessions; a hook that fails does so silently |
| **C. The hub pulls** | cron on the hub: `rsync`/`scp` over SSH from each machine | nothing to change in the agents | the Mac and `arc` are behind NAT: the hub cannot reach them; needs SSH keys to every machine; copies whole folders, with no idea which agent a file is |
| **D. A sync tool** | Syncthing / rclone mirrors `~/.claude/projects` to the hub | set once, catches everything | the same: everything, personal sessions included; no agent names; big first copy (262 MB here); conflicts; Codex's daemon storage does not mirror cleanly |
| **E. The agent reports itself** | an MCP tool the agent calls at the end: "save my session" | no files touched | the model forgets, and it costs tokens; only what the model chose to say, not what happened |
| **F. A model proxy** | all model traffic through a proxy that logs it | complete and tool-agnostic | invasive, breaks with subscription (OAuth) logins, sees every secret in flight; far too much for this need |

**A**, with **B** added later for machines where sessions started outside the wrapper should also
count. **C** and **D** fail on NAT and on who-is-who; **E** is unreliable; **F** is out of scale.

## Size, safety, keeping

- **Size.** About 1 GB a month at today's pace; sessions untouched for 7 days are gzipped (JSON
  lines shrink roughly 5–10×). The server has 853 GB free.
- **Secrets.** Raw sessions hold code, keys and tokens: the folder is `0700`, never served on the
  web, and the lead agent reads the digest (redacted) — a raw session only by asking the hub for
  one by id.
- **Codex.** Read through `codex` itself (its archive/export commands), not its files, since 0.156
  moved storage into a daemon; to settle on `arc`, where Codex runs. **Grok:** to find out.

## Build order

1. Hub: `POST /sessions` (append by offset, per-member folders), `index.json`, owner read. (S)
2. Wrapper: the Claude adapter (session id from the hook, offsets, push on turn end and exit). (M)
   Needs `feature/thread-sessions` merged first.
3. `metacom sessions pull <agent> <id>`: a session back on any machine, `claude --resume` there. (S)
4. Codex adapter after a look at `arc`; Grok once its storage is known. (S each)
5. Then the digest and redaction, the signals, and the lead agent.
