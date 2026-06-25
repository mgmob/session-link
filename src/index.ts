/**
 * session-link — a pi extension that links sessions via a context handoff with
 * a back-channel.
 *
 * Flow:
 *   1. Closing session: `/session-link [note]` writes a handoff
 *      (`.pi/session_link/handoff.json`) that records how to resume it
 *      headlessly, THEN starts a new session in the same process AND
 *      auto-submits a context-acceptance task to it (the new agent reads the
 *      handoff, loads context, identifies uncertainties, and resolves them by
 *      querying the previous session). `/session-link-write` writes only.
 *   2. New session: `current_session` (self-id) → read handoff → read files →
 *      report understanding → resolve each uncertainty via the `session_link`
 *      tool (headless resume of the previous session).
 *   3. The previous session resumes via `pi --session <file>` — which APPENDS,
 *      so multi-round Q&A accumulates in its real context. If it needs human
 *      input it replies with a `CLARIFY:` marker; the tool returns
 *      `kind:"clarification"` and the new session relays those questions to the
 *      user.
 *
 * Portability: the invocation lives in the handoff's `askCommand` (an argv
 * template), so the next session never guesses platform flags. `driver` only
 * selects the output parser — that's what makes this work across
 * claude-code / qwen (author their handoff in the same JSON schema).
 */

import * as path from "node:path";
import { Type } from "typebox";
import type { ExtensionAPI, ExtensionCommandContext, ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { Handoff } from "./types.ts";
import { findHandoff, handoffPath, readHandoff, writeHandoff } from "./handoff.ts";
import { querySession } from "./drivers/index.ts";

const DEFAULT_TIMEOUT_MS = Number(process.env.SESSION_LINK_TIMEOUT_MS || 5 * 60 * 1000);
const PI_TOOLS_ALLOWLIST = process.env.SESSION_LINK_PI_TOOLS || "read,grep,find,ls";
const PI_BIN = process.env.SESSION_LINK_PI_BIN || process.env.PI_BIN || "pi";
const DEFAULT_START_MODE = (process.env.SESSION_LINK_DEFAULT_MODE || "manual") === "auto" ? "auto" : "manual";

type StartMode = "auto" | "manual";

/**
 * Parse a leading `auto`/`manual` token from the command args.
 * Returns the mode (if the first word is exactly `auto` or `manual`) plus the
 * remaining text as the context note. A token glued to text (`auto-test ...`)
 * is NOT treated as a mode — it stays part of the note.
 */
function parseStartArgs(args: string): { mode?: StartMode; note: string } {
	const trimmed = args.trim();
	const m = trimmed.match(/^(auto|manual)(?:\s+|$)(.*)$/is);
	if (m) {
		return { mode: m[1].toLowerCase() as StartMode, note: m[2].trim() };
	}
	return { note: trimmed };
}

const HANDOFF_SCHEMA = "session-link/handoff/v1";
const HANDOFF_DIR = path.join(".pi", "session_link");

/** Extract the uuid from a pi session filename, if present. */
function deriveSessionId(sessionFile: string | undefined): string | undefined {
	if (!sessionFile) return undefined;
	const m = path.basename(sessionFile).match(/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})/i);
	return m ? m[1] : undefined;
}

/** Recent user-message texts (commands and empty excluded), oldest-first. */
function recentUserTexts(ctx: ExtensionContext, limit = 8): string[] {
	const out: string[] = [];
	const branch = ctx.sessionManager.getBranch();
	for (let i = branch.length - 1; i >= 0 && out.length < limit; i--) {
		const entry = branch[i] as any;
		if (!entry || entry.type !== "message") continue;
		const msg = entry.message;
		if (!msg || msg.role !== "user") continue;
		let text = "";
		if (typeof msg.content === "string") text = msg.content;
		else if (Array.isArray(msg.content)) {
			text = msg.content.filter((b: any) => b && b.type === "text").map((b: any) => b.text).join(" ");
		}
		text = text.trim();
		if (!text || text.startsWith("/")) continue; // skip commands
		out.unshift(text);
	}
	return out;
}

/** Truncated recent user topics for the handoff. */
function recentUserTopics(ctx: ExtensionContext, limit = 6): string[] {
	return recentUserTexts(ctx, limit).map((t) => t.slice(0, 280));
}

/**
 * Detect the dominant language of a text by Unicode script (best-effort heuristic;
 * handles the common cases: Latin→English, Cyrillic→Russian, CJK→Chinese, …).
 */
