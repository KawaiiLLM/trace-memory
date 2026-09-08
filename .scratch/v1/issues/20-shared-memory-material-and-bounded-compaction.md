# 20 — Shared memory material and bounded compaction

Label: ready-for-agent. Tracker: none configured; this file is the ticket.

Status: specified; held pending implementation authorization. Writing this ticket does not dispatch implementation. Reviewed baseline: `0a4429b`. Depends on the source/progress contracts of 17a–17c, enrollment and manual catchup of 18a–18b, and the native runtime of 19a–19c.

This ticket records the latest material-budget, compaction and core/host rulings. It supersedes the affected rules in the main specification, glossary and tickets 17b, 18b and 19b when implemented; those documents currently describe the earlier behavior. It does not rename Consolidator to Memorizer: that name was discussed, not adopted.

## Problem Statement

Noting can currently process 50,000 compressed Raw tokens in one run, while Raw and historical facts nominally share a 20,000-token episodic budget. Large Raw batches therefore exclude historical facts and exceed that nominal block budget. Compaction likewise retains all pending Raw even when extraction has repeatedly failed, so its replacement context can remain too large.

Consolidation starts at fifty facts, regardless of how much context those facts occupy, and has no corresponding 10,000-token batch boundary. A small number of large facts and many short facts impose different loads despite this count-based trigger.

The two worker phases already expose structured material, but Pi owns their domain-text layout while main-agent injection and compaction assemble related material in core. Titles, ordering and budget behavior can diverge. Putting the changing task range before unchanged knowledge also prevents that knowledge from extending a reusable request prefix.

After successful compaction, original entries may remain in native history without remaining in the foreground model context. A newly started Noter must not assume that a fork still carries pre-compaction evidence.

## Solution

Core owns a shared memory-material contract, selection and budgeting, and the final host-neutral domain text. Hosts place that text into their harness's native messages and invoke the native runner; they do not each reproduce a knowledge/facts/Raw layout. This explicitly revises 19b's ban on core-composed domain text, without restoring core-owned provider conversations or a custom model loop.

Use the following default hard estimated-token limits. The episodic limit is shared, not an independent allowance for every row:

| Material or phase | Default |
| --- | ---: |
| Knowledge block | 10,000 |
| Historical facts plus current task material | 20,000 |
| Compressed Raw within that shared block | 10,000 |
| Noting automatic trigger | 10,000 pending normal-view tokens |
| Noting batch | At most 10,000 normal-view tokens |
| Consolidation automatic trigger | 5,000 pending fact-view tokens |
| Consolidation batch | At most 10,000 fact-view tokens |

Fresh memory material is at most 30,000 estimated tokens by default. Fixed labels, separators, material reminders and omission receipts count toward their containing budgets. System instructions, tool definitions, output reserve, inherited native history and subsequent tool/review messages are additional context costs, not a promise that the whole provider request fits in 30,000 tokens.

For compaction, first try all pending normal Raw views within the Raw budget. If they do not fit, try a deterministic, more lossy secondary view that retains each entry's identity but removes tool arguments/results and truncates user/assistant text. If even that view cannot fit, decline the custom replacement and let Pi perform native compaction. Neither representation advances extraction progress.

## User Stories

