/**
 * verdict.ts — the pure decision function for the Command Centre loop.
 *
 * decideVerdict(facts, checkpoint) → { verdict, writes, needsRender, needsYou }
 *
 * Everything that used to be 200 lines of prose in the wake-up prompt
 * becomes ordered, unit-tested rules here. The LLM is only involved when
 * `needsRender` is true (composing a message); the tick applies state
 * verdicts (WAIT / LANDING / AUTO_CLOSE / UNPARK / STALLED) directly.
 *
 * Incident lessons encoded (see adr/ for the full list):
 *  - SIGN before review: re-signing rewrites the head and dismisses
 *    approvals, so signature/attribution outranks review nudges.
 *  - Human-approval gates are not CI failures (approval_pending).
 *  - The nudge loop guard: identical verdict + recent nudge + no state
 *    change → escalate, never re-nudge (the 14-comment spam incident).
 *  - Impossibility escalation: the agent said "I cannot" → blocked for
 *    the human, no re-nudges (the 5-day unsigned-commit orbit).
 *  - Stall detection: 5 consecutive WAITs → surfaced, not idled.
 */

import type { CiState, WorkerFacts } from "./facts";

export type VerdictName =
  | "DELEGATE"
  | "AUTO_CLOSE"
  | "SIGN_SQUASH"
  | "ATTRIBUTION_FIX"
  | "BRANCH_RENAME"
  | "FIX_CI"
  | "NUDGE_SPECIFIC"
  | "NUDGE_THREADS"
  | "REBASE"
  | "DONE_PENDING_APPROVAL"
  | "LANDING"
  | "UNPARK"
  | "BLOCKED_IMPOSSIBILITY"
  | "STALLED"
  | "ASK"
  | "WAIT";

export interface VerdictCheckpointShape {
  worker_id: string;
  status: string;
  action?: string;
  linear_issue_id?: string;
  expected_pr?: string;
  last_nudge_at?: string;
  /** Park time (or last checkpoint write) — used to detect new PR activity while landed. */
  updated_at?: string;
  wait_streak?: number;
  repeat_failures?: number;
  reply_class?: string;
  do_not_rename?: boolean;
  rename_attempts?: number;
}

export interface VerdictResult {
  verdict: VerdictName;
  reason: string;
  /** true → spawn the render worker to compose + post a message. */
  needsRender: boolean;
  needsYou?: { priority: "P1" | "P2" | "P3"; message: string };
  /** Checkpoint mutations the caller applies verbatim. */
  writes: Record<string, unknown>;
}

const NUDE_LOOP_GUARD_MS = 30 * 60_000;
const STALL_STREAK = 5;

function recentNudgeMs(checkpoint: VerdictCheckpointShape, now: number): number | null {
  if (!checkpoint.last_nudge_at) return null;
  const t = Date.parse(checkpoint.last_nudge_at);
  if (Number.isNaN(t)) return null;
  return now - t;
}

function baseWrites(waitStreakReset: boolean): Record<string, unknown> {
  return waitStreakReset ? { wait_streak: 0 } : {};
}

/**
 * Decide the next action for a worker given deterministic facts.
 * Pure: no I/O, no clock reads beyond the injected `now`.
 */
