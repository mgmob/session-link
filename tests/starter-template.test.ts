/**
 * Starter preamble/postamble + the go template contract (П-5, issue #15).
 * DoD 7 — the org block stands BEFORE the seven steps (string comparison, not
 * eyes). DoD 6 — a profile that requires a template refuses to start a
 * successor when the file is missing, naming the path. Plain never has one.
 */
import { test } from "node:test";
import * as assert from "node:assert/strict";
import * as cp from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";

import { buildStarterPrompt } from "../src/starter.ts";
import { writeLink, type WriteLinkInput } from "../src/handoff.ts";
import { PROFILES_SUBDIR } from "../src/profiles.ts";
import { rmrf, tmpProject } from "./helpers.ts";

const CLI = path.join(process.cwd(), "src", "cli.ts");
const hex = (s: string) => () => s;

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

test("DoD 7: the org block stands BEFORE the seven steps — by string order", () => {
	const s = buildStarterPrompt("/h.json", { language: "Russian", preamble: "# ORG STEPS\n1. Проверь санкцию." });
	assert.ok(s.indexOf("# ORG STEPS") < s.indexOf("Proceed now:"), "preamble must precede the steps");
	assert.ok(s.indexOf("# ORG STEPS") > s.indexOf("LANGUAGE:"), "language stays at the very top");
	assert.match(s, /---\n\nThe previous session handed off context/, "block separated from the steps");
});

test("DoD 7 (plain side): no preamble — the prompt is exactly the seven steps, no org block", () => {
	const s = buildStarterPrompt("/h.json", {});
	assert.equal(s.includes("---"), false);
	assert.equal(s.includes("ORG"), false);
	assert.ok(s.indexOf("Proceed now:") > -1);
});

test("postamble lands after the closing line", () => {
	const s = buildStarterPrompt("/h.json", { postamble: "# AFTER" });
	assert.ok(s.indexOf("# AFTER") > s.indexOf("Narrate each step"));
});

test("DoD 6: fleet line + MISSING fleet.md → go refuses, names the file, starts nothing", async () => {
	const cwd = tmpProject();
	try {
		const r = await writeLink(cwd, input({ profile: "fleet" }), { now: new Date(Date.UTC(2026, 8, 2, 9, 0, 0)), hex: hex("dd01") });
		const gone = run(["go", "--cwd", cwd, "--unit", r.unit, "--json", "--dry-run"]);
		const env = JSON.parse(gone.stdout.trim());
		assert.equal(env.ok, false);
		assert.equal(gone.status, 4);
		assert.match(env.error.message, /шаблон организационных шагов/);
		assert.match(env.error.message, /fleet\.md/, "the missing file is named");
	} finally {
		rmrf(cwd);
	}
});

test("DoD 6 (control): the SAME store with the template present → go assembles the starter with the block", async () => {
	const cwd = tmpProject();
	try {
		fs.mkdirSync(path.join(cwd, PROFILES_SUBDIR), { recursive: true });
		fs.writeFileSync(path.join(cwd, PROFILES_SUBDIR, "fleet.md"), "# Fleet steps\n- check sanctions");
		const r = await writeLink(cwd, input({ profile: "fleet" }), { now: new Date(Date.UTC(2026, 8, 2, 9, 0, 0)), hex: hex("dd02") });
		const ok = run(["go", "--cwd", cwd, "--unit", r.unit, "--json", "--dry-run"]);
		const env = JSON.parse(ok.stdout.trim());
		assert.equal(env.ok, true);
		assert.equal(ok.status, 0);
		assert.match(env.data.starterPrompt, /# Fleet steps/);
		assert.ok(
			env.data.starterPrompt.indexOf("# Fleet steps") < env.data.starterPrompt.indexOf("Proceed now:"),
			"org block before the steps in the real assembled starter",
		);
	} finally {
		rmrf(cwd);
	}
});

test("plain line: go never requires a template (no org dir at all)", async () => {
	const cwd = tmpProject();
	try {
		const r = await writeLink(cwd, input(), { now: new Date(Date.UTC(2026, 8, 2, 9, 0, 0)), hex: hex("dd03") });
		const ok = run(["go", "--cwd", cwd, "--unit", r.unit, "--json", "--dry-run"]);
		const env = JSON.parse(ok.stdout.trim());
		assert.equal(env.ok, true);
		assert.equal(env.data.starterPrompt.includes("---"), false);
	} finally {
		rmrf(cwd);
	}
});

test("org profile with knobs only (no .md): no block and no refusal — the org declared steps-free strictness", async () => {
	const cwd = tmpProject();
	try {
		fs.mkdirSync(path.join(cwd, PROFILES_SUBDIR), { recursive: true });
		fs.writeFileSync(path.join(cwd, PROFILES_SUBDIR, "ops.json"), JSON.stringify({ maxAgeDays: 3 }));
		const r = await writeLink(cwd, input({ profile: "ops" }), { now: new Date(Date.UTC(2026, 8, 2, 9, 0, 0)), hex: hex("dd04") });
		const ok = run(["go", "--cwd", cwd, "--unit", r.unit, "--json", "--dry-run"]);
		assert.equal(JSON.parse(ok.stdout.trim()).ok, true);
	} finally {
		rmrf(cwd);
	}
});
