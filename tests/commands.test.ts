/**
 * Commands (Э9): /session-link-graph (renderGraph) and /session-link-doctor
 * (doctorReport + --validate). The command handlers in index.ts are thin shells
 * over these pure functions, which is what's tested here (no TUI).
 */
import { test } from "node:test";
import * as assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";

import { renderGraph } from "../src/graph.ts";
import { doctorReport, validateDocument, validateStore } from "../src/doctor.ts";
import { writeLink, type WriteLinkInput } from "../src/handoff.ts";
import { headPath, indexPath, lockPath, resolveStore } from "../src/store.ts";
import { rmrf, tmpProject } from "./helpers.ts";

const T1 = new Date(Date.UTC(2026, 7, 5, 10, 0, 0));
const T2 = new Date(Date.UTC(2026, 7, 5, 11, 0, 0));
const hex = (s: string) => () => s;
const DEAD_PID = 4_000_000;

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
function writeJson(p: string, obj: unknown): void {
	fs.mkdirSync(path.dirname(p), { recursive: true });
	fs.writeFileSync(p, JSON.stringify(obj));
}

// ── renderGraph ─────────────────────────────────────────────────────────────────

test("renderGraph: empty store ⇒ a placeholder", () => {
	const cwd = tmpProject();
	try {
		assert.match(renderGraph(storeOf(cwd)), /no v2 lines/);
	} finally {
		rmrf(cwd);
	}
});

test("renderGraph: nodes for every link and a parent edge for a chain", async () => {
	const cwd = tmpProject();
	try {
		const store = storeOf(cwd);
		await writeLink(cwd, input({ sessionId: "A", unit: "alpha" }), { now: T1, hex: hex("aaaa") }); // seq 1
		await writeLink(cwd, input({ sessionId: "B", unit: "alpha" }), { now: T2, hex: hex("bbbb") }); // seq 2 → parent edge
		const g = renderGraph(store);
		assert.match(g, /^graph TD/);
		assert.match(g, /alpha:1/);
		assert.match(g, /alpha:2/);
		assert.match(g, /-->/, "the parent relation shows up as an edge");
	} finally {
		rmrf(cwd);
	}
});

// ── validateDocument / validateStore ─────────────────────────────────────────────

test("validateDocument: a well-formed v2 has no issues", () => {
	const issues = validateDocument({
		schema: "session-link/handoff/v2",
		id: "20260805T100000000-aaaa",
		createdAt: "2026-08-05T10:00:00.000Z",
		driver: "pi",
		sessionRef: "/s",
		cwd: "/p",
		howToAsk: "pi",
		askCommand: ["pi"],
		unit: "alpha",
		seq: 1,
	});
	assert.deepEqual(issues, []);
});

test("validateDocument: v2 missing id/unit/seq is flagged (–-validate catches a schema breach)", () => {
	const issues = validateDocument({
		schema: "session-link/handoff/v2",
		createdAt: "x",
		driver: "pi",
		sessionRef: "/s",
		cwd: "/p",
		howToAsk: "pi",
		askCommand: ["pi"],
	});
	assert.ok(issues.some((m) => /id/.test(m)));
	assert.ok(issues.some((m) => /unit/.test(m)));
	assert.ok(issues.some((m) => /seq/.test(m)));
});

test("validateStore: a broken file in the store surfaces a problem", async () => {
	const cwd = tmpProject();
	try {
		const store = storeOf(cwd);
		await writeLink(cwd, input({ sessionId: "A", unit: "alpha" }), { now: T1, hex: hex("aaaa") });
		// Corrupt the head: drop `unit` (a v2-required field).
		const p = headPath(store, "alpha");
		const obj = JSON.parse(fs.readFileSync(p, "utf-8"));
		delete obj.unit;
		fs.writeFileSync(p, JSON.stringify(obj));
		const r = validateStore(store);
		assert.ok(r.problems.some((pr) => /unit/.test(pr.message)), "the breach is reported");
	} finally {
		rmrf(cwd);
	}
});

// ── doctorReport ────────────────────────────────────────────────────────────────

test("doctorReport: a healthy store has no problems", async () => {
	const cwd = tmpProject();
	try {
		const store = storeOf(cwd);
		await writeLink(cwd, input({ sessionId: "A", unit: "alpha" }), { now: T1, hex: hex("aaaa") });
		assert.equal(doctorReport(store).problems.length, 0);
	} finally {
		rmrf(cwd);
	}
});

test("doctorReport: a broken parent link is reported", async () => {
	const cwd = tmpProject();
	try {
		const store = storeOf(cwd);
		await writeLink(cwd, input({ sessionId: "A", unit: "alpha" }), { now: T1, hex: hex("aaaa") });
		const p = headPath(store, "alpha");
		const obj = JSON.parse(fs.readFileSync(p, "utf-8"));
		obj.parent = { id: "20260101T000000000-dead", unit: "alpha", seq: 0 };
		fs.writeFileSync(p, JSON.stringify(obj));
		const r = doctorReport(store);
		assert.ok(r.problems.some((pr) => pr.kind === "broken-parent"));
	} finally {
		rmrf(cwd);
	}
});

test("doctorReport: index divergence is reported", async () => {
	const cwd = tmpProject();
	try {
		const store = storeOf(cwd);
		await writeLink(cwd, input({ sessionId: "A", unit: "alpha" }), { now: T1, hex: hex("aaaa") });
		writeJson(indexPath(store), { schema: "session-link/index/v1", units: {} }); // wipe the real index
		const r = doctorReport(store);
		assert.ok(r.problems.some((pr) => pr.kind === "index-divergence"));
	} finally {
		rmrf(cwd);
	}
});

test("doctorReport: a stale lock is reported", async () => {
	const cwd = tmpProject();
	try {
		const store = storeOf(cwd);
		await writeLink(cwd, input({ sessionId: "A", unit: "alpha" }), { now: T1, hex: hex("aaaa") });
		writeJson(lockPath(store), { pid: DEAD_PID, startedAt: 0, acquiredAt: 0 });
		const r = doctorReport(store);
		assert.ok(r.problems.some((pr) => pr.kind === "stale-lock"));
	} finally {
		rmrf(cwd);
	}
});

test("doctorReport: an orphaned incoming/ pointer is reported", async () => {
	const cwd = tmpProject();
	try {
		const store = storeOf(cwd);
		await writeLink(cwd, input({ sessionId: "A", unit: "alpha" }), { now: T1, hex: hex("aaaa") });
		writeJson(path.join(store, "incoming", "ghost.json"), { unit: "ghost" });
		const r = doctorReport(store);
		assert.ok(r.problems.some((pr) => pr.kind === "orphaned-incoming"));
	} finally {
		rmrf(cwd);
	}
});
