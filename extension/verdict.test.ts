/**
 * verdict.test.ts — regression fixtures from real incidents.
 *
 * Each test case reproduces a state the live system got WRONG (or right,
 * at cost) and asserts the pure decision function now handles it cheaply
 * and deterministically.
 *
 * Run: node --experimental-strip-types --test verdict.test.ts
 */

import test from "node:test";
import assert from "node:assert/strict";
import { decideVerdict } from "./verdict.ts";
import { firstUntrackedPr } from "./facts.ts";
import { buildRenderPrompt, DELEGATE_TEMPLATE } from "./render.ts";
import type { WorkerFacts, PrFact } from "./facts.ts";

const NOW = Date.parse("2026-09-27T12:00:00Z");

function pr(over: Partial<PrFact> = {}): PrFact {
  return {
    num: "964",
    url: "https://github.com/acme/example-service/pull/964",
    state: "OPEN",
    mergeStateStatus: "BLOCKED",
    reviewDecision: "REVIEW_REQUIRED",
    headRefName: "owner/SCAAS-11159-recover-settled-share-receipts",
    branchConforming: true,
    commits: [
      {
        sha: "7eb8315a",
        authorName: "Supervisor",
        committerName: "example-bot",
        verified: true,
        coAuthoredByHuman: true,
      },
    ],
    commitOk: true,
    hitlGateOk: false,
    threads: [],
    ...over,
  };
}

function facts(over: Partial<WorkerFacts> = {}): WorkerFacts {
  return {
    workerId: "worker-11159",
    ticket: "SCAAS-11159",
    sessionStatus: "complete",
    lastActivityAt: "2026-09-27T11:40:00Z",
    prs: [pr()],
    anchorNum: "964",
    ciState: "approval_pending",
    unresolvedThreadIds: [],
    ...over,
  };
}

const cp = (over: Record<string, unknown> = {}) =>
  ({
    worker_id: "worker-11159",
    status: "working",
    action: undefined,
    linear_issue_id: "SCAAS-11159",
    expected_pr: "#964",
    ...over,
  }) as never;

test("incident: false-unsigned (#964) — REST-verified commit must NOT trigger SIGN_SQUASH", () => {
  // The GraphQL projection showed verified:null and prose CC treated it as
  // unsigned for days. facts built from REST say verified:true.
  const v = decideVerdict(facts(), cp({ action: "WAIT" }));
  assert.notEqual(v.verdict, "SIGN_SQUASH");
  assert.equal(v.verdict, "LANDING", "should park as awaiting review");
  assert.equal(v.needsRender, false);
  assert.equal(v.writes.status, "landing");
});

test("incident: parked on a broken PR (11159 arse-sitting) — landing + unsigned must UNPARK", () => {
  const f = facts({
    prs: [pr({ commitOk: false, commits: [{ sha: "x", authorName: "a", committerName: "b", verified: false, coAuthoredByHuman: false }] })],
    ciState: "approval_pending",
  });
  const v = decideVerdict(f, cp({ status: "landing", action: "LANDING" }));
  assert.equal(v.verdict, "UNPARK");
  assert.equal(v.writes.status, "working");
});

// The loop guard test vehicle: any RENDER verdict that can recur while the
// world is unchanged. BRANCH_RENAME can no longer serve (rule 5 now escalates
// instead of renaming), so use unresolved review threads.
const spamCase = (minsAgo: number, sess: string, activity: string) => {
  const f = facts({
    prs: [pr({ threads: [{ id: "t1", resolved: false, isBot: false }] })],
    sessionStatus: sess,
    lastActivityAt: activity,
    ciState: "unknown",
    unresolvedThreadIds: ["t1"],
  });
  const checkpoint = cp({
    action: "NUDGE_THREADS",
    last_nudge_at: new Date(NOW - minsAgo * 60_000).toISOString(),
    rename_attempts: 1,
  });
  return decideVerdict(f, checkpoint, NOW);
};

