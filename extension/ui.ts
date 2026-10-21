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

import type { ExtensionCommandContext, Theme } from "@earendil-works/pi-coding-agent";
import {
  matchesKey,
  visibleWidth,
  wrapTextWithAnsi,
  truncateToWidth,
    Text,
  type Component,
} from "@earendil-works/pi-tui";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import type { WorkerStatus } from "./types";
import {
  deriveBoard,
  fmtDue,
  ageOf,
  oneLine,
  prChain,
  prsOf,
  shortProject,
  todayStats,
  PRIORITY_LABEL,
  type AssignedTicket,
  type Board,
  type BoardWorker,
  type TodayStats,
  type Why,
} from "./board";
import { readAssigned } from "./assigned";
import { appendEvent, ensureState, getActiveController, getPaths, liveAgentStatus, normalizePrRef, readJson, readWorkerCheckpoints, writeJson } from "./state";

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

const FIX_VERDICTS = new Set(["FIX_CI", "REBASE", "NUDGE_THREADS", "NUDGE_SPECIFIC", "SIGN_SQUASH", "ATTRIBUTION_FIX", "BRANCH_RENAME", "DELEGATE"]);

type Paint = (s: string) => string;
const plain: Paint = (s) => s;

/** Semantic colors, bound to pi's active theme (applyTheme) so light/dark and custom themes just work. */
export const tone: { red: Paint; amber: Paint; green: Paint; blue: Paint; dim: Paint; bold: Paint } = {
  red: plain,
  amber: plain,
  green: plain,
  blue: plain,
  dim: plain,
  bold: plain,
};

export function applyTheme(theme: Theme): void {
  tone.red = (s) => theme.fg("error", s);
  tone.amber = (s) => theme.fg("warning", s);
  tone.green = (s) => theme.fg("success", s);
  tone.blue = (s) => theme.fg("accent", s);
  tone.dim = (s) => theme.fg("muted", s);
  tone.bold = (s) => theme.bold(s);
}

const WHY_STYLE: Record<Why, { glyph: string; color: (s: string) => string }> = {
  QUESTION: { glyph: "\u270B", color: tone.amber },
  BLOCKED: { glyph: "\u26D4", color: tone.red },
  STALLED: { glyph: "\u23F8", color: tone.amber },
  APPROVE: { glyph: "\u2705", color: tone.green },
};

function ageTone(text: string, hours: number) {
  return hours >= 48 ? tone.red(text) : hours >= 24 ? tone.amber(text) : text;
}

async function readTodayStats(cwd: string): Promise<TodayStats> {
  try {
    const paths = await ensureState(cwd);
    const raw = await readFile(paths.eventsFile, "utf8");
    const lines = raw.split("\n").slice(-4000);
    const events = lines.flatMap((l) => {
      try {
        return [JSON.parse(l) as { ts?: string; type?: string }];
      } catch {
        return [];
      }
    });
    return todayStats(events, Date.now());
  } catch {
    return { landed: 0, merged: 0, replies: 0 };
  }
}

async function loadBoard(cwd: string) {
  const [checkpoints, assigned] = await Promise.all([readWorkerCheckpoints(cwd), readAssigned(cwd)]);
  const board = deriveBoard({
    workers: checkpoints as unknown as BoardWorker[],
    live: liveAgentStatus as unknown as Map<string, { status: string; activityAt?: string }>,
    assigned,
    now: Date.now(),
  });
  return { checkpoints, assigned, board };
}

export interface ConsoleSnap {
  updated: string;
  now: number;
  board: Board;
  stats: TodayStats;
  ifRows: string[][];
  rvRows: string[][];
  assignedById: Map<string, AssignedTicket>;
}

export const consoleSnapCache = new Map<string, ConsoleSnap>();

