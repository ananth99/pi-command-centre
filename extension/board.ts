/**
 * board.ts — the single source of truth for what the human sees.
 *
 * Pure: checkpoints + live probe + assigned tickets in, one Board out.
 * Both the beacon and the console render from the same Board, so they can
 * never disagree, and a worker appears in exactly one section.
 */

export type Why = "QUESTION" | "BLOCKED" | "STALLED" | "APPROVE";

export interface Blocker {
  id: string;
  done: boolean;
}

export interface AssignedTicket {
  id: string;
  title: string;
  state: string;
  priority: number;
  dueDate: string | null;
  estimate: number | null;
  project: string | null;
  blockedBy: Blocker[];
  launchable: boolean;
}

export interface BoardWorker {
  worker_id: string;
  status: string;
  linear_issue_id?: string;
  action?: string;
  summary?: string;
  objective?: string;
  blocker?: string;
  proposed_action?: string;
  updated_at?: string;
  last_nudge_at?: string;
  scan_prs?: string[];
  evidence?: { pr?: string };
  ci_state?: string;
  unresolved_thread_count?: number;
  session_status?: string;
  last_activity_at?: string;
  agent_name?: string;
}

export interface LiveStatus {
  status: string;
  activityAt?: string;
  questionPreview?: string;
}

export interface NeedsYouItem {
  why: Why;
  worker: string;
  ticket: string;
  prs: string[];
  anchor?: string;
  since?: string;
  text: string;
  doIt: string;
  effort: string;
  effortRank: number;
}

export interface Board {
  needsYou: NeedsYouItem[];
  inFlight: BoardWorker[];
  awaitingReview: BoardWorker[];
  queue: AssignedTicket[];
  overdue: number;
  dormant: number;
  /** Tickets ready to auto-launch (launchable, untracked, in a launch state). */
  launchReady: AssignedTicket[];
}

const WHY_ORDER: Record<Why, number> = { QUESTION: 0, BLOCKED: 1, STALLED: 2, APPROVE: 3 };

const EFFORT: Record<Why, { label: string; rank: number; doIt: string }> = {
  QUESTION: { label: "\u26A1 30s", rank: 0, doIt: "alt+r reply" },
  APPROVE: { label: "\u2615 5m", rank: 1, doIt: "review the PR, merge yourself" },
  STALLED: { label: "\u2615 5m", rank: 1, doIt: "alt+i inspect, then alt+r or alt+k" },
  BLOCKED: { label: "\u{1F9F1} 30m+", rank: 2, doIt: "alt+i inspect, fix by hand" },
};

