/**
 * Clarification relay.
 *
 * The previous session runs headlessly (no interactive user). If answering the
 * question requires information only a human has, it must say so explicitly so
 * the next session can surface it to the user. We enforce a tiny output contract:
 *
 *   - To request human input, start the reply with the token `CLARIFY:` on its
 *     own, then list the questions.
 *   - Otherwise, just answer.
 *
 * This is platform- and model-agnostic, which is what makes the relay portable.
 */

export const CLARIFY_TOKEN = "CLARIFY:";

/** Build the prompt sent to the previous session. */
export function wrapQuestion(question: string, clarifications?: string[], language?: string): string {
	const parts: string[] = [];
	parts.push(
		"You are being queried by a FOLLOW-UP session that took over the work after this session was handed off. " +
			"Answer the question below as concretely as you can, drawing on everything in this session's history. " +
			"You may use read-only tools (read/grep/find/ls) to check facts, but you are answering a question, not doing new work.",
	);
	if (clarifications && clarifications.length > 0) {
		parts.push(
			"The follow-up session's user answered your earlier clarification request as follows — use it:\n" +
				clarifications.map((c) => "- " + c).join("\n"),
		);
	}
	if (language) {
		parts.push(`Reply in ${language}.`);
	}
	parts.push(question);
	parts.push(
		"OUTPUT CONTRACT (important): if you need information from a human to answer, do NOT answer yet. " +
			"Start your reply with the single token " +
			CLARIFY_TOKEN +
			" on its own line, followed by the concise questions you need answered (one per line). " +
			"Otherwise, answer directly and do NOT emit " +
			CLARIFY_TOKEN +
			".",
	);
	return parts.join("\n\n");
}

/** Split a previous-session reply into answer vs. clarification request. */
export function parseResponse(raw: string): { kind: "answer" | "clarification"; text: string } {
	const idx = raw.indexOf(CLARIFY_TOKEN);
	if (idx === -1) {
		return { kind: "answer", text: raw.trim() };
	}
	const after = raw
		.slice(idx + CLARIFY_TOKEN.length)
		.trim();
	return { kind: "clarification", text: after };
}
