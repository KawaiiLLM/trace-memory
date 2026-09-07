# Ticket 18b acceptance report

**Ready for acceptor review.** Baseline: `54bf613`, **Ticket 18b: apply the Noting/Consolidation rename left over in the summary line**, read with `git log -1 --oneline` before implementation. The initial working tree was clean; HEAD remains unchanged and all implementation changes are unstaged and uncommitted.

Read: 18b and its parent (section "Manual catchup and stop", "Menu and configuration", acceptance scenarios 18–21); 17c and its report (executor slots, target claims, token fence, `cancelTasks`/`forceTasks`, shutdown deadline); 18a's report (menu, enrollment, settings layering); `hosts/pi/README.md`, `core/README.md`, `.scratch/v1/spec.md`, `CONTEXT.md`; `hosts/pi/test-host.ts`; the existing `hosts/pi/catchup.test.ts`, `enrollment.test.ts`, `batching.test.ts`, `core/api/rulings.test.ts`.

Repository additions are English; conversation fixtures are unaffected (none touched). No dependencies, migration, new scheduler, worker pool or claim system were added. No native child-session runtime was introduced. Every pre-existing file under `.scratch/v1/issues/` compares byte-identical to `54bf613`; only this report is new there.

## Verification

The initial suite and final restored implementation were executed locally on Node 24.6.0, using Vitest and temporary SQLite databases, entirely in the foreground with bounded polling (no unattended background waits).

| Check | Before | After |
|---|---:|---:|
| `npm test` | 451 passed, 20 files, independently rerun | 465 passed, 21 files |
| `npm run typecheck` | Passed | Passed after all probe restorations |
| `npm run smoke:pi` | Not rerun at baseline | Passed: one Noting run and one fact |
| `git diff --check` | Clean tree | Passed |
| Required full-suite revert probes | Not applicable | Three named red results, each restored byte-for-byte |
| HEAD / staged changes / new commits | `54bf613` / none / none | `54bf613` / none / none |

Fourteen new cases: thirteen in `hosts/pi/manual-catchup.test.ts` (new file) and one in `core/api/rulings.test.ts` (a core-level unit test of the shared `boundary` mechanism, added there because it needs no host simulation). All new titles begin **18b 2026-09-08:**. Every existing 17a/17b/17c/18a case is retained and green.

## Acceptance evidence

### Ticket checkboxes

| Checkbox | Implementation | Behavioral evidence |
|---|---|---|
| Parent scenarios 18–21 | See table below | See table below |
| Revert probe (a): manual drain expands its snapshot with later entries | `core/api/index.ts` `execute`'s pre-freeze emptiness check and `core/noting/index.ts` `freezeNoting` / `core/consolidation/index.ts` `freezeConsolidation` filter by the optional `boundary` | `core/api/rulings.test.ts` **18b 2026-09-08: a frozen manual boundary excludes entries and facts added after it was captured, even though they are on-path** |
| Revert probe (b): batches chain outside a manual catchup | `hosts/pi/index.ts` `driveCatchup`'s own stop/outcome gates are the only place a next batch is scheduled on completion | `hosts/pi/manual-catchup.test.ts` **18b 2026-09-08: stop prevents the next batch from being scheduled even when the in-flight one wins its commit race** |
| Revert probe (c): stop releases another owner's claim | `core/store/index.ts` `invalidateExecutor`'s `WHERE executor_id = ?` scoping | `hosts/pi/manual-catchup.test.ts` **18b 2026-09-08: stop invalidates only this executor's own claims, never a foreign owner's active claim** |

### Parent scenarios

