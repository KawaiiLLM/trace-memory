# 17 — Entry Recording and closed-session catch-up

Label: ready-for-agent. Tracker: none configured; this file is the ticket.

Status: specified, not implemented. Baseline: `2ff66be`.

## Problem Statement

A user Turn can contain many tool calls and grow far beyond a reasonable Recording input. Whole-file reads, documentation and diffs dominate the Raw, although only a small part becomes useful memory. Turn-sized progress makes a large Turn expensive to process and prevents progress within it.

The current triggers also leave short tails behind: a session may close below the Recording or Integration threshold. Extracting everything during compaction or shutdown adds latency and lifecycle complexity. Users need bounded foreground-triggered work and eventual opportunities to process closed-session tails without delaying compaction or exit.

## Solution

Use completed Pi session entries as Recording work units while retaining their owning Turn as the public source address. Render one deterministic compressed Raw view everywhere the plugin automatically supplies Raw. Preserve the original source for explicit trace reads.

An entry completion checks the active session's queues and gives closed sessions one bounded catch-up opportunity. Compaction and shutdown launch no extraction. Work proceeds oldest-first without waiting for a complete Turn, and successful commits advance only the progress actually processed.

The defaults separate view limits, trigger thresholds and batch size:

| Setting | Default | Meaning |
| --- | ---: | --- |
| Tool-call view limit | 1,000 tokens | Combined arguments and result, before the entry limit |
| Entry view limit | 10,000 tokens | Complete rendered entry, including source labels and omission markers |
| Recording count trigger | 10 entries | Pending eligible completed entries |
| Recording size trigger | 10,000 tokens | Pending compressed entry views, not original Raw size |
| Recording batch limit | 50,000 tokens | Oldest pending compressed entry views supplied as new material |
| Integration trigger | 50 facts | Committed facts not yet integrated on the target path |

Token counts use the existing shared estimator. In this ticket, 1k, 10k and 50k mean the decimal values above, not binary multiples. The batch limit is separate from the model's total context budget.

## User Stories

1. As a user, I want large tool results represented compactly, so that source material does not overwhelm useful memory.
2. As a user, I want original tool arguments and results retained, so that I can inspect evidence omitted from the automatic view.
3. As a user, I want every excerpt to advertise omissions, so that I do not mistake a preview for complete evidence.
4. As a user, I want the same Raw view in Recording and compaction, so that memory behavior does not depend on which path supplied the source.
5. As a user, I want large user and assistant entries bounded too, so that one pasted document cannot exhaust the extraction budget.
6. As a user, I want familiar Turn addresses retained, so that existing citations remain understandable.
7. As a user, I want multiple assistant entries within a Turn distinguishable internally, so that their sources are not overwritten or conflated.
8. As a user, I want Recording to progress through a long Turn, so that it does not have to wait for the whole task to finish.
9. As a user, I want unfinished streaming messages excluded, so that extraction never runs against changing text.
10. As a user, I want plugin-injected memory excluded from source queues, so that memory does not recursively manufacture evidence.
11. As a user, I want ten small entries to trigger Recording, so that short exchanges are not delayed by a token-only threshold.
12. As a user, I want ten thousand compressed-view tokens to trigger Recording, so that a few substantial entries can be processed promptly.
13. As a user, I want thresholds measured after truncation, so that oversized file reads do not cause unnecessary runs.
14. As a user, I want each Recording batch bounded independently of its trigger, so that launching a run does not imply processing the entire backlog.
15. As a user, I want entries processed oldest-first, so that later activity does not starve earlier material.
16. As a user, I want excess entries left pending, so that a batch limit never silently marks unseen material processed.
17. As a user, I want new facts eligible for Integration as soon as their Recording commits, so that an unfinished Turn does not block useful knowledge.
18. As a user, I want ordinary Integration triggered at fifty new facts, so that small active-session changes do not each incur a separate run.
19. As a user, I want compaction to use the already-available compressed Raw view without launching extraction, so that compaction is not gated on a model call.
20. As a user, I want shutdown to preserve outstanding work without starting extraction, so that closing a session does not require a new background conversation.
21. As a user, I want activity in another session to notice closed-session tails, so that below-threshold work gets another processing opportunity.
22. As a user, I want closed-session catch-up to bypass ordinary queue thresholds, so that one remaining entry or fact can be processed.
23. As a user, I want catch-up to use subagent mode, so that it does not need a closed conversation's captured provider prefix.
24. As a user, I want catch-up to retain the target session's identity and branch, so that another session does not inherit its evidence or deliveries.
25. As a user, I want at most one Recorder and one Integrator per session, so that repeated events and multiple Pi processes cannot duplicate work.
26. As a user, I want independent Recording and Integration allowed to overlap, so that one phase need not idle while the other runs.
27. As a user, I want a reopened or externally active session protected from catch-up, so that a background worker does not mistake it for abandoned work.
28. As a user, I want failures to leave work pending and successful commits to survive later provider errors, so that retries do not lose or duplicate facts.
29. As a user, I want forked paths to inherit only applicable progress, so that shared entries are not rerecorded and sibling entries are not consumed.
30. As a user, I want existing facts, knowledge and completed work preserved during migration, so that this change does not restart my memory history.
31. As a user, I want audit records to identify the actual entry batch and truncation, so that I can tell what a Recorder saw.
32. As a user, I want catch-up to stop after one batch per phase per opportunity, so that another session's backlog does not become an unbounded drain loop.

