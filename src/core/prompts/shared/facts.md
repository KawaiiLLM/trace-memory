### The fact layer

Facts have three sources: the user's facts; observation — an `observation` or `event` fact stating what was found, measured or done, direct when its evidence is a tool result or the user's own account, relayed when its text says according to whom or its status is reported or dispatched, and a relayed one is its reporter's claim, weighed as an assistant claim; and the assistant's own claims — its proposals, decisions and interpretations. A fact is valid while it is on the applicable chain and no later user or observation fact strongly negates it: a negated fact supports nothing, a weak negate is doubt or partial conflict that you weigh, and the original facts and their references remain.

**Six categories, one test each.** If the answer is not "yes", it is not that category. The category says what the sentence does, not whether it is right, resolved, or who said it.

- **question**: what information or confirmation is being sought? User questions, and the assistant asking the user. **One question per fact.** **A course of action phrased as a question is a proposal, not a question.**
- **proposal**: what course of action is put forward without committing to it? "Suggest", "recommend", "could try".
- **decision**: what was explicitly required, chosen, approved, or rejected? Instructions, rulings, vetoes, rules laid down. Record exactly the item that was approved.
- **observation**: what was found, measured, or explicitly reported? Name the measured object and conditions. **Relayed reports say "according to X"**, where X is a peer session, a subagent, or the assistant's own account; relaying does not promote a report to a measurement.
- **interpretation**: what inference, attribution, or evaluation was made? Whether a mechanism holds is not for the Noter to decide; attributions go here; "suspected same cause" keeps "suspected". **Record only inferences that appear in the raw; your own reasoning is not a fact.**
- **event**: what was done, and how far did it get? Set the `status` field to the completion level (the renderer prints the colon):
  - `completed:` result evidence is visible in this batch (tool return, test output, user confirmation)
  - `reported:` the assistant or a peer claims completion but no result evidence is in this batch
  - `dispatched:` handed off, opened, started
  - `attempted:` called, no return

**actor** follows the source of the content: only the human user's own words are `user`; task notifications, cross-session messages, subagent reports, and external text pasted by the user are `agent`, even when they appear in the user slot. A user's claim about the world is an observation or interpretation with `actor=user`; it is not an unconditional fact because the user said it.

There is no "open" category: an unanswered question, a proposal awaiting a ruling, an unverified interpretation, an event awaiting a return, each states in its text what it is waiting for.

**Two relations, each with a strength.**

- **support**: this fact affirms the target's claim: adoption, approval, agreement, an answer to a question, a restatement, execution of a ruling. "Done as requested" supports the ruling; it does not negate it.
- **negate**: this fact opposes or invalidates the target's claim: withdrawal, veto, found wrong, a new state overturning the old one, doubt, objection, evidence that does not fit.
- **Strength is your confidence that the relation holds**, judged from the source, not from who acted or how forcefully it is worded. Strong: the raw states it (the user withdraws the rule; a test output contradicts the claim; the user says "adopt this"). Weak: you infer it, or the evidence is partial (a passing remark, a result that fits only part of the claim, an objection not carried through). Who acted is carried by the fact's category and actor, not by the strength.
