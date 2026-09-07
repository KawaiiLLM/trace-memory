# Ticket 17a acceptance report

**Ready for acceptor review.** The implementation remains unstaged and uncommitted. Baseline: `de924e8bcd25cd2652932c6a23284ed6a490ce0d`; the initial working tree was clean. Both ticket 17a and its parent, the v1 specification, host README, both prompts, glossary and the 16a/16b reports informed this implementation. All new repository prose is English; CJK remains in source fixtures exercising rendering and estimation.

## Verification

| Check | Before | After |
|---|---:|---:|
| `npm test` | 366 passed, 15 files | 384 passed, 17 files |
| `npm run typecheck` | — | Passed |
| `npm run smoke:pi` | — | Passed on Node 24.6.0: one Recording, one fact |
| `git diff --check` | — | Passed |
| Existing named ruling declarations | 41 direct declarations | All names and dates retained |
| Revert probes, each running `npm test` | — | 24 independent mutations red; all restored byte-for-byte |
| Staged changes / new commits | None | None |

Eighteen behavioral tests were added: eight core view/configuration cases and ten fake-Pi host cases. All 366 pre-existing tests remain, with entry-scope supersessions recorded in comments rather than deleting named tests. `test/source-fixture.ts` is a test-only completed-message producer that assigns native fixture identities while seeding the older fixtures through the public facade. It rejects aggregate assistant-text replacement; it performs no production-data or coverage migration.

The host's provider worker, retry and request-construction prefix is byte-identical to the baseline. The four tool definitions and schemas are byte-identical. `hosts/pi/branch.ts`, runtime Integration modules, the Integration prompt, dependency manifests and the estimator's ruling tests are unchanged. The complete estimator implementation was compared byte-for-byte; SHA-256 of its source span: `a3416b6306d58bc16df409ff2e70e2f76530f3814304c27fce479c328a411281`.

## Acceptance evidence

All tests below are in `hosts/pi/entries.test.ts` unless a core file is named. The new test names begin `17a 2026-09-08:`.

