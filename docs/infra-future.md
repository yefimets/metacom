# metavm, globalstorage, and an infrastructure for agents a year from now

Research note, 30 September 2026, for misha. The question: can two Metarhia projects,
[metavm](https://github.com/metarhia/metavm) and [globalstorage](https://github.com/metarhia/globalstorage),
be the base of an agent infrastructure built for where the market will be in a year, not for
what metacom is today. Three research passes: the two repositories read in full (and metavm
tested), agent isolation on the market, and agent state, data and coordination on the market.

## The answer first

- **metavm is a script loader, not a sandbox.** It is a good way to load *our own* code in
  isolated contexts (what the Impress server does with it). It is not a boundary for agents,
  tenants or untrusted code: code in its default context reached the host's `process` in our
  test, and Node itself says `node:vm` is "not a security mechanism". The market isolates agents
  with microVMs (Firecracker, Kata) or gVisor, and plug-ins with WebAssembly.
- **globalstorage has the right ideas and early code.** Schema-driven domains, local-first
  sync, CRDTs, compare-and-swap and a hash chain for integrity are exactly where agent data is
  going. But the rewrite is a prototype: records are JSON files, sync over metacom is a `TODO`,
  schema validation is not wired in, no queries, no transactions across records.
- **So: take the concepts, not the code — yet.** Build the infrastructure on the pattern the
  market is converging on (an append-only log per room, a small database per tenant or agent,
  clients as local-first replicas, agents as peers, one microVM per agent), express it in
  Metarhia terms (metaschema for the event types, metacom as the sync transport), and keep
  globalstorage as the place to contribute that work back once it holds up in production.

## What the two projects really are

| | metavm 1.4.5 | globalstorage (rewrite, unpublished 1.0) |
| --- | --- | --- |
| What it is | "Script loader with isolated sandboxes for node.js": 231 lines over `node:vm` | "Distributed Data Sync Engine": a modular distributed database, local-first, CRDTs, blockchain integrity, smart contracts (README) |
| Works today | `createScript` / `readScript`, contexts (empty, common, node), `require` through an allow-list, 1 s timeout on the first run, no string eval in empty contexts | JSON-file storage with a cache, records with change events and deltas, CAS `swap`, a hash chain, contracts rebuilt with `new Function` (not sandboxed), a 103-line CRDT (union of arrays, numbers add) |
| Not there | memory limits, CPU limits after the first run, protection from host-object escapes and prototype pollution through shared host objects | sync (`// TODO: Implement metacom-based sync`), metaschema validation, sharding, queries, multi-record transactions, IndexedDB |
| Used by | Impress: every api/lib/domain file is loaded through it, for the app's *own* code | nothing in production found |
| Health | one maintainer (155 of ~160 commits), last commit Aug 2026, ~1,450 downloads a week | last commit Apr 2026, README ahead of the code, npm still has 0.9.1 from 2019 |

The Metarhia pieces fit each other: **Impress** (application server) loads code with **metavm**,
reloads it with **metawatch**, describes the domain in **metaschema**, and talks **metacom**;
globalstorage means to sync over metacom. The design is coherent; the storage and sync layer is
the part not built.

## Where the market is, and where it goes in a year

**Isolation.** One sandbox per agent is the default, and the sandbox is a microVM (E2B,
Vercel, Fly Sprites, Deno, AWS Lambda MicroVMs, Northflank) or gVisor (Modal, GKE Agent Sandbox).
Snapshots, pause/resume and forking are table stakes (Morph, Daytona, Factory, Replit, Cursor);
long-lived "agent computers" replace throwaway containers. Secrets stay out of the sandbox: a
proxy adds the real credential at the edge (Claude Code's git proxy, Deno placeholders, Codex
removing them before the agent starts). Vendors run the agent loop while the customer runs the
compute (Cursor self-hosted, Devin Outposts). V8 isolates are under fresh scrutiny after a 2026
Spectre leak between Workers; WebAssembly is the choice for tool plug-ins.

**State and data.** Durable state *per agent* (a Durable Object with its own SQLite, Turso's
database per agent, Temporal/Restate journals) and an **append-only, replayable log** as the
medium between agents and people (Electric's Durable Streams, OpenAI conversation objects,
LangGraph checkpoints). Local-first sync is reaching agents: agents join CRDT documents as peers
(Electric with Yjs, Jazz 2). Memory becomes managed files and graphs with scoped sharing
(Anthropic Managed Agents Memory, Zep's temporal graph, Letta).

**Coordination.** MCP's July 2026 spec made the protocol stateless and gateway-friendly (routing
headers, OAuth-aligned auth, extensions); A2A reached 1.0 with signed agent cards; both are now
under the Linux Foundation. Agent identity is becoming workload identity (SPIFFE, OAuth) with
registries (Entra Agent ID, Bedrock AgentCore). Observability converges on OpenTelemetry's GenAI
conventions (still experimental).

## An infrastructure for that market, in Metarhia terms

```
                 clients: terminal · web · phone · other platforms' agents (MCP, A2A)
                          │ local-first replicas of the rooms they are in
                          ▼
 ┌─────────────────────────── control plane: the hub ────────────────────────────┐
 │ identity & roles (owner, admin, member, agent) · rooms & invites · audit      │
 │ metacom (+ MCP server, A2A agent cards) · OpenTelemetry spans                 │
 └───────────────┬───────────────────────────────────────────────┬───────────────┘
                 │                                               │
 ┌──── data plane ──────────────────────┐   ┌──── execution plane ──────────────────┐
 │ per room: append-only event log,     │   │ per agent (or per customer): a        │
 │   offsets, replay (event types in    │   │   microVM / gVisor sandbox, own disk, │
 │   metaschema)                        │   │   snapshots to pause, resume, fork    │
 │ per tenant: SQLite for indexes       │   │ secrets added by an egress proxy,     │
 │   (unread, search, members, colours) │   │   never inside the sandbox            │
 │ sessions → digests → shared memory   │   │ on a laptop: the agent's own OS       │
 │ sync over metacom by offset          │   │   sandbox and a user of its own       │
 └──────────────────────────────────────┘   └───────────────────────────────────────┘
                 extension plane: hub rules and plug-ins —
                 metavm for code the owner wrote, WebAssembly for code from others
```

| Metarhia concept | Market equivalent | Use it for |
| --- | --- | --- |
| metavm contexts | V8 contexts; WebAssembly (Extism, Wasmtime) for untrusted | hub rules and plug-ins *the owner writes* (routing, digests, notifications); never agents or customers' code |
| globalstorage's log, CAS, hash chain | Durable Streams, event sourcing, Temporal journals | the room log as a real event log: offsets, compaction, integrity chain for audit |
| globalstorage's local-first sync over metacom | Zero, Electric, Jazz | clients as replicas: instant room switching, offline, agents as peers |
| globalstorage's CRDT | Yjs, Automerge | shared documents several agents edit (plans, specs); not for messages, which only append |
| metaschema | JSON Schema, protobuf in MCP/A2A | one definition of every event, message and API type, checked on write |
| metacom | MCP transport, A2A | the native wire; MCP and A2A as gateways onto it |

## A roadmap in three stages

1. **Foundations (weeks).** The room log becomes an event log with offsets and a SQLite index
   per hub (fixes today's full-file reads); per-connection presence; room roles and invites with
   the API checked on every call; the hub under its own user or container, tokens out of agents'
   reach. Session collection (the design already sent) writes into the same log shape.
2. **Local-first and execution (a month or two).** Clients sync rooms by offset over metacom;
   hosted agents in one microVM or gVisor sandbox per customer, through a provider (E2B,
   Daytona, Fly Sprites) or self-hosted (Kata/Firecracker via Northflank or the Kubernetes
   agent-sandbox controller); an egress proxy for secrets; snapshots to pause idle agents.
3. **Interop and intelligence (quarter).** The hub as a remote MCP server and each agent with
   an A2A card, so outside agents can join rooms; the team-lead agent on digests and signals;
   OpenTelemetry traces; contribute the log and sync layer back to globalstorage if it proves out.

## Risks

- **Single-maintainer dependencies.** metavm and globalstorage are essentially one person's
  work; building the core on them couples our roadmap to theirs.
- **Betting on a prototype.** globalstorage's README describes a system that is not written;
  treat it as a design to realise, not a library to adopt.
- **A moving target.** MCP changed shape in July 2026; A2A just reached 1.0. Keep them as
  gateways over our own protocol, not the core.
- **Cost of isolation.** A microVM per agent costs real money at scale (roughly $0.05–$0.15 per
  vCPU-hour on the market); per-customer sandboxes and pausing idle agents keep it sane.

## Sources

Repositories: github.com/metarhia/metavm (metavm.js, SECURITY.md), github.com/metarhia/globalstorage
(lib/, README, git log), github.com/metarhia/impress (lib/code.js), nodejs.org/api/vm.html.
Isolation: e2b.dev/pricing, daytona.io/docs, modal.com/docs/guide/sandbox, developers.cloudflare.com
(Containers GA, Apr 2026), vercel.com/docs/sandbox, fly.io (Sprites), cloud.google.com (GKE Agent
Sandbox, May 2026), anthropic.com/engineering/claude-code-sandboxing, developers.openai.com/codex,
cursor.com/docs/cloud-agent, devin.ai (Outposts), blog.cloudflare.com (Spectre, Aug 2026).
State and coordination: electric.ax (Durable Streams, Electric Agents), jazz.tools, turso.tech,
github.com/cloudflare/agents, platform.claude.com (Managed Agents Memory), temporal.io,
blog.modelcontextprotocol.io (2026-07-28 spec), linuxfoundation.org (A2A, AAIF),
opentelemetry.io (GenAI conventions). Several prices come from comparison blogs and should be
checked against vendors' own pages before any decision.
