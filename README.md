# session-link

A [pi](https://pi.dev) extension that **links sessions** via a context handoff
with a back-channel.

A normal handoff is one-way: the closing session drops a file and the next
session is on its own. `session-link` adds two things:

1. **An agent-authored handoff body** — the closing agent writes *what it
   actually did and decided* into the handoff (not just a transcript of the
   user's messages). The next session starts oriented.
2. **A back-channel** — the next session can **query the previous one** to
   resolve uncertainties, and that conversation accumulates in the previous
   session's real context.

```
  closing session                            next session
  ────────────────                           ─────────────
  /session-link [manual] [note]
   ├─ code writes the handoff ENVELOPE
   │    (sessionRef / askCommand / model / …)
   ├─ authoring turn (in THIS session):        (not started yet)
   │    the agent fills the BODY (goal/summary/
   │    nextStep + optional sections) directly
   │    in handoff.json, then shows the starter
   │    prompt for your review.
   ├─ review is an ordinary chat: open the
   │    handoff file, post remarks → the agent
   │    revises the file → re-present. Loop.
   │    (…or you reopen this session & re-link.)
   └─ /session-link-go ─────────────────────►  started with the starter
       (validates the mandatory spine)          prompt; reads the handoff,
                                                    loads context, resolves
       ▲   session_link({question})             uncertainties via the tool
       │       ◄──────────────────────────────┘
       │
       └──── answer / CLARIFY:  (headless resume, appends to context)
```

`auto` mode skips the review pause and runs the authoring turn →
`/session-link-go` unattended. The default is `manual` (review-first).


## What's new in this version

- **Agent-authored body.** The handoff now carries a structured **body**
  authored by the closing agent, not a copy of your messages:
  - **Mandatory spine**: `goal`, `summary`, `nextStep`. A handoff is "ready" to
    hand off only when the spine is filled (`/session-link-go` validates it).
  - **Optional fields**: `blockers`, `decisions` (with rationale),
    `filesChanged`, `filesToRead`, `environment`, `deliberatelySkipped`.
  - **Free-form `sections`**: the agent owns the section titles, so the same
    schema fits coding, debugging, research, writing, … (e.g. *"Hypotheses ruled
    out"*, *"Sources consulted"*, *"Tests"*).
  The old `topics` (recent user messages) survives only as a fallback when the
  agent never authored a `summary`.
- **Manual-first flow.** `/session-link [manual] [note]` writes the envelope,
  then runs the **authoring turn inside the closing session** — the agent fills
  the body, shows you the **starter prompt** and the **handoff file path**, and
  asks for review. You review (open the file, post remarks → the agent revises
  → re-present) and run **`/session-link-go`** when you're happy. No separate
  review machinery — it's just a chat in the closing session.
- **`/session-link-go`.** Validates the spine, (optionally) warns if a child
  session already started from this handoff (a **fork** is allowed — it's the
  recovery path), then starts the next session with the starter prompt.
- **Chain-safe redo.** `handoff.json` is the only mutable file; the chain only
  ever points at immutable archives. Redoing a handoff from the **same** session
  (by sessionId) overwrites it in place and carries the authored body forward
  (a failed authoring pass never wipes a good summary). A handoff from a
  **different** session archives the old one and advances the chain. This also
  fixes a self-link bug where `parentHandoffPath` used to point at the live file.
- **`auto` mode** keeps doing the whole pipeline unattended (authoring turn →
  wait → validate → start next session) for hands-off handoffs.
- Backwards chain (`parentHandoffPath`), **language preservation**, and the
  **portable driver model** (pi / claude-code / qwen) are unchanged.


## What it gives you

- **`/session-link [auto|manual] [lang=<ru|en|Russian|…>] [note]`** (TUI only) — write the handoff envelope **and** run the authoring turn in the closing session. In `manual` (default) the agent fills the body and asks for review; in `auto` it then validates and starts the next session unattended. The detected conversation language is shown in the notify (override it with `lang=…`, or `SESSION_LINK_LANGUAGE`).
  envelope **and** run the authoring turn in the closing session. In `manual`
  (default) the agent fills the body and asks for review; in `auto` it then
  validates and starts the next session unattended.
- **`/session-link-go`** (TUI only) — start the next session from the current
  handoff. Validates the spine first; warns on a fork. Use it after reviewing.
- **`/session-link-write [lang=<…>] [note]`** (TUI only) — write the envelope + authoring turn, without starting the next session (open the next session yourself, or run `/session-link-go` later).
  turn, without starting the next session (open the next session yourself, or
  run `/session-link-go` later).
- **`/session-link-show`** (any mode) — print the current handoff's path and
  spine status (`ready` / `DRAFT`).
- **`session_link` tool** — the LLM in the next session calls this to query a
  linked session headlessly. Returns an **answer** or a **clarification**
  request. Pass `handoffPath` to follow the chain to an earlier session.
- **`current_session` tool** — lets the agent self-identify.
- **Session-start nudge** — when a new session starts and a handoff is on disk,
  a notice points to it, so a pending handoff can't be forgotten.

The handoff is written to `<project>/.pi/session_link/handoff.json` (+ a
human-readable `handoff.md`, plus timestamped archives of prior handoffs; each
handoff links backwards via `parentHandoffPath`, forming a chain).


## The handoff body

The handoff has two zones:

- **Envelope** (owned by code): `schema`, `createdAt`, `driver`, `sessionRef`,
  `sessionId`, `cwd`, `model`, `language`, `howToAsk`, `askCommand`,
  `parentHandoffPath`. The agent must not edit these.
- **Body** (owned by the closing agent):
  - `goal`, `summary`, `nextStep` — mandatory spine.
  - `blockers`, `decisions` (`{decision, rationale}[]`), `filesChanged`,
    `filesToRead`, `environment`, `deliberatelySkipped` — optional.
  - `sections` (`{title, body, files?}[]`) — optional, free-form; the agent
    chooses the titles to fit the task.

The schema is described to the agent **inside the authoring prompt**, and
`/session-link-go` validates the spine before starting the next session. See
`src/types.ts` for the exact shape.


## How the back-channel works (and why it's portable)

The handoff records an **`askCommand`** — an argv template with a `{QUESTION}`
placeholder — that the *closing* side authors (it knows its own platform's
flags). The next session just substitutes the question and runs it; no guessing.

The **`driver`** field only selects the **output parser**:

| driver | headless invocation (example) | output parsed as |
| --- | --- | --- |
| `pi` | `pi --mode json --session <file> --tools read,grep,find,ls [--model provider/id] "{QUESTION}"` | JSONL events → last assistant text |
| `claude-code` | `claude -p "{QUESTION}" --resume <id> --output-format json` | `{result: "..."}` |
| `qwen` | (verify flags for your `qwen` version; encode in `askCommand`) | plain text |

That separation is what makes the same next-session tool work across platforms:
a Claude Code / Qwen handoff just needs to be authored in the **same JSON
schema** with its own `driver` and `askCommand`. For the Claude Code side
(back-channel command, `CLARIFY:` contract, handoff shape), see
[docs/claude-code-backchannel.md](docs/claude-code-backchannel.md).

### Clarification relay

The previous session runs headlessly — no interactive user. If answering needs a
human, it's instructed to start its reply with `CLARIFY:` followed by its
questions. The tool then returns `kind: "clarification"`; the next session shows
those questions to the user, collects answers, and calls `session_link` again
with `clarifications: [...]`. The previous session sees the whole exchange
because each headless run **appends** to its session file (`pi --session <file>`).


## Install

From the GitHub repo:

**Prerequisites:** Node.js `>= 22.19.0` (same minimum the pi core packages
require; they're pulled in as peer dependencies).

```bash
pi install git:github.com/mgmob/session-link
# or try it without installing:
pi -e git:github.com/mgmob/session-link
```

`pi` loads the TypeScript directly — there is no build step. The pi core
packages and `typebox` are `peerDependencies` (provided by your pi installation).

> Seeing `npm warn EBADENGINE ... required: { node: '>=22.19.0' }` during
> install? The system Node.js is too old — upgrade Node to a current 22.x
> (`>= 22.19.0`, e.g. via nvm/fnm) and the warnings disappear. They're warnings,
> not errors (install still completes), but pi targets that Node.


## Environment knobs

| var | default | meaning |
| --- | --- | --- |
| `SESSION_LINK_TIMEOUT_MS` | `300000` (5 min) | per-query timeout |
| `SESSION_LINK_PI_TOOLS` | `read,grep,find,ls` | tools the resumed previous session may use (read-only by default; also excludes our own tools, which breaks recursion) |
| `SESSION_LINK_PI_BIN` / `PI_BIN` | `pi` | the pi binary used for headless resume. Resolved via PATH + `PATHEXT` by the extension itself (so the global npm shim `pi` / `pi.cmd` is found on Windows too). If the shim is genuinely off PATH in the process, set this to its absolute path. |
| `SESSION_LINK_DEFAULT_MODE` | `manual` | default start mode when `/session-link` is called without an explicit `auto`/`manual` argument. Set to `auto` for hands-off handoffs. |
| `SESSION_LINK_LANGUAGE` | *(auto-detect)* | force the conversation language carried into the next session (e.g. `Russian`). By default the language is detected from the closing session's recent **real** user messages by one-message-one-vote (commands and code-injected authoring/starter prompts are excluded, so a long English prompt never outweighs several short user messages). A `lang=` argument to `/session-link` overrides this for one run. |


## Typical session

**Closing session** (in your project):

```
# default (manual): the agent authors the body, shows the starter prompt + path,
# you review, then /session-link-go starts the next session.
/session-link lang=ru finishing the auth refactor; tests in tests/auth still red
```

→ writes the envelope and runs the authoring turn **in this session**. The agent
fills `goal`/`summary`/`nextStep` (+ any optional fields/sections that matter)
into `.pi/session_link/handoff.json`, shows you the **starter prompt** and the
file path, and asks for review. Open the file; if you want changes, post them as
a message — the agent revises the same file and re-presents. When you're happy:

```
/session-link-go
```

→ starts the next session with the starter prompt. The new agent reads the
handoff (its body IS the context), reports understanding, and — only if
something real is missing — queries the previous session headlessly; when
satisfied, it reports "context accepted" and waits.

Hands-off variant: `/session-link auto [note]` does the authoring turn, waits,
validates the spine, and starts the next session without pausing for review.

**Recovery / redo.** If the next session went the wrong way: close it, reopen the
**previous** session (`/resume` / `/tree`), and run `/session-link` again — it
overwrites the handoff in place (same session) and starting again simply forks a
new branch. Nothing in the chain is corrupted.


## Status / caveats

- **pi driver**: implemented and exercised against `pi --mode json`.
- **claude-code driver**: best-effort JSON-result parsing; author the handoff
  from the Claude Code side with `driver: "claude-code"` and a working
  `askCommand`.
- **qwen driver**: plain-text parser; **verify** `qwen`'s non-interactive resume
  flags for your version before relying on it (see `src/drivers/qwen.ts`).
- The resumed previous session is restricted to read-only tools by default to
  keep "answering questions" safe and side-effect-free; broaden via
  `SESSION_LINK_PI_TOOLS` if you trust it to investigate.
- **Windows**: works. The headless resume resolves PATH and `PATHEXT` itself (so
  `pi` finds `pi.cmd`) and runs a `.cmd`/`.bat` shim through `cmd.exe` with
  verbatim-escaped arguments — `{QUESTION}` is passed as a real argv element,
  never interpolated into a shell string. This is self-contained: there are no
  runtime `dependencies` (only `peerDependencies` provided by pi), so the package
  loads from a git cache with no `node_modules`. If you still see an `ENOENT`
  from `session_link`, the binary isn't on PATH for that process; point
  `SESSION_LINK_PI_BIN` at the absolute `pi.cmd` (find it with `where pi`).
