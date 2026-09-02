# Running the CLI — and the one check that closes it

## Install / run

```bash
node src/cli.ts --help            # no install, no build (Node ≥ 22.6 strips TS)
node src/cli.ts <command> --json  # stable machine surface
```

`--json` is the contract. Human output is not — it may change between versions.

## Tests

```bash
npm test          # node --test --experimental-strip-types tests/**/*.test.ts
npm run typecheck # tsc --noEmit
```

A green stage is **both** clean.

## The acceptance check that is NOT automated (§7 of docs/cli-spec.md)

> A link written by the **CLI from a Claude Code session** must show up in a **live
> pi session** via `/session-link-show`, and a link written by the **pi adapter**
> must show up via the CLI. This is the only check that proves the CLI is *needed*.

This is a manual run, not `node --test` — it needs both platforms live, in the same
store. The automated suite proves the CLI works; this proves two platforms share one
store. Capture the output of both sides and attach it to the release.

### How to run it

Pick a real git repo both platforms work in (so the store is repo-scoped and shared).

1. **Claude Code writes a link via the CLI** (from a CC session in that repo):
   ```bash
   echo '{"createdAt":"…","driver":"claude-code","sessionRef":"/cc/…","sessionId":"cc-1","cwd":"…","howToAsk":"…","askCommand":[…],"goal":"…","summary":"…","nextStep":"…","unit":"from-cc"}' \
     | node src/cli.ts write --json
   ```
2. **A live pi session** in the same repo, with the session-link extension loaded:
   ```
   /session-link-show
   ```
   → must list/locate the `from-cc` line. Capture the `/session-link-show` output.
3. **Reverse**: write a link from pi (`/session-link`), then from anywhere:
   ```bash
   node src/cli.ts show --unit <that-unit> --json
   ```
   → must show the pi-written link. Capture both outputs.

Both directions must succeed for §7 to close. The automated `cli-cross.test.ts`
covers the **format** cross-read (CLI↔core in one process); it does **not** cover
the parts that can only diverge across platforms — resolution of the store from a
different cwd, the lock with a live writer on the other side, index behaviour. The
manual run above is what catches those.

## Strictness profiles (issue #15, §9 of the spec)

```bash
session-link show --cwd X --json                      # plain: as before, nothing new required
session-link show --cwd X --profile fleet --json        # asker declares fleet (or env SESSION_LINK_PROFILE)
echo '{…,"profile":"fleet"}' | session-link write …   # the LINE's profile — inherited along the chain
```

- effective strictness = line profile + asker declaration, combined per knob
  (booleans OR, thresholds MIN); `data.strictness` prints every applied knob WITH its source;
- fleet: `--unit` required even for a single line; links older than the threshold or with a
  foreign driver are `error.code:"suspicious"` (exit 4) — valid but rejected by rule, with the
  threshold named;
- org profiles: `<repo-root>/.session-link/profiles/<name>.json` (knobs) + `<name>.md` (starter
  template — required for fleet; missing file ⇒ `go` refuses to start a successor);
- unknown profile ⇒ exit 4, never a silent plain; empty `--profile`/env = not declared.

## Exit codes (§5)

`0` ok · `1` not found · `2` usage · `3` store busy · `4` invalid (+ `suspicious`) · `5` conflict · `6` invariant