| Criterion | Implementation | Behavioral evidence |
|---|---|---|
| Completed entries, native identity and repeated occurrences | `appendEntry` persists `(session, native lineage, native id)`, owning Turn, raw message, natural text and stable tool fragments. Selected native ancestry determines path membership; text is never an identity. | **attach imports earlier native history, preserves repeated occurrences, and excludes plugin and empty sources** asserts two equal user messages own different Turns, two equal assistant messages survive separately, original repeated text is readable, reattach creates no S2 and later messages continue S1. |
| Persistence boundary | Reconciliation reads persisted ancestry only. The installed Pi 0.85.0 `agent-session.js` emits extension hooks before `appendMessage` at message_end. Safe later events reconcile and persist host references. | **completion alone has no native identity; next safe boundary reconciles persisted entries** invokes the hook before appending the fake native entry, proves it is absent from the queue, then appends and reconciles its actual native id. Repeated reconciliation is exactly idempotent. |
| Both limits, all content shapes, labels and markers included | `renderEntry` uses the unchanged estimator, fixed tool portions, then the complete-entry cap. Character excerpts handle a huge line or JSON value. Entry redistribution retains labels, status and excerpts for every call when they fit. | `core/api/entries.test.ts`: **shared view bounds ... including source labels and omission markers** covers ordinary text, CJK, one huge line, huge JSON arguments, seven calls with long natural language, and 30 calls without natural text. It measures complete entry and tool-fragment strings, and checks head/count/tail. |
| Stable late result budgeting and validated defaults | Arguments and results each permanently reserve half of the call budget, with two joining tokens reserved. Values are positive safe integers, defaulting to decimal 1,000/10,000. Impossible metadata capacity throws and leaves work pending. | Core tests **fixed call portions bound arguments plus late result without changing the earlier view** and **view configuration validates decimal limits and impossible metadata reports capacity**; host **huge native JSON arguments and results remain byte-exact through full trace** measures the combined call and compares the earlier view after the result arrives. |
| Identical Recording, fallback, compaction and carry views; no provider call for preparation | All four consumers call `renderEntry`; whole-view joining is the only difference. `budgetFacts` measures compressed Raw, retains pending views with outer-overage receipts and admits whole facts that fit. | **Recording, fallback, compaction and carry supply identical bounded entry bytes** compares exact Raw slices from real host requests and the two blocks, exercising actual missing-prefix fallback; preparation records zero provider calls. **compaction measures compressed tokens and preserves facts that fit beside excerpts** proves originals exceed 20k while views fit, and checks exact retained fact text in both compaction and Recording. |
| Original evidence and honest omissions | Immutable source Raw is retained; full trace emits original argument/result strings, including auxiliary JSON fields. Multiple results for a shared forked call are all labelled and readable. Default trace previews and pagination retain their existing contract. | **huge native JSON arguments and results remain byte-exact through full trace** checks exact full trace equality for large native values; **shared-call fork results retain both originals through unrestricted full trace** checks A and B plus their success/failure statuses after the fork. Core excerpt cases require `middle not inspected`; the Recording prompt forbids promoting cut evidence to inspected completion. |
| Branch-mode native request contract | The native provider prefix is never compressed or rebuilt. Its single appended user message still contains instruction, range, head reply and the frozen source index. The README explicitly says branch Recording reads the uncompressed prefix and gains nothing from the compressed view. | All existing `hosts/pi/branch.test.ts`, `branch-wire.test.ts` and host branch-request tests pass. The retained **08:53 with 2026-09-07 premise repair: branch uses conversation context; subagent carries the raw** compares the exact append. The late-entry host case also checks the next branch append excludes the already-processed user source. |
| Exact frozen progress and citation eligibility | `recorded_entries` commits only selected identities, including zero-fact success. The bound writer retains frozen path membership, not a numeric allocation cutoff. New matching occurrences cannot become eligible just because they share a Turn; manual writes require current-path occurrences too. | **frozen entries leave late same-Turn sources pending and reject their citations despite unrestricted reads** fetches the late result, rejects its tool and assistant citations, corrects to an empty batch, checks only the two late entries remain pending, and checks the derived whole-Turn boundary has not advanced. |
| Reopen, forks and stable ordinals | Host state persists the exact source head, so forks within one Turn get distinct branches. Shared entries reuse original identities and processing; new lineages can reuse a short native id without collision. Ordinals belong to persisted call occurrences. | **forks reuse shared identities and ordinals but native short ids in different lineages never collide** checks ordinals 1/2/3, shared inherited coverage, sibling exclusion, manual citation rejection, and all tool reads after opening another facade. **shared-call fork results...** checks a same-native-session tree switch inside a Turn. |
| Missing native history and excluded sources | Attach reports missing parents, unavailable owning source history and changed native identities; it does not synthesize missing entries. Source messages exclude custom/plugin data, thinking-only content, summaries and non-conversation roles. | **attach surfaces missing native ancestry without manufacturing sources** removes native messages while retaining state, observes a warning and no manufactured pending entries, and confirms originals remain stored. The attach-import case excludes custom and summary messages. **thinking-only reply remains answered for the existing trigger but is not a source** preserves the pre-17b trigger while proving the private thinking is absent from input. |
| Audit, atomicity and host neutrality | `entryAudit` records native identities, owning Turns, frozen branch, view version/budgets and exact omission markers. It survives both the atomic write and subsequent response updates. Ingestion uses one SQLite transaction; no Pi SDK enters core. | The frozen-entry host case compares committed audit membership with the pre-launch entry set. Existing commit rollback, failure/bounce, zero-fact, postcommit error, delivery, retry, branch verification and core-without-Pi tests remain green. |
| Scope and documentation | Updated v1 schema/affected text, glossary, core/host READMEs and Recording input prompt. The Integration input did not change, so its prompt remains untouched. Removed writable Turn progress rather than maintaining parallel progress. | Protected-span comparisons plus all existing trigger, Integration batching and delivery tests. No closure, claims, timers, new runtime dependency, AgentSession or native fork introduced. |
| Revert evidence | Every rewritten reader/predicate family is exercised by restoring the former behavior or its pre-entry equivalent. | The 24 named red checks below; direct span diffs verified before executing each suite; byte restoration checked afterward; final full suite green. |

