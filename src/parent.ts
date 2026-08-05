/**
 * Ancestor resolution + chain walk (contract §2.5).
 *
 * The ancestor link is stored as IDENTITY, not location: an immutable `id` plus a
 * structural `parent {id, unit?, seq?, store?}`. Resolution tries, in order:
 *   1. `<store>/<parent.unit>/handoff-<parent.id>.json` — one FS hop using the hint;
 *   2. scan the OTHER `<unit>/` dirs for `handoff-<parent.id>.json` — handles a
 *      rename (dir name changed, id did not) without rewriting anything;
 *   3. if `parent.store` is set, run steps 1–2 there; a `MOVED-TO.txt` on that
 *      path is followed transparently (a marker meant for humans, reused as a
 *      redirect) and the search repeats;
 *   4. `parentHandoffPath` — legacy v1 chains / last resort;
 *   5. honest miss with the `id` and the last tried path.
 *
 * Lives in its own module (not store.ts) to avoid an import cycle:
 * handoff.ts → store.ts, and this module needs both readHandoff (handoff.ts) and
 * movedToPath (store.ts).
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { readHandoff } from "./handoff.ts";
import { movedToPath } from "./store.ts";
import type { Handoff, HandoffV2, ParentRef } from "./types.ts";

export type ParentResolveVia = "direct" | "scan" | "cross-store" | "legacy-path";

export interface ParentFound {
	kind: "found";
	/** Absolute path to the resolved archive. */
	path: string;
	/** Store root where the ancestor was actually found (may differ from the
	 *  starting store after a cross-store hop — the walk follows into it). */
	store: string;
	via: ParentResolveVia;
	/** Path to the MOVED-TO.txt that was followed, if resolution needed a redirect (§2.5 step 3). */
	movedTo?: string;
}

export interface ParentNotFound {
	kind: "notFound";
	id: string;
	/** Last path we tried — for the honest "not found" message (§2.5 step 5). */
	lastTriedPath?: string;
}

export type ResolveParentResult = ParentFound | ParentNotFound;

export interface ResolveParentOptions {
	/** Legacy / last-resort hint from the referring link's `parentHandoffPath` (§2.5 step 4). */
	hintPath?: string;
}

/** Cap on chained MOVED-TO redirects — a marker must not send us into a spin. */
const MAX_MOVED_HOPS = 4;

/**
 * Resolve a `parent` reference against a store (§2.5, five steps).
 * `store` is the store the referring link lives in; cross-store ancestors are
 * reached via `parent.store`.
 */
export function resolveParent(parent: ParentRef, store: string, opts: ResolveParentOptions = {}): ResolveParentResult {
	const archiveFile = `handoff-${parent.id}.json`;
	const tried: string[] = [];

	// Step 1 — one-shot hit using the unit hint in the current store.
	if (parent.unit) {
		const p = path.join(store, parent.unit, archiveFile);
		tried.push(p);
		if (fs.existsSync(p)) return { kind: "found", path: p, store, via: "direct" };
	}

	// Step 2 — scan the other unit dirs (rename case: dir changed, id didn't).
	const scanned = scanForArchive(store, archiveFile);
	if (scanned) return { kind: "found", path: scanned, store, via: "scan" };

	// Step 3 — cross-store: repeat steps 1–2 in parent.store, following MOVED-TO.
	if (parent.store) {
		let target = parent.store;
		let movedTo: string | undefined;
		for (let hop = 0; hop < MAX_MOVED_HOPS; hop++) {
			const mt = movedToPath(target);
			if (fs.existsSync(mt)) {
				const next = fs.readFileSync(mt, "utf-8").trim();
				// Empty, self-pointing, or unresolvable marker — stop following.
				if (!next || next === target) break;
				movedTo = mt;
				target = next;
				continue;
			}
			if (parent.unit) {
				const p = path.join(target, parent.unit, archiveFile);
				tried.push(p);
				if (fs.existsSync(p)) return { kind: "found", path: p, store: target, via: "cross-store", movedTo };
			}
			const scanned2 = scanForArchive(target, archiveFile);
			if (scanned2) return { kind: "found", path: scanned2, store: target, via: "cross-store", movedTo };
			break;
		}
	}

	// Step 4 — parentHandoffPath (legacy v1 chains / last resort).
	if (opts.hintPath) {
		tried.push(opts.hintPath);
		if (fs.existsSync(opts.hintPath)) return { kind: "found", path: opts.hintPath, store, via: "legacy-path" };
	}

	// Step 5 — honest miss.
	return { kind: "notFound", id: parent.id, lastTriedPath: tried.length ? tried[tried.length - 1] : undefined };
}

/** Scan `<store>/<unit>/handoff-<archiveFile>` across unit dirs; first hit or undefined. */
function scanForArchive(store: string, archiveFile: string): string | undefined {
	let dirs: fs.Dirent[];
	try {
		dirs = fs.readdirSync(store, { withFileTypes: true });
	} catch {
		return undefined;
	}
	for (const e of dirs) {
		if (!e.isDirectory() || e.name === "incoming") continue;
		const candidate = path.join(store, e.name, archiveFile);
		if (fs.existsSync(candidate)) return candidate;
	}
	return undefined;
}

export interface AncestorStep {
	/** Absolute path to the ancestor archive/live file. */
	path: string;
	/** The ancestor handoff itself. */
	link: Handoff;
}

/**
 * Walk the ancestor chain starting from `start` (§2.5), following `parent` (v2)
 * or `parentHandoffPath` (v1) until a link has no parent or resolution honestly
 * fails. `start` itself is NOT included — only its ancestors. The store context
 * follows the walk: a cross-store ancestor is searched from its own store for
 * ITS parent. Visited-path guard prevents cycles.
 */
export function walkAncestors(start: Handoff, store: string): AncestorStep[] {
	const out: AncestorStep[] = [];
	const visited = new Set<string>();
	let current: Handoff | undefined = start;
	let currentStore = store;

	for (let depth = 0; depth < 256 && current; depth++) {
		const parent = (current as HandoffV2).parent;
		const hint = current.parentHandoffPath;

		let nextPath: string | undefined;
		let nextLink: Handoff | undefined;

		if (parent) {
			const r = resolveParent(parent, currentStore, { hintPath: hint });
			if (r.kind !== "found") break;
			nextPath = r.path;
			nextLink = readHandoff(r.path);
			currentStore = r.store; // follow the chain into the ancestor's store
		} else if (hint && fs.existsSync(hint)) {
			nextPath = hint;
			nextLink = readHandoff(hint);
			// v1 chain — currentStore stays; v1 links carry no parent.store to chase.
		} else {
			break;
		}

		if (!nextPath || !nextLink) break;
		if (visited.has(nextPath)) break; // cycle guard
		visited.add(nextPath);
		out.push({ path: nextPath, link: nextLink });
		current = nextLink;
	}

	return out;
}
