/**
 * writeLink: three write cases (§5.1) + derived (§7.3).
 *   1  — `unit` survives a session/model change (a new link keeps the line name);
 *   2  — two lines in one store don't mix (their own rotation, their own chain);
 *   15 — a session that dies before authoring still leaves `derived` (a DRAFT with facts);
 *   16 — a failed session never closes the line (lineState stays active);
 *   17 — redo-in-place doesn't fork links and doesn't wipe authored body.
 */
import { test } from "node:test";
import * as assert from "node:assert/strict";
import * as cp from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";

import { collectDerived } from "../src/store.ts";
import { writeLink, type WriteLinkInput } from "../src/handoff.ts";
import { archivePath, headPath, resolveStore } from "../src/store.ts";
import type { HandoffV2 } from "../src/types.ts";
import { rmrf, tmpProject } from "./helpers.ts";

const T1 = new Date(Date.UTC(2026, 7, 5, 10, 0, 0));
const T2 = new Date(Date.UTC(2026, 7, 5, 11, 0, 0));

/** A minimal valid WriteLinkInput; `o` overrides/extends. */
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
	const raw = JSON.parse(fs.readFileSync(headPath(store, unit), "utf-8"));
	return raw as HandoffV2;
}

// ── the three cases ─────────────────────────────────────────────────────────────

test("first link: seq=1, technical unit, no parent, derived present (inv. 15)", async () => {
	const cwd = tmpProject();
	try {
		const r = await writeLink(cwd, input({ sessionId: "sid-A" }), { now: T1, hex: () => "aaaa" });
		assert.equal(r.caseName, "first-link");
		assert.equal(r.seq, 1);
		assert.equal(r.unit, "u-20260805-100000-aaaa", "no unit given ⇒ technical name");
		assert.equal(r.id, "20260805T100000000-aaaa");
		assert.equal(r.link.parent, undefined);
		assert.equal(r.link.unitProvisional, true);
		assert.ok(r.link.derived?.endedAt, "derived endedAt is collected even for a fresh link");
	} finally {
		rmrf(cwd);
	}
});

test("new link: advances seq, archives the head, keeps the line name (inv. 1)", async () => {
	const cwd = tmpProject();
	try {
		const store = storeOf(cwd);
		const r1 = await writeLink(cwd, input({ sessionId: "sid-A" }), { now: T1, hex: () => "aaaa" });
		const r2 = await writeLink(cwd, input({ sessionId: "sid-B" }), { now: T2, hex: () => "bbbb" });

		assert.equal(r2.caseName, "new-link");
		assert.equal(r2.seq, 2);
		assert.equal(r2.unit, r1.unit, "the line name survives the session change");
		assert.deepEqual(r2.link.parent, { id: r1.id, unit: r1.unit, seq: 1 });
		assert.ok(fs.existsSync(archivePath(store, r1.unit, r1.id)), "the old head was archived");
		assert.equal(readHead(store, r2.unit).sessionId, "sid-B");
	} finally {
		rmrf(cwd);
	}
});

test("redo-in-place: no archive, seq unchanged, id stable (inv. 17)", async () => {
	const cwd = tmpProject();
	try {
		const store = storeOf(cwd);
		const r1 = await writeLink(cwd, input({ sessionId: "sid-A", summary: "first" }), { now: T1, hex: () => "aaaa" });
		const r2 = await writeLink(cwd, input({ sessionId: "sid-A", summary: "second" }), { now: T2, hex: () => "bbbb" });

		assert.equal(r2.caseName, "redo-in-place");
		assert.equal(r2.seq, 1, "seq does not grow on redo");
		assert.equal(r2.id, r1.id, "id is stable");
		assert.ok(!fs.existsSync(archivePath(store, r1.unit, r1.id)), "redo creates no archive");
		assert.equal(readHead(store, r1.unit).summary, "second", "the new value wins when provided");
	} finally {
		rmrf(cwd);
	}
});

test("inv. 17: a failed authoring pass keeps the previous good body (merge forward)", async () => {
	const cwd = tmpProject();
	try {
		await writeLink(cwd, input({ sessionId: "sid-A", summary: "good summary", nextStep: "old next" }), {
			now: T1,
			hex: () => "aaaa",
		});
		// Redo with an EMPTY summary (a crash mid-authoring) but a new nextStep.
		const r2 = await writeLink(
			cwd,
			input({ sessionId: "sid-A", summary: undefined, nextStep: "new next" }),
			{ now: T2, hex: () => "bbbb" },
		);
		assert.equal(r2.link.summary, "good summary", "summary survived the empty redo");
		assert.equal(r2.link.nextStep, "new next", "the provided field still updates");
	} finally {
		rmrf(cwd);
	}
});

// ── line isolation ───────────────────────────────────────────────────────────────

