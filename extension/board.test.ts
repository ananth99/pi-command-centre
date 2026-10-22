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

// ── deterministic branch names (CC decides, the agent obeys) ───────────

test("branchNameFor always uses the given owner and a short slug", async () => {
  const { branchNameFor } = await import("./facts.ts");
  const cases: Array<[string, string, string]> = [
    ["SCAAS-11712", "WP: per-asset stablecoin T&C storage + API", "ananth/SCAAS-11712-per-asset-stablecoin-tc"],
    ["SCAAS-11715", "Retail: asset-specific T&C dialogs + gating", "ananth/SCAAS-11715-asset-specific-tc-dialogs"],
    ["SCAAS-11716", "Retail: USDC/WTGXX T&C content components", "ananth/SCAAS-11716-usdc-wtgxx-tc-content"],
  ];
  for (const [ticket, title, want] of cases) {
    assert.equal(branchNameFor(ticket, title, "ananth"), want);
  }
});

test("branch slug stays 2-6 words and never ends in a dash", async () => {
  const { slugForBranch } = await import("./facts.ts");
  const long = slugForBranch("qa-automation: webhooks.cc multi-account rotation pool + enterprise webhook self-heal");
  const words = long.split("-");
  assert.ok(words.length >= 2 && words.length <= 6, `got ${words.length} words: ${long}`);
  assert.ok(!long.endsWith("-"));
  assert.equal(slugForBranch(undefined), "");
  assert.equal(slugForBranch(""), "");
});

test("delegation carries the exact branch name, not a pattern", async () => {
  const { DELEGATE_TEMPLATE } = await import("./render.ts");
  const tpl = DELEGATE_TEMPLATE("SCAAS-11712", "ralph", "ananth", "ananth/SCAAS-11712-per-asset-stablecoin-tc");
  assert.ok(tpl.includes("ananth/SCAAS-11712-per-asset-stablecoin-tc"), "exact name present");
  assert.ok(!tpl.includes("<owner>/"), "no placeholder");
  assert.ok(!tpl.includes("<short-desc>"), "no slug pattern");
  assert.ok(/NEVER rename/i.test(tpl), "rename warning present");
});

// ── structural: CC can never instruct a rename again ───────────────────

test("no module tells the agent to rename a branch", async () => {
  const { readFile } = await import("node:fs/promises");
  const { dirname } = await import("node:path");
  const { fileURLToPath } = await import("node:url");
  const here = dirname(fileURLToPath(import.meta.url));
  // Files that produce text sent to the agent.
  for (const f of ["render.ts", "prompts.ts"]) {
    const src = await readFile(`${here}/${f}`, "utf8");
    assert.ok(!src.includes("BRANCH_RENAME"), `${f} must not mention BRANCH_RENAME`);
    // Target the instruction phrasings that actually caused the orphaning.
    const banned = [
      /rename branch to the convention/i,
      /instruct it to use GitHub's branch rename API/i,
      /branches\/<old>\/rename/i,
      /-f new_name=/i,
      /→\s*BRANCH_RENAME/,
    ];
    for (const line of src.split("\n")) {
      for (const b of banned) {
        assert.ok(!b.test(line), `${f}: rename instruction reintroduced → ${line.trim().slice(0, 140)}`);
      }
    }
  }
});

test("BRANCH_RENAME is not a producible verdict", async () => {
  const { decideVerdict } = await import("./verdict.ts");
  // An off-convention branch must escalate, never rename.
  const f: never = {
    workerId: "w", ticket: "SCAAS-1", sessionStatus: "complete", lastActivityAt: "2026-01-01T00:00:00Z",
    prs: [{ num: "1", url: "u", state: "OPEN", mergeStateStatus: "BLOCKED", reviewDecision: "REVIEW_REQUIRED",
      headRefName: "who/SCAAS-1-bad", branchConforming: false, commits: [], commitOk: true, hitlGateOk: false, threads: [] }],
    anchorNum: "1", ciState: "approval_pending", unresolvedThreadIds: [],
  } as never;
  const cp = { worker_id: "w", status: "working", linear_issue_id: "SCAAS-1", expected_pr: "#1" } as never;
  const v = decideVerdict(f, cp);
  assert.notEqual(v.verdict as string, "BRANCH_RENAME");
  assert.equal(v.verdict, "ASK");
});

// ── repo slugs (PR numbers are per-repo, so #992 alone is ambiguous) ────

test("shortRepo resolves plain checkouts and worktrees", async () => {
  const { shortRepo } = await import("./board.ts");
  const cases: Array<[string | null, string]> = [
    ["/Users/a/BitGo/stablecoin-fungibility-service", "sfs"],
    ["/Users/a/BitGo/bitgo-retail", "retail"],
    ["/Users/a/BitGo/bitgo-ui", "ui"],
    ["/Users/a/BitGo/bitgo-microservices", "microservices"],
    ["/Users/a/BitGo/usd-tokenization-service", "uts"],
    ["/Users/a/BitGo/client-admin", "client-admin"],
    // worktrees: the worktree name is NOT the repo
    ["/Users/a/BitGo/bitgo-ui-worktree/scaas-11409-wlf", "ui"],
    ["/Users/a/BitGo/qa-automation-worktree/scaas-11576", "qa"],
    ["/Users/a/BitGo/bitgo-retail-worktree/SCAAS-11445", "retail"],
    [null, ""],
    [undefined, ""],
  ];
  for (const [input, want] of cases) {
    assert.equal(shortRepo(input), want, `${input} → ${want}`);
  }
});

test("needs-you items carry a repo slug", async () => {
  const { deriveBoard } = await import("./board.ts");
  const b = deriveBoard({
    workers: [
      { worker_id: "w1", status: "blocked", linear_issue_id: "SCAAS-1", blocker: "nope",
        evidence: { repo: "/Users/a/BitGo/stablecoin-fungibility-service" }, updated_at: "2026-01-01T00:00:00Z" },
    ],
    live: new Map(),
    assigned: [],
    now: Date.parse("2026-01-01T00:10:00Z"),
  });
  assert.equal(b.needsYou[0]?.repo, "sfs");
});
