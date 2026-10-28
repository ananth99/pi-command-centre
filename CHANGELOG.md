# Changelog

## [Unreleased]

### Added

- **One board, one truth (`board.ts`).** Pure `deriveBoard()` feeds both the beacon and the console, so the two surfaces can never disagree and a worker appears in exactly one section. Tested (`board.test.ts`).
- **NEEDS YOU redesign.** Classified by *reason* (QUESTION / BLOCKED / STALLED / APPROVE) with an effort tag (⚡ 30s / ☕ 5m / 🧱 30m+), age heat (amber at 24h, red at 48h), the PR chain, and the hotkey to act. A **NEXT UP** hero card shows the single best item; **ALL CLEAR** when empty. Worker session status is read from Linear and rendered in the agent's own words.
- **Assigned-ticket queue.** The dead `queue.json` (a slash-command-era inbox nothing wrote to) is gone. The queue is now your assigned Linear tickets with no worker yet — polled, throttled, sorted by priority then due date, with project, due (overdue flagged), estimate, and dependency state (`ready` / `⏸ blocked by SCAAS-XXXX`).
- **AWAITING REVIEW** section for parked workers, a today line (`landed · merged · replies`), and stacked-PR rendering in the PR column (`#984→985`, `#996 +3`, deduped).
- **Repo slugs in the tables.** PR numbers are per-repo, so `#992` alone was ambiguous. NEEDS YOU / AWAITING REVIEW / IN FLIGHT show a slug beside the chain: `retail #10781 +3`. `shortRepo()` handles plain checkouts and worktrees (`<repo>-worktree/<name>` → `ui`, not the worktree name).
- **`autoLaunchWorkers`.** With `assignedTickets.autoLaunch: true`, CC spawns a worker for any launchable assigned ticket (blockers Done, state Todo/In Progress): one per tick, 2-minute cooldown, up to `maxConcurrent` (default 5). **Off by default and never yet run.**
- **Auto-answer.** When the agent asks something, CC reads the question from the Linear session and classifies it (repo/branch/process → auto-answer; credentials/design/approval → escalate), then spawns a render worker to reply. The human sees the agent's actual question instead of "the agent asked you something". Question dedup included.
- **Unified beacon.** The controller writes `beacon.json`; reader sessions display the same line. Each beacon is tagged `🎛 ctrl` or `👁 reader`, so you can see which terminal is driving.

### Changed

