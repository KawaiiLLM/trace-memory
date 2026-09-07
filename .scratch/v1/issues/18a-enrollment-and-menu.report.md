# Ticket 18a acceptance report

**Ready for acceptor review.** Implementation is unstaged and uncommitted. Baseline: `23f2a57`, **Tickets 17c and 18: reopen takes the claim over, enabled is vacuous before 18, 18 split into 18a/18b**, read with `git log -1 --oneline` before implementation. The initial status already showed a modification to the protected `.scratch/v1/issues/19-native-pi-fork-runtime.md`; it was left untouched. No other existing issue file was edited. The user's stated 402-test baseline was independently reproduced.

Read: ticket 18a, its full parent, the 17a/17b and 16b reports, current v1 specification, Pi README, glossary and both prompts. Repository work is English; existing conversation fixtures retain their language. This slice adds no runtime dependency, AgentSession, native fork, closure, claims, catch-up, timer or cancellation machinery. No Catch up or Stop command/menu action is exposed.

## Verification

| Check | Before | After |
|---|---:|---:|
| `npm test` | 402 passed, 18 files, independently rerun | 430 passed, 19 files |
| `npm run typecheck` | Passed | Passed after all restorations |
| `git diff --check` | Pre-existing protected ticket-19 modification | Passed |
| `npm run smoke:pi` | Not rerun at baseline | Passed on Node 24.6.0: one Recording and one committed fact |
| Direct dated ruling declarations in `core/api/rulings.test.ts` | 41 | 41 retained by name/date |
| Full-suite revert probes | Not applicable | Seven named red results; each byte-restored |
| HEAD / staged changes / implementation commits | `23f2a57` / none / none | `23f2a57` / none / none |

The two host consumer-matrix tests retain their original date/premise and explicitly
name the 2026-09-08 supersession. `hosts/pi/branch.ts`, both prompt files,
`package.json` and `package-lock.json` compare byte-identical to the baseline.
Final full-suite log: `/private/tmp/18a-final.log`; typecheck:
`/private/tmp/18a-final-typecheck.log`; smoke: `/private/tmp/18a-smoke.log`.
Baseline logs are `/private/tmp/18a-before.log` and
`/private/tmp/18a-before-typecheck.log`.

All checks use Vitest on Node and the installed SQLite implementation, not Bun. New behavior tests use `hosts/pi/test-host.ts`, the public facade and temporary databases. Separate Node processes exercise concurrent first initialization and cross-process disable. The existing store contention test remains unchanged apart from explicitly enrolling its fixture session.

## Acceptance evidence

New named cases are in `hosts/pi/enrollment.test.ts` and begin **18a 2026-09-08:**. Existing 17a/17b tests remain and continue to establish source exclusions, exact identity/order, tool results, missing-history receipts, frozen batches, thresholds and no completion chaining.

