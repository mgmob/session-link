/**
 * Store layout + identity (contract §2).
 *
 * The store is REPO-SCOPED: when cwd is inside a git repo, the store lives at
 * `<git-common-dir>/.pi/session_link` so every worktree of one clone shares it
 * (invariant 13) for free — no network, no daemon. Otherwise it falls back to
 * `<cwd>/.pi/session_link` (the v0.1.0 behaviour).
 *
 * Identity is an immutable link `id` (§2.5): `<YYYYMMDD>T<HHMMSSmmm>-<4hex>`,
 * assigned on first write and never changed. Name-sort stays time-sort, like the
 * old v1 `<stamp>`. Collisions (same ms + same 4 hex) are resolved by regenerating
 * the hex against the existing archive/head ids in the store.
 *
 * This module knows nothing about reading or writing handoff documents — only
 * WHERE they live and WHAT their id is. Read/write/lock land in later stages.
 */
import * as cp from "node:child_process";
import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";

/** Store tail, relative to the chosen root (git-common-dir or cwd). */
export const STORE_SUBDIR = path.join(".pi", "session_link");

/** Regex a link id matches (contract §2.5 / schema pattern). */
export const ID_PATTERN = /^[0-9]{8}T[0-9]{9}-[0-9a-f]{4}$/;

export interface ResolvedStore {
	/** Absolute path to the store root (`<root>/.pi/session_link`). */
	root: string;
	/** true — resolved via `git-common-dir` (repo-scoped); false — cwd fallback. */
	viaGit: boolean;
}

/**
 * Resolve the store for a cwd (§2.1).
 *
 * `git rev-parse --git-common-dir` is asked first; any failure (not a repo, git
 * binary missing, non-zero exit, non-existent path) falls back to the cwd. The
 * fallback is the rule, not an error: a folder outside git simply uses its own
 * `.pi/session_link`, exactly as v0.1.0 did.
 */
export function resolveStore(cwd: string): ResolvedStore {
	const commonDir = gitCommonDir(cwd);
	if (commonDir) {
		return { root: path.join(commonDir, STORE_SUBDIR), viaGit: true };
	}
	return { root: path.join(cwd, STORE_SUBDIR), viaGit: false };
}

/**
 * Absolute `git-common-dir` for cwd, or undefined on any failure.
 * The output may be relative (`.`, `.git`, …), so it is resolved against cwd.
 */
function gitCommonDir(cwd: string): string | undefined {
	let out: cp.SpawnSyncReturns<string>;
	try {
		out = cp.spawnSync("git", ["rev-parse", "--git-common-dir"], {
			cwd,
			encoding: "utf-8",
		});
	} catch {
		return undefined;
	}
	if (out.status !== 0 || out.error) return undefined;
	const raw = (out.stdout || "").trim();
	if (!raw) return undefined;
	const abs = path.resolve(cwd, raw);
	// `git rev-parse` happily prints paths that don't exist (e.g. inside a bare
	// dir's subdir quirks); treat a missing dir as "not usable".
	if (!fs.existsSync(abs)) return undefined;
	return abs;
}

/** Options for `generateId` (test seams; production calls with no args). */
export interface GenerateIdOptions {
	/** Fixed "now" — for deterministic tests. */
	now?: Date;
	/** Source of the 4-hex suffix — for collision-resolution tests. */
	hex?: () => string;
}

/**
 * Mint a link id (§2.5): `<YYYYMMDD>T<HHMMSSmmm>-<4hex>` in UTC, unique within
 * the store. UTC (not local) keeps name-sort == time-sort across machines and
 * avoids tz-induced reordering. If the hex clashes with an existing archive/head
 * id at the same millisecond, the hex is regenerated.
 */
