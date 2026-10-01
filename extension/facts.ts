/**
 * facts.ts — deterministic state-gathering for the Command Centre loop.
 *
 * Every "read the world" operation lives here so the verdict logic and the
 * tick share ONE source of truth. No LLM involved anywhere.
 *
 * Design rules (paid for in incidents):
 *  - Signature verification is read via the REST API. The
 *    `gh pr view --json commits` GraphQL projection returns
 *    verification.verified === null REGARDLESS of real state (the
 *    "false-unsigned" incident on PR #964). REST is authoritative.
 *  - Timestamps are always RFC-3339 produced by code, never hand-written.
 *  - All external calls go through injectable `FactDeps` so tests run
 *    against recorded fixtures instead of live GitHub/Linear.
 */

import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export interface ExecResult {
  stdout: string;
}

export interface FactDeps {
  exec: (
    cmd: string,
    args: string[],
    opts?: { cwd?: string; timeout?: number },
  ) => Promise<ExecResult>;
}

export function defaultDeps(): FactDeps {
  return {
    exec: (cmd, args, opts) =>
      execFileAsync(cmd, args, { timeout: opts?.timeout ?? 10_000, maxBuffer: 4 * 1024 * 1024, ...opts }),
  };
}

export interface CommitFact {
  sha: string;
  authorName: string;
  committerName: string;
  /** REST-verified signature state — the ONLY trusted source. */
  verified: boolean;
  /** Co-authored-by trailer naming the human supervisor present in message. */
  coAuthoredByHuman: boolean;
}

export interface ThreadFact {
  id: string;
  kind: "review" | "conversation";
  lastCommentAt: string | null;
}

export interface PrFact {
  num: string;
  url: string;
  state: "OPEN" | "MERGED" | "CLOSED" | "UNKNOWN";
  mergeStateStatus: string | null;
  reviewDecision: string | null;
  headRefName: string | null;
  branchConforming: boolean;
  commits: CommitFact[];
  /** Exactly one commit, REST-verified, with human co-authorship. */
  commitOk: boolean;
  /** Both Humans-In-The-Loop gate heads: attribution/commitOk AND approved. */
  hitlGateOk: boolean;
  threads: ThreadFact[];
}

export type CiState = "green" | "red" | "running" | "approval_pending" | "unknown";

export interface WorkerFacts {
  workerId: string;
  ticket: string;
  /** Latest Linear agent session for the ticket (null = no session). */
  sessionStatus: string | null;
  lastActivityAt: string | null;
  /** Stack order (base first). Anchor PR = merge/auto-close target. */
  prs: PrFact[];
  anchorNum: string | null;
  ciState: CiState;
  /** Unresolved thread ids: not in the addressed latch. */
  unresolvedThreadIds: string[];
}

/** Extract a PR number from "#964", a URL, or a bare number. */
export function parsePrNum(ref: string): string | null {
  const m = ref.match(/(\d+)/);
  return m ? m[1]! : null;
}

function isRfc3339(s: string): boolean {
  return !Number.isNaN(Date.parse(s));
}

function safeJson<T>(raw: string): T | null {
  try {
    return JSON.parse(raw) as T;
  } catch {
    return null;
  }
}

interface PrViewShape {
  state?: string;
  mergeStateStatus?: string;
  reviewDecision?: string;
  headRefName?: string;
  commits?: Array<{ oid?: string }>;
}

interface CommitShape {
  commit?: {
    author?: { name?: string };
    committer?: { name?: string };
    verification?: { verified?: boolean | null; reason?: string | null };
    message?: string;
  };
}

/**
 * Gather all deterministic facts for one worker. Throws nothing — missing
 * data degrades to nulls; verdict logic treats nulls conservatively.
 */
