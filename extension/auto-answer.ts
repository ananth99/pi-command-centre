/**
 * auto-answer.ts — read the agent's question, classify it, and either
 * auto-answer or escalate to the human. Runs in the verdict cycle when
 * a worker's session is awaitingInput.
 *
 * Flow:
 *  1. Read the latest activity from the Linear session
 *  2. Classify with jev: can CC answer this, or does the human decide?
 *  3. If auto-answerable: spawn a render worker to compose + post an answer
 *  4. If not: leave as QUESTION for the human (existing behavior)
 */

import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { spawnRenderRpc } from "./spawns";
import { appendEvent, readCCConfig } from "./state";
import type { WorkerCheckpoint } from "./types";

const execFileAsync = promisify(execFile);

/** Timestamps of questions we've already attempted to answer (avoid loops). */
const attempted = new Map<string, string>();

interface QuestionInfo {
  text: string;
  sessionId: string;
  activityAt: string;
}

async function linearApi(query: string): Promise<unknown> {
  const { stdout } = await execFileAsync("linear", ["api", query], {
    timeout: 15_000,
    maxBuffer: 4 * 1024 * 1024,
  });
  return JSON.parse(stdout);
}

/** Read the latest agent question from the ticket's most recent session. */
export async function readLatestQuestion(ticketId: string): Promise<QuestionInfo | null> {
  // ElicitationContent is how the agent ACTUALLY asks a human question —
  // the render prompt's "question" class never sees it, and the response-only
  // filter silently returned null, so auto-answer never fired (SCAAS-11713-716).
  const data = (await linearApi(
    `query { issue(id:"${ticketId}") { agentSessions(first:5, orderBy:updatedAt) { nodes { id status updatedAt activities(last:60) { nodes { createdAt content { __typename ... on AgentActivityResponseContent { body } ... on AgentActivityElicitationContent { body } ... on AgentActivityPromptContent { body } ... on AgentActivityErrorContent { body } } sourceComment { user { name } } } } } } } }`,
  )) as {
    data?: {
      issue?: {
        agentSessions?: {
          nodes?: Array<{
            id: string;
            status: string;
            updatedAt?: string;
            activities?: {
              nodes?: Array<{
                createdAt: string;
                content?: { __typename: string; body?: string };
                sourceComment?: { user?: { name?: string } };
              }>;
            };
          }>;
        };
      };
    };
  };

  const sessions = data?.data?.issue?.agentSessions?.nodes ?? [];
  const awaiting = sessions.find((s) => /awaiting/i.test(s.status));
  if (!awaiting) return null;

  const activities = awaiting.activities?.nodes ?? [];
  // The agent's ask is either a Response or an Elicitation. Elicitations are
  // authored by the agent itself (sourceComment.user = the agent), so the old
  // `!sourceComment.user` filter would drop them even if they were fetched.
  const asks = activities.filter(
    (a) =>
      (a.content?.__typename === "AgentActivityResponseContent" ||
        a.content?.__typename === "AgentActivityElicitationContent") &&
      a.content.body,
  );
  const last = asks[asks.length - 1];
  if (!last?.content?.body) return null;

  return {
    text: last.content.body.slice(0, 6000),
    sessionId: awaiting.id,
    activityAt: last.createdAt,
  };
}

export type AnswerClass = "auto_answer" | "escalate";

/** Classify whether CC can answer this question or needs to escalate. */
export async function classifyQuestion(
  question: string,
  checkpoint: WorkerCheckpoint,
): Promise<{ classification: AnswerClass; confidence: number }> {
  // Use jev via the render worker's codemode — but since we need a quick
  // decision before spawning, we use a heuristic + keyword approach.
  // Questions about repos, branches, naming, config, process → auto-answer.
  // Questions about credentials, secrets, design decisions, approval → escalate.

  const q = question.toLowerCase();
  // Impossibility first: an explicit "I cannot" is a BLOCKED_IMPOSSIBILITY for
  // the human (the 5-day orbit class), never something to auto-answer around.
  const impossiblePatterns = [
    /\bi cannot\b/,
    /\bcan'?t (retrieve|access|find|reopen|resolve)\b/,
    /\bunable to\b/,
    /\bblocker\b/,
    /cannot be (reopened|retrieved|accessed|resolved)/,
    /(closed|deleted) (with a )?(deleted )?head branch/,
    /has diverged/,
  ];
  for (const p of impossiblePatterns) {
    if (p.test(q)) return { classification: "escalate", confidence: 0.9 };
  }
  const escalatePatterns = [
    /credential|secret|token|password|api.?key/,
    /approv|permission|authoriz/,
    /should (we|i) (change|modify|redesign|refactor)/,
    /design.?(decision|choice|pattern)/,
    /which (approach|option|strategy)/,
    /do you (want|prefer|agree)/,
    /is (this|that|it) (ok|acceptable|correct|right)/,
    /confirm|verify with/,
    /budget|cost|pricing/,
    /deploy|release|rollback|production/,
    /merge (strategy|into|to main)/,
  ];

  const autoPatterns = [
    /which (repo|repository|branch|project|package|directory|folder)/,
    /where (should|do|is|are|can)/,
    /what (is|are) the (repo|branch|ticket|pr|issue)/,
    /how (should|do) (i|we) (name|create|set up|start)/,
    /branch.?nam/,
    /repo(sitory)?.?(path|location|url)/,
    /can (i|you) (proceed|continue|start|go ahead)/,
    /ready to (start|begin|proceed)/,
    /clarif(y|ication) on the (task|objective|scope|requirement)/,
    /what (scope|files|services|endpoints) (should|to)/,
  ];

  for (const p of escalatePatterns) {
    if (p.test(q)) return { classification: "escalate", confidence: 0.8 };
  }
  for (const p of autoPatterns) {
    if (p.test(q)) return { classification: "auto_answer", confidence: 0.8 };
  }

  // Default: if the question is short and simple, try auto-answer;
  // if it's long and complex, escalate.
  if (question.length < 500) return { classification: "auto_answer", confidence: 0.5 };
  return { classification: "escalate", confidence: 0.5 };
}

