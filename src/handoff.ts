import * as fs from "node:fs";
import * as path from "node:path";
import type { Handoff } from "./types.ts";

/** Directory where the handoff lives for a given project cwd. */
export function handoffDir(cwd: string): string {
	return path.join(cwd, ".pi", "session_link");
}

/** Path to the "current" handoff for a project. */
export function handoffPath(cwd: string): string {
	return path.join(handoffDir(cwd), "handoff.json");
}

/** Find the current handoff for a cwd, if any. */
export function findHandoff(cwd: string): string | undefined {
	const p = handoffPath(cwd);
	return fs.existsSync(p) ? p : undefined;
}

/** Read + validate a handoff. Returns undefined if missing/corrupt/wrong schema. */
export function readHandoff(p: string): Handoff | undefined {
	try {
		const raw = fs.readFileSync(p, "utf-8");
		const obj = JSON.parse(raw);
		if (obj && obj.schema === "session-link/handoff/v1") {
			return obj as Handoff;
		}
		return undefined;
	} catch {
		return undefined;
	}
}

function stamp(iso: string): string {
	return iso.replace(/[:.]/g, "-");
}

/** The mandatory spine — a handoff is "ready" to commit to a new session iff present. */
export const SPINE_FIELDS = ["goal", "summary", "nextStep"] as const;

/** The agent-authored body fields we merge forward on a redo-in-place. */
export const AGENT_BODY_FIELDS = [
	"goal",
	"summary",
	"nextStep",
	"blockers",
	"decisions",
	"filesChanged",
	"filesToRead",
	"environment",
	"deliberatelySkipped",
	"sections",
] as const;

/** Validate the mandatory spine. Returns ok + the list of missing fields. */
export function validateHandoff(h: Handoff | undefined): { ok: boolean; missing: string[] } {
	const missing: string[] = [];
	if (!h) return { ok: false, missing: [...SPINE_FIELDS] };
	for (const k of SPINE_FIELDS) {
		const v = (h as unknown as Record<string, unknown>)[k];
		if (typeof v !== "string" || v.trim().length === 0) missing.push(k);
	}
	return { ok: missing.length === 0, missing };
}

/** Copy the agent-authored body fields from `src` onto `dst` (only keys that are present). */
function mergeAgentBody(dst: Handoff, src: Handoff | undefined): void {
	if (!src) return;
	for (const k of AGENT_BODY_FIELDS) {
		const v = (src as unknown as Record<string, unknown>)[k];
		if (v !== undefined) (dst as unknown as Record<string, unknown>)[k] = v;
	}
}

function mdEscapeInline(s: string): string {
	return s;
}

/** Render a human-readable markdown view of a handoff. */
export function toMarkdown(h: Handoff): string {
	const lines: string[] = [];
	const v = validateHandoff(h);
	lines.push(`# Context handoff (${h.driver})${v.ok ? "" : " — DRAFT (spine not yet filled)"}`);
	lines.push("");
	lines.push(`- Created: ${h.createdAt}`);
	if (h.sessionName) lines.push(`- Previous session: ${h.sessionName}`);
	if (h.sessionId) lines.push(`- Session id: \`${h.sessionId}\``);
	if (h.model) lines.push(`- Model: ${h.model}`);
	lines.push(`- Working directory: \`${h.cwd}\``);
	lines.push("");

	lines.push("## How to query this previous session headlessly");
	lines.push("");
	lines.push("```");
	lines.push(h.howToAsk);
	lines.push("```");
	lines.push("");

	if (h.goal) {
		lines.push("## Goal");
		lines.push("");
		lines.push(h.goal);
		lines.push("");
	}
	if (h.summary) {
		lines.push("## Summary");
		lines.push("");
		lines.push(h.summary);
		lines.push("");
	}
	if (h.nextStep) {
		lines.push("## Next step");
		lines.push("");
		lines.push(h.nextStep);
		lines.push("");
	}
	if (h.blockers && h.blockers.length > 0) {
		lines.push("## Blockers");
		lines.push("");
		for (const b of h.blockers) lines.push(`- ${b}`);
		lines.push("");
	}
	if (h.decisions && h.decisions.length > 0) {
		lines.push("## Decisions");
		lines.push("");
		for (const d of h.decisions) {
			lines.push(`- **${d.decision}** — ${d.rationale}`);
		}
		lines.push("");
	}
	if (h.filesChanged && h.filesChanged.length > 0) {
		lines.push("## Files changed this session");
		lines.push("");
		for (const f of h.filesChanged) lines.push(`- \`${f}\``);
		lines.push("");
	}
	const toRead = h.filesToRead ?? h.files;
	if (toRead && toRead.length > 0) {
		lines.push("## Files to read");
		lines.push("");
		for (const f of toRead) lines.push(`- \`${f}\``);
		lines.push("");
	}
	if (h.environment) {
		lines.push("## Environment");
		lines.push("");
		if (Array.isArray(h.environment)) {
			for (const e of h.environment) lines.push(`- ${e}`);
		} else {
			for (const [k, val] of Object.entries(h.environment)) lines.push(`- \`${k}\`: ${val}`);
		}
		lines.push("");
	}
	if (h.deliberatelySkipped && h.deliberatelySkipped.length > 0) {
		lines.push("## Deliberately skipped / not written down");
		lines.push("");
		for (const s of h.deliberatelySkipped) lines.push(`- ${s}`);
		lines.push("");
	}
	if (h.sections && h.sections.length > 0) {
		for (const sec of h.sections) {
			lines.push(`## ${sec.title}`);
			lines.push("");
			lines.push(sec.body);
			lines.push("");
			if (sec.files && sec.files.length > 0) {
				for (const f of sec.files) lines.push(`- \`${f}\``);
				lines.push("");
			}
		}
	}
	if (h.contextNote) {
		lines.push("## Context note (from the closing user)");
		lines.push("");
		lines.push(h.contextNote);
		lines.push("");
	}
	lines.push("## askCommand (machine-readable argv template)");
	lines.push("");
	lines.push("```json");
	lines.push(JSON.stringify(h.askCommand));
	lines.push("```");
	void mdEscapeInline;
	return lines.join("\n");
}

