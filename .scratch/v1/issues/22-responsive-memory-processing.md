# 22 — Responsive memory processing

Label: ready-for-agent. Tracker: local issue files; this file is the ticket.

Baseline reviewed: `bdb9968` (`0.1.0-beta.2`). The user confirmed the testing seams: the existing fake Pi host, the Core façade, and the installed-package smoke using native Pi with simulated HTTP. This specification does not authorize implementation dispatch, publication, or changing live enrollment.

## Problem Statement

Trace Memory can block Pi's main thread long enough to make the terminal appear frozen. Enabling memory on an existing conversation produced about 22 seconds of unresponsiveness. Ordinary message and tool boundaries then caused intermittent pauses of roughly two seconds, without any model request being responsible for the delay.

Further inspection found that the cost grows with both history and fact count. A status-bar count can rebuild the selected conversation path once per fact. On a database copy with 1,892 source entries and 126 facts, that count took 7.4 seconds; querying pending Consolidation facts took 11 seconds. The same expensive footer work still runs after `/trace disable`, so pausing memory processing does not reliably restore responsiveness.

Explicit reads also perform work the caller did not request: one full tool trace repeatedly loads the whole session, while a one-result knowledge search formats every match and repeatedly resolves the entire knowledge DAG before returning its first page. Task preparation and spend accounting contain smaller instances of the same problem.

The user needs a responsive coding interface without losing Raw, attribution, historical traceability, correct budgets, or reliable memory progress. Functional tests passing and native workers completing do not establish that the foreground remains usable.

## Solution

Make memory work proportional to the evidence and output actually needed, while preserving existing behavior. Remove repeated whole-history scans, reuse immutable source views and read-scoped applicability calculations, narrow source queries, and paginate before expensive display preparation.

Cover seven measured hotspot families:

1. Historical source reconciliation when enabling or recovering a session.
2. Ordinary reconciliation and pending-material token accounting at completed-entry boundaries.
3. Repeated path applicability work in fact selection, Consolidation, branch carry, and footer counts, including disabled sessions.
4. Whole-session rereads during a full trace of one tool occurrence.
5. Eager knowledge-search formatting and repeated current-tip resolution before pagination.
6. Repeated material refreezing when mandatory costs already exceed model capacity.
7. Loading complete run audit bodies merely to aggregate usage and spend.

Prefer removing redundant work and narrowing reads before adding scheduling machinery. If a remaining operation cannot meet the responsiveness budget, bound its uninterrupted work without changing the evidence boundary, allowing partial commits to masquerade as completion, or keeping a database write transaction open while yielding.

## User Stories

