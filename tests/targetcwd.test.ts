/**
 * targetCwd / cross-store relocation (Э10; contract §2.6). Invariant 5: a line
 * with a targetCwd in ANOTHER store is found there via the incoming/ pointer;
 * the successor's first write finishes the move; the ancestor stays reachable.
 *
 * Two-store transactions are forbidden (two locks = deadlock), so the writer
 * drops a cheap pointer into the target and the successor consumes it.
 */
import { test } from "node:test";
import * as assert from "node:assert/strict";
import * as cp from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";

import { relocateFromIncoming, writeLink, type WriteLinkInput } from "../src/handoff.ts";
import { resolveParent } from "../src/parent.ts";
import {
	headPath,
	incomingPath,
	isCrossStore,
	readIncoming,
	removeIncoming,
	resolveStore,
	writeIncomingPointer,
} from "../src/store.ts";
import { rmrf, tmpProject } from "./helpers.ts";

const T1 = new Date(Date.UTC(2026, 7, 5, 10, 0, 0));
const T2 = new Date(Date.UTC(2026, 7, 5, 11, 0, 0));
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

// ── isCrossStore ─────────────────────────────────────────────────────────────────

test("isCrossStore: different folders ⇒ true; same ⇒ false", () => {
	const a = tmpProject();
	const b = tmpProject();
	try {
		assert.equal(isCrossStore(a, b), true);
		assert.equal(isCrossStore(a, a), false);
	} finally {
		rmrf(a);
		rmrf(b);
	}
});

function git(args: string[], cwd: string): void {
	const r = cp.spawnSync("git", args, { cwd, encoding: "utf-8" });
	if (r.status !== 0) throw new Error(`git ${args.join(" ")}: ${(r.stderr || "").trim()}`);
}

test("isCrossStore: two worktrees of one clone share a store ⇒ false", () => {
	const main = tmpProject();
	const wt = main + "-wt";
	try {
		git(["init", "-q"], main);
		git(["config", "user.email", "t@t"], main);
		git(["config", "user.name", "t"], main);
		fs.writeFileSync(path.join(main, "seed"), "x");
		git(["add", "."], main);
		git(["commit", "-qm", "init"], main);
		git(["worktree", "add", "-q", wt], main);
		assert.equal(isCrossStore(main, wt), false, "same clone ⇒ one shared store");
	} finally {
		rmrf(main);
		rmrf(wt);
	}
});

// ── incoming pointer round-trip ───────────────────────────────────────────────────

test("write/read/remove incoming pointer", () => {
	const cwd = tmpProject();
	try {
		const store = resolveStore(cwd).root;
		writeIncomingPointer(store, { unit: "alpha", id: "20260805T100000000-aaaa", head: "/x/alpha/handoff.json", store: "/src" });
		const p = readIncoming(store, "alpha");
		assert.equal(p?.id, "20260805T100000000-aaaa");
		assert.equal(p?.store, "/src");
		removeIncoming(store, "alpha");
		assert.equal(readIncoming(store, "alpha"), undefined);
	} finally {
		rmrf(cwd);
	}
});

// ── invariant 5: the full relocation ──────────────────────────────────────────────

test("inv. 5: a cross-store move via incoming — pointer, finish on first write, ancestor reachable", async () => {
	const source = tmpProject();
	const target = tmpProject();
	try {
		const sStore = resolveStore(source).root;
		const tStore = resolveStore(target).root;
		assert.ok(isCrossStore(source, target), "sanity: two different stores");

		// Source has a line; the closing session wants the successor in `target`.
		const r = await writeLink(source, input({ sessionId: "sid-A", unit: "alpha", cwd: source }), {
			now: T1,
			hex: hex("aaaa"),
		});
		// Drop the pointer into the target store (the writer does NOT touch the source line).
		writeIncomingPointer(tStore, {
			unit: "alpha",
			id: r.id,
			head: headPath(sStore, "alpha"),
			store: sStore,
		});
		assert.ok(fs.existsSync(incomingPath(tStore, "alpha")), "pointer is in the target");

		// The successor's first write consumes the pointer and finishes the move.
		const moved = relocateFromIncoming(tStore, "alpha", input({ sessionId: "sid-B", cwd: target }), {
			now: T2,
			hex: hex("bbbb"),
		});
		assert.equal(moved.unit, "alpha");
		assert.equal(moved.seq, 2, "parent.seq + 1");
		assert.deepEqual(moved.link.parent, { id: r.id, unit: "alpha", seq: 1, store: sStore }, "parent.store points at the source");

		// The line now lives in the target store; the pointer is gone.
		assert.ok(fs.existsSync(headPath(tStore, "alpha")), "line present in the target");
		assert.ok(!fs.existsSync(incomingPath(tStore, "alpha")), "pointer consumed");

		// Inv. 5 — the ancestor in the SOURCE store is still reachable via §2.5 cross-store resolution.
		const res = resolveParent(moved.link.parent!, tStore);
		assert.equal(res.kind, "found");
		if (res.kind === "found") {
			assert.equal(res.store, sStore, "resolved inside the source store");
			assert.equal(res.path, headPath(sStore, "alpha"));
		}
	} finally {
		rmrf(source);
		rmrf(target);
	}
});

test("relocateFromIncoming: no pointer ⇒ honest refusal", () => {
	const cwd = tmpProject();
	try {
		assert.throws(
			() => relocateFromIncoming(resolveStore(cwd).root, "ghost", input({ sessionId: "x" })),
			/нет incoming-указателя/,
		);
	} finally {
		rmrf(cwd);
	}
});
