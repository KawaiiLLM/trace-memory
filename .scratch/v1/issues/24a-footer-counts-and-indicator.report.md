# 24a — Footer counts and indicator (report)

Branch `ticket-24a`, baseline `80e2cb5` (the parent's own baseline). No schema change, no migration,
no new dependency, no timer, no polling scheduler, no new configuration key. `npm test` **639 → 646**
(7 new cases, all passing), `npm run typecheck`, `npm run smoke:pi`, `npm run smoke:package`,
`npm run perf -- --repeats=2` (both sizes) and `git diff --check` all pass.

## 1. The footer, as rendered in each state

| State | Footer |
|---|---|
| Enabled, idle, work in both queues | `🧠 <dim>○</dim> notes: 2->3 memory: 3->1 cost: $0.00` |
| Enabled, nothing pending | `🧠 <dim>○</dim> notes: 0->3 memory: 1->1 cost: $0.12` |
| Noting running (also when Consolidation runs too) | `🧠 <accent>●</accent> notes: 2->0 memory: 0->0 cost: $0.00` |
| Consolidation running | `🧠 <success>●</success> notes: 2->1 memory: 1->0 cost: $0.00` |
| Retry waiting / committed with problems / blocked on a launch condition | `🧠 <warning>●</warning> notes: …` |
| Last task failed | `🧠 <error>●</error> notes: …` |
| Off | `🧠 <dim>○ off</dim>` |
| Enabled, no memory identity allocated yet | `🧠 <dim>○</dim> notes: ?->? memory: ?->? cost: $?` |
| No colour support (Pi's native fallback) | `🧠 ● notes: 2->3 memory: 3->1 cost: $0.00` / `🧠 ○ off` |

(`<role>…</role>` is the fake host's theme renderer; production emits Pi's theme colour for that
role. Every line above is a literal assertion in `tests/hosts/pi/footer.test.ts`, and the off line is
also asserted by the performance runner.)

Reading: `notes` is imported source entries still to note over every committed fact applicable on this
branch (already-consolidated ones included); `memory` is those applicable facts Consolidation has not
taken on this path over the applicable current knowledge; `cost` is this memory session's cumulative
run spend. The arrows are stage inputs and existing outputs, not percentages.

Current session (`/trace status`, and the menu's Status entry) gained the same numbers as a
`Pending:` line, and states the two conditions apart:

```text
Pending: 2 imported entries to note, 0 of 0 applicable facts to consolidate; 0 current knowledge (imported evidence on this branch)
```
```text
Trace Memory: no assistant reply; no memory identity allocated, so no session id and no counts (this is not a claim that no native history exists).
```

## 2. What changed

### One core-owned query for all four counts

`readFacade.progress(sessionId, branch, headTurnId)` (`src/core/api/read.ts`, on the `TraceMemory`
interface) answers the four numbers from **one** 22a path snapshot and the 22b pending-entry
identities:

- `entries` — `store.pendingEntryIds(...).length`. This is a count-only reader by construction: 22b
  already decides pending membership from `noted_entries` against the path's entry **ids**, so no
  Raw payload is loaded. `pendingEntries` (the listing form) would have loaded every entry's Raw; the
  footer uses the id form. That is the one place a listing reader was replaced by a count-only one.
- `facts` — `store.listBranchFacts(..., snapshot)`, the existing 22a call with the shared snapshot.
- `unconsolidated` — a new one-line store primitive `unconsolidated(facts, path, snapshot)` filtering
  by `consolidatedOnPath`, extracted **out of** `consolidationBatch`, which now calls it. One
  definition serves the batch and the footer, so the displayed number cannot drift from the set
  Consolidation will actually take, and it is exact membership, never "applicable facts minus cited".
- `knowledge` — `store.listCurrentKnowledge(path, {}, snapshot)`, so divergent tips of one identity
  count as the two items current-tip semantics say they are.

Three signatures gained an optional prepared-snapshot parameter, the shape 22a already established
(`factOnPath`, `commitApplies`, `consolidatedOnPath`, `listBranchFacts` all have it):
`commitGraph`, `currentSet`/`listCurrentKnowledge`, and `pathEntryIds`/`pendingEntryIds`. Every
existing call site is unchanged, and each still builds its own snapshot when none is passed. The
result is exactly **one** `pathTurns` build for a whole footer refresh, pinned by a test.

`status(sessionId, branch?, headTurnId?)` gained the two optional path arguments and prints the same
counts through the same `progress` call; callers passing only a session id are unaffected.

### The renderer and the indicator

`showSpend` in `src/hosts/pi/index.ts` renders the ruled shape, and off returns before counting
anything at all. The indicator keeps the precedence it already had — off, active retry, running
Noting, running Consolidation, last failure, last warning, idle — which is the parent's table
verbatim; only the off branch changed (from a `Disabled` label to `○ off`). Colours are `theme.fg`
role names as before; a missing or throwing theme prints the same text unpainted.

An unreadable count is `?`, not `0`: the counts and the amount are read in two separate `try`
blocks, so a failure of one does not fabricate the other, and a Pi session with no allocated memory
identity shows `?` for all four rather than four zeros it has no session to compute.

### Refresh points

No new mechanism: `showSpend` was already called at restore/`session_start`, tree switch, each phase
admission and settle, each retry start/end, each run outcome, catchup drive/stop, toggle and Retry
fork. 24a adds it to three existing hooks whose event *is* "this turn's evidence became importable" —
`tool_result`, `agent_end`, and (in a `finally`, so every path through the handler refreshes once)
`agent_settled`. `message_update` deliberately does not refresh: it fires per streaming delta.
Because every refresh re-reads and nothing is cached between refreshes, another connection's commits
appear at the next one; that is asserted.

## 3. Which ruling each choice satisfies

| Choice | Ruling |
|---|---|
| Footer shape `🧠 ● notes: a->b memory: c->d cost: $x`, arrows as stage input/output | Parent 24 "Footer counts and cost", the agreed shape and the count-definition table |
| Off is `🧠 ○ off`, counts remain in Current session | Parent 24 "Indicator semantics": "The off footer may use the compact form" |
| Indicator = theme roles, precedence off → retry → Noting → Consolidation → failure/warning → idle, Noting wins when both run | Parent 24 "Indicator semantics" table and "Retain the existing precedence" |
| A nonzero queue below its trigger stays dim | Parent 24: "Merely remaining below a trigger does not make the indicator yellow" |
| `?` for an unreadable or unallocated value | Parent 24: "an unknown/unavailable value is not a fabricated zero" |
| Unallocated identity stated in status; counts described as imported evidence | Parent 24: "A session without an allocated memory identity remains visibly unallocated in its status details"; "do not present a database zero as proof that all available native history has been processed" |
| `unconsolidated` filters by `consolidatedOnPath`, extracted from `consolidationBatch` | Parent 24: "do not replace pending-fact membership with `total facts minus cited facts`"; 22b exact accounting |
| Pending until the business commit; post-commit failure restores nothing | Parent 24 user story 3 and "An admitted or running batch remains pending until its business transaction commits" |
| Counts carry the branch, so a same-Turn sibling occurrence is excluded | Parent 24: "Preserve same-Turn source-occurrence checks"; 22a review 2026-09-08 (identity, not the shared address, decides). This also **fixed** a latent gap: the old footer's knowledge count passed no branch |
| Current-tip counting unit, divergent tips counted separately | Parent 24: "using the existing current-tip semantics and counting unit"; rulings "two tips surface as alternatives" |
| One snapshot per refresh, passed as an argument, dropped with the read | 22a ruling: "Read-scoped reuse is the default", no longer-lived cache to invalidate — which is why an external commit is seen at the next refresh |
| No Raw, no tokenizing, no freeze, no run body, no scheduler | Parent 24: "Footer updates must not render Raw, tokenize material, freeze tasks, load full run audit bodies, or introduce a polling scheduler" |
| Refreshes ride existing hooks only | Parent 24: "Refresh through existing lifecycle, commit, control, and status-update opportunities" |
| Cost stays session-cumulative, borrowed work charged to its own session | Parent 24 "cost" row and "Trace Memory's `cost` remains session-cumulative"; `listRunUsage` already selects by the run's own session |
| `≤ 100 ms` added p95 | Parent 24: "Preserve the ticket-22 responsiveness target" |
| No schema statement, no new key, no new dependency | Parent 24 "Out of Scope"; `git diff` contains no DDL |

## 4. Performance

`npm run perf -- --repeats=2`, **node v24.6.0 darwin/arm64**, nothing else running. p95 with two
repeats is the maximum of the warm samples (one warm sample), as the runner records. "reads" counts
whole-Raw loads (`Store.getSourceEntry`).

Baseline fixture: 1,999 source entries, 14.8 M Raw characters, 647 Turns, 132 facts (132 on this
branch), 21 knowledge revisions, 30 pending entries, 63.6 MB.
Large fixture: 3,951 entries, 28.7 M Raw characters, 1,292 Turns, 264 facts, 31 pending, 123.4 MB.

| Scenario | baseline cold / warm / p95 ms | large cold / warm / p95 ms | reads |
|---|---|---|---|
| footer counts, enabled (`progress` + `spend`, what `showSpend` reads) | 11.7 / 11.0 / **11.0** | 20.6 / 20.2 / **20.2** | 0 |
| footer `progress` alone (the four counts) | 13.2 / 11.0 / **11.0** | 19.8 / 20.0 / **20.0** | 0 |
| host `session_start`, off session | 1.1 / 0.2 / **0.2** | 0.7 / 0.2 / **0.2** | 0 |
| host `before_agent_start`, off session | 0.1 / 0.0 / **0.0** | 0.0 / 0.0 / **0.0** | 0 |
| host `before_provider_request`, off session | 0.0 / 0.0 / **0.0** | 0.0 / 0.0 / **0.0** | 0 |
| host `agent_end` (now refreshes the footer) | 11.9 / 10.8 / **10.8** | 22.2 / 22.8 / **22.8** | 6 |
| host `agent_settled` (now refreshes the footer) | 4.9 / 4.2 / **4.2** | 11.9 / 10.5 / **10.5** | 0 |
| host `tool_result` (now refreshes the footer) | 18.2 / 18.7 / **18.7** | 36.5 / 34.7 / **34.7** | 17 |
| host 50 × `message_update` (no refresh, by design) | 1.3 / 0.7 / **0.7** | 1.8 / 0.6 / **0.6** | 0 |

The three host callbacks vary run to run at two repeats (a second sweep put `agent_end` at 28.1 ms
and `footer counts` at 12.6 ms on the baseline); the ordering and the margin do not change.

**Every footer scenario is within the 100 ms p95 bound, enabled and disabled.** For comparison with
22a's table, the two-number footer cost 7.6 ms warm / 12.8 ms p95 on the same baseline fixture; four
counts over one shared snapshot cost 11.0 ms. The off state got *cheaper* — 7.4–9.4 ms in 22a, now
0.0–0.2 ms — because the compact line counts nothing. The three enabled callbacks that now refresh
the footer stay far inside the bound at both sizes. No other scenario in the suite moved outside
run-to-run noise, and the runner still fails if any provider request is made (none was).

The full output of both sizes is reproducible with `npm run perf -- --repeats=2`.

## 5. Revert probes

Each mutation was applied on its own to production source, the affected tests run, then the file
restored from a pre-probe copy and verified with `cmp` (all three reported byte-for-byte
restoration; the suite is green again afterwards). No production instrumentation was added for them.

| Probe | Mutation | Test that goes red |
|---|---|---|
| 1 — count work complete before commit | `showSpend`: `if (counts && runningKind("noting")) counts.entries = 0;` — an admitted batch displayed as done | `tests/hosts/pi/footer.test.ts` › "24a: an in-flight batch is still pending, a failed run advances nothing, a commit moves both queues and a post-commit failure restores nothing" (`"entries": "2"` → `"0"`), and › "24a: a cancelled batch advances nothing…" |
| 2 — hardcode a colour | `showSpend`: the Noting branch returns a literal ANSI-coloured `●` instead of `paint("accent", "●")` | `tests/hosts/pi/footer.test.ts` › "24a: the indicator is theme roles in the ruled precedence, Noting wins over Consolidation, and no colour support prints the same line unpainted", and `tests/hosts/pi/index.test.ts` › "the footer indicator follows activity: accent while noting runs…" |
| 3 — count a sibling Turn's evidence | `progress`: the snapshot is built from `{ sessionId, headTurnId }` alone, so Turn membership decides and the branch's own selected entries do not | `tests/hosts/pi/footer.test.ts` › "24a: the counts follow the selected branch, so a sibling entry of the same Turn is neither noted, counted nor applicable here" (`facts 1 → 2`, `knowledge 1 → 0`) — the only red test, which is what isolates the mistake |

## 6. Tests

`tests/hosts/pi/footer.test.ts` is rewritten for 24a (2 cases → 8), keeping 22a's cheapness contract:

1. **Footer meaning** — the shape and each number on a synthetic branch, checked both as a literal
   line and against an independent enumeration (`pendingEntries` / `listBranchFacts` /
   `consolidationBatch` / `listCurrentKnowledge` / `spend`, each rebuilding its own membership);
   committed facts are eligible at once; citing a fact is not consolidating it; a Consolidation
   commit and a Noting commit each move their own queue; and cost counts another executor's work
   *for* this session while this executor's borrowed run is charged to the session it ran for.
2. **Progress boundaries** — an admitted, in-flight batch is still pending; a precommit failure
   advances nothing; the successful commit is what moves both queues at once; a provider failure
   after the commit keeps the progress and shows the warning role.
3. **Cancellation and external writes** — a stopped batch advances nothing and writes no fact;
   another connection's commits are invisible until the next refresh and appear at it.
4. **Same-Turn sibling** — a withdrawal fact and its archive bound to main's occurrence of T1 are not
   counted on the sibling branch, which keeps one fact and its current rule.
5. **Off and idle** — a nonzero queue below its trigger is dim, not warning; off is the compact line
   through five different callbacks, each loading zero Raw payloads, building zero paths, reading
   zero run-audit bytes, importing no Turn or entry of the paused interval and making no request;
   enabling then imports it and the count rises.
6. **Cheapness, enabled** — one path membership, zero Raw payloads, zero run-audit bytes per refresh.
7. **Unallocated identity** — `?` for all four values and no `Pending:` line, versus an allocated
   session whose details carry real zeros.
8. **Indicator** — idle, both phases in flight at once (two requests held at the wire, Noting shown),
   off winning over in-flight work, and the unpainted native fallback.

`tests/core/api/rulings.test.ts` gains one case beside the existing tip rulings: the knowledge count
is the current-tip counting unit (two divergent tips of one identity = 2; the root path sees 1), and
the pending-fact count equals `consolidationBatch`'s length before and after a consolidation commit,
so it is membership and not a subtraction.

Updated: `tests/hosts/pi/index.test.ts` (the footer line for one idle fact),
`tests/hosts/pi/enrollment.test.ts` (the disabled footer is now `🧠 ○ off`), `tests/perf/run.ts`
(the enabled footer scenario measures `progress` + `spend`, a `progress`-only scenario was added,
and the off assertion checks the compact line).

## 7. Line delta, and what is not met

`src/` net **+79 lines** (`+113 −34`); **61 of the 113 added lines are comments** — the footer
contract, the count definitions and the ruled precedence written where the code is — so the net
executable change is roughly +18 lines. Per file: `src/hosts/pi/index.ts` +47 −20,
`src/core/api/read.ts` +38 −1, `src/core/store/index.ts` +22 −12, `src/core/api/index.ts` +6 −1.
Docs: `docs/pi.md` +65 −11 (footer/status sections only, deliberately away from the runsDir sections
24c is editing), `README.md` +1.

Public surface added inside core: `TraceMemory.progress`, `Store.unconsolidated`, an optional third
argument on `commitGraph`/`listCurrentKnowledge` and an optional fourth on `pendingEntryIds`, and two
optional arguments on `status`. Nothing was removed.

**Not met / stated plainly:**

1. **An unreadable count is silent.** A failing `progress` or `spend` renders `?` and does not notify.
   A notice on every refresh would be a loop, and the parent only requires that an unknown is not a
   zero. The condition is therefore visible in the footer but has no explanation attached to it;
   `/trace status` re-runs the same query and does throw its error to the caller.
2. **The off footer drops the counts from the line entirely**, which is the compact form the parent
   permits; a user who wants them while off must open Current session. `Pending:` there is computed
   on demand, so it is not free — but it is a user-initiated read, not a refresh.
3. **`p95` with `--repeats=2` is the maximum of one warm sample.** The runner records the repeat
   count with every table; the numbers above are ~10–20 ms against a 100 ms bound, so the margin does
   not depend on the estimator.
4. **The three added refresh points cost their read on a busy turn.** `tool_result` is 18.7 ms
   (baseline) / 34.7 ms (large) per call, most of which is the pre-existing reconciliation; the
   footer's own share is the 11.0 / 20.2 ms figure. On a history far larger than the large fixture
   this would eventually matter, and the honest lever then is the count query, not the refresh
   points — `listBranchFacts` and the commit graph still scan, which is 22a's known residue.
5. **24a does not touch the command surface.** `/trace enable|disable|status|runs|…` still exist as
   they were; retiring and reshaping them is 24b, which the parent sequenced after this slice and
   which shares these refresh points.
