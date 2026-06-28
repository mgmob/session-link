/**
 * session-link — a pi extension that links sessions via a context handoff with
 * a back-channel.
 *
 * Flow (manual is the default):
 *   1. Closing session: `/session-link [manual] [note]` writes the handoff
 *      ENVELOPE (code-owned: sessionRef / askCommand / model / …) to
 *      `.pi/session_link/handoff.json`, then sends an AUTHORING turn into the
 *      SAME (closing) session via pi.sendUserMessage. The agent fills in the
 *      BODY (goal/summary/nextStep/…) directly in that file and presents the
 *      starter prompt + the file path for review.
 *   2. Review is an ordinary conversation in the closing session: the user opens
 *      the handoff file, posts remarks as messages, the agent revises the file,
 *      re-presents. Loop until satisfied — no special machinery.
 *   3. `/session-link-go` validates the mandatory spine, (optionally) warns about
 *      a fork if this handoff already started a child, then starts a new session
 *      and injects the starter prompt (a thin pointer at the handoff file).
 *      `auto` mode does steps 1→3 unattended (authoring turn, wait for idle,
 *      validate, start next session).
 *   4. New session: `current_session` (self-id) → read handoff (its BODY is the
 *      context) → read referenced files → report understanding → resolve any real
 *      uncertainty via the `session_link` tool (headless resume of the previous
 *      session, which appends, so multi-round Q&A accumulates there).
 *
 * Chain integrity: handoff.json is the ONLY mutable file; archives are immutable
 * and are the only thing parentHandoffPath ever points at. A redo from the same
 * session overwrites in place and carries the authored body forward. See
 * writeHandoff() in handoff.ts.
 *
 * Portability: the invocation lives in the handoff's `askCommand` (an argv
 * template), so the next session never guesses platform flags. `driver` only
 * selects the output parser — that's what makes this work across
 * claude-code / qwen (author their handoff in the same JSON schema).
 */

