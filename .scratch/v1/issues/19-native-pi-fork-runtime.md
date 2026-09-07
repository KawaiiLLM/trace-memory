# 19 — Native Pi fork runtime

Label: ready-for-agent. Tracker: none configured; this file is the ticket.

Status: specified, held. Baseline for the slices: the 17a commit `accc22c`; 17b is in progress. Sequenced after 17a acceptance and after the 17b/17c slices; not released for dispatch. Split into 19a (native runner behind an opt-in switch, with the acceptance gate), 19b (core stops assembling model context; subagent parity) and 19c (readiness, fallback, cutover, deletion of the old runner, rename); this file is their parent specification.

## Acceptance gates and sequencing (user rulings 2026-09-08)

The user's ruling behind this ticket is 「branch 改名为 fork；核心层不涉及组装上下文；适配层换成复用 Pi 的 fork」: rename the execution mode to fork, keep model-context assembly out of core, and replace the adapter's runner with Pi's native fork. The same exchange fixed the shape of the migration; where a bullet below conflicts with this section, this section wins.

1. **Prefix verification is the gate, not a deletion.** The existing byte-level comparison of the outgoing request against the captured parent request (`verifyRequest`, rulings 15:14 and 17:15) is kept and applied to the body the native child produces through `onPayload`. 19a is accepted only when this check passes for the production Recorder and Integrator prompt and tool shape, not for synthetic contexts. The "Deletion" bullet below is amended accordingly: custom message construction, the duplicated model/tool loop and the handwritten settings reader go; the verification stays. If the native path cannot meet the prefix contract, stop and decide explicitly; do not waive it as "caching is never guaranteed".
2. **Net simplification is shown by the diff.** The 19c report states production lines added and removed; the old runner is deleted only after 19a's gate passed and 19b landed, never before.
3. **The cache-miss latch counts only server-side misses.** The deterministic prefix check runs first on every fork request; a request whose bytes differ from the parent prefix is a known miss and is routed to subagent for that task without touching the latch. Only a response whose request passed the prefix check and still reports an eligible `cacheRead = 0` counts toward the latch. The latch itself stays as ruled: one eligible miss, one TUI warning, session-scoped, explicit reset through the trace command. Data point recorded for the record, not as an objection: the public Pi benchmark in discussion #6646 saw whole zero-cache requests inside append-only sessions with no deterministic cause, so on OpenAI-family providers a single miss can be background noise.
4. **Budget is supplied before selection, not negotiated after.** The adapter reports its available material budget (model window minus inherited history, instructions, knowledge, tool definitions and output reserve) to core before core selects the batch; core selects and freezes once. The "Budget negotiation" bullet below is replaced by this single call; the observable behaviour it describes (a smaller oldest-first batch, matching audit range and write eligibility, the capacity problem when nothing fits) is unchanged.
5. **Native worker logs live next to the database.** Default directory `dirname(dbPath)/runs/<parent Pi session id>/`, configurable as `runsDir`, Pi's own `<timestamp>_<child id>.jsonl` filenames. Not Pi's session directory, which `/resume` scans; not the project tree. Each run record stores the absolute path; retention is a documented v1 limit.
6. **Settings come from Pi's `SettingsManager`** (public SDK, verified importable on 0.85.1 from this repository); the handwritten retry-settings reader and its stale "needs pi-server" comment are deleted in 19c together with the old runner, not earlier, so they are not touched twice.

## Problem Statement

The current execution mode called branch copies a captured provider request, appends task material, verifies its prefix and drives its own model/tool loop. It is not a native Pi fork. The name also overlaps with the branch identity used for memory paths and evidence isolation.

That custom runner duplicates capabilities Pi already supplies and makes entry-driven execution depend on captured provider requests. Core Recording and Integration also assemble model conversations, although different hosts may allow different ways to supply context. A subscription-backed host may expose only its own session API, not arbitrary provider request construction.

