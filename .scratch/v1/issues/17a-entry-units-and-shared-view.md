# 17a — Entry units and the shared compressed Raw view

**Parent:** 17 — Entry Recording and closed-session catch-up (this file carries the slice; the parent carries the rulings, defaults and full decisions).

**What to build:** the plugin's source unit becomes a completed Pi session entry (user text, assistant content with its tool calls, or a tool result) with a stable native identity, its owning Turn and a stable tool ordinal, while Turn addresses (`T<id>#user`, `T<id>#assistant`, `T<id>#t<n>`) keep their meaning. One renderer produces the compressed view of an entry under two limits, tool call first (1,000 tokens over arguments plus result) then whole entry (10,000 tokens including labels and omission markers), and that same view is what the subagent Recording input, the subagent fallback, the compaction block and the branch carry supply. Explicit `trace` reads still return the original. Recording progress is tracked per entry on a path, and a run freezes its exact entry set; nothing in this slice changes when runs start.

**Blocked by:** None. Held until the user releases ticket 17 (「先不执行」, 2026-09-07).

**Status:** ready-for-agent (held)

- [ ] Ordinary text, CJK, one huge line, a huge JSON argument, several tool calls in one assistant entry and a late-arriving tool result all render within both limits by the shared estimator, with source labels and omission markers counted inside the budget.
- [ ] The same entry renders byte-identically in the subagent Recording input, the fallback input, the compaction block and the branch carry; compaction and tree-summary preparation make no provider call.
- [ ] Original arguments and results are stored unchanged and readable through `trace`; an excerpt never claims its omitted middle was inspected.
- [ ] Branch-mode Recording still appends only the range, head reply and source index to the uncompressed native prefix; the host documentation says the compressed view does not apply to it.
- [ ] A run frozen midway through a Turn neither consumes nor may cite an entry appended after the freeze; existing Turn and tool addresses resolve after reopen.
- [ ] Attach-time reconciliation reuses known entries by identity, queues unknown ones and surfaces missing native history; no migration of Turn-based coverage exists.
- [ ] Revert probe: measuring original instead of compressed tokens, or advancing whole Turns instead of entries, makes a named test fail.
