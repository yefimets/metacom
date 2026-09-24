# Banda terminal client: implementation plan

## Product

`banda` is a room-first Rust terminal client for the existing self-hosted Metacom hub. Herdr owns agent processes and terminals; a detached local bridge connects explicitly selected agents to the hub. Closing the UI does not stop agents. Existing JavaScript `metacom` / `mc` clients remain available.

No hosted Banda/Convex/Vercel service, new model provider, telemetry, or automatic publication of local terminals is introduced. Rooms in the current hub are coordination scopes, not confidentiality boundaries. Local agents still have their existing operating-system privileges.

## Reference research

- **tnotes** (`~/code/tnotes`, MIT): terminal-default colors; Cyan accent, DarkGray secondary text, restrained Green/Yellow/Red statuses; borderless sidebar, one thin divider, compact clickable footer. Default sidebar 32 cells, adjustable 24–48; below 80 columns show the focused panel rather than squeezing both. Separate active room, keyboard selection, and focus. Ctrl+B toggles navigation; Tab cycles focus; mouse uses rendered hit rectangles. Reimplement these patterns, not its document tabs/editor or scalar-width truncation.
- **Banda web** (`~/code/banda`): shared conversation is distinct from task execution detail; quiet personal navigation, authorship and chronological messages, explicit drilldown, queues and requests for input. Its current implementation is a conversation/task system, not a ready-made registry of terminal agents. Do not port its hosted backend, model runtime, or sandbox assumptions.
- **herdr 0.9.1 / socket protocol 22**: NDJSON local API, snapshots, pane-scoped lifecycle subscriptions, native interactive attach. Native agent name/terminal ID are not enough to identify a running process; use foreground process group and process start identity before automation.

## Architecture and ownership

```text
banda TUI / one-shot CLI ─── WebSocket ─── existing hub
          │                                  │
          │ local state / terminal attach    │ one connection per agent
          ▼                                  ▼
       herdr server ◄──── local API ─── banda bridge (detached)
          │                                  │
          PTY                                bindings + delivery journal
          ▼
     Claude / Codex / omp / other herdr-supported agents
```

One Rust package under `banda-cli/`, binary `banda`. Modules: `config`, `model`, `hub`, `media`, `herdr`, `bridge`, `tui`, `mcp`. The repository root is a Cargo workspace. Shared configuration remains `~/.config/metacom-hub/config.json`; private Banda runtime state is separate under `~/.local/state/banda`. Environment overrides permit fully isolated smoke runs.

### Contracts

- Hub actor multiplexes RPC callbacks and events, handles WebSocket control frames, and fails outstanding calls on disconnect. Never silently replay side-effecting calls. Consumers reconnect, subscribe before reconciling snapshots, and deduplicate history by message UUID.
- Each managed identity has a persistent `executorId` and `runId`. The hub accepts only one active executor. Explicit observer connections (MCP) do not reset metadata, publish status, acknowledge commands, or keep a dead executor online. Existing unmanaged JS identities keep their behavior.
- Directed messages to managed identities carry `runId`. Stale control messages cannot affect a replacement process. `unknown` is a real hub state, never ready for automatic input.
- Bridge launches use dedicated owned terminals. Binding an existing agent is explicit and does not take destructive ownership of its pane. `!stop` can close only a dedicated, still-verified owned terminal; it must never stop herdr or destroy an arbitrary bound pane.
- Input is FIFO per agent, idle-only unless an explicit owner control. Persist delivery uncertainty around submission; never claim exactly-once or automatically repeat a possibly submitted prompt. Hub acknowledgement means inbox removal, not successful task completion.
- Agent credentials are separate from owner credentials. MCP uses the agent token only and six existing tools. A terminal screen is not automatically turned into a fabricated task summary.

## Implementation sequence

1. **Transport and configuration:** raw Metacom WebSocket client, typed data, existing config compatibility, private persistence, HTTP media, one-shot commands including login/token/rooms/agents/history/send/say/read/wait/seen/tail.
2. **Managed-agent safety:** hub executor/observer registration, run stamping, unknown state, behavioral regressions for ownership and observer disconnect semantics.
3. **Herdr bridge:** real launch/bind/attach; detached singleton with local control; per-agent event reconciliation and queue; read/control handling; persistent delivery journal and recovery actions.
4. **MCP:** initialized stdio JSON-RPC, tool listing/calls, cancellation/concurrent waits, observer reconnect, real room/agent operations and attachment localization.
5. **TUI:** tnotes-inspired room/agent sidebar, real transcript and events, Unicode multiline composer, command palette/help, keyboard/mouse/resize, room switching with preserved drafts, screen details, explicit native terminal handoff, launch/bind and attachments.
6. **Verification and delivery:** build/test once after slice integration; actual CLI against isolated hub; actual herdr socket/bridge interaction; actual MCP SDK client; PTY-driven TUI input/mouse/resize/cleanup; document commands, security and exercised limits.

