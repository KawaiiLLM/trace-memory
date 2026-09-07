# Ticket 17c acceptance report

**Ready for acceptor review.** Baseline: `6d2eea68ee6a00a9cfd90a085b69aa45d96ac53b`, **Rename the two phases repo-wide: Noting/Noter and Consolidation/Consolidator**, read with `git log -1` before implementation. The initial working tree was clean; HEAD remains unchanged and all implementation changes are unstaged and uncommitted.

Read: 17c and its parent, the 17a/17b/18a and 16b reports, current v1 spec, Pi README, glossary and both prompts. The user's current authorization releases this slice despite its historical held label. The slice's executor-slot policy supersedes parent fan-out. Its Reopen section and the user's 2026-09-08 amendment supersede the stale acceptance clause asking own work to wait for release/expiry: restore takes ownership immediately. The already-landed store enrollment gate applies to both executors and targets.

Repository additions are English; conversation fixtures retain their language. No dependencies, migration, native child-session runtime, manual catch-up/stop commands, polling, heartbeat or continuous drain were added. Every pre-existing file under `.scratch/v1/issues/` compares byte-identical to HEAD; only this report is new there.

## Verification

The initial suite and final restored implementation were executed locally on Node 24.6.0, using Vitest and temporary SQLite databases.

| Check | Before | After |
|---|---:|---:|
| `npm test` | 434 passed, 19 files, independently rerun | 451 passed, 20 files |
| `npm run typecheck` | Passed | Passed after all probe restorations |
| `npm run smoke:pi` | Not rerun at baseline | Passed: one Noting run and one fact |
| `git diff --check` | Clean tree | Passed |
| Direct named ruling declarations in `core/api/rulings.test.ts` | 41 | 41 names and dates retained verbatim |
| Required full-suite revert probes | Not applicable | Five named red results, each restored byte-for-byte |
| Additional changed-reader probe | Not applicable | Cancelled usage reader red, restored byte-for-byte |
| HEAD / staged changes / new commits | `6d2eea6` / none / none | `6d2eea6` / none / none |

Seventeen new cases are in `hosts/pi/catchup.test.ts`. The existing child-process write-lock test was extended in place to race claims for both phases, kill their owners and exercise replacement/stale tokens. Existing shutdown replacement cases retain their original premise in names with an explicit **17c 2026-09-08** supersession. The sibling-concurrency fixture and the dated branch/subagent comparison record the same supersession in comments. Installed-adapter wire tests now observe completion before shutdown, which intentionally cancels instead of draining. Their byte-equality assertions remain intact.

Baseline log: `/private/tmp/17c-before.log`. Final suite: `/private/tmp/17c-final.log` and `/private/tmp/17c-final.json`; typecheck: `/private/tmp/17c-final-typecheck.log`; smoke: `/private/tmp/17c-smoke.log`. Both installed workspace Pi packages are 0.85.1. The pi-ai signal option and retry signature/implementation were read locally; this is installed-API and fake-provider evidence, not a live provider session.

`hosts/pi/branch.ts`, both prompts, all four tool definitions in `core/api/tools.ts`, the Consolidation write protocol in `core/consolidation/memory.ts`, and dependency manifests compare byte-identical to HEAD. The only renderer change is cancelled-usage display; the source-entry renderer and token estimator remain unchanged. Existing dated source, scope, knowledge-commit, two-submission, branch-byte and delivery rulings remain green.

## Acceptance evidence

Every 17c checkbox is mapped below. New test titles have the prefix **17c 2026-09-08:** and live in `hosts/pi/catchup.test.ts` unless another file is named.

