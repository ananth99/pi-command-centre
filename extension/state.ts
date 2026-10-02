/**
 * state.ts — the on-disk state store + small shared helpers.
 *
 * Everything lives under <cwd>/.pi/command-centre/: worker checkpoints,
 * the event log (append-only), the controller heartbeat lock, and config.
 * The checkpoint file is the ONLY channel between the tick and workers.
 */

import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { ActiveController, CCConfig, QueueState, WorkerCheckpoint } from "./types";
import { DEFAULT_CC_CONFIG } from "./types";

const execFileAsync = promisify(execFile);

/** Linear workspace slug for ticket deep-links. Override with CC_LINEAR_WORKSPACE. */

/** Linear workspace slug for ticket deep-links. Override with CC_LINEAR_WORKSPACE. */
export const LINEAR_WORKSPACE = process.env.CC_LINEAR_WORKSPACE ?? "bitgo";


export function getPaths(cwd: string) {
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


export async function ensureState(cwd: string) {
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


export async function readJson<T>(path: string, fallback: T): Promise<T> {
  try {
    const raw = await readFile(path, "utf8");
    return JSON.parse(raw) as T;
  } catch {
    return fallback;
  }
}


export async function writeJson(path: string, value: unknown) {
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}


export async function appendEvent(cwd: string, event: Record<string, unknown>) {
  const paths = await ensureState(cwd);
  const line = `${JSON.stringify({ ts: new Date().toISOString(), ...event })}\n`;
  await writeFile(paths.eventsFile, line, { encoding: "utf8", flag: "a" });
}


export async function getActiveController(cwd: string): Promise<ActiveController | null> {
  const paths = await ensureState(cwd);
  return readJson<ActiveController | null>(paths.activeControllerFile, null);
}


export async function setActiveController(cwd: string, sessionId: string) {
  const paths = await ensureState(cwd);
  await writeJson(paths.activeControllerFile, {
    sessionId,
    startedAt: new Date().toISOString(),
    heartbeatAt: new Date().toISOString(),
  } satisfies ActiveController);
}


export async function clearActiveController(cwd: string) {
  const paths = await ensureState(cwd);
  await writeJson(paths.activeControllerFile, null);
}


export function normalizePrRef(ref: string): string {
  const trimmed = ref.trim();
  const urlMatch = trimmed.match(/\/pull\/(\d+)(?:[/?#].*)?$/i);
  if (urlMatch) return `#${urlMatch[1]}`;

  const numberMatch = trimmed.match(/^#?(\d+)$/);
  if (numberMatch) return `#${numberMatch[1]}`;

  return trimmed.replace(/\/+$/, "").toLowerCase();
}


export function hasPrMismatch(expectedPr: string, actualPr: string): boolean {
  return normalizePrRef(expectedPr) !== normalizePrRef(actualPr);
}


export async function readWorkerCheckpoints(cwd: string): Promise<WorkerCheckpoint[]> {
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


export async function readCCConfig(cwd: string): Promise<CCConfig> {
  const paths = await ensureState(cwd);
  const file = join(paths.root, "config.json");
  const loaded = await readJson<Partial<CCConfig>>(file, {});
  return {
    models: { ...DEFAULT_CC_CONFIG.models, ...(loaded.models ?? {}) },
    wakeups: { ...DEFAULT_CC_CONFIG.wakeups, ...(loaded.wakeups ?? {}) },
    agent: { ...DEFAULT_CC_CONFIG.agent, ...(loaded.agent ?? {}) },
    mode: loaded.mode === "code-verdicts" ? "code-verdicts" : "prompt-verdicts",
    budgets: { ...DEFAULT_CC_CONFIG.budgets, ...(loaded.budgets ?? {}) },
  };
}

/** Forgiving shorthands → real catalog ids, so "luna"/"glm" never 404. */

/** Tick-level agent-session probe (no LLM): worker_id -> live Linear session status. */
export const liveAgentStatus = new Map<string, { status: string; activityAt?: string; checkedAt: number }>();
