/**
 * CLI↔core cross-read (К-7): the format-level half of the §7 acceptance.
 * The CLI writes what the core (== the pi adapter) reads, and vice versa.
 *
 * This is NOT the full §7 check — it does not cross a platform boundary (different
 * cwd resolution, a live writer on the other side, etc.). That is a manual run
 * documented in RUNNING.md. But it does pin the shared-format invariant that
 * makes the manual run meaningful.
 */
import { test } from "node:test";
import * as assert from "node:assert/strict";
import * as cp from "node:child_process";
import * as path from "node:path";

import { readHandoff, writeLink, type WriteLinkInput } from "../src/handoff.ts";
import { headPath, resolveStore } from "../src/store.ts";
import { rmrf, tmpProject } from "./helpers.ts";

const CLI = path.join(process.cwd(), "src", "cli.ts");

function run(args: string[], opts: { input?: string } = {}): { status: number | null; stdout: string } {
	const r = cp.spawnSync("node", [CLI, ...args], { cwd: process.cwd(), encoding: "utf-8", input: opts.input });
	return { status: r.status, stdout: r.stdout ?? "" };
}
function jsonOut(stdout: string) {
	return JSON.parse(stdout.trim()) as { ok: boolean; data?: { link?: { unit: string; schema: string } } };
}
function writeInput(o: Partial<WriteLinkInput>): string {
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

test("cross: a link the CLI writes is read by the core (== the pi adapter)", () => {
	const cwd = tmpProject();
	try {
		const r = run(["write", "--cwd", cwd, "--json"], { input: writeInput({ unit: "from-cli", sessionId: "sid-cli" }) });
		assert.equal(r.status, 0);
		// readHandoff is the exact function the pi extension's /session-link-show goes through.
		const store = resolveStore(cwd).root;
		const h = readHandoff(headPath(store, "from-cli"));
		assert.ok(h, "core reads the CLI-written link");
		assert.equal(h!.schema, "session-link/handoff/v2");
	} finally {
		rmrf(cwd);
	}
});

test("cross: a link the core writes is shown by the CLI", async () => {
	const cwd = tmpProject();
	try {
		await writeLink(cwd, {
			createdAt: "2026-08-09T10:00:00.000Z",
			driver: "pi",
			sessionRef: "/s.jsonl",
			sessionId: "sid-core",
			cwd,
			howToAsk: "pi",
			askCommand: ["pi"],
			goal: "g",
			summary: "s",
			nextStep: "n",
			unit: "from-core",
		});
		const env = jsonOut(run(["show", "--unit", "from-core", "--cwd", cwd, "--json"]).stdout);
		assert.equal(env.ok, true);
		assert.equal(env.data!.link!.unit, "from-core");
		assert.equal(env.data!.link!.schema, "session-link/handoff/v2");
	} finally {
		rmrf(cwd);
	}
});
