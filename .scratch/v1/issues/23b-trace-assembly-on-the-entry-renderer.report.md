# 23b — Explicit `trace` assembled from the entry renderer (report)

Baseline `6f9477d` (main, after 23a). Everything below is left unstaged and uncommitted; `.claude/`
is untouched. No schema change, no migration, no new dependency, no prompt change.

`npm test` **1,821 passed** (1,809 before) — but that total counts two other agents' worktrees under
`.claude/worktrees/`, which vitest's default include picks up. This tree alone
(`npx vitest run --dir tests`): **604 → 611** (8 new cases in one new file, 1 deleted).
`npm run typecheck`, `npm run smoke:pi`, `npm run smoke:package`, `git diff --check` all pass;
`npm run perf -- --repeats=2` below.

## What was built, per decision

| Parent decision (23, "`trace` assembly") | Implementation | Ruling it satisfies |
|---|---|---|
| An explicit read of a Turn assembles that Turn's selected source entries in path order, each rendered with the tier-1 profile | `renderTrace(turn, entries, profile, options, resultText)` in `src/core/render/index.ts`; `src/core/api/index.ts` calls it with `store.listSourceEntries(turn.sessionId, turn.id, display.branch)` | 23a's renderer is the unit (no second renderer); 22c's Turn-scoped read is the source |
| Several assistant messages each show; a call with several result occurrences shows each occurrence | falls out of assembling entries instead of the denormalized Turn shape — no merging, no synthetic status | 22c "multiple results" stays on the `full` path, unchanged |
| A sibling branch's entries never appear | `Store.listSourceEntries` takes an optional `branch` and answers from that branch's `source_paths` selection, in the branch's own order; a branch that selected none of the asked-for entries does not restrict them | 17a "shared-call fork results retain both originals through **unrestricted** full trace" — an unbound read still shows both |
| `tool: n` renders that call's parts in full within their budgets; unselected calls keep their label line and an omission receipt | `renderEntry` gained `choose(address) → "render" \| "floor" \| "drop"`; a floored part renders at `Part.floor` (label + `[omitted N characters]`), and `EntryView.omitted` reports the ordinals that were not rendered whole, which `renderTrace` turns into the `T<n>: N omitted calls…` + `expand: trace(…)` receipts | 22c "metadata for unselected calls, multiple results, omission receipts" unchanged in kind |
| `full: true` renders stored arguments and result envelope uncut, **as today** | `renderTurn` keeps that path byte for byte, including 22c's per-ordinal occurrence merge | the ticket's own wording ("without `full` … assembles"; "`full` … as today") |
| Deletions | the read/search-as-path branch, the memory-write receipt branch, the bash `command` + `stdout`/`stderr` branch, the report head/tail branch, both tool-name regexes, `STDOUT_HEAD_TOKENS`/`STDOUT_TAIL_TOKENS`/`STDERR_TAIL_TOKENS`, and `renderTurn`'s `budgets` parameter (it has no budget left) | 23 "Deletions and settings" |
| `commandTokens`, `reportHeadTokens`, `reportTailTokens` | moved into `REMOVED_SETTINGS` naming `render.toolCallTokens (one budget for the whole tool call)`; gone from `TraceMemoryConfig` and `DEFAULT_CONFIG`, so the read-only settings menu drops them for free | 20b's removed-settings table |
| Native identity stays bound in storage and in the run audit | untouched: `entryAudit`, `nativeLineage`/`nativeId`, `appendSourceEntry` unchanged | 17a |

**`renderTurn`'s other callers** (checked before deleting anything): `src/core/noting/index.ts` uses it
for the head reply (`renderTurn(head, [], { part: "assistant" })`, no calls) — kept, and it only ever
needed the natural-text part. `src/core/api/read.ts` imported it and never called it — the dead import
is gone. `src/core/api/index.ts` keeps it for `full`. Nothing else. `renderSources`, `cut`, `object`
and `string` are still used (`renderSources` by Noting's source index, `cut` by `renderRun`, the other
two by `argumentsPart` and `renderRun`), so none of them was deleted.

## Sample output (goldens in `tests/core/api/trace-assembly.test.ts`)

