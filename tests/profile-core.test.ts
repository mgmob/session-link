/**
 * Profile field in the core (П-0, issue #15): an optional envelope field that is
 * a property of the LINE — written explicitly or inherited along the chain,
 * never derived from the environment. Absent ⇔ plain; "plain" normalizes to
 * absence; a downgrade (anything → plain) is reported so it can't pass silently.
 */
import { test } from "node:test";
import * as assert from "node:assert/strict";
import * as fs from "node:fs";

import {
	rebuildIndex,
	readIndex,
	renameLine,
	writeLink,
	envelopeProblems,
	type WriteLinkInput,
} from "../src/handoff.ts";
import { resolveStore } from "../src/store.ts";
import { rmrf, tmpProject } from "./helpers.ts";

const T1 = new Date(Date.UTC(2026, 8, 2, 10, 0, 0));
const T2 = new Date(Date.UTC(2026, 8, 2, 11, 0, 0));
const hex = (s: string) => () => s;

function input(o: Partial<WriteLinkInput> = {}): WriteLinkInput {
	return {
		createdAt: "2026-09-02T10:00:00.000Z",
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

test("first link: explicit profile is stored, mirrored in the index, shown in .md", async () => {
	const cwd = tmpProject();
	try {
		const r = await writeLink(cwd, input({ profile: "fleet" }), { now: T1, hex: hex("aa01") });
		assert.equal(r.link.profile, "fleet");
		assert.equal(r.profileChange, undefined); // first link — nothing to change

		const store = resolveStore(cwd).root;
		const head = JSON.parse(fs.readFileSync(r.path, "utf-8"));
		assert.equal(head.profile, "fleet");

		const idx = readIndex(store)!;
		assert.equal(idx.units[r.unit].profile, "fleet");

		const md = fs.readFileSync(store + "/" + r.unit + "/handoff.md", "utf-8");
		assert.match(md, /- Profile: `fleet`/);
	} finally {
		rmrf(cwd);
	}
});

test("profile is inherited along the line like unit", async () => {
	const cwd = tmpProject();
	try {
		await writeLink(cwd, input({ profile: "fleet" }), { now: T1, hex: hex("aa01") });
		const r2 = await writeLink(cwd, input({ sessionId: "sid-B" }), { now: T2, hex: hex("aa02") });
		assert.equal(r2.caseName, "new-link");
		assert.equal(r2.link.profile, "fleet"); // no explicit profile → inherited
		assert.equal(r2.profileChange, undefined); // unchanged
	} finally {
		rmrf(cwd);
	}
});

test("explicit profile on a later write overrides and is reported as a change", async () => {
	const cwd = tmpProject();
	try {
		await writeLink(cwd, input({ profile: "fleet" }), { now: T1, hex: hex("aa01") });
		const r2 = await writeLink(cwd, input({ sessionId: "sid-B", profile: "org-x" }), { now: T2, hex: hex("aa02") });
		assert.equal(r2.link.profile, "org-x");
		assert.deepEqual(r2.profileChange, { from: "fleet", to: "org-x", downgraded: false });
	} finally {
		rmrf(cwd);
	}
});

test("downgrade to plain is reported: field removed, downgraded:true", async () => {
	const cwd = tmpProject();
	try {
		await writeLink(cwd, input({ profile: "fleet" }), { now: T1, hex: hex("aa01") });
		// Explicit "plain" normalizes to absence — absent ⇔ plain.
		const r2 = await writeLink(cwd, input({ sessionId: "sid-B", profile: "plain" }), { now: T2, hex: hex("aa02") });
		assert.equal("profile" in r2.link, false);
		assert.deepEqual(r2.profileChange, { from: "fleet", to: null, downgraded: true });

		const idx = readIndex(resolveStore(cwd).root)!;
		assert.equal("profile" in idx.units[r2.unit], false);
	} finally {
		rmrf(cwd);
	}
});

test("a bad profile name is rejected before anything hits the disk", async () => {
	const cwd = tmpProject();
	try {
		await assert.rejects(() => writeLink(cwd, input({ profile: "Fleet" })), /profile "Fleet" недопустим/);
		await assert.rejects(() => writeLink(cwd, input({ profile: "флот" })), /недопустим/);
		const store = resolveStore(cwd).root;
		// The lock dir may exist; NO line data must: no unit dirs, no index, no head.
		const leftovers = fs.existsSync(store) ? fs.readdirSync(store).filter((f) => f !== ".lock") : [];
		assert.deepEqual(leftovers, []); // nothing written
	} finally {
		rmrf(cwd);
	}
});

test("envelope contract: a stored link with a bad profile is unreadable (one contract, issue #99)", async () => {
	const problems = envelopeProblems({
		schema: "session-link/handoff/v2",
		createdAt: "x",
		driver: "pi",
		sessionRef: "/s",
		cwd: "/p",
		howToAsk: "h",
		askCommand: ["pi"],
		id: "20260902T100000000-aa01",
		unit: "u",
		seq: 1,
		profile: "Bad_Name",
	});
	assert.ok(problems.some((p) => p.startsWith("profile")));
});

test("old stores keep working: no profile field anywhere, byte-identical rebuild", async () => {
	const cwd = tmpProject();
	try {
		const r = await writeLink(cwd, input(), { now: T1, hex: hex("aa01") });
		assert.equal("profile" in r.link, false);
		const store = resolveStore(cwd).root;
		const before = fs.readFileSync(store + "/index.json", "utf-8");
		rebuildIndex(store);
		const after = fs.readFileSync(store + "/index.json", "utf-8");
		assert.equal(after, before); // byte-for-byte, no profile key appears
	} finally {
		rmrf(cwd);
	}
});

test("rebuild reproduces the profile mirror byte-for-byte", async () => {
	const cwd = tmpProject();
	try {
		const r = await writeLink(cwd, input({ profile: "fleet" }), { now: T1, hex: hex("aa01") });
		const store = resolveStore(cwd).root;
		const before = fs.readFileSync(store + "/index.json", "utf-8");
		const idx = rebuildIndex(store);
		const after = fs.readFileSync(store + "/index.json", "utf-8");
		assert.equal(after, before);
		assert.equal(idx.units[r.unit].profile, "fleet");
	} finally {
		rmrf(cwd);
	}
});

test("fork inherits the ancestor line's profile; explicit --profile overrides", async () => {
	const cwd = tmpProject();
	try {
		const { forkLine } = await import("../src/handoff.ts");
		const r1 = await writeLink(cwd, input({ profile: "fleet" }), { now: T1, hex: hex("aa01") });
		const f = forkLine(resolveStore(cwd).root, { id: r1.id, unit: r1.unit, seq: 1 }, input({ sessionId: "sid-B" }), {
			now: T2,
			hex: hex("aa02"),
		});
		assert.equal(f.link.profile, "fleet");

		const f2 = forkLine(resolveStore(cwd).root, { id: r1.id, unit: r1.unit, seq: 1 }, input({ sessionId: "sid-C", profile: "org-y" }), {
			now: T2,
			hex: hex("aa03"),
		});
		assert.equal(f2.link.profile, "org-y");
	} finally {
		rmrf(cwd);
	}
});

test("rename keeps the profile; --profile on rename may change it", async () => {
	const cwd = tmpProject();
	try {
		const r = await writeLink(cwd, input({ profile: "fleet" }), { now: T1, hex: hex("aa01") });
		const store = resolveStore(cwd).root;

		renameLine(store, r.unit, "renamed");
		let head = JSON.parse(fs.readFileSync(store + "/renamed/handoff.json", "utf-8"));
		assert.equal(head.profile, "fleet"); // kept through the rename

		renameLine(store, "renamed", "renamed2", { profile: "org-z" });
		head = JSON.parse(fs.readFileSync(store + "/renamed2/handoff.json", "utf-8"));
		assert.equal(head.profile, "org-z");

		renameLine(store, "renamed2", "renamed3", { profile: "plain" });
		head = JSON.parse(fs.readFileSync(store + "/renamed3/handoff.json", "utf-8"));
		assert.equal("profile" in head, false); // plain normalizes away
	} finally {
		rmrf(cwd);
	}
});
