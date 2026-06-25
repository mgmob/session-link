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

/** Render a human-readable markdown view of a handoff. */
export function toMarkdown(h: Handoff): string {
	const lines: string[] = [];
	lines.push(`# Context handoff (${h.driver})`);
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
	if (h.contextNote) {
		lines.push("## Context note");
		lines.push("");
		lines.push(h.contextNote);
		lines.push("");
	}
	if (h.topics && h.topics.length > 0) {
		lines.push("## Recent topics from the previous session");
		lines.push("");
		for (const t of h.topics) lines.push(`- ${t}`);
		lines.push("");
	}
	if (h.files && h.files.length > 0) {
		lines.push("## Files to read");
		lines.push("");
		for (const f of h.files) lines.push(`- ${f}`);
		lines.push("");
	}
	lines.push("## askCommand (machine-readable argv template)");
	lines.push("");
	lines.push("```json");
	lines.push(JSON.stringify(h.askCommand));
	lines.push("```");
	return lines.join("\n");
}

/**
 * Write a handoff for a project. Archives any existing current handoff and
 * links it as the parent (so handoff chains are traceable). Returns the path.
 */
export function writeHandoff(cwd: string, h: Handoff): string {
	const dir = handoffDir(cwd);
	fs.mkdirSync(dir, { recursive: true });

	const current = handoffPath(cwd);
	const prev = findHandoff(cwd);
	if (prev) {
		h.parentHandoffPath = prev;
		try {
			fs.copyFileSync(prev, path.join(dir, `handoff-${stamp(h.createdAt)}.json`));
		} catch {
			// archive is best-effort
		}
	}

	fs.writeFileSync(current, JSON.stringify(h, null, 2) + "\n", "utf-8");
	fs.writeFileSync(path.join(dir, "handoff.md"), toMarkdown(h) + "\n", "utf-8");
	return current;
}
