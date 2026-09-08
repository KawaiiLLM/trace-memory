# 22a — One path snapshot per operation, and a footer that costs nothing (report)

Baseline commit `5370775`; the tree was clean before this work started and every change below is left
unstaged and uncommitted. No schema change, no migration, no new dependency, no scheduler, no
process-lifetime cache. `npm test` 580 passed (573 before, 7 new cases), `npm run typecheck`,
`npm run smoke:pi`, `npm run smoke:package` and `git diff --check` all pass.

## 1. The fixture and the baseline, measured before the implementation

`tests/perf/` holds the shared fixture the parent ticket asks for: a seeded deterministic generator
(`fixture.ts`) and a serial runner (`run.ts`, `npm run perf`, not part of `npm test`) that prints the
runtime version, the fixture size and the warm/cold state with every number. The runner installs no
provider wire and fails if any request is made.

Baseline size, as generated (`npm run perf -- baseline`):

> 1,999 source entries, 14.8 M Raw characters, 647 Turns (heaviest with 40 tool calls), 132 facts
> (all applicable on the branch), 21 knowledge revisions, 30 pending entries, a sibling branch whose
> selected ancestry carries a same-Turn entry main's does not, non-text user boundaries every 17th
> Turn, repeated prompts, several native occurrences of one tool call, mixed CJK/Latin payloads, and
> facts written without entry bindings. 63.6 MB, generated in 6.8 s.

Larger size for scaling: 3,951 entries, 28.7 M Raw characters, 1,292 Turns, 264 facts, 123.4 MB.

Pre-change numbers, `node v24.6.0 darwin/arm64`, `--repeats=3` (first sample cold, the rest warm),
nothing else running. "Reads" counts calls that load and parse a whole Raw payload
(`Store.getSourceEntry`), through a test-only prototype wrapper — no production hook.

| Scenario (baseline size) | cold ms | warm ms | source reads |
|---|---|---|---|
| `listBranchFacts` | 19,270 | 19,040 | 263,472 |
| `consolidationBatch` | 23,145 | 22,892 | 303,392 |
| `branchSummary` (branch carry) | 21,607 | 21,769 | 307,384 |
| `citationProblem` (20 facts) | 2,739 | 2,760 | 39,920 |
| footer counts (the three reads `showSpend` makes) | 19,107 | 19,701 | 263,472 |
| host `session_start`, disabled session | 19,660 | 19,474 | 263,472 |
| host `before_agent_start`, disabled session | 19,486 | 19,288 | 263,472 |
| host `before_provider_request`, disabled session | 19,174 | 19,496 | 263,472 |

263,472 ≈ 132 facts × 1,996 selected entries: the audit's "one path rebuild per fact", reproduced on
a public fixture. The audit's own figures (7.4 s / 238,392 reads on a 1,892-entry copy) are the same
shape; this fixture is slower because its Raw payloads are larger.

Larger size, pre-change, cold single sample: `listBranchFacts` 75,636 ms / 1,042,272 reads,
`consolidationBatch` 85,412 ms / 1,121,232 reads — **3.97× and 3.73× for twice the evidence**, the
near-fourfold growth the parent describes.

## 2. What changed, and why

### The primitive: one path snapshot per operation

`source_entries.content` is the whole message JSON, and before this slice every identity question —
which Turn, which role, which entry, on the path or not — was answered by loading and parsing it.
`Store.pathSnapshot(path)` answers those questions from identity columns instead, and one operation
builds exactly one snapshot:

- **Turn membership** comes from a single recursive query over `turns` instead of one `getTurn` per
  ancestor. The walk that decides is unchanged, so a missing Turn, a Turn of another session and a
  cycle are still `invalid path ancestry`, never a silently shorter path.
- **Entry membership** comes from `source_paths.entry_ids` joined to `source_entries(id, turn_id)`.
  No `content` is read, in SQL or in JavaScript.
- **Citable addresses** — the fallback for facts written without entry bindings — are read one Turn
  at a time, with `json_extract` over that Turn's entries only, and kept for the rest of the
  operation. A fact that carries bindings never asks.
- **Consolidation's run memo** (did this run take only facts on this path?) moved into the snapshot,
  which removed a parameter instead of adding one.

