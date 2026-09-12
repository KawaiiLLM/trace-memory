# External-conflict verification

## Review baseline

- **Base:** `862e40684b07bbe2be349d95139038facf9834c6`.
- **Branch:** `fix/dreamer-external-conflict`.
- **Worktree:** `/private/tmp/tm-dreamer-external-conflict`.
- **Contract:** [Dreamer external-successor conflicts](dreamer-external-conflict.md), the user-ruled exception to 32c, with the glossary and core/Pi docs updated.

The production changes are confined to Dreamer acceptance and audit, execution settlement and its real SQLite outcome constraints, the existing tool binding's unresolved-exception tracking, and the Dreamer prompt. No host scheduler, phase seat, cleanup controller, processed-projection algorithm, foreground write authority, package version or dependency changed.

## Acceptance evidence

The offline tests exercise actual commits and graph changes, not diagnostic-string substitutions.

| Requirement | Evidence |
|---|---|
| External update and merge, including a legal own commit first | `tests/core/api/dreaming-conflict.test.ts`: barriers around two independently attributed executors sharing a file database; exact successor identities, own commits, usage, pending events and absent certificates asserted |
| Streak zero/two unchanged through repeated conflicts; next real third failure disables | The same suite checks the whole streak row, including previous reason/run/time, four consecutive conflicts, then real failures |
| Provider, request, invalid batch, scope, stale-handle, tool and budget problems still fail | Parameterized mixed-failure cases retain a real external successor while independently introducing each unresolved failure |
| Cancellation and claim loss retain their existing settlement | Two mixed-cancellation cases assert the durable execution is cancelled, not conflict, with no increment |
| Race before and after final check | A second connection commits immediately before the final transaction; a competing write after final check is rejected by the existing SQLite write lock; a later write remains unprocessed |
| Replay and process reopening | File-backed close/reopen cases and a separate Node process replay failure/cancellation/conflict settlement against the authoritative conflict; streak two remains two, then a real third failure disables |
| Fresh freeze after external merge, without widening writes | Core and native tests preserve the original family and anchor, supply the actual latest body on the next admission and certify only its exact result; external event IDs remain pending unless selected |
| Another target's Dreamer finishes shared events first | Both update and merge cases close the shared range legitimately; the original execution still ends in conflict and creates no additional completion |
| No immediate worker restart; repair and independent seats preserved | `tests/hosts/pi/dreaming.test.ts`: exactly one native worker and one repair, no completion chaining, next entry completion succeeds; existing independent C/D-seat and 50-round tests remain unchanged |
| Public exemption cannot be forged | Fake result text/metadata and fabricated run outcomes fail to issue conflict; public settlement checks run association and rejects untrusted conflict authority |
| Actual legacy CHECK migration | `tests/core/store/dreaming-conflict-migration.test.ts`: old CHECKs reject conflict before reopen; migration preserves runs, execution links, streaks, foreign keys, indexes, triggers and sequences; FK failure rolls back both tables |
| Noter/Consolidator regression | Existing logical-task failure tests and the complete suite remain enabled; no generalized conflict exemption was added |

## Verification commands

Run on Node `v24.6.0`, Darwin arm64. Commands run serially in the isolated worktree; each failed intermediate attempt remains under `.scratch/external-conflict/`, and final logs are under `.scratch/external-conflict/final/`.

| Gate | Command / evidence |
|---|---|
| Directed | Eight core/store/native Dreamer and failure suites, 117 tests; `07-directed.log` |
| TypeScript | `npm run typecheck`; `08-typecheck.log` |
| Complete suite | `npm test`, 94 files and 1,411 tests; `09-full.log` |
| Pi smoke | `npm run smoke:pi`; `10-pi-smoke.log` |
| Installed package smoke | `npm run smoke:package`: offline tarball installation in a temporary consumer, Pi discovery/load and native-worker smoke; `11-package-smoke.log` |
| Serial performance | `npm run perf -- --repeats=3`, both sizes, isolated temporary cache; `12-perf.log` |
| Whitespace / scope | `git diff --check`; `13-diff.log`, followed by staged and base-to-commit checks |

The additional check microbenchmark uses seven fresh in-memory databases at each size, with unchanged families of 10 and 100 identities, against an archive of the exact base and the working implementation. SQL prepare counts remain **200 / 1,550 in both versions**. Warm median times are approximately **1.36 / 11.95 ms at base** and **1.40 / 11.64 ms after**. These numbers show no added per-identity query in classification, not a claim that the existing store is free of linear queries or that all production histories are bounded. The script and raw samples are retained in `.scratch/external-conflict/check-perf.mjs` and `final/14-check-perf-base.log`, `final/15-check-perf-current.log`.

An intermediate full run failed the pre-existing Noter post-commit warning-notice assertion in `tests/hosts/pi/index.test.ts`. The unchanged file passed all 61 tests in isolation; its full-run failure and isolated recheck are retained as `17-full-failure.log` and `18-host-failure-recheck.log`. No host gate or assertion was weakened. Timing is a suspected cause, not a base-reproduced diagnosis; use the final full-suite log for the acceptance result. Earlier old-expectation/fixture failures and a private-method TypeScript error are also retained alongside their subsequent successful checks.

## Follow-up: enlarged successors

The first spec review found a liveness bug after the neutral conflict itself: a processed read-only item could gain an external successor after freeze, and the next admission treated that unprocessed successor as part of the retained changed family. A roughly 6,000-token real pending item plus a roughly 4,500-token read successor therefore exceeded the 10,000-token changed window forever, even though the successor was neither supplied for processing nor eligible for certification.

The follow-up keeps the retained range, anchor, event membership, writable family, runs and streak identity unchanged, but reselects still-unsettled retained events at each later admission. Only current descendants of selected events and unprocessed legal outputs are changed-result candidates. Current descendants of processed read context still prove the first conflict, but remain separate pending events afterwards. Multi-event ranges shrink into whole-result batches; one indivisible oversized result remains pending with a bounded capacity diagnostic while independently fitting events may complete first.

Offline evidence is in `tests/core/api/dreaming-conflict.test.ts`: both update and merge reproduce the 6,000 + 4,500 case; the first check records only the true eligible result, the next admission completes it, and later admission reports the independent real project-scope overflow. Three enlarged events then complete in four bounded batches without moving the retained anchor. A separate 11,000-token successor remains unprocessed and blocks no independently fitting retained event. Logs are retained under `.scratch/external-conflict/followup/`, beginning with `01-independent-repro-red.log` and the corresponding directed green runs.

The final serial run is under `.scratch/external-conflict/followup/final-2/`: 9 directed files and 182 tests, TypeScript, the full 94 files and 1,415 tests, both smoke tests, three-repeat performance fixtures and `git diff --check` all pass. The unchanged-family check microbenchmark remains at 200 SQL prepares for 10 identities and 1,550 for 100; warm medians were 1.40 ms and 11.59 ms. These are local regression measurements, not production latency claims.

## Limits and review split

No real provider, production database/configuration, installed extension or release was exercised or changed. The tests cover actual process reopening, not forced process termination at every SQLite instruction or power-loss recovery. Timing samples are local fixtures, not production-scale multi-process throughput guarantees. An indivisible result over the changed-material cap still requires a legal maintenance path or an explicit product ruling; the implementation does not clip, skip as completed or certify it.

The original Sol reviews are historical evidence for `2c30bf1`. The follow-up is left for the requested later aggregate Astra review; no review, merge or publication is claimed by this implementation handoff.
