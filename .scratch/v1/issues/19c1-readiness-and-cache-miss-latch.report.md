# Ticket 19c, first half — readiness, cache-miss latch and cancellation: acceptance report

**Ready for acceptor review.** Baseline: `055cd68`, *Ticket 19b: core stops assembling model context;
native subagent parity*, read with `git log -1 --oneline` before implementation. The initial working
tree was clean; HEAD is unchanged, nothing is staged and nothing is committed. No pre-existing file
under `.scratch/v1/issues/` was touched; only this report is new there. Everything added is behind the
existing `nativeRunner` switch, which is still off by default. **No part of the second half was
started**: the request-copy runner, the handwritten retry-settings reader, the `branch` spelling and
the historical-run labelling are untouched.

---

## Verification

Every command ran in the foreground on Node 24.6.0 with an explicit timeout; no background waits, no
credentials, no live provider. The whole suite takes ~24 s.

| Check | Before | After |
|---|---:|---:|
| `npm test` | 492 passed, 24 files | 506 passed, 26 files |
| `npm run typecheck` | Passed | Passed, including after both probe restorations |
| `npm run smoke:pi` | Passed | Passed: one Noting run and one fact |
| `git diff --check` | Clean | Clean |
| Revert probes | Not applicable | Two applied, each red on its named test, each restored byte-for-byte |
| HEAD / staged / commits | `055cd68` / none / none | `055cd68` / none / none |

Fourteen new cases, all titled **19c 2026-09-08:** — five in the new `hosts/pi/readiness.test.ts`,
seven in the new `hosts/pi/cache-miss.test.ts`, two appended to `hosts/pi/native.test.ts`. Every
pre-existing case is retained, unchanged and green: no existing test was rewritten or deleted. The
only edit to an existing test file is mechanical (see Design choices, "Test seam").

**Schema:** `sessions` gains `fork_suppressed_at` and `fork_suppressed_run` in place. v1 is
unreleased, so a schema addition needs no migration, exactly as 17c's and 18a's additions did.

## Checkbox and scenario mapping

