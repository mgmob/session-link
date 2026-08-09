#!/usr/bin/env node
/**
 * session-link CLI — thin layer over the core (docs/cli-spec.md).
 *
 * Stable surface: `--json` only. The human-readable output is NOT a contract and
 * may change between versions; the JSON envelope is, and breaks only with a
 * major version (which moves together with the schema major).
 *
 * Commands are wired in incrementally (read → write → platform). Until a command
 * is wired, it falls through to a usage error.
 */
import { readdirSync, readFileSync } from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { findHandoff, forkLine, markCommitted, migrateLegacyHead, readHandoff, rebuildIndex, relocateFromIncoming, renameLine, validateHandoff, writeLink, type WriteLinkInput } from "./handoff.ts";
import type { HandoffV2 } from "./types.ts";
import { resolveParent, walkAncestors } from "./parent.ts";
import { readIncoming, removeIncoming, resolveStore, withLock, writeIncomingPointer } from "./store.ts";
import { renderGraph } from "./graph.ts";
import { doctorReport, validateStore } from "./doctor.ts";
import { buildStarterPrompt } from "./starter.ts";
import { querySession } from "./drivers/index.ts";
import { spawnBin } from "./drivers/spawn.ts";
import type { DriverName } from "./types.ts";

const PKG = JSON.parse(
	readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "package.json"), "utf-8"),
) as { version: string };

/** CLI version (== package version). Moves with the schema major. */
export const CLI_VERSION: string = PKG.version;
/** Handoff schema major this CLI speaks. */
export const SCHEMA_VERSION = "2";

/** Semantic exit codes (§5) — so scripts don't parse text. */
export const EXIT = {
	ok: 0,
	notFound: 1,
	usage: 2,
	lockBusy: 3,
	invalid: 4,
	conflict: 5,
	invariant: 6,
} as const;

export interface Envelope {
	ok: boolean;
	command: string;
	cliVersion: string;
	schemaVersion: string;
	data?: unknown;
	error?: { code: string; message: string };
}

export interface ParsedArgs {
	command: string | undefined;
	positional: string[];
	flags: Record<string, string | boolean>;
	json: boolean;
	quiet: boolean;
	cwd: string | undefined;
}

/**
 * Parse argv into command + positional + flags. Recognized common flags:
 * `--json`, `--quiet`/`-q`, `--cwd <path>` (and `--cwd=<path>`), `--help`/`-h`,
 * `--version`/`-V`. Any other `--flag`/`--flag=value` is captured generically so
 * per-command flags survive without special-casing here.
 */
export function parseArgs(argv: string[]): ParsedArgs {
	const positional: string[] = [];
	const flags: Record<string, string | boolean> = {};
	let json = false;
	let quiet = false;
	let cwd: string | undefined;
	let command: string | undefined;
	for (let i = 0; i < argv.length; i++) {
		const a = argv[i];
		if (a === "--json") {
			json = true;
			flags.json = true;
			continue;
		}
		if (a === "--quiet" || a === "-q") {
			quiet = true;
			flags.quiet = true;
			continue;
		}
		if (a === "--help" || a === "-h") {
			flags.help = true;
			continue;
		}
		if (a === "--version" || a === "-V") {
			flags.version = true;
			continue;
		}
		if (a.startsWith("--cwd=")) {
			cwd = a.slice("--cwd=".length);
			flags.cwd = cwd;
			continue;
		}
		if (a === "--cwd") {
			cwd = argv[++i];
			flags.cwd = cwd;
			continue;
		}
		if (a.startsWith("--") && a.length > 2) {
			const eq = a.indexOf("=");
			if (eq > 2) {
				flags[a.slice(2, eq)] = a.slice(eq + 1);
			} else {
				const name = a.slice(2);
				const next = argv[i + 1];
				if (next !== undefined && !next.startsWith("--")) {
					flags[name] = next;
					i++;
				} else {
					flags[name] = true;
				}
			}
			continue;
		}
		if (command === undefined) command = a;
		else positional.push(a);
	}
	return { command, positional, flags, json, quiet, cwd };
}

