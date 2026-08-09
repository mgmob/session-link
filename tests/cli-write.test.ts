/**
 * CLI write commands (К-4): write, name, fork, migrate — all under the lock.
 */
import { test } from "node:test";
import * as assert from "node:assert/strict";
import * as cp from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";

import { resolveStore } from "../src/store.ts";
import { rmrf, tmpProject } from "./helpers.ts";

const CLI = path.join(process.cwd(), "src", "cli.ts");

function run(args: string[], opts: { input?: string } = {}): { status: number | null; stdout: string } {
	const r = cp.spawnSync("node", [CLI, ...args], { cwd: process.cwd(), encoding: "utf-8", input: opts.input });
	return { status: r.status, stdout: r.stdout ?? "" };
}
function jsonOut(stdout: string) {
	return JSON.parse(stdout.trim()) as { ok: boolean; data?: Record<string, unknown>; error?: { code: string } };
}
function writeInput(o: Record<string, unknown> = {}): string {
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
function writeV1Legacy(cwd: string): void {
	const dir = path.join(cwd, ".pi", "session_link");
	fs.mkdirSync(dir, { recursive: true });
	fs.writeFileSync(
		path.join(dir, "handoff.json"),
		JSON.stringify({
			schema: "session-link/handoff/v1",
			createdAt: "2026-07-01T09:00:00.000Z",
			driver: "pi",
			sessionRef: "/s",
			sessionId: "sid-v1",
			cwd,
			howToAsk: "pi",
			askCommand: ["pi"],
			goal: "g",
			summary: "s",
			nextStep: "n",
		}),
	);
}

// ── write ────────────────────────────────────────────────────────────────────────

test("write: first link via JSON stdin; show reads it back", () => {
	const cwd = tmpProject();
	try {
		const r = run(["write", "--cwd", cwd, "--json"], { input: writeInput({ unit: "alpha", sessionId: "sid-A" }) });
		assert.equal(r.status, 0);
		const env = jsonOut(r.stdout);
		assert.equal(env.ok, true);
		assert.equal((env.data as { unit: string }).unit, "alpha");
		assert.equal((env.data as { case: string }).case, "first-link");

		const show = jsonOut(run(["show", "--cwd", cwd, "--json"]).stdout);
		assert.equal((show.data as { link: { unit: string } }).link.unit, "alpha");
	} finally {
		rmrf(cwd);
	}
});

test("write: a second session advances the line (new-link, seq+1)", () => {
	const cwd = tmpProject();
	try {
		run(["write", "--cwd", cwd, "--json"], { input: writeInput({ unit: "alpha", sessionId: "sid-A" }) });
		const r2 = run(["write", "--cwd", cwd, "--json"], { input: writeInput({ unit: "alpha", sessionId: "sid-B" }) });
		assert.equal((jsonOut(r2.stdout).data as { case: string; seq: number }).case, "new-link");
		assert.equal((jsonOut(r2.stdout).data as { seq: number }).seq, 2);
	} finally {
		rmrf(cwd);
	}
});

test("write: invalid JSON on stdin → exit 2", () => {
	const cwd = tmpProject();
	try {
		const r = run(["write", "--cwd", cwd, "--json"], { input: "{ not json" });
		assert.equal(r.status, 2);
		assert.equal(jsonOut(r.stdout).error!.code, "usage");
	} finally {
		rmrf(cwd);
	}
});

// ── name ─────────────────────────────────────────────────────────────────────────

test("name: renames the current line", () => {
	const cwd = tmpProject();
	try {
		run(["write", "--cwd", cwd, "--json"], { input: writeInput({ unit: "alpha", sessionId: "sid-A" }) });
		const r = run(["name", "beta", "--cwd", cwd, "--json"]);
		assert.equal(r.status, 0);
		const show = jsonOut(run(["show", "--cwd", cwd, "--json"]).stdout);
		assert.equal((show.data as { link: { unit: string } }).link.unit, "beta");
	} finally {
		rmrf(cwd);
	}
});

test("name: an occupied name → exit 5 (conflict)", () => {
	const cwd = tmpProject();
	try {
		run(["write", "--cwd", cwd, "--json"], { input: writeInput({ unit: "alpha", sessionId: "sid-A" }) });
		run(["write", "--cwd", cwd, "--json"], { input: writeInput({ unit: "gamma", sessionId: "sid-G" }) });
		const r = run(["name", "gamma", "--unit", "alpha", "--cwd", cwd, "--json"]);
		assert.equal(r.status, 5);
		assert.equal(jsonOut(r.stdout).error!.code, "conflict");
	} finally {
		rmrf(cwd);
	}
});

test("name: an invalid name → exit 4 (invalid)", () => {
	const cwd = tmpProject();
	try {
		run(["write", "--cwd", cwd, "--json"], { input: writeInput({ unit: "alpha", sessionId: "sid-A" }) });
		const r = run(["name", "Bad Name!", "--cwd", cwd, "--json"]);
		assert.equal(r.status, 4);
		assert.equal(jsonOut(r.stdout).error!.code, "invalid");
	} finally {
		rmrf(cwd);
	}
});

// ── fork ─────────────────────────────────────────────────────────────────────────

test("fork: forks off an existing line → <unit>-b2", () => {
	const cwd = tmpProject();
	try {
		run(["write", "--cwd", cwd, "--json"], { input: writeInput({ unit: "alpha", sessionId: "sid-A" }) });
		// fork requires the forking platform's identity on stdin (driver/howToAsk/askCommand/sessionRef).
		const forkInput = JSON.stringify({ driver: "pi", sessionRef: "/cli", sessionId: "cli-fork", howToAsk: "pi", askCommand: ["pi"], goal: "g", summary: "s", nextStep: "n" });
		const r = run(["fork", "--from", "alpha", "--cwd", cwd, "--json"], { input: forkInput });
		assert.equal(r.status, 0);
		assert.equal((jsonOut(r.stdout).data as { unit: string }).unit, "alpha-b2");
	} finally {
		rmrf(cwd);
	}
});

test("fork: requires --from → exit 2 otherwise", () => {
	const cwd = tmpProject();
	try {
		run(["write", "--cwd", cwd, "--json"], { input: writeInput({ unit: "alpha", sessionId: "sid-A" }) });
		const r = run(["fork", "--cwd", cwd, "--json"]);
		assert.equal(r.status, 2);
	} finally {
		rmrf(cwd);
	}
});

// ── migrate ───────────────────────────────────────────────────────────────────────

test("migrate: a legacy v1 head is moved to v2 (no new link)", () => {
	const cwd = tmpProject();
	try {
		writeV1Legacy(cwd);
		const r = run(["migrate", "--cwd", cwd, "--json"]);
		assert.equal(r.status, 0);
		const env = jsonOut(r.stdout);
		assert.equal((env.data as { provisional: boolean }).provisional, true, "no name given ⇒ technical");
		// legacy file gone, MOVED-TO left (core behavior, exposed through the store)
		assert.ok(!fs.existsSync(path.join(cwd, ".pi", "session_link", "handoff.json")));
		assert.ok(fs.existsSync(path.join(cwd, ".pi", "session_link", "MOVED-TO.txt")));
	} finally {
		rmrf(cwd);
	}
});

test("migrate: nothing to migrate → exit 1", () => {
	const cwd = tmpProject();
	try {
		const r = run(["migrate", "--cwd", cwd, "--json"]);
		assert.equal(r.status, 1);
	} finally {
		rmrf(cwd);
	}
});
