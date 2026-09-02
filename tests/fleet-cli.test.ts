/**
 * Fleet/plain modes in the CLI (П-2/П-3/П-4, issue #15).
 *
 * П-2 are the CONTROL tests — they exist so the fleet work can't turn green
 * "by itself": plain stores, organizational-looking catalogs, and legacy
 * behaviour must be byte-for-byte what it was (DoD 1, 3, 5).
 * П-3/П-4 are the feature: explicit addressing in fleet, the suspicious
 * outcome, printed strictness provenance, and the DoD 8 defect scenario.
 */
import { test } from "node:test";
import * as assert from "node:assert/strict";
import * as cp from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";

import { writeLink, type WriteLinkInput } from "../src/handoff.ts";
import { rmrf, tmpProject } from "./helpers.ts";
import { PROFILES_SUBDIR } from "../src/profiles.ts";

const CLI = path.join(process.cwd(), "src", "cli.ts");
const OLD = new Date(Date.UTC(2026, 7, 20)); // 2026-08-20 — the defect's stale link date
const hex = (s: string) => () => s;

function run(args: string[], opts: { env?: Record<string, string> } = {}): { status: number | null; stdout: string; stderr: string } {
	const r = cp.spawnSync("node", [CLI, ...args], {
		cwd: process.cwd(),
		encoding: "utf-8",
		env: { ...process.env, ...opts.env },
	});
	return { status: r.status, stdout: r.stdout ?? "", stderr: r.stderr ?? "" };
}
function jsonOut(stdout: string): { ok: boolean; data?: any; error?: { code: string; message: string } } {
	return JSON.parse(stdout.trim());
}
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
async function seedLine(cwd: string, o: Partial<WriteLinkInput> = {}): Promise<{ unit: string; id: string }> {
	const r = await writeLink(cwd, input(o), { now: new Date(Date.UTC(2026, 8, 2, 9, 0, 0)), hex: hex("aa01") });
	return { unit: r.unit, id: r.id };
}
function orgCatalog(root: string, name: string, knobs?: Record<string, unknown>, template?: string): void {
	fs.mkdirSync(path.join(root, PROFILES_SUBDIR), { recursive: true });
	if (knobs) fs.writeFileSync(path.join(root, PROFILES_SUBDIR, `${name}.json`), JSON.stringify(knobs));
	if (template) fs.writeFileSync(path.join(root, PROFILES_SUBDIR, `${name}.md`), template);
}

// ── П-2: controls — plain must not change (DoD 1, 3, 5) ───────────────────────

test("П-2/DoD 1+3: a store WITHOUT a profile — unit-less show still returns the single line, code 0", async () => {
	const cwd = tmpProject();
	try {
		await seedLine(cwd);
		const r = run(["show", "--cwd", cwd, "--json"]);
		const env = jsonOut(r.stdout);
		assert.equal(env.ok, true);
		assert.equal(r.status, 0);
		assert.equal(env.data.kind, "head");
		// The strictness block is present and honest: nothing applied, defaults.
		assert.deepEqual(env.data.strictness.requireExplicitUnit, { value: false, from: "default" });
		assert.equal(env.data.strictness.lineProfile, null);
		assert.equal(env.data.strictness.askerProfile, null);
	} finally {
		rmrf(cwd);
	}
});

test("П-2/DoD 5: an organizational-looking catalog does NOT turn plain into anything", async () => {
	const cwd = tmpProject();
	try {
		// The catalog "looks organizational": profiles, fleet template, even a
		// plain override attempt. None of it is a DECLARATION — mode stays plain.
		orgCatalog(cwd, "fleet", { requireExplicitUnit: true, maxAgeDays: 1 }, "# Steps");
		orgCatalog(cwd, "plain", { requireExplicitUnit: true });
		await seedLine(cwd);
		const r = run(["show", "--cwd", cwd, "--json"]);
		const env = jsonOut(r.stdout);
		assert.equal(env.ok, true); // still returns the line — no refusal, no suspicion
		assert.equal(r.status, 0);
		assert.deepEqual(env.data.strictness.requireExplicitUnit, { value: false, from: "default" });
	} finally {
		rmrf(cwd);
	}
});

