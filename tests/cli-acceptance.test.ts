/**
 * CLI acceptance (К-7, §7 of docs/cli-spec.md).
 * - the --json envelope shape holds across commands (stable machine contract);
 * - exit code 3 (store busy) fires when a live lock is held;
 * - no command creates files outside the store.
 *
 * The live pi↔Claude-Code cross-read is a MANUAL run (needs both platforms live);
 * it lives in RUNNING.md with the captured output, not here.
 */
import { test } from "node:test";
import * as assert from "node:assert/strict";
import * as cp from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";

import { writeLink, type WriteLinkInput } from "../src/handoff.ts";
import { resolveStore } from "../src/store.ts";
import { CLI_VERSION, SCHEMA_VERSION } from "../src/cli.ts";
import { rmrf, tmpProject } from "./helpers.ts";

const CLI = path.join(process.cwd(), "src", "cli.ts");

function run(args: string[], opts: { input?: string } = {}): { status: number | null; stdout: string; stderr: string } {
	const r = cp.spawnSync("node", [CLI, ...args], { cwd: process.cwd(), encoding: "utf-8", input: opts.input });
	return { status: r.status, stdout: r.stdout ?? "", stderr: r.stderr ?? "" };
}
function jsonOut(stdout: string) {
	return JSON.parse(stdout.trim()) as {
		ok: boolean;
		command: string;
		cliVersion: string;
		schemaVersion: string;
		data?: unknown;
		error?: { code: string; message: string };
	};
}
function writeInput(o: Partial<WriteLinkInput> = {}): string {
	return JSON.stringify({
		createdAt: "2026-08-09T10:00:00.000Z",
		driver: "pi",
		sessionRef: "/s.jsonl",
		sessionId: "sid-A",
		cwd: "/proj",
		howToAsk: "pi",
		askCommand: ["pi"],
		goal: "g",
		summary: "s",
		nextStep: "n",
		...o,
	});
}

// ── §7.2: --json is a contract — every command returns the same envelope shape ─────

test("acceptance: every command returns the stable --json envelope", async () => {
	const cwd = tmpProject();
	try {
		await writeLink(cwd, {
			createdAt: "2026-08-09T10:00:00.000Z",
			driver: "pi",
			sessionRef: "/s.jsonl",
			sessionId: "sid-A",
			cwd,
			howToAsk: "pi",
			askCommand: ["pi"],
			goal: "g",
			summary: "s",
			nextStep: "n",
			unit: "alpha",
		});
		const cases: string[][] = [
			["store", "--cwd", cwd],
			["show", "--cwd", cwd],
			["parent", "--cwd", cwd],
			["ancestors", "--cwd", cwd],
			["graph", "--cwd", cwd],
			["doctor", "--cwd", cwd],
			["migrate", "--cwd", cwd],
			["incoming", "--cwd", cwd],
		];
		for (const args of cases) {
			const env = jsonOut(run([...args, "--json"]).stdout);
			assert.equal(env.cliVersion, CLI_VERSION, `${args[0]}: cliVersion`);
			assert.equal(env.schemaVersion, SCHEMA_VERSION, `${args[0]}: schemaVersion`);
			assert.equal(env.command, args[0], `${args[0]}: command`);
			assert.equal(typeof env.ok, "boolean", `${args[0]}: ok is boolean`);
			// success carries data; failure carries error — never both, never neither
			if (env.ok) assert.ok(env.data !== undefined, `${args[0]}: data on success`);
			else assert.ok(env.error && env.error.code, `${args[0]}: error.code on failure`);
		}
	} finally {
		rmrf(cwd);
	}
});

// ── §7.3: exit code 3 (store busy) ─────────────────────────────────────────────────

test("acceptance: write under a live lock → exit 3 (store busy)", async () => {
	const cwd = tmpProject();
	try {
		const store = resolveStore(cwd).root;
		fs.mkdirSync(store, { recursive: true });
		// A live lock: our pid + our process start time → readStaleOwner sees it as alive.
		fs.writeFileSync(
			path.join(store, ".lock"),
			JSON.stringify({
				pid: process.pid,
				startedAt: Date.now() - Math.floor(process.uptime() * 1000),
				acquiredAt: Date.now(),
			}),
		);
		const r = run(["write", "--cwd", cwd, "--json"], { input: writeInput({ unit: "alpha" }) });
		assert.equal(r.status, 3);
		assert.equal(jsonOut(r.stdout).error!.code, "lock-busy");
	} finally {
		rmrf(cwd);
	}
});

// ── §7.5: no command creates files outside the store ─────────────────────────────────

test("acceptance: a write creates files only under the store", () => {
	const cwd = tmpProject();
	try {
		const before = new Set(walk(cwd));
		run(["write", "--cwd", cwd, "--json"], { input: writeInput({ unit: "alpha", sessionId: "sid-A" }) });
		const after = new Set(walk(cwd));
		const created = [...after].filter((p) => !before.has(p));
		const store = resolveStore(cwd).root;
		for (const p of created) {
			assert.ok(p.startsWith(store + path.sep), `file created outside the store: ${p}`);
		}
	} finally {
		rmrf(cwd);
	}
});

test("acceptance: name/migrate also stay inside the store", async () => {
	const cwd = tmpProject();
	try {
		await writeLink(cwd, {
			createdAt: "2026-08-09T10:00:00.000Z",
			driver: "pi",
			sessionRef: "/s.jsonl",
			sessionId: "sid-A",
			cwd,
			howToAsk: "pi",
			askCommand: ["pi"],
			goal: "g",
			summary: "s",
			nextStep: "n",
			unit: "alpha",
		});
		const before = new Set(walk(cwd));
		run(["name", "beta", "--cwd", cwd, "--json"]);
		const afterRename = new Set(walk(cwd));
		const store = resolveStore(cwd).root;
		for (const p of [...afterRename].filter((x) => !before.has(x))) {
			assert.ok(p.startsWith(store + path.sep), `rename created a file outside store: ${p}`);
		}
	} finally {
		rmrf(cwd);
	}
});

function walk(root: string): string[] {
	const out: string[] = [];
	function step(dir: string) {
		let entries: fs.Dirent[];
		try {
			entries = fs.readdirSync(dir, { withFileTypes: true });
		} catch {
			return;
		}
		for (const e of entries) {
			const p = path.join(dir, e.name);
			if (e.isDirectory()) step(p);
			else out.push(p);
		}
	}
	step(root);
	return out;
}