| Checkbox | Implementation | Behavioral evidence |
|---|---|---|
| 1. Several closed tails; one slot per phase; own priority | Host reserves one local phase slot before asynchronous admission. Own eligible work precedes closed candidates; each opportunity runs one target per phase. | **two executor slots prefer own work over several closed tails and never fan out** seeds four closed sessions with both tails, fifty own facts and due own Raw. It observes two requests and only own claims; further completions launch nothing while busy. |
| 2. Busy slots, no preemption or completion chaining | Slots release with the handled worker promise. Completion does not invoke queue checks. | **busy borrowed slots are not preempted or chained; later entries take oldest tails with stable branch order** adds due own Raw while borrowing, observes unchanged requests and un-aborted signals, then verifies completion alone starts nothing. A later entry gives own Noting priority and the next closed Consolidation tail its opportunity. |
| 3. Below-threshold own work; tiny tails; phase independence | `taskEligibility` retains normal thresholds; closed candidates use nonempty queues independently by phase. Queues remain derived from existing membership. | **tiny closed tails bypass thresholds; empty Noting does not hide Consolidation; live and disabled targets never launch** processes one closed entry and one fact from a target with no Noting backlog while own Raw remains queued. The busy-slot test demonstrates subsequent bounded opportunities. |
| 4. Racing executors and shared ordinary/borrowed admission | Immediate SQLite transaction acquires one target-wide phase claim, irrespective of branch or facade. Failed acquisition may select another candidate. | **two active executors share target claims and the loser selects another target** observes two workers in each executor, different target owners and dropped ordinary attempts against borrowed claims. **failed own capacity admission leaves the slot free for a smaller closed tail** verifies that an oversized own entry rolls admission back and allows a smaller closed target to run; no own claim or progress remains. Existing facade duplicate tests remain. The extended **a short write lock held by another process delays the commit instead of losing it** in `core/store/index.test.ts` races two actual Node processes, admitting exactly one claim per phase. |
| 5. Target identity, frozen branch/project, attribution, eligibility | Target path, evidence and project freeze inside admission. Borrowing forces subagent mode. Run records, facts, knowledge, progress, usage and deliveries remain target-bound. Project movement rejects the commit. | **borrowed requests freeze target project and branch; costs, commits and deliveries stay with target** creates both kinds of target result/delivery, checks their project/origin/branch and target usage, and observes no executor spend or delivery. The tiny-tail case excludes live/disabled targets. **disabled executors cannot acquire or commit borrowed work; target project changes keep frozen work pending** exercises external disable and a project change on a second connection immediately after the freeze transaction. |
| 6. Reopen during selection/execution; immediate takeover | Restore clears closure and rotates another owner's claims to fresh reserved tokens. Atomic admission consumes the reservation after current eligibility checks. Ordinary tree navigation does not rotate tokens. | **reopen blocks selection and immediately replaces borrowed tokens; stale completion cannot clear the new owner** rejects a post-reopen borrower, rejects old completion without progress, retains the replacement token and immediately admits own work. **resume takes crashed claims immediately without inventing closure; tree navigation keeps its worker** covers an unclosed crashed identity and unchanged tree-worker ownership. This implements the explicit immediate-takeover amendment, superseding the checkbox's old waiting clause. |
| 7. Process death, expiry, stale commit/release, no inferred closure | Claims expire after thirty minutes using timestamp comparisons only. Token-conditional releases cannot delete replacements. Expiry never writes closure. | The extended store write-lock test races both phases, sends SIGKILL to the owners, advances only the comparison clock to expiry, acquires replacements and rejects stale commits/releases. Both pending queues remain. A separate live target with an expired claim is still unclosed/ineligible for borrowing, but resumable by its own executor. |
| 8. Own plus borrowed shutdown; shared deadline; cancellation | Shutdown stops scheduling and invalidates tokens before signalling calls/retries. One deadline covers both slots; forced local completion closes bindings before final audit/release/own closure/database close. | **shared five-second shutdown deadline fences own and borrowed workers even when providers never resolve** uses two permanently unresolved providers, checks both signals and invalidated claims immediately, observes unfinished exit at 4,999 ms and finished exit at 5,000 ms, then checks both queues, conditional releases, both targets' closure states and no extra request. **database contention cannot multiply shutdown deadline; cleanup errors are reported** holds a real child-process write lock and observes exit under one second with diagnostics. |
| 9. Disable/cancel versus commit; late completion and cleanup failures | Commit-time target and executor enrollment checks combine with token/closure fences. Successful business commits survive postcommit cancellation, audit and release failures. Late promises never use a disposed store. | Both **noting/consolidation commit transaction rejects a replaced token without progress** cases keep bindings open and replace the token under the same executor, isolating the token fence. **shutdown cancels retry waits, retains available usage, and never restarts a committed batch** preserves an already committed Noting, cancels a 60-second retry wait promptly and keeps usage/retry diagnostics. Both **noting/consolidation cleanup or audit failure preserves committed success** cases inject failures after commit. **late rejection after deadline is consumed, normal restore clears closure, and late results never touch the closed store** compares run bytes after a late rejection; Vitest reports no unhandled failure. Existing 18a disable/commit tests remain. |
| 10. Pending failures; exact zero-fact advancement; no lifecycle extraction | Uncommitted claims do not advance membership. Successful zero-fact results advance only frozen entries. Compaction/shutdown have no extraction trigger. | The new cancellation/fence cases preserve both queues. Retained **17a 2026-09-08: frozen entries leave late same-Turn sources pending and reject their citations despite unrestricted reads** checks exact zero-fact membership. Retained **17b 2026-09-08: lifecycle hooks launch neither phase and preserve both pending queues** checks zero lifecycle requests and durable tails. Existing bounded multi-batch, failure/bounce and provider-retry cases remain. |
| 11. Revert probes | Each independent mutation runs the full suite, checks a named failed assertion, verifies its direct span diff and restores original bytes. | All five mandatory probes and the additional cancelled-usage reader probe are recorded below. |

