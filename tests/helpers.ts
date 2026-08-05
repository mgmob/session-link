/**
 * Shared test helpers.
 *
 * Э0 keeps the surface tiny on purpose — later stages add git/store/lock
 * helpers as the invariants demand them. No external deps: `node:test`,
 * `node:assert`, `node:fs` only.
 */
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

const TESTS_DIR = path.dirname(fileURLToPath(import.meta.url));
export const FIXTURES_DIR = path.join(TESTS_DIR, "fixtures");

/** Absolute path to a fixture subdir under tests/fixtures. */
export function fixturePath(name: string): string {
	return path.join(FIXTURES_DIR, name);
}

/**
 * Create a fresh empty tmp directory and return its absolute path.
 * The caller owns cleanup (typically `afterEach(() => rmrf(dir))`).
 */
export function tmpProject(prefix = "session-link-test-"): string {
	return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

/** Recursive rm -rf; never throws (best-effort cleanup in afterEach). */
export function rmrf(p: string): void {
	try {
		fs.rmSync(p, { recursive: true, force: true });
	} catch {
		// best-effort
	}
}

/** Read + JSON.parse a file; throws on missing/corrupt (tests want hard failures). */
export function readJson<T = unknown>(p: string): T {
	return JSON.parse(fs.readFileSync(p, "utf-8")) as T;
}
