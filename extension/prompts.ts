/**
 * prompts.ts — legacy prompt builders (prompt-verdicts mode + manual workers).
 *
 * In code-verdicts mode only the RENDER path is used (see render.ts);
 * these builders remain for the legacy self-deciding worker and the
 * one-shot manual worker flow.
 */

import type { WorkerCheckpoint } from "./types";

export function buildWorkerPrompt(params: {
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


export function buildCheckWorkerPrompt(p: {
  workerId: string;
  ticket: string;
  agentName: string;
  expectedPr?: string;
  basePr?: string;
  /** All live PRs to scan (stack order). Undefined/empty → scan only the target PR. */
  scanPrs?: string[];
  repoPath: string;
  checkpointPath: string;
  eventsPath: string;
  firstRun: boolean;
  doNotRename?: boolean;
  knownRepoQuirks?: string[];
}): string {
  const prHint = p.expectedPr
    ? `Target PR (auto-close anchor): ${p.expectedPr}`
    : "No target PR known yet — find it from the ticket's comments/linked PRs. Record it as evidence.pr once found.";
  const scanHint = p.scanPrs?.length
    ? `MULTI-PR STACK — scan EVERY PR below on every wake-up (threads, CI, commits, merge state). Threads on ANY scan PR are this worker's responsibility; NUDGE_THREADS lists them all. scan order: ${p.scanPrs.join(" → ")}. Target PR above is only the merge/auto-close anchor. KEEP THIS LIST CURRENT: if the ticket's comments mention any PR of this ticket that is NOT in checkpoint.scan_prs, ADD it (stack order, base first) in your checkpoint write — and if a scan PR is closed/merged, drop it from the list.`
    : "";
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
    scanHint,
    baseHint,
    quirksHint,
    "",
    "## Step 0 — Memory",
    `Read your checkpoint file first — it is your only memory across wake-ups: ${p.checkpointPath}`,
    "",
    "## Step 1 — Gather (Bash: linear + gh CLIs)",
    `1. Sessions: linear api 'query { issue(id:"${p.ticket}") { title state { name } agentSessions { nodes { id status updatedAt } } } }' — pick the latest session for ${p.agentName}.`,
    "2. If a session exists, read its last few activities via linear api agentSession(id, activities) — the last activity timestamp is critical.",
    "3. If a PR exists: gh pr view <PR> --json state,mergeable,mergeStateStatus,reviewDecision,headRefName,commits,body ; gh pr checks <PR> ; gh api repos/<owner>/<repo>/pulls/<PR>/comments for review threads AND gh api repos/<owner>/<repo>/issues/<PR>/comments for PR conversation comments — a reviewer's 'take a look at the ticket' style conversation comment is just as much a thread to address as an inline one — REPEAT for EVERY PR in the scan list above, not just the target. Thread ids already in checkpoint.addressed_threads must NOT be re-raised — EXCEPT when a comment on that thread is NEWER than the agent's last reply on it (a reviewer follow-up): then the thread is NOT addressed — re-raise it, and REMOVE its id from addressed_threads in your checkpoint write. addressed_threads is a latch, follow-ups break the latch.",
    "CRITICAL — human-approval gates are NOT CI failures: checks like 'Validate Humans In The Loop' (from the ci-ai-checks workflow) only clear when human reviewers approve the PR. No agent action can ever fix them. When evaluating CI red, naming failing checks, or setting ci_state/ci_failure_signature, EXCLUDE these approval gates entirely. A PR whose only failing check is a human-approval gate is CI-green for verdict purposes: set ci_state to 'approval_pending' (not 'red'), ci_failure_signature to null, and take WAIT or the DONE-verdict awaiting_approval path — NEVER NUDGE_SPECIFIC, FIX_CI, or any other CI-red verdict for it.",
    `4. Branch check: PR headRefName MUST match <owner>/${p.ticket}-<2-3-word-desc> (e.g. <owner>/<ticket>-order-read).`,
    "5. Commits: exactly ONE per branch; every commit must have verification.verified == true AND a `Co-authored-by: <ticket owner>` trailer — the Validate Humans In The Loop gate rejects AI commits without human attribution. A committer of 'GitHub' (UI rebase) satisfies neither: amend, add the trailer, and re-sign via the repo's signer flow.",
    "6. If gh pr checks fails with a permission error (Resource not accessible), do NOT block on it — fall back to gh pr view --json mergeStateStatus (CLEAN=green, BLOCKED=red) and note in the checkpoint summary that CI could not be verified directly.",
    "",
    "## Step 2 — Verdict (EXACTLY ONE action, first match wins)",
    `- no_agent_session AND firstRun → DELEGATE: post a comment that @mentions ${p.agentName} explicitly: one-sentence objective + branch naming rule (<owner>/${p.ticket}-<2-3-word-desc>) + draft PR + single signed commit + commit header feat(<scope>): + PR-DESC CONTRACT (hard rule, treat as acceptance criteria): PR body ≤ 10 lines, EXACTLY this structure — (1) what & why in 1-2 sentences; (2) a \`Ticket: ${p.ticket}\` line; (3) ≤ 6 one-line bullets of key changes (file/component level, not per-function); (4) breaking changes / rollout notes, only if they exist. FORBIDDEN anywhere in the PR body: test evidence or CI output, screenshots, restating the diff, design-essay prose, agent/workflow narration ('I have updated the branch...'), process checklists, 'next steps' sections. Tight means tight. COMMIT ATTRIBUTION (non-negotiable): every commit MUST carry a \`Co-authored-by: <SUPERVISOR_NAME> <SUPERVISOR_EMAIL>\` trailer — the Validate Humans In The Loop gate rejects AI commits without human attribution. MULTI-PR SIZING: estimate the ticket's changed lines first (new service/handler + its tests + docs — tests typically ≈ 50-60% of a slice). If the estimate exceeds ~500 changed lines, mandate a linear STACK of 2-3 PRs split on file boundaries (e.g. shared types/glue → core logic → integration/webhook), each ≤~500 lines: each slice gets its own branch stacked on the previous slice's branch, its own docs updates, ONE signed commit; all branches named <owner>/${p.ticket}-<slice>. Instruct the agent to record ALL PR numbers on the ticket and keep evidence.pr pointing at the STACK TOP (merge-retire anchor) while listing the full scan order for the supervisor.`,
    "- ANY commit unsigned OR commits > 1 → SIGN_SQUASH — ABSOLUTE TOP PRIORITY, above review threads, CI nudges, and merge approval. The Humans-In-The-Loop gate blocks merges on BOTH signature AND review, but they are ordered: re-signing rewrites the head, which dismisses reviews — so NEVER chase reviews or approval on an unsigned PR. Comment @mentioning the agent: squash to one commit and sign (git sign-pr before push). After the push, RE-CHECK verification.verified == true on the new head before anything else.",
    "- CI red AND session active AND last activity < 20 min ago → WAIT: update checkpoint only. ('CI red' here and below means real code-check failures only — human-approval gates are excluded per Step 1.)",
    "- CI red AND repeat_failures >= 2 on same failure → NUDGE_SPECIFIC: comment @mentioning the agent with the exact failing log excerpt + one-line hint. repeat_failures is maintained by the Command Centre tick — NEVER modify it yourself.",
    "- CI red AND session stale > 30 min → FIX_CI: post a comment whose body is exactly /fix-ci",
    "- unresolved review threads (not in addressed_threads) AND session stale → NUDGE_THREADS: comment @mentioning the agent listing each unresolved thread URL, one per line; reply inline then push.",
    "- PR unmergeable/conflicts (e.g. stack base merged) → REBASE: comment @mentioning the agent: rebase onto master, retarget base if needed, single commit, re-sign.",
    `- PR body violates the PR-DESC CONTRACT (longer than ~10 lines, or any forbidden content: test evidence/CI output, screenshots, diff restatement, design-essay prose, agent narration, process checklists, 'next steps') → NUDGE_DESC_TRIM: comment @mentioning the agent: 'Rewrite the PR body to the contract: what & why (1-2 sentences), "Ticket: ${p.ticket}", ≤6 key-change bullets, rollout notes only if needed — delete everything else. Edit the PR description only, no code changes.' This verdict fires BEFORE the all-green DONE verdict — never surface a bloated desc for merge approval.`,
    "",
    branchRenameVerdict,
    `- all green (HITL gate BOTH satisfied: every commit verification.verified == true AND reviewDecision APPROVED; plus CI pass, no unresolved threads, single commit, conforming branch) → DONE: set status done, evidence.pr, and ALSO set status awaiting_approval with proposed_action 'Approve merge of <PR> for ${p.ticket}?' so the human decides.`,
    "- same failure 3+ times OR agent overwrote existing work → BLOCKED: status blocked, blocker describes it, propose takeover.",
    "- the agent's latest response explicitly states it CANNOT perform the required action (missing tool, no permission, sandbox limitation) → BLOCKED (impossibility): status blocked, proposed_action states exactly what the human must do (e.g. 'sign the commit yourself — git sign-pr origin/master'), do NOT re-nudge the same action; wait for human reply.",
    "- checkpoint.action has been WAIT for 5+ consecutive wake-ups AND the PR state has not changed → STALLED: status awaiting_approval, proposed_action 'stalled since <date>: waiting on <what>' — surface the stall to the human instead of idling.",
    "- scope/intent unclear, OR the ticket description and target PR scope do not align, OR a stacked sibling PR is mid-rewrite affecting this head → ASK: status awaiting_approval, proposed_action is ONE focused question. Do not guess and do not pause silently.",
    "- OTHERWISE (nothing above matched: agent active, CI running, nothing stale) → WAIT: update checkpoint only.",
    "",
    "## Queue discipline (before ANY comment verdict)",
    "- Read the last 2-3 comments on the ticket via linear api before posting.",
    "- If a prior wake-up already posted a comment on the SAME issue within the last 30 minutes AND the agent has not yet responded to it, that message is QUEUED and pending consumption — do NOT send a duplicate. Take the WAIT verdict instead.",
    "- If the agent HAS responded (queued message consumed) but the issue persists, THEN you may post a new message — but check repeat_failures first.",
    "- If the action you're about to take (verdict name) matches checkpoint.action AND the situation has not changed since last_nudge_at, do NOT re-nudge. Set status to awaiting_approval with proposed_action explaining what's stuck and what the human should do. This is the loop guard — it overrides the verdict table. EXCEPTION: never set awaiting_approval just because the PR is waiting on human CODEOWNER/reviewer approval — parked workers are never scanned for new review threads, and reviewers can leave actionable comments at any time. In that case keep status working with action WAIT so the tick keeps watching the PR.",
    "- Also read each PR body and score it against the PR-DESC CONTRACT (DELEGATE rule below): longer than ~10 lines or any forbidden content → desc violation, verdict NUDGE_DESC_TRIM.",
    "",
    "## Progress narration (live dashboard)",
    `As you work, after EACH major step, update the checkpoint's \"summary\" field with a short present-tense line of what you are doing right now (e.g. \"reading ralph's session activity\", \"checking CI on the PR\", \"posting nudge comment\"). Do it with a compact python3 one-liner that loads ${p.checkpointPath}, sets summary and updated_at (RFC3339 UTC from date -u +%Y-%m-%dT%H:%M:%SZ — never hand-write timestamps), and saves, keeping all other fields intact. This is what the human sees live.`,
    "",
    "## Step 3 — Write checkpoint (ALWAYS, even on WAIT)",
    `Update ${p.checkpointPath} as JSON: status, action (verdict name), summary (one line), ralph_session_id, session_status, last_activity_at, last_nudge_at (if you posted), ci_state ('red' ONLY if a real code check failed; 'approval_pending' if the only failing checks are human-approval gates; 'green' if CI passes; 'unknown' if not yet checked), ci_failure_signature (name of the failing CODE check when ci_state is red — e.g. "Release / Lint Commit Messages"; null when green or approval_pending), unresolved_thread_count, addressed_threads (append delegated threads), evidence.pr (once known), updated_at = now, check_in_progress_at = null. Do NOT touch repeat_failures or last_observed_failure_signature — the Command Centre tick owns those. Load the existing file first and preserve every field you are not explicitly updating (evidence.repo, evidence.dashboard_links, permissions, do_not_rename, known_repo_quirks, model, thinking, etc.) — never rewrite the checkpoint from memory, fields you drop break the tick's automation.`,
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
