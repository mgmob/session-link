import * as fs from "node:fs";
import * as path from "node:path";
import type { DerivedFacts, Handoff, HandoffV1, HandoffV2, LineState, ParentRef } from "./types.ts";
import type { WithLockOptions } from "./store.ts";
import { archivePath, assignUnit, collectDerived, generateId, headMdPath, headPath, indexPath, movedToPath, resolveStore, unitDir, withLock, UNIT_PATTERN } from "./store.ts";

/** Directory where the handoff lives for a given project cwd. */
export function handoffDir(cwd: string): string {
	return path.join(cwd, ".pi", "session_link");
}

/** Path to the "current" handoff for a project. */
export function handoffPath(cwd: string): string {
	return path.join(handoffDir(cwd), "handoff.json");
}

/** Сводка линии для перечня (§4.3). Строится из головы — источник истины, не из index. */
export interface UnitSummary {
	unit: string;
	unitProvisional?: boolean;
	state: LineState;
	seq: number;
	updatedAt: string;
	cwd: string;
	/** Первая непустая строка nextStep головы — ориентир, о какой это линии. */
	nextStepFirstLine?: string;
}

/** Результат поиска головы линии (§2.3). */
export type FindResult =
	| { kind: "head"; path: string; unit: string }
	| { kind: "legacy"; path: string }
	| { kind: "ambiguous"; lines: UnitSummary[] }
	| { kind: "none" };

/** Линия по умолчанию, когда `unit` не задан (§4.3). */
export type DefaultUnit =
	| { kind: "single"; unit: string }
	| { kind: "ambiguous"; lines: UnitSummary[] }
	| { kind: "none" };

/** Запись оглавления (§4). index.json — производный кэш, истина в головах. */
export interface IndexEntry {
	head: string;
	updatedAt: string;
	sessions: number;
	state: LineState;
	cwd: string;
	unitProvisional?: boolean;
}

export interface HandoffIndex {
	schema: "session-link/index/v1";
	units: Record<string, IndexEntry>;
}

/**
 * Линия по умолчанию, когда `unit` не задан (§4.3).
 *
 * Обходит каталоги линий store и читает каждую голову напрямую — НЕ доверяет
 * index.json (производный кэш, может рассинхронизироваться): активное
 * множество и его факты берутся из живых голов. Одна active → она; несколько →
 * ambiguous; ни одной → none, и вызывающий идёт к шагу legacy.
 */
export function resolveDefaultUnit(store: string): DefaultUnit {
	const actives: UnitSummary[] = [];
	let unitDirs: fs.Dirent[];
	try {
		unitDirs = fs.readdirSync(store, { withFileTypes: true });
	} catch {
		return { kind: "none" };
	}
	for (const e of unitDirs) {
		if (!e.isDirectory()) continue;
		const unit = e.name;
		if (unit === "incoming") continue; // incoming/ — указатели переезда (§2.6), не линии
		const s = readUnitSummary(store, unit);
		if (s && s.state === "active") actives.push(s);
	}
	if (actives.length === 0) return { kind: "none" };
	if (actives.length === 1) return { kind: "single", unit: actives[0].unit };
	actives.sort((a, b) => (a.updatedAt < b.updatedAt ? 1 : a.updatedAt > b.updatedAt ? -1 : 0));
	return { kind: "ambiguous", lines: actives };
}

/** Сводка линии из её головы; undefined, если головы нет или она не v2 (безымянная v1 в перечень не попадает, §4). */
function readUnitSummary(store: string, unit: string): UnitSummary | undefined {
	const h = readHandoff(headPath(store, unit));
	if (!h) return undefined;
	if (h.schema !== "session-link/handoff/v2") return undefined;
	const v2 = h as HandoffV2;
	return {
		unit: v2.unit,
		unitProvisional: v2.unitProvisional,
		state: v2.lineState ?? "active",
		seq: v2.seq,
		updatedAt: v2.committedAt ?? v2.createdAt,
		cwd: v2.cwd,
		nextStepFirstLine: firstLine(v2.nextStep),
	};
}

