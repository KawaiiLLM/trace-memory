### Facts

A situational slice of one topic over a continuous stretch of time, restoring what happened then. One fact may span Turns and gather many Raw entries; slicing too finely loses the narrative thread.

The writer fills:

- **`title`**: a one-line situational title saying what this discussion or work was doing, for recognition and lookup. It is not only the final conclusion and does not replace the body.
- **`sources`**: one `{address, text}` segment per contributing entry. `address` is the entry's address; `text` summarizes only that entry's contribution to this topic. One entry gets one segment within a fact.
- **`support`** and **`negate`** (optional): relations to existing facts, each naming the target fact and a strength.
  - `support`: this fact affirms the target, such as adoption, approval, agreement, an answer, a restatement or execution of a ruling.
  - `negate`: this fact opposes the target, such as withdrawal, veto, correction, a changed state, doubt or contrary evidence.
  - Strength is `strong` when the entries state the relation explicitly, and `weak` when it is inferred or the evidence is incomplete. Strength follows the evidence, not the tone.

The system generates the id (such as `F123`), each segment's role and the body, joining the segments in order of occurrence. The writer writes no separate body and fills no fact-level category, status, speaker or quote. Progress and necessary verbatim wording go in the source segments.
