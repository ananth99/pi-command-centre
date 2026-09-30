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
    url: "https://github.com/BitGo/stablecoin-fungibility-service/pull/964",
    state: "OPEN",
    mergeStateStatus: "BLOCKED",
    reviewDecision: "REVIEW_REQUIRED",
    headRefName: "ananth/SCAAS-11159-recover-settled-share-receipts",
    branchConforming: true,
    commits: [
      {
        sha: "7eb8315a",
        authorName: "Ananth Madhavan",
        committerName: "bitgobot",
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
    workerId: "ralph-11159",
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
    worker_id: "ralph-11159",
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

test("incident: 14-comment spam (11150) — repeated verdict within 30min must escalate, not re-send", () => {
  const f = facts({
    prs: [pr({ headRefName: "SCAAS-11150-order-read", branchConforming: false })],
    sessionStatus: "stale",
    ciState: "unknown",
  });
  const checkpoint = cp({
    action: "BRANCH_RENAME",
    last_nudge_at: new Date(NOW - 10 * 60_000).toISOString(),
    rename_attempts: 1,
  });
  const v = decideVerdict(f, checkpoint, NOW);
  assert.equal(v.verdict, "STALLED");
  assert.equal(v.needsRender, false, "must NOT render another nudge");
  assert.ok(v.needsYou, "must surface to the human");
});

test("incident: rename exhausted — after 2 attempts escalate ASK instead of renaming forever", () => {
  const f = facts({
    prs: [pr({ headRefName: "SCAAS-11150-order-read", branchConforming: false })],
    sessionStatus: "complete",
    ciState: "approval_pending",
  });
  const v = decideVerdict(f, cp({ rename_attempts: 3 }), NOW);
  assert.equal(v.verdict, "ASK");
  assert.equal(v.needsRender, true);
  assert.ok(v.needsYou);
});

test("incident: unsigned commit outranks review — SIGN_SQUASH is absolute priority", () => {
  const f = facts({
    prs: [pr({
      commits: [
        { sha: "a1", authorName: "Ralph", committerName: "bitgobot", verified: false, coAuthoredByHuman: true },
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
});

test("render prompt: slim and obedient — no gather steps, no verdict table", () => {
  const p = buildRenderPrompt({
    workerId: "ralph-11159",
    ticket: "SCAAS-11159",
    agentName: "ralph",
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
  const tpl = DELEGATE_TEMPLATE("SCAAS-11159", "ralph");
  const p = buildRenderPrompt({
    workerId: "w",
    ticket: "SCAAS-11159",
    agentName: "ralph",
    verdict: "DELEGATE",
    reason: "no agent session yet",
    facts: {},
    checkpointPath: "/tmp/cp.json",
    eventsPath: "/tmp/ev.jsonl",
    delegateTemplate: tpl,
  });
  assert.ok(p.includes("Co-authored-by: Ananth Madhavan"));
  assert.ok(p.includes("ananth/SCAAS-11159"));
  assert.ok(p.includes("MULTI-PR SIZING"));
});

test("revival: a new open PR on a done ticket is detected", () => {
  const search = [
    { number: 964, url: "https://github.com/BitGo/x/pull/964" },
    { number: 1042, url: "https://github.com/BitGo/x/pull/1042" },
  ];
  // worker tracked #964 (merged, retired); #1042 is new
  const fresh = firstUntrackedPr(search, ["#964", "https://github.com/BitGo/x/pull/964"]);
  assert.equal(fresh?.number, "1042");
  assert.equal(fresh?.url, "https://github.com/BitGo/x/pull/1042");
});

test("revival: nothing new → stays retired (no churn)", () => {
  const search = [{ number: 964, url: "https://github.com/BitGo/x/pull/964" }];
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