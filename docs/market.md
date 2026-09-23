# Who this is for: the pains worth solving, and how we reach them

Research, September 2026. What people building with coding agents complain about, which of
those complaints metacom is actually positioned to answer, and the go-to-market that follows
from it. Sources at the end; every number below is quoted from one of them.

## What we have to sell

Not opinions — the parts that already work, because positioning has to stand on them:

- **A wrapper around any terminal program.** A pseudo-terminal plus a headless xterm, so the
  room sees the real screen: `working`, `waiting`, `blocked` (a permission dialog, with the
  question), `stopped`. Not a harness plugin, not an API integration: `claude`, `codex`,
  `opencode`, `aider`, a build script — anything with a terminal.
- **Two-way.** Instructions are typed into the agent when it is safe to (`waiting`, never into
  a dialog), plus `!cancel`, `!keys`, `!stop`.
- **Machine-independent.** The agent runs where the code is — laptop, VPS, three VPSes — and
  the room is a single Node process with no database that you can host yourself.
- **Agents talk to each other.** Named members with inboxes that survive restarts, directed
  messages, and the room as MCP tools (`mc_agents`, `mc_read`, `mc_say`, `mc_send`, `mc_wait`)
  for the three harnesses that take MCP, so an agent can ask another one and wait for it.
- **Rooms are encrypted end to end.** P-256 ECDH per device, AES-256-GCM per message, the
  server holds no room key unless the owner deliberately grants it one.
- **Two front ends.** A terminal chat and a web client, over the same protocol.

## The pains, ranked

Ranked by how much each one hurts, how badly it is served today, and how much of the answer
we already have. The first four are worth building the company on; the rest are real but not
ours.

### 1. Nobody knows which agent needs them, right now

The measured complaint of 2026 is not that agents write bad code, it is the cost of watching
them. 66% of developers name "AI solutions that are almost right, but not quite" as their top
frustration, 45% say debugging AI-generated code takes *longer* than writing it, and trust in
the output fell from 40% to 29% in a year (Stack Overflow, 2025 → 2026). Trust falling while
adoption rises means more supervision per unit of work, not less. Practitioners say it
plainly: *"the bottleneck became me"*, and *"visibility across machines without drowning in
it — is the real frontier"*. The orchestration write-ups of this year agree from the other
side: context-switching between agents is the new bottleneck, agents replan because nobody
owns the task, and what people ask for is "dashboards, diff review, merge control".

The shape of the pain: three to six agents, each of which is silent for ten minutes and then
needs a one-word answer, and the human polls them in a loop. Polling is the tax. Every
minute an agent sits on a permission dialog is a minute of wall clock thrown away, and every
check on an agent that did not need checking is a context switch.

**Ours already.** `blocked` with the question on it is the single highest-value signal we
produce, and we produce it for any harness, by reading the screen, without a vendor API.
**Missing:** it has to reach a human who is not looking at the room — push, phone, a digest
that says *these two need you, the other four are fine*, and an explicit "I've seen it".

### 2. The agents are on machines; the human is not at those machines

The category grew up Mac-local and solo: a survey of the 2026 orchestrators finds "most tools
remain Mac-local and solo-developer oriented", only two of them execute on a remote machine,
exactly one has a native phone app, and the best-known GUI (Conductor) is macOS-only and
closed source. Meanwhile the work moved: agents run for hours, on VPSes, in containers, on
someone else's GPU box — and the person supervising them is on a phone, on a train, on a
different laptop.

**Ours already.** The wrapper is a terminal program: it runs over ssh, inside tmux, on a VPS
next to the repo, and reports to a room that can live anywhere. Nothing about us is
macOS-shaped. **Missing:** the phone experience has to be as good as the terminal one — the
web client exists but is not yet a thing you would choose over Omnara on an iPhone.

### 3. One human, several vendors — and every orchestrator is single-vendor

Teams do not standardise on one agent. The pattern people write up this year is Claude Code
*and* Codex *and* Copilot in parallel, chosen per task. The orchestrators, dashboards and
"agent control planes" are each built around one harness's API or one GUI, and each new
harness is a rewrite.

**Ours already.** We wrap the terminal, so vendor support is a question of *does it print to
a screen* — yes, always. The three MCP-capable harnesses additionally get the room's tools
without touching anyone's config file (the merge happens in the child's environment). This is
the most defensible thing we have, and the least obvious from the outside: it needs to be on
the front page, not in the README's third table.

### 4. The code, and everything the agent said about it, leaves through someone's SaaS

