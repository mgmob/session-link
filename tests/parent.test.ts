/**
 * resolveParent (§2.5, five steps) + walkAncestors — invariants 4, 20, 21, 22.
 *
 *   4  — ancestor walk returns THIS line's links, including cross-store ones;
 *   20 — a rename does not touch archives; the parent still resolves via the scan step;
 *   21 — a cross-store ancestor resolves via parent.store + MOVED-TO;
 *   22 — a broken link is an honest miss with the id and last tried path.
 */
import { test } from "node:test";
import * as assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";

import { resolveParent, walkAncestors } from "../src/parent.ts";
import { archivePath, movedToPath, unitDir } from "../src/store.ts";
import type { HandoffV2 } from "../src/types.ts";
import { isHandoffV1 } from "../src/types.ts";
import { rmrf, tmpProject } from "./helpers.ts";

/** Non-git tmp project → resolveStore fallback → <cwd>/.pi/session_link. */
function newStore(): { cwd: string; store: string } {
	const cwd = tmpProject();
	return { cwd, store: path.join(cwd, ".pi", "session_link") };
}

function v2Link(id: string, unit: string, o: Record<string, unknown> = {}): Record<string, unknown> {
	return {
		schema: "session-link/handoff/v2",
		id,
		createdAt: "2026-07-01T10:00:00.000Z",
		driver: "pi",
		sessionRef: "/s.jsonl",
		sessionId: "sid",
		cwd: "/proj",
		howToAsk: "pi",
		askCommand: ["pi"],
		unit,
		seq: 1,
		...o,
	};
}

function writeArchive(store: string, unit: string, id: string, o: Record<string, unknown> = {}): string {
	fs.mkdirSync(unitDir(store, unit), { recursive: true });
	const p = archivePath(store, unit, id);
	fs.writeFileSync(p, JSON.stringify(v2Link(id, unit, o)) + "\n", "utf-8");
	return p;
}

function writeFile(p: string, obj: Record<string, unknown>): string {
	fs.mkdirSync(path.dirname(p), { recursive: true });
	fs.writeFileSync(p, JSON.stringify(obj) + "\n", "utf-8");
	return p;
}

// ── resolveParent: the five steps ─────────────────────────────────────────────

test("step 1 (direct): parent.unit hint hits in one FS hop", () => {
	const { store } = newStore();
	try {
		writeArchive(store, "alpha", "20260701T100000000-aaaa");
		const r = resolveParent({ id: "20260701T100000000-aaaa", unit: "alpha" }, store);
		assert.equal(r.kind, "found");
		if (r.kind !== "found") return;
		assert.equal(r.via, "direct");
		assert.equal(r.path, archivePath(store, "alpha", "20260701T100000000-aaaa"));
		assert.equal(r.store, store);
	} finally {
		rmrf(store.replace(/\/\.pi\/session_link$/, ""));
	}
});

test("step 2 (scan) / inv. 20: a rename is resolved by id, not by dir name", () => {
	const { store } = newStore();
	try {
		// Archive lives under the NEW name; the ref still carries the OLD unit hint.
		writeArchive(store, "renamed", "20260701T100000000-aaaa");
		const r = resolveParent({ id: "20260701T100000000-aaaa", unit: "original" }, store);
		assert.equal(r.kind, "found");
		if (r.kind !== "found") return;
		assert.equal(r.via, "scan", "found by scanning unit dirs, ignoring the stale unit hint");
		assert.equal(r.path, archivePath(store, "renamed", "20260701T100000000-aaaa"));
	} finally {
		rmrf(store.replace(/\/\.pi\/session_link$/, ""));
	}
});

test("step 3 (cross-store) / inv. 21: parent.store points into another store", () => {
	const a = newStore();
	const b = newStore();
	try {
		writeArchive(b.store, "alpha", "20260701T100000000-aaaa");
		const r = resolveParent({ id: "20260701T100000000-aaaa", unit: "alpha", store: b.store }, a.store);
		assert.equal(r.kind, "found");
		if (r.kind !== "found") return;
		assert.equal(r.via, "cross-store");
		assert.equal(r.store, b.store, "resolved inside the other store");
	} finally {
		rmrf(a.cwd);
		rmrf(b.cwd);
	}
});

test("step 3 (cross-store + MOVED-TO) / inv. 21: a stale store path is followed to the new one", () => {
	const stale = newStore();
	const fresh = newStore();
	try {
		// The recorded store has moved: leave a MOVED-TO redirect, archive is in `fresh`.
		fs.mkdirSync(stale.store, { recursive: true });
		fs.writeFileSync(movedToPath(stale.store), fresh.store + "\n", "utf-8");
		writeArchive(fresh.store, "alpha", "20260701T100000000-aaaa");

		const r = resolveParent({ id: "20260701T100000000-aaaa", unit: "alpha", store: stale.store }, stale.store);
		assert.equal(r.kind, "found");
		if (r.kind !== "found") return;
		assert.equal(r.via, "cross-store");
		assert.equal(r.store, fresh.store, "followed the redirect into the new store");
		assert.equal(r.movedTo, movedToPath(stale.store), "records the MOVED-TO that was followed");
	} finally {
		rmrf(stale.cwd);
		rmrf(fresh.cwd);
	}
});