test("incident: 14-comment spam (11150) — agent silent past the grace window must escalate, not re-send", () => {
  const v = spamCase(20, "stale", "2026-09-27T11:40:00Z");
  assert.equal(v.verdict, "STALLED");
  assert.equal(v.needsRender, false, "must NOT render another nudge");
  assert.ok(v.needsYou, "must surface to the human");
});

test("incident: 11190 false stall — platform command still queued (<15m, agent not started) must WAIT", () => {
  const v = spamCase(10, "complete", "2026-09-27T11:40:00Z");
  assert.equal(v.verdict, "WAIT");
  assert.equal(v.needsRender, false);
  assert.equal(v.needsYou, undefined);
});

test("agent actively working on the nudge is never loop-guarded", () => {
  const v = spamCase(25, "active", new Date(NOW - 60_000).toISOString());
  assert.equal(v.verdict, "WAIT");
});

test("agent acted since the nudge, is idle again, problem unchanged → STALLED", () => {
  const v = spamCase(10, "complete", new Date(NOW - 2 * 60_000).toISOString());
  assert.equal(v.verdict, "STALLED");
});

test("incident: off-convention branch escalates to the human, NEVER auto-renames", () => {
  // Renaming orphans the PR (ai-agent #892/#3315/#903; 11714/11715/11716).
  // Renaming is cosmetic, orphaning is irreversible — so CC never renames.
  const f = facts({
    prs: [pr({ headRefName: "SCAAS-11150-order-read", branchConforming: false })],
    sessionStatus: "complete",
    ciState: "approval_pending",
  });
  const v = decideVerdict(f, cp({}), NOW);
  assert.equal(v.verdict, "ASK");
  assert.notEqual(v.verdict, "BRANCH_RENAME");
  assert.equal(v.writes.do_not_rename, true, "latches so it never re-asks");
  assert.ok(v.needsYou);
});

test("incident: unsigned commit outranks review — SIGN_SQUASH is absolute priority", () => {
  const f = facts({
    prs: [pr({
      commits: [
        { sha: "a1", authorName: "Agent", committerName: "example-bot", verified: false, coAuthoredByHuman: true },
      ],
      commitOk: false,
      threads: [{ id: "t1", kind: "review", lastCommentAt: "2026-09-27T10:00:00Z" }],
    })],
    unresolvedThreadIds: ["t1"],
    ciState: "red",
  });
  const v = decideVerdict(f, cp({ action: "WAIT" }), NOW);
  assert.equal(v.verdict, "SIGN_SQUASH", "signature outranks threads and CI");
});

test("incident: approval gate is NOT CI red — blocked-only-on-review never fires FIX_CI", () => {
  const f = facts({ ciState: "approval_pending" }); // derived by facts.deriveCiState
  const v = decideVerdict(f, cp({ action: "WAIT" }), NOW);
  assert.notEqual(v.verdict, "FIX_CI");
  assert.notEqual(v.verdict, "NUDGE_SPECIFIC");
});

test("incident: impossibility (5-day orbit) — reply_class=cannot_do → BLOCKED for human", () => {
  const f = facts({
    prs: [pr({ commitOk: false, commits: [{ sha: "x", authorName: "a", committerName: "b", verified: false, coAuthoredByHuman: false }] })],
    ciState: "unknown",
  });
  const v = decideVerdict(f, cp({ reply_class: "cannot_do", action: "SIGN_SQUASH" }), NOW);
  assert.equal(v.verdict, "BLOCKED_IMPOSSIBILITY");
  assert.equal(v.needsRender, false, "no more nudging an impossible action");
  assert.equal(v.needsYou?.priority, "P1");
  assert.equal(v.writes.status, "blocked");
});

test("incident: WAIT ocean (11159, 50 WAITs) — 5 consecutive WAITs escalate to STALLED", () => {
  const f = facts({
    sessionStatus: "active",
    prs: [],
    ciState: "unknown",
    anchorNum: null,
    unresolvedThreadIds: [],
  });
  const v = decideVerdict(f, cp({ action: "WAIT", wait_streak: 5 }), NOW);
  assert.equal(v.verdict, "STALLED");
  assert.ok(v.needsYou);
});