## Design choices and deletions

- **One ownership table, no copied backlog.** `task_claims` has primary key `(session_id, phase)`, executor id, random token, expiry, borrowed flag and reopen-reservation flag. Source paths, `noted_entries` and `consolidated_facts` still derive pending work. Claim acquisition, current eligibility and freeze share an immediate transaction; the network starts after it ends.
- **Stable selection.** Global entry/fact allocation ids provide pending arrival order; session id and lexical branch order break ties. Each branch remains a separate candidate. The host and atomic admission call one shared threshold/delivery predicate, avoiding separate policies. Admission failures are distinguished from errors after a worker starts: only failed admission can continue candidate selection, preserving the no-completion-chaining rule.
- **Explicit takeover without extraction.** Restore reserves replacement tokens immediately; the next eligible completion consumes the reservation under ordinary thresholds. Expired reservations receive new tokens. Crash resume also replaces abandoned ownership because no normal-close mark exists in that case. Tree navigation keeps its current worker's token.
- **One cancellation path.** The facade owns per-worker AbortControllers and tool closures. Pi threads the signal through the converse loop, direct/registry completion and `retryAssistantCall`. The host deadline forces only local waits; late underlying promises remain handled. No new model-call retry policy, child runtime or native fork was introduced.
- **Bounded SQLite cleanup.** Teardown disables SQLite busy waiting before invalidation. A competing write lock is reported immediately rather than consuming five seconds per cleanup write. If closure cannot be persisted, the session remains unclosed until resume; no heartbeat or heuristic repairs it. This preserves bounded exit without claiming an unavailable database was updated.
- **Business result before cleanup result.** Transactional success survives provider cancellation, audit failure or claim-release failure. Release errors become returned problems rather than replacing success with rejection. Cancellation audit labels missing usage unknown and partial counters as known usage only; explicit run rendering does not call unknown cost zero. Cumulative spend sums available counters only.
- **Deleted mechanisms.** Removed the unbounded shutdown `Promise.allSettled` wait for natural worker completion. Removed both process-global session/branch in-flight sets, their realpath-based database identity and their per-memory-database counter. SQLite claims now supply cross-process target exclusion, while local slots bound executor capacity. The remaining `allSettled` after the deadline waits only for forced local completions, never the unresolved provider promises.
- **Unchanged model contract.** Both prompts were read; their timing/batch descriptions still apply to the supplied target, so they remain byte-identical. Branch-prefix construction, read permissions, fact source rules, knowledge DAG semantics and the two-submission Consolidation protocol remain unchanged. Schema changes are in place for unreleased v1, with the existing new-database/no-migration policy documented.

## Revert probes

Each probe ran `npm test -- --reporter=json --outputFile=/private/tmp/17c-probes/<probe>.json` against all 451 tests. The probe asserted each replacement span occurs exactly once, wrote and reread the intended bytes, generated and compared the direct unified diff, then required both a nonzero exit and the named failed assertion in Vitest JSON. A `finally` block restored and compared the original bytes. Restored hashes were rechecked against the final tree before writing this report.

