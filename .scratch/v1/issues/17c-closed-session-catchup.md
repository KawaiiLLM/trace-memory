# 17c — Shared task selection and closed-session catch-up

**Parent:** 17 — Entry Recording and closed-session catch-up.

**What to build:** one task-selection policy for ordinary work and closed-session tails. Each enabled active Pi session is an executor with one Recording slot and one Integration slot. Each free slot prefers eligible work for its own memory session, then considers other enabled, normally closed sessions. A target session also has one atomic claim per phase, shared across executors and processes. Thus many closed-session backlogs do not cause one executor to launch many workers. On executor shutdown, stop scheduling, cancel its workers and preserve pending work instead of waiting for extraction to finish naturally.

**Blocked by:** 17b — Entry-driven triggers, Integration without Turn batching, no lifecycle flush.

**Status:** ready-for-agent (held). Updated by user ruling 2026-09-08; this ticket does not authorize implementation of held work.

## Task selection

- **Enabled before ticket 18.** Enrollment is ticket 18's concept and 18 is sequenced after this slice. Until it lands, every session counts as enabled wherever this ticket says "enabled"; 18 adds the gate without changing selection or claims (user ruling 2026-09-08).

- **Logical shared queue.** Derive pending Recording entries and unintegrated facts from existing source/progress state. Do not create a second persisted copy of every pending entry or fact. Store task ownership, not a duplicate backlog.
- **Executor versus target.** The executor is the active Pi session/plugin runtime that hosts a worker. The target is the Trace Memory session and branch whose evidence it processes. Ordinary work has the executor's own memory session as target; catch-up borrows a free slot for a different target. Attribution never moves to the executor.
- **Two executor slots.** Each executor runs at most one Recorder and one Integrator, including both its own and borrowed tasks. The phases may overlap. Reserve the local slot before asynchronous admission; release it only after the worker is no longer running, or when executor teardown has fenced it from further writes.
- **Entry-triggered admission.** An eligible entry completion in an enabled active session checks each free slot. First try its own queue under 17b's normal threshold: 10,000 compressed-view tokens for Recording, fifty facts for Integration. If no own task can be claimed, consider other enabled sessions that are marked closed and have a nonempty queue for that phase, ignoring their normal threshold.
- **One task per free phase.** Skip already-claimed targets. Select a single eligible target and frozen branch range for each free slot; do not launch one task for every closed session found. Use oldest pending work first among closed targets with a stable tie-breaker. A target with no pending Recording may still supply Integration work.
- **Priority is not preemption.** New own-session work does not cancel an already-running borrowed task. Busy slots wait for their worker to settle; completion releases the slot but does not itself trigger another extraction. Remaining work waits for another eligible entry completion.
- **Execution modes.** Own-session work follows its configured/effective mode. Borrowed work always uses subagent mode. Recording takes one bounded batch under 17b; Integration takes one eligible batch without a complete-Turn requirement. Neither phase drains continuously.
- **Target context.** Freeze the target's project, branch and evidence range. Costs, commits, progress, audit records and deliveries belong to the target session, never to the active executor's conversation. Do not combine sibling branch queues into one writable range.

## Claims and reopening

- **Target-wide exclusion.** Each target memory session has at most one valid Recording claim and one valid Integration claim across all branches, hosts and processes. Both ordinary and borrowed tasks use this admission rule; a foreground task cannot bypass a catch-up claim.
- **Atomic ownership.** Each phase claim records its executor, an ownership token and a thirty-minute expiry. Acquire it atomically against current eligibility. Do not hold a database transaction during a model request. Failed acquisition leaves the executor free to try another eligible target.
- **Commit fence.** In the commit transaction, require the current unexpired token and the target still enabled. Borrowed work additionally requires the target still closed. Cancellation invalidates ownership before it can permit a late write. Release is token-conditional so an old worker cannot clear a newer worker's claim.
- **Normally closed only.** Normal shutdown marks the executor's own memory session closed. There is no heartbeat, process-liveness discovery or automatic closed marking for a crash; a crashed conversation waits until resumed. Expiry can recover an abandoned task claim, but does not by itself declare its target session closed.
- **Reopen.** Reopening clears the target's closed mark, blocking new borrowed claims and preventing an already-running borrowed task from committing: its fence requires the target still closed, so that claim can no longer write anything. The reopened session therefore takes the phase claim over immediately with a new token (user ruling 2026-09-08); the old worker may finish or be cancelled, its commit fails the fence and leaves the batch pending. There is no waiting for release or expiry, so a borrower that died cannot stall the reopened session for up to thirty minutes.

