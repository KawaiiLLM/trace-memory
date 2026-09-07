# Trace Memory — domain glossary

Terms only. No implementation detail. When a term here conflicts with usage in code or prompts, this file wins and the other side is fixed.

## Layers

- **Raw** — the conversation as the host recorded it: user messages, tool calls with results, assistant text. The only source of truth. Never edited.
- **Turn** — one user message and everything it triggered until the next user message. A compaction is also recorded as a turn, with no facts.
- **Fact** — one claim extracted from a turn that can be overturned on its own. Six categories: question, proposal, decision, observation, interpretation, event. Carries an actor (user or agent), a source address, optional verbatim quote, and relations.
- **Knowledge** — one durable, decontextualized conclusion integrated from facts. Seven categories: constraint, open, dispute, goal, mechanism, term, reference. Carries a scope, its supporting facts, a revision log.
- **Recording** — the phase in which the Recorder turns raw into facts. Runs after a turn stops.
- **Integration** — the phase in which the Integrator turns facts into knowledge and revises existing knowledge. Runs after a turn stops when enough unintegrated facts exist.

## Relations (annotations, never derived state)

- **Support** — an affirmative response from a newer fact to an older one. *Strong* only when the user explicitly adopts; *weak* for everything else, including agent agreement, an answer to a question, and execution completed.
- **Negate** — opposition from a newer fact to an older one. *Strong*: withdrawn, vetoed, found wrong, a new state overturning the old. *Weak*: doubt, objection, inconsistent evidence.
- No fact is ever hidden or retired by a relation. Relations show the Integrator the shape; the Integrator judges.
- **Dispute** — the Integrator's judgment that two accounts of the same object under the same conditions coexist without a ruling. A category of knowledge, not a relation.

## Scope and attribution

- **Session** — one host conversation. Gets an id only once an assistant reply exists.
- **Project** — the unit that shares knowledge. A session belongs to a project only by explicit declaration (a `.trace-memory` marker file found upward from cwd, or an in-session `mark(project=…)`; the in-session call wins). An undeclared session is its own project and may later be merged into another, retroactively.
- **Scope** of a knowledge item — `session` (holds only in that session), `project`, or `global` (about the user, the environment, general working method).

## Reading

- **Injection** — the memory block placed into context at session start (knowledge) and at compaction (knowledge, recent facts, raw since the watermark). Grouped by category in a fixed order; bytes change only when content changes.
- **Watermark** — the position in the raw up to which Recording has processed turns.
- **Compaction** — instant replacement of the context with the injection block. No model call.
- **Trace** — the tool that walks addresses: knowledge → its facts → the source turn; knowledge revisions (`K7@2`, `K7@2..4`); a fact's later strong negations (`F101..`). Also the project name.
- **Search** — lexical lookup over facts and knowledge (and optionally a session's raw) returning addresses. No hit does not mean absent.
- **Mark** — the main agent's only write: verified / flagged / clear on a knowledge item revision, or the session's project declaration.

## Process

- **Accounting** — after each integration run, every user fact and every question in the range must be cited by a knowledge item or listed as not admitted with a reason.
- **NEAR** — the lexically nearest existing knowledge shown for every new or edited knowledge; the Integrator must edit, merge, or state why the claim differs.
- **CLOSER** — new facts lexically near each open or goal knowledge, shown as candidate closing evidence.
- **Run record** — one record per recording or integration run holding the exact input sent to the model, the prompt version, the model, and the output. Knowledge revisions point at the run that produced them.
- **Completion level** — the prefix on an event fact: completed (result evidence visible), reported (claimed only), dispatched, attempted.
- **Local handle** — `$n`, the n-th fact of the current recording batch, used for in-batch relations before ids exist; the writer resolves it.

## Languages

Memory content is written in the language of the conversation. Everything that is work — code, comments, docs, prompts, subagent briefs — is English.
