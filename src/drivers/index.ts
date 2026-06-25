import type { ChildProcess } from "node:child_process";
import { spawnBin } from "./spawn.ts";
import type { AskRequest, AskResult, DriverName, Handoff, SessionDriver } from "../types.ts";
import { parseResponse, wrapQuestion } from "../clarify.ts";
import { piDriver } from "./pi.ts";
import { claudeCodeDriver } from "./claude-code.ts";
import { qwenDriver } from "./qwen.ts";

/** Registered output parsers, keyed by driver name. */
const DRIVERS: Record<DriverName, SessionDriver> = {
	pi: piDriver,
	"claude-code": claudeCodeDriver,
	qwen: qwenDriver,
};

const QUESTION_PLACEHOLDER = "{QUESTION}";

interface Captured {
	stdout: string;
	stderr: string;
	exitCode: number | null;
}

/** Spawn a process, capture stdout/stderr, honor a timeout and an optional abort signal. */
function runCapture(
	cmd: string,
	args: string[],
	opts: { cwd: string; timeoutMs: number; signal?: AbortSignal },
): Promise<Captured> {
	return new Promise((resolve, reject) => {
		const child = spawnBin(cmd, args, { cwd: opts.cwd, env: process.env, stdio: ["ignore", "pipe", "pipe"] });
		let stdout = "";
		let stderr = "";
		let settled = false;
		let timedOut = false;

		const cleanup = () => {
			if (timer) clearTimeout(timer);
			if (opts.signal) opts.signal.removeEventListener("abort", onAbort);
		};
		const onAbort = () => {
			killChild(child);
		};
		const timer = setTimeout(() => {
			timedOut = true;
			killChild(child);
		}, opts.timeoutMs);

		if (opts.signal?.aborted) {
			settled = true;
			cleanup();
			reject(new Error(`Aborted before spawning '${cmd}'`));
			return;
		}
		if (opts.signal) opts.signal.addEventListener("abort", onAbort);

		child.stdout!.on("data", (d) => {
			stdout += d;
		});
		child.stderr!.on("data", (d) => {
			stderr += d;
		});
		child.on("error", (err: any) => {
			if (settled) return;
			settled = true;
			cleanup();
			if (err && err.code === "ENOENT") {
				reject(new Error(enoentMessage(cmd, err)));
			} else {
				reject(new Error(`Failed to spawn '${cmd}': ${err?.message ?? err}`));
			}
		});
		child.on("close", (code) => {
			if (settled) return;
			settled = true;
			cleanup();
			if (timedOut) {
				return reject(
					new Error(`Previous-session query timed out after ${Math.round(opts.timeoutMs / 1000)}s. stderr: ${stderr.slice(0, 1500)}`),
				);
			}
			// pi (json mode) exits 0 even on some agent errors; rely on parsing. Only fail
			// hard on non-zero exit with no stdout to show.
			if (code !== null && code !== 0 && !stdout) {
				return reject(new Error(`'${cmd}' exited with code ${code}. stderr: ${stderr.slice(0, 1500)}`));
			}
			resolve({ stdout, stderr, exitCode: code });
		});
	});
}

/** Build a helpful message for ENOENT (binary not on PATH / wrong Windows shim). */
function enoentMessage(cmd: string, err: any): string {
	const hint =
		process.platform === "win32"
			? "On Windows the global npm shim is 'pi.cmd' (not 'pi.exe'). Resolution now applies PATHEXT, " +
				"so this usually means the binary is genuinely not on PATH in this process's environment " +
				"(e.g. pi is installed for a different shell/user). Point SESSION_LINK_PI_BIN (or PI_BIN) at " +
				"the absolute path of the shim — find it with `where pi` (e.g. ...\\pi.cmd)."
			: "The binary is not on PATH in this process's environment. Set SESSION_LINK_PI_BIN (or PI_BIN) " +
				"to its absolute path, or ensure it is installed for this user.";
	return (
		`Cannot run '${cmd}': executable not found (ENOENT).\n` +
		`${hint}\n` +
		`Verify in a shell first: '${cmd} --version'. (Original error: ${err?.message ?? err})`
	);
}

function killChild(child: ChildProcess) {
	try {
		child.kill("SIGTERM");
	} catch {
		// ignore
	}
	setTimeout(() => {
		try {
			child.kill("SIGKILL");
		} catch {
			// ignore
		}
	}, 2000);
}

/** Build the argv to resume + query the previous session headlessly. */
function buildArgv(handoff: Handoff, wrappedQuestion: string): string[] {
	const tpl = handoff.askCommand && handoff.askCommand.length > 0
		? handoff.askCommand
		: ["pi", "--mode", "json", handoff.sessionRef ? "--session" : "", handoff.sessionRef, QUESTION_PLACEHOLDER].filter(
				Boolean,
			);
	return tpl.map((a) => (a === QUESTION_PLACEHOLDER ? wrappedQuestion : a));
}

function parseOutput(driver: DriverName, raw: string): string {
	const d = DRIVERS[driver] ?? DRIVERS.pi;
	return d.parseOutput(raw);
}

/** Run a full query round against the linked session. */
export async function querySession(req: AskRequest): Promise<AskResult> {
	const wrapped = wrapQuestion(req.question, req.clarifications, req.handoff.language);
	const argv = buildArgv(req.handoff, wrapped);
	const cmd = argv[0];
	const args = argv.slice(1);

	const captured = await runCapture(cmd, args, {
		cwd: req.handoff.cwd || process.cwd(),
		timeoutMs: req.timeoutMs,
		signal: req.signal,
	});

	const text = parseOutput(req.handoff.driver, captured.stdout);
	const parsed = parseResponse(text);
	const result: AskResult = {
		kind: parsed.kind,
		text: parsed.text,
		raw: text,
		driver: req.handoff.driver,
	};
	if (captured.stderr && captured.stderr.trim().length > 0) {
		result.stderr = captured.stderr.trim().slice(0, 4000);
	}
	return result;
}