export function decideVerdict(
  facts: WorkerFacts,
  checkpoint: VerdictCheckpointShape,
  now: number = Date.now(),
): VerdictResult {
  const open = facts.prs.filter((p) => p.state === "OPEN");
  const anchor = open.find((p) => p.num === facts.anchorNum) ?? open[open.length - 1] ?? null;

  // ── 0. Impossibility: the agent explicitly said it cannot do the task.
  if (checkpoint.reply_class === "cannot_do") {
    return {
      verdict: "BLOCKED_IMPOSSIBILITY",
      reason: "agent declared the required action impossible",
      needsRender: false,
      needsYou: {
        priority: "P1",
        message: `${checkpoint.worker_id}: agent cannot proceed — human action required (see last agent reply on ${facts.ticket})`,
      },
      writes: { status: "blocked", ...baseWrites(true) },
    };
  }

  // ── 1. First run: delegate the ticket to the agent.
  if (!facts.sessionStatus && !checkpoint.action) {
    return {
      verdict: "DELEGATE",
      reason: "no agent session yet",
      needsRender: true,
      writes: { ...baseWrites(true) },
    };
  }

  // ── 2. Merged → retire.
  const mergedAnchor = facts.prs.find(
    (p) => p.num === facts.anchorNum && p.state === "MERGED",
  );
  if (mergedAnchor) {
    return {
      verdict: "AUTO_CLOSE",
      reason: `anchor PR #${mergedAnchor.num} merged`,
      needsRender: false,
      writes: { status: "done", action: "MERGED", ...baseWrites(true) },
    };
  }

  // ── 3. Parked (landing) but the world changed → unpark.
  if (checkpoint.status === "landing") {
    const parkTime = checkpoint.updated_at ? Date.parse(checkpoint.updated_at) : 0;
    const threadActivitySincePark = facts.prs.some((p) =>
      p.threads.some((t) => t.lastCommentAt && Date.parse(t.lastCommentAt) > parkTime),
    );
    const stillParkable =
      open.length > 0 &&
      open.every((p) => p.commitOk) &&
      facts.ciState !== "red" &&
      open.every((p) => p.reviewDecision === "REVIEW_REQUIRED") &&
      !threadActivitySincePark &&
      facts.unresolvedThreadIds.length === 0;
    if (!stillParkable) {
      const why = threadActivitySincePark
        ? "new review-thread activity since park"
        : facts.unresolvedThreadIds.length
          ? `${facts.unresolvedThreadIds.length} unresolved thread(s)`
          : "parking conditions no longer hold";
      return {
        verdict: "UNPARK",
        reason: why,
        needsRender: false,
        writes: {
          status: "working",
          action: "UNPARKED",
          summary: `Unparked: ${why} — resuming supervision`,
          ...baseWrites(true),
        },
      };
    }
    return {
      verdict: "WAIT",
      reason: "parked: awaiting human review, conditions unchanged",
      needsRender: false,
      writes: { wait_streak: (checkpoint.wait_streak ?? 0) + 1 },
    };
  }

  // ── 4. Signature & attribution — ABSOLUTE priority over review nudges
  //     (re-signing rewrites the head and dismisses approvals).
  for (const pr of open) {
    if (pr.commitOk) continue;
    const multi = pr.commits.length !== 1;
    const unsigned = pr.commits.length >= 1 && !pr.commits.every((c) => c.verified);
    if (multi || unsigned) {
      return guarded(
        {
          verdict: "SIGN_SQUASH",
          reason: `PR #${pr.num}: ${multi ? `${pr.commits.length} commits (need exactly 1)` : "head not REST-verified"}`,
          needsRender: true,
          writes: { ...baseWrites(true) },
        },
        checkpoint,
        now,
      );
    }
    // Single, verified, but missing human co-authorship (HITL attribution).
    return guarded(
      {
        verdict: "ATTRIBUTION_FIX",
        reason: `PR #${pr.num}: commit lacks human Co-authored-by attribution`,
        needsRender: true,
        writes: { ...baseWrites(true) },
      },
      checkpoint,
      now,
    );
  }

  // ── 5. Branch naming convention (bounded: escalate after 2 attempts).
  const badBranch = open.find((p) => !p.branchConforming);
  if (badBranch && !checkpoint.do_not_rename) {
    if ((checkpoint.rename_attempts ?? 0) >= 2) {
      return {
        verdict: "ASK",
        reason: `branch rename attempted ${(checkpoint.rename_attempts ?? 0)}x without success`,
        needsRender: true,
        needsYou: {
          priority: "P2",
          message: `${checkpoint.worker_id}: rename loop on PR #${badBranch.num} — decide: rename via GitHub API yourself or accept the name`,
        },
        writes: { ...baseWrites(true) },
      };
    }
    return guarded(
      {
        verdict: "BRANCH_RENAME",
        reason: `PR #${badBranch.num}: branch ${badBranch.headRefName} violates <owner>/<ticket>-<desc>`,
        needsRender: true,
        writes: { rename_attempts: (checkpoint.rename_attempts ?? 0) + 1, ...baseWrites(true) },
      },
      checkpoint,
      now,
    );
  }

  // ── 6. Real CI failures (human-approval gates are NOT CI — see facts).
  if (facts.ciState === "red") {
    if ((checkpoint.repeat_failures ?? 0) >= 2) {
      return guarded(
        {
          verdict: "NUDGE_SPECIFIC",
          reason: `CI red, same failure ${checkpoint.repeat_failures}x — send the log excerpt`,
          needsRender: true,
          writes: { ...baseWrites(true) },
        },
        checkpoint,
        now,
      );
    }
    return guarded(
      {
        verdict: "FIX_CI",
        reason: "CI red with fresh failure — /fix-ci",
        needsRender: false, // tick posts "/fix-ci" verbatim, no LLM needed
        writes: { ...baseWrites(true) },
      },
      checkpoint,
      now,
    );
  }

  // ── 6b. "Request changes" reviews are the PLATFORM's trigger now (2026-09-30
  //     capability: the agent platform auto-detects CHANGES_REQUESTED and addresses it).
  //     If threads exist AND a changes-requested review landed AND the agent
  //     session is active, CC stays hands-off — WAIT, no render, no duplicate
  //     nudge. Backstop below: if the session is NOT active, threads still
  //     escalate through the normal rules (platform trigger may have failed).
  const changesRequested = open.some((p) => p.reviewDecision === "CHANGES_REQUESTED");
  if (
    changesRequested &&
    facts.unresolvedThreadIds.length > 0 &&
    facts.sessionStatus === "active"
  ) {
    return {
      verdict: "WAIT",
      reason: "CHANGES_REQUESTED review — platform auto-triggers the agent; CC hands-off",
      needsRender: false,
      writes: { wait_streak: (checkpoint.wait_streak ?? 0) + 1 },
    };
  }

  // ── 7. Unresolved review threads (not in the addressed latch).
  if (facts.unresolvedThreadIds.length > 0) {
    return guarded(
      {
        verdict: "NUDGE_THREADS",
        reason: `${facts.unresolvedThreadIds.length} unresolved thread(s)`,
        needsRender: true,
        writes: { ...baseWrites(true) },
      },
      checkpoint,
      now,
    );
  }

  // ── 8. Stacked base moved (BEHIND) → rebase.
  if (open.some((p) => p.mergeStateStatus === "BEHIND")) {
    return guarded(
      {
        verdict: "REBASE",
        reason: "PR is behind its base — rebase",
        needsRender: true,
        writes: { ...baseWrites(true) },
      },
      checkpoint,
      now,
    );
  }

  // ── 9. Everything green on BOTH HITL gate heads → merge approval.
  const allGateGreen =
    open.length > 0 && open.every((p) => p.hitlGateOk) && facts.ciState !== "red";
  if (allGateGreen && facts.ciState !== "unknown") {
    return {
      verdict: "DONE_PENDING_APPROVAL",
      reason: `all gate heads green on ${open.map((p) => "#" + p.num).join(", ")}`,
      needsRender: false,
      needsYou: {
        priority: "P2",
        message: `${checkpoint.worker_id}: approve merge of ${facts.anchorNum ? "#" + facts.anchorNum : "the PR"} for ${facts.ticket}?`,
      },
      writes: { status: "awaiting_approval", action: "DONE", ...baseWrites(true) },
    };
  }

  // ── 10. Agent finished; PR open, attributed, clean — park it.
  const parkable =
    facts.sessionStatus === "complete" &&
    open.length > 0 &&
    open.every((p) => p.commitOk) &&
    open.every((p) => p.reviewDecision === "REVIEW_REQUIRED") &&
    (facts.ciState === "approval_pending" || facts.ciState === "green");
  if (parkable) {
    return {
      verdict: "LANDING",
      reason: "agent finished; PR awaits human review",
      needsRender: false,
      writes: {
        status: "landing",
        action: "LANDING",
        summary: `Agent finished — PR ${open.map((p) => "#" + p.num).join(", ")} awaits human review (parked)`,
        ...baseWrites(true),
      },
    };
  }

  // ── 11. Stall: five consecutive WAITs with no world change.
  if ((checkpoint.wait_streak ?? 0) >= STALL_STREAK) {
    return {
      verdict: "STALLED",
      reason: `${STALL_STREAK}+ consecutive WAITs with no state change`,
      needsRender: false,
      needsYou: {
        priority: "P2",
        message: `${checkpoint.worker_id}: stalled on ${facts.ticket} — waiting on ${waitingOn(facts, checkpoint)}; review manually or kill via alt+k`,
      },
      writes: { status: "awaiting_approval", action: "STALLED", ...baseWrites(true) },
    };
  }

  // ── 12. Default: hold.
  return {
    verdict: "WAIT",
    reason: "agent active / state unchanged",
    needsRender: false,
    writes: { wait_streak: (checkpoint.wait_streak ?? 0) + 1 },
  };
}

