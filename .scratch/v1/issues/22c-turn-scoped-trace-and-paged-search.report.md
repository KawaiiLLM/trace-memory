# 22c — Turn-scoped full trace, and search that formats only the requested page (report)

Baseline commit `9a2ccb1`; the tree was clean before this work started and every change below is left
unstaged and uncommitted. No schema change, no migration, no new dependency, no process-lifetime
cache, no prompt, tool-schema, address-grammar, threshold or enrollment change. `npm test` 1,192
passed (1,189 before, 3 new cases), `npm run typecheck`, `npm run smoke:pi`, `npm run smoke:package`
and `git diff --check` all pass. `src/hosts/pi/` and `docs/` are untouched, as the scope fence asks;
the untracked `.claude/worktrees/` directory in `git status` is the harness's, not this work's.

## 1. The workload, and the baseline measured before the implementation

The shared 22a fixture (`tests/perf/`, `npm run perf`, not part of `npm test`), unchanged and cached
from the earlier slices:

> 1,999 source entries, 14.8 M Raw characters, 647 Turns (heaviest **T324 with 40 tool calls**),
> 132 facts (all applicable on the branch), 21 knowledge revisions, 30 pending entries. 63.6 MB.

Two additions to `tests/perf/`, both test-only:

- `searchCorpus()` writes the search workload on a **copy** of that fixture, so applicability is
  decided against its real facts and Turns rather than against a bare knowledge table. Every fifth
  commit opens a knowledge, the rest are updates, and every tenth knowledge ends in two updates
  written from two sibling Turns of the head — two tips of one base that no single path carries.

  | corpus | matching revisions | knowledge | updates (historical) | divergent (read as "another branch") |
  |---|---|---|---|---|
  | 100 | 100 | 20 | 80 | 2 |
  | 500 | 500 | 99 | 401 | 18 |
  | 1,000 | 1,000 | 197 | 803 | 38 |

- `countGraphResolutions()` counts the whole-knowledge-graph resolutions a read performs, through a
  prototype wrapper that names `currentSet` before this slice and the `commitGraph` it was extracted
  into after it. Test-only, like 22a's `countSourceReads`; production carries no hook.

Pre-change numbers, `node v24.6.0 darwin/arm64`, `--repeats=3` (first sample cold, the rest warm),
nothing else running. "Reads" counts calls that load and parse a whole Raw payload
(`Store.getSourceEntry`).

| Scenario | cold ms | warm ms | source reads | graph resolutions |
|---|---|---|---|---|
| full trace of one occurrence, T324 (40 calls) | 5,288.2 | **5,160.6** | 79,960 | — |
| search first page, 100 matches, `cap: 1` | 1,753.1 | **1,795.7** | 0 | 200 |
| search full continuation, 100 matches, `cap: 1` | 1,796.2 | 1,834.3 | 0 | 200 |
| search first page, 500 matches, `cap: 1` | 35,659.2 | **35,728.0** | 0 | 1,000 |
| search full continuation, 500 matches, `cap: 1` | 35,766.5 | 36,473.8 | 0 | 1,000 |
| search first page, 1,000 matches, `cap: 1` | 138,676.0 | **137,914.3** | 0 | 2,000 |
| search full continuation, 1,000 matches, `cap: 1` | 138,087.3 | 138,053.2 | 0 | 2,000 |