export async function buildConsoleLines(cwd: string, width = 100): Promise<string[]> {
  const { checkpoints, assigned, board } = await loadBoard(cwd);
  const now = Date.now();
  const assignedById = new Map(assigned.map((t) => [t.id, t]));
  const byWorker = new Map(checkpoints.map((w) => [w.worker_id, w]));

  const meta = (ticket: string | undefined) => {
    const t = ticket ? assignedById.get(ticket) : undefined;
    const due = fmtDue(t?.dueDate ?? null, now);
    const dueText = due.level === "overdue" ? tone.red(due.text) : due.level === "soon" ? tone.amber(due.text) : due.text;
    return { project: shortProject(t?.project), due: dueText, est: t?.estimate != null ? String(t.estimate) : "-" };
  };

  const ifRows: string[][] = [];
  for (const w of board.inFlight) {
    const full = byWorker.get(w.worker_id)!;
    const live = liveAgentStatus.get(w.worker_id);
    const sess = live?.status ?? full.session_status;
    const sessAt = live?.activityAt ?? full.last_activity_at;
    const updatedMs = now - new Date(full.updated_at ?? 0).getTime();
    const narrating = !Number.isNaN(updatedMs) && updatedMs < 3 * 60_000;
    const nowText = narrating
      ? full.summary || full.objective
      : (await getWorkerLiveLine(w.worker_id)) || full.summary || full.objective;
    const ci = full.ci_state;
    const glyph = ci === "red" ? tone.red("\u2716") : ci === "running" ? tone.amber("\u25D0") : tone.blue("\u25CF");
    const verdict = full.action && FIX_VERDICTS.has(full.action) ? `${full.action} ` : "";
    const threads = full.unresolved_thread_count ? `\u{1F4AC}${full.unresolved_thread_count} ` : "";
    const sessText = sess ? tone.dim(`${sess}(${timeAgo(sessAt)}) `) : "";
    const m = meta(full.linear_issue_id);
    const ciText = ci === "green" ? tone.green("pass") : ci === "red" ? tone.red("FAIL") : ci === "running" ? tone.amber("run") : "-";
    ifRows.push([
      `${full.linear_issue_id ?? full.worker_id}\n${tone.dim(prChain(prsOf(full), full.evidence?.pr))}`,
      m.project,
      `CI ${ciText}\n${tone.dim("due")} ${m.due} ${tone.dim("\u00b7 est")} ${m.est}`,
      `${glyph} ${verdict}${threads}${sessText}\u00b7 ${nowText}`,
    ]);
  }

  const rvRows = board.awaitingReview.map((w) => {
    const full = byWorker.get(w.worker_id)!;
    const m = meta(full.linear_issue_id);
    const age = ageOf(full.updated_at, now);
    return [
      `${full.linear_issue_id ?? full.worker_id}\n${tone.dim(prChain(prsOf(full), full.evidence?.pr))}`,
      m.project,
      ageTone(age.text, age.hours),
      oneLine(full.summary || full.objective || "awaiting human review", 160),
    ];
  });

  const snap: ConsoleSnap = {
    updated: new Date().toLocaleTimeString(),
    now,
    board,
    stats: await readTodayStats(cwd),
    ifRows,
    rvRows,
    assignedById,
  };
  consoleSnapCache.set(cwd, snap);
  return formatConsole(snap, width);
}

function box(title: string, body: string[], width: number, color: (s: string) => string): string[] {
  const inner = Math.max(10, width - 4);
  const head = ` ${title} `;
  const top = color(`\u250c\u2500${head}${"\u2500".repeat(Math.max(0, inner - visibleWidth(head)))}\u2500\u2510`);
  const rows = body.flatMap((b) => wrapTextWithAnsi(b, inner)).map((l) => {
    return `${color("\u2502")} ${l}${" ".repeat(Math.max(0, inner - visibleWidth(l)))} ${color("\u2502")}`;
  });
  return [top, ...rows, color(`\u2514${"\u2500".repeat(inner + 2)}\u2518`)];
}

