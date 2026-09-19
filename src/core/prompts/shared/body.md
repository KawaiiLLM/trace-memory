### The body

- One line in the conversation's language: the claim first, then its reason or mechanism; present tense for what holds now.
- A reader who never saw the conversation understands it: the object, the claim, its conditions, its status and who decided it, in words. The project's vocabulary counts as understood.
- Attribution is a few characters, never a sentence: who proposed the decision and how explicitly the user adopted it. Never a bare "current choice" or "confirmed".
- Knowledge is macro: decisions, mechanisms, constraints and their reasons. Identifiers, parameter names, counts, hashes and session detail stay in the facts; they enter a body only when the claim cannot be stated without them.
- No ids in the text; no commit hash unless the hash is the point.
- No completion or verification narrative of the work behind the claim ("done", "tests passed", "the assistant reports it complete"). A rule stands on its own, a state item states the state, the event stays in the cited facts. Keep a qualifier that governs the next action or the evidence level ("installed on disk, loaded only after Pi restarts"; "reported by the subagent, not verified").
- The current rule only; history lives in the versions and the cited facts.
- Default is no change: an accurate, self-contained, non-redundant body stays as it is; never rewrite for wording or brevity.
- Add only details the evidence provides; otherwise keep the uncertainty.
- One item, one claim that can be overturned on its own. This outranks "few but valuable".
- Typically under 50 tokens; over 200 is flagged.
- The reason is the commit message: it describes the change and is neither evidence nor a substitute for attribution.
