# Changelog

## [Unreleased]

### Board
- **One source of truth (`board.ts`)** — pure `deriveBoard()` feeds both beacon and console, so a worker appears in exactly one section and the two surfaces can't disagree. Tested (`board.test.ts`).
- **NEEDS YOU redesign** — classified by reason (QUESTION / BLOCKED / STALLED / APPROVE) with effort tag (quick win vs. big), age heat, PR chain, and the hotkey to act. A "NEXT UP" hero card shows the single best item; "ALL CLEAR" when empty.
- **Assigned-ticket queue** — the dead `queue.json` is gone. The queue is now your assigned Linear tickets with no worker yet (polled, throttled, `assignedTickets.poll`), sorted by priority then due date, with project, due (overdue flagged) and estimate. In-flight rows carry the same metadata.
- **Stacked PRs** — PR column shows the chain (`#984→985`, `#996 +3`), deduped.
- **AWAITING REVIEW** section for parked workers; today's landed / merged / replies line; one-line beacon with effort breakdown; a 🆕 marker in the beacon (5 min) on *new* needs-you items — no chat-log spam.

### Unified beacon
- The controller writes beacon state to `beacon.json`; reader sessions display the same line. All sessions now show identical data. Each beacon is tagged `🎛 ctrl` or `👁 reader` so you know which terminal is driving.

### Repo slugs in the tables
- PR numbers are per-repo, so `#992` alone was ambiguous across sfs/retail/ui/microservices. NEEDS YOU, AWAITING REVIEW and IN FLIGHT now show a short repo slug beside the PR chain: `SCAAS-11445` / `retail #10781 +3`. `shortRepo()` handles both plain checkouts and worktrees (`BitGo/bitgo-ui-worktree/<name>` → `ui`, not the worktree name).

### Fixed
- **The assigned-ticket queue was frozen for 24h.** Adding `relations { relatedIssue { state } }` to the poll pushed the query past Linear's 10000 complexity budget (measured ~17000 at `first:100`), so `pollAssignedTickets` failed every tick and `assigned.json` went stale — silently, because the failure was swallowed. Now pages at `first:50` with a fallback that re-queries without relations, so a schema or complexity problem degrades the queue instead of freezing it (and marks nothing launchable on partial data).

### Deterministic branch names
- **The rename path is deleted, not just avoided.** `BRANCH_RENAME` is gone from the verdict union, from the render prompt's shape list, and from every module that produces text sent to the agent. Two structural tests lock it: no module may contain a rename instruction, and an off-convention branch must resolve to `ASK` (never `BRANCH_RENAME`). Removing the constant means a future edit cannot accidentally revive it — the type no longer exists.
- **CC now hands the agent the exact branch name** instead of a `<owner>/<TICKET>-<2-3-word-desc>` pattern. Because the pattern was advisory, real branches came out with three different owners (`ananth`, `ananth99`, none), slugs from 2-6 words, and three slice styles (`-0-`, `-a-`, `-pt1`). A pattern isn't enforceable; a value is. `branchNameFor(ticket, title, owner)` slugs the ticket title.
- **Owner is pinned by config**, not guessed: `agent.branchOwner` in `config.json` (falling back to `CC_BRANCH_OWNER`, then `gh api user`). Slice suffixes are specified too: `-2`, `-3`, … on the same name.
- Slug rules: title prefix stripped (`WP:`/`Retail:`/`qa-automation:`), `&` collapsed (`T&C` → `tc`), stopwords dropped, up to 4 words. 3 tests.

### Never rename branches
- **`BRANCH_RENAME` is gone.** The verdict now escalates to the human (`ASK`, latching `do_not_rename`) instead of telling the agent to rename. Renaming is cosmetic; the agent's implementation pushes a new branch and deletes the old one, which **closes the pull request** (upstream #892/#3315/#903). That cost us SCAAS-11150 and orphaned the 11714/11715/11716 stacks — including renaming `ananth99/SCAAS-11715-*` to `ananth99/SCAAS-11716-*`.
- **The delegation instruction now carries a real owner.** It used to emit a bare `<owner>/<TICKET>-<desc>` placeholder while the conformance check demanded one exact string, so every branch the agent named was judged wrong. `resolveBranchOwner()` (CC_BRANCH_OWNER → `gh api user`) fills it in, and the template now says not to rename a branch that already contains the ticket.

