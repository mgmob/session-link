/**
 * v1→v2 migration (Э4; contract §2.4).
 *
 *   7  — a v1 chain reads; after migration it is v2 with no data loss;
 *   14 — the legacy head is found, moved ONCE, marked; a repeat no longer sees it;
 *   19 — two legacy chains from different worktrees become two distinct lines;
 *   23 — after the head moves, walking to v1 ancestors returns the same links
 *        (the v1 archives stayed put, reachable via parentHandoffPath).
 */
import { test } from "node:test";
import * as assert from "node:assert/strict";
import * as cp from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";

import { convertV1ToV2Link, findHandoff, migrateLegacyHead, readHandoff } from "../src/handoff.ts";
import { walkAncestors } from "../src/parent.ts";
import { assignUnit, headPath, movedToPath, resolveStore, sluggifyHint, unitDir } from "../src/store.ts";
import type { HandoffV1, HandoffV2 } from "../src/types.ts";
import { isHandoffV1, isHandoffV2 } from "../src/types.ts";
import { rmrf, tmpProject } from "./helpers.ts";

/** A minimal valid v1 handoff with a distinct sessionId per `n`. */
function v1Handoff(n: number): Record<string, unknown> {
	return {
		schema: "session-link/handoff/v1",
		createdAt: `2026-07-01T1${n}:00:00.000Z`,
		driver: "pi",
		sessionRef: `/s-${n}.jsonl`,
		sessionId: `sid-${n}-aaaaaaaaaaaaaaaaaaaa`,
		cwd: "/proj",
		howToAsk: "pi",
		askCommand: ["pi"],
		goal: "g",
		summary: `session ${n}`,
		nextStep: `do ${n + 1}`,
	};
}

/** Write a real v1 chain of `n` links into <cwd>/.pi/session_link — emulating the
 *  v0.1.0 writer (archive the previous head, set parentHandoffPath). */
function writeV1Chain(cwd: string, n: number): void {
	const dir = path.join(cwd, ".pi", "session_link");
	fs.mkdirSync(dir, { recursive: true });
	const stamp = (iso: string) => iso.replace(/[:.]/g, "-");
	for (let i = 1; i <= n; i++) {
		const h = v1Handoff(i) as Record<string, unknown> & { parentHandoffPath?: string; createdAt: string };
		const current = path.join(dir, "handoff.json");
		if (fs.existsSync(current)) {
			const archive = path.join(dir, `handoff-${stamp(h.createdAt)}.json`);
			fs.copyFileSync(current, archive);
			h.parentHandoffPath = archive;
		}
		fs.writeFileSync(current, JSON.stringify(h, null, 2) + "\n", "utf-8");
	}
}

/** Non-git tmp project → store root = legacy dir = <cwd>/.pi/session_link. */
function legacyDir(cwd: string): string {
	return path.join(cwd, ".pi", "session_link");
}

const MIG_NOW = new Date(Date.UTC(2026, 7, 5, 12, 0, 0));
const MIG_HEX = () => "aaaa";

// ── migration of a real v1 chain ───────────────────────────────────────────────

test("inv. 7/14: a v1 chain migrates to a v2 head in the store, with id/unit/seq", () => {
	const cwd = tmpProject();
	try {
		writeV1Chain(cwd, 3);
		const store = resolveStore(cwd).root;

		const r = migrateLegacyHead(cwd, { now: MIG_NOW, hex: MIG_HEX });
		if (!r) assert.fail("migration should happen for a legacy head");
		assert.equal(r.unit, "u-20260805-120000-aaaa");
		assert.equal(r.id, "20260805T120000000-aaaa");
		assert.equal(r.provisional, true);

		const head = readHandoff(headPath(store, r.unit));
		if (!head) assert.fail("migrated head should be readable");
		assert.ok(isHandoffV2(head), "head is now v2");
		const v2 = head as HandoffV2;
		assert.equal(v2.seq, 1);
		assert.equal(v2.unit, r.unit);
		assert.equal(v2.unitProvisional, true);
		assert.ok(v2.parentHandoffPath, "the v1 ancestor hint (parentHandoffPath) was preserved");
	} finally {
		rmrf(cwd);
	}
});