1. As a user, I want a Noter batch bounded to 10,000 compressed Raw tokens, so that a large backlog does not produce a 50,000-token extraction task.
2. As a Noter, I want historical facts to have room beside the current Raw batch, so that I can avoid duplicating earlier notes.
3. As a user, I want knowledge and episodic material to have explicit hard budgets, so that a nominal limit is not silently exceeded.
4. As a user, I want unused Raw space available to historical facts, so that short tasks do not waste context capacity.
5. As a maintainer, I want one core material contract and rendering implementation, so that workers and main-agent memory do not evolve incompatible formats.
6. As a host author, I want prepared domain text without provider-specific message objects, so that I can connect it to a native harness without reproducing memory policy.
7. As a maintainer, I want complete and inherited-context material derived from the same frozen task, so that execution mode cannot change the writable evidence range.
8. As a user, I want unchanged knowledge before changing facts and task ranges, so that independent Noter runs have a potentially reusable knowledge prefix.
9. As a user, I want cache claims based on measured provider usage, so that a stable string is not presented as proof of a cache hit.
10. As a main agent, I want compact to retain a representation of every pending entry when it can fit, so that unfinished work is not silently replaced by only the latest entries.
11. As a main agent, I want a secondary compact view when ordinary excerpts are too large, so that moderate extraction delays do not immediately require model summarization.
12. As a main agent, I want secondary tool views to expose tool identity but not bulky arguments/results, so that I can locate evidence without carrying its full preview.
13. As a main agent, I want truncated user/assistant text and honest omission markers, so that compressed context is not mistaken for complete evidence.
14. As a user, I want native compaction when even minimal entry representations exceed the budget, so that repeated Noter failures do not make the session uncompactable.
15. As a user, I want native compaction failure handled normally by Pi, so that the plugin never substitutes an empty successful summary to hide failure.
16. As a user, I want original Raw and pending progress preserved through every compaction route, so that later extraction can still process what happened.
17. As a user, I want compact neither to start nor wait for Noting, so that memory extraction does not become a lifecycle flush.
18. As a user, I want a concurrent successful Noter commit to survive compact, so that rendering a context snapshot cannot undo business progress.
19. As a Noter, I want post-compaction admission to use subagent when my selected entries include pre-compaction sources, so that I actually receive the evidence I must process.
20. As a user, I want an already-running fork to finish against its frozen context, so that compaction does not cancel and replay work unnecessarily.
21. As a user, I want a cancelled or failed compaction not to create a false context boundary, so that execution mode follows persisted reality.
22. As a user, I want Consolidation triggered by fact tokens rather than fact count, so that admission reflects the actual material size.
23. As a Consolidator, I want all facts of my selected batch intact and historical facts separately labelled, so that context is not confused with work I must account for.
24. As a user, I want oversized indivisible input to remain pending with a capacity error, so that it is neither skipped nor falsely marked processed.
25. As a user, I want catchup to drain successive bounded batches in both phases, so that the new Consolidation limit does not leave part of my frozen target unprocessed.
26. As a user, I want stop to discard only the active drain's remaining execution plan, so that durable pending material remains available to the next invocation.
27. As a maintainer, I want the existing claims, lifecycle and atomic commits reused, so that budgeting introduces no second queue or scheduler.
28. As a user, I want omitted knowledge and facts discoverable by trace, so that a hard context limit is not deletion or a new evidence-visibility rule.

## Implementation Decisions

### Core and host ownership

- **Shared contract.** Evolve the existing material types rather than introduce a generic ContextBuilder or provider-strategy framework. Common parts are rendered knowledge, historical facts, compressed Raw entries with concrete source identity, and budget receipts. Pending Consolidation facts remain a separate task-specific part; so do the frozen range, source index, head reply and review cues.
- **Core selection.** Core owns scope/path eligibility, candidate selection, stable ordering, view construction, budgets, frozen entry/fact membership, knowledge commits, write tools, review content, validation and atomic progress. A common interface must share the implementation of rendering and budgeting, not merely duplicate field names around separate algorithms.
- **Core assembly.** Core also owns host-neutral material titles, block order, separators, domain instructions and feedback text. Main-agent initial injection, compact, Noting and Consolidation consume the same material components and rendering rules. Initial injection remains knowledge-only; sharing a type does not cause it to inject Raw or facts.
- **Host binding.** The host chooses how the prepared text is delivered through native system/user/custom messages or steering. It owns native checkpoint access, fork/subagent preparation, actual model and context capacity, provider audit hooks, usage, cancellation and log linkage. Harness-native facilities still own the model/tool/retry loop.
- **Inherited context.** Core exposes the full task material and the domain increment required when context is inherited, both from the same frozen task. The host selects the appropriate representation based on actual native context capability. Fork still preserves its inherited provider prefix; it does not append a second copy of all knowledge, facts and Raw. No Pi/CC message objects, provider bodies or SDK dependencies enter core.
- **Capacity negotiation.** The host reports remaining real context capacity after instructions, tools, output reserve and inherited history. When the domain ceiling is not enough, core reduces the oldest-first task set and re-freezes its write eligibility and audit membership together before execution. A host must not remove material while preserving the larger progress range.

### Material order and cache scope

The fresh task layouts place stable history before volatile task data:

| Consumer | Material order |
| --- | --- |
| Noter | Knowledge → historical facts → range → selected Raw → receipts |
| Consolidator | Knowledge → already-consolidated historical facts → range → selected pending facts → negation reminders → receipts |
| Main-agent initial injection | Knowledge → receipts |
| Main-agent compact | Knowledge → historical facts → pending Raw → receipts |

