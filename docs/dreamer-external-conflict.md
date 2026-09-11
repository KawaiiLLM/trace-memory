# Dreamer external-successor conflicts

## User ruling

A Dreamer execution blocked **only by an external successor created after its freeze** ends as `conflict`, not success, failure or user cancellation. This is the sole business-failure exception to the [32c logical-task rule](core.md#logical-task-outcomes-32c), not an exemption for arbitrary competition or stale handles.

An existing streak of two remains two through any number of these conflicts; the next real failure reaches three and disables the target. Successful completion and explicit enrollment-on retain their existing reset rules. Noter and Consolidator gain no exception.

## Acceptance and authority

Core freezes exact supplied versions and the maximum allocated commit identity with the existing retained range. At check time, it resolves the current graph, including merge descendants and this range's own commits. A non-admitted current result qualifies as an external successor only if it was allocated after that boundary and descends from frozen material or the task's own result. Diagnostic text and model assertions carry no authority.

The final transaction rechecks the claim, retained path, graph and processed-scope caps. Conflict requires a successful provider outcome, the existing exact-request audit contract, no unresolved illegal tool/batch operation and no other acceptance failure. A stale write is not forgiven merely because an external successor exists. The existing one repair and shared maximum of 50 tool rounds remain available; a valid corrective submission can resolve an earlier refusal. Cancellation and lost ownership retain cancellation settlement.

The core's live Dreamer capability binds one range, claim, execution and run. Only that capability can issue conflict settlement. The public settlement entry point cannot manufacture it from an outcome, run response or another execution's run. Run audit and execution terminal state commit together. Reopening or duplicate settlement observes the authoritative terminal state without adding or clearing failures.

## Retention and continuation

Conflict retains legal immediate writes, their provenance, the independent run record and usage. It writes no Dreamer completion, settled event or processed-version certificate. Both run and execution use a real `conflict` outcome; old SQLite CHECK constraints are rebuilt transactionally with IDs, foreign keys, indexes, triggers and sequences preserved.

The retained anchor, event membership, path and writable family do not expand. A later eligible admission freezes the actual current result bodies again. This includes an external merge survivor outside the writable family: fresh admission can certify that supplied result, but the identity remains read-only. Reading it during the earlier execution cannot certify it. Success settles only the retained events, not every external event encountered along the way.

Another target's Dreamer may already have completed shared events legitimately. Final acceptance can still read the original range identity and graph descendants after that closure; write validation still requires an open range. This execution creates no additional certificate for its external successor and does not undo the other executor's completion.

There is no new retry controller, worker restart or completion chaining. Later eligible entry completions and existing bounded recovery admission can resume pending work. Recovery still consumes at most one Dreamer use; phase seats remain independent. Admission and processed caps are unchanged, so an oversized retained body still stays pending rather than being clipped.

## Offline evidence

- **Core barriers:** `tests/core/api/dreaming-conflict.test.ts` uses two SQLite connections and independently attributed executors for external update/merge, own commits, repeated conflicts, mixed failures, cancellation, final locking, reopen and public-authority rejection.
- **Native scheduling:** `tests/hosts/pi/dreaming.test.ts` verifies one native worker with one repair, no immediate replacement, and successful refreezing at the next entry completion, for both update and merge.
- **Migration:** `tests/core/store/dreaming-conflict-migration.test.ts` reconstructs the actual old CHECKs and tests reference/audit preservation, reopen and transactional rollback.

This ruling does not change processed-projection performance policy, host admission gates, foreground Agent write authority or cleanup behavior. Verification uses no real provider or production database.
