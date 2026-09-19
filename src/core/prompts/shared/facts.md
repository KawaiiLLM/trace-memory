### Facts

A fact is one line of plain text with a `category`, an `actor`, a `status` for events, an optional `quote`, its `source` entries and its relations.

**Three sources.**
- user — the user's own words.
- observation — an `observation` or `event` fact. Direct when its evidence is a tool result or the user's own account; relayed when its text says according to whom or its status is `reported` or `dispatched`. A relayed observation is its reporter's claim and weighs as an assistant claim.
- assistant — the assistant's proposals, decisions and interpretations.

**Validity.** A fact is valid while it is on the applicable chain and no later user or observation fact strongly negates it. A negated fact supports nothing. A weak negate is doubt or partial conflict: weigh it. The original facts and their references remain.

**Six categories, one test each.** The category says what the sentence does, not whether it is right, resolved, or who said it. If no test answers yes, it is not that category.
- **question** — what information or confirmation is sought, by the user or by the assistant asking the user? A course of action phrased as a question is a proposal.
- **proposal** — what course of action is put forward without commitment? "Suggest", "recommend", "could try".
- **decision** — what was explicitly required, chosen, approved or rejected? Instructions, rulings, vetoes, rules laid down. Record exactly the item that was approved.
- **observation** — what was found, measured or explicitly reported? Name the object and the conditions. A relayed report says "according to X" (a peer session, a subagent, the assistant's own account); relaying does not make it a measurement.
- **interpretation** — what inference, attribution or evaluation was made, as the raw states it? "Suspected same cause" keeps "suspected".
- **event** — what was done, and how far did it get? `status` says how far:
  - `completed` — result evidence is in this batch (tool return, test output, user confirmation)
  - `reported` — the assistant or a peer claims completion; no result evidence is in this batch
  - `dispatched` — handed off, opened, started
  - `attempted` — called, no return

**actor** is who wrote the words: `user` only for the human user's own words; `agent` for task notifications, cross-session messages, subagent reports and text the user pasted, even in the user slot. A user's claim about the world is an observation or interpretation with `actor=user`, not an unconditional fact.

There is no open category: a question, proposal, interpretation or event that awaits something states in its text what it waits for.

**Two relations, each strong or weak.**
- **support** — this fact affirms the target: adoption, approval, agreement, an answer, a restatement, execution of a ruling. "Done as requested" supports the ruling; it does not negate it.
- **negate** — this fact opposes or invalidates the target: withdrawal, veto, found wrong, a new state overturning the old, doubt, objection, evidence that does not fit.
- **strong** — the raw states the relation (the user withdraws the rule; a test output contradicts the claim; the user says "adopt this"). **weak** — you infer it, or the evidence is partial (a passing remark, a result fitting only part of the claim, an objection not carried through). Strength is your confidence in the relation, never who acted or how forcefully it was said.
