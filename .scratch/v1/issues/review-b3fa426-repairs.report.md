# Review repairs on b3fa426: findings 1 and 2

Branch `review-b3fa-repairs`, from `b3fa426` ("23c: nested-JSON cut edges avoid escapes"). Scope is
the two findings assigned here — the retained cache-miss count across reopen, and the incomplete
search continuation snapshot. Findings 3 and 4 (nontext user address, null argument value) belong to
another workstream; `src/core/render/index.ts` is byte-identical to `b3fa426`, and no probe of theirs
was copied in.

Standing constraints held: no schema change, no dependency, no paid model call, `~/.trace-memory/`
and `~/.pi/agent/` untouched.

## Finding 1 — a reopen must start the consecutive-miss count at zero

`src/hosts/pi/index.ts`. Ticket 19's 2026-09-09 amendment says the count "lives in the executor
process (a reopen starts at zero; the persisted latch itself is unchanged)". `restore()` reopened the
memory session and reset reconciliation state but left this session's `cacheMisses` entry, so one
eligible miss before a reopen and one after it downgraded the session at `2/2`.

The repair clears the process-local counter at the reopen boundary itself — the line that calls
`store.reopenSession` — and only there:

- The persisted `forkSuppression` latch is not touched. Its only reset remains the menu's Retry fork,
  which already cleared both together.
- A tree switch (`restore(context, true)`, from `session_tree`) does not reopen the session and does
  not clear the count: navigation moves position inside the same memory session, so its misses stay
  consecutive. This half already held; it is now pinned so the repair cannot over-reach into it.

Src delta: `src/hosts/pi/index.ts` +6/−1 (five of the six added lines are the comment stating the
ruling and the boundary).

## Finding 2 — a search continuation must be a complete query snapshot

`src/core/api/read.ts`, with two supporting files. 22c froze the hit addresses and the commit graph,
but `factLine()`, `knowledgeLine()` and `expand()` still read live state on every page, so a fact
negated, a knowledge commit marked, or an assistant message completed after page one showed up in a
page that query had already established.

The repair keeps 22c's shape — lazy formatting of one page, values only between pages — and adds the
one thing it was missing: **the query freezes the mutable annotations of the hits it defers, at the
moment it defers them.**

- `Continuation` gains an optional `capture(deferred)` hook. `page()` runs it once, on the leftover
  items, when a cursor is first minted, and does not carry it into the stored continuation. The hits
  formatted at query time need nothing frozen; the deferred ones now carry their own state.
- `search` supplies that hook. For each deferred hit it captures exactly one annotation: a fact's
  relations (`F`), a commit's marks (`K`), a Turn's source-entry identities (`T`). Everything else a
  line prints — the fact and commit records, the path, the labels the graph decided — is immutable or
  already frozen.
- `factLine` and `knowledgeLine` take that frozen value as an optional argument and otherwise read
  live state exactly as before, so every other caller is unchanged.
- `ListingOptions` gains `entryIds`, a Turn's frozen occurrence membership, alongside `branch` which
  already selected occurrences. `trace()` in `src/core/api/index.ts` uses it for both the assembled
  read and the `full` read. **`src/core/render/index.ts` was not touched**: 23b's `renderTrace`
  already takes the entries, so telling `expand()` which entries to assemble needed no renderer
  change — the question the brief asked to check, answered without a stop.
- Three new `Store` readers do the capture in one query per kind: `listFactRelationsOf`,
  `listKnowledgeMarksOf`, `listSourceEntryIdsOf`. The Turn reader returns **identities only** — no Raw
  is loaded — so the cost follows the hit count, not the conversation's volume. No transaction is
  opened or held.

Docs: `docs/core.md` now states the continuation promise (the cursor continues the query, not the
database as it now stands); `docs/pi.md` names the reopen boundary and that a tree switch is not one.

Src delta: `src/core/api/read.ts` +51/−15, `src/core/store/index.ts` +37/−0,
`src/core/api/index.ts` +7/−2. Whole-branch src delta for both findings: **+101/−18 across four
files, net +83 lines**, of which roughly half are comments; the three store readers are 27 of the
remaining code lines.

### Why the marks are frozen as values and not by rewriting the line renderer

