# 22d — Cheap capacity rejection, and spend from usage rather than audit bodies (report)

Branch `ticket-22d`, from `6f9477d` (the 23a merge). No schema change, no migration, no new dependency,
no scheduler, no process-lifetime cache, no prompt, tool-schema, address-grammar, threshold or
enrollment change. `npm test` 609 passed (604 before, 5 new cases), `npm run typecheck`,
`npm run smoke:pi`, `npm run smoke:package`, `npm run perf -- --repeats=2` (both sizes) and
`git diff --check` all pass. `src/hosts/pi/`, `src/core/render/index.ts` and `docs/` are untouched;
`src/core/api/index.ts` was not edited at all.

`src/` line delta: **+98 / −23, net +75 lines** over four files (`core/store/index.ts`,
`core/api/read.ts`, `core/noting/index.ts`, `core/consolidation/index.ts`).

## 1. The workload, and the baseline measured before the implementation

The shared 22a fixture (`tests/perf/`, `npm run perf`, not part of `npm test`), unchanged and cached
from the earlier slices:

> 1,999 source entries, 14.8 M Raw characters, 647 Turns (heaviest T324 with 40 tool calls), 132 facts,
> 21 knowledge revisions, 30 pending entries, 112 pending Consolidation facts. 63.6 MB.

Two additions to `tests/perf/`, both test-only, in the shape 22a established (prototype wrappers,
restored afterwards; production carries no hook):

- `runAudit()` writes the spend workload on a **copy** of the fixture: 200 runs with 256 KiB requests
  and 64 KiB responses (65.6 M characters in total) and small usage records, in three shapes the
  aggregation must keep apart — 179 observed usages, 12 cancelled runs whose usage is unknown
  (`usage: null`), 9 failures whose response is not JSON at all.
- `countRunBodies()` counts the `request`/`response` characters a read pulls into JavaScript.

The capacity scenarios call `freezeNoting` / `freezeConsolidation` directly, because the freeze is
what the hotspot is; nothing there runs a task, so no provider request is possible (the runner still
asserts none was made). Two Noting databases are used: a copy whose Noting progress is deleted (the
whole 1,996-entry history pending — the worst case), and the fixture as it stands (a 30-entry pending
tail — the ordinary case the 100 ms target is stated against).

Pre-change numbers, `node v24.6.0 darwin/arm64`, `--repeats=3` (first sample cold, the rest warm),
serial, nothing else running. Measured twice; the two runs agreed except for one 480 ms outlier on
"noting freeze (no allowance)", where the second run's 262 ms is quoted.

| Scenario | cold ms | warm ms | note |
|---|---|---|---|
| noting freeze, no allowance | 270.5 | **262.1** | 63 of 1,996 pending entries selected, 19,364 tokens priced |
| noting freeze, impossible 2,000-token allowance (1,996 pending) | 3,271.5 | **3,252.1** | instructions 2,834 + tools 1,159 = 3,993 mandatory tokens |
| noting freeze, impossible 2,000-token allowance (30 pending) | 857.8 | **856.2** | the ordinary pending tail |
| noting freeze, allowance 500 under the natural size | 318.1 | **322.4** | 63 entries, 116 of 132 historical facts kept |
| consolidation freeze, no allowance | 29.5 | **32.4** | 112 pending facts |
| consolidation freeze, impossible 2,000-token allowance | 345.2 | **343.6** | instructions 3,769 + tools 1,159 = 4,928 mandatory tokens |
| spend, 200 large-audit runs | 240.2 | **229.1** | 65.6 M audit characters loaded |

The audit's own figures are the same shape on its private copy: "a normal Noting freeze selected 23
entries in 297 ms", "an impossible 2,000-token allowance spent 1,427 ms before rejection while
instructions and tools alone cost 3,896 estimated tokens", "spend for 200 synthetic runs … loaded
65.6 million characters". The freeze is slower here because this fixture's batch is 63 entries, not
23, and the re-freeze cost grows with the square of the batch.

