/**
 * Generate the synthetic v1 handoff chain under tests/fixtures/v1-chain/.
 *
 * Run on demand:  node tests/fixtures/v1-chain/generate.mjs
 * Output is committed (regenerate only when the v1 shape changes).
 *
 * The chain is produced by the REAL `writeHandoff` v1 (src/handoff.ts) so it
 * mirrors exactly what v0.1.0 writes on disk: head + N archives, each new
 * sessionId archiving the previous head. The only post-processing is making
 * `parentHandoffPath` portable: the live writer stores an absolute tmp path,
 * which would be machine-specific and break on commit. We rewrite it to the
 * basename of the archive sitting right next to it, keeping the chain
 * self-consistent within the fixture directory. That deviation is fine for a
 * read-fixture (we test parsing + chain contiguity, never path semantics).
 */
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { writeHandoff } from "../../../src/handoff.ts";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "v1chain-gen-"));

// Four links of one line (`unit` does not exist in v1; the line identity is
// implicit). Same `goal` across the chain, different `sessionId` each step so
// every write archives the previous head. Fixed timestamps → deterministic
// archive names → stable git diffs.
const SESSIONS = [
	{
		n: 1,
		id: "11111111-1111-4111-8111-111111111111",
		createdAt: "2026-07-01T09:00:00.000Z",
		summary: "Заведён репозиторий, базовая структура каталогов, README и tsconfig.",
		nextStep: "Описать схему данных и завести миграции.",
	},
	{
		n: 2,
		id: "22222222-2222-4222-8222-222222222222",
		createdAt: "2026-07-01T10:00:00.000Z",
		summary: "Схема данных описана, добавлены миграции, indexer читает конфиг.",
		nextStep: "Реализовать чтение конфигурации (YAML + ENV).",
	},
	{
		n: 3,
		id: "33333333-3333-4333-8333-333333333333",
		createdAt: "2026-07-01T11:00:00.000Z",
		summary: "Чтение конфигурации работает; тестов пока нет.",
		nextStep: "Добавить интеграционный тест на чтение конфига.",
	},
	{
		n: 4,
		id: "44444444-4444-4444-8444-444444444444",
		createdAt: "2026-07-01T12:00:00.000Z",
		summary: "Интеграционный тест зелёный. Конфиг читается из YAML и ENV, ошибки валидируются.",
		nextStep: "Перейти к слою хранилища: store repo-scoped.",
	},
];

function build(s) {
	return {
		schema: "session-link/handoff/v1",
		createdAt: s.createdAt,
		driver: "pi",
		sessionRef: `/home/omr/.pi/agent/sessions/${s.id}.jsonl`,
		sessionId: s.id,
		sessionName: `omr-foundation-${s.n}`,
		cwd: "/home/omr/projects/omr",
		model: "zai-coding-cn/glm-5.2",
		howToAsk:
			`printf '%s' "<your question>" | pi --mode json --session ` +
			`/home/omr/.pi/agent/sessions/${s.id}.jsonl ` +
			`--tools read,grep,find,ls --model zai-coding-cn/glm-5.2`,
		askCommand: [
			"pi",
			"--mode",
			"json",
			"--session",
			`/home/omr/.pi/agent/sessions/${s.id}.jsonl`,
			"--tools",
			"read,grep,find,ls",
			"--model",
			"zai-coding-cn/glm-5.2",
		],
		language: "Russian",
		goal: "Подвести фундамент проекта OMR: репозиторий, схема данных, конфигурация.",
		summary: s.summary,
		nextStep: s.nextStep,
		sessionTitle: `OMR: фундамент #${s.n}`,
		decisions:
			s.n === 1
				? [{ decision: "Стек: Node 22 + TypeScript + node:test", rationale: "Знаком команде; встроенный test-runner, новых зависимостей нет." }]
				: undefined,
		filesChanged: s.n === 4 ? ["src/config.ts", "tests/config.test.ts"] : undefined,
		filesToRead: ["src/config.ts", "README.md"],
		environment: [`Node v22.23.2`, "OS: Linux x86_64"],
	};
}

try {
	for (const s of SESSIONS) {
		writeHandoff(TMP, build(s));
	}

	const srcDir = path.join(TMP, ".pi", "session_link");
	const jsonFiles = fs.readdirSync(srcDir).filter((f) => f.endsWith(".json"));

	// Clear a previous generation (handoff*.json only — leave this script intact).
	for (const f of fs.readdirSync(HERE)) {
		if (f.startsWith("handoff") && f.endsWith(".json")) {
			fs.rmSync(path.join(HERE, f), { force: true });
		}
	}

	for (const f of jsonFiles) {
		const obj = JSON.parse(fs.readFileSync(path.join(srcDir, f), "utf-8"));
		// Make the parent link portable: archive sits next to this file in the fixture.
		if (obj.parentHandoffPath) obj.parentHandoffPath = path.basename(obj.parentHandoffPath);
		fs.writeFileSync(path.join(HERE, f), JSON.stringify(obj, null, 2) + "\n", "utf-8");
	}

	console.log(
		`generated ${jsonFiles.length} files in ${path.relative(process.cwd(), HERE) || "."}:`,
		jsonFiles.sort().join(", "),
	);
} finally {
	fs.rmSync(TMP, { recursive: true, force: true });
}