function buildAutoAnswerPrompt(
  question: string,
  checkpoint: WorkerCheckpoint,
  agentName: string,
): string {
  return [
    "You are a single-shot AUTO-ANSWER worker. The agent asked a question and you must answer it.",
    "",
    "## The agent's question:",
    question,
    "",
    "## Context from the checkpoint:",
    `Ticket: ${checkpoint.linear_issue_id}`,
    `Objective: ${checkpoint.objective}`,
    `Repo: ${checkpoint.evidence?.repo ?? "unknown"}`,
    `Branch: ${checkpoint.evidence?.branch ?? "unknown"}`,
    `PR: ${checkpoint.expected_pr ?? checkpoint.evidence?.pr ?? "none yet"}`,
    `Summary: ${checkpoint.summary}`,
    "",
    "## Your job:",
    `1. Compose a helpful, specific answer to the agent's question. Use the context above.`,
    `2. If the question is about which repo/branch/naming: answer from the checkpoint context.`,
    `3. If the question is about scope/what to implement: answer from the ticket objective.`,
    `4. If you genuinely cannot answer (missing info, needs human judgment): say so clearly.`,
    "",
    "## Execution:",
    `Post your answer as a comment on ${checkpoint.linear_issue_id} mentioning @${agentName}:`,
    `  linear issue comment add ${checkpoint.linear_issue_id} --body "<your answer>"`,
    "",
    "Then flush the send queue (same as render workers):",
    `  Fetch the issue's latest agentSession activities, then for every activity with queued:true and sentAt:null:`,
    `    linear api 'mutation { agentActivitySendQueued(id: "<ACTIVITY_ID>") { success } }'`,
    "",
    `Finally, write reply_class="auto_answered" into the checkpoint at the path provided, and append an event.`,
    "",
    "Hard rules:",
    "- @mention the agent by name. Be direct and specific. One answer, then stop.",
    "- NEVER invent or assume local tooling. Do NOT tell the agent to create, define,",
    "  install, or alias a command (no git aliases, no shell functions, no helper",
    "  scripts). The agent runs in its own sandbox with its own tools — a command",
    "  that works on the operator's laptop does not exist there. If the agent says",
    "  something is unavailable, believe it and escalate to the human instead of",
    "  suggesting it define the missing thing.",
    "- State requirements, never mechanisms. 'One signed commit, verified' — not how to sign.",
  ].join("\n");
}

/** Try to auto-answer a worker's pending question. Returns true if handled. */
export async function tryAutoAnswer(
  checkpoint: WorkerCheckpoint,
  cwd: string,
): Promise<boolean> {
  const ticket = checkpoint.linear_issue_id;
  if (!ticket) return false;

  // Check if we've already attempted this question
  const attemptKey = `${checkpoint.worker_id}`;
  const prevAttempt = attempted.get(attemptKey);

  const question = await readLatestQuestion(ticket);
  if (!question) return false;

  // Don't re-attempt the same question
  if (prevAttempt === question.activityAt) return false;

  const { classification } = await classifyQuestion(question.text, checkpoint);
  if (classification === "escalate") {
    // Store the question text on the checkpoint so the NEEDS YOU table shows it
    attempted.set(attemptKey, question.activityAt);
    return false;
  }

  // Auto-answer: spawn a render worker
  const config = await readCCConfig(cwd);
  const agentName = checkpoint.agent_name ?? config.agent.name;
  const prompt = buildAutoAnswerPrompt(question.text, checkpoint, agentName);

  attempted.set(attemptKey, question.activityAt);

  await appendEvent(cwd, {
    type: "auto_answer_spawned",
    worker_id: checkpoint.worker_id,
    ticket,
    question_preview: question.text.slice(0, 200),
  });

  const result = await spawnRenderRpc({
    workerId: `${checkpoint.worker_id}-auto-answer`,
    cwd,
    model: config.models.nudge.model,
    thinking: config.models.nudge.thinking,
    prompt,
    timeoutMs: 3 * 60_000,
  });

  await appendEvent(cwd, {
    type: "auto_answer_done",
    worker_id: checkpoint.worker_id,
    ticket,
    settled: result.settled,
    timedOut: result.timedOut,
  });

  return result.settled;
}

/** Get the actual question text for display in the NEEDS YOU table. */
export async function getQuestionPreview(ticketId: string): Promise<string | null> {
  try {
    const q = await readLatestQuestion(ticketId);
    if (!q) return null;
    const clean = q.text.replace(/\s+/g, " ").trim();
    return clean.length > 300 ? clean.slice(0, 297) + "…" : clean;
  } catch {
    return null;
  }
}
