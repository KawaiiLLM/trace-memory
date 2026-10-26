### Facts

A situational slice of the finest topic, keeping its narrative; a fact may span Turns and group same-topic statements even when not adjacent.

The writer fills:

- **`title`**: a one-line index for recognition and lookup: name the object and the activity, enough to recognize and find it. Do not narrate the course of events or restate the body.
- **`sources`**: one `{address, text}` segment per contributing entry. `address` is the entry's address; `text` summarizes only that entry's contribution to this topic. One entry gets one segment within a fact.
- **`objects`**: the specific things a developer of this project identifies at once, by their full current names; resolve coreferences and include every object case-insensitively in the body.
  - Yes: a project or repository (trace-memory), a component (Noter, Dreamer), a file or function (`src/core/store/index.ts#commitGraph`), a setting (`dreaming.triggerKnowledge`), a tool (omp, Codex), a named mechanism or rule of the project (the “possibly outdated” flag, the shared prefix), a ticket or commit, a session, or a person or agent when the fact is about them.
  - No: class words such as project, file, session, knowledge, fact, test or prompt.
  - A ticket, commit or session never stands alone: name the mechanism it implements or the problem it solves as an object too.
- **`caused_by`** and **`negate`** (optional): relations to visible facts, each naming the target and a strength.
  - `caused_by`: the source explicitly states an outcome caused by the target; at most two per fact. It is an annotation, never a knowledge-update trigger; `support` remains readable on old facts but is refused on new ones.
  - `negate`: this fact opposes the target, such as withdrawal, veto, correction, a changed state, doubt or contrary evidence.
  - Strength is `strong` when the entries state the relation explicitly, and `weak` when it is inferred or the evidence is incomplete. Strength follows the evidence, not the tone.

The system generates the id (such as `F123`), each segment's role and the body, joining the segments in order of occurrence. The writer writes no separate body and fills no fact-level category, status, speaker or quote. Progress and necessary verbatim wording go in the source segments.