## Implementation Decisions

### Shared compressed Raw view

- **One renderer.** Reuse the existing rendering and token-estimation layer. Automatic Recording material, subagent fallback material, compaction Raw, and branch-carry Raw use the same entry view. Existing outer budgets may omit whole views with receipts; they must not reconstruct an unbounded alternative Raw representation.
- **Two limits.** Apply the tool-call limit first, then the entry limit. A tool call means its name, arguments and associated result, not a quota per tool type. Multiple calls in one assistant entry do not bypass the entry limit. User and assistant natural-language content are not subject to the tool-call limit, but are subject to the entry limit.
- **Stable fragments.** Arguments and results may belong to different entries. Budget their portions deterministically so that arrival of a result cannot retroactively alter an already-processed entry view. Do not delay every assistant entry until its complete tool cycle ends.
- **Explicit excerpts.** Retain useful head and tail content with omission markers. Preserve source addresses, tool identities and available execution status. Count these labels and markers inside the applicable budget. Handle an oversized single line or JSON value without exceeding the limit or discarding the entire useful excerpt.
- **Original evidence.** Store the Raw actually received from Pi unchanged. Explicit trace reads may retrieve the original, subject to the existing read interface and pagination rules. Tool-side omissions and non-text material remain labelled; the plugin cannot recover bytes it never received. Processing an excerpt is not a claim that its omitted middle was inspected.
- **Branch compatibility.** Do not rewrite a captured native provider prefix to compress its history. The shared view governs Raw the plugin adds. Existing exact-prefix verification and fallback behavior remain; an oversized inherited prefix must not be described as covered by the 50k new-material limit.

### Entry identity and Recording progress

- **Source units.** An eligible entry is a completed source message from the user's conversation: user text, assistant content/tool calls, or tool results. Exclude thinking-only or otherwise empty source views, plugin injections, plugin state entries, compaction summaries, and background worker messages. None of these excluded items contributes to the count trigger.
- **Persistence boundary.** Map completed messages to stable Pi entry identities after persistence. A completion notification alone is not permission to invent an entry ID or save progress ahead of the source. Reconcile from persisted ancestry at the next safe host boundary if needed.
- **Turn compatibility.** Keep existing Turn identities and source-address meanings. Persist each entry's owning Turn and enough source-occurrence information to distinguish repeated assistant messages and tool calls within that Turn. Tool ordinals must remain stable across chunking, reopen and fork.
- **Durable progress.** Recording tracks processed entries on a path, rather than treating a partly processed Turn as wholly recorded. Reuse existing storage and progress mechanisms where possible; queue membership should be derived from durable source and processing state, not duplicated into a second delivery protocol.
- **Frozen evidence.** A run freezes its exact source-entry set. Entry arrivals after launch remain pending. Citation validation must not admit a later entry merely because it shares a Turn with an allowed source. Reads remain unrestricted under the existing read contract; write eligibility remains constrained.
- **Startup and migration.** Reconcile the selected native ancestry, including earlier history available when memory attaches. Translate previously successful Recording coverage into entry coverage where the correspondence is provable. Preserve existing facts and knowledge; do not globally reset progress or silently mark unknown history processed. Missing native history is surfaced rather than invented.

### Trigger and batch selection

- **Normal checks.** Each eligible entry completion checks the active session's Recording and Integration queues. Recording launches when pending count is at least ten OR pending view size is at least 10,000 tokens. Integration launches when at least fifty applicable committed facts remain unintegrated.
- **Bounded Recording.** Select the oldest contiguous pending entries whose rendered views fit 50,000 tokens, including separators. Do not stop at a Turn boundary or require a Turn to be complete. Freeze only selected entries; remaining entries wait for another completion-triggered check.
- **Actual context capacity.** Reserve space for instructions, knowledge, tool definitions, output and existing model context. The effective input budget may be lower than 50,000 tokens. If even the oldest entry cannot fit safely, leave it pending and report the capacity problem rather than exceeding the model limit or skipping it.
- **Immediate fact eligibility.** Remove the requirement that a whole source Turn be recorded before its committed facts can enter Integration. Keep path-aware per-fact accounting; do not restore a maximum-fact-ID cursor, which can skip late facts from earlier Turns.
- **No Turn batching for Integration.** Select eligible facts without grouping or waiting by complete Turn. The fifty-fact trigger is not a promise to process exactly fifty facts or permission to mix branch paths. This ticket does not introduce lossy truncation of atomic fact content.
- **No completion chaining.** Finishing a worker does not itself start another batch. A fresh eligible entry completion provides the next ordinary or catch-up opportunity. Existing provider-call retries within a run remain supported.

