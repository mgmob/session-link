/**
 * /session-link-graph — render the store as a graph of links and parent edges
 * (contract §9). No deps: plain Mermaid text to stdout; rendering a picture is
	 * `parent` reference (§2.5, ancestor-in-time) and the `partOf` reference (decomposition,
	 *  a separate axis). External targets (v1 / cross-store, not in this
 * store) are shown as leaf nodes so the topology is still visible.
 */
import * as fs from "node:fs";
import * as path from "node:path";

import { readHandoff } from "./handoff.ts";
import { headPath, unitDir } from "./store.ts";
import type { HandoffV2 } from "./types.ts";

interface GraphNode {
	id: string;
	unit: string;
	seq: number;
	link: HandoffV2;
}

/** Collect every v2 link in the store (head + archives) keyed by id. */
function collectNodes(store: string): Map<string, GraphNode> {
	const nodes = new Map<string, GraphNode>();
	let dirs: fs.Dirent[];
	try {
		dirs = fs.readdirSync(store, { withFileTypes: true });
	} catch {
		return nodes;
	}
	for (const e of dirs) {
		if (!e.isDirectory() || e.name === "incoming") continue;
		const unit = e.name;
		const dir = unitDir(store, unit);
		let files: string[];
		try {
			files = fs.readdirSync(dir);
		} catch {
			continue;
		}
		const candidates = files.filter((f) => f === "handoff.json" || /^handoff-.*\.json$/.test(f));
		for (const f of candidates) {
			const link = readHandoff(path.join(dir, f));
			if (link && link.schema === "session-link/handoff/v2") {
				const v2 = link as HandoffV2;
				nodes.set(v2.id, { id: v2.id, unit: v2.unit, seq: v2.seq, link: v2 });
			}
		}
	}
	return nodes;
}

/** Mermaid-safe node id (alphanumeric + underscore). */
function nodeKey(id: string): string {
	return "L" + id.replace(/[^a-zA-Z0-9]/g, "_");
}

/** Render the store as a Mermaid `graph TD`. */
export function renderGraph(store: string): string {
	const nodes = collectNodes(store);
	const lines: string[] = ["graph TD"];

	if (nodes.size === 0) {
		lines.push("  empty[\"(no v2 lines in store)\"]");
		return lines.join("\n") + "\n";
	}

	const keys = [...nodes.keys()].sort();
	for (const id of keys) {
		const n = nodes.get(id)!;
		lines.push(`  ${nodeKey(id)}["${n.unit}:${n.seq}"]`);
	}

	const declaredExternal = new Set<string>();
	for (const id of keys) {
		const parent = nodes.get(id)!.link.parent;
		if (!parent) continue;
		const inGraph = nodes.has(parent.id);
		const targetKey = nodeKey(parent.id);
		if (!inGraph && !declaredExternal.has(parent.id)) {
			const label = parent.unit ?? "external";
			lines.push(`  ${targetKey}("${label}\\n(external / v1)")`);
			declaredExternal.add(parent.id);
		}
		lines.push(`  ${nodeKey(id)} --> ${targetKey}`);
	}

	// "Part-of" edges (decomposition) — separate axis from parent (ancestor-in-time).
	const declaredPartExternal = new Set<string>();
	for (const id of keys) {
		const partOf = nodes.get(id)!.link.partOf;
		if (!partOf) continue;
		const inGraph = nodes.has(partOf.id);
		const targetKey = nodeKey(partOf.id);
		if (!inGraph && !declaredPartExternal.has(partOf.id)) {
			const label = partOf.unit ?? "external";
			lines.push(`  ${targetKey}("${label}\\n(part-of, external)")`);
			declaredPartExternal.add(partOf.id);
		}
		lines.push(`  ${nodeKey(id)} -. part-of .-> ${targetKey}`);
	}

	return lines.join("\n") + "\n";
}
