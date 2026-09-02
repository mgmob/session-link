/**
 * Profile resolution + per-knob combination (П-1, issue #15).
 * Covers: built-in presets, org profiles, unknown-profile refusal, the plain
 * immutability (DoD 5), per-knob combination incl. the incomparable pair, the
 * expectedDriver conflict error, and the "empty declaration = not declared" rule.
 */
import { test } from "node:test";
import * as assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";

import {
	combineStrictness,
	declaredProfileName,
	loadTemplate,
	resolveProfile,
	PROFILES_SUBDIR,
} from "../src/profiles.ts";
import { rmrf, tmpProject } from "./helpers.ts";

function orgRepo(): string {
	const root = tmpProject("sl-profiles-");
	fs.mkdirSync(path.join(root, PROFILES_SUBDIR), { recursive: true });
	return root;
}

test("null (not declared) resolves to null — combining nulls is everything off", () => {
	const root = orgRepo();
	try {
		assert.equal(resolveProfile(null, root), null);
		const c = combineStrictness(null, null);
		assert.deepEqual(
			c,
			{
				requireExplicitUnit: { value: false, from: "default" },
				maxAgeDays: { value: null, from: "default" },
				expectedDriver: { value: null, from: "default" },
				checkCwd: { value: false, from: "default" },
				lineProfile: null,
				askerProfile: null,
			},
			"plain behaviour: no knob fires, sources say default — printable honesty"
		);
	} finally {
		rmrf(root);
	}
});

test("empty/whitespace declaration = not declared, NOT plain", () => {
	assert.equal(declaredProfileName(""), null);
	assert.equal(declaredProfileName("   "), null);
	assert.equal(declaredProfileName(undefined), null);
	assert.equal(declaredProfileName("fleet"), "fleet");
});

test("built-in plain is immutable: org files are never consulted (DoD 5)", () => {
	const root = orgRepo();
	try {
		// An org drops an "organizational-looking" plain override + template.
		fs.writeFileSync(path.join(root, PROFILES_SUBDIR, "plain.json"), JSON.stringify({ requireExplicitUnit: true }));
		fs.writeFileSync(path.join(root, PROFILES_SUBDIR, "plain.md"), "# should be ignored");
		const p = resolveProfile("plain", root)!;
		assert.deepEqual(p.knobs, {});
		assert.equal(p.templatePath, undefined);
	} finally {
		rmrf(root);
	}
});

test("built-in fleet: preset knobs; org files may tune and add a template", () => {
	const root = orgRepo();
	try {
		const p = resolveProfile("fleet", root)!;
		assert.equal(p.builtin, true);
		assert.equal(p.knobs.requireExplicitUnit, true);
		assert.equal(p.knobs.maxAgeDays, 7);

		fs.writeFileSync(path.join(root, PROFILES_SUBDIR, "fleet.json"), JSON.stringify({ maxAgeDays: 30, checkCwd: true }));
		fs.writeFileSync(path.join(root, PROFILES_SUBDIR, "fleet.md"), "# Org steps");
		const tuned = resolveProfile("fleet", root)!;
		assert.equal(tuned.knobs.maxAgeDays, 30);
		assert.equal(tuned.knobs.checkCwd, true);
		assert.equal(tuned.knobs.requireExplicitUnit, true); // preset key survives
		assert.equal(tuned.templatePath, path.join(root, PROFILES_SUBDIR, "fleet.md"));
		assert.equal(loadTemplate(tuned), "# Org steps");
	} finally {
		rmrf(root);
	}
});

test("unknown profile is a hard refusal — its strictness cannot be guessed as plain", () => {
	const root = orgRepo();
	try {
		assert.throws(() => resolveProfile("org-x", root), /профиль "org-x" не найден/);
	} finally {
		rmrf(root);
	}
});

