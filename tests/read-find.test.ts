/**
 * readHandoff {v1,v2} + findHandoff + default-line rule (Э2; contract §2.3, §4.3, §7.4).
 *
 * Invariant 7 — v1 reads. Invariant 18 — with >1 active line the tool does NOT
 * pick for the operator (read returns a list, not a path). Lenient reading
 * preserves unknown fields so a newer-shape document survives an older tool.
 */
import { test } from "node:test";
import * as assert from "node:assert/strict";
import * as fs from "node:fs";

import { findHandoff, readHandoff, readIndex, resolveDefaultUnit } from "../src/handoff.ts";
import { headPath, movedToPath, unitDir } from "../src/store.ts";
import { isHandoffV2 } from "../src/types.ts";
import { fixturePath, rmrf, tmpProject } from "./helpers.ts";

const V1_DIR = fixturePath("v1-chain");

/** A minimal valid v2 head; `o` overrides / extends (incl. unknown fields). */
function v2Head(o: Record<string, unknown> = {}): Record<string, unknown> {
	return {
		schema: "session-link/handoff/v2",
		id: "20260701T120000000-aaaa",
		createdAt: "2026-07-01T12:00:00.000Z",
		driver: "pi",
		sessionRef: "/home/s/.pi/s.jsonl",
		sessionId: "sid-1",
		cwd: "/proj",
		howToAsk: "printf '%s' | pi --mode json",
		askCommand: ["pi", "--mode", "json"],
		unit: "demo",
		seq: 1,
		goal: "goal",
		summary: "summary",
		nextStep: "first line of next step\nsecond line",
		committedAt: "2026-07-01T12:01:00.000Z",
		lineState: "active",
		...o,
	};
}

/** Write a v2 head into <store>/<unit>/handoff.json. Returns the head path. */
function writeHead(store: string, unit: string, o: Record<string, unknown> = {}): string {
	const dir = unitDir(store, unit);
	fs.mkdirSync(dir, { recursive: true });
	const p = headPath(store, unit);
	fs.writeFileSync(p, JSON.stringify(v2Head({ unit, ...o })) + "\n", "utf-8");
	return p;
}

/** Non-git tmp project → store root = <cwd>/.pi/session_link (resolveStore fallback). */
function storeRootOf(cwd: string): string {
	return `${cwd}/.pi/session_link`;
}

// ── readHandoff ───────────────────────────────────────────────────────────────

test("readHandoff (inv. 7): v1 fixture head reads as v1", () => {
	const h = readHandoff(`${V1_DIR}/handoff.json`);
	if (!h) assert.fail("v1 head should parse");
	assert.equal(h.schema, "session-link/handoff/v1");
});

test("readHandoff: v2 head reads as v2", () => {
	const dir = tmpProject();
	try {
		const store = storeRootOf(dir);
		const p = writeHead(store, "demo");
		const h = readHandoff(p);
		if (!h) assert.fail("v2 head should parse");
		assert.equal(h.schema, "session-link/handoff/v2");
		assert.ok(isHandoffV2(h));
	} finally {
		rmrf(dir);
	}
});

test("readHandoff: lenient — unknown fields are preserved (forward-compat)", () => {
	const dir = tmpProject();
	try {
		const store = storeRootOf(dir);
		const p = writeHead(store, "demo", { externals: { chat: { x: 1 } }, futureField: { z: [1, 2, 3] } });
		const h = readHandoff(p) as unknown as Record<string, unknown>;
		if (!h) assert.fail("head should parse");
		assert.deepEqual((h.externals as { chat: { x: number } }).chat, { x: 1 });
		assert.deepEqual(h.futureField, { z: [1, 2, 3] }, "unknown field survived the read");
	} finally {
		rmrf(dir);
	}
});

test("readHandoff: rejects non-family schema, corrupt json, and a v2 missing required id", () => {
	const dir = tmpProject();
	try {
		const store = storeRootOf(dir);
		fs.mkdirSync(store, { recursive: true });

		const other = `${store}/other.json`;
		fs.writeFileSync(other, JSON.stringify({ schema: "some/other/v9", createdAt: "x" }));
		assert.equal(readHandoff(other), undefined, "non-family schema");

		const corrupt = `${store}/corrupt.json`;
		fs.writeFileSync(corrupt, "{ not json");
		assert.equal(readHandoff(corrupt), undefined, "corrupt json");

		// v2 minus id → fails the required check.
		const noId = v2Head();
		delete noId.id;
		const noIdPath = `${store}/no-id.json`;
		fs.writeFileSync(noIdPath, JSON.stringify(noId));
		assert.equal(readHandoff(noIdPath), undefined, "v2 without id");

		// v2 with a bad unit → fails the regex check.
		const badUnit = `${store}/bad-unit.json`;
		fs.writeFileSync(badUnit, JSON.stringify(v2Head({ unit: "Bad Unit!" })));
		assert.equal(readHandoff(badUnit), undefined, "v2 with invalid unit");
	} finally {
		rmrf(dir);
	}
});