### Lifecycle and catch-up

The lifecycle actions are deliberately asymmetric:

| Event or target | Recording | Integration |
| --- | --- | --- |
| Active source entry completes | One batch if its normal threshold is met | One run if its normal threshold is met |
| Compaction | No new run | No new run |
| Session shutdown | No new run | No new run |
| Closed session considered on another session's entry completion | One batch if nonempty, regardless of threshold | One run if nonempty, regardless of threshold |

- **No hidden flush.** Remove extraction launched solely to prepare a tree-switch summary or lifecycle flush. Summaries and compaction use committed memory plus the shared pending Raw view. Existing in-flight tasks may settle under the current bounded shutdown policy; preserving them is not a new extraction trigger.
- **Independent tail checks.** A closed session with no Recording backlog but one unintegrated fact is eligible for Integration catch-up. If a Recording run produces facts after the check has frozen its candidates, those facts wait for the next eligible entry completion. Do not add a same-event drain chain.
- **Target identity.** Catch-up runs against the closed session's project, branch and frozen source path, never the active session's evidence context. Select and freeze one branch queue per task; shared-session sibling branches are not combined into one range. Selection must not indefinitely starve another eligible branch.
- **Subagent execution.** Force subagent mode for both catch-up phases. Use the existing worker loop, four tools, two-submission Integration review, retries and exact-request audit. Resolve a usable model in the active host while retaining target-session identity. If unavailable, leave the queue pending and surface the problem.
- **Closure ownership.** Persist enough lifecycle information to distinguish an inactive session from one open in another Pi process. Session shutdown marks closure; abrupt owner death must be recoverable without classifying a merely idle live owner as closed. A memory session is not eligible while any live host owns that shared session identity.
- **Reopen race.** Reopening a session prevents new catch-up claims. An already-running task remains governed by its frozen identity and exclusive claim; do not launch a competing foreground task of the same phase or redirect its commit to the newly selected branch.
- **Session-wide exclusion.** Across all branches and Pi processes sharing the database, a target memory session has at most one Recorder and one Integrator at a time. The phases may overlap. Admission must be atomic and shared; an in-memory map alone is insufficient. Never hold a database transaction across a network call. Recover abandoned claims without allowing a stale owner to commit after ownership was reassigned.

### Existing contracts and integration work

- **Atomic success.** Commit facts, entry progress, run records and applicable deliveries atomically. Integration commits knowledge and its exact processed-fact membership atomically. A successful zero-fact Recording still advances the selected entries; rejection, cancellation and precommit failure do not.
- **Postcommit behavior.** Business success remains success after a provider or audit-update problem. Preserve accumulated reported usage and retry diagnostics. Unreported provider usage must not be fabricated.
- **Delivery separation.** Entry progress is not delivery confirmation. Preserve settled-only confirmation and current mode-dependent backfill policy. Catch-up results belong to their target session and do not become source entries in the active session.
- **Audit detail.** Run records identify the selected entries, owning Turns, frozen branch, view-budget version and omission information, in addition to the existing request, response, usage and tool sequence. No per-run JSON export system is required.
- **Affected modules.** Update the core rendering, source storage, Recording, Integration and façade contracts, and the Pi host's source ingestion and lifecycle scheduling. Keep the core host-neutral by passing source identities and content through the façade instead of importing the Pi SDK into core.
- **Configuration.** Replace the answered-Turn trigger with the entry-count trigger; change the Recording size trigger to compressed-view tokens. Keep the three view/batch limits and thresholds in the existing configuration system, with validation. Document obsolete configuration behavior rather than silently interpreting an old Turn count as an entry count.
- **Documentation.** Update the glossary's Recording timing, the main specification, host documentation and model prompts together. Existing address formats and knowledge commit semantics remain authoritative unless explicitly changed above.

## Testing Decisions

**Primary proposed seam:** use the existing fake Pi host together with the public TraceMemory façade and a real temporary SQLite database. Drive source-message completion, persisted tree ancestry, lifecycle events and model replies; inspect emitted requests, readable Raw, run records, facts, knowledge and subsequent queue behavior. Extend this seam rather than introducing a second scheduler-only test framework. The user should confirm this seam choice before implementation.

Good tests assert what was sent, persisted, retried or left pending. They should not lock down table layouts, private helper names or the exact implementation of task claims. Existing host lifecycle tests, exact-request branch tests, façade ruling tests and process-death transaction probes provide the prior art.

