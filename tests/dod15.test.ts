/**
 * Issue #15 acceptance sweep (П-6). Each DoD criterion by number, one test per
 * item; where a criterion is fully covered by a dedicated file, the test here
 * re-asserts its load-bearing half and points there. Criteria 3 and 5 are the
 * CONTROLS — they exist so the others can't turn green "by themselves".
 */
import { test } from "node:test";
import * as assert from "node:assert/strict";
import * as cp from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";

import { writeLink, type WriteLinkInput } from "../src/handoff.ts";
import { PROFILES_SUBDIR } from "../src/profiles.ts";
import { rmrf, tmpProject } from "./helpers.ts";

const CLI = path.join(process.cwd(), "src", "cli.ts");
const hex = (s: string) => () => s;

function run(args: string[]): { status: number | null; stdout: string; stderr: string } {
	const r = cp.spawnSync("node", [CLI, ...args], { cwd: process.cwd(), encoding: "utf-8" });
	return { status: r.status, stdout: r.stdout ?? "", stderr: r.stderr ?? "" };
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
async function seed(cwd: string, o: Partial<WriteLinkInput> = {}) {
	return writeLink(cwd, input(o), { now: new Date(Date.UTC(2026, 8, 2, 9, 0, 0)), hex: hex("ee01") });
}

test("DoD 1 — plain unchanged: a pre-profile store keeps codes AND ok-semantics on show/write/go", async () => {
	const cwd = tmpProject();
	try {
		await seed(cwd); // store created "before the change": no profile anywhere
		// show: same code and ok as before the feature (data gains only the
		// additive strictness block — recorded interpretation, see issue #15 plan).
		assert.equal(run(["show", "--cwd", cwd, "--json"]).status, 0);
		// write (with stdin) and go are covered by the next tests + starter-template;
	} finally {
		rmrf(cwd);
	}
});

test("DoD 1 (write half) — unit-less write into a plain single-line store advances it, code 0", async () => {
	const cwd = tmpProject();
	try {
		const r1 = await seed(cwd);
		const w = cp.spawnSync("node", [CLI, "write", "--cwd", cwd, "--json"], {
			input: JSON.stringify(input({ sessionId: "sid-B", createdAt: "2026-09-02T12:00:00.000Z" })),
			encoding: "utf-8",
		});
		const env = JSON.parse((w.stdout ?? "").trim());
		assert.equal(env.ok, true);
		assert.equal(w.status, 0);
		assert.equal(env.data.unit, r1.unit); // same line, no new flags required
		assert.equal(env.data.seq, 2);
		assert.equal(env.data.case, "new-link");
	} finally {
		rmrf(cwd);
	}
});

test("DoD 2 — fleet store: unit-less show → usage(2); with --unit → ok(0)  [full: fleet-cli.test.ts]", async () => {
	const cwd = tmpProject();
	try {
		const { unit } = await seed(cwd, { profile: "fleet" });
		assert.equal(run(["show", "--cwd", cwd, "--json"]).status, 2);
		assert.equal(run(["show", "--cwd", cwd, "--unit", unit, "--json"]).status, 0);
	} finally {
		rmrf(cwd);
	}
});

test("DoD 3 (CONTROL) — the same shape of store WITHOUT a profile serves the unit-less ask", async () => {
	const cwd = tmpProject();
	try {
		await seed(cwd);
		const r = run(["show", "--cwd", cwd, "--json"]);
		assert.equal(r.status, 0);
		assert.equal(JSON.parse(r.stdout).data.kind, "head");
	} finally {
		rmrf(cwd);
	}
});

test("DoD 4 — suspicious is distinct from ok AND from not-found, with reason and threshold  [full: fleet-cli.test.ts]", async () => {
	const cwd = tmpProject();
	try {
		const stale = new Date(Date.UTC(2026, 7, 20)); // 2026-08-20 — ~13 days before "now"
		const r = await writeLink(cwd, input({ profile: "fleet", createdAt: stale.toISOString() }), { now: stale, hex: hex("ee02") });
		const shown = run(["show", "--cwd", cwd, "--unit", r.unit, "--json"]);
		assert.equal(shown.status, 4); // not 0 (ok), not 1 (not-found)
		const env = JSON.parse(shown.stdout);
		assert.equal(env.error!.code, "suspicious");
		assert.equal(env.data.suspicious.reason, "stale");
		assert.match(env.error!.message, /сут/);
	} finally {
		rmrf(cwd);
	}
});

test("DoD 5 (CONTROL) — no profile field + an org-looking catalog ⇒ mode plain", async () => {
	const cwd = tmpProject();
	try {
		fs.mkdirSync(path.join(cwd, PROFILES_SUBDIR), { recursive: true });
		fs.writeFileSync(path.join(cwd, PROFILES_SUBDIR, "fleet.json"), JSON.stringify({ requireExplicitUnit: true }));
		fs.writeFileSync(path.join(cwd, PROFILES_SUBDIR, "fleet.md"), "# fleet");
		await seed(cwd);
		assert.equal(run(["show", "--cwd", cwd, "--json"]).status, 0); // served, not refused
	} finally {
		rmrf(cwd);
	}
});

test("DoD 6 — missing template ⇒ go refuses naming the file  [full: starter-template.test.ts]", async () => {
	const cwd = tmpProject();
	try {
		const r = await seed(cwd, { profile: "fleet" });
		const gone = run(["go", "--cwd", cwd, "--unit", r.unit, "--json", "--dry-run"]);
		assert.equal(gone.status, 4);
		assert.match(JSON.parse(gone.stdout).error!.message, /fleet\.md/);
	} finally {
		rmrf(cwd);
	}
});

test("DoD 7 — prompt order is string-checked: block BEFORE the steps  [full: starter-template.test.ts]", async () => {
	const cwd = tmpProject();
	try {
		fs.mkdirSync(path.join(cwd, PROFILES_SUBDIR), { recursive: true });
		fs.writeFileSync(path.join(cwd, PROFILES_SUBDIR, "fleet.md"), "# ORG BLOCK");
		const r = await seed(cwd, { profile: "fleet" });
		const ok = run(["go", "--cwd", cwd, "--unit", r.unit, "--json", "--dry-run"]);
		const prompt = JSON.parse(ok.stdout).data.starterPrompt;
		assert.ok(prompt.indexOf("# ORG BLOCK") < prompt.indexOf("Proceed now:"));
	} finally {
		rmrf(cwd);
	}
});

test("DoD 8 — the observed defect does not reproduce: foreign plain line + fleet role", async () => {
	const cwd = tmpProject();
	try {
		const foreign = new Date(Date.UTC(2026, 7, 20));
		await writeLink(cwd, input({ sessionId: "sid-foreign", createdAt: foreign.toISOString() }), { now: foreign, hex: hex("ee03") });
		assert.equal(run(["show", "--cwd", cwd, "--json", "--profile", "fleet"]).status, 2);
		assert.equal(run(["go", "--cwd", cwd, "--json", "--profile", "fleet", "--dry-run"]).status, 2);
		assert.equal(run(["show", "--cwd", cwd, "--unit", "my-role", "--json"]).status, 1); // honest not-found
	} finally {
		rmrf(cwd);
	}
});

test("downgrade is announced: write --profile plain on a fleet line warns and reports the field", async () => {
	const cwd = tmpProject();
	try {
		await seed(cwd, { profile: "fleet" });
		const w = cp.spawnSync("node", [CLI, "write", "--cwd", cwd, "--json", "--profile", "plain"], {
			input: JSON.stringify(input({ sessionId: "sid-B", createdAt: "2026-09-02T12:00:00.000Z" })),
			encoding: "utf-8",
		});
		const env = JSON.parse((w.stdout ?? "").trim());
		assert.equal(env.ok, true);
		assert.deepEqual(env.data.profileChange, { from: "fleet", to: null, downgraded: true });
		assert.match(w.stderr ?? "", /профиль линии понижен fleet → plain/);
	} finally {
		rmrf(cwd);
	}
});

test("doctor --validate catches a bad stored profile (schema-family check stays one contract)", async () => {
	const cwd = tmpProject();
	try {
		const r = await seed(cwd, { profile: "fleet" });
		// Corrupt the head directly: a profile the writer would never accept.
		const p = r.path;
		const doc = JSON.parse(fs.readFileSync(p, "utf-8"));
		doc.profile = "Bad_Name";
		fs.writeFileSync(p, JSON.stringify(doc, null, 2) + "\n");
		const v = run(["doctor", "--validate", "--cwd", cwd, "--json"]);
		assert.equal(v.status, 4);
		assert.match(v.stdout, /profile/);
	} finally {
		rmrf(cwd);
	}
});
