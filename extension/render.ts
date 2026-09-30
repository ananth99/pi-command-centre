/**
 * render.ts — the slim render-only prompt (step 3 of the inversion).
 *
 * The tick has ALREADY decided the verdict. This worker does exactly three
 * things: (1) compose the message for the agent, (2) post it + flush
 * Linear's send queue, (3) classify the agent's latest reply into ONE
 * checkpoint field. No gathering, no deciding — those bugs are history.
 */

export const DELEGATE_TEMPLATE = (ticket: string, agentName: string): string =>
  `@${agentName} please implement ${ticket} end-to-end:
- One-sentence objective from the ticket.
- Branch naming: ananth/${ticket}-<2-3-word-desc> (stacked slices: ananth/${ticket}-<slice>).
- Draft PR. PR-DESC CONTRACT (acceptance criteria): body ≤ 10 lines — (1) what & why in 1-2 sentences; (2) a "Ticket: ${ticket}" line; (3) ≤ 6 one-line bullets of key changes (file/component level); (4) breaking changes/rollout notes only if they exist. FORBIDDEN in the body: test evidence or CI output, screenshots, restating the diff, design-essay prose, agent/workflow narration, process checklists, 'next steps' sections.
- COMMIT ATTRIBUTION (non-negotiable): every commit MUST carry a "Co-authored-by: Ananth Madhavan <ananthmadhavan@bitgo.com>" trailer — the Humans In The Loop gate rejects AI commits without human attribution.
- Single signed commit, commit header feat(scaas):.
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

/** Slim, render-only. No gather steps, no verdict table — the tick owns those. */
export function buildRenderPrompt(p: RenderPromptParams): string {
  const isDelegate = p.verdict === "DELEGATE";
  return [
    "You are a single-shot RENDER worker. The controller has ALREADY decided the action — do not gather state, do not decide anything, do not second-guess the verdict.",
    "",
    `Verdict: ${p.verdict} — ${p.reason}`,
    `Facts (pre-gathered by the controller; trust these, do not re-fetch):`,
    JSON.stringify(p.facts, null, 1),
    "",
    `Ticket: ${p.ticket} · Agent: ${p.agentName} · Checkpoint: ${p.checkpointPath}`,
    "",
    "## Job 1 — compose ONE comment to the agent",
    `@mention "${p.agentName}" explicitly (unmentioned comments are never picked up). Be specific from the facts: PR numbers, SHAs, thread URLs, exact failures. Shapes by verdict:`,
    "  SIGN_SQUASH → name the offending commit + its verified state; squash to exactly one commit; sign via git sign-pr before push; note that re-signing rewrites the head (reviews dismiss).",
    "  ATTRIBUTION_FIX → name the commit and the missing trailer (Co-authored-by: Ananth Madhavan <ananthmadhavan@bitgo.com>); the Humans In The Loop gate rejects AI commits without human attribution.",
    "  NUDGE_THREADS → list each thread URL from the facts, one per line; instruct inline replies then push.",
    "  REBASE → rebase onto master, retarget the PR base if stacked, single commit, re-sign.",
    "  BRANCH_RENAME → use GitHub's branch rename API (gh api repos/<owner>/<repo>/branches/<old>/rename -f new_name=...), NEVER push-new-and-delete-old (that auto-closes PRs).",
    "  ASK → one focused question for the human, as specified in the verdict reason.",
    isDelegate ? `  DELEGATE → post the delegation template below as the comment (fill the one-sentence objective from the ticket):` : "",
    isDelegate ? p.delegateTemplate ?? "" : "",
    "",
    "## Job 2 — post + flush",
    `linear issue comment add ${p.ticket} --body "<comment>"`,
    "Then flush Linear's send queue so the message is delivered immediately: query the issue's latest agentSession activities (id, queued, sentAt); for every node with queued:true and sentAt:null run:",
    'linear api \'mutation { agentActivitySendQueued(id: "<ACTIVITY_ID>") { success } }\'',
    "",
    "## Job 3 — classify the agent's latest reply (ONE field)",
    "Read the agent's LATEST activity on the ticket (linear api agentSession activities). Write exactly ONE field into the checkpoint JSON:",
    '  "reply_class" — one of: doing | cannot_do | done | question | none',
    "  cannot_do = the agent explicitly says it cannot (missing tool, no permission, sandbox limitation).",
    "  question = the agent asked something and is waiting on a human.",
    "Touch NOTHING else in the checkpoint. The controller owns every other field.",
    `Append an event: echo '{"type":"render_done","worker":"${p.workerId}","verdict":"${p.verdict}"}' >> ${p.eventsPath}`,
  ]
    .filter((l) => l !== "")
    .join("\n");
}