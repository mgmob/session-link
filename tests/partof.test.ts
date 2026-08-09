/**
 * partOf edge (К-0; decomposition axis). Separate from `parent` (ancestor-in-time):
 * round-trips through a write, renders as a second edge type, and is NOT followed
 * by the ancestor walk.
 */
import { test } from "node:test";
import * as assert from "node:assert/strict";
import * as fs from "node:fs";

import { readHandoff, writeLink, type WriteLinkInput } from "../src/handoff.ts";
import { renderGraph } from "../src/graph.ts";
import { walkAncestors } from "../src/parent.ts";
import { headPath, resolveStore } from "../src/store.ts";
import type { HandoffV2 } from "../src/types.ts";
import { rmrf, tmpProject } from "./helpers.ts";

const T1 = new Date(Date.UTC(2026, 7, 9, 10, 0, 0));
const T2 = new Date(Date.UTC(2026, 7, 9, 11, 0, 0));
const hex = (s: string) => () => s;
const TASK = { id: "20260101T000000000-task", unit: "parent-task" };

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
function storeOf(cwd: string): string {
	return resolveStore(cwd).root;
}
function readHead(store: string, unit: string): HandoffV2 {
	return JSON.parse(fs.readFileSync(headPath(store, unit), "utf-8")) as HandoffV2;
}

test("partOf: round-trips through a write", async () => {
	const cwd = tmpProject();
	try {
		await writeLink(cwd, input({ sessionId: "sid-A", unit: "alpha", partOf: TASK }), { now: T1, hex: hex("aaaa") });
		const h = readHead(storeOf(cwd), "alpha");
		assert.deepEqual(h.partOf, TASK, "partOf survives the write");
	} finally {
		rmrf(cwd);
	}
});

test("partOf: absent by default (the edge is opt-in)", async () => {
	const cwd = tmpProject();
	try {
		await writeLink(cwd, input({ sessionId: "sid-A", unit: "alpha" }), { now: T1, hex: hex("aaaa") });
		assert.equal(readHead(storeOf(cwd), "alpha").partOf, undefined);
	} finally {
		rmrf(cwd);
	}
});

test("partOf: renderGraph draws both edges (parent --> and partOf -. part-of .->)", async () => {
	const cwd = tmpProject();
	try {
		// A 2-link line; the head has BOTH a parent (seq1) and a partOf (decomposition).
		await writeLink(cwd, input({ sessionId: "sid-A", unit: "alpha", partOf: TASK }), { now: T1, hex: hex("aaaa") });
		await writeLink(cwd, input({ sessionId: "sid-B", unit: "alpha", partOf: TASK }), { now: T2, hex: hex("bbbb") });
		const g = renderGraph(storeOf(cwd));
		assert.match(g, /-->/, "parent (ancestor-in-time) edge present");
		assert.match(g, /-\. part-of \.->/, "partOf (decomposition) edge present, distinct style");
	} finally {
		rmrf(cwd);
	}
});

test("partOf: the ancestor walk does NOT follow it (separate axis)", async () => {
	const cwd = tmpProject();
	try {
		const store = storeOf(cwd);
		// First link: no parent, but a partOf. walkAncestors must return nothing.
		await writeLink(cwd, input({ sessionId: "sid-A", unit: "alpha", partOf: TASK }), { now: T1, hex: hex("aaaa") });
		const head = readHandoff(headPath(store, "alpha"));
		if (!head) assert.fail("head should parse");
		const ancestors = walkAncestors(head, store);
		assert.equal(ancestors.length, 0, "partOf is not an ancestor — walk ignores it");
	} finally {
		rmrf(cwd);
	}
});

test("partOf: toMarkdown surfaces it", async () => {
	const cwd = tmpProject();
	try {
		const store = storeOf(cwd);
		await writeLink(cwd, input({ sessionId: "sid-A", unit: "alpha", partOf: TASK }), { now: T1, hex: hex("aaaa") });
		const md = fs.readFileSync(headPath(store, "alpha").replace(/handoff\.json$/, "handoff.md"), "utf-8");
		assert.ok(md.includes("Part of:"), "projection shows the partOf edge");
		assert.ok(md.includes(TASK.id));
	} finally {
		rmrf(cwd);
	}
});
