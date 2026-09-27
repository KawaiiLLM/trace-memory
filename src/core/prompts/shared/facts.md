### Facts

A fact is one topic's slice over a continuous stretch of conversation. Its short, nonempty, single-line `title` names what happened, not just the conclusion. A slice may draw on several entries and Turns.

Its `sources` each contain an `address` for one contributing whole entry and `text` for that entry's contribution. Core orders the segments by the selected path and joins their text into the body. Each source's role comes from its entry, not the writer.

A new fact has no fact-wide category, actor, status or quote. Historical rows retain those fields and their stored source strings unchanged.

Each cited entry has a core-derived `role`:
- `user` — a user's message.
- `assistant` — an agent message or tool call.
- `observation` — a tool result.

Assistant sources show their original harness (Pi agent or Claude Code), not the executor's harness. A report quoted by a user remains a user entry; an agent claiming an observation remains an assistant entry. The fact text names who said or did each thing and distinguishes evidence from claims.

**Optional relations, each strong or weak.**
- **support** — this fact affirms the target: adoption, approval, agreement, an answer, a restatement, execution of a ruling. "Done as requested" supports the ruling.
- **negate** — this fact opposes or invalidates the target: withdrawal, veto, found wrong, a new state overturning the old, doubt, objection, evidence that does not fit.
- **strong** — the raw states the relation (the user withdraws the rule; a test output contradicts the claim; the user says "adopt this"). **weak** — the relation is inferred, or the evidence is partial (a passing remark, a result fitting only part of the claim, an objection not carried through).