## Design choices

- **Two durable memberships:** `source_paths` records selected native ancestry; `recorded_entries` records successful processing. Neither stores delivery acknowledgement or duplicates a pending queue. Pending work is their difference.
- **Immutable source versus display projection:** the native source message and its fragments never change. Turn text and `tool_calls` remain address/read projections. Full trace resolves all result occurrences when a shared ordinal has alternate fork results; it never hides the original behind the latest projection.
- **Stable fragments:** the default call reserves 499 tokens for arguments and 499 for a result, including repeated identifying metadata; two tokens remain for joining. Result arrival never reallocates the earlier view. The entry cap reduces fragment payloads while protecting their metadata and useful head/tail excerpts. Tiny configurations unable to carry labels/markers report capacity rather than silently exceeding a limit.
- **Address aliases:** public Turn/tool addresses stay unchanged. In a Recording write they identify matching occurrences within that run's frozen entry set, which the audit records. Already-processed occurrences sharing an alias are not added back to that set. A matching occurrence arriving after freeze makes the address ineligible for the earlier writer; reads remain unrestricted. No semantic truth checker or new model-facing source syntax is introduced.
- **Subtraction:** removed the `watermarks` table, writable `setWatermark`, and `lastRecordedAncestor` Turn-range inheritance. `getWatermark`/`listWatermarks` now derive a fully processed Turn boundary solely for the unchanged trigger, Integration and status consumers. Recording selection and commit never consume that boundary. No historical coverage translation exists.
- **Host scheduling:** only reconciliation was added to safe boundaries. Existing answered-Turn/raw-token triggers, tree-switch Recording, retry and delivery admission remain. `branchSummary` preparation itself is a read with no provider call; removing the before-tree extraction trigger is 17b work.
- **Fixture scope:** older tests explicitly produce completed fixture entries through a test-only adapter. Production sources require actual native identities. Fixture coverage seeds exact entry ids, not a converted Turn watermark.

## Golden diffs

Only the following golden/snapshot lines changed. Both contain short uncut text, so no head/count/tail omission shape was removed. The existing tool preview goldens under `test/fixtures/recording` remain byte-identical; the new automatic excerpt shape is independently checked for head, omission count and tail, including oversized single-line input.

```diff
diff --git a/core/api/__snapshots__/rulings.test.ts.snap b/core/api/__snapshots__/rulings.test.ts.snap
index c0a0e6a..f0762ca 100644
--- a/core/api/__snapshots__/rulings.test.ts.snap
+++ b/core/api/__snapshots__/rulings.test.ts.snap
@@ -14,9 +14,10 @@ Commits (by evidence):
 [K1@2] [constraint/project] C version
   supports: F2
 Unrecorded raw:
-[S1/T4] 2026-09-06T00:00:00Z [turn]
+[S1/T4] [entry ["fixture","message-7"]]
 [Source entry id: T4#user]
 Unrecorded <work> & more
+[S1/T4] [entry ["fixture","message-8"]]
 [Source entry id: T4#assistant]
 Pending
 </branch_carry>"
diff --git a/test/fixtures/read/compact.txt b/test/fixtures/read/compact.txt
index 19447e7..1c876b5 100644
--- a/test/fixtures/read/compact.txt
+++ b/test/fixtures/read/compact.txt
@@ -8,7 +8,7 @@
 <episodic>
 Raw:
 
-[S1/T2] 2026-09-06T00:00:00Z [turn]
+[S1/T2] [entry ["fixture","message-2"]]
 [Source entry id: T2#user]
 能不能从贴图推断
 
```