test("happy path: both gate heads green → DONE_PENDING_APPROVAL, no LLM", () => {
  const f = facts({
    ciState: "green",
    prs: [pr({ reviewDecision: "APPROVED", mergeStateStatus: "CLEAN", hitlGateOk: true })],
  });
  const v = decideVerdict(f, cp({ action: "WAIT" }), NOW);
  assert.equal(v.verdict, "DONE_PENDING_APPROVAL");
  assert.equal(v.needsRender, false);
  assert.equal(v.writes.status, "awaiting_approval");
  assert.match(v.needsYou?.message ?? "", /approve merge/i);
});

test("merged anchor retires the worker with zero renders", () => {
  const f = facts({
    prs: [pr({ state: "MERGED", reviewDecision: "APPROVED", hitlGateOk: true })],
  });
  const v = decideVerdict(f, cp({ action: "WAIT" }), NOW);
  assert.equal(v.verdict, "AUTO_CLOSE");
  assert.equal(v.writes.status, "done");
  assert.equal(v.needsRender, false);
});

test("first run with no agent session delegates", () => {
  const f = facts({ sessionStatus: null, prs: [] });
  const v = decideVerdict(f, cp({ action: undefined }), NOW);
  assert.equal(v.verdict, "DELEGATE");
  assert.equal(v.needsRender, true);
});

test("branch-conforming with slice suffix passes", () => {
  const f = facts({
    prs: [pr({ headRefName: "ananth/SCAAS-11159-glue" })],
  });
  const v = decideVerdict(f, cp({ action: "WAIT" }), NOW);
  assert.notEqual(v.verdict, "BRANCH_RENAME");
  assert.notEqual(v.verdict, "ASK");
});

test("render prompt: slim and obedient — no gather steps, no verdict table", () => {
  const p = buildRenderPrompt({
    workerId: "worker-11159",
    ticket: "SCAAS-11159",
    agentName: "the-agent",
    verdict: "SIGN_SQUASH",
    reason: "PR #964: head not REST-verified",
    facts: { prs: [{ num: "964", commits: [{ sha: "7eb8315a", verified: false }] }] },
    checkpointPath: "/tmp/cp.json",
    eventsPath: "/tmp/ev.jsonl",
  });
  assert.ok(p.includes("SIGN_SQUASH"), "carries the verdict");
  assert.ok(p.includes("7eb8315a"), "carries the facts");
  assert.ok(p.includes("reply_class"), "asks for the classification");
  assert.ok(p.includes("agentActivitySendQueued"), "asks for queue flush");
  assert.ok(!p.includes("Gather (Bash"), "must NOT gather");
  assert.ok(!p.includes("Verdict (EXACTLY ONE"), "must NOT decide");
  assert.ok(!p.includes("first match wins"), "no legacy verdict prose");
});

test("render prompt: DELEGATE carries the conventions template", () => {
  const tpl = DELEGATE_TEMPLATE("SCAAS-11159", "the-agent", "ananth");
  const p = buildRenderPrompt({
    workerId: "w",
    ticket: "SCAAS-11159",
    agentName: "the-agent",
    verdict: "DELEGATE",
    reason: "no agent session yet",
    facts: {},
    checkpointPath: "/tmp/cp.json",
    eventsPath: "/tmp/ev.jsonl",
    delegateTemplate: tpl,
  });
  assert.ok(p.includes("Co-authored-by: <SUPERVISOR_NAME>"));
  assert.ok(p.includes("ananth/SCAAS-11159"), "renders the real branch owner");
  assert.ok(p.includes("MULTI-PR SIZING"));
});

test("platform capability: CHANGES_REQUESTED + active agent → WAIT, no duplicate nudge render", () => {
  const f = facts({
    sessionStatus: "active",
    prs: [pr({ reviewDecision: "CHANGES_REQUESTED", mergeStateStatus: "BLOCKED" })],
    unresolvedThreadIds: ["t1", "t2", "t3"],
  });
  const v = decideVerdict(f, cp({ action: "WAIT" }), NOW);
  assert.equal(v.verdict, "WAIT");
  assert.equal(v.needsRender, false, "platform auto-triggers the agent — CC must not nudge");
});

