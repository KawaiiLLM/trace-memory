# 08 — Fact tool: notes write through `fact`, per-operation results, staged commit

**What to build:** The `fact` write tool replaces the note run's JSON text output. A note run receives the four tool definitions from the façade (`tools(context)`), the model stages facts through `fact` calls, each call answers per fact with a staged handle or a rejection reason, and the run commits the staged set in one transaction when the model stops (an empty staged set still advances the watermark). The same tool bound to a main-agent session commits at once as a `manual` run. The note prompt's Output section describes the tool instead of the JSON array; the text-JSON parsing path is deleted.

**Blocked by:** None — can start immediately (07 is done).

**Status:** ready-for-agent

Ruling (user, 2026-09-07, verbatim): 「mark可以合并掉，最终4个工具，trace search和两个分别操作事实和记忆。主agent允许用，但无需提示用，本身不是它的职责」. Spec section "Write tools" carries the derived rules; quote them in tests.

- [ ] `tools(context)` on the façade returns `trace`, `search`, `fact`, `entry` definitions (name, description, JSON-schema parameters, execute) bound either to a run's staging context or to a main-agent session context; `entry` may be a stub here that rejects every operation with "not implemented in this ticket" (ticket 09 fills it)
- [ ] A `fact` call validates each fact with the existing shape rules (categories, actor, event prefix, no ids in text, relation targets among existing facts or earlier staged handles, source addresses inside the frozen range for a run or the calling session for the main agent) and returns, in order, `staged as $n` or `rejected: <reason>` per fact; valid facts stage even when siblings are rejected
- [ ] Handles `$n` count across all `fact` calls of one run; a later call may reference an earlier call's handle
- [ ] The run commits the staged facts, run record, watermark, and pending delivery in one transaction when the fake runAgent reports the model stopped; failure or cancellation commits only the run record; nothing staged leaks across runs
- [ ] A run that stops with zero staged facts records success, advances the watermark, and queues no delivery
- [ ] A main-agent `fact` call commits immediately as a run of kind `manual` with session, branch, turn, request = tool input, response = tool result; its facts appear in `listBranchFacts` and in settlement ranges
- [ ] The run record's `request` is the last provider request the host reports and `response` holds the tool-call sequence and results; `fetched` remains for `trace` calls
- [ ] The fake runAgent in tests exercises the loop through one seam: it receives the tool definitions and calls `execute` itself; no test imports below the façade
- [ ] note.md Output section rewritten for the tool; `validateNoteOutput` and JSON parsing removed; rulings.test.ts pins "four tools, no other model-facing surface" and "per-operation rejection leaves siblings staged"
- [ ] Line count of core does not grow beyond the deleted JSON path plus the tool layer; report the delta