- **Stable prefix.** Keep task ranges, entry ids belonging only to the new batch, timestamps, run ids and omission counts out of the leading knowledge block. Identical selected knowledge and annotations render identically when only the task range or Raw changes. Existing historical-fact freshness order is not changed to improve caching.
- **No cache simulation.** Knowledge can be revised, archived or omitted under budget; facts can change membership as new facts arrive or task size changes. Repeated material is not automatically an append-only prefix. Noter and Consolidator have different instructions and are not treated as one shared cache chain.
- **Limited optimization.** This ticket changes domain assembly and ordering, not request identities, cache keys, transports, thinking levels or model selection. It neither retains a prior subagent conversation nor promises a provider cache hit. Existing fork-prefix checks, cache-miss suppression and Retry fork behavior remain intact.

### Shared material budgets

- **Measured view.** All domain limits use the existing local estimator over the exact rendered view, including metadata and separators. They are not exact provider tokenizer guarantees. Keep the independent real-context reserve and request-capacity checks.
- **Boundary accounting.** The 10,000-token current-material ceiling counts concatenated entry/fact views, including their own source labels, omission markers and joining separators. Outer section headings, the task range and block-level receipts consume the enclosing 20,000-token episodic budget. Do not make an otherwise valid single 10,000-token entry permanently unbatchable by charging its outer heading against the same inner allowance. Knowledge framing and its omission receipt consume the knowledge budget; count every emitted component exactly once in the combined material ceiling.
- **Knowledge hard cap.** Preserve the established category priority and deterministic within-category order, but remove the exemption that lets constraints, open items and disputes exceed the knowledge budget. Retain whole knowledge items within the cap; omitted items remain stored and traceable. Do not silently rewrite a knowledge claim to make it fit.
- **Budgeted receipts.** Reserve space for block labels and honest, bounded omission receipts. A large list of omitted addresses must not itself defeat the cap; use a bounded expansion instruction rather than unbounded enumeration. No omission advances knowledge lifecycle or processing progress.
- **Shared episodic space.** Reserve the selected current material and necessary cues/receipts first, then fill the remaining episodic space with historical facts in the existing freshness order. Raw consumes at most its own ceiling, not a guaranteed fixed allocation. Consolidation has no automatic Raw block: its selected pending facts take the current-material allowance instead.
- **Complete task evidence.** All selected current facts and normal Raw entry views must be supplied in fresh-context execution. If required reminders or other mandatory material prevent the combined block from fitting, reduce and re-freeze the task rather than drop selected evidence. An indivisible oldest unit that still cannot fit remains pending with a capacity error.
- **No deletion.** Budgets affect automatic context only. Explicit trace/search, original Raw, immutable facts/knowledge and evidence applicability retain their contracts. This ticket does not redesign branch-carry selection or truncate normal committed-result deliveries.

### Token admission and batch progress

- **Noting.** Set the default automatic trigger and batch ceiling to 10,000 normal compressed-view tokens. Select the oldest contiguous pending whole-entry prefix on the current path. Do not skip an entry merely to fill the remaining space with smaller later entries. A partly filled batch is valid.
- **Primary entry bound.** The existing primary renderer already returns an entry within its configured 10,000-token default, counting labels and omission markers, or throws if mandatory metadata cannot fit. It does not return an oversized successful view. Secondary compact compression is not needed to establish this per-entry bound and does not change the primary renderer's contract.
- **Consolidation.** Replace the fifty-fact trigger with 5,000 rendered tokens of applicable, unconsolidated committed facts. Select an oldest-first whole-fact prefix within 10,000 rendered tokens, with deterministic arrival order and the existing path-aware eligibility. Count the same fact representation, relations and separators for triggering and selection; historical facts and knowledge do not contribute to the trigger.
- **Oversized fact.** A fact has no guaranteed primary-entry-style size bound. If the oldest fact cannot fit by itself, report the capacity problem and leave it pending. Do not clip its evidence text, skip it for smaller later facts, or mark it consolidated without presenting it. A new fact-length restriction or semantic fact splitting is not part of this ticket.
- **Exact membership.** Selected source-entry ids and selected fact ids remain the units of progress. A displayed range is only a label, not an id watermark. Later entries, same-Turn siblings, late facts on older Turns and holes between fact ids do not become processed by implication.
- **Admission opportunities.** Ordinary eligible persisted entry completions still check both phase queues independently. Finishing a worker, compacting, restoring history, switching trees or shutting down starts neither phase. The trigger is not a requirement that a selected batch itself reaches the threshold.
- **Configuration.** Keep the existing Noting trigger and batch settings, changing the batch default to 10,000. Add token trigger/batch settings for Consolidation in the existing configuration namespace and retire the fact-count trigger with an explicit removed-key error; do not interpret an old fact count as tokens. Reuse one effective Raw ceiling for Noting and compact rather than introduce independently drifting copies. All new limits use the existing positive-safe-integer validation and read-only effective-settings presentation.