/** Build the JSON envelope. */
export function envelope(
	ok: boolean,
	command: string,
	data?: unknown,
	error?: { code: string; message: string },
): Envelope {
	const env: Envelope = { ok, command, cliVersion: CLI_VERSION, schemaVersion: SCHEMA_VERSION };
	if (data !== undefined) env.data = data;
	if (error) env.error = error;
	return env;
}

const HELP = `session-link CLI v${CLI_VERSION} (schema v${SCHEMA_VERSION})

Usage: session-link <command> [flags] [args]

Commands:
  store                 store path, repo root, fallback flag
  show [--unit U]       current link of a line (default line if no --unit)
  write                 write a link (JSON on stdin)
  name <new> [--unit U] rename the current line
  fork [--from U]       fork a line
  parent [--unit U]     resolve the parent reference
  ancestors [--unit U]  the ancestor chain
  graph                 line graph (Mermaid)
  doctor [--validate|--rebuild]  store diagnostics
  index rebuild         rebuild the index from line heads
  migrate               migrate a legacy v1 head to v2 (no new link)
  incoming              read/list/set/relocate/remove cross-store pointers
  ask                   query a predecessor session via the platform driver
  go                    start a successor (parity with the pi command)

Common flags: --cwd <path> · --json · --quiet (-q) · --help (-h) · --version (-V)

Stable surface: --json only. Human output may change between versions.
Exit codes: 0 ok · 1 not found · 2 usage · 3 store busy · 4 invalid · 5 conflict · 6 invariant`;

/** Map a thrown error to an exit code by its shape (name / code). */
export function exitCodeFor(e: unknown): number {
	const name = (e as { name?: string })?.name;
	if (name === "LockBusyError") return EXIT.lockBusy;
	const code = (e as { code?: string })?.code;
	switch (code) {
		case "not-found":
		case "notFound":
			return EXIT.notFound;
		case "conflict":
			return EXIT.conflict;
		case "invalid":
			return EXIT.invalid;
		case "invariant":
			return EXIT.invariant;
		default:
			return EXIT.usage;
	}
}

function formatHuman(data: unknown): string {
	if (typeof data === "string") return data;
	if (data === undefined) return "";
	return JSON.stringify(data, null, 2);
}

/**
 * Dispatch a parsed command. Commands are wired in К-2…К-7; until then anything
 * falls through to a usage error. Kept async — write/ask/go will await.
 */
function cwdOf(parsed: ParsedArgs): string {
	return parsed.cwd ?? process.cwd();
}
function flagStr(v: string | boolean | undefined): string | undefined {
	return typeof v === "string" ? v : undefined;
}
function notFound(command: string, message: string): { env: Envelope; exit: number } {
	return { env: envelope(false, command, undefined, { code: "not-found", message }), exit: EXIT.notFound };
}

/** Read all of stdin (fd 0); "" if none / not piped. */
function readStdin(): string {
	try {
		return readFileSync(0, "utf-8");
	} catch {
		return "";
	}
}

/** Throw with a `code` so exitCodeFor maps it to a semantic exit. */
function fail(code: string, message: string): never {
	const e = new Error(message) as Error & { code?: string };
	e.code = code;
	throw e;
}

async function cmdStore(parsed: ParsedArgs): Promise<{ env: Envelope; exit: number }> {
	const cwd = cwdOf(parsed);
	const r = resolveStore(cwd);
	return { env: envelope(true, "store", { root: r.root, viaGit: r.viaGit, cwd }), exit: EXIT.ok };
}

