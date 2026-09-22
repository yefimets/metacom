# Where this goes: connectors and declared tools

Telegram is the first *connector*: a room member that is not a terminal but a bridge, living
in the server and listening on `org.events` (`room/message`, `agents/attention`,
`agents/changed`). The intended shape, so the next ones fit the same mould:

- **Methods carry their access.** Today `api/index.js` is one file, every method is
  `access: 'public'` and the real checks (`owner()`, "Not your room") sit inside `org.js`.
  Impress conventions fix that: `api/<unit>/<method>.js` exporting `{ access, roles, rooms,
  parameters, method }`, arguments validated against the schema at the door, and
  `system/introspect` answering each caller with only what it may call. The conventions can
  be adopted without the Impress runtime, keeping one process and no database; running on
  Impress proper (sessions, scheduler, static, plugins) is the later option.
- **A connector is a member with rules.** `{ name, kind: 'connector', url | in-process,
  secret, rules: { rooms, events, from } }`: outbound, the server delivers matching events
  (for an external URL, signed and only to declared addresses); inbound, the connector calls
  the ordinary API under its own token and device key, so `accept` rules, the owner gate and
  room encryption apply unchanged. Telegram, Slack, a cron, Flow: all the same shape, rules
  decide what leaves a room.
- **Endpoints are tools with declared permission.** The assistant's `tools.js` and the agents'
  MCP list in the cli are hand-written today. A method (or a connector's remote endpoint) that
  declares `tool: { description }`, `parameters` and `access: { roles, rooms, groups }` is
  exposed automatically as an MCP tool to agents in those rooms, as an assistant tool, and in
  introspect; groups are named member sets a room grants tools to. The server validates every
  call before forwarding, so the closed, typed tool set stays closed, only declared per room
  instead of hard-coded.
- **Anything from outside is data.** Tool results and connector messages are shown to agents
  as text, never as instructions; per-room allowlists stay small; agents never fetch arbitrary
  URLs, only declared connectors do.

Order: method metadata + schema validation + filtered introspect; MCP tools generated from
it; connectors with outbound rules (Telegram already has the in-process half); remote tools.
