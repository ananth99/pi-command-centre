/**
 * ui.ts — everything the human sees.
 *
 * Two surfaces, split on purpose:
 *  - BEACON: a single hard-capped line above the editor. A status light, not
 *    a dashboard — the platform caps widget height, so nothing long renders here.
 *  - CONSOLE: a bordered ScrollView overlay (alt+c) with box tables that wrap
 *    inside cells and flex to terminal width. Where you actually read.
 *
 * pi-tui provides the primitives (ScrollView, width-aware helpers); the
 * box-table renderer is ours.
 */

import type { ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import {
  matchesKey,
  visibleWidth,
  wrapTextWithAnsi,
  truncateToWidth,
  ScrollView,
  Text,
  type Component,
} from "@earendil-works/pi-tui";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { WorkerCheckpoint, WorkerStatus } from "./types";
import { appendEvent, ensureState, getPaths, liveAgentStatus, readJson, readWorkerCheckpoints } from "./state";

const execFileAsync = promisify(execFile);

export const refreshTimers = new Map<string, ReturnType<typeof setInterval>>();

export const commandCentreModeSessions = new Set<string>();

export const dashboardHiddenSessions = new Set<string>();

export const blockedControllerSessions = new Set<string>();

/** Word-wrap to at most maxLines (wide-char aware); ellipsize overflow. */

/** Word-wrap to at most maxLines (wide-char aware); ellipsize overflow. */
export function wrapText(text: string, width: number, maxLines: number): string[] {
  const clean = text.replace(/\s+/g, " ").trim();
  if (!clean) return [""];
  const all = wrapTextWithAnsi(clean, width);
  if (all.length <= maxLines) return all;
  const kept = all.slice(0, maxLines);
  const rest = all.slice(maxLines - 1).join(" ");
  kept[maxLines - 1] = truncateToWidth(rest, width, "\u2026");
  return kept;
}


export function padCell(value: string, width: number) {
  const clean = value.replace(/\s+/g, " ").trim();
  const t = truncateToWidth(clean, width, "\u2026");
  return t + " ".repeat(Math.max(0, width - visibleWidth(t)));
}


export function tableLine(columns: Array<{ value: string; width: number; url?: string }>) {
  return columns
    .map((col) => {
      const padded = padCell(col.value, col.width);
      return col.url ? osc8Link(padded, col.url) : padded;
    })
    .join(" ");
}

/** OSC 8 terminal hyperlink — cmd+click opens in browser (Ghostty/iTerm2/WezTerm). */

/** OSC 8 terminal hyperlink — cmd+click opens in browser (Ghostty/iTerm2/WezTerm). */
export function osc8Link(text: string, url: string) {
  return `\u001b]8;;${url}\u001b\\${text}\u001b]8;;\u001b\\`;
}


export function statusBadge(status: WorkerStatus) {
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


export function timeAgo(iso?: string) {
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


export const ANSI_RE = /\u001b\[[0-9;?]*[A-Za-z]|\u001b\][^\u0007]*\u0007/g;

/** Last meaningful line of a worker's zmx scrollback — the "what is it doing right now" signal. */

/** Last meaningful line of a worker's zmx scrollback — the "what is it doing right now" signal. */
export async function getWorkerLiveLine(workerId: string): Promise<string | null> {
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

export async function buildConsoleLines(cwd: string, width = 100): Promise<string[]> {
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


export interface ConsoleSnap {
  updated: string;
  counts: { needsYou: number; queue: number; inFlight: number };
  nyRows: string[][];
  ifRows: string[][];
  nowRows: string[][];
  moreInFlight: number;
  dormant: number;
}

export const consoleSnapCache = new Map<string, ConsoleSnap>();

/** Sync formatter: renders a snapshot into box tables sized to `width`. */

/** Sync formatter: renders a snapshot into box tables sized to `width`. */
export function formatConsole(s: ConsoleSnap, width: number): string[] {
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

/** Beacon: a fixed ≤3-line status light for the always-on widget — never truncates. */
export async function buildBeaconLines(cwd: string): Promise<string[]> {
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
  return beacon.slice(0, 1);
}


export async function renderDashboardWidget(ctx: ExtensionCommandContext) {
  const key = ctx.sessionManager.getSessionId();
  if (dashboardHiddenSessions.has(key)) {
    ctx.ui.setWidget("command-centre-dashboard", undefined);
    return;
  }
  const beacon = await buildBeaconLines(ctx.cwd);
  ctx.ui.setWidget("command-centre-dashboard", beacon);
}


export async function openConsole(ctx: ExtensionCommandContext) {
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


export function showOutputPanel(ctx: ExtensionCommandContext, content: string) {
  const lines = content.split("\n");
  ctx.ui.setWidget("command-centre-output", lines.slice(0, 300), {
    placement: "belowEditor",
  });
}

/** Scrollable overlay pager for long content — widgets are height-capped by pi. */
/** Content component that renders from a live builder (console tables at real width). */

/** Scrollable overlay pager for long content — widgets are height-capped by pi. */
/** Content component that renders from a live builder (console tables at real width). */
export class StaticContent implements Component {
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

/** Bordered overlay pane backed by pi-tui ScrollView (scrollbar + mouse-wheel). */
export class OverlayPane implements Component {
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


export async function showPager(ctx: ExtensionCommandContext, title: string, content: string) {
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

/**
 * Box-drawing table with per-cell word wrap and flex columns that expand to
 * fill the terminal width. Every returned line is exactly `totalWidth` wide.
 */
export function renderBoxTable(
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