async function cmdShow(parsed: ParsedArgs): Promise<{ env: Envelope; exit: number }> {
	const cwd = cwdOf(parsed);
	const unit = flagStr(parsed.flags.unit);
	const found = findHandoff(cwd, unit);
	if (found.kind === "none") return notFound("show", `no handoff for ${cwd}${unit ? ` (unit=${unit})` : ""}`);
	if (found.kind === "ambiguous") {
		return {
			env: envelope(false, "show", undefined, {
				code: "ambiguous",
				message: `multiple active lines; specify --unit. Lines: ${found.lines.map((l) => l.unit).join(", ")}`,
			}),
			exit: EXIT.usage,
		};
	}
	const h = readHandoff(found.path);
	if (!h) return notFound("show", `unreadable handoff at ${found.path}`);
	return { env: envelope(true, "show", { path: found.path, kind: found.kind, link: h }), exit: EXIT.ok };
}

async function cmdParent(parsed: ParsedArgs): Promise<{ env: Envelope; exit: number }> {
	const cwd = cwdOf(parsed);
	const unit = flagStr(parsed.flags.unit);
	const found = findHandoff(cwd, unit);
	if (found.kind !== "head" && found.kind !== "legacy") return notFound("parent", "no current line head");
	const h = readHandoff(found.path);
	if (!h || h.schema !== "session-link/handoff/v2") return notFound("parent", "the head is not v2 (no parent reference)");
	const parent = (h as { parent?: { id: string; unit?: string; seq?: number; store?: string } }).parent;
	if (!parent) return notFound("parent", "the head has no parent reference");
	const r = resolveParent(parent, resolveStore(cwd).root, { hintPath: h.parentHandoffPath });
	if (r.kind !== "found") return notFound("parent", `parent not resolved (id ${r.id}; last tried ${r.lastTriedPath ?? "—"})`);
	return { env: envelope(true, "parent", { path: r.path, store: r.store, via: r.via, movedTo: r.movedTo }), exit: EXIT.ok };
}

async function cmdAncestors(parsed: ParsedArgs): Promise<{ env: Envelope; exit: number }> {
	const cwd = cwdOf(parsed);
	const unit = flagStr(parsed.flags.unit);
	const found = findHandoff(cwd, unit);
	let links: unknown[] = [];
	if (found.kind === "head" || found.kind === "legacy") {
		const h = readHandoff(found.path);
		if (h) {
			links = walkAncestors(h, resolveStore(cwd).root).map((a) => ({
				path: a.path,
				schema: a.link.schema,
				id: (a.link as { id?: string }).id ?? null,
			}));
		}
	}
	return { env: envelope(true, "ancestors", { links }), exit: EXIT.ok };
}

async function cmdGraph(parsed: ParsedArgs): Promise<{ env: Envelope; exit: number }> {
	return { env: envelope(true, "graph", { mermaid: renderGraph(resolveStore(cwdOf(parsed)).root) }), exit: EXIT.ok };
}

async function cmdDoctor(parsed: ParsedArgs): Promise<{ env: Envelope; exit: number }> {
	const store = resolveStore(cwdOf(parsed)).root;
	if (parsed.flags.validate) {
		const r = validateStore(store);
		if (r.problems.length === 0) return { env: envelope(true, "doctor", { problems: [] }), exit: EXIT.ok };
		return { env: envelope(false, "doctor", { problems: r.problems }, { code: "invalid", message: `${r.problems.length} validation problem(s)` }), exit: EXIT.invalid };
	}
	if (parsed.flags.rebuild) {
		await withLock(store, () => { rebuildIndex(store); });
		return { env: envelope(true, "doctor", { rebuilt: true }), exit: EXIT.ok };
	}
	const r = doctorReport(store);
	return { env: envelope(true, "doctor", { problems: r.problems }), exit: EXIT.ok };
}

async function cmdIndexRebuild(parsed: ParsedArgs): Promise<{ env: Envelope; exit: number }> {
	const store = resolveStore(cwdOf(parsed)).root;
	await withLock(store, () => { rebuildIndex(store); });
	return { env: envelope(true, "index", { rebuilt: true }), exit: EXIT.ok };
}

