/**
 * The starter prompt the NEXT session receives — the thin pointer at the handoff
 * file. Shared by the pi extension (`/session-link-go`) and the CLI `go`, so both
 * spawn a successor with the same instructions. Pure: no platform deps; the agent
 * never authors this; the only variable is the handoff file path.
 */
export function buildStarterPrompt(
	handoffFile: string,
	opts: { language?: string; unitProvisional?: boolean; preamble?: string; postamble?: string } = {},
): string {
	const lines: string[] = [];
	lines.push("# Context handoff (auto-started by /session-link)");
	if (opts.language) {
		// Prominent + at the very top: this prompt is English, so an explicit
		// instruction here is what keeps the new session in the user's language.
		lines.push("");
		lines.push(
			"> LANGUAGE: Communicate with me in **" +
				opts.language +
				"** throughout this entire session — every status update, understanding report, and summary. Match the user's language; do not switch to English unless I do.",
		);
	}
	// Preamble (issue #15): the org-steps block, BEFORE the seven steps. The
	// plugin inserts it verbatim — it never interprets org texts (the plugin
	// must not know organizations, only that a profile may carry a block).
	if (opts.preamble) {
		lines.push("");
		lines.push(opts.preamble);
		lines.push("");
		lines.push("---");
	}
	lines.push("");
	lines.push("The previous session handed off context. The handoff is at:");
	lines.push(`  ${handoffFile}`);
	lines.push("");
	lines.push("Proceed now:");
	lines.push("1. Call the `current_session` tool to confirm your identity.");
	lines.push("2. Read the handoff file. Its body fields (`goal`, `summary`, `nextStep`, plus any `blockers`/`decisions`/`filesToRead`/`sections`) ARE the context — start there, not at the envelope. The `derived` block (branch/commits/filesChanged) is CODE-collected facts — read them as facts, the agent didn't author them.");
	lines.push("3. Read every file in the handoff's `filesToRead` (and anything cited in `summary`/`nextStep`).");
	lines.push("4. For the actual current state of changed files, trust GIT over the handoff's `filesChanged` (that list is only a reading hint and can drift across uncommitted sessions): run `git diff HEAD` (uncommitted) and `git diff <merge-base/main>..HEAD` (committed) to see the complete current file state. The handoff's `summary`/`sections` carry the INTENT; git carries the line-level truth.");
	lines.push("5. Report your understanding of the context, concisely.");
	lines.push("6. Only if something is genuinely unclear or missing (and is NOT spelled out in the handoff or those files): resolve each such uncertainty by calling the `session_link` tool to query the previous session headlessly. Do NOT guess — the previous session's context is the only source for anything not written down. (It is fine and expected to find zero uncertainties — a clean handoff needs no query.)");
	lines.push('   - If `session_link` returns `kind: "clarification"`, show those questions to me, collect my answers, then call it again with `clarifications: [...]`.');
	lines.push("   - You may call `session_link` multiple times; each round is appended to the previous session, so it remembers earlier answers.");
	lines.push('7. Once you have the context (and any real uncertainties are resolved), report "context accepted" with a short summary — state explicitly whether there were uncertainties to chase down — then wait for my next instruction. Do not query the previous session just for the sake of it.');
	lines.push("");
	if (opts.unitProvisional) {
		lines.push("");
		lines.push("> The line has a PROVISIONAL technical name — give it a real one with `/session-link-name <unit>`.");
	}
	lines.push("");
	lines.push("Narrate each step so I can follow along.");
	if (opts.postamble) {
		lines.push("");
		lines.push(opts.postamble);
	}
	return lines.join("\n");
}
