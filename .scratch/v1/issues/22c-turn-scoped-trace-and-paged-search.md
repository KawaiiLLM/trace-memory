# 22c — Turn-scoped full trace, and search that formats only the requested page

**Parent:** 22 — Responsive memory processing (hotspot families 4 "Whole-session rereads during a full trace of one tool occurrence" and 5 "Eager knowledge-search formatting and repeated current-tip resolution before pagination"; section "Trace and Search"; user stories 23–29).

**What to build:** a full trace of one tool occurrence reads the target Turn's source entries once and reuses them across the Turn's tool ordinals; knowledge search applies the page cap before per-hit formatting and resolves applicability, current tips and ancestry once per query snapshot. Output is unchanged.

**Verbatim constraints from the parent (apply as written):**
- "A full tool trace should obtain the relevant Turn's native source occurrences once and reuse them across its tool ordinals. Preserve deterministic occurrence order, multiple results, metadata for unselected calls, and omission receipts." The audit's note applies: "simply deleting unselected calls was not equivalent" — the comparison must be against the complete pre-change output.
- "Apply pagination before expensive per-hit formatting. Reuse knowledge applicability, current-tip, and ancestry/descendant resolution within the query rather than rebuilding the whole revision graph for each hit."
- "Preserve the existing cursor's ownership and validation behavior, stable result ordering, and continuation semantics. New data between pages must not introduce omissions, duplicates, or inconsistent historical labels compared with the query's snapshot."
- "Do not keep a database transaction open while waiting for a caller to request another page. Reuse the existing cursor mechanism and retain sufficient stable identities or snapshot metadata instead."
- "Keep literal substring matching, escaping, topic matching, unrestricted explicit reads, and all applicable divergent tips. Pagination is not permission to drop results or choose the largest commit id as truth."

**Blocked by:** 22a — the path snapshot primitive (reused for the query-scoped applicability) and the `tests/perf/` fixture and runner.

**Status:** ready-for-agent (after 22a)

- [ ] Baseline recorded on the generated fixture before any change (audit numbers: one full tool trace in a 40-call Turn 2,312 ms loading 75,680 source entries; a Turn-scoped probe 5 ms, byte-identical; knowledge search with 500 matching revisions and `cap: 1` 2,998 ms with 1,000 current-set resolutions, 100 matches 123 ms).
- [ ] Full trace of one occurrence in a Turn with about 40 tool calls inside the long fixture: byte-identical output to the pre-change implementation, including other-call metadata, multiple native result occurrences and omission receipts; at least ten times faster; source reads scoped to the Turn (assert on the read counter).
- [ ] Knowledge search with 100, 500 and 1,000 matching revisions including historical and divergent revisions, `cap: 1`: first page within 100 ms at 500 matches; continuation through every page yields the complete, duplicate-free, stably ordered hit list with the same labels as the pre-change implementation.
- [ ] Commits arriving between two pages neither drop nor duplicate hits and do not change the historical/current labels already established by the query's snapshot; no database transaction is open between pages.
- [ ] Literal substring semantics, escaping of `%`, `_` and the escape character, topic matching via `json_each`, unrestricted explicit reads and divergent tips are pinned by the existing tests and remain green.
- [ ] Revert probes: (1) restore the per-call whole-session load in trace and name the test that goes red; (2) format all hits before paging and name the test that goes red; (3) resolve current tips per hit and name the test that goes red on the resolution counter.
- [ ] `npm test`, `npm run typecheck`, `npm run smoke:pi`, `npm run smoke:package` pass.