88% of agent pilots never reach production, and the reported blocker is rarely the agent: it
is isolation, governance, audit and data residency. Of the phone-relay tools, Happy Coder
advertises end-to-end encryption and self-hosting; Omnara stores the stream server-side in
plaintext and says so — *"We don't have true E2EE yet"*. For a regulated team, the relay that
carries an agent's screen carries source code, secrets in tracebacks and customer data in
test fixtures, and the EU AI Act's 2026 obligations put documentation and audit-trail duties
on whoever deploys the result.

**Ours already.** Per-device keys, per-room keys, server blind by default, self-host as the
normal case rather than the enterprise upsell. **Missing:** the boring proof — an audit log
of who sent what to which agent, key rotation and revocation a non-cryptographer can operate
(`rooms revoke` exists; the story around it does not), and one written page a security
reviewer can read.

### 5. Handoffs between agents lose the thread

Reported everywhere in the orchestration literature: context is lost at every transfer,
nobody owns the task, agents replan. We have the *plumbing* for this — named members,
persistent inboxes, directed messages, `mc_wait_agent` — but plumbing is not ownership. This
is where a task object with a state and an owner would belong, and it is the first thing to
build *after* the attention problem is solved. Not the wedge: the field is crowded with task
boards (and Vibe Kanban's company shut down in April 2026, which says something about
task-board-first as a business).

### 6. Cost is unpredictable

Per-seat plus token spend lands teams at $200–600/month, and the unpredictability itself is
named as a buying barrier. Not a pain we solve, but it dictates *our* pricing: flat, per
member, no metered surprise. We are the cheap layer on top of the expensive one.

### What we should not chase

Sandboxing and VM isolation (Northflank, Coder and the cloud vendors own it), code review
quality, model routing, and being another kanban board. Each is someone else's fight, and
none of them is improved by the thing we are good at.

## Who buys it

- **A. The agent orchestrator (individual).** Runs three or more agents across a laptop and a
  server, already lives in a terminal, already built half of this with tmux and ssh. Feels
  pains 1–3 daily. Pays little or nothing, but decides everything: this is the distribution
  channel, not the revenue.
- **B. The small team running agents on shared machines (3–15 people).** Agents on a shared
  VPS or one per engineer, humans who need to see each other's, a lead who wants to know what
  is stuck. Feels 1–3 plus the beginning of 4. **This is the wedge that pays** — a flat
  per-member price, bought with a card, no procurement.
- **C. The team that cannot use a SaaS relay.** Regulated, air-gapped, or simply
  code-protective. Feels 4 hardest and will tolerate rough edges for self-hosting and real
  encryption. Slower, larger, and the reason the crypto work already done is an asset rather
  than a detour.

Sell to B, be adopted by A, let C arrive through the self-host page.

## Positioning

> **metacom is the room your coding agents live in.** Any harness, any machine, one place
> that tells you which one needs you — and it is yours: self-hosted, end-to-end encrypted.

Against what people will compare us to:

| They ask | The answer |
| --- | --- |
| Conductor, Vibe Kanban, the Mac GUIs | Ours runs where the agent runs, including a VPS, and it is not one vendor's harness |
| Omnara, Happy Coder (phone relays) | Those relay *your* Claude to *your* phone; we are a room where several people and several agents meet — and we are blind by default |
| Slack + a bot | A bot can post; it cannot see a permission dialog or type into one |
| "I have tmux and ssh" | That is exactly the thing we replaced — and it does not tell you which pane is blocked |
| Anthropic / OpenAI shipping this | They will ship it for their own agent. The bet is that nobody runs one vendor's agents only |

## What to build before selling it (next 90 days)

1. **Attention that leaves the room.** Push to phone and desktop for `blocked` and for
   "finished what you asked", a digest that ranks by who has been waiting longest, and seen-state
   that clears across devices. This is pain 1 and it is 80% of the perceived value.
2. **The phone client at parity.** The web client, installable, with the room feed, the
   attention list and a text box that can answer a dialog.
3. **Five-minute onboarding.** One command that installs, logs in, creates the first room and
   wraps the agent already running in the next pane; `metacom doctor` for when it is not.
4. **The security page.** How the keys work, what the server sees, how to revoke a laptop,
   where the audit log is — written for someone else's security reviewer.
5. **Proof in public.** A room of real agents, shown working, in a recording that does not cut.

## Go to market

**Motion: developer-led, open source, bottom-up.** The buyer is the user; the product sells
itself in a terminal or not at all. No sales motion until B-tier teams are renewing.

**Sequence.**

- *Days 0–30, be findable and be correct.* Front page that says the one sentence above.
  Comparison pages against the named alternatives (people search for those names, not for us).
  The install path working on Linux and macOS from a cold machine. A short recording of three
  agents on two machines with one of them blocked and answered from a phone.