| Scenario | Implementation | Behavioral evidence |
|---|---|---|
| 18. Manual finite drain | `startCatchup` freezes `{sessionId, branch, headTurnId, maxEntryId, factIds}` from `memory.pendingEntries`/`store.consolidationBatch` at invocation time; `driveCatchup` drains bounded Noting batches against `boundary.maxEntryId`, then one Consolidation batch against `boundary.factIds` (frozen facts plus every id a successful Noting batch adds); disabled/enrollment and empty-target checks precede any store or model work | **manual catchup drains bounded Noting batches then integrates the frozen-plus-produced facts; later entries and facts stay outside the target** drains a 3-batch backlog plus 2 pre-existing manual facts, checks the Consolidation run's committed fact set equals exactly the frozen-plus-produced set, then adds a later Turn and a later fact and shows they are excluded and the reported completion total is unchanged. **an empty target completes without a model call; a disabled session rejects catchup without enrolling** checks the disabled-rejection creates no session, the no-reply case is a no-op, and a second catchup over an already-drained target sends no request |
| 19. Capacity and command parity | `driveCatchup` checks `slots.has(phase)` and a live foreign `store.getClaim` before attempting, setting `waitingPhase` without stealing; `startCatchup` reports the existing operation instead of creating a second one; the menu's "Catch up" option and `/trace catchup` both call `startCatchup` | **an occupied local slot shows Waiting and resumes on release; repeating catchup reports the same operation** occupies the Noting slot with an ordinary automatic run, shows the repeated command reporting the same Waiting state, then shows the freed slot resuming the drain into Consolidation. **a foreign claim on the target shows Waiting without stealing it; the menu reaches the same controller as the command** holds a raw `acquireClaim` from a second `TraceMemory` instance, shows Waiting from both the command and the menu path, then shows the next ordinary opportunity resuming after release |
| 20. Stop and resume | `stopCatchup` sets the controller's stop flag and calls `memory.cancelTasks()` (not the `stopping` form); `driveCatchup`'s top guard and its settle handler's `c.stopped` check prevent any further scheduling | **stop during a Noting batch cancels it, leaves it pending, repeating stop is harmless, and a later catchup resumes it**; **stop while waiting for an occupied slot prevents the frozen batch from ever starting**; **stop during Consolidation cancels it and preserves an already-committed Noting batch** (asserts the prior successful run and its facts are untouched); **stop prevents the next batch from being scheduled even when the in-flight one wins its commit race** (the probe-b test); **stop invalidates only this executor's own claims, never a foreign owner's active claim** (the probe-c test) |
| 21. Drain lifecycle | `toggle(false)`, `session_shutdown` and `restore` (tree-switch-away comparison of `catchup.sessionId`/`branch` against the new `state`) all set `catchup.stopped` (and `outcome` when idle) and call `memory.cancelTasks()`; none retarget the frozen task or resume the drain automatically | **disable cancels an in-flight catchup batch; re-enable does not auto-resume the drain**; **switching tree paths during catchup ends it; it is never redirected and does not resume on reopen** (forks to an unrelated session mid-drain, then restores the original path and shows no automatic resumption); **a failure after one successful Noting batch preserves it and stops the drain with a visible diagnostic** |
| (standing) No completion chaining outside catchup | `checkQueues`'s own settle `finally` and its own trailing call are gated by `if (catchup) driveCatchup();`; ordinary/borrowed completion never itself schedules a next batch | **an ordinary worker's completion does not chain a follow-up batch outside an active manual catchup** (also the test bounding revert probe (b)'s first, abandoned mutation attempt — see below) |

## Design choices and deletions

- **Host-local controller, no new core mechanism beyond one boundary field.** The catchup controller (`Catchup` type, `catchup` variable, `driveCatchup`/`startCatchup`/`stopCatchup`/`catchupProgress`/`catchupLine`/`hasBackgroundWork`) lives entirely in `hosts/pi/index.ts`, matching the design guidance that freezing, chaining, waiting and cancellation are host concerns. The only core change is `TaskOptions.boundary?: { maxEntryId?: number; factIds?: number[] }` (shared by `NotingInput`/`ConsolidateInput`), read by `freezeNoting`, `freezeConsolidation` and `execute`'s pre-freeze emptiness check. No second selection path, second queue, worker pool or claim table was added.
- **Reused verbatim from 17c:** the executor's `slots` Set (one Noter/Consolidator slot), `store.acquireClaim`/`getClaim`/`releaseClaim`, the token fence in `requireClaim`, `memory.cancelTasks()`/`forceTasks()`, and the shared five-second shutdown cleanup. Manual catchup calls `memory.noting`/`memory.consolidate` with `borrowed: false, automatic: false` — the same "manual bypass" path `execute`'s `eligible()` callback already had (`!input.automatic || input.borrowed` returns `true` immediately), so no new admission branch was needed for "ignore normal thresholds."
- **Shared admission helper (subtraction).** `attemptPhase` factors the "resolve mode/model, guard on enabled, resolve the registry model, build capacity, call `noting`/`consolidate`" logic that `checkQueues`'s inline `attempt` closure and `driveCatchup` both need, out of a single shared function. `checkQueues`'s own `attempt` closure (~15 duplicated lines) was deleted in favor of calling `attemptPhase`; `driveCatchup` reuses the same function instead of a second near-duplicate implementation.
- **Reconciliation and freeze reuse.** `startCatchup` calls the existing `reconcile(false)` (17a) before reading `pendingEntries`/`consolidationBatch` to compute the frozen boundary — no new reconciliation path.
- **Progress computed on demand, not tracked incrementally.** `catchupProgress` recomputes remaining entries/facts against the frozen boundary from the store on every call, rather than maintaining running counters that could drift from a concurrently-processing ordinary/borrowed worker touching the same underlying queue. `factTotal` is the one piece of state that grows (as Noting produces facts the frozen Consolidation target must also cover); everything else is a live re-derivation.
- **Synchronous Waiting detection.** `driveCatchup` peeks `memory.store.getClaim` directly (a read-only, already-public store method) before attempting a phase, so a live foreign claim is reported as Waiting immediately rather than only after an async "dropped" round-trip. This is a small addition of my own (not specified verbatim by the ticket) needed because the alternative — waiting for the async attempt to fail — would report "running" for one tick before flipping to "waiting" in a fake host's synchronous status check; a live TUI would not notice the difference, but the design is more honest either way.
- **Own re-derivation of the frozen fact set feeding into a single Consolidation call.** Unlike Noting (which is chunked by `noting.batchTokens`), `freezeConsolidation` already takes its whole selected range in one call (no existing token-based splitting), so the catchup controller only ever needs at most one Consolidation attempt per remaining nonempty subset, matching existing behavior rather than inventing a second batching scheme.
- **Nothing else deleted.** 18b is additive; no existing mechanism from 17a/17b/17c/18a was removed. The one net simplification is the `attemptPhase` extraction described above.

## Revert probes

Each probe was run entirely in the foreground with bounded polling (no unattended background waits): apply the mutation, verify the byte diff, run `npm test -- --reporter=json --outputFile=...`, read the JSON for `numFailedTests`/`numTotalTests` and the failing titles, then restore the original bytes and reverify with `shasum -a 256`.

| Probe | Named red test | Failed / total | Restored file SHA-256 |
|---|---|---:|---|
| `expand-frozen-boundary` | **18b 2026-09-08: a frozen manual boundary excludes entries and facts added after it was captured, even though they are on-path** | 1 / 464 | `core/noting/index.ts` = `68eaeface2eddf5ca872ffb74bcfb7fa0c6f0b981825d61576e01c3711b79757` |
| `chain-outside-catchup` | **18b 2026-09-08: stop prevents the next batch from being scheduled even when the in-flight one wins its commit race** | 1 / 465 | `hosts/pi/index.ts` = `19af15fe8bc2d5af005516922349c8113002303a7a4a2b25ea1d0133ef445d22` |
| `stop-releases-foreign-claim` | **18b 2026-09-08: stop invalidates only this executor's own claims, never a foreign owner's active claim** (also **17c 2026-09-08: two active executors share target claims and the loser selects another target**) | 2 / 465 | `core/store/index.ts` = `d3f16c50a51d411e1a1a991150fce3f50e4c5fd29f2f9c6918d5e2f6316b16ce` |

### `expand-frozen-boundary`

```diff
--- core/noting/index.ts
+++ core/noting/index.ts (pre-ticket behavior probe)
@@ -60,7 +60,7 @@
     !Number.isSafeInteger(input.capacity.prefixTokens) || input.capacity.prefixTokens < 0)) throw new Error("Invalid Noting capacity: expected nonnegative safe integers");
   const pendingAll = store.pendingEntries(session.id, input.branch, input.headTurnId);
   // A manual catchup (18b) freezes an entry-id boundary so later arrivals never join this target.
-  const pending = input.boundary?.maxEntryId === undefined ? pendingAll : pendingAll.filter(e => e.id <= input.boundary!.maxEntryId!);
+  const pending = pendingAll;
   const entries: typeof pending = [];
```

Run against the full suite: 1 failed / 464 total (this probe was applied before the `chain-outside-catchup` test existed, at 464 total tests). Restored and reverified byte-identical (`68eaeface2eddf5ca872ffb74bcfb7fa0c6f0b981825d61576e01c3711b79757`).

### `chain-outside-catchup`

This probe took two attempts; both are recorded honestly.

**Attempt 1 (abandoned — too broad to run against the full suite).** The most literal reading of "chain batches outside a manual catchup" is to let an *ordinary* (non-catchup) automatic completion also schedule its own next batch:

```diff
--- hosts/pi/index.ts
+++ hosts/pi/index.ts (pre-ticket behavior probe, attempt 1 — abandoned)
@@ -628,7 +628,8 @@
       const settled = promise.then(result => reportProblems(result, context), error => {
         activity.last = "error"; context.ui.notify(String(error), "error");
       }).finally(() => { slots.delete(kind); pending.delete(settled); activity.running.delete(kind); showSpend(context);
-        if (catchup) driveCatchup(); }); // 18b: a slot release is one of the two events that may resume a waiting catchup.
+        checkQueues(); });
```

Run against a bounded copy of `hosts/pi/manual-catchup.test.ts` alone, this correctly turned **an ordinary worker's completion does not chain a follow-up batch outside an active manual catchup** red in ~6s. Run against the full suite it never finished: `hosts/pi/branch.test.ts` and `hosts/pi/index.test.ts` both use deliberately tiny thresholds (`noting.triggerTokens: 60`, `consolidation.triggerUnconsolidatedFacts: 1`) together with a provider that always produces a fresh committable fact; under this mutation each commit's own re-check finds something newly due again, producing genuine unbounded Noting/Consolidation alternation in those files rather than a single extra tick. Two independent full-suite attempts were killed after exceeding 90–100 seconds with the worker processes still at ~100% CPU and no JSON report written; this is a real, reproducible property of the mutation given the existing fixtures, not a fluke. Because it cannot be verified against the required full suite in bounded time, this mutation was abandoned as probe evidence (its diff and finding are kept here for the record, not as the accepted probe).

**Attempt 2 (accepted).** A narrower, always-bounded mutation confined to the catchup controller itself: remove the two places that let `stopCatchup` actually end continuation.

```diff
--- hosts/pi/index.ts
+++ hosts/pi/index.ts (pre-ticket behavior probe, attempt 2 — accepted)
@@ -656,7 +656,7 @@
   const hasBackgroundWork = () => runningKind("noting") || runningKind("consolidation") || !!(catchup && !catchup.outcome);
   const driveCatchup = () => {
     const c = catchup;
-    if (!c || c.stopped || c.outcome || closed) return;
+    if (!c || c.outcome || closed) return;
     const context = ctx;
     const own = { sessionId: c.sessionId, branch: c.branch, headTurnId: c.headTurnId };
     const p = catchupProgress(c);
@@ -681,7 +681,6 @@
         for (const f of (result as { facts: { id: number }[] }).facts) if (!c.factIds.has(f.id)) { c.factIds.add(f.id); c.factTotal++; }
       reportProblems(result, context);
       const outcome = (result as { outcome?: string }).outcome;
-      if (c.stopped) { c.outcome = "stopped"; return; } // Stop wins the race: no further chaining, whatever this batch returned.
       if (outcome === "dropped") { c.waitingPhase = phase; return; } // A foreign claim on our own target; retry on the next opportunity.
       if (outcome !== "success" && outcome !== "empty") {
         c.outcome = outcome === "cancelled" ? "stopped" : "failed";
```

Run against the full suite *before* adding a dedicated test for the exact race this guards: **0 failed / 464 total** — inert. Every reachable path in the existing tests (including the three other stop tests already written) halts anyway through the unmodified `outcome !== "success" && outcome !== "empty"` branch, because any batch cancelled by `cancelTasks()` returns `"cancelled"`, and any batch whose commit is rejected by 17c's own token fence (the claim's `expires_at` was already zeroed by `invalidateExecutor`) returns `"failure"` — both already set `c.outcome` and stop the chain regardless of the removed `c.stopped` checks. The only gap is a batch that *wins* its commit race — it fully commits, synchronously, before `cancelTasks()` invalidates the token — and *then* stop is requested; per 17c ("a business commit that wins first stays successful"), that batch legitimately returns `"success"`, and without the removed checks nothing stops the next one from being scheduled.