/**
 * Write a handoff for a project.
 *
 * Chain / redo rules (so handoff files never corrupt):
 *   - handoff.json is the ONLY mutable file; the chain NEVER points at it.
 *   - If a live handoff exists from the SAME session (sameAuthor by sessionId),
 *     this is a REDO: overwrite in place, keep the existing parentHandoffPath,
 *     and carry forward any agent-authored body fields the agent already filled
 *     (a failed authoring pass must not wipe a good summary).
 *   - If a live handoff exists from a DIFFERENT session, this is a NEW handoff:
 *     archive the old live file to handoff-<stamp>.json and set parentHandoffPath
 *     to that immutable archive.
 *   - parentHandoffPath therefore always points at an archive (or is undefined),
 *     never at the live handoff.json — which also fixes the earlier self-link bug.
 *
 * Returns the path written.
 */
export function writeHandoff(cwd: string, h: Handoff): string {
	const dir = handoffDir(cwd);
	fs.mkdirSync(dir, { recursive: true });

	const current = handoffPath(cwd);
	const existing = readHandoff(current);
	const sameAuthor =
		!!existing && !!h.sessionId && !!existing.sessionId && h.sessionId === existing.sessionId;

	if (existing && !sameAuthor) {
		// New handoff from a different author → archive + advance the chain.
		const archive = path.join(dir, `handoff-${stamp(h.createdAt)}.json`);
		try {
			fs.copyFileSync(current, archive);
			h.parentHandoffPath = archive;
		} catch {
			// archive is best-effort; chain link only set if the copy succeeded
		}
	} else if (existing && sameAuthor) {
		// Redo in place: don't touch the chain, carry forward authored body.
		h.parentHandoffPath = existing.parentHandoffPath;
		mergeAgentBody(h, existing);
	}

	fs.writeFileSync(current, JSON.stringify(h, null, 2) + "\n", "utf-8");
	fs.writeFileSync(path.join(dir, "handoff.md"), toMarkdown(h) + "\n", "utf-8");
	return current;
}

/** Patch the live handoff's commit marker (best-effort) after a child session starts. */
export function markCommitted(cwd: string, committedAt: string, committedSessionFile?: string): void {
	try {
		const p = handoffPath(cwd);
		const h = readHandoff(p);
		if (!h) return;
		h.committedAt = committedAt;
		if (committedSessionFile) h.committedSessionFile = committedSessionFile;
		fs.writeFileSync(p, JSON.stringify(h, null, 2) + "\n", "utf-8");
		fs.writeFileSync(path.join(handoffDir(cwd), "handoff.md"), toMarkdown(h) + "\n", "utf-8");
	} catch {
		// commit marker is best-effort
	}
}