### Agent asks are elicitations
- **CC was blind to every question the agent asked.** The agent asks humans via `AgentActivityElicitationContent`; the reader only fetched `AgentActivityResponseContent` *and* filtered out any activity with a `sourceComment.user` (elicitations are authored by the agent), so it always returned null and auto-answer silently never fired (0 events; SCAAS-11713-716 sat STALLED for ~50 min each). Now fetches and accepts elicitations, with a deeper activity window (60 — the ask is buried behind dozens of thoughts).
- **Impossibility is recognised, not auto-answered.** Elicitations that say "I cannot…", "unable to", "blocker", "closed with a deleted head branch", "has diverged" classify as escalate → the human sees the real blocker.
- **NEEDS YOU shows the agent's own words.** BLOCKED/STALLED rows now render the elicitation text (`agent asked: …`) instead of "waiting on your reply to the agent".

### Branch conformance
- **Every worker was being flagged as a badly-named branch.** `branchConforming` interpolated `CC_BRANCH_OWNER ?? "owner"`; with the variable unset *or empty* the pattern became `^/SCAAS-...`, which no branch matches. Result: each worker took a `BRANCH_RENAME` it could never satisfy, burned 2 attempts, then escalated to a repeating `ASK` (SCAAS-11712: 10 ASK renders in 2h). The owner segment is now accepted by default (`[^/]+`); set `CC_BRANCH_OWNER` to pin a specific owner. 3 regression tests.
- **Unguarded terminal verdicts.** The `rename-exhausted → ASK` return was not wrapped in `guarded()`, so it re-spawned a render worker every tick. Now guarded.

### Reroll guard
- **Blind-and-immortal workers are now impossible.** If every PR a worker tracks is CLOSED (not merged), CC re-discovers the ticket's current open PRs and repoints the worker (event `prs_rerolled`). Previously discovery ran once, so a closed-and-rerolled stack (SCAAS-11445: #10208-210 closed → rerolled #10778-781) left the worker pointing at dead PRs forever — it could never land and never retire. Throttled to one `gh` sweep per worker per 5 minutes.

### Auto-answer
- **`auto-answer.ts`**: when the agent is `awaitingInput`, CC reads the actual question from the Linear session, classifies it (repo/branch/process questions → auto-answer; credentials/design/approval → escalate), and spawns a render worker to reply. The human only sees QUESTION items CC genuinely can't handle.
- NEEDS YOU table now shows the agent's actual question preview instead of the generic "ralph asked you something" text.
- Question dedup: CC won't re-attempt the same question twice.

### Auto-launch
- **`autoLaunchWorkers`** tick job: when `assignedTickets.autoLaunch: true`, CC automatically spawns workers for assigned tickets that are launchable (all blockers Done, state is Todo or In Progress). One launch per tick, 2-minute cooldown, up to `maxConcurrent` (default 5) active workers.
- **Dependency-aware queue**: the Linear query now fetches `blockedBy` relations. Blocked tickets show `⏸ blocked by SCAAS-XXXX` in the queue; launchable ones show `ready`. Only launchable, untracked tickets are auto-launched.
- **Config**: `assignedTickets: { poll: true, autoLaunch: false, maxConcurrent: 5 }` — off by default.

