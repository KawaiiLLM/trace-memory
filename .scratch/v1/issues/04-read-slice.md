# 04 — Read slice: inject, compact, search, mark, status

**What to build:** From a populated store: `inject(session)` returns the XML entries block (global + project + this session's session entries, category order constraints → open → dispute → goal → mechanism → term → reference, 10K budget dropping whole trailing categories, receipt after the stable content); `compact(session)` returns entries + recent facts + raw since the watermark under the 20K episodic rule (raw kept whole, facts dropped oldest first, overage stated); `search(query, scope)` returns addresses with one line; `mark` writes verified/flagged/clear bound to a revision and the session's project declaration; `status(session)` reports counts, watermark, last runs, pending deliveries.

**Blocked by:** 02 — Note slice; 03 — Settle slice.

**Status:** ready-for-agent

- [ ] Injection block bytes are identical when content is unchanged (test compares two renders across a no-op run)
- [ ] Attributes hold no counts or token numbers; dynamic receipts are appended after the block
- [ ] Compaction never calls `runAgent`; raw since the watermark is never dropped even when it alone exceeds the budget
- [ ] Visibility rule enforced: another session's session entries never appear
- [ ] `mark(verified)` binds to the current revision and is not inherited by the next revision; `clear` removes it
- [ ] FTS search over facts and entries; a `raw` scope searches one session's turns; results say that no hit does not mean absent