## Acceptance scenarios

- `banda` opens a live hub-backed room UI; no fixture data is used by the application.
- A message sent in Rust appears in existing clients/history, and incoming events do not destroy the composer draft.
- Sidebar selection, room activation and input focus remain distinct. Unicode edits and narrow layout work; exiting restores the terminal.
- Native herdr attach relinquishes UI input/mouse ownership and restores the room view on return.
- An explicitly bound live agent receives ready-state messages; blocked/unknown/replaced processes never receive automatic prompts.
- Closing the viewer leaves the bridge and agent alive. Bridge restart restores bindings without blindly resending uncertain input.
- A second executor is rejected; MCP observers cannot change execution state or keep the executor falsely online.
- Attachment URLs remain scoped to the configured hub. Tokens are not logged or passed as owner credentials to agents.
- The original Node hub/client contracts continue working for unmanaged identities.

## Verification record

Implemented as the alternative `banda` binary; existing `cli/`, `metacom`, and `mc` remain in place.
The disposable verification services, terminal fixtures, credentials and state were removed after the checks.

### Automated checks

- `cargo test --workspace`: **17 passed**.
- `cargo build --workspace`: successful, no compiler warnings in the final build.
- Hub `npm test`: **28 passed**, including managed executor exclusivity, observer authority, offline presence, persisted run identities, unknown readiness, and unmanaged-client compatibility.
- `rust-analyzer` is installed, configured in `.omp/lsp.json`, and answered live semantic requests. No reinstall was needed.

### Executed integration scenarios

All runtime checks used a disposable localhost hub, private config/state directories, and a separate herdr socket. No production hub, user agent session, or user credential was changed.

- **Real CLI and hub:** token-stdin login and 0600 configuration; Unicode room messages and history; live Rust `tail` received a message sent by the original Node `metacom` CLI; `@auto`/CLI automatic dispatch does not silently turn an informational note into a command.
- **Real herdr 0.9.1 / protocol 22:** dedicated agent launch, native process identification, detached bridge, owner message → native PTY input → working/waiting turn observation, passive screen read, upload/download of an attachment and its local path in the prompt.
- **Persistence:** stopping the bridge preserved the native agent PID; a message sent after the hub observed the executor offline was queued and delivered after bridge restart. Previously acknowledged prompts appeared only once in the native input log.
- **Ownership and identity:** a changed daemon credential was rejected before registering or launching another agent; an externally bound pane rejected `!stop`; terminating its foreground fixture caused `unknown`, and a later queued message never reached the replacement shell. Stopping an owned agent removed only its dedicated terminal and binding.
- **Blocked and uncertain input:** a native blocked state refused commands and retained informational context without typing it. After native idle, the context reached the PTY. Deliberately withholding a subsequent working-state transition made herdr report a stalled prompt: Banda retained an honest `uncertain` journal entry, did not replay it after restart, and accepted explicit operator discard.
- **Journal saturation:** an injected interrupted intent plus 2047 unresolved records did not cause the actor to reconnect-loop. The interrupted entry became `uncertain`; a new delivery stayed pending at the hub. Operator discard was acknowledged, periodic reconciliation recovered the deferred message into the freed slot, and it executed after the verification-only unresolved records were removed.
- **MCP through the installed JavaScript SDK:** initialization, all six tools, room read/post/send, incoming room wait, simultaneous requests, cancellation, offline-agent wait, and a nullable timeout response while an agent remained unknown. A still-connected MCP observer did not keep a stopped bridge's executor falsely online.
- **Actual TUI through a controlling PTY:** observed 110×34 and 60×22 layouts; multiline Unicode paste round-tripped exactly; incoming messages preserved an unfinished draft; mouse room switching restored independent drafts; F1 help and Ctrl+P picker rendered. Native attach showed the real herdr terminal, accepted manual input, and returned with Ctrl+B then `q`; foreground process-group ownership returned to Banda. Ctrl+Q restored canonical mode, echo and the normal terminal screen without stopping the runtime.

### Limits

- Native lifecycle/input checks used a disposable executable recognized by herdr as `claude`, with explicit fixture output and no model calls. They prove real hub/socket/PTY/MCP transport behavior, **not** authenticated Claude/Codex provider behavior. No fake executable, fixture data, or fallback runtime is included in Banda.
- Linux was exercised. The macOS process-start identity branch was not.
- Herdr does not offer atomic compare-and-submit: checking the process immediately before input reduces but cannot eliminate the final native race. Refuse unknown/replaced identity; do not promise exactly-once delivery.
- The hub caps inboxes and history catch-up at 500 records. Local journal backpressure does not turn that bounded upstream storage into a lossless queue.
- Rooms are coordination scopes, not tenant isolation; herdr does not sandbox processes. Owner credentials are excluded from generated agent/MCP environment overrides, but agents retain the filesystem privileges of their OS user.
