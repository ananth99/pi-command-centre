/**
 * assigned.ts — poll the human's assigned Linear tickets into assigned.json.
 * Read by the beacon/console in every session; written only by the tick owner.
 */

import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { join } from "node:path";
import { ensureState, readJson, writeJson } from "./state";
import type { AssignedTicket, Blocker } from "./board";

const execFileAsync = promisify(execFile);
const THROTTLE_MS = 90_000;

interface AssignedFile {
  fetchedAt: string;
  tickets: AssignedTicket[];
}

export async function readAssigned(cwd: string): Promise<AssignedTicket[]> {
  const paths = await ensureState(cwd);
  const f = await readJson<AssignedFile>(join(paths.root, "assigned.json"), { fetchedAt: "", tickets: [] });
  return f.tickets;
}

const LAUNCH_STATES = new Set(["Todo", "In Progress"]);

export async function pollAssignedTickets(cwd: string): Promise<void> {
  const paths = await ensureState(cwd);
  const file = join(paths.root, "assigned.json");
  const prev = await readJson<AssignedFile>(file, { fetchedAt: "", tickets: [] });
  if (prev.fetchedAt && Date.now() - new Date(prev.fetchedAt).getTime() < THROTTLE_MS) return;

  const query = `query { viewer { assignedIssues(first: 100, filter: { state: { type: { in: ["triage","unstarted","started"] } } }) { nodes {
    identifier title dueDate estimate priority
    project { name }
    state { name }
    relations { nodes { type relatedIssue { identifier state { type } } } }
  } } } }`;
  const { stdout } = await execFileAsync("linear", ["api", query], { timeout: 20_000, maxBuffer: 4 * 1024 * 1024 });
  const nodes: Array<{
    identifier: string;
    title: string;
    dueDate: string | null;
    estimate: number | null;
    priority: number;
    project: { name: string } | null;
    state: { name: string };
    relations: { nodes: Array<{ type: string; relatedIssue: { identifier: string; state: { type: string } } }> };
  }> = JSON.parse(stdout)?.data?.viewer?.assignedIssues?.nodes ?? [];

  const tickets: AssignedTicket[] = nodes.map((n) => {
    const blockedBy: Blocker[] = (n.relations?.nodes ?? [])
      .filter((r) => r.type === "is-blocked-by")
      .map((r) => ({ id: r.relatedIssue.identifier, done: r.relatedIssue.state.type === "completed" }));
    const allBlockersDone = blockedBy.length === 0 || blockedBy.every((b) => b.done);
    return {
      id: n.identifier,
      title: n.title,
      state: n.state.name,
      priority: n.priority,
      dueDate: n.dueDate,
      estimate: n.estimate,
      project: n.project?.name ?? null,
      blockedBy,
      launchable: allBlockersDone && LAUNCH_STATES.has(n.state.name),
    };
  });
  await writeJson(file, { fetchedAt: new Date().toISOString(), tickets } as AssignedFile);
}