Users want native background sessions, inspectable native logs and less host-specific runtime logic, without changing memory attribution, atomic commits or source progress.

## Solution

Rename the execution mode to fork and replace the Pi adapter's request-prefix implementation with the native path already verified in probes:

1. Open the source native session through an independent SessionManager.
2. Create a branched session at the frozen persisted entry.
3. Create an independent AgentSession using that manager and run the memory task there.

The foreground session continues unchanged. Background JSONL logs go to the configured private run directory. Core defines the task, evidence and commit contract; each host decides how to present that task through its available model/session interface.

Fork means inherited native session context. Subagent means independently prepared context. Neither term replaces the database's branch identity.

## User Stories

1. As a user, I want the execution mode called fork, so that its name matches a copied native conversation path.
2. As a user, I want branch to remain the name of an evidence path, so that execution strategy and memory identity are not confused.
3. As a user, I want background work to copy one frozen ancestry, so that sibling branches and later foreground entries cannot enter its evidence range.
4. As a user, I want the parent conversation to continue during extraction, so that memory work does not switch or block my foreground session.
5. As a user, I want the parent session file and tree position preserved, so that a worker cannot move or overwrite my conversation.
6. As a user, I want Pi to manage the background model/tool loop, so that Trace Memory does not maintain a second implementation of it.
7. As a user, I want native retry and cancellation behavior, so that transient failures and interruptions use the host's established mechanisms.
8. As a user, I want worker extensions and unrelated tools disabled, so that copied plugin state cannot recursively start memory workers.
9. As a user, I want Integration's review and second submission preserved, so that changing the runner does not weaken its commit protocol.
10. As a user, I want every worker's native log stored privately, so that I can inspect its conversation without cluttering the foreground session list.
11. As a user, I want a run linked to its native log, so that database evidence and host execution can be inspected together.
12. As a user, I want only new worker usage charged to its run, so that copied parent usage does not inflate memory costs.
13. As a user, I want committed results to survive a later provider error, so that a successful batch is never replayed merely to obtain a final reply.
14. As a user, I want an uncommitted failed task to leave progress unchanged, so that the next permitted trigger can retry safely.
15. As a user, I want tasks to launch from persisted entries when their native context is usable, so that they need not wait for another provider request capture.
16. As a user, I want incomplete tool-call groups handled safely, so that a child does not execute an unfinished foreground action or send invalid tool history.
17. As a user, I want a clear subagent fallback when native forking is unavailable, so that a missing source file does not cause silent loss or a fake successful fork.
18. As a user, I want closed-session catch-up to remain subagent work, so that it does not rely on a live parent's runtime.
19. As a user, I want existing configuration to fail clearly or map to the renamed mode, so that an old setting does not silently select the wrong execution strategy.
20. As a user, I want old run records to retain their actual execution history, so that pre-migration request-copy runs are not falsely described as native forks.
21. As a user, I want context assembly owned by the host adapter, so that the same core memory logic can support Pi and hosts with restricted session APIs.
22. As a user, I want audit limitations stated explicitly, so that a native JSONL file is not mistaken for an exact provider request record.
23. As a user, I want fork cache reuse retained where supported, so that native session isolation does not automatically discard existing caching benefits.
24. As a user, I want cache and transport failures visible, so that a shared request identity is not presented as guaranteed caching or perfect transport independence.
25. As a user, I want the existing view limits, triggers and enrollment rules unchanged by the runner replacement, so that this migration does not redesign memory scheduling.
26. As a user, I want one eligible fork cache miss to switch subsequent memory tasks in this session to subagent, so that I do not repeatedly pay to resend inherited history without a cache hit.
27. As a user, I want one TUI warning when that automatic downgrade occurs, so that the effective mode change is visible without repeated alerts.
28. As a user, I want the current task to finish without replay, so that a cache miss does not discard useful work or incur a duplicate extraction.
29. As a user, I want to explicitly retry fork for this session, so that a transient cache miss need not permanently prevent inherited-context execution.