### Fixed
- Loop guard escalated to STALLED 10 minutes after a `/fix-ci` even though the platform command was still queued (SCAAS-11190). Within the window the verdict is now WAIT while the agent is active or hasn't started (15 min grace); STALLED only if the agent acted, went idle, and the problem is unchanged — or stayed silent past the grace.
- Colors now come from pi's active theme (`theme.fg` semantic tokens) instead of hardcoded ANSI, so light/dark and custom themes work.
- Console overlay did not scroll (ScrollView had no viewport height) — replaced with explicit scrolling: ↑↓/j/k, PgUp/PgDn/space, g/G, mouse wheel, scrollbar and position in the header.
- Console is wider (98% of terminal), tables use 2-space padding, row separators, and 3–4 column layouts so the text column gets the room. Cells support `\n`.
- Status sanitizer rejected `landing` and demoted landed workers to `working` on every read, flip-flopping with the verdict engine.

## [0.1.0] — 2026-10-02

First properly-versioned release. Everything below shipped over a single working session that grew from "a widget that shows worker status" into a tested supervisor platform.

### Architecture

- **Beacon + console split** — the always-on widget is a single hard-capped line (status light, not a dashboard); the rich scrollable tables live behind `alt+c` in a bordered ScrollView overlay with per-cell word-wrap, flex columns, and box-drawing borders. Nothing long ever renders in a height-capped surface.
- **Modular package** — the 2343-line monolith split into 13 focused files: `index.ts` (wiring, ~230 lines) + `types` / `state` / `spawns` / `prompts` / `cycle` / `ui` / `actions` / `facts` / `verdict` / `render`. Each has a terse header comment explaining its role.
- **Pure verdict engine (`facts.ts` → `verdict.ts`)** — all deterministic state-gathering in one injectable module (REST-verified commit signatures, HITL attribution, thread latches, approval-gate classification); all decision logic as an ordered pure function. 19 regression tests, each named after a real incident that paid for it.
- **Render-only workers (`render.ts`)** — the LLM's job shrank to: compose the message, post it, flush Linear's send queue, classify the agent's reply via a cheap classifier. No gathering, no deciding — those bugs are structurally impossible now.
- **Code-verdicts mode (`config.mode`)** — the tick runs `gatherFacts → decideVerdict` and applies state verdicts (WAIT / LANDING / AUTO_CLOSE / UNPARK / STALLED / FIX_CI) directly with zero LLM spawns; only message-composition verdicts spawn a render worker. Rollback to the legacy self-deciding prompt via one config key.

### Worker transports

- **RPC renders (default)** — render workers are headless `pi --mode rpc` child processes: prompt in, JSONL events out, PID kill on timeout. No PTY anywhere. Kills the entire PTY scar class (1KB input truncation, bootstrap Enter-swallow, zombie reapers, terminal pty pressure).
- **Legacy zmx transport** — launcher-script + PTY session, kept for the prompt-verdicts rollback path. Every battle-scar is documented in `spawns.ts`'s header.

### Hotkeys (the entire interface)

| Key | Action |
|---|---|
| `alt+c` / `alt+n` | open console (full tables, scrollable overlay) |
| `alt+a` | action mode — pick worker → reply / inspect / kill |
| `alt+l` | launch workers (interactive: tickets → repo → agent) |
| `alt+r` | reply to a waiting agent (posts @mention + queue-flush) |
| `alt+i` | inspect a worker's full checkpoint |
| `alt+k` | close/kill a worker |
| `alt+p` | toggle beacon panel |

No slash commands — they echoed into the editor and cost LLM turns.

### The tick's five jobs (all deterministic, no LLM)

1. **`runVerdictCycle`** — facts → verdict → apply state writes directly; spawn renders only when a message is needed. Claims the worker before gathering (closes the concurrent-cycle double-run race).
2. **`probeAgentSessions`** — live agent session status; reconciles stale "needs you"; parks/unparks the landing lane; watches parked workers for new review-thread activity.
3. **`autoCloseMergedWorkers`** — retires on merge; resumes parked workers on review approval.
4. **`maybeReviveForNewPRs`** — a `done` worker whose ticket gained a new PR resurrects, re-anchored and pruned.
5. **`reapStaleRenderSessions`** — watchdog: kills zombie zmx sessions past the timeout. Also reclaims PTYs from *ended* sessions older than 1 hour (the zmx process holds `/dev/ptmx` for scrollback even after the worker inside exits — ~40 orphaned PTYs were found accumulating; the reaper previously skipped them because it read `ended=` as "not a leak".)

