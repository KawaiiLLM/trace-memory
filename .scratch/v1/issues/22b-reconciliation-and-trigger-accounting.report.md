# 22b — Reconciliation proportional to new evidence, and a trigger that stops at its threshold (report)

Baseline commit `842c02b` (22a); the tree was clean before this work and every change below is left
unstaged and uncommitted. No schema change, no migration, no new dependency, no scheduler, no chunked
import, no in-progress marker or fence. `npm test` 587 passed (580 before, 7 new cases),
`npm run typecheck`, `npm run smoke:pi`, `npm run smoke:package` and `git diff --check` all pass.

Everything below was measured on `node v24.6.0 darwin/arm64`, serially, with `npm run perf --
baseline --repeats=3` (first sample cold, the rest warm), on the shared fixture 22a generated:
**1,999 source entries, 14.8 M Raw characters, 647 Turns** (heaviest with 40 tool calls), 132 facts,
30 pending entries; and the larger one, **3,951 entries, 28.7 M Raw characters, 1,292 Turns**.
"Reads" counts calls that load and parse a whole Raw payload (`Store.getSourceEntry`), through the
test-only prototype wrapper 22a added — production carries no hook. No provider request is made in
any of it; the runner fails if one is.

## 1. What the runner had to grow first, and the baseline it recorded

22a's fixture is a database. Hotspot family 1 is a *host* operation — enabling memory on an existing
native conversation — so `tests/perf/fixture.ts` gained `nativeAncestry()`: the same seeded
generator, emitted as the Pi ancestry a host reconciles (repeated prompts, non-text user boundaries
every 17th Turn, one Turn of 40 calls, a second native occurrence of one tool call). `tests/perf/run.ts`
gained two scenario groups: the host's own `/trace enable`, repeat enable and post-warm-up callbacks,
and the Noting trigger on a copy of the fixture whose Noting progress is removed, so the audit's
"the trigger alone, 1,566 pending entries" has a public reproduction. Both were written and the
baseline recorded **before** any `src/` change; the numbers below are two independent pre-change runs
(they agreed to within 2%).

| Scenario (baseline size) | before ms (warm) | before reads |
|---|---|---|
| host `/trace enable` — the one-time import | **42,872** | 707,686 |
| host `/trace enable` again | 266 | 3,992 |
| host `agent_end`, one short new exchange after warm-up | 410 | 6,000 |
| host `tool_result` after warm-up | 946 | 14,038 |
| host `agent_settled`, nothing new | 0.0 | 0 |
| host 50 `message_update`, unchanged persisted leaf (total) | 0.7 | 0 |
| `taskEligibility` noting — the trigger alone, 1,996 pending | **2,117** | 1,996 |
| `taskEligibility` noting — the trigger alone, 30 pending | 165 | 1,996 |
| `pendingEntries`, whole selected path (30 pending of 1,996) | 153 | 1,996 |
| `branchSummary` (22a's stated residue) | 185 | 1,996 |

707,686 reads for 1,996 entries is the per-result rescan: every tool result reread every source entry
before it. The audit's own figures (21.8 s, 763,629 reads on 1,852 entries) are the same shape; this
fixture is slower because its Raw payloads are larger.

## 2. What changed, and why

### The tool result finds its call (`src/hosts/pi/index.ts`, `walk`)

The walk now carries a map from one Turn's offer of a call id to the call, filled as it goes: an
assistant entry offers its calls under `<turnId> <callId>`, a later entry supersedes an earlier one,
and the first occurrence inside an entry wins — the order the rescan searched in (it reversed the
selected entries and took the first matching call of the newest assistant entry of that Turn). A tool
result then resolves its call with one map lookup. Turn boundaries are in the key; the selected
ancestry and native lineage decide what enters the map, because only the entries this walk selected
ever offer anything.

### Unchanged ancestry is not re-validated (`walk`, `reconciled`)

`reconciled` holds what the previous walk established: the ancestry prefix it covered (`ids`), and
the state that prefix produced — lineage, current Turn, selected entry ids, seen native ids and the
call map. The next walk trusts it **only when the ancestry still begins with exactly that prefix**,
and then starts at its end. A tree navigation, a fork, a lineage change or any shortened ancestry is
not a prefix and rebuilds from the start; restoration (`session_start`, `session_tree`, a changed Pi
session id) and the enrollment switch drop it outright. It lives in process memory only.

The content-identity check is untouched for every entry the walk checks: an entry that is looked up
still fails `known.raw !== JSON.stringify(message)` into `missing(... changed after persistence)`.
What the trusted prefix decides is *which entries are new*, never that a changed message is unchanged
— and any rebuild checks them all again.

### The trigger stops at its threshold (`src/core/api/index.ts`, `notingDue`)

Pending entries are rendered one at a time and joined with the batch's own `\n\n`, and the answer is
returned as soon as `tokens(joined) >= noting.triggerTokens`. The estimate is still of one joined
string — independently estimated views are never summed — so the boundary is exactly the old one; the
work is bounded by the threshold. `freezeNoting`'s batch selection is untouched.

### The path stops loading Raw to decide membership (`src/core/store/index.ts`)

- `pathEntryIds` answers membership from `turn_id` and the branch's stored order (`json_each`'s key
  preserves it). `sourcePath` is now that plus one load per entry it returns.