`tests/core/api/paged-reads.test.ts` pins `listKnowledgeMarks` at exactly one call for a one-hit page
over 36 hits — the proxy it uses for "a page formats its own hits". Capturing marks per hit through
that method would have made the number 36; capturing them in bulk while formatting the page from the
captured values would have made it 0. Capturing only the deferred hits, in bulk, and formatting the
first page live keeps it at exactly 1, and is also the honest reading: the first page *is* formatted
at query time, so it needs no snapshot. That test is unchanged.

## Tests

| Check | Before (`b3fa426`) | After |
|---|---:|---|
| `npm test` | 616 passed, 35 files | 621 passed, 37 files |
| `npm run typecheck` | passed | passed |
| `npm run smoke:pi` | not rerun | passed (one native Noting run, one fact; long-history regression) |
| `npm run smoke:package` | not rerun | passed (offline tarball install, discovery/load, native Noting) |
| `git diff --check` | clean | clean |

Two new files, five new cases, no existing test edited:

- `tests/hosts/pi/cache-miss-reopen.test.ts` — reopen starts at zero without clearing the latch; a
  tree switch is not a reopen.
- `tests/core/api/search-continuation-snapshot.test.ts` — a fact negated, a commit marked, and a
  message completed between two pages each leave the established page unchanged.

### Revert probes

All four `src` files were reverted to `b3fa426` together, the new cases were run against them, and
the files were restored and verified byte-for-byte with `cmp`. Red on the unrepaired source:

| Test that goes red | Repair it pins |
|---|---|
| `19 amendment: reopening the session starts the miss count at zero without clearing the latch` | finding 1 |
| `22c: a fact negated between two pages does not add a relation to the established page` | finding 2 (`F`) |
| `22c: a knowledge commit marked between two pages does not carry the mark into the established page` | finding 2 (`K`) |
| `22c: a message completed between two pages does not join the established page's assembled trace` | finding 2 (`T`) |

`19 amendment: a tree switch inside the same session is not a reopen and keeps the count` is green
both before and after. It is stated honestly as a regression pin on the half that already held, not
as a reproduction of the defect.

## Performance

`npm run perf -- --repeats=2`, Node v24.6.0, darwin/arm64, cached fixtures and search corpora. p95 ms,
before → after:

| Scenario | baseline fixture | large fixture |
|---|---|---|
| search first page (100 matches, cap 1) | 7.4 → 7.7 | 8.1 → 8.5 |
| search full continuation (100 matches) | 10.9 → 9.9 | 10.9 → 11.3 |
| search first page (500 matches, cap 1) | 30.0 → 30.6 | 30.9 → 47.7 |
| search full continuation (500 matches) | 49.4 → 45.7 | 50.2 → 50.0 |
| search first page (1,000 matches, cap 1) | 73.2 → 58.9 | 60.8 → 62.0 |
| search full continuation (1,000 matches) | 103.7 → 124.0 | 132.6 → 103.1 |

Graph resolutions stay at 1 per query throughout. The two rows that moved most (large 500-match first
page, and the 1,000-match continuations) moved in both directions between the two runs and their cold
samples disagree with their warm ones — 32.0 cold against 47.7 warm for the large 500-match page —
so they read as run-to-run noise, not a trend. Nothing was measured that scales with the deferred hit
count in a way the numbers show: the capture is one query per kind per query, not per page.

The two touched read scenarios are unchanged in the counter that is not noisy: `trace full (heavy
Turn)` and `trace assembled (heavy Turn)` both still make 42 source reads, before and after.

The two acceptance gaps the reviewer disclosed — impossible-Noting capacity with the whole backlog
pending, and 42% tier-1 material reduction against a 50% target — are untouched here and remain open.

## Unmet

Nothing in the two assigned findings is left unrepaired. Two things are worth stating plainly:

- The snapshot covers what these reads actually print. A `Turn`'s own row (`startedAt`, `kind`) and a
  fact's or commit's text are treated as immutable, which they are in the store today; if a future
  ticket makes any of them mutable, the snapshot would have to grow to cover them.
- The `trace` facade's other paged callers — comma lists, session listings, project listings — still
  format eagerly before paging, as they did before 22c and after it. That is pre-existing and out of
  this repair's scope; only `search` defers formatting, so only `search` needed a snapshot.
