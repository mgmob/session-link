/**
 * CLI incoming (К-5): cross-store relocation pointers — list / read / set /
 * relocate / remove. `set`+`relocate` together finish a cross-store move.
 */
import { test } from "node:test";
import * as assert from "node:assert/strict";
import * as cp from "node:child_process";
import * as path from "node:path";

import { writeLink, type WriteLinkInput } from "../src/handoff.ts";
import { incomingPath, resolveStore } from "../src/store.ts";
import { rmrf, tmpProject } from "./helpers.ts";

const CLI = path.join(process.cwd(), "src", "cli.ts");
const T1 = new Date(Date.UTC(2026, 7, 9, 10, 0, 0));
const hex = (s: string) => () => s;

function run(args: string[], opts: { input?: string } = {}): { status: number | null; stdout: string; stderr: string } {
	const r = cp.spawnSync("node", [CLI, ...args], { cwd: process.cwd(), encoding: "utf-8", input: opts.input });
	return { status: r.status, stdout: r.stdout ?? "", stderr: r.stderr ?? "" };
}
function jsonOut(stdout: string) {
	return JSON.parse(stdout.trim()) as { ok: boolean; data?: Record<string, unknown>; error?: { code: string } };
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

test("incoming list: empty when there are no pointers", () => {
	const cwd = tmpProject();
	try {
		const r = run(["incoming", "--cwd", cwd, "--json"]);
		assert.equal(r.status, 0);
		assert.deepEqual(jsonOut(r.stdout).data!.pointers, []);
	} finally {
		rmrf(cwd);
	}
});

test("incoming set + read round-trip", () => {
	const cwd = tmpProject();
	try {
		const store = resolveStore(cwd).root;
		const r = run([
			"incoming", "set", "--cwd", cwd, "--json",
			"--unit", "alpha",
			"--id", "20260809T100000000-aaaa",
			"--head", "/source/store/alpha/handoff.json",
			"--store", "/source/store",
		]);
		assert.equal(r.status, 0);

		const read = jsonOut(run(["incoming", "read", "--unit", "alpha", "--cwd", cwd, "--json"]).stdout);
		assert.equal(read.ok, true);
		assert.equal((read.data!.pointer as { id: string }).id, "20260809T100000000-aaaa");
		assert.equal((read.data!.pointer as { store: string }).store, "/source/store");

		const list = jsonOut(run(["incoming", "--cwd", cwd, "--json"]).stdout);
		assert.equal((list.data!.pointers as unknown[]).length, 1);
		void store;
	} finally {
		rmrf(cwd);
	}
});

test("incoming read: no such pointer → exit 1", () => {
	const cwd = tmpProject();
	try {
		const r = run(["incoming", "read", "--unit", "ghost", "--cwd", cwd, "--json"]);
		assert.equal(r.status, 1);
	} finally {
		rmrf(cwd);
	}
});

test("incoming set + relocate finishes a cross-store move; pointer is consumed", async () => {
	const source = tmpProject();
	const target = tmpProject();
	try {
		// A real v2 head in the source — relocate reads it via ptr.head.
		const head = await writeLink(source, input({ sessionId: "sid-A", unit: "alpha", cwd: source }), { now: T1, hex: hex("aaaa") });
		const sStore = resolveStore(source).root;
		const tStore = resolveStore(target).root;

		const set = run([
			"incoming", "set", "--cwd", target, "--json",
			"--unit", "alpha", "--id", head.id, "--head", head.path, "--store", sStore,
		]);
		assert.equal(set.status, 0);
		// relocate requires the relocating platform's identity on stdin.
		const relocInput = JSON.stringify({ driver: "pi", sessionRef: "/cli", sessionId: "cli-relocate", howToAsk: "pi", askCommand: ["pi"] });
		const rel = run(["incoming", "relocate", "--unit", "alpha", "--cwd", target, "--json"], { input: relocInput });
		assert.equal(rel.status, 0);
		assert.equal(jsonOut(rel.stdout).data!.relocated, true);

		// Pointer consumed, line now lives in the target.
		void tStore;
		const list = jsonOut(run(["incoming", "--cwd", target, "--json"]).stdout);
		assert.deepEqual(list.data!.pointers, []);
		const show = jsonOut(run(["show", "--unit", "alpha", "--cwd", target, "--json"]).stdout);
		assert.equal(show.ok, true);
	} finally {
		rmrf(source);
		rmrf(target);
	}
});

test("incoming remove: drops the pointer", () => {
	const cwd = tmpProject();
	try {
		run([
			"incoming", "set", "--cwd", cwd, "--json",
			"--unit", "alpha", "--id", "X", "--head", "/h", "--store", "/s",
		]);
		const r = run(["incoming", "remove", "--unit", "alpha", "--cwd", cwd, "--json"]);
		assert.equal(r.status, 0);
		assert.equal(jsonOut(r.stdout).data!.removed, true);
		const list = jsonOut(run(["incoming", "--cwd", cwd, "--json"]).stdout);
		assert.deepEqual(list.data!.pointers, []);
	} finally {
		rmrf(cwd);
	}
});
