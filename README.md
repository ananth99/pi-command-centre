# pi Command Centre

A [pi](https://github.com/earendil-works/pi-coding-agent) extension that turns your terminal into a **supervisor cockpit for Linear coding agents** (Ralph / BitGo Internal Agent, or any Linear agent). Launch one background worker per ticket, watch them drive the agent to green through a compact always-on beacon, and step in only when a real decision is needed — all via hotkeys, zero conversation bloat.

> Built live over one long session. It supervises agents the way you would by hand — polling status, nudging on stale CI, addressing review threads, flushing Linear's send queue — but on a 20-second reconciler loop instead of your attention.

![beacon](docs/beacon.png)

## What it does

- **One worker per ticket.** `alt`-driven launch spawns a headless `pi` process (via [`zmx`](#requirements)) that supervises the Linear agent on that ticket end-to-end.
- **A reconciler, not a chat.** Each worker wakes on a timer, reads the live state (Linear session status, `gh pr` checks, review threads, branch name, commit signatures), decides **exactly one action** (nudge / fix-ci / rebase / squash-sign / rename / wait / escalate), writes a checkpoint, exits. The controller session re-spawns wake-ups when a checkpoint goes stale.
- **A beacon, not a dashboard.** The always-on widget is a fixed ≤3-line status light (`⚡ CC 🔴 · needs-you 1 · in-flight 2 · queue 0`). The rich, scrollable tables live one hotkey away in an overlay console — so nothing ever truncates in the height-capped widget.
- **Self-cleaning.** Workers auto-close when their PR merges. Stale "needs you" flags reconcile automatically when the agent resumes.
- **Queue-flush built in.** Comments posted to a Linear agent can sit `queued: true, sentAt: null` (undelivered). Every post auto-flushes via `agentActivitySendQueued` so messages land immediately.

## Hotkeys

| Key | Action |
|-----|--------|
| `alt+c` | Open the **console** — full In Flight + Needs You tables, scrollable, no truncation |
| `alt+n` | Open the console (leads with Needs You) |
| `alt+r` | **Reply** to an agent awaiting your input (pick worker → type → posts @mention + flushes queue) |
| `alt+i` | **Inspect** a worker's full checkpoint in a scrollable pager |
| `alt+k` | **Close/kill** a worker |

Console navigation: `↑↓` / `PgUp` `PgDn` / `g` `G` scroll, `q` or `esc` close. Ticket & PR cells are `cmd`-clickable (OSC 8 links).

Slash commands still exist as a fallback (`/cc`, `/cc reply`, `/cc launch`, `/cc inspect`, `/cc needs`, `/cc approve`, `/cc reject`) but hotkeys are the intended interface.

## Launching workers

```
/cc launch --tickets SCAAS-11150,SCAAS-11148 --repo ~/code/my-service --agent ralph
```

One supervisor worker per ticket. The first wake-up delegates to the agent (with your branch/PR conventions), then subsequent wake-ups drive it to a mergeable, signed, single-commit PR — escalating to **Needs You** only for merge approval, scope questions, or genuine blockers.

## How it works

```
 CONTROLLER pi session (beacon + 20s tick)
   │  reads checkpoints, renders beacon, re-spawns stale wake-ups,
   │  probes live agent status, auto-closes merged PRs
   │
   └─ WORKER (headless pi in zmx, one per ticket)  ── supervises ──▶  LINEAR AGENT
         one action per wake-up, writes a checkpoint JSON               (does the code)
```

- **State store:** plain JSON under `<project>/.pi/command-centre/` — `workers/*.json` (checkpoints), `queue.json`, `events.jsonl`, `config.json`.
- **The clock is yours:** the 20s tick lives in the extension; `pi` sessions are stateless wake-ups. Only one session (heartbeat-elected) runs the mutating tick; every session shows the read-only beacon.

See [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) for the full design.

## Requirements

- [pi](https://github.com/earendil-works/pi-coding-agent) (the coding agent this extends)
- [`zmx`](https://github.com/…) — terminal session persistence, used to run headless workers
- [`linear`](https://github.com/schpet/linear-cli) CLI — authenticated, for reading/driving agent sessions
- [`gh`](https://cli.github.com) CLI — authenticated with `Contents`, `Pull requests`, `Checks`, `Actions` read access
- A terminal with Alt/Option-as-Meta (e.g. Ghostty `macos-option-as-alt = true`) for the hotkeys

## Install

```bash
git clone https://github.com/ananth99/pi-command-centre
mkdir -p ~/.pi/agent/extensions/command-centre
cp pi-command-centre/extension/index.ts ~/.pi/agent/extensions/command-centre/index.ts
# the Linear-agent tool extension (used by the reply/flush flow):
mkdir -p ~/.pi/agent/extensions/linear-agent
cp pi-command-centre/extension/linear-agent.ts ~/.pi/agent/extensions/linear-agent/index.ts
```

Then `/reload` in pi (or restart). The beacon appears above your editor in every session.

## Configuration

`<project>/.pi/command-centre/config.json` (auto-created with defaults):

```json
{
  "models": {
    "check":   { "model": "openrouter/~openai/gpt-luna-latest",  "thinking": "xhigh" },
    "nudge":   { "model": "openrouter/~z-ai/glm-flash-latest",   "thinking": "low" }
  },
  "wakeups": { "staleMinutes": 10, "checkTimeoutMinutes": 15 },
  "agent":   { "name": "ralph" }
}
```

- `CC_LINEAR_WORKSPACE` env var sets the Linear workspace slug for ticket deep-links (default `bitgo`).
- The worker prompt encodes an opinionated workflow (single signed commit, `feat(scope):` headers, branch naming `owner/<TICKET>-<desc>`, GitHub branch-rename API). Edit `buildCheckWorkerPrompt` in `index.ts` to match your team's conventions.

## Caveats

- The check-worker prompt is tuned for a BitGo-style workflow; treat it as a starting template.
- Workers run real `pi` sessions and post real comments to Linear — start with `wakeups.staleMinutes` high and watch the first few wake-ups (`zmx tail <worker>`).
- pi caps widget height; that's *why* the design is beacon + overlay console rather than one big dashboard.

## License

MIT © Ananth Madhavan
