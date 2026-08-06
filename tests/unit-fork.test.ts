/**
 * unit naming, rename, forks (Э8; contract §3, §6).
 *   8  — a fork off a mid-chain link keeps both branches reachable;
 *   11 — `auto` with no unit/parent ⇒ a technical name and the write still happens;
 *   12 — a rename doesn't break the chain (ancestor walk is identical before/after);
 *   20 — a rename doesn't touch archives (byte-identical) and doesn't rewrite links.
 */
import { test } from "node:test";
import * as assert from "node:assert/strict";
import * as fs from "node:fs";

import { forkLine, readHandoff, renameLine, writeLink, type WriteLinkInput } from "../src/handoff.ts";
import { resolveParent, walkAncestors } from "../src/parent.ts";
import { assignUnit, archivePath, deriveForkUnitName, headPath, resolveStore, unitDir, validateUnit, UNIT_PATTERN } from "../src/store.ts";
import type { HandoffV2 } from "../src/types.ts";
import { rmrf, tmpProject } from "./helpers.ts";

const T = (h: number) => new Date(Date.UTC(2026, 7, 5, h, 0, 0));
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

// ── assignUnit / validateUnit ────────────────────────────────────────────────────

test("inv. 11: no given, no parent ⇒ a technical provisional name that passes UNIT_PATTERN", () => {
	const r = assignUnit({ now: T(9), hex: hex("1f2e") });
	assert.equal(r.unit, "u-20260805-090000-1f2e");
	assert.equal(r.provisional, true);
	assert.ok(UNIT_PATTERN.test(r.unit));
});

test("validateUnit: rejects Windows-reserved names (§3.1)", () => {
	assert.equal(validateUnit("alpha").ok, true);
	assert.equal(validateUnit("con").ok, false, "con is reserved");
	assert.equal(validateUnit("NUL").ok, false, "case-insensitive");
	assert.equal(validateUnit("lpt1.json").ok, false, "reserved with extension");
	assert.equal(validateUnit("com9").ok, false);
});

// ── rename (§2.5/§3) ─────────────────────────────────────────────────────────────

test("inv. 12 + 20: rename moves the dir, keeps archives byte-identical, walk is identical", async () => {
	const cwd = tmpProject();
	try {
		const store = storeOf(cwd);
		const r1 = await writeLink(cwd, input({ sessionId: "A", unit: "alpha" }), { now: T(10), hex: hex("aaaa") });
		await writeLink(cwd, input({ sessionId: "B", unit: "alpha" }), { now: T(11), hex: hex("bbbb") });
		// r1 is now archived in alpha/handoff-<r1.id>.json
		const archiveBefore = fs.readFileSync(archivePath(store, "alpha", r1.id));
		const walkBefore = walkAncestors(readHead(store, "alpha"), store).map((s) => (s.link as HandoffV2).id);

		renameLine(store, "alpha", "beta");

		// Inv. 20 — archive contents unchanged, just relocated.
		const archiveAfter = fs.readFileSync(archivePath(store, "beta", r1.id));
		assert.deepEqual(archiveAfter, archiveBefore, "archive byte-identical after rename");

		// Inv. 12 — the ancestor walk yields the same set.
		const walkAfter = walkAncestors(readHead(store, "beta"), store).map((s) => (s.link as HandoffV2).id);
		assert.deepEqual(walkAfter, walkBefore, "ancestor walk identical before/after rename");

		assert.ok(fs.existsSync(headPath(store, "beta")));
		assert.ok(!fs.existsSync(headPath(store, "alpha")), "old dir is gone");

		// Inv. 20 (resolve side) — a parent ref still carrying the OLD unit hint resolves via the scan step.
		const res = resolveParent({ id: r1.id, unit: "alpha" }, store);
		assert.equal(res.kind, "found");
		if (res.kind === "found") assert.equal(res.path, archivePath(store, "beta", r1.id));
	} finally {
		rmrf(cwd);
	}
});