### Compaction escalation

1. **Freeze a read snapshot.** Reconcile available persisted sources without an extraction trigger and read committed progress. Select every pending original entry on the current path. Rendering must not change this pending set; a concurrently finishing worker may make the snapshot redundant but never incomplete through a speculative progress advance.
2. **Try normal views.** If all pending primary compressed views, joined with their separators, fit the Raw ceiling and the enclosing episodic framing fits its budget, use them. There is no second copy of the batch selector that silently retains only the next 10,000 tokens of work.
3. **Try secondary views.** Otherwise produce a deterministic, explicitly labelled compact-only view of all selected entries. Tool fragments retain tool name and the minimum source/occurrence identity needed for trace, not arguments/results. User and assistant text receive shorter bounded excerpts with omission markers. Preserve entry order, user boundaries and non-text placeholders. Use a versioned deterministic truncation rule, not a model call or an unbounded summarization loop.
4. **Recheck the whole block.** Count all identities, labels, retained tool names, excerpts and omission markers under the same inner/outer accounting as normal material. Many tiny entries or one entry with excessive mandatory metadata can exceed the cap even after secondary compression. Do not hide selected entries, falsify omission counts or relax the cap to force success.
5. **Delegate if necessary.** If no complete secondary representation fits, return an explicit core result that asks for native compaction, with a reason. Pi declines to supply a custom replacement summary and proceeds through its normal compaction path. Do not return an empty success, append an oversized plugin block to the native result, or implement another summarizer inside core.

- **Bounded effort.** Secondary rendering is deterministic local work. It may fail capacity and delegate; it need not guarantee fitting an arbitrarily large backlog. Impossible primary-view metadata capacity is an escalation case for compact, not permission for Noting to mark that entry processed. Missing/corrupt source history is still reported honestly, not disguised as ordinary truncation.
- **Native failure.** Native compaction may make a foreground model call and may fail or be cancelled. Let Pi retain its normal outcome handling; do not manufacture a successful summary or start an extraction flush. The previous unconditional “compaction never calls a model” rule is superseded only by this native fallback.
- **Progress and evidence.** Original Raw remains untouched and traceable; normal Noter input and token counters continue to use primary views. Neither secondary views nor native/plugin summaries become new source entries, adoption facts or processing receipts. Native compaction cannot reconstruct evidence missing from stored history.
- **Race safety.** Do not wait for or cancel an already-running Noter solely for compact. Preserve a business commit that wins concurrently. A view may include Raw that is committed just afterward; duplication is acceptable. Do not confirm memory deliveries or initial injection merely because an unused custom summary was prepared before native fallback.
- **Failure visibility.** Report whether compact used normal views, secondary views or native delegation, including its reason, through existing diagnostics. Do not introduce a new queue, persistent compression service or progress state machine.

### Post-compaction worker mode

- **Persisted boundary.** A successfully persisted native compaction on the target's selected ancestry establishes the boundary, whether its summary came from Trace Memory or Pi. A request to compact, a failed/cancelled attempt, or a boundary on a sibling path does not.
- **Admission rule.** After that boundary, a Noter that has not started native execution and whose frozen entry set includes any original entry before the boundary must run as subagent for the entire selected batch. This also applies to a task prepared before compact but still waiting for a slot, claim or native readiness. Recheck at actual launch.
- **Existing workers.** A fork already running against its independent frozen context is not restarted, replayed or cancelled just because the foreground compacted. Its normal claim and commit fences remain effective.
- **Scope and persistence.** Determine the boundary through native ancestry/checkpoints, not wall-clock comparisons, the database's highest entry id or a transient current-context flag. Restore the same behavior after reopen and tree navigation. Entries still present in the native log, or coincidentally retained by Pi after compact, do not waive the pre-compaction subagent rule.
- **No permanent downgrade.** This is a per-task evidence-readiness decision, not the cache-miss latch. Preserve configured/requested mode, record actual subagent mode and a pre-compaction-evidence reason, and use existing explicit-subagent/fallback model-selection rules. Do not change enrollment, configuration or cache suppression. Tasks containing only post-compaction entries may use normal configured/effective mode once existing readiness checks pass.