The snapshot is a plain value passed through `factOnPath`, `commitApplies`, `consolidatedOnPath`,
`citationProblem`, `listBranchFacts`, `consolidationBatch`, `currentSet` and `branchSummary`. It is
built at the start of an operation and dropped at its end: no field on `Store`, no module state, no
key to invalidate. Two reads in a row build two snapshots, which is why another executor's commit,
enrollment change or branch move between them is seen.

`factOnPath(fact, path)` still builds its own snapshot when no caller passes one, so every existing
two-argument call site keeps working — and that default *is* the pre-22a behaviour, which is what the
equivalence tests compare against.

### The hotspots

- **`listBranchFacts`** selected the facts on the lineage and then called `factOnPath` with no
  snapshot, so every fact rebuilt the Turn ancestry *and* loaded every selected source entry. It now
  builds one snapshot for the whole list. The fact-selection query is untouched, including the case
  where the head names no facts, so a head from another session still returns an empty list rather
  than raising.
- **`consolidationBatch`** built the path twice per fact — once inside `listBranchFacts`, once inside
  `consolidatedOnPath`. It now builds one and hands the same one to both. Its new first line guards
  the head exactly as the lineage query did, so a head naming no Turn of this session still returns
  `[]` instead of raising.
- **`branchSummary` (branch carry)** rebuilt the entry set for every session fact and again for every
  knowledge revision. It now shares one snapshot for both.
- **`citationProblem`** passed only the Turn set, so `factOnPath` rebuilt the entry set for every
  cited fact. It now passes the whole snapshot: the same values, computed once.
- **`currentSet`** (behind `listCurrentKnowledge`, `inject`, `search` and the footer's left-hand
  number) already computed the two sets once per read, but computed them the expensive way.
- **The footer.** `showSpend` is unchanged. It already asked for exactly the two numbers the user
  ruling of 2026-09-07 fixed — applicable current knowledge, facts on this branch — plus this
  session's cumulative spend, so making those reads cheap made the footer cheap in every state, and
  the displayed counts are the enumeration's by construction rather than by agreement.

### Why the disabled footer still shows counts

The ticket allows either truthful counts or an explicit unavailable marker. Counts were kept, for
three reasons: they are now cheap — a disabled callback loads no Raw payload at all, which the probe
test pins; they are truthful, because a disabled session writes no fact and no knowledge, so the
stored numbers are current statistics and not a cached old value; and a second, cheaper counting
implementation for the disabled case would be a second definition of "facts on this branch" that
could drift from the enumeration the ticket requires it to equal. The disabled callbacks stay out of
the automatic-history path because `reconcile` returns before any work when memory is disabled: they
dispatch no model, write no Turn, and read no source entry.

## 3. Which ruling each choice satisfies

| Choice | Ruling |
|---|---|
| One snapshot per operation, passed as an argument, dropped at the end | Parent 22: "Read-scoped reuse is the default. Any longer-lived derived cache or aggregate must account for branch/head changes and writes by other executors" — there is no longer-lived cache to account for. |
| Identity from `turn_id` and `json_extract`, never a new column or table | 22a: "`json_extract` on the column is allowed; a new column or table is not"; parent: "Preserve existing database contents and schemas". `git diff` contains no schema statement. |
| Entry-binding check kept; address fallback kept, per Turn | Parent: "Retain source-occurrence checks for same-Turn divergence and the existing treatment of facts without explicit entry bindings"; review 2026-09-08 (`T1#assistant` is shared by every assistant entry of a Turn, so identity decides, not the address). |
| `content` parsed only to render a view | 22a's primitive statement; `renderEntry` is still the only reader of Raw. |
| No scheduler, worker, service or dependency; no bounded steps | Parent: "A performance problem alone is not authorization for a new scheduler, service, persistent job system, dependency, or worker-process architecture"; amendment "Bounded steps deferred". |
| Footer keeps the same counts, computed by the same enumeration | User ruling 2026-09-07 (footer reading); parent: "the displayed counts equal the enumeration's" and "Keep status truthful". |
| Disabled callbacks do no reconciliation and read no history | Parent: "Disabled callbacks must not enter the expensive automatic-history path merely to display disabled status". |
| Nothing touched under `src/core/prompts`, tool schemas, address grammar, thresholds or enrollment | 22a "Out of scope". |
| `tests/core/api/rulings.test.ts` and `budget-repairs.test.ts` pins | Unchanged and green, including the byte-for-byte branch-carry snapshot, the A/B commit-path cases, archive/update/merge, the scope table, the frozen manual boundary and the "late fact on an early turn" batch rule — all of which now run through the snapshot. |