/** Sync formatter: renders a snapshot into box tables sized to `width`. */
export function formatConsole(s: ConsoleSnap, width: number): string[] {
  const { board: b } = s;
  const out: string[] = [];
  out.push(
    `${tone.dim(`Updated ${s.updated}`)} \u00b7 ${tone.bold(`${b.needsYou.length} need you`)} \u00b7 ${b.inFlight.length} in flight \u00b7 ${b.awaitingReview.length} in review \u00b7 ${b.queue.length} queued`,
  );
  out.push(
    tone.dim(`Today  \u2713 ${s.stats.landed} landed \u00b7 \u21C4 ${s.stats.merged} merged \u00b7 \u270E ${s.stats.replies} replies`),
  );
  out.push("");

  const top = b.needsYou[0];
  if (top) {
    const st = WHY_STYLE[top.why];
    const age = ageOf(top.since, s.now);
    const head = `${st.glyph} ${top.why} \u00b7 ${top.ticket}${top.prs.length ? ` \u00b7 ${prChain(top.prs, top.anchor)}` : ""} \u00b7 ${age.text} \u00b7 ${top.effort}`;
    out.push(...box("NEXT UP", [tone.bold(head), top.text, tone.dim(`\u2192 ${top.doIt}`)], width, st.color));
  } else {
    out.push(
      ...box(
        "ALL CLEAR",
        [`\u2713 Nothing needs you. ${b.inFlight.length} in flight, ${b.awaitingReview.length} waiting on review.`],
        width,
        tone.green,
      ),
    );
  }
  out.push("");

  if (b.needsYou.length) {
    const quick = b.needsYou.filter((n) => n.effortRank === 0).length;
    out.push(tone.bold(`NEEDS YOU`) + tone.dim(quick ? `  (${quick} quick win${quick > 1 ? "s" : ""})` : ""));
    out.push(
      ...renderBoxTable(
        width,
        [
          { title: "WHY", min: 14 },
          { title: "TICKET", min: 18 },
          { title: "WHAT \u2192 DO", min: 30, flex: 1 },
        ],
        b.needsYou.map((n) => {
          const st = WHY_STYLE[n.why];
          const age = ageOf(n.since, s.now);
          return [
            `${st.color(`${st.glyph} ${n.why}`)}\n${n.effort} ${tone.dim("\u00b7")} ${ageTone(age.text, age.hours)}`,
            `${n.ticket}\n${tone.dim(prChain(n.prs, n.anchor))}`,
            `${n.text}\n${tone.dim(`\u2192 ${n.doIt}`)}`,
          ];
        }),
      ),
    );
    out.push("");
  }

  if (s.rvRows.length) {
    out.push(tone.bold("AWAITING REVIEW") + tone.dim("  (parked, waiting for a human to review or merge)"));
    out.push(
      ...renderBoxTable(
        width,
        [
          { title: "TICKET", min: 18 },
          { title: "PROJECT", min: 18 },
          { title: "AGE", min: 5 },
          { title: "SUMMARY", min: 24, flex: 1 },
        ],
        s.rvRows,
      ),
    );
    out.push("");
  }

  out.push(tone.bold("IN FLIGHT"));
  if (!s.ifRows.length) out.push(tone.dim("  nothing running"));
  else
    out.push(
      ...renderBoxTable(
        width,
        [
          { title: "TICKET", min: 18 },
          { title: "PROJECT", min: 18 },
          { title: "STATUS", min: 16 },
          { title: "NOW", min: 24, flex: 1 },
        ],
        s.ifRows,
      ),
    );
  if (b.dormant > 0) out.push(tone.dim(`  \u{1F4A4} ${b.dormant} dormant (no activity for 48h)`));

  if (b.queue.length) {
    out.push("");
    out.push(
      tone.bold("QUEUE") +
        tone.dim("  (assigned to you, no worker yet)") +
        (b.overdue ? tone.red(`  \u2757 ${b.overdue} overdue`) : ""),
    );
    const shown = b.queue.slice(0, 10);
    out.push(
      ...renderBoxTable(
        width,
        [
          { title: "TICKET", min: 14 },
          { title: "PROJECT", min: 18 },
          { title: "DUE", min: 8 },
          { title: "TITLE", min: 24, flex: 1 },
        ],
        shown.map((t) => {
          const due = fmtDue(t.dueDate, s.now);
          const dueText = due.level === "overdue" ? tone.red(due.text) : due.level === "soon" ? tone.amber(due.text) : due.text;
          const pri = PRIORITY_LABEL[t.priority] ?? "-";
          const est = t.estimate != null ? ` \u00b7 est ${t.estimate}` : "";
          const blocked = t.blockedBy?.length && !t.launchable;
          const blockerIds = blocked ? t.blockedBy.filter((b: {done:boolean}) => !b.done).map((b: {id:string}) => b.id).join(", ") : "";
          const status = blocked ? tone.dim(`\u23F8 blocked by ${blockerIds}`) : t.launchable ? tone.green("ready") : tone.dim(t.state);
          return [`${t.id}\n${tone.dim(pri)}${tone.dim(est)}`, shortProject(t.project), dueText, `${t.title}\n${status}`];
        }),
      ),
    );
    if (b.queue.length > shown.length) out.push(tone.dim(`  \u2026 +${b.queue.length - shown.length} more`));
  }
  return out;
}

