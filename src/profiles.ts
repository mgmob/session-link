/**
 * Profile resolution and strictness combination (issue #15, П-1).
 *
 * The plugin knows KNOBS, not organizations. A profile is a named set of
 * strictness knobs (+ an org-steps template for the starter). Sources:
 *
 *   - built-in presets: `plain` (everything off, IMMUTABLE — org files are
 *     never consulted for it, so a catalog that "looks organizational" cannot
 *     turn plain into something else, DoD 5) and `fleet` (explicit addressing,
 *     freshness threshold; tunable by an org override file);
 *   - org profiles: `<repo-root>/.session-link/profiles/<name>.json` (knob
 *     values) and `<name>.md` (the org-steps template). The directory lives in
 *     the ORG's repo — versioned and pushed; the store (.git/) is clone-local
 *     and would let the texts rot silently (the reason they were moved out).
 *     It is deliberately OUTSIDE `.pi/` and `.claude/`: a line survives a
 *     platform change, so its profile's location must not know the platform.
 *
 * A profile is DECLARED, never derived: by the line (`profile` field) or by the
 * asking side (CLI `--profile`, extension `SESSION_LINK_PROFILE`). An empty
 * declaration means "not declared" — NOT plain (a botched `VAR=` substitution
 * in a script must not become an active declaration of the weakest mode).
 *
 * Combination is PER-KNOB (the issue author's amendment): "strictest of two
 * profiles" is undefined on incomparable knob sets, so booleans OR together,
 * thresholds take the minimum, and conflicting `expectedDriver` values are a
 * configuration ERROR, not a silent pick.
 */
import * as fs from "node:fs";
import * as path from "node:path";
import * as cp from "node:child_process";
import { PROFILE_PATTERN } from "./store.ts";

/** Strictness knobs a profile may set. Absent ⇒ the preset's default. */
export interface StrictnessKnobs {
	/** Refuse unit-less show/go even when the store has a single line. */
	requireExplicitUnit?: boolean;
	/** Max age of an accepted link, in days. null/absent ⇒ no freshness check. */
	maxAgeDays?: number | null;
	/** The only driver an accepted link may carry. null/absent ⇒ any. */
	expectedDriver?: string | null;
	/** Require the link's cwd to resolve to the same repo root as the reader's. */
	checkCwd?: boolean;
}

/** A knob with its provenance — the amendment: the applied strictness must be
 *  printable WITH its source, or a silently-missing declaration is
 *  indistinguishable from an applied one. */
export interface Knob<T> {
	value: T;
	from: "line" | "asker" | "line+asker" | "default";
}

export interface CombinedStrictness {
	requireExplicitUnit: Knob<boolean>;
	maxAgeDays: Knob<number | null>;
	expectedDriver: Knob<string | null>;
	checkCwd: Knob<boolean>;
	/** Profile names that participated, for the printed line. */
	lineProfile: string | null;
	askerProfile: string | null;
}

export interface ResolvedProfile {
	name: string;
	builtin: boolean;
	knobs: StrictnessKnobs;
	/** Absolute path of the org-steps template, when one exists. */
	templatePath?: string;
}

/** Where org profiles live, relative to the repo root. */
export const PROFILES_SUBDIR = path.join(".session-link", "profiles");

const BUILTIN_PRESETS: Record<string, StrictnessKnobs> = {
	plain: {},
	fleet: { requireExplicitUnit: true, maxAgeDays: 7 },
};

/** Normalize a declaration: null/undefined/whitespace ⇒ null ("not declared").
 *  NOT "plain" — see the module comment. */
export function declaredProfileName(raw: string | null | undefined): string | null {
	if (typeof raw !== "string") return null;
	const t = raw.trim();
	return t.length ? t : null;
}

/** The repo root for a cwd: `git rev-parse --show-toplevel`, else the cwd.
 *  Profiles belong to the working tree (versioned), not the git common dir. */
export function repoRootOf(cwd: string): string {
	try {
		const r = cp.execFileSync("git", ["-C", cwd, "rev-parse", "--show-toplevel"], {
			encoding: "utf-8",
			stdio: ["ignore", "pipe", "ignore"],
		});
		const root = r.trim();
		if (root) return root;
	} catch {
		// not a repo / git missing → cwd is the root
	}
	return cwd;
}

