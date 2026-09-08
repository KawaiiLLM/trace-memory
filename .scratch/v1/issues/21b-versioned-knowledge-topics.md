# 21b — Versioned knowledge topics: storage, rendering, grouping and search

**Parent:** 21 — Commit reasons and knowledge topics (sections "Versioned topics", "Rendering, grouping and search"; acceptance scenarios 10–15 and the topic half of 17).

**What to build:** knowledge content commits carry a `topics` string array on the immutable revision: required for create, update and merge as the complete replacement set (an empty array means unclassified or explicitly cleared; merge supplies the survivor's full set, no implicit union), not accepted on archive, which inherits its parent's array. Labels are strings, trimmed, nonempty, exact duplicates removed into a deterministic order; no case folding, translation, synonym merge, hierarchy or primary-topic meaning. Topics are classification only: they change no scope, evidence permission, lifecycle, eligibility or progress, and sharing a label merges nothing. The Consolidator reuses the topic names visible beside the supplied knowledge, uses module names and domain terms rather than category words, may add a new label, and may leave the list empty. The shared knowledge renderer (20a) shows topics as metadata beside text, category, scope and commit address for every automatic consumer, counted inside 20b's knowledge cap with no duplication of a multi-topic item and nothing task-specific in the leading block. Structured knowledge reads expose topics so consumers can group applicable revisions by topic without cloning K identities; unclassified items stay available. Literal knowledge search matches label text with the existing substring semantics and escaping, one result per exact commit however many labels match. Explicit reads keep their historical, archived and superseded labels; grouping never collapses divergent applicable tips.

**Storage (user via GPT, 2026-09-08):** a JSON column on `knowledge_revisions`, matching how supports are stored; label matching through SQLite `json_each` with `EXISTS`, so JSON punctuation never matches and one commit never repeats. No topics table, registry, catalog injection, fact-level tags or fifth tool.

**Blocked by:** 21a — Unified commit evidence and reason (the tool schema and prompt change once more, on top of 21a's).

**Status:** ready-for-agent (after 21a)

- [ ] Scenario 10: several labels, empty arrays, surrounding whitespace, duplicates, malformed arrays and empty labels follow the declared normalization; reordering the same set renders the same metadata.
- [ ] Scenario 11: a topic-only update is an ordinary update with a reason; old commits keep old labels; clearing is explicit; merge supplies the full set; archive inherits.
- [ ] Scenario 12: one topic across categories and one commit under two topics; structured reads group both without cloning; search by a label absent from the text finds the commit once.
- [ ] Scenario 13: labels with Chinese, spaces, percent, underscore, quotes or backslashes match literally, not as JSON syntax; empty topics hide nothing.
- [ ] Scenario 14: matching labels on sibling-only, historical, archived and multi-tip knowledge change no applicability; injection excludes inapplicable revisions; grouping picks no largest id.
- [ ] Scenario 15: all four consumers render topics through the one core renderer; labels count in the knowledge budget; a multi-topic item appears once; identical selected revisions and topics give identical leading bytes when only Raw or range changes.
- [ ] Scenario 17: facts and `note` gain no topics field; the main agent gains no duty; the tool count stays four; no catalog is injected and no model is called for storage.
- [ ] Revert probes: topics stored on K instead of the revision, labels escaping the knowledge budget, and a search returning one commit twice each make a named test fail.
