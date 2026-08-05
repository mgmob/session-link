/**
 * Store-wide lock (Э5; contract §5). Invariant 10: concurrent writes don't lose
 * data; a stale lock is reclaimed; the race loser gets an honest refusal.
 *
 * The lock identifies a live owner by pid + process start time (a reused pid has
 * a different start), and a dead owner is reclaimed — otherwise the first crash
 * would make writing a handoff in the project impossible forever (§5).
 */
import { test } from "node:test";
import * as assert from "node:assert/strict";
import * as fs from "node:fs";

import { lockPath, LockBusyError, withLock } from "../src/store.ts";
import { rmrf, tmpProject } from "./helpers.ts";

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

// A pid that very likely does not exist (used to simulate a dead owner).
const DEAD_PID = 4_000_000;

test("withLock: acquires, runs, releases", async () => {
	const store = tmpProject();
	try {
		let ran = false;
		await withLock(store, () => {
			ran = true;
		});
		assert.equal(ran, true);
		assert.ok(!fs.existsSync(lockPath(store)), "lock file removed after release");
	} finally {
		rmrf(store);
	}
});

test("withLock: returns the fn result (sync and async)", async () => {
	const store = tmpProject();
	try {
		assert.equal(await withLock(store, () => 42), 42);
		assert.equal(await withLock(store, async () => "hello"), "hello");
	} finally {
		rmrf(store);
	}
});

test("inv. 10: two concurrent runs never overlap", async () => {
	const store = tmpProject();
	try {
		const order: string[] = [];
		const slow = withLock(
			store,
			async () => {
				order.push("slow-start");
				await sleep(60);
				order.push("slow-end");
			},
			{ pollMs: 10 },
		);
		const fast = withLock(
			store,
			async () => {
				order.push("fast-start");
				await sleep(5);
				order.push("fast-end");
			},
			{ pollMs: 10 },
		);
		await Promise.all([slow, fast]);
		const joined = order.join(",");
		assert.ok(
			joined === "slow-start,slow-end,fast-start,fast-end" ||
				joined === "fast-start,fast-end,slow-start,slow-end",
			`runs did not serialize cleanly: ${joined}`,
		);
	} finally {
		rmrf(store);
	}
});

test("inv. 10: a live owner makes the loser time out with LockBusyError (honest refusal)", async () => {
	const store = tmpProject();
	try {
		// Holder keeps the lock until we release it.
		let release!: () => void;
		const held = new Promise<void>((r) => (release = r));
		const holder = withLock(store, () => held, { pollMs: 5 });

		// The loser has a short timeout and the owner is alive (us) → must refuse.
		await assert.rejects(
			withLock(store, () => "should-not-run", { timeoutMs: 40, pollMs: 5 }),
			(e) => e instanceof LockBusyError,
		);

		release();
		await holder;
		assert.ok(!fs.existsSync(lockPath(store)), "lock released once the holder finishes");
	} finally {
		rmrf(store);
	}
});

test("inv. 10: a stale lock with a dead pid is reclaimed", async () => {
	const store = tmpProject();
	try {
		fs.mkdirSync(store, { recursive: true });
		fs.writeFileSync(lockPath(store), JSON.stringify({ pid: DEAD_PID, startedAt: 0, acquiredAt: 0 }));

		const log: string[] = [];
		const result = await withLock(store, () => "ok", { log: (m) => log.push(m), pollMs: 5 });
		assert.equal(result, "ok", "ran after reclaiming");
		assert.ok(log.some((m) => /reclaiming stale/.test(m)), "reclamation was logged");
		assert.ok(!fs.existsSync(lockPath(store)), "lock released afterwards");
	} finally {
		rmrf(store);
	}
});

test("inv. 10: a lock with our pid but a different start time is reclaimed (pid reuse)", async () => {
	const store = tmpProject();
	try {
		fs.mkdirSync(store, { recursive: true });
		// Live pid (ours) but a different process start → treated as a reused pid.
		fs.writeFileSync(lockPath(store), JSON.stringify({ pid: process.pid, startedAt: 0, acquiredAt: 0 }));
		const result = await withLock(store, () => "ok", { pollMs: 5 });
		assert.equal(result, "ok", "reclaimed despite a live pid (different start)");
		assert.ok(!fs.existsSync(lockPath(store)));
	} finally {
		rmrf(store);
	}
});

test("withLock: releases the lock even when fn throws", async () => {
	const store = tmpProject();
	try {
		await assert.rejects(
			withLock(store, () => {
				throw new Error("boom");
			}),
			/boom/,
		);
		assert.ok(!fs.existsSync(lockPath(store)), "lock released despite the throw");
	} finally {
		rmrf(store);
	}
});