79,960 = 40 tool calls × 1,999 session entries: the audit's "whole-session reread per call", reproduced
on a public fixture (the audit's own 2,312 ms / 75,680 reads is the same shape on a smaller copy).
The graph resolutions are exactly two per hit — one for the hit's own tips, one for its successors' —
the audit's "1,000 whole-current-set resolutions" at 500 matches, reproduced.

The search figures are **an order of magnitude above the audit's 2,998 ms** at 500 matches because
this corpus sits on 647 Turns and 132 facts: each of the 1,000 resolutions re-decides applicability
for every revision against a real path. That is the honest baseline for this fixture, not a different
defect.

## 2. What changed, per hotspot

### Family 4 — the full trace reread the whole session once per tool call

`src/core/api/index.ts` obtained `listSourceEntries(sessionId)` **inside** the per-call map, filtered
it to this Turn's tool results, and threw the rest away — forty times for a forty-call Turn. It now
obtains this Turn's result occurrences once, before the map, and reuses them across the Turn's
ordinals. `Store.listSourceEntries` gained an optional `turnId` that narrows the existing query
(`AND (? IS NULL OR turn_id = ?)`, the same `? IS NULL OR` shape `listKnowledgeRevisions` already
uses) rather than a new helper; the order — by entry id — is unchanged.

Nothing else about the loop moved. Every call is still described from those occurrences, including
the calls the caller did not select: an unselected call whose Raw carries two occurrences is still
charged its joined character count, so `[omitted N characters of input/result]` and the `expand:
trace(...)` receipts print exactly as before. This is the audit's "simply deleting unselected calls
was not equivalent", and it is why the comparison below is against the complete output.

While reading the same file, `trace` on a `K` address built a fresh path membership **per revision**
(`commitApplies` with its default argument) and again for every other branch's tip. It now builds one
snapshot for the read and passes it — the 22a primitive, used as 22a intended. Same answers, one
membership.

### Family 5 — search formatted every hit and rebuilt the graph twice per hit

Two changes, one in the store and one in the façade.

- **`Store.commitGraph(path, projectId?)`** is `currentSet`'s body, returned as a value instead of
  consumed on the spot: every revision in id order, the ids applicable to the path, the current tips
  among them, and `descendants(commitId)` over the same `parent_id` + `merged_into` edges the walk
  already builds (inverted lazily, only if asked). `currentSet` is now two lines over it, so no
  caller of `currentCommit`, `listCurrentKnowledge`, `listVisibleKnowledge` or `baseProblem` changed
  behaviour, and the DAG walk exists once in the codebase, not twice.

- **`readFacade`'s pagination** now carries hit identities plus the formatter for one page, instead of
  the formatted lines of every hit. `page()` takes either the string list it always took or a
  `{ items, format }` continuation; the cursor stores the untaken identities and the same formatter.
  `search` resolves the path, the graph and the tips **once, before the first page**, and formats only
  `items.slice(0, cap)`. Per hit it now does no `knowledgePath`, no `currentCommit` (twice), no
  `listKnowledgeRevisions` and no `commitDescendants` SQL — it answers from the query's own graph.

  The graph is built only when the hit list actually contains a knowledge address, so a facts-only or
  raw-only search pays nothing for it — cheaper than before, not merely deferred.

### What deliberately did not change

Literal substring matching, `%`/`_`/escape handling and `json_each` topic matching live in
`Store.searchAddresses`, which this slice does not touch; the hit list is still produced by one query
and frozen for the query. Unrestricted explicit reads, cursor ownership and validation, the default
cap of 100, the receipt wording and the rendered line shape are untouched. The tie-breaks that decide
a label — `tip (newest-created alternatives)` unbound, `current`/`archived on this path` bound,
`superseded … by …` — are the same expressions, reading the same values from a snapshot instead of
from four fresh queries; pagination drops no result and picks no maximum commit id.

## 3. Which ruling each choice satisfies

| Choice | Ruling |
|---|---|
| The Turn's occurrences obtained once and reused across its ordinals; metadata for unselected calls, multiple results and omission receipts unchanged | Parent 22 "Trace and Search", clause 1, and the audit's note that deleting unselected calls is not equivalent — the comparison in §4 is against the complete pre-change output. |
| The page cap applied before per-hit formatting; applicability, current tips and ancestry resolved once per query | Parent 22 "Trace and Search", clause 2. |
| Cursor ownership, validation, `cap` inheritance and the "unknown or expired cursor" error kept verbatim; the query's hit list frozen at query time | Parent 22 clause 3; `tests/core/api/tools.test.ts` "cursors to their owner" and `read.test.ts` "default listing caps continue all hits and freeze the remaining search results", both green unchanged. |
| The continuation holds identities and a formatter — plain values — and no transaction, connection or statement between pages | Parent 22 clause 4; pinned by `paged-reads.test.ts` (`db.isTransaction` false between pages, and a second `Store` connection commits between them). |
| Labels come from the query's snapshot, so a commit arriving between pages neither joins the hits nor moves an established label | Parent 22 clause 3 ("no … inconsistent historical labels compared with the query's snapshot"); this is also the pre-change behaviour, which froze the rendered lines. |
| Literal matching, escaping and `json_each` topics left in `searchAddresses`; all applicable divergent tips still listed | Parent 22 clause 5; `read.test.ts` "labels match literally, never as JSON syntax", "search marks historical, merged and archived knowledge hits", `rulings.test.ts` "two tips surface as alternatives to a third session". |
| `commitGraph` is a per-read value, dropped when the read ends; two reads build two graphs | Parent 22 "Read-scoped reuse is the default. Any longer-lived derived cache … must account for branch/head changes and writes by other executors" — there is no longer-lived cache to account for. 22a's `pathSnapshot` is reused inside it, as the amendment "one cause, one primitive" asks. |
| `listSourceEntries` narrowed by `turn_id`; no new column, table or index | Parent 22 "Preserve existing database contents and schemas"; the repository rule "narrow a query before adding a helper". `git diff` contains no schema statement. |
| Counting wrappers live in `tests/perf/fixture.ts` on the prototype | Parent 22 "Testing Decisions": "Do not add public production hooks merely to expose an optimization's internals"; the same device as 22a's `countPathBuilds`. |
| No scheduler, worker, service, dependency or bounded stepping | Parent 22 "Out of Scope"; amendment "Bounded steps deferred". |

## 4. Results

Post-change, same fixture and same corpus files (both generated before the change and reused, so the
comparison is against identical bytes), `--repeats=5`.

| Scenario | before warm ms | after warm ms | after p95 ms | before reads / resolutions | after reads / resolutions | speed-up |
|---|---|---|---|---|---|---|
| full trace of one occurrence, T324 | 5,160.6 | **10.1** | 10.2 | 79,960 reads | **42 reads** | **511×** |
| search first page, 100 matches | 1,795.7 | **7.3** | 10.9 | 200 resolutions | **1** | 246× |
| search first page, 500 matches | 35,728.0 | **30.2** | 30.9 | 1,000 resolutions | **1** | 1,183× |
| search first page, 1,000 matches | 137,914.3 | **59.7** | 89.7 | 2,000 resolutions | **1** | 2,311× |
| search full continuation, 100 matches | 1,834.3 | 10.5 | 10.8 | 200 | **1** | 175× |
| search full continuation, 500 matches | 36,473.8 | 49.8 | 83.6 | 1,000 | **1** | 733× |
| search full continuation, 1,000 matches | 138,053.2 | 104.1 | 134.5 | 2,000 | **1** | 1,326× |

Cold samples after the change: 10.7 / 7.3 / 29.5 / 58.6 / 10.7 / 48.9 / 103.6 ms — cold and warm no
longer differ materially, because the work is no longer proportional to the Raw volume or to the hit
count. 42 reads is T324's own entry count (one user, one assistant, forty results): the trace is
Turn-scoped by measurement, not by claim.

**Targets.** The trace target (tenfold) is met at 511×. The search target (first page within 100 ms at
500 matches) is met at 30.2 ms, and still met at 1,000 matches (59.7 ms). The other 22a/22b scenarios
in the same table are unchanged within noise (`listBranchFacts` 5.7 ms, `branchSummary` 45.7 ms,
footer counts 8.1 ms, disabled callbacks 7.5–7.9 ms).

**Byte-identical output.** The complete pre-change output was captured on the fixture and the corpora,
and again with the post-change source; the two captures compare equal byte for byte (`cmp`), 114
sections, 4,526,755 bytes. What is in them:

- T324 plain and full; **all forty ordinals**, each with and without `full`; three Turns whose Raw
  carries two native occurrences of one call — whole-Turn, selected-call, `S1/T<n>#t1` and capped
  forms; `trace K1` bound and unbound. 9 sections contain `multiple results`; 3,201 `expand: trace(…)`
  omission receipts are reproduced exactly.
- For each corpus (100 / 500 / 1,000 matches): the whole hit list on one page, and the complete
  continuation one hit at a time, page by page, path-scoped; plus unbound and `all`-scope variants for
  100 and 500. Cursor identifiers — random by design — are normalised to `cursor=<opaque>`; results,
  ordering, classification and continuation are compared literally. The captures contain 3,470
  `superseded on this path`, 873 `current on this path`, 258 `tip (newest-created alternatives)` and
  78 `another branch` labels, all identical on both sides.

New tests (3 cases, in `npm test`, `tests/core/api/paged-reads.test.ts`):

1. *"a full trace obtains the Turn's occurrences once, whatever the session's length"* — the same
   twelve-call Turn inside a six-Turn and a twenty-four-Turn session costs the same 27 reads, exactly
   that Turn's own entry count (564 and 1,428 before); the doubled occurrence renders as
   `multiple results` in entry order; the eleven unselected calls keep their metadata and none of
   their results; every ordinal of the Turn costs the same.
2. *"a search page formats its own hits and resolves the commit graph once for the query"* — one page
   of one formats one hit out of the 36 that match and resolves the graph once; a corpus a third the
   size resolves it once too.
3. *"continuation is complete and stable, and a commit between pages moves no label"* — the pages,
   concatenated, equal the single-page output; the hit list is complete, duplicate-free and in the
   query's order; between two pages `db.isTransaction` is false and a **second `Store` connection**
   commits a superseding revision, which the continuation neither lists nor lets change the
   `current on this path` label it had already established — while the next fresh query does see it.

The existing pins for literal matching, `%`/`_`/escape handling, `json_each` topics, visibility,
unrestricted reads, archived/merged/superseded labels, divergent tips and cursor ownership are green
unchanged (`read.test.ts`, `rulings.test.ts`, `memory.test.ts`, `tools.test.ts`).

## 5. Revert probes

Each mutation was applied on its own, the affected test file run, then the file restored from a
pre-probe copy and verified with `cmp` (all three reported byte-for-byte restoration; the suite is
green again afterwards).

| Probe | Mutation | Test that goes red |
|---|---|---|
| 1 | `trace` restores the per-call whole-session load (`listSourceEntries(sessionId)` inside the map) | `paged-reads.test.ts` › "22c: a full trace obtains the Turn's occurrences once, whatever the session's length" — `expected 1428 to be 564` |
| 2 | `search` formats every hit before paging (`page(format(addresses), …)`) | `paged-reads.test.ts` › "22c: a search page formats its own hits and resolves the commit graph once for the query" — `expected 36 to be 1` formatted hits |
| 3 | `search` resolves current tips per hit (`store.currentCommit(id, path)` for the hit and for each successor) | the same case on the resolution counter — `expected 3 to be 1` — **and** "22c: continuation is complete and stable, and a commit between pages moves no label", where the page rendered after the between-pages commit reports `superseded on this path by none` where the query's snapshot said `current on this path` |

Probe 3 is the interesting one: resolving tips per hit is not only slower, it is the mechanism by
which a later page starts disagreeing with its own query.

## 6. Line delta, and what is not met

`src/` net **+47 lines** (`+69 −22`): `src/core/store/index.ts` +32 −3 (of which 14 are the
`CommitGraph` type and the two doc comments), `src/core/api/read.ts` +29 −15,
`src/core/api/index.ts` +8 −4. Test and fixture additions, none of them shipped in the package:
`tests/core/api/paged-reads.test.ts` 179 lines, `tests/perf/fixture.ts` +72, `tests/perf/run.ts` +49.

Public surface inside core: `Store.commitGraph` is new (public because `readFacade` uses it;
`currentSet` stays private), `Store.listSourceEntries` takes an optional second argument, and
`CommitGraph` is exported beside `PathSnapshot`. No existing signature changed.

**Not met / stated plainly:**

1. **A knowledge line's own content is read when its page is formatted, not frozen at query time.**
   The query freezes the hit list and everything a *label* depends on — path, applicability, tips,
   ancestry. The revision text and supports come from the frozen revision list, but the conclusion's
   marks (`verified`/`flagged`) and, for a raw hit, the rendered Turn are read when the page is
   formatted. So a mark placed, or a Turn extended, between two pages shows on the later page, where
   before the whole listing was rendered up front. That is inherent to "format only the requested
   page"; the ticket's pins are about hits and historical labels, and freezing marks would mean a
   second, divergent knowledge-line formatter. Stated here rather than silently accepted.
2. **The 1,000-match corpus was compared path-scoped only** in the byte capture. Its unbound and
   `all`-scope variants would have added about a quarter-hour of pre-change baseline for a comparison
   the 100- and 500-match corpora already make in all three variants.
3. **No archived hit appears in the generated corpus** (its commits are creates, updates and divergent
   updates), so the `archived on this path` branch of the label is pinned by the existing
   `read.test.ts` case rather than by the fixture-scale capture.
4. **`p95` with five repeats is the maximum of the warm samples**, not a true 95th percentile; the
   runner records the sample count with every table. The pre-change table is `--repeats=3` because a
   single 1,000-match sample costs 138 s.
5. **The corpus databases are cached in the perf temp directory** like the fixture itself
   (`npm run perf -- --rebuild` regenerates them); writing 1,000 valid commits takes 27.7 s, and doing
   it inside every run would dominate the measurement it exists to serve.
6. **`branchSummary` (45.7 ms) and the whole-backlog `pendingEntries` (132.7 ms) remain above 100 ms**
   — unchanged by this slice and out of its scope; they are 22b's residue, recorded here only because
   they share the table.
