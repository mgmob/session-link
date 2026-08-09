/**
 * CLI platform commands (К-6): ask, go.
 * Real headless query / real spawn need the platform binary — not run here.
 * Covered: the guards (no handoff, no question, incomplete spine) and go's
 * `--dry-run` path (starter-prompt, fork-warn) which needs no binary.
 */
import { test } from "node:test";
import * as assert from "node:assert/strict";
import * as cp from "node:child_process";
import * as path from "node:path";

import { markCommitted, writeLink, type WriteLinkInput } from "../src/handoff.ts";
import { rmrf, tmpProject } from "./helpers.ts";

const CLI = path.join(process.cwd(), "src", "cli.ts");

function run(args: string[], opts: { input?: string } = {}): { status: number | null; stdout: string; stderr: string } {
	const r = cp.spawnSync("node", [CLI, ...args], { cwd: process.cwd(), encoding: "utf-8", input: opts.input });
	return { status: r.status, stdout: r.stdout ?? "", stderr: r.stderr ?? "" };
}
function jsonOut(stdout: string) {
	return JSON.parse(stdout.trim()) as { ok: boolean; data?: Record<string, unknown>; error?: { code: string } };
}
function input(o: Partial<WriteLinkInput> = {}): WriteLinkInput {
	return {
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
	};
}

// ── ask (guards only; real query needs the binary) ───────────────────────────────

test("ask: no handoff → exit 1", () => {
	const cwd = tmpProject();
	try {
		const r = run(["ask", "--question", "hi", "--cwd", cwd, "--json"]);
		assert.equal(r.status, 1);
	} finally {
		rmrf(cwd);
	}
});

test("ask: handoff present but no question → exit 2", async () => {
	const cwd = tmpProject();
	try {
		await writeLink(cwd, input({ sessionId: "sid-A", unit: "alpha", cwd }));
		const r = run(["ask", "--cwd", cwd, "--json"]); // no --question, empty stdin
		assert.equal(r.status, 2);
		assert.equal(jsonOut(r.stdout).error!.code, "usage");
	} finally {
		rmrf(cwd);
	}
});


// Real `ask` (headless query) and real `go` (spawn a successor) need the platform
// binary — not covered here; run them by hand. The guards and go's --dry-run path
// (starter-prompt, fork-warn) need no binary and are covered above/below.

// ── go (--dry-run path; real spawn needs the binary) ───────────────────────────────

test("go: no handoff → exit 1", () => {
	const cwd = tmpProject();
	try {
		const r = run(["go", "--dry-run", "--cwd", cwd, "--json"]);
		assert.equal(r.status, 1);
	} finally {
		rmrf(cwd);
	}
});

test("go: incomplete spine → exit 4 (invalid)", async () => {
	const cwd = tmpProject();
	try {
		await writeLink(cwd, { ...input({ sessionId: "sid-A", unit: "alpha", cwd }), goal: undefined, summary: undefined, nextStep: undefined });
		const r = run(["go", "--dry-run", "--cwd", cwd, "--json"]);
		assert.equal(r.status, 4);
		assert.equal(jsonOut(r.stdout).error!.code, "invalid");
	} finally {
		rmrf(cwd);
	}
});

test("go --dry-run: returns the starter-prompt and the chosen binary, without spawning", async () => {
	const cwd = tmpProject();
	try {
		await writeLink(cwd, input({ sessionId: "sid-A", unit: "alpha", cwd }));
		const r = run(["go", "--dry-run", "--cwd", cwd, "--json"]);
		assert.equal(r.status, 0);
		const env = jsonOut(r.stdout);
		assert.equal(env.data!.spawned, "pi");
		assert.equal(env.data!.dryRun, true);
		assert.match(env.data!.starterPrompt as string, /Context handoff/);
	} finally {
		rmrf(cwd);
	}
});

test("go: a head with committedAt forks a new branch and warns on stderr", async () => {
	const cwd = tmpProject();
	try {
		await writeLink(cwd, input({ sessionId: "sid-A", unit: "alpha", cwd }));
		markCommitted(cwd, "2026-08-09T12:00:00.000Z", "/some/child/session.jsonl");
		const r = run(["go", "--dry-run", "--cwd", cwd, "--json"]);
		assert.equal(r.status, 0, "still proceeds (fork is allowed, just warned)");
		assert.match(r.stderr, /already started|forks a new branch/);
	} finally {
		rmrf(cwd);
	}
});