### Catchup and stop continuity

- **Finite target retained.** Manual catchup still freezes pending entry membership through its boundary and the explicit pending fact set, adding only facts produced by its selected Noting batches. Repeating catchup never extends that target.
- **Both phases batch.** Drain successive bounded Noting batches first, then successive bounded Consolidation batches until the frozen target is exhausted. This supersedes the earlier one-Consolidation-call wording. Both phases always use subagent and ignore triggers, not batch or real-context limits.
- **Same scheduler.** Keep the existing host-local finite drain controller, executor phase slots and target claims. Ordinary and borrowed jobs also obey the new batch ceilings; closed-session compensation retains its nonempty-queue admission exception and does not become a completion-chained drain.
- **Stop is not deletion.** Stop immediately disables continuation and fences/cancels this executor's uncommitted workers through the existing bounded cancellation path. It discards the invocation's remaining execution plan, not durable pending entries/facts, committed results or another executor's claims. No prebuilt persistent batch queue is required.

## Testing Decisions

Use the existing fake Pi host, public TraceMemory facade and temporary real SQLite database as the primary seam. Reuse native fixture coverage for successful/failed compaction events, fork readiness and task execution. Do not add another concurrency harness; extend an existing claim/race check only where this ticket changes an observable boundary.

Acceptance must cover:

1. **Shared domain assembly.** A host stub with no Pi/CC message types receives core-prepared material and can execute the existing note/memory protocol. Initial injection, compact and both task phases use shared component rendering; no host duplicates the domain block layout.
2. **Prefix ordering.** Two separately prepared Noter tasks with identical knowledge but different Raw/ranges have identical text through the knowledge block. Verify facts precede the range, receipts follow dynamic material, and Consolidation uses the corresponding order. This is a byte-layout test, not a provider-cache-hit test.
3. **Budget boundaries.** Exercise exactly-at and one-over limits with labels, separators and receipts included. Normal custom material stays within the configured knowledge/episodic/Raw caps. Metadata and omission receipts cannot silently overflow a cap.
4. **Knowledge priority.** More than 10,000 tokens of high-priority knowledge no longer bypass the cap. Retained items are whole and deterministic; omitted items remain readable and their omission is visible. Empty and single-oversized-item cases remain bounded.
5. **Noting trigger and batch.** At 9,999 pending primary-view tokens, no automatic Noting starts; at 10,000 it is eligible. A backlog above 10,000 selects only the oldest fitting whole-entry prefix, leaves the rest pending, and does not chain on completion. Include a small oldest entry followed by a near-10,000-token entry.
6. **Consolidation tokens, not counts.** Many short facts below 5,000 tokens wait; fewer long facts reaching 5,000 trigger. Test 4,999/5,000 and the 10,000 batch cap using the same rendered fact representation, including annotations and separators.
7. **Consolidation progress.** Several token-bounded batches process exact membership without a Turn-completion gate, fact-id watermark or cross-branch leakage. Facts arriving later on earlier Turns stay eligible. A rejected, failed or cancelled batch advances nothing; a committed batch survives later provider/audit failure.
8. **Oversized indivisible input.** An oldest fact that exceeds the cap stays pending with a useful error and is not bypassed. A primary entry with impossible metadata capacity is not returned as an oversized success; Noting stays pending and compact can escalate.
9. **Normal compact.** All pending normal views fit within the Raw cap. The result contains them, historical facts use the remaining shared capacity, and compact starts no memory worker and changes no progress.
10. **Secondary compact.** Normal views exceed the Raw cap but secondary views fit. Every selected entry remains represented; tool arguments/results are absent, names and trace identity remain, user/assistant truncation is marked, and original full trace output is unchanged.
11. **Native fallback.** Enough entries make even secondary metadata exceed the cap. No custom replacement is returned; Pi's native path is allowed to run. Failure and cancellation do not create a success boundary, erase pending sources or confirm unseen deliveries.
12. **Compaction race.** Hold a Noter open while preparing compact, then release its commit before or after the snapshot. Compact does not wait or launch another task; committed data survives and any duplicate Raw is harmless. Summaries never re-enter the source queue.
13. **Post-compaction mode.** After successful custom and native compaction, a new task containing pre-boundary entries uses subagent with full selected primary material and a recorded reason. A mixed pre/post batch also uses subagent. Repeat with a task prepared but not launched, reopen, and a sibling compaction that must not affect this path.
14. **Already-running fork.** A started native fork keeps its frozen context across foreground compaction without replay. A post-only task can later use normal mode, while cache suppression and requested/actual audit semantics remain unchanged.
15. **Capacity negotiation.** A smaller host window causes core to reduce and re-freeze the task before execution. Supplied evidence, entry/fact audit membership and writable sources match. Knowledge/mandatory context that cannot fit produces a capacity failure rather than an oversized send.
16. **Finite catchup.** Freeze more than one batch of both phases, with a final below-trigger tail. Drain Noting then Consolidation in subagent, excluding later entries and unrelated fact writes. Stop during either phase or between batches: no continuation, committed work retained, remaining target still pending for a new invocation.
17. **Configuration and regression.** New token settings obey existing validation/precedence and are shown read-only; the removed fact-count key errors by name. Enrollment, explicit reads, settled delivery confirmation, automatic no-chaining, borrowed-task limits and existing five-second cancellation remain unchanged.