async function cmdWrite(parsed: ParsedArgs): Promise<{ env: Envelope; exit: number }> {
	const cwd = cwdOf(parsed);
	const raw = readStdin();
	let input: WriteLinkInput;
	try {
		input = JSON.parse(raw) as WriteLinkInput;
	} catch (e) {
		fail("usage", `invalid JSON on stdin: ${String((e as Error).message)}`);
	}
	if (!input || typeof input !== "object") fail("usage", "stdin must be a JSON object");
	input.cwd = cwd; // the writer's cwd wins (§6.1: repo of work = cwd, not the launch dir)
	const r = await writeLink(cwd, input);
	return { env: envelope(true, "write", { unit: r.unit, id: r.id, seq: r.seq, path: r.path, case: r.caseName }), exit: EXIT.ok };
}

async function cmdName(parsed: ParsedArgs): Promise<{ env: Envelope; exit: number }> {
	const cwd = cwdOf(parsed);
	const store = resolveStore(cwd).root;
	const newName = parsed.positional[0] ?? flagStr(parsed.flags.new);
	if (!newName) fail("usage", "name requires the new <unit> (positional or --new)");
	const unit = flagStr(parsed.flags.unit);
	const found = findHandoff(cwd, unit);
	if (found.kind === "legacy") {
		await withLock(store, () => { migrateLegacyHead(cwd, { unit: newName }); });
		return { env: envelope(true, "name", { unit: newName, migrated: true }), exit: EXIT.ok };
	}
	if (found.kind !== "head") fail("not-found", `no current line${unit ? ` for unit=${unit}` : ""}`);
	const oldUnit = found.unit;
	try {
		await withLock(store, () => { renameLine(store, oldUnit, newName); });
	} catch (e) {
		const msg = String((e as Error).message);
		if (/уже существует|exists/.test(msg)) fail("conflict", msg);
		if (/недопустим|reserved|invalid|совпадает/.test(msg)) fail("invalid", msg);
		throw e;
	}
	return { env: envelope(true, "name", { unit: newName }), exit: EXIT.ok };
}

async function cmdFork(parsed: ParsedArgs): Promise<{ env: Envelope; exit: number }> {
	const cwd = cwdOf(parsed);
	const store = resolveStore(cwd).root;
	const fromUnit = flagStr(parsed.flags.from);
	if (!fromUnit) fail("usage", "fork requires --from <unit>");
	const found = findHandoff(cwd, fromUnit);
	if (found.kind !== "head") fail("not-found", `no line to fork from: ${fromUnit}`);
	const head = readHandoff(found.path);
	if (!head || head.schema !== "session-link/handoff/v2") fail("not-found", "fork source is not v2");
	const v2 = head as HandoffV2;
	const parentRef = { id: v2.id, unit: v2.unit, seq: v2.seq };
	const base: WriteLinkInput = { createdAt: new Date().toISOString(), driver: "pi", sessionRef: "/cli", sessionId: "cli-fork", cwd, howToAsk: "pi", askCommand: ["pi"] };
	const raw = readStdin();
	if (raw.trim()) Object.assign(base, JSON.parse(raw) as Partial<WriteLinkInput>);
	const r = await withLock(store, () => forkLine(store, parentRef, base));
	return { env: envelope(true, "fork", { unit: r.unit, id: r.id, seq: r.seq, path: r.path }), exit: EXIT.ok };
}

async function cmdMigrate(parsed: ParsedArgs): Promise<{ env: Envelope; exit: number }> {
	const cwd = cwdOf(parsed);
	const store = resolveStore(cwd).root;
	const unit = flagStr(parsed.flags.unit);
	const r = await withLock(store, () => migrateLegacyHead(cwd, unit ? { unit } : {}));
	if (!r) fail("not-found", "no legacy v1 head to migrate");
	return { env: envelope(true, "migrate", { unit: r.unit, id: r.id, path: r.newPath, provisional: r.provisional }), exit: EXIT.ok };
}