test("inv. 2: two named lines keep separate rotations and chains", async () => {
	const cwd = tmpProject();
	try {
		const store = storeOf(cwd);
		const rA = await writeLink(cwd, input({ sessionId: "sid-A" }), { now: T1, hex: () => "aaaa" }); // technical unit
		const rB = await writeLink(cwd, input({ sessionId: "sid-B", unit: "beta" }), { now: T2, hex: () => "bbbb" });

		assert.notEqual(rA.unit, rB.unit);
		assert.ok(fs.existsSync(headPath(store, rA.unit)));
		assert.ok(fs.existsSync(headPath(store, "beta")));

		// Advance A independently (name it explicitly — with 2 active lines the default is ambiguous).
		const rA2 = await writeLink(cwd, input({ sessionId: "sid-A2", unit: rA.unit }), { now: T2, hex: () => "cccc" });
		assert.equal(rA2.unit, rA.unit);
		assert.equal(readHead(store, "beta").id, rB.id, "beta untouched by A's advance");
	} finally {
		rmrf(cwd);
	}
});

test("inv. 16: a link with blockers keeps the line active", async () => {
	const cwd = tmpProject();
	try {
		const r = await writeLink(
			cwd,
			input({ sessionId: "sid-A", goal: undefined, summary: undefined, nextStep: undefined, blockers: ["stuck"] }),
			{ now: T1, hex: () => "aaaa" },
		);
		assert.ok(!r.link.lineState || r.link.lineState === "active", "a failed session never closes the line");
	} finally {
		rmrf(cwd);
	}
});

test("writeLink: N>1 active lines with no unit ⇒ refuses (doesn't pick for the operator)", async () => {
	const cwd = tmpProject();
	try {
		await writeLink(cwd, input({ sessionId: "sid-A", unit: "a" }), { now: T1, hex: () => "aaaa" });
		await writeLink(cwd, input({ sessionId: "sid-B", unit: "b" }), { now: T2, hex: () => "bbbb" });
		await assert.rejects(
			writeLink(cwd, input({ sessionId: "sid-C" }), { now: T2, hex: () => "cccc" }),
			/несколько активных линий/,
		);
	} finally {
		rmrf(cwd);
	}
});

// ── migration integration ─────────────────────────────────────────────────────────

test("writeLink migrates a legacy v1 head, then advances it as a new link", async () => {
	const cwd = tmpProject();
	try {
		const store = storeOf(cwd);
		const legacyDir = path.join(cwd, ".pi", "session_link");
		fs.mkdirSync(legacyDir, { recursive: true });
		fs.writeFileSync(
			path.join(legacyDir, "handoff.json"),
			JSON.stringify({
				schema: "session-link/handoff/v1",
				createdAt: "2026-07-01T09:00:00.000Z",
				driver: "pi",
				sessionRef: "/s",
				sessionId: "sid-V1",
				cwd: cwd,
				howToAsk: "pi",
				askCommand: ["pi"],
				goal: "legacy goal",
				summary: "legacy work",
				nextStep: "carry on",
			}),
		);

		const r = await writeLink(cwd, input({ sessionId: "sid-NEW", cwd }), { now: T1, hex: () => "aaaa" });
		assert.equal(r.caseName, "new-link", "migrated head is seq=1, this write is seq=2");
		assert.equal(r.seq, 2);
		assert.ok(r.link.parent, "new link parents the migrated head");
		assert.ok(!fs.existsSync(path.join(legacyDir, "handoff.json")), "legacy head moved away");
		assert.ok(fs.existsSync(path.join(legacyDir, "MOVED-TO.txt")), "MOVED-TO marker left");
		assert.ok(fs.existsSync(archivePath(store, r.unit, r.link.parent!.id)), "migrated head archived");
	} finally {
		rmrf(cwd);
	}
});

// ── collectDerived (§7.3) ──────────────────────────────────────────────────────

test("collectDerived: without baseRef ⇒ no commits/filesChanged", () => {
	const cwd = tmpProject();
	try {
		const d = collectDerived(cwd);
		assert.ok(d.endedAt);
		assert.equal(d.commits, undefined);
		assert.equal(d.filesChanged, undefined);
		assert.equal(d.baseRef, undefined);
	} finally {
		rmrf(cwd);
	}
});

function git(args: string[], cwd: string): string {
	const r = cp.spawnSync("git", args, { cwd, encoding: "utf-8" });
	if (r.status !== 0) throw new Error(`git ${args.join(" ")}: ${(r.stderr || "").trim()}`);
	return r.stdout;
}
function gitInit(dir: string): void {
	git(["init", "-q"], dir);
	git(["config", "user.email", "test@example.test"], dir);
	git(["config", "user.name", "Test"], dir);
	fs.writeFileSync(path.join(dir, "seed.txt"), "x");
	git(["add", "."], dir);
	git(["commit", "-q", "-m", "init"], dir);
}

test("collectDerived: with baseRef in a repo ⇒ commits + filesChanged filled", () => {
	const repo = tmpProject();
	try {
		gitInit(repo);
		const base = git(["rev-parse", "HEAD"], repo).trim();
		fs.writeFileSync(path.join(repo, "f.txt"), "change");
		git(["add", "."], repo);
		git(["commit", "-qm", "c2"], repo);
		fs.writeFileSync(path.join(repo, "dirty.txt"), "uncommitted"); // working-tree-only

		const d = collectDerived(repo, base);
		assert.equal(d.baseRef, base);
		assert.ok(d.branch, "branch collected");
		assert.equal(d.commits?.length, 1, "one commit since base");
		assert.ok(d.filesChanged?.includes("f.txt"), "committed change listed");
		assert.ok(d.filesChanged?.includes("dirty.txt"), "uncommitted working-tree file also listed");
	} finally {
		rmrf(repo);
	}
});
