import type { SessionDriver } from "../types.ts";

/**
 * Qwen Code output parser (best-effort).
 *
 * Qwen Code CLI's exact resume/print flags should be verified against your
 * installed version and encoded in the handoff's `askCommand` when that side
 * authors a handoff. Here we assume the headless run prints the assistant reply
 * as plain text on stdout; we just strip common ANSI escapes and trim.
 *
 * TODO(verifier): confirm `qwen` flags for non-interactive resume + print and
 * tighten this parser (e.g. switch to a structured output mode if available).
 */
function stripAnsi(s: string): string {
	// eslint-disable-next-line no-control-regex
	return s.replace(/\u001b\[[0-9;]*[A-Za-z]/g, "");
}

export const qwenDriver: SessionDriver = {
	name: "qwen",
	parseOutput(raw: string): string {
		return stripAnsi(raw).trim();
	},
};
