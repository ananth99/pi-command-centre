/**
 * actions.ts — what the hotkeys actually do.
 *
 * alt+r reply to a waiting agent (comment + queue flush + clear impossibility)
 * alt+i inspect a worker's full checkpoint in the pager
 * alt+k kill/close a worker
 * alt+a action mode: pick worker -> reply/inspect/kill
 * alt+l interactive launch (tickets -> repo -> agent)
 */

import { join } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import type { WorkerCheckpoint } from "./types";
import { appendEvent, ensureState, liveAgentStatus, readJson, readWorkerCheckpoints, writeJson } from "./state";
import { openConsole, renderDashboardWidget, showPager, showOutputPanel, wrapText } from "./ui";
import { launchTicketWorkers } from "./spawns";

const execFileAsync = promisify(execFile);

/** Flush queued-but-unsent agent activities on an issue's latest session (agentActivitySendQueued). */
export async function flushQueuedAgentActivity(issueId: string): Promise<string> {
  try {
    const opts = { timeout: 8000, maxBuffer: 1024 * 1024 };
    const { stdout: sess } = await execFileAsync(
      "linear",
      ["api", `query { issue(id: "${issueId}") { agentSessions { nodes { id updatedAt } } } }`],
      opts,
    );
    const nodes: Array<{ id: string; updatedAt?: string }> =
      JSON.parse(sess)?.data?.issue?.agentSessions?.nodes ?? [];
    nodes.sort((a, b) => (a.updatedAt ?? "").localeCompare(b.updatedAt ?? ""));
    const latest = nodes[nodes.length - 1];
    if (!latest) return "no agent session";
    const { stdout: acts } = await execFileAsync(
      "linear",
      ["api", `query { agentSession(id: "${latest.id}") { activities(last: 10) { nodes { id queued sentAt } } } }`],
      opts,
    );
    const activities: Array<{ id: string; queued?: boolean; sentAt?: string | null }> =
      JSON.parse(acts)?.data?.agentSession?.activities?.nodes ?? [];
    const queued = activities.filter((a) => a.queued === true && !a.sentAt);
    if (!queued.length) return "delivered";
    let flushed = 0;
    for (const q of queued) {
      const { stdout: res } = await execFileAsync(
        "linear",
        ["api", `mutation { agentActivitySendQueued(id: "${q.id}") { success } }`],
        opts,
      );
      if (JSON.parse(res)?.data?.agentActivitySendQueued?.success) flushed += 1;
    }
    return `flushed ${flushed}/${queued.length} queued`;
  } catch {
    return "flush check failed";
  }
}


/** Mark a worker done and drop it from the boards. */
export async function closeWorker(ctx: ExtensionCommandContext, workerId: string, reason: string): Promise<void> {
  const paths = await ensureState(ctx.cwd);
  const p = join(paths.workersDir, `${workerId}.json`);
  const w = await readJson<WorkerCheckpoint | null>(p, null);
  if (!w) {
    ctx.ui.notify(`Worker ${workerId} not found`, "warn");
    return;
  }
  w.status = "done";
  w.action = "CLOSED";
  w.summary = `Closed by you: ${reason}`.slice(0, 100);
  w.updated_at = new Date().toISOString();
  w.check_in_progress_at = null;
  await writeJson(p, w);
  liveAgentStatus.delete(workerId);
  await appendEvent(ctx.cwd, { type: "worker_closed", worker_id: workerId, reason });
  ctx.ui.notify(`Closed ${workerId}`, "info");
  await renderDashboardWidget(ctx);
}

/** alt+k hotkey: pick a pending worker and close it. */