## 4. Results

Post-change, same fixture files (the databases were generated before the change and reused, so the
comparison is against identical bytes), `--repeats=5` on the baseline size, `--repeats=3` on the
larger one.

| Scenario (baseline size) | before warm ms | after warm ms | after p95 ms | before reads | after reads | speed-up |
|---|---|---|---|---|---|---|
| `listBranchFacts` | 19,040 | **5.8** | 5.9 | 263,472 | 0 | 3,280× |
| `consolidationBatch` | 22,892 | **6.7** | 6.7 | 303,392 | 0 | 3,420× |
| `branchSummary` | 21,769 | **185.0** | 185.4 | 307,384 | 1,996 | 118× |
| `citationProblem` (20 facts) | 2,760 | **3.0** | 3.0 | 39,920 | 0 | 920× |
| footer counts (enabled) | 19,701 | **7.6** | 12.8 | 263,472 | 0 | 2,590× |
| host `session_start` (disabled) | 19,474 | **8.1** | 9.4 | 263,472 | 0 | 2,400× |
| host `before_agent_start` (disabled) | 19,288 | **7.6** | 7.6 | 263,472 | 0 | 2,540× |
| host `before_provider_request` (disabled) | 19,496 | **7.4** | 7.4 | 263,472 | 0 | 2,630× |

Cold samples after the change: 5.7 / 7.6 / 195.4 / 3.2 / 8.0 / 9.3 / 8.1 / 7.5 ms — the cold and warm
cases no longer differ materially, because the work is no longer proportional to the Raw volume.

Scaling, baseline → larger fixture (2× the evidence, 2× the facts):

| | before | after |
|---|---|---|
| `listBranchFacts` | 19,040 → 75,636 ms (**×3.97**) | 5.8 → 12.3 ms (**×2.1**) |
| `consolidationBatch` | 22,892 → 85,412 ms (**×3.73**) | 6.7 → 14.6 ms (**×2.2**) |
| source reads | 263,472 → 1,042,272 (×3.96) | 0 → 0 |

The near-fourfold growth is gone; what is left grows with the evidence, not with its square. Larger
size after the change, in full: `branchSummary` 345.7 ms, `citationProblem` 6.2 ms, footer counts
14.2 ms, disabled callbacks 14.6 / 21.7 / 13.9 ms.

**Byte-identical output.** Beyond the equivalence assertions in the unit tests, the four named reads
were captured on the fixture with the pre-change source and again with the post-change source, and
the two captures compare equal byte for byte (`cmp`): `listBranchFacts` (22,483 chars of serialized
facts), `consolidationBatch` (19,122), `branchSummary` (38,792), `citationProblem` on the branch and
on the sibling path under session and project scope, plus `listCurrentKnowledge`, the sibling
branch's facts and carry, and `inject`.

The footer text is identical too: `🧠 <dim>○</dim> trace-memory Disabled 19/132 $0.00` before and
after.

New tests (7 cases, all in `npm test`):

- `tests/core/store/path-snapshot.test.ts` — membership is built once whatever the fact count (twice
  the facts, the same number of builds); identity questions load no Raw payload while branch carry
  reads each entry once; the shared snapshot returns exactly what the per-fact rebuild returns, with
  bindings and through the address fallback; a same-Turn sibling occurrence stays off the other
  branch; and a second `Store` connection's new fact, new consolidation progress, new fact relation
  and shortened selected ancestry are all seen by the next read.
- `tests/hosts/pi/footer.test.ts` — the displayed counts equal `listBranchFacts` /
  `listCurrentKnowledge` / `spend`, enabled and disabled; and a disabled session's `session_start`,
  `before_agent_start` and `before_provider_request` load no Raw payload, build no per-fact path,
  dispatch no model, reconcile nothing and keep all data.

