/**
 * Linear Agent extension
 *
 * Lets pi read and drive Linear agent sessions (e.g. Ralph or other agents)
 * using ONLY the personal API key that the `linear` CLI already has.
 *
 * Key insight: you don't need the forbidden `agentActivityCreatePrompt` OAuth
 * mutation to talk to the agent. A plain Linear issue comment on an issue that
 * has an active/delegated agent session becomes an `AgentSessionPrompted`
 * event — the agent picks it up. And `linear issue comment add` works with the
 * personal API key. So everything here shells out to the `linear` CLI.
 *
 * Queue flush: comments can land in the agent session's queue as
 * `queued: true, sentAt: null` — parked, NOT yet delivered to the agent.
 * `linear_agent_prompt` now auto-flushes via `agentActivitySendQueued` after
 * every post, so messages are delivered immediately instead of sitting queued.
 *
 * Tools:
 *   - linear_agent_sessions(issueId)        list agent sessions on an issue
 *   - linear_agent_activity(sessionId)      read a session's activity stream
 *   - linear_agent_prompt(issueId, body)    comment on the issue -> prompts the agent (auto-flushes queue)
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const pexec = promisify(execFile);

async function linear(args: string[]): Promise<string> {
	const { stdout } = await pexec("linear", args, { maxBuffer: 20 * 1024 * 1024 });
	return stdout;
}

async function linearApi(query: string): Promise<unknown> {
	const out = await linear(["api", query]);
	return JSON.parse(out);
}

function textResult(obj: unknown) {
	const text = typeof obj === "string" ? obj : JSON.stringify(obj, null, 2);
	return { content: [{ type: "text" as const, text }], details: (typeof obj === "object" ? obj : { out: obj }) as Record<string, unknown> };
}

/**
 * Flush any queued-but-unsent activities on the issue's latest agent session
 * so the agent receives them immediately instead of waiting in the queue.
 */
async function flushQueuedActivities(issueId: string): Promise<string> {
	try {
		const sess = (await linearApi(
			`query { issue(id: "${issueId}") { agentSessions { nodes { id updatedAt } } } }`,
		)) as { data?: { issue?: { agentSessions?: { nodes?: Array<{ id: string; updatedAt?: string }> } } } };
		const nodes = sess?.data?.issue?.agentSessions?.nodes ?? [];
		nodes.sort((a, b) => (a.updatedAt ?? "").localeCompare(b.updatedAt ?? ""));
		const latest = nodes[nodes.length - 1];
		if (!latest) return "no agent session on issue";

		const acts = (await linearApi(
			`query { agentSession(id: "${latest.id}") { activities(last: 10) { nodes { id queued sentAt } } } }`,
		)) as { data?: { agentSession?: { activities?: { nodes?: Array<{ id: string; queued?: boolean; sentAt?: string | null }> } } } };
		const activities = acts?.data?.agentSession?.activities?.nodes ?? [];
		const queued = activities.filter((a) => a.queued === true && !a.sentAt);
		if (!queued.length) return "delivered (nothing queued)";

		let flushed = 0;
		for (const q of queued) {
			const res = (await linearApi(
				`mutation { agentActivitySendQueued(id: "${q.id}") { success } }`,
			)) as { data?: { agentActivitySendQueued?: { success?: boolean } } };
			if (res?.data?.agentActivitySendQueued?.success) flushed += 1;
		}
		return `flushed ${flushed}/${queued.length} queued activit${queued.length === 1 ? "y" : "ies"} — delivered immediately`;
	} catch (error) {
		return `queue-flush check failed (comment still posted): ${error instanceof Error ? error.message : String(error)}`;
	}
}

export default function linearAgentExtension(pi: ExtensionAPI) {
	pi.registerTool({
		name: "linear_agent_sessions",
		label: "Linear Agent Sessions",
		description: "List the agent sessions on a Linear issue (e.g. SCAAS-10909). Returns session ids + status.",
		promptSnippet: "List Linear agent sessions on an issue",
		parameters: Type.Object({
			issueId: Type.String({ description: "Issue identifier (e.g. SCAAS-10909) or UUID" }),
		}),
		async execute(_id, params) {
			const { issueId } = params as { issueId: string };
			const data = await linearApi(
				`query { issue(id: "${issueId}") { identifier title state { name } agentSessions { nodes { id status createdAt updatedAt } } } }`,
			);
			return textResult(data);
		},
	});

	pi.registerTool({
		name: "linear_agent_activity",
		label: "Linear Agent Activity",
		description: "Read the activity stream (thoughts, actions, responses, prompts) of a Linear agent session by id. Includes queued/sentAt delivery state.",
		promptSnippet: "Read a Linear agent session's activity",
		parameters: Type.Object({
			sessionId: Type.String({ description: "Agent session UUID" }),
		}),
		async execute(_id, params) {
			const { sessionId } = params as { sessionId: string };
			const data = await linearApi(
				`query { agentSession(id: "${sessionId}") { status creator { name } activities { nodes { createdAt queued sentAt content { __typename ... on AgentActivityThoughtContent { body } ... on AgentActivityResponseContent { body } ... on AgentActivityActionContent { action } ... on AgentActivityPromptContent { body } ... on AgentActivityErrorContent { body } } sourceComment { user { name } } } } } }`,
			);
			return textResult(data);
		},
	});

	pi.registerTool({
		name: "linear_agent_prompt",
		label: "Linear Agent Prompt",
		description:
			"Prompt/talk to a Linear agent by posting a comment on its issue. Works with the personal API key. The issue must already have an active or delegated agent session for the agent to pick it up. Auto-flushes Linear's send queue so the message is delivered immediately.",
		promptSnippet: "Send a prompt to a Linear agent via an issue comment",
		promptGuidelines: [
			"Use only when the user explicitly wants to instruct a Linear agent.",
			"Different Linear agents are separate identities. Always explicitly @mention the intended one by name in the comment body (e.g. '@ralph ...') -- do not assume a plain comment will be picked up, and do not default to @ralph unless the user asked for Ralph specifically.",
			"If unsure which agent owns a given issue, check linear_agent_sessions / linear_agent_activity first (the session's creator/sourceComment.user.name shows which agent has been responding) before prompting.",
		],
		parameters: Type.Object({
			issueId: Type.String({ description: "Issue identifier (e.g. SCAAS-10909)" }),
			body: Type.String({ description: "Comment/prompt body. Must explicitly @mention the intended agent by name (e.g. '@ralph') -- different agents are separate identities and may not pick up an unmentioned comment." }),
			parentCommentId: Type.Optional(Type.String({ description: "Reply under this comment id (optional)" })),
		}),
		async execute(_id, params) {
			const p = params as { issueId: string; body: string; parentCommentId?: string };
			const args = ["issue", "comment", "add", p.issueId, "--body", p.body];
			if (p.parentCommentId) args.push("--parent", p.parentCommentId);
			const out = await linear(args);
			const flushNote = await flushQueuedActivities(p.issueId);
			return textResult(`${out.trim() || "comment posted"}\nqueue: ${flushNote}`);
		},
	});
}