/** alt+k hotkey: pick a pending worker and close it. */
export async function closeHotkey(ctx: ExtensionCommandContext): Promise<void> {
  const checkpoints = await readWorkerCheckpoints(ctx.cwd);
  const candidates = checkpoints.filter(
    (w) => w.status !== "done" && w.status !== "failed",
  );
  if (!candidates.length) {
    ctx.ui.notify("No open workers to close", "info");
    return;
  }
  let target = candidates[0]!;
  if (candidates.length > 1) {
    const pick = await ctx.ui.select(
      "Close which worker?",
      candidates.map((w) => `${w.worker_id} (${w.status}, ${w.linear_issue_id ?? "-"})`),
    );
    if (!pick) return;
    const chosen = candidates.find((w) => pick.startsWith(w.worker_id));
    if (!chosen) return;
    target = chosen;
  }
  await closeWorker(ctx, target.worker_id, "manual dismiss");
}

/** alt+a action mode: pick a worker → pick an action → execute. Replaces 3 bespoke pickers. */

/** alt+a action mode: pick a worker → pick an action → execute. Replaces 3 bespoke pickers. */
export async function actHotkey(ctx: ExtensionCommandContext): Promise<void> {
  const checkpoints = await readWorkerCheckpoints(ctx.cwd);
  if (!checkpoints.length) {
    ctx.ui.notify("No workers", "info");
    return;
  }
  const active = checkpoints.filter((w) => w.status !== "done" && w.status !== "failed");
  const pool = active.length ? active : checkpoints;
  const pick = await ctx.ui.select(
    "Pick a worker",
    pool.map((w) => `${w.worker_id} (${w.status}, ${w.linear_issue_id ?? "-"})`),
  );
  if (!pick) return;
  const target = pool.find((w) => pick.startsWith(w.worker_id));
  if (!target) return;
  const action = await ctx.ui.select(`Act on ${target.worker_id}`, [
    "Reply to its agent",
    "Inspect checkpoint",
    "Kill / close worker",
  ]);
  if (!action) return;
  if (action.startsWith("Reply")) {
    const message = await ctx.ui.input(
      `Reply to ${target.agent_name ?? "ralph"} on ${target.linear_issue_id ?? "its ticket"}`,
      "Your answer (posted as an @mention + queue-flushed):",
    );
    if (message) await doReply(ctx, target.worker_id, message);
  } else if (action.startsWith("Inspect")) {
    const paths = await ensureState(ctx.cwd);
    const checkpoint = await readJson<WorkerCheckpoint | null>(
      join(paths.workersDir, `${target.worker_id}.json`),
      null,
    );
    if (checkpoint) {
      await showPager(ctx, `Checkpoint — ${target.worker_id}`, JSON.stringify(checkpoint, null, 2));
    }
  } else if (action.startsWith("Kill")) {
    await closeWorker(ctx, target.worker_id, "killed via action mode");
  }
}

/** alt+i hotkey: pick a worker and show its full checkpoint in the pager. */

/** alt+i hotkey: pick a worker and show its full checkpoint in the pager. */
export async function inspectHotkey(ctx: ExtensionCommandContext): Promise<void> {
  const checkpoints = await readWorkerCheckpoints(ctx.cwd);
  if (!checkpoints.length) {
    ctx.ui.notify("No workers to inspect", "info");
    return;
  }
  const active = checkpoints.filter((w) => w.status !== "done" && w.status !== "failed");
  const pool = active.length ? active : checkpoints;
  let target = pool[0]!;
  if (pool.length > 1) {
    const pick = await ctx.ui.select(
      "Inspect which worker?",
      pool.map((w) => `${w.worker_id} (${w.status}, ${w.linear_issue_id ?? "-"})`),
    );
    if (!pick) return;
    const chosen = pool.find((w) => pick.startsWith(w.worker_id));
    if (!chosen) return;
    target = chosen;
  }
  await showPager(ctx, `Checkpoint — ${target.worker_id}`, JSON.stringify(target, null, 2));
}