### Verdict rules (lessons encoded, ticket IDs scrubbed)

- Signature/attribution outrank review nudges — re-signing rewrites the head, which dismisses approvals.
- Human-approval gates are classified `approval_pending`, never CI-red.
- Impossibility escalation: agent says "I cannot" → `BLOCKED` for the human, no re-nudges.
- Stall detection: 5+ consecutive WAITs → surfaced, not idled.
- Nudge loop guard: same verdict + recent nudge + no state change → escalate, never re-send.
- Landing lane: agent finished + PR open + attributed + clean → parked (no wake-ups); unparks on any change.
- Platform-first review handling: `CHANGES_REQUESTED` + active agent → hands-off WAIT (the agent platform auto-detects request-changes reviews); CC nudges threads only as backstop.
- Inline-reply mandate: thread nudges instruct replies on the thread itself — never top-level digests, never bot-comment acknowledgments.
- Worker budget (`maxRenders`) — cap on render spawns per worker; exhausted → `BLOCKED` + surfaced.

### Integrations & tooling

- **Linear send-queue flush** — every comment post checks the issue's latest agent-session activities and flushes any `queued: true, sentAt: null` entries via `agentActivitySendQueued`, so messages are delivered immediately instead of parked.
- **`cc_status` tool** — structured `outputSchema` + `structuredContent` extension tool; the session model (or any amnesiac future session) reads live worker state without spelunking the source.
- **`+codemode`** enabled — render workers compose + execute in one codemode script turn (post ∥ flush ∥ fetch ∥ classify ∥ write).
- **jev classification for `reply_class`** — calibrated classifier calls (fraction of a cent) replace LLM judgment for agent-reply classification.
- **PR discovery** — workers launched without PR linkage auto-discover the ticket's open PRs via `gh search` on the first cycle; the checkpoint persists the linkage.
- **Read-only `verdict-dryrun.ts`** — `fixtures` view (decision table over the incident corpus) + `live` view (gather → decide against real workers, nothing posted) — the eyeball/pre-flight tool for every change.

### UI details

- OSC-8 hyperlinks: ticket + PR cells are `cmd`-clickable (wrap-after-pad so column alignment survives).
- Emoji-correct width math via pi-tui's `visibleWidth` / `wrapTextWithAnsi` — wide-char alignment drift fixed at the helper level.
- Console uses pi-tui `ScrollView` (scrollbar + mouse-wheel) in a bordered overlay; the legacy pager and hand-rolled scroll code were deleted.
- Every session gets the beacon by default; the mutating tick runs in exactly one session (heartbeat-elected lock with 90s auto-claim).

### Infrastructure

- Generic worker infrastructure beyond Linear supervision — the checkpoint contract + headless transport + reaper is transport-agnostic; it has been used to run headless E2E test suites with structured pass/fail reports as checkpointed workers (no Linear involved).
- Controller lifecycle: heartbeat lock replaces manual takeover; stale locks auto-claimed.
- Config: model tiers (check / takeover / nudge / supervisor), wake-up cadence, render budgets, mode flag — all in `<project>/.pi/command-centre/config.json`.

### Known limitations

- Render workers inherit the user's full GitHub token — a read-only token plumbing exists but needs a token to be minted and set via env.
- The legacy prompt-verdicts path still contains the self-deciding worker prompt (~200 lines of prose) — kept as the rollback mode.
- Concurrent-tick races are mitigated by the claim-before-gather pattern but not proven closed; the triple-instance race (three ticks in 32ms) needs the lock protocol tightened.
- `executeTool("codemode")` from the tick (jev calls with zero spawns) is the next frontier — feasible but unproven.

---

*Everything in this release was debugged against live incidents: the spam loop, the parked-on-unsigned bug, the impossibility non-escalation, the PTY truncation, the render leak, the PR-blind worker, the duplicate-cycle race. Each has a regression test or a structural fix (or both). The system you're running is the version those incidents produced.*