import * as path from "node:path";
import { Type } from "typebox";
import type { ExtensionAPI, ExtensionCommandContext, ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { Handoff, StartMode } from "./types.ts";
import { findHandoff, handoffPath, markCommitted, readHandoff, validateHandoff, writeHandoff } from "./handoff.ts";
import { querySession } from "./drivers/index.ts";

const DEFAULT_TIMEOUT_MS = Number(process.env.SESSION_LINK_TIMEOUT_MS || 5 * 60 * 1000);
const PI_TOOLS_ALLOWLIST = process.env.SESSION_LINK_PI_TOOLS || "read,grep,find,ls";
const PI_BIN = process.env.SESSION_LINK_PI_BIN || process.env.PI_BIN || "pi";
const DEFAULT_START_MODE = (process.env.SESSION_LINK_DEFAULT_MODE || "manual") === "auto" ? "auto" : "manual";

const HANDOFF_SCHEMA = "session-link/handoff/v1";
const HANDOFF_DIR = path.join(".pi", "session_link");

const LANG_CODE_MAP: Record<string, string> = {
	ru: "Russian",
	en: "English",
	zh: "Chinese",
	cn: "Chinese",
	ar: "Arabic",
	hi: "Hindi",
	he: "Hebrew",
};

/** Normalize a language given on the command line: accept full names or short codes (ru/en/zh/…). */
function normalizeLang(raw: string): string {
	const t = raw.trim();
	const mapped = LANG_CODE_MAP[t.toLowerCase()];
	if (mapped) return mapped;
	return t.charAt(0).toUpperCase() + t.slice(1);
}

/** Parse a leading `auto`/`manual` token and any `lang=…` tokens from the command args. */
function parseStartArgs(args: string): { mode?: StartMode; lang?: string; note: string } {
	const trimmed = args.trim();
	const tokens = trimmed ? trimmed.split(/\s+/) : [];
	let mode: StartMode | undefined;
	let lang: string | undefined;
	const noteParts: string[] = [];
	for (const tok of tokens) {
		const lm = tok.match(/^(?:lang|language)=(.+)$/i);
		if (lm) {
			if (!lang) lang = normalizeLang(lm[1].replace(/^["']|["']$/g, ""));
			continue;
		}
		if (!mode) {
			const mm = tok.match(/^(auto|manual)$/i);
			if (mm) {
				mode = mm[1].toLowerCase() as StartMode;
				continue;
			}
		}
		noteParts.push(tok);
	}
	return { mode, lang, note: noteParts.join(" ") };
}

/** Extract the uuid from a pi session filename, if present. */
function deriveSessionId(sessionFile: string | undefined): string | undefined {
	if (!sessionFile) return undefined;
	const m = path.basename(sessionFile).match(/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})/i);
	return m ? m[1] : undefined;
}

/** Markers for messages injected by our own code via pi.sendUserMessage — never real user text,
 *  so they must not influence language detection (they are authored in English). */
const INJECTED_PROMPT_MARKERS = [
	"# Context handoff — author the body",
	"# Context handoff (auto-started by /session-link)",
];

function isInjectedMessage(text: string): boolean {
	for (const marker of INJECTED_PROMPT_MARKERS) {
		if (text.startsWith(marker)) return true;
	}
	return false;
}

/** Recent REAL user-message texts (slash commands and code-injected prompts excluded), oldest-first. */
function recentUserTexts(ctx: ExtensionContext, limit = 16): string[] {
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
		if (!text || text.startsWith("/")) continue; // skip slash commands
		if (isInjectedMessage(text)) continue; // skip our own authoring/starter prompts
		out.unshift(text);
	}
	return out;
}


/**
 * Detect the dominant language of a SINGLE text by Unicode script (best-effort heuristic).
 */
function detectLanguageOfText(text: string): string | undefined {
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
 * Detect the dominant language across several messages by ONE-MESSAGE-ONE-VOTE.
 * Counting characters across a joined blob lets a single long English prompt
 * (e.g. an injected authoring prompt that slipped past the filter) outweigh many
 * short Russian messages, so each message votes once for its own dominant script.
 */
function detectLanguage(texts: string[]): string | undefined {
	const votes: Record<string, number> = {};
	for (const t of texts) {
		const lang = detectLanguageOfText(t);
		if (lang) votes[lang] = (votes[lang] ?? 0) + 1;
	}
	let best: string | undefined;
	let bestCount = 0;
	for (const [lang, count] of Object.entries(votes)) {
		if (count > bestCount) {
			best = lang;
			bestCount = count;
		}
	}
	return best;
}

/** Resolve the conversation language to carry into the next session. */
function resolveLanguage(ctx: ExtensionContext, override?: string): string | undefined {
	if (override) return override;
	const env = (process.env.SESSION_LINK_LANGUAGE || "").trim();
	if (env) return env;
	return detectLanguage(recentUserTexts(ctx, 16));
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

/**
 * Build the envelope-only handoff. The agent authors the BODY afterwards (in the
 * authoring turn). On a redo from the same session, writeHandoff() merges the
 * previously-authored body forward so a failed pass doesn't wipe a good summary.
 */
function buildEnvelope(pi: ExtensionAPI, ctx: ExtensionCommandContext, contextNote: string, langOverride?: string): Handoff {
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
		language: resolveLanguage(ctx, langOverride),
		howToAsk: human,
		askCommand: argv,
		contextNote: contextNote.trim() || undefined,
	};
}

/** The thin starter prompt the NEXT session receives. Lives in code; the only
 *  variable is the handoff file path. The agent never authors this. */
function buildStarterPrompt(handoffFile: string, language?: string): string {
	const lines: string[] = [];
	lines.push("# Context handoff (auto-started by /session-link)");
	if (language) {
		// Prominent + at the very top: this prompt is English, so an explicit
		// instruction here is what keeps the new session in the user's language.
		lines.push("");
		lines.push(
			"> LANGUAGE: Communicate with me in **" +
				language +
				"** throughout this entire session — every status update, understanding report, and summary. Match the user's language; do not switch to English unless I do.",
		);
	}
	lines.push("");
	lines.push("The previous session handed off context. The handoff is at:");
	lines.push(`  ${handoffFile}`);
	lines.push("");
	lines.push("Proceed now:");
	lines.push("1. Call the `current_session` tool to confirm your identity.");
	lines.push("2. Read the handoff file. Its body fields (`goal`, `summary`, `nextStep`, plus any `blockers`/`decisions`/`filesToRead`/`sections`) ARE the context — start there, not at the envelope.");
	lines.push("3. Read every file in the handoff's `filesToRead` (and anything cited in `summary`/`nextStep`).");
	lines.push("4. For the actual current state of changed files, trust GIT over the handoff's `filesChanged` (that list is only a reading hint and can drift across uncommitted sessions): run `git diff HEAD` (uncommitted) and `git diff <merge-base/main>..HEAD` (committed) to see the complete current file state. The handoff's `summary`/`sections` carry the INTENT; git carries the line-level truth.");
	lines.push("5. Report your understanding of the context, concisely.");
	lines.push("6. Only if something is genuinely unclear or missing (and is NOT spelled out in the handoff or those files): resolve each such uncertainty by calling the `session_link` tool to query the previous session headlessly. Do NOT guess — the previous session's context is the only source for anything not written down. (It is fine and expected to find zero uncertainties — a clean handoff needs no query.)");
	lines.push('   - If `session_link` returns `kind: "clarification"`, show those questions to me, collect my answers, then call it again with `clarifications: [...]`.');
	lines.push("   - You may call `session_link` multiple times; each round is appended to the previous session, so it remembers earlier answers.");
	lines.push('7. Once you have the context (and any real uncertainties are resolved), report "context accepted" with a short summary — state explicitly whether there were uncertainties to chase down — then wait for my next instruction. Do not query the previous session just for the sake of it.');
	lines.push("");
	lines.push("Narrate each step so I can follow along.");
	return lines.join("\n");
}

/** The authoring prompt sent into the CLOSING session so it fills the handoff body.
 *  `mode` controls only step 2: manual asks for review; auto tells it to stop. */
function buildAuthorPrompt(handoffFile: string, starterPrompt: string, language: string | undefined, mode: StartMode): string {
	const langName = language ?? "English";
	const lines: string[] = [];
	lines.push("# Context handoff — author the body" + (mode === "auto" ? " (auto mode)" : " (review mode)"));
	if (language) {
		lines.push("");
		lines.push(`> Write the CONTENT of the handoff body in **${language}**.`);
	}
	lines.push("");
	lines.push(
		"You are closing THIS session so a fresh one can take over. The handoff ENVELOPE is already written to the file by the code; your job is to author the BODY — what was actually done and decided — so the next session is productive with as few questions back to you or the user as possible.",
	);
	lines.push("");
	lines.push(
		"Why this matters: earlier handoffs contained only a transcript of the USER's messages, not what YOU did. Lead with your work and reasoning.",
	);
	lines.push("");
	lines.push("## Step 1 — author the body");
	lines.push("Open and EDIT this file in place (use the `edit`/`write` tools), adding ONLY the agent-authored fields below. The envelope fields are already set — do NOT touch them (`schema`, `createdAt`, `driver`, `sessionRef`, `sessionId`, `sessionName`, `cwd`, `model`, `language`, `howToAsk`, `askCommand`, `parentHandoffPath`). Write the content in " + langName + ".");
	lines.push("");
	lines.push(`Handoff file: ${handoffFile}`);
	lines.push("");
	lines.push("Schema — MANDATORY spine (always include these three):");
	lines.push("- `goal` (string, 1–3 sentences): the overarching objective — WHY this work exists, what \"done\" looks like. Intent, not a task list.");
	lines.push("- `summary` (string, markdown, 3–8 sentences): what you ACTUALLY did/decided this session — concrete: file names, decisions, outcomes. The headline the next session needs. No filler (\"In this session we explored…\").");
	lines.push("- `nextStep` (string, 1–4 sentences): exactly where the next session picks up — the immediate next action, or \"task complete — because …\", or the decision you're waiting on. Actionable.");
	lines.push("");
	lines.push("Optional — include ONLY those that carry real information for THIS task; omit any that would be empty filler (that is expected and good):");
	lines.push("- `blockers`: string[] — each item names the blocker and what unblocks it.");
	lines.push("- `decisions`: array of { decision, rationale } — consequential choices with WHY, so they aren't re-litigated or undone.");
	lines.push("- `filesChanged`: string[] — paths created/edited this session. Keep it a plain manifest of paths (the character of each change belongs in `summary` or a `sections` entry like \"Changes by file\", not here).");
	lines.push("- `filesToRead`: string[] — paths the next session MUST read to be productive.");
	lines.push("- `environment`: string[] | {} — gotchas, versions, repro commands that matter.");
	lines.push("- `deliberatelySkipped`: string[] — what you intentionally did NOT do / did NOT write down (guards against a false \"done\").");
	lines.push("");
	lines.push("`sections`: array of { title, body (markdown), files? }  (optional, recommended)");
	lines.push("A free-form ORDERED list for anything the fixed fields don't capture. YOU OWN the titles — choose them to fit THIS task. Useful titles by task type (NOT a mandatory set — pick only what genuinely matters): feature → \"What changed\", \"Why this approach\", \"Tests\", \"Known gotchas\"; debug → \"Symptom & repro\", \"Hypotheses ruled out\", \"Current hypothesis\", \"Evidence\"; research → \"Sources consulted\", \"Findings\", \"Open sub-questions\", \"Confidence\"; refactor → \"Before/after\", \"Invariants preserved\", \"Risk areas\"; writing → \"Audience & tone\", \"Outline\", \"Drafted sections\". If a section would be one line of obvious content — omit it.");
	lines.push("");
	lines.push("Rules:");
	lines.push("- Concrete over generic. Names, paths, decisions, commands — not \"we looked into things\".");
	lines.push("- Separate DONE from PLANNED from OPEN. Don't blur them.");
	lines.push("- Be honest about uncertainty and about what you didn't do. A false \"done\" costs the next session far more than a stated gap.");
	lines.push("- Do NOT include a transcript or quotes of the user's messages.");
	lines.push("- Do NOT record secrets, credentials, or private values in the handoff.");
	lines.push("- You may use read-only tools to verify a path/fact you're unsure of; do not invent.");
	lines.push("- Do not modify any project files other than the handoff file.");
	if (mode === "manual") {
		lines.push("");
		lines.push("## Step 2 — present for review");
		lines.push("After saving the body, show the user this STARTER PROMPT verbatim (it is exactly what the next session will receive), then ask them to review:");
		lines.push("");
		lines.push("----- starter prompt -----");
		lines.push(starterPrompt);
		lines.push("----- end starter prompt -----");
		lines.push("");
		lines.push("Tell the user:");
		lines.push(`- The handoff file path (so they can open and inspect it): ${handoffFile}`);
		lines.push("- If everything looks good → run `/session-link-go` to start the next session with the starter prompt above.");
		lines.push("- If not → describe what to change in plain words; you will revise the handoff file and present again. Revise by editing the SAME file; do not re-run the command.");
		lines.push("");
		lines.push("Do NOT start a new session yourself, and do NOT run `/session-link-go` — that is the user's call. Wait for the user.");
	} else {
		lines.push("");
		lines.push("## Step 2 — finish");
		lines.push("Auto mode: once the body is saved, stop. Do NOT ask for review, do NOT start a new session, do NOT run `/session-link-go` — the code does that. Just confirm the file was saved.");
	}
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

/** Send the authoring turn into the CURRENT (closing) session. */
function sendAuthorTurn(pi: ExtensionAPI, ctx: ExtensionCommandContext, prompt: string): void {
	if (ctx.isIdle()) {
		pi.sendUserMessage(prompt);
	} else {
		// Should not happen from a command handler, but stay safe: queue as follow-up.
		pi.sendUserMessage(prompt, { deliverAs: "followUp" });
		notify(ctx, "Agent was busy; authoring turn queued as a follow-up.", "info");
	}
}

/** Start the next session with the starter prompt injected. Shared by auto + go. */
async function startNextSession(
	ctx: ExtensionCommandContext,
	parentSession: string | undefined,
	starterPrompt: string,
	onReady: (childSessionFile: string | undefined) => void,
): Promise<{ cancelled: boolean }> {
	const result = await ctx.newSession({
		parentSession,
		withSession: async (rctx) => {
			try {
				await rctx.sendUserMessage(starterPrompt);
				onReady(rctx.sessionManager.getSessionFile() ?? undefined);
				notify(rctx, "New session started; context acceptance is running.", "info");
			} catch {
				rctx.ui.setEditorText(starterPrompt);
				onReady(rctx.sessionManager.getSessionFile() ?? undefined);
				notify(rctx, "New session started; submit the editor to begin context acceptance.", "info");
			}
		},
	});
	if (result.cancelled) {
		notify(ctx, "New session cancelled (handoff is still on disk).", "info");
	}
	return { cancelled: !!result.cancelled };
}

export default function (pi: ExtensionAPI): void {
	// --- /session-link: write envelope + authoring turn in the closing session ----
	pi.registerCommand("session-link", {
		description:
			"Write a context handoff and author its body in THIS session. Usage: /session-link [auto|manual] [context note]. " +
			"manual (default): the agent fills the handoff, shows the starter prompt, and you review; run /session-link-go when ready. " +
			"auto: same authoring, then the next session starts unattended. " +
			"Default mode is configurable via SESSION_LINK_DEFAULT_MODE.",
		handler: async (args, ctx) => {
			if (ctx.mode !== "tui") {
				notify(ctx, "session-link requires interactive (TUI) mode", "error");
				return;
			}
			const { mode: explicitMode, lang, note } = parseStartArgs(args);
			const mode: StartMode = explicitMode ?? DEFAULT_START_MODE;

			const envelope = buildEnvelope(pi, ctx, note, lang);
			const parentSession = ctx.sessionManager.getSessionFile() ?? undefined;
			const handoffFile = writeHandoff(ctx.cwd, envelope);
			notify(ctx, `Handoff envelope written: ${handoffFile} (mode: ${mode}, language: ${envelope.language ?? "undetected"})`, "info");

			const starterPrompt = buildStarterPrompt(handoffFile, envelope.language);
			const authorPrompt = buildAuthorPrompt(handoffFile, starterPrompt, envelope.language, mode);
			sendAuthorTurn(pi, ctx, authorPrompt);

			if (mode === "auto") {
				// Wait for the authoring turn to finish, then validate + start the next session.
				await ctx.waitForIdle();
				const h = readHandoff(handoffFile);
				const v = validateHandoff(h);
				if (!v.ok) {
					notify(
						ctx,
						`Authoring did not fill the mandatory spine (missing: ${v.missing.join(", ")}). Review the handoff and run /session-link-go manually.`,
						"warning",
					);
					return;
				}
				notify(ctx, "Handoff body ready — starting the next session.", "info");
				const committedAt = new Date().toISOString();
				await startNextSession(ctx, parentSession, starterPrompt, (child) => {
					markCommitted(ctx.cwd, committedAt, child);
				});
			} else {
				notify(
					ctx,
					"Authoring turn started in this session. Review the handoff + starter prompt; then /session-link-go (or post remarks to revise).",
					"info",
				);
			}
		},
	});

	// --- /session-link-go: validate spine, fork-warn, start the next session ------
	pi.registerCommand("session-link-go", {
		description:
			"Start the next session from the current handoff (validates the mandatory spine first). " +
			"Use after reviewing the handoff produced by /session-link. Warns if a child was already started from this handoff (fork).",
		handler: async (_args, ctx) => {
			if (ctx.mode !== "tui") {
				notify(ctx, "session-link-go requires interactive (TUI) mode", "error");
				return;
			}
			const hp = findHandoff(ctx.cwd);
			if (!hp) {
				notify(ctx, `No handoff found at ${path.join(ctx.cwd, HANDOFF_DIR, "handoff.json")}. Run /session-link first.`, "warning");
				return;
			}
			const h = readHandoff(hp);
			if (!h) {
				notify(ctx, `Unreadable handoff at ${hp}.`, "error");
				return;
			}
		const v = validateHandoff(h);
		if (!v.ok) {
			notify(
				ctx,
				`Handoff spine is incomplete (missing: ${v.missing.join(", ")}). Run /session-link [note] in this session — it starts the authoring turn that fills goal/summary/nextStep. (Handoff file: ${hp})`,
				"warning",
			);
			return;
		}
			if (h.committedAt) {
				// Non-blocking fork hint: a child already started from this exact handoff.
				const which = h.committedSessionFile ? ` (${path.basename(h.committedSessionFile)})` : "";
				notify(
					ctx,
					`Note: a session already started from this handoff at ${h.committedAt}${which}. Starting again forks a new branch — that is fine if intentional.`,
					"warning",
				);
			}
			const parentSession = ctx.sessionManager.getSessionFile() ?? undefined;
			const starterPrompt = buildStarterPrompt(hp, h.language);
			const committedAt = new Date().toISOString();
			await startNextSession(ctx, parentSession, starterPrompt, (child) => {
				markCommitted(ctx.cwd, committedAt, child);
			});
		},
	});

	// --- /session-link-write: write envelope + authoring turn, no go -------------
	pi.registerCommand("session-link-write", {
		description: "Write a handoff and author its body in THIS session, without starting a new session. Usage: /session-link-write [context note]. Run /session-link-go later (or open the next session yourself).",
		handler: async (args, ctx) => {
			if (ctx.mode !== "tui") {
				notify(ctx, "session-link-write requires interactive (TUI) mode", "error");
				return;
			}
			const { lang, note } = parseStartArgs(args);
			const envelope = buildEnvelope(pi, ctx, note, lang);
			const handoffFile = writeHandoff(ctx.cwd, envelope);
			notify(ctx, `Handoff envelope written: ${handoffFile} (language: ${envelope.language ?? "undetected"})`, "info");
			const starterPrompt = buildStarterPrompt(handoffFile, envelope.language);
			const authorPrompt = buildAuthorPrompt(handoffFile, starterPrompt, envelope.language, "manual");
			sendAuthorTurn(pi, ctx, authorPrompt);
			notify(ctx, "Authoring turn started in this session. Review, then /session-link-go when ready.", "info");
		},
	});

	// --- /session-link-show: print the current handoff path / status --------------
	pi.registerCommand("session-link-show", {
		description: "Show the current handoff for this project (path + spine status), if any.",
		handler: async (_args, ctx) => {
			const hp = findHandoff(ctx.cwd);
			if (!hp) {
				notify(ctx, `No handoff found at ${path.join(ctx.cwd, HANDOFF_DIR, "handoff.json")}`, "info");
				return;
			}
			const h = readHandoff(hp);
			if (!h) {
				notify(ctx, `Unreadable handoff at ${hp}`, "warning");
				return;
			}
			const v = validateHandoff(h);
			const status = v.ok ? "ready (spine filled)" : `DRAFT (spine missing: ${v.missing.join(", ")})`;
			notify(ctx, `Handoff: ${hp} — ${status} (driver=${h.driver}, session=${h.sessionId ?? h.sessionRef})`, "info");
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
