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
import type { DerivedFacts } from "./types.ts";

/** Store tail, relative to the chosen root (git-common-dir or cwd). */
export const STORE_SUBDIR = path.join(".pi", "session_link");

/** Regex a link id matches (contract §2.5 / schema pattern). */
export const ID_PATTERN = /^[0-9]{8}T[0-9]{9}-[0-9a-f]{4}$/;

/** Line-name regex (§3.1): lowercase alnum + hyphens, 1–64 chars, leading alnum.
 *  Strict — no silent normalization; a violation is rejected with a sluggify hint. */
export const UNIT_PATTERN = /^[a-z0-9][a-z0-9-]{0,63}$/;

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

/** Options for `assignUnit` (test seams mirror `generateId`). */
export interface AssignUnitOptions {
	/** Operator-given name — strict-checked, used as-is. */
	given?: string;
	/** Inherit from the parent line's unit (§3.2 step 2), when there is one. */
	parentUnit?: string;
	now?: Date;
	hex?: () => string;
}

export interface AssignedUnit {
	unit: string;
	/** True when the name is technical (u-…) and unconfirmed by the operator. */
	provisional: boolean;
}

/**
 * Decide a line's `unit` (§3.2): operator-given → inherited from parent →
 * technical `u-<YYYYMMDD>-<HHMMSS>-<4hex>` (marked provisional). A given name is
 * validated STRICTLY against UNIT_PATTERN and rejected with a sluggify hint —
 * never silently normalized (§3.1). The unit is never derived from the folder
 * name: lines move between folders and the folder would lie exactly there.
 */
export function assignUnit(opts: AssignUnitOptions): AssignedUnit {
	if (opts.given !== undefined && opts.given !== "") {
		if (!UNIT_PATTERN.test(opts.given)) {
			throw new Error(
				`unit "${opts.given}" недопустим: разрешено [a-z0-9][a-z0-9-]{0,63}. ` +
					`Возможно, имелось в виду "${sluggifyHint(opts.given)}».`,
			);
		}
		return { unit: opts.given, provisional: false };
	}
	if (opts.parentUnit && UNIT_PATTERN.test(opts.parentUnit)) {
		return { unit: opts.parentUnit, provisional: false };
	}
	return { unit: technicalUnit(opts.now ?? new Date(), opts.hex), provisional: true };
}

/** Technical line name `u-<YYYYMMDD>-<HHMMSS>-<4hex>` (§3.2 step 3) — unique by construction. */
export function technicalUnit(now: Date, hex?: () => string): string {
	const h = hex ?? (() => crypto.randomBytes(2).toString("hex"));
	const pad = (n: number, w: number) => String(n).padStart(w, "0");
	const d = now;
	return `u-${d.getUTCFullYear()}${pad(d.getUTCMonth() + 1, 2)}${pad(d.getUTCDate(), 2)}-` +
		`${pad(d.getUTCHours(), 2)}${pad(d.getUTCMinutes(), 2)}${pad(d.getUTCSeconds(), 2)}-${h()}`;
}