export async function doReply(
  ctx: ExtensionCommandContext,
  workerId: string,
  message: string,
): Promise<void> {
  const paths = await ensureState(ctx.cwd);
  const checkpointPath = join(paths.workersDir, `${workerId}.json`);
  const checkpoint = await readJson<WorkerCheckpoint | null>(checkpointPath, null);
  if (!checkpoint?.linear_issue_id) {
    ctx.ui.notify(`Worker ${workerId} not found or has no linked ticket`, "warn");
    return;
  }
  const agent = checkpoint.agent_name ?? "ralph";
  try {
    await execFileAsync(
      "linear",
      ["issue", "comment", "add", checkpoint.linear_issue_id, "--body", `@${agent} ${message}`],
      { timeout: 15000 },
    );
  } catch (error) {
    ctx.ui.notify(
      `Failed to post comment: ${error instanceof Error ? error.message : String(error)}`,
      "error",
    );
    return;
  }
  checkpoint.last_nudge_at = new Date().toISOString();
  checkpoint.updated_at = new Date().toISOString();
  checkpoint.summary = `You replied to ${agent}: ${message.slice(0, 60)}`;
  checkpoint.reply_class = undefined; // human replied — impossibility block lifts
  await writeJson(checkpointPath, checkpoint);
  liveAgentStatus.delete(workerId);
  const flushNote = await flushQueuedAgentActivity(checkpoint.linear_issue_id);
  await appendEvent(ctx.cwd, { type: "human_reply", worker_id: workerId, message, queue: flushNote });
  ctx.ui.notify(`Replied to ${agent} on ${checkpoint.linear_issue_id} (${flushNote})`, "info");
  await renderDashboardWidget(ctx);
}

/** Interactive reply flow for the alt+r hotkey: pick a waiting worker, type an answer. */
/** alt+l: interactive worker launch — prompts for tickets/repo/agent (replaces /cc launch). */

/** Interactive reply flow for the alt+r hotkey: pick a waiting worker, type an answer. */
/** alt+l: interactive worker launch — prompts for tickets/repo/agent (replaces /cc launch). */
export async function launchHotkey(ctx: ExtensionCommandContext): Promise<void> {
  const ticketsRaw = await ctx.ui.input(
    "Launch workers",
    "Linear tickets, comma-separated (e.g. prior incidents,prior incidents):",
  );
  if (!ticketsRaw || !ticketsRaw.trim()) return;
  const tickets = ticketsRaw
    .split(",")
    .map((s: string) => s.trim())
    .filter(Boolean);
  if (!tickets.length) return;
  const repo = (await ctx.ui.input("Repo path", "Repo (blank = current dir):")) ?? "";
  const agent = (await ctx.ui.input("Agent", "Agent name (blank = ralph):")) ?? "";
  await launchTicketWorkers(
    {
      workerId: "",
      objective: "",
      model: "",
      thinking: "",
      repo,
      expectedPr: "",
      allowInlineComments: false,
      tickets,
      agent,
      basePr: "",
    } as ReturnType<typeof parseLaunchArgs>,
    ctx,
  );
}


export async function replyHotkey(ctx: ExtensionCommandContext): Promise<void> {
  const checkpoints = await readWorkerCheckpoints(ctx.cwd);
  const candidates = checkpoints.filter((w) => {
    if (w.status === "blocked" || w.status === "awaiting_approval") return true;
    const s = liveAgentStatus.get(w.worker_id);
    return s ? /awaiting/i.test(s.status) : false;
  });
  if (!candidates.length) {
    ctx.ui.notify("No agent is waiting on you right now", "info");
    return;
  }
  let target = candidates[0]!;
  if (candidates.length > 1) {
    const pick = await ctx.ui.select(
      "Reply to which worker?",
      candidates.map((w) => `${w.worker_id} (${w.linear_issue_id ?? "-"})`),
    );
    if (!pick) return;
    const chosen = candidates.find((w) => pick.startsWith(w.worker_id));
    if (!chosen) return;
    target = chosen;
  }
  const message = await ctx.ui.input(
    `Reply to ${target.agent_name ?? "ralph"} on ${target.linear_issue_id}`,
    "Your answer (posted as an @mention + queue-flushed):",
  );
  if (!message) return;
  await doReply(ctx, target.worker_id, message);
}