1. As a Pi user, I want to enable memory on a long existing conversation without freezing the terminal, so that I can continue using my coding interface.
2. As a Pi user, I want all available eligible history to remain recoverable when I enable memory, so that responsiveness is not achieved by silently discarding earlier messages.
3. As a Pi user, I want a short new message to incur work for its new evidence rather than repeatedly processing the whole conversation, so that long sessions remain usable.
4. As a Pi user, I want streaming updates with no new persisted source entry to remain cheap, so that text arrives smoothly.
5. As a Pi user, I want tool-result handling to find the correct tool call efficiently, so that reading a file does not cause a multi-second terminal pause.
6. As a Pi user, I want a reply's completion and settlement callbacks to remain responsive, so that the terminal does not freeze after the model finishes.
7. As a Pi user, I want the memory footer to refresh cheaply, so that status information does not become the source of interface stalls.
8. As a Pi user, I want disabling memory to stop expensive automatic history processing, so that pausing the extension's work actually reduces its foreground cost.
9. As a Pi user, I want disabled status to remain truthful, so that an optimization does not display stale counters as current measurements.
10. As a Pi user, I want stored memory to survive disabling and re-enabling, so that a performance workaround does not destroy my data.
11. As a Pi user, I want repeated enable commands to reuse already reconciled sources, so that retrying a command does not duplicate history or repeat the original import cost.
12. As a Pi user, I want restoring a session to preserve its enrollment and project declaration, so that performance changes do not alter which conversations participate in memory.
13. As a user navigating the conversation tree, I want branch carry to be prepared without repeatedly scanning history for every fact, so that switching branches remains practical.
14. As a user navigating the conversation tree, I want source occurrences within the same Turn to remain distinct, so that a sibling branch's evidence does not become applicable merely because its address or text looks similar.
15. As a user with multiple sessions, I want each session and branch to receive only its applicable automatic material, so that reused calculations do not mix their knowledge or progress.
16. As a user with multiple executors, I want another executor's commits and enrollment changes to become visible correctly, so that a faster read does not reuse obsolete state.
17. As a user of Noting, I want the oldest whole-entry batch to remain selected under the existing token limits, so that speed does not change what the Noter is allowed to extract.
18. As a user of Noting, I want source labels, omission receipts, and original Raw to remain intact, so that compressed views stay traceable.
19. As a user of Noting, I want source identity checks to remain effective, so that a changed persisted message is not silently accepted as the same immutable source.
20. As a user of Consolidation, I want pending-fact selection to reuse one applicable-path calculation, so that growing fact counts do not multiply full-history reads.
21. As a user of Consolidation, I want strong and weak relations to remain annotations rather than derived lifecycle state, so that optimization does not hide facts or choose conclusions for the Consolidator.
22. As a user of Consolidation, I want archives, corrections, and divergent knowledge tips to retain their evidence semantics, so that faster DAG processing does not select a winner by commit number.
23. As a user reading a tool result, I want a full trace to read the relevant Turn's sources efficiently, so that inspecting one occurrence does not reload the entire session many times.
24. As a user reading a tool result, I want multiple native result occurrences, other-call metadata, and omission receipts preserved, so that a narrower query returns the same trace information.
25. As a user of Search, I want a small result cap to limit expensive result preparation, so that requesting one result does not require formatting every match.
26. As a user of Search, I want literal substring behavior and ordering to remain unchanged, so that existing queries still find the same evidence.
27. As a user of Search, I want historical, archived, superseded, and branch-specific knowledge labels to remain accurate, so that a fast result is not mistaken for a current conclusion.
28. As a user paging through Search results, I want stable continuation without duplicate or missing hits, so that commits arriving between pages do not corrupt my result sequence.
29. As a user of explicit memory tools, I want unrestricted local trace and search to remain available, so that performance work does not introduce new read permissions or hidden truncation.
30. As a user choosing a model, I want impossible mandatory context costs rejected promptly, so that the extension does not freeze while repeatedly shrinking a batch that can never fit.
31. As a user choosing a model, I want optional history to yield before selected current evidence, so that a smaller capacity does not unnecessarily prevent useful extraction.
32. As a user of fork and subagent execution, I want capacity to be priced for the effective execution mode, so that reuse of prepared material does not send an oversized request or reject a fitting one.
33. As a user of memory tools, I want precommit failures to advance no fact or knowledge progress, so that faster preparation does not create silent gaps.
34. As a user receiving memory, I want delivery to remain confirmed only after the host settles material it actually supplied, so that responsiveness changes do not lose a committed result.
35. As a user running manual catchup, I want its finite boundary and bounded subagent batches preserved, so that a performance repair does not turn it into an endless background drain.
36. As a user stopping work or closing a session, I want cancellation and claim ownership to remain authoritative, so that interrupted preparation cannot commit through a stale executor.
37. As a user inspecting costs, I want accurate totals without loading full model request bodies, so that the footer remains cheap as run history grows.
38. As a user inspecting costs, I want a later usage update on an existing run reflected correctly, so that incremental accounting does not undercount completed work or treat unknown usage as observed zero.
39. As an installed-package user, I want the responsive behavior verified on the packaged extension, so that a passing source-checkout test does not leave the released package broken.
40. As a maintainer, I want deterministic synthetic long-history fixtures, so that performance regressions can be reproduced without private conversations or paid models.
41. As a maintainer, I want tests focused on public behavior, responsiveness, and scaling, so that a correct alternative implementation is not rejected for using different queries or caches.
42. As a maintainer, I want the improvements achieved without changing stored schemas or rewriting user databases, so that existing Beta data remains usable.