function firstLine(s: string | undefined): string | undefined {
	if (!s) return undefined;
	const t = s.trim();
	if (!t) return undefined;
	const i = t.indexOf("\n");
	return (i === -1 ? t : t.slice(0, i)).trim() || undefined;
}

/**
 * Найти текущий handoff для cwd (§2.3).
 *
 * Порядок: (1) `unit` задан → голова этой линии; (2) без `unit` → правило линии
 * по умолчанию (§4.3); (3) legacy `<cwd>/.pi/session_link/handoff.json`, если
 * рядом нет маркера `MOVED-TO.txt`; (4) ничего.
 */
export function findHandoff(cwd: string, unit?: string): FindResult {
	const store = resolveStore(cwd).root;

	if (unit) {
		const p = headPath(store, unit);
		if (fs.existsSync(p)) return { kind: "head", path: p, unit };
		// Явный unit + промах → none: не проваливаемся в legacy/чужую линию.
		return { kind: "none" };
	}

	const def = resolveDefaultUnit(store);
	if (def.kind === "single") {
		return { kind: "head", path: headPath(store, def.unit), unit: def.unit };
	}
	if (def.kind === "ambiguous") {
		return { kind: "ambiguous", lines: def.lines };
	}

	// def.kind === "none" → пробуем legacy-расположение v1.
	const legacyDir = handoffDir(cwd);
	const legacy = handoffPath(cwd);
	if (fs.existsSync(legacy) && !fs.existsSync(movedToPath(legacyDir))) {
		return { kind: "legacy", path: legacy };
	}
	return { kind: "none" };
}

/** Свернуть FindResult в путь, если он однозначен; иначе undefined.
 *  Переходный хелпер для вызывающих, ещё не v2-aware (index.ts до Э9). */
export function findHeadPath(r: FindResult): string | undefined {
	return r.kind === "head" || r.kind === "legacy" ? r.path : undefined;
}

/** Прочитать оглавление store (§4). Только чтение — запись в Э7. Отсутствует/повреждён → undefined.
 *  Истина — в головах; index производный, не полагаться как на источник. */
export function readIndex(store: string): HandoffIndex | undefined {
	let obj: Record<string, unknown>;
	try {
		obj = JSON.parse(fs.readFileSync(indexPath(store), "utf-8"));
	} catch {
		return undefined;
	}
	if (!obj || obj.schema !== "session-link/index/v1") return undefined;
	if (!obj.units || typeof obj.units !== "object") return undefined;
	return obj as unknown as HandoffIndex;
}

const HANDOFF_SCHEMAS = new Set(["session-link/handoff/v1", "session-link/handoff/v2"]);

/**
 * Прочитать handoff снисходительно (§7.4). Принимает всё семейство {v1, v2} по
 * `schema`; проверяет МИНИМУМ (семейство schema, обязательные поля конверта, а
 * для v2 — наличие id/unit/seq и regex unit). НЕзнакомые поля СОХРАНЯЮТСЯ:
 * распарсенный объект возвращается целиком, без проекции в строгий тип, — так
 * документ более новой формы переживает round-trip через старый инструмент.
 * Полная проверка по схеме — отдельный диагностический режим `--validate`, не здесь.
 */
export function readHandoff(p: string): Handoff | undefined {
	let obj: Record<string, unknown>;
	try {
		obj = JSON.parse(fs.readFileSync(p, "utf-8"));
	} catch {
		return undefined;
	}
	if (!obj || typeof obj !== "object") return undefined;
	if (!HANDOFF_SCHEMAS.has(obj.schema as string)) return undefined;
	// Обязательные поля конверта (общие для v1 и v2).
	if (typeof obj.createdAt !== "string") return undefined;
	if (typeof obj.driver !== "string") return undefined;
	if (typeof obj.sessionRef !== "string") return undefined;
	if (typeof obj.cwd !== "string") return undefined;
	if (typeof obj.howToAsk !== "string") return undefined;
	if (!Array.isArray(obj.askCommand)) return undefined;
	// Обязательное v2 + regex unit.
	if (obj.schema === "session-link/handoff/v2") {
		if (typeof obj.id !== "string") return undefined;
		if (typeof obj.unit !== "string") return undefined;
		if (!UNIT_PATTERN.test(obj.unit)) return undefined;
		if (!Number.isInteger(obj.seq)) return undefined;
	}
	return obj as unknown as Handoff;
}