| 18a checkbox / parent scenario | Implementation | Behavioral evidence |
|---|---|---|
| Native creation defaults; stable baseline (1, 2) | `enrollmentDefault` accepts valid canonical native ISO creation times only; strictly after baseline enables. The host publishes a complete baseline file using an atomic hard link, retaining the first winner across processes/restarts. It uses the native header, not source time, file time, database time or first encounter. | **native header default (before/after/equal/missing/malformed), never first-seen time**; **malformed native creation metadata stays disabled** covers normalized-invalid dates, date-only/year-only strings and numeric metadata; **concurrent first initialization and restart keep one atomic baseline** runs two actual child processes and a restart against one installation. |
| Explicit precedence and shared identity (3, 13) | Store columns separate `enrollment_default` and nullable `enrollment_choice`. Historical position never sets the current database choice. Restoration recovers the allocated identity even when the selected custom entry predates allocation. Shared copies disclose switch scope. | **historical tree and newer clone never overwrite the current shared switch** disables S1, restores an older enabled state under a newer clone header, checks Disabled and the menu's shared-identity notice; **selecting pre-allocation history keeps the allocated identity and current choice** proves no S2 is created. |
| Before-first-reply toggle (4) | Provisional enrollment lives in the Pi custom state and an atomic host-state receipt because installed Pi defers creating a new native file until an assistant message exists. Allocation transfers the explicit choice; the allocated store state is authoritative thereafter. | **provisional toggle, cancel, menu parity and headless status create no artificial Turn** checks no S1 before a reply, one Turn after it, no S2, and default/explicit status; **pre-reply choice survives loss of Pi unflushed custom entries** discards all fake native entries and verifies the receipt preserves both choices. |
| Local historical import, no synthetic completion (5; retained 17a/17b seams) | Enable persists intent, invalidates the reconciliation leaf and calls the existing identity-based walk with queue checking disabled. No model invocation or completion event is manufactured. | **historical import and pause resume use native identities without a model call** imports three repeated-text Turns/six sources, repeats enable without changing addresses or queue, imports the paused interval, then starts exactly one Recording on a genuine completion. Existing 17a attach/import/tool-result/compaction/missing-source cases stay green. |
| Disabled participation and unrestricted reads (9, 10, delivery part of 12) | Core source mutation methods check enrollment inside transactions. Automatic facade admission drops disabled work. Automatic knowledge/compaction/carry blocks return empty; the host returns no lifecycle override. Write tools reject with `/trace enable`; shared read validation remains active. Confirmation checks the current delivery owner's enrollment. | **historical import and pause resume…** checks no sources/requests/blocks and Pi fallback, rejected writes and successful trace/search; **disabled reads retain tool validation before and after allocation**; **core gates admissions and late commits through another facade; queues and deliveries survive** bypasses the menu; mode-combination tests assert unseen deliveries remain pending even under explicit facade confirmation. |
| Commit boundary, prior success and retained queues (18a's disable criterion; parent's commit-race requirement) | Both existing commit transactions reread enrollment before inserting successful runs, facts, knowledge or progress. Failure audits remain allowed. Existing successful commits and their audit updates remain successful. No provider cancellation is added. | **disable during Recording provider call rejects late true/false submission and retains pending batch**; **disable during Integration rejects late true/false submission and leaves facts pending**; **another process disables before the transaction; prior success survives** uses a separate Node writer, rejects both commit kinds, retains F1 and its successful run bytes, and leaves F1 unintegrated. |
| Enabled delivery in all four modes (12) | Deleted the configuration-derived delivery booleans and `BindOptions`; nonempty Recording and Integration worker commits always leave their deliveries. The existing branch-mode wait predicate remains unchanged. | **enabled delivery ignores worker modes (true,true / true,false / false,true / false,false) and disable preserves unseen deliveries** checks actual host prompts for `<recorded>` and `<integrated>` plus preserved pending IDs. Rewritten **2026-09-07 backfill by consumer — superseded 2026-09-08…** and **08:53 premise…2026-09-08 supersession…** retain dated history and test the new policy and existing branch wait. |
| Settings layers, validation and no editor (16) | One file reader serves Pi retry and `trace-memory`. Global, project and environment precedence is explicit. Every layer validates, including masked values; the menu shows defaults, effective source and masked values. Settings are never written. | **read-only settings show precedence, effective defaults and masked values** compares file bytes before/after; **all count/token keys and masked layers validate by key** checks every count/token key against zero, negative, fractional, unsafe and nonfinite input plus modes, removed keys, similarity and tool-round limits. Existing impossible-view-capacity tests remain green. |
| Native menu, command parity, cancel, headless and footer (15) | Select/confirm/input provide Current session, Global read-only Settings, Runs and Status. Menu toggles and explicit commands share `toggle`; run view is shared. Disabled adds one label to the existing themed status item. | **provisional toggle, cancel, menu parity and headless status…** exercises confirmation cancel, both menu toggles, explicit enable, no artificial records, command help and Disabled footer; settings test exercises source labels. Existing status, run view, spend/theme, command and tool registration tests remain. |
| Retained shared knowledge (17) | Disabling changes only enrollment intent; no Raw, fact, knowledge, scope, run or delivery deletion occurs. Knowledge selection for other sessions is unchanged. | Mode-combination tests create global knowledge, disable its origin, and check that shared knowledge remains visible while the origin's future injection/delivery stops. The separate-process test retains an already committed fact and successful run unchanged. |
| Required revert probes | Direct span diffs and byte restoration accompany each full-suite mutation. | Results below name the actual failing tests, not only assertions that happened to stay green. |

## Design choices and deletions