test("platform backstop: CHANGES_REQUESTED + dead session still nudges threads", () => {
  const f = facts({
    sessionStatus: "stale",
    prs: [pr({ reviewDecision: "CHANGES_REQUESTED" })],
    unresolvedThreadIds: ["t1"],
  });
  const v = decideVerdict(f, cp({ action: "WAIT" }), NOW);
  assert.equal(v.verdict, "NUDGE_THREADS", "session not active — platform trigger failed, CC backstop fires");
  assert.equal(v.needsRender, true);
});

test("revival: a new open PR on a done ticket is detected", () => {
  const search = [
    { number: 964, url: "https://github.com/acme/x/pull/964" },
    { number: 1042, url: "https://github.com/acme/x/pull/1042" },
  ];
  // worker tracked #964 (merged, retired); #1042 is new
  const fresh = firstUntrackedPr(search, ["#964", "https://github.com/acme/x/pull/964"]);
  assert.equal(fresh?.number, "1042");
  assert.equal(fresh?.url, "https://github.com/acme/x/pull/1042");
});

test("revival: nothing new → stays retired (no churn)", () => {
  const search = [{ number: 964, url: "https://github.com/acme/x/pull/964" }];
  const fresh = firstUntrackedPr(search, ["#964"]);
  assert.equal(fresh, null);
});

test("fresh CI failure posts /fix-ci deterministically (no LLM)", () => {
  const f = facts({
    ciState: "red",
    prs: [pr({ mergeStateStatus: "DIRTY" })],
  });
  const v = decideVerdict(f, cp({ action: "WAIT" }), NOW);
  assert.equal(v.verdict, "FIX_CI");
  assert.equal(v.needsRender, false, "tick posts /fix-ci itself");
});
test("incident: unreadable signature is UNKNOWN, not unsigned — never a false SIGN_SQUASH", () => {
  // SCAAS-11715: a failed REST read recorded verified:false and the engine
  // demanded a re-sign of an already-signed commit, 6 times, each rewrite
  // cancelling CI. Unknown must skip the signature rule, not accuse.
  const f = facts({
    prs: [
      pr({
        commitOk: false,
        commits: [
          { sha: "7bea5e1e", authorName: "S", committerName: "bot", verified: false,
            verificationKnown: false, coAuthoredByHuman: true },
        ],
      }),
    ],
    ciState: "approval_pending",
  });
  const v = decideVerdict(f, cp({ action: "WAIT" }), NOW);
  assert.notEqual(v.verdict, "SIGN_SQUASH");
  assert.notEqual(v.verdict, "ATTRIBUTION_FIX");
});

test("a KNOWN-bad signature still fires SIGN_SQUASH", () => {
  const f = facts({
    prs: [
      pr({
        commitOk: false,
        commits: [
          { sha: "deadbeef", authorName: "S", committerName: "bot", verified: false,
            verificationKnown: true, coAuthoredByHuman: true },
        ],
      }),
    ],
    ciState: "approval_pending",
  });
  const v = decideVerdict(f, cp({ action: "WAIT" }), NOW);
  assert.equal(v.verdict, "SIGN_SQUASH");
});

test("incident: an EMPTY commit list is unknown, not '0 commits (need exactly 1)'", () => {
  // facts.ts reads the commit sha list via GraphQL; a failed fetch yields [].
  // `length !== 1` then reads as "multi" and fabricates a SIGN_SQUASH.
  const f = facts({ prs: [pr({ commitOk: false, commits: [] })], ciState: "approval_pending" });
  const v = decideVerdict(f, cp({ action: "WAIT" }), NOW);
  assert.notEqual(v.verdict, "SIGN_SQUASH");
});