## 2. What changed, per hotspot

### Family 6 — the freeze stops re-pricing what cannot be bought

`freezeNoting` and `freezeConsolidation` both negotiated capacity by re-freezing: prepare the whole
candidate material, price it, trim the optional history or pop the newest unit, repeat. When the
allowance is below what the instructions and tool definitions cost on their own, every one of those
candidates is priced above it, so the loop runs the batch down to nothing and raises a capacity error
after O(batch²) renders.

The repair is a floor, computed from the same three terms the loop prices with:

```
mandatory = max(instructions + tools, effectiveMode === "fork" ? prefixTokens + instructions : 0)
```

Every candidate's price is `max(instructions + tools + fresh, fork ? prefix + instructions + inherited : 0)`,
and both material terms are non-negative, so `priced ≥ mandatory` always. An allowance below
`mandatory` therefore cannot be met by any batch, and the freeze raises its capacity error
immediately — before the pending entries are rendered, before the knowledge and facts are read,
before the first candidate exists. Above the floor the preflight says nothing at all and the loop
decides exactly as before; the check inside the loop is untouched.

The error keeps the sentence the 17b pins match (`"Noting capacity: oldest entry cannot fit the
episodic budget or the model context with instructions, knowledge, tools and output reserved"`,
`"Consolidation capacity: oldest fact with its mandatory cues cannot fit …"`) and appends the two
numbers that explain it: what the fixed cost is, and what the allowance was.

Inside a freeze that does proceed, three things that cannot change between candidates are now
computed once instead of once per candidate:

- **the fixed cost** — `tokens(prompt)` and `tokens(JSON.stringify(toolDefinitions))`, memoized per
  module (lazily: `toolDefinitions` reaches these modules through an import cycle);
- **the entry views** — the selection loop already renders each pending entry once to apply
  `noting.batchTokens`; those `Rendered` values are now kept and handed to every re-freeze, instead
  of the batch being re-rendered per candidate. `notingMaterial` takes the view and the fact line as
  functions and no longer needs the store at all;
- **the fact lines and the Turn tool calls** — one `renderFact` (with its relations query) per fact
  and one `listToolCalls` per Turn for the whole freeze. Consolidation already memoized its fact
  lines in `lines`; this is Noting catching up with its twin.

Nothing about what is selected changed: the same oldest-first whole units, the same optional-history
priority, the same `over.episodic` reduction signal, the same final comparison against the allowance,
and `runNoting`/`runConsolidation` still execute the exact `prepared` material the freeze priced.

**The twin.** Both freezes got the preflight and the fixed-cost memo, worded and placed the same way.
Consolidation additionally had its capacity *validation* moved up beside its sibling's (Noting
validates before reading pending entries; Consolidation validated after selecting the batch), so the
preflight has a validated allowance to compare against. The view memo has no Consolidation
counterpart — Consolidation has no Raw block, and its fact lines were already memoized.

### Family 7 — spend reads usage, not audit bodies

`spend` loaded every run row of the session (`SELECT *`, so both the request and the response text)
and `JSON.parse`d each response to reach `usage`. It now asks the store for a projection:
`Store.listRunUsage(sessionId)` selects `kind` plus `json_extract(response, '$.usage.…')` for the five
counters, guarded by `json_valid` so a non-JSON response is a missing observation rather than a SQL
error. The bodies stay in SQLite.

The distinctions the parent requires are kept in the projection, not papered over:
`json_type(response, '$.usage')` separates *no key* and *recorded null* (no observation: the run is
counted, its usage is not) from *an object that happens to be empty* (an observation of zeros). A
usage amended on an existing run is read on the next call, because there is no retained total to
maintain — the "correctly maintained in-process total" the ticket also allows was not needed.

## 3. Which ruling each choice satisfies

