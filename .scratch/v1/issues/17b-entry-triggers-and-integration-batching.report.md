# Ticket 17b acceptance report

**Ready for acceptor review.** Implementation is unstaged and uncommitted. The pinned baseline is `accc22c2ff30351a2369dd79909b7b0dc79dc5fe`, titled **17a: source entries as Recording units, one compressed Raw view, per-entry progress**. It was read with `git log -1 --format=fuller` before implementation. Initial status showed only the excluded untracked `.scratch/v1/issues/19-native-pi-fork-runtime.md`.

During implementation an external commit advanced HEAD to `27668ee` (**Ticket 19: gates and sequencing recorded, split into 19a/19b/19c, held**). This implementation created no commit and neither read nor modified that ticket or its split tickets. The original baseline remains authoritative; the external commit changes no 17b implementation path.

Both 17b and its parent were read, together with the 17a/16b reports, v1 spec, host README, glossary and both prompts. Repository work is English. CJK remains in existing conversation/test fixtures. No runtime dependency, closure, claim, enrollment, timer, background drain, AgentSession or native fork was introduced.

## Verification

| Check | Before | After |
|---|---:|---:|
| `npm test` | 385 passed, 17 files, independently rerun from the pinned commit in a temporary checkout | 400 passed, 18 files |
| `npm run typecheck` | Passed in the isolated baseline checkout | Passed after all restorations |
| `git diff --check` | Clean tracked tree | Passed after all restorations |
| `npm run smoke:pi` | Not rerun on baseline | Passed on Node 24.6.0: one Recording and one fact |
| Existing named ruling declarations | 41 direct declarations in `core/api/rulings.test.ts` | 41 retained; one title explicitly records Turn-batching supersession; the late-fact ruling retains its original name and a dated first-Recording-gate supersession comment |
| Revert probes, each running `npm test` | Not applicable | Eleven named red results; every file restored byte-for-byte |
| Staged changes / implementation commits | None | None |

The baseline checkout was created with `git archive accc22c2ff30351a2369dd79909b7b0dc79dc5fe` under `/private/tmp/trace-memory-17b-baseline`, sharing the installed `node_modules` read-only by symlink. It excludes the unrelated ticket-19 commit and produced the expected 385 green tests. All test commands use Vitest on Node, not Bun.

`git diff --exit-code` against the pinned baseline confirmed `core/render/index.ts`, `core/api/tools.ts`, `hosts/pi/branch.ts`, `package.json` and `package-lock.json` are byte-identical. The estimator, four tool definitions/write protocol, native branch builder and dependency manifests therefore remain unchanged.

## Acceptance evidence

New tests are in `hosts/pi/batching.test.ts` and begin **17b 2026-09-08:** unless another location is named.

