# 09 — Entry tool: settlement writes through `entry`, mark folded in, feedback round by tools

**What to build:** The `entry` write tool replaces the settle run's JSON text output and the former `mark` tool. Operations: `new`, `edit`, `merge`, `archive`, `mark`, `decline`, `near_ack`, `withdraw`, validated per operation with immediate results. A settle run stages the candidate operations, the system sends the NEAR/CLOSER/checklist feedback as one user message, the model adds or withdraws operations (or stops without calling), and the run commits after accounting and diagnostics exactly as today. A main-agent `entry` call (including `mark`) commits at once as a `manual` run.

**Blocked by:** 08 — Fact tool.

**Status:** ready-for-agent

Ruling (user, 2026-09-07, verbatim): 「mark可以合并掉，最终4个工具，trace search和两个分别操作事实和记忆。主agent允许用，但无需提示用，本身不是它的职责」. Spec sections "Write tools" and "Settle feedback loop" carry the derived rules.

- [ ] `entry` operations validate per item (targets exist and revisions match the frozen read set, supports non-empty and cite existing or range facts, category and scope enums, `decline` names a range fact, `near_ack` names a candidate handle and an entry, `withdraw` names a staged handle) and answer per item with `staged as $e<n>` / `staged` / `rejected: <reason>`
- [ ] The candidate round ends when the model stops; NEAR and CLOSER are computed over the staged set; the feedback message is unchanged in content (system-generated guidance plus the checklist); the final round may add or withdraw; stopping without a call commits the staged set unchanged
- [ ] Accounting runs against the entry set after applying the staged operations; `decline` replaces `not_admitted`; unanswered NEAR is a diagnostic; number-not-in-cited-facts and over-200-token diagnostics unchanged
- [ ] Revision conflict rejects that operation at staging time with the reason; merge, archive, links, and the absorbed entry's tracing behave as in ticket 03c
- [ ] `mark` sets verified/flagged/clear on the entry's current revision; the former `mark` tool and `MarkInput` project branch are deleted; project declaration moves to `declareProject(sessionId, name)` on the façade
- [ ] A main-agent `entry` call commits at once as a `manual` run; its revisions carry that run id
- [ ] settle.md Output and second-round sections rewritten for the tool; `validateSettleOutput` and JSON parsing removed; rulings tests pin "mark is an entry operation", "a rejected operation does not block its siblings", and "the final round commits unchanged when the model stops without calling"
- [ ] Ticket 03's inherited acceptance items still pass through the tool path; report which tests were rewritten and which stayed
