# Impress, read properly, and what of it belongs in metacom

Research notes from reading [impress](https://github.com/metarhia/impress) 3.1.2 (`lib/`, 1708
lines) and the reference application [metarhia/Example](https://github.com/metarhia/example)
3.1.0, September 2026. Then: what to take, what to leave, and what we can build on top that
Impress does not have. This replaces the sketch in [direction.md](direction.md) with the
detail needed to actually do it.

## What Impress is

An application server for Node: a supervisor process that starts a balancer thread, N server
threads and a pool of worker threads, loads an `application/` directory into a v8 sandbox
built with metavm, and serves it over [metacom](https://github.com/metarhia/metacom) — the
same RPC protocol we already run on. Dependencies are metarhia's own only (metavm, metaschema,
metawatch, metaconfiguration, metalog, metautil, metacom); the whole stack is around 2 MB.

The parts that matter to us, each verified in the source:

**Endpoints are files.** `application/api/<unit>[.<version>]/<method>.js`, auto-routed, no
route table. The file evaluates to an object (or a bare async function) and
`lib/procedure.js` reads from it: `access`, `parameters`, `returns`, `errors`, `validate`,
`timeout`, `queue`, `caption`, `description`, `deprecated`, `protocols`, `serialize`,
`assert`, `examples`. On every call it checks arguments against the `parameters` schema, runs
`validate`, applies the timeout, checks the result against `returns`, and maps a returned
`DomainError('EARGA')` to the message declared in `errors`. A method can carry its own
semaphore (`queue: { concurrency, size, timeout }`) on top of the application-wide one.

```js
// application/api/example/add.js — the whole contract is the file
({
  access: 'public',
  parameters: { a: 'number', b: 'number' },
  method: async ({ a, b }) => (a < 0 ? new DomainError('EARGA') : a + b),
  returns: 'number',
  errors: { EARGA: 'Invalid argument: "a" expected to be > 0' },
});
```

**Access control is thinner than it looks.** metacom's server enforces exactly one rule —
`if (!client.session && proc.access !== 'public') return client.error(403)`
(`metacom/lib/server.js:242`). Roles, rooms and ownership are the application's business.
Our `org.owner(conn)` checks do not go away by adopting Impress; they get a declarative place
to live, which is the point.

**Versioning and introspection.** `api/geo.1.js`, `api/example.1/…`: the unit name carries a
version, the highest loaded version is the default, `'*'` resolves to it, and
`application.introspect(units)` returns the method signatures per unit — which is how a
metacom client builds `metacom.api.example.add(…)` at run time. A unit file can also be a
*plugin*: `{ plugin: 'metasql/crud', database: db.pg, entities: { City: ['create','get',…] } }`
generates the CRUD methods from the schema.

**Layers, as directories in the sandbox.** `api/` endpoints, `domain/` business logic with
`start`/`stop` hooks, `lib/` helpers, `db/` data access, `bus/` external services, `schemas/`
metaschema models, `static/` and `resources/` served with caching, `cert/`, `config/`.
Application code has no `require`: the sandbox provides `node`, `npm`, `metarhia`, plus
`api`, `lib`, `db`, `bus`, `domain`, `schemas`, `config`, `console`, `application`.

**External APIs are declared, not coded.** `bus/<service>/.service.js` gives a URL and rate
limits, and each method file declares its HTTP shape and its types:

```js
// application/bus/worldTime/currentTime.js
({ parameters: { area: 'string', location: 'string' },
   method: { get: 'timezone', path: ['area', 'location'] },
   returns: { timezone: 'string', unixtime: 'number', /* … */ } });
```

`lib/bus.js` turns that into a validated call — arguments checked, URL built, response checked
against `returns`.

**Scheduled work survives restarts.** `lib/planner.js` keeps each task as a JSON file
(`<date>-id-<n>.json`) under the task directory, parses `every` (`parseEvery`), restores and
restarts everything on boot, and `scheduler.add({ name, every, args, run })` from application
code posts it to the supervisor over a MessagePort.

**Live reload and graceful stop.** metawatch watches `application/`; a changed file is
recompiled into the sandbox in place (`Api.change`, `Code.change`), a deleted one is removed
from the tree, and `stop` hooks run on shutdown. No restart, no dropped connections — which
for us means no dropped agents.

**Threads.** A balancer on one port, server threads on `ports: [8001, 8002]`, and a worker
pool (`workers.pool`) reachable with `application.invoke({ method, args, exclusive })`.
Singletons guard themselves with `if (application.worker.id !== 'W1') return`. State is
per-thread; sharing it is the application's problem (their TODO list still has "state
synchronisation" and "multi-tenancy" on it).

**Sessions and auth.** `config/sessions.js` (token characters, length, expiry, per-ip and
per-user limits), `context.client.startSession(token, data)`, and an `api/auth/provider.js`
the application supplies — in memory by default (`lib/auth.js`), Postgres in the example.

**Tests.** `application/domain/**/*.test.js` exporting `{ name, run(t) }`, run with the
node test runner at startup under `MODE=test`, including a case that opens a real metacom
client against the running server.

**Streams.** File upload is a stream id: `context.client.getStream(streamId).pipe(writable)`,
and `lib/storage.js` stores under hashed directories with md5 and size.

## What our org already is

`server.js` (95 lines) builds `Auth`, `Org` and a context whose `getMethod` looks methods up
in one object literal, `api/index.js` (111 lines), where every method is `access: 'public'`
and the real checks — `org.identify(context, args)`, `org.owner(conn)`, "not your room" — sit
inside the 448-line `lib/org.js`. Room encryption, media over HTTP, the web client and the
socket guard hang off the same `http.Server`. It works, and it is one process with no
database. The Impress-shaped question is not "should we depend on Impress" but "which of
these conventions buy us something".

## What to take, in order

### 1. Methods as files with declared metadata (no new dependency)

One file per method, `api/<unit>/<method>.js`, exporting the same shape Impress reads. Our
loader replaces `lib/context.js`'s `getMethod` and stays about eighty lines. What it buys
immediately, before anything else on this list: the gate stops being handwritten in every
body.

```js
// api/room/say.js
({
  access: 'member',                       // public | member | owner
  rooms: 'argument',                      // the room in args is the one checked
  parameters: { room: 'string', text: 'string', media: '?array' },
  audit: true,
  method: async ({ room, text, media }) => org.say(context.conn, room, text, media),
});
```

`access`, `rooms` and `roles` are checked by the loader before the handler runs; `context.conn`
is what `org.identify()` returns today. `parameters` are validated at the door (metaschema, or
a fifty-line checker if we would rather stay dependency-free for now).

### 2. Introspect that answers per caller

Impress's `introspect` returns every signature to everyone. Ours should return only what this
caller may call, in this room, with this role — so the cli and the web client can build their
command lists from the server instead of hard-coding them, and an agent's tool list is the
truth about its permissions rather than a parallel copy of it.

### 3. MCP tools generated from the same metadata

This is the one that changes the product. A method that additionally declares

```js
tool: { name: 'say', description: 'Post a message to the room' },
```

is offered to agents in the rooms its `rooms`/`roles` allow, with `parameters` as the tool's
JSON schema. The cli's hand-written tool list (`mc_agents`, `mc_read`, `mc_say`, `mc_send`,
`mc_wait`, `mc_wait_agent`) becomes a projection of the API, and a self-hosted org that adds
`api/deploy/rollback.js` with a `tool:` block gives its agents a `rollback` tool in the rooms
it names — no cli release, no config file. The server validates every call against the same
schema, so the tool surface stays closed and typed.

