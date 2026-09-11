# Unified-entry verification

Worktree: `/private/tmp/tm-unified-entry-raw-budget`, branch `feat/unified-entry-raw-budget`. Baseline: `dfdeda694c9f280680e2ef018cdb37e9d3c35bdd`. Implementation and regressions: `3f88f32c6bcb2b8c48c69cc8cfa8a5c7487a3db9`. No main-branch integration, publishing, production database, host configuration or live provider work is part of this change.

The original acceptance record below is retained unchanged. The [Sol repair record](#sol-review-repairs) records the subsequent fixes and their validation.

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

## Sol review repairs

Implementation: `db97a2191ee5d45d0bd4d8f597e9c4fad7dfa9b7`, an ordinary new commit after the reviewed `94bdf393c979748bb6638148926b8e863b995f53`. The baseline remains `dfdeda694c9f280680e2ef018cdb37e9d3c35bdd`. Only this worktree and branch were changed; no amend, reset, merge, release, production database, real installation or host configuration change was performed.

**Withdrawn finding — deliberately unchanged.** The reviewer withdrew the initial claim that truncated Raw falsely covers facts. Optional consolidated facts still deduplicate against bounded Raw using complete entry bindings; pending facts remain complete. No change was made to `visible.ts`, no word-for-word coverage mechanism was introduced, and this existing contract was neither widened nor narrowed.

The five remaining findings have the following dispositions:

| Finding | Disposition | Regression evidence |
| --- | --- | --- |
| Empty path selection widened to the whole session | Fixed: stored path existence, not selected-row count, decides fallback. Empty collections remain empty; an absent exact E errors. Full changes ceilings only. Unbound and missing-path legacy reads remain available, including cross-session reads. | `sol-repairs.test.ts`: empty Turn selection, explicit empty path, sibling, full, exact E, legacy and unbound reads |
| Single E with selector shared its block budget | Fixed: child-budget level follows the selected E container independently of its selector. Turn/list/range entry budgets and automatic whole-entry E2k remain unchanged; call/result ceilings remain independently 100. | Multiple text blocks, role/text selectors, ranges/lists, default/null and call/result leaf ceilings |
| Fork material repeated earlier head bodies | Fixed: only the actual path-tail assistant entry can be a missing head supplement, and only when selected and withheld from Raw. The entire frozen index remains, as identity mapping. Head and index count toward episodic/model capacity; the audit records the actual head view. | Mixed visible/supplied entries, several assistant messages, shorter batch than path, one body per increment, full index membership and one-token capacity boundary |
| Mixed whole-entry citation bypassed completion checks | Fixed: one cached citation resolution supplies entry/block hits for eligibility, binding and completion; one live path read serves a submission. Every cited dispatch needs a cited result with the same Turn/call ID on this path. Text-only delivery sources and historical text aliases remain valid; no natural-language success classifier was added. | Manual/Noter parity; mixed entry, pure call, explicit call/text, matching/unrelated/sibling results, reported/dispatched/attempted, legacy and multiple sources |
| Semantic previews added framing after fitting | Fixed: the shared semantic fitter measures group headings/separators and walk indentation/terminal text before fitting the body. Identity/evidence metadata cannot be truncated to fit. Automatic fact/knowledge selection remains whole. | Single F, grouped Turn facts, intervals, multiple groups, project facts, walks, small-cap errors, pagination, and existing complete-K-handle regressions |

The index premise needed correction: the reviewed `renderEntryIndex` already emitted omission floors, not complete Raw bodies. The repair replaces those floors with smaller identity-only mappings; it does not claim to have removed a second full-Raw renderer. The actual head duplication was the restatement of earlier assistant entries already inherited in the captured context. Three older fixture assertions were updated because their synthetic order ends with a tool result, not the earlier assistant text they had called the final reply.

### Token and capacity evidence

Both comparisons use synthetic fixtures, never real conversation logs. `tests/perf/unified-entry-drift.ts` reran against the original baseline renderer. Raw and complete fact bytes, estimates and trigger/batch boundaries are unchanged by these repairs:

| Fixed 240-entry / 60-fact fixture | Original baseline | After repairs |
| --- | ---: | ---: |
| Joined Raw bytes / tokens | 106,606 / 24,180 | 108,406 / 25,500 |
| First 10k Noting crossing | Entry 99 | Entry 94 |
| 10k whole-entry batch ends | 98, 196, 240 | 93, 187, 240 |
| Grouped complete fact bytes / tokens | 27,932 / 7,079 | 28,952 / 7,499 |
| First 5k Consolidation crossing | Fact 43 | Fact 41 |
| 10k whole-fact content prefix | 60 | 60 |

Thus the original Raw +5.46% and facts +5.93% estimates remain fixture observations, not claims about real logs. The additional Noter guidance changes the reviewed prompt from 14,496 bytes / 3,300 tokens to 14,920 / 3,385, a fixed +85-token cost. Tool metadata remains 7,293 bytes / 1,743 tokens. No threshold, estimator, E2k/C100/R100 profile or material-window limit changed.

`tests/perf/unified-entry-sol.ts` compares the actual pre-repair and repaired freezes from isolated archives. Both select the same oldest 93 entries from this fixture; their indexes retain all 93 identities. In mixed mode, 31 entries are supplied in Raw. Neither batch includes the actual path-tail reply, so both correctly have zero head tokens in this fixture; the head-supplement cases are separate regressions.

| Source-index / increment measure | Reviewed implementation | Repaired implementation |
| --- | ---: | ---: |
| Index bytes / tokens | 6,905 / 2,410 | 3,648 / 2,063 |
| All-visible increment tokens | 2,432 | 2,085 |
| Mixed increment tokens | 5,759 | 5,412 |
| All-visible exact input capacity, including prompt and 173 inherited tokens | 5,905 | 5,643 |
| Mixed exact input capacity, same accounting | 9,232 | 8,970 |

The index saves 347 tokens; after the +85-token instruction change, each tested fork's total input floor falls by 262 tokens. Each freeze succeeds at its measured capacity and rejects one token below it with exact membership, rather than shrinking the target. Pending status still measures 25,500 joined Raw tokens and triggers from the same rendered bytes.

### Changes and checks

Relative to the reviewed commit, production source changes are **+112 / −79 lines, net +33** across nine files. Relative to the original baseline, production totals are **+557 / −204, net +353** across twelve files. These counts exclude tests and documentation. Removed duplicate work includes separate citation reparsing for eligibility/binding/completion, repeated per-citation path scans, body-based index rendering, and replaying every assistant body in the batch's last Turn. The shared Raw renderer, source-block authority and semantic fitter remain the common primitives.

Checks ran in the requested order. Logs are retained under `.scratch/sol-repair/`:

| Check | Result | Log |
| --- | --- | --- |
| Targeted regressions | 9 files, 269 tests passed | `targeted-final.log` |
| TypeScript | Passed | `typecheck-1.log` |
| Full Vitest, one worker, cache disabled | 91 files, 1,342 tests passed; no unhandled errors | `full-1.log` |
| Pi fake-provider smoke | Native Noting, Dreamer recovery, carrier persistence and long-history checks passed | `pi-smoke-1.log` |
| Isolated offline package smoke | Tarball install, Pi discovery/load and native workers passed; 40 shipped files | `package-smoke-1.log` |
| Serial performance, isolated temporary cache | Both sizes passed, three samples per scenario | `perf-1.log` |
| Fixed drift and source-index capacity | Passed against the original and reviewed archives | `unified-drift.json`, `source-index.json` and their stderr logs |
| Working, baseline and staged diff checks | Passed | `diff-1.log`, `staged-diff.log` |
| Ordinary implementation commit | Preserved | `implementation-commit.log` |

Performance observations on Node 24.6.0, darwin/arm64: the 3,951-entry fixture has 28.7M Raw characters. Warm heavy-Turn full trace is 21.4 ms; bounded assembly is 170.0 ms. Eligibility for a 3,948-entry pending backlog reads only 88 sources in 138.9 ms; the smaller backlog also reads 88. Fifty unchanged-leaf streaming updates take 0.6 ms with zero source reads. These are small fixture samples, not statistically established tail percentiles or production latency guarantees.

Failure logs remain intact: `targeted-initial.log` records four obsolete head/index fixture expectations; `new-regressions-1.log` records a test that initially charged the next block's separator to the previous block. The subsequent targeted logs retain the passing reruns. Earlier `.scratch/` logs and commits were not deleted or rewritten. An initial exploratory parent-directory `find` encountered OS read denials on unrelated temporary mounts; those locations were not pursued. No approval refusal was bypassed.

Evidence hashes (SHA-256):

- `unified-drift.json`: `08965e3aa4f29c7fafcd305f20655281cbf6b970446049b38240d6118601d859`
- `source-index.json`: `4adfa10dfd47f1248f7dcc400fc8970e515bd3bfea862079f7b820b9cedab5d1`

Unverified boundaries remain real-provider extraction quality, billing/cache reuse, interactive user acceptance, other SDK/runtime versions and unsupported old schemas. Completion validation establishes structural result evidence, not that the result semantically proves every authored claim. The host's existing fork gate remains responsible for rejecting a captured-context mismatch. Main-branch integration, publishing, real installation and the independent cleanup branch are outside this work. Sol re-review is still pending.

## Completion evidence follow-up

This follow-up starts at `36b4a294c08524bb859cdfc85abe725b8f692336` and addresses only the remaining completion-association blocker. The earlier review records above remain historical; their Turn/call-ID matching rule was insufficient when one Turn reused a call ID.

**Invocation and order.** The shared citation resolution now matches Turn, stored call ordinal and call ID, and requires the cited result to follow its dispatch in the admitted source path. Noter uses its initially frozen path order; manual writes use the current path. Neither immutable E numbers, authored citation order nor the caller's frozen-ID array order substitutes for path order. A position map reuses the already loaded candidates; each submission still reads the source path once. No new database query, session traversal, renderer or semantic classifier was introduced.

**Completion is not success.** A matching failure result can establish that tests ran and failure was observed. Explicit text deliverables and reported/dispatched/attempted facts remain accepted. Unmatched dispatches reject the entire batch without facts, noted-entry settlement or a successful run; manual bounced-run audit records remain intact.

Production changes relative to this follow-up's starting commit are **+11 / −3 lines, net +8**, in two files: `src/core/api/tools.ts` (+10/−2) and the one requested sentence in `src/core/prompts/noting.md` (+1/−1). The prompt now promises every frozen entry and addresses exposed by default bounded Raw, not every thinking block. The withdrawn head/thinking and optional consolidated-fact findings, E2k/C100/R100, visible-view semantics and all four closed items were left unchanged.

### Ordered validation

Runtime checks ran on Node 24.6.0, darwin/arm64, before this audit-only appendix was added. Evidence is retained under `.scratch/completion-repair/`:

| Check | Result | Evidence |
| --- | --- | --- |
| Pre-fix targeted reproduction | 13 expected failures, 33 passes | `targeted-red.log` |
| Targeted regressions | 9 files, 130 tests passed; 46 new completion cases | `targeted-after.log` |
| TypeScript | Passed | `typecheck.log` |
| Full Vitest, one worker, cache disabled | 92 files, 1,388 tests passed | `full.log` |
| Pi fake-provider smoke | Native Noting, Dreamer recovery and long-history checks passed | `pi-smoke.log` |
| Isolated offline package smoke | 40 shipped files; tarball install, Pi load and native workers passed | `package-smoke.log` |
| Serial performance | Both fixture sizes, three samples per scenario, isolated cache | `perf.log` |
| Fixed drift and capacity | Only prompt cost changed; exact-capacity acceptance and one-below rejection passed | `unified-drift.json`, `source-index.json`, `drift-comparison.log` |
| Diff checks | Working diff and both starting-commit/original-baseline comparisons passed | `diff-before-doc.log`, `final-diff.log` |

The new tests cover reused call IDs with different ordinals, an ordinal mismatch even with a later result, results preceding dispatch despite larger E numbers, wrong call IDs, other Turns, siblings, uncited/missing results, matching success/failure, whole entries and exact fragments, manual/Noter parity, frozen membership and live reordering. Rejected mixed batches assert zero facts, zero noted entries and no successful run. Submission-level spies assert one source-path read.

### Drift and retained evidence

Compared with the preceding repair's retained measurements, all Raw/fact bytes, estimates, cumulative prefixes, trigger and batch boundaries, renderer examples, selected source-index members and increment bodies are unchanged. Prompt size moves from 14,920 bytes / 3,385 estimated tokens to 14,988 / 3,397 (+68 bytes / +12 tokens). Tool metadata remains 7,293 bytes / 1,743 tokens. Exact input floors rise only by those 12 prompt tokens: all-visible 5,643 → 5,655; mixed 8,970 → 8,982.

The large performance fixture's 3,948-entry pending backlog still reads 88 sources for Noting eligibility (140.3 ms warm); 50 unchanged-leaf streaming updates read zero sources (0.7 ms warm). These are small synthetic samples, not production latency guarantees. `evidence-sha256.txt` records log hashes; drift JSON SHA-256 is `a3a718072672d88ea067d4ac28d0fff89010c9ee1a88e2b031e43758399f0a35`, and source-index JSON SHA-256 is `5709637a5f720c68f68e6d7e5b0401ff66a788adfc865738d5e7fb114d1c0e26`.

All old logs remain. `targeted-before.log` also retains the first run's incorrect test assumption that fact-binding storage returns path order; the corrected test checks membership, without changing storage. The initial parent-directory search encountered unrelated OS read denials and did not pursue those locations. No approval refusal was bypassed.

**Pending acceptance:** the main agent must arrange Sol's directed final review. Structural result matching does not prove the semantics of every authored claim. Real-provider quality, billing/cache reuse, interactive acceptance, other runtimes and unsupported old schemas remain unverified. No main/cleanup-worktree modification, real database/configuration/installation change, amend, merge or release was performed.