/** Sluggify a name into a UNIT_PATTERN-shaped suggestion (§3.1 — hint only, never a source of truth). */
export function sluggifyHint(name: string): string {
	const s = name.toLowerCase().trim().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
	if (!s) return "line";
	// ensure a leading alnum (UNIT_PATTERN requires it)
	const fixed = /^[a-z0-9]/.test(s) ? s : `n-${s}`;
	return fixed.slice(0, 64);
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

// ── Derived facts (§7.3) ───────────────────────────────────────────────────
// Best-effort git collection: any failure (not a repo, git missing) just omits
// the field — collecting facts MUST NOT fail the write. `baseRef` gates
// commits/filesChanged: without a base point they'd be guessed, which is the
// same thing forbidden for `checks`. `checks` itself is NOT collected in MVP.

/** Collect derived facts for the current session (§7.3). Pure read, never throws. */
export function collectDerived(cwd: string, baseRef?: string, startedAt?: string): DerivedFacts {
	const facts: DerivedFacts = {};
	if (startedAt) facts.startedAt = startedAt;
	facts.endedAt = new Date().toISOString();
	const branch = gitOut(cwd, ["rev-parse", "--abbrev-ref", "HEAD"]);
	if (branch) facts.branch = branch;
	if (baseRef) {
		facts.baseRef = baseRef;
		const commits = gitOut(cwd, ["rev-list", `${baseRef}..HEAD`]);
		if (commits) facts.commits = commits.trim().split("\n").filter(Boolean);
		// committed deltas + the uncommitted working tree (what git doesn't see yet).
		const changed = gitOut(cwd, ["diff", "--name-only", `${baseRef}..HEAD`]);
		const dirty = gitOut(cwd, ["status", "--porcelain", "--untracked-files=all"]);
		const files = new Set<string>();
		if (changed) for (const f of changed.trim().split("\n")) if (f) files.add(f);
		if (dirty) for (const line of dirty.trim().split("\n")) { const f = line.slice(3); if (f) files.add(f); }
		if (files.size) facts.filesChanged = [...files].sort();
	}
	return facts;
}

/** Run git and return stdout (trimmed), or undefined on ANY failure. */
function gitOut(cwd: string, args: string[]): string | undefined {
	let out: cp.SpawnSyncReturns<string>;
	try {
		out = cp.spawnSync("git", args, { cwd, encoding: "utf-8" });
	} catch {
		return undefined;
	}
	if (out.status !== 0 || out.error) return undefined;
	return (out.stdout || "").trim() || undefined;
}


// ── Lock (§5) ──────────────────────────────────────────────────────────────
// Store-wide: index.json is the single contention point, so per-unit granularity
// wouldn't help. A live owner is identified by pid + process start time; a stale
// lock left by a killed owner MUST be reclaimed, or the first crash makes writing
// a handoff in the project impossible forever.

/** Process start time (epoch ms), fixed at module load. Two attempts in the same
 *  process share it; a reused pid (a new process) gets a different one. */
const PROCESS_START_EPOCH_MS = Date.now() - Math.floor(process.uptime() * 1000);

export interface LockContent {
	/** Owner pid. */
	pid: number;
	/** Owner process start time (epoch ms) — distinguishes pid reuse. */
	startedAt: number;
	/** When the lock was acquired (epoch ms) — diagnostics only. */
	acquiredAt: number;
}

/** Honest refusal for the loser of the lock race (§9). Never a silent overwrite. */
export class LockBusyError extends Error {
	readonly lockPath: string;
	readonly owner: LockContent | undefined;
	constructor(lockPath: string, owner: LockContent | undefined, timeoutMs: number) {
		const pid = owner ? ` (pid ${owner.pid})` : "";
		super(
			`store занят другим процессом${pid}; ожидание ${timeoutMs}мс истекло по пути ${lockPath}. ` +
				`Повторите позже или снимите протухший лок вручную.`,
		);
		this.name = "LockBusyError";
		this.lockPath = lockPath;
		this.owner = owner;
	}
}

export interface WithLockOptions {
	/** How long to wait for a live owner before refusing (default 10s). */
	timeoutMs?: number;
	/** Polling interval while waiting (default 50ms). */
	pollMs?: number;
	/** Sink for stale-lock reclamation notices. */
	log?: (msg: string) => void;
}

const DEFAULT_LOCK_TIMEOUT_MS = 10_000;
const DEFAULT_LOCK_POLL_MS = 50;

/**
 * Run `fn` under the store-wide lock (§5). The lock file holds {pid, startedAt,
 * acquiredAt}; a dead/stale owner is reclaimed. On timeout the loser gets a
 * `LockBusyError` (an honest refusal, not a silent overwrite). The lock is always
 * released in `finally`, even if `fn` throws.
 */
export async function withLock<T>(
	store: string,
	fn: () => T | Promise<T>,
	opts: WithLockOptions = {},
): Promise<T> {
	fs.mkdirSync(store, { recursive: true });
	const lockP = lockPath(store);
	const timeoutMs = opts.timeoutMs ?? DEFAULT_LOCK_TIMEOUT_MS;
	const pollMs = opts.pollMs ?? DEFAULT_LOCK_POLL_MS;
	const log = opts.log ?? (() => {});
	const deadline = Date.now() + timeoutMs;

	let acquired = false;
	try {
		while (Date.now() < deadline) {
			if (tryAcquire(lockP)) {
				acquired = true;
				break;
			}
			const owner = readStaleOwner(lockP);
			if (owner) {
				log(
					`session-link: reclaiming stale store lock at ${lockP} ` +
						`(pid ${owner.pid}, started ${new Date(owner.startedAt).toISOString()}).`,
				);
				fs.rmSync(lockP, { force: true });
				continue; // retry acquire immediately
			}
			await sleep(pollMs);
		}
		if (!acquired) {
			let owner: LockContent | undefined;
			try {
				owner = JSON.parse(fs.readFileSync(lockP, "utf-8"));
			} catch {
				// unreadable / gone — no owner to report
			}
			throw new LockBusyError(lockP, owner, timeoutMs);
		}
		return await fn();
	} finally {
		if (acquired) fs.rmSync(lockP, { force: true });
	}
}

/** Attempt an exclusive (O_EXCL) create of the lock file. True on success, false if held. */
function tryAcquire(lockP: string): boolean {
	const content: LockContent = { pid: process.pid, startedAt: PROCESS_START_EPOCH_MS, acquiredAt: Date.now() };
	let fd: number | undefined;
	try {
		fd = fs.openSync(lockP, "wx");
		fs.writeFileSync(fd, JSON.stringify(content));
		return true;
	} catch (e) {
		if ((e as NodeJS.ErrnoException).code === "EEXIST") return false;
		throw e;
	} finally {
		if (fd !== undefined) {
			try {
				fs.closeSync(fd);
			} catch {
				// best-effort
			}
		}
	}
}

/** Read the lock; return the owner ONLY if stale (dead pid, or our pid with a
 *  different start time = pid reuse). A live owner or an unreadable lock → null. */
function readStaleOwner(lockP: string): LockContent | null {
	let c: LockContent;
	try {
		c = JSON.parse(fs.readFileSync(lockP, "utf-8"));
	} catch {
		return null; // unreadable: don't touch someone else's lock
	}
	if (typeof c.pid !== "number" || typeof c.startedAt !== "number") return null;
	if (!isPidAlive(c.pid)) return c; // dead owner → stale
	if (c.pid === process.pid && c.startedAt !== PROCESS_START_EPOCH_MS) return c; // reused pid
	return null; // live owner
}

/** Is `pid` an existing process? signal 0 probes without delivering a signal. */
function isPidAlive(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch (e) {
		const code = (e as NodeJS.ErrnoException).code;
		if (code === "ESRCH") return false; // no such process
		if (code === "EPERM") return true; // exists, just not ours to signal
		return true; // unknown — assume alive (safer than deleting someone's lock)
	}
}

function sleep(ms: number): Promise<void> {
	return new Promise((r) => setTimeout(r, ms));
}