- `pendingEntryIds` subtracts `noted_entries` from those ids **before** any content is loaded, which
  is 22a's §6 residue: `pendingEntries` used to load all 1,996 path entries to drop the 1,966 a
  Noting run had already taken. It is also what lets the trigger read only as far as it needs.
- `selectSourcePath` counts ownership in one query instead of loading every selected entry's Raw
  payload. This runs on every walk, so it was the last whole-history read on an ordinary boundary.

### What was deliberately *not* built

**The rendered-view memo (item 4) is not implemented.** It is permitted ("may be memoized"), not
required by any acceptance line, and after the four changes above no target needs it: the trigger is
43–55 ms and `branchSummary` 43 ms, both inside the 100 ms budget, and ordinary callbacks are 6–13 ms.
Against that, the key the ticket proposes — entry id, render configuration, view version — does not
satisfy the constraint it cites ("keys sufficient to identify the immutable source") in a process that
opens more than one database: entry id 1 of two databases is two different sources, and the test suite
and any second `TraceMemory` instance do exactly that. A key that would satisfy it has to carry the
entry's own content, which costs a linear pass per lookup and retains the whole Raw volume in memory.
Adding it would have been speculative generality with a correctness hazard; the measurements are in §3.

## 3. Which ruling each choice satisfies

| Choice | Ruling |
|---|---|
| callId→(Turn, ordinal) map built while walking; Turn boundaries, lineage, selected ancestry and existing order decide ties | Parent 22: "Match tool results against the appropriate tool-call occurrences without rereading every preceding source entry for each result. Respect Turn boundaries, native lineage, selected ancestry, and existing ordering when tool identifiers or text repeat." |
| Trusted prefix, in process memory, dropped on restoration/navigation/lineage change/divergence | Parent 22: "Reuse validated, unchanged ancestry and process newly persisted entries incrementally where the native source-identity contract permits it. Rebuild or invalidate the necessary state on restoration, tree navigation, lineage changes, or incompatible checkpoints." |
| `known.raw` comparison kept for every checked entry | Parent 22: "Keep checks for inconsistent persisted source content. Identical text is not source identity"; 22b probe 3. |
| Trigger renders incrementally against the same joined representation | Parent 22: "Avoid rendering and estimating all pending material again merely to establish whether a threshold is reached. Preserve the existing joined representation's token accounting… naive addition of independently estimated strings is not assumed equivalent." |
| `freezeNoting`, batch ceilings and the audit range untouched | Parent 22: "Reuse does not change batch membership, current-material ceilings, or the relationship between the prepared material and the exact write/audit range" — pinned by `tests/core/api/trigger.test.ts` "stopping at the threshold does not change what the batch selects", and by the unchanged `rulings.test.ts` / `budget-repairs.test.ts` batch cases. |
| Membership and ownership from identity columns and `json_each`; no new column or table | Parent 22: "Read identity metadata rather than full Raw payloads when that metadata is sufficient"; "Preserve existing database contents and schemas". `git diff` contains no schema statement. |
| No memo, no scheduler, no chunking, no fences | Parent 22: "A performance problem alone is not authorization for a new scheduler, service, persistent job system, dependency, or worker-process architecture"; 22b amendment "Bounded steps deferred"; "Reuse compressed Raw views **only** with keys sufficient to identify the immutable source". |
| Enabling imports without dispatching anything | Parent 22: "Enabling or recovering history does not itself authorize paid extraction, synthetic completion events, or unbounded queue draining" — `/trace enable` reconciles with `check = false`; the perf runner and both smokes assert zero provider requests. |
| The walk stays inside one synchronous `store.transaction` | Parent 22: "Do not hold a write transaction across an asynchronous yield, model request, or wait for UI input" — nothing in `walk` awaits. |
| Thresholds, enrollment rule, prompts, schemas, renderer output untouched | Parent 22: "Preserve … enrollment baseline rule, trigger thresholds, and ordinary-versus-manual-catchup scheduling semantics"; 22b out of scope. |

## 4. Results

Same fixture files before and after (the databases were generated before the work and reused).