| Criterion | Implementation | Behavioral evidence |
|---|---|---|
| Exactly 10,000 compressed tokens, no count or answered-Turn trigger | Host reconciliation measures `tokens(pendingEntries.map(renderEntry).join("\n\n"))`. Only completed persisted eligible sources enter the queue. | **Recording threshold is exactly compressed tokens (9999)** sends no request and retains both entries; **(10000)** sends one request and processes them. The test measures the stored rendered views including source labels and separators. Rewritten host cases prove ten short answered Turns and an oversized original tool result still do not trigger. |
| Completion boundary and exclusions | A changed persisted source head supplies one queue check after reconciliation. The original native leaf-id guard remains. Attach, tree, compaction and shutdown reconcile without scheduling. | Existing 17a persistence-order, thinking-only, missing-history and streaming leaf-guard tests remain. A bare `agent_settled` without a new eligible entry starts nothing. Source metadata, thinking-only, streaming, plugin, summary and worker entries remain excluded. |
| Oldest contiguous whole-entry prefix, at most 50,000 tokens | Recording selects a pending entry prefix by the rendered joined size before freezing sources, Turns and audit membership. It never skips an oversized oldest entry. | **oldest whole-entry batches cross Turns or split one Turn (false/true), with no completion chaining** queues more than 100,000 tokens. Three batches compare exact sent Raw bytes and persisted audit IDs with consecutive prefixes. Each of the first two batches plus its next entry would exceed 50,000. One case stays within a single Turn; the other spans several Turns in each batch. |
| Effective model capacity and honest failure | Optional `RecordInput.capacity` communicates available input and inherited prefix size. Candidate material includes instructions, knowledge, recent facts and tool definitions. Pi reserves the model output limit and a 15% estimation/framing margin. Actual native Recording requests are also checked before every provider call, including continuations. | **model capacity reduces the prefix and an oversized oldest entry stays pending with a report** selects one entry under a smaller model window, checks the serialized request plus reserved output fits, then lowers capacity and verifies no second request, unchanged old pending entries and a capacity notice. **an oldest entry blocked by the batch/native prefix budget stays pending** separately covers the configured batch cap and inherited native context. **native payload overhead is capacity-checked before sending or advancing entries** injects oversized provider framing after selection and checks zero sends, unchanged pending entries and an audited failure. |
| Fifty-fact trigger; immediate eligibility; no Turn grouping | `integrationBatch(sessionId, branch, headTurnId?)` selects all applicable committed facts not already integrated on that path. Threshold checking is separate from selection. The existing `integrated_facts` accounting and its path rule are unchanged. | **49 facts wait, 50 immediately committed facts trigger on a completion despite pending same-Turn sources** checks requests, exact integrated membership and retained Recording backlog. The rewritten core Turn-batching ruling includes facts on the unrecorded head. The retained **2026-09-07 review: a late fact on an early turn does not make the batch skip pending facts of later turns** checks non-monotonic Turn/fact order and proves integrating F1/F3 leaves F2 pending. Existing fork and mixed-source path regressions remain. |
| Remove derived Turn watermark and first-Recording gate | Removed `Watermark`, `getWatermark`, `listWatermarks`, and the status watermark lines. `knowledgePath` uses selected source ancestry; headless non-host callers retain branch-specific recorded-entry/run/manual-head fallback, without deriving whole-Turn coverage. | **facade infers the source path before a Turn is fully recorded** records just the user entry, leaves its assistant entry pending and integrates the committed fact without supplying `headTurnId`. Status explicitly asserts absence of `Watermark`; progress tests inspect nonempty source membership instead. |
| No completion chaining | Both queue thresholds are observed at the completion opportunity. Neither worker completion nor delivery confirmation starts a new run. Provider-call retries remain within the existing worker loop. | The three-batch tests repeatedly drain and settle without new entries and assert unchanged request counts, then append an eligible source to start the next batch. Existing retry, postcommit failure and duplicate-run tests remain; duplicate Integration now receives a real second completion while held. |
| Lifecycle preserves both queues and in-flight success | Before-tree returns the shared read-only summary immediately. Compaction and shutdown launch neither phase. Shutdown retains the existing `Promise.allSettled([...pending])` policy before closing SQLite; no new timeout or flush was added. | **lifecycle hooks launch neither phase and preserve both pending queues** seeds a due Recording backlog plus fifty unintegrated facts, invokes all three hooks, and verifies zero provider requests and unchanged queues. Existing shutdown tests for new/resume/fork hold a worker, prove shutdown waits, release it and assert successful commit with no extra run. The tree test proves immediate summary while a frozen worker remains in flight, followed by branch-bound delivery after it settles. |
| Branch request and delivery contracts unchanged | Branch construction remains the captured prefix plus one user append; subsequent native tool rounds preserve it. A selected entry missing from captured source coverage uses the existing shared-view subagent fallback. Native messages before the latest compaction/branch-summary boundary are conservatively excluded from capture coverage. Delivery creation predicates, pending-delivery gating and settled-only confirmation stay unchanged. | Existing exact-request branch and installed-adapter tests remain green. **stale branch capture falls back with the newly completed user/toolResult evidence** inspects actual supplied evidence and persisted mode/reason. **capture after compaction does not claim the persisted original prefix** verifies old pending evidence is supplied through fallback. Existing dated delivery and backfill rulings retain their names and assertions, with fresh completions replacing obsolete settled-trigger opportunities. |
| Configuration and synchronized documentation | Removed `recording.triggerAnsweredTurns`; `recording.triggerTokens` now defaults to 10,000 compressed tokens; new `recording.batchTokens` defaults to 50,000. View defaults remain 1,000/10,000 and Integration remains fifty facts. Unknown keys fail in the host and core configuration paths; size limits are positive safe integers. | **configuration rejects removed and unknown keys and validates compressed trigger and batch limits** covers zero, negative, fractional, nonfinite and unsafe values plus removed/unknown keys through both configuration seams. Spec, glossary, host/core READMEs, current live setup and both prompts were updated. Historical live-run records remain historical. |
| Revert acceptance | Required lifecycle and Turn-grouping reversions, plus changed reader/predicate families, are tested independently. | Direct changed-span diffs, named red tests, full-suite results and restoration hashes are recorded below. |