The acceptance scenarios are:

1. **View bounds and fidelity.** Cover ordinary text, CJK, one huge line, a huge JSON argument, multiple tool calls in one assistant entry, and late-arriving tool results. Verify both limits with the shared estimator, stable source labels, omission markers and original trace readability.
2. **Shared view.** Compare the same entry's compressed representation in Recording, fallback, compaction and branch carry. Assert that compact and tree-summary preparation make no new provider calls.
3. **Entry-count boundary.** Nine short pending entries do not trigger; the tenth does. Excluded metadata, injected memory, thinking-only entries and partial streaming updates cannot reach the threshold.
4. **Token boundary.** Fewer than ten entries trigger at 10,000 compressed-view tokens, not at 10,000 original tokens. Test just below and exactly at the boundary.
5. **Batch boundary.** Supply more than 50,000 tokens of eligible views. Verify that the run sees an oldest-first whole-entry prefix within the limit and that the next event sees the remainder. Include one Turn spanning several batches and a batch spanning several Turns.
6. **Entry-address boundary.** Freeze a run midway through a Turn, then append another assistant entry and tool result. The earlier batch must neither consume nor cite the later entries; existing Turn and tool addresses still resolve after reopen.
7. **Integration boundary.** Forty-nine active-session facts do not trigger; fifty do. Committed facts from a partly recorded Turn are eligible. Include non-monotonic Turn/fact creation order and verify that no fact is skipped or reintegrated solely because of its ID.
8. **Lifecycle behavior.** Compaction and session shutdown launch neither phase and preserve pending work. A running task may settle without an additional flush being launched.
9. **Closed tails.** Another session's entry completion triggers one subagent Recording batch for a one-entry tail and one subagent Integration run for a one-fact tail. An empty Recording queue must not hide a nonempty Integration queue. Larger tails require subsequent events.
10. **Isolation and reopening.** Catch-up preserves target-session attribution, branch eligibility, cost attribution and delivery destination. Reopen during selection and during execution; ensure no new conflicting catch-up or foreground task is admitted.
11. **Failures and retries.** Failed work stays pending; empty successful Recording advances only its selected entries. Verify no duplicated source suffix on provider retry, no duplicated write after commit, and persisted usage/retry diagnostics.
12. **Migration and forks.** Reopen an existing database with successful Turn-based coverage. Preserve facts and applicable progress, inherit shared source entries, and keep sibling evidence out of the frozen range.

**One additional seam is necessary:** a small two-process façade/host integration check against one temporary database. Race claims for the same target, kill an owner, and attempt stale completion after recovery. Assert the externally visible at-most-one-writer contract for each phase, including two branches sharing one memory session. Fake-host tests in one process cannot prove this property.

For the highest-risk regressions, retain revert probes: replacing entry coverage with whole-Turn advancement, measuring original instead of compressed tokens, removing shared admission, or restoring a lifecycle flush must make the corresponding test fail. No network provider is required for these checks; a later live acceptance run verifies real Pi persistence boundaries and cancellation.

## Out of Scope

- Replacing the worker runtime with AgentSession or changing the native-prefix contract.
- A new session enrollment UI or changing current mode-dependent memory injection/backfill policy.
- Continuous draining, background timers that independently trigger extraction, or guaranteed progress while no session produces eligible entries.
- Automatic extraction during compaction, shutdown or tree switching.
- Waiting for a full user Turn before Recording or Integration.
- Recursively summarizing every omitted tool-result region or claiming lossless extraction from excerpts.
- A separate model-based tool-output summarizer or per-tool-type budget configuration.
- Replacing per-fact Integration accounting with a fact-ID watermark.
- Changing the knowledge DAG, scope/evidence matrix, relation semantics or the two-submission Integration protocol.
- A new footer design, run-log export mechanism or cross-machine task scheduler.

## Further Notes

This ticket synthesizes the final four-part user ruling from 2026-09-07. It supersedes earlier proposals to wait for complete Turns, drain on compaction/shutdown, or continuously drain a closed session in one opportunity. It also supersedes the old deferral of closed-session proxy Integration and the process-local, per-branch-only exclusion rule for this feature.

The supporting log sample was one active coding conversation, not a general benchmark. It contained hundreds of source entries, with tool results accounting for roughly 85% of the measured view material. Capping tool results at about 1k cut the estimated input substantially, but recall quality has not been measured. Acceptance must therefore verify honest omission markers and successful explicit evidence retrieval, not assert that truncation is lossless.

The proposed test seam remains the only confirmation requested: existing fake host plus façade for behavior, and one two-process check for shared ownership. No external issue was published because this repository has neither a configured issue tracker nor a Git remote; the local ticket carries the ready-for-agent label under the existing repository convention.