## Implementation Decisions

### Naming and compatibility

- **Execution mode.** New task options, configuration, status text, prompts and run metadata use fork instead of branch for inherited-context execution. Subagent remains the fresh-context alternative. Rename the Recording branch-mode configuration to its fork equivalent; do not introduce a second overlapping mode-selection scheme solely for this rename.
- **Path identity.** Keep existing session/branch IDs, source addresses, knowledge commit addresses and evidence-path terminology. A background child's native session ID is not a new Trace Memory evidence-sharing session.
- **Legacy input.** Accept old branch execution-mode/configuration spelling at the configuration/API boundary as an alias where needed; emit only the canonical spelling for new work. If both forms are supplied, the canonical form wins and the conflict is reported. Do not retain the old runner behind the alias.
- **Historical truth.** Preserve existing run records and verification data. Read interfaces may label old branch-mode runs as legacy request-copy execution; do not rewrite their historical mode to imply that AgentSession ran them. No bulk database rewrite is required for a terminology change.

### Core task boundary

- **Core owns memory.** Keep task kind, target session/branch, frozen source-entry or fact set, evidence eligibility, domain instructions, tool implementations, review feedback, validation, atomic commits and progress in core.
- **Adapters own conversations.** Core must no longer build system/user message sequences, provider bodies, inherited request prefixes or separate mode-specific concatenated input strings. Supply structured task material and domain rules to the adapter. The adapter chooses how to use them through the host's supported API.
- **Reusable views.** Source queries, the compressed Raw view and fact/knowledge renderers may remain core services. Providing a bounded source representation is different from deciding which model message contains it. Existing rendering budgets remain applicable to Raw the plugin explicitly adds.
- **Budget ownership.** Core enforces the shared 1k tool-call view limit, 10k entry view limit and 50k Recording candidate-batch ceiling under the current configuration. The adapter accounts for the actual model window, inherited history, instructions, knowledge, tool definitions and output reserve. The 50k ceiling is not a claim that the complete provider request fits.
- **Budget negotiation.** Before model execution, an adapter that cannot fit the candidate asks core to select and freeze a smaller oldest-first batch within the available material budget. Core regenerates the selected source set, range metadata and bound write eligibility together; the superseded candidate must not execute or commit. The adapter must not silently remove queued material while retaining authority to advance the larger range. This is preparation of the same task opportunity, not another extraction trigger or a drain loop. If the oldest eligible unit still cannot fit, apply the documented fallback or leave it pending with a capacity problem.
- **Inherited context is not evidence permission.** Extra history supplied by a native fork remains context only. It cannot expand the core-frozen writable range. A smaller prepared batch leaves every unselected entry or fact pending, regardless of what else the model can see.
- **Capability-aware auditing.** The host reports its actual model, execution mode, native log reference, available request audit, usage, retry diagnostics and terminal outcome. Pi must retain exact provider payload capture where its SDK hook exposes it. Another adapter that cannot expose a request must report that limitation explicitly rather than fabricate one or fail otherwise-valid business work solely because the host cannot provide that artifact. An adapter expected to capture a payload but failing to do so still reports an audit problem.
- **Minimal contract.** Evolve the existing run-agent boundary rather than add a provider framework or new core dependency on the Pi SDK. The CC adapter may use the session API available to its subscription integration; implementing or bypassing that host's restrictions is not part of this ticket.

### Native Pi execution