test("step 4 (legacy-path): parentHandoffPath is the last-resort hint", () => {
	const { cwd } = newStore();
	try {
		const legacyArchive = writeFile(path.join(cwd, "legacy", "handoff-stamp.json"), {
			schema: "session-link/handoff/v1",
			createdAt: "2026-07-01T09:00:00.000Z",
			driver: "pi",
			sessionRef: "/s",
			cwd: "/p",
			howToAsk: "pi",
			askCommand: ["pi"],
		});
		const r = resolveParent({ id: "20260701T090000000-xxxx" }, path.join(cwd, ".pi", "session_link"), {
			hintPath: legacyArchive,
		});
		assert.equal(r.kind, "found");
		if (r.kind !== "found") return;
		assert.equal(r.via, "legacy-path");
		assert.equal(r.path, legacyArchive);
	} finally {
		rmrf(cwd);
	}
});

test("step 5 / inv. 22: a broken link is an honest miss with the id and last tried path", () => {
	const { store } = newStore();
	try {
		const r = resolveParent({ id: "20260701T100000000-dead", unit: "alpha" }, store);
		assert.equal(r.kind, "notFound");
		if (r.kind !== "notFound") return;
		assert.equal(r.id, "20260701T100000000-dead");
		assert.ok(r.lastTriedPath, "reports the last path tried");
		assert.ok(r.lastTriedPath!.includes("alpha"), "last tried path reflects the unit hint");
	} finally {
		rmrf(store.replace(/\/\.pi\/session_link$/, ""));
	}
});

// ── walkAncestors ──────────────────────────────────────────────────────────────

test("inv. 4: walk returns THIS line's ancestors in order", () => {
	const { store, cwd } = newStore();
	try {
		// A ← B ← C (head). Archives under their own unit dirs.
		writeArchive(store, "unit-a", "20260701T080000000-aaaa");
		writeArchive(store, "unit-b", "20260701T090000000-bbbb", {
			parent: { id: "20260701T080000000-aaaa", unit: "unit-a" },
			seq: 2,
		});
		const headC = v2Link("20260701T100000000-cccc", "unit-c", {
			parent: { id: "20260701T090000000-bbbb", unit: "unit-b" },
			seq: 3,
		});
		const ancestors = walkAncestors(headC as never, store);
		assert.equal(ancestors.length, 2);
		assert.equal((ancestors[0].link as HandoffV2).id, "20260701T090000000-bbbb", "first ancestor is B (the parent)");
		assert.equal((ancestors[1].link as HandoffV2).id, "20260701T080000000-aaaa", "then A");
	} finally {
		rmrf(cwd);
	}
});

test("inv. 4: cross-store ancestors are followed into their own store", () => {
	const a = newStore();
	const b = newStore();
	try {
		// A ← B live in store B; the head in store A points into B via parent.store.
		writeArchive(b.store, "unit-a", "20260701T080000000-aaaa");
		writeArchive(b.store, "unit-b", "20260701T090000000-bbbb", {
			parent: { id: "20260701T080000000-aaaa", unit: "unit-a" },
			seq: 2,
		});
		const headC = v2Link("20260701T100000000-cccc", "unit-c", {
			parent: { id: "20260701T090000000-bbbb", unit: "unit-b", store: b.store },
			seq: 3,
		});
		const ancestors = walkAncestors(headC as never, a.store);
		assert.equal(ancestors.length, 2, "both B and A reached across the store boundary");
		assert.equal((ancestors[0].link as HandoffV2).id, "20260701T090000000-bbbb");
		assert.equal((ancestors[1].link as HandoffV2).id, "20260701T080000000-aaaa");
	} finally {
		rmrf(a.cwd);
		rmrf(b.cwd);
	}
});

test("walk: a v1 chain is followed via parentHandoffPath", () => {
	const { cwd } = newStore();
	try {
		// Two v1 archives chained by absolute parentHandoffPath, plus a v1 head.
		const a = writeFile(path.join(cwd, "arc", "a.json"), {
			schema: "session-link/handoff/v1",
			createdAt: "2026-07-01T08:00:00.000Z",
			driver: "pi",
			sessionRef: "/s",
			cwd: "/p",
			howToAsk: "pi",
			askCommand: ["pi"],
		});
		const b = writeFile(
			path.join(cwd, "arc", "b.json"),
			{
				schema: "session-link/handoff/v1",
				createdAt: "2026-07-01T09:00:00.000Z",
				driver: "pi",
				sessionRef: "/s",
				cwd: "/p",
				howToAsk: "pi",
				askCommand: ["pi"],
				parentHandoffPath: a,
			},
		);
		const head = {
			schema: "session-link/handoff/v1",
			createdAt: "2026-07-01T10:00:00.000Z",
			driver: "pi",
			sessionRef: "/s",
			cwd: "/p",
			howToAsk: "pi",
			askCommand: ["pi"],
			parentHandoffPath: b,
		};
		const ancestors = walkAncestors(head as never, path.join(cwd, ".pi", "session_link"));
		assert.equal(ancestors.length, 2);
		assert.ok(isHandoffV1(ancestors[0].link));
		assert.equal(ancestors[1].path, a);
	} finally {
		rmrf(cwd);
	}
});