That race is real but not naturally reachable from outside the host in a fake-provider test (any attempt to call `/trace stop` after the fact races the already-scheduled continuation of the *same* microtask chain that performed the commit, so stop always loses that race from the test's vantage point, not wins it). A dedicated test manufactures it directly with `vi.spyOn(Store.prototype, "commitNotingRun")` — a *prototype*-level spy, which intercepts the extension's own private internal `Store` instance too, not only the test's separate observer instance — letting the real transaction commit first, then synchronously invoking `/trace stop`, then returning the already-successful result unchanged. Re-running the full suite with the same diff above and this test present: **1 failed / 465 total**, isolating exactly **18b 2026-09-08: stop prevents the next batch from being scheduled even when the in-flight one wins its commit race**. Both full-suite runs finished in well under a minute. Restored and reverified byte-identical (`19af15fe8bc2d5af005516922349c8113002303a7a4a2b25ea1d0133ef445d22`).

As a byproduct of this investigation, **an ordinary worker's completion does not chain a follow-up batch outside an active manual catchup** was hardened to park any request beyond the first on an abort-aware never-resolving promise, so it fails fast and deterministically (instead of racing a real commit) if attempt 1's broader regression is ever reintroduced in a form that reaches only that one file.

### `stop-releases-foreign-claim`

```diff
--- core/store/index.ts
+++ core/store/index.ts (pre-ticket behavior probe)
@@ -651,7 +651,7 @@
   }
 
   invalidateExecutor(executorId: string): void {
-    this.db.prepare("UPDATE task_claims SET expires_at = 0 WHERE executor_id = ?").run(executorId);
+    this.db.prepare("UPDATE task_claims SET expires_at = 0").run();
   }
```

Run against the full suite: 2 failed / 465 total — **18b 2026-09-08: stop invalidates only this executor's own claims, never a foreign owner's active claim** and, independently, the pre-existing **17c 2026-09-08: two active executors share target claims and the loser selects another target** (both exercise the same `WHERE executor_id = ?` scoping from different angles). Restored and reverified byte-identical (`d3f16c50a51d411e1a1a991150fce3f50e4c5fd29f2f9c6918d5e2f6316b16ce`).

No compilation error was accepted as probe evidence; every red result above is a Vitest assertion failure inside a full, completed run.

## Production line delta

Counts compare the final working tree with `54bf613`; blank lines/comments count. Runtime TypeScript and edited contract documentation are included. Tests (`core/api/rulings.test.ts`'s addition, the new `hosts/pi/manual-catchup.test.ts`) and this report are excluded.

| File | Before | After | Added | Removed | Net |
|---|---:|---:|---:|---:|---:|
| `.scratch/v1/spec.md` | 363 | 425 | +69 | -7 | +62 |
| `CONTEXT.md` | 55 | 57 | +2 | -0 | +2 |
| `core/README.md` | 332 | 349 | +17 | -0 | +17 |
| `core/api/index.ts` | 364 | 374 | +13 | -3 | +10 |
| `core/consolidation/index.ts` | 149 | 152 | +4 | -1 | +3 |
| `core/noting/index.ts` | 168 | 170 | +3 | -1 | +2 |
| `hosts/pi/README.md` | 681 | 739 | +64 | -6 | +58 |
| `hosts/pi/index.ts` | 731 | 848 | +139 | -22 | +117 |
| Total | 2843 | 3114 | +311 | -40 | +271 |

The removed lines in `hosts/pi/index.ts` are the inline `attempt` closure `checkQueues` no longer needs (replaced by the shared `attemptPhase`) and the two-line "Catch up and Stop are 18b" README/spec placeholders that this ticket resolves. No source/progress membership, knowledge operation, delivery SQL or claim-table schema changed; the only store change is the additive `boundary` read inside two existing freeze functions and `execute`'s emptiness check, which is data, not schema.

## Standards review

Not a separate independent-reviewer pass in this session; the implementing agent's own full-suite, typecheck and three revert probes (including one intentionally abandoned, over-broad mutation attempt kept for the record) are the acceptance evidence here. No remaining concrete blocker was found by that process.

## Acceptance self-check and remaining work

- [x] Parent scenarios 18–21 mapped to implementation and executed evidence.
- [x] All three named revert probes red on the full suite, each restored byte-for-byte and reverified.
- [x] 451 existing cases retained; 465 final tests green; typecheck, smoke and `git diff --check` pass.
- [x] No dependencies, migration, new scheduler/worker pool/claim system, or native child-session runtime added; 17c's slots/claims/token-fence/cancellation and 17b's thresholds reused unchanged for every non-catchup path.
- [x] No staging, commits, or existing `.scratch/v1/issues/` file modified.
- [ ] Live Pi/TUI acceptance was not performed. The catchup/stop menu entries, dialogs and status line were exercised only through the fake Pi host (`hosts/pi/test-host.ts`) and a real temporary SQLite database, not a live terminal session or a real provider.

Deliberate limits carried over from 17c/18a and not reopened here: normally-closed-only borrowed targets, thirty-minute claims without renewal, best-effort remote cancellation, unknown missing usage, and the existing process-death precommit audit gap. New to 18b: the "commit wins its race while stop is requested" path exists and is guarded, but is only reachable in practice through the exact timing this report's dedicated test manufactures with a prototype-level spy — a live provider would need genuinely concurrent stop and commit to exercise it, which this suite does not attempt to simulate beyond that one synthetic case. The synchronous foreign-claim peek in `driveCatchup` is a small design addition of my own (documented above) rather than a literal instruction from the ticket text.