- **Supported SDK.** Use a Pi version whose public SDK imports successfully; the tested version is 0.85.1. No loader hook, replacement module, or dependency on private bundle chunks is allowed as the production solution.
- **Independent manager.** Open the original session file in a separate SessionManager with the background log directory, then call `createBranchedSession` at the frozen entry. Never mutate the foreground manager. Do not use the foreground runtime's switching fork API or the whole-file `forkFrom` operation, which copies unrelated branches.
- **Independent AgentSession.** Pass the child manager to `createAgentSession`. The child owns its model state, tool loop, cancellation and persistence. Do not write a parallel custom conversation loop around the native one.
- **Subagent parity.** Use the same native AgentSession runner for Pi subagent execution with a fresh private manager and adapter-prepared task context. Closed-session catch-up continues to force subagent mode. This avoids retaining a second Pi model/tool runtime solely for fallback.
- **Resources and tools.** Disable automatic extension, skill and project-context discovery in workers unless a resource is explicitly supplied by the adapter. Copied custom state must not activate plugins. Explicitly register the required memory tools, omit unrelated execution tools, and set tool execution to sequential; Pi's tested default was parallel.
- **Task placement.** The adapter supplies background instructions without pretending a system-generated review is a human ruling. Use native messages/steering for the Integration review and preserve its two valid submissions. Do not permit copied unfinished foreground tool calls to run as worker actions.
- **Compaction semantics.** A native fork's model context respects existing native compaction; copying its JSONL does not restore all pre-compaction Raw into model context. The adapter supplies selected task material or supports trace retrieval when that material is not present in the restored context. Do not silently mark absent material processed.
- **Runtime settings.** Read settings through Pi's native SettingsManager now that the SDK import works. Reuse its retry and provider policies and remove the handwritten duplicate settings merge. A worker may intentionally suppress automatic discovery or foreground UI without replacing the underlying retry policy.

### Entry readiness and fallback

- **Trigger versus launch.** Keep scheduling thresholds in their existing authority, including the later entry-trigger changes in ticket 17b. A due task launches only after its chosen native checkpoint is persisted and can be reopened. Pi's message-completion extension callback precedes persistence in the tested build; do not assume its current entry already exists on disk.
- **No capture dependency.** A native fork does not need the parent's next provider request. Once a persisted, valid checkpoint exists, it may run while the foreground is still processing the same user Turn.
- **Tool-group boundary.** If the chosen checkpoint contains an assistant tool-call group with missing results, defer native launch until a valid boundary or use the documented subagent fallback. Do not silently execute pending foreground tools, create fictional results, or treat a partial tool result as complete.
- **Frozen task scope.** Distinguish the fork checkpoint from the writable source-entry batch. Any extra native history needed to make the model context valid is read-only task context, not additional Recording coverage. Entry arrivals while waiting or running cannot expand the task's write eligibility implicitly.
- **Readiness recheck.** A safe persistence/tool-group boundary may start a task already made due by an earlier entry completion; that is not a new extraction trigger. Waiting creates no duplicate task and advances no progress. Tree switches invalidate a stale launch context rather than substituting the new branch's history for the old task.
- **Fallback.** If a source file, checkpoint, model or context capacity prevents native fork execution, apply the adapter's explicit subagent fallback when feasible and record requested mode, actual mode and reason. If neither mode is viable, leave the queue pending and report the problem. Do not fall back after a committed batch in a way that repeats the write.

### Cache and transport identity

- **Separate log identity.** Native parent and child session IDs and files remain distinct. For Pi providers using session identity for caching/affinity, preserve the current branch runner's policy of supplying the parent's request/transport session ID for active-session fork work. This must be an adapter decision; never overwrite the child's SessionManager identity or its Trace Memory target attribution.
- **Scope sharing narrowly.** Share request identity only within the intended parent-child lineage and compatible provider/auth context. Do not assign one global identity to unrelated sessions or subagent catch-up jobs.
- **Best-effort caching.** Keep the same working directory and stable resources when appropriate, but do not claim byte-identical provider prefixes. The native SDK rebuilds system prompts and tool definitions; changing them can invalidate caching. No cache-hit minimum is a business success condition.
- **Native connection policy.** Reuse pi-ai's busy-connection isolation and continuation-prefix checks; do not add a custom WebSocket pool. Account for shared fallback state and possible loss of incremental continuation when divergent requests alternate. Cancellation and cleanup must not explicitly close all resources under the shared parent request identity merely because one child finishes.
- **Acceptance scope.** The probes support shared request identity as a viable candidate, not a universal guarantee. Test the actual production memory prompt/tool shape, not only identical synthetic contexts. If that shape loses cache reuse, report the result instead of retaining the old request-copy runner covertly.

