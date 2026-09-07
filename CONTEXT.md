# Trace Memory — domain glossary

Terms only. No implementation detail. When a term here conflicts with usage in code or prompts, this file wins and the other side is fixed.

## Layers

- **Raw** — the conversation as the host recorded it: user messages, tool calls with results, assistant text. The only source of truth. Never edited.
- **Source entry** — one completed native conversation message: user text, assistant content with tool calls, or a tool result. Identity is its native id within the session lineage, never its text. It belongs to a Turn; plugin injections and summaries are never sources.
- **Compressed Raw view** — the shared, bounded head/tail excerpt of one source entry, with source labels and honest omission counts. The original Raw remains available through trace.
- **Turn** — one user message and everything it triggered until the next user message. A compaction is also recorded as a turn, with no facts.
- **Fact** — one claim extracted from a turn that can be overturned on its own. Six categories: question, proposal, decision, observation, interpretation, event. Carries an actor (user or agent), a source address, optional verbatim quote, and relations.
- **Knowledge** — one durable, decontextualized conclusion consolidated from facts. Seven categories: constraint, open, dispute, goal, mechanism, term, reference. Carries a scope, its supporting facts, a revision log.
- **Noting** — the phase in which the Noter turns raw into facts. Each eligible entry completion checks for 10,000 pending compressed-view tokens; a run processes the oldest whole-entry prefix within 50,000 tokens and the model context capacity. A partly processed Turn may still have pending entries.
- **Consolidation** — the phase in which the Consolidator turns facts into knowledge and revises existing knowledge. Each eligible entry completion checks for fifty applicable unconsolidated committed facts, including facts of partly recorded Turns. Worker completion, compaction, shutdown and tree switching launch neither phase.

## Relations (annotations, never derived state)

- **Support** — a newer fact affirms an older one: adoption, approval, agreement, an answer, a restatement, execution of a ruling.
- **Negate** — a newer fact opposes or invalidates an older one: withdrawal, veto, found wrong, a new state overturning the old, doubt, objection, evidence that does not fit.
- **Strength** — the Noter's confidence that the relation holds: *strong* when the raw states it, *weak* when inferred or partial. Who acted is carried by the fact's category and actor, not by the strength.
- No fact is ever hidden or retired by a relation. Relations show the Consolidator the shape; the Consolidator judges.
- **Dispute** — the Consolidator's judgment that two accounts of the same object under the same conditions coexist without a ruling. A category of knowledge, not a relation.

## Scope and attribution

- **Enrollment** — the durable enabled or disabled participation of one memory-session identity. Explicit intent overrides its derived default; shared forks and clones share the switch. Disable pauses future work and injection while retaining memory and unrestricted reads.
- **Baseline** — the installation-scoped instant of the plugin's first successful initialization, retained across restarts and upgrades. Only native sessions created strictly after it default enabled; unknown or malformed creation times default disabled.
- **Session** — one host conversation. Gets an id only once an assistant reply exists.
- **Executor** — an enabled active host runtime that provides one Noting slot and one Consolidation slot. A free slot prefers its own eligible work before borrowing another session's closed tail.
- **Target** — the memory session and branch whose evidence a worker processes. Its project, costs, commits, progress and deliveries remain its own even when another executor hosts the worker.
- **Claim** — exclusive ownership of one target's phase across branches and executors, identified by an executor, a token and a thirty-minute expiry. Current ownership fences commits; reopening immediately replaces another executor's token.
- **Closed** — a session marked by normal shutdown and cleared on restore. A crash or expired claim does not establish closure; an unclosed crashed conversation waits for resume.
- **Project** — the unit that shares knowledge. A session belongs to a project only by explicit declaration (a `.trace-memory` marker file found upward from cwd, or an in-session `/trace project <name>`; the in-session declaration wins). An undeclared session is its own project and may later be merged into another, retroactively.
- **Scope** of a knowledge item — `session` (holds only in that session), `project`, or `global` (about the user, the environment, general working method).

## Reading

- **Injection** — the memory block placed into context at session start (knowledge) and at compaction (knowledge, recent facts, pending compressed Raw views). Grouped by category in a fixed order; bytes change only when content changes.
- **Compaction** — instant replacement of the context with the injection block. No model call.
- **Trace** — the tool that walks addresses: knowledge → its facts → the source turn; knowledge revisions (`K7@2`, `K7@2..4`); a fact's later strong negations (`F101..`). Also the project name.
- **Search** — lexical lookup over facts and knowledge (and optionally a session's raw) returning addresses. No hit does not mean absent.
- **Mark** — the user's verified / flagged / clear annotation on a knowledge revision, applied through `/trace mark K<n> <kind>` and the façade. Project declaration is a separate user command.

## Process

- **Accounting** — after each consolidation run, every user fact and every question in the range must be cited by a knowledge item or listed in `skipped` with a reason; missing accounting is a diagnostic.
- **NEAR** — the lexically nearest existing knowledge shown for every new or edited knowledge; the Consolidator must edit, merge, or state why the claim differs.
- **CLOSER** — new facts lexically near each open or goal knowledge, shown as candidate closing evidence.
- **Run record** — one record per noting or consolidation run holding the exact input sent to the model, the prompt version, the model, and the output. Knowledge revisions point at the run that produced them.
- **Completion level** — the prefix on an event fact: completed (result evidence visible), reported (claimed only), dispatched, attempted.
- **Local handle** — `$n`, the n-th fact of the current noting batch, used for in-batch relations before ids exist; the writer resolves it.

## Languages

Memory content is written in the language of the conversation. Everything that is work — code, comments, docs, prompts, subagent briefs — is English.
