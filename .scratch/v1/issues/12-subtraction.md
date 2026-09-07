# 12 — Subtraction: retire the non-atomic store path, the manual assistant replay, and the old-protocol test converter

**What to build:** Nothing new. Remove code and tests that only served the retired JSON protocol or the retired partial-commit rule. Behaviour visible through the façade and the Pi host is unchanged; the test count may fall only where tests are merged, and every situation a removed test covered must be named in the report with the test that still covers it.

**Blocked by:** None — can start immediately.

**Status:** ready-for-agent

Ruling behind it (user, 2026-09-07): every write batch is atomic; any rejection writes nothing. The user adopted this subtraction list on 2026-09-07 (「采纳」).

- [ ] `core/store`: delete the non-atomic commit mode, the `atomic` input flag, and the partial-success `rejected` branch of `commitIntegrationRun`; a batch either commits whole or rolls back; validation and failure audit stay; callers and test fixtures updated
- [ ] `hosts/pi/branch.ts`: delete the hand-built assistant message shapes in `providerMessage` and the "replays an assistant reply in pi-ai's native shape" test; the first round appends only the user instruction, later rounds are adapter-serialized and appended through `appendNativeRequest`; `Appended` narrows to the user role
- [ ] `test/memory-batch.ts` deleted; the core tests that used it write `{operations, skipped}` directly; no second input vocabulary (`new`, `edit`, `delete`, `not_admitted`, `near_ack`) remains anywhere under core/ or test/
- [ ] `core/api/integration.test.ts`: the three concurrent-change tests (a conflict rejects only its operation…, conflict diagnostics exclude…, rejected supports still cited…) become the two cases the atomic rule leaves: a target that moved on and a target that was archived; names say what they assert
- [ ] `core/store`: delete the `openStore` wrapper; callers construct the store directly
- [ ] Production line count of core and hosts/pi goes down; report the delta per file; `npm run typecheck` and `npm test` pass
