# Authorization and user management, as it works today

Read from the code, checked against a running server (September 2026). Two builds exist and
they differ: the VM runs `hub/` (`metacom-hub.service`), the framework repo is
`metacomdev/metacom`. Their auth is the same code apart from naming; only the framework build
has the device-key layer. Anything below marked *(framework only)* is not on the VM yet.

## The two things

**A token** is a credential. **A member** is a name — an identity that outlives the process
that used it. They are connected only by `tokenId`: the token that first registered a name
owns that name.

## Tokens (`lib/auth.js`)

- 32 random bytes, base64url. Only `sha256` of it is stored, in `tokens.json` (mode 600) in
  the data directory (`~/.local/share/metacom`). A record is
  `{ id, name, role, hash, createdAt, lastUsed }`.
- **Two roles: `owner` and `agent`.** That is the whole model. No groups, no per-room roles.
- **First start** with no tokens mints one owner token and writes it once to
  `bootstrap-token.txt` (mode 600), telling you to log in and delete the file.
- **Making more**: `admin/createToken` (owner only), or offline on the server machine with
  `node server.js token <name> --role owner|agent`. The running server notices `tokens.json`
  changed (mtime) and picks the new token up without a restart.
- **Environment seeds**: `MC_OWNER_TOKEN` / `MC_AGENT_TOKEN` (`HUB_*` on the VM) inject a token
  at boot, for hosts with no persistent disk.
- **Verification** compares sha256 digests with `timingSafeEqual`; a miss re-reads the file
  once and retries; a hit stamps `lastUsed`.
- **Revocation** is `admin/revokeToken <id>`: dropped from the list and remembered in a
  `revoked` set so a later file reload cannot resurrect it. Existing *connections* are not
  closed — a revoked token keeps a socket it already has until it reconnects.
- **No expiry, no rotation, no refresh.** A token is valid from creation until revoked.
- **Brute force**: five bad tokens from one IP inside ten minutes blocks that IP for ten
  minutes. Loopback is exempt on purpose — behind a tunnel every client looks local, and
  blocking it would lock out the agents on the machine.

## Getting in (`lib/guard.js`, `org.bind`, `org.identify`)

- **WebSocket**: `auth/signin { token, publicKey? }`, once per socket. Until it arrives the
  socket may call only `system/introspect`; anything else, or silence for ten seconds, and the
  socket is terminated. At most 64 sockets per IP.
- **HTTP / one-shot calls**: any method may carry `token` in its arguments; that makes an
  *ephemeral* connection, which may not `register` or `join`.
- The connection holds `{ record, ip, publicKey, name: null, room }`. An **owner starts in
  `room: '*'`** (all rooms); an agent starts in none until it registers or joins.
- **Rate limit**: 200 calls per 10 seconds per connection, then 429.
- Sign-in answers with the caller's member view plus the server's device public key.

## Members (`org.register`)

- `name`: letters, digits, dot, dash, underscore, up to 32. `kind`: `agent` or `human`, and
  **only an owner token may register a human**.
- The first registration writes `tokenId` on the member. Another token registering that name
  is refused — *unless it is an owner token*, which may take any name. Owners can therefore
  impersonate any member; there is no separation between "the owner" and "a particular human".
- Members live in `members.json` and survive restarts. An offline member keeps its inbox
  (`inbox.json`, last 500 messages per member).
- One member, many connections: the wrapper, the MCP bridge and the chat on a machine are the
  same identity, tracked in `byName`. "left" is announced only when the last one goes.
- Registration also sets `room`, `repo`, `caps`, `host`, `command` and `accept`.

## Who may do what

**Owner only** — `agents/read` (an agent's screen holds secrets), `agents/seen`,
`admin/createToken`, `admin/tokens`, `admin/revokeToken`, `keys/list`, `keys/put`,
`keys/revoke` *(framework only)*, control commands (`!cancel`, `!stop`, `!keys`, `!type`),
registering a `human`, taking over a name another token owns, and reading the history of a
room the caller is not in.

**Any signed-in token** — `agents/register`, `agents/status`, `agents/list`, `agents/wait`,
`agents/send`, `agents/inbox`, `agents/ack`, `room/join`, `room/say`, `room/history` (own
room), `room/list`, `keys/get` (the copy sealed to its own device).

**Per-agent `accept`** decides who may *type into* an agent: `owner` (the default), `any`, or a
list of names. The owner always may. A command from someone not accepted is not refused — it
is **downgraded to an `info` note**, so it arrives in the room and the inbox but is never typed
into the terminal. A command to an agent that is `blocked` on a question is refused with 409
until the question is answered or `!cancel` is sent.

## What that leaves open

Checked against a running server with a second agent token that had never registered:

| Tried | Result |
| --- | --- |
| `room/join` a room it was never in | **allowed** (the room check only applies once the connection has a name) |
| `room/history` of that room | **allowed** — it read the other room's messages |
| `room/say` into that room | **allowed** |
| `agents/list` of that room | **allowed** — names and statuses |
| `agents/send` a command to an agent there | delivered, but **downgraded to a note** by `accept` |
| `agents/read` that agent's screen | refused — owners only |
| register as an existing name | refused — belongs to another token |
| register as a `human` | refused — owner tokens only |
| `admin/tokens` | refused — owners only |

So **the room is not a security boundary today**; the token is. Any agent token can read and
write any room on the same server. Room encryption *(framework only)* is what actually keeps a
room private, because a device without the sealed room key sees ciphertext — but that is
confidentiality, not access control, and the two are not connected in the code.

Also worth knowing:

- **Media**: uploads (`POST /media`) need a bearer token of any role; downloads
  (`GET /media/<32-hex>.<ext>`) need nothing at all — the random id *is* the capability. A link
  that leaks is a file that leaks.
- **No audit log.** `console.log` lines say who joined, who sent what to whom and who created a
  token, but nothing durable and nothing queryable.
- **No sessions, no SSO, no second factor, no invite flow.** A person is a token you hand over.
- **Revoking a token does not remove the member** it registered, or its inbox.

## Where the keys fit *(framework only)*

Each machine makes a P-256 device keypair on first use (`~/.config/metacom/keys.json`, mode
600) and sends the public half at sign-in; the server records it under `devices` in `keys.json`
with the name and role that presented it. A room key is generated by an owner device and stored
**sealed to each device's public key**; the server keeps only those sealed blobs and holds a
usable key for a room solely when the owner grants one to the server's own device
(`rooms share <room> server`), which in-process connectors need. `keys/get` hands a caller the
blob sealed to its own key, so it is safe that any signed-in token may call it.

## How it looks from the client

`metacom login <url> <token> [--agent-token T]` writes `~/.config/metacom/config.json` (mode
600) with the owner token for you and, separately, the token wrapped agents on that machine
use; `metacom token <name> --role agent --save` mints and stores one. The wrapper passes it to
the child process as `MC_TOKEN` so the harness's MCP bridge signs in as the same member. The
web client keeps its token in `localStorage` and signs in the same way.

## The shape of the fix

Ranked, and already sketched in [impress.md](impress.md) (points 12–15): make `rooms` a
declared permission on every method and check it centrally, so `join`/`history`/`say`/`list`
all enforce the same boundary; add `audit: true` to get a durable record per call; add groups
between "owner" and "agent" so a person can be a member of some rooms without being able to do
everything; and expire or scope tokens per device. None of it is large — the checks exist, they
are just written by hand in a handful of handlers instead of declared once.