## Executor shutdown

Shutdown or foreground session replacement cancels workers owned by that executor, including tasks borrowed from other sessions. The runtime is not a detached daemon.

1. Stop scheduling and invalidate the executor's outstanding task tokens against future commits.
2. Request cancellation of both active model calls and retry waits through the host runtime. With native AgentSession, cancel the child runtime, not the foreground session or every connection under a shared provider identity.
3. Allow a short, bounded cleanup interval for cancellation, audit updates and log flushing; do not wait for the extraction to finish naturally. Use one five-second cleanup deadline across both slots rather than an unbounded wait per worker.
4. Dispose child runtimes and release claims conditionally on their tokens. Close the database after cleanup, or at the deadline after fencing late writes and closing their tool bindings. Consume late promise failures without allowing access to a closed store.

- **Race with commit.** If a business commit wins before cancellation invalidates its token, preserve that success and its progress. If cancellation wins, no business writes or progress from the old task may land. Do not restart a committed batch merely to obtain a final assistant reply.
- **Pending tails.** Uncommitted work remains queued. Mark the executor's own session closed during normal shutdown so later enabled sessions can claim its tails. A borrowed target keeps its existing closure state; executor exit does not reopen it or transfer its evidence.
- **Audit limits.** Retain available usage, native logs and cancellation diagnostics. Cancellation without returned usage is unknown, not free. If cleanup or audit storage fails, report it without undoing a committed batch or blocking exit indefinitely. A forced process kill still has the existing precommit audit gap.
- **No lifecycle extraction.** Shutdown and compaction launch no extraction. This policy replaces waiting indefinitely for every pending task on shutdown; it does not add a flush or a continuous catch-up mode.

## Acceptance checks

Use the existing host/façade seam and real temporary database; extend the existing two-process claim check rather than add a separate queue framework.

- [ ] Several closed sessions each have Recording and Integration tails. One executor starts at most one worker per phase, not one per target, and its own eligible work wins selection.
- [ ] A busy local slot launches nothing else in that phase. Work arriving for the executor does not preempt its borrowed worker; worker completion alone launches no follow-up batch.
- [ ] Below-threshold own work may wait while a free slot claims a closed session's one-entry or one-fact tail. An empty Recording queue does not hide Integration work. Later entry completions provide subsequent bounded opportunities.
- [ ] Two active executors racing the same target admit one valid claim per phase; the loser may select another target. Ordinary and borrowed work cannot bypass each other's target claims.
- [ ] Catch-up preserves target identity, frozen branch, cost attribution and delivery destination. Other live or disabled sessions are not eligible borrowed targets.
- [ ] Reopen during selection admits no borrowed claim. Reopen during execution rejects the borrowed commit without progress, and own-session extraction waits for the existing claim to release or expire.
- [ ] After an executor dies and its claim expires, a replacement may claim eligible work; a stale token cannot commit or release the replacement's claim. A missing closed mark is not inferred from claim expiry.
- [ ] Exit with one own task and one borrowed task in flight: stop admission, request both cancellations, fence late writes, release owned claims safely and preserve both queues. A provider ignoring cancellation cannot block shutdown beyond the shared cleanup deadline.
- [ ] Race disable/cancel with commit: a commit completed first remains successful; a task whose token was invalidated first writes nothing. Settling after disposal does not cause an unhandled rejection or mutate the closed database.
- [ ] Failed or cancelled work stays pending; successful zero-fact Recording advances only its selected entries. Compaction and shutdown launch no model calls.
- [ ] Revert probes: remove the executor slot limit, target claim, token fence, closed-target condition or shutdown deadline; each change makes a named test fail.

## Scope boundary

This slice supersedes the parent's earlier per-closed-target fan-out wording: an entry event offers capacity in two executor slots, not permission to start workers for every closed target. It retains the normal-close-only rule, thirty-minute claims, no heartbeat and no completion-triggered drain. It does not introduce manual `/trace catchup` or `/trace stop` commands; their eventual handlers should reuse these ownership and cancellation rules.