## Design choices and subtraction

- **One scheduling boundary:** reconciliation supplies an opportunity only when a completed eligible source changes the selected source head. No secondary queue, timer, count, answered-turn scan or worker-finished callback was added. `before_provider_request` installs its fresh capture before checking newly reconciled sources.
- **Separate trigger and batch:** all pending compressed views determine whether Recording is due; only the oldest safe prefix is frozen. Integration's fifty-fact setting is a trigger, not a batch-count cap. No atomic fact truncation or Turn grouping remains.
- **Context safety:** core sizes the actual assembled Recording input and conservatively also reserves the complete fallback material. The host uses installed model `contextWindow`/`maxTokens` declarations, checks actual native payload size plus output allowance, and reports a capacity problem without processing sources if it cannot safely send. The estimator remains the existing heuristic, not a provider tokenizer guarantee. Native branch prefixes are never rewritten or described as covered by the new-material cap.
- **Capture freshness:** mid-Turn entry completion makes a previously sufficient capture stale for new user/tool evidence. The existing fallback now receives an explicit missing-selected-source reason. Plain head assistant text remains eligible for the unchanged full head-reply append. Context resets conservatively invalidate prior native-source coverage. This does not defend arbitrary downstream payload-rewriting extensions; the existing documented hook ordering still applies.
- **Deleted mechanisms:** the answered-Turn configuration and trigger, original-Raw trigger scan, whole-Turn Integration loop, first-successful-Recording gate, derived Turn watermark type/readers/status, tree-switch Recording flush, its recording-promise lookup map and its summary usage attribution. The general pending-run set and the facade's run deduplication remain because shutdown and in-flight exclusion still use them.
- **Reader replacement:** explicit host heads determine selection. Without a head, selected native ancestry is authoritative even before Recording. For older headless test/API seams without selected native ancestry, the branch's successful recorded entry/run and manual run heads provide path context; this is not processed-Turn progress or a maximum-fact-ID cursor.
- **Fixture changes:** old watermark assertions now check actual nonempty source membership or pending entries. Provider fixtures choose an eligible frozen user source rather than assuming a range's first Turn always contains its user entry. Branch identity tests capture after persisted user input, matching Pi's source/prefix relationship. Existing named rulings remain; the two superseded Turn eligibility/grouping premises explicitly record the 2026-09-08 supersession.

## Revert probes

Each independent mutation runs the full `npm test` suite. Before execution the probe verifies original bytes, writes exactly the intended changed bytes, reads them back and generates a direct unified diff of the changed span. The saved diff is checked to contain an actual source change. A `finally` block restores every changed file and compares it byte-for-byte against the original. No mutation is used as a substitute for a named failing test.

An initial probe setup rejected an addition-only diff because its guard incorrectly required both added and removed lines. No suite ran for that attempt; the file was restored. The guard was corrected to accept any actual changed line before collecting the evidence below.

| Reverted behavior | Named red test | Failed tests in that suite |
|---|---|---:|
| `lifecycle-flush` | **17b 2026-09-08: lifecycle hooks launch neither phase and preserve both pending queues** | 4 |
| `integration-whole-turns` | **2026-09-07 review: a late fact on an early turn does not make the batch skip pending facts of later turns** | 1 |
| `integration-recording-gate` | **17b 2026-09-08: 49 facts wait, 50 immediately committed facts trigger on a completion despite pending same-Turn sources** | 13 |
| `original-raw-trigger` | **17b 2026-09-08: Recording threshold is exactly compressed tokens (9999)** | 5 |
| `unbounded-recording` | **17b 2026-09-08: oldest whole-entry batches cross Turns or split one Turn (false), with no completion chaining** | 4 |
| `no-capacity-selection` | **17b 2026-09-08: model capacity reduces the prefix and an oversized oldest entry stays pending with a report** | 2 |
| `stale-capture-admitted` | **17b 2026-09-08: stale branch capture falls back with the newly completed user evidence** | 3 |
| `derived-turn-head` | **17b 2026-09-08: facade infers the source path before a Turn is fully recorded** | 1 |
| `watermark-status` | **status reports attribution, counts, every watermark, last runs and pending deliveries** | 1 |
| `unknown-config-ignored` | **17b 2026-09-08: configuration rejects removed and unknown keys and validates compressed trigger and batch limits** | 1 |
| `native-capacity-unchecked` | **17b 2026-09-08: native payload overhead is capacity-checked before sending or advancing entries** | 1 |