A native Pi acceptance check must confirm that declining the custom summary actually reaches Pi's normal compaction path and that only successful persisted compaction establishes the execution boundary. A fake event alone does not prove these runtime facts. No paid cache probe is required for this ticket.

## Out of Scope

- Renaming Noter, Consolidator, phase names, persisted runs or configuration to Memorizer or another discussed alternative.
- Cross-run cache keys, shared transport identities, connection pooling, provider cache guarantees or a new live benchmark suite.
- Independent per-phase thinking-strength settings or changes to existing model selection.
- Building a Claude Code adapter; the host-neutral contract must remain usable by one later.
- Core-owned model message sequences, provider payloads, a custom agent loop or another runtime fallback.
- Model-driven secondary compression inside core, deleting Raw, summarizing facts for write eligibility, or counting compact summaries as extraction.
- A separate scheduler, persistent batch queue, continuous catchup mode or extraction triggered by compact/shutdown/tree navigation.
- Redesigning explicit trace previews, source provenance, branch carry, immutable knowledge commits or normal result-delivery selection.

## Further Notes

**Superseded rules.** The affected older contracts are: Noting's 50,000-token batch; Consolidation's fifty-fact trigger and unbounded/one-call batch; the knowledge-category soft-cap exemption; compact keeping all pending Raw regardless of size and never calling a model; and 19b assigning host-neutral text layout to the adapter. Update the main specification, glossary, prompts where applicable, effective configuration documentation and acceptance tests alongside implementation. Do not rewrite historical run records or completed ticket reports to imply these rules already existed.

**Implementation starting points.** The current domain layout is in `hosts/pi/compose.ts`; the primary entry and block budget helpers are in `core/render/index.ts`; material types and selection are in `core/noting/index.ts` and `core/consolidation/index.ts`; initial injection and compact are in `core/api/read.ts`. Move the host-neutral layout into the existing core rendering/material surface, reuse the existing facade, and leave native message binding and SDK execution in the host. The native compaction hooks and manual drain currently live in `hosts/pi/index.ts`.

**Sequence.** Start with shared domain assembly and stable material ordering. Then apply the new hard budgets, token-based Consolidation batches, compact escalation and pre-compaction admission rule with their checks. Do not mix cache-identity experiments into either step. Smaller batches can increase call count and repeated instruction cost; stable knowledge ordering is an opportunity for future caching, not a measured savings claim.

**Secondary-view tuning.** The secondary excerpt lengths must be deterministic, documented with their view version and exercised by the budget/fallback tests. This discussion did not select a numeric per-message secondary cap; do not present an arbitrary tuning value as a user ruling. There is no requirement for a new user-facing tuning layer or for secondary compression to fit every backlog.

No external issue was published. This local ticket is the specification artifact, not evidence of implemented behavior or a successful provider-cache experiment.