- *Days 30–90, land where these people already are.* Show HN (the honest framing: the room, the
  encryption, any-harness wrapping — HN punishes agent-hype and rewards protocol detail).
  r/ClaudeAI, r/LocalLLaMA, the Codex and opencode communities — each with the demo that
  matters to *them*, which for opencode and Codex users is "it works with yours too". The
  awesome-lists and MCP/plugin directories. Write the post the category is missing:
  *running Claude Code and Codex on a VPS and supervising both from a phone* — every existing
  guide stops at the Mac.
- *Days 90–180, turn A into B.* Every individual user has colleagues on the same repo:
  invite flow, a free tier that stops at three members, and the team page that answers the
  lead's question ("what is stuck, and for how long"). Case studies from the first five teams,
  by name, with numbers.

**Channels ranked by expected return:** comparison content against named tools > HN and the
harness subreddits > the post nobody has written (remote + phone + multi-vendor) > directories
and awesome-lists > conference talks (slow, credibility only).

**Pricing** — flat, per member, against anchors of Copilot Business $19/seat, Cursor Teams
$32–40/user and Devin at $80 plus $40/seat:

| Tier | Price | For |
| --- | --- | --- |
| Self-hosted, open source | free, unlimited | A and C; the distribution |
| Hosted, up to 3 members | free | the on-ramp out of self-host |
| Hosted team | **$15 / member / month** | B: hosting, push, history, backups |
| Team + governance | **$35 / member / month** | SSO, audit log, retention policy, support |
| Enterprise self-host | annual licence + support | C, when it asks |

Agents are not seats. Charging per agent punishes the behaviour the product exists to
encourage, and metering tokens re-creates the unpredictability that is already a barrier.

**What would kill this, honestly.** A harness vendor shipping the same room for its own agent
and most people being single-vendor after all; the perception that this is a thin layer over
tmux; encryption UX friction at exactly the moment a new teammate joins; and a one-maintainer
project asking a security reviewer for trust. The first is answered by being the neutral
place, the second by the blocked-detection demo, the third by build order, the fourth by
being open source and self-hostable.

**Measure:** time from install to first wrapped agent (target < 5 min); agents per active
user (the multi-agent thesis is false below 2); median seconds a `blocked` agent waits
(the number the product exists to reduce — publish it); second human joining a room within
14 days (the A→B conversion); self-host to hosted conversion.

**First experiments, each falsifiable in two weeks.** (1) Show HN with the remote/multi-vendor
framing — if remote and any-harness are not the top comments, the positioning is wrong.
(2) The comparison pages — do people searching for the Mac GUIs convert, or bounce on "no GUI"?
(3) Push notifications behind a flag for twenty users — does median blocked-wait actually fall?
(4) Ask the first ten teams to name the pain in their words before pitching; if it is not
"knowing which one needs me", re-rank this document.

## Sources

- [Stack Overflow Developer Survey 2025 — AI section](https://survey.stackoverflow.co/2025/ai) — 66% "almost right", 45% debugging takes longer, trust 40% → 29%
- [The Code Agent Orchestra — Addy Osmani](https://addyosmani.com/blog/code-agent-orchestra/) — what multi-agent coding needs
- [From VS Code to agent orchestrators — Quentin Rousseau](https://blog.quent.in/blog/2026/03/09/from-vs-code-to-agent-orchestrators-how-multi-agent-workflows-changed-everything/) — the orchestrator's day
- [Multi-Agent Orchestration for Developers in 2026 — Scopir](https://scopir.com/posts/multi-agent-orchestration-parallel-coding-2026/) — Claude, Codex and Copilot in parallel
- [Developer Tools Watch: The Developer Becomes the Orchestrator — The CODEW](https://www.thecodew.com/2026/09/developer-watch-september-18-2026-ai-orchestrator-coding-agents.html) — Mac-local and solo-oriented category, remote execution, phone apps
- [Omnara](https://omnara.com/) and [Happy Coder](https://happy.engineering/) — the phone-relay alternatives and their encryption stances
- [Enterprise AI coding agent deployment in 2026 — Northflank](https://northflank.com/blog/enterprise-ai-coding-agent-deployment) — 88% of pilots never reach production; isolation, governance, residency
- [Self-hosting AI agents for regulated enterprises — Baytech](https://www.baytechconsulting.com/blog/keep-code-off-cloud-self-hosted-ai-dev-agents) — why code stays in the VPC
- [When AI agents travel: data residency as an operating problem](https://www.cloudmagazin.com/en/2026/07/16/when-ai-agents-travel-data-residency-as-an-operating-problem) — EU AI Act obligations in 2026
- [AI coding tools pricing compared 2026 — amux](https://amux.io/blog/ai-coding-tools-pricing-2026/) and [AI coding assistant pricing and ROI — DX](https://getdx.com/blog/ai-coding-assistant-pricing/) — seat and token anchors, $200–600/month per team
