import type { SessionDriver } from "../types.ts";

/**
 * Claude Code output parser (best-effort).
 *
 * The handoff for a claude-code session is authored elsewhere (a Claude Code
 * hook / slash command would write the same JSON schema with
 * `driver: "claude-code"` and an `askCommand` such as:
 *   ["claude","-p","{QUESTION}","--resume","<session-id>","--output-format","json"]
 * ). Claude Code's JSON output is an object with a `result` field; we take the
 * last JSON line that carries one.
 */
export const claudeCodeDriver: SessionDriver = {
	name: "claude-code",
	parseOutput(raw: string): string {
		const lines = raw.split("\n").filter((l) => l.trim().length > 0);
		for (let i = lines.length - 1; i >= 0; i--) {
			try {
				const o = JSON.parse(lines[i]);
				if (o && typeof o === "object" && ("result" in o || o.type === "result")) {
					return String(o.result ?? "").trim();
				}
			} catch {
				// not JSON — keep scanning
			}
		}
		return raw.trim();
	},
};
