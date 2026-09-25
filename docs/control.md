# Control: starting, stopping and restarting agents from the chat, safely

Proposal, September 2026. Today an agent exists because someone typed `metacom dev -n Alex claude`
in a terminal on the machine where it runs. From the chat you can talk to it, answer its dialogs
and `!stop` it — and after that it is gone until someone logs in to that machine again. This is
how to get the rest from the CLI: *what* runs, *where*, stop, restart, and see it all — without
turning the hub into a remote shell that anyone with a leaked token can drive.

## What is there today, and what it lacks

| Piece | Today | Gap |
| --- | --- | --- |
| Starting an agent | `metacom <room> -n X claude` by hand, in a terminal on that machine | nothing can start one remotely |
| The process | the wrapper owns the PTY and dies with its terminal | no detach, no restart, no `--resume` |
| Stopping | `!stop` → SIGTERM to the PTY, owner only | nothing to bring it back; a crash is just `stopped` |
| Machines | a `host` string on each member | the hub does not know which machines exist or what they may run |
| Permissions | two roles, owner and agent; any agent token reads and writes any room ([auth.md](auth.md)) | no per-machine, per-room or per-action grants; no audit log |
| Trust | whoever holds the hub holds everything | a compromised hub could type into every agent |

## The shape: a node on every machine

Add one long-lived process per machine: **`metacom node`**, started by systemd or launchd, signed in
with its own *node token*. It is the only thing that starts agent processes on that machine.

```
            chat / phone / Telegram
                     │  "start Deploy on hetzner in ~/metacom, claude"
                     ▼
     ┌──────────── hub ─────────────┐   desired state, permissions, audit, routing
     │  rooms · members · policies  │
     └──────┬────────────────┬──────┘
   wss      │ spawn/stop/…   │ spawn/stop/…     (signed by the owner's device key)
            ▼                ▼
   ┌─ node: macbook ─┐  ┌─ node: hetzner ─┐   enforces its own allowlist, owns the PTYs
   │ Alex  (claude)  │  │ Deploy (claude) │
   │ Bob   (codex)   │  │ metaceo(claude) │
   └─────────────────┘  └─────────────────┘
```

Why a node and not "the hub runs `ssh`": the node dials *out* to the hub (no open ports, works
behind NAT, the way agents already connect); the machine keeps its own rules even if the hub is
wrong; and the node, not a terminal window, owns the agent's PTY, which is exactly what herdr does
and what we listed as missing (detach and reattach). The existing wrapper becomes the node's
per-agent worker; `metacom dev -n X claude` in a terminal keeps working as today, for
ad-hoc agents.

### What a node declares

On sign-in the node publishes a manifest; the machine's owner writes it, the hub only reads it:

```jsonc
// ~/.config/metacom/node.json on hetzner
{
  "name": "hetzner",
  "max_agents": 6,
  "workdirs": ["~/metacom", "~/metaceo", "~/code/*"],   // cwd must resolve inside one of these
  "harnesses": {
    "claude": { "cmd": "claude", "resume": "--resume", "permission_mode": "default" },
    "codex":  { "cmd": "codex" }
  },
  "env": { "pass": ["PATH", "HOME", "LANG"], "secrets": ["ANTHROPIC_API_KEY"] },
  "owners": ["misha"],               // whose signed requests this node accepts
  "run_as": "misha"                  // or a dedicated unix user per agent, see Isolation
}
```

The hub shows it: *hetzner · online · 2/6 agents · claude, codex · ~/metacom ~/metaceo ~/code/\**.

### The lifecycle

An agent becomes a record with a **desired state**, not just a process that happens to be alive:

```
{ name: "Deploy", node: "hetzner", room: "dev", harness: "claude", cwd: "~/metacom",
  args: [], accept: "owner", restart: "on-failure", desired: "running" }
```

