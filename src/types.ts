/**
 * Shared types for session-link.
 *
 * The handoff is a small JSON document with two zones:
 *   - ENVELOPE (owner = code): who to talk to + how to resume it headlessly.
 *     Fields like sessionRef / askCommand / driver / model / cwd / timestamps are
 *     written by buildHandoff; the agent must never author them.
 *   - BODY (owner = the closing agent): what was actually done and decided.
 *     goal/summary/nextStep form the mandatory "spine"; the rest are optional.
 *
 * `driver` only selects the OUTPUT PARSER (how the raw stdout of the headless
 * run is turned into text). The invocation itself lives in askCommand, so adding
 * a new platform is: author its askCommand when closing + add a parser.
 */

export type DriverName = "pi" | "claude-code" | "qwen";

/** How /session-link starts the next session: review-first, or unattended. */
export type StartMode = "auto" | "manual";

export interface HandoffDecision {
	decision: string;
	rationale: string;
}

export interface HandoffSection {
	title: string;
	/** Markdown body. */
	body: string;
	/** Optional paths the next session should read alongside this section. */
	files?: string[];
}

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

	// ── BODY (agent-authored) ────────────────────────────────────────────────
	/** Overarching objective — WHY this work exists, what "done" looks like. Mandatory for a ready handoff. */
	goal?: string;
	/** What was ACTUALLY done/decided this session (markdown). Mandatory for a ready handoff. */
	summary?: string;
	/** Where the next session picks up / what "done" looks like here. Mandatory for a ready handoff. */
	nextStep?: string;
	/** Short 2–5 word label for THIS session's work, shown in pi's /resume list. Optional authored override; the code derives one from `goal` when absent. */
	sessionTitle?: string;
	/** Blockers and what unblocks them. */
	blockers?: string[];
	/** Consequential choices WITH why, so they aren't re-litigated. */
	decisions?: HandoffDecision[];
	/** Paths created/edited this session. */
	filesChanged?: string[];
	/** Paths the next session MUST read to be productive. */
	filesToRead?: string[];
	/** Gotchas, versions, repro commands (free-form lines or key/value). */
	environment?: string[] | Record<string, string>;
	/** Things deliberately not done/not written down — guards against false "done". */
	deliberatelySkipped?: string[];
	/** Free-form ordered list for anything the fixed fields don't capture. The agent owns the titles. */
	sections?: HandoffSection[];

	// ── legacy / fallback author content ────────────────────────────────────
	/** Optional free-form context note authored by the closing user (the /session-link argument). */
	contextNote?: string;
	/** Optional list of file paths the next session should read (superseded by filesToRead when present). */
	files?: string[];

	// ── commit / chain ───────────────────────────────────────────────────────
	/** Stamp of the last `/session-link-go` that started a child from this handoff (fork-detection hint). */
	committedAt?: string;
	/** Session file of the last child started from this handoff. */
	committedSessionFile?: string;
	/** Previous handoff in a chain (always an immutable archive path, never the live handoff.json). */
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