```
[S1/T1] 2026-09-09T00:00:00Z [turn]        trace("T1", {tool: 1})
[Source entry id: T1#user]
two calls
[T1#t1] bash
command: echo one
[T1#t1] bash success
output one
[T1#t2] read
[omitted 9 characters]
[T1#t2] read success
[omitted 40 characters; middle not inspected]

Receipts:
T1: 1 omitted calls (including partial calls)
expand: trace({"address":"T1","tool":2,"full":true})
```

```
[T1#t1] tool=bash status=success omitted=false     trace("T1#t1", {full: true}) — unchanged
input:
{"command":"echo xxxx…","timeout":30}
result:
{"stdout":"zzzz…","exitCode":0}
```

Two wording changes a reader will notice, both from using the entry view's own markers instead of the
preview's: an unselected call's marker now counts **its own part** (`[omitted 9 characters]` for the
arguments it dropped, `[omitted 40 characters; middle not inspected]` for the result) where the old
line counted input+result together; and a Turn's assistant text is now capped by `E` in an explicit
read too (`full` still returns it uncut). Both are stated in the tests that moved.

## Numbers

`node v24.6.0`, darwin/arm64, `npm run perf -- --repeats=2`, 22a baseline fixture (63.6 MB, 1,999
entries, heaviest Turn T324 with 40 tool calls). "reads" = whole-Raw loads (`Store.getSourceEntry`).

| Scenario | warm ms | reads | vs the pre-22c baseline (5,160.6 ms) |
|---|---|---|---|
| `trace full (heavy Turn, one occurrence)` | **10.0** | 42 | 516× (22c measured 10.1 ms / 42 reads) |
| `trace assembled (heavy Turn, no full)` — new scenario in the runner | **83.2** | 42 | 62× |

Both are ≥10×, and both cost the Turn's own 42 entries, not the session's 1,999 — the assembly reuses
22c's Turn-scoped read rather than adding one. The assembled read is slower than `full` because it
renders: 40 tool results each budgeted to 225 tokens by the `fit` bisection (`full` copies stored
strings). 83 ms for the heaviest Turn of a 63 MB database is within the 100 ms bar ticket 22 used for
explicit reads; it is recorded here rather than tuned. The other scenarios are unchanged within noise
(`branchSummary` 45.9 ms, tier-1 views 320,109 tokens / −42.2%, search 7.7–104.8 ms).

`tests/core/api/paged-reads.test.ts` — 22c's counter pin — is green with **its read count unchanged**
(`b.reads === a.reads`, `a.reads <= entries`), and now also pins that the assembled read costs the
same `a.reads` and shows both occurrences in entry order.

## Tests

New: `tests/core/api/trace-assembly.test.ts`, 8 cases, one per ticket checkbox —

1. `23b golden: a Turn with several assistant messages shows each one, in path order` (byte for byte)
2. `23b golden: a call with several native result occurrences shows each occurrence` (byte for byte)
3. `23b golden: a sibling branch's entries never appear in this branch's trace` (bound read excludes
   the same-Turn sibling occurrence; the `fork` branch sees it; the unbound read stays unrestricted)
4. `23b golden: tool selection renders one call and keeps every other call's label and omission receipt`
5. `23b golden: full renders the stored arguments and result envelope, uncut`
6. `23b: a read of a tool result without full is the entry renderer's tier-1 rendering of that entry`
   (literal equality with `renderEntry(entry, config.render, resultText)`)
7. `23b: the per-tool branches of the Turn preview, the tool-name regex and the stdout/stderr constants
   are gone from src` (greps `src/core/render/index.ts` for the eleven dead identifiers, the device
   `boundary.test.ts` uses for host imports)
8. `23b 2026-09-09: the three explicit-preview budgets are rejected at load, by name, with the
   replacement named`

Changed: `tests/fixtures/noting/turn.txt` and `read.txt` regenerated (the two whole-Turn goldens; the
`commandTokens: 30` override they were generated under is gone with the key); `noting.test.ts` lost
`23: stdout keeps head and tail at its own constants…` (it tested three deleted branches; its
removed-key half moved to case 8 above); `rulings.test.ts` Q12 now shows the same estimator-measured
cut under the tier-1 arguments share (400 Han characters = 348 tokens, cut; the same 400 ASCII
characters = 58 tokens, kept whole) and the two `#part` cases carry the new bytes; `read.test.ts`
scenario 10 asserts `full` for the uncut prompt and the head for the assembled read;
`paged-reads.test.ts` as above; `tests/perf/run.ts` gained the assembled scenario.