| Probe | Named red test | Failed / total | Verified diff SHA-256 |
|---|---|---:|---|
| `executor-slot-limit` | **17c 2026-09-08: busy borrowed slots are not preempted or chained; later entries take oldest tails with stable branch order** | 3 / 451 | `f5382a7af3fe4643eeb81156ed54c2a3a1b54f78b9bd7f785e2a52c5750acf14` |
| `target-claim` | **a short write lock held by another process delays the commit instead of losing it** | 5 / 451 | `8a66ed2607234ce3933f53a6579d9d68c101f277eb18d8f9cfc8d8d757d417e7` |
| `token-fence` | **17c 2026-09-08: noting commit transaction rejects a replaced token without progress** | 2 / 451 | `e8751756e35cbc3c4381ff63b479c51272437026dfd7d5e50703dc6e8f1fe42f` |
| `closed-target` | **17c 2026-09-08: tiny closed tails bypass thresholds; empty Noting does not hide Consolidation; live and disabled targets never launch** | 3 / 451 | `b9c234f69a45fc26497b519d0f5ecc4df8b380906a75ecc80bd32dbd76fa2f30` |
| `shutdown-deadline` | **17c 2026-09-08: shared five-second shutdown deadline fences own and borrowed workers even when providers never resolve** | 2 / 451 | `42ff10a020059e095f06adf35f798472bf33dd03c0c118361bc9fa4070e2fe02` |
| `cancelled-usage-reader` | **17c 2026-09-08: shared five-second shutdown deadline fences own and borrowed workers even when providers never resolve** | 1 / 451 | `1d03112543bfb258bd1ca5dba235b0af0ab7e89d72867f724fe101d232b6bda5` |

The checked changed spans are reproduced directly. Each removes only the selected mechanism; the slot probe retains target claims, and the token probe retains executor, expiry, enrollment and closure checks. Its regression replaces ownership with a new token under the same executor so those other checks cannot mask the missing token comparison.

### executor-slot-limit

```diff
--- hosts/pi/index.ts
+++ hosts/pi/index.ts (pre-ticket behavior probe)
@@ -561,7 +561,6 @@
     const context = ctx;
     const own = { sessionId: state.sessionId, branch: state.branch, headTurnId: state.head };
     for (const kind of ["noting", "consolidation"] as const) {
-      if (slots.has(kind)) continue;
       const selected = launch(kind);
       let due = false, paused = false;
       try { ({ due, paused } = memory.taskEligibility(kind, own, selected.mode)); }
```

### target-claim

```diff
--- core/store/index.ts
+++ core/store/index.ts (pre-ticket behavior probe)
@@ -634,7 +634,6 @@
       if (!pending.length || !eligible()) return null;
       const current = this.getClaim(target.sessionId, phase), now = Date.now();
       const takeover = current?.reserved && current.expiresAt > now && current.executorId === executorId && !borrowed;
-      if (current && current.expiresAt > now && !takeover) return null;
       const claim: TaskClaim = { sessionId: target.sessionId, phase, executorId,
         token: takeover ? current.token : randomUUID(), expiresAt: now + 30 * 60_000, borrowed, reserved: false };
       this.db.prepare(`INSERT INTO task_claims (session_id, phase, executor_id, token, expires_at, borrowed, reserved) VALUES (?, ?, ?, ?, ?, ?, 0)
```

### token-fence

```diff
--- core/store/index.ts
+++ core/store/index.ts (pre-ticket behavior probe)
@@ -667,7 +667,7 @@
     if (run.executorSessionId !== undefined) this.requireEnabled(run.executorSessionId);
     const claim = run.claim, current = this.getClaim(claim.sessionId, claim.phase);
     if (claim.sessionId !== run.sessionId || claim.phase !== run.kind || !current || current.reserved ||
-        current.token !== claim.token || current.executorId !== claim.executorId || current.expiresAt <= Date.now())
+        current.executorId !== claim.executorId || current.expiresAt <= Date.now())
       throw new Error("task claim is no longer current and unexpired");
     if (current.borrowed && this.getSession(claim.sessionId)?.closedAt == null) throw new Error("borrowed target is no longer closed");
     if (run.projectId !== undefined && this.getSession(claim.sessionId)?.projectId !== run.projectId)