test("org profile: knobs from .json, template from .md; either may exist alone", () => {
	const root = orgRepo();
	try {
		fs.writeFileSync(path.join(root, PROFILES_SUBDIR, "ops.json"), JSON.stringify({ maxAgeDays: 3, expectedDriver: "pi" }));
		fs.writeFileSync(path.join(root, PROFILES_SUBDIR, "steps-only.md"), "# Only steps");
		const ops = resolveProfile("ops", root)!;
		assert.equal(ops.builtin, false);
		assert.equal(ops.knobs.maxAgeDays, 3);
		assert.equal(ops.knobs.expectedDriver, "pi");
		assert.equal(ops.templatePath, undefined); // knobs alone are fine

		const steps = resolveProfile("steps-only", root)!;
		assert.deepEqual(steps.knobs, {}); // template alone: strictness off, steps applied
		assert.equal(loadTemplate(steps), "# Only steps");
	} finally {
		rmrf(root);
	}
});

test("org profile with garbage knobs is a named refusal, not a silent fallback", () => {
	const root = orgRepo();
	try {
		fs.writeFileSync(path.join(root, PROFILES_SUBDIR, "bad.json"), "{ not json");
		assert.throws(() => resolveProfile("bad", root), /не читается как JSON/);

		fs.writeFileSync(path.join(root, PROFILES_SUBDIR, "bad2.json"), JSON.stringify({ maxAgeDays: "week" }));
		assert.throws(() => resolveProfile("bad2", root), /maxAgeDays должно быть положительным числом/);

		fs.writeFileSync(path.join(root, PROFILES_SUBDIR, "bad3.json"), JSON.stringify({ requireExplicit: true }));
		assert.throws(() => resolveProfile("bad3", root), /незнакомая ручка "requireExplicit"/);
	} finally {
		rmrf(root);
	}
});

test("per-knob combination on the incomparable pair (the amendment's case)", () => {
	// line: requireExplicitUnit, maxAgeDays 30; asker: no unit requirement, maxAgeDays 7.
	// Neither profile is strictly stricter — "strictest of two" is undefined here.
	const line = { name: "a", builtin: false, knobs: { requireExplicitUnit: true, maxAgeDays: 30 } };
	const asker = { name: "b", builtin: false, knobs: { maxAgeDays: 7 } };
	const c = combineStrictness(line as never, asker as never);
	assert.deepEqual(c.requireExplicitUnit, { value: true, from: "line" }); // OR
	assert.deepEqual(c.maxAgeDays, { value: 7, from: "asker" }); // MIN
});

test("expectedDriver conflict is a configuration error, not a silent pick", () => {
	const line = { name: "a", builtin: false, knobs: { expectedDriver: "pi" } };
	const asker = { name: "b", builtin: false, knobs: { expectedDriver: "claude-code" } };
	assert.throws(() => combineStrictness(line as never, asker as never), /конфликт конфигурации.*"pi".*"claude-code"/);

	const same = { name: "b", builtin: false, knobs: { expectedDriver: "pi" } };
	const ok = combineStrictness(line as never, same as never);
	assert.deepEqual(ok.expectedDriver, { value: "pi", from: "line" });
});

test("sources are tracked per knob — printable provenance", () => {
	const line = { name: "fleet", builtin: true, knobs: { requireExplicitUnit: true, maxAgeDays: 7 } };
	const asker = { name: "ops", builtin: false, knobs: { requireExplicitUnit: true, maxAgeDays: 3, checkCwd: true } };
	const c = combineStrictness(line as never, asker as never);
	assert.deepEqual(c.requireExplicitUnit, { value: true, from: "line+asker" });
	assert.deepEqual(c.maxAgeDays, { value: 3, from: "asker" });
	assert.deepEqual(c.checkCwd, { value: true, from: "asker" });
	assert.deepEqual(c.expectedDriver, { value: null, from: "default" });
	assert.equal(c.lineProfile, "fleet");
	assert.equal(c.askerProfile, "ops");
});

test("loadTemplate refuses on a missing file instead of returning an empty block (DoD 6)", () => {
	const root = orgRepo();
	try {
		const p = { name: "x", builtin: false, knobs: {}, templatePath: path.join(root, PROFILES_SUBDIR, "gone.md") };
		assert.throws(() => loadTemplate(p as never), /файл не читается.*gone\.md/);
	} finally {
		rmrf(root);
	}
});

test("bad profile name is rejected by the pattern", () => {
	const root = orgRepo();
	try {
		assert.throws(() => resolveProfile("Fleet", root), /недопустим/);
		assert.throws(() => resolveProfile("fleet/", root), /недопустим/);
	} finally {
		rmrf(root);
	}
});