function readOrgKnobs(repoRoot: string, name: string): StrictnessKnobs | undefined {
	const p = path.join(repoRoot, PROFILES_SUBDIR, `${name}.json`);
	if (!fs.existsSync(p)) return undefined;
	let obj: unknown;
	try {
		obj = JSON.parse(fs.readFileSync(p, "utf-8"));
	} catch (e) {
		throw new Error(
			`профиль "${name}": ${path.relative(repoRoot, p)} не читается как JSON (${String((e as Error).message)}) — исправьте файл или уберите его.`,
		);
	}
	if (!obj || typeof obj !== "object" || Array.isArray(obj)) {
		throw new Error(`профиль "${name}": ${path.relative(repoRoot, p)} должен быть JSON-объектом с ручками (requireExplicitUnit, maxAgeDays, expectedDriver, checkCwd).`);
	}
	const raw = obj as Record<string, unknown>;
	const knobs: StrictnessKnobs = {};
	const bool = (k: keyof StrictnessKnobs) => {
		if (raw[k] !== undefined) {
			if (typeof raw[k] !== "boolean") throw new Error(`профиль "${name}": ручка ${String(k)} должна быть true/false, получено ${JSON.stringify(raw[k])}.`);
			(knobs as Record<string, unknown>)[k] = raw[k];
		}
	};
	bool("requireExplicitUnit");
	bool("checkCwd");
	if (raw.maxAgeDays !== undefined) {
		if (raw.maxAgeDays !== null && (typeof raw.maxAgeDays !== "number" || !Number.isFinite(raw.maxAgeDays) || raw.maxAgeDays <= 0)) {
			throw new Error(`профиль "${name}": maxAgeDays должно быть положительным числом дней или null, получено ${JSON.stringify(raw.maxAgeDays)}.`);
		}
		knobs.maxAgeDays = raw.maxAgeDays as number | null;
	}
	if (raw.expectedDriver !== undefined) {
		if (raw.expectedDriver !== null && typeof raw.expectedDriver !== "string") {
			throw new Error(`профиль "${name}": expectedDriver должно быть строкой или null, получено ${JSON.stringify(raw.expectedDriver)}.`);
		}
		knobs.expectedDriver = raw.expectedDriver as string | null;
	}
	const known = new Set(["requireExplicitUnit", "maxAgeDays", "expectedDriver", "checkCwd"]);
	for (const k of Object.keys(raw)) {
		if (!known.has(k)) throw new Error(`профиль "${name}": незнакомая ручка "${k}" — опечатка? Разрешены: ${[...known].join(", ")}.`);
	}
	return knobs;
}

/**
 * Resolve a declared profile name. `null` (not declared) resolves to null —
 * the caller combines nulls as "everything off".
 *
 * `plain` is immutable and never reads org files. Built-in non-plain presets
 * (`fleet`) take org overrides for BOTH knobs and template. An org profile
 * with neither `<name>.json` nor `<name>.md` is UNKNOWN — a hard error: its
 * strictness cannot be known, and guessing it as plain is exactly the failure
 * mode this whole feature exists to prevent.
 */
export function resolveProfile(name: string | null, repoRoot: string): ResolvedProfile | null {
	if (name === null) return null;
	if (!PROFILE_PATTERN.test(name)) {
		throw new Error(`profile "${name}" недопустим: разрешено [a-z0-9][a-z0-9-]{0,31}.`);
	}
	if (name === "plain") {
		return { name, builtin: true, knobs: {} };
	}
	const orgKnobs = readOrgKnobs(repoRoot, name);
	const templatePath = path.join(repoRoot, PROFILES_SUBDIR, `${name}.md`);
	const hasTemplate = fs.existsSync(templatePath);
	if (name in BUILTIN_PRESETS) {
		const knobs = { ...BUILTIN_PRESETS[name], ...orgKnobs };
		return { name, builtin: true, knobs, ...(hasTemplate ? { templatePath } : {}) };
	}
	if (!orgKnobs && !hasTemplate) {
		throw new Error(
			`профиль "${name}" не найден: нет ни ${path.join(PROFILES_SUBDIR, name + ".json")}, ни ${path.join(PROFILES_SUBDIR, name + ".md")} в корне репозитория. Профиль не выводится из окружения — объявите существующий или создайте файл.`,
		);
	}
	return { name, builtin: false, knobs: orgKnobs ?? {}, ...(hasTemplate ? { templatePath } : {}) };
}

/** Load the org-steps template text. A missing file is a REFUSAL, not a silent
 *  empty block (DoD 6): silence here is indistinguishable from "no org steps
 *  required", and that is how mandatory checks get lost. */
export function loadTemplate(profile: ResolvedProfile): string {
	if (!profile.templatePath) return "";
	let text: string;
	try {
		text = fs.readFileSync(profile.templatePath, "utf-8");
	} catch (e) {
		throw new Error(
			`профиль "${profile.name}" требует шаблон организационных шагов, но файл не читается: ${profile.templatePath} (${String((e as Error).message)}). Преемник не запущен.`,
		);
	}
	return text.trim();
}

