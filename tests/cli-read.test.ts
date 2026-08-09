/**
 * CLI read commands (К-2): store, show, parent, ancestors, graph.
 * Read-only — none take the lock; they work while a writer holds it (asserted for one).
 */
import { test } from "node:test";
import * as assert from "node:assert/strict";
import * as cp from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";

import { writeLink, type WriteLinkInput } from "../src/handoff.ts";
import { resolveStore } from "../src/store.ts";
import { rmrf, tmpProject } from "./helpers.ts";

const CLI = path.join(process.cwd(), "src", "cli.ts");
const T1 = new Date(Date.UTC(2026, 7, 9, 10, 0, 0));
const T2 = new Date(Date.UTC(2026, 7, 9, 11, 0, 0));
const hex = (s: string) => () => s;

function run(args: string[]): { status: number | null; stdout: string } {
	const r = cp.spawnSync("node", [CLI, ...args], { cwd: process.cwd(), encoding: "utf-8" });
	return { status: r.status, stdout: r.stdout ?? "" };
}
function jsonOut(stdout: string): { ok: boolean; data?: unknown; error?: { code: string } } {
	return JSON.parse(stdout.trim());
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

// ── store ────────────────────────────────────────────────────────────────────────

test("store: non-git cwd → fallback store, viaGit:false", () => {
	const cwd = tmpProject();
	try {
		const r = run(["store", "--cwd", cwd, "--json"]);
		const env = jsonOut(r.stdout);
		assert.equal(env.ok, true);
		assert.deepEqual((env.data as { root: string; viaGit: boolean }).root, resolveStore(cwd).root);
		assert.equal((env.data as { viaGit: boolean }).viaGit, false);
	} finally {
		rmrf(cwd);
	}
});

test("store: git repo → repo-scoped store, viaGit:true", () => {
	const cwd = tmpProject();
	try {
		cp.spawnSync("git", ["init", "-q"], { cwd, encoding: "utf-8" });
		const r = run(["store", "--cwd", cwd, "--json"]);
		const env = jsonOut(r.stdout);
		assert.equal((env.data as { viaGit: boolean }).viaGit, true);
		assert.ok((env.data as { root: string }).root.includes(path.join(".git", ".pi", "session_link")));
	} finally {
		rmrf(cwd);
	}
});

// ── show ─────────────────────────────────────────────────────────────────────────

test("show: a line written via the core is shown by the CLI", async () => {
	const cwd = tmpProject();
	try {
		await writeLink(cwd, input({ sessionId: "sid-A", unit: "alpha", cwd }), { now: T1, hex: hex("aaaa") });
		const r = run(["show", "--cwd", cwd, "--json"]);
		const env = jsonOut(r.stdout);
		assert.equal(env.ok, true);
		const link = (env.data as { link: { unit: string; seq: number; schema: string } }).link;
		assert.equal(link.unit, "alpha");
		assert.equal(link.schema, "session-link/handoff/v2");
	} finally {
		rmrf(cwd);
	}
});

test("show: nothing in the store → exit 1 (not-found)", () => {
	const cwd = tmpProject();
	try {
		const r = run(["show", "--cwd", cwd, "--json"]);
		assert.equal(r.status, 1);
		assert.equal(jsonOut(r.stdout).error!.code, "not-found");
	} finally {
		rmrf(cwd);
	}
});

// ── parent ───────────────────────────────────────────────────────────────────────

test("parent: resolves the head's parent reference", async () => {
	const cwd = tmpProject();
	try {
		const a = await writeLink(cwd, input({ sessionId: "sid-A", unit: "alpha", cwd }), { now: T1, hex: hex("aaaa") });
		await writeLink(cwd, input({ sessionId: "sid-B", unit: "alpha", cwd }), { now: T2, hex: hex("bbbb") });
		const r = run(["parent", "--cwd", cwd, "--json"]);
		const env = jsonOut(r.stdout);
		assert.equal(env.ok, true);
		assert.equal((env.data as { via: string }).via, "direct");
		assert.ok((env.data as { path: string }).path.includes(a.id), "path points at the archived parent");
	} finally {
		rmrf(cwd);
	}
});

test("parent: a first link has no parent → exit 1", async () => {
	const cwd = tmpProject();
	try {
		await writeLink(cwd, input({ sessionId: "sid-A", unit: "alpha", cwd }), { now: T1, hex: hex("aaaa") });
		const r = run(["parent", "--cwd", cwd, "--json"]);
		assert.equal(r.status, 1);
	} finally {
		rmrf(cwd);
	}
});

// ── ancestors ─────────────────────────────────────────────────────────────────────

test("ancestors: walks the chain", async () => {
	const cwd = tmpProject();
	try {
		await writeLink(cwd, input({ sessionId: "sid-A", unit: "alpha", cwd }), { now: T1, hex: hex("aaaa") });
		await writeLink(cwd, input({ sessionId: "sid-B", unit: "alpha", cwd }), { now: T2, hex: hex("bbbb") });
		const r = run(["ancestors", "--cwd", cwd, "--json"]);
		const env = jsonOut(r.stdout);
		assert.equal(env.ok, true);
		assert.equal((env.data as { links: unknown[] }).links.length, 1);
	} finally {
		rmrf(cwd);
	}
});

test("ancestors: no line → empty list, exit 0 (not an error)", () => {
	const cwd = tmpProject();
	try {
		const r = run(["ancestors", "--cwd", cwd, "--json"]);
		assert.equal(r.status, 0);
		assert.equal((jsonOut(r.stdout).data as { links: unknown[] }).links.length, 0);
	} finally {
		rmrf(cwd);
	}
});

// ── graph ─────────────────────────────────────────────────────────────────────────

test("graph: emits Mermaid", async () => {
	const cwd = tmpProject();
	try {
		await writeLink(cwd, input({ sessionId: "sid-A", unit: "alpha", cwd }), { now: T1, hex: hex("aaaa") });
		const r = run(["graph", "--cwd", cwd, "--json"]);
		const env = jsonOut(r.stdout);
		assert.equal(env.ok, true);
		assert.match((env.data as { mermaid: string }).mermaid, /^graph TD/);
	} finally {
		rmrf(cwd);
	}
});

// ── read works while the store is locked ─────────────────────────────────────────

test("read does not take the lock: show works with a live .lock present", async () => {
	const cwd = tmpProject();
	try {
		await writeLink(cwd, input({ sessionId: "sid-A", unit: "alpha", cwd }), { now: T1, hex: hex("aaaa") });
		// Plant a lock file as if a writer holds it (with a live pid = ours, current start).
		fs.writeFileSync(
			path.join(resolveStore(cwd).root, ".lock"),
			JSON.stringify({ pid: process.pid, startedAt: Date.now() - Math.floor(process.uptime() * 1000), acquiredAt: Date.now() }),
		);
		const r = run(["show", "--cwd", cwd, "--json"]);
		assert.equal(r.status, 0, "show reads fine despite the lock");
	} finally {
		rmrf(cwd);
	}
});
