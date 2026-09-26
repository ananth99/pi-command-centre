import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import {
  matchesKey,
  visibleWidth,
  wrapTextWithAnsi,
  truncateToWidth,
  ScrollView,
  Text,
  type Component,
} from "@earendil-works/pi-tui";

const execFileAsync = promisify(execFile);

/** Linear workspace slug for ticket deep-links. Override with CC_LINEAR_WORKSPACE. */
const LINEAR_WORKSPACE = process.env.CC_LINEAR_WORKSPACE ?? "bitgo";

type WorkerStatus = "working" | "landing" | "blocked" | "awaiting_approval" | "done" | "failed";
type Confidence = "low" | "medium" | "high";
type Risk = "low" | "medium" | "high";
type QueuePriority = 1 | 2 | 3 | 4;
type QueueStatus = "open" | "approved" | "rejected" | "resolved";

interface WorkerCheckpoint {
  worker_id: string;
  status: WorkerStatus;
  objective: string;
  expected_pr?: string;
  summary: string;
  permissions?: {
    allow_github_inline_comments?: boolean;
  };
  evidence: {
    repo?: string;
    branch?: string;
    pr?: string;
    ci_url?: string;
    dashboard_links: string[];
  };
  blocker?: string;
  proposed_action?: string;
  confidence: Confidence;
  risk: Risk;
  updated_at: string;
  model?: string;
  thinking?: string;
  // CC v2 — agent supervision fields
  linear_issue_id?: string;
  agent_name?: string;
  /** All PRs the check worker must scan (threads/CI), in stack order —
   * for single-PR tickets this is just [evidence.pr]. evidence.pr itself is
   * ONLY the auto-close target (the PR whose merge retires the worker). */
  scan_prs?: string[];
  ralph_session_id?: string;
  session_status?: string;
  last_activity_at?: string;
  last_nudge_at?: string;
  ci_state?: string;
  unresolved_thread_count?: number;
  addressed_threads?: string[];
  pending_threads?: string[];
  repeat_failures?: number;
  // Deterministic CI-failure tracking: the check-worker records the raw facts
  // (ci_state, ci_failure_signature); the tick code owns repeat_failures.
  ci_failure_signature?: string | null;
  last_observed_failure_signature?: string | null;
  base_pr?: string;
  action?: string;
  check_in_progress_at?: string | null;
  do_not_rename?: boolean;
  known_repo_quirks?: string[];
  rename_attempts?: number;
}

interface QueueItem {
  id: string;
  priority: QueuePriority;
  title: string;
  source: "worker" | "github" | "linear" | "ops" | "manual";
  status: QueueStatus;
  worker_id?: string;
  details?: string;
  proposed_action?: string;
  created_at: string;
  updated_at: string;
}

interface QueueState {
  items: QueueItem[];
}

interface ActiveController {
  sessionId: string;
  startedAt: string;
  heartbeatAt?: string;
}

function getPaths(cwd: string) {
  const root = join(cwd, ".pi", "command-centre");
  return {
    root,
    registryFile: join(root, "registry.json"),
    workersDir: join(root, "workers"),
    queueFile: join(root, "queue.json"),
    eventsFile: join(root, "events.jsonl"),
    activeControllerFile: join(root, "active-controller.json"),
  };
}

async function ensureState(cwd: string) {
  const paths = getPaths(cwd);
  await mkdir(paths.workersDir, { recursive: true });

  if (!existsSync(paths.registryFile)) {
    await writeJson(paths.registryFile, {
      version: 1,
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    });
  }

  if (!existsSync(paths.queueFile)) {
    await writeJson(paths.queueFile, { items: [] satisfies QueueItem[] });
  }

  if (!existsSync(paths.eventsFile)) {
    await writeFile(paths.eventsFile, "", "utf8");
  }

  return paths;
}

async function readJson<T>(path: string, fallback: T): Promise<T> {
  try {
    const raw = await readFile(path, "utf8");
    return JSON.parse(raw) as T;
  } catch {
    return fallback;
  }
}

async function writeJson(path: string, value: unknown) {
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

async function appendEvent(cwd: string, event: Record<string, unknown>) {
  const paths = await ensureState(cwd);
  const line = `${JSON.stringify({ ts: new Date().toISOString(), ...event })}\n`;
  await writeFile(paths.eventsFile, line, { encoding: "utf8", flag: "a" });
}

async function getActiveController(cwd: string): Promise<ActiveController | null> {
  const paths = await ensureState(cwd);
  return readJson<ActiveController | null>(paths.activeControllerFile, null);
}

async function setActiveController(cwd: string, sessionId: string) {
  const paths = await ensureState(cwd);
  await writeJson(paths.activeControllerFile, {
    sessionId,
    startedAt: new Date().toISOString(),
    heartbeatAt: new Date().toISOString(),
  } satisfies ActiveController);
}

async function clearActiveController(cwd: string) {
  const paths = await ensureState(cwd);
  await writeJson(paths.activeControllerFile, null);
}

function parseLaunchArgs(args: string | undefined) {
  const trimmed = (args ?? "").trim();
  if (!trimmed) {
    return {
      workerId: "",
      objective: "",
      model: "",
      thinking: "",
      repo: "",
      expectedPr: "",
      allowInlineComments: false,
      tickets: [] as string[],
      agent: "",
      basePr: "",
    };
  }

  const tokens = trimmed.split(/\s+/);
  const workerId = tokens[0] ?? "";
  let model = "";
  let thinking = "";
  let repo = "";
  let expectedPr = "";
  let allowInlineComments = false;
  let tickets: string[] = [];
  let agent = "";
  let basePr = "";
  const objectiveParts: string[] = [];

  for (let i = 1; i < tokens.length; i += 1) {
    const token = tokens[i];
    if (token === "--model") {
      model = tokens[i + 1] ?? "";
      i += 1;
      continue;
    }
    if (token === "--thinking") {
      thinking = tokens[i + 1] ?? "";
      i += 1;
      continue;
    }
    if (token === "--repo") {
      repo = tokens[i + 1] ?? "";
      i += 1;
      continue;
    }
    if (token === "--pr") {
      expectedPr = tokens[i + 1] ?? "";
      i += 1;
      continue;
    }
    if (token === "--allow-inline-comments") {
      allowInlineComments = true;
      continue;
    }
    if (token === "--tickets") {
      tickets = (tokens[i + 1] ?? "")
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean);
      i += 1;
      continue;
    }
    if (token === "--agent") {
      agent = tokens[i + 1] ?? "";
      i += 1;
      continue;
    }
    if (token === "--base-pr") {
      basePr = tokens[i + 1] ?? "";
      i += 1;
      continue;
    }
    objectiveParts.push(token);
  }

  return {
    workerId,
    objective: objectiveParts.join(" "),
    model,
    thinking,
    repo,
    expectedPr,
    allowInlineComments,
    tickets,
    agent,
    basePr,
  };
}