function stamp(iso: string): string {
	return iso.replace(/[:.]/g, "-");
}

/** The mandatory spine — a handoff is "ready" to commit to a new session iff present. */
export const SPINE_FIELDS = ["goal", "summary", "nextStep"] as const;

/** The agent-authored body fields we merge forward on a redo-in-place. */
export const AGENT_BODY_FIELDS = [
	"goal",
	"summary",
	"nextStep",
	"sessionTitle",
	"blockers",
	"decisions",
	"filesChanged",
	"filesToRead",
	"environment",
	"deliberatelySkipped",
	"sections",
] as const;

/** Validate the mandatory spine. Returns ok + the list of missing fields. */
export function validateHandoff(h: Handoff | undefined): { ok: boolean; missing: string[] } {
	const missing: string[] = [];
	if (!h) return { ok: false, missing: [...SPINE_FIELDS] };
	for (const k of SPINE_FIELDS) {
		const v = (h as unknown as Record<string, unknown>)[k];
		if (typeof v !== "string" || v.trim().length === 0) missing.push(k);
	}
	return { ok: missing.length === 0, missing };
}

/** Copy the agent-authored body fields from `src` onto `dst` (only keys that are present). */
function mergeAgentBody(dst: Handoff, src: Handoff | undefined): void {
	if (!src) return;
	for (const k of AGENT_BODY_FIELDS) {
		const v = (src as unknown as Record<string, unknown>)[k];
		if (v !== undefined) (dst as unknown as Record<string, unknown>)[k] = v;
	}
}

function mdEscapeInline(s: string): string {
	return s;
}

