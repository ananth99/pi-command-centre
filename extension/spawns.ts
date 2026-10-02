/**
 * spawns.ts — process plumbing: how workers actually run.
 *
 * Two transports:
 *  - spawnRenderRpc (v4 default): headless `pi --mode rpc` child — prompt in,
 *    JSONL events out, PID kill on timeout. No PTY anywhere.
 *  - spawnWorkerPi (legacy): zmx PTY + on-disk launcher script. Kept for the
 *    prompt-verdicts rollback path. PTYs truncate typed input ~1KB and can
 *    swallow Enter during shell bootstrap — hence the launcher-script dance.
 */

import { execFile } from "node:child_process";
import { spawn as childSpawn } from "node:child_process";
import { promisify } from "node:util";
import { existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { mkdir, writeFile } from "node:fs/promises";
import type { CCConfig, WorkerCheckpoint } from "./types";
import { appendEvent, ensureState, readCCConfig, readJson, writeJson, getPaths, liveAgentStatus } from "./state";
import { renderDashboardWidget } from "./ui";
import { buildCheckWorkerPrompt } from "./prompts";

const execFileAsync = promisify(execFile);

export function parseLaunchArgs(args: string | undefined) {
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


export async function runZmx(args: string[], cwd: string) {
  return execFileAsync("zmx", args, {
    cwd,
    env: {
      ...process.env,
      SHELL: "/bin/bash",
    },
  });
}


export async function resolvePiBinary(cwd: string): Promise<string> {
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


/** Forgiving shorthands → real catalog ids, so "luna"/"glm" never 404. */
export const MODEL_ALIASES: Record<string, string> = {
  luna: "openrouter/~openai/gpt-luna-latest",
  "luna-5.6": "openrouter/~openai/gpt-luna-latest",
  "luna-5.7": "openrouter/~openai/gpt-luna-latest",
  "gpt-luna": "openrouter/~openai/gpt-luna-latest",
  glm: "openrouter/~z-ai/glm-flash-latest",
  "glm-flash": "openrouter/~z-ai/glm-flash-latest",
  "glm-5.3-flash": "openrouter/~z-ai/glm-flash-latest",
  "glm-5.3": "openrouter/z-ai/glm-5.3",
};


export async function spawnWorkerPi(opts: {
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


export async function launchTicketWorkers(
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

/**
 * runVerdictCycle — the code-verdicts heart. For each worker past the wake-up
 * cadence: gather deterministic facts, decide via the pure function, apply
 * state verdicts DIRECTLY (no LLM), spawn the render worker only when the
 * verdict needs a message composed.
 */

export interface RpcRenderResult {
  settled: boolean;
  timedOut: boolean;
  exitCode: number | null;
  lastEvent: string;
}

/**
 * RPC render spawn (CC v4): headless `pi --mode rpc` child — no PTY, no
 * zmx, no typed commands. Prompt in, JSONL events out; killed by PID on
 * timeout. Kills the entire PTY scar class (1KB truncation, Enter-swallow,
 * reaper) for renders.
 */

/**
 * RPC render spawn (CC v4): headless `pi --mode rpc` child — no PTY, no
 * zmx, no typed commands. Prompt in, JSONL events out; killed by PID on
 * timeout. Kills the entire PTY scar class (1KB truncation, Enter-swallow,
 * reaper) for renders.
 */
export function spawnRenderRpc(opts: {
  workerId: string;
  cwd: string;
  model: string;
  thinking: string;
  prompt: string;
  timeoutMs: number;
}): Promise<RpcRenderResult> {
  return new Promise((resolve) => {
    const args = [
      "--mode",
      "rpc",
      "--no-session",
      "--name",
      opts.workerId,
      "--model",
      opts.model,
      "--thinking",
      opts.thinking,
      "--tools",
      "codemode,read,bash,edit,write",
    ];
    const child = childSpawn("pi", args, { cwd: opts.cwd, stdio: ["pipe", "pipe", "pipe"] });
    let buffer = "";
    let settled = false;
    let done = false;
    let lastEvent = "";
    const finish = (result: RpcRenderResult) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      try {
        child.stdin.end();
      } catch {
        // already closed
      }
      try {
        child.kill("SIGKILL");
      } catch {
        // already dead
      }
      resolve(result);
    };
    const timer = setTimeout(
      () => finish({ settled, timedOut: true, exitCode: child.exitCode, lastEvent: "timeout" }),
      opts.timeoutMs,
    );
    // Binary-split on LF only (never readline: U+2028/2029 are valid in JSON).
    child.stdout.on("data", (chunk: Buffer) => {
      buffer += chunk.toString("utf8");
      let idx: number;
      while ((idx = buffer.indexOf("\n")) >= 0) {
        const line = buffer.slice(0, idx).replace(/\r$/, "");
        buffer = buffer.slice(idx + 1);
        if (!line.trim()) continue;
        let rec: { type?: string } | null = null;
        try {
          rec = JSON.parse(line) as { type?: string };
        } catch {
          continue;
        }
        lastEvent = String(rec.type ?? "");
        if (rec.type === "agent_settled") {
          settled = true;
          finish({ settled: true, timedOut: false, exitCode: null, lastEvent });
        }
      }
    });
    child.on("error", (e: Error) =>
      finish({ settled, timedOut: false, exitCode: null, lastEvent: `spawn_error: ${e.message}` }),
    );
    child.on("close", (code: number | null) =>
      finish({ settled, timedOut: false, exitCode: code, lastEvent: lastEvent || "exit" }),
    );
    try {
      child.stdin.write(JSON.stringify({ id: "cc-render", type: "prompt", message: opts.prompt }) + "\n");
    } catch (e) {
      finish({ settled: false, timedOut: false, exitCode: null, lastEvent: `stdin_error: ${e}` });
    }
  });
}
