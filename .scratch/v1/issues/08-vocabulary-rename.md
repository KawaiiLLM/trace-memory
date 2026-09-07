# 08 — Vocabulary rename: Recording / Integration, facts / knowledge, K addresses

**What to build:** A mechanical rename with no behaviour change. Ruling (user, 2026-09-07, verbatim): 「工具名叫note和memory，数据库表名和概念上统一叫facts（笔记产出的条目）和knowledge（结算产出的条目），两个阶段叫记录、整合（英文Recording / Integration， Recorder / Integrator），不用原来的笔记和结算」. After it, no identifier, table, prompt, config key, address prefix, comment, README or spec sentence uses note/settle/entry/settlement for these concepts.

**Blocked by:** None — can start immediately.

**Status:** ready-for-agent

Wide refactor: apply as one change across the repository; the suite must be green at the end, with the same number of tests.

- [ ] Modules `core/recording`, `core/integration`; prompts `recording.md`, `integration.md` (headings and body vocabulary updated: Recorder, Integrator, knowledge); façade `record`, `integrate`, `RecordInput`, `IntegrateInput`, and the agent-input `kind` values `recording` | `integration`
- [ ] Run kinds `recording` | `integration`; configuration sections `recording.*` and `integration.*` (`recording.branchModeDefault`, `recording.triggerAnsweredTurns`, `recording.triggerTokens`, `integration.subagentModeDefault`, `integration.triggerUnsettledFacts` → `integration.triggerUnintegratedFacts`, `integration.nearThreshold`); watermark column `last_integrated_fact`; the Pi host env keys and README follow
- [ ] Tables `knowledge`, `knowledge_revisions`, `knowledge_links`, `knowledge_marks`; columns `knowledge_id`; FTS names; store methods and types (`Knowledge`, `KnowledgeRevision`, `KNOWLEDGE_CATEGORIES`, `KNOWLEDGE_SCOPES`, …); no migration of old databases (v1 is unreleased; state this in the README)
- [ ] Address prefix `K<n>` replaces `E<n>` everywhere (parser, renderer, prompts, goldens, tests, README, spec); `F`, `T`, `S` unchanged
- [ ] Injection block tags and the compaction block follow (`<knowledge>` for the former entries block); pending_notes delivery tag becomes `<recorded>`
- [ ] Ruling tests keep their names and dates; only vocabulary inside changes; report the test count before and after
- [ ] spec.md and the remaining tickets swept for the old words; the "Vocabulary" section stays as the record of the ruling