### 4. Live reload

metawatch over `api/`, recompiling a method in place. An org restart today disconnects every
wrapped agent and every chat; adding a method should not do that.

### 5. A scheduler, with our own twist

Planner's persistence model (a JSON file per task, restored at boot) is worth copying almost
verbatim, and the twist is what it schedules: *an instruction to an agent*. "Every weekday at
09:00, tell Alex to pull and run the suite." The agent may be offline, which we already handle
— the inbox keeps it until the wrapper comes back. Nobody in the category has this; it is the
difference between a room and an operations rota.

### 6. Bus units as room tools

`bus/<service>/.service.js` plus method files is exactly the "external endpoints as declared
tools" idea from direction.md, with a working implementation to copy. Declare Linear, GitHub
or an internal service once, with rate limits and typed arguments, and grant it to a room:
agents get a tool that the server calls on their behalf. No agent ever fetches an arbitrary
URL, which is also the security answer.

### 7. Per-method queue and timeout

`agents/read` and media upload should carry their own concurrency limits. Today a burst of
reads competes with everything else in one process.

## What to add that Impress does not have

- **Room-scoped permission as a first-class field.** Impress has `access` and leaves roles to
  you. Ours is `{ access, roles, rooms, accepts }` where `rooms` can be `'argument'`, a list,
  or `'granted'` (the member's rooms), enforced centrally and reported by introspect. This is
  the primitive the whole product needs and the framework does not provide.
- **Encryption-aware methods.** A method marks the fields that are ciphertext
  (`opaque: ['text', 'media']`), and the loader guarantees the server never validates, logs or
  indexes them. Impress assumes it can read every argument; we assume the opposite, and the
  declaration is what keeps a careless method from breaking the guarantee.
- **An audit record per call, from the metadata.** `audit: true` gives who, which method, which
  room, when, and the argument digest (never the plaintext) — the log a security reviewer asks
  for, produced by the loader rather than by remembering to write it.
- **Connectors as sandboxed members.** direction.md's connector — a member with rules that
  bridges a chat group, a cron or a webhook — becomes a small script the owner drops in, run in
  a metavm context inside a pool thread, with `application.invoke` semantics: a connector bug
  cannot take the room down, and its rules (`rooms`, `events`, `from`) say what may leave a
  room. Impress gives the isolation machinery; the rules are ours.
- **Tools with an approval gate.** A tool can declare `confirm: 'owner'`, and the call parks in
  the room as a request the owner answers — the same shape as an agent's permission dialog,
  which we already model. An agent gets `deploy/rollback` *and* a human still says yes.
- **Introspect-driven clients.** Because the cli builds itself from introspect, `metacom call
  <unit>/<method>` works on any org, including one with units we never shipped.

## What not to take

Postgres and `db/` (we have no database and want none), the balancer and multiple server
threads (our state is in memory in one process; two threads would need shared state before it
buys anything — the pool for CPU work and sandboxed connectors is the useful half), the
`static/`-served web client (our `lib/web.js` is smaller than the configuration would be), and
sandboxing our *own* code, which costs `require` and TypeScript for no gain. Sandbox the code
that comes from outside instead.

## The decision

**Adopt the conventions, do not adopt the runtime — yet.** Stages 1–3 above (metadata, filtered
introspect, generated MCP tools) are a few hundred lines in our own process, no new dependency,
and they are what turns the org from a server with an API into a framework. Stage 4–7 (live
reload, scheduler, bus, per-method queues) each stand alone and can be lifted from Impress's
implementation, which is MIT and readable.

Running *on* Impress proper stays open, and gets cheaper after stages 1–3, because by then our
api directory already has Impress's shape. The cost when we do it: our HTTP extras (media
upload, the web client, the socket guard) move to `static`/`resources` and stream methods, our
token auth becomes a session provider, and we pin to one server thread until the org state is
shared. The gain: threads, planner, live reload, schema validation, logging and tests for
free, and the same dialect as the protocol we already speak.

## Sources

- [metarhia/impress](https://github.com/metarhia/impress) 3.1.2 — `lib/api.js`, `lib/procedure.js`, `lib/application.js`, `lib/code.js`, `lib/bus.js`, `lib/planner.js`, `lib/worker.js`, `lib/static.js`, `lib/storage.js`, `lib/auth.js`
- [metarhia/example](https://github.com/metarhia/example) 3.1.0 — `application/api/*`, `application/bus/*`, `application/domain/*`, `application/config/*`, `application/schemas/*`
- [metarhia/metacom](https://github.com/metarhia/metacom) — `lib/server.js` (`access`, streams, RPC dispatch)
- [metarhia/Contracts](https://github.com/metarhia/Contracts) — the specifications behind both