All eleven suites were red on the listed tests, and all changes were restored byte-for-byte. The first nine probes ran with 399 tests; the last two included the added native-payload admission regression, for 400 tests. Logs and direct diffs are under `/private/tmp/17b-probes`. The two required changed spans are reproduced here:

```diff
--- hosts/pi/index.ts
+++ hosts/pi/index.ts (pre-ticket probe)
@@ -500,6 +500,7 @@
     ensure(context); flush(true);
     const { sessionId, branch, head } = state;
     if (!sessionId || !head) return { summary: { summary: "" } };
+    await memory.record({ sessionId, branch, headTurnId: head, mode: "subagent", model: modelName("recording") });
     return { summary: { summary: memory.branchSummary(sessionId, branch, head) } };
   });
   pi.on("session_before_compact", (event, context) => {
```

```diff
--- core/store/index.ts
+++ core/store/index.ts (pre-ticket probe)
@@ -1102,7 +1102,15 @@
   integrationBatch(sessionId: number, branch: string, headTurnId?: number): Fact[] {
     const path = this.knowledgePath(sessionId, branch, headTurnId);
     const runs = new Map<number, boolean>();
-    return this.listBranchFacts(sessionId, branch, path.headTurnId).filter(f => !this.integratedOnPath(f.id, path, runs));
+    const facts = this.listBranchFacts(sessionId, branch, path.headTurnId).filter(f => !this.integratedOnPath(f.id, path, runs));
+    const order: number[] = [];
+    for (let id = path.headTurnId; id; id = this.getTurn(id)?.parentTurnId ?? null) order.unshift(id);
+    const batch: Fact[] = [];
+    for (const turnId of order) {
+      batch.push(...facts.filter(f => f.turnId === turnId).sort((a, b) => a.id - b.id));
+      if (batch.length >= 50) break;
+    }
+    return batch;
   }
 
   markIntegrated(factId: number, runId: number, projectId: number): void {
```

The lifecycle probe restores the removed extraction call using the current facade (the redundant host recording-promise wrapper no longer exists). The grouping probe restores the former path-order whole-Turn loop with the default fifty-fact cut; the independent recording-gate probe also restores the baseline derived reader and eligibility predicate. Thus the two old behaviors are tested separately rather than letting one hide the other.

| Direct span diff | Verified SHA-256 |
|---|---|
| `lifecycle-flush` | `cb54fb67d246591264f385f20a1260283bca20f0e95141411dd641b68c6be816` |
| `integration-whole-turns` | `db3e638b843b3cc7be36914d7d52f0611e55413db680ffe3ff43a923933af0dd` |
| `integration-recording-gate` | `4c811cf2e8815963cce6619fd7e7cddf72ae79d940b12e053e221bcf12201538` |
| `original-raw-trigger` | `98afae1f266834fee1a3eb5e986908f4505c52b0b0521236355e82e1d3d7b47a` |
| `unbounded-recording` | `e67c9ca3c2f0637ab5c330461328c48860465a8606781d7c791fceab7abcfe30` |
| `no-capacity-selection` | `e9a2a90359e24ea42f0501b3697cde6ee184c196c6cc2bb7658aae2079be8e06` |
| `stale-capture-admitted` | `4cad6353d810a80b7d600ed927c88a8367e4953b9f73386152309ecff246b2a7` |
| `derived-turn-head` | `1f37b142ec4c94ce8b2ac58e799572ab2c76dc0d3a968a6014449c06a4dff179` |
| `watermark-status` | `c40bc104788e8bfb4c4e460fae69ccfe31d4dfcf17bdd0ccee284246b3955b1a` |
| `unknown-config-ignored` | `92e9a18621d1be220a0ea90addfd7dd91be598bc5b00877676c6e3e31cc978d2` |
| `native-capacity-unchecked` | `040f776adce4798fd6cb2687852ae8b08e88632f75138464875a2cc6f182eca4` |

Restored production source hashes:

| File | SHA-256 |
|---|---|
| `hosts/pi/index.ts` | `4b462138a05dbf6fc394b4a9b3b5668117f622c836774617a046373197114044` |
| `core/store/index.ts` | `0062a40fa13d9af19533445706c79ed6188662c0a1f682b8c698f651be4a8438` |
| `core/api/read.ts` | `caa0ab3156983eac6058295b1b98723540833ae1dbe22a8817c7c920118539e5` |
| `core/recording/index.ts` | `dfab096c5f3d68b6b9743a95199668dab736a25edef7a9d96b83557717a21f6c` |
| `core/api/index.ts` | `630aa086521b01ca97bc08a08e3adcdce6511f2e72d4b3f33b8f5a3fbe621359` |

