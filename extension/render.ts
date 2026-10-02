/**
 * render.ts — the slim render-only prompt (step 3 of the inversion), v2:
 * codemode-native. The tick has ALREADY decided the verdict. The worker
 * composes the message, executes everything in ONE codemode script (post +
 * flush + fetch + jev classify + checkpoint write), and exits. Fallback:
 * sequential bash calls if codemode is unavailable.
 */

export const DELEGATE_TEMPLATE = (ticket: string, agentName: string): string =>
  `@${agentName} please implement ${ticket} end-to-end:
- One-sentence objective from the ticket.
- Branch naming: <owner>/${ticket}-<2-3-word-desc> (stacked slices: <owner>/${ticket}-<slice>).
- Draft PR. PR-DESC CONTRACT (acceptance criteria): body ≤ 10 lines — (1) what & why in 1-2 sentences; (2) a "Ticket: ${ticket}" line; (3) ≤ 6 one-line bullets of key changes (file/component level); (4) breaking changes/rollout notes only if they exist. FORBIDDEN in the body: test evidence or CI output, screenshots, restating the diff, design-essay prose, agent/workflow narration, process checklists, 'next steps' sections.
- COMMIT ATTRIBUTION (non-negotiable): every commit MUST carry a "Co-authored-by: <SUPERVISOR_NAME> <SUPERVISOR_EMAIL>" trailer — the Humans In The Loop gate rejects AI commits without human attribution. Fill from config or the ticket owner.
- Single signed commit, commit header feat(<scope>):.
- MULTI-PR SIZING: estimate changed lines first (tests ≈ 50-60% of a slice). If > ~500 lines, mandate a linear STACK of 2-3 PRs split on file boundaries, each ≤ ~500 lines, stacked branches, one signed commit each. Record ALL PR numbers on the ticket; the supervisor will track them.`;

export interface RenderPromptParams {
  workerId: string;
  ticket: string;
  agentName: string;
  verdict: string;
  reason: string;
  facts: unknown;
  checkpointPath: string;
  eventsPath: string;
  delegateTemplate?: string;
}

/** Slim, render-only, codemode-native. No gather steps, no verdict table. */
export function buildRenderPrompt(p: RenderPromptParams): string {
  const isDelegate = p.verdict === "DELEGATE";
  const replyCriteria = [
    "      doing: actively working on the task or replying it is in progress",
    "      cannot_do: explicitly says it cannot (missing tool, no permission, sandbox limitation)",
    "      done: states the requested work is complete",
    "      question: asks a question and waits on a human",
    "      none: no meaningful activity found",
  ].join("\n");
  return [
    "You are a single-shot RENDER worker. The controller has ALREADY decided the action — do not gather state, do not decide anything, do not second-guess the verdict.",
    "",
    `Verdict: ${p.verdict} — ${p.reason}`,
    "Facts (pre-gathered by the controller; trust these, do not re-fetch):",
    JSON.stringify(p.facts, null, 1),
    "",
    `Ticket: ${p.ticket} · Agent: ${p.agentName} · Checkpoint: ${p.checkpointPath}`,
    "",
    "## Job 1 — compose ONE comment to the agent",
    `@mention "${p.agentName}" explicitly (unmentioned comments are never picked up). Be specific from the facts: PR numbers, SHAs, thread URLs, exact failures. Shapes by verdict:`,
    "  SIGN_SQUASH → name the offending commit + its verified state; squash to exactly one commit; sign via git sign-pr before push; note that re-signing rewrites the head (reviews dismiss).",
    "  ATTRIBUTION_FIX → name the commit and the missing Co-authored-by supervisor trailer; the Humans In The Loop gate rejects AI commits without human attribution.",
    "  NUDGE_THREADS → instruct the agent to REPLY INLINE on each review thread URL from the facts (one reply per thread, on the thread itself). NEVER summarize answers in a top-level PR conversation comment. Never acknowledge bot comments; delete any such comments you already made.",
    "  REBASE → rebase onto master, retarget the PR base if stacked, single commit, re-sign.",
    "  BRANCH_RENAME → use GitHub's branch rename API (gh api repos/<owner>/<repo>/branches/<old>/rename -f new_name=...), NEVER push-new-and-delete-old (that auto-closes PRs).",
    "  ASK → one focused question for the human, as specified in the verdict reason.",
    isDelegate ? "  DELEGATE → post the delegation template below as the comment (fill the one-sentence objective from the ticket):" : "",
    isDelegate ? p.delegateTemplate ?? "" : "",
    "",
    "## Job 2 — execute everything in ONE codemode script",
    "You have the `codemode` tool. Write ONE script that posts the comment, flushes the send queue, fetches the agent's latest activity, classifies it with a jev classifier, writes `reply_class` into the checkpoint, and appends the event. Sketch (adapt; use string concatenation, not template literals, inside the script):",
    [
      "// @options: {\"timeout_ms\": 180000}",
      "// 1. post the comment (compose it in a variable first)",
      `const post = await tools.bash({ command: "linear issue comment add ${p.ticket} --body " + JSON.stringify(comment) });`,
      `// 2. flush the queue: fetch the issue's latest agentSession activities (linear api),`,
      "//    then for every activity with queued:true and sentAt:null:",
      "//      linear api 'mutation { agentActivitySendQueued(id: \"<ACTIVITY_ID>\") { success } }'",
      "// 3. fetch the agent's LATEST activity text (agentSession activities)",
      "// 4. classify with jev:",
      "const jev = await models.getModelOfType(\"classifier\", \"typesafe\", \"jev-latest\");",
      "const cls = await models.classify(jev, {",
      "  state: { latestActivity: <the activity text, trimmed to ~4000 chars> },",
      "  questions: { reply_class: { type: \"choice\",",
      "    instructions: \"What is the agent doing per its latest activity?\",",
      "    criteria: {",
      replyCriteria,
      "    } } } });",
      "const reply_class = cls.stopReason === \"stop\" ? cls.answers.reply_class.choice : \"none\";",
      "// 5. write reply_class into the checkpoint (the ONLY field you may write) and append the event",
    ].join("\n"),
    `Checkpoint write (node one-liner works): set reply_class on ${p.checkpointPath}; then append {"type":"render_done","worker":"${p.workerId}","verdict":"${p.verdict}","reply_class":...} to ${p.eventsPath}.`,
    "",
    "## Fallback (only if the codemode tool is unavailable)",
    "Perform the same five steps with individual bash calls: post → flush queue → fetch latest activity → judge the reply yourself into exactly one of: doing | cannot_do | done | question | none → write reply_class + event.",
    "",
    "Hard rules: touch NOTHING in the checkpoint except reply_class; the controller owns every other field; never top-level-digest answers; one action, then stop.",
  ]
    .filter((l) => l !== "")
    .join("\n");
}