# pi Command Centre

A [pi](https://github.com/earendil-works/pi-coding-agent) extension that turns your terminal into a **supervisor cockpit for background work**. Launch headless workers, watch them run through a compact always-on beacon, and step in only when a real decision is needed — all via hotkeys, zero conversation bloat.

> Built live over one long session. It supervises bounded work the way you would by hand — polling status, checking CI, addressing review feedback, escalating when stuck — but on a 20-second reconciler loop instead of your attention.

## What it does

- **Workers.** `alt`-driven launch spawns a headless `pi` process (via [`zmx`](#requirements)) that runs a bounded task end-to-end: implement a ticket, execute a test plan, audit a codebase. Each writes a structured checkpoint.
- **A reconciler, not a chat.** Each worker wakes on a timer, reads the live state (ticket-tracker sessions, `gh pr` checks, review threads, branch names, commit signatures), decides **exactly one action** (nudge / fix-ci / rebase / squash-sign / rename / wait / escalate), writes a checkpoint, exits. The controller session re-spawns wake-ups when a checkpoint goes stale.
- **A beacon, not a dashboard.** The always-on widget is a fixed ≤3-line status light (`⚡ CC 🔴 · needs-you 1 · in-flight 2 · queue 0`). The rich, scrollable tables live one hotkey away in an overlay console — so nothing ever truncates in the height-capped widget.
- **Self-cleaning.** Workers auto-close when their PR merges. Stale "needs you" flags reconcile automatically when the agent resumes. Done workers resurrect if their ticket gains a new PR.
- **Queue-flush built in.** Comments posted to a ticket-tracker agent can sit `queued: true, sentAt: null` (undelivered). Every post auto-flushes via the tracker's send-queue mutation so messages land immediately.

## Hotkeys

| Key | Action |
|-----|--------|
| `alt+c` | Open the **console** — full In Flight + Needs You box tables, overlay with border + scrollbar, no truncation |
| `alt+n` | Open the console (leads with Needs You) |
| `alt+a` | **Action mode** — pick worker → reply / inspect / kill |
| `alt+r` | **Reply** to an agent awaiting your input (pick worker → type → posts @mention + flushes queue) |
| `alt+i` | **Inspect** a worker's full checkpoint in a scrollable pager |
| `alt+k` | **Close/kill** a worker |
| `alt+l` | **Launch** supervisor workers (interactive: tickets → repo → agent) |
| `alt+p` | Toggle the beacon panel |

Console navigation: `↑↓` / `PgUp` `PgDn` / `g` `G` scroll, `q` or `esc` close. Ticket & PR cells are `cmd`-clickable (OSC 8 links).

## Launching workers

Press `alt+l` and follow the prompts (tickets → repo → agent). One supervisor worker per ticket. The first wake-up delegates to the agent (with your branch/PR conventions), then subsequent wake-ups drive it to a mergeable, signed, single-commit PR — escalating to **Needs You** only for merge approval, scope questions, or genuine blockers.

## How it works

```
 CONTROLLER pi session (beacon + 20s tick)
   │  reads checkpoints, renders beacon, re-spawns stale wake-ups,
   │  probes live agent status, auto-closes merged PRs, revives on new PRs
   │
   └─ WORKER (headless pi in zmx, one per task)  ── does the bounded work
         one action per wake-up, writes a checkpoint JSON
```

- **State store:** plain JSON under `<project>/.pi/command-centre/` — `workers/*.json` (checkpoints), `queue.json`, `events.jsonl`, `config.json`.
- **The clock is yours:** the 20s tick lives in the extension; `pi` sessions are stateless wake-ups. Only one session (heartbeat-elected) runs the mutating tick; every session shows the read-only beacon.

See [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) for the full design.

## Requirements

- [pi](https://github.com/earendil-works/pi-coding-agent) (the coding agent this extends)
- [`zmx`](https://github.com/…) — terminal session persistence, used to run headless workers
- [`linear`](https://github.com/schpet/linear-cli) CLI — authenticated, for reading/driving ticket-tracker agent sessions (optional; the worker infrastructure works without it for non-tracker tasks)
- [`gh`](https://cli.github.com) CLI — authenticated with `Contents`, `Pull requests`, `Checks`, `Actions` read access
- A terminal with Alt/Option-as-Meta (e.g. Ghostty `macos-option-as-alt = true`) for the hotkeys

## Install

```bash
git clone https://github.com/ananth99/pi-command-centre
mkdir -p ~/.pi/agent/extensions/command-centre
cp pi-command-centre/extension/index.ts ~/.pi/agent/extensions/command-centre/index.ts
# companion tool extension (agent-session tools + queue flush):
mkdir -p ~/.pi/agent/extensions/linear-agent
cp pi-command-centre/extension/linear-agent.ts ~/.pi/agent/extensions/linear-agent/index.ts
```

Then `/reload` in pi (or restart). The beacon appears above your editor in every session.

## Configuration

`<project>/.pi/command-centre/config.json` (auto-created with defaults):

```json
{
  "models": {
    "check":   { "model": "openrouter/gpt-luna",  "thinking": "xhigh" },
    "nudge":   { "model": "openrouter/glm-flash", "thinking": "low" }
  },
  "wakeups": { "staleMinutes": 10, "checkTimeoutMinutes": 15 },
  "mode":    "code-verdicts"
}
```

- `CC_LINEAR_WORKSPACE` env var sets the ticket-tracker workspace slug for deep-links.
- `CC_BRANCH_OWNER` env var sets the expected branch-name prefix (`owner/<ticket>-<desc>` convention).
- The worker prompt encodes an opinionated workflow (single signed commit, `feat(scope):` headers, branch naming, GitHub branch-rename API, human-commit-attribution gates). Edit `render.ts` / `prompts.ts` to match your conventions.

## Generic worker infrastructure

The checkpoint contract + headless transport + watchdog is transport-agnostic — it has been used to run headless E2E test suites with structured pass/fail reports as checkpointed workers (no ticket-tracker involvement):

```
worker launch → spawnWorkerPi → pi worker with a plain prompt
               ↑ NO tracker, NO verdict cycle — just bounded work + checkpoint
```

Anything that's "prompt in → bounded work → structured checkpoint out" runs under CC's supervision for free: E2E suites, security audits, migration dry-runs, benchmarks.

## Caveats

- The worker prompt is tuned for a CI + ticket-tracker + GitHub flow with signed commits and human-attribution gates; treat it as a starting template.
- Workers run real `pi` sessions and post real comments — start with `wakeups.staleMinutes` high and watch the first few wake-ups (`zmx tail <worker>`).
- pi caps widget height; that's *why* the design is beacon + overlay console rather than one big dashboard.

## Changelog

See [CHANGELOG.md](CHANGELOG.md) — everything to date is the [0.1.0] release.

## License

MIT