## Revert probes

Each mutation ran the full `npm test` suite. Before execution, the probe compared the actual file to the intended changed bytes and generated a direct unified diff of the original and changed span. The checked diff was saved before trusting any result. A `finally` block restored the original bytes and compared them for equality; all restored source hashes were also rechecked against the final tree. Each listed test actually failed, not merely a `toContain` pin remaining green.

An initial attach probe was caught by a fork test rather than the intended attach test because the latter allowed an intervening event to save state. The attach test was strengthened to reattach immediately; rerunning the mutation then failed that named test as well. An early excerpt-probe setup failed its own span-verification guard before running tests; its setup was corrected before collecting the result below.

| Reverted behavior | Source | Named red test | Failed tests in that suite |
|---|---|---|---:|
| `original-compaction-tokens` | `core/api/read.ts` | **17a 2026-09-08: compaction measures compressed tokens and preserves facts that fit beside excerpts** | 1 |
| `original-recording-tokens` | `core/recording/index.ts` | **17a 2026-09-08: compaction measures compressed tokens and preserves facts that fit beside excerpts** | 1 |
| `whole-turn-advancement` | `core/store/index.ts` | **17a 2026-09-08: frozen entries leave late same-Turn sources pending and reject their citations despite unrestricted reads** | 2 |
| `whole-turn-pending-reader` | `core/store/index.ts` | **17a 2026-09-08: frozen entries leave late same-Turn sources pending and reject their citations despite unrestricted reads** | 2 |
| `whole-turn-boundary` | `core/store/index.ts` | **17a 2026-09-08: frozen entries leave late same-Turn sources pending and reject their citations despite unrestricted reads** | 13 |
| `ignore-native-path` | `core/store/index.ts` | **17a 2026-09-08: forks reuse shared identities and ordinals but native short ids in different lineages never collide** | 3 |
| `turn-only-citation` | `core/api/tools.ts` | **17a 2026-09-08: frozen entries leave late same-Turn sources pending and reject their citations despite unrestricted reads** | 1 |
| `manual-turn-only-citation` | `core/api/tools.ts` | **17a 2026-09-08: forks reuse shared identities and ordinals but native short ids in different lineages never collide** | 1 |
| `recording-old-raw` | `core/recording/index.ts` | **17a 2026-09-08: Recording, fallback, compaction and carry supply identical bounded entry bytes** | 100 |
| `compact-old-raw` | `core/api/read.ts` | **17a 2026-09-08: Recording, fallback, compaction and carry supply identical bounded entry bytes** | 4 |
| `carry-old-raw` | `core/api/read.ts` | **17a 2026-09-08: Recording, fallback, compaction and carry supply identical bounded entry bytes** | 2 |
| `last-result-only` | `core/api/index.ts` | **17a 2026-09-08: shared-call fork results retain both originals through unrestricted full trace** | 1 |
| `no-identity-reuse` | `hosts/pi/index.ts` | **17a 2026-09-08: completion alone has no native identity; next safe boundary reconciles persisted entries** | 153 |
| `all-history-instead-of-ancestry` | `hosts/pi/index.ts` | **17a 2026-09-08: forks reuse shared identities and ordinals but native short ids in different lineages never collide** | 7 |
| `thinking-is-source` | `hosts/pi/index.ts` | **17a 2026-09-08: thinking-only reply remains answered for the existing trigger but is not a source** | 2 |
| `turn-head-only-fork` | `hosts/pi/index.ts` | **17a 2026-09-08: shared-call fork results retain both originals through unrestricted full trace** | 1 |
| `no-missing-history-receipt` | `hosts/pi/index.ts` | **17a 2026-09-08: attach surfaces missing native ancestry without manufacturing sources** | 1 |
| `no-attach-state` | `hosts/pi/index.ts` | **17a 2026-09-08: attach imports earlier native history, preserves repeated occurrences, and excludes plugin and empty sources** | 2 |
| `old-line-only-excerpt` | `core/render/index.ts` | **17a 2026-09-08: shared view bounds one huge line including source labels and omission markers** | 6 |
| `no-combined-tool-cap` | `core/render/index.ts` | **17a 2026-09-08: fixed call portions bound arguments plus late result without changing the earlier view** | 3 |
| `no-whole-entry-cap` | `core/render/index.ts` | **17a 2026-09-08: shared view bounds one huge line including source labels and omission markers** | 5 |
| `old-full-tool-projection` | `core/render/index.ts` | **2026-09-07: trace source suffix keeps standard tool cuts unless full** | 4 |
| `whole-turn-source-index` | `core/recording/index.ts` | **17a 2026-09-08: frozen entries leave late same-Turn sources pending and reject their citations despite unrestricted reads** | 1 |
| `run-only-progress-listing` | `core/store/index.ts` | **integration progress does not count on a fork when a manual fact beyond the fork point was integrated in the same run** | 1 |