export async function gatherFacts(
  checkpoint: {
    worker_id: string;
    linear_issue_id?: string;
    evidence?: { repo?: string; pr?: string };
    expected_pr?: string;
    scan_prs?: string[];
    addressed_threads?: string[];
  },
  deps: FactDeps = defaultDeps(),
): Promise<WorkerFacts> {
  const repoPath = checkpoint.evidence?.repo ?? process.cwd();
  const anchorRaw = checkpoint.expected_pr || checkpoint.evidence?.pr || "";
  const anchorNum = parsePrNum(anchorRaw);
  const scanRefs = [...new Set([...(checkpoint.scan_prs ?? []), anchorRaw].filter(Boolean))];

  // Repo full name (owner/name) for REST calls.
  let repoFullName: string | null = null;
  try {
    const r = await deps.exec("gh", ["repo", "view", "--json", "nameWithOwner", "-q", ".nameWithOwner"], { cwd: repoPath });
    repoFullName = r.stdout.trim() || null;
  } catch {
    repoFullName = null;
  }

  // Latest agent session status from Linear.
  let sessionStatus: string | null = null;
  let lastActivityAt: string | null = null;
  if (checkpoint.linear_issue_id) {
    try {
      const r = await deps.exec(
        "linear",
        [
          "api",
          `query { issue(id:"${checkpoint.linear_issue_id}") { agentSessions { nodes { status updatedAt } } } }`,
        ],
        { timeout: 8_000 },
      );
      const parsed = safeJson<{
        data?: { issue?: { agentSessions?: { nodes?: Array<{ status: string; updatedAt?: string }> } } };
      }>(r.stdout);
      const nodes = parsed?.data?.issue?.agentSessions?.nodes ?? [];
      nodes.sort((a, b) => (a.updatedAt ?? "").localeCompare(b.updatedAt ?? ""));
      const latest = nodes[nodes.length - 1];
      if (latest) {
        sessionStatus = latest.status ?? null;
        lastActivityAt = latest.updatedAt && isRfc3339(latest.updatedAt) ? latest.updatedAt : null;
      }
    } catch {
      // keep nulls
    }
  }

  const addressed = new Set(checkpoint.addressed_threads ?? []);
  const ticket = checkpoint.linear_issue_id ?? "";
  const prs: PrFact[] = [];
  for (const ref of scanRefs) {
    const num = parsePrNum(ref);
    if (!num || !repoFullName) continue;
    const prFact = await gatherPrFacts(num, repoFullName, repoPath, ticket, deps);
    if (prFact) {
      prFact.threads = prFact.threads.filter((t) => !addressed.has(t.id));
      prs.push(prFact);
    }
  }

  const ciState = deriveCiState(prs);
  const unresolvedThreadIds = prs.flatMap((p) => p.threads.map((t) => t.id));

  return {
    workerId: checkpoint.worker_id,
    ticket: checkpoint.linear_issue_id ?? "",
    sessionStatus,
    lastActivityAt,
    prs,
    anchorNum,
    ciState,
    unresolvedThreadIds,
  };
}

async function gatherPrFacts(
  num: string,
  repoFullName: string,
  repoPath: string,
  ticket: string,
  deps: FactDeps,
): Promise<PrFact | null> {
  const url = `https://github.com/${repoFullName}/pull/${num}`;
  try {
    const r = await deps.exec(
      "gh",
      ["pr", "view", num, "--json", "state,mergeStateStatus,reviewDecision,headRefName,commits"],
      { cwd: repoPath },
    );
    const pr = safeJson<PrViewShape>(r.stdout);
    if (!pr) return null;

    // REST verification per commit — the authoritative read.
    const commits: CommitFact[] = [];
    for (const c of pr.commits ?? []) {
      const sha = c.oid;
      if (!sha) continue;
      try {
        const cr = await deps.exec("gh", ["api", `repos/${repoFullName}/commits/${sha}`, "--jq",
          JSON.stringify({author: ".commit.author.name", committer: ".commit.committer.name",
                          verified: ".commit.verification.verified", message: ".commit.message"})], { cwd: repoPath });
        // gh --jq with an object literal isn't valid; use fields directly.
        const raw = await deps.exec("gh", ["api", `repos/${repoFullName}/commits/${sha}`,
          "--jq", "[.commit.author.name, .commit.committer.name, .commit.verification.verified, .commit.message]"], { cwd: repoPath });
        const arr = safeJson<[string | null, string | null, boolean | null, string | null]>(raw.stdout);
        commits.push({
          sha,
          authorName: arr?.[0] ?? "",
          committerName: arr?.[1] ?? "",
          verified: arr?.[2] === true,
          coAuthoredByHuman: /Co-authored-by:\s*Ananth Madhavan/i.test(arr?.[3] ?? ""),
        });
      } catch {
        commits.push({ sha, authorName: "", committerName: "", verified: false, coAuthoredByHuman: false });
      }
    }

    const headRefName = pr.headRefName ?? null;
    const commitOk =
      commits.length === 1 && commits[0]!.verified && commits[0]!.coAuthoredByHuman;
    const reviewApproved = pr.reviewDecision === "APPROVED";
    const state = (pr.state as PrFact["state"]) ?? "UNKNOWN";

    // Threads: review comments + conversation comments.
    const threads: ThreadFact[] = [];
    try {
      const tr = await deps.exec("gh", ["api", `repos/${repoFullName}/pulls/${num}/comments`,
        "--jq", "[.[] | [.id, .created_at]]"], { cwd: repoPath });
      const arr = safeJson<Array<[number, string]>>(tr.stdout) ?? [];
      for (const [id, at] of arr) threads.push({ id: String(id), kind: "review", lastCommentAt: at });
    } catch { /* none */ }
    try {
      const cr = await deps.exec("gh", ["api", `repos/${repoFullName}/issues/${num}/comments`,
        "--jq", "[.[] | [.id, .created_at]]"], { cwd: repoPath });
      const arr = safeJson<Array<[number, string]>>(cr.stdout) ?? [];
      for (const [id, at] of arr) threads.push({ id: String(id), kind: "conversation", lastCommentAt: at });
    } catch { /* none */ }

    return {
      num,
      url,
      state,
      mergeStateStatus: pr.mergeStateStatus ?? null,
      reviewDecision: pr.reviewDecision ?? null,
      headRefName,
      branchConforming: branchConforming(headRefName, ticket),
      commits,
      commitOk,
      hitlGateOk: commitOk && reviewApproved,
      threads,
    };
  } catch {
    return null;
  }
}