test("inv. 14: legacy head is gone, MOVED-TO.txt is left in the old dir", () => {
	const cwd = tmpProject();
	try {
		writeV1Chain(cwd, 2);
		const dir = legacyDir(cwd);
		assert.ok(fs.existsSync(path.join(dir, "handoff.json")), "legacy head present before migration");

		const r = migrateLegacyHead(cwd, { now: MIG_NOW, hex: MIG_HEX });
		if (!r) assert.fail("migration should happen");

		assert.ok(!fs.existsSync(path.join(dir, "handoff.json")), "legacy head removed (move, not copy)");
		assert.ok(!fs.existsSync(path.join(dir, "handoff.md")), "legacy projection removed too");
		assert.ok(fs.existsSync(movedToPath(dir)), "MOVED-TO.txt left behind");
		const marker = fs.readFileSync(movedToPath(dir), "utf-8").trim();
		assert.equal(marker, unitDir(resolveStore(cwd).root, r.unit), "marker points at the new line dir");
	} finally {
		rmrf(cwd);
	}
});

test("inv. 23: v1 archives stay in place and are byte-identical", () => {
	const cwd = tmpProject();
	try {
		writeV1Chain(cwd, 3);
		const dir = legacyDir(cwd);
		const archivesBefore = fs.readdirSync(dir).filter((f) => /^handoff-.*\.json$/.test(f)).sort();
		const snapshot = new Map(archivesBefore.map((f) => [f, fs.readFileSync(path.join(dir, f))]));

		migrateLegacyHead(cwd, { now: MIG_NOW, hex: MIG_HEX });

		const archivesAfter = fs.readdirSync(dir).filter((f) => /^handoff-.*\.json$/.test(f)).sort();
		assert.deepEqual(archivesAfter, archivesBefore, "no v1 archive moved or removed");
		for (const f of archivesAfter) {
			assert.deepEqual(fs.readFileSync(path.join(dir, f)), snapshot.get(f), `${f} unchanged byte-for-byte`);
		}
	} finally {
		rmrf(cwd);
	}
});

test("inv. 14: a repeat findHandoff no longer sees the stale legacy head", () => {
	const cwd = tmpProject();
	try {
		writeV1Chain(cwd, 2);
		assert.equal(findHandoff(cwd).kind, "legacy", "before migration: legacy head");
		migrateLegacyHead(cwd, { now: MIG_NOW, hex: MIG_HEX });
		const after = findHandoff(cwd);
		assert.equal(after.kind, "head", "after migration: the migrated v2 head (not legacy, not none)");
		if (after.kind === "head") assert.equal(after.unit, "u-20260805-120000-aaaa");
	} finally {
		rmrf(cwd);
	}
});

test("inv. 23: walking from the migrated head returns the same v1 ancestors", () => {
	const cwd = tmpProject();
	try {
		writeV1Chain(cwd, 3); // head + 2 v1 archives
		const store = resolveStore(cwd).root;
		const r = migrateLegacyHead(cwd, { now: MIG_NOW, hex: MIG_HEX });
		if (!r) assert.fail("migration should happen");

		const head = readHandoff(r.newPath);
		if (!head) assert.fail("migrated head readable");
		const ancestors = walkAncestors(head, store);
		assert.equal(ancestors.length, 2, "two v1 ancestors reached through the head's parentHandoffPath");
		assert.ok(isHandoffV1(ancestors[0].link), "first ancestor is a v1 archive");
		assert.ok(isHandoffV1(ancestors[1].link), "second ancestor is a v1 archive");
	} finally {
		rmrf(cwd);
	}
});

test("migrateLegacyHead: returns undefined when there is no legacy head", () => {
	const cwd = tmpProject();
	try {
		assert.equal(migrateLegacyHead(cwd), undefined);
	} finally {
		rmrf(cwd);
	}
});

// ── invariant 19: two legacy chains → two lines in a shared store ───────────────

function git(args: string[], cwd: string): void {
	const r = cp.spawnSync("git", args, { cwd, encoding: "utf-8" });
	if (r.status !== 0) throw new Error(`git ${args.join(" ")} failed: ${(r.stderr || "").trim()}`);
}
function gitInit(dir: string): void {
	git(["init", "-q"], dir);
	git(["config", "user.email", "test@example.test"], dir);
	git(["config", "user.name", "Test"], dir);
	fs.writeFileSync(path.join(dir, "seed.txt"), "x");
	git(["add", "."], dir);
	git(["commit", "-q", "-m", "init"], dir);
}