## Implementation Decisions

### Architecture and public contracts

- Keep Core responsible for domain material, budgets, applicability, evidence validation, progress, and delivery. Keep Pi responsible for host events and binding work to its native SDK. Do not add a custom model/tool execution loop.
- Preserve the four memory-tool schemas, address grammar, explicit-read scope, project declaration mechanism, enrollment baseline rule, trigger thresholds, and ordinary-versus-manual-catchup scheduling semantics.
- Preserve existing database contents and schemas. This work does not introduce a migration, delete a database, rewrite historical sources, or require users to reset their memory.
- Prefer the existing store, read façade, material assembly, and host event mechanisms. A performance problem alone is not authorization for a new scheduler, service, persistent job system, dependency, or worker-process architecture.

### Source reconciliation and token accounting

- Match tool results against the appropriate tool-call occurrences without rereading every preceding source entry for each result. Respect Turn boundaries, native lineage, selected ancestry, and existing ordering when tool identifiers or text repeat.
- Reuse validated, unchanged ancestry and process newly persisted entries incrementally where the native source-identity contract permits it. Rebuild or invalidate the necessary state on restoration, tree navigation, lineage changes, or incompatible checkpoints.
- Keep checks for inconsistent persisted source content. Identical text is not source identity; an optimization must not silently accept mutation under a known identity.
- Reuse compressed Raw views only with keys sufficient to identify the immutable source, the rendering configuration, and the view version. A budget or renderer change must not reuse an incompatible view.
- Avoid rendering and estimating all pending material again merely to establish whether a threshold is reached. Preserve the existing joined representation's token accounting, including separators, labels, and receipts; naive addition of independently estimated strings is not assumed equivalent.
- Reuse does not change batch membership, current-material ceilings, or the relationship between the prepared material and the exact write/audit range.

### Applicability and lightweight status

- Build the selected path's Turn membership and source-entry membership once for a read or operation, and share it through fact checks, commit checks, pending-fact selection, citation validation, and branch carry where they use that same path.
- Read identity metadata rather than full Raw payloads when that metadata is sufficient. Retain source-occurrence checks for same-Turn divergence and the existing treatment of facts without explicit entry bindings.
- Reuse immutable unit calculations more freely than mutable projections. Fact relations can change a rendered fact; new commits can change applicable tips; project declarations, marks, enrollment, progress, and delivery confirmation can change views without changing the source entry.
- Read-scoped reuse is the default. Any longer-lived derived cache or aggregate must account for branch/head changes and writes by other executors, not only writes performed by the current process.
- Footer refresh must not independently enumerate and revalidate the full history to obtain counts. Disabled callbacks must not enter the expensive automatic-history path merely to display disabled status.
- Keep status truthful: use inexpensive current statistics or explicitly distinguish unavailable/stale values. Do not silently label an old cached value as a fresh count.

### Trace and Search

- A full tool trace should obtain the relevant Turn's native source occurrences once and reuse them across its tool ordinals. Preserve deterministic occurrence order, multiple results, metadata for unselected calls, and omission receipts.
- Apply pagination before expensive per-hit formatting. Reuse knowledge applicability, current-tip, and ancestry/descendant resolution within the query rather than rebuilding the whole revision graph for each hit.
- Preserve the existing cursor's ownership and validation behavior, stable result ordering, and continuation semantics. New data between pages must not introduce omissions, duplicates, or inconsistent historical labels compared with the query's snapshot.
- Do not keep a database transaction open while waiting for a caller to request another page. Reuse the existing cursor mechanism and retain sufficient stable identities or snapshot metadata instead.
- Keep literal substring matching, escaping, topic matching, unrestricted explicit reads, and all applicable divergent tips. Pagination is not permission to drop results or choose the largest commit id as truth.

### Capacity and accounting

