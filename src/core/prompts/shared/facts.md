### Facts

A situational slice of the finest topic, keeping its narrative; a fact may span Turns and group same-topic statements even when not adjacent.

The writer fills:

- **`title`**: a one-line index for recognition and lookup: name the object and the activity, enough to recognize and find it. Do not narrate the course of events or restate the body.
- **`sources`**: one `{address, text}` segment per contributing entry. `address` is the entry's address; `text` summarizes only that entry's contribution to this topic. One entry gets one segment within a fact.
- **`objects`**: full current names of the key things the fact says something about; resolve coreferences and include every object case-insensitively in the body.
- **`caused_by`** and **`negate`** (optional): relations to visible facts, each naming the target and a strength.
  - `caused_by`: the source explicitly states an outcome caused by the target; at most two per fact. It is an annotation, never a knowledge-update trigger; `support` remains readable on old facts but is refused on new ones.
  - `negate`: this fact opposes the target, such as withdrawal, veto, correction, a changed state, doubt or contrary evidence.
  - Strength is `strong` when the entries state the relation explicitly, and `weak` when it is inferred or the evidence is incomplete. Strength follows the evidence, not the tone.

The system generates the id (such as `F123`), each segment's role and the body, joining the segments in order of occurrence. The writer writes no separate body and fills no fact-level category, status, speaker or quote. Progress and necessary verbatim wording go in the source segments.
