import type { SessionDriver } from "../types.ts";

/**
 * Pi output parser.
 *
 * The headless run uses `pi --mode json`, which streams JSONL events. We walk
 * the stream and pull the text of the last assistant message (preferring the
 * `agent_end` event, falling back to the last assistant `message_end`). Errors
 * surfaced via `auto_retry_end` are thrown so the caller can report them.
 */
function textOf(message: any): string | undefined {
	const c = message?.content;
	if (typeof c === "string") return c.trim() || undefined;
	if (Array.isArray(c)) {
		const t = c
			.filter((b: any) => b && b.type === "text")
			.map((b: any) => b.text)
			.join("\n")
			.trim();
		return t || undefined;
	}
	return undefined;
}

export const piDriver: SessionDriver = {
	name: "pi",
	parseOutput(raw: string): string {
		let lastText: string | undefined;
		let finalError: string | undefined;
		for (const line of raw.split("\n")) {
			const t = line.trim();
			if (!t) continue;
			let ev: any;
			try {
				ev = JSON.parse(t);
			} catch {
				continue; // not a JSON line (e.g. stray log)
			}
			if (!ev || typeof ev !== "object") continue;

			if (ev.type === "agent_end" && Array.isArray(ev.messages)) {
				const asst = [...ev.messages].reverse().find((m: any) => m && m.role === "assistant");
				const txt = asst ? textOf(asst) : undefined;
				if (txt) lastText = txt;
			} else if (ev.type === "message_end" && ev.message && ev.message.role === "assistant") {
				const txt = textOf(ev.message);
				if (txt) lastText = txt;
			} else if (ev.type === "auto_retry_end" && ev.success === false && ev.finalError) {
				finalError = String(ev.finalError);
			}
		}
		if (!lastText && finalError) {
			throw new Error(`Previous session errored: ${finalError}`);
		}
		return lastText ?? "";
	},
};