```

### closed-target

```diff
--- core/store/index.ts
+++ core/store/index.ts (pre-ticket behavior probe)
@@ -628,7 +628,6 @@
   acquireClaim(target: TaskTarget, phase: Phase, executorId: string, borrowed = false, eligible: () => boolean = () => true): TaskClaim | null {
     return this.transaction(() => {
       if (!executorId || !this.enabled(target.sessionId)) return null;
-      if (borrowed && this.getSession(target.sessionId)?.closedAt == null) return null;
       const pending = phase === "noting" ? this.pendingEntries(target.sessionId, target.branch, target.headTurnId)
         : this.consolidationBatch(target.sessionId, target.branch, target.headTurnId);
       if (!pending.length || !eligible()) return null;
@@ -669,7 +668,6 @@
     if (claim.sessionId !== run.sessionId || claim.phase !== run.kind || !current || current.reserved ||
         current.token !== claim.token || current.executorId !== claim.executorId || current.expiresAt <= Date.now())
       throw new Error("task claim is no longer current and unexpired");
-    if (current.borrowed && this.getSession(claim.sessionId)?.closedAt == null) throw new Error("borrowed target is no longer closed");
     if (run.projectId !== undefined && this.getSession(claim.sessionId)?.projectId !== run.projectId)
       throw new Error("target project changed after admission");
   }
@@ -677,7 +675,7 @@
   closedTasks(phase: Phase, executorSessionId: number): TaskTarget[] {
     if (!this.enabled(executorSessionId)) return [];
     const targets: (TaskTarget & { oldest: number })[] = [];
-    const sessions = this.db.prepare("SELECT id FROM sessions WHERE closed_at IS NOT NULL AND id != ? AND COALESCE(enrollment_choice, enrollment_default) = 1 ORDER BY id").all(executorSessionId);
+    const sessions = this.db.prepare("SELECT id FROM sessions WHERE id != ? AND COALESCE(enrollment_choice, enrollment_default) = 1 ORDER BY id").all(executorSessionId);
     for (const row of sessions) {
       const sessionId = Number(row.id);
       if ((this.getClaim(sessionId, phase)?.expiresAt ?? 0) > Date.now()) continue;
```

### shutdown-deadline

```diff
--- hosts/pi/index.ts
+++ hosts/pi/index.ts (pre-ticket behavior probe)
@@ -635,7 +635,7 @@
     try {
       try { memory.cancelTasks(true); } catch (error) { report(error); }
       try { if (state) flush(true); } catch (error) { report(error); }
-      await Promise.race([Promise.allSettled([...pending]), deadline]);
+      await Promise.allSettled([...pending]);
       memory.forceTasks(); // Close bindings and end only local waits, retaining partial audit.
       await Promise.allSettled([...pending]);
       try { if (state?.sessionId) memory.store.closeSession(state.sessionId); } catch (error) { report(error); }
```

### cancelled-usage-reader

```diff
--- core/render/index.ts
+++ core/render/index.ts (pre-ticket behavior probe)
@@ -257,8 +257,7 @@
     `  S${run.sessionId ?? "?"} / branch ${run.branch ?? "?"}  ${run.rangeFrom ?? "?"}..${run.rangeTo ?? "?"}`,
     `  model ${run.model ?? "?"}  mode ${run.mode ?? "?"}`,
     `  created: ${[...factIds.map((id) => `F${id}`), ...commits.map((c) => `K${c.knowledgeId}@${c.id} (${c.op})`)].join(", ") || "nothing"}`,
-    response.usageStatus === "unknown" ? "  usage: unknown  cost unknown"
-      : `  usage: ${usage ? `in ${usage.input ?? 0} out ${usage.output ?? 0} cacheRead ${usage.cacheRead ?? 0} cacheWrite ${usage.cacheWrite ?? 0}` : "none"}  cost $${(usage?.cost?.total ?? 0).toFixed(4)}${response.usageStatus === "partial" ? " (known usage only; remaining cost unknown)" : ""}`,
+    `  usage: ${usage ? `in ${usage.input ?? 0} out ${usage.output ?? 0} cacheRead ${usage.cacheRead ?? 0} cacheWrite ${usage.cacheWrite ?? 0}` : "none"}  cost $${(usage?.cost?.total ?? 0).toFixed(4)}`,
     `  tools: ${[...counts].map(([n, k]) => `${n} ×${k}`).join(", ") || "none"}`,
     `  problems: ${problems.length ? problems.join("; ") : "none"}`];
   if (full) {
```

The deadline mutation failed the explicit 5,000-ms completion assertion; the late-rejection case additionally timed out. Other probes failed behavioral launch/claim/commit/display assertions. No compilation error was accepted as probe evidence. All six restorations were byte-identical, and the final full suite returned 451 green tests.

| Restored production file | SHA-256 |
|---|---|
| `hosts/pi/index.ts` | `3a256adfc189ff68d1a1301271d91354e99f68bb63611affde44092dce213a9b` |
| `core/store/index.ts` | `d3f16c50a51d411e1a1a991150fce3f50e4c5fd29f2f9c6918d5e2f6316b16ce` |
| `core/render/index.ts` | `120f268abdc9fef1c640eece12be22771c2de342937014fa6c30c8f5580ac179` |

## Production line delta

Counts compare the final working tree with `6d2eea6`; blank lines/comments count. Runtime TypeScript and edited contract documentation are included. Tests, the fake-host helper and this report are excluded.

| File | Before | After | Added | Removed | Net |
|---|---:|---:|---:|---:|---:|
| `.scratch/v1/spec.md` | 302 | 363 | +69 | -8 | +61 |
| `CONTEXT.md` | 51 | 55 | +4 | -0 | +4 |
| `core/README.md` | 325 | 332 | +14 | -7 | +7 |
| `core/api/index.ts` | 295 | 364 | +99 | -30 | +69 |
| `core/consolidation/index.ts` | 147 | 149 | +6 | -4 | +2 |
| `core/model/index.ts` | 302 | 303 | +1 | -0 | +1 |
| `core/noting/index.ts` | 166 | 168 | +6 | -4 | +2 |
| `core/render/index.ts` | 379 | 380 | +2 | -1 | +1 |
| `core/store/index.ts` | 1247 | 1373 | +126 | -0 | +126 |
| `hosts/pi/README.md` | 612 | 681 | +78 | -9 | +69 |
| `hosts/pi/index.ts` | 690 | 731 | +90 | -49 | +41 |
| Total | 4516 | 4899 | +495 | -112 | +383 |

New store queries read/write session closure, acquire/reopen/read/invalidate/release phase claims, and enumerate enabled closed target paths. Existing Noting and Consolidation commit transactions gained current-claim/project/executor checks alongside the retained target enrollment check. No source/progress membership, knowledge operation or delivery SQL changed. Teardown alone changes its connection's busy timeout to zero.

## Standards review

The independent read-only reviewer identified per-operation SQLite waits during teardown, release errors overriding successful results, duplicated threshold/delivery predicates, and a post-transaction project-id read that could disagree with frozen context. All were corrected. Regressions cover real lock contention, both phases' audit/release failures and a second-connection project move immediately after freeze. Final recheck found no remaining concrete blocker.

## Spec review

The independent read-only reviewer identified the same deadline risk and an unclosed crashed conversation retaining its abandoned claim on resume. Both were corrected and covered. Recheck found no remaining concrete specification defect in lifecycle, claims or cancellation. Direct facade `close()` remains immediate disposal and may skip a final audit; Pi shutdown deliberately forces and settles local worker completions before calling it. Reviews were static and do not substitute for the executing agent's suite/probe results.

## Acceptance self-check and remaining work

- [x] All eleven slice checkboxes mapped to implementation and executed evidence, with the stale waiting clause explicitly superseded by immediate takeover.
- [x] 434 existing cases retained; 451 final tests green; typecheck, smoke and whitespace checks pass.
- [x] Five mandatory full-suite probes plus one changed-reader probe red; direct diffs and byte restoration verified.
- [x] Existing issue files, branch builder, tool definitions/protocol, prompts, token estimator and dependencies preserved as specified.
- [x] No staging, commits, runtime dependencies, native child sessions, manual catch-up/stop commands, heartbeat or scheduling timers added.
- [ ] Live Pi/provider acceptance was not performed. Requested fake Pi/facade/SQLite tests and installed-adapter HTTP stubs provide automated evidence, not live-provider cancellation/billing proof.

No authorized implementation item is deferred. Deliberate limits remain: normally closed targets only, crash waits for resume, thirty-minute claims without renewal, eligible-entry opportunities without continuous drain, best-effort remote cancellation, unknown missing usage and the existing process-death precommit audit gap. Database unavailability may prevent the normal-close/audit write; that failure is reported and never converted into inferred closure. Tickets 18b and 19 remain outside this implementation.

The schema adds nullable `sessions.closed_at` and one target-wide `task_claims` row per phase while retaining existing source/progress queues. The facade replaces process-local branch exclusion with atomic claims, frozen target attribution, shared eligibility, cancellation controls and commit fences, preserving business success and available audit. The Pi host provides two executor slots, own-first closed-tail selection, borrowed subagent execution, immediate restore takeover and a shared five-second cancellation cleanup before database closure; compaction and shutdown start no extraction.
