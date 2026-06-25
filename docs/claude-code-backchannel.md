# Claude Code back-channel

The Claude Code (CC) side of `session-link` is **not a plugin in this repo**. It
lives as a few lightweight CC skills in the user's CC setup. This package ships
only the pi side (fully working) **plus the output parser** that lets a *pi*
session query a *CC* session headlessly. This page records the back-channel so
the interop contract is unambiguous.

## The back-channel command

Query a linked CC session headlessly with read-only tools:

```bash
claude -p "<question>" --resume <session-id> \
  --allowedTools "Read,Grep,Glob" --strict-mcp-config \
  --output-format json | jq -r '.result'
```

- `--resume <session-id>` **appends to the same session**, so multi-round Q&A
  accumulates (each round sees the full prior exchange). Verified against current
  CC docs; mirrors the append semantics of `pi --session <file>` on the pi side.
- `--allowedTools "Read,Grep,Glob"` + `--strict-mcp-config` keep the headless run
  read-only and sandboxed — the previous session answers a question, it does not
  do new work.
- `--output-format json` emits an object with a `result` field, which the
  `claude-code` driver parses (see below).

## Same `CLARIFY:` contract

The clarification relay is **platform- and model-agnostic** and is shared with
the pi side through [`src/clarify.ts`](../src/clarify.ts):

- The question sent to the previous session is wrapped by `wrapQuestion()`,
  which instructs it to start its reply with the token `CLARIFY:` on its own line
  if it needs a human, and otherwise answer directly.
- The reply is split into answer vs. clarification request by `parseResponse()`.

Because the wrapping and parsing live in one place and operate on plain text, a
pi session can query a CC session (and vice versa) with **no special-case code**
per platform — only the output parser differs.

## Authoring a CC-side handoff

The closing CC session writes the same JSON schema
(`session-link/handoff/v1`, see [`src/types.ts`](../src/types.ts)) with:

```jsonc
{
  "schema": "session-link/handoff/v1",
  "driver": "claude-code",
  "sessionRef": "<session-id>",
  "askCommand": [
    "claude", "-p", "{QUESTION}",
    "--resume", "<session-id>",
    "--allowedTools", "Read,Grep,Glob",
    "--strict-mcp-config",
    "--output-format", "json"
  ]
  // ...createdAt, cwd, etc.
}
```

This is done by a user CC skill (e.g. `ask-prev-session` + a per-project
handoff convention recording `prevSessionId`), **not** by anything in this repo.
The `driver` field only selects the output parser; the actual invocation lives in
`askCommand`, so the next session never has to guess CC's flags.

## Why the `claude-code` driver is kept

- It is the reader that lets a **pi** session query a **CC** session headlessly
  (it parses the `result` field of `claude --output-format json`; see
  [`src/drivers/claude-code.ts`](../src/drivers/claude-code.ts)).
- It is part of pi's documented cross-tool portability: one shared handoff schema
  where `driver` only selects the output parser.
- It costs ~nothing to keep and is the cheap hedge that keeps the pi↔CC interop
  door open.

## Status

Interop (pi querying a CC session and vice versa) is "maybe / rarely" for now.
The only thing that preserves that optionality at ~zero cost is the **shared
handoff JSON schema** plus the **existing `claude-code` driver**. So: keep the
driver, drop the speculative heavy plugin (MCP server + hooks + slash commands),
and let the CC side live as user skills. No second repo, no MCP plugin here.