function detectLanguage(text: string): string | undefined {
	if (!text) return undefined;
	let cyrillic = 0;
	let latin = 0;
	let cjk = 0;
	let arabic = 0;
	let devanagari = 0;
	let hebrew = 0;
	for (const ch of text) {
		const c = ch.codePointAt(0);
		if (c === undefined) continue;
		if (c >= 0x0400 && c <= 0x04ff) cyrillic++;
		else if ((c >= 0x0041 && c <= 0x005a) || (c >= 0x0061 && c <= 0x007a) || (c >= 0x00c0 && c <= 0x024f)) latin++;
		else if (c >= 0x4e00 && c <= 0x9fff) cjk++;
		else if (c >= 0x0600 && c <= 0x06ff) arabic++;
		else if (c >= 0x0900 && c <= 0x097f) devanagari++;
		else if (c >= 0x0590 && c <= 0x05ff) hebrew++;
	}
	const max = Math.max(cyrillic, latin, cjk, arabic, devanagari, hebrew);
	if (max === 0) return undefined;
	if (cyrillic === max) return "Russian";
	if (latin === max) return "English";
	if (cjk === max) return "Chinese";
	if (arabic === max) return "Arabic";
	if (devanagari === max) return "Hindi";
	if (hebrew === max) return "Hebrew";
	return undefined;
}

/**
 * Resolve the conversation language to carry into the next session.
 * Priority: SESSION_LINK_LANGUAGE env > auto-detect from recent user messages.
 */
function resolveLanguage(ctx: ExtensionContext): string | undefined {
	const env = (process.env.SESSION_LINK_LANGUAGE || "").trim();
	if (env) return env;
	return detectLanguage(recentUserTexts(ctx, 8).join(" "));
}

function buildAskCommand(absSessionFile: string | undefined, model: string | undefined): { argv: string[]; human: string } {
	const argv = [PI_BIN, "--mode", "json"];
	if (absSessionFile) argv.push("--session", absSessionFile);
	argv.push("--tools", PI_TOOLS_ALLOWLIST); // read-only + excludes our own tools → no recursion, no mutation
	if (model) argv.push("--model", model);
	argv.push("{QUESTION}");
	const human = argv.join(" ").replace("{QUESTION}", '"<your question>"');
	return { argv, human };
}

function buildHandoff(pi: ExtensionAPI, ctx: ExtensionCommandContext, contextNote: string): Handoff {
	const sessionFile = ctx.sessionManager.getSessionFile();
	const abs = sessionFile ? path.resolve(sessionFile) : undefined;
	const model = ctx.model ? `${ctx.model.provider}/${ctx.model.id}` : undefined;
	const { argv, human } = buildAskCommand(abs, model);
	return {
		schema: HANDOFF_SCHEMA,
		createdAt: new Date().toISOString(),
		driver: "pi",
		sessionRef: abs ?? deriveSessionId(sessionFile) ?? "unknown",
		sessionId: deriveSessionId(sessionFile),
		sessionName: pi.getSessionName() ?? undefined,
		cwd: ctx.cwd,
		model,
		language: resolveLanguage(ctx),
		howToAsk: human,
		askCommand: argv,
		topics: recentUserTopics(ctx),
		contextNote: contextNote.trim() || undefined,
	};
}

/** Task auto-submitted to the new session. Drives the whole acceptance flow. */
function buildPreloadPrompt(handoffFile: string, language?: string): string {
	const lines: string[] = [];
	lines.push("# Context handoff (auto-started by /session-link)");
	if (language) {
		// Prominent + at the very top: the rest of this prompt is English, so an
		// explicit instruction here is what actually keeps the new session in the
		// user's language instead of defaulting to English.
		lines.push("");
		lines.push("> LANGUAGE: Communicate with me in **" + language + "** throughout this entire session — every status update, understanding report, and summary. Match the user's language; do not switch to English unless I do.");
	}
	lines.push("");
	lines.push("The previous session handed off context. The handoff is at:");
	lines.push(`  ${handoffFile}`);
	lines.push("");
	lines.push("Proceed now:");
	lines.push("1. Call the `current_session` tool to confirm your identity.");
	lines.push("2. Read the handoff file at the path above.");
	lines.push("3. Read every file it references (its `files` list, and anything cited in its context note).");
	lines.push("4. Report your understanding of the context, concisely.");
	lines.push("5. Only if something is genuinely unclear or missing (and is NOT spelled out in the handoff or the files above): resolve each such uncertainty by calling the `session_link` tool to query the previous session headlessly. Do NOT guess — the previous session's context is the only source for anything not written down. (It is fine and expected to find zero uncertainties — a clean handoff needs no query.)");
	lines.push('   - If `session_link` returns `kind: "clarification"`, show those questions to me, collect my answers, then call it again with `clarifications: [...]`.');
	lines.push("   - You may call `session_link` multiple times; each round is appended to the previous session, so it remembers earlier answers.");
	lines.push('6. Once you have the context (and any real uncertainties are resolved), report "context accepted" with a short summary — state explicitly whether there were uncertainties to chase down — then wait for my next instruction. Do not query the previous session just for the sake of it.');
	lines.push("");
	lines.push("Narrate each step so I can follow along.");
	return lines.join("\n");
}

