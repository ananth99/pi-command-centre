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
  reply_class_at?: string;
  reply_class_pr?: string;
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
const START_GRACE_MS = 15 * 60_000;
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
  //
  // The latch must EXPIRE. This rule outranks everything, and the only other
  // thing that clears reply_class is a human reply (actions.ts), so a stale
  // classification used to freeze a worker permanently — re-applying
  // BLOCKED_IMPOSSIBILITY every tick while the world moved on. It is now scoped
  // to the activity it came from and the PR it was about: if the agent has
  // spoken since, or the worker was repointed, the verdict no longer applies.
  const classStaleByActivity =
    !!checkpoint.reply_class_at &&
    !!facts.lastActivityAt &&
    Date.parse(facts.lastActivityAt) > Date.parse(checkpoint.reply_class_at);
  const classStaleByPr =
    !!checkpoint.reply_class_pr &&
    !!checkpoint.expected_pr &&
    checkpoint.reply_class_pr !== checkpoint.expected_pr;
  if (checkpoint.reply_class === "cannot_do" && !classStaleByActivity && !classStaleByPr) {
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
      facts.unresolvedThreadIds.length === 0 &&
      (facts.humanLastWordThreadIds ?? []).length === 0;
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
    // A commit whose verification READ FAILED is unknown, not unsigned. Acting on
    // it nags the agent about a signature that may be perfectly valid — the
    // false-SIGN_SQUASH class that cost SCAAS-11715 six renders and three unparks.
    // Unknown signature → skip rule 4 this tick; the next tick re-reads.
    // Also unknown: an empty list. A failed GraphQL commit fetch yields [],
    // and `length !== 1` would then accuse the agent of having 0 commits
    // (need exactly 1) — a fabricated SIGN_SQUASH.
    const signatureUnknown =
      pr.commits.length === 0 || pr.commits.some((c) => c.verificationKnown === false);
    if (signatureUnknown) continue;
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
        facts,
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
      facts,
    );
  }

  // ── 5. Branch naming convention — ESCALATE, never auto-rename.
  //
  // Renaming is cosmetic; orphaning the pull request is catastrophic and
  // irreversible. The agent's rename implementation pushes a new branch and
  // deletes the old one, which closes the PR (bitgo/ai-agent #892, #3315,
  // #903; SCAAS-11150, and the orphaned stacks on 11714/11715/11716). CC used
  // to demand renames because its own conformance check rejected every branch
  // (empty CC_BRANCH_OWNER) — that root cause is fixed, and this rule now
  // surfaces the rare genuine offender to the human instead of acting on it.
  const badBranch = open.find((p) => !p.branchConforming);
  if (badBranch && !checkpoint.do_not_rename) {
    return guarded(
      {
        verdict: "ASK",
        reason: `PR #${badBranch.num}: branch ${badBranch.headRefName} doesn't match <owner>/${facts.ticket}-<desc>`,
        needsRender: true,
        needsYou: {
          priority: "P3",
          message: `${checkpoint.worker_id}: branch name on PR #${badBranch.num} ("${badBranch.headRefName}") is off-convention — rename it yourself via the GitHub API, or accept it (CC will not rename; renaming orphans the PR)`,
        },
        writes: { do_not_rename: true, ...baseWrites(true) },
      },
      checkpoint,
      now,
      facts,
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
        facts,
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
      facts,
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
    (facts.unresolvedThreadIds.length > 0 || (facts.humanLastWordThreadIds ?? []).length > 0) &&
    facts.sessionStatus === "active"
  ) {
    return {
      verdict: "WAIT",
      reason: "CHANGES_REQUESTED review — platform auto-triggers the agent; CC hands-off",
      needsRender: false,
      writes: { wait_streak: (checkpoint.wait_streak ?? 0) + 1 },
    };
  }

  // ── 7. Review threads needing a reply.
  //    Two kinds: genuinely unresolved, and resolved threads whose last word was
  //    a human's. The second kind is invisible everywhere else — GitHub does not
  //    reopen a thread when you reply to it, so a question can sit unanswered
  //    forever (SCAAS-11576: ananth99 asked on #5599 and CC never saw it because
  //    it skipped every resolved thread).
  const openThreads = facts.unresolvedThreadIds.length;
  const humanLast = (facts.humanLastWordThreadIds ?? []).filter(
    (id) => !facts.unresolvedThreadIds.includes(id),
  ).length;
  if (openThreads > 0 || humanLast > 0) {
    const reason =
      openThreads && humanLast
        ? `${openThreads} unresolved + ${humanLast} resolved-with-a-human-question thread(s)`
        : openThreads
          ? `${openThreads} unresolved thread(s)`
          : `${humanLast} thread(s) resolved but the human had the last word — answer it`;
    return guarded(
      {
        verdict: "NUDGE_THREADS",
        reason,
        needsRender: true,
        writes: { ...baseWrites(true) },
      },
      checkpoint,
      now,
      facts,
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
      facts,
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
  // Rule 10 must agree with rule 3, or a parked worker oscillates: rule 3
  // unparks on unresolved threads, rule 10 re-parks without checking them, and
  // the pair ping-pongs forever (the 11576/11716 park-unpark pendulum). Threads
  // the agent must answer mean the work is not finished, so rule 10 declines.
  const parkable =
    facts.sessionStatus === "complete" &&
    open.length > 0 &&
    open.every((p) => p.commitOk) &&
    open.every((p) => p.reviewDecision === "REVIEW_REQUIRED") &&
    facts.unresolvedThreadIds.length === 0 &&
    (facts.humanLastWordThreadIds ?? []).length === 0 &&
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
  facts: WorkerFacts,
): VerdictResult {
  if (result.verdict !== (checkpoint.action as VerdictName)) return result;
  const since = recentNudgeMs(checkpoint, now);
  if (since === null || since > NUDE_LOOP_GUARD_MS) return result;
  // Give the agent time: platform commands (/fix-ci, nudges) queue before the
  // agent starts. Only a worker that has acted since the nudge and is idle
  // again with the problem unchanged is genuinely stuck.
  const nudgeAt = Date.parse(checkpoint.last_nudge_at ?? "");
  const actedAt = Date.parse(facts.lastActivityAt ?? "");
  const agentBusy = facts.sessionStatus === "active" || facts.sessionStatus === "pending";
  const notStartedYet = (Number.isNaN(actedAt) || actedAt <= nudgeAt) && since <= START_GRACE_MS;
  if (agentBusy || notStartedYet) {
    return {
      verdict: "WAIT",
      reason: `${result.verdict} sent ${Math.round(since / 60000)}m ago \u2014 ${agentBusy ? "agent is working on it" : "agent hasn't started yet"}`,
      needsRender: false,
      writes: { wait_streak: (checkpoint.wait_streak ?? 0) + 1 },
    };
  }
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