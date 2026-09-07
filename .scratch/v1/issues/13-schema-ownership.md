# 13 — Schema: business ownership as columns, constraints in the database

**What to build:** No behaviour change. The relationships that business queries already depend on become explicit columns and constraints instead of being recovered from audit JSON or revision history. Adopted by the user on 2026-09-07 (「可以」) from a store review.

**Blocked by:** None — can start immediately.

**Status:** ready-for-agent

- [ ] `facts.run_id` (NOT NULL, REFERENCES runs) written at commit for noting and manual runs; `deliver()` selects the run's facts by `run_id`; `listBranchFacts()` distinguishes manual facts through `runs.kind` and `runs.branch` by JOIN; no query reads `factIds` from `runs.response` (the field may stay in the audit JSON)
- [ ] `knowledge.origin_session_id` (REFERENCES sessions), set once at create and never updated; `isKnowledgeVisible`, `listVisibleKnowledge`, and project merge use it instead of walking revision 1 → run → session
- [ ] `facts.created_at` renamed `source_time` (the first source turn's `started_at`); the fact's noting time is its run's `created_at`; renderer output unchanged in content
- [ ] Database constraints: `UNIQUE(knowledge_id, rev)` on knowledge_revisions; `UNIQUE(turn_id, ordinal)` on tool_calls; `UNIQUE(session_id, ordinal)` on turns; `UNIQUE(knowledge_id, rev)` on knowledge_marks (one current mark per revision); knowledge_links ends reference `(knowledge_id, rev)`; watermarks reference sessions, turns and facts; a CHECK on facts that `status` is present exactly when `category = 'event'`
- [ ] The `ALTER TABLE facts ADD COLUMN status` compatibility branch is deleted: v1 is unreleased and the README says older databases are not read
- [ ] Tests: duplicate revision, duplicate tool ordinal, duplicate turn ordinal, and a status/category mismatch are rejected by the database; deliveries and branch facts still behave as the existing tests assert; the test that seeded runs without facts adjusts to the NOT NULL run_id
- [ ] Report the production line delta (expected negative or flat), test count before and after, and every query that stopped parsing JSON or walking history