The two required probe families changed these exact spans:

```diff
--- core/api/read.ts
+++ core/api/read.ts
@@ -95,7 +95,7 @@
       const raw = head === undefined ? [] : store.pendingEntries(sessionId, branch, head).map(e => renderEntry(e, config.render));
       const rawText = raw.map((r) => r.content).join("\n\n");
       const facts = store.listSessionFacts(sessionId);
-      const episodic = budgetFacts(rawText, facts, (f) => factLine(f.id), config.render.episodicBlockTokens);
+      const episodic = budgetFacts(store.pendingEntries(sessionId, branch, head!).map(e => e.raw).join("\n\n"), facts, (f) => factLine(f.id), config.render.episodicBlockTokens);
       return finish({ content: `${block.content}\n\n${xmlBlock("episodic", ["Raw:", rawText, "Recent facts (newest first):", episodic.recent.join("\n")].join("\n\n"))}`,
         receipts: [...block.receipts, ...raw.flatMap((r) => r.receipts), ...episodic.receipts] });
     },
--- core/recording/index.ts
+++ core/recording/index.ts
@@ -80,7 +80,7 @@
   const raw = entries.map(entry => renderEntry(entry, config.render));
   const rawText = raw.map((r) => r.content).join("\n\n");
   const receipts = raw.flatMap((r) => r.receipts);
-  const episodic = budgetFacts(rawText, facts, (f) => renderFact(f, store.listFactRelations(f.id)), config.render.episodicBlockTokens);
+  const episodic = budgetFacts(entries.map(e => e.raw).join("\n\n"), facts, (f) => renderFact(f, store.listFactRelations(f.id)), config.render.episodicBlockTokens);
   const active = budgetKnowledge(knowledge, config.render.knowledgeBlockTokens);
   const recent = episodic.recent, knowledgeLines = active.groups.map((g) => g.text);
   receipts.push(...episodic.receipts, ...active.receipts);
--- core/store/index.ts
+++ core/store/index.ts
@@ -683,7 +683,7 @@
         try { const parsed = JSON.parse(input.responseForFacts?.(batchIds) ?? input.run.response ?? "{}"); response = parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : { output: parsed }; }
         catch { response = { output: input.run.response }; }
         this.db.prepare("UPDATE runs SET response = ? WHERE id = ?").run(JSON.stringify({ ...response, ...(input.run.entryAudit ? { entryAudit: input.run.entryAudit } : {}), factIds: batchIds }), runId);
-        for (const id of input.entryIds ?? []) {
+        for (const id of this.listSourceEntries(sessionId).filter(e => (input.entryIds ?? []).some(id => this.getSourceEntry(id)!.turnId === e.turnId)).map(e => e.id)) {
           if (this.getSourceEntry(id)?.sessionId !== sessionId) throw new Error("entry does not belong to the run session");
           this.db.prepare("INSERT INTO recorded_entries (entry_id, run_id) VALUES (?, ?)").run(id, runId);
         }
```