- **The rename path is deleted, not avoided.** `BRANCH_RENAME` is gone from the verdict union, from the render prompt's shape list, and from every module that emits agent-facing text. Renaming is cosmetic; the agent's implementation pushes a new branch and deletes the old one, which **closes the PR** (upstream #892/#3315/#903) — it closed one PR outright and orphaned three stacks. An off-convention branch now escalates as `ASK` and latches `do_not_rename`. Two structural tests lock it: no module may contain a rename instruction, and an off-convention branch must resolve to `ASK`.
- **CC dictates the branch name.** Delegation carries a literal `owner/TICKET-short-slug`, not a `<owner>/<ticket>-<desc>` pattern. The pattern was advisory, so real branches came out with three different owners (a short handle, a long handle, and none at all), slugs of 2–6 words, and three slice styles (`-0-`, `-a-`, `-pt1`). A pattern is not enforceable; a value is. Owner is pinned by `agent.branchOwner` (then `CC_BRANCH_OWNER`, then `gh api user`). Slugs strip the title prefix, collapse `T&C` → `tc`, drop stopwords.
- **Colors come from pi's active theme** (`theme.fg` semantic tokens) instead of hardcoded ANSI, so light, dark and custom themes all work.
- **The console is wider and roomier** — 98% of the terminal, 2-space cell padding, row separators, and 3–4 column layouts so the text column gets the room. Cells support `
`.
- **Notifications left the chat log.** A new NEEDS YOU item shows a `🆕` marker in the beacon for 5 minutes instead of writing a permanent `Warning:` line into the transcript.

### Fixed

- **CC told the agent to run a command that only exists on the operator's laptop.** The render and legacy prompts instructed `git sign-pr` — a local signing alias from the operator's own workflow — while the agent runs in a sandbox where that alias does not exist. Worse, when the agent reported it unavailable, auto-answer suggested *defining the alias*, so CC kept re-issuing an impossible instruction. CC now states the **requirement** (one commit, signature verifiable via the REST API) and never the mechanism, and auto-answer may not invent or assume local tooling. 2 structural tests lock it.

- **A stale `cannot_do` no longer latches forever.** Rule 0 (highest priority) fired on `reply_class === "cannot_do"`, and the only other thing that cleared it was a human reply — so one stale classification froze a worker permanently. one worker was classified against a **closed** PR, then repointed at a live PR with the code fixed, and CC kept re-applying `BLOCKED_IMPOSSIBILITY` ~6×/hour for four days, mute and un-revivable without hand-editing the checkpoint. The classification is now scoped to its provenance (`reply_class_at`, `reply_class_pr`) and expires when the agent speaks again or the worker is repointed.
- **A human's question in a resolved thread is no longer invisible.** CC skipped every resolved review thread, and GitHub does **not** reopen a thread when you reply — so a question asked in a resolved thread was invisible to CC *and* easy to miss in the UI. On `one pull request` a question sat unanswered while CC produced only unrelated noise. Threads are now classified as unresolved, or **resolved with a human having the last word**; both nudge, both block parking, both count for the CHANGES_REQUESTED hands-off rule. Measured at **1 of 11 threads across eight live PRs**.
- **The park/unpark pendulum.** Found the system's largest source of churn: **1333 unparks across 8 workers**, with one worker cycling 441 times in 7.1 days (one every 23 minutes) over three PRs whose commits were all `verified=true`. Two independent causes: the landing guard unparked on GraphQL nulls while the verdict engine (REST-correct) re-parked; and rule 3 unparks on unresolved threads while rule 10 re-parked without checking them, so any parked PR with open threads ping-ponged forever. Rule 10 now requires `unresolvedThreadIds.length === 0`, matching rule 3.
- **A failed read is never a verdict.** Swept every GitHub read for the false-accusation class — a *missing* signal treated as a *negative* one. Three found: `facts.ts` recorded an unreadable commit as `verified: false` (a transient `gh api` failure looked exactly like an unsigned commit); an empty commit list read as "multiple commits" (a failed GraphQL fetch yielded `[]`, and `length !== 1` told the agent it had "0 commits (need exactly 1)"); and the new landing-lane helper failed closed the same way, unparking on a read failure. Commits now carry `verificationKnown`, reads retry once, and unknown **skips** the rule. The rule: **unknown means do nothing and re-read, never punish.**
- **The landing lane read commit verification from GraphQL.** `gh pr view --json commits` returns `verification.verified = null`, so every signed commit looked unsigned. Both call sites (park-on-finish, unpark guard) used it; one worker took 3 unparks and 6 `SIGN_SQUASH` renders over a commit that had always been `verified=true`. Now one shared `readPrGateInfo()`: PR state from `gh pr view` (no commits), verification from `gh api .../pulls/<n>/commits`.
- **The assigned-ticket queue was frozen for 24h.** Adding `relations { relatedIssue { state } }` pushed the poll past Linear's 10000 complexity budget (measured ~17000 at `first:100`), so `pollAssignedTickets` failed every tick and `assigned.json` went stale — silently, because the failure was swallowed. Now pages at `first:50` with a fallback that re-queries without relations, so a complexity or schema problem degrades the queue instead of freezing it.
- **Branch conformance rejected every branch.** `branchConforming` interpolated `CC_BRANCH_OWNER ?? "owner"`; with the variable unset *or empty* the pattern became `^/SCAAS-...`, which no branch matches. Each worker took a `BRANCH_RENAME` it could never satisfy, burned 2 attempts, then escalated to a repeating `ASK` (one worker: 10 ASK renders in 2h). The owner segment is accepted by default now. 3 regression tests.
- **Unguarded terminal verdicts.** The `rename-exhausted → ASK` return was not wrapped in `guarded()`, so it re-spawned a render worker every tick.
- **CC was blind to every question the agent asked.** The agent asks via `AgentActivityElicitationContent`; the reader fetched only `AgentActivityResponseContent` *and* filtered out any activity with a `sourceComment.user` (elicitations are authored by the agent), so it always returned null and auto-answer silently never fired. the ticket/716 each sat STALLED ~50 min. Also deepened the activity window to 60 — the ask is buried behind dozens of thoughts.
- **Auto-answer never ran on stalled workers.** It was gated to `status === "working"`, but the verdict engine had already escalated those workers to `awaiting_approval`, so it never fired. It now runs on working, awaiting_approval and blocked, and un-stalls the worker when it succeeds.
- **Blind-and-immortal workers.** If every PR a worker tracks is CLOSED (not merged), CC now re-discovers the ticket's current open PRs and repoints the worker (`prs_rerolled`). Previously discovery ran once, so a closed-and-rerolled stack (one ticket: four PRs closed, rerolled as four new ones) left the worker pointing at dead PRs forever — it could never land and never retire.
- **The loop guard cried stall on a queued command.** It escalated to STALLED 10 minutes after a `/fix-ci` while the platform command was still queued (one worker). Within the window the verdict is now WAIT while the agent is active or hasn't started; STALLED only if the agent acted, went idle, and the problem is unchanged — or stayed silent past the grace.
- **The console overlay did not scroll** (pi-tui's `ScrollView` is sized by the layout pass, which overlays skip). Replaced with explicit scrolling: ↑↓/j/k, PgUp/PgDn/space, g/G, mouse wheel, plus a scrollbar and position in the header.
- **The status sanitizer rejected `landing`** and demoted landed workers to `working` on every read, flip-flopping against the verdict engine.
- **The extension failed to load entirely.** `(w.evidence?.pr) ?? ""` — a `?.` immediately followed by `??` without parens broke pi's parser, so the whole extension threw on load and every hotkey died (`ref.trim is not a function` was a separate symptom of the same fragility: `normalizePr` assumed a string, and one checkpoint held a numeric PR).

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
