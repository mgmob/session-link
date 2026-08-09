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
import { readFileSync } from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

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
async function dispatch(parsed: ParsedArgs): Promise<{ env: Envelope; exit: number }> {
	const cmd = parsed.command ?? "";
	return {
		env: envelope(false, cmd, undefined, {
			code: "unknown-command",
			message: `unknown or unimplemented command: ${cmd || "(none)"}`,
		}),
		exit: EXIT.usage,
	};
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