function notify(ctx: ExtensionContext, message: string, level: "info" | "warning" | "error" = "info"): void {
	if (ctx.hasUI) {
		try {
			ctx.ui.notify(message, level);
		} catch {
			// notify is best-effort
		}
	}
}

export default function (pi: ExtensionAPI): void {
	// --- /session-link: write handoff + start the new session --------------------
	pi.registerCommand("session-link", {
		description:
			"Write a context handoff and start a new session. Usage: /session-link [auto|manual] [context note]. " +
			"auto = the new session runs context-acceptance immediately (queries the previous session on its own); " +
			"manual (default) = the task is left as a draft in the editor; press Enter to start. " +
			"Default mode is configurable via SESSION_LINK_DEFAULT_MODE.",
		handler: async (args, ctx) => {
			if (ctx.mode !== "tui") {
				notify(ctx, "session-link requires interactive (TUI) mode", "error");
				return;
			}
			const { mode: explicitMode, note } = parseStartArgs(args);
			const startMode: StartMode = explicitMode ?? DEFAULT_START_MODE;

			const handoff = buildHandoff(pi, ctx, note);
			const currentFile = ctx.sessionManager.getSessionFile();
			const handoffFile = writeHandoff(ctx.cwd, handoff);
			notify(ctx, `Handoff written: ${handoffFile} (start: ${startMode})`, "info");

			const preload = buildPreloadPrompt(handoffFile, handoff.language);
			const result = await ctx.newSession({
				parentSession: currentFile ?? undefined,
				withSession: async (rctx) => {
					if (startMode === "auto") {
						// Send the acceptance task as a real user message so the new agent
						// begins immediately (no manual Enter). Fall back to a draft if the
						// direct send is unavailable in this context.
						try {
							await rctx.sendUserMessage(preload);
							notify(rctx, "New session started; context acceptance is running.", "info");
						} catch {
							rctx.ui.setEditorText(preload);
							notify(rctx, "New session started; submit the editor to begin context acceptance.", "info");
						}
					} else {
						// manual: leave the task as an editable draft; the user reviews the
						// handoff + prompt and presses Enter to start.
						rctx.ui.setEditorText(preload);
						notify(rctx, "New session started; review the draft and press Enter to begin context acceptance.", "info");
					}
				},
			});
			if (result.cancelled) {
				notify(ctx, "New session cancelled (handoff is still on disk).", "info");
			}
		},
	});

	// --- /session-link-write: write handoff only (no new session) -----------------
	pi.registerCommand("session-link-write", {
		description: "Write a context handoff file without starting a new session. Usage: /session-link-write [context note]",
		handler: async (args, ctx) => {
			const handoff = buildHandoff(pi, ctx, args);
			const handoffFile = writeHandoff(ctx.cwd, handoff);
			notify(ctx, `Handoff written: ${handoffFile}`, "info");
		},
	});

	// --- /session-link-show: print the current handoff path / status --------------
	pi.registerCommand("session-link-show", {
		description: "Show the current handoff for this project (if any).",
		handler: async (_args, ctx) => {
			const hp = findHandoff(ctx.cwd);
			if (!hp) {
				notify(ctx, `No handoff found at ${path.join(ctx.cwd, HANDOFF_DIR, "handoff.json")}`, "info");
				return;
			}
			const h = readHandoff(hp);
			notify(ctx, h ? `Handoff: ${hp} (driver=${h.driver}, session=${h.sessionId ?? h.sessionRef})` : `Unreadable handoff at ${hp}`, "info");
		},
	});

	// --- session_link tool: query a linked (previous) session headlessly ----------
	pi.registerTool({
		name: "session_link",
		label: "Query linked session",
		description:
			"Query a linked (previous/handed-off) session by resuming it headlessly. Returns the answer, or a clarification request if that session needs human input first. Previous Q&A persists in that session's context, so you can call this repeatedly for follow-ups. Defaults to the handoff at .pi/session_link/handoff.json in the cwd; pass handoffPath to query any linked session in the chain.",
		promptSnippet: "session_link({question, handoffPath?, clarifications?}) — query a linked session headlessly; returns an answer or a clarification request.",
		promptGuidelines: [
			"Use session_link to resolve uncertainties about handed-off context. Narrate each question you ask and the answer you receive.",
			"If session_link returns kind='clarification', show those questions to the user, collect answers, then call it again with clarifications=[...]. Never fabricate the linked session's answers.",
			"You may call session_link multiple times; each round is appended to the linked session so it remembers earlier answers. Pass handoffPath to follow the chain to an earlier linked session.",
		],
		parameters: Type.Object({
			question: Type.String({ description: "The precise question for the linked session." }),
			handoffPath: Type.Optional(
				Type.String({
					description: "Absolute path to a handoff.json. Defaults to .pi/session_link/handoff.json in the cwd. Use this to query an earlier session in the chain (the handoff's parentHandoffPath field links backwards).",
				}),
			),
			clarifications: Type.Optional(
				Type.Array(Type.String(), {
					description: "Answers to a previous clarification round, forwarded to the linked session.",
				}),
			),
		}),
		async execute(_toolCallId, params, signal, onUpdate, ctx) {
			const handoffPathArg = (params as { handoffPath?: string }).handoffPath;
			const hp = handoffPathArg || findHandoff(ctx.cwd);
			if (!hp) {
				return {
					content: [
						{
							type: "text",
							text: "No handoff found. Ask the user for the path to a handoff.json, or run /session-link-write (or /session-link) in the previous session first.",
						},
					],
					details: { error: "no-handoff", checked: path.join(ctx.cwd, HANDOFF_DIR, "handoff.json") },
				};
			}
			const handoff = readHandoff(hp);
			if (!handoff) {
				return {
					content: [{ type: "text", text: `Could not read handoff at ${hp} (missing or wrong schema).` }],
					details: { error: "bad-handoff", path: hp },
				};
			}

			try {
				onUpdate?.({
					content: [
						{
							type: "text",
							text: `Querying linked session (driver=${handoff.driver}, session=${handoff.sessionId ?? handoff.sessionRef})… this may take a while.`,
						},
					],
					details: {},
				});
			} catch {
				// onUpdate is optional / may be unavailable
			}

			try {
				const result = await querySession({
					question: (params as { question: string }).question,
					clarifications: (params as { clarifications?: string[] }).clarifications,
					handoff,
					timeoutMs: DEFAULT_TIMEOUT_MS,
					signal,
				});
				const label = result.kind === "clarification" ? "CLARIFICATION NEEDED from the user" : "ANSWER from the linked session";
				const body = result.kind === "clarification"
					? `The linked session cannot answer without more information. Please answer these and I will forward them:\n\n${result.text}`
					: result.text;
				return {
					content: [{ type: "text", text: `[${label}]\n\n${body}` }],
					details: { kind: result.kind, driver: result.driver, handoffPath: hp },
				};
			} catch (err: any) {
				return {
					content: [
						{
							type: "text",
							text: `Linked-session query failed: ${err?.message ?? err}\n\nManual fallback (run yourself, then paste the answer back):\n  ${handoff.howToAsk}`,
						},
					],
					details: { error: String(err?.message ?? err), handoffPath: hp },
				};
			}
		},
	});

	// --- current_session tool: let the agent self-identify ------------------------
	pi.registerTool({
		name: "current_session",
		label: "Current session",
		description:
			"Return this session's id, file path, cwd, and (if present) the path to the active handoff. Use to self-identify at the start of context acceptance.",
		parameters: Type.Object({}),
		async execute(_toolCallId, _params, _signal, _onUpdate, ctx) {
			const file = ctx.sessionManager.getSessionFile();
			const id = deriveSessionId(file);
			const hp = findHandoff(ctx.cwd);
			const obj = { sessionId: id, sessionFile: file ?? null, cwd: ctx.cwd, handoffPath: hp ?? null };
			return {
				content: [{ type: "text", text: JSON.stringify(obj, null, 2) }],
				details: obj,
			};
		},
	});

	// --- nudge: if a handoff is present when a fresh session starts ---------------
	pi.on("session_start", async (event, ctx) => {
		if (event.reason !== "new" && event.reason !== "startup") return;
		const hp = findHandoff(ctx.cwd);
		if (!hp) return;
		const h = readHandoff(hp);
		if (h) {
			notify(ctx, `Handoff available from a previous session (${h.driver}). Read it, or run /session-link-show.`, "info");
		}
	});
}
