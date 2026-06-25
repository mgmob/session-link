# session-link

A [pi](https://pi.dev) extension that **links sessions** via a context handoff
with a back-channel.

A normal handoff is one-way: the closing session drops a file and the next
session is on its own. `session-link` adds the missing direction — the next
session can **query the previous one** to resolve uncertainties, and the
conversation accumulates in the previous session's real context.

```
  closing session                         next session
  ────────────────                         ─────────────
  /session-link auto ──►  handoff.json  ──►  agent runs: reads handoff,
  "note"                                   loads context, lists uncertainties,
       ▲                                   resolves each via session_link
       │                                            │
       │   session_link({question})  ◄──────────────┘
       │                                            │
       └──── answer  /  CLARIFY:  ────────────────►  narrates to user,
           (headless resume,                        "context accepted"
            appends to context)
```
*(The diagram shows the `auto` path, where the new session runs the whole acceptance flow on its own. The default is `manual`, which pauses at the editable draft for your review.)*


## What's new in this version

Earlier prototype was called `ask-prev-session` (command `/askprev`, tool
`ask_prev_session`, folder `.pi/ask_prev_session/`). This version:

- **Renamed** everything to `session-link` — package, command (`/session-link`),
  tool (`session_link`), handoff folder (`.pi/session_link/`), handoff schema
  (`session-link/handoff/v1`), and env vars (`SESSION_LINK_*`).
- **Auto-start vs. manual review.** `/session-link` now takes an optional leading
  mode:
  - **`/session-link auto [note]`** — the new session runs context-acceptance
    immediately (reads the handoff, and — only if anything is unclear —
    queries the previous session on its own).
  - **`/session-link manual [note]`** — the acceptance task is left as an
    editable draft in the editor; you review the handoff + prompt and press
    **Enter** to start. This is the cautious default.
  - **`/session-link [note]`** (no mode) — uses the default (see below).
- **Cautious default = `manual`.** Auto kicks off an irreversible pipeline
  (tokens spent reading files + headless queries of the previous session);
  manual gives you a last-chance review. Override globally with
  `SESSION_LINK_DEFAULT_MODE=auto`.
- **Backwards chain.** Each handoff records `parentHandoffPath`; the `session_link`
  tool's `handoffPath` parameter lets you query any earlier linked session, not
  just the immediate parent.
- **Language preservation.** The conversation language is auto-detected from the closing session's recent user messages and recorded in the handoff (`language`). The new session is instructed to keep talking to you in that language (it no longer silently defaults to English just because the preload prompt is in English), and headless replies from the previous session come back in it too. Override with `SESSION_LINK_LANGUAGE`.
- No build step; pi loads the `.ts` directly (unchanged).

## What it gives you

- **`/session-link [auto|manual] [note]`** — write a handoff **and** start the
  next session. This command requires interactive **TUI** mode (the two below,
  `/session-link-write` and `/session-link-show`, work in any mode). In `auto`
  the new agent immediately self-identifies, reads the handoff + referenced
  files, reports understanding, and — if there are any uncertainties —
  resolves them by querying the previous session; if the new session can't receive an
  auto-submitted message directly, the task falls back to an editable draft
  exactly like `manual`. In `manual` (default) the same task waits as a draft in
  the editor — review it, then press Enter.
- **`/session-link-write [note]`** — write the handoff only (two-step workflow).
- **`/session-link-show`** — print the current handoff's status.
- **`session_link` tool** — the LLM in the next session calls this to query a
  linked session headlessly. Returns an **answer** or a **clarification** request.
  Pass `handoffPath` to follow the chain to an earlier linked session.
- **`current_session` tool** — lets the agent self-identify: returns its session
  id, file path, cwd, and (if present) the path to the active handoff.
- **Session-start nudge.** When a new session starts and a handoff is already on
  disk, a notice points you to it ("Handoff available from a previous session…
  Read it, or run `/session-link-show`"), so a pending handoff can't be
  forgotten even if you opened the new session yourself.
- **Language preservation** — the conversation language is detected from the
  closing session's recent user messages (script-based: Latin→English, Cyrillic→Russian,
  CJK→Chinese, …) and stored in the handoff. The new session is told explicitly to
  keep talking to you in that language, and headless replies from the previous session
  come back in it too. Override the auto-detection with `SESSION_LINK_LANGUAGE`.

The handoff is written to `<project>/.pi/session_link/handoff.json`
(+ a human-readable `handoff.md`, plus timestamped archives of prior handoffs;
each handoff links backwards via `parentHandoffPath`, forming a chain).

## How the back-channel works (and why it's portable)

The handoff records an **`askCommand`** — an argv template with a `{QUESTION}`
placeholder — that the *closing* side authors (it knows its own platform's flags).
The next session just substitutes the question and runs it; no guessing.

The **`driver`** field only selects the **output parser**:

| driver | headless invocation (example) | output parsed as |
| --- | --- | --- |
| `pi` | `pi --mode json --session <file> --tools read,grep,find,ls [--model provider/id] "{QUESTION}"` | JSONL events → last assistant text |
| `claude-code` | `claude -p "{QUESTION}" --resume <id> --output-format json` | `{result: "..."}` |
| `qwen` | (verify flags for your `qwen` version; encode in `askCommand`) | plain text |

That separation is what makes the same next-session tool work across platforms:
a Claude Code / Qwen handoff just needs to be authored in the **same JSON
schema** (see `src/types.ts`) with its own `driver` and `askCommand`. Authoring
those handoffs from inside Claude Code / Qwen (a hook or slash command) is the
portable follow-up; this package ships the pi side fully working.

### Clarification relay

The previous session runs headlessly — no interactive user. If answering needs a
human, it's instructed to start its reply with `CLARIFY:` followed by its
questions. The tool then returns `kind: "clarification"`; the next session shows
those questions to the user, collects answers, and calls `session_link` again
with `clarifications: [...]`. The previous session sees the whole exchange
because each headless run **appends** to its session file (`pi --session <file>`).

## Install

From the GitHub repo:

**Prerequisites:** Node.js `>= 22.19.0` (same minimum the pi core packages require;
they're pulled in as peer dependencies).

```bash
pi install git:github.com/mgmob/session-link
# or try it without installing:
pi -e git:github.com/mgmob/session-link
```

`pi` loads the TypeScript directly — there is no build step. The pi core packages
and `typebox` are `peerDependencies` (provided by your pi installation).

> Seeing `npm warn EBADENGINE ... required: { node: '>=22.19.0' }` during install?
> The system Node.js is too old — the warning prints the current version right next
> to the required one. Upgrade Node to a current 22.x (`>= 22.19.0`, e.g. via nvm/fnm)
> and the warnings disappear. They're warnings, not errors (install still completes),
> but pi targets that Node, so don't stay on an older one.

## Environment knobs

| var | default | meaning |
| --- | --- | --- |
| `SESSION_LINK_TIMEOUT_MS` | `300000` (5 min) | per-query timeout |
| `SESSION_LINK_PI_TOOLS` | `read,grep,find,ls` | tools the resumed previous session may use (read-only by default; also excludes our own tools, which breaks recursion) |
| `SESSION_LINK_PI_BIN` / `PI_BIN` | `pi` | the pi binary used for headless resume. Resolved via `cross-spawn`, so the global npm shim (`pi` / `pi.cmd` / `pi.ps1`) is found on Windows too. If the shim is genuinely off PATH in the process, set this to its absolute path. |
| `SESSION_LINK_DEFAULT_MODE` | `manual` | default start mode when `/session-link` is called without an explicit `auto`/`manual` argument. Set to `auto` for hands-off handoffs. |
| `SESSION_LINK_LANGUAGE` | *(auto-detect)* | force the conversation language carried into the next session (e.g. `Russian`). By default it is detected from the closing session's recent user messages. |

## Typical session

**Closing session** (in your project):

```
# cautious (default): review the draft, then press Enter
/session-link finishing the auth refactor; tests in tests/auth still red

# or hands-off: the next session runs acceptance immediately
/session-link auto finishing the auth refactor; tests in tests/auth still red
```

→ writes `.pi/session_link/handoff.json` and opens a fresh session. In `auto`
(or if `SESSION_LINK_DEFAULT_MODE=auto`) the new agent runs the full
context-acceptance task by itself: reads the handoff, reports understanding,
finds uncertainties, and — if there are any — queries the previous session to resolve them;
clarifications bounce through you; when satisfied, it reports "context
accepted" and waits for your next instruction. In `manual` the same task sits
as a draft for you to review first.

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
- **Windows**: works. The headless resume is spawned via [`cross-spawn`](https://www.npmjs.com/package/cross-spawn), which resolves PATH and `PATHEXT` (so `pi` finds `pi.cmd`) without a shell — `{QUESTION}` is passed as a real argv element, never interpolated into a shell string. If you still see an `ENOENT` from `session_link`, the binary isn't on PATH for that process; point `SESSION_LINK_PI_BIN` at the absolute `pi.cmd` (find it with `where pi`).
