# Architecture

## The core idea: a reconciler, not a chat

Command Centre treats agent work like a control loop:

- **Desired state** — the Linear tickets you launched workers for.
- **Observed state** — live Linear agent session status + `gh pr` (checks, review threads, branch, commits, merge state).
- **The loop** — a 20s tick that diffs the two and takes bounded actions.

`pi` supplies the reasoning + tool execution inside each wake-up. The extension owns the *clock* and the *state store*. A `pi` session is a stateless wake-up: it reads the checkpoint (its only memory), takes exactly one action, writes the checkpoint, exits.

## Two planes

### Controller (your interactive pi session)
- Renders the **beacon** (≤3-line widget) every 20s — read-only, shown in every session.
- Runs the **mutating tick** — but only in the one session that holds the heartbeat lock (`.pi/command-centre/active-controller.json`, 90s staleness → auto-reclaim). This prevents N open editors from spawning N duplicate workers.
- The tick does four things, all without an LLM:
  1. `maybeSpawnCheckWorkers` — checkpoint stale > `staleMinutes` → spawn a fresh wake-up (with an in-flight guard so it can't double-spawn).
  2. `probeAgentSessions` — read each worker's live Linear session status; reconcile stale `awaiting_approval`/`blocked` checkpoints back to `working` when the agent is active again.
  3. `autoCloseMergedWorkers` — `gh pr view` per worker; MERGED → auto-close.
  4. heartbeat the controller lock.

### Worker (headless `pi -p` in a `zmx` session, one per ticket)
- Launched via a launcher script (not typed into the PTY — that truncates at ~1KB) to sidestep shell-input limits.
- Runs the check-worker prompt: gather → **one verdict** → write checkpoint → exit.
- Verdicts (first match wins): `DELEGATE`, `WAIT`, `NUDGE_SPECIFIC`, `FIX_CI`, `NUDGE_THREADS`, `REBASE`, `SIGN_SQUASH`, `BRANCH_RENAME`, `DONE`, `BLOCKED`, `ASK`, and a catch-all `WAIT`.
- A **loop guard** prevents re-posting the same verdict without state change (escalates to you instead) — and **queue discipline** skips a nudge if a prior message is still queued/unconsumed.

## State store

`<project>/.pi/command-centre/`:

| File | Purpose |
|------|---------|
| `workers/<id>.json` | per-worker checkpoint (status, verdict, evidence, live agent fields) |
| `queue.json` | manual/derived intervention queue |
| `events.jsonl` | append-only audit log |
| `config.json` | model tiers, wake-up thresholds, agent name |
| `active-controller.json` | heartbeat lock electing the tick owner |
| `launchers/` | generated launcher scripts + prompt files per worker |

## UI: beacon + console

pi hard-caps widget height, so:

- **Beacon** (widget) — a fixed ≤3-line status light. Cannot truncate by design.
- **Console** (`ctx.ui.custom` overlay, `alt+c`) — unbounded, scrollable, bordered. Full tables with wrapped text, `cmd`-clickable ticket/PR links.

The single most important design lesson: never render long content into the height-capped widget. Glance in the beacon; work in the console.

## Source-of-truth rule

When a stored checkpoint field disagrees with the live Linear session status, **live wins**:

- `active` → working, don't flag you (even if an old verdict said `awaiting_approval`)
- `awaitingInput` → genuinely needs a reply
- `complete` + open PR → genuinely needs merge/approval

This keeps "CC says needs-you but the agent's actually fine" false alarms from persisting beyond one probe window.