test("П-2: legacy v1 head + fleet asker — show without --unit does not address the legacy line implicitly", async () => {
	const cwd = tmpProject();
	try {
		fs.mkdirSync(path.join(cwd, ".pi", "session_link"), { recursive: true });
		fs.writeFileSync(
			path.join(cwd, ".pi", "session_link", "handoff.json"),
			JSON.stringify({ schema: "session-link/handoff/v1", createdAt: "2026-06-01T00:00:00.000Z", driver: "pi", sessionRef: "/s", cwd, howToAsk: "h", askCommand: ["pi"] }),
		);
		// requireExplicitUnit guards v2 heads (found.kind === "head"); a legacy
		// head is still returned — plain behaviour, unchanged (control).
		const r = run(["show", "--cwd", cwd, "--json"]);
		assert.equal(jsonOut(r.stdout).ok, true);
		assert.equal(jsonOut(r.stdout).data.kind, "legacy");
	} finally {
		rmrf(cwd);
	}
});

// ── П-3: explicit addressing in fleet ─────────────────────────────────────────

test("П-3/DoD 2: fleet LINE — unit-less show on a single-line store refuses with usage (2)", async () => {
	const cwd = tmpProject();
	try {
		await seedLine(cwd, { profile: "fleet" });
		const r = run(["show", "--cwd", cwd, "--json"]);
		const env = jsonOut(r.stdout);
		assert.equal(env.ok, false);
		assert.equal(r.status, 2);
		assert.equal(env.error!.code, "usage");
		assert.match(env.error!.message, /адресуется явно/);
		assert.match(env.error!.message, /источник: line/); // provenance printed
		assert.equal(env.data.strictness.requireExplicitUnit.from, "line");
	} finally {
		rmrf(cwd);
	}
});

test("П-3/DoD 2: same store, WITH --unit — ok:true", async () => {
	const cwd = tmpProject();
	try {
		const { unit } = await seedLine(cwd, { profile: "fleet" });
		const r = run(["show", "--cwd", cwd, "--unit", unit, "--json"]);
		assert.equal(jsonOut(r.stdout).ok, true);
		assert.equal(r.status, 0);
	} finally {
		rmrf(cwd);
	}
});

test("П-3/DoD 3 (control): the SAME store with profile fleet but asked as plain — refuses too? NO: line profile governs", async () => {
	const cwd = tmpProject();
	try {
		// DoD 3's literal text: the same store with profile plain (or none) returns
		// the line unit-less. Covered above. Here: line=fleet governs even when the
		// asker declares nothing — stricter-of-both via per-knob OR.
		await seedLine(cwd, { profile: "fleet" });
		const r = run(["show", "--cwd", cwd, "--json"]);
		assert.equal(r.status, 2);
	} finally {
		rmrf(cwd);
	}
});

test("П-3: ASKER-declared fleet protects against a foreign PLAIN line (per-knob OR, source=asker)", async () => {
	const cwd = tmpProject();
	try {
		await seedLine(cwd); // plain line, no profile — the 15.08 defect's store
		const r = run(["show", "--cwd", cwd, "--json", "--profile", "fleet"]);
		const env = jsonOut(r.stdout);
		assert.equal(env.ok, false);
		assert.equal(r.status, 2);
		assert.equal(env.error!.code, "usage");
		assert.equal(env.data.strictness.requireExplicitUnit.from, "asker");
	} finally {
		rmrf(cwd);
	}
});

test("П-3: empty --profile means NOT declared — the plain line is served (botched substitution is not a fleet declaration)", async () => {
	const cwd = tmpProject();
	try {
		await seedLine(cwd);
		const r = run(["show", "--cwd", cwd, "--json", "--profile", ""]);
		assert.equal(jsonOut(r.stdout).ok, true);
		assert.equal(r.status, 0);
	} finally {
		rmrf(cwd);
	}
});

test("П-3: SESSION_LINK_PROFILE env works; empty env is not a declaration", async () => {
	const cwd = tmpProject();
	try {
		await seedLine(cwd);
		const viaEnv = run(["show", "--cwd", cwd, "--json"], { env: { SESSION_LINK_PROFILE: "fleet" } });
		assert.equal(viaEnv.status, 2);
		const viaEmpty = run(["show", "--cwd", cwd, "--json"], { env: { SESSION_LINK_PROFILE: "" } });
		assert.equal(viaEmpty.status, 0);
	} finally {
		rmrf(cwd);
	}
});

test("П-3: unknown profile — invalid (4), never a silent plain", async () => {
	const cwd = tmpProject();
	try {
		await seedLine(cwd);
		const r = run(["show", "--cwd", cwd, "--json", "--profile", "ghost"]);
		const env = jsonOut(r.stdout);
		assert.equal(env.ok, false);
		assert.equal(r.status, 4);
		assert.match(env.error!.message, /ghost/);
	} finally {
		rmrf(cwd);
	}
});

