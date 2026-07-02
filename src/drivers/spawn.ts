import { spawn, type ChildProcess, type SpawnOptions } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";

/**
 * Spawn a binary by name (e.g. "pi"), resolving PATH + PATHEXT ourselves on
 * Windows so the global npm shim (`pi.cmd`) is found WITHOUT a shell.
 *
 * Why no shell: the headless resume argv may carry user-derived values (e.g.
 * a session path). With a shell they would be interpolated into a command line
 * and re-interpreted (injection). Instead we resolve the absolute path of the
 * binary ourselves and pass every argument as a real argv element. (The wrapped
 * QUESTION itself is delivered via STDIN, not argv — see drivers/index.ts.)
 *
 * On Windows a `.cmd`/`.bat` shim still has to run through `cmd.exe`, so we
 * reproduce cross-spawn's verbatim-argument escaping (based on
 * https://qntm.org/cmd) — every arg is escaped so cmd.exe leaves it literal.
 *
 * This is self-contained (no external dependency): pi loads this `.ts` from the
 * installed package location, where a freshly cloned git cache has no
 * `node_modules`. Keeping the package dependency-free (peer deps only) means it
 * loads everywhere, including `pi -e git:...`.
 */

const IS_WIN = process.platform === "win32";

/** The PATH env key actually present in `env` (Windows is case-insensitive). */
function pathEnvKey(env: NodeJS.ProcessEnv): string {
	if (Object.prototype.hasOwnProperty.call(env, "PATH")) return "PATH";
	if (Object.prototype.hasOwnProperty.call(env, "Path")) return "Path";
	return "PATH";
}

/** Split the PATH of `env` into directories. */
function pathDirs(env: NodeJS.ProcessEnv): string[] {
	const v = env[pathEnvKey(env)];
	return v ? String(v).split(path.delimiter).filter(Boolean) : [];
}

/** Candidate executable extensions on Windows (PATHEXT); empty on POSIX. */
function pathExts(env: NodeJS.ProcessEnv): string[] {
	if (!IS_WIN) return [""];
	const pe = env.PATHEXT || env.PathExt || ".COM;.EXE;.BAT;.CMD;.VBS;.JS;.WS;.MSC";
	return String(pe).split(";").filter(Boolean);
}

/** True for a real executable that Node can spawn directly (no cmd.exe shim). */
function isExecutable(p: string): boolean {
	return /\.(?:com|exe)$/i.test(p);
}

/** Resolve a command (bare name or a path) to an absolute path on Windows, applying PATHEXT. */
function resolveWindows(command: string, env: NodeJS.ProcessEnv, cwd: string): string | undefined {
	const exts = pathExts(env);
	const tryWithExt = (base: string): string | undefined => {
		if (fs.existsSync(base)) return base;
		for (const ext of exts) {
			const candidate = base + ext;
			if (fs.existsSync(candidate)) return candidate;
		}
		return undefined;
	};
	if (/[\\/]/.test(command)) {
		// Looks like a path (has a separator); resolve relative to cwd.
		return tryWithExt(path.resolve(cwd, command));
	}
	// Bare name: search every PATH dir.
	for (const dir of pathDirs(env)) {
		const resolved = tryWithExt(path.resolve(dir, command));
		if (resolved) return resolved;
	}
	return undefined;
}

// --- cmd.exe verbatim escaping (https://qntm.org/cmd, same approach cross-spawn uses) ---

const META_CHARS = /([()\][%!^"`<>&|;, *?])/g;

/** Escape a command/script path for a cmd.exe verbatim command line. */
function escapeCommand(arg: string): string {
	return arg.replace(META_CHARS, "^$1");
}

/** Escape a single argument for a cmd.exe verbatim command line. */
function escapeArgument(arg: string): string {
	arg = `${arg}`;
	// Backslashes right before a double quote: double them, then escape the quote.
	arg = arg.replace(/(?=(\\+?)?)\1"/g, '$1$1\\"');
	// Trailing backslashes (the arg will be wrapped in a quote next): double them.
	arg = arg.replace(/(?=(\\+?)?)\1$/, "$1$1");
	// Wrap in quotes, then escape cmd meta chars.
	arg = `"${arg}"`;
	return arg.replace(META_CHARS, "^$1");
}

/**
 * Spawn a binary. On Windows, resolves it via PATH+PATHEXT and runs a `.cmd`/
 * `.bat` shim through cmd.exe with verbatim-escaped arguments. On POSIX, defers
 * to Node's normal PATH lookup. Returns a ChildProcess exactly like `spawn`.
 */
export function spawnBin(command: string, args: string[], options: SpawnOptions = {}): ChildProcess {
	if (IS_WIN) {
		const env = (options.env as NodeJS.ProcessEnv | undefined) || process.env;
		const cwd = options.cwd ? path.resolve(String(options.cwd)) : process.cwd();
		const resolved = resolveWindows(command, env, cwd);

		if (resolved && isExecutable(resolved)) {
			// A real .exe/.com: spawn directly, no shell needed.
			return spawn(resolved, args, options);
		}
		if (resolved) {
			// A .cmd/.bat/... shim: must go through cmd.exe. Escape the script path
			// and every argument verbatim so cmd.exe does not re-interpret them.
			const shellCommand = [escapeCommand(path.normalize(resolved)), ...args.map((a) => escapeArgument(a))].join(" ");
			return spawn(process.env.ComSpec || "cmd.exe", ["/d", "/s", "/c", `"${shellCommand}"`], {
				...options,
				windowsVerbatimArguments: true,
				windowsHide: options.windowsHide ?? true,
			});
		}
		// Not found: fall through to a plain spawn so Node emits an 'error' event
		// with code ENOENT (the caller formats a helpful message).
	}
	return spawn(command, args, options);
}
