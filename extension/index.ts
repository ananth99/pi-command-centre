import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { matchesKey } from "@earendil-works/pi-tui";

const execFileAsync = promisify(execFile);

/** Linear workspace slug for ticket deep-links. Override with CC_LINEAR_WORKSPACE. */
const LINEAR_WORKSPACE = process.env.CC_LINEAR_WORKSPACE ?? "bitgo";

type WorkerStatus = "working" | "blocked" | "awaiting_approval" | "done" | "failed";
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
  ralph_session_id?: string;
  session_status?: string;
  last_activity_at?: string;
  last_nudge_at?: string;
  ci_state?: string;
  unresolved_thread_count?: number;
  addressed_threads?: string[];
  pending_threads?: string[];
  repeat_failures?: number;
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
  repoPath: string;
  checkpointPath: string;
  eventsPath: string;
  firstRun: boolean;
  doNotRename?: boolean;
  knownRepoQuirks?: string[];
}): string {
  const prHint = p.expectedPr
    ? `Target PR: ${p.expectedPr}`
    : "No target PR known yet — find it from the ticket's comments/linked PRs. Record it as evidence.pr once found.";
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
    baseHint,
    quirksHint,
    "",
    "## Step 0 — Memory",
    `Read your checkpoint file first — it is your only memory across wake-ups: ${p.checkpointPath}`,
    "",
    "## Step 1 — Gather (Bash: linear + gh CLIs)",
    `1. Sessions: linear api 'query { issue(id:"${p.ticket}") { title state { name } agentSessions { nodes { id status updatedAt } } } }' — pick the latest session for ${p.agentName}.`,
    "2. If a session exists, read its last few activities via linear api agentSession(id, activities) — the last activity timestamp is critical.",
    "3. If a PR exists: gh pr view <PR> --json state,mergeable,mergeStateStatus,reviewDecision,headRefName,commits ; gh pr checks <PR> ; gh api repos/<owner>/<repo>/pulls/<PR>/comments for review threads. Thread ids already in checkpoint.addressed_threads must NOT be re-raised.",
    `4. Branch check: PR headRefName MUST match ananth/${p.ticket}-<2-3-word-desc> (e.g. ananth/SCAAS-11150-order-read).`,
    "5. Commits: exactly ONE per branch; every commit must have verification.verified == true.",
    "6. If gh pr checks fails with a permission error (Resource not accessible), do NOT block on it — fall back to gh pr view --json mergeStateStatus (CLEAN=green, BLOCKED=red) and note in the checkpoint summary that CI could not be verified directly.",
    "",
    "## Step 2 — Verdict (EXACTLY ONE action, first match wins)",
    `- no_agent_session AND firstRun → DELEGATE: post a comment that @mentions ${p.agentName} explicitly: one-sentence objective + branch naming rule (ananth/${p.ticket}-<2-3-word-desc>) + draft PR + single signed commit + commit header feat(scaas): + succinct PR desc + no test evidence in desc.`,
    "- CI red AND session active AND last activity < 20 min ago → WAIT: update checkpoint only.",
    "- CI red AND repeat_failures >= 2 on same failure → NUDGE_SPECIFIC: comment @mentioning the agent with the exact failing log excerpt + one-line hint; increment repeat_failures.",
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
    "- If the action you're about to take (verdict name) matches checkpoint.action AND the situation has not changed since last_nudge_at, do NOT re-nudge. Set status to awaiting_approval with proposed_action explaining what's stuck and what the human should do. This is the loop guard — it overrides the verdict table.",
    "",
    "## Progress narration (live dashboard)",
    `As you work, after EACH major step, update the checkpoint's \"summary\" field with a short present-tense line of what you are doing right now (e.g. \"reading ralph's session activity\", \"checking CI on the PR\", \"posting nudge comment\"). Do it with a compact python3 one-liner that loads ${p.checkpointPath}, sets summary and updated_at (RFC3339 UTC from date -u +%Y-%m-%dT%H:%M:%SZ — never hand-write timestamps), and saves, keeping all other fields intact. This is what the human sees live.`,
    "",
    "## Step 3 — Write checkpoint (ALWAYS, even on WAIT)",
    `Update ${p.checkpointPath} as JSON: status, action (verdict name), summary (one line), ralph_session_id, session_status, last_activity_at, last_nudge_at (if you posted), ci_state, unresolved_thread_count, addressed_threads (append delegated threads), repeat_failures, evidence.pr (once known), updated_at = now, check_in_progress_at = null.`,
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

    w.check_in_progress_at = new Date().toISOString();
    const checkpointPath = join(paths.workersDir, `${w.worker_id}.json`);
    await writeJson(checkpointPath, w);

    const prompt = buildCheckWorkerPrompt({
      workerId: w.worker_id,
      ticket: w.linear_issue_id,
      agentName: w.agent_name ?? config.agent.name,
      expectedPr: w.expected_pr,
      basePr: w.base_pr,
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

/** Word-wrap to at most maxLines; ellipsize only what truly overflows. */
function wrapText(text: string, width: number, maxLines: number): string[] {
  const clean = text.replace(/\s+/g, " ").trim();
  const out: string[] = [];
  let rest = clean;
  while (rest.length && out.length < maxLines) {
    if (rest.length <= width) {
      out.push(rest);
      rest = "";
      break;
    }
    let cut = rest.lastIndexOf(" ", width);
    if (cut < width * 0.6) cut = width;
    out.push(rest.slice(0, cut));
    rest = rest.slice(cut).trim();
  }
  if (rest.length && out.length > 0) {
    const last = out[out.length - 1] ?? "";
    out[out.length - 1] = `${last.slice(0, Math.max(1, width - 1))}…`;
  }
  return out;
}

function padCell(value: string, width: number) {
  const clean = value.replace(/\s+/g, " ").trim();
  if (clean.length <= width) return clean.padEnd(width, " ");
  if (width <= 1) return clean.slice(0, width);
  return `${clean.slice(0, width - 1)}…`;
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
    const pr = w.expected_pr || w.evidence?.pr;
    const repo = w.evidence?.repo;
    if (!pr || !repo) continue;
    const prNum = pr.match(/(\d+)/)?.[1];
    if (!prNum) continue;
    const prev = prMergeChecked.get(w.worker_id);
    if (prev && Date.now() - prev < 60_000) continue;
    prMergeChecked.set(w.worker_id, Date.now());
    try {
      const { stdout } = await execFileAsync("gh", ["pr", "view", prNum, "--json", "state,mergedAt"], {
        cwd: repo,
        timeout: 10_000,
      });
      const prState = JSON.parse(stdout) as { state?: string; mergedAt?: string | null };
      if (prState.state === "MERGED") {
        w.status = "done";
        w.action = "MERGED";
        w.summary = `PR ${pr} merged ${prState.mergedAt ?? ""} — auto-closed`.trim();
        w.updated_at = new Date().toISOString();
        w.check_in_progress_at = null;
        await writeJson(join(paths.workersDir, `${w.worker_id}.json`), w);
        liveAgentStatus.delete(w.worker_id);
        await appendEvent(cwd, { type: "worker_auto_closed", worker_id: w.worker_id, pr, reason: "pr_merged" });
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

/** alt+d hotkey: pick a pending worker and close it. */
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
    if (!(w.status === "working" || w.status === "awaiting_approval" || w.status === "blocked")) continue;
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
      }
    } catch {
      // keep previous reading
    }
  }
}

async function buildConsoleLines(cwd: string): Promise<string[]> {
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

  const workingAll = checkpoints.filter((w) => w.status === "working");
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

  const clip = (text: string, max = 96) => {
    const clean = text.replace(/\s+/g, " ").trim();
    return clean.length <= max ? clean : `${clean.slice(0, max - 1)}…`;
  };

  const lines: string[] = [];
  lines.push("⚡ Command Centre — console");
  lines.push(
    clip(
      `Updated ${new Date().toLocaleTimeString()} • Needs You ${needsYou.length} • Queue ${openQueue.length} • In Flight ${inFlight.length}`,
    ),
  );
  lines.push("");
  lines.push("Needs You");
  if (!needsYou.length) {
    lines.push("  ✓ none");
  } else {
    lines.push(
      tableLine([
        { value: "P", width: 3 },
        { value: "WORKER", width: 14 },
        { value: "TICKET", width: 11 },
        { value: "WHAT YOU NEED TO DO", width: 62 },
      ]),
    );
    const contIndent = " ".repeat(3 + 1 + 14 + 1 + 11 + 1);
    let anyTruncated = false;
    for (const item of needsYou) {
      const wrapped = wrapText(item.message, 62, 3);
      anyTruncated ||= wrapped[wrapped.length - 1]?.endsWith("…") ?? false;
      lines.push(
        tableLine([
          { value: item.priority, width: 3 },
          { value: item.worker, width: 14 },
          {
            value: item.ticket,
            width: 11,
            url:
              item.ticket !== "-"
                ? `https://linear.app/${LINEAR_WORKSPACE}/issue/${item.ticket}`
                : undefined,
          },
          { value: wrapped[0] ?? "", width: 62 },
        ]),
      );
      for (const cont of wrapped.slice(1)) lines.push(contIndent + cont);
    }
    if (anyTruncated) lines.push("  … clipped — /cc needs for full text");
  }

  lines.push("In Flight");
  if (!inFlight.length) {
    lines.push("  ✓ none");
  } else {
    lines.push(
      tableLine([
        { value: "", width: 2 },
        { value: "WORKER", width: 14 },
        { value: "TICKET", width: 11 },
        { value: "PR", width: 5 },
        { value: "VERDICT", width: 14 },
        { value: "CI", width: 4 },
        { value: "💬", width: 2 },
        { value: "AGENT", width: 19 },
        { value: "UPD", width: 4 },
      ]),
    );
    for (const worker of inFlight) {
      const ciText =
        worker.ci_state === "green"
          ? "pass"
          : worker.ci_state === "red"
            ? "FAIL"
            : worker.ci_state === "running"
              ? "run"
              : "-";
      const liveSess = liveAgentStatus.get(worker.worker_id);
      const sessStatus = liveSess?.status ?? worker.session_status;
      const sessAt = liveSess?.activityAt ?? worker.last_activity_at;
      const agentText = sessStatus ? `${sessStatus}(${timeAgo(sessAt)})` : "-";
      const prRef = worker.evidence?.pr ? normalizePrRef(worker.evidence.pr) : "-";
      const prUrl =
        worker.evidence?.pr && /^https?:\/\//.test(worker.evidence.pr)
          ? worker.evidence.pr
          : undefined;
      const ticketUrl = worker.linear_issue_id
        ? `https://linear.app/${LINEAR_WORKSPACE}/issue/${worker.linear_issue_id}`
        : undefined;
      lines.push(
        tableLine([
          { value: statusBadge(worker.status), width: 2 },
          { value: worker.worker_id, width: 14 },
          { value: worker.linear_issue_id ?? "-", width: 11, url: ticketUrl },
          { value: prRef, width: 5, url: prUrl },
          { value: worker.action ?? "-", width: 14 },
          { value: ciText, width: 4 },
          { value: String(worker.unresolved_thread_count ?? 0), width: 2 },
          { value: agentText, width: 19 },
          { value: timeAgo(worker.updated_at), width: 4 },
        ]),
      );
      // Fresh checkpoint summary (worker narrating) beats raw scrollback; stale summary falls back to zmx.
      const updatedMs = Date.now() - new Date(worker.updated_at ?? 0).getTime();
      const narrating = !Number.isNaN(updatedMs) && updatedMs < 3 * 60_000;
      const live = narrating ? null : await getWorkerLiveLine(worker.worker_id);
      lines.push(
        clip(live ? `   ⏵ ${live}` : `   ↳ ${worker.summary || worker.objective}`, 92),
      );
    }
  }
  if (moreInFlight > 0) {
    lines.push(`  … +${moreInFlight} more in flight — /cc-workers`);
  }
  if (dormantCount > 0) {
    lines.push(`  💤 ${dormantCount} dormant worker(s) — /cc-workers`);
  }

  if (nowQueue.length) {
    lines.push("");
    lines.push("Now");
    for (const item of nowQueue) {
      lines.push(`  P${item.priority} ${clip(item.title, 92)}`);
    }
  }

  return lines;
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
  const beacon: string[] = [
    `⚡ CC${hot} · needs-you ${needsYou} · in-flight ${working.length} · queue ${openQueue.length} · alt+c console`,
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
  const lines = await buildConsoleLines(ctx.cwd);
  await showPager(ctx, "Command Centre", lines.join("\n"));
}

function showOutputPanel(ctx: ExtensionCommandContext, content: string) {
  const lines = content.split("\n");
  ctx.ui.setWidget("command-centre-output", lines.slice(0, 300), {
    placement: "belowEditor",
  });
}

/** Scrollable overlay pager for long content — widgets are height-capped by pi. */
class PagerView {
  private offset = 0;
  private readonly pageSize = 20;
  private title: string;
  private raw: string[];
  private tui: { requestRender?: () => void };
  private done: (v: null) => void;
  constructor(
    title: string,
    content: string[],
    tui: { requestRender?: () => void },
    done: (v: null) => void,
  ) {
    this.title = title;
    this.raw = content;
    this.tui = tui;
    this.done = done;
  }
  /** Wrap every logical line to the pane width — nothing is ever clipped. */
  private wrapped(inner: number): string[] {
    const out: string[] = [];
    for (const line of this.raw) {
      if (line.length <= inner) {
        out.push(line);
        continue;
      }
      for (let i = 0; i < line.length; i += inner) out.push(line.slice(i, i + inner));
    }
    return out;
  }
  render(width: number): string[] {
    const inner = Math.max(20, Math.min(width - 4, 110));
    const lines = this.wrapped(inner);
    const total = lines.length;
    const maxOffset = Math.max(0, total - this.pageSize);
    if (this.offset > maxOffset) this.offset = maxOffset;
    if (this.offset < 0) this.offset = 0;
    const end = Math.min(this.offset + this.pageSize, total);
    const pad = (s: string) => `│ ${s}${" ".repeat(Math.max(0, inner - s.length))} │`;
    const head = ` ${this.title} · ${total ? this.offset + 1 : 0}-${end}/${total} · ↑↓ PgUp/PgDn · q closes `;
    const top = `┌${head.slice(0, inner + 2).padEnd(inner + 2, "─")}┐`;
    const bottom = `└${"─".repeat(inner + 2)}┘`;
    const body = lines.slice(this.offset, end).map(pad);
    while (body.length < Math.min(this.pageSize, total)) body.push(pad(""));
    return [top, ...body, bottom];
  }
  handleInput(data: string): void {
    if (matchesKey(data, "escape") || data === "q") {
      this.done(null);
      return;
    }
    if (matchesKey(data, "up")) this.offset -= 1;
    else if (matchesKey(data, "down")) this.offset += 1;
    else if (matchesKey(data, "pageup")) this.offset -= this.pageSize;
    else if (matchesKey(data, "pagedown") || data === " ") this.offset += this.pageSize;
    else if (data === "g") this.offset = 0;
    else if (data === "G") this.offset = Number.MAX_SAFE_INTEGER;
    this.tui.requestRender?.();
  }
  invalidate(): void {}
}

async function showPager(ctx: ExtensionCommandContext, title: string, content: string) {
  if (ctx.mode !== "tui") {
    showOutputPanel(ctx, content);
    return;
  }
  await ctx.ui.custom<null>(
    (tui, _theme, _keybindings, done) => new PagerView(title, content.split("\n"), tui, done),
    { overlay: true },
  );
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

  pi.registerShortcut("alt+d", {
    description: "Command Centre: close/dismiss a worker",
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

  pi.registerCommand("cc", {
    description: "Command Centre router. Example: /cc now, /cc launch ...",
    handler: async (args, ctx) => {
      const [subcommand, ...rest] = (args ?? "").trim().split(/\s+/).filter(Boolean);
      const sessionId = ctx.sessionManager.getSessionId();

      if (!subcommand || subcommand === "now" || subcommand === "console") {
        await openConsole(ctx);
        return;
      }
      if (subcommand === "help") {
        showOutputPanel(ctx, [
          "# /cc — on | off | panel | takeover | clear | now | workers | inspect <id>",
          "- /cc launch --tickets SCAAS-11150,SCAAS-11148 [--repo <path>] [--agent ralph] [--base-pr #875]",
          "- /cc launch <worker_id> [--repo <path>] [--model p/m] [--thinking lvl] <objective>",
          "- /cc add-action <1-4> <title> · /cc approve <id> · /cc reject <id> [reason]",
          "- /cc reply <worker_id> <message> (answer an agent awaiting your input — posts @mention on its ticket)",
          "- /cc needs (all pending decisions, full text, in a scrollable pager)",
          "Plain English works after /cc on. This panel clears on your next prompt (or /cc clear).",
        ].join("\n"));
        return;
      }

      if (subcommand === "takeover") {
        await setActiveController(ctx.cwd, sessionId);
        blockedControllerSessions.delete(sessionId);
        commandCentreModeSessions.add(sessionId);
        dashboardHiddenSessions.delete(sessionId);
        ctx.ui.notify("Command Centre control claimed by this session", "info");
        await renderDashboardWidget(ctx);
        return;
      }

      if (subcommand === "clear") {
        ctx.ui.setWidget("command-centre-output", undefined, { placement: "belowEditor" });
        ctx.ui.notify("Output panel cleared", "info");
        return;
      }

      if (blockedControllerSessions.has(sessionId)) {
        ctx.ui.notify("This session is not the active Command Centre controller. Use /cc takeover.", "warn");
        return;
      }

      if (subcommand === "on") {
        const key = sessionId;
        commandCentreModeSessions.add(key);
        dashboardHiddenSessions.delete(key);
        ctx.ui.notify("Command Centre mode enabled (panel on)", "info");
        await renderDashboardWidget(ctx);
        return;
      }

      if (subcommand === "off") {
        commandCentreModeSessions.delete(sessionId);
        ctx.ui.notify("Command Centre mode disabled", "info");
        return;
      }

      if (subcommand === "panel") {
        const action = (rest[0] ?? "toggle").toLowerCase();
        const key = ctx.sessionManager.getSessionId();
        if (action === "off") {
          dashboardHiddenSessions.add(key);
          ctx.ui.setWidget("command-centre-dashboard", undefined);
          ctx.ui.notify("Command Centre dashboard hidden", "info");
          return;
        }
        if (action === "on") {
          dashboardHiddenSessions.delete(key);
          await renderDashboardWidget(ctx);
          ctx.ui.notify("Command Centre dashboard shown", "info");
          return;
        }
        if (dashboardHiddenSessions.has(key)) {
          dashboardHiddenSessions.delete(key);
          await renderDashboardWidget(ctx);
          ctx.ui.notify("Command Centre dashboard shown", "info");
        } else {
          dashboardHiddenSessions.add(key);
          ctx.ui.setWidget("command-centre-dashboard", undefined);
          ctx.ui.notify("Command Centre dashboard hidden", "info");
        }
        return;
      }

      const commandMap: Record<string, string> = {
        needs: "cc-needs",
        reply: "cc-reply",
        now: "cc-now",
        workers: "cc-workers",
        inspect: "cc-inspect",
        launch: "cc-launch",
        "add-action": "cc-add-action",
        approve: "cc-approve",
        reject: "cc-reject",
      };

      const mapped = commandMap[subcommand];
      if (!mapped) {
        ctx.ui.notify(`Unknown subcommand: ${subcommand}. Use /cc help`, "warn");
        return;
      }

      const payload = ["/" + mapped, ...rest].join(" ").trim();
      pi.sendUserMessage(payload);
    },
  });

  pi.registerCommand("cc-now", {
    description: "Open the Command Centre console (scrollable, no truncation)",
    handler: async (_args, ctx) => {
      await openConsole(ctx);
    },
  });

  pi.registerCommand("cc-workers", {
    description: "List worker checkpoints",
    handler: async (_args, ctx) => {
      const workers = await readWorkerCheckpoints(ctx.cwd);
      if (!workers.length) {
        ctx.ui.notify("No workers found.", "info");
        return;
      }

      const rows = [
        tableLine([
          { value: "", width: 2 },
          { value: "WORKER", width: 16 },
          { value: "STATUS", width: 18 },
          { value: "VERDICT", width: 14 },
          { value: "TICKET", width: 12 },
          { value: "UPD", width: 5 },
          { value: "SUMMARY", width: 70 },
        ]),
        ...workers.map((w) =>
          tableLine([
            { value: statusBadge(w.status), width: 2 },
            { value: w.worker_id, width: 16 },
            { value: w.status, width: 18 },
            { value: w.action ?? "-", width: 14 },
            { value: w.linear_issue_id ?? "-", width: 12 },
            { value: timeAgo(w.updated_at), width: 5 },
            { value: w.summary || w.objective, width: 70 },
          ]),
        ),
      ];
      await showPager(ctx, "Workers", rows.join("\n"));
    },
  });

  pi.registerCommand("cc-inspect", {
    description: "Inspect a worker checkpoint: /cc-inspect <worker_id>",
    handler: async (args, ctx) => {
      const workerId = (args ?? "").trim();
      if (!workerId) {
        ctx.ui.notify("Usage: /cc-inspect <worker_id>", "warn");
        return;
      }

      const paths = await ensureState(ctx.cwd);
      const workerPath = join(paths.workersDir, `${workerId}.json`);
      const checkpoint = await readJson<WorkerCheckpoint | null>(workerPath, null);
      if (!checkpoint) {
        ctx.ui.notify(`Worker not found: ${workerId}`, "warn");
        return;
      }

      await showPager(ctx, `Checkpoint — ${workerId}`, JSON.stringify(checkpoint, null, 2));
    },
  });

  pi.registerCommand("cc-needs", {
    description: "Show every pending decision with full text",
    handler: async (_args, ctx) => {
      const workers = await readWorkerCheckpoints(ctx.cwd);
      const paths = await ensureState(ctx.cwd);
      const queue = await readJson<QueueState>(paths.queueFile, { items: [] });
      const out: string[] = [];
      for (const w of workers.filter(
        (w) => w.status === "blocked" || w.status === "awaiting_approval",
      )) {
        out.push(`■ ${w.worker_id} (${w.status}) — ${w.linear_issue_id ?? "no ticket"}`);
        if (w.blocker) out.push(`  blocker:  ${w.blocker}`);
        if (w.proposed_action) out.push(`  proposed: ${w.proposed_action}`);
        out.push(`  answer:   /cc reply ${w.worker_id} <your answer>`);
        out.push("");
      }
      for (const q of queue.items.filter((i) => i.status === "open")) {
        out.push(`■ ${q.id} P${q.priority} — ${q.title}`);
        if (q.details) out.push(`  ${q.details}`);
        out.push(`  decide:   /cc approve ${q.id}  ·  /cc reject ${q.id} [reason]`);
        out.push("");
      }
      if (!out.length) {
        ctx.ui.notify("Nothing needs you 🎉", "info");
        return;
      }
      await showPager(ctx, "Needs You — full detail", out.join("\n"));
    },
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

  pi.registerCommand("cc-reply", {
    description: "Answer an agent awaiting your input: /cc-reply <worker_id> <message>",
    handler: async (args, ctx) => {
      const parts = (args ?? "").trim().split(/\s+/);
      const workerId = parts[0] ?? "";
      const message = parts.slice(1).join(" ");
      if (!workerId || !message) {
        ctx.ui.notify("Usage: /cc-reply <worker_id> <message>", "warn");
        return;
      }
      await doReply(ctx, workerId, message);
    },
  });

  pi.registerCommand("cc-launch", {
    description:
      "Launch a background worker: /cc-launch <worker_id> [--repo <path>] [--pr <url|#num>] [--model <provider/model>] [--thinking <level>] [--allow-inline-comments] <objective>",
    handler: async (args, ctx) => {
      const parsed = parseLaunchArgs(args);
      if (parsed.tickets.length > 0) {
        await launchTicketWorkers(parsed, ctx);
        return;
      }
      const workerId = parsed.workerId || (await ctx.ui.input("Worker ID", "Enter worker ID:")) || "";
      const objective =
        parsed.objective ||
        (await ctx.ui.input("Objective", "Enter the worker objective:")) ||
        "";
      const repoInput =
        parsed.repo ||
        (await ctx.ui.input(
          "Repo path",
          "Repo path (relative to current dir or absolute). Leave blank for current dir:",
        )) ||
        "";
      const ccConfig = await readCCConfig(ctx.cwd);
      const model =
        parsed.model ||
        (await ctx.ui.input("Model", `Model (blank = ${ccConfig.models.check.model}):`)) ||
        ccConfig.models.check.model;
      const thinking =
        parsed.thinking ||
        (await ctx.ui.input("Thinking", `Thinking level (blank = ${ccConfig.models.check.thinking}):`)) ||
        ccConfig.models.check.thinking;
      const allowInlineComments = parsed.allowInlineComments;
      const expectedPr = parsed.expectedPr || "";

      if (!workerId || !objective) {
        ctx.ui.notify("worker_id and objective are required.", "warn");
        return;
      }

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
      const checkpointPath = join(paths.workersDir, `${workerId}.json`);

      const initialCheckpoint: WorkerCheckpoint = {
        worker_id: workerId,
        status: "working",
        objective,
        expected_pr: expectedPr || undefined,
        summary: "Worker launched",
        permissions: { allow_github_inline_comments: allowInlineComments },
        evidence: { repo: launchCwd, dashboard_links: [] },
        confidence: "medium",
        risk: "low",
        updated_at: new Date().toISOString(),
        model: model || undefined,
        thinking,
      };

      await writeJson(checkpointPath, initialCheckpoint);

      const prompt = buildWorkerPrompt({
        workerId,
        objective,
        checkpointPath,
        repoPath: launchCwd,
        expectedPr: expectedPr || undefined,
        allowInlineComments,
      });

      try {
        await spawnWorkerPi({
          workerId,
          cwd: launchCwd,
          stateCwd: ctx.cwd,
          model,
          thinking,
          prompt,
        });
        await appendEvent(ctx.cwd, {
          type: "worker_launched",
          worker_id: workerId,
          objective,
          model: model || null,
          thinking,
          repo_path: launchCwd,
          allow_inline_comments: allowInlineComments,
          expected_pr: expectedPr || null,
        });
        ctx.ui.notify(`Launched worker ${workerId}`, "info");
        await renderDashboardWidget(ctx);
      } catch (error) {
        initialCheckpoint.status = "failed";
        initialCheckpoint.summary = "Failed to launch worker via zmx";
        initialCheckpoint.blocker = error instanceof Error ? error.message : String(error);
        initialCheckpoint.updated_at = new Date().toISOString();
        await writeJson(checkpointPath, initialCheckpoint);
        await appendEvent(ctx.cwd, {
          type: "worker_launch_failed",
          worker_id: workerId,
          error: initialCheckpoint.blocker,
        });
        ctx.ui.notify(`Failed to launch worker ${workerId}`, "error");
        await renderDashboardWidget(ctx);
      }
    },
  });

  pi.registerCommand("cc-add-action", {
    description: "Add a manual intervention queue item: /cc-add-action <priority:1-4> <title>",
    handler: async (args, ctx) => {
      const parts = (args ?? "").trim().split(/\s+/).filter(Boolean);
      const priorityRaw = parts[0];
      const title = parts.slice(1).join(" ");
      const priority = Number(priorityRaw);

      if (![1, 2, 3, 4].includes(priority) || !title) {
        ctx.ui.notify("Usage: /cc-add-action <priority:1-4> <title>", "warn");
        return;
      }

      const paths = await ensureState(ctx.cwd);
      const queue = await readJson<QueueState>(paths.queueFile, { items: [] });
      const id = `action-${Date.now()}`;
      const now = new Date().toISOString();

      queue.items.push({
        id,
        priority: priority as QueuePriority,
        title,
        source: "manual",
        status: "open",
        created_at: now,
        updated_at: now,
      });

      await writeJson(paths.queueFile, queue);
      await appendEvent(ctx.cwd, {
        type: "queue_item_added",
        action_id: id,
        priority,
        title,
      });

      ctx.ui.notify(`Added queue item ${id}`, "info");
      await renderDashboardWidget(ctx);
    },
  });

  pi.registerCommand("cc-approve", {
    description: "Approve a queue item: /cc-approve <action_id>",
    handler: async (args, ctx) => {
      const actionId = (args ?? "").trim();
      if (!actionId) {
        ctx.ui.notify("Usage: /cc-approve <action_id>", "warn");
        return;
      }

      const paths = await ensureState(ctx.cwd);
      const queue = await readJson<QueueState>(paths.queueFile, { items: [] });
      const item = queue.items.find((entry) => entry.id === actionId);
      if (!item) {
        ctx.ui.notify(`Action not found: ${actionId}`, "warn");
        return;
      }

      item.status = "approved";
      item.updated_at = new Date().toISOString();
      await writeJson(paths.queueFile, queue);
      await appendEvent(ctx.cwd, { type: "queue_approved", action_id: actionId });
      ctx.ui.notify(`Approved ${actionId}`, "info");
      await renderDashboardWidget(ctx);
    },
  });

  pi.registerCommand("cc-reject", {
    description: "Reject a queue item: /cc-reject <action_id> [reason]",
    handler: async (args, ctx) => {
      const parts = (args ?? "").trim().split(/\s+/).filter(Boolean);
      const actionId = parts[0];
      const reason = parts.slice(1).join(" ");
      if (!actionId) {
        ctx.ui.notify("Usage: /cc-reject <action_id> [reason]", "warn");
        return;
      }

      const paths = await ensureState(ctx.cwd);
      const queue = await readJson<QueueState>(paths.queueFile, { items: [] });
      const item = queue.items.find((entry) => entry.id === actionId);
      if (!item) {
        ctx.ui.notify(`Action not found: ${actionId}`, "warn");
        return;
      }

      item.status = "rejected";
      item.updated_at = new Date().toISOString();
      if (reason) {
        item.details = item.details ? `${item.details}\nReject reason: ${reason}` : `Reject reason: ${reason}`;
      }
      await writeJson(paths.queueFile, queue);
      await appendEvent(ctx.cwd, {
        type: "queue_rejected",
        action_id: actionId,
        reason: reason || null,
      });
      ctx.ui.notify(`Rejected ${actionId}`, "info");
      await renderDashboardWidget(ctx);
    },
  });
}