// ── findHandoff ───────────────────────────────────────────────────────────────

test("findHandoff: explicit unit → that line's head", () => {
	const dir = tmpProject();
	try {
		writeHead(storeRootOf(dir), "alpha");
		const r = findHandoff(dir, "alpha");
		assert.equal(r.kind, "head");
		assert.equal(r.unit, "alpha");
	} finally {
		rmrf(dir);
	}
});

test("findHandoff: explicit unit, miss → none (no fallthrough)", () => {
	const dir = tmpProject();
	try {
		writeHead(storeRootOf(dir), "alpha");
		assert.equal(findHandoff(dir, "missing").kind, "none");
	} finally {
		rmrf(dir);
	}
});

test("findHandoff: a single active line becomes the default", () => {
	const dir = tmpProject();
	try {
		writeHead(storeRootOf(dir), "solo");
		const r = findHandoff(dir);
		assert.equal(r.kind, "head");
		assert.equal(r.unit, "solo");
	} finally {
		rmrf(dir);
	}
});

test("findHandoff (inv. 18): two active lines → ambiguous list, no silent pick", () => {
	const dir = tmpProject();
	try {
		writeHead(storeRootOf(dir), "a", { committedAt: "2026-07-01T10:00:00.000Z" });
		writeHead(storeRootOf(dir), "b", { committedAt: "2026-07-01T12:00:00.000Z" });
		const r = findHandoff(dir);
		assert.equal(r.kind, "ambiguous");
		if (r.kind !== "ambiguous") return;
		assert.equal(r.lines.length, 2);
		// Sorted by updatedAt desc → "b" first.
		assert.equal(r.lines[0].unit, "b");
		assert.equal(r.lines[1].unit, "a");
		// UnitSummary carries the §4.3 fields.
		assert.equal(r.lines[0].nextStepFirstLine, "first line of next step");
	} finally {
		rmrf(dir);
	}
});

test("findHandoff: zero active lines + legacy v1 file → legacy", () => {
	const dir = tmpProject();
	try {
		fs.mkdirSync(`${dir}/.pi/session_link`, { recursive: true });
		fs.writeFileSync(
			`${dir}/.pi/session_link/handoff.json`,
			JSON.stringify({ schema: "session-link/handoff/v1", createdAt: "x", driver: "pi", sessionRef: "/s", cwd: "/p", howToAsk: "pi", askCommand: ["pi"] }),
		);
		const r = findHandoff(dir);
		assert.equal(r.kind, "legacy");
	} finally {
		rmrf(dir);
	}
});

test("findHandoff: legacy next to MOVED-TO.txt → none (already relocated)", () => {
	const dir = tmpProject();
	try {
		fs.mkdirSync(`${dir}/.pi/session_link`, { recursive: true });
		fs.writeFileSync(`${dir}/.pi/session_link/handoff.json`, "{}");
		fs.writeFileSync(movedToPath(`${dir}/.pi/session_link`), "/new/store/loc\n");
		assert.equal(findHandoff(dir).kind, "none");
	} finally {
		rmrf(dir);
	}
});

test("findHandoff: nothing at all → none", () => {
	const dir = tmpProject();
	try {
		assert.equal(findHandoff(dir).kind, "none");
	} finally {
		rmrf(dir);
	}
});

test("findHandoff: done/abandoned lines are not the default; only active counts", () => {
	const dir = tmpProject();
	try {
		writeHead(storeRootOf(dir), "finished", { lineState: "done", unit: "finished" });
		// No active line, no legacy → none.
		assert.equal(findHandoff(dir).kind, "none");
	} finally {
		rmrf(dir);
	}
});

// ── resolveDefaultUnit / readIndex ─────────────────────────────────────────────

test("resolveDefaultUnit: none in an empty/missing store", () => {
	const dir = tmpProject();
	try {
		assert.equal(resolveDefaultUnit(storeRootOf(dir)).kind, "none");
	} finally {
		rmrf(dir);
	}
});

test("readIndex: undefined when absent", () => {
	const dir = tmpProject();
	try {
		assert.equal(readIndex(storeRootOf(dir)), undefined);
	} finally {
		rmrf(dir);
	}
});

test("readIndex: parses a valid v1 index", () => {
	const dir = tmpProject();
	try {
		const store = storeRootOf(dir);
		fs.mkdirSync(store, { recursive: true });
		fs.writeFileSync(
			`${store}/index.json`,
			JSON.stringify({
				schema: "session-link/index/v1",
				units: { "demo": { head: "demo/handoff.json", updatedAt: "2026-07-01T12:00:00.000Z", sessions: 3, state: "active", cwd: "/proj" } },
			}),
		);
		const idx = readIndex(store);
		if (!idx) assert.fail("index should parse");
		assert.equal(idx.units["demo"].sessions, 3);
	} finally {
		rmrf(dir);
	}
});