/** Render a human-readable markdown view of a handoff. */
export function toMarkdown(h: Handoff): string {
	const lines: string[] = [];
	const v = validateHandoff(h);
	if (h.schema === "session-link/handoff/v2") {
		const v2 = h as HandoffV2;
		const draft = v.ok ? "" : " — DRAFT (spine not yet filled)";
		const prov = v2.unitProvisional
			? " — ⚠️ ПРОВИЗОРНОЕ ИМЯ, переименуйте командой /session-link-name"
			: "";
		lines.push(`# Handoff — линия ${v2.unit} · звено ${v2.seq}${draft}${prov}`);
	} else {
		lines.push(`# Context handoff (${h.driver})${v.ok ? "" : " — DRAFT (spine not yet filled)"}`);
	}
	lines.push("");
	lines.push(`- Created: ${h.createdAt}`);
	if (h.sessionName) lines.push(`- Previous session: ${h.sessionName}`);
	if (h.sessionId) lines.push(`- Session id: \`${h.sessionId}\``);
	if (h.model) lines.push(`- Model: ${h.model}`);
	lines.push(`- Working directory: \`${h.cwd}\``);
	if (h.schema === "session-link/handoff/v2") {
		const v2 = h as HandoffV2;
		lines.push(`- Line: \`${v2.unit}\``);
		lines.push(`- Sequence: ${v2.seq}`);
		if (v2.lineState && v2.lineState !== "active") lines.push(`- Line state: ${v2.lineState}`);
		if (v2.parent) lines.push(`- Parent link: \`${v2.parent.id}\`${v2.parent.store ? " (cross-store)" : ""}`);
		if (v2.unitProvisional) lines.push(`- ⚠️ Имя техническое — назовите линию: \\/session-link-name <unit\``);
	}
	lines.push("");

	lines.push("## How to query this previous session headlessly");
	lines.push("");
	lines.push("```");
	lines.push(h.howToAsk);
	lines.push("```");
	lines.push("");
	if (h.schema === "session-link/handoff/v2") {
		const d = (h as HandoffV2).derived;
		if (d && (d.branch || d.baseRef || d.commits || d.filesChanged || d.startedAt || d.endedAt)) {
			lines.push("## Facts (derived — collected, not authored)");
			lines.push("");
			if (d.branch) lines.push(`- Branch: \`${d.branch}\``);
			if (d.baseRef) lines.push(`- Base ref: \`${d.baseRef}\``);
			if (d.commits) lines.push(`- Commits since base: ${d.commits.length}`);
			if (d.startedAt || d.endedAt) {
				const span = [d.startedAt, d.endedAt].filter(Boolean).join(" → ");
				lines.push(`- Time: ${span}`);
			}
			if (d.filesChanged && d.filesChanged.length) {
				lines.push("");
				lines.push("Changed files (git):");
				lines.push("");
				for (const f of d.filesChanged) lines.push(`- \`${f}\``);
			}
			lines.push("");
		}
	}

	if (h.goal) {
		lines.push("## Goal");
		lines.push("");
		lines.push(h.goal);
		lines.push("");
	}
	if (h.summary) {
		lines.push("## Summary");
		lines.push("");
		lines.push(h.summary);
		lines.push("");
	}
	if (h.nextStep) {
		lines.push("## Next step");
		lines.push("");
		lines.push(h.nextStep);
		lines.push("");
	}
	if (h.blockers && h.blockers.length > 0) {
		lines.push("## Blockers");
		lines.push("");
		for (const b of h.blockers) lines.push(`- ${b}`);
		lines.push("");
	}
	if (h.decisions && h.decisions.length > 0) {
		lines.push("## Decisions");
		lines.push("");
		for (const d of h.decisions) {
			lines.push(`- **${d.decision}** — ${d.rationale}`);
		}
		lines.push("");
	}
	if (h.filesChanged && h.filesChanged.length > 0) {
		lines.push("## Files changed this session");
		lines.push("");
		for (const f of h.filesChanged) lines.push(`- \`${f}\``);
		lines.push("");
	}
	const toRead = h.filesToRead ?? h.files;
	if (toRead && toRead.length > 0) {
		lines.push("## Files to read");
		lines.push("");
		for (const f of toRead) lines.push(`- \`${f}\``);
		lines.push("");
	}
	if (h.environment) {
		lines.push("## Environment");
		lines.push("");
		if (Array.isArray(h.environment)) {
			for (const e of h.environment) lines.push(`- ${e}`);
		} else {
			for (const [k, val] of Object.entries(h.environment)) lines.push(`- \`${k}\`: ${val}`);
		}
		lines.push("");
	}
	if (h.deliberatelySkipped && h.deliberatelySkipped.length > 0) {
		lines.push("## Deliberately skipped / not written down");
		lines.push("");
		for (const s of h.deliberatelySkipped) lines.push(`- ${s}`);
		lines.push("");
	}
	if (h.sections && h.sections.length > 0) {
		for (const sec of h.sections) {
			lines.push(`## ${sec.title}`);
			lines.push("");
			lines.push(sec.body);
			lines.push("");
			if (sec.files && sec.files.length > 0) {
				for (const f of sec.files) lines.push(`- \`${f}\``);
				lines.push("");
			}
		}
	}
	if (h.contextNote) {
		lines.push("## Context note (from the closing user)");
		lines.push("");
		lines.push(h.contextNote);
		lines.push("");
	}
	lines.push("## askCommand (machine-readable argv template)");
	lines.push("");
	lines.push("```json");
	lines.push(JSON.stringify(h.askCommand));
	lines.push("```");
	void mdEscapeInline;
	return lines.join("\n");
}

/**
 * Write a handoff for a project.
 *
 * Chain / redo rules (so handoff files never corrupt):
 *   - handoff.json is the ONLY mutable file; the chain NEVER points at it.
 *   - If a live handoff exists from the SAME session (sameAuthor by sessionId),
 *     this is a REDO: overwrite in place, keep the existing parentHandoffPath,
 *     and carry forward any agent-authored body fields the agent already filled
 *     (a failed authoring pass must not wipe a good summary).
 *   - If a live handoff exists from a DIFFERENT session, this is a NEW handoff:
 *     archive the old live file to handoff-<stamp>.json and set parentHandoffPath
 *     to that immutable archive.
 *   - parentHandoffPath therefore always points at an archive (or is undefined),
 *     never at the live handoff.json — which also fixes the earlier self-link bug.
 *
 * Returns the path written.
 */
