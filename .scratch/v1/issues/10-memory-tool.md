# 10 — `memory` tool: Consolidation writes knowledge through one uniform atomic batch; marks and project become commands

**What to build:** The `memory` write tool replaces the Consolidator's JSON text output and the former `mark` tool. One operation shape (`op`, `id`, `absorb`, `text`, `category`, `scope`, `supports`, `because`) for create / update / merge / archive, plus `skipped` for range facts that form no knowledge. The two-round protocol runs through the tool: the first valid batch returns NEAR, CLOSER and the checklist without committing; the second valid batch commits after accounting and diagnostics. Marks and project declaration move to façade methods for host commands.

**Blocked by:** 09 — `note` tool.

**Status:** ready-for-agent

Spec sections "Write tools" and "Consolidation feedback loop" carry the rules. Ruling (user, 2026-09-07): four tools; mark merged away; uniform fields with full resulting state.

- [ ] One JSON schema for all operations; `because` always required; create/update/merge require text, category, scope, supports (full replacement set); `id` required for update/archive/merge and forbidden for create; `absorb` required for merge and forbidden elsewhere; archive forbids text/category/scope/supports/absorb; a field that does not apply is rejected, never ignored
- [ ] Per-item results `ok` / `rejected: <reason>`; any rejection means nothing is written; targets must exist, be active, and match the revision the run read (main-agent calls use the current revision); supports cite existing or range facts, non-empty
- [ ] merge is one transaction: survivor revision, absorbed status `merged`, links to the survivor's new revision; the absorbed item still traces to its own last revision (ticket 03 semantics)
- [ ] First valid batch of a run: not committed; NEAR and CLOSER computed over it; the tool result carries the system-generated guidance line, NEAR, CLOSER and the checklist verbatim from consolidation.md; second valid batch commits; a third submission is rejected with "already committed"; stopping after the first batch without resubmitting records the run as bounced with the batch preserved in the run record
- [ ] Accounting against the post-batch knowledge set: user facts and questions in range not cited by any resulting item must appear in `skipped`; unanswered NEAR, number-not-in-cited-facts and over-200-token remain diagnostics, never rejections
- [ ] `mark(knowledgeId, kind)` and `declareProject(sessionId, name)` on the façade; the `mark` tool and `MarkInput` deleted; marks render as before
- [ ] consolidation.md Output and second-round sections rewritten for the tool; the JSON validator and parsing removed; rulings tests pin "one operation shape, inapplicable fields rejected", "supports replaces, history keeps the old set", "merge atomic", "second submission commits, first does not"
- [ ] Ticket 03's inherited acceptance items pass through the tool path; report which tests were rewritten and which stayed