- Perform a cheap rejection when unavoidable instruction, tool, or inherited-prefix costs already exceed the effective mode's input allowance. Do not repeatedly re-freeze candidate batches when no candidate can possibly fit.
- Within a freeze, reuse fixed instruction/tool costs, immutable views, and already computed material components where their inputs have not changed.
- Retain optional-history priority, oldest-first whole evidence, mandatory reminders, final hard-budget verification, and execution of the exact prepared material that was priced. A fast preflight supplements the final guard; it does not replace it.
- Spend and footer accounting should read usage metadata or correctly maintained totals, not full request and response audit bodies. Preserve exact run accounting when usage is added or amended on an existing run.
- Unknown or failed-response placeholder usage remains distinct from observed usage. Do not manufacture zero observations to make aggregation easier.

### Responsiveness and lifecycle

- Remove redundant work before introducing cooperative scheduling. If a large operation still needs bounded steps, preserve a finite selected-ancestry boundary and distinguish preparation in progress from completed reconciliation.
- Do not hold a write transaction across an asynchronous yield, model request, or wait for UI input. Preserve existing atomic business commits and exact progress membership.
- Any bounded preparation must be fenced on stop, shutdown, disable, tree change, and loss of ownership. It must neither commit stale work nor silently skip history when interrupted and resumed.
- Enabling or recovering history does not itself authorize paid extraction, synthetic completion events, or unbounded queue draining. Ordinary eligible completions and the existing manual-catchup controller retain their responsibilities.

## Testing Decisions

### Confirmed seams

1. Use the existing fake Pi host as the primary integration seam. Drive real extension commands and callbacks with persisted native entries, observe responsiveness, notices, registered tools, and durable results, and keep provider traffic simulated or prohibited as appropriate.
2. Use the existing Core façade for focused semantic tests of Trace, Search, applicability, material budgets, capacity failure, progress, and spend. Do not add public production hooks merely to expose an optimization's internals.
3. Extend the existing installed-package smoke. Discover and load the actual tarball through Pi, run the native-worker path against simulated HTTP, and verify that a representative long-history regression is exercised against the installed entry rather than only checkout source.

The user confirmed these seams. Existing enrollment, completed-entry, branch, read, budget-repair, native-runtime, and artifact-smoke tests provide the prior art.

### What makes a good test

- Test externally observable results and responsiveness: complete and correctly attributed Raw, identical applicable facts and knowledge, stable trace/search output, correct batch membership, valid receipts, durable progress, and appropriate failure behavior.
- Use deterministic generators with fixed seeds. Cover long conversations, many tool results, nontext user boundaries, repeated text, multiple native occurrences, and mixed CJK/Latin tool payloads without copying private conversation content into the repository.
- Retain byte-equivalence assertions where output is required to be unchanged. For cursors and other generated identities, compare stable results, ordering, classification, and continuation rather than random identifier bytes.
- Use event-loop heartbeat measurements and increasing workload sizes for performance acceptance. SQL-call counts, private-method spies, or a specific cache layout may inform local profiling but are not the primary acceptance contract.
- Keep normal functional tests deterministic. Run timing comparisons serially in a controlled performance invocation; record runtime version, fixture size, warm/cold state, and concurrent load. Do not turn a single noisy wall-clock sample into a correctness failure.

### Workloads and acceptance

The following are engineering acceptance targets for the agreed responsiveness goal, not claims that the current implementation meets them. Establish reproducible synthetic baseline results before changing the implementation; retain those results so later comparisons do not depend on a private database or an obsolete checkout.