/** First-seen time per needs-you item (0 = already there when the session started). */
const firstSeen = new Map<string, Map<string, number>>();
const FRESH_MS = 5 * 60_000;

function freshItems(sessionKey: string, items: Array<{ worker: string; why: string; ticket: string }>): string[] {
  const known = firstSeen.get(sessionKey);
  const seeding = !known;
  const map = known ?? new Map<string, number>();
  const now = Date.now();
  const keys = new Set<string>();
  for (const it of items) {
    const k = `${it.worker}:${it.why}`;
    keys.add(k);
    if (!map.has(k)) map.set(k, seeding ? 0 : now);
  }
  for (const k of [...map.keys()]) if (!keys.has(k)) map.delete(k);
  firstSeen.set(sessionKey, map);
  return items.filter((it) => now - (map.get(`${it.worker}:${it.why}`) ?? 0) < FRESH_MS).map((it) => it.ticket);
}

/** Beacon: one line. Never truncates. */
export async function buildBeaconLines(cwd: string, fresh: string[] = []): Promise<string[]> {
  const { board: b } = await loadBoard(cwd);
  const n = b.needsYou.length;
  const efforts = [0, 1, 2]
    .map((r) => [r, b.needsYou.filter((i) => i.effortRank === r).length] as const)
    .filter(([, c]) => c > 0)
    .map(([r, c]) => `${["\u26A1", "\u2615", "\u{1F9F1}"][r]}${c}`)
    .join(" ");
  const head = n ? `\u{1F534} \u270B ${n} need you (${efforts})` : "\u2713 all clear";
  const parts = [
    `\u26A1 CC ${head}`,
    `\u{1F535} ${b.inFlight.length} in flight`,
    `\u{1F6EC} ${b.awaitingReview.length} in review`,
    `\u{1F4E5} ${b.queue.length} queued${b.overdue ? ` (${b.overdue} \u2757)` : ""}`,
    ...(fresh.length ? [tone.amber(`\u{1F195} ${[...new Set(fresh)].join(", ")}`)] : []),
    "alt+c console",
  ];
  return [parts.join(" \u00b7 ")];
}

interface BeaconCache {
  line: string;
  writtenAt: number;
}

const BEACON_STALE_MS = 5 * 60_000;