The node reconciles: desired `running` and no process → start it; `stopped` → SIGTERM, then
SIGKILL after 10 s; `restart` → stop, then start with the harness's resume flag so the
conversation carries on. Crash with `restart: on-failure` → start again with backoff (1 s, 2 s,
4 s … capped at 5 min, and after 5 crashes in 10 minutes it stays down and the room is told why).
Reconciliation instead of fire-and-forget commands is what makes this survive a hub restart, a
node restart or a dropped connection: when either side comes back, the node reports what is
actually running and both converge on the record.

## In the CLI

The room list (← on an empty line) grows a second column: **rooms · machines**. → on a machine
shows its agents and what it allows; the same keys work:

```
  machines                      rooms
› hetzner   online · 2/6        Deploy   claude  ~/metacom     working   4m
  macbook   online · 3/8        metaceo  claude  ~/metaceo     waiting
  vps-2     offline 3h
                                enter: open its room · s stop · r restart · n new agent
```

And the same as commands, for the phone and for scripts:

| Command | Does |
| --- | --- |
| `/nodes` | machines, online state, load, what each allows |
| `/spawn Deploy on hetzner claude ~/metacom [--room dev] [--accept owner]` | declares and starts an agent |
| `/stop Deploy` · `/restart Deploy` · `/start Deploy` | changes the desired state; the node acts |
| `/logs Deploy` | the last screen and the node's lifecycle log (started, exited 1, restarted) |
| `/forget Deploy` | removes the record; the process must be stopped first |

`n` (new agent) opens a short form in the input, one field at a time with completion from the
node's manifest: machine → harness → directory (only allowed ones) → name → room. Enter on the
last field sends one signed request. `metacom spawn …` does the same from a shell, so agents can
be started by scripts or by another agent — if a policy lets them (below).

## Permissions

Three layers, each able to say no on its own. A request runs only if all three agree.

**1. Who is asking (identity).** Every human has a *device key* (the framework build already
creates P-256 keys per device; add Ed25519 signing next to the ECDH). Tokens stay as the transport
credential, but they become per device, carry an expiry (90 days, renewed on use) and a scope, and
revoking one closes its live sockets at once — today it does not.

**2. What the hub allows (policy).** Roles become sets of capabilities, granted per room or per
node, instead of the two hard-coded roles:

| Capability | owner | operator | member | viewer | agent |
| --- | --- | --- | --- | --- | --- |
| read and post in granted rooms | ✓ | ✓ | ✓ | read | own room |
| command an agent (typed as instruction) | ✓ | ✓ | if its `accept` names them | – | if `accept` allows |
| answer dialogs, `!keys`, `!cancel` | ✓ | ✓ | – | – | – |
| start / stop / restart agents on node N | ✓ | if granted N | – | – | only with a delegated grant |
| declare nodes, mint tokens, change policy | ✓ | – | – | – | – |

Policy is data (`policies.json`, edited with `metacom policy …`), checked in one place: each API
method declares `{ capability, scope: room|node }` — the Impress-style method metadata already
planned in [impress.md](impress.md) — and the hub refuses before the handler runs. This also closes
the known hole that any agent token can read any room.

**3. What the machine allows (the node).** The node checks every spawn against its manifest:
harness in the list, `cwd` inside an allowed directory after resolving symlinks, name not taken,
under `max_agents`. And it verifies the **owner's signature** on the request, over
`{action, agent, node, cwd, harness, args, nonce, expires}`. The hub forwards the signed blob; it
cannot forge one. So a compromised hub, or a stolen agent token, can at worst refuse service — it
cannot start a process on your machine. This is the single most important property in this
document.

**Delegation, for agents that start agents.** metaceo may want to start a researcher. Instead of
giving agents spawn rights, the owner signs a narrow, expiring grant: *metaceo may start up to 2
agents of harness claude on hetzner in ~/metaceo/\*, until Friday*. The agent presents the grant;
the node checks it like a signature from the owner, with its limits. (This is a macaroon or a
UCAN in spirit; a signed JSON object is enough.)

**Approvals for the risky ones.** Some actions ask the owner first even when a policy allows them:
starting an agent with `permission_mode: bypassPermissions`, a `cwd` outside the manifest's usual
directories, or anything requested by an agent. The owner gets a "Deploy wants to start X · y/n"
line (phone, chat, Telegram); approving signs it.