| Choice | Ruling |
|---|---|
| A floor derived from the actual instructions, tool definitions and effective mode; rejection before any candidate material | 22 "Capacity and accounting": "Perform a cheap rejection when unavoidable instruction, tool, or inherited-prefix costs already exceed the effective mode's input allowance. Do not repeatedly re-freeze candidate batches when no candidate can possibly fit." |
| The loop's hard-budget comparison is unchanged and still runs on every freeze that passes the floor | 22: "A fast preflight supplements the final guard; it does not replace it" — pinned by revert probe 2 and by the budget-repairs pin of 2026-09-08. |
| Fixed costs, entry views, fact lines and tool calls computed once per freeze | 22: "Within a freeze, reuse fixed instruction/tool costs, immutable views, and already computed material components where their inputs have not changed." |
| Oldest-first whole units, optional history first, mandatory reminders, `prepared` executed as priced | 22: "Retain optional-history priority, oldest-first whole evidence, mandatory reminders, final hard-budget verification, and execution of the exact prepared material that was priced"; review 2026-09-08 pins in `budget-repairs.test.ts`, all still green. |
| Capacity priced by the effective mode, in the preflight as in the loop | review 2026-09-08 ("capacity is priced by effective mode"); user story 32. |
| `json_extract`/`json_type` over the existing `runs.response`; no column, no table, no retained total | 22d: "a SQL projection of the existing `runs.response` column (`json_extract`) or a correctly maintained in-process total"; 22a amendment: "`json_extract` on the column is allowed, a new column or table is not"; 22: "Preserve existing database contents and schemas". `git diff` contains no schema statement. |
| Unknown usage counted as a run and not as a zero; an all-zero usage object stays an observation | 22: "Unknown or failed-response placeholder usage remains distinct from observed usage. Do not manufacture zero observations to make aggregation easier"; user story 38. |
| Nothing added to the freeze but a comparison; no scheduler, worker, cache framework or dependency | 22: "A performance problem alone is not authorization for a new scheduler, service, persistent job system, dependency, or worker-process architecture"; amendment "Bounded steps deferred". |
| Test counters live on prototypes in `tests/perf/fixture.ts`; the render counter is the injected result extractor the façade already takes | 22 "Confirmed seams": "Do not add public production hooks merely to expose an optimization's internals." |
| `tests/core/api/rulings.test.ts`, `budget-repairs.test.ts`, `noting.test.ts`, `consolidation.test.ts`, `batching.test.ts` and `manual-catchup.test.ts` unchanged | The capacity error keeps the sentence those pins match; only two numbers are appended. |

## 4. Results

Same fixture files, same machine, `--repeats=3`, post-change.

| Scenario | before warm ms | after warm ms | speed-up | note |
|---|---|---|---|---|
| noting freeze, impossible allowance (1,996 pending) | 3,252.1 | **146.8** | 22× | rejection, 0 entry views built |
| noting freeze, impossible allowance (30 pending) | 856.2 | **12.1** | 71× | the ordinary case; **under the 100 ms target** |
| consolidation freeze, impossible allowance | 343.6 | **7.2** | 48× | rejection, 0 fact lines rendered |
| noting freeze, no allowance | 262.1 | **221.6** | 1.18× | same 63 entries, same 19,364 tokens priced |
| noting freeze, allowance 500 under the natural size | 322.4 | **231.5** | 1.39× | same 63 entries, same 116 of 132 facts kept |
| consolidation freeze, no allowance | 32.4 | **29.8** | 1.09× | same 112 pending facts |
| spend, 200 large-audit runs | 229.1 | **15.6** | **14.7×** | **65.6 M → 0 audit characters loaded**; identical totals ($1.8006) |

Both selection outcomes above are unchanged by construction and by assertion: the same entry count,
the same priced token total, the same number of historical facts retained, and the same spend totals
to the cent.