async function cmdIncoming(parsed: ParsedArgs): Promise<{ env: Envelope; exit: number }> {
	const cwd = cwdOf(parsed);
	const store = resolveStore(cwd).root;
	const sub = parsed.positional[0];
	const unit = flagStr(parsed.flags.unit);

	if (!sub || sub === "list") {
		const incDir = path.join(store, "incoming");
		let names: string[] = [];
		try {
			names = readdirSync(incDir).filter((f: string) => f.endsWith(".json"));
		} catch {
			// no incoming dir
		}
		const pointers = names.map((f) => JSON.parse(readFileSync(path.join(incDir, f), "utf-8")));
		return { env: envelope(true, "incoming", { pointers }), exit: EXIT.ok };
	}
	if (sub === "read") {
		if (!unit) fail("usage", "incoming read requires --unit");
		const ptr = readIncoming(store, unit);
		if (!ptr) fail("not-found", `no incoming pointer for ${unit}`);
		return { env: envelope(true, "incoming", { pointer: ptr }), exit: EXIT.ok };
	}
	if (sub === "set") {
		if (!unit) fail("usage", "incoming set requires --unit");
		const id = flagStr(parsed.flags.id);
		const head = flagStr(parsed.flags.head);
		const src = flagStr(parsed.flags.store);
		if (!id || !head || !src) fail("usage", "incoming set requires --id, --head, --store (the source store root)");
		writeIncomingPointer(store, { unit, id, head, store: src });
		return { env: envelope(true, "incoming", { set: true, unit }), exit: EXIT.ok };
	}
	if (sub === "relocate") {
		if (!unit) fail("usage", "incoming relocate requires --unit");
		const base: WriteLinkInput = { createdAt: new Date().toISOString(), driver: "pi", sessionRef: "/cli", sessionId: "cli-relocate", cwd, howToAsk: "pi", askCommand: ["pi"] };
		const raw = readStdin();
		if (raw.trim()) Object.assign(base, JSON.parse(raw) as Partial<WriteLinkInput>);
		const r = await withLock(store, () => relocateFromIncoming(store, unit, base));
		return { env: envelope(true, "incoming", { relocated: true, unit: r.unit, path: r.path }), exit: EXIT.ok };
	}
	if (sub === "remove") {
		if (!unit) fail("usage", "incoming remove requires --unit");
		removeIncoming(store, unit);
		return { env: envelope(true, "incoming", { removed: true, unit }), exit: EXIT.ok };
	}
	fail("usage", `incoming: unknown subcommand ${sub}`);
}

/** Platform binary to spawn for `go` (a successor session). The driver registry
 *  only knows parsers; spawn is keyed by the handoff's `driver` field. */
function driverBin(driver: DriverName): string {
	switch (driver) {
		case "claude-code": return "claude";
		case "qwen": return "qwen";
		case "pi":
		default:
			return "pi";
	}
}

async function cmdAsk(parsed: ParsedArgs): Promise<{ env: Envelope; exit: number }> {
	const cwd = cwdOf(parsed);
	const found = findHandoff(cwd, flagStr(parsed.flags.unit));
	if (found.kind !== "head" && found.kind !== "legacy") fail("not-found", "no handoff to ask");
	const h = readHandoff(found.path);
	if (!h) fail("not-found", `unreadable handoff at ${found.path}`);
	const question = flagStr(parsed.flags.question) ?? readStdin().trim();
	if (!question) fail("usage", "ask requires --question or the question on stdin");
	const timeoutMs = Number(flagStr(parsed.flags.timeout) ?? 5 * 60 * 1000);
	const result = await querySession({ question, handoff: h, timeoutMs });
	return { env: envelope(true, "ask", { kind: result.kind, text: result.text, driver: result.driver, raw: result.raw, stderr: result.stderr }), exit: EXIT.ok };
}

