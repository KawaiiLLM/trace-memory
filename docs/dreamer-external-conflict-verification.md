# Ticket 34b verification record

**Historical evidence for Ticket 34b, superseded by Ticket 64.** Test names, commands and outcomes below belong to that branch and do not establish current acceptance. See [the domain glossary](../CONTEXT.md) and [current core behavior](core.md#dreamer-execution) for the replacement contract.

## Baseline and scope

- **Base:** `5d5c81b` (accepted Ticket 34a).
- **Branch:** `feat/34b-path-processing`.
- **Worktree:** `/private/tmp/tm-34-implementation.Ipow6l/34b`.
- **Scope:** path-conflict guards, Consolidator correction, Dreamer exact processing, restored-version discovery and owned documentation only. Ticket 34c was not merged into this branch.

All automated checks use temporary or in-memory SQLite databases and fake providers. No network service, installed extension, production database or production configuration is used.

## Focused behavior evidence

| Contract | Tests |
|---|---|
| Immutable equal/ancestor/divergent origins, same-Turn siblings, shared evidence, inapplicable later evidence, independent sessions | `tests/core/api/path-processing.test.ts` |
| Transaction guard across update, archive, split and each merge parent | Parameterized operation matrix in `path-processing.test.ts` |
| Consolidator unresolved ordinary failure and complete-read correction | `tests/core/api/consolidation.test.ts`; `tests/core/api/processing-material.test.ts` |
| Consumed-input success, exact event settlement, empty certificate set, finalization race | `path-processing.test.ts`, `dreaming-conflict.test.ts`, `dreaming.test.ts` |
| Formal/own candidate construction, split/archive leaves, no outside adoption, prior legal commit audit | `dreaming.test.ts`, `dreaming-conflict.test.ts` |
| Narrow reference-only conflict, mixed real failures, cancellation, authority and streak persistence across process reopen | `dreaming-conflict.test.ts` |
| Restored uncertified predecessor discovery and certified exclusion | `path-processing.test.ts`, `tests/core/store/processing.test.ts` |
| Whole shared-result component admission, independent progress, retained capacity and exact remaining work | `path-processing.test.ts`, `dreaming-conflict.test.ts` |
| Native scheduling: no completion chaining, next-entry processing, independent seats and bounded recovery (recovery removed by 73) | `tests/hosts/pi/dreaming.test.ts`, `tests/hosts/pi/recovery-dreaming.test.ts` |
| Migration preservation and idempotent creation of retained version obligations | `tests/core/store/dreaming-conflict-migration.test.ts` |
| Bounded graph/certificate reads | Existing linear prepare/graph-count regression in `dreaming-conflict.test.ts`; structural performance command below |

The final directed command covers 11 files and **192 tests**, all passing:

```sh
npx vitest run \
  tests/core/api/path-processing.test.ts \
  tests/core/api/dreaming.test.ts \
  tests/core/api/dreaming-conflict.test.ts \
  tests/core/api/consolidation.test.ts \
  tests/core/api/processing-material.test.ts \
  tests/core/api/allocator-increment.test.ts \
  tests/core/api/pending-tokens.test.ts \
  tests/core/store/processing.test.ts \
  tests/core/store/dreaming-conflict-migration.test.ts \
  tests/hosts/pi/dreaming.test.ts \
  tests/hosts/pi/recovery-dreaming.test.ts
```

## Peer-propagation mutation

The distinguishing test is:

`34b: shared-result peer propagation blocks the whole oversized group while an independent event completes`

Its fixture gives two retained events one shared merge result, gives the second event an additional divergent current result, and adds a separate fitting event. One member's result fits; the whole peer component exceeds 10,000 tokens. The normal implementation supplies, settles and certifies only the independent event and leaves the whole shared component pending.

Exact mutation in `Store.dreamingInputSnapshot().components()`:

```diff
 for (const result of eventResults.get(id) ?? []) {
   results.add(result);
-  for (const peer of resultEvents.get(result) ?? [])
-    if (!visited.has(peer)) pending.push(peer);
+  // shared-result peers deliberately not propagated
 }
```

With that compiling mutation, the targeted run failed the external result assertion at `tests/core/api/path-processing.test.ts:232`: expected Dreamer outcome `success`, received `failure` after the mutated admission partially exposed the shared group. After restoring production code, the same targeted run passed (**1 passed, 12 skipped**).

## Final implementation checks

- `npm run typecheck`: passed.
- The directed 11-file Vitest command above: **11 files, 192 tests passed**.
- `npm run smoke:pi`: passed on Node 24.6.0, including native Noting, Dreamer recovery and the 600/1,500-entry long-history checks.
- `npm run smoke:package`: passed; the offline tarball contained 42 shipped files and installed, discovered and loaded without network access.
- `npm run perf`: completed on the synthetic baseline and large fixtures. A first run exposed repeated ancestry walks in the new exact-version projection (about 3.7 s warm for large-fixture eligibility and 2.8 s for admission). The implementation was corrected to share applicability memoization, reuse the admission graph and walk current-result ancestry once. The post-fix three-sample run measured 126.6 ms warm eligibility and 93.8 ms warm admission on the large fixture (baseline log: 57.0 ms and 78.8 ms); graph-resolution counts remained 0 for eligibility and one shared admission graph. These synthetic timings are diagnostic comparisons, not an SLA.
- `git diff --check`: passed after the final changes.

## Verification boundaries

The complete repository suite is intentionally not run on this branch. The parent integration owner will combine 34b with Ticket 34c, run the full suite and perform cross-ticket review.

Real-data processing acceptance is **unverified** because no authorized transactionally consistent database copy was supplied. No claim is made about production latency distributions, query counts, traversal/render work or an accepted real-data baseline. The synthetic checks are regression evidence only and define no numeric production SLA.