/** ananth/<TICKET>-<slice-or-desc> convention. */
export function branchConforming(headRefName: string | null, ticket: string): boolean {
  if (!headRefName || !ticket) return false;
  return new RegExp(`^ananth/${ticket.replace(/[.*+?^${}()|[\\]\\\\]/g, "\\$&")}(-[a-z0-9-]+)?$`).test(headRefName);
}

/**
 * Derive CI state. Human-approval gates ("Validate Humans In The Loop")
 * are NOT CI failures — a PR blocked only on review is approval_pending.
 */
export function deriveCiState(prs: PrFact[]): CiState {
  const open = prs.filter((p) => p.state === "OPEN");
  if (!open.length) return "unknown";
  if (open.some((p) => p.mergeStateStatus === "DIRTY")) return "red";
  if (open.every((p) => p.mergeStateStatus === "CLEAN")) return "green";
  if (open.every((p) => p.mergeStateStatus === "BLOCKED" && p.reviewDecision === "REVIEW_REQUIRED")) {
    return "approval_pending";
  }
  return "unknown";
}

/**
 * Revival helper: given gh-search results for a ticket's open PRs and the
 * PR refs the worker already tracked, return the first PR the worker never
 * saw (null if nothing new). Pure — unit-tested.
 */
export function firstUntrackedPr(
  searchResults: Array<{ number: number; url: string }>,
  knownRefs: Array<string | undefined | null>,
): { number: string; url: string } | null {
  const known = new Set<string>();
  for (const ref of knownRefs) {
    if (!ref) continue;
    const n = parsePrNum(ref);
    if (n) known.add(n);
  }
  for (const r of searchResults) {
    const n = String(r.number);
    if (!known.has(n)) return { number: n, url: r.url };
  }
  return null;
}

/**
 * PR discovery (v3 backfill): workers launched without PR linkage can't see
 * their ticket's PRs — the render-only worker never gathers. The tick calls
 * this to find the ticket's open PRs via search, then persists them into
 * scan_prs. Stack-top heuristic: the highest PR number (later slices open last).
 */
export async function discoverOpenPrsForTicket(
  ticket: string,
  repoPath: string,
  deps: FactDeps = defaultDeps(),
): Promise<Array<{ number: string; url: string }>> {
  const opts = { cwd: repoPath, timeout: 10_000, maxBuffer: 1024 * 1024 };
  const r = await deps.exec("gh", ["repo", "view", "--json", "nameWithOwner", "-q", ".nameWithOwner"], opts);
  const fullName = r.stdout.trim();
  if (!fullName) return [];
  const s = await deps.exec(
    "gh",
    ["search", "prs", ticket, "--repo", fullName, "--state", "open", "--json", "number,url", "--limit", "10"],
    opts,
  );
  const raw = JSON.parse(s.stdout) as Array<{ number: number; url: string }>;
  return raw.map((x) => ({ number: String(x.number), url: x.url }));
}