- **Core owns participation.** Enrollment stays in the store rather than a cached UI preference. Source updates use the existing transaction helper so disable and source writes serialize as well as business commits. Pending queue readers remain available for status and explicit inspection; they are not destructive filters.
- **One baseline per installation.** The baseline lives under the Pi agent directory, independently of the selected database. A temporary complete JSON timestamp is published with `linkSync`; concurrent initializers read the winning file, never a partially written placeholder. Restarts and upgrades do not replace it. This is the first successful initialization instant, not a claim about historical package installation.
- **Pi's pre-reply persistence boundary.** Installed `dist/core/session-manager.js` `_persist` defers native file creation until an assistant exists. Therefore a small atomic receipt under `trace-memory-enrollment/<identity hash>.json` preserves the provisional host state even if its native custom entry has not flushed. The receipt is keyed by database/native identity and used only before allocation; after allocation the database switch wins. No native session file is parsed or forcibly flushed, no synthetic reply/Turn is inserted, and no cancellation or scheduler is introduced.
- **Restore identity separately from position.** The latest native state supplies an already allocated identity when a historical entry lacks it. The selected path still supplies branch position and reconciliation ancestry; the database supplies enrollment. A fork/clone cannot turn a disabled shared identity back on through a newer header or historical snapshot.
- **Configuration validation before opening core.** All positive integer budgets/counts validate centrally. The existing `maxToolRounds: 0` unlimited sentinel and `nearThreshold` similarity interval remain their documented special meanings. Three old zero-budget renderer fixtures now use a positive one-token budget to preserve their intended omission assertions under the new load contract. View-capacity errors remain runtime evidence-preserving failures.
- **Deleted mechanisms.** Removed `deliverFacts` and `deliverKnowledge` configuration-derived switches, `BindOptions`, their call plumbing and the old consumer-matrix prose/assertions. Central validation replaces the narrow constructor checks for only four numeric keys. Existing branch pending-delivery waits, settled-only confirmation, renderer/source rules, exact request construction, retries, per-entry/per-fact accounting and successful-postcommit behavior are retained.
- **Fixture enrollment is explicit.** Existing direct-store test sessions now specify `enrollmentChoice: true`; production missing metadata remains disabled. Database existence is never translated into opt-in. The fake host supplies native header timestamps and scripted menu answers.
- **Prompts.** Both were read. Their branch-context descriptions remain correct and contain no configuration-derived delivery gate, so their bytes are unchanged. The v1 spec, host README, core README and glossary were updated together.

## Revert probes

Each independent mutation ran `npm test -- --reporter=json --outputFile=<probe>.json`, the entire Vitest suite. Before execution, the probe verified the intended bytes and saved a direct unified span diff. It required a nonzero exit and the named failed assertion from Vitest JSON. A `finally` block restored every changed file and compared the bytes for equality. All seven suites contained 430 tests; final green verification ran after every restoration. Logs, JSON and exact diffs are under `/private/tmp/18a-probes`.

| Reverted behavior | Named red test | Failed tests | Verified diff SHA-256 |
|---|---|---:|---|
| `first-seen-default` | **18a 2026-09-08: native header default (before), never first-seen time** | 10 | `5cce5ddd458b2829fc4d5ba07b6bc1e2692d139acc1458f86f5e339a9a26a9dc` |
| `menu-only-gate` | **18a 2026-09-08: core gates admissions and late commits through another facade; queues and deliveries survive** | 13 | `3f4abba0eddffe932b1574fe45e16aee10d9271d7d36649c2f78b6ccc4f95342` |
| `historical-switch` | **18a 2026-09-08: historical tree and newer clone never overwrite the current shared switch** | 1 | `5112d6712542927cd172883f410033c0db8a23e0ab4d2a42884dd400046fd69a` |
| `consumer-mode-delivery` | **18a 2026-09-08: enabled delivery ignores worker modes (true, true) and disable preserves unseen deliveries** | 5 | `29abb259578bcbe05624897a820b496b6ab4bb7403c76ac2235de5c1a4919bc4` |
| `unchecked-commit` | **18a 2026-09-08: another process disables before the transaction; prior success survives** | 6 | `e1991a2b44d8cd62d4c55db1a1c065d36af5ab8ce1da44b2a63c414c2641ec9f` |
| `unchecked-config` | **18a 2026-09-08: all count/token keys and masked layers validate by key** | 3 | `b715c76131c088d567e00a3df20ee9baf1b6e62f68e61a1ceefd9b61b16606b0` |
| `no-provisional-receipt` | **18a 2026-09-08: pre-reply choice survives loss of Pi unflushed custom entries** | 3 | `5b7a8426705071f00ad10169c5b278627e6ac8b0c4ff818edd8cc58f4431640a` |