export function writeHandoff(cwd: string, h: Handoff): string {
	const dir = handoffDir(cwd);
	fs.mkdirSync(dir, { recursive: true });

	const current = handoffPath(cwd);
	const existing = readHandoff(current);
	const sameAuthor =
		!!existing && !!h.sessionId && !!existing.sessionId && h.sessionId === existing.sessionId;

	if (existing && !sameAuthor) {
		// New handoff from a different author → archive + advance the chain.
		const archive = path.join(dir, `handoff-${stamp(h.createdAt)}.json`);
		try {
			fs.copyFileSync(current, archive);
			h.parentHandoffPath = archive;
		} catch {
			// archive is best-effort; chain link only set if the copy succeeded
		}
	} else if (existing && sameAuthor) {
		// Redo in place: don't touch the chain, carry forward authored body.
		h.parentHandoffPath = existing.parentHandoffPath;
		mergeAgentBody(h, existing);
	}

	fs.writeFileSync(current, JSON.stringify(h, null, 2) + "\n", "utf-8");
	fs.writeFileSync(path.join(dir, "handoff.md"), toMarkdown(h) + "\n", "utf-8");
	return current;
}

/** Patch the live handoff's commit marker (best-effort) after a child session starts. */
export function markCommitted(cwd: string, committedAt: string, committedSessionFile?: string): void {
	try {
		const p = handoffPath(cwd);
		const h = readHandoff(p);
		if (!h) return;
		h.committedAt = committedAt;
		if (committedSessionFile) h.committedSessionFile = committedSessionFile;
		fs.writeFileSync(p, JSON.stringify(h, null, 2) + "\n", "utf-8");
		fs.writeFileSync(path.join(handoffDir(cwd), "handoff.md"), toMarkdown(h) + "\n", "utf-8");
	} catch {
		// commit marker is best-effort
	}
}
/**
 * Convert a v1 head into a v2 link (§2.4 step 1-2): schema bumped, immutable
 * `id` + line `unit` assigned, `seq` starts at 1 (first v2 link of the line).
 * Every v1 field — including the v1 ancestor `parentHandoffPath` — is preserved
 * whole, so unknown fields survive and the v1 chain stays reachable.
 */
export function convertV1ToV2Link(v1: HandoffV1, id: string, unit: string, provisional: boolean): HandoffV2 {
	const v2: HandoffV2 = { ...v1, schema: "session-link/handoff/v2", id, unit, seq: 1 };
	if (provisional) v2.unitProvisional = true;
	return v2;
}

export interface MigrationOptions {
	/** Operator-given unit (otherwise a technical name is minted). */
	unit?: string;
	now?: Date;
	hex?: () => string;
}

export interface MigrationResult {
	unit: string;
	id: string;
	provisional: boolean;
	/** Path to the migrated head: `<store>/<unit>/handoff.json`. */
	newPath: string;
	link: HandoffV2;
}

/**
 * Migrate a legacy v1 head into the v2 store (§2.4), invoked at first write.
 *
 * Detects THIS cwd's own legacy head directly (its <cwd>/.pi/session_link/
 * handoff.json, unless a MOVED-TO marker says it migrated) — NOT via findHandoff,
 * whose step 2 (§4.3) would return the store default once a line exists and hide
 * a sibling worktree's legacy (breaking invariant 19). Assigns a `unit` (§3.2) and
 * `id` (§2.5), converts it to a v2 link, and MOVES (not copies) only the head
 * (`handoff.json` + `handoff.md`) into `<store>/<unit>/`. v1 archives stay where
 * they are — they have no id and moving them would sever the chain at the
 * migration point; they remain reachable via `parentHandoffPath` (§2.5 step 4).
 * A one-line `MOVED-TO.txt` is left in the old dir so a human sees a pointer
 * and findHandoff step 3 no longer returns the stale head.
 *
 * Returns undefined when there is no legacy head to migrate.
 */