function boolKnob(k: keyof StrictnessKnobs, line: ResolvedProfile | null, asker: ResolvedProfile | null): Knob<boolean> {
	const l = !!line?.knobs[k];
	const a = !!asker?.knobs[k];
	if (l && a) return { value: true, from: "line+asker" };
	if (l) return { value: true, from: "line" };
	if (a) return { value: true, from: "asker" };
	return { value: false, from: "default" };
}

function minKnob(line: ResolvedProfile | null, asker: ResolvedProfile | null): Knob<number | null> {
	const l = line?.knobs.maxAgeDays;
	const a = asker?.knobs.maxAgeDays;
	if (l != null && a != null) {
		if (l === a) return { value: l, from: "line+asker" };
		return l < a ? { value: l, from: "line" } : { value: a, from: "asker" };
	}
	if (l != null) return { value: l, from: "line" };
	if (a != null) return { value: a, from: "asker" };
	return { value: null, from: "default" };
}

function driverKnob(line: ResolvedProfile | null, asker: ResolvedProfile | null): Knob<string | null> {
	const l = line?.knobs.expectedDriver ?? null;
	const a = asker?.knobs.expectedDriver ?? null;
	if (l && a && l !== a) {
		throw new Error(
			`конфликт конфигурации: профиль линии требует driver "${l}", объявление спрашивающего — "${a}". Откажитесь от одного из них: молчаливый выбор здесь означал бы неизвестную строгость.`,
		);
	}
	if (l) return { value: l, from: "line" };
	if (a) return { value: a, from: "asker" };
	return { value: null, from: "default" };
}

/** Combine line and asker strictness PER-KNOB (the amendment): booleans OR,
 *  thresholds MIN, expectedDriver — equal-or-error. Every knob carries its
 *  source so the applied strictness can be printed, not guessed. */
export function combineStrictness(line: ResolvedProfile | null, asker: ResolvedProfile | null): CombinedStrictness {
	return {
		requireExplicitUnit: boolKnob("requireExplicitUnit", line, asker),
		maxAgeDays: minKnob(line, asker),
		expectedDriver: driverKnob(line, asker),
		checkCwd: boolKnob("checkCwd", line, asker),
		lineProfile: line ? line.name : null,
		askerProfile: asker ? asker.name : null,
	};
}

/** Why a found link was deemed suspicious (issue #15, П-4). */
export interface SuspiciousReason {
	reason: "stale" | "driver" | "cwd";
	/** Names the rule, the measurement AND the threshold — the reader must see
	 *  BY WHICH RULE the link was rejected (the issue's demand). */
	message: string;
	/** Knob source that fired, for machine consumers. */
	source: "line" | "asker" | "line+asker";
}

/** Check a FOUND link against the combined strictness (П-4). The link itself is
 *  VALID — the outcome must read "rejected by rule", never "corrupt": a reader
 *  who mistakes this for store rot goes to fix the wrong thing. */
export function suspiciousReason(
	h: { driver: string; cwd: string; createdAt: string; committedAt?: string },
	c: CombinedStrictness,
	readerCwd: string,
	now: Date = new Date(),
): SuspiciousReason | undefined {
	if (c.maxAgeDays.value != null) {
		const ts = h.committedAt ?? h.createdAt;
		const ageDays = (now.getTime() - Date.parse(ts)) / 86_400_000;
		if (Number.isFinite(ageDays) && ageDays > c.maxAgeDays.value) {
			return {
				reason: "stale",
				source: knobSource(c.maxAgeDays.from),
				message: `возраст ${ageDays.toFixed(1)} сут > порога ${c.maxAgeDays.value} сут (правило: свежесть; источник: ${c.maxAgeDays.from})`,
			};
		}
	}
	if (c.expectedDriver.value && h.driver !== c.expectedDriver.value) {
		return {
			reason: "driver",
			source: knobSource(c.expectedDriver.from),
			message: `driver «${h.driver}» ≠ ожидаемому «${c.expectedDriver.value}» (правило: платформа; источник: ${c.expectedDriver.from})`,
		};
	}
	if (c.checkCwd.value && repoRootOf(h.cwd) !== repoRootOf(readerCwd)) {
		return {
			reason: "cwd",
			source: knobSource(c.checkCwd.from),
			message: `линк описывает «${h.cwd}», а читатель в «${readerCwd}» (правило: репозиторий; источник: ${c.checkCwd.from})`,
		};
	}
	return undefined;
}

function knobSource(from: Knob<unknown>["from"]): "line" | "asker" | "line+asker" {
	return from === "default" ? "line" : from;
}