The remaining path-semantics cases the ticket lists are already pinned by existing tests, which run
against the new snapshot unchanged: tree restoration and explicit project change
(`tests/hosts/pi/index.test.ts` "explicit project names share across sessions and survive tree
restoration without moving peers", "declaring an own project moves facts and project knowledge…"),
shared ancestors (`rulings.test.ts` "pre-fork evidence applies to both branches and rejects the
sibling's stale base atomically"), foreign-session evidence ("supports obeys the
session/project/global scope table", "cross-session concurrent edits reject linearly"),
archive/update/merge ("archive has empty text and retires its parent only on its applicable path",
"two tips surface as alternatives to a third session and merge by explicit commits"), and the
same-Turn sibling at host level (`entries.test.ts` "a sibling entry of the same Turn is off-path for
facts and knowledge, not only for note").

## 5. Revert probes

Each mutation was applied on its own, the affected test file run, then the file restored from a
pre-probe copy and verified with `cmp` (all three reported byte-for-byte restoration; the full suite
is green again afterwards).

| Probe | Mutation | Test that goes red |
|---|---|---|
| 1 | `listBranchFacts` drops the shared snapshot and lets `factOnPath` rebuild the path per fact (its default argument) | `tests/core/store/path-snapshot.test.ts` › "22a: applicability is answered from one membership per operation, whatever the fact count" **and** `tests/hosts/pi/footer.test.ts` › "22a: a disabled session's callbacks refresh the footer without reading history or rebuilding the path per fact" |
| 2 | `showSpend` counts by enumerating the session's facts and revalidating each against the path | `tests/hosts/pi/footer.test.ts` › "22a: a disabled session's callbacks refresh the footer without reading history or rebuilding the path per fact" |
| 3 | `pathSnapshot` memoises into a `Store`-lifetime map keyed by the path | `tests/core/store/path-snapshot.test.ts` › "22a: a snapshot never outlives its operation, so another connection's writes are seen" (`expected [ 'fact 0', 'fact 1', 'fact 2', …(2) ] to deeply equal [ 'fact 0' ]`) |

## 6. Line delta, and what is not met

`src/` net **+60 lines** (`+90 −30`): `src/core/store/index.ts` +87 −27, `src/core/api/read.ts`
+3 −3. Roughly 20 of the added lines are the doc comments on the new primitive. `src/hosts/pi/`
is untouched. Test and fixture additions, none of them shipped in the package: `tests/perf/fixture.ts`
229, `tests/perf/run.ts` 159, `tests/core/store/path-snapshot.test.ts` 150,
`tests/hosts/pi/footer.test.ts` 73; `package.json` gains the `perf` script.

Public surface changes inside core: `factOnPath`, `commitApplies`, `consolidatedOnPath` and
`citationProblem` take an optional `PathSnapshot` where they took `turns`/`entries`/`runs`;
`listBranchFacts` gains an optional fourth argument; `pathEntries` became private (it had no caller
outside the store). Two-argument calls — every call in the tests — are unaffected.

**Not met / left for later slices, stated plainly:**

1. **`branchSummary` is 185 ms (346 ms at the larger size), above the 100 ms figure.** Its own
   acceptance target (tenfold) is met at 118×, and the 100 ms budget in the ticket covers footer
   refreshes and status-only callbacks, not the tree-switch carry. The residue is not applicability:
   it is `pendingEntries` → `sourcePath`, which loads and parses every entry of the selected ancestry
   (1,996 reads) only to drop the ones a Noting run already took, and then renders. That is hotspot
   family 2 (ticket 22b, "reconciliation and trigger accounting"), and 22b can take it to a handful
   of reads by filtering on `noted_entries` before loading. I did not do it here because it is
   outside this slice's stated scope and the shortest correct diff for 22a does not need it.
2. **"Every enabled-session callback that only refreshes status" is not a category that exists.** On
   an enabled session every callback reconciles native history first (`reconcile`), which this slice
   does not touch; the footer's own three reads cost 7.6 ms (p95 12.8 ms) and the disabled callbacks,
   which are exactly "refresh status and nothing else", are 7.4–9.4 ms. The enabled-callback figure
   will be a 22b number.
3. **`spend()` still loads every run's full request and response body** to sum usage (hotspot family
   7, ticket 22d). It is inside the footer's 7.6 ms on this fixture only because the fixture's runs
   carry small bodies; a session with large audit bodies will show it. Unchanged here by design.
4. **The larger fixture's pre-change numbers are a single cold sample** for `listBranchFacts` and
   `consolidationBatch` only. Running the full pre-change sweep at that size would have taken about
   half an hour of serial wall clock for numbers that only confirm the quadratic; the growth factors
   are reported from that single sample and marked as such.
5. **`p95` with three or five repeats is the maximum of the warm samples**, not a true 95th
   percentile. The runner records the sample count with every table.