export function migrateLegacyHead(cwd: string, opts: MigrationOptions = {}): MigrationResult | undefined {
	// Per-cwd detection of THIS folder's own legacy head — not via findHandoff
	// (its §4.3 default-line step would hide a sibling worktree's legacy once the
	// shared store has a line; migration must be per-cwd to satisfy invariant 19).
	const legacyDir = handoffDir(cwd);
	const legacyPath = handoffPath(cwd);
	if (!fs.existsSync(legacyPath)) return undefined;
	if (fs.existsSync(movedToPath(legacyDir))) return undefined; // already migrated

	const v1 = readHandoff(legacyPath);
	if (!v1 || v1.schema !== "session-link/handoff/v1") return undefined;

	const store = resolveStore(cwd).root;
	const { unit, provisional } = assignUnit({ given: opts.unit, now: opts.now, hex: opts.hex });
	const id = generateId(store, { now: opts.now, hex: opts.hex });
	const v2 = convertV1ToV2Link(v1 as HandoffV1, id, unit, provisional);

	const newDir = unitDir(store, unit);
	fs.mkdirSync(newDir, { recursive: true });
	fs.writeFileSync(headPath(store, unit), JSON.stringify(v2, null, 2) + "\n", "utf-8");
	fs.writeFileSync(headMdPath(store, unit), toMarkdown(v2) + "\n", "utf-8");

	// Move (not copy): remove the legacy head + its projection. v1 archives stay.
	fs.rmSync(legacyPath, { force: true });
	fs.rmSync(path.join(legacyDir, "handoff.md"), { force: true });

	// Relocation marker — for humans and to block findHandoff step 3.
	fs.writeFileSync(movedToPath(legacyDir), newDir + "\n", "utf-8");

	return { unit, id, provisional, newPath: headPath(store, unit), link: v2 };
}

// ── writeLink: v2 запись, три случая (§5.1) ───────────────────────────────

/** Input for a v2 write: a full envelope+body minus the code-owned identity
 *  fields (schema/id/parent/seq/derived/unit) which `writeLink` assigns, plus
 *  the derived inputs `baseRef`/`startedAt`. */
export type WriteLinkInput = Omit<HandoffV2, "schema" | "id" | "parent" | "seq" | "derived" | "unit"> & {
	unit?: string;
	baseRef?: string;
	startedAt?: string;
};

export type WriteCase = "redo-in-place" | "new-link" | "first-link";

export interface WriteResult {
	unit: string;
	id: string;
	seq: number;
	path: string;
	caseName: WriteCase;
	link: HandoffV2;
}

export interface WriteLinkOptions {
	now?: Date;
	hex?: () => string;
	lock?: WithLockOptions;
}

/**
 * Write a v2 link under the store lock (§5 + §5.1). Three cases, decided by the
 * line's head and the writer's `sessionId`: redo-in-place (rewrite, no archive,
 * seq unchanged, agent body carried forward), new link (archive head, advance
 * seq, parent = old head), first link (seq=1, no parent). A legacy v1 head of
 * THIS cwd is migrated first (§2.4, per-cwd under the lock). `derived` is
 * collected before the lock and ALWAYS rebuilt, even on redo. Loser of the
 * lock race gets a LockBusyError (§9). index.json is updated in Э7.
 */
export async function writeLink(
	cwd: string,
	input: WriteLinkInput,
	opts: WriteLinkOptions = {},
): Promise<WriteResult> {
	const store = resolveStore(cwd).root;
	// Collect git facts BEFORE the lock — git reads must not hold the store lock.
	const derived = collectDerived(cwd, input.baseRef, input.startedAt);

	return withLock(
		store,
		() => {
			// §2.4: migrate THIS cwd's legacy v1 head first (per-cwd, under the lock).
			try {
				migrateLegacyHead(cwd, { unit: input.unit, now: opts.now, hex: opts.hex });
			} catch {
				// migration is best-effort; the write must still proceed
			}

			const head = locateHead(store, input.unit);
			const result = buildLink(store, input, head, derived, opts);
			persistLink(store, result);
			return result;
		},
		opts.lock ?? {},
	);
}