async function cmdGo(parsed: ParsedArgs): Promise<{ env: Envelope; exit: number }> {
	const cwd = cwdOf(parsed);
	const found = findHandoff(cwd, flagStr(parsed.flags.unit));
	if (found.kind !== "head" && found.kind !== "legacy") fail("not-found", "no handoff to start a successor from");
	const h = readHandoff(found.path);
	if (!h) fail("not-found", `unreadable handoff at ${found.path}`);
	const v = validateHandoff(h);
	if (!v.ok) fail("invalid", `spine incomplete (missing: ${v.missing.join(", ")}); fill goal/summary/nextStep first`);
	if (h.committedAt) {
		const which = h.committedSessionFile ? ` (${path.basename(h.committedSessionFile)})` : "";
		process.stderr.write(`warning: a session already started from this handoff at ${h.committedAt}${which}; starting again forks a new branch.\n`);
	}
	const starter = buildStarterPrompt(found.path, { language: h.language, unitProvisional: (h as HandoffV2).unitProvisional });
	const bin = driverBin(h.driver);
	if (!parsed.flags["dry-run"]) {
		const child = spawnBin(bin, [], { cwd, stdio: "inherit" });
		try { markCommitted(cwd, new Date().toISOString(), undefined); } catch { /* best-effort */ }
		return { env: envelope(true, "go", { spawned: bin, pid: child.pid, starterPrompt: starter, note: "starter-prompt is in the response; injecting it into the successor is the caller's (platform-specific) responsibility — the CLI has no inject API" }), exit: EXIT.ok };
	}
	return { env: envelope(true, "go", { spawned: bin, dryRun: true, starterPrompt: starter }), exit: EXIT.ok };
}




async function dispatch(parsed: ParsedArgs): Promise<{ env: Envelope; exit: number }> {
	const cmd = parsed.command ?? "";
	switch (cmd) {
		case "store": return cmdStore(parsed);
		case "show": return cmdShow(parsed);
		case "parent": return cmdParent(parsed);
		case "ancestors": return cmdAncestors(parsed);
		case "graph": return cmdGraph(parsed);
		case "doctor": return cmdDoctor(parsed);
		case "write": return cmdWrite(parsed);
		case "name": return cmdName(parsed);
		case "fork": return cmdFork(parsed);
		case "migrate": return cmdMigrate(parsed);
		case "incoming": return cmdIncoming(parsed);
		case "ask": return cmdAsk(parsed);
		case "go": return cmdGo(parsed);
		case "index":
			if (parsed.positional[0] === "rebuild") return cmdIndexRebuild(parsed);
			return { env: envelope(false, "index", undefined, { code: "usage", message: "usage: index rebuild" }), exit: EXIT.usage };
		default:
			return { env: envelope(false, cmd, undefined, { code: "unknown-command", message: `unknown or unimplemented command: ${cmd || "(none)"}` }), exit: EXIT.usage };
	}
}

async function main(argv: string[]): Promise<number> {
	const parsed = parseArgs(argv);
	const out = (s: string) => process.stdout.write(s);

	if (parsed.flags.help) {
		if (!parsed.quiet) out(HELP + "\n");
		return EXIT.ok;
	}
	if (parsed.flags.version) {
		if (!parsed.quiet) out(`session-link ${CLI_VERSION} (schema v${SCHEMA_VERSION})\n`);
		return EXIT.ok;
	}
	if (!parsed.command) {
		const env = envelope(false, "", undefined, { code: "usage", message: "no command given — --help for usage." });
		out((parsed.json ? JSON.stringify(env) : env.error!.message) + "\n");
		return EXIT.usage;
	}

	try {
		const { env, exit } = await dispatch(parsed);
		if (parsed.json) out(JSON.stringify(env) + "\n");
		else if (!parsed.quiet) {
			if (env.ok) {
				if (env.data !== undefined) out(formatHuman(env.data) + "\n");
			} else {
				out((env.error?.message ?? "error") + "\n");
			}
		}
		return exit;
	} catch (e) {
		const env = envelope(false, parsed.command, undefined, {
			code: (e as { code?: string })?.code ?? "error",
			message: String((e as Error)?.message ?? e),
		});
		if (parsed.json) out(JSON.stringify(env) + "\n");
		else if (!parsed.quiet) out(env.error!.message + "\n");
		return exitCodeFor(e);
	}
}

const invokedDirectly = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (invokedDirectly) {
	main(process.argv.slice(2)).then((code) => process.exit(code));
}