// ── П-4: the suspicious outcome ───────────────────────────────────────────────

test("П-4/DoD 4: stale link in fleet — distinct outcome with reason AND threshold, exit 4", async () => {
	const cwd = tmpProject();
	try {
		// The defect's exact shape: a link written 2026-08-20 (OLD), asked 02.09.
		const r = await writeLink(cwd, input({ profile: "fleet", createdAt: OLD.toISOString() }), { now: OLD, hex: hex("bb01") });
		const shown = run(["show", "--cwd", cwd, "--unit", r.unit, "--json"]);
		const env = jsonOut(shown.stdout);
		assert.equal(env.ok, false);
		assert.equal(shown.status, 4); // NOT 1 (not-found), NOT 0 (ok) — distinct
		assert.equal(env.error!.code, "suspicious");
		assert.match(env.error!.message, /линк валиден, но не принят/);
		assert.match(env.error!.message, /порога 7 сут/); // threshold printed
		assert.equal(env.data.suspicious.reason, "stale");
		assert.equal(env.data.suspicious.source, "line");
	} finally {
		rmrf(cwd);
	}
});

test("П-4: fresh fleet link — ok, strictness provenance printed", async () => {
	const cwd = tmpProject();
	try {
		const { unit } = await seedLine(cwd, { profile: "fleet" });
		const r = run(["show", "--cwd", cwd, "--unit", unit, "--json"]);
		const env = jsonOut(r.stdout);
		assert.equal(env.ok, true);
		assert.deepEqual(env.data.strictness.maxAgeDays, { value: 7, from: "line" });
		assert.deepEqual(env.data.strictness.requireExplicitUnit, { value: true, from: "line" });
	} finally {
		rmrf(cwd);
	}
});

test("П-4: driver mismatch via org profile — named reason, valid-but-rejected wording", async () => {
	const cwd = tmpProject();
	try {
		orgCatalog(cwd, "cc-only", { expectedDriver: "claude-code" });
		const { unit } = await seedLine(cwd, { profile: "cc-only" }); // driver: pi
		const r = run(["show", "--cwd", cwd, "--unit", unit, "--json"]);
		const env = jsonOut(r.stdout);
		assert.equal(env.error!.code, "suspicious");
		assert.equal(env.data.suspicious.reason, "driver");
		assert.match(env.error!.message, /«pi» ≠ ожидаемому «claude-code»/);
	} finally {
		rmrf(cwd);
	}
});

test("П-4: threshold is tunable and the APPLIED one is printed (min of line/asker)", async () => {
	const cwd = tmpProject();
	try {
		orgCatalog(cwd, "fresh3", { maxAgeDays: 3 });
		// Line says 3 days (org), asker says fleet (7 days) → min = 3, from "line".
		const { unit } = await seedLine(cwd, { profile: "fresh3" });
		const r = run(["show", "--cwd", cwd, "--unit", unit, "--json", "--profile", "fleet"]);
		const env = jsonOut(r.stdout);
		assert.deepEqual(env.data.strictness.maxAgeDays, { value: 3, from: "line" });
	} finally {
		rmrf(cwd);
	}
});

// ── DoD 8: the observed defect does not reproduce ─────────────────────────────

test("DoD 8: foreign plain line + fleet role — the successor gets NO link, via show AND via go", async () => {
	const cwd = tmpProject();
	try {
		// The store of 15.08: one line, someone else's, plain, two weeks old.
		await writeLink(cwd, input({ goal: "Томограф сессий", sessionId: "sid-foreign" }), { now: OLD, hex: hex("cc01") });

		const shown = run(["show", "--cwd", cwd, "--json", "--profile", "fleet"]);
		assert.equal(shown.status, 2); // not served unit-lessly
		const gone = run(["go", "--cwd", cwd, "--json", "--profile", "fleet", "--dry-run"]);
		assert.equal(gone.status, 2); // no successor started from the foreign link
		assert.match(jsonOut(gone.stdout).error!.message, /адресуется явно/);

		// And addressing the role's OWN (nonexistent) line is an honest not-found,
		// not the foreign link:
		const own = run(["show", "--cwd", cwd, "--unit", "fleet-dashboard", "--json"]);
		assert.equal(own.status, 1);
	} finally {
		rmrf(cwd);
	}
});