function normalizePrRef(ref: string): string {
  const trimmed = ref.trim();
  const urlMatch = trimmed.match(/\/pull\/(\d+)(?:[/?#].*)?$/i);
  if (urlMatch) return `#${urlMatch[1]}`;

  const numberMatch = trimmed.match(/^#?(\d+)$/);
  if (numberMatch) return `#${numberMatch[1]}`;

  return trimmed.replace(/\/+$/, "").toLowerCase();
}

function hasPrMismatch(expectedPr: string, actualPr: string): boolean {
  return normalizePrRef(expectedPr) !== normalizePrRef(actualPr);
}

async function readWorkerCheckpoints(cwd: string): Promise<WorkerCheckpoint[]> {
  const paths = await ensureState(cwd);
  const files = await readdir(paths.workersDir);
  const checkpoints: WorkerCheckpoint[] = [];

  for (const file of files) {
    if (!file.endsWith(".json")) continue;
    const checkpointPath = join(paths.workersDir, file);
    const checkpoint = await readJson<WorkerCheckpoint | null>(checkpointPath, null);
    if (!checkpoint) continue;

    // Status sanitization: the check-worker LLM occasionally invents statuses
    // (e.g. "landing"), which every loop silently ignores — a permanent,
    // unlogged dormancy. Clamp unknowns to "working" (the safe default: it
    // resumes scans and wake-ups) and stamp the file so the fix persists.
    const validStatuses = new Set(["working", "blocked", "awaiting_approval", "done", "failed"]);
    if (!validStatuses.has(checkpoint.status)) {
      const badStatus = checkpoint.status;
      checkpoint.status = "working";
      checkpoint.summary = `[status sanitized: '${badStatus}' is not a valid status → working] ${checkpoint.summary ?? ""}`.slice(0, 200);
      checkpoint.updated_at = checkpoint.updated_at ?? new Date().toISOString();
      void writeJson(checkpointPath, checkpoint).catch(() => {});
      void appendEvent(cwd, { type: "worker_status_sanitized", worker_id: checkpoint.worker_id, from: badStatus, to: "working" }).catch(() => {});
    }

    if (checkpoint.status === "done" && checkpoint.expected_pr) {
      const actualPr = checkpoint.evidence?.pr?.trim();
      const expectedPr = checkpoint.expected_pr.trim();

      if (!actualPr || hasPrMismatch(expectedPr, actualPr)) {
        const summary = !actualPr
          ? `Worker completed without evidence.pr. Expected ${expectedPr}. Result rejected.`
          : `Target PR mismatch: expected ${expectedPr}, got ${actualPr}. Result rejected.`;
        const blocker = !actualPr
          ? `Missing evidence.pr in final checkpoint; cannot verify target PR ${expectedPr}.`
          : `Worker reviewed ${actualPr}, but launch target was ${expectedPr}.`;

        const updatedCheckpoint: WorkerCheckpoint = {
          ...checkpoint,
          status: "failed",
          summary,
          blocker,
          updated_at: new Date().toISOString(),
        };

        await writeJson(checkpointPath, updatedCheckpoint);
        await appendEvent(cwd, {
          type: "worker_target_mismatch",
          worker_id: checkpoint.worker_id,
          expected_pr: expectedPr,
          actual_pr: actualPr || null,
        });
        checkpoints.push(updatedCheckpoint);
        continue;
      }
    }

    checkpoints.push(checkpoint);
  }

  checkpoints.sort((a, b) => (b.updated_at ?? "").localeCompare(a.updated_at ?? ""));
  return checkpoints;
}

async function runZmx(args: string[], cwd: string) {
  return execFileAsync("zmx", args, {
    cwd,
    env: {
      ...process.env,
      SHELL: "/bin/bash",
    },
  });
}

async function resolvePiBinary(cwd: string): Promise<string> {
  const envPath = process.env.PI_BIN;
  if (envPath && existsSync(envPath)) {
    return envPath;
  }

  try {
    const { stdout } = await execFileAsync("which", ["pi"], { cwd });
    const piPath = stdout.trim();
    if (piPath && existsSync(piPath)) {
      return piPath;
    }
  } catch {
    // ignore
  }

  return "pi";
}

function buildWorkerPrompt(params: {
  workerId: string;
  objective: string;
  checkpointPath: string;
  repoPath: string;
  expectedPr?: string;
  allowInlineComments: boolean;
}) {
  return [
    `Worker ID: ${params.workerId}`,
    `Objective: ${params.objective}`,
    `Repo path: ${params.repoPath}`,
    params.expectedPr ? `Target PR: ${params.expectedPr}` : null,
    "Rules:",
    "- Keep scope bounded to this objective.",
    params.expectedPr
      ? "- You MUST review exactly the Target PR above. If any command returns another PR, set status to blocked and explain the mismatch."
      : "- If reviewing a PR, explicitly record the PR URL/number in evidence.pr.",
    "- Write structured checkpoints to the checkpoint file path below.",
    params.allowInlineComments
      ? "- You may create pending inline review comments for this PR if needed. Keep them pending only and do not submit the review. Do not push, merge, or post non-inline comments without approval."
      : "- Do not push, merge, post GitHub comments/replies, or edit Linear without explicit approval from Command Centre.",
    "- If blocked or uncertain, set status to blocked/awaiting_approval with evidence and proposed_action.",
    params.expectedPr
      ? `- Before setting status=done, evidence.pr MUST match Target PR (${params.expectedPr}). Otherwise set status=blocked.`
      : "- Before setting status=done, populate evidence.pr with the reviewed PR URL/number.",
    "Checkpoint file:",
    params.checkpointPath,
    "Checkpoint JSON schema:",
    JSON.stringify(
      {
        worker_id: params.workerId,
        status: "working | blocked | awaiting_approval | done | failed",
        objective: params.objective,
        expected_pr: params.expectedPr || "",
        summary: "",
        evidence: {
          repo: "",
          branch: "",
          pr: "",
          ci_url: "",
          dashboard_links: [],
        },
        blocker: "",
        proposed_action: "",
        confidence: "low | medium | high",
        risk: "low | medium | high",
        updated_at: "ISO-8601",
      },
      null,
      2,
    ),
  ].filter(Boolean).join("\n");
}

// ─── CC v2: model tiers (openrouter only), config, check-workers ─────────────

interface ModelTier {
  model: string;
  thinking: string;
}

interface CCConfig {
  models: { supervisor: ModelTier; check: ModelTier; takeover: ModelTier; nudge: ModelTier };
  wakeups: { staleMinutes: number; checkTimeoutMinutes: number };
  agent: { name: string };
}

const DEFAULT_CC_CONFIG: CCConfig = {
  models: {
    supervisor: { model: "openrouter/~z-ai/glm-flash-latest", thinking: "low" },
    check: { model: "openrouter/~openai/gpt-luna-latest", thinking: "xhigh" },
    takeover: { model: "openrouter/~openai/gpt-luna-latest", thinking: "xhigh" },
    nudge: { model: "openrouter/~z-ai/glm-flash-latest", thinking: "low" },
  },
  wakeups: { staleMinutes: 10, checkTimeoutMinutes: 15 },
  agent: { name: "ralph" },
};

async function readCCConfig(cwd: string): Promise<CCConfig> {
  const paths = await ensureState(cwd);
  const file = join(paths.root, "config.json");
  const loaded = await readJson<Partial<CCConfig>>(file, {});
  return {
    models: { ...DEFAULT_CC_CONFIG.models, ...(loaded.models ?? {}) },
    wakeups: { ...DEFAULT_CC_CONFIG.wakeups, ...(loaded.wakeups ?? {}) },
    agent: { ...DEFAULT_CC_CONFIG.agent, ...(loaded.agent ?? {}) },
  };
}

/** Forgiving shorthands → real catalog ids, so "luna"/"glm" never 404. */
const MODEL_ALIASES: Record<string, string> = {
  luna: "openrouter/~openai/gpt-luna-latest",
  "luna-5.6": "openrouter/~openai/gpt-luna-latest",
  "luna-5.7": "openrouter/~openai/gpt-luna-latest",
  "gpt-luna": "openrouter/~openai/gpt-luna-latest",
  glm: "openrouter/~z-ai/glm-flash-latest",
  "glm-flash": "openrouter/~z-ai/glm-flash-latest",
  "glm-5.3-flash": "openrouter/~z-ai/glm-flash-latest",
};

async function spawnWorkerPi(opts: {
  workerId: string;
  cwd: string;
  stateCwd: string;
  model: string;
  thinking: string;
  prompt: string;
}) {
  // PTY canonical input is capped (~1KB): NEVER type the prompt into the session.
  // Write a launcher script + prompt file; zmx types only a short command.
  const paths = await ensureState(opts.stateCwd);
  const model = MODEL_ALIASES[opts.model] ?? opts.model;
  const launchersDir = join(paths.root, "launchers");
  await mkdir(launchersDir, { recursive: true });
  const promptPath = join(launchersDir, `${opts.workerId}.prompt.txt`);
  const scriptPath = join(launchersDir, `${opts.workerId}.sh`);
  const piBinary = await resolvePiBinary(opts.cwd);
  const nodePathPrefix = piBinary === "pi" ? "" : `${dirname(piBinary)}:`;
  const safePath = `${nodePathPrefix}${process.env.PATH ?? "/usr/bin:/bin"}`;
  await writeFile(promptPath, opts.prompt, "utf8");
  const script = [
    "#!/bin/bash",
    `export PATH="${safePath}"`,
    `cd ${JSON.stringify(opts.cwd)}`,
    `exec ${JSON.stringify(piBinary)} -p --name ${JSON.stringify(opts.workerId)}${
      model ? ` --model ${JSON.stringify(model)}` : ""
    }${opts.thinking ? ` --thinking ${JSON.stringify(opts.thinking)}` : ""} "$(cat ${JSON.stringify(promptPath)})"`,
    "",
  ].join("\n");
  await writeFile(scriptPath, script, { encoding: "utf8", mode: 0o755 });
  // Spawn from stateCwd (fast shell bootstrap) — heavy direnv/nix repos swallow the
  // typed Enter during bootstrap. The launcher script cds into the repo itself.
  await runZmx(["run", opts.workerId, "-d", "bash", scriptPath], opts.stateCwd);
}

function buildCheckWorkerPrompt(p: {
  workerId: string;
  ticket: string;
  agentName: string;
  expectedPr?: string;
  basePr?: string;
  /** All live PRs to scan (stack order). Undefined/empty → scan only the target PR. */
  scanPrs?: string[];
  repoPath: string;
  checkpointPath: string;
  eventsPath: string;
  firstRun: boolean;
  doNotRename?: boolean;
  knownRepoQuirks?: string[];
}): string {
  const prHint = p.expectedPr
    ? `Target PR (auto-close anchor): ${p.expectedPr}`
    : "No target PR known yet — find it from the ticket's comments/linked PRs. Record it as evidence.pr once found.";
  const scanHint = p.scanPrs?.length
    ? `MULTI-PR STACK — scan EVERY PR below on every wake-up (threads, CI, commits, merge state). Threads on ANY scan PR are this worker's responsibility; NUDGE_THREADS lists them all. scan order: ${p.scanPrs.join(" → ")}. Target PR above is only the merge/auto-close anchor.`
    : "";
  const baseHint = p.basePr ? `Stack base PR: ${p.basePr}.` : "";
  const quirksHint = p.knownRepoQuirks?.length
    ? ["KNOWN REPO QUIRKS (read before acting):", ...p.knownRepoQuirks.map((q) => `- ${q}`)].join("\n")
    : "";
  const branchRenameVerdict = p.doNotRename
    ? "- branch non-conforming → DO NOT rename or delete the branch (do_not_rename is set for this worker — a prior rename attempt broke this PR). Just note it in the checkpoint summary and move on."
    : "- branch non-conforming → BRANCH_RENAME: comment @mentioning the agent: rename branch to the convention before merge — instruct it to use GitHub's branch rename API (gh api repos/<owner>/<repo>/branches/<old>/rename -f new_name=...), NEVER push-new-and-delete-old (that auto-closes the PR). If checkpoint.rename_attempts >= 1 already, do NOT retry — escalate to BLOCKED instead.";
  return [
    `You are a SINGLE-SHOT supervisor wake-up. Worker id: ${p.workerId}.`,
    `You supervise Linear agent "${p.agentName}" on ticket ${p.ticket}. Repo: ${p.repoPath}.`,
    p.firstRun
      ? "This is the FIRST run: the ticket may have no agent session and no PR yet — your likely action is the DELEGATE verdict."
      : "",
    prHint,
    scanHint,
    baseHint,
    quirksHint,
    "",
    "## Step 0 — Memory",
    `Read your checkpoint file first — it is your only memory across wake-ups: ${p.checkpointPath}`,
    "",
    "## Step 1 — Gather (Bash: linear + gh CLIs)",
    `1. Sessions: linear api 'query { issue(id:"${p.ticket}") { title state { name } agentSessions { nodes { id status updatedAt } } } }' — pick the latest session for ${p.agentName}.`,
    "2. If a session exists, read its last few activities via linear api agentSession(id, activities) — the last activity timestamp is critical.",
    "3. If a PR exists: gh pr view <PR> --json state,mergeable,mergeStateStatus,reviewDecision,headRefName,commits ; gh pr checks <PR> ; gh api repos/<owner>/<repo>/pulls/<PR>/comments for review threads — REPEAT for EVERY PR in the scan list above, not just the target. Thread ids already in checkpoint.addressed_threads must NOT be re-raised — EXCEPT when a comment on that thread is NEWER than the agent's last reply on it (a reviewer follow-up): then the thread is NOT addressed — re-raise it, and REMOVE its id from addressed_threads in your checkpoint write. addressed_threads is a latch, follow-ups break the latch.",
    "CRITICAL — human-approval gates are NOT CI failures: checks like 'Validate Humans In The Loop' (from the ci-ai-checks workflow) only clear when human reviewers approve the PR. No agent action can ever fix them. When evaluating CI red, naming failing checks, or setting ci_state/ci_failure_signature, EXCLUDE these approval gates entirely. A PR whose only failing check is a human-approval gate is CI-green for verdict purposes: set ci_state to 'approval_pending' (not 'red'), ci_failure_signature to null, and take WAIT or the DONE-verdict awaiting_approval path — NEVER NUDGE_SPECIFIC, FIX_CI, or any other CI-red verdict for it.",
    `4. Branch check: PR headRefName MUST match ananth/${p.ticket}-<2-3-word-desc> (e.g. ananth/SCAAS-11150-order-read).`,
    "5. Commits: exactly ONE per branch; every commit must have verification.verified == true.",
    "6. If gh pr checks fails with a permission error (Resource not accessible), do NOT block on it — fall back to gh pr view --json mergeStateStatus (CLEAN=green, BLOCKED=red) and note in the checkpoint summary that CI could not be verified directly.",
    "",
    "## Step 2 — Verdict (EXACTLY ONE action, first match wins)",
    `- no_agent_session AND firstRun → DELEGATE: post a comment that @mentions ${p.agentName} explicitly: one-sentence objective + branch naming rule (ananth/${p.ticket}-<2-3-word-desc>) + draft PR + single signed commit + commit header feat(scaas): + succinct PR desc + no test evidence in desc. MULTI-PR SIZING: estimate the ticket's changed lines first (new service/handler + its tests + docs — tests typically ≈ 50-60% of a slice). If the estimate exceeds ~500 changed lines, mandate a linear STACK of 2-3 PRs split on file boundaries (e.g. shared types/glue → core logic → integration/webhook), each ≤~500 lines: each slice gets its own branch stacked on the previous slice's branch, its own docs updates, ONE signed commit; all branches named ananth/${p.ticket}-<slice>. Instruct the agent to record ALL PR numbers on the ticket and keep evidence.pr pointing at the STACK TOP (merge-retire anchor) while listing the full scan order for the supervisor.`,
    "- CI red AND session active AND last activity < 20 min ago → WAIT: update checkpoint only. ('CI red' here and below means real code-check failures only — human-approval gates are excluded per Step 1.)",
    "- CI red AND repeat_failures >= 2 on same failure → NUDGE_SPECIFIC: comment @mentioning the agent with the exact failing log excerpt + one-line hint. repeat_failures is maintained by the Command Centre tick — NEVER modify it yourself.",
    "- CI red AND session stale > 30 min → FIX_CI: post a comment whose body is exactly /fix-ci",
    "- unresolved review threads (not in addressed_threads) AND session stale → NUDGE_THREADS: comment @mentioning the agent listing each unresolved thread URL, one per line; reply inline then push.",
    "- PR unmergeable/conflicts (e.g. stack base merged) → REBASE: comment @mentioning the agent: rebase onto master, retarget base if needed, single commit, re-sign.",
    "- commits > 1 OR any unsigned → SIGN_SQUASH: comment @mentioning the agent: squash to one commit, sign (git sign-pr before push).",
    branchRenameVerdict,
    `- all green (CI pass + no unresolved threads + single signed commit + approved + conforming branch) → DONE: set status done, evidence.pr, and ALSO set status awaiting_approval with proposed_action 'Approve merge of <PR> for ${p.ticket}?' so the human decides.`,
    "- same failure 3+ times OR agent overwrote existing work → BLOCKED: status blocked, blocker describes it, propose takeover.",
    "- scope/intent unclear → ASK: status awaiting_approval, proposed_action is ONE focused question. Do not guess.",
    "- OTHERWISE (nothing above matched: agent active, CI running, nothing stale) → WAIT: update checkpoint only.",
    "",
    "## Queue discipline (before ANY comment verdict)",
    "- Read the last 2-3 comments on the ticket via linear api before posting.",
    "- If a prior wake-up already posted a comment on the SAME issue within the last 30 minutes AND the agent has not yet responded to it, that message is QUEUED and pending consumption — do NOT send a duplicate. Take the WAIT verdict instead.",
    "- If the agent HAS responded (queued message consumed) but the issue persists, THEN you may post a new message — but check repeat_failures first.",
    "- If the action you're about to take (verdict name) matches checkpoint.action AND the situation has not changed since last_nudge_at, do NOT re-nudge. Set status to awaiting_approval with proposed_action explaining what's stuck and what the human should do. This is the loop guard — it overrides the verdict table. EXCEPTION: never set awaiting_approval just because the PR is waiting on human CODEOWNER/reviewer approval — parked workers are never scanned for new review threads, and reviewers can leave actionable comments at any time. In that case keep status working with action WAIT so the tick keeps watching the PR.",
    "",
    "## Progress narration (live dashboard)",
    `As you work, after EACH major step, update the checkpoint's \"summary\" field with a short present-tense line of what you are doing right now (e.g. \"reading ralph's session activity\", \"checking CI on the PR\", \"posting nudge comment\"). Do it with a compact python3 one-liner that loads ${p.checkpointPath}, sets summary and updated_at (RFC3339 UTC from date -u +%Y-%m-%dT%H:%M:%SZ — never hand-write timestamps), and saves, keeping all other fields intact. This is what the human sees live.`,
    "",
    "## Step 3 — Write checkpoint (ALWAYS, even on WAIT)",
    `Update ${p.checkpointPath} as JSON: status, action (verdict name), summary (one line), ralph_session_id, session_status, last_activity_at, last_nudge_at (if you posted), ci_state ('red' ONLY if a real code check failed; 'approval_pending' if the only failing checks are human-approval gates; 'green' if CI passes; 'unknown' if not yet checked), ci_failure_signature (name of the failing CODE check when ci_state is red — e.g. "Release / Lint Commit Messages"; null when green or approval_pending), unresolved_thread_count, addressed_threads (append delegated threads), evidence.pr (once known), updated_at = now, check_in_progress_at = null. Do NOT touch repeat_failures or last_observed_failure_signature — the Command Centre tick owns those. Load the existing file first and preserve every field you are not explicitly updating (evidence.repo, evidence.dashboard_links, permissions, do_not_rename, known_repo_quirks, model, thinking, etc.) — never rewrite the checkpoint from memory, fields you drop break the tick's automation.`,
    `Then append an event via Bash: echo '{"type":"check_verdict","worker":"${p.workerId}","action":"<verdict>"}' >> ${p.eventsPath}`,
    "",
    "## Hard rules",
    "- ONE action per wake-up, then stop. Never chain actions.",
    `- EVERY comment MUST explicitly @mention "${p.agentName}" — unmentioned comments are never picked up. Post via: linear issue comment add ${p.ticket} --body "<comment>"`,
    `- After posting ANY comment, FLUSH Linear's send queue so the agent receives it immediately: query the issue's latest agentSession activities (fields: id queued sentAt); for every node with queued:true and sentAt:null run: linear api 'mutation { agentActivitySendQueued(id: \"<ACTIVITY_ID>\") { success } }'. A comment left queued may sit undelivered for hours.`,
    "- NEVER merge, never push, never edit code, never force-push. Merge is human-only.",
    "- If the PR you find is NOT the target PR, set status failed with the mismatch in blocker.",
    "- You are a supervisor. If code changes are needed that the agent can't do, escalate (blocked + proposed_action), don't code.",
  ]
    .filter(Boolean)
    .join("\n");
}

/** Flush queued-but-unsent agent activities on an issue's latest session (agentActivitySendQueued). */
async function flushQueuedAgentActivity(issueId: string): Promise<string> {
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

async function launchTicketWorkers(
  parsed: ReturnType<typeof parseLaunchArgs>,
  ctx: ExtensionCommandContext,
) {
  const config = await readCCConfig(ctx.cwd);
  const repoInput = parsed.repo;
  const launchCwd = repoInput
    ? repoInput.startsWith("/")
      ? resolve(repoInput)
      : resolve(ctx.cwd, repoInput)
    : ctx.cwd;
  if (!existsSync(launchCwd)) {
    ctx.ui.notify(`Repo path does not exist: ${launchCwd}`, "warn");
    return;
  }
  const paths = await ensureState(ctx.cwd);
  const agentName = parsed.agent || config.agent.name;

  for (const ticket of parsed.tickets) {
    const shortId = ticket.split("-")[1] ?? ticket;
    const workerId = `${agentName}-${shortId.toLowerCase()}`;
    const checkpointPath = join(paths.workersDir, `${workerId}.json`);

    const initialCheckpoint: WorkerCheckpoint = {
      worker_id: workerId,
      status: "working",
      objective: `Supervise ${agentName} on ${ticket} end-to-end: delegate, drive CI green, address review threads, single signed commit, conforming branch.`,
      expected_pr: parsed.expectedPr || undefined,
      summary: `Supervising ${agentName} on ${ticket}`,
      permissions: { allow_github_inline_comments: parsed.allowInlineComments },
      evidence: { repo: launchCwd, dashboard_links: [] },
      confidence: "medium",
      risk: "low",
      updated_at: new Date().toISOString(),
      model: config.models.check.model,
      thinking: config.models.check.thinking,
      linear_issue_id: ticket,
      agent_name: agentName,
      base_pr: parsed.basePr || undefined,
      addressed_threads: [],
      pending_threads: [],
      repeat_failures: 0,
      ci_state: "unknown",
      check_in_progress_at: null,
    };
    await writeJson(checkpointPath, initialCheckpoint);

    const prompt = buildCheckWorkerPrompt({
      workerId,
      ticket,
      agentName,
      expectedPr: parsed.expectedPr || undefined,
      basePr: parsed.basePr || undefined,
      repoPath: launchCwd,
      checkpointPath,
      eventsPath: paths.eventsFile,
      firstRun: true,
      doNotRename: initialCheckpoint.do_not_rename,
      knownRepoQuirks: initialCheckpoint.known_repo_quirks,
    });

    try {
      await spawnWorkerPi({
        workerId,
        cwd: launchCwd,
        stateCwd: ctx.cwd,
        model: config.models.check.model,
        thinking: config.models.check.thinking,
        prompt,
      });
      await appendEvent(ctx.cwd, {
        type: "worker_launched",
        worker_id: workerId,
        ticket,
        model: config.models.check.model,
      });
      ctx.ui.notify(`Launched supervisor worker ${workerId} for ${ticket}`, "info");
    } catch (error) {
      initialCheckpoint.status = "failed";
      initialCheckpoint.summary = "Failed to launch worker via zmx";
      initialCheckpoint.blocker = error instanceof Error ? error.message : String(error);
      initialCheckpoint.updated_at = new Date().toISOString();
      await writeJson(checkpointPath, initialCheckpoint);
      await appendEvent(ctx.cwd, { type: "worker_launch_failed", worker_id: workerId, error: initialCheckpoint.blocker });
      ctx.ui.notify(`Failed to launch ${workerId}`, "error");
    }
  }
  await renderDashboardWidget(ctx);
}

async function maybeSpawnCheckWorkers(ctx: { cwd: string }): Promise<void> {
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

const refreshTimers = new Map<string, ReturnType<typeof setInterval>>();
const commandCentreModeSessions = new Set<string>();
const dashboardHiddenSessions = new Set<string>();
const blockedControllerSessions = new Set<string>();

/** Word-wrap to at most maxLines (wide-char aware); ellipsize overflow. */
function wrapText(text: string, width: number, maxLines: number): string[] {
  const clean = text.replace(/\s+/g, " ").trim();
  if (!clean) return [""];
  const all = wrapTextWithAnsi(clean, width);
  if (all.length <= maxLines) return all;
  const kept = all.slice(0, maxLines);
  const rest = all.slice(maxLines - 1).join(" ");
  kept[maxLines - 1] = truncateToWidth(rest, width, "\u2026");
  return kept;
}

function padCell(value: string, width: number) {
  const clean = value.replace(/\s+/g, " ").trim();
  const t = truncateToWidth(clean, width, "\u2026");
  return t + " ".repeat(Math.max(0, width - visibleWidth(t)));
}

function tableLine(columns: Array<{ value: string; width: number; url?: string }>) {
  return columns
    .map((col) => {
      const padded = padCell(col.value, col.width);
      return col.url ? osc8Link(padded, col.url) : padded;
    })
    .join(" ");
}

/** OSC 8 terminal hyperlink — cmd+click opens in browser (Ghostty/iTerm2/WezTerm). */
function osc8Link(text: string, url: string) {
  return `\u001b]8;;${url}\u001b\\${text}\u001b]8;;\u001b\\`;
}

function statusBadge(status: WorkerStatus) {
  switch (status) {
    case "working":
      return "🟦";
    case "blocked":
      return "🟥";
    case "awaiting_approval":
      return "🟨";
    case "landing":
      return "🛬";
    case "done":
      return "🟩";
    case "failed":
      return "⬛";
  }
}

function timeAgo(iso?: string) {
  if (!iso) return "-";
  const ms = Date.now() - new Date(iso).getTime();
  if (Number.isNaN(ms) || ms < 0) return "-";
  const mins = Math.floor(ms / 60000);
  if (mins < 1) return "now";
  if (mins < 60) return `${mins}m`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs}h`;
  return `${Math.floor(hrs / 24)}d`;
}

const ANSI_RE = /\u001b\[[0-9;?]*[A-Za-z]|\u001b\][^\u0007]*\u0007/g;

/** Last meaningful line of a worker's zmx scrollback — the "what is it doing right now" signal. */
async function getWorkerLiveLine(workerId: string): Promise<string | null> {
  try {
    const { stdout } = await execFileAsync("zmx", ["history", workerId], {
      timeout: 3000,
      maxBuffer: 4 * 1024 * 1024,
    });
    const lines = stdout
      .replace(ANSI_RE, "")
      .split("\n")
      .map((l) => l.trim())
      .filter(
        (l) =>
          l.length > 2 &&
          !l.includes("PATH=/") &&
          !l.startsWith("env ") &&
          !l.startsWith("direnv") &&
          !l.startsWith("➜") &&
          !l.includes("is 📦") &&
          !/\/bin[:\s/]|--model|--think|\/nix\/|\.asdf\/|\/homebrew\/|CodeArtifact/.test(l) &&
          !/ZMX_TASK_COMPLETED|\btook \d|\bvia [❄⬢]|^\S+ on\s|[$%]\s*$/.test(l) &&
          !/^\s*\d+\s*[|:]/.test(l) &&
          (l.match(/[A-Za-z]/g) ?? []).length >= 8 &&
          !/(\+\w+ ){2,}/.test(l) &&
          !/^[-+~_=\s]+$/.test(l),
      );
    return lines.length ? (lines[lines.length - 1] ?? null) : null;
  } catch {
    return null;
  }
}

/** Tick-level agent-session probe (no LLM): worker_id -> live Linear session status. */
const liveAgentStatus = new Map<string, { status: string; activityAt?: string; checkedAt: number }>();

const prMergeChecked = new Map<string, number>();

/** Tick-level (no LLM): if a worker's PR is merged, auto-close the worker. */
async function autoCloseMergedWorkers(cwd: string): Promise<void> {
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
async function closeWorker(ctx: ExtensionCommandContext, workerId: string, reason: string): Promise<void> {
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
async function closeHotkey(ctx: ExtensionCommandContext): Promise<void> {
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
async function actHotkey(ctx: ExtensionCommandContext): Promise<void> {
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
async function inspectHotkey(ctx: ExtensionCommandContext): Promise<void> {
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

async function probeAgentSessions(cwd: string): Promise<void> {
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
          const { stdout: ghOut } = await execFileAsync(
            "gh",
            [
              "api",
              `repos/${ref.owner}/${ref.repo}/pulls/${ref.prNum}/comments`,
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

async function buildConsoleLines(cwd: string, width = 100): Promise<string[]> {
  const checkpoints = await readWorkerCheckpoints(cwd);
  const paths = await ensureState(cwd);
  const queue = await readJson<QueueState>(paths.queueFile, { items: [] });
  const openQueue = queue.items
    .filter((item) => item.status === "open")
    .sort((a, b) => a.priority - b.priority || (b.updated_at ?? "").localeCompare(a.updated_at ?? ""));

  const needsYouFromWorkers = checkpoints
    .filter((w) => w.status === "blocked" || w.status === "awaiting_approval")
    .map((w) => ({
      priority: w.status === "awaiting_approval" ? "P2" : "P3",
      worker: w.worker_id,
      ticket: w.linear_issue_id ?? "-",
      message: String(w.blocker || w.proposed_action || w.summary || w.objective),
    }));

  const needsYouFromQueue = openQueue
    .filter((item) => item.priority <= 2)
    .map((item) => ({
      priority: `P${item.priority}`,
      worker: item.id,
      ticket: "-",
      message: item.title,
    }));

  const workingAll = checkpoints.filter(
    (w) => w.status === "working" || w.status === "landing",
  );
  const needsYouFromAgents = workingAll.flatMap((w) => {
    const s = liveAgentStatus.get(w.worker_id);
    // Grace window: you just replied — don't re-raise the P1 while the agent
    // picks the answer up (Linear keeps the session 'awaitingInput' for a bit).
    const repliedRecently =
      w.last_nudge_at && Date.now() - new Date(w.last_nudge_at).getTime() < 5 * 60_000;
    return s && /awaiting/i.test(s.status) && !repliedRecently
      ? [
          {
            priority: "P1",
            worker: w.worker_id,
            ticket: w.linear_issue_id ?? "-",
            message: `${w.agent_name ?? "agent"} is AWAITING YOUR INPUT — read the latest ticket comment, answer with /cc reply ${w.worker_id} <answer>`,
          },
        ]
      : [];
  });
  const needsYou = [...needsYouFromAgents, ...needsYouFromQueue, ...needsYouFromWorkers].slice(0, 8);
  const freshCutoff = Date.now() - 48 * 3600 * 1000;
  const fresh = workingAll.filter((w) => new Date(w.updated_at ?? 0).getTime() >= freshCutoff);
  const inFlight = fresh.slice(0, 6);
  const moreInFlight = fresh.length - inFlight.length;
  const dormantCount = workingAll.length - fresh.length;
  const nowQueue = openQueue.slice(0, 3);

  // ── snapshot rows (async), formatted synchronously by formatConsole ──
  const ifRows: string[][] = [];
  for (const w of inFlight) {
    const ciText =
      w.ci_state === "green" ? "pass" : w.ci_state === "red" ? "FAIL" : w.ci_state === "running" ? "run" : "-";
    const live = liveAgentStatus.get(w.worker_id);
    const sess = live?.status ?? w.session_status;
    const sessAt = live?.activityAt ?? w.last_activity_at;
    const updatedMs = Date.now() - new Date(w.updated_at ?? 0).getTime();
    const narrating = !Number.isNaN(updatedMs) && updatedMs < 3 * 60_000;
    const now = narrating
      ? w.summary || w.objective
      : (await getWorkerLiveLine(w.worker_id)) || w.summary || w.objective;
    const meta =
      `${w.action ? `[${w.action}] ` : ""}${sess ? `${sess}(${timeAgo(sessAt)}) ` : ""}` +
      `${w.unresolved_thread_count ? `\u{1F4AC}${w.unresolved_thread_count} ` : ""}\u00b7 ${now}`;
    ifRows.push([
      w.worker_id,
      w.linear_issue_id ?? "-",
      w.evidence?.pr ? normalizePrRef(w.evidence.pr) : "-",
      ciText,
      meta,
    ]);
  }
  const snap: ConsoleSnap = {
    updated: new Date().toLocaleTimeString(),
    counts: { needsYou: needsYou.length, queue: openQueue.length, inFlight: inFlight.length },
    nyRows: needsYou.map((it) => [it.priority, it.worker, it.ticket, it.message]),
    ifRows,
    nowRows: nowQueue.map((i) => [`P${i.priority}`, i.title]),
    moreInFlight,
    dormant: dormantCount,
  };
  consoleSnapCache.set(cwd, snap);
  return formatConsole(snap, width);
}

interface ConsoleSnap {
  updated: string;
  counts: { needsYou: number; queue: number; inFlight: number };
  nyRows: string[][];
  ifRows: string[][];
  nowRows: string[][];
  moreInFlight: number;
  dormant: number;
}
const consoleSnapCache = new Map<string, ConsoleSnap>();

/** Sync formatter: renders a snapshot into box tables sized to `width`. */
function formatConsole(s: ConsoleSnap, width: number): string[] {
  const out: string[] = [];
  out.push(
    `Updated ${s.updated} \u00b7 Needs You ${s.counts.needsYou} \u00b7 Queue ${s.counts.queue} \u00b7 In Flight ${s.counts.inFlight}`,
  );
  out.push("");
  out.push("NEEDS YOU");
  if (!s.nyRows.length) out.push("  \u2713 none");
  else
    out.push(
      ...renderBoxTable(
        width,
        [
          { title: "P", min: 2 },
          { title: "WORKER", min: 13 },
          { title: "TICKET", min: 11 },
          { title: "WHAT YOU NEED TO DO", min: 20, flex: 1 },
        ],
        s.nyRows,
      ),
    );
  out.push("");
  out.push("IN FLIGHT");
  if (!s.ifRows.length) out.push("  \u2713 none");
  else
    out.push(
      ...renderBoxTable(
        width,
        [
          { title: "WORKER", min: 13 },
          { title: "TICKET", min: 11 },
          { title: "PR", min: 5 },
          { title: "CI", min: 4 },
          { title: "STATUS / NOW", min: 20, flex: 1 },
        ],
        s.ifRows,
      ),
    );
  if (s.moreInFlight > 0) out.push(`  \u2026 +${s.moreInFlight} more in flight`);
  if (s.dormant > 0) out.push(`  \u{1F4A4} ${s.dormant} dormant`);
  if (s.nowRows.length) {
    out.push("");
    out.push("QUEUE");
    out.push(
      ...renderBoxTable(
        width,
        [
          { title: "P", min: 2 },
          { title: "ITEM", min: 20, flex: 1 },
        ],
        s.nowRows,
      ),
    );
  }
  return out;
}


/** Beacon: a fixed ≤3-line status light for the always-on widget — never truncates. */
async function buildBeaconLines(cwd: string): Promise<string[]> {
  const checkpoints = await readWorkerCheckpoints(cwd);
  const paths = await ensureState(cwd);
  const queue = await readJson<QueueState>(paths.queueFile, { items: [] });
  const openQueue = queue.items.filter((i) => i.status === "open");
  const working = checkpoints.filter((w) => w.status === "working");
  const blockers = checkpoints.filter(
    (w) => w.status === "blocked" || w.status === "awaiting_approval",
  );
  const awaiting = working.filter((w) => {
    const s = liveAgentStatus.get(w.worker_id);
    const replied =
      w.last_nudge_at && Date.now() - new Date(w.last_nudge_at).getTime() < 5 * 60_000;
    return s && /awaiting/i.test(s.status) && !replied;
  });
  const needsYou = awaiting.length + blockers.length + openQueue.filter((i) => i.priority <= 2).length;
  const hot = needsYou > 0 ? " 🔴" : "";
  const landing = checkpoints.filter((w) => w.status === "landing");
  const beacon: string[] = [
    `⚡ CC${hot} · needs-you ${needsYou} · in-flight ${working.length} · landing ${landing.length} · queue ${openQueue.length} · alt+c console`,
  ];
  const top = awaiting[0] ?? blockers[0];
  if (top) {
    beacon.push(
      `  ▸ ${top.worker_id} (${top.linear_issue_id ?? "-"}) — ${
        awaiting.includes(top) ? "awaiting your input" : top.status
      } · alt+c…`,
    );
  }
  return beacon.slice(0, 3);
}

async function renderDashboardWidget(ctx: ExtensionCommandContext) {
  const key = ctx.sessionManager.getSessionId();
  if (dashboardHiddenSessions.has(key)) {
    ctx.ui.setWidget("command-centre-dashboard", undefined);
    return;
  }
  const beacon = await buildBeaconLines(ctx.cwd);
  ctx.ui.setWidget("command-centre-dashboard", beacon);
}

async function openConsole(ctx: ExtensionCommandContext) {
  await buildConsoleLines(ctx.cwd, 100); // populates consoleSnapCache
  const snap = consoleSnapCache.get(ctx.cwd);
  if (!snap) return;
  if (ctx.mode !== "tui") {
    showOutputPanel(ctx, formatConsole(snap, 100).join("\n"));
    return;
  }
  await ctx.ui.custom<null>(
    (tui, _theme, _keybindings, done) =>
      new OverlayPane(
        "Command Centre",
        new StaticContent((w) => formatConsole(snap, w)),
        tui,
        done,
      ),
    { overlay: true },
  );
}

function showOutputPanel(ctx: ExtensionCommandContext, content: string) {
  const lines = content.split("\n");
  ctx.ui.setWidget("command-centre-output", lines.slice(0, 300), {
    placement: "belowEditor",
  });
}

/** Scrollable overlay pager for long content — widgets are height-capped by pi. */
/** Content component that renders from a live builder (console tables at real width). */
class StaticContent implements Component {
  private build: (width: number) => string[];
  constructor(build: (width: number) => string[]) {
    this.build = build;
  }
  render(width: number): string[] {
    return this.build(Math.max(20, width));
  }
  invalidate(): void {}
}

/** Bordered overlay pane backed by pi-tui ScrollView (scrollbar + mouse-wheel). */
class OverlayPane implements Component {
  private title: string;
  private sv: ScrollView;
  private tui: { requestRender?: () => void; height?: number; rows?: number };
  private done: (v: null) => void;
  constructor(
    title: string,
    content: Component,
    tui: { requestRender?: () => void; height?: number; rows?: number },
    done: (v: null) => void,
  ) {
    this.title = title;
    this.tui = tui;
    this.done = done;
    this.sv = new ScrollView(content, { follow: "none", scrollbar: "auto" });
  }
  render(width: number): string[] {
    const inner = Math.max(20, width - 2);
    const head = ` ${this.title} · ↑↓ PgUp/PgDn scroll · q close · alt+a act `;
    const top = `\u250c${head.slice(0, inner).padEnd(inner, "\u2500")}\u2510`;
    const body = this.sv.render(inner).map((l) => {
      const padw = Math.max(0, inner - visibleWidth(l));
      return `\u2502${l}${" ".repeat(padw)}\u2502`;
    });
    const bottom = `\u2514${"\u2500".repeat(inner)}\u2518`;
    return [top, ...body, bottom];
  }
  handleInput(data: string): void {
    if (matchesKey(data, "escape") || data === "q") {
      this.done(null);
      return;
    }
    this.sv.handleInput?.(data);
    this.tui.requestRender?.();
  }
  handleMouse(ev: unknown): unknown {
    return (this.sv as unknown as { handleMouse?: (e: unknown) => unknown }).handleMouse?.(ev);
  }
  invalidate(): void {}
}

async function showPager(ctx: ExtensionCommandContext, title: string, content: string) {
  if (ctx.mode !== "tui") {
    showOutputPanel(ctx, content);
    return;
  }
  await ctx.ui.custom<null>(
    (tui, _theme, _keybindings, done) =>
      new OverlayPane(title, new Text(content), tui, done),
    { overlay: true },
  );
}

/**
 * Box-drawing table with per-cell word wrap and flex columns that expand to
 * fill the terminal width. Every returned line is exactly `totalWidth` wide.
 */
function renderBoxTable(
  totalWidth: number,
  columns: Array<{ title: string; min: number; flex?: number }>,
  rows: string[][],
): string[] {
  const n = columns.length;
  const overhead = 3 * n + 1; // │ + " x " padding per column + trailing │
  const avail = Math.max(n * 3, totalWidth - overhead);
  const widths = columns.map((c) => c.min);
  const flexIdx = columns.map((c, i) => (c.flex ? i : -1)).filter((i) => i >= 0);
  let remaining = avail - widths.reduce((a, b) => a + b, 0);
  if (remaining > 0 && flexIdx.length) {
    const totalFlex = flexIdx.reduce((s, i) => s + (columns[i]!.flex ?? 1), 0);
    for (const i of flexIdx) widths[i]! += Math.floor((remaining * (columns[i]!.flex ?? 1)) / totalFlex);
  }
  // Shrink widest columns if we overflow a narrow terminal.
  let over = widths.reduce((a, b) => a + b, 0) - avail;
  while (over > 0) {
    let widest = 0;
    for (let i = 1; i < n; i++) if (widths[i]! > widths[widest]!) widest = i;
    if (widths[widest]! <= 6) break;
    widths[widest]! -= 1;
    over -= 1;
  }
  const bar = (l: string, m: string, r: string) =>
    l + widths.map((w) => "\u2500".repeat(w + 2)).join(m) + r;
  const rowLines = (cells: string[]): string[] => {
    const wrapped = widths.map((w, i) => {
      const t = (cells[i] ?? "").replace(/\s+/g, " ").trim();
      return t ? wrapText(t, w, 12) : [""];
    });
    const height = Math.max(...wrapped.map((c) => c.length), 1);
    const out: string[] = [];
    for (let li = 0; li < height; li++) {
      const parts = widths.map((w, ci) => {
        const line = wrapped[ci]![li] ?? "";
        return ` ${line}${" ".repeat(Math.max(0, w - visibleWidth(line)))} `;
      });
      out.push(`\u2502${parts.join("\u2502")}\u2502`);
    }
    return out;
  };
  const lines: string[] = [bar("\u250c", "\u252c", "\u2510")];
  lines.push(...rowLines(columns.map((c) => c.title)));
  lines.push(bar("\u251c", "\u253c", "\u2524"));
  for (const r of rows) lines.push(...rowLines(r));
  lines.push(bar("\u2514", "\u2534", "\u2518"));
  return lines;
}

export default function commandCentreExtension(pi: ExtensionAPI) {
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
        await maybeSpawnCheckWorkers({ cwd: ctx.cwd }).catch(() => {});
        await probeAgentSessions(ctx.cwd).catch(() => {});
        await autoCloseMergedWorkers(ctx.cwd).catch(() => {});
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

async function doReply(
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
  await writeJson(checkpointPath, checkpoint);
  liveAgentStatus.delete(workerId);
  const flushNote = await flushQueuedAgentActivity(checkpoint.linear_issue_id);
  await appendEvent(ctx.cwd, { type: "human_reply", worker_id: workerId, message, queue: flushNote });
  ctx.ui.notify(`Replied to ${agent} on ${checkpoint.linear_issue_id} (${flushNote})`, "info");
  await renderDashboardWidget(ctx);
}

/** Interactive reply flow for the alt+r hotkey: pick a waiting worker, type an answer. */
/** alt+l: interactive worker launch — prompts for tickets/repo/agent (replaces /cc launch). */
async function launchHotkey(ctx: ExtensionCommandContext): Promise<void> {
  const ticketsRaw = await ctx.ui.input(
    "Launch workers",
    "Linear tickets, comma-separated (e.g. SCAAS-11150,SCAAS-11148):",
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

async function replyHotkey(ctx: ExtensionCommandContext): Promise<void> {
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
}
