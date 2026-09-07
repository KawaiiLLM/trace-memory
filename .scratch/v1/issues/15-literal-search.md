# 15 — Search: one literal substring semantics for facts, knowledge and raw

**What to build:** `search` finds content that contains the query text, literally, in all three layers. No tokenizer, no query syntax, no ranking. Chinese of any length, mixed Chinese and Latin, paths, and literal `%` or `_` all work the same way. The FTS5 tables and their triggers, which no longer serve any query, are deleted.

**Blocked by:** 14 — Branch Noting input.

**Status:** ready-for-agent

Adopted by the user on 2026-09-07 from a search review: unify on literal search now; consider trigram plus LIKE only when data size and latency are measured; relevance ranking is a separate decision if ever needed.

- [ ] `searchAddresses` uses parameterized `LIKE … ESCAPE '\'` over `facts.text`, `knowledge_revisions.text` (every revision, so history is searchable) and, for `raw`, turns and tool calls as today; the query is escaped so `%`, `_` and `\` match themselves; results keep their current ordering (by id) and the current visibility filter; `layer` keeps its four values
- [ ] The `facts_fts` and `knowledge_revisions_fts` virtual tables, their triggers, and the "Indexes: FTS" line in the spec are removed; the tool description says literal substring search, not FTS
- [ ] Tests: the three measured failures (`美琴` in 御坂美琴的电击, `pnpm` in 使用pnpm而不是npm, `不要` in 用 pnpm，不要 npm) plus a single character, Chinese adjoining Latin, a path, a literal `%` and `_`; an older knowledge revision is found by its old text; another project's content is not returned; a result set larger than `cap` is fully reachable through `cursor`
- [ ] Production line count goes down; report the delta and the removed DDL
