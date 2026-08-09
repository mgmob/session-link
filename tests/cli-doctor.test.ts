/**
 * CLI doctor + index rebuild (К-3). doctor is read-only (report / --validate);
 * --rebuild and `index rebuild` write, under the lock.
 */
import { test } from "node:test";
import * as assert from "node:assert/strict";
import * as cp from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";

import { writeLink, type WriteLinkInput } from "../src/handoff.ts";
import { indexPath, resolveStore } from "../src/store.ts";
import { rmrf, tmpProject } from "./helpers.ts";

const CLI = path.join(process.cwd(), "src", "cli.ts");
const T1 = new Date(Date.UTC(2026, 7, 9, 10, 0, 0));
const hex = (s: string) => () => s;

function run(args: string[]): { status: number | null; stdout: string } {
	const r = cp.spawnSync("node", [CLI, ...args], { cwd: process.cwd(), encoding: "utf-8" });
	return { status: r.status, stdout: r.stdout ?? "" };
}
function jsonOut(stdout: string) {
	return JSON.parse(stdout.trim()) as { ok: boolean; data?: { problems?: { kind: string }[] }; error?: { code: string } };
}
function input(o: Partial<WriteLinkInput> = {}): WriteLinkInput {
	return {
		createdAt: "2026-08-09T10:00:00.000Z",
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

test("doctor: clean store → empty problems, exit 0", async () => {
	const cwd = tmpProject();
	try {
		await writeLink(cwd, input({ sessionId: "sid-A", unit: "alpha", cwd }), { now: T1, hex: hex("aaaa") });
		const r = run(["doctor", "--cwd", cwd, "--json"]);
		const env = jsonOut(r.stdout);
		assert.equal(r.status, 0);
		assert.equal(env.ok, true);
		assert.equal(env.data!.problems!.length, 0);
	} finally {
		rmrf(cwd);
	}
});

test("doctor: a broken parent link shows up in the report (still exit 0 — it's a report)", async () => {
	const cwd = tmpProject();
	try {
		await writeLink(cwd, input({ sessionId: "sid-A", unit: "alpha", cwd }), { now: T1, hex: hex("aaaa") });
		const store = resolveStore(cwd).root;
		const headPath = path.join(store, "alpha", "handoff.json");
		const obj = JSON.parse(fs.readFileSync(headPath, "utf-8"));
		obj.parent = { id: "20260101T000000000-dead", unit: "alpha", seq: 0 };
		fs.writeFileSync(headPath, JSON.stringify(obj));
		const r = run(["doctor", "--cwd", cwd, "--json"]);
		assert.equal(r.status, 0, "report is not a failure");
		assert.ok(jsonOut(r.stdout).data!.problems!.some((p) => p.kind === "broken-parent"));
	} finally {
		rmrf(cwd);
	}
});

test("doctor --validate: clean → exit 0; a v2 file missing unit → exit 4", async () => {
	const cwd = tmpProject();
	try {
		await writeLink(cwd, input({ sessionId: "sid-A", unit: "alpha", cwd }), { now: T1, hex: hex("aaaa") });
		assert.equal(run(["doctor", "--validate", "--cwd", cwd, "--json"]).status, 0);

		const headPath = path.join(resolveStore(cwd).root, "alpha", "handoff.json");
		const obj = JSON.parse(fs.readFileSync(headPath, "utf-8"));
		delete obj.unit;
		fs.writeFileSync(headPath, JSON.stringify(obj));
		const r = run(["doctor", "--validate", "--cwd", cwd, "--json"]);
		assert.equal(r.status, 4);
		assert.equal(jsonOut(r.stdout).error!.code, "invalid");
	} finally {
		rmrf(cwd);
	}
});

test("doctor --rebuild and `index rebuild` both rebuild under the lock, idempotently", async () => {
	const cwd = tmpProject();
	try {
		await writeLink(cwd, input({ sessionId: "sid-A", unit: "alpha", cwd }), { now: T1, hex: hex("aaaa") });
		const store = resolveStore(cwd).root;

		const r1 = run(["doctor", "--rebuild", "--cwd", cwd, "--json"]);
		assert.equal(r1.status, 0);
		assert.equal(jsonOut(r1.stdout).ok, true);

		const before = fs.readFileSync(indexPath(store), "utf-8");
		// Corrupt the index; `index rebuild` must restore it byte-for-byte.
		fs.writeFileSync(indexPath(store), JSON.stringify({ schema: "session-link/index/v1", units: {} }));
		const r2 = run(["index", "rebuild", "--cwd", cwd, "--json"]);
		assert.equal(r2.status, 0);
		const after = fs.readFileSync(indexPath(store), "utf-8");
		assert.equal(after, before, "rebuild restores the canonical index byte-for-byte");
	} finally {
		rmrf(cwd);
	}
});

test("index with no subcommand → usage error (exit 2)", () => {
	const cwd = tmpProject();
	try {
		const r = run(["index", "--cwd", cwd, "--json"]);
		assert.equal(r.status, 2);
	} finally {
		rmrf(cwd);
	}
});
