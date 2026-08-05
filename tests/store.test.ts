/**
 * Store layout + identity (Э1; contract §2).
 *
 * Covers: resolveStore in a normal repo / non-git / a worktree (invariant 13 —
 * one clone's worktrees share the store); generateId format, uniqueness, and
 * collision regeneration; idExists against archives and heads; layout helpers.
 *
 * Edge cases flagged by the plan (bare / submodule / symlinked .git) are
 * smoke-tested only lightly here — the load-bearing invariant is worktree
 * sharing, which is what the repo-scoped rule exists for.
 */
import { test } from "node:test";
import * as assert from "node:assert/strict";
import * as cp from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";

import {
	ID_PATTERN,
	archivePath,
	generateId,
	headPath,
	idExists,
	indexPath,
	incomingPath,
	lockPath,
	movedToPath,
	resolveStore,
	STORE_SUBDIR,
	unitDir,
} from "../src/store.ts";
import { tmpProject, rmrf } from "./helpers.ts";

// ── git test harness ───────────────────────────────────────────────────────
function git(args: string[], cwd: string): cp.SpawnSyncReturns<string> {
	const r = cp.spawnSync("git", args, { cwd, encoding: "utf-8" });
	if (r.status !== 0) {
		throw new Error(`git ${args.join(" ")} (in ${cwd}) failed: ${(r.stderr || "").trim()}`);
	}
	return r;
}

function gitInit(dir: string): void {
	git(["init", "-q"], dir);
	git(["config", "user.email", "test@example.test"], dir);
	git(["config", "user.name", "Test"], dir);
	fs.writeFileSync(path.join(dir, "seed.txt"), "init");
	git(["add", "."], dir);
	git(["commit", "-q", "-m", "init"], dir);
}

// ── resolveStore ─────────────────────────────────────────────────────────────

test("resolveStore: repo-scoped via git-common-dir in a normal repo", () => {
	const repo = tmpProject();
	try {
		gitInit(repo);
		const s = resolveStore(repo);
		assert.equal(s.viaGit, true);
		assert.equal(s.root, path.join(repo, ".git", STORE_SUBDIR));
	} finally {
		rmrf(repo);
	}
});

test("resolveStore: cwd fallback when not a git repo", () => {
	const dir = tmpProject();
	try {
		const s = resolveStore(dir);
		assert.equal(s.viaGit, false);
		assert.equal(s.root, path.join(dir, STORE_SUBDIR));
	} finally {
		rmrf(dir);
	}
});

test("invariant 13: a worktree resolves to the SAME store as the main checkout", () => {
	const main = tmpProject();
	const wt = main + "-wt";
	try {
		gitInit(main);
		git(["worktree", "add", "-q", wt], main);

		const fromMain = resolveStore(main);
		const fromWorktree = resolveStore(wt);
		assert.equal(fromMain.viaGit, true);
		assert.equal(fromWorktree.viaGit, true);
		// The whole point of the repo-scoped rule: one shared store per clone.
		assert.equal(fromWorktree.root, fromMain.root, "worktree shares the main store");
		assert.equal(fromWorktree.root, path.join(main, ".git", STORE_SUBDIR));
	} finally {
		rmrf(main);
		rmrf(wt);
	}
});

test("resolveStore: a bare repo still resolves via git-common-dir (smoke)", () => {
	const bare = tmpProject();
	try {
		// `git init --bare` then ask from within it; common-dir is the bare dir itself.
		git(["init", "-q", "--bare", "."], bare);
		const s = resolveStore(bare);
		assert.equal(s.viaGit, true);
		assert.equal(s.root, path.join(bare, STORE_SUBDIR));
	} finally {
		rmrf(bare);
	}
});

// ── generateId ───────────────────────────────────────────────────────────────

test("generateId: matches the id pattern <YYYYMMDD>T<HHMMSSmmm>-<4hex>", () => {
	const store = tmpProject();
	try {
		const id = generateId(store, { now: new Date(Date.UTC(2026, 6, 1, 12, 0, 0, 123)) });
		assert.ok(id.startsWith("20260701T120000123-"), `utc ts prefix: ${id}`);
		assert.match(id, ID_PATTERN);
	} finally {
		rmrf(store);
	}
});

test("generateId: repeated draws in a fresh store are all unique", () => {
	const store = tmpProject();
	try {
		const ids = new Set<string>();
		for (let i = 0; i < 200; i++) ids.add(generateId(store));
		assert.equal(ids.size, 200, "all generated ids are distinct");
	} finally {
		rmrf(store);
	}
});

test("generateId: regenerates the hex on a collision (same ms + same hex)", () => {
	const store = tmpProject();
	try {
		const unit = "demo";
		fs.mkdirSync(unitDir(store, unit), { recursive: true });
		// Pre-plant an archive whose id collides with the first hex our source yields.
		fs.writeFileSync(archivePath(store, unit, "20260701T120000000-aaaa"), "{}");

		const seq = ["aaaa", "bbbb", "cccc"];
		let i = 0;
		const id = generateId(store, {
			now: new Date(Date.UTC(2026, 6, 1, 12, 0, 0, 0)),
			hex: () => seq[i++],
		});
		assert.equal(id, "20260701T120000000-bbbb", "first hex collided → second hex used");
	} finally {
		rmrf(store);
	}
});

// ── idExists ─────────────────────────────────────────────────────────────────

test("idExists: false on a missing store", () => {
	assert.equal(idExists(tmpProject(), "20260701T120000000-aaaa"), false);
});

test("idExists: true for an archive filename and for a head's id field", () => {
	const store = tmpProject();
	try {
		const a = "alpha";
		const b = "beta";
		fs.mkdirSync(unitDir(store, a), { recursive: true });
		fs.mkdirSync(unitDir(store, b), { recursive: true });

		// Archive of a known id in unit `a`.
		fs.writeFileSync(archivePath(store, a, "20260701T120000000-aaaa"), "{}");
		assert.equal(idExists(store, "20260701T120000000-aaaa"), true, "archive hit");

		// Head carrying its id inside in unit `b`.
		fs.writeFileSync(headPath(store, b), JSON.stringify({ id: "20260701T130000000-bbbb" }));
		assert.equal(idExists(store, "20260701T130000000-bbbb"), true, "head id hit");

		assert.equal(idExists(store, "20260701T140000000-cccc"), false, "absent id");
	} finally {
		rmrf(store);
	}
});

// ── layout helpers ───────────────────────────────────────────────────────────

test("layout helpers: produce the documented paths off the store root", () => {
	const root = "/srv/repo/.git/.pi/session_link";
	assert.equal(unitDir(root, "omr-dev"), path.join(root, "omr-dev"));
	assert.equal(headPath(root, "omr-dev"), path.join(root, "omr-dev", "handoff.json"));
	assert.equal(archivePath(root, "omr-dev", "20260701T120000000-aaaa"), path.join(root, "omr-dev", "handoff-20260701T120000000-aaaa.json"));
	assert.equal(indexPath(root), path.join(root, "index.json"));
	assert.equal(lockPath(root), path.join(root, ".lock"));
	assert.equal(movedToPath(path.join(root, "omr-dev")), path.join(root, "omr-dev", "MOVED-TO.txt"));
	assert.equal(incomingPath(root, "omr-dev"), path.join(root, "incoming", "omr-dev.json"));
});
