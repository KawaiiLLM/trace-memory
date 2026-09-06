# 03b — Settle slice, part 1: frozen input, reminders, two rounds

Split of ticket 03. Spec: .scratch/v1/spec.md. Glossary: CONTEXT.md. Prompt: core/prompts/settle.md. English only in the repo; fixture memory content stays in its conversation language. Follow the patterns of tickets 01–02 (core/README.md); no host SDK imports; no new store tables (read methods may be added); reuse core/render for every line.

**What to build:** A settle run's model-facing half through the façade: freeze the fact range and read entry revisions at start; build the input (all range facts with relation annotations, context facts by freshness, visible entries per the visibility rule, and the negated-evidence reminder listing every visible active entry whose current supports contain a fact negated by a range fact, with both facts and the recorded strength); call `runAgent` for the candidate round; compute NEAR (lexical nearest active entries per candidate text, threshold configurable) and CLOSER (range facts near open and goal entries); send one user-role feedback message containing NEAR, CLOSER and the settle prompt's second-round checklist verbatim; call `runAgent` for the final round; validate with core/model. Every attempt is recorded as a run (candidate round, final round, bounces, failures); this part commits no entry writes yet — the final validated output is returned to the caller (part 03c applies it). A repeated trigger while a run is in flight is dropped.

**Blocked by:** 03a — Trace slice (tests observe through trace).

**Status:** ready-for-agent

- [ ] Range and read revisions frozen at start; input rendered through core/render
- [ ] Reminder lists multiple entries citing the same negated fact, strong and weak, excludes unrelated entries and other sessions' session entries; it derives no status
- [ ] NEAR and CLOSER appear only in the feedback round; the checklist text is byte-identical to the prompt's section and marked as system guidance
- [ ] Both an unchanged and a corrected final output are accepted; bounces return the problem list; all attempts have run records with the exact provider request
- [ ] Duplicate trigger dropped