- **Long history:** use approximately 2,000 source entries and 15 million Raw characters, with at least 126 applicable facts and tool-heavy Turns. Exercise initial enable, repeated enable, recovery, and a short new exchange after warm-up. Include a larger workload to expose quadratic growth.
- **Foreground response:** on the controlled baseline workload, target no more than 100 ms of added latency at the 95th percentile for ordinary memory callbacks and footer refreshes. Initial bulk reconciliation should complete within two seconds, with no extension-owned uninterrupted main-thread segment exceeding 250 ms. If the operation remains longer than a response budget, verify event-loop progress and lifecycle correctness between bounded steps.
- **Scaling:** repeated streaming updates with an unchanged persisted leaf must not resume full-history work. A fixed small appended exchange after warm-up must not incur repeated whole-history rendering as the retained history grows. Doubling evidence size must not reproduce the observed near-fourfold growth from repeated full scans; report the cold and warm cases separately.
- **Disabled behavior:** run session restoration, pre-prompt, and pre-provider callbacks on a disabled session that already has long history and facts. Verify the same foreground-response target, no model dispatch, no automatic source reconciliation, retained data, and truthful status.
- **Path semantics:** exercise same-Turn sibling occurrences, tree restoration, shared ancestors, foreign-session evidence, explicit project changes, new relations, archive/update/merge commits, and a second store connection updating the database between reads. Reused results must match uncached semantics.
- **Consolidation and navigation:** pending-fact selection and branch carry on the baseline workload should improve by at least an order of magnitude over the recorded baseline while preserving exact membership, content, and receipts. Do not equate a disabled operation returning an empty result with a successful performance improvement.
- **Full trace:** use a Turn with roughly 40 tool calls inside a long session. Request one full tool occurrence and compare the entire output, including metadata for other calls and multiple-result handling. Target at least a tenfold improvement over the measured baseline.
- **Search:** use 100, 500, and 1,000 matching knowledge revisions, including historical and divergent revisions, with a first-page cap of one. At 500 matches, target a first page within 100 ms on the controlled runner. Verify complete continuation, stable query-snapshot behavior when new commits arrive, no duplicate or missing hits, and unchanged literal matching and labels.
- **Capacity:** derive mandatory costs from the actual instructions, tool definitions, and effective mode. Supply an allowance below those costs and verify prompt rejection without model dispatch or progress advancement. Target rejection within 100 ms without repeated candidate-material construction. Also retain fitting-capacity and optional-history-reduction cases.
- **Spend:** use approximately 200 synthetic runs with large audit bodies and small usage records. Preserve totals while reducing the baseline accounting time and allocation volume; target at least a fivefold improvement on the controlled fixture. Update usage on an existing run and verify that subsequent totals change correctly.
- **Artifact:** run the established source checks and package smoke, including the new long-history regression, before declaring the work complete. Report measured targets that remain unmet rather than weakening the budgets, dropping sources, or changing the test fixture silently.

### Safety and completion checks

- No paid provider calls in the performance suite. Pure inspection and rejected-capacity cases must make no provider request at all.
- No private data, credentials, runtime database, or native request log becomes a checked-in fixture or release artifact.
- Existing tests for atomic commit, retries, exact progress, settled delivery, claims, cancellation, compaction tiers, and scope remain passing. Extend them where a reuse or bounded-execution change adds a relevant transition.
- If a benchmark misses its target because of runner variation, report the measurements and cause. If meeting a target requires an architecture or semantic change outside this specification, stop for approval rather than hiding the discrepancy.

## Out of Scope

- Changing which sessions default enabled, redefining the initialization baseline, or automatically enabling/disabling live sessions.
- Reintroducing project marker files, inferring projects from cwd or Git, or changing explicit project declarations.
- Changing Noter/Consolidator extraction policy, model selection, provider behavior, cache-affinity policy, prompts, or memory quality criteria.
- Reducing token limits, omitting required evidence, clipping selected whole units, dropping delivery content, relaxing applicability checks, or advancing progress without a successful commit.
- Changing normal trigger opportunities, adding timers that drain ordinary queues, or turning manual catchup into an open-ended process.
- Replacing SQLite, introducing a new storage schema, migrating historical databases, or deleting user data.
- Building a new worker pool, scheduler, model loop, cache framework, monitoring service, or dependency as a prerequisite to removing the demonstrated redundant work.
- Treating every inspected loop as a confirmed performance defect. Unmeasured fork-checkpoint reopening and convergent negation-traversal risks are not additional required workstreams here.
- Publishing a new npm version, changing installed packages or live settings, creating a remote issue, or dispatching implementation merely because this local ticket is marked ready-for-agent.

