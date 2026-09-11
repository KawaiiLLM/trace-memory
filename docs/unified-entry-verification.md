# Unified-entry verification

Worktree: `/private/tmp/tm-unified-entry-raw-budget`, branch `feat/unified-entry-raw-budget`. Baseline: `dfdeda694c9f280680e2ef018cdb37e9d3c35bdd`. Implementation and regressions: `3f88f32c6bcb2b8c48c69cc8cfa8a5c7487a3db9`. No main-branch integration, publishing, production database, host configuration or live provider work is part of this change.

## Fixed-fixture token drift

`tests/fixtures/unified-entry.ts` defines 60 bilingual engineering exchanges: 240 native entries and 60 complete facts. Each exchange contains a review request, an assistant text/call message, a test result and an assistant finding. Bodies, ordering, thresholds and the estimator are fixed. The comparison executes the actual baseline renderer from an isolated `git archive`, not a reimplementation kept beside production code.

Reproduce from this worktree:

```sh
mkdir -p .scratch/baseline
# Extract into an unused directory; retain earlier verification artifacts.
git archive dfdeda694c9f280680e2ef018cdb37e9d3c35bdd | tar -x -C .scratch/baseline
node tests/perf/unified-entry-drift.ts .scratch/baseline > .scratch/unified-drift.json
```

The extracted baseline needs access to the existing development dependencies. The verification used a relative `node_modules` symlink inside that extracted directory; it did not install or change the main checkout's dependencies.

| Actual rendered material | Baseline | Unified | Difference |
| --- | ---: | ---: | ---: |
| Joined Raw UTF-8 bytes | 106,606 | 108,406 | +1,800 (+1.69%) |
| Joined Raw estimated tokens | 24,180 | 25,500 | +1,320 (+5.46%) |
| First 10k Noting crossing, entry position | 99 | 94 | 5 entries earlier |
| 10k whole-entry batch end positions | 98, 196, 240 | 93, 187, 240 | Earlier cuts; no skipped entries |
| Grouped complete facts UTF-8 bytes | 27,932 | 28,952 | +1,020 (+3.65%) |
| Grouped complete facts estimated tokens | 7,079 | 7,499 | +420 (+5.93%) |
| First 5k Consolidation crossing, fact position | 43 | 41 | 2 facts earlier |
| 10k whole-fact content prefix end | 60 | 60 | Both fit; task framing is additional |

The Raw increase is address/role framing, not added thinking. Calls and results keep their existing independent 100-token ceilings; longer labels can therefore retain slightly less payload inside those same ceilings. The JSON report preserves four old/new rendered examples and every cumulative prefix estimate. Fact bodies are identical; the comparison changes only newly authored citations from legacy tool ordinals to exact result-entry/call-ID addresses. Existing stored fact strings are not rewritten.

Fixed worker overhead also changes: the Noter prompt grows from 13,744 bytes / 3,143 estimated tokens to 14,496 / 3,300; shared tool metadata grows from 5,911 / 1,414 to 7,293 / 1,743. This is explicit address/budget/citation guidance, not trigger material. Production thresholds, material windows and estimator constants remain unchanged. Small eager test fixtures use 30 rather than 20 tokens so their unchanged default prompt/reply still triggers after the pair: exact labels now price the user message alone above 20. Capacity fixtures adjust synthetic model windows, never production headroom.

## Regression coverage

- Parser inheritance, selector scope, mixed targets, shorthand knowledge diffs, opaque JSON IDs and legacy quoted project names.
- Persisted ordinal upgrade, restart, branch gaps and simultaneous SQLite connections; native identity reuse.
- Host-normalized block order, absent/ghost fragments, explicit stored thinking, non-text markers and exact frozen source bindings.
- Equivalent JSON spellings preserve authored citations while resolving to the same membership key.
- Per-child and leaf budgets, independent null ceilings, compatibility conflicts, separate call/result completion evidence.
- Frozen cursor ownership/origin/profile/budgets, malformed continuation rejection, lossless Unicode, whole-line nonmonotone admission and page-sized continuation work.
- Chronological fact groups, unchanged semantic selection, complete automatic material, and no exact knowledge handle for a completed truncated preview.
- Exact Raw bytes shared by status, trigger and oldest-prefix batch selection; unchanged 10k/5k production thresholds.

