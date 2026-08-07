/**
 * externals (Э11; contract §8). Invariant 6: absent/unknown externals never
 * breaks read or write. Invariant 9: the tool never writes externals itself.
 *
 * §8 rules: per-block ceiling 32 KB — over ⇒ HARD refusal (named, not truncated);
 * a block that can't serialize ⇒ fail-soft drop (write proceeds, logged).
 */
import { test } from "node:test";
import * as assert from "node:assert/strict";
import * as fs from "node:fs";

import { checkExternals, writeLink, type WriteLinkInput } from "../src/handoff.ts";
import { EXTERNALS_BLOCK_LIMIT } from "../src/handoff.ts";
import { headPath, resolveStore } from "../src/store.ts";
import type { HandoffV2 } from "../src/types.ts";
import { rmrf, tmpProject } from "./helpers.ts";

const T1 = new Date(Date.UTC(2026, 7, 5, 10, 0, 0));
const hex = (s: string) => () => s;

function input(o: Partial<WriteLinkInput> = {}): WriteLinkInput {
	return {
		createdAt: "2026-08-05T10:00:00.000Z",
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
function storeOf(cwd: string): string {
	return resolveStore(cwd).root;
}
function readHead(store: string, unit: string): HandoffV2 {
	return JSON.parse(fs.readFileSync(headPath(store, unit), "utf-8")) as HandoffV2;
}

// ── checkExternals ───────────────────────────────────────────────────────────────

test("checkExternals: absent / empty / small ⇒ clean", () => {
	assert.deepEqual(checkExternals(undefined), { violations: [], unserializable: [] });
	assert.deepEqual(checkExternals({}), { violations: [], unserializable: [] });
	assert.deepEqual(checkExternals({ chat: { msg: "hi" } }), { violations: [], unserializable: [] });
});

test("checkExternals: an oversize block is reported with its size", () => {
	const big = "x".repeat(EXTERNALS_BLOCK_LIMIT + 1000);
	const r = checkExternals({ big });
	assert.equal(r.violations.length, 1);
	assert.equal(r.violations[0].key, "big");
	assert.ok(r.violations[0].bytes > EXTERNALS_BLOCK_LIMIT);
});

test("checkExternals: an unserializable block (cycle) is reported separately", () => {
	const cycle: Record<string, unknown> = {};
	cycle.self = cycle;
	const r = checkExternals({ cycle });
	assert.equal(r.violations.length, 0, "size is fine; it's serialization that fails");
	assert.deepEqual(r.unserializable, ["cycle"]);
});

// ── writeLink + externals ────────────────────────────────────────────────────────

test("inv. 6: arbitrary externals survive a write/read round-trip", async () => {
	const cwd = tmpProject();
	try {
		const store = storeOf(cwd);
		await writeLink(
			cwd,
			input({ sessionId: "sid-A", unit: "alpha", externals: { chat: { msg: "hi", n: 42 }, metrics: [1, 2, 3] } }),
			{ now: T1, hex: hex("aaaa") },
		);
		const h = readHead(store, "alpha");
		assert.deepEqual((h.externals as { chat: { msg: string; n: number } }).chat, { msg: "hi", n: 42 });
		assert.deepEqual((h.externals as { metrics: number[] }).metrics, [1, 2, 3]);
	} finally {
		rmrf(cwd);
	}
});

test("inv. 9: a write with no externals leaves the field absent (the tool doesn't write it)", async () => {
	const cwd = tmpProject();
	try {
		const store = storeOf(cwd);
		await writeLink(cwd, input({ sessionId: "sid-A", unit: "alpha" }), { now: T1, hex: hex("aaaa") });
		assert.equal(readHead(store, "alpha").externals, undefined);
	} finally {
		rmrf(cwd);
	}
});

test("§8: an oversize block ⇒ hard refusal, nothing is written", async () => {
	const cwd = tmpProject();
	try {
		const store = storeOf(cwd);
		const big = "x".repeat(EXTERNALS_BLOCK_LIMIT + 5000);
		await assert.rejects(
			writeLink(cwd, input({ sessionId: "sid-A", unit: "alpha", externals: { big } }), { now: T1, hex: hex("aaaa") }),
			/50|байт|handoff не записан/,
		);
		assert.ok(!fs.existsSync(headPath(store, "alpha")), "no head written after the refusal");
	} finally {
		rmrf(cwd);
	}
});

test("§8: an unserializable block ⇒ fail-soft (written without it, logged)", async () => {
	const cwd = tmpProject();
	try {
		const store = storeOf(cwd);
		const cycle: Record<string, unknown> = {};
		cycle.self = cycle;
		const logs: string[] = [];
		await writeLink(
			cwd,
			input({ sessionId: "sid-A", unit: "alpha", externals: { good: { a: 1 }, bad: cycle } }),
			{ now: T1, hex: hex("aaaa"), log: (m) => logs.push(m) },
		);
		const h = readHead(store, "alpha");
		assert.deepEqual((h.externals as { good: { a: number } }).good, { a: 1 }, "good block kept");
		assert.equal((h.externals as Record<string, unknown>).bad, undefined, "bad block dropped");
		assert.ok(logs.some((m) => /bad/.test(m)), "drop was logged");
	} finally {
		rmrf(cwd);
	}
});