## Further Notes

The audit established the following observations; the first two and the later database-copy measurements used different snapshots and must not be added together as one trace.

| Scenario | Observed baseline | Evidence type |
|---|---|---|
| Initial enable, 1,852 imported sources | About 21.8 seconds; 763,629 source reads; no event-loop yield | Isolated replay of the reported conversation |
| Ordinary completed-entry callbacks before the expanded audit | About 1.79–1.94 seconds; unchanged-leaf streaming updates remained cheap | Isolated host replay with model admission prevented |
| Applicable facts, 1,892 sources and 126 facts | 7.4 seconds; one shared-path probe returned identical ordered facts in 61 ms | Database-copy comparison |
| Pending Consolidation facts and branch carry | About 11.0 seconds and 9.1 seconds respectively | Database-copy measurements; navigation enabled only in the copy |
| Disabled host callbacks | About 7.7–8.2 seconds each, with zero model requests | Existing fake host against a disabled database copy |
| Full trace of one tool in a 40-call Turn | 2.3 seconds; Turn-scoped probe returned byte-identical output in 5 ms | Database-copy comparison |
| Knowledge search, 500 matches, cap one | About 3.0 seconds and 1,000 whole-current-set resolutions | Synthetic valid knowledge records |
| Impossible 2,000-token Noting allowance | 1.4 seconds before rejection; instructions and tools alone cost 3,896 estimated tokens | Simulated capacity against a database copy |
| Spend for 200 large-audit runs | About 20 ms and 66 MB of audit text loaded; usage projection about 2 ms | Synthetic run records |

The small comparison implementations demonstrate that narrower reads and scoped reuse can preserve results. They are not production patches or proof that every scenario is solved. In particular, the full-trace comparison needed to retain other-call metadata and omission receipts; simply deleting unselected calls was not equivalent.

Recommended execution order is applicability/footer work together with historical reconciliation and ordinary token accounting, followed by Trace/Search, then capacity preflight and spend aggregation. Preserve the complete seven-workstream scope; any staged delivery should state which measured problems remain.

Detailed local measurements and probe artifacts are recorded in `/tmp/tm-performance-review-bdb9968.md`. They are diagnostic evidence, not portable test fixtures. Implementation must replace dependence on those private snapshots with deterministic generated workloads.

This ticket follows the repository's existing local issue convention. Its `ready-for-agent` label records specification readiness after the user confirmed the test seams; it is not a GitHub label application, a code change, or authorization to start an agent.

## Amendments and split (user-approved 2026-09-09)

- **One cause, one primitive.** The seven hotspot families share one cause in the code: `source_entries.content` holds the whole message JSON and identity questions (Turn, role, callId, path membership) are answered by parsing it. The repair primitive is a per-operation path snapshot (Turn set plus entry metadata read without parsing `content`; `json_extract` on the column is allowed, a new column or table is not), passed through every applicability check; `content` is parsed only to render. Introduced by 22a and reused by the later slices.
- **Bounded steps deferred.** After the quadratic matching is removed, the one-time import is a single synchronous pass at an explicit user command; the "bound its uninterrupted work" clause applies only if that pass still exceeds 2 s on the baseline workload. No chunked preparation, in-progress markers or fences are built speculatively.
- **Trigger algorithm fixed.** Render pending entries one at a time, join incrementally with the existing separator, stop when the joined estimate reaches `noting.triggerTokens`; cost is the threshold, not the backlog, and the representation is the same joined text as today.
- **Slices:** 22a path snapshot + cheap footer + shared perf fixture (families 3 and the footer); 22b reconciliation + trigger accounting (families 1, 2); 22c Turn-scoped trace + paged search (families 4, 5); 22d capacity preflight + usage projection (families 6, 7). Order 22a → 22b → 22c → 22d; 22b–22d are blocked by 22a. Executed by Opus subagents (user, 2026-09-09).