## Production change

Relative to the baseline, the 11 production source files change by **+496 / −176 lines, net +320**. Tests and documentation are excluded from these counts.

| Responsibility | Added | Removed | Net |
| --- | ---: | ---: | ---: |
| Read facade, budgets, cursor completion and tool validation | 143 | 61 | +82 |
| Address grammar and shared source authority | 146 | 0 | +146 |
| Store migration, ordinals and membership metadata | 57 | 32 | +25 |
| Shared rendering and semantic child ceilings | 103 | 70 | +33 |
| Noter material and prompt guidance | 11 | 11 | 0 |
| Pi ordered-block normalization and ingestion wiring | 36 | 2 | +34 |

Removed/replaced paths: the old `renderText` head formatter and `renderSources` preview formatter; naive comma splitting; synthetic compaction-summary source entries; the legacy label-rendering branch; and the standalone `listFactIdsInRange` query replaced by the grouped lazy metadata projection. Core does not decode Pi raw shapes. Legacy citation adaptation remains deliberately narrow; it is not a second renderer. Stable persisted ordinals were retained rather than replaced by repeated read-time ranking.

## Logs and limitations

Earlier failures are retained in `.scratch/`, including the original `.scratch/v1/failures.json`. The resumed baseline host comparison passed 90 tests before fixture updates. A resumed full run initially had 88 failing tests plus a worker failure; a later run had 22 failures with 1,305 passing. These are intermediate results, not acceptance.

The worker out-of-memory failure was reproduced in a thinking fixture: its scripted Consolidator repeatedly submitted an obsolete fixed F1 batch after exact new citations allowed a later Noter batch to succeed. The fixture now submits its actual frozen range; the dedicated 13-test thinking suite passes. No production retry limit or permission was weakened.

One source-store edit received a permission timeout. Its identical normal edit retry succeeded; `.scratch/resumed-permission-denial.log` retains the exact denial. No bypass was used for the denied operation.

The final baseline-to-HEAD diff check also caught one trailing space inherited from the earlier budget-wiring commit. A whitespace-only ordinary follow-up removed it; `.scratch/resumed-baseline-diff-failure.log` preserves the diagnostic. No commit was amended or rebased.

Final checks ran sequentially on the implementation above:

| Check | Result | Log under `.scratch/` |
| --- | --- | --- |
| TypeScript | Passed | `final-typecheck.log` |
| Full Vitest suite, one worker, cache disabled | 90 files, 1,333 tests passed; no unhandled errors | `final-full.log` |
| Pi fake-provider smoke | Native Noting, Dreamer recovery, carrier persistence and long-history checks passed | `final-pi-smoke.log` |
| Isolated offline package smoke | Tarball install, Pi discovery/load, overlay and native workers passed; 40 shipped files | `final-package-smoke.log` |
| Serial performance suite | Both fixture sizes passed, three samples per scenario, isolated temporary cache | `final-perf.log` |
| Whitespace/diff check | Passed | `final-diff-check.log` |

Performance observations on Node 24.6.0, darwin/arm64: the large fixture has 3,951 stored entries and 28.7M Raw characters. A heavy Turn's full trace read takes 17.3 ms warm; bounded assembly takes 146.7 ms. A 3,948-entry pending backlog checks Noting eligibility with 88 source reads in 135.8 ms warm, versus the smaller backlog's same 88 reads. Fifty unchanged-leaf streaming updates take 0.6 ms warm with zero source reads. These are fixture observations, not production latency guarantees or statistically established tail percentiles.

The complete old/new comparison is `.scratch/final-unified-drift.json`, SHA-256 `37efa88b093b2cef1bf05027510f665394a696abd9cc3cde586a3f451dcf83b8`. Earlier logs remain in place; the prior passing check sequence was also retained under `verification-pass1-*`. Generated artifacts and the existing dependency symlink are ignored, not deleted.

Unverified boundaries: real provider extraction quality, billing/cache reuse, real-user interactive acceptance, other SDK/runtime versions and unsupported older development schemas. All database upgrades exercised synthetic fixtures, never production data. No merge, publish, live installation or host configuration change was performed.
