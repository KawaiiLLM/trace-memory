# 03c — Settle slice, part 2: accounting, apply, lifecycle

Split of ticket 03. Spec: .scratch/v1/spec.md. Glossary: CONTEXT.md. Prompt: core/prompts/settle.md. English only in the repo; fixture memory content stays in its conversation language. Follow the patterns of tickets 01–02 (core/README.md); no host SDK imports; no new store tables (read methods may be added); reuse core/render for every line.

**What to build:** The commit half of a settle run through the façade: accounting against the entry set as it will be after applying the final round (every user fact and question in range cited by a resulting entry or listed in `not_admitted`; otherwise bounce with the list); apply new/edit/merge/delete as revisions through `commitSettleRun` in one transaction with the run record and `lastSettledFact` advanced to the frozen range end; diagnostics (numbers in entry text not found in cited facts, entries over 200 tokens, NEAR left unanswered) reported in the run record, never rejecting. A revision conflict rejects only that operation and the rest commit; the watermark still advances; facts whose only citation was in a rejected operation are listed in the run record as a diagnostic (they stay in the store; the next settlement reads the moved entries at their new revisions). Merge links per the store contract.

**Blocked by:** 03b.

**Status:** ready-for-agent

- [ ] Accounting bounce and acceptance of `not_admitted`; accounting evaluated on the post-apply set
- [ ] Revision conflict rejects one operation, the rest commit, watermark advanced in the same transaction, lost-citation diagnostic recorded
- [ ] Merge records the survivor's revision and links the absorbed entry; both trace correctly
- [ ] Number and 200-token diagnostics reported, not rejected; unanswered NEAR committed with a diagnostic
- [ ] End-to-end settle through the façade on a fixture cut from the simulation data