/** Controller writes the beacon; every session reads it. */
export async function writeBeaconCache(cwd: string, fresh: string[] = []): Promise<void> {
  const paths = await ensureState(cwd);
  const beacon = await buildBeaconLines(cwd, fresh);
  const cache: BeaconCache = { line: beacon[0] ?? "", writtenAt: Date.now() };
  await writeJson(join(paths.root, "beacon.json"), cache);
}

async function readBeaconCache(cwd: string): Promise<string | null> {
  const paths = await ensureState(cwd);
  const cache = await readJson<BeaconCache>(join(paths.root, "beacon.json"), { line: "", writtenAt: 0 });
  if (!cache.line || Date.now() - cache.writtenAt > BEACON_STALE_MS) return null;
  return cache.line;
}

export async function renderDashboardWidget(ctx: ExtensionCommandContext) {
  const key = ctx.sessionManager.getSessionId();
  if (dashboardHiddenSessions.has(key)) {
    ctx.ui.setWidget("command-centre-dashboard", undefined);
    return;
  }
  applyTheme(ctx.ui.theme);

  // Check if this session is the controller
  const active = await getActiveController(ctx.cwd);
  const isController = active?.sessionId === key;

  let line: string;
  if (isController) {
    const { board } = await loadBoard(ctx.cwd);
    const fresh = freshItems(key, board.needsYou);
    const beacon = await buildBeaconLines(ctx.cwd, fresh);
    line = beacon[0] ?? "";
    // Write to disk so other sessions read the same line
    const paths = await ensureState(ctx.cwd);
    await writeJson(join(paths.root, "beacon.json"), { line, writtenAt: Date.now() } satisfies BeaconCache).catch(() => {});
  } else {
    // Reader: use the controller's cached beacon, never recompute
    try {
      line = (await readBeaconCache(ctx.cwd)) ?? "⚡ CC · waiting for controller · alt+c console";
    } catch {
      line = "⚡ CC · beacon read failed · alt+c console";
    }
  }

  const tag = isController ? " \u{1F39B} ctrl" : " \u{1F441} reader";
  ctx.ui.setWidget("command-centre-dashboard", [line + tag]);
}


