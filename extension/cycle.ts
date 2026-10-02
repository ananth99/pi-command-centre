/**
 * cycle.ts — the tick's five jobs. All deterministic, no LLM except render
 * spawns (which the verdict engine gates):
 *
 *   runVerdictCycle         gather facts -> decide -> apply state verdicts
 *                           directly (free), spawn render workers only when
 *                           a message must be composed
 *   probeAgentSessions      live agent status; reconcile stale "needs you";
 *                           land/park the landing lane; watch parked workers
 *   autoCloseMergedWorkers  retire on merge; resume parked workers on approval
 *   maybeReviveForNewPRs    a done worker's ticket gained a new PR -> resurrect
 *   reapStaleRenderSessions kill zombie zmx sessions older than the timeout
 */

import { join } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { WorkerCheckpoint } from "./types";
import { appendEvent, ensureState, liveAgentStatus, readCCConfig, readWorkerCheckpoints, writeJson } from "./state";
import { gatherFacts, firstUntrackedPr, discoverOpenPrsForTicket } from "./facts";
import { decideVerdict } from "./verdict";
import { buildRenderPrompt, DELEGATE_TEMPLATE } from "./render";
import { spawnRenderRpc } from "./spawns";

const execFileAsync = promisify(execFile);

/**
 * runVerdictCycle — the code-verdicts heart. For each worker past the wake-up
 * cadence: gather deterministic facts, decide via the pure function, apply
 * state verdicts DIRECTLY (no LLM), spawn the render worker only when the
 * verdict needs a message composed.
 */
