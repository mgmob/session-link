/**
 * CLI foundation (К-1): argv parsing, the JSON envelope, exit codes, versions.
 * Commands land in К-2…; here only help/version/usage + the envelope shape.
 */
import { test } from "node:test";
import * as assert from "node:assert/strict";
import * as cp from "node:child_process";
import * as path from "node:path";

import { CLI_VERSION, SCHEMA_VERSION, envelope, EXIT, exitCodeFor, parseArgs } from "../src/cli.ts";

const CLI = path.join(process.cwd(), "src", "cli.ts");

/** Run the CLI as a real subprocess and return {status, stdout, stderr}. */
function run(args: string[], opts: { input?: string } = {}): { status: number | null; stdout: string; stderr: string } {
	const r = cp.spawnSync("node", [CLI, ...args], {
		cwd: process.cwd(),
		encoding: "utf-8",
		input: opts.input,
	});
	return { status: r.status, stdout: r.stdout ?? "", stderr: r.stderr ?? "" };
}

// ── unit: parseArgs ──────────────────────────────────────────────────────────────

test("parseArgs: command + positional + common flags", () => {
	const p = parseArgs(["show", "--unit", "alpha", "--json", "--cwd", "/tmp/x", "extra"]);
	assert.equal(p.command, "show");
	assert.deepEqual(p.positional, ["extra"]);
	assert.equal(p.json, true);
	assert.equal(p.cwd, "/tmp/x");
	assert.equal(p.flags.unit, "alpha");
});

test("parseArgs: --cwd=value and --flag=value forms", () => {
	const p = parseArgs(["store", "--cwd=/p", "--unit=beta"]);
	assert.equal(p.cwd, "/p");
	assert.equal(p.flags.unit, "beta");
});

test("parseArgs: boolean flag without a value", () => {
	const p = parseArgs(["graph", "--json", "--quiet"]);
	assert.equal(p.flags.json, true);
	assert.equal(p.flags.quiet, true);
	assert.equal(p.quiet, true);
});

// ── unit: envelope + exit codes ───────────────────────────────────────────────────

test("envelope: success carries data; failure carries error; both carry versions", () => {
	const ok = envelope(true, "store", { root: "/x" });
	assert.equal(ok.ok, true);
	assert.equal(ok.command, "store");
	assert.equal(ok.cliVersion, CLI_VERSION);
	assert.equal(ok.schemaVersion, SCHEMA_VERSION);
	assert.deepEqual(ok.data, { root: "/x" });
	assert.equal(ok.error, undefined);

	const err = envelope(false, "show", undefined, { code: "not-found", message: "no line" });
	assert.equal(err.ok, false);
	assert.equal(err.error!.code, "not-found");
	assert.equal(err.data, undefined);
});

test("exitCodeFor: LockBusyError → 3; code not-found → 1; unknown → 2", () => {
	const busy = new Error("busy");
	busy.name = "LockBusyError";
	assert.equal(exitCodeFor(busy), EXIT.lockBusy);
	assert.equal(exitCodeFor(Object.assign(new Error("x"), { code: "not-found" })), EXIT.notFound);
	assert.equal(exitCodeFor(Object.assign(new Error("x"), { code: "conflict" })), EXIT.conflict);
	assert.equal(exitCodeFor(new Error("x")), EXIT.usage);
});

// ── subprocess: the bin actually runs ─────────────────────────────────────────────

test("subprocess: --help exits 0 and prints usage", () => {
	const r = run(["--help"]);
	assert.equal(r.status, EXIT.ok);
	assert.match(r.stdout, /Usage: session-link/);
});

test("subprocess: --version prints cli + schema versions", () => {
	const r = run(["--version"]);
	assert.equal(r.status, EXIT.ok);
	assert.match(r.stdout, new RegExp(`session-link ${CLI_VERSION} \\(schema v${SCHEMA_VERSION}\\)`));
});

test("subprocess: no command → exit 2 (usage)", () => {
	const r = run([]);
	assert.equal(r.status, EXIT.usage);
	assert.match(r.stdout, /no command given|--help/);
});

test("subprocess: unknown command → exit 2; --json gives the full envelope", () => {
	const r = run(["bogus", "--json"]);
	assert.equal(r.status, EXIT.usage);
	const env = JSON.parse(r.stdout);
	assert.equal(env.ok, false);
	assert.equal(env.command, "bogus");
	assert.equal(env.cliVersion, CLI_VERSION);
	assert.equal(env.schemaVersion, SCHEMA_VERSION);
	assert.equal(env.error.code, "unknown-command");
});

test("subprocess: --quiet suppresses human output but keeps exit code", () => {
	const r = run(["bogus", "--quiet"]);
	assert.equal(r.status, EXIT.usage);
	assert.equal(r.stdout, "");
});