The required changed spans are reproduced below. The gate probe restores pre-enrollment unconditional eligibility, so direct facade/store tests establish that the menu is insufficient. The first-seen probe deliberately uses encounter time after initialization instead of the native header. The historical-state probe reapplies the stale saved choice; the delivery probe restores configuration-derived consumer gating through the removed plumbing.

### first-seen-default

```diff
--- hosts/pi/index.ts
+++ hosts/pi/index.ts (pre-ticket probe)
@@ -368,7 +368,7 @@
       state.branch = randomUUID();
     }
     state.enrollment = state.sessionId ? memory.store.enrollment(state.sessionId)
-      : provisional() ?? latest?.enrollment ?? saved?.enrollment ?? { defaultEnabled: enrollmentDefault(ctx.sessionManager.getHeader()?.timestamp, baseline), choice: null };
+      : provisional() ?? latest?.enrollment ?? saved?.enrollment ?? { defaultEnabled: enrollmentDefault(new Date(Date.now() + 1).toISOString(), baseline), choice: null };
     if (!state.sessionId) { persistProvisional(state.enrollment); state.enrollment = provisional()!; }
     state.shared = state.shared || (!!state.sessionId && memory.store.getSession(state.sessionId)!.host !== `pi:${piId}`);
     current = undefined;
```

### menu-only-gate

```diff
--- core/store/index.ts
+++ core/store/index.ts (pre-ticket probe)
@@ -547,7 +547,7 @@
   }
   enabled(sessionId: number): boolean {
     const value = this.enrollment(sessionId);
-    return value.choice ?? value.defaultEnabled;
+    return true;
   }
   setEnrollment(sessionId: number, enabled: boolean): void {
     if (typeof enabled !== "boolean") throw new Error("Enrollment choice must be boolean");
```

### historical-switch

```diff
--- hosts/pi/index.ts
+++ hosts/pi/index.ts (pre-ticket probe)
@@ -359,6 +359,7 @@
       const project = name && memory.store.findProjectByName(name);
       state = { projectId: project ? project.id : memory.store.createProject({ name: name ?? `pi:${piId}`, declaredBy: "marker" }).id, branch: "main", piId };
     }
+    if (state.sessionId && saved?.enrollment) memory.store.setEnrollment(state.sessionId, saved.enrollment.choice ?? saved.enrollment.defaultEnabled);
     // Branch history restores position only; the database and latest provisional choice own intent.
     const latest = ctx.sessionManager.getEntries().filter(e => e.type === "custom" && e.customType === tag)
       .map(e => (e as { data: State & { dbPath: string } }).data).filter(d => d.dbPath === dbPath && d.piId === piId).at(-1);
```

### consumer-mode-delivery