## Production line delta

Counts compare only this implementation's changed paths against the pinned baseline; the unrelated external ticket-19 commit is excluded. Blank lines/comments count. Tests, fixtures and this report are excluded.

| File | Before | After | Added | Removed | Net |
|---|---:|---:|---:|---:|---:|
| `.scratch/v1/spec.md` | 248 | 250 | +13 | -11 | +2 |
| `CONTEXT.md` | 50 | 49 | +3 | -4 | -1 |
| `core/README.md` | 310 | 311 | +13 | -12 | +1 |
| `core/api/index.ts` | 278 | 287 | +13 | -4 | +9 |
| `core/api/read.ts` | 170 | 167 | +2 | -5 | -3 |
| `core/integration/index.ts` | 148 | 147 | +2 | -3 | -1 |
| `core/model/index.ts` | 313 | 307 | +0 | -6 | -6 |
| `core/prompts/integration.md` | 122 | 123 | +1 | -0 | +1 |
| `core/prompts/recording.md` | 92 | 93 | +1 | -0 | +1 |
| `core/recording/index.ts` | 135 | 166 | +51 | -20 | +31 |
| `core/store/index.ts` | 1214 | 1175 | +11 | -50 | -39 |
| `hosts/pi/LIVE-VERIFICATION.md` | 185 | 185 | +1 | -1 | +0 |
| `hosts/pi/README.md` | 532 | 539 | +64 | -57 | +7 |
| `hosts/pi/index.ts` | 554 | 562 | +52 | -44 | +8 |
| Total | 4351 | 4361 | +227 | -217 | +10 |

The store query changes are limited to head inference and deleting derived watermark readers. `knowledgePath` reads selected `source_paths.entry_ids` and its last source Turn, with a recorded-entry/run/manual-run head fallback where no native source path exists. Removed queries enumerate recording branches and scan whole-Turn recorded coverage. `integrationBatch` composes existing branch-fact and `integratedOnPath` readers; the `integrated_facts` SQL and path rule are unchanged. No schema, migration, knowledge DAG or delivery SQL changed.

## Standards review

The independent reviewer identified stale core contract documentation, vacuous progress assertions, an obsolete settled-only duplicate test, and a leftover threshold argument now interpreted as a head. All were corrected. Its restored-work review found no remaining hard standards violation. The suggested shared name for the 15% context margin was also adopted.

## Spec review

The independent reviewer found that new entry completions could use a provider capture lacking user/tool evidence, and that persisted ancestry before compaction is insufficient capture proof. Both were fixed with explicit fallback coverage and actual-request regressions. The independent reviewer re-read the restored production files and reported **READY**, with no remaining 17b specification issue. Both reviews were static; test and probe results in this report were run by the implementing agent.

## Acceptance self-check and remaining work

- [x] All 17b behavior and configuration criteria have implementation and behavioral evidence above.
- [x] Original estimator, read permissions, source-address meanings, knowledge commits and per-fact accounting retained.
- [x] No 17c/18/19 implementation, runtime dependency, timer, AgentSession, staging or implementation commit.
- [x] Final restored full suite: 400 passed; typecheck and whitespace checks passed; eleven revert probes recorded.

No authorized 17b implementation item is deferred. A live provider conversation was not performed; fake Pi plus the public facade and temporary SQLite database supply the requested automated evidence, and installed native adapter tests preserve the branch request contract. Closed-session catch-up/claims, enrollment/delivery-policy changes and native fork runtime remain intentionally outside this ticket.

Configuration now uses a 10,000-token compressed-view Recording trigger and a separate 50,000-token whole-entry batch cap alongside the unchanged 1,000/10,000 view limits and fifty-fact Integration trigger; removed or unknown keys fail explicitly. The facade accepts optional host Recording capacity and exposes frozen `RecordingAgentInput.entryIds` for capture coverage, while `integrationBatch` accepts a path head instead of a threshold; derived Turn watermark readers and status lines are gone. Model-facing tools, exact branch append construction, unrestricted reads, settled delivery confirmation and path-aware per-fact Integration progress retain their contracts.
