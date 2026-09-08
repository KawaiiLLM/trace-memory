# 22b — Reconciliation proportional to new evidence, and a trigger that stops at its threshold

**Parent:** 22 — Responsive memory processing (hotspot families 1 "Historical source reconciliation when enabling or recovering a session" and 2 "Ordinary reconciliation and pending-material token accounting at completed-entry boundaries"; section "Source reconciliation and token accounting"; user stories 1–6, 11, 17–19). Amended 2026-09-09 (user-approved), see "Amendments" below.

**What to build:** enabling memory on a long existing conversation imports its history once, in time proportional to the history, without rereading earlier entries per tool result; an ordinary completed entry costs work proportional to what is new, not to the whole conversation; and the Noting trigger decides "10K pending tokens reached" without rendering the whole backlog.

Concretely, in the host's `walk`/`reconcile` (`src/hosts/pi/index.ts`) and core's `taskEligibility` (`src/core/api/index.ts`):
1. **Tool-result matching** keeps a map from callId to (Turn, ordinal) built while walking the ancestry, so a tool result finds its call in constant time. Turn boundaries, native lineage, selected ancestry and existing ordering still decide ties when callIds or text repeat.
2. **Unchanged ancestry is not re-validated on every callback.** Entries already reconciled under the same lineage and leaf prefix are trusted; only newly persisted entries are matched and stored. The source-identity check stays for every entry that is checked: "Identical text is not source identity; an optimization must not silently accept mutation under a known identity." Restoration, tree navigation, lineage change and an incompatible checkpoint rebuild the reconciled state.
3. **Trigger accounting** (amendment): render pending entries one at a time, join incrementally with the existing separator, and stop as soon as the joined estimate reaches `noting.triggerTokens`; the same joined representation as today, so there is no question of independently estimated strings being summed. Complexity is the threshold, not the backlog. The batch selection in `freezeNoting` already stops at `noting.batchTokens` and is unchanged.
4. **Immutable rendered views may be memoized in process memory**, keyed by entry id, render configuration and `ENTRY_VIEW_VERSION` ("Reuse compressed Raw views only with keys sufficient to identify the immutable source, the rendering configuration, and the view version"). Nothing persisted, no schema change.

**Amendments (user-approved 2026-09-09):**
- Bounded steps / cooperative yielding are **deferred**: after the quadratic matching is removed, the one-time import is a single synchronous pass at an explicit user command. Only if that pass still exceeds 2 s on the baseline workload does the parent's "bound its uninterrupted work" clause apply; do not build chunked preparation, in-progress markers or fences speculatively. Report the measured number either way.
- The trigger algorithm is fixed as item 3 above.

**Verbatim constraints from the parent (apply as written):**
- "Match tool results against the appropriate tool-call occurrences without rereading every preceding source entry for each result. Respect Turn boundaries, native lineage, selected ancestry, and existing ordering when tool identifiers or text repeat."
- "Reuse does not change batch membership, current-material ceilings, or the relationship between the prepared material and the exact write/audit range."
- "Enabling or recovering history does not itself authorize paid extraction, synthetic completion events, or unbounded queue draining."
- "Do not hold a write transaction across an asynchronous yield, model request, or wait for UI input."
- "Preserve … enrollment baseline rule, trigger thresholds, and ordinary-versus-manual-catchup scheduling semantics."

**Blocked by:** 22a — the path snapshot primitive and the `tests/perf/` fixture and runner.

**Status:** ready-for-agent (after 22a)

- [ ] Baseline recorded on the generated fixture before any change (audit numbers on the private copy: initial enable 21.8 s with 763,629 source reads and no yield; ordinary completed-entry callbacks 1.79–1.94 s; the trigger check alone 981 ms for 1,566 pending entries; fifty streaming updates with an unchanged leaf about 1 ms total).
- [ ] Initial enable on the baseline workload completes within 2 s; source reads are linear in the entry count (assert on a read counter or query count in the perf runner, not only on wall clock); every Raw entry, Turn, tool call and attribution is identical to the pre-change import (compare the stored rows).
- [ ] Repeated `/trace enable` reuses the reconciled sources: no duplicate Turns or entries, no second import cost.
- [ ] Ordinary memory callbacks after warm-up (a short new exchange, a tool result, `agent_end`, `agent_settled`) add at most 100 ms at p95 on the baseline workload; streaming updates with an unchanged persisted leaf stay at the recorded cheap cost; doubling the retained history does not double the cost of a fixed small appended exchange.
- [ ] The trigger check costs the same on 200 and 2,000 pending entries once the threshold is reachable, fires at exactly the same boundary as before (pin with a fixture whose joined estimate crosses 10K at a known entry), and the selected batch membership is unchanged.
- [ ] A persisted entry whose content changed under a known identity is still reported (`missing(...)`) when it is checked; a checkpoint from another lineage rebuilds; tree navigation rebuilds.
- [ ] Revert probes: (1) restore the per-result rescan and name the test that goes red on the read counter; (2) restore whole-backlog rendering in the trigger and name the test that goes red; (3) drop the identity check for trusted entries and name the test that goes red.
- [ ] `npm test`, `npm run typecheck`, `npm run smoke:pi`, `npm run smoke:package` pass; the package smoke runs the long-history regression against the installed entry ("verify that a representative long-history regression is exercised against the installed entry rather than only checkout source").
