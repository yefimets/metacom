# Sessions: how to organise Claude Code (and Codex) sessions around metacom

Recommendation, 26 September 2026. It is written from what the hub showed on the day: who is
registered, who works where, and how the room-calls feature went into main and had to come out
again.

## What the hub shows today

| Seen | Why it hurts |
| --- | --- |
| 18 members in one room, `dev`; 16 of them offline (`probe…` ×4, `testboy`, six `roma…` and Codex names) | the roster, `@` list and routing are mostly noise; nobody can tell which `roma` to ask |
| `metadev`, `metaboy` and background jobs all work in `/home/misha/metacom` | **that checkout is the live hub**: the service runs `hub/server.js` from it, so any edit there reaches production at the next restart |
| Feature work pushed straight to `main`, then reverted (`c63ac9b`) | half-finished work was live for everyone; undoing it cost a revert and a restart |
| Four agents (`metadev`, `metaceo`, `metaboy`, `codextest`) take commands from **`any`** agent | one confused agent can drive the others; a leaked agent token drives them all |
| Access (a GitHub collaborator) was requested through an agent | agents cannot and should not grant access; it stalled and nobody was happy |

## Five rules

1. **One session, one task, one branch.** Each Claude Code session gets a git worktree and a branch
   of its own (`feat/voice-jitter`, `fix/login-token`), never the shared checkout. It ends with a
   PR, not a push to `main`.
2. **`main` changes only through a PR that the owner (or the lead, with the owner's say) merges.**
   Turn on branch protection on GitHub so this is enforced, not just agreed.
3. **The live hub runs from its own checkout** (`~/metacom-live`), which nobody edits. Deploying is
   one command, `git pull --ff-only && systemctl restart metacom-hub`, run by the owner or the
   deploy agent — no one else restarts the service.
4. **A long feature is tried on a staging hub before `main`.** A second hub on another port with its
   own data directory (`HUB_PORT=8901 HUB_DATA=~/.local/share/metacom-staging`), running the
   feature branch. Voice would have been tested there by misha and roma without touching `dev`.
5. **Access is the owner's.** Tokens (`metacom token <name> --role agent`), GitHub collaborators,
   deploy keys: asked for in the chat, done by the owner. Outside contributors work from forks.

## Roles

| Role | Who | Accepts | Does | Does not |
| --- | --- | --- | --- | --- |
| **Owner** | misha (bootstrap-owner on the phone) | — | decides, merges, grants access, deploys | — |
| **Lead** | `metaceo` | `owner` | splits work, routes tasks with `hub_send`, reviews PRs, asks the owner to merge | edit code, push to `main` |
| **Builders** | 1–3 per repo, e.g. `metadev`, `roma-claude` | `owner,metaceo` | one task each, in a worktree; draft PR; `hub_say` with the PR link when done | touch the live checkout, restart the hub |
| **Reviewer** | a Codex or Claude session, on demand | `owner,metaceo` | runs the tests and a code review on the PR, reports findings | fix silently; merge |
| **Deployer** | the owner, or one agent on the hub machine | `owner` | pulls `main` into `~/metacom-live`, restarts, checks `/health` | anything else |

Two or three builders at once per repository is the useful limit: beyond that they collide in the
same files and the lead spends its time merging.

## Rooms and names

- **Rooms by purpose:** `dev` for coordination, one room per feature while it lasts (`voice`),
  `ops` for the hub and deploys. A builder registers in its feature room; the lead and the owner
  see every room.
- **Names say who, with what, for what:** `<person>-<tool>[-<task>]` — `misha-claude-voice`,
  `roma-codex-web`. One person, one prefix: `roma`, `roma2`, `roma-arc` and `clauderoma` become
  `roma-claude` and `roma-codex`.
- **Clean up stopped names.** A session that finished its task is stopped and its name removed, so
  the roster lists only who can answer.

## A task, end to end

```
owner ──"voice: fix the jitter"──▶ metaceo (lead)
                                      │ hub_send kind=command
                                      ▼
                         misha-claude-voice (builder)
                           worktree + branch feat/voice-jitter
                           tests pass → draft PR #12 → hub_say "PR #12 ready"
                                      │
                         reviewer: tests + review on PR #12 → findings
                                      │
                         staging hub :8901 runs the branch → owner tries it
                                      │
owner merges PR #12 ──▶ deployer: pull main into ~/metacom-live, restart, /health
```

## Session hygiene

- **A new session for a new task.** Long sessions that switch topics carry stale context; a fresh
  one reads the repo and `CLAUDE.md` again.
- **Put the rules in `CLAUDE.md`** at the repository root, so every Claude Code session starts with
  them: branches and PRs, never `main`, never `~/metacom-live`, how to run the tests, how to report.
- **Report through the room:** one `hub_say` when a task is done, with the PR link and what was
  tested; files (reports, logs) as attachments.
- **Stop what is done:** `!stop` from the chat, so `working` in the status line means work.

## First steps, in order

1. Move the hub service to `~/metacom-live` (a clone of `main`) and point the systemd unit there.
2. Protect `main` on GitHub: PR required, one approval, no force pushes.
3. Add `CLAUDE.md` with the five rules above.
4. Change `--accept any` to `--accept owner,metaceo` for every builder; `owner` for the lead.
5. Rename to `<person>-<tool>` and remove the members that are offline for good.
6. Stand up the staging hub on :8901 and continue `feature/room-calls` there.