/** Find the line's current v2 head (by unit, or the single default active line).
 *  Ambiguous (N>1 active, no unit) ⇒ throw — §4.3 forbids picking for the operator. */
function locateHead(store: string, unit: string | undefined): { path: string; link: HandoffV2 } | undefined {
	let p: string | undefined;
	if (unit) {
		const candidate = headPath(store, unit);
		if (fs.existsSync(candidate)) p = candidate;
	} else {
		const def = resolveDefaultUnit(store);
		if (def.kind === "single") {
			p = headPath(store, def.unit);
		} else if (def.kind === "ambiguous") {
			throw new Error(
				`несколько активных линий в store; укажите unit=. Линии: ` + def.lines.map((l) => l.unit).join(", "),
			);
		}
	}
	if (!p) return undefined;
	const link = readHandoff(p);
	if (!link || link.schema !== "session-link/handoff/v2") return undefined;
	return { path: p, link };
}

/** Decide the case (§5.1) and assemble the v2 link object. */
function buildLink(
	store: string,
	input: WriteLinkInput,
	head: { path: string; link: HandoffV2 } | undefined,
	derived: DerivedFacts,
	opts: WriteLinkOptions,
): WriteResult {
	const sameSession = !!head && !!input.sessionId && head.link.sessionId === input.sessionId;
	let unit: string;
	let id: string;
	let seq: number;
	let parent: ParentRef | undefined;
	let parentHandoffPath: string | undefined;
	let unitProvisional: boolean | undefined;
	let caseName: WriteCase;

	if (head && sameSession) {
		// REDO in place — rewrite; id/seq/parent unchanged, body carried forward.
		unit = head.link.unit;
		id = head.link.id;
		seq = head.link.seq;
		parent = head.link.parent;
		parentHandoffPath = head.link.parentHandoffPath;
		unitProvisional = head.link.unitProvisional;
		caseName = "redo-in-place";
	} else if (head) {
		// NEW link — different session advances the line; archive the old head.
		unit = head.link.unit; // inherit the line name (rename is Э8)
		unitProvisional = head.link.unitProvisional;
		id = generateId(store, { now: opts.now, hex: opts.hex });
		seq = head.link.seq + 1;
		parent = { id: head.link.id, unit: head.link.unit, seq: head.link.seq };
		const archive = archivePath(store, head.link.unit, head.link.id);
		try {
			fs.copyFileSync(head.path, archive);
			parentHandoffPath = archive;
		} catch {
			// archive is best-effort; chain link only set if the copy succeeded
		}
		caseName = "new-link";
	} else {
		// FIRST link of a line.
		const assigned = assignUnit({ given: input.unit, now: opts.now, hex: opts.hex });
		unit = assigned.unit;
		unitProvisional = assigned.provisional ? true : undefined;
		id = generateId(store, { now: opts.now, hex: opts.hex });
		seq = 1;
		parent = undefined;
		parentHandoffPath = undefined;
		caseName = "first-link";
	}

	// Strip the derived-input-only fields before materializing the link.
	const rest = { ...input } as Partial<WriteLinkInput>;
	delete rest.baseRef;
	delete rest.startedAt;
	delete (rest as { unit?: string }).unit;

	const link = {
		...rest,
		schema: "session-link/handoff/v2",
		id,
		unit,
		seq,
		parent,
		parentHandoffPath,
		derived,
	} as HandoffV2;
	if (unitProvisional) link.unitProvisional = true;
	else delete link.unitProvisional;

	if (head && sameSession) mergeBodyForward(link, head.link);

	return { unit, id, seq, path: headPath(store, unit), caseName, link };
}

/** Carry agent-authored body fields from `src` onto `dst` ONLY where dst is
 *  empty — a failed authoring pass keeps the previous good value (§5.1).
 *  `derived` is never carried (always rebuilt). */
