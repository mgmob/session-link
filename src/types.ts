/**
 * Shared types for session-link.
 *
 * The handoff is a small JSON document that the CLOSING session writes. It tells
 * the next session two things:
 *   1. who to talk to (driver + sessionRef), and
 *   2. exactly how to resume it headlessly (askCommand: an argv template with a
 *      "{QUESTION}" placeholder), so the next session never has to guess the
 *      platform-specific flags.
 *
 * The `driver` field only selects the OUTPUT PARSER (how the raw stdout of the
 * headless run is turned into text). The invocation itself lives in askCommand,
 * so adding a new platform is: author its askCommand when closing + add a parser.
 */

export type DriverName = "pi" | "claude-code" | "qwen";

export interface Handoff {
	schema: "session-link/handoff/v1";
	createdAt: string;
	/** Selects the output parser for the headless run. */
	driver: DriverName;
	/** Token consumed by the driver to resume the session (pi: absolute session file path; claude-code: session id; ...). */
	sessionRef: string;
	sessionId?: string;
	sessionName?: string;
	cwd: string;
	model?: string;
	/** Human + machine readable one-shot invocation (for manual fallback / debugging). */
	howToAsk: string;
	/** Argv template. The element "{QUESTION}" is replaced with the wrapped question at runtime. No shell, no injection. */
	askCommand: string[];
	/** Recent user-message topics (truncated), to seed the next session's understanding. */
	topics?: string[];
	/** Optional free-form context note authored by the closing agent/user. */
	contextNote?: string;
	/** Optional list of file paths the next session should read. */
	files?: string[];
	/** Previous handoff in a chain, if any. */
	parentHandoffPath?: string;
	/** Conversation language to carry into the next session (e.g. "Russian"). Auto-detected or set via SESSION_LINK_LANGUAGE. */
	language?: string;
}

export interface AskRequest {
	question: string;
	handoff: Handoff;
	timeoutMs: number;
	signal?: AbortSignal;
	/** Answers to a previous clarification round, forwarded to the previous session. */
	clarifications?: string[];
}

export interface AskResult {
	/** "answer" = the previous session answered; "clarification" = it needs human input first. */
	kind: "answer" | "clarification";
	text: string;
	raw?: string;
	stderr?: string;
	driver: DriverName;
}

export interface SessionDriver {
	readonly name: DriverName;
	/** Parse raw stdout from a headless run into the previous session's textual reply. */
	parseOutput(raw: string): string;
}