`npm run perf -- --repeats=2` on both sizes after the change (the larger fixture: 3,951 entries,
28.7 M Raw characters, 244 pending facts): noting freeze 343.3 ms with no allowance, 265.6 ms for the
impossible allowance with 3,948 entries pending, 22.5 ms on its ordinary 31-entry tail; consolidation
freeze 93.9 ms and 13.8 ms; spend 15.4 ms. The rejection cost now grows with the pending read, not
with the square of the batch.

New tests (5 cases, in `npm test`, `tests/core/api/capacity-and-spend.test.ts`):

- an allowance under the mandatory cost is rejected with **nothing rendered** (the injected result
  extractor, which `renderEntry` calls once per tool-result view, is never called), no model
  dispatch, no run record, no progress advanced, and spend still zero;
- the rejection renders nothing whether 6 or 24 tool results are pending, while a workable allowance
  renders each pending view exactly once — the negotiation reuses them rather than re-rendering per
  candidate;
- an allowance comfortably **above** the floor but below the material is still refused by the final
  guard, with nothing dispatched, and the same material under a fitting allowance runs priced under
  what it was given;
- spend equals the pre-change implementation's totals (recomputed in the test from the bodies) while
  loading zero body characters, and a later usage amendment on the same run is reflected exactly;
- an unknown usage and a non-JSON response are counted as runs and contribute no observed zero, while
  a recorded empty usage object stays an observation.

## 5. Revert probes

Each mutation was applied on its own, the affected tests run, then the file restored from a pre-probe
copy and verified with `cmp` (all three reported byte-for-byte restoration; the suite is green again
afterwards).

| Probe | Mutation | Test that goes red |
|---|---|---|
| 1 | The preflight's condition is disabled (`if (false && …)`), so an impossible allowance goes back to the re-freeze loop | `tests/core/api/capacity-and-spend.test.ts` › "22d: an allowance under the mandatory instruction and tool cost is rejected with nothing rendered, dispatched or recorded" **and** › "22d: the rejection costs the same whatever the pending backlog is…" — both on the render counter (`expected 6 to be +0`) |
| 2 | The preflight replaces the final guard: `fits = !prepared.over.episodic`, skipping the hard-cap comparison because the preflight passed | `tests/core/api/capacity-and-spend.test.ts` › "22d: the preflight is a floor and not the guard…" **and** `tests/core/api/budget-repairs.test.ts` › "review 2026-09-08: Noting runs the prepared material the capacity negotiation priced…" |
| 3 | `spend` goes back to `store.listRuns` + `JSON.parse` of each response | `tests/core/api/capacity-and-spend.test.ts` › "22d: spend totals come from the recorded usage without loading a run's request or response body" (`expected 200133 to be +0`) |

## 6. What is not met, and what was left alone

- **The 100 ms rejection target holds on the ordinary workload (12.1 ms) and not on the whole-backlog
  copy (146.8 ms).** The remaining cost there is not the freeze: `store.pendingEntries` loads 1,996
  whole Raw payloads (122–131 ms measured on its own) before the freeze can know it has anything
  pending at all, and the preflight is deliberately placed after that check so that a session with
  nothing to note still returns "empty" rather than raising a capacity error. A cheap
  "is anything pending" projection would remove the rest; it is a family-2 read (22b) rather than
  this slice's re-freeze loop, and inventing a second definition of "pending" for it was not worth
  the concept split without a ruling.
- **`Store.notedWatermark` still loads whole run rows** (`listRuns` twice) to find a range end. It is
  the same "`SELECT *` for one column" shape as the spend defect, but it aggregates progress rather
  than usage, so it is outside hotspot family 7 as written. Noted here rather than fixed.
- The audit's "20 ms" for the pre-change spend was not reproduced: on this fixture the same
  implementation takes 229 ms for the same 65.6 M characters. The private snapshot's number is not
  portable; the improvement is measured against the honest baseline of this fixture.
- The Consolidation twin has no entry-view memo, because it has no Raw block; its fact lines were
  already computed once. Stated here rather than left implicit.
