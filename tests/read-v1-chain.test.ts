/**
 * Инвариант 7 (база): v1-фикстура читается; цепочка цела.
 *
 * Э0 ставит только фундамент — реальная v1-цепочка владельца (gate перед
 * мержем) прогоняется тем же кодом на Э13. Здесь — синтетическая цепочка из 4
 * звеньев, сгенерированная эмуляцией v0.1.0 writer'а (см. ./generate.mjs).
 *
 * Проверяем три вещи, которых требует контракт §7.4 у приёмника версий:
 *   - голова читается как `session-link/handoff/v1` со заполненным spine;
 *   - каждый архив тоже читается как v1;
 *   - parent-цепочка от головы непрерывна до первого звена (без дырок и циклов).
 */
import { test } from "node:test";
import * as assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { readHandoff } from "../src/handoff.ts";
import { fixturePath } from "./helpers.ts";

const DIR = fixturePath("v1-chain");
const SPINE = ["goal", "summary", "nextStep"] as const;

function readOrFail(p: string) {
	const h = readHandoff(p);
	if (!h) assert.fail(`expected v1 handoff at ${p}`);
	return h;
}

test("v1 fixture: head reads as session-link/handoff/v1 with a filled spine", () => {
	const headPath = path.join(DIR, "handoff.json");
	assert.ok(fs.existsSync(headPath), "fixture head handoff.json exists");

	const head = readOrFail(headPath);
	assert.equal(head.schema, "session-link/handoff/v1");
	for (const f of SPINE) {
		const v = head[f];
		assert.ok(typeof v === "string" && v.trim().length > 0, `spine field "${f}" is filled`);
	}
});

test("v1 fixture: every archive reads as session-link/handoff/v1", () => {
	const archives = fs
		.readdirSync(DIR)
		.filter((f) => /^handoff-.*\.json$/.test(f))
		.sort();
	assert.ok(archives.length >= 3, `at least 3 archives for a 4-link chain (got ${archives.length})`);

	for (const a of archives) {
		const h = readOrFail(path.join(DIR, a));
		assert.equal(h.schema, "session-link/handoff/v1", `${a} is v1`);
	}
});

test("v1 fixture: parent chain is contiguous from the head down to the first link", () => {
	let cur = readOrFail(path.join(DIR, "handoff.json"));
	let links = 0;

	while (cur.parentHandoffPath) {
		links += 1;
		if (links > 32) assert.fail("parent chain too deep — suspected cycle");
		// Фикстура самосогласована: parentHandoffPath = basename архива рядом (см. generate.mjs).
		const parentFile = path.join(DIR, path.basename(cur.parentHandoffPath));
		assert.ok(fs.existsSync(parentFile), `parent archive exists: ${path.basename(parentFile)}`);
		cur = readOrFail(parentFile);
	}

	// 4 звена = 3 parent-ссылки от головы до первого звена.
	assert.ok(links >= 3, `chain spans >=3 parent links (got ${links})`);
});