All other probes restore the corresponding old reader behavior: Turn-based queue filtering or source indexing, path-wide Turn citation admission, old automatic `renderTurn` material, line-only cuts, absent complete-entry/tool caps, original single-result trace projection, or missing identity/attach/source-head handling. Exact diff fingerprints follow so the applied spans are distinguishable:

| Probe | Verified diff SHA-256 |
|---|---|
| `original-compaction-tokens` | `cf044f66e8e8b0ffd828b1fbee2860569916393f6d84a26fb02ed3df87b1d1a2` |
| `original-recording-tokens` | `f4affb6eb16a45a9c79b28a35b9b523caa6b4413b4dd0eb050df86c3f92cd858` |
| `whole-turn-advancement` | `ebf6298561f0e3ae4943353136c34452288f890c323617d00d337e691afdc206` |
| `whole-turn-pending-reader` | `46d0d2d6b135fe927010de524d87f4f3fd5ba70f244b145d9a4c0cfc4fd25161` |
| `whole-turn-boundary` | `e8e4fc3940fa4048f0903a04e946555de62d05c29491991f1118eab4f4a625e2` |
| `ignore-native-path` | `ebda7882c6e03b74d638507b43b9f7021bf2f9f2b68bd68195dc8a16c5174d78` |
| `turn-only-citation` | `ba286707f64050030b7097ed8a0c6f94dd0ab344fa5821dfb4d585a89dcd2bfb` |
| `manual-turn-only-citation` | `d87505cf8bf1a24b88682e3e5e35717f6977f46f71fad41f12c8fcf87f7e24e4` |
| `recording-old-raw` | `d546c02ffe65abe0301ac647d9582cc6d1d0e4dc18cc140c567fc4375f4ed2b2` |
| `compact-old-raw` | `bd39b8ba24ad41f043d2a1e0eec7fd4769163816807e50c6ec323a97111fad03` |
| `carry-old-raw` | `a41b30e899b958d0e0e7ab903c9bc07bb25e342b95f2541d07e3acc5d50ac086` |
| `last-result-only` | `0919482d639cec5b821647ad51c87e3db627ddc581a4238a3283529460e8b317` |
| `no-identity-reuse` | `6ded564b850ab9502c0242232a3e220ad841f70e0392aaf5121d2834ee4433ea` |
| `all-history-instead-of-ancestry` | `448ba1b74b3ed8dd3ddfb2650e83290dd3e28c2541fc87730c68d56b8fc6ce27` |
| `thinking-is-source` | `3f5305fdf4a1425fc3211d1e40b16c388dfe7c35a62720434c2aaeef318fae12` |
| `turn-head-only-fork` | `84a39efd1e6b44b40de6fa101e41326d75c0b418829dad05d0e194b01b2e2004` |
| `no-missing-history-receipt` | `011b9c679f8ef3e27a296d0baa56bb7186e346c7b42bb33843219ee596dcafba` |
| `no-attach-state` | `225441119dff3b2f5f95335a13aa5c68bec3c9c85620abd439fca61a05379d3e` |
| `old-line-only-excerpt` | `a507d4b61845fedf5f99d34a997e1840f931d42f3848d75687c15c0f09246774` |
| `no-combined-tool-cap` | `7d2d47845f6f37884b8e26e6af9b4cf51d38e08af4de979985295cd5ef6de8de` |
| `no-whole-entry-cap` | `a840ccbde299a2c96e5452497e178b908d36883e61fbbacc82d1ebc1a3212eba` |
| `old-full-tool-projection` | `3146a54a2b9b9e7e987c35dd8766b454ebefbb43149bdd9d349223e15d2bac72` |
| `whole-turn-source-index` | `4bf02e94a09bf991c86ee6fdddb343342d3c3bd27725dfda6f93ea04ef23acce` |
| `run-only-progress-listing` | `7b9e903ffd109703f1dfd942cd6d04a23aa24a0479649bbd90eece25fa0c6c72` |

