/**
 * /session-link-doctor — store diagnostics (contract §9).
 *
 * Plain report (no flags): broken parent links, index divergence, a stale lock,
 * orphaned `incoming/` pointers. Flags: `--rebuild-index`, `--validate`.
 *
 * No JSON-schema library (the plan bans new deps): `validateDocument` checks the
 * load-bearing shape — schema family, envelope-required fields, and the v2
 * required id/unit/seq with their regexes. That's enough to catch a broken file;
 * full draft-2020-12 checking stays an optional future concern.
 */
import * as fs from "node:fs";
import * as path from "node:path";

import { buildIndex, readHandoff, readIndex } from "./handoff.ts";
import { resolveParent } from "./parent.ts";
import { headPath, ID_PATTERN, isLockStale, PROFILE_PATTERN, unitDir, UNIT_PATTERN } from "./store.ts";
import type { Handoff, HandoffV2 } from "./types.ts";

export type Severity = "error" | "warn";

export interface DoctorProblem {
	severity: Severity;
	kind: string;
	message: string;
}

export interface DoctorReport {
	problems: DoctorProblem[];
}

/** A link the doctor looks at: its path and the parsed handoff. */
interface LinkRef {
	path: string;
	link: Handoff;
}

/** Walk every v2 head + archive in the store (skip v1-only / unreadable). */
function collectLinks(store: string): LinkRef[] {
	const out: LinkRef[] = [];
	let dirs: fs.Dirent[];
	try {
		dirs = fs.readdirSync(store, { withFileTypes: true });
	} catch {
		return out;
	}
	for (const e of dirs) {
		if (!e.isDirectory() || e.name === "incoming") continue;
		const dir = unitDir(store, e.name);
		let files: string[];
		try {
			files = fs.readdirSync(dir);
		} catch {
			continue;
		}
		for (const f of files) {
			if (f !== "handoff.json" && !/^handoff-.*\.json$/.test(f)) continue;
			const p = path.join(dir, f);
			const link = readHandoff(p);
			if (link && link.schema === "session-link/handoff/v2") out.push({ path: p, link: link as HandoffV2 });
		}
	}
	return out;
}

/**
 * Structural check of a handoff document (the `--validate` path, without a
 * JSON-schema runtime). Returns the list of issues (empty ⇒ ok).
 */
export function validateDocument(obj: unknown): string[] {
	const issues: string[] = [];
	if (!obj || typeof obj !== "object") return ["не объект"];
	const o = obj as Record<string, unknown>;
	const schema = o.schema;
	if (schema !== "session-link/handoff/v1" && schema !== "session-link/handoff/v2") {
		return [`schema "${String(schema)}" не принадлежит семейству {v1,v2}`];
	}
	for (const k of ["createdAt", "driver", "sessionRef", "cwd", "howToAsk", "askCommand"]) {
		if (o[k] === undefined) issues.push(`отсутствует обязательное поле ${k}`);
	}
	if (o.askCommand !== undefined && !Array.isArray(o.askCommand)) issues.push("askCommand должен быть массивом");
	if (schema === "session-link/handoff/v2") {
		if (typeof o.id !== "string") issues.push("v2 требует строковый id");
		else if (!ID_PATTERN.test(o.id)) issues.push(`id не соответствует формату: ${o.id}`);
		if (typeof o.unit !== "string") issues.push("v2 требует строковый unit");
		else if (!UNIT_PATTERN.test(o.unit)) issues.push(`unit не соответствует regex: ${o.unit}`);
		if (!Number.isInteger(o.seq)) issues.push("v2 требует целочисленный seq");
		if (o.profile !== undefined && (typeof o.profile !== "string" || !PROFILE_PATTERN.test(o.profile))) {
			issues.push(`profile не соответствует regex: ${String(o.profile)}`);
		}
	}
	return issues;
}

/** Validate every handoff file in the store (the `--validate` report).
 *  Reads files DIRECTLY — not through readHandoff, which would filter out the
 *  very files we want to flag. */
export function validateStore(store: string): DoctorReport {
	const problems: DoctorProblem[] = [];
	let dirs: fs.Dirent[];
	try {
		dirs = fs.readdirSync(store, { withFileTypes: true });
	} catch {
		return { problems };
	}
	for (const e of dirs) {
		if (!e.isDirectory() || e.name === "incoming") continue;
		const dir = unitDir(store, e.name);
		let files: string[];
		try {
			files = fs.readdirSync(dir);
		} catch {
			continue;
		}
		for (const f of files) {
			if (f !== "handoff.json" && !/^handoff-.*\.json$/.test(f)) continue;
			const p = path.join(dir, f);
			let raw: unknown;
			try {
				raw = JSON.parse(fs.readFileSync(p, "utf-8"));
			} catch (err) {
				problems.push({ severity: "error", kind: "schema", message: `${p}: невозможно разобрать JSON (${String(err)})` });
				continue;
			}
			for (const msg of validateDocument(raw)) {
				problems.push({ severity: "error", kind: "schema", message: `${p}: ${msg}` });
			}
		}
	}
	return { problems };
}

/** Plain doctor report (contract §9): broken links, index divergence, stale lock, orphaned incoming. */
export function doctorReport(store: string): DoctorReport {
	const problems: DoctorProblem[] = [];

	// 1. Broken parent links.
	for (const ref of collectLinks(store)) {
		const v2 = ref.link as HandoffV2;
		if (!v2.parent) continue;
		const r = resolveParent(v2.parent, store, { hintPath: ref.link.parentHandoffPath });
		if (r.kind === "notFound") {
			problems.push({
				severity: "error",
				kind: "broken-parent",
				message: `${ref.path}: битая ссылка на предка (id ${r.id}; последний путь: ${r.lastTriedPath ?? "—"})`,
			});
		}
	}

	// 2. Index divergence — rebuilt vs what's on disk.
	const rebuilt = buildIndex(store);
	const existing = readIndex(store);
	const a = JSON.stringify(rebuilt);
	const b = existing ? JSON.stringify(existing) : null;
	if (a !== b) {
		problems.push({
			severity: "warn",
			kind: "index-divergence",
			message: `index.json расходится с головами линий — выполните /session-link-doctor --rebuild-index`,
		});
	}

	// 3. Stale lock.
	const stale = isLockStale(store);
	if (stale) {
		problems.push({
			severity: "warn",
			kind: "stale-lock",
			message: `протухший лок (pid ${stale.pid}, старт ${new Date(stale.startedAt).toISOString()})`,
		});
	}

	// 4. Orphaned incoming/ pointers.
	const incDir = path.join(store, "incoming");
	let incs: string[];
	try {
		incs = fs.readdirSync(incDir);
	} catch {
		incs = [];
	}
	for (const f of incs) {
		if (!f.endsWith(".json")) continue;
		const unit = f.replace(/\.json$/, "");
		if (!fs.existsSync(headPath(store, unit))) {
			problems.push({
				severity: "warn",
				kind: "orphaned-incoming",
				message: `incoming/${f}: указатель на линию "${unit}", которой нет в store`,
			});
		}
	}

	return { problems };
}