### Cache-miss fallback

- **Eligible miss.** Observe individual completed fork responses, not the sum of a run's replies. Trigger when the provider explicitly reports `cacheRead = 0` and the actual input meets that provider/model's known minimum cacheable length. Use provider-reported input usage under its documented counting convention, not compressed Raw size or an assumption that uncached input includes cached tokens. A nonzero hit does not trigger this policy; there is no hit-ratio threshold.
- **Unknown is not zero.** Missing usage, SDK placeholder zeros on errors or cancellation, unsupported cache reporting, a disabled provider cache, an unknown cacheability minimum, and inputs below that minimum do not establish an eligible miss. Do not invent one universal token minimum across providers. Record unavailable diagnostics without triggering this automatic mode change.
- **Session-scoped latch.** The first eligible miss atomically disables fork admission for subsequent Recording and Integration tasks belonging to the same Trace Memory session identity. Retain the configured requested mode, but resolve a requested fork to subagent while this latch is active. Unrelated sessions and global configuration are unchanged. Persist the latch across reopen; branches or copied hosts sharing that memory session share it too.
- **No replay.** The task that observed the miss continues normally in its existing native session, including its tool protocol and trailing replies. Do not restart it as a subagent, cancel it merely for the miss, or turn a committed batch into a failure. Already-running sibling tasks remain frozen; tasks not yet launched recheck the latch before admission. A cache miss does not create an extra extraction trigger.
- **One warning.** On the transition, notify the active Pi TUI once: `Trace Memory: fork cache miss. Future memory tasks in this session will use subagent.` Further misses during the same downgrade episode do not repeat the warning. Headless operation records the event without requiring UI. A worker never sends this warning as a user-source message to the model.
- **Audit and status.** Record the miss's run/response, model, reported input/cache usage and resulting downgrade. Subsequent run records retain requested fork, actual subagent and the cache-miss reason. Status makes the session downgrade visible; do not falsely label the run that detected it as subagent execution.
- **Explicit reset.** Provide a session-scoped retry-fork action through the trace command/menu path. It clears the automatic suppression without changing global mode preferences or launching extraction. Another eligible miss after a reset starts a new downgrade episode and may warn once again. Reopen or an unrelated settings refresh must not silently reset suppression.
- **Tradeoff.** One transient miss is sufficient under this deliberately conservative policy. The downgrade is a user-chosen response to unproductive inherited-context cost, not proof that fork is broken or that subagent is always cheaper. It does not replace production-context validation or relax memory correctness checks.

### Logs, outcomes and cleanup

- **Log destination.** Write native worker JSONL under a configured private run directory, defaulting to the user's Trace Memory runs directory. Keep Pi's generated timestamp/session-ID filenames. Do not require a database run ID before launch or rename active native files to match it.
- **Run linkage.** Link the database run to its native file and original session, branch and frozen checkpoint. Failed and cancelled attempts with an audit record retain their log reference. Preserve the existing accepted boundary that a process killed before its first durable run record may leave an orphan worker log.
- **Native log limitations.** JSONL holds native history, tool rounds and responses, not necessarily the exact system prompt or tool schema sent to a provider. Keep provider-payload audit separate. Do not save credentials or authorization headers in diagnostic artifacts.
- **Usage.** Count only newly generated worker responses, including reported failed attempts. Do not use total native session statistics as run usage: they include copied parent responses. Cancellation without reported usage is unknown, not evidence of a free request.
- **Completion.** Determine business outcome from core commit state first, then the native terminal response. `prompt()` resolving does not prove success; the probe confirmed that it may resolve after a provider error. Preserve committed success with problems and leave uncommitted failures pending.
- **Cancellation.** Wire existing host/task cancellation into AgentSession. After a core commit, do not start a fresh extraction because a trailing reply failed. Dispose only the child runtime and its subscriptions; preserve the parent session and other active workers.
- **Scheduling ownership.** Preserve existing task admission and integrate with ticket 17c's session-wide shared claims when available. This ticket does not implement a competing claim system or release its held dependency.
- **Deletion.** Remove custom provider-message construction, exact-prefix verification as a launch requirement, duplicated model/tool looping and redundant retry/configuration reading from the Pi adapter. Retain only legacy audit rendering and checks that still enforce memory correctness.