After restoration, `npm test` passed all 384 tests. Typecheck and the fake-Pi smoke check also passed. Probe logs/diffs were collected under `/tmp/17a-probes`; this report contains the durable result, named failures and checked diff fingerprints.

## Production line delta

Against `de924e8`; blank lines/comments count. Runtime TypeScript and affected specification, glossary, README and prompt prose are included; tests, fixtures, snapshots and this report are excluded.

| File | Before | After | Added | Removed | Net |
|---|---:|---:|---:|---:|---:|
| `.scratch/v1/spec.md` | 203 | 248 | +63 | -18 | +45 |
| `CONTEXT.md` | 48 | 50 | +4 | -2 | +2 |
| `core/README.md` | 304 | 310 | +44 | -38 | +6 |
| `core/api/index.ts` | 258 | 278 | +23 | -3 | +20 |
| `core/api/read.ts` | 172 | 170 | +6 | -8 | -2 |
| `core/api/tools.ts` | 186 | 193 | +10 | -3 | +7 |
| `core/prompts/recording.md` | 92 | 92 | +3 | -3 | +0 |
| `core/recording/index.ts` | 128 | 135 | +18 | -11 | +7 |
| `core/render/index.ts` | 324 | 380 | +58 | -2 | +56 |
| `core/store/index.ts` | 1139 | 1214 | +108 | -33 | +75 |
| `hosts/pi/README.md` | 485 | 532 | +67 | -20 | +47 |
| `hosts/pi/index.ts` | 496 | 543 | +97 | -50 | +47 |

## Standards review

The independent reviewer found a thinking-only answered-trigger regression, stale core contract text, obsolete streaming buffers and an overly permissive fixture update. All were fixed; the reviewer rechecked the changes and the focused host/core tests and reported no remaining findings.

## Spec review

The independent reviewer reproduced three defects: duplicate sessions when reattaching imported native history, hidden original results after a shared-call fork, and manual sibling-only citations within one Turn. All were fixed with behavioral host tests. The recheck reported no additional confirmed blocker. The documented address-alias rule is explicit above; it does not expand a run's frozen entry membership.

## Acceptance self-check and remaining work

- [x] All 17a automated acceptance items implemented and mapped to evidence.
- [x] 366 existing tests retained; 384 total pass; typecheck, smoke and whitespace checks pass.
- [x] Every listed mutation made its named test red, then the exact bytes were restored and the final suite passed.
- [x] Estimator, model-facing tool protocol, provider-prefix construction, retry code, Integration runtime and dependency manifests preserved.
- [x] No production migration, closure/claims, native fork, AgentSession, staging or commit.
- [x] Specification, glossary, host/core contract and Recording prompt updated together.
- [ ] Live Pi/provider conversation was not run. The installed persistence implementation was inspected and the fake host reproduces its hook-before-persistence order; the parent's later live acceptance remains separate from this automated evidence.

Tickets 17b, 17c and 18 are intentionally unimplemented: no compressed-token trigger, bounded scheduler batching, lifecycle-trigger removal, closure or catch-up was added. An unrelated untracked `.scratch/v1/issues/19-native-pi-fork-runtime.md` appeared after the baseline and was left untouched.

The schema replaces writable Turn watermarks with immutable `source_entries`, selected native ancestry in `source_paths`, and exact successful membership in `recorded_entries`; original Turns/tool ordinals, facts, knowledge commits and deliveries retain their identities. The facade adds `SourceInput`/`SourceEntry`, `appendEntry`, `selectEntries`, `pendingEntries`, `renderEntry` and the view-version constant, exposes the existing store transaction for atomic host ingestion, accepts frozen entry ids in Recording tool context, and adds entry audit metadata to run responses; no model-facing tool name or protocol changes.