/**
 * The nudge loop guard: if this render-verdict was already sent recently
 * and nothing changed, escalate instead of re-posting (the 14-comment
 * spam incident on SCAAS-11150).
 */
function guarded(
  result: VerdictResult,
  checkpoint: VerdictCheckpointShape,
  now: number,
): VerdictResult {
  if (result.verdict !== (checkpoint.action as VerdictName)) return result;
  const since = recentNudgeMs(checkpoint, now);
  if (since === null || since > NUDE_LOOP_GUARD_MS) return result;
  return {
    verdict: "STALLED",
    reason: `loop guard: ${result.verdict} already sent ${Math.round(since / 60000)}m ago with no state change`,
    needsRender: false,
    needsYou: {
      priority: "P2",
      message: `${checkpoint.worker_id}: repeated ${result.verdict} is not landing (last sent ${Math.round(since / 60000)}m ago) — needs human judgment`,
    },
    writes: { status: "awaiting_approval", action: "STALLED", ...baseWrites(true) },
  };
}

function waitingOn(facts: WorkerFacts, checkpoint: VerdictCheckpointShape): string {
  if (facts.ciState === "approval_pending") return "human review";
  if (facts.sessionStatus === "awaitingInput") return "your reply to the agent";
  return `agent activity (session ${facts.sessionStatus ?? "unknown"})`;
}