function mergeBodyForward(dst: HandoffV2, src: HandoffV2): void {
	for (const k of AGENT_BODY_FIELDS) {
		const sv = (src as unknown as Record<string, unknown>)[k];
		const dv = (dst as unknown as Record<string, unknown>)[k];
		if (sv !== undefined && dv === undefined) (dst as unknown as Record<string, unknown>)[k] = sv;
	}
}

/** Persist the link: head.json via temp+rename, the .md projection, then the
 *  index. Data first, index last (§5) — a stale index is rebuilt, a lost head is not. */
function persistLink(store: string, result: WriteResult): void {
	const dir = unitDir(store, result.unit);
	fs.mkdirSync(dir, { recursive: true });
	const finalPath = headPath(store, result.unit);
	const tmp = finalPath + ".tmp";
	fs.writeFileSync(tmp, JSON.stringify(result.link, null, 2) + "\n", "utf-8");
	fs.renameSync(tmp, finalPath);
	fs.writeFileSync(headMdPath(store, result.unit), toMarkdown(result.link) + "\n", "utf-8");
	// index last (§5): derived cache, rebuilt from heads — always recoverable.
	rebuildIndex(store);
}

// ── index.json (§4) ──────────────────────────────────────────────────────────
// The index is a DERIVED cache: fully rebuildable by walking <store>/*/head.
// To make `--rebuild-index` byte-for-byte equal to the in-transaction update, both
// paths go through `buildIndex` (sorted unit names, fixed field order).

/** Build the canonical index by walking every line's head (§4). v1-only / unnamed
 *  lines are skipped — they have no unit key. Deterministic: sorted unit names. */
export function buildIndex(store: string): HandoffIndex {
	const heads = new Map<string, HandoffV2>();
	let dirs: fs.Dirent[];
	try {
		dirs = fs.readdirSync(store, { withFileTypes: true });
	} catch {
		return { schema: "session-link/index/v1", units: {} };
	}
	for (const e of dirs) {
		if (!e.isDirectory() || e.name === "incoming") continue;
		const h = readHandoff(headPath(store, e.name));
		if (h && h.schema === "session-link/handoff/v2") heads.set(e.name, h as HandoffV2);
	}
	const units: Record<string, IndexEntry> = {};
	for (const unit of [...heads.keys()].sort()) {
		units[unit] = buildIndexEntry(store, unit, heads.get(unit)!);
	}
	return { schema: "session-link/index/v1", units };
}

/** Build one index entry from a head (§4): head path relative to store, sessions
 *  counts the line's v2 links in the store, state mirrors the head's lineState. */
function buildIndexEntry(store: string, unit: string, head: HandoffV2): IndexEntry {
	const entry: IndexEntry = {
		head: `${unit}/handoff.json`,
		updatedAt: head.committedAt ?? head.createdAt,
		sessions: countSessions(store, unit),
		state: head.lineState ?? "active",
		cwd: head.cwd,
	};
	if (head.unitProvisional) entry.unitProvisional = true;
	return entry;
}

/** Number of v2 links of a line in the store: archives in <unit>/ + the head. */
function countSessions(store: string, unit: string): number {
	try {
		const files = fs.readdirSync(unitDir(store, unit));
		const archives = files.filter((f) => /^handoff-.*\.json$/.test(f)).length;
		return archives + 1;
	} catch {
		return 1;
	}
}

/** Serialize the index atomically (temp + rename). Deterministic given the same
 *  object (fixed key order: schema, units; units in insertion = sorted order). */
export function writeIndex(store: string, index: HandoffIndex): void {
	fs.mkdirSync(store, { recursive: true });
	const p = indexPath(store);
	const tmp = p + ".tmp";
	fs.writeFileSync(tmp, JSON.stringify(index, null, 2) + "\n", "utf-8");
	fs.renameSync(tmp, p);
}

/** Rebuild index.json from the live heads and return it (§4). Byte-for-byte
 *  identical to what writeLink leaves behind, because writeLink updates the index
 *  by calling THIS function — same path, same serialization. */
export function rebuildIndex(store: string): HandoffIndex {
	const index = buildIndex(store);
	writeIndex(store, index);
	return index;
}