## Revert probes

Each applied alone, the file restored from a pre-probe copy and verified with `cmp` (all reported
byte-for-byte restoration; the suite is green again after each).

| Probe | Mutation | Tests that go red |
|---|---|---|
| 1 | restore a per-tool branch: a `read`/`search`/`grep`/`glob` name renders as name-plus-path instead of the uniform arguments part | `23b golden: tool selection renders one call and keeps every other call's label and omission receipt`; `23b: the per-tool branches … are gone from src`; `fixture turn golden and noting input use identical rendering with receipts last` |
| 2 | drop the omission receipt for unselected calls (seal the part with `whole: part.floor`, so it never counts as omitted) | `23b golden: tool selection renders one call and keeps every other call's label and omission receipt` |
| 3 | ignore the caller's branch in `Store.listSourceEntries` | `23b golden: a sibling branch's entries never appear in this branch's trace` |

## `src/` line delta — **not a net deletion**

`src/**/*.ts` 5,610 → 5,661 lines: **+51**, of which 40 are comment lines carrying the rulings.
Non-comment, non-blank lines: **+11** (`render/index.ts` +7, `store/index.ts` +6, `api/index.ts` −2).

Per file: `core/render/index.ts` +98 −67 (the ~26 code lines of per-tool branches, regexes and
constants are gone; `renderTrace`, the `PartChoice`/`EntryView` types and the `choose`/`floor`
plumbing in `renderEntry` are new), `core/store/index.ts` +15 −4 (the branch-selected read, 6 code
lines and its doc comment), `core/api/index.ts` +16 −11 (the assembly call and three removed settings,
minus three config fields and three defaults), `core/api/read.ts` +7 −3 (the `branch` option and its
comment), `noting/index.ts`, `api/tools.ts`, `hosts/pi/index.ts` one line each.

The ticket expected a net deletion and did not get one. The honest reason: the deletion this slice
owns is small (the per-tool preview was ~26 code lines) and it is replaced by an assembly that has to
do three things the preview did not — walk entries rather than one denormalized Turn, decide per part
whether it renders, is sealed or is dropped, and report which calls were cut so the receipts stay
truthful. Together with the branch-selected read that keeps a sibling's occurrences out, that is +40
code lines against −29. Nothing here was written for a future need; the only candidate for removal
would be the branch scoping, and the parent's "that Turn's **selected** source entries in path order"
plus its sibling-exclusion acceptance require it.

## Unmet / stated plainly

1. **Sibling exclusion depends on the caller naming a branch.** A `trace` bound to a session, head and
   branch (the Pi tool path and every run's tool binding) hides a same-Turn occurrence the branch did
   not select; an unbound `memory.trace("T1")` still shows every occurrence. That split is deliberate —
   17a's ruling that an unrestricted full trace retains both fork results is pinned and green — but it
   does mean the same address can render differently for a bound and an unbound reader. `branch` was
   added to `ListingOptions` (host-supplied, never model-supplied) beside the `sessionId`/`headTurnId`
   that already scope a read.
2. **`full` was not re-shaped onto the entry labels.** It keeps `[T<n>#t<k>] tool=… status=… omitted=…`
   with `input:`/`result:` blocks, because the parent says "as today" and the 22c byte captures,
   the 17a fork-result ruling and the huge-payload host goldens all pin it. So two label vocabularies
   exist: the entry view's for the assembled read, the evidence view's for `full`.
3. **The assembled read is 8× slower than `full`** (83 ms vs 10 ms on the heaviest Turn of the 63 MB
   fixture), because it renders under budgets instead of copying stored strings. No target is missed;
   recorded so a later slice does not discover it as a surprise.
4. **`npm test`'s 1,821 includes two other agents' worktrees** under `.claude/worktrees/`, which the
   default vitest include sweeps up. I did not touch `.claude/`; this tree's own count is 604 → 611.
