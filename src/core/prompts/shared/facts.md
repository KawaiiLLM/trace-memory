### Facts

A fact is one topic's slice over a continuous stretch of conversation, restoring what happened. It may span entries and Turns. Its short, nonempty, single-line `title` identifies the episode; it does not replace the body.

Its nonempty `sources` contain one `{address,text}` segment per contributing whole entry. Each segment has nonempty text describing that source's contribution to the topic. Core orders segments by path and joins them with line breaks into the fact's `text`; the writer supplies no separate body.

Each cited entry has a core-derived `role`:
- `user` — a user's message.
- `assistant` — the original agent's message or tool call.
- `observation` — a tool result; this does not mean its content was independently verified.

An `address` names a whole entry, such as `T123#E2`, never an internal block or thinking-only entry. Assistant sources retain their original harness (Pi agent or Claude Code), not the executor's harness. A relayed report retains the role of the entry relaying it.

Progress and necessary verbatim wording belong in the source segments. A new fact has no fact-wide category, actor, status or quote. Historical rows retain those fields and their stored source strings unchanged.

**Optional relations, each strong or weak.**
- **support** — this fact affirms the target: adoption, approval, agreement, an answer, a restatement, execution of a ruling.
- **negate** — this fact opposes the target: withdrawal, veto, correction, a changed state, doubt or contrary evidence.
- **strong** — the Raw states the relation explicitly. **weak** — the relation is inferred or its evidence is partial.

Strength describes how the evidence supports or negates the target, not the tone of agreement or objection.
