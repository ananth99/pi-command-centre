/**
 * types.ts — shared types, config shape, and defaults.
 * Every module speaks these shapes; the checkpoint is the contract between
 * the tick (code) and the render workers (LLM edges).
 */

export type WorkerStatus = "working" | "landing" | "blocked" | "awaiting_approval" | "done" | "failed";

export type Confidence = "low" | "medium" | "high";

export type Risk = "low" | "medium" | "high";

export type QueuePriority = 1 | 2 | 3 | 4;

export type QueueStatus = "open" | "approved" | "rejected" | "resolved";


export interface WorkerCheckpoint {
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
  agent_session_id?: string;
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
  // v3 — code-verdicts fields (owned by tick/render worker, never the legacy prompt)
  reply_class?: string;
  wait_streak?: number;
  render_count?: number;
}


export interface QueueItem {
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


export interface QueueState {
  items: QueueItem[];
}


export interface ActiveController {
  sessionId: string;
  startedAt: string;
  heartbeatAt?: string;
}


export interface ModelTier {
  model: string;
  thinking: string;
}


export interface CCConfig {
  models: { supervisor: ModelTier; check: ModelTier; takeover: ModelTier; nudge: ModelTier };
  wakeups: { staleMinutes: number; checkTimeoutMinutes: number };
  agent: { name: string };
  /** "code-verdicts": tick runs the pure decision function, spawns LLM only to
   *  render messages. "prompt-verdicts": legacy — worker LLM self-decides. */
  mode: "prompt-verdicts" | "code-verdicts";
  /** Budgets: cap what costs money — render spawns. State verdicts are free.
   *  Exhausted worker → BLOCKED + surfaced to the human. Human reply resets. */
  budgets: { maxRenders: number };
}


export const DEFAULT_CC_CONFIG: CCConfig = {
  models: {
    supervisor: { model: "openrouter/~z-ai/glm-flash-latest", thinking: "low" },
    check: { model: "openrouter/~openai/gpt-luna-latest", thinking: "xhigh" },
    takeover: { model: "openrouter/~openai/gpt-luna-latest", thinking: "xhigh" },
    nudge: { model: "openrouter/~z-ai/glm-flash-latest", thinking: "low" },
  },
  wakeups: { staleMinutes: 10, checkTimeoutMinutes: 15 },
  agent: { name: "the-agent" },
  budgets: { maxRenders: 15 },
};