export async function runVerdictCycle(ctx: { cwd: string }): Promise<void> {
  const config = await readCCConfig(ctx.cwd);
  const checkpoints = await readWorkerCheckpoints(ctx.cwd);
  const paths = await ensureState(ctx.cwd);
  const now = Date.now();

  for (const w of checkpoints) {
    if (!w.linear_issue_id) continue;
    if (w.status === "done" || w.status === "failed") continue;
    const ageMin = (now - new Date(w.updated_at).getTime()) / 60000;
    if (Number.isNaN(ageMin) || ageMin < config.wakeups.staleMinutes) continue;
    if (w.check_in_progress_at) {
      const inflightMin = (now - new Date(w.check_in_progress_at).getTime()) / 60000;
      if (inflightMin < config.wakeups.checkTimeoutMinutes) continue;
    }

    // v3 PR-discovery backfill: a worker launched without PR linkage is blind
    // (render workers never gather). Discover the ticket's open PRs once and
    // persist the linkage; highest PR number = stack top (merge-retire anchor).
    if (
      !w.scan_prs?.length &&
      !w.expected_pr &&
      !w.evidence?.pr &&
      w.linear_issue_id &&
      w.evidence?.repo
    ) {
      try {
        const found = await discoverOpenPrsForTicket(w.linear_issue_id, w.evidence.repo);
        if (found.length) {
          const top = found.reduce((a, b) => (Number(b.number) > Number(a.number) ? b : a));
          w.scan_prs = found.map((f) => f.url);
          w.expected_pr = `#${top.number}`;
          w.evidence.pr = top.url;
          await appendEvent(ctx.cwd, {
            type: "prs_discovered",
            worker_id: w.worker_id,
            prs: w.scan_prs,
          });
        }
      } catch {
        // discovery failed — worker stays as-is; retried next cycle
      }
    }

    let facts: Awaited<ReturnType<typeof gatherFacts>>;
    let verdict;
    // Claim the worker BEFORE gathering (facts take seconds) — concurrent tick
    // instances holding the same stale snapshot must not double-run this worker
    // (the 16s-apart duplicate FIX_CI race). On failure, release the claim.
    const claimPath = join((await ensureState(ctx.cwd)).workersDir, `${w.worker_id}.json`);
    w.check_in_progress_at = new Date().toISOString();
    await writeJson(claimPath, w);
    try {
      facts = await gatherFacts(w as never);
      verdict = decideVerdict(facts, w as never);
    } catch (error) {
      w.check_in_progress_at = null;
      w.updated_at = new Date().toISOString();
      await writeJson(claimPath, w);
      await appendEvent(ctx.cwd, {
        type: "verdict_cycle_failed",
        worker_id: w.worker_id,
        error: error instanceof Error ? error.message : String(error),
      });
      continue;
    }

    const checkpointPath = join(paths.workersDir, `${w.worker_id}.json`);

    // Apply the verdict's checkpoint writes verbatim.
    for (const [k, v] of Object.entries(verdict.writes)) {
      (w as unknown as Record<string, unknown>)[k] = v;
    }
    if (verdict.needsYou) {
      w.proposed_action = verdict.needsYou.message;
      if (!verdict.writes.summary) w.summary = verdict.reason;
    }
    w.updated_at = new Date().toISOString();

    if (!verdict.needsRender) {
      // State-only verdicts: the tick acts alone. FIX_CI is deterministic —
      // post "/fix-ci" verbatim, no LLM ever involved.
      if (verdict.verdict === "FIX_CI") {
        try {
          await execFileAsync(
            "linear",
            ["issue", "comment", "add", w.linear_issue_id, "--body", "/fix-ci"],
            { timeout: 15_000 },
          );
          w.last_nudge_at = new Date().toISOString();
          w.action = "FIX_CI";
          await appendEvent(ctx.cwd, { type: "fix_ci_sent", worker_id: w.worker_id });
        } catch (error) {
          await appendEvent(ctx.cwd, {
            type: "fix_ci_failed",
            worker_id: w.worker_id,
            error: error instanceof Error ? error.message : String(error),
          });
        }
      }
      w.check_in_progress_at = null;
      await writeJson(checkpointPath, w);
      await appendEvent(ctx.cwd, {
        type: "verdict_applied",
        worker_id: w.worker_id,
        verdict: verdict.verdict,
        reason: verdict.reason,
      });
      continue;
    }

    // Render verdicts: spawn the SLIM render-only worker (step 3). The tick
    // decided; the worker composes, posts, flushes, and classifies. Non-DELEGATE
    // renders run on the cheap nudge tier.
    w.check_in_progress_at = new Date().toISOString();
    // Bookkeeping at spawn (render workers touch only reply_class): this arms
    // the guarded() loop-guard so the same verdict can't be re-rendered in a
    // loop — the spam-regression fix.
    w.last_nudge_at = new Date().toISOString();
    w.action = verdict.verdict;
    await writeJson(checkpointPath, w);
    const isDelegate = verdict.verdict === "DELEGATE";
    const agentName = w.agent_name ?? config.agent.name;
    const prompt = buildRenderPrompt({
      workerId: w.worker_id,
      ticket: w.linear_issue_id,
      agentName,
      verdict: verdict.verdict,
      reason: verdict.reason,
      facts,
      checkpointPath,
      eventsPath: paths.eventsFile,
      delegateTemplate: isDelegate
        ? DELEGATE_TEMPLATE(w.linear_issue_id, agentName)
        : undefined,
    });
    try {
      const rpc = await spawnRenderRpc({
        workerId: `${w.worker_id}-render-${now.toString(36)}`,
        cwd: w.evidence?.repo ?? ctx.cwd,
        model: isDelegate ? config.models.check.model : config.models.nudge.model,
        thinking: isDelegate ? config.models.check.thinking : config.models.nudge.thinking,
        prompt,
        timeoutMs: 5 * 60_000,
      });
      await appendEvent(ctx.cwd, {
        type: "render_worker_spawned",
        worker_id: w.worker_id,
        verdict: verdict.verdict,
        tier: isDelegate ? "check" : "nudge",
        transport: "rpc",
        settled: rpc.settled,
        timedOut: rpc.timedOut,
        lastEvent: rpc.lastEvent,
      });
    } catch (error) {
      await appendEvent(ctx.cwd, {
        type: "check_worker_spawn_failed",
        worker_id: w.worker_id,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }
}


export const reapThrottleMs = 60_000;
let lastReapAt = 0;

/**
 * Watchdog (flaw #14): render/check workers can hang (stalled model call,
 * blocked CLI). zmx keeps their PTYs alive forever. Kill any zmx session
 * named *-render-* / *-check-* that never ended and is older than 20 min.
 */

/**
 * Watchdog (flaw #14): render/check workers can hang (stalled model call,
 * blocked CLI). zmx keeps their PTYs alive forever. Kill any zmx session
 * named *-render-* / *-check-* that never ended and is older than 20 min.
 */
export async function reapStaleRenderSessions(): Promise<void> {
  const now = Date.now();
  if (now - lastReapAt < reapThrottleMs) return;
  lastReapAt = now;
  try {
    const { stdout } = await execFileAsync("zmx", ["list"], { timeout: 8_000 });
    for (const line of stdout.split("\n")) {
      const nameM = line.match(/name=([^\s]+)/);
      const createdM = line.match(/created=(\d+)/);
      if (!nameM || !createdM) continue;
      const name = nameM[1]!;
      if (!/-render-|-check-/.test(name)) continue;
      if (line.includes("ended=")) continue; // already exited — not a leak
      const ageMin = (now - Number(createdM[1]) * 1000) / 60_000;
      if (ageMin < 20) continue;
      try {
        await execFileAsync("zmx", ["kill", name], { timeout: 8_000 });
        console.log(`[cc-reaper] killed stale worker session ${name} (age ${Math.round(ageMin)}m)`);
      } catch {
        // already dead
      }
    }
  } catch {
    // zmx unavailable — skip this window
  }
}


export async function maybeSpawnCheckWorkers(ctx: { cwd: string }): Promise<void> {
  const config = await readCCConfig(ctx.cwd);
  const checkpoints = await readWorkerCheckpoints(ctx.cwd);
  const paths = await ensureState(ctx.cwd);
  const now = Date.now();

  for (const w of checkpoints) {
    if (!w.linear_issue_id || w.status !== "working") continue;
    const staleMin = (now - new Date(w.updated_at).getTime()) / 60000;
    if (Number.isNaN(staleMin) || staleMin < config.wakeups.staleMinutes) continue;
    if (w.check_in_progress_at) {
      const inflightMin = (now - new Date(w.check_in_progress_at).getTime()) / 60000;
      if (inflightMin < config.wakeups.checkTimeoutMinutes) continue;
    }

    // Deterministic repeat_failures — the tick owns this counter, not the
    // check-worker LLM. Same failing check on consecutive ticks → +1;
    // green or a different failure → reset to 0.
    const sig =
      w.ci_state === "red" ? (w.ci_failure_signature || "unknown") : null;
    const prevSig = w.last_observed_failure_signature ?? null;
    w.repeat_failures = sig && sig === prevSig ? (w.repeat_failures ?? 0) + 1 : 0;
    w.last_observed_failure_signature = sig;

    w.check_in_progress_at = new Date().toISOString();
    const checkpointPath = join(paths.workersDir, `${w.worker_id}.json`);
    await writeJson(checkpointPath, w);

    const prompt = buildCheckWorkerPrompt({
      workerId: w.worker_id,
      ticket: w.linear_issue_id,
      agentName: w.agent_name ?? config.agent.name,
      expectedPr: w.expected_pr,
      basePr: w.base_pr,
      scanPrs: w.scan_prs ?? (w.evidence?.pr ? [w.evidence.pr] : []),
      repoPath: w.evidence?.repo ?? ctx.cwd,
      checkpointPath,
      eventsPath: paths.eventsFile,
      firstRun: false,
      doNotRename: w.do_not_rename,
      knownRepoQuirks: w.known_repo_quirks,
    });

    try {
      await spawnWorkerPi({
        workerId: `${w.worker_id}-check-${now.toString(36)}`,
        cwd: w.evidence?.repo ?? ctx.cwd,
        stateCwd: ctx.cwd,
        model: config.models.check.model,
        thinking: config.models.check.thinking,
        prompt,
      });
      await appendEvent(ctx.cwd, { type: "check_worker_spawned", worker_id: w.worker_id });
    } catch (error) {
      await appendEvent(ctx.cwd, {
        type: "check_worker_spawn_failed",
        worker_id: w.worker_id,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }
}


export const reviveSearched = new Map<string, number>();

/**
 * maybeReviveForNewPRs — a done worker's lifecycle belongs to the TICKET, not
 * to the merged PR that retired it. If a new open PR referencing the ticket
 * appears later, resurrect the worker: done → working, re-anchored onto the
 * new PR (merged refs pruned from scan_prs so auto-close won't insta-retire).
 */

/**
 * maybeReviveForNewPRs — a done worker's lifecycle belongs to the TICKET, not
 * to the merged PR that retired it. If a new open PR referencing the ticket
 * appears later, resurrect the worker: done → working, re-anchored onto the
 * new PR (merged refs pruned from scan_prs so auto-close won't insta-retire).
 */
export async function maybeReviveForNewPRs(cwd: string): Promise<void> {
  const checkpoints = await readWorkerCheckpoints(cwd);
  const paths = await ensureState(cwd);
  const now = Date.now();

  for (const w of checkpoints) {
    if (w.status !== "done" || !w.linear_issue_id || !w.evidence?.repo) continue;
    const prev = reviveSearched.get(w.worker_id);
    if (prev && now - prev < 60_000) continue;
    reviveSearched.set(w.worker_id, now);

    const repoPath = w.evidence.repo;
    const opts = { cwd: repoPath, timeout: 10_000, maxBuffer: 1024 * 1024 };
    try {
      const { stdout: repoOut } = await execFileAsync(
        "gh",
        ["repo", "view", "--json", "nameWithOwner", "-q", ".nameWithOwner"],
        opts,
      );
      const fullName = repoOut.trim();
      if (!fullName) continue;
      const { stdout: searchOut } = await execFileAsync(
        "gh",
        ["search", "prs", w.linear_issue_id, "--repo", fullName, "--state", "open", "--json", "number,url", "--limit", "10"],
        opts,
      );
      const results = JSON.parse(searchOut) as Array<{ number: number; url: string }>;
      const fresh = firstUntrackedPr(results, [
        w.expected_pr,
        w.evidence.pr,
        ...(w.scan_prs ?? []),
      ]);
      if (!fresh) continue;

      const knownScan = (w.scan_prs ?? []).filter((ref) => ref !== fresh.url);
      w.status = "working";
      w.action = "REVIVED";
      w.expected_pr = `#${fresh.number}`;
      w.evidence.pr = fresh.url;
      w.scan_prs = [fresh.url, ...knownScan];
      w.summary = `New PR #${fresh.number} on ${w.linear_issue_id} — reviving supervision (merged refs pruned)`;
      w.updated_at = new Date().toISOString();
      w.check_in_progress_at = null;
      await writeJson(join(paths.workersDir, `${w.worker_id}.json`), w);
      await appendEvent(cwd, {
        type: "worker_revived",
        worker_id: w.worker_id,
        ticket: w.linear_issue_id,
        pr: `#${fresh.number}`,
      });
    } catch {
      // search failed (private repo/permissions/rate) — retry next window
    }
  }
}


export const prMergeChecked = new Map<string, number>();

/** Tick-level (no LLM): if a worker's PR is merged, auto-close the worker. */

/** Tick-level (no LLM): if a worker's PR is merged, auto-close the worker. */
export async function autoCloseMergedWorkers(cwd: string): Promise<void> {
  const checkpoints = await readWorkerCheckpoints(cwd);
  const paths = await ensureState(cwd);
  for (const w of checkpoints) {
    if (w.status === "done" || w.status === "failed") continue;
    // Multi-PR tickets: retire only when EVERY PR in the scan set is merged or
    // closed (a closed-without-merge PR like a deferred slice is terminal too).
    // Closing on the anchor alone would retire the worker while live stack
    // siblings still need supervision.
    const prUrls = [...new Set([w.expected_pr || w.evidence?.pr, ...(w.scan_prs ?? [])].filter(Boolean))] as string[];
    type PrRef = { num: string; owner?: string; repo?: string };
    const prRefs: PrRef[] = [];
    for (const url of prUrls) {
      const num = url.match(/(\d+)/)?.[1];
      if (!num) continue;
      const m = /github\.com\/([^/]+)\/([^/]+)\/pull\//.exec(url);
      prRefs.push({ num, ...(m ? { owner: m[1], repo: m[2] } : {}) });
    }
    if (!prRefs.length) continue;
    const repo = w.evidence?.repo;
    if (!repo && prRefs.some((r) => !r.owner)) continue;
    const prev = prMergeChecked.get(w.worker_id);
    if (prev && Date.now() - prev < 60_000) continue;
    prMergeChecked.set(w.worker_id, Date.now());
    try {
      const states: Record<string, { state?: string; mergedAt?: string | null }> = {};
      for (const ref of prRefs) {
        const ghArgs = ["pr", "view", ref.num, "--json", "state,mergedAt,reviewDecision"];
        if (!repo && ref.owner) ghArgs.push("-R", `${ref.owner}/${ref.repo}`);
        const { stdout } = await execFileAsync("gh", ghArgs, {
          cwd: repo,
          timeout: 10_000,
        });
        states[ref.num] = JSON.parse(stdout) as {
          state?: string;
          mergedAt?: string | null;
          reviewDecision?: string;
        };
      }
      const allTerminal = prRefs.every(
        (ref) => states[ref.num]?.state === "MERGED" || states[ref.num]?.state === "CLOSED",
      );
      const anchor = w.expected_pr || w.evidence?.pr;
      const anchorNum = anchor?.match(/(\d+)/)?.[1];
      const anchorState = anchorNum ? states[anchorNum] : undefined;
      if (allTerminal && anchorState?.state === "MERGED") {
        w.status = "done";
        w.action = "MERGED";
        w.summary = `All tracked PRs merged/closed; ${anchor} merged ${anchorState.mergedAt ?? ""} — auto-closed`.trim();
        w.updated_at = new Date().toISOString();
        w.check_in_progress_at = null;
        await writeJson(join(paths.workersDir, `${w.worker_id}.json`), w);
        liveAgentStatus.delete(w.worker_id);
        await appendEvent(cwd, { type: "worker_auto_closed", worker_id: w.worker_id, pr: anchor, reason: "all_prs_terminal" });
      } else if (
        w.status === "landing" &&
        anchorState?.state === "OPEN" &&
        anchorState?.reviewDecision === "APPROVED"
      ) {
        // Review landed while parked → resume wake-ups (worker will surface merge-approval).
        w.status = "working";
        w.action = "RESUMED";
        w.summary = `Review approved on ${anchor} — resuming supervision for merge-approval`;
        w.updated_at = new Date().toISOString();
        await writeJson(join(paths.workersDir, `${w.worker_id}.json`), w);
        await appendEvent(cwd, { type: "worker_reconciled", worker_id: w.worker_id, to: "working", reason: "review_approved" });
      }
    } catch {
      // ignore; retry next window
    }
  }
}

/** Mark a worker done and drop it from the boards. */

export async function probeAgentSessions(cwd: string): Promise<void> {
  const checkpoints = await readWorkerCheckpoints(cwd);
  const paths = await ensureState(cwd);
  for (const w of checkpoints) {
    if (!w.linear_issue_id) continue;
    if (!(w.status === "working" || w.status === "awaiting_approval" || w.status === "blocked" || w.status === "landing")) continue;
    const prev = liveAgentStatus.get(w.worker_id);
    if (prev && Date.now() - prev.checkedAt < 60_000) continue;
    try {
      const { stdout } = await execFileAsync(
        "linear",
        ["api", `query { issue(id:"${w.linear_issue_id}") { agentSessions { nodes { status updatedAt } } } }`],
        { timeout: 8000, maxBuffer: 1024 * 1024 },
      );
      const nodes: Array<{ status: string; updatedAt?: string }> =
        JSON.parse(stdout)?.data?.issue?.agentSessions?.nodes ?? [];
      nodes.sort((a, b) => (a.updatedAt ?? "").localeCompare(b.updatedAt ?? ""));
      const latest = nodes[nodes.length - 1];
      if (latest) {
        liveAgentStatus.set(w.worker_id, {
          status: latest.status,
          activityAt: latest.updatedAt,
          checkedAt: Date.now(),
        });
        // Reconcile a stale "needs you" checkpoint: if the agent is actively working
        // again, it is no longer waiting on you — move it back to In Flight.
        if (
          (w.status === "awaiting_approval" || w.status === "blocked") &&
          /active/i.test(latest.status)
        ) {
          w.status = "working";
          w.summary = `Agent resumed (${latest.status}) — no longer awaiting you`;
          w.updated_at = new Date().toISOString();
          await writeJson(join(paths.workersDir, `${w.worker_id}.json`), w);
          await appendEvent(cwd, { type: "worker_reconciled", worker_id: w.worker_id, to: "working" });
        }
        // Landing lane: agent finished + PR open + review still required + commit
        // gates pass (single, verified) → park it. Stops pointless WAIT wake-ups;
        // the cheap probe below keeps watching it and unparks on any change.
        if (w.status === "working" && /complete/i.test(latest.status)) {
          const pr = w.expected_pr || w.evidence?.pr || "";
          const prNum = pr.match(/(\d+)/)?.[1];
          if (prNum && w.evidence?.repo) {
            try {
              const { stdout: prOut } = await execFileAsync(
                "gh",
                ["pr", "view", prNum, "--json", "state,reviewDecision,mergeStateStatus,commits"],
                { cwd: w.evidence.repo, timeout: 8000, maxBuffer: 4 * 1024 * 1024 },
              );
              const p = JSON.parse(prOut) as {
                state?: string;
                reviewDecision?: string;
                mergeStateStatus?: string;
                commits?: Array<{ commit?: { verification?: { verified?: boolean | null } } }>;
              };
              const commitOk =
                (p.commits?.length ?? 0) === 1 &&
                (p.commits ?? []).every((c) => c?.commit?.verification?.verified === true);
              if (
                p.state === "OPEN" &&
                p.reviewDecision === "REVIEW_REQUIRED" &&
                p.mergeStateStatus !== "DIRTY" &&
                commitOk
              ) {
                w.status = "landing";
                w.action = "LANDING";
                w.summary = `Agent finished — PR #${prNum} awaits human review (parked, probe keeps watching)`;
                w.updated_at = new Date().toISOString();
                await writeJson(join(paths.workersDir, `${w.worker_id}.json`), w);
                await appendEvent(cwd, { type: "worker_landing", worker_id: w.worker_id, pr: prNum });
              }
            } catch {
              // keep working
            }
          }
        }
        // Landing guard: parked workers are still watched here (no LLM) — unpark
        // the moment anything changes: new review comments, unsigned/multiple
        // commits, CI dirty, review approved (approved also handled in auto-close).
        if (w.status === "landing") {
          const pr = w.expected_pr || w.evidence?.pr || "";
          const prNum = pr.match(/(\d+)/)?.[1];
          const repoPath = w.evidence?.repo;
          if (prNum && repoPath) {
            const opts = { cwd: repoPath, timeout: 8000, maxBuffer: 4 * 1024 * 1024 };
            try {
              const { stdout: prOut } = await execFileAsync(
                "gh",
                ["pr", "view", prNum, "--json", "state,reviewDecision,mergeStateStatus,commits"],
                opts,
              );
              const p = JSON.parse(prOut) as {
                state?: string;
                reviewDecision?: string;
                mergeStateStatus?: string;
                commits?: Array<{ commit?: { verification?: { verified?: boolean | null } } }>;
              };
              const commitOk =
                (p.commits?.length ?? 0) === 1 &&
                (p.commits ?? []).every((c) => c?.commit?.verification?.verified === true);
              const ciOk = p.mergeStateStatus !== "DIRTY";
              const stillParked = p.state === "OPEN" && p.reviewDecision === "REVIEW_REQUIRED" && ciOk && commitOk;
              if (!stillParked) {
                w.status = "working";
                w.action = "UNPARKED";
                w.summary = !commitOk
                  ? `Unparked: PR #${prNum} commit not single+verified — wake-up will demand squash+sign`
                  : !ciOk
                    ? `Unparked: CI dirty on PR #${prNum} — wake-up will fire FIX_CI`
                    : `Unparked: PR #${prNum} review state changed — resuming supervision`;
                w.updated_at = new Date().toISOString();
                await writeJson(join(paths.workersDir, `${w.worker_id}.json`), w);
                await appendEvent(cwd, { type: "worker_unparked", worker_id: w.worker_id, pr: prNum });
              } else {
                // No PR-state change — check for NEW review comments since we parked.
                try {
                  const { stdout: repoOut } = await execFileAsync(
                    "gh",
                    ["repo", "view", "--json", "nameWithOwner", "-q", ".nameWithOwner"],
                    opts,
                  );
                  const fullName = repoOut.trim();
                  const { stdout: cmOut } = await execFileAsync(
                    "gh",
                    ["api", `repos/${fullName}/pulls/${prNum}/comments`, "--paginate", "--jq", "max_by(.created_at).created_at"],
                    opts,
                  );
                  const latest = cmOut.trim().split("\n").filter((l) => l && l !== "null").sort().pop();
                  if (latest && Date.parse(latest) > Date.parse(w.updated_at)) {
                    w.status = "working";
                    w.action = "UNPARKED";
                    w.summary = `Unparked: new review comments on PR #${prNum} — wake-up will address threads`;
                    w.updated_at = new Date().toISOString();
                    await writeJson(join(paths.workersDir, `${w.worker_id}.json`), w);
                    await appendEvent(cwd, { type: "worker_unparked", worker_id: w.worker_id, pr: prNum, reason: "new_review_comments" });
                  }
                } catch {
                  // comment scan failed; stay parked
                }
              }
            } catch {
              // keep parked
            }
          }
        }
      }
    } catch {
      // keep previous reading
    }

    // Reconcile a worker parked in awaiting_approval when NEW review comments
    // land on its PR. "Waiting on human codeowner review" must never be a
    // parked state: parked workers are never scanned for review threads, and
    // reviewers can leave actionable comments at any time.
    if (w.status === "awaiting_approval" && w.evidence?.pr) {
      // Multi-PR tickets: check every PR the worker scans (scan_prs, plus the
      // auto-close anchor) — a comment on ANY slice of the stack is a wake-up.
      const prUrls = [...new Set([...(w.scan_prs ?? []), w.evidence.pr].filter(Boolean))];
      type PrRef = { owner: string; repo: string; prNum: string };
      const prRefs: PrRef[] = [];
      for (const url of prUrls) {
        const m = /github\.com\/([^/]+)\/([^/]+)\/pull\/(\d+)/.exec(url);
        if (m) prRefs.push({ owner: m[1], repo: m[2], prNum: m[3] });
      }
      let newestCommentAt: string | undefined;
      let newestPrNum: string | undefined;
      try {
        for (const ref of prRefs) {
          const latestPerSource: string[] = [];
          // Review threads (inline) and PR conversation comments are both wake-up
          // signals — the scanner historically only watched the former.
          for (const endpoint of [`pulls`, `issues`]) {
            try {
              const { stdout: ghOut } = await execFileAsync(
                "gh",
                [
                  "api",
                  `repos/${ref.owner}/${ref.repo}/${endpoint}/${ref.prNum}/comments`,
                  "--paginate",
                  "--jq",
                  "max_by(.created_at).created_at",
                ],
                { timeout: 8000, maxBuffer: 1024 * 1024 },
              );
              // --paginate prints one max per page; ISO strings sort chronologically.
              const latest = ghOut
                .trim()
                .split("\n")
                .filter((l) => l && l !== "null")
                .sort()
                .pop();
              if (latest) latestPerSource.push(latest);
            } catch {
              // endpoint not readable; try the other
            }
          }
          const latest = latestPerSource.sort().pop();
          if (latest && (!newestCommentAt || latest > newestCommentAt)) {
            newestCommentAt = latest;
            newestPrNum = ref.prNum;
          }
        }
        if (
          newestCommentAt &&
          newestPrNum &&
          Date.parse(newestCommentAt) > Date.parse(w.updated_at)
        ) {
          w.status = "working";
          w.summary = `New review comments on PR #${newestPrNum} landed after ${w.updated_at} — woke from awaiting_approval`;
          // Deliberately NOT refreshing updated_at: the wake-up tick's
          // staleMinutes gate keys off it, and we want an immediate spawn.
          await writeJson(join(paths.workersDir, `${w.worker_id}.json`), w);
          await appendEvent(cwd, {
            type: "worker_reconciled",
            worker_id: w.worker_id,
            to: "working",
            reason: "new_review_comments",
          });
        }
      } catch {
        // keep parked
      }
    }
  }
}