| Owned checkbox | Implementation | Named test |
|---|---|---|
| A completion before persistence launches nothing; the next safe boundary launches once with a real entry id and no request capture | 17a's reconciliation already walks the persisted ancestry only, and `checkQueues` runs after it; 19c adds nothing here and the test proves it rather than assuming it | **a message completion before persistence launches nothing; the next safe boundary launches once with a real entry id** (fake host, persist-after-emit sequencing; asserts no run and no model call at the completion callback, then exactly one run whose `entryAudit` carries the persisted entry's real native id, with `before_provider_request` never emitted) and **a fork launches from the persisted checkpoint on the existing capture, without a further provider request** |
| A partial multi-tool group defers or falls back | `checkpointReadiness` in `native.ts` (`SessionManager.open` + `getEntry` + `forkable`), called by `forkWait` in `checkQueues` before admission | **a checkpoint with an unanswered tool call defers the launch; the completed group launches it once** (the deferred boundary produces no run, no claim and no progress; completing the group launches one fork run with no fallback) and **the readiness probe rejects an unpersisted checkpoint and an unreadable parent file without creating anything** |
| A tree switch before launch does not substitute the new branch's history | `restore()` already drops the capture and re-identifies the branch; the fork branch additionally refuses when `state.branch !== input.branch` | **a tree switch before the launch does not substitute the new branch's history for the waiting task** (the waiting task's entries stay pending on their branch and are absent from the new run's audit; the new position's run is its own task, `requestedMode: "branch"`, `mode: "subagent"`, capture-missing reason) |
| Cache eligibility: hit, below-minimum, missing/placeholder usage, error/cancellation, disabled/unsupported caching, unknown limits and a prefix-failed request set nothing | `eligibleCacheMiss` + `CACHE_MINIMUM` in `native.ts`; detection guarded by `verification?.passed` and by the fork path being the only caller that subscribes | **cache eligibility rejects hits, small, missing, placeholder and unsupported usage, unknown limits and a disabled cache** (ten cases over the exported function), **a provider error sets no latch, and a cancelled child reports no miss**, **a request that failed the prefix check does not count toward the latch** |
| One eligible miss sets it, warns once, survives reopen, clears only through the explicit reset | `store.suppressFork` (guarded UPDATE) + one `ctx.ui.notify` + the `/trace` menu's Retry fork | **an eligible zero-cache fork response downgrades the session once and neither replays the task nor relabels its mode**, **while the latch is set a requested fork is admitted as a subagent with the cache-miss reason**, **the latch survives reopen and clears only through the menu's Retry fork** |
| Two in-flight phases reporting misses together produce one transition | `UPDATE … WHERE fork_suppressed_at IS NULL` returns whether it changed the row | **two phases reporting a miss together produce one transition and one warning** (Noting and Consolidation both fork in one opportunity, both report an eligible miss, both keep `mode: "branch"`; one warning, one timestamp, and a direct `suppressFork` call afterwards returns `false`) |

| Parent testing scenario | Named test |
|---|---|
| 4. Readiness (completion before persistence, safe boundary, partial multi-tool group, no capture requirement) | the four readiness cases above |
| 10, native part (abort before commit, committed success then a dead reply, child disposal while the parent is active) | **/trace stop cancels the running child after its commit and starts no fresh extraction** plus the retained 19a case *a provider error after the commit keeps the commit and records the problem* |
| 12. Cancel the child while the parent continues | **cancelling one native child disposes only that child; a sibling worker and the parent session continue** (two concurrent children, one aborted; the other completes; parent bytes, id and leaf unchanged and the parent then runs another turn) |
| 14. Cache-miss transition (one commit, no replay, one warning, no new trigger, later tasks subagent) | **an eligible zero-cache fork response …** and **while the latch is set …** |
| 15. Cache eligibility and reset (no false downgrade; warn once; reopen retains; menu-only reset; no reset subcommand; global config and other sessions unchanged) | **cache eligibility rejects …**, **a provider error sets no latch …**, **a request that failed the prefix check …**, **the latch survives reopen and clears only through the menu's Retry fork**, and the unrelated-session/global-config assertions inside **while the latch is set …** |
| 16. Concurrent downgrade (one transition, frozen tasks preserved, a queued fork cannot bypass it) | **two phases reporting a miss together …** and the second-task assertion in **while the latch is set …** |

Ruling coverage, per the standing rule that every ruling an implementation could silently deviate from
gets a named test: gate 3's "only server-side misses after a passing prefix check" is pinned twice (the
prefix-failed case and the eligibility table); "Unknown is not zero" by the ten-case table plus the
error/cancellation case; "No replay" by the commit/one-run assertions; "One warning" by the exact-text
array equality in three tests; "Menu-only reset" by the option list, the absent subcommand and the
"reopen does not clear" assertion; "Trigger versus launch", "Tool-group boundary", "Readiness recheck"
and "Frozen task scope" by the four readiness cases; the Cancellation bullet by the two new native
cases.

## Design choices