```diff
--- core/api/index.ts
+++ core/api/index.ts (pre-ticket probe)
@@ -260,6 +260,7 @@
   };
 
   const read = readFacade(store, cfg, trace);
+  const delivery = { deliverFacts: cfg.recording.branchModeDefault || !cfg.integration.subagentModeDefault, deliverKnowledge: !cfg.integration.subagentModeDefault };
   return {
     store,
     config: cfg,
@@ -275,7 +276,7 @@
       inFlightRecordings.add(key);
       try {
         const frozen = freezeRecording(store, input, cfg);
-        return await runRecording(store, frozen, runAgent, cfg, (context, run) => bindTools(store, read, context, run));
+        return await runRecording(store, frozen, runAgent, cfg, (context, run) => bindTools(store, read, context, run, undefined, delivery));
       } finally { inFlightRecordings.delete(key); }
     },
     integrate: async (input) => {
@@ -287,7 +288,7 @@
       inFlightIntegrations.add(key);
       try {
         const frozen = freezeIntegration(store, input, cfg);
-        return await runIntegration(store, frozen, runAgent, cfg, (context, run, review) => bindTools(store, read, context, run, review));
+        return await runIntegration(store, frozen, runAgent, cfg, (context, run, review) => bindTools(store, read, context, run, review, delivery));
       } finally { inFlightIntegrations.delete(key); }
     },
     ...read,
--- core/api/tools.ts
+++ core/api/tools.ts (pre-ticket probe)
@@ -55,7 +55,7 @@
   return input;
 }
 
-export function bindTools(store: Store, read: Reads, supplied: ToolContext, metadata?: RunInput, review?: MemoryReview) {
+export function bindTools(store: Store, read: Reads, supplied: ToolContext, metadata?: RunInput, review?: MemoryReview, options: { deliverFacts?: boolean; deliverKnowledge?: boolean } = {}) {
   const context = structuredClone(supplied);
   const session = store.getSession(context.sessionId);
   if (!session || !context.branch) throw new Error("tools require an existing session and a non-empty branch");
@@ -91,7 +91,7 @@
   const frozenPath = new Set(context.kind === "recording" ? store.sourcePath(session.id, context.branch, path.headTurnId!).map(e => e.id) : []);
   const sourceEligible = (source: string) => frozenSources.has(source) && !store.sourcePath(session.id, context.branch, path.headTurnId!)
     .some(e => !frozenPath.has(e.id) && sourceAddresses(e).includes(source));
-  const memory = bindMemory(store, session.id, run, review, path);
+  const memory = bindMemory(store, session.id, run, review, path, options);
   const sequence = memory.sequence;
   const fetched: { address: string; input: unknown; content: string }[] = [];
   let closed = false, committed: { runId: number; facts: Fact[] } | undefined;
@@ -140,7 +140,7 @@
       response: JSON.stringify({ toolCalls: [...sequence, { name: "note", input, result: "ok" }], readKnowledgeCommits: context.kind === "recording" ? context.readKnowledgeCommits : [] }) }, facts: commits,
       responseForFacts: (ids) => context.kind === "manual" ? receipt(ids) : JSON.stringify({ toolCalls: [...sequence, { name: "note", input, result: receipt(ids) }], fetched, problems: [], readKnowledgeCommits: context.readKnowledgeCommits }),
       ...(context.kind === "recording" ? { entryIds: frozenEntries,
-        pendingDelivery: { sessionId: session.id, branch: context.branch } } : {}) });
+        ...(options.deliverFacts === false ? {} : { pendingDelivery: { sessionId: session.id, branch: context.branch } }) } : {}) });
     if (!committedRun.ok) { problems = committedRun.problems; return JSON.stringify({ results: results.map(() => `rejected: ${problems.join("; ")}`) }); }
     const result = receipt(committedRun.facts.map((f) => f.id));
     if (context.kind === "recording") committed = committedRun;
--- core/integration/memory.ts
+++ core/integration/memory.ts (pre-ticket probe)
@@ -6,7 +6,7 @@
   frozen: ReturnType<typeof freezeIntegration>;
   feedback(batch: MemoryBatch): { text: string; near: NearPair[] };
 }
-export function bindMemory(store: Store, sessionId: number, run: RunInput, review?: MemoryReview, path: KnowledgePath = store.knowledgePath(sessionId)) {
+export function bindMemory(store: Store, sessionId: number, run: RunInput, review?: MemoryReview, path: KnowledgePath = store.knowledgePath(sessionId), options: { deliverKnowledge?: boolean } = {}) {
   const reads = new Map((review?.frozen.knowledge ?? store.listCurrentKnowledge(path)).map(k => [k.revision.id, k]));
   const reread = (addresses: string) => {
     for (const address of addresses.split(",").map(a => a.trim())) {
@@ -47,7 +47,7 @@
     const receipt = (items: import("../store/index.ts").CommittedKnowledgeOp[]) => JSON.stringify({ results: prepared.results, committed: items, diagnostics });
     const result = store.commitIntegrationRun({ path, run: { ...run, response: JSON.stringify({ problems: [] }), ...(review ? {} : { request: JSON.stringify(input) }) }, operations: prepared.operations,
       ...(review ? { integrated: review.frozen.rangeFacts.map(f => f.id),
-        pendingDelivery: { sessionId, branch: run.branch ?? null } } : {}),
+        ...(options.deliverKnowledge ? { pendingDelivery: { sessionId, branch: run.branch ?? null } } : {}) } : {}),
       finalizeResponse: ({ committed }) => {
         if (review) diagnostics.push(...accounting(store, sessionId, prepared.batch, review.frozen.rangeFacts, path));
         return review ? JSON.stringify({ toolCalls: [...sequence, { name: "memory", input, result: receipt(committed) }], candidate, committed, diagnostics, problems: [], readKnowledgeCommits: review.frozen.knowledge.map(k => ({ knowledgeId: k.knowledge.id, commit: k.revision.id })) }) : receipt(committed); } });
```

Restored production source hashes:

| File | SHA-256 |
|---|---|
| `core/api/index.ts` | `75e903bf835ecf4b1a907f7a445a469983d7fa45bc463b031471b8806afa8217` |
| `core/api/tools.ts` | `8ddf8dc81515344c9a9329d8d4f077a352ea2a029482efd8dda5436fd73264bf` |
| `core/api/read.ts` | `b1a0b17e4cb9eb0bb9de00c624be8c464bc06da7d1c600861ce6a61d7f5bdba0` |
| `core/integration/memory.ts` | `1fabb1112c637c400a56647d5f8fd0981ee95f12a6787bc4f3281e5db2194f0d` |
| `core/store/index.ts` | `a2ae981518cc450d6d751f03c71a6074ccdc22b20a08faa496073e7ba5d51b93` |
| `hosts/pi/index.ts` | `6c8ba2f7d404062587f9133beb4fbec040f65b9faafd6c6ccd83369993d11669` |

## Production line delta

Against `23f2a57`; blank lines/comments count. Tests, fixtures, this report and the pre-existing protected ticket-19 change are excluded.

| File | Before | After | Added | Removed | Net |
|---|---:|---:|---:|---:|---:|
| `.scratch/v1/spec.md` | 250 | 302 | +55 | -3 | +52 |
| `CONTEXT.md` | 49 | 51 | +2 | -0 | +2 |
| `core/README.md` | 311 | 325 | +16 | -2 | +14 |
| `core/api/index.ts` | 287 | 295 | +26 | -18 | +8 |
| `core/api/read.ts` | 167 | 171 | +5 | -1 | +4 |
| `core/api/tools.ts` | 180 | 183 | +19 | -16 | +3 |
| `core/integration/memory.ts` | 61 | 61 | +2 | -2 | +0 |
| `core/store/index.ts` | 1171 | 1224 | +104 | -51 | +53 |
| `hosts/pi/README.md` | 539 | 612 | +86 | -13 | +73 |
| `hosts/pi/index.ts` | 564 | 689 | +165 | -40 | +125 |
| Total | 3579 | 3913 | +480 | -146 | +334 |

## Review

The implement skill's code-review step ran separate read-only Standards and Spec reviewers against `23f2a57` and the working tree. Both found the pre-allocation restoration gap and incomplete sibling Raw gates; Spec additionally found the read-validation bypass and permissive timestamp parsing. All were corrected with regressions. Their rechecks found no remaining runtime or standards blocker. The Pi provisional-persistence limitation identified by review was subsequently addressed with the atomic host-state receipt and a loss-of-unflushed-state test. These reviews do not substitute for the executing agent's full-suite and revert-probe evidence.

## Acceptance self-check and remaining work

- [x] All nine 18a checkboxes implemented and mapped above, including the four required revert probes.
- [x] Parent scenarios 1–5, 9, 10, 12 (delivery), 13, 15, 16 and 17 covered within 18a, with inherited 17a/17b behavior retained.
- [x] Final 430 tests, typecheck, smoke and whitespace checks pass; all seven probes name red tests and verify changed spans and byte restoration.
- [x] No dependencies, migration, AgentSession, native fork, closure, claims, catch-up, timers, cancellation, staging or commits introduced.
- [x] Existing protected issue files left untouched; ticket 19's initial unrelated modification remains.
- [ ] Live Pi terminal/provider acceptance was not performed. Installed `getHeader`, select/confirm/input signatures and native `_persist` behavior were inspected; synthetic host and subprocess tests establish automated behavior, not a real terminal dialog or live-provider transcript.

No authorized implementation item is deferred. Ticket 17c still owns cancellation,
closure and claims; 18b owns manual Catch up and Stop; 19 owns native fork runtime.
These remain deliberate scope exclusions. The final reviewer accepted the added
provisional receipt and lost-custom-entry regression, with no remaining concrete
blocker. Full interactive Pi acceptance remains a separate live check.

The schema adds a derived enrollment boolean and a separate nullable explicit-choice boolean to sessions in place, with no migration; Pi supplies native creation metadata and the installation baseline, and preserves provisional choices until allocation. Configuration is a read-only `trace-memory` object in global/project Pi `settings.json` with environment overrides and per-value source display. Bare `/trace` opens the native enrollment/settings/runs/status menu, headless `/trace` prints status/help, and enable/disable/status join the retained commands; Catch up and Stop remain ticket 18b.
