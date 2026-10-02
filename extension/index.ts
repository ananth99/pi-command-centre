/**
 * index.ts — the extension entry point: registration and wiring only.
 *
 * Registers the hotkeys, the cc_status structured tool, and the session
 * handlers that arm the 20s tick. All logic lives in the modules:
 *   types.ts   shared shapes + config defaults
 *   state.ts   on-disk store (checkpoints, events, lock)
 *   spawns.ts  process plumbing (RPC renders, legacy zmx)
 *   prompts.ts legacy self-deciding worker prompts
 *   cycle.ts   the tick's five jobs
 *   ui.ts      beacon + console
 *   actions.ts hotkey handlers
 *   facts.ts / verdict.ts / render.ts   the v3 decision engine
 */

import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import type { WorkerCheckpoint } from "./types";
import { readCCConfig, readWorkerCheckpoints, setActiveController, getActiveController, clearActiveController, appendEvent, ensureState } from "./state";
import { renderDashboardWidget, dashboardHiddenSessions, blockedControllerSessions, commandCentreModeSessions, refreshTimers } from "./ui";
import { runVerdictCycle, maybeSpawnCheckWorkers, probeAgentSessions, autoCloseMergedWorkers, maybeReviveForNewPRs, reapStaleRenderSessions } from "./cycle";
import { doReply, launchHotkey, replyHotkey, closeHotkey, actHotkey, inspectHotkey } from "./actions";
import { openConsole } from "./ui";