## Isolation: what an agent can reach once it runs

Permissions decide who may start a process; isolation decides what that process can do.

- **Harness permissions stay on.** The node writes each agent's Claude Code settings: permission mode
  `default` unless the owner signs otherwise, an allowlist of tools and commands per agent, and
  the MCP hub tools. Answering dialogs from the phone is the product; skipping them is an opt-in
  per agent, never a machine-wide default.
- **One directory, one worktree.** `cwd` is fixed at spawn; for code, the node can make a git
  worktree per agent (`~/code/app/.worktrees/Alex`), so two agents never edit the same checkout.
- **A unix user per agent, when it matters.** `run_as: "per-agent"` makes the node start each agent
  as `mc-<name>`, owning only its worktree: an agent cannot read another's files or your
  `~/.ssh`. The step after that is a container (podman/docker, the worktree mounted, network
  egress limited to the model API and the git remote) for agents running on code you do not trust.
- **Secrets are injected, not inherited.** The node passes only the environment the manifest lists;
  API keys come from the node's secret store at spawn. The hub never sees them.

## Audit

Every state change — sign-in, token minted or revoked, policy changed, spawn, stop, restart,
approval, control command — appends one record to `audit.jsonl`:
`{ts, who, device, action, target, args, result, prev_hash}`. Each record carries the hash of the one
before, so a deleted or edited line is detectable; nodes keep their own log of what they ran,
which can be compared with the hub's. `/audit [agent|node|who]` reads it from the chat.

## Reliability

- **The hub can go down and agents keep running.** The node owns the processes; it queues status
  and output while disconnected and reconciles on reconnect. Today a hub restart is harmless to
  wrapped agents too, and it must stay that way.
- **Requests are idempotent.** Each carries an id; a spawn retried after a timeout does not start
  two agents. Requests expire (60 s): a stop queued while a node was offline does not fire an hour
  later by surprise.
- **Heartbeats with leases.** A node pings every 10 s; after 30 s of silence the hub shows it
  `unreachable` (not `offline`: the agents may be fine), and agents on it `unknown`.
- **Supervised everything.** The hub and each node run under systemd/launchd with restart on
  failure; the node's own state (desired records, grants seen, nonces used) is a small JSON file
  written atomically, so a node restart re-adopts its running agents instead of orphaning them.
- **Graceful stop.** SIGTERM, a grace period, SIGKILL; the node reports the exit code and the last
  screen, so "why did it die" has an answer in `/logs`.
- **Health you can read.** `metacom doctor` on any machine: hub reachable, token valid, node
  manifest parses, harnesses on PATH, clock skew (signatures carry expiry).

## Build order

Each step is useful alone and none needs the next.

1. **Node, local only** — `metacom node` owns PTYs, reattach (`metacom attach Alex`), restart with
   `--resume`, restart policy. No remote spawn yet. Fixes "the wrapper dies with its terminal".
2. **Remote lifecycle for the owner** — node manifest, `/nodes`, `/spawn` `/stop` `/restart`, the
   machines column in the room list. Owner token only; nodes accept the owner's requests.
3. **Signed requests** — device keys sign; nodes verify. From here a hub compromise cannot start
   processes.
4. **Declared permissions and audit** — capabilities per room/node, operator and viewer roles,
   `audit.jsonl`, revocation that closes sockets, token expiry. Closes the "any agent reads any
   room" hole.
5. **Delegation and approvals** — grants for agents that start agents, the y/n approval line.
6. **Isolation** — worktree per agent, unix user per agent, then containers.

Steps 1–2 are about a week and are what you asked for first; 3–4 are what make it safe to run on
machines you do not sit next to, and should land before anyone else gets a token.

## Open questions

- Does the hub keep agent records when their node is gone for good, or does `/forget` stay manual?
- Should an agent's room be fixed at spawn, or may the owner move it (today it cannot move)?
- Per-agent unix users need `sudo` rules on the node once; is that acceptable on the Mac, or is it
  Linux-only?
- One owner today. With a team, who may sign policy changes — any owner, or two of them?
