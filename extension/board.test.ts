import { test } from "node:test";
import assert from "node:assert/strict";
import { deriveBoard, prChain, prsOf, oneLine, todayStats, type BoardWorker } from "./board.ts";

const NOW = new Date("2026-10-13T12:00:00Z").getTime();
const w = (o: Partial<BoardWorker>): BoardWorker => ({ worker_id: "ralph-1", status: "working", linear_issue_id: "SCAAS-1", updated_at: new Date(NOW).toISOString(), ...o });
const board = (workers: BoardWorker[], live = new Map(), assigned: any[] = []) => deriveBoard({ workers, live, assigned, now: NOW });

test("awaiting worker appears once: in needs-you, not in-flight", () => {
  const b = board([w({})], new Map([["ralph-1", { status: "awaitingInput" }]]));
  assert.equal(b.needsYou.length, 1);
  assert.equal(b.needsYou[0]!.why, "QUESTION");
  assert.equal(b.inFlight.length, 0);
});

test("recent reply suppresses the question", () => {
  const b = board([w({ last_nudge_at: new Date(NOW - 60_000).toISOString() })], new Map([["ralph-1", { status: "awaitingInput" }]]));
  assert.equal(b.needsYou.length, 0);
  assert.equal(b.inFlight.length, 1);
});

test("probe outranks stale blocked-status text for same worker (one row)", () => {
  const b = board([w({ status: "blocked", blocker: "x" })]);
  assert.equal(b.needsYou[0]!.why, "BLOCKED");
});

test("landing is its own section; STALLED vs APPROVE split", () => {
  const b = board([
    w({ worker_id: "a", status: "landing", linear_issue_id: "S-1" }),
    w({ worker_id: "b", status: "awaiting_approval", action: "STALLED", linear_issue_id: "S-2" }),
    w({ worker_id: "c", status: "awaiting_approval", action: "DONE", linear_issue_id: "S-3" }),
  ]);
  assert.equal(b.awaitingReview.length, 1);
  assert.deepEqual(b.needsYou.map((n) => n.why), ["STALLED", "APPROVE"]);
});

test("PR chain + dedupe", () => {
  assert.deepEqual(prsOf({ scan_prs: ["#5601", "https://x/pull/5601", "5600"] }), ["#5601", "#5600"]);
  assert.equal(prChain(["#984", "#985"]), "#984\u2192985");
  assert.equal(prChain(["#1", "#2", "#3", "#4"], "#4"), "#4 +3");
  assert.equal(prChain([]), "-");
});

test("queue = assigned minus tracked, sorted by priority then due; overdue counted", () => {
  const t = (id: string, priority: number, dueDate: string | null, blockedBy: any[] = []) => ({ id, title: id, state: "Todo", priority, dueDate, estimate: null, project: null, blockedBy, launchable: blockedBy.length === 0 || blockedBy.every((b: any) => b.done) });
  const b = board([w({ linear_issue_id: "T-9" })], new Map(), [t("T-9", 1, null), t("A", 3, null), t("B", 1, "2026-10-20"), t("C", 1, "2026-10-01")]);
  assert.deepEqual(b.queue.map((q) => q.id), ["C", "B", "A"]);
  assert.equal(b.overdue, 1);
});

test("blocked tickets are not launchReady", () => {
  const t = (id: string, priority: number, dueDate: string | null, blockedBy: any[] = []) => ({ id, title: id, state: "Todo", priority, dueDate, estimate: null, project: null, blockedBy, launchable: blockedBy.length === 0 || blockedBy.every((b: any) => b.done) });
  const b = board([], new Map(), [
    t("A", 1, null, [{ id: "X", done: false }]),
    t("B", 1, null, [{ id: "X", done: true }]),
    t("C", 2, null),
  ]);
  assert.deepEqual(b.launchReady.map((q) => q.id), ["B", "C"]);
  assert.equal(b.queue.length, 3);
});

test("oneLine cuts at a boundary", () => {
  assert.ok(oneLine("word ".repeat(100), 50).endsWith("\u2026"));
  assert.equal(oneLine("short"), "short");
});

test("todayStats", () => {
  const s = todayStats([{ ts: "2026-10-13T01:00:00Z", type: "worker_landing" }, { ts: "2026-10-12T01:00:00Z", type: "worker_landing" }, { ts: "2026-10-13T02:00:00Z", type: "human_reply" }], NOW);
  assert.deepEqual(s, { landed: 1, merged: 0, replies: 1 });
});

// ── branch convention (the CC_BRANCH_OWNER="" regression) ──────────────

test("branch names conform without CC_BRANCH_OWNER set", async () => {
  const { branchConforming } = await import("./facts.ts");
  const prev = process.env.CC_BRANCH_OWNER;
  delete process.env.CC_BRANCH_OWNER;
  try {
    assert.equal(branchConforming("ananth/SCAAS-11712-per-asset-stablecoin-tandc-pt1", "SCAAS-11712"), true);
    assert.equal(branchConforming("ananth/SCAAS-11712-0-contract", "SCAAS-11712"), true);
    assert.equal(branchConforming("ananth/SCAAS-11712", "SCAAS-11712"), true);
    assert.equal(branchConforming("deivas/SCAAS-11044-1b-presenter-hoist", "SCAAS-11044"), true);
    // wrong ticket, or no ticket at all
    assert.equal(branchConforming("ananth/SCAAS-99999-thing", "SCAAS-11712"), false);
    assert.equal(branchConforming("feature-branch", "SCAAS-11712"), false);
    assert.equal(branchConforming(null, "SCAAS-11712"), false);
  } finally {
    if (prev === undefined) delete process.env.CC_BRANCH_OWNER;
    else process.env.CC_BRANCH_OWNER = prev;
  }
});

test("CC_BRANCH_OWNER pins the owner when set", async () => {
  const { branchConforming } = await import("./facts.ts");
  const prev = process.env.CC_BRANCH_OWNER;
  process.env.CC_BRANCH_OWNER = "ananth";
  try {
    assert.equal(branchConforming("ananth/SCAAS-11712-thing", "SCAAS-11712"), true);
    assert.equal(branchConforming("someone-else/SCAAS-11712-thing", "SCAAS-11712"), false);
  } finally {
    if (prev === undefined) delete process.env.CC_BRANCH_OWNER;
    else process.env.CC_BRANCH_OWNER = prev;
  }
});

test("empty CC_BRANCH_OWNER behaves as unset (the incident)", async () => {
  const { branchConforming } = await import("./facts.ts");
  const prev = process.env.CC_BRANCH_OWNER;
  process.env.CC_BRANCH_OWNER = "";
  try {
    assert.equal(branchConforming("ananth/SCAAS-11712-per-asset-stablecoin-tandc-pt1", "SCAAS-11712"), true);
  } finally {
    if (prev === undefined) delete process.env.CC_BRANCH_OWNER;
    else process.env.CC_BRANCH_OWNER = prev;
  }
});
