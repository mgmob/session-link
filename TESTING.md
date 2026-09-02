# Testing

The project has no test framework dependency — it uses Node's built-in test
runner (`node:test`) with type-stripping (Node ≥ 22.6; on 22.23 strip-types is on
by default). Run everything with:

```
npm test           # node --test --experimental-strip-types tests/**/*.test.ts
npm run typecheck  # tsc --noEmit
```

A green stage = `npm run typecheck` clean **and** `npm test` all passing.

## Test files

| File | Covers |
| --- | --- |
| `tests/read-v1-chain.test.ts` | reading the synthetic v1 fixture |
| `tests/store.test.ts` | `resolveStore`, `generateId`, layout helpers |
| `tests/read-find.test.ts` | `readHandoff` {v1,v2} lenient, `findHandoff` (§2.3), default line (§4.3) |
| `tests/parent.test.ts` | `resolveParent` 5 steps (§2.5), `walkAncestors` |
| `tests/migrate.test.ts` | v1→v2 migration (§2.4), `assignUnit` (§3.2) |
| `tests/lock.test.ts` | `withLock`, stale-lock reclaim (§5) |
| `tests/write.test.ts` | `writeLink` three cases (§5.1), `collectDerived` (§7.3) |
| `tests/index.test.ts` | `index.json` + `rebuildIndex` (§4) |
| `tests/unit-fork.test.ts` | `renameLine`, forks (§3, §6) |
| `tests/commands.test.ts` | `renderGraph`, `doctorReport`, `validateStore` (§9) |
| `tests/targetcwd.test.ts` | cross-store relocation via `incoming/` (§2.6) |
| `tests/externals.test.ts` | `externals` ceiling + fail-soft (§8) |
| `tests/partof.test.ts` | `partOf` edge: round-trip, graph, ancestry ignores it (К-0) |
| `tests/profile-core.test.ts` | profile field in the core: inherit/mirror/normalize, downgrade report (П-0) |
| `tests/profiles-resolve.test.ts` | profile resolution, per-knob combination, org catalog (П-1) |
| `tests/fleet-cli.test.ts` | fleet/plain in the CLI: DoD 1–5, 8 controls and feature (П-2/3/4) |
| `tests/starter-template.test.ts` | starter preamble order, missing-template refusal (П-5, DoD 6–7) |
| `tests/dod15.test.ts` | issue #15 acceptance sweep: each DoD criterion by number (П-6) |

## Invariant → test map (contract §10)

| # | Invariant | Test |
| --- | --- | --- |
| 1 | `unit` survives a session/model change | `write.test`: "new link … keeps the line name" |
| 2 | two lines in one store don't mix | `write.test`: "two named lines keep separate rotations" |
| 3 | `index.json` rebuild is byte-for-byte the same | `index.test`: "rebuildIndex reproduces … byte-for-byte" |
| 4 | ancestor walk returns this line's links (incl. cross-store) | `parent.test`: "walk returns THIS line's ancestors" + "cross-store ancestors" |
| 5 | a `targetCwd` line is found via the pointer; first write finishes the move | `targetcwd.test`: "inv. 5" |
| 6 | absent/unknown `externals` never breaks; round-trips | `externals.test`: "arbitrary externals survive" |
| 7 | a v1 chain reads; after a write it's v2 with no data loss | `read-v1-chain.test`, `read-find.test`, `migrate.test` |
| 8 | a fork keeps both branches reachable | `unit-fork.test`: "inv. 8" |
| 9 | the tool never writes `externals` itself | `externals.test`: "inv. 9" |
| 10 | concurrent writes don't lose data; stale lock reclaimed | `lock.test`: "inv. 10" (×3) |
| 11 | `auto` with no unit/parent ⇒ technical name, write still happens | `migrate.test`/`unit-fork.test`: assignUnit |
| 12 | a rename doesn't break the chain | `unit-fork.test`: "inv. 12" |
| 13 | lines of one repo are visible from any worktree | `store.test`: "invariant 13" |
| 14 | a legacy head is found, moved once, marked | `migrate.test`: "inv. 14" |
| 15 | a session dead before authoring still leaves `derived` (DRAFT) | `write.test`: "first link … derived present" |
| 16 | a failed session never closes the line | `write.test`: "inv. 16" |
| 17 | redo-in-place doesn't fork links and keeps authored body | `write.test`: "redo-in-place" + "merge forward" |
| 18 | with >1 active line the tool doesn't pick for the operator | `read-find.test`: "inv. 18"; `/session-link-show` |
| 19 | two legacy chains of one clone → two lines | `migrate.test`: "inv. 19" |
| 20 | a rename doesn't touch archives (byte-identical) | `unit-fork.test`: "inv. 20" |
| 21 | a cross-store link survives a store move (MOVED-TO) | `parent.test`: "cross-store + MOVED-TO" |
| 22 | a broken parent link is an honest miss | `parent.test`: "step 5 … honest miss" |
| 23 | migration doesn't sever v1 ancestors | `migrate.test`: "inv. 23" |

## Strip-types caveat

Node's experimental strip-types **erases types only** — it does not transform.
TS features that need transformation are unsupported at runtime even though
`tsc` accepts them. In practice this means: no parameter properties
(`constructor(public x: number)`), no enums, no namespaces — declare fields
explicitly. (Caught once on `LockBusyError`; the rule is now followed throughout.)
