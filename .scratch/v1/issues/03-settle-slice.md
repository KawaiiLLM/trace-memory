# 03 — Settle slice: facts in, entries out, diffable

**What to build:** A settle run over a fact range: builds the input (all range facts with relation annotations, context facts by freshness, visible entries), runs the two-round loop (candidates → NEAR and CLOSER feedback → final), runs accounting against the post-apply entry set, and applies new/edit/merge/archive as revisions with links, all in one transaction with the run record. `trace E<n>` shows the current text, supports, and revision summary; `E<n>@<rev>` shows a snapshot; `E<n>@a..b` shows the diff; `F<n>..` walks later strong negations with branches.

**Blocked by:** 02 — Note slice.

**Status:** ready-for-agent

- [ ] Settle triggers when unsettled facts reach the configured count; the range and read revisions are frozen at start
- [ ] The initial input separately lists all visible active entries whose current supports contain a fact negated by a range fact, with both facts and the recorded strength through the shared renderer. Test multiple entries citing the same negated fact, strong and weak negations, unrelated entries excluded, and visibility preserved. Listing alone changes no status and requires no new acknowledgement; a settler may retain an entry unchanged.
- [ ] NEAR uses lexical similarity over active entries; CLOSER lists range facts near open and goal entries; both appear only in the feedback round
- [ ] The second model call receives one user-role feedback message combining NEAR/CLOSER with the settle prompt's evidence-review checklist. No issues means submitting the candidate JSON unchanged; otherwise submit corrected complete JSON. No checklist report, new acknowledgement fields, or third review round. Test both unchanged and corrected final outputs and assert the checklist is included in the second request; system feedback must not be treated as a human ruling.
- [ ] Unanswered NEAR after the final round commits with a diagnostic; accounting lists uncited user facts and questions after applying the round; each must be cited or in `not_admitted`
- [ ] Revision conflict rejects that operation only; the rest commit; creation is revision 1; `because` and `supports` stored separately
- [ ] Merge records the survivor's new revision and links the absorbed entry to that revision; the absorbed entry still traces to its own last revision
- [ ] `E<n>@a..b` diff: changed spans within the line, supports added and removed, category and scope changes, intermediate revisions listed with their triggering facts
- [ ] `F<n>..` renders "later strong negations", branching, ending with "no later strong negation recorded"
- [ ] Number-not-in-cited-facts and over-200-token entries are diagnostics, never rejections
