/**
 * verdict-dryrun.ts — eyeball the pure decision function.
 *
 * Two views:
 *   node --experimental-strip-types verdict-dryrun.ts fixtures  → decision table over the incident corpus
 *   node --experimental-strip-types verdict-dryrun.ts live      → live facts vs verdict for every open worker
 *
 * Pure read-only: nothing is posted, no checkpoint is written.
 */

import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { gatherFacts } from "./facts.ts";
import { decideVerdict } from "./verdict.ts";

const mode = process.argv[2] ?? "fixtures";

function row(cells: string[], widths: number[]) {
  return cells
    .map((c, i) => c.length > widths[i]! ? c.slice(0, widths[i]! - 1) + "…" : c.padEnd(widths[i]!))
    .join(" ");
}

if (mode === "fixtures") {
  const { execFileSync } = await import("node:child_process");
  const out = execFileSync(
    "node",
    ["--experimental-strip-types", "--no-warnings", "--test", "verdict.test.ts"],
    { encoding: "utf8", cwd: import.meta.dirname },
  );
  const lines = out
    .split("\n")
    .filter((l) => l.startsWith("✔") || l.startsWith("✖"))
    .map((l) => l.slice(0,1) === "✔" ? `[PASS] ${l.slice(2).trim()}` : `[FAIL] ${l.slice(2).trim()}`);
  console.log("\nDECISION TABLE — incident corpus (run: node --test verdict.test.ts)\n");
  console.log(row(["TEST", "RESULT"], [95, 10]));
  console.log("─".repeat(105));
  for (const l of lines) console.log(l);
  process.exit(0);
}

if (mode === "live") {
  const dir = join(process.env.HOME!, ".pi/command-centre/workers");
  const files = readdirSync(dir).filter((f) => f.endsWith(".json"));
  console.log("\nLIVE DRY-RUN — code verdict vs current checkpoint (read-only)\n");
  console.log(
    row(["WORKER", "TICKET", "NOW(status/action)", "CODE VERDICT", "RENDER", "WRITES/NEEDS-YOU"], [15, 12, 26, 20, 7, 42]),
  );
  console.log("─".repeat(125));
  for (const f of files) {
    let cp: Record<string, unknown> | null = null;
    try {
      cp = JSON.parse(readFileSync(join(dir, f), "utf8")) as Record<string, unknown>;
    } catch {
      continue;
    }
    if (!cp || (cp.status !== "working" && cp.status !== "landing" && cp.status !== "awaiting_approval" && cp.status !== "blocked")) continue;
    const workerId = String(cp.worker_id);
    const ticket = String(cp.linear_issue_id ?? "-");
    const nowLine = `${cp.status}/${cp.action ?? "-"}`;
    try {
      const facts = await gatherFacts(cp as never);
      const verdict = decideVerdict(facts, cp as never);
      const writes = Object.keys(verdict.writes).length
        ? JSON.stringify(verdict.writes)
        : "-";
      const needsYou = verdict.needsYou ? ` ⚠ ${verdict.needsYou.priority}: ${verdict.needsYou.message.slice(0, 60)}` : "";
      console.log(
        row(
          [workerId, ticket, nowLine, verdict.verdict, verdict.needsRender ? "yes" : "no", writes + needsYou],
          [15, 12, 26, 20, 7, 42],
        ),
      );
    } catch (e) {
      console.log(row([workerId, ticket, nowLine, `GATHER FAILED: ${(e as Error).message.slice(0, 40)}`, "-", "-"], [15, 12, 26, 20, 7, 42]));
    }
  }
  console.log("\n(nothing was posted; no checkpoint was modified)\n");
}