export function generateId(storeRoot: string, opts: GenerateIdOptions = {}): string {
	const now = opts.now ?? new Date();
	const ts = formatIdTs(now);
	const hex = opts.hex ?? (() => crypto.randomBytes(2).toString("hex"));
	// 16 attempts cover the realistic case; the full 65536-space is unreachable
	// in practice and we must not loop forever on a pathological mock.
	for (let attempt = 0; attempt < 16; attempt++) {
		const id = `${ts}-${hex()}`;
		if (!ID_PATTERN.test(id)) continue; // guard a misbehaving hex source
		if (!idExists(storeRoot, id)) return id;
	}
	// Exhausted — fall back to one more draw rather than throwing: an id that
	// collides is still schema-valid; the collision check is best-effort.
	return `${ts}-${hex()}`;
}

/** Format a Date as the id timestamp prefix `<YYYYMMDD>T<HHMMSSmmm>` (UTC). */
function formatIdTs(d: Date): string {
	const pad = (n: number, w: number) => String(n).padStart(w, "0");
	const yyyy = d.getUTCFullYear();
	const mm = pad(d.getUTCMonth() + 1, 2);
	const dd = pad(d.getUTCDate(), 2);
	const HH = pad(d.getUTCHours(), 2);
	const MM = pad(d.getUTCMinutes(), 2);
	const SS = pad(d.getUTCSeconds(), 2);
	const mmm = pad(d.getUTCMilliseconds(), 3);
	return `${yyyy}${mm}${dd}T${HH}${MM}${SS}${mmm}`;
}

/**
 * Does a link id already live in the store? Checked against BOTH archive names
 * (`<unit>/handoff-<id>.json`) and head contents (`<unit>/handoff.json`'s `id`),
 * since heads carry their id inside, not in the filename. A missing store or
 * unit dir means "no collision".
 */
export function idExists(storeRoot: string, id: string): boolean {
	const archiveFile = `handoff-${id}.json`;
	let entries: fs.Dirent[];
	try {
		entries = fs.readdirSync(storeRoot, { withFileTypes: true });
	} catch {
		return false; // store does not exist yet → nothing to collide with
	}
	for (const e of entries) {
		if (!e.isDirectory()) continue;
		const unitDir = path.join(storeRoot, e.name);
		try {
			if (fs.readdirSync(unitDir).includes(archiveFile)) return true;
		} catch {
			// unit dir vanished mid-scan — ignore
		}
		try {
			const raw = fs.readFileSync(path.join(unitDir, "handoff.json"), "utf-8");
			const obj = JSON.parse(raw) as { id?: unknown };
			if (obj && obj.id === id) return true;
		} catch {
			// no head / unreadable — ignore
		}
	}
	return false;
}

// ── Layout helpers (paths only — no FS writes) ────────────────────────────────
// Every path is absolute given absolute inputs; the store root is the pivot.

/** `<store>/<unit>/` — a line's directory. */
export function unitDir(storeRoot: string, unit: string): string {
	return path.join(storeRoot, unit);
}
/** `<store>/<unit>/handoff.json` — the live head. */
export function headPath(storeRoot: string, unit: string): string {
	return path.join(storeRoot, unit, "handoff.json");
}
/** `<store>/<unit>/handoff.md` — the human-readable projection. */
export function headMdPath(storeRoot: string, unit: string): string {
	return path.join(storeRoot, unit, "handoff.md");
}
/** `<store>/<unit>/handoff-<id>.json` — an immutable archive of link `<id>`. */
export function archivePath(storeRoot: string, unit: string, id: string): string {
	return path.join(storeRoot, unit, `handoff-${id}.json`);
}
/** `<store>/index.json` — the line directory (derived cache, §4). */
export function indexPath(storeRoot: string): string {
	return path.join(storeRoot, "index.json");
}
/** `<store>/.lock` — the store-wide lock marker (§5). */
export function lockPath(storeRoot: string): string {
	return path.join(storeRoot, ".lock");
}
/** `<oldDir>/MOVED-TO.txt` — the one-line relocation pointer (§2.4). */
export function movedToPath(oldDir: string): string {
	return path.join(oldDir, "MOVED-TO.txt");
}
/** `<targetStore>/incoming/<unit>.json` — cross-store hand-off pointer (§2.6). */
export function incomingPath(targetStoreRoot: string, unit: string): string {
	return path.join(targetStoreRoot, "incoming", `${unit}.json`);
}