export default function commandCentreExtension(pi: ExtensionAPI) {
  // cc_status: structured status tool for the session model (and codemode
  // scripts) — the amnesiac-LLM-spelunking-the-source class dies here.
  try {
    pi.registerTool({
      name: "cc_status",
      label: "Command Centre Status",
      description:
        "Live Command Centre worker status: counts by state + per-worker ticket/PR/verdict/age. Read-only; use before making claims about CC workers.",
      exposure: "direct",
      parameters: {},
      outputSchema: {
        type: "object",
        properties: {
          counts: { type: "object", description: "workers by status" },
          workers: {
            type: "array",
            description: "per-worker snapshot, newest first",
            items: { type: "object" },
          },
        },
        required: ["counts", "workers"],
      },
      async execute(_toolCallId: string, _params: unknown, _signal: unknown, _onUpdate: unknown, ctx: { cwd: string }) {
        const checkpoints = await readWorkerCheckpoints(ctx.cwd);
        const counts: Record<string, number> = {};
        for (const w of checkpoints) counts[w.status] = (counts[w.status] ?? 0) + 1;
        const workers = checkpoints
          .slice()
          .sort((a, b) => (b.updated_at ?? "").localeCompare(a.updated_at ?? ""))
          .map((w) => ({
            worker: w.worker_id,
            ticket: w.linear_issue_id ?? null,
            pr: w.expected_pr ?? null,
            status: w.status,
            action: w.action ?? null,
            reply_class: w.reply_class ?? null,
            updated: w.updated_at,
            summary: (w.summary ?? "").slice(0, 120),
          }));
        const data = { counts, workers };
        return {
          content: [{ type: "text" as const, text: JSON.stringify(data, null, 1) }],
          structuredContent: data,
          details: {},
        };
      },
    });
  } catch (error) {
    // registration failure must never take the whole extension down
    console.error("[cc] cc_status registration failed:", error);
  }
  pi.registerShortcut("alt+c", {
    description: "Open Command Centre console (scrollable, no truncation)",
    handler: async (ctx) => {
      await openConsole(ctx as ExtensionCommandContext);
    },
  });
  pi.registerShortcut("alt+n", {
    description: "Command Centre: open console (leads with Needs You)",
    handler: async (ctx) => {
      await openConsole(ctx as ExtensionCommandContext);
    },
  });

  pi.registerShortcut("alt+r", {
    description: "Command Centre: reply to a waiting agent (pick + type)",
    handler: async (ctx) => {
      await replyHotkey(ctx as ExtensionCommandContext);
    },
  });

  pi.registerShortcut("alt+k", {
    description: "Command Centre: close/kill a worker",
    handler: async (ctx) => {
      await closeHotkey(ctx as ExtensionCommandContext);
    },
  });
  pi.registerShortcut("alt+i", {
    description: "Command Centre: inspect a worker's full status",
    handler: async (ctx) => {
      await inspectHotkey(ctx as ExtensionCommandContext);
    },
  });
  pi.registerShortcut("alt+a", {
    description: "Command Centre: action mode — pick worker → reply/inspect/kill",
    handler: async (ctx) => {
      await actHotkey(ctx as ExtensionCommandContext);
    },
  });
  pi.registerShortcut("alt+l", {
    description: "Command Centre: launch supervisor workers (interactive)",
    handler: async (ctx) => {
      await launchHotkey(ctx as ExtensionCommandContext);
    },
  });
  pi.registerShortcut("alt+p", {
    description: "Command Centre: toggle beacon panel",
    handler: async (ctx) => {
      const key = (ctx as ExtensionCommandContext).sessionManager.getSessionId();
      if (dashboardHiddenSessions.has(key)) {
        dashboardHiddenSessions.delete(key);
      } else {
        dashboardHiddenSessions.add(key);
      }
      await renderDashboardWidget(ctx as ExtensionCommandContext);
    },
  });

  pi.on("input", async (event, ctx) => {
    const sessionId = ctx.sessionManager.getSessionId();
    if (event.source === "interactive") {
      // Output panel is transient: dismiss it as soon as the user types a new prompt.
      ctx.ui.setWidget("command-centre-output", undefined, { placement: "belowEditor" });
    }
    if (blockedControllerSessions.has(sessionId)) {
      return { action: "continue" };
    }
    if (!commandCentreModeSessions.has(sessionId)) {
      return { action: "continue" };
    }
    if (event.source !== "interactive") {
      return { action: "continue" };
    }
    return { action: "continue" };
  });

  pi.on("before_agent_start", async (event, ctx) => {
    const sessionId = ctx.sessionManager.getSessionId();
    if (blockedControllerSessions.has(sessionId)) return;
    if (!commandCentreModeSessions.has(sessionId)) return;

    return {
      systemPrompt:
        `${event.systemPrompt}\n\n` +
        "Command Centre mode is enabled. Prefer orchestration behavior: use command-centre state files under .pi/command-centre and zmx operations when relevant.",
    };
  });

  pi.on("session_start", async (_event, ctx) => {
    await ensureState(ctx.cwd);
    const key = ctx.sessionManager.getSessionId();

    // Beacon shows in EVERY session by default (tiny, read-only). /cc panel off to hide.
    // Claim the controller lock if it's free or stale (owner runs the mutating tick).
    const active = await getActiveController(ctx.cwd);
    const beat = active ? new Date(active.heartbeatAt ?? active.startedAt).getTime() : 0;
    const lockFree =
      !active?.sessionId ||
      active.sessionId === key ||
      Number.isNaN(beat) ||
      Date.now() - beat > 90_000;
    if (lockFree) await setActiveController(ctx.cwd, key);

    void renderDashboardWidget(ctx); // immediate beacon

    const existing = refreshTimers.get(key);
    if (existing) clearInterval(existing);
    const timer = setInterval(() => {
      void renderDashboardWidget(ctx); // beacon: every session, always
      void (async () => {
        // Mutating ops run only in the session that owns (or can claim) the lock.
        const a = await getActiveController(ctx.cwd);
        const b = a ? new Date(a.heartbeatAt ?? a.startedAt).getTime() : 0;
        const iOwn =
          !a?.sessionId ||
          a.sessionId === key ||
          Number.isNaN(b) ||
          Date.now() - b > 90_000;
        if (!iOwn) return;
        await setActiveController(ctx.cwd, key); // refresh heartbeat / claim
        const cfg = await readCCConfig(ctx.cwd).catch(() => null);
        if (cfg?.mode === "code-verdicts") {
          await runVerdictCycle({ cwd: ctx.cwd }).catch(() => {});
        } else {
          await maybeSpawnCheckWorkers({ cwd: ctx.cwd }).catch(() => {});
        }
        await probeAgentSessions(ctx.cwd).catch(() => {});
        await autoCloseMergedWorkers(ctx.cwd).catch(() => {});
        await maybeReviveForNewPRs(ctx.cwd).catch(() => {});
        await reapStaleRenderSessions().catch(() => {});
      })();
    }, 20000);
    refreshTimers.set(key, timer);
  });

  pi.on("session_shutdown", async (_event, ctx) => {
    const key = ctx.sessionManager.getSessionId();
    const timer = refreshTimers.get(key);
    if (timer) {
      clearInterval(timer);
      refreshTimers.delete(key);
    }

    const active = await getActiveController(ctx.cwd);
    if (active?.sessionId === key) {
      await clearActiveController(ctx.cwd);
    }

    blockedControllerSessions.delete(key);
    commandCentreModeSessions.delete(key);
    dashboardHiddenSessions.delete(key);
    ctx.ui.setStatus("command-centre", undefined);
    ctx.ui.setWidget("command-centre-dashboard", undefined);
    ctx.ui.setWidget("command-centre-output", undefined, { placement: "belowEditor" });
  });
}
