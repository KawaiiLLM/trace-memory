# 08 — Vocabulary rename: Noting / Consolidation, facts / knowledge, K addresses

**What to build:** A mechanical rename with no behaviour change. Ruling (user, 2026-09-07, verbatim): 「工具名叫note和memory，数据库表名和概念上统一叫facts（笔记产出的条目）和knowledge（结算产出的条目），两个阶段叫记录、整合（英文Noting / Consolidation， Noter / Consolidator），不用原来的笔记和结算」. After it, no identifier, table, prompt, config key, address prefix, comment, README or spec sentence uses note/settle/entry/settlement for these concepts.

**Blocked by:** None — can start immediately.

**Status:** ready-for-agent

Wide refactor: apply as one change across the repository; the suite must be green at the end, with the same number of tests.

- [ ] Modules `core/noting`, `core/consolidation`; prompts `noting.md`, `consolidation.md` (headings and body vocabulary updated: Noter, Consolidator, knowledge); façade `record`, `integrate`, `NotingInput`, `ConsolidateInput`, and the agent-input `kind` values `noting` | `consolidation`
- [ ] Run kinds `noting` | `consolidation`; configuration sections `noting.*` and `consolidation.*` (`noting.branchModeDefault`, `noting.triggerAnsweredTurns`, `noting.triggerTokens`, `consolidation.subagentModeDefault`, `consolidation.triggerUnsettledFacts` → `consolidation.triggerUnconsolidatedFacts`, `consolidation.nearThreshold`); watermark column `last_consolidated_fact`; the Pi host env keys and README follow
- [ ] Tables `knowledge`, `knowledge_revisions`, `knowledge_links`, `knowledge_marks`; columns `knowledge_id`; FTS names; store methods and types (`Knowledge`, `KnowledgeRevision`, `KNOWLEDGE_CATEGORIES`, `KNOWLEDGE_SCOPES`, …); no migration of old databases (v1 is unreleased; state this in the README)
- [ ] Address prefix `K<n>` replaces `E<n>` everywhere (parser, renderer, prompts, goldens, tests, README, spec); `F`, `T`, `S` unchanged
- [ ] Injection block tags and the compaction block follow (`<knowledge>` for the former entries block); pending_notes delivery tag becomes `<noted>`
- [ ] Ruling tests keep their names and dates; only vocabulary inside changes; report the test count before and after
- [ ] spec.md and the remaining tickets swept for the old words; the "Vocabulary" section stays as the record of the ruling