## Testing Decisions

**Primary proposed seam:** the existing public TraceMemory façade and Pi host harness, extended to instantiate real native SessionManager/AgentSession objects in a temporary directory. Use controlled model responses for deterministic behavior and inspect provider payloads, native JSONL, public run outcomes and actual committed memory. Prefer this seam over tests coupled to the old prefix builder. Confirm this test boundary with the user before implementation.

Reuse current Recording/Integration commit tests, source-entry path tests, provider-error tests and the native fork probes. The implementation must include at least one end-to-end check using actual core write tools; the completed live feasibility probe used a synthetic in-memory commit and does not by itself validate database integration.

Acceptance scenarios:

1. **Public SDK and naming.** Import the supported SDK without hooks, select fork through the canonical configuration and the supported legacy alias, and verify that new run metadata uses the new name while historical request-copy runs remain distinguishable.
2. **Exact selected ancestry.** Fork a persisted entry with later foreground activity and a sibling branch present. The child contains the selected path, not the sibling or future entries. Parent bytes, ID and tree position are not mutated by the child.
3. **True background execution.** Continue foreground messages while the child runs. Verify independent native logs, bounded task evidence and no child tool results or review messages appended to the parent.
4. **Readiness.** Drive message completion before native persistence, followed by the safe persistence boundary. Launch once, with a real entry ID, without requiring provider request capture. Cover a partially complete multi-tool group and final assistant completion without a following provider call.
5. **Core protocol.** Run actual Recording writes and two-submission Integration through native tool execution. Reject out-of-range source entries even if they exist in copied history. Confirm atomic progress and no duplicate commit after a trailing native error.
6. **Resources.** Copy plugin custom state into a child but prove no recursive extension loading or worker creation. Verify the tool whitelist and sequential execution through observable call order.
7. **Fresh-context path.** Exercise explicit subagent execution, closed-session subagent requests and a precommit fork fallback. Verify the actual mode and fallback reason, and that no legacy custom tool loop runs.
8. **Logs and reopen.** Persist native files under the configured directory, link them from run records, reopen the child and recover its tool history. Verify exclusion from default foreground session discovery and preservation of original log history.
9. **Accounting and audit.** Seed copied history with usage, then perform new calls including a retry. Report only newly returned usage and exact available payloads. Test an explicitly unsupported request-audit capability separately from a Pi capture failure.
10. **Errors and lifecycle.** Cover abort before commit, provider error returned without a thrown exception, committed success followed by error, and child disposal while the parent remains active. Existing lifecycle trigger policy must not change.
11. **Compaction and source scope.** Fork after native compaction and prove that retained JSONL Raw and restored model context differ as expected. Selected missing material is provided or retrieved, never silently considered inspected.
12. **Cache and concurrency.** Keep distinct native log identities while sharing the intended request identity. Run parent and child concurrently, cancel the child occupying the cached connection, and continue the parent. Verify outputs, continuation selection and fallback diagnostics; do not assert that every request hits cache.
13. **Task-context ownership.** Exercise a host stub that accepts structured task material but assembles no core-prescribed message sequence and reports unavailable provider audit explicitly. The same core validation and commit contract must work without Pi-specific context construction.
14. **Cache-miss transition.** Return an eligible zero-cache response, then complete the current fork's write protocol. Assert one commit, no task replay, one TUI warning, no new extraction trigger, and subagent selection for both phases on their next permitted launches. A miss after an earlier hit in the same run must still be detected.
15. **Cache eligibility and reset.** Test a positive hit, below-minimum input, missing or placeholder usage, provider error/cancellation, disabled or unsupported caching, and unknown provider limits: none falsely downgrades the session. Repeated misses warn once; reopening retains the latch; an explicit retry-fork reset permits a new attempt and one new warning if it misses again. Verify global configuration and unrelated sessions are unchanged.
16. **Concurrent downgrade.** Two in-flight phases report eligible misses together. Admit one downgrade transition, preserve their existing frozen tasks, and prevent a queued-but-unlaunched fork from bypassing it. Reuse existing shared-state test infrastructure rather than building a separate scheduler for this latch.
17. **Budget negotiation.** Give the adapter a core candidate below the 50k material ceiling whose full inherited request exceeds the available model window. Verify that core selects and re-freezes a smaller oldest-first batch before the only model call, with matching request material, audit range and write eligibility. Attempt to cite or advance an excluded entry and require rejection; after success, the excluded tail remains pending. If the oldest unit alone cannot fit, verify an explicit viable fallback or a reported capacity failure without progress, not silent truncation of the task range.