export async function openConsole(ctx: ExtensionCommandContext) {
  applyTheme(ctx.ui.theme);
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
    { overlay: true, overlayOptions: { width: "98%", maxHeight: "96%", anchor: "center" } },
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

/**
 * Bordered overlay pane with explicit scrolling (keys, PgUp/PgDn, wheel).
 * pi-tui's ScrollView is sized by the layout pass (VStack / fullscreen root);
 * overlays are rendered as plain render(width) and clipped to maxHeight, so a
 * ScrollView never gets a viewport there. Scrolling therefore lives here.
 */
export class OverlayPane implements Component {
  private title: string;
  private content: Component;
  private tui: { requestRender?: () => void; terminal?: { rows?: number } };
  private done: (v: null) => void;
  private top = 0;
  private lastTotal = 0;
  private lastView = 20;
  constructor(
    title: string,
    content: Component,
    tui: { requestRender?: () => void; terminal?: { rows?: number } },
    done: (v: null) => void,
  ) {
    this.title = title;
    this.content = content;
    this.tui = tui;
    this.done = done;
  }
  private viewHeight(): number {
    const rows = this.tui.terminal?.rows ?? process.stdout.rows ?? 40;
    return Math.max(8, Math.floor(rows * 0.94) - 2);
  }
  private clamp() {
    this.top = Math.max(0, Math.min(this.top, Math.max(0, this.lastTotal - this.lastView)));
  }
  render(width: number): string[] {
    const inner = Math.max(20, width - 2);
    const lines = this.content.render(inner - 2);
    const view = this.viewHeight();
    this.lastTotal = lines.length;
    this.lastView = view;
    this.clamp();
    const slice = lines.slice(this.top, this.top + view);
    while (slice.length < Math.min(view, lines.length)) slice.push("");
    const max = Math.max(1, lines.length - view);
    const thumbSize = Math.max(1, Math.round((view * view) / Math.max(view, lines.length)));
    const thumbPos = Math.round((this.top / max) * (view - thumbSize));
    const scrollable = lines.length > view;
    const pos = scrollable ? ` ${this.top + 1}\u2013${Math.min(lines.length, this.top + view)}/${lines.length} ` : "";
    const head = ` ${this.title} \u00b7 \u2191\u2193 j/k scroll \u00b7 PgUp/PgDn \u00b7 g/G \u00b7 q close${pos ? " \u00b7" + pos : ""}`;
    const top = `\u250c${head.slice(0, inner).padEnd(inner, "\u2500")}\u2510`;
    const body = slice.map((l, i) => {
      const padw = Math.max(0, inner - 2 - visibleWidth(l));
      const bar = scrollable && i >= thumbPos && i < thumbPos + thumbSize ? "\u2503" : "\u2502";
      return `\u2502 ${l}${" ".repeat(padw)} ${bar}`;
    });
    const bottom = `\u2514${"\u2500".repeat(inner)}\u2518`;
    return [top, ...body, bottom];
  }
  private scroll(by: number) {
    this.top += by;
    this.clamp();
    this.tui.requestRender?.();
  }
  handleInput(data: string): void {
    if (matchesKey(data, "escape") || data === "q") return this.done(null);
    const page = Math.max(1, this.lastView - 2);
    if (matchesKey(data, "down") || data === "j") return this.scroll(1);
    if (matchesKey(data, "up") || data === "k") return this.scroll(-1);
    if (matchesKey(data, "pageDown") || data === " " || matchesKey(data, "ctrl+d")) return this.scroll(page);
    if (matchesKey(data, "pageUp") || matchesKey(data, "ctrl+u")) return this.scroll(-page);
    if (matchesKey(data, "home") || data === "g") return this.scroll(-1e9);
    if (matchesKey(data, "end") || data === "G") return this.scroll(1e9);
  }
  handleMouse(ev: { type?: string; wheelDelta?: number }): { handled: true; render: true } | undefined {
    if (ev.type !== "wheel" || !ev.wheelDelta) return undefined;
    this.scroll(Math.sign(ev.wheelDelta) * 3);
    return { handled: true, render: true };
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
    { overlay: true, overlayOptions: { width: "98%", maxHeight: "96%", anchor: "center" } },
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
  const overhead = 5 * n + 1; // │ + 2-space padding each side per column + trailing │
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
    l + widths.map((w) => "\u2500".repeat(w + 4)).join(m) + r;
  const rowLines = (cells: string[]): string[] => {
    const wrapped = widths.map((w, i) => {
      const parts = (cells[i] ?? "").split("\n").map((p) => p.replace(/\s+/g, " ").trim());
      const lines = parts.flatMap((p) => (p ? wrapText(p, w, 12) : [""]));
      return lines.length ? lines : [""];
    });
    const height = Math.max(...wrapped.map((c) => c.length), 1);
    const out: string[] = [];
    for (let li = 0; li < height; li++) {
      const parts = widths.map((w, ci) => {
        const line = wrapped[ci]![li] ?? "";
        return `  ${line}${" ".repeat(Math.max(0, w - visibleWidth(line)))}  `;
      });
      out.push(`\u2502${parts.join("\u2502")}\u2502`);
    }
    return out;
  };
  const lines: string[] = [bar("\u250c", "\u252c", "\u2510")];
  lines.push(...rowLines(columns.map((c) => c.title)));
  lines.push(bar("\u251c", "\u253c", "\u2524"));
  rows.forEach((r, i) => {
    if (i > 0) lines.push(tone.dim(bar("\u251c", "\u253c", "\u2524")));
    lines.push(...rowLines(r));
  });
  lines.push(bar("\u2514", "\u2534", "\u2518"));
  return lines;
}
