import * as fs from "node:fs";
import * as path from "node:path";
import type { Handoff, HandoffV2, LineState } from "./types.ts";
import { headPath, indexPath, movedToPath, resolveStore, UNIT_PATTERN } from "./store.ts";

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
	lines.push(`# Context handoff (${h.driver})${v.ok ? "" : " — DRAFT (spine not yet filled)"}`);
	lines.push("");
	lines.push(`- Created: ${h.createdAt}`);
	if (h.sessionName) lines.push(`- Previous session: ${h.sessionName}`);
	if (h.sessionId) lines.push(`- Session id: \`${h.sessionId}\``);
	if (h.model) lines.push(`- Model: ${h.model}`);
	lines.push(`- Working directory: \`${h.cwd}\``);
	lines.push("");

	lines.push("## How to query this previous session headlessly");
	lines.push("");
	lines.push("```");
	lines.push(h.howToAsk);
	lines.push("```");
	lines.push("");

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
