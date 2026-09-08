# 21a — One evidence list per knowledge commit, with a reason

**Parent:** 21 — Commit reasons and knowledge topics (sections "Unified evidence and commit messages", "Archive and path safety", the reason parts of "Rendering, grouping and search", "Storage and compatibility" as amended below; acceptance scenarios 1–9 and the reason half of 17).

**What to build:** every new knowledge operation carries one nonempty `supports` fact array, meaning the evidence for this commit, and one nonempty `reason` string, the commit message. The commit-level `because` array is removed from new write input and rejected by name (the same shape 18a uses for unknown keys); `skipped[].because` is untouched. Archive accepts target, supports and reason, writes an archive revision that keeps those supports (no more empty-supports archive), and inherits scope, category and topics from its parent; any other field on archive stays an inapplicable-field error. Every new commit's supports drive scope validation and entry-aware path applicability exactly as today; reason never establishes evidence, scope, applicability, accounting or completion, and core never parses addresses out of it. Accounting gains one narrow rule: a range fact cited by a successfully applied archive in this batch counts as archival evidence and needs no duplicate `skipped` entry. Commit trace, history, diffs and run operation results show the reason; routine knowledge blocks do not repeat it. The Consolidator prompt, the `memory` tool schema and description, the glossary and the spec change together (the prompt hash moves; the fork gate is re-verified against the updated parent request in the existing gate tests, never assumed).

**Rulings amended on review (user via GPT, 2026-09-08):** no migration and no read-side legacy compatibility — the parent's "Storage and compatibility" atomic upgrade, the `supports ∪ because` read rule and scenario 16 are deleted; v1 keeps its new-database policy and never deletes an existing database. The `because` column is replaced in the schema by `reason TEXT NOT NULL` (user, 2026-09-08: nothing reads the old column once migration is gone, so it does not stay); a database written by the earlier schema is not read, as with every earlier schema change.

**Blocked by:** 20c — Compaction escalation (ticket 20 lands whole before the knowledge model changes; the order is 20b → 20c → 21a → 21b).

**Status:** ready-for-agent (after 20c)

- [ ] Scenario 1: create, update, merge and archive accept valid supports and reason; archive keeps nonempty supports of its own; omitted, wrongly typed or empty required values reject the whole batch.
- [ ] Scenario 2: a commit-level `because` on any new operation is rejected by name, also beside valid new fields; `skipped[].because` still works.
- [ ] Scenario 3: an update needs evidence for its complete result; correction and withdrawal facts among supports are not treated as contradictory; addresses inside a reason add no supports.
- [ ] Scenario 4: an archive based on an A-only fact retires the knowledge on A while B and the shared ancestor keep the former commit, with several source entries in one Turn so a Turn-only check cannot pass.
- [ ] Scenario 5: session, project and global citation rules apply to every new support including archives; reason text cannot bypass them.
- [ ] Scenarios 6 and 7: the two-submission review and batch atomicity are unchanged; one bad reason or support commits nothing; stale-base rejection still holds.
- [ ] Scenario 8: archival accounting as ruled; a rejected or candidate-only archive, an address in a reason, or a matching topic gives no coverage.
- [ ] Scenario 9: reason appears in trace, history and diffs and never as conclusion evidence; a reason-only change is visible; the numeric-evidence diagnostic never runs on the reason.
- [ ] The fork gate tests pass with the updated prompt and tool schema (re-run, not assumed).
- [ ] Revert probes: an archive that clears supports again, a reason parsed into citations, and a commit-level `because` silently accepted each make a named test fail.