**Reused, not invented** (per the standing ruling to copy Pi's own shape first):

- The readiness probe is Pi's own reopen: `SessionManager.open(parentFile)` + `getEntry` +
  `getBranch`, i.e. exactly what `runNative` does at launch, plus 19a's existing `forkable`. It is
  passed *no* session directory, so it uses the parent file's own directory and creates nothing —
  `SessionManager`'s constructor `mkdir`s a supplied session directory, which a read-only probe must
  not do.
- The wait mechanism is the host's existing boundary loop. `checkQueues` already runs after each
  reconciliation of a moved persisted leaf; a not-ready task is simply not offered as a candidate, so
  waiting needs no timer, no queue, no state and no second scheduler, and the next boundary re-decides
  from the live session. This mirrors 18b's rule that a waiting phase is re-evaluated on the next
  opportunity rather than parked.
- The tree-switch comparison is 18b's: compare the frozen target's branch against the currently
  selected one, and drop rather than retarget.
- The latch is one guarded `UPDATE … WHERE … IS NULL` in the store, the same "the row decides, not the
  caller" shape `acquireClaim` uses for 17c's claims. No lock, no in-process mutex, no new table.
- The fallback on a suppressed session is 19b's fallback verbatim: the same `NotForkable` route, the
  same `requestedMode` / `mode` / `fallbackReason` recording, the same fresh child.
- The menu action is native Pi `select` with an option added to the existing current-session list, and
  settings stay read-only; no new command was registered.

**Mine, and why:**

- **Readiness lives before admission, not inside `runAgent`.** Once core has frozen a batch and taken
  a claim, "wait" no longer exists as an option — the run would have to be abandoned. Putting the
  checkpoint question in `checkQueues` is what makes "waiting creates no duplicate task and advances
  no progress" literally true. The launch itself keeps `runNative`'s own persisted/forkable refusals,
  which now act as the documented fallback for the state that changed after the decision.
- **My reading of "No capture dependency" under gate 1** (stated as instructed): gate 1 wins, so a
  fork's first body must still be verified against the captured parent request for this branch, and a
  fork therefore needs *a* capture. What the bullet still requires, and what is implemented, is that a
  fork never waits for a **new** capture: a persisted, valid checkpoint plus the capture already held
  is enough, and the fork may run while the foreground is still inside the same Turn — pinned by *a
  fork launches from the persisted checkpoint on the existing capture, without a further provider
  request*, which asserts that exactly one non-worker request existed in the process. When no capture
  exists for the branch, the task takes the documented subagent fallback with a recorded reason
  instead of waiting.
- **`verification.cacheMiss` rather than a new top-level `cacheMiss` response field** (a deliberate
  deviation from the design guidance's placement, same name and same content). Gate 3 says a miss can
  only be counted for a request that passed the prefix check, so the observation is a property of that
  verification; recording it there also means **no core change at all** for the audit — `verification`
  is already an opaque host field in the run record. It reads as
  `response.verification.cacheMiss = {model, api, minimum, input, cacheRead, cacheWrite}`.
- **The store keeps the detecting run id, linked after the fact.** A miss is observed on the first
  response, before any run row exists, so `suppressFork` sets only the timestamp and `work()` calls
  `linkForkSuppression` once `attemptPhase` returns a `runId`. `linkForkSuppression` refuses to
  overwrite, so a later episode cannot inherit an older run id. Status omits the `on R<n>` clause in
  the window before the run finishes.
- **Two independent guards implement gate 3**, which is why probe (b) needed a two-file mutation: the
  fork path is the only caller that passes `onCacheMiss`, and `runNative` additionally requires
  `verification.passed` before it will report one. A rejected fork's body never leaves the process, so
  the observable form of "a prefix-failed request must not count" is that the *subagent run it falls
  back to* must not count either — that is what the named test asserts.
- **A disabled provider cache is read off the body we sent.** For `anthropic-messages` a body with no
  `cache_control` marker asked for no caching, so its zero read says nothing; OpenAI-family caching is
  automatic and not request-controlled, so it counts as enabled. This is the only way to distinguish
  "cache disabled" from "cache missed" without asking the provider.
- **The counting convention is stated and justified in code**: pi-ai normalizes both families so that
  `input` excludes `cacheRead` and `cacheWrite` (`openai-completions` subtracts them from
  `prompt_tokens`; `anthropic-messages` copies `input_tokens`, which already excludes them), so the
  compared quantity is `input + cacheRead + cacheWrite`. Verified in
  `node_modules/@earendil-works/pi-ai/dist/api/{openai-completions,anthropic-messages}.js`.
- **The warning is exactly the ruled sentence**, with no diagnostics appended; the numbers live in the
  run record, which is where the ruling puts the audit.
- **`state.branch !== input.branch` at launch is defence-in-depth, and I say so.** In the current flow
  the readiness decision and the fork admission happen in the same synchronous block, so no tree
  switch can slip between them; the reachable enforcement of the ruling is that a switch drops the
  capture and re-identifies the branch, which the named test drives. The two-line guard is kept
  because the ruling states an invariant, not an implementation, and any future async gap would
  otherwise reintroduce the substitution silently.
- **The budget stops reserving an inherited prefix for a downgraded session.** `attemptPhase` reserved
  `prefixTokens` whenever the requested mode was branch and a capture existed; under the latch the run
  is fresh-context, so the reservation would shrink the batch for a prefix that will not be sent. One
  `!suppressed()` term, consistent with the existing no-capture case.
- **Test seam: the native fixture moved to `hosts/pi/native-fixture.ts`.** The three test files that
  need a real parent `AgentSession`, a real child fork and the real pi-ai adapters now share one
  fixture instead of three copies. `hosts/pi/native.test.ts` keeps every one of its cases unchanged;
  the diff there is the import header, the moved block and the two new cancellation cases. The
  fixture's only behavioural change is that a scripted response may now be a `Promise<Response>`, so a
  test can hold a reply open while it cancels.
- **One stale documentation line corrected**: the Known limits bullet still said the child body
  "cannot match the captured parent prefix" on `anthropic-messages`, which the gate-1 amendment (and
  19b's own README section) already superseded. Declared here because it is outside the docs this
  dispatch owns.

## Revert probes

Each probe: apply the mutation, confirm the diff, run the **full** suite in the foreground, record the
red titles and counts, restore the original bytes, reverify with `shasum -a 256`, then confirm the
suite is green again.

| Probe | Mutation | Named red test(s) | Failed / total | Restored SHA-256 |
|---|---|---|---:|---|
| (a) Restore a lifecycle-style launch from a completion | `hosts/pi/index.ts`: the assistant-completion handler appends the in-flight message to the walked ancestry under a synthesized `pending-<uuid>` id and forces a reconciliation, so the queue counts the completion before Pi persists it | **19c 2026-09-08: a message completion before persistence launches nothing; the next safe boundary launches once with a real entry id** (a run launches at the completion callback, and its audit carries the synthesized id instead of the persisted one), together with 17a's own pin **17a 2026-09-08: completion alone has no native identity; next safe boundary reconciles persisted entries** | 27 / 506 | `hosts/pi/index.ts` `ab30208bac98dac7b901361cbdcd238c87f8e295c53c1057aac793bce781cebd` |
| (b) Count a prefix-failed request toward the latch | `hosts/pi/native.ts`: drop the `verification?.passed` condition from the miss detection; `hosts/pi/index.ts`: give the fresh-context `runNative` call the same `onCacheMiss` handler as the fork call. Both halves are needed, because either guard alone stops it | **19c 2026-09-08: a request that failed the prefix check does not count toward the latch** (the doctored capture makes the child's first body fail the gate; the task falls back to a subagent whose zero-cache responses now set the latch and warn) | 1 / 506 | `hosts/pi/native.ts` `13d62990f8c6fb2bc1c7bc22f1289856a39cb1362ef515a86df59410c4ae936f`, `hosts/pi/index.ts` `ab30208bac98dac7b901361cbdcd238c87f8e295c53c1057aac793bce781cebd` |

Probe (a)'s blast radius is wide (27 cases across six files) because counting an unpersisted message
corrupts reconciliation for every host test that persists after emitting; the two tests named above
are the ones that name the violated ruling. Probe (b) is narrow because one test owns the ruling.

## Production line delta

| File | + | − |
|---|---:|---:|
| `core/store/index.ts` | 30 | 1 |
| `hosts/pi/native.ts` | 81 | 1 |
| `hosts/pi/index.ts` | 62 | 6 |
| **Production total** | **173** | **8** |
| `hosts/pi/readiness.test.ts` (new, tests) | 142 | 0 |
| `hosts/pi/cache-miss.test.ts` (new, tests) | 198 | 0 |
| `hosts/pi/native-fixture.ts` (new, tests; ~79 lines moved out of `native.test.ts`) | 81 | 0 |
| `hosts/pi/native.test.ts` (tests) | 63 | 77 |
| Docs (`hosts/pi/README.md`, `core/README.md`, `.scratch/v1/spec.md`) | 115 | 3 |

Of the 173 production lines, 63 are comments and doc comments (the eligibility table's sources, the
counting convention, and the rulings each guard implements). This half is additive by construction:
the net simplification the parent asks for is the second half's to show, when the request-copy runner
and the handwritten settings reader go.

## Documentation

- `hosts/pi/README.md`: a new **Launch readiness and the cache-miss latch (19c)** section — the
  trigger/launch split and what a wait is, the reopen probe, the fallback cases, the "no capture
  dependency" reading, tree-switch invalidation, gate 3, the minimum-cacheable-input table with its
  sources, the counting convention, the transition/warning/audit rules, the exact status line and the
  menu-only reset. Five new Known limits bullets and one corrected stale bullet.
- `core/README.md`: a new **Host-observed fork suppression (19c)** section — the two columns, the four
  store methods, why the state is session-scoped rather than global, that core neither reads nor
  enforces it, and the no-migration statement.
- `.scratch/v1/spec.md`: the `sessions` schema line gains both columns; the Run record contract gains
  one 19c paragraph covering readiness and the latch.
- `CONTEXT.md`: **unchanged.** No glossary term changed, and the `branch` → `fork` rename that will
  touch it belongs to the second half.
- `core/prompts/*`: unchanged, zero edits.

## Honest limits

- **No live provider run.** Every check stubs HTTP against the real installed pi-ai adapters. The
  usage numbers that drive the eligibility decisions are stubbed values; nothing here observes a real
  cache hit or miss, and the table's minimums are transcribed from vendor documentation, not measured.
- **The errored-response guard is not independently observable.** A real errored response also carries
  the SDK's placeholder zeros, so the `stopReason` check and the below-minimum check agree on every
  reachable input. The placeholder rule is pinned on the exported function; the integration case
  asserts only that an errored run sets no latch.
- **The launch-context guard is defence-in-depth**, as explained under Design choices; the reachable
  path for the tree-switch ruling is the capture reset plus the new branch identity.
- **Concurrency is real but not simultaneous.** The two-phase test really runs two forks from one
  opportunity and both really report an eligible miss, but Node is single-threaded: the atomicity
  claim rests on the store's guarded UPDATE, which the same test also asserts directly.
- **Only the first miss per run is reported.** A second eligible miss inside the same run is neither
  re-reported nor separately audited (the ruling forbids a second warning; it does not ask for a
  second audit record).
- **The readiness probe re-reads the parent session file** at each launch decision and at each
  boundary while a task waits. It is read-only and creates nothing, but it is repeated I/O on large
  session files.
- **The latch and readiness never touch 18b catchup or 17c borrowed work**, which are subagent by
  construction; that is by routing, not by a dedicated test.
- **Everything stays behind `nativeRunner`.** The request-copy runner's branch mode ignores the latch
  and the readiness gate, per this dispatch's instruction; it disappears in the second half.
- **17b thresholds, 17c claims/cancellation, 18a enrollment/settings layering, 18b catchup, the 19a
  gate and 19b's material/compose boundary are unchanged.** The only calls into them are the ones the
  dispatch required: `checkQueues`'s candidate list, `attemptPhase`'s capacity argument and 18b's stop
  path in a test.
- **No conflict with any ruling was found.** The three places where I had to choose a reading are
  declared above: the "no capture dependency" reading under gate 1, the `verification.cacheMiss`
  placement, and the latch applying only to the native runner while the switch still exists.

## What the second half still has to do

1. **Cutover**: make the native runner the only runner; delete the request-copy conversation loop,
   its provider-message construction and the handwritten `retrySettings` reader with its stale
   "needs pi-server" comment, replacing it with Pi's `SettingsManager`; keep `verifyRequest` as the
   gate on every fork request. Extend the latch and the readiness gate to the now-single runner (both
   are currently gated on `flat.nativeRunner === true`, which becomes unconditional).
2. **Rename** `branch` → `fork` in configuration, status, prompts and run metadata, with `branch`
   accepted as an alias, the canonical form winning, and the conflict reported. That includes
   `noting.branchModeDefault`, the `mode` values in `RunAgentResult`/`RunInput`, `NativeForkTask.mode`,
   the `composeTask(input, "branch")` selector and the wording this half added
   (`fallbackReason: "cache miss latch…"`, the status line and the menu action already say "fork").
3. **Legacy labelling** of historical `branch`-mode runs as legacy request-copy execution on the read
   side, without rewriting stored modes, plus its revert probe.
4. **Glossary** (`CONTEXT.md`) and the remaining doc/prompt wording, and the production line delta
   against the 19a baseline showing the net simplification.
