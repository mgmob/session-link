/**
 * index.json (Э7; contract §4). Invariant 3: the index points at each line's head,
 * and `--rebuild-index` is byte-for-byte identical to what the write left behind.
 *
 * The index is a DERIVED cache — both the in-transaction update and the rebuild go
 * through `buildIndex`, so they cannot drift apart.
 */
import { test } from "node:test";
import * as assert from "node:assert/strict";
import * as fs from "node:fs";

import { buildIndex, readIndex, rebuildIndex, writeLink, type WriteLinkInput } from "../src/handoff.ts";
import { indexPath, resolveStore } from "../src/store.ts";
import { rmrf, tmpProject } from "./helpers.ts";

const T1 = new Date(Date.UTC(2026, 7, 5, 10, 0, 0));
const T2 = new Date(Date.UTC(2026, 7, 5, 11, 0, 0));

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

// ── entry shape ────────────────────────────────────────────────────────────────

test("index entry: head is store-relative; state mirrors lineState; sessions counts links", async () => {
	const cwd = tmpProject();
	try {
		const store = storeOf(cwd);
		await writeLink(cwd, input({ sessionId: "sid-A", unit: "alpha" }), { now: T1, hex: () => "aaaa" });

		const idx = readIndex(store);
		if (!idx) assert.fail("index should exist after writeLink");
		const e = idx.units["alpha"];
		assert.equal(e.head, "alpha/handoff.json", "head path is relative to the store");
		assert.equal(e.state, "active", "absent lineState ⇒ active");
		assert.equal(e.sessions, 1, "one link ⇒ sessions=1");
		assert.equal(e.cwd, "/proj");
		assert.equal(e.unitProvisional, undefined, "given name ⇒ no provisional flag");
	} finally {
		rmrf(cwd);
	}
});

test("index entry: a provisional head is flagged", async () => {
	const cwd = tmpProject();
	try {
		const store = storeOf(cwd);
		// No unit given ⇒ a technical (provisional) name.
		await writeLink(cwd, input({ sessionId: "sid-A" }), { now: T1, hex: () => "aaaa" });
		const idx = readIndex(store)!;
		const unit = Object.keys(idx.units)[0];
		assert.equal(idx.units[unit].unitProvisional, true, "technical name flagged in the index");
	} finally {
		rmrf(cwd);
	}
});

test("sessions grows as the line advances (new link archives the head)", async () => {
	const cwd = tmpProject();
	try {
		const store = storeOf(cwd);
		await writeLink(cwd, input({ sessionId: "sid-A", unit: "alpha" }), { now: T1, hex: () => "aaaa" });
		await writeLink(cwd, input({ sessionId: "sid-B", unit: "alpha" }), { now: T2, hex: () => "bbbb" });
		assert.equal(readIndex(store)!.units["alpha"].sessions, 2, "head + 1 archive");
	} finally {
		rmrf(cwd);
	}
});

test("state mirrors the head's lineState (done ⇒ done, not active)", async () => {
	const cwd = tmpProject();
	try {
		const store = storeOf(cwd);
		await writeLink(cwd, input({ sessionId: "sid-A", unit: "alpha", lineState: "done" }), {
			now: T1,
			hex: () => "aaaa",
		});
		assert.equal(readIndex(store)!.units["alpha"].state, "done");
	} finally {
		rmrf(cwd);
	}
});

test("units are sorted by name in the serialized index", async () => {
	const cwd = tmpProject();
	try {
		const store = storeOf(cwd);
		await writeLink(cwd, input({ sessionId: "sid-A", unit: "zeta" }), { now: T1, hex: () => "aaaa" });
		await writeLink(cwd, input({ sessionId: "sid-B", unit: "alpha" }), { now: T2, hex: () => "bbbb" });
		assert.deepEqual(Object.keys(readIndex(store)!.units), ["alpha", "zeta"]);
	} finally {
		rmrf(cwd);
	}
});

// ── invariant 3: rebuild == in-transaction update ─────────────────────────────

test("inv. 3: rebuildIndex reproduces the index byte-for-byte", async () => {
	const cwd = tmpProject();
	try {
		const store = storeOf(cwd);
		await writeLink(cwd, input({ sessionId: "sid-A", unit: "alpha" }), { now: T1, hex: () => "aaaa" });
		await writeLink(cwd, input({ sessionId: "sid-B", unit: "beta" }), { now: T2, hex: () => "bbbb" });

		const afterWrite = fs.readFileSync(indexPath(store), "utf-8");
		rebuildIndex(store);
		const afterRebuild = fs.readFileSync(indexPath(store), "utf-8");
		assert.equal(afterWrite, afterRebuild, "rebuild gives the exact same bytes the write left");
	} finally {
		rmrf(cwd);
	}
});

test("inv. 3: buildIndex on a fresh/missing store yields an empty v1 index", () => {
	const cwd = tmpProject();
	try {
		const idx = buildIndex(storeOf(cwd));
		assert.equal(idx.schema, "session-link/index/v1");
		assert.deepEqual(idx.units, {});
	} finally {
		rmrf(cwd);
	}
});