export function normalizePr(ref: unknown): string {
  if (typeof ref !== "string") return ref == null ? "" : `#${ref}`;
  const t = ref.trim();
  const url = t.match(/\/pull\/(\d+)/i);
  if (url) return `#${url[1]}`;
  const n = t.match(/^#?(\d+)$/);
  return n ? `#${n[1]}` : t;
}

export function prsOf(w: Pick<BoardWorker, "scan_prs" | "evidence">): string[] {
  const raw = w.scan_prs?.length ? w.scan_prs : w.evidence?.pr ? [w.evidence.pr] : [];
  return [...new Set(raw.map(normalizePr).filter(Boolean))];
}

/** "#984→985" for a small stack, "#996 +3" beyond three. */
export function prChain(prs: string[], anchor?: string): string {
  if (!prs.length) return "-";
  if (prs.length === 1) return prs[0]!;
  if (prs.length <= 3) return [prs[0]!, ...prs.slice(1).map((p) => p.replace(/^#/, ""))].join("\u2192");
  const a = anchor ? normalizePr(anchor) : prs[prs.length - 1]!;
  return `${a} +${prs.length - 1}`;
}

/** First sentence(s) up to ~max chars, cut at a word boundary. */
export function oneLine(text: string, max = 200): string {
  const clean = text.replace(/\s+/g, " ").trim();
  if (clean.length <= max) return clean;
  const cut = clean.slice(0, max);
  const stop = Math.max(cut.lastIndexOf(". "), cut.lastIndexOf("; "));
  if (stop > max * 0.5) return cut.slice(0, stop + 1);
  return `${cut.slice(0, cut.lastIndexOf(" "))}\u2026`;
}

function repliedRecently(w: BoardWorker, now: number): boolean {
  return !!w.last_nudge_at && now - new Date(w.last_nudge_at).getTime() < 5 * 60_000;
}

export function deriveBoard(input: {
  workers: BoardWorker[];
  live: Map<string, LiveStatus>;
  assigned: AssignedTicket[];
  now: number;
}): Board {
  const { workers, live, assigned, now } = input;
  const needsYou: NeedsYouItem[] = [];
  const claimed = new Set<string>();

  const push = (w: BoardWorker, why: Why, text: string, since?: string) => {
    claimed.add(w.worker_id);
    const prs = prsOf(w);
    const e = EFFORT[why];
    needsYou.push({
      why,
      worker: w.worker_id,
      ticket: w.linear_issue_id ?? w.worker_id,
      prs,
      anchor: w.evidence?.pr,
      since,
      text,
      doIt: e.doIt,
      effort: e.label,
      effortRank: e.rank,
    });
  };

  for (const w of workers) {
    if (w.status !== "working" && w.status !== "landing") continue;
    const s = live.get(w.worker_id);
    if (s && /awaiting/i.test(s.status) && !repliedRecently(w, now)) {
      const preview = s.questionPreview;
      const text = preview
        ? `${w.agent_name ?? "The agent"} asks: ${preview}`
        : `${w.agent_name ?? "The agent"} asked you something \u2014 read its latest comment on ${w.linear_issue_id ?? "the ticket"}.`;
      push(w, "QUESTION", text, s.activityAt);
    }
  }

  for (const w of workers) {
    if (claimed.has(w.worker_id)) continue;
    // The agent's own ask beats our paraphrase of it: an elicitation saying
    // "raise the sandbox memory limit above 8 GiB" is actionable in a way that
    // "stalled — waiting on your reply to the agent" is not.
    const ask = live.get(w.worker_id)?.questionPreview;
    const fallback = (d: string) => (ask ? `agent asked: ${ask}` : d);
    if (w.status === "blocked") {
      push(w, "BLOCKED", oneLine(fallback(w.blocker || w.summary || w.objective || "blocked")), w.updated_at);
    } else if (w.status === "awaiting_approval") {
      const stalled = w.action === "STALLED";
      push(
        w,
        stalled ? "STALLED" : "APPROVE",
        oneLine(fallback(w.proposed_action || w.summary || w.objective || (stalled ? "stalled" : "ready for you"))),
        w.updated_at,
      );
    }
  }

  needsYou.sort(
    (a, b) =>
      WHY_ORDER[a.why] - WHY_ORDER[b.why] ||
      new Date(a.since ?? 0).getTime() - new Date(b.since ?? 0).getTime(),
  );

  const rest = workers.filter((w) => !claimed.has(w.worker_id));
  const awaitingReview = rest.filter((w) => w.status === "landing");
  const active = rest.filter((w) => w.status === "working");
  const fresh = now - 48 * 3600_000;
  const inFlight = active.filter((w) => new Date(w.updated_at ?? 0).getTime() >= fresh);

  const tracked = new Set(workers.map((w) => w.linear_issue_id).filter(Boolean));
  const queue = assigned
    .filter((t) => !tracked.has(t.id))
    .sort(
      (a, b) =>
        (a.priority || 5) - (b.priority || 5) ||
        (a.dueDate ?? "9999").localeCompare(b.dueDate ?? "9999"),
    );
  const today = new Date(now).toISOString().slice(0, 10);
  const overdue = queue.filter((t) => t.dueDate && t.dueDate < today).length;

  const launchReady = queue.filter((t) => t.launchable);
  return { needsYou, inFlight, awaitingReview, queue, overdue, dormant: active.length - inFlight.length, launchReady };
}

export function fmtDue(due: string | null, now: number): { text: string; level: "none" | "ok" | "soon" | "overdue" } {
  if (!due) return { text: "-", level: "none" };
  const d = new Date(`${due}T00:00:00Z`);
  const text = d.toLocaleDateString("en-US", { month: "short", day: "numeric", timeZone: "UTC" });
  const days = Math.floor((d.getTime() - new Date(new Date(now).toISOString().slice(0, 10)).getTime()) / 86400_000);
  if (days < 0) return { text: `\u2757 ${text}`, level: "overdue" };
  return { text, level: days <= 2 ? "soon" : "ok" };
}

export const PRIORITY_LABEL: Record<number, string> = { 0: "-", 1: "Urgent", 2: "High", 3: "Med", 4: "Low" };

export function ageOf(iso: string | undefined, now: number): { text: string; hours: number } {
  if (!iso) return { text: "-", hours: 0 };
  const ms = now - new Date(iso).getTime();
  if (Number.isNaN(ms) || ms < 0) return { text: "-", hours: 0 };
  const mins = Math.floor(ms / 60000);
  const hours = mins / 60;
  if (mins < 1) return { text: "now", hours };
  if (mins < 60) return { text: `${mins}m`, hours };
  if (hours < 24) return { text: `${Math.floor(hours)}h`, hours };
  return { text: `${Math.floor(hours / 24)}d`, hours };
}

export interface TodayStats {
  landed: number;
  merged: number;
  replies: number;
}

export function todayStats(events: Array<{ ts?: string; type?: string }>, now: number): TodayStats {
  const day = new Date(now).toISOString().slice(0, 10);
  const s: TodayStats = { landed: 0, merged: 0, replies: 0 };
  for (const e of events) {
    if (!e.ts?.startsWith(day)) continue;
    if (e.type === "worker_landing") s.landed++;
    else if (e.type === "worker_auto_closed") s.merged++;
    else if (e.type === "human_reply") s.replies++;
  }
  return s;
}

/** Readable project label: drop the team prefix, cap long names at a word boundary. */
export function shortProject(name: string | null | undefined, max = 60): string {
  if (!name) return "-";
  const n = name.replace(/^SCaaS\s+/i, "").replace(/\s+/g, " ").trim();
  if (n.length <= max) return n;
  const cut = n.slice(0, max);
  return `${cut.slice(0, cut.lastIndexOf(" "))}\u2026`;
}
