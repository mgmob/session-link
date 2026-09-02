/**
 * Shared types for session-link.
 *
 * The handoff is a small JSON document. In v2 it splits into THREE zones
 * (contract §7.1) instead of the v1 two:
 *   - ENVELOPE (owner = code): who to talk to + how to resume it headlessly,
 *     plus the v2 identity fields (id / parent / unit / seq / …). The agent
 *     must never author these.
 *   - DERIVED (owner = code): facts collected by the tool (branch, commits,
 *     filesChanged, timings, …). "Facts are collected, meaning is written."
 *   - BODY (owner = the closing agent): meaning — goal/summary/nextStep form
 *     the mandatory "spine"; the rest are optional.
 *
 * The reader accepts the WHOLE family {v1, v2} (§7.4): `Handoff` is therefore a
 * union. `HandoffCommon` carries the fields present in every version so callers
 * that only touch common fields stay union-safe without narrowing.
 *
 * `driver` only selects the OUTPUT PARSER (how the raw stdout of the headless
 * run is turned into text). The invocation itself lives in askCommand, so adding
 * a new platform is: author its askCommand when closing + add a parser.
 */

export type DriverName = "pi" | "claude-code" | "qwen";

/** How /session-link starts the next session: review-first, or unattended. */
export type StartMode = "auto" | "manual";

/** Line lifecycle (contract §4). The source of truth is the HEAD's field;
 *  index.json only mirrors it. A failed session never closes the line. */
export type LineState = "active" | "done" | "abandoned";

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

/**
 * Fields shared by every handoff version. Kept as a base so callers that only
 * need common fields (most of handoff.ts / index.ts) remain union-safe.
 * `schema` is deliberately NOT here — it's the version discriminator.
 */
export interface HandoffCommon {
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
	/** Argv for the headless resume (no shell, no injection). The QUESTION TEXT is delivered via STDIN at runtime, not as an argv element — a newline in an argv element is truncated by cmd.exe on Windows (issue-6). Any legacy `{QUESTION}` element is filtered out at spawn time. The `howToAsk` field shows the stdin piping form for a manual fallback. */
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
	/** Paths created/edited this session (author's complement to derived.filesChanged — for what git can't see). */
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
	/** Previous handoff in a chain. In v1 — an absolute archive path (the only link). In v2 — demoted to a HINT: the source of truth is `parent.id` (§2.5), this is kept for v1 chains and as a last resort. Never points at a live handoff.json. */
	parentHandoffPath?: string;
	/** Conversation language to carry into the next session (e.g. "Russian"). Auto-detected or set via SESSION_LINK_LANGUAGE. */
	language?: string;
}

/** v1 handoff — the legacy shape still written/read by v0.1.0. */
export interface HandoffV1 extends HandoffCommon {
	schema: "session-link/handoff/v1";
}

/**
 * Structural ancestor reference (contract §2.5). Identity, not location:
 * `id` is immutable and is the source of truth; `unit`/`seq` are hints for a
 * one-shot FS hit; `store` is set only when the ancestor lives in ANOTHER store.
 */
export interface ParentRef {
	id: string;
	/** Hint — which <unit>/ dir to look in first (one FS hop). */
	unit?: string;
	/** For diagnostics / sanity check. */
	seq?: number;
	/** Absolute path to a DIFFERENT store; only for cross-store chains. */
	store?: string;
}

/** A single check result reserved in `derived` (NOT collected in MVP — §7.3). */
export interface DerivedCheck {
	name: string;
	ok: boolean;
	detail?: string;
}

/** Facts collected by the tool (contract §7.3). Best-effort: missing ⇒ omitted,
 *  the write never fails on collection. `baseRef` gates commits/filesChanged. */
export interface DerivedFacts {
	/** HEAD at session start — the base for commits/filesChanged. Absent ⇒ both omitted. */
	baseRef?: string;
	branch?: string;
	/** baseRef..HEAD */
	commits?: string[];
	/** diff baseRef..HEAD + working tree */
	filesChanged?: string[];
	startedAt?: string;
	endedAt?: string;
	/** Reserved — not populated until a declarative source exists (§7.3). */
	checks?: DerivedCheck[];
}

/**
 * v2 handoff (contract §7.2). Adds identity/line/derived fields on top of the
 * common envelope+body. `id`, `unit`, `seq` are required — every v2 record has
 * them (unnamed lines do not exist in v2, §3.2).
 */
export interface HandoffV2 extends HandoffCommon {
	schema: "session-link/handoff/v2";
	/** Immutable link id (§2.5): <YYYYMMDD>T<HHMMSSmmm>-<4hex>. Set on first write, never changes. */
	id: string;
	/** Structural ancestor reference. Absent on the first link of a line. */
	parent?: ParentRef;
	/** Line name (§3). Operator-given, inherited from parent, or technical (u-…). Never derived from the folder name. */
	unit: string;
	/** Name is technical and unconfirmed; cleared by /session-link-name. */
	unitProvisional?: boolean;
	/** Link number in the line. New link = seq(head)+1; redo-in-place keeps it; a fork from N starts at N+1. */
	seq: number;
	/** Line state — source of truth for index.json. Absent ⇒ active. */
	lineState?: LineState;
	/** Facts collected by code. The agent must not author or edit these. */
	derived?: DerivedFacts;
	/** Where the successor should start. Absent ⇒ = cwd. */
	targetCwd?: string;
	/** Opaque external blocks (§8). The tool stores/pass-through only — never writes or interprets. */
	externals?: Record<string, unknown>;
	/** "Part-of" edge (decomposition): this link is part of ANOTHER line's work, as opposed to
	 * `parent` which is "ancestor in time". Separate axis — `resolveParent`/`walkAncestors`
	 * ignore it. Same shape as `parent` (reference by id, not path). */
	partOf?: ParentRef;
	/** Strictness profile of the line (issue #15): "fleet" | <org profile name>.
	 * WRITTEN EXPLICITLY (write/name/fork) or inherited along the line — never derived
	 * from the environment (path, repo name, file presence). Absent ⇒ plain — existing
	 * stores keep working unchanged. "plain" normalizes to absent. The profile is a
	 * property of the LINE: it travels with the chain, not with the machine. */
	profile?: string;
}

/** Any handoff the reader accepts (family {v1, v2}, §7.4). */
export type Handoff = HandoffV1 | HandoffV2;

/** Narrow a read handoff to v2, or undefined. */
export function isHandoffV2(h: Handoff): h is HandoffV2 {
	return h.schema === "session-link/handoff/v2";
}

/** Narrow a read handoff to v1, or undefined. */
export function isHandoffV1(h: Handoff): h is HandoffV1 {
	return h.schema === "session-link/handoff/v1";
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