test("rename: clears unitProvisional (operator confirmed the name)", async () => {
	const cwd = tmpProject();
	try {
		const store = storeOf(cwd);
		const r = await writeLink(cwd, input({ sessionId: "A" }), { now: T(10), hex: hex("aaaa") }); // technical unit
		assert.ok(readHead(store, r.unit).unitProvisional, "starts provisional");
		renameLine(store, r.unit, "named");
		assert.equal(readHead(store, "named").unitProvisional, undefined, "provisional cleared on rename");
		assert.equal(readHead(store, "named").unit, "named");
	} finally {
		rmrf(cwd);
	}
});

test("rename: rejects invalid, occupied, same-name, and missing lines", async () => {
	const cwd = tmpProject();
	try {
		const store = storeOf(cwd);
		await writeLink(cwd, input({ sessionId: "A", unit: "alpha" }), { now: T(10), hex: hex("aaaa") });
		await writeLink(cwd, input({ sessionId: "B", unit: "beta" }), { now: T(11), hex: hex("bbbb") });
		assert.throws(() => renameLine(store, "alpha", "Bad Name!"), /недопустим/);
		assert.throws(() => renameLine(store, "alpha", "beta"), /уже существует/);
		assert.throws(() => renameLine(store, "alpha", "alpha"), /совпадает/);
		assert.throws(() => renameLine(store, "ghost", "x"), /не найдена/);
	} finally {
		rmrf(cwd);
	}
});

// ── forks (§6) ───────────────────────────────────────────────────────────────────

test("deriveForkUnitName: next free -bN suffix (occupied names skipped, not reused)", () => {
	const cwd = tmpProject();
	try {
		const store = storeOf(cwd);
		fs.mkdirSync(unitDir(store, "alpha"), { recursive: true });
		assert.equal(deriveForkUnitName(store, "alpha"), "alpha-b2");
		fs.mkdirSync(unitDir(store, "alpha-b2"), { recursive: true });
		assert.equal(deriveForkUnitName(store, "alpha"), "alpha-b3");
	} finally {
		rmrf(cwd);
	}
});

test("inv. 8: a fork off a mid-chain link keeps both branches reachable", async () => {
	const cwd = tmpProject();
	try {
		const store = storeOf(cwd);
		const r1 = await writeLink(cwd, input({ sessionId: "A", unit: "alpha" }), { now: T(10), hex: hex("aaaa") }); // seq 1
		const r2 = await writeLink(cwd, input({ sessionId: "B", unit: "alpha" }), { now: T(11), hex: hex("bbbb") }); // seq 2, archives r1
		await writeLink(cwd, input({ sessionId: "C", unit: "alpha" }), { now: T(12), hex: hex("cccc") }); // seq 3, archives r2

		// Fork off link seq=2 (the archived r2).
		const parentRef = { id: r2.id, unit: "alpha", seq: 2 };
		const f = forkLine(store, parentRef, input({ sessionId: "FORK", cwd }), { now: T(13), hex: hex("ffff") });

		assert.equal(f.unit, "alpha-b2");
		assert.equal(f.seq, 3, "fork from N starts at N+1 (§7.2)");
		assert.deepEqual(f.link.parent, parentRef);
		assert.equal(f.link.unitProvisional, true, "fork is provisional — operator is prompted");

		// Both branches are present and reachable.
		assert.ok(fs.existsSync(headPath(store, "alpha")));
		assert.ok(fs.existsSync(headPath(store, "alpha-b2")));

		// Walking the fork reaches the fork point (r2) and beyond (r1) — the shared trunk.
		const walk = walkAncestors(readHead(store, "alpha-b2"), store).map((s) => (s.link as HandoffV2).id);
		assert.deepEqual(walk, [r2.id, r1.id], "fork reaches its parent and the shared ancestor");
	} finally {
		rmrf(cwd);
	}
});