| Scenario (baseline size: 1,999 entries, 14.8 M chars) | before warm | after cold | after warm | before reads | after reads | change |
|---|---|---|---|---|---|---|
| host `/trace enable` — the one-time import | 42,872 ms | 522 ms | — | 707,686 | **1,996** | **82×**, reads 355× |
| host `/trace enable` again | 266 ms | 142 ms | — | 3,992 | 1,996 | 1.9× |
| host `agent_end`, short new exchange | 410 ms | 7.0 | **6.3 ms** | 6,000 | **6** | **65×** |
| host `tool_result` | 946 ms | 14.6 | **13.2 ms** | 14,038 | **21** | **72×** |
| host `agent_settled`, nothing new | 0.0 ms | 0.6 | 0.0 ms | 0 | 0 | unchanged |
| host 50 `message_update`, unchanged leaf | 0.7 ms | 1.2 | 0.6 ms | 0 | 0 | unchanged |
| trigger alone, 1,996 pending | 2,117 ms | 59.3 | **54.8 ms** | 1,996 | **38** | **39×** |
| trigger alone, 30 pending | 165 ms | 43.8 | 43.1 ms | 1,996 | 30 | 3.8× |
| `pendingEntries`, 30 pending of 1,996 | 153 ms | 4.6 | 4.6 ms | 1,996 | 30 | 33× |
| `pendingEntries`, all 1,996 pending | 137 ms | 131.3 | 128.2 ms | 1,996 | 1,996 | unchanged, by design |
| `branchSummary` (22a's residue) | 185 ms | 50.1 | **43.4 ms** | 1,996 | 30 | 4.3× |

`p95` equals the warm maximum over three samples; the runner records the sample count with every table.
22a's untouched scenarios are unchanged: `listBranchFacts` 5.5 ms, `consolidationBatch` 9.3 ms,
`citationProblem` 3.0 ms, footer counts 7.4 ms, disabled callbacks 7.3–7.5 ms, 0 reads each.

**Scaling, baseline → larger fixture (1.98× the entries, 1.94× the Raw):**

| | baseline | larger | factor |
|---|---|---|---|
| import | 522 ms / 1,996 reads | 1,056 ms / 3,948 reads | **×2.02** — linear |
| trigger, whole backlog pending | 54.8 ms / 38 reads | 57.4 ms / 38 reads | **×1.05** — the threshold, not the backlog |
| `agent_end`, the same short exchange | 6.3 ms / 6 reads | 13.1 ms / 6 reads | ×2.08 reads unchanged (see §7) |
| `tool_result` | 13.2 ms / 21 reads | 26.0 ms / 21 reads | ×1.97, reads unchanged |
| 50 `message_update`, unchanged leaf | 0.6 ms / 0 reads | 0.6 ms / 0 reads | ×1.0 |

**The import is 522 ms on the baseline workload — well inside the amendment's 2 s gate, so the
parent's "bound its uninterrupted work" clause does not apply and no chunked preparation, in-progress
marker or fence was built.** It is one synchronous segment, which is longer than the parent's 250 ms
uninterrupted-segment figure; the amendment governs, and the number is reported here rather than
treated as authorization to build the machinery.

**The imported rows are identical.** The same ancestry was imported through `/trace enable` with the
pre-change source and again with the post-change source, and every stored row was dumped and
compared: 1 session, **646 Turns, 686 tool calls, 1,996 source entries** (id, session, native lineage,
native id, turn id, content length and SHA-256 of the whole stored content), the one `source_paths`
row, and the empty `noted_entries` / `facts` / `runs`. The two dumps are equal except for the
session's own wall-clock `started_at` / `first_reply_at` / `closed_at`, which are `now()` at import
time. Attribution — which result completed which call, in which Turn, with which ordinal — is inside
those compared rows.

## 5. Tests (7 new cases, all in `npm test`)

`tests/hosts/pi/reconciliation.test.ts`

- *a tool result finds its call without rereading the entries before it* — 10 and 40 Turns of
  prompt/reply/result where **every Turn reuses the same call id**; each result completes its own
  Turn's own call, nothing is reported missing, and the import's reads are ≤ 2 per entry and grow
  with the history rather than with its square.
- *an ordinary boundary costs what is new, not what the session already holds* — after warm-up a
  fixed two-entry exchange costs fewer than 10 reads, **the same number after the retained history is
  doubled**, and 50 streaming updates on an unchanged leaf read nothing at all.
- *a persisted message changed under a known identity is still reported when it is checked* — a
  mutated native message is reported on the next restoration, and the original Raw is kept.
- *tree navigation and a foreign lineage rebuild the reconciled ancestry* — navigating back to an
  earlier point moves to a new branch whose selected path is the common prefix, and a new result on
  that shorter ancestry matches that ancestry's call.

`tests/core/api/trigger.test.ts`

- *fires at the boundary the whole-backlog estimate fired at, and stops there* — for the threshold
  the joined prefix first reaches at entry *n*, exactly *n* entries are read and not one more; the
  whole backlog's own estimate is due, one token above it is not.
- *costs the threshold, not the backlog* — 200 and 2,000 pending entries, the same reads.
- *stopping at the threshold does not change what the batch selects* — the frozen batch is identical
  with a threshold of 10,000 and of 1.

`tests/hosts/pi/smoke.ts` gained the long-history regression the ticket requires of the package
smoke, so it runs against the **installed** entry: 600 and 1,500 native entries with one repeated
call id, imported through `/trace enable`; every result completes its own call, nothing missing, no
provider request, and 2.5× the history may not cost 3× the time. Installed run: 600 entries in 62 ms,
1,500 in 149 ms, ordinary boundary 6 ms. With the rescan restored it reports
`the import grew faster than the history: 600 entries in 493 ms, 1500 in 2970 ms` and fails.

## 6. Revert probes

Each mutation was applied on its own, the affected suite run, then the file restored from a pre-probe
copy and verified with `cmp` (all three restored byte for byte; the full suite is green afterwards).

| Probe | Mutation | Test that goes red |
|---|---|---|
| 1 | `walk` restores the per-result rescan over `selected` | `tests/hosts/pi/reconciliation.test.ts` › "22b: a tool result finds its call without rereading the entries before it" — `expected 2540 to be less than or equal to 240` (the read counter). `npm run smoke:pi` also fails, on the installed-entry scaling gate. |
| 2 | `taskEligibility` restores whole-backlog rendering | `tests/core/api/trigger.test.ts` › "22b: the trigger fires at the boundary the whole-backlog estimate fired at, and stops there" (`expected 240 to be 143`) **and** › "22b: the trigger costs the threshold, not the backlog" (`expected 2000 to be 200`) |
| 3 | `walk` drops the content-identity check on a known entry | `tests/hosts/pi/reconciliation.test.ts` › "22b: a persisted message changed under a known identity is still reported when it is checked" (`expected false to be true`) |

## 7. Line delta, and what is not met

`src/` net **+60 lines** (`+76 −16`): `src/hosts/pi/index.ts` +38 −9, `src/core/store/index.ts`
+24 −5, `src/core/api/index.ts` +14 −2. About 22 of the added lines are the doc comments on the
resumed-walk state and the two new store queries. Test and fixture additions, none shipped in the
package: `tests/hosts/pi/reconciliation.test.ts` 126, `tests/core/api/trigger.test.ts` 107,
`tests/perf/run.ts` +111, `tests/perf/fixture.ts` +47, `tests/hosts/pi/smoke.ts` +51. Public surface:
`Store.pendingEntryIds` is new, `Store.pathEntryIds` is private; no signature changed.

**Not met / stated plainly:**

1. **"Doubling the retained history does not double the cost of a fixed small appended exchange" is
   not met literally.** The same two-entry exchange costs 6.3 ms at 1,996 entries and 13.1 ms at
   3,948 (×2.08). It reads **6 Raw payloads either way**, so the parent's own sentence — "must not
   incur repeated whole-history rendering as the retained history grows" — is met; what remains is
   linear in the *number* of entries at about 3 µs each. Profiled at 3,948 entries: the noting
   trigger's path membership 5.8 ms, the consolidation trigger's `consolidationBatch` 4.4 ms,
   `selectSourcePath`'s ownership check and path write 0.9 ms. Two of those three are one path
   membership built twice per boundary, once per queue; the third is inherent to `source_paths`
   storing the whole selected path as one array. Removing them means either sharing a snapshot across
   the two queues' triggers (a read-scoped change 22a's primitive would carry, but the parent rules
   read-scoped reuse per operation) or an incremental selected-path format (a schema question, out of
   scope here). At 100 ms the budget is reached at roughly 30,000 entries.
2. **`pendingEntries` on a backlog where everything is pending is unchanged** (128 ms for 1,996
   entries), and cannot improve: every entry it returns must be loaded. The 33× gain is in the
   ordinary case, where most of the path is already noted.
3. **The rendered-view memo (item 4) was not built**, for the reasons in §2. If a later slice wants
   it, the safe key is the entry's stored content, not its id.
4. **The trigger still costs 43 ms with 30 pending entries** on this fixture, because those 30
   entries are 20 KB tool results and the threshold is never reached, so all 30 are rendered. That is
   the honest worst case of the fixed algorithm: an unreachable threshold reads the whole backlog
   once. It is inside the 100 ms budget here and is the case a view memo would help most.
5. **`p95` with three repeats is the maximum of the warm samples**, not a true 95th percentile, and
   the import and repeat-enable figures are single shots by nature (the second import has nothing to
   import). Both pre-change runs are reported in §1 so the comparison does not rest on one sample.