Retain runnable failure probes: using the foreground SessionManager, copying the entire tree, summing copied usage, treating resolved `prompt()` as success, or activating inherited extensions must fail a named test. Live provider checks use a small approved model and synthetic evidence, with cost and transport clearly reported; deterministic tests should not require credentials.

## Out of Scope

- Implementing or releasing the held trigger, catch-up or enrollment work in tickets 17 and 18.
- Renaming database branch identities or changing evidence scope and knowledge commit semantics.
- Guaranteeing cache hits, identical provider requests, or no WebSocket/SSE fallback.
- Retaining the legacy request-copy runner as an additional production mode.
- A custom background-session framework, custom connection pool or independent retry implementation.
- Implementing a CC subscription runner or bypassing host restrictions.
- Changing compressed Raw limits, queue thresholds or the read-only configuration menu policy.
- Bulk rewriting historical run records, a log-export subsystem, or a new footer design.

## Further Notes

This ticket records the user's requested rename and native Pi fork replacement, together with the earlier explicit boundary that core must not assemble model context. It supersedes the native-runtime and exact-provider-prefix exclusions in the earlier tickets only for this work; their other rulings remain unchanged.

A subsequent user ruling adds the cache-miss fallback above: one eligible miss emits one TUI notice and downgrades future work in that session to subagent. The current task is not replayed, and the global configuration is not changed.

Feasibility evidence on Pi 0.85.1:

- Public-SDK synthetic checks passed selected-path extraction, parent preservation, private native logs, reopening, tool whitelisting, sequential review feedback and provider-error persistence.
- A real Codex Luna task completed three model responses and two synthetic memory calls: candidate, review, commit. The parent continued independently; its estimated reported cost was $0.000282.
- With shared request identity, Codex Luna and Terra child requests demonstrated parent-prefix cache reuse under actual concurrent WebSocket execution. Responses and cancellation remained isolated in the tested scenarios. Luna recovery also encountered an SSE fallback; Terra's repeat stayed on WebSocket. Some parent requests still missed cache.
- Merely sharing the request-body cache key while retaining independent transport identity did not yield a child cache hit in the tested samples. That observation is not proof that the combination can never hit.
- The probes used synthetic conversation and tool shapes. Production memory instructions, resources and tools still require acceptance testing; no unchanged-prefix or cache-success claim follows automatically from native forking.

The current worktree includes another agent's entry-ingestion changes. Implement against the then-current contracts rather than overwriting that work or resurrecting superseded Turn-based behavior. No implementation files were changed to publish this specification.

No external issue was published because the repository has no configured issue tracker or Git remote. This local ticket follows the ready-for-agent convention. Only the proposed test seam needs confirmation before implementation; this specification is not an instruction to dispatch held work.