test("inv. 19: two legacy chains in one clone migrate to two distinct lines", () => {
	const main = tmpProject();
	const wt = main + "-wt";
	try {
		gitInit(main);
		git(["worktree", "add", "-q", wt], main);

		// Each worktree has its own legacy chain; the store is shared (common .git).
		writeV1Chain(main, 2);
		writeV1Chain(wt, 2);

		const storeMain = resolveStore(main).root;
		const storeWt = resolveStore(wt).root;
		assert.equal(storeWt, storeMain, "sanity: shared store across the clone");

		// Distinct `now` ⇒ distinct technical units; no line overwrites the other.
		const r1 = migrateLegacyHead(main, { now: new Date(Date.UTC(2026, 7, 5, 10, 0, 0)), hex: MIG_HEX });
		const r2 = migrateLegacyHead(wt, { now: new Date(Date.UTC(2026, 7, 5, 11, 0, 0)), hex: MIG_HEX });
		if (!r1 || !r2) assert.fail("both should migrate");
		assert.notEqual(r1.unit, r2.unit, "two different line names");

		const units = fs.readdirSync(storeMain, { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => d.name);
		assert.ok(units.includes(r1.unit) && units.includes(r2.unit), "both lines live in the shared store");
		assert.ok(fs.existsSync(headPath(storeMain, r1.unit)));
		assert.ok(fs.existsSync(headPath(storeMain, r2.unit)), "neither line was overwritten");
	} finally {
		rmrf(main);
		rmrf(wt);
	}
});

// ── assignUnit (§3.2) ──────────────────────────────────────────────────────────

test("assignUnit: a given valid name is used as-is, not provisional", () => {
	const r = assignUnit({ given: "omr-dev" });
	assert.deepEqual(r, { unit: "omr-dev", provisional: false });
});

test("assignUnit: a parent unit is inherited when nothing is given", () => {
	const r = assignUnit({ parentUnit: "parent-line" });
	assert.deepEqual(r, { unit: "parent-line", provisional: false });
});

test("assignUnit: no given, no parent ⇒ a technical provisional name", () => {
	const r = assignUnit({ now: new Date(Date.UTC(2026, 7, 5, 9, 30, 5)), hex: () => "1f2e" });
	assert.equal(r.unit, "u-20260805-093005-1f2e");
	assert.equal(r.provisional, true);
});

test("assignUnit: an invalid given name is rejected with a sluggify hint", () => {
	assert.throws(
		() => assignUnit({ given: "Omr Dev!" }),
		/недопустим.*omr-dev/,
		"strict reject; message carries the sluggified suggestion",
	);
	// sluggifyHint directly
	assert.equal(sluggifyHint("Omr Dev!"), "omr-dev");
	assert.equal(sluggifyHint("Уже кириллица"), "line", "no [a-z0-9] at all ⇒ fallback name");
	assert.equal(sluggifyHint("_leading"), "leading", "leading non-alnum is trimmed, not prefixed");
});

// ── convertV1ToV2Link ──────────────────────────────────────────────────────────

test("convertV1ToV2Link: bumps schema, assigns id/unit/seq=1, preserves the rest", () => {
	const v1 = {
		schema: "session-link/handoff/v1",
		createdAt: "2026-07-01T11:00:00.000Z",
		driver: "pi",
		sessionRef: "/s",
		cwd: "/p",
		howToAsk: "pi",
		askCommand: ["pi"],
		goal: "g",
		summary: "s",
		nextStep: "n",
		parentHandoffPath: "/abs/archive.json",
		customFuture: { x: 1 },
	} as HandoffV1;
	const v2 = convertV1ToV2Link(v1, "20260805T120000000-aaaa", "demo", false);
	assert.equal(v2.schema, "session-link/handoff/v2");
	assert.equal(v2.id, "20260805T120000000-aaaa");
	assert.equal(v2.unit, "demo");
	assert.equal(v2.seq, 1);
	assert.equal(v2.parentHandoffPath, "/abs/archive.json", "v1 ancestor hint preserved");
	assert.equal((v2 as unknown as { customFuture: { x: number } }).customFuture.x, 1, "unknown field preserved");
});
