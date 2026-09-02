/**
 * Degenerate --profile forms (from PR #17 reviews): the parser's behaviour on
 * the edges nobody writes tests for — a valueless flag, a repeated flag, and a
 * flag followed by another flag. All three are DECISIONS; these tests write
 * them down so a future parser rewrite can't change them silently (scribe's
 * observation: "two --profile with different names" is exactly the input on
 * which two parses of one argument diverge quietly).
 */
import { test } from "node:test";
import * as assert from "node:assert/strict";
import * as cp from "node:child_process";
import * as path from "node:path";

import { writeLink, type WriteLinkInput } from "../src/handoff.ts";
import { rmrf, tmpProject } from "./helpers.ts";

const CLI = path.join(process.cwd(), "src", "cli.ts");

function run(args: string[]): { status: number | null; stdout: string } {
	const r = cp.spawnSync("node", [CLI, ...args], { cwd: process.cwd(), encoding: "utf-8" });
	return { status: r.status, stdout: r.stdout ?? "" };
}
function input(o: Partial<WriteLinkInput> = {}): WriteLinkInput {
	return {
		createdAt: "2026-09-02T10:00:00.000Z",
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

test("--profile without a value = not declared (NOT plain, NOT an error)", async () => {
	const cwd = tmpProject();
	try {
		await writeLink(cwd, input(), { now: new Date(), hex: () => "ff01" });
		// A bare --profile followed by nothing: the parser records `true`,
		// flagStr maps it to undefined → no declaration → the plain line is served.
		const r = run(["show", "--cwd", cwd, "--json", "--profile"]);
		assert.equal(r.status, 0);
		assert.equal(JSON.parse(r.stdout).ok, true);
	} finally {
		rmrf(cwd);
	}
});

test("--profile --json: the valueless flag does NOT swallow the next flag", async () => {
	const cwd = tmpProject();
	try {
		await writeLink(cwd, input(), { now: new Date(), hex: () => "ff02" });
		const r = run(["show", "--profile", "--json", "--cwd", cwd]);
		assert.equal(r.status, 0);
		assert.equal(JSON.parse(r.stdout).ok, true); // --json still honoured, not eaten as the value
	} finally {
		rmrf(cwd);
	}
});

test("--profile a --profile b: LAST WINS (recorded decision, scribe's observation)", async () => {
	const cwd = tmpProject();
	try {
		await writeLink(cwd, input(), { now: new Date(), hex: () => "ff03" });
		// fleet (refuses unit-less) declared twice, the last one plain-shaped…
		// --profile fleet --profile "" → last wins → not declared → served.
		const r = run(["show", "--cwd", cwd, "--json", "--profile", "fleet", "--profile", ""]);
		assert.equal(r.status, 0);

		// …and the reverse order: "" then fleet → last wins → fleet applies.
		const r2 = run(["show", "--cwd", cwd, "--json", "--profile", "", "--profile", "fleet"]);
		assert.equal(r2.status, 2);
	} finally {
		rmrf(cwd);
	}
});