test("incident: parked worker with unresolved threads must NOT oscillate park<->unpark", () => {
  // Rule 3 unparks on unresolved threads; rule 10 used to re-park regardless,
  // so the two ping-ponged every tick (11576: 441 unparks / 425 re-parks).
  const withThreads = () =>
    facts({
      sessionStatus: "complete",
      ciState: "approval_pending",
      unresolvedThreadIds: ["t1"],
      prs: [pr({ threads: [{ id: "t1", resolved: false, isBot: false }, ...[]] })],
    });

  const parked = decideVerdict(withThreads(), cp({ status: "landing", action: "LANDING" }), NOW);
  assert.equal(parked.verdict, "UNPARK", "a parked worker with open threads resumes");

  // Feed the unparked result back: it must NOT immediately re-park.
  const next = decideVerdict(withThreads(), cp({ status: "working", action: "UNPARKED" }), NOW);
  assert.notEqual(next.verdict, "LANDING", "must not re-park while threads are unresolved");
});

test("incident: a human's question in a RESOLVED thread still needs an answer", () => {
  // SCAAS-11576 / qa-automation#5599: ananth99 replied to a resolved thread.
  // GitHub does not reopen it, CC skipped resolved threads, so the question was
  // never surfaced. Resolved + human-last-word must nudge.
  const f = facts({
    sessionStatus: "complete",
    ciState: "approval_pending",
    unresolvedThreadIds: [],
    humanLastWordThreadIds: ["4366854492"],
  });
  const v = decideVerdict(f, cp({ status: "working", action: "WAIT" }), NOW);
  assert.equal(v.verdict, "NUDGE_THREADS");
  assert.ok(/last word/i.test(v.reason), `reason should explain it: ${v.reason}`);
});

test("no threads at all → no NUDGE_THREADS", () => {
  const f = facts({
    sessionStatus: "complete",
    ciState: "approval_pending",
    unresolvedThreadIds: [],
    humanLastWordThreadIds: [],
  });
  const v = decideVerdict(f, cp({ status: "working", action: "WAIT" }), NOW);
  assert.notEqual(v.verdict, "NUDGE_THREADS");
});

test("isBotLogin distinguishes bots from humans", async () => {
  const { isBotLogin } = await import("./facts.ts");
  for (const b of ["ralph-bitgo[bot]", "github-actions[bot]", "linear-code[bot]", "dependabot[bot]", "ralph-bitgo"]) {
    assert.equal(isBotLogin(b), true, `${b} is a bot`);
  }
  for (const h of ["ananth99", "deiva-s", "prasunkumar575"]) {
    assert.equal(isBotLogin(h), false, `${h} is human`);
  }
});

test("incident: a stale cannot_do must NOT latch a terminal verdict forever", () => {
  // SCAAS-11712: cannot_do was latched from a reply about a CLOSED PR. The
  // worker was later repointed at a live PR and the code was fixed, but rule 0
  // (highest priority, cleared only by a human reply) kept it terminal for 4 days.
  const f = facts({ sessionStatus: "complete", lastActivityAt: "2026-10-26T09:00:00Z", ciState: "approval_pending" });

  // The agent has spoken SINCE the classification → the class is stale.
  const staleByActivity = decideVerdict(
    f,
    cp({ reply_class: "cannot_do", reply_class_at: "2026-10-22T20:00:00Z", expected_pr: "#964" }),
    NOW,
  );
  assert.notEqual(staleByActivity.verdict, "BLOCKED_IMPOSSIBILITY");

  // The worker was repointed at a different PR → the class is void.
  const staleByPr = decideVerdict(
    f,
    cp({ reply_class: "cannot_do", reply_class_at: "2026-10-26T10:00:00Z", reply_class_pr: "#63767", expected_pr: "#63763" }),
    NOW,
  );
  assert.notEqual(staleByPr.verdict, "BLOCKED_IMPOSSIBILITY");
});

test("a FRESH cannot_do still blocks the worker for the human", () => {
  const f = facts({ sessionStatus: "complete", lastActivityAt: "2026-09-27T11:00:00Z", ciState: "approval_pending" });
  const v = decideVerdict(
    f,
    cp({ reply_class: "cannot_do", reply_class_at: "2026-09-27T11:30:00Z", reply_class_pr: "#964", expected_pr: "#964" }),
    NOW,
  );
  assert.equal(v.verdict, "BLOCKED_IMPOSSIBILITY");
  assert.ok(v.needsYou);
});
