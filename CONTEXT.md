# Trace Memory — domain glossary

Terms only. No implementation detail. When a term here conflicts with usage in code or prompts, this file wins and the other side is fixed.

## Layers

- **Raw** — the conversation as the host recorded it: user messages, tool calls with results, assistant text. The only source of truth. Never edited.
- **Source entry** — one completed native conversation message: user text, assistant content with tool calls, or a tool result. Identity is its native id within the session lineage, never its text. It belongs to a Turn; plugin injections and summaries are never sources.
- **Compressed Raw view** — the shared, bounded head/tail excerpt of one source entry, in Pi's compaction line shape with the source address as the label (`[T<n>#user]: …`, `[T<n>#t<k>] <tool>(<key>=<JSON>)`, `[T<n>#t<k>] <tool> <status>: …`) and honest omission counts in one marker family (`[... N characters truncated]`). The original Raw remains available through trace, which renders it under the same labels with no budget.
- **Turn** — one user message and everything it triggered until the next user message. A compaction is also recorded as a turn, with no facts.
- **Fact** — one claim extracted from a turn that can be overturned on its own. Six categories: question, proposal, decision, observation, interpretation, event. Carries an actor (user or agent), a source address, optional verbatim quote, and relations.
- **Fact group** — the display of selected facts under their owning Turn: Turns in chronological start-time order, facts in ascending F-id order. A group need not cover its entire Turn; grouping changes neither citation scope nor processing membership, and all original source references stay on each fact.
- **Knowledge** — one durable, decontextualized conclusion consolidated from facts. Seven categories: constraint, open, dispute, goal, mechanism, term, reference. Carries a scope, its supporting facts, a revision log.
- **Supports** — the fact evidence of one knowledge commit: the grounds of its complete resulting text together with the correction, changed circumstance or withdrawal that justified the change. The cited facts need not agree with each other. One list per commit, archives included; it decides where the commit applies and which citation scope it must satisfy.
- **Reason** — the commit message of one knowledge commit: what changed and why it was chosen. It is not a durable claim and has no authority of its own; it establishes no evidence, scope, applicability, accounting coverage or completion level, and addresses written in it are never read as citations.
- **Topic** — a subject label on one knowledge revision: the module, component or domain the conclusion is about, beside its category. Labels are free strings, trimmed, deduplicated and versioned with the revision that carries them; several may apply and none is required. Classification only — a topic changes no scope, evidence permission, lifecycle or eligibility, and sharing one merges no knowledge.
- **Noting** — the phase in which the Noter turns raw into facts. Each eligible entry completion checks for 10,000 pending compressed-view tokens; a run processes the oldest whole-entry prefix within 10,000 tokens and the model context capacity. A partly processed Turn may still have pending entries.
- **Consolidation** — the phase in which the Consolidator turns facts into knowledge and revises existing knowledge. Each eligible entry completion checks for 5,000 rendered tokens of applicable unconsolidated committed facts, including facts of partly recorded Turns; a run takes the oldest-first whole-fact prefix within 10,000 rendered tokens. Worker completion, compaction, shutdown and tree switching launch neither phase.

## Relations (annotations, never derived state)

- **Support** — a newer fact affirms an older one: adoption, approval, agreement, an answer, a restatement, execution of a ruling.
- **Negate** — a newer fact opposes or invalidates an older one: withdrawal, veto, found wrong, a new state overturning the old, doubt, objection, evidence that does not fit.
- **Strength** — the Noter's confidence that the relation holds: *strong* when the raw states it, *weak* when inferred or partial. Who acted is carried by the fact's category and actor, not by the strength.
- No fact is ever hidden or retired by a relation. Relations show the Consolidator the shape; the Consolidator judges.
- **Dispute** — the Consolidator's judgment that two accounts of the same object under the same conditions coexist without a ruling. A category of knowledge, not a relation.

## Scope and attribution

- **Enrollment** — the durable enabled or disabled participation of one memory-session identity, changed by `/trace on` and `/trace off` (in Pi) for that identity alone, immediately and without a reload. Explicit intent overrides its derived default; shared forks and clones share the switch. Disable pauses future work and injection while retaining memory and unrestricted reads. There is no global participation switch.
- **Baseline** — the installation-scoped instant of the plugin's first successful initialization, retained across restarts and upgrades. Only native sessions created strictly after it default enabled; unknown or malformed creation times default disabled.
- **Session** — one host conversation. Gets an id only once an assistant reply exists.
- **Executor** — an enabled active host runtime that provides one Noting slot and one Consolidation slot. A free slot prefers its own eligible work before borrowing a closed tail allowed by the configured Closed-session scope.
- **Closed-session scope** — the policy for automatically borrowing closed-session work: off leaves tails pending, project allows only the same project (default), and global allows any project. Both phases require an enabled, open executor session; scope does not change current-session processing or manual catchup.
- **Target** — the memory session and branch whose evidence a worker processes. Its project, costs, commits, progress and deliveries remain its own even when another executor hosts the worker.
- **Claim** — exclusive ownership of one target's phase across branches and executors, identified by an executor, a token and a thirty-minute expiry. Current ownership fences commits; reopening immediately replaces another executor's token.
- **Closed** — a session marked by normal shutdown and cleared on restore. A crash or expired claim does not establish closure; an unclosed crashed conversation waits for resume.
- **Project** — the unit that shares knowledge. Shared membership requires an explicit user command (`/trace project <name>` in Pi); the same name in the same database identifies the same project. Files, cwd and Git remotes do not declare membership. An undeclared session is its own project and may later be merged into another, retroactively. Existing stored project assignments survive removal of file-based discovery.
- **Scope** of a knowledge item — `session` (holds only in that session), `project`, or `global` (about the user, the environment, general working method).
- **Manual catchup** — `/trace catchup`'s finite, explicit drain of the current enabled session's selected branch: a frozen entry-id boundary for Noting and a frozen fact-id set for Consolidation, drained in bounded batches below the normal triggers, in subagent mode, chaining only within its own host-local controller. The sole exception to the no-completion-chaining rule; it never expands past what it froze.
- **Stop** — `/trace stop`'s cancellation of one executor's background work (its own manual catchup plus any ordinary or borrowed work), reusing the same claim, token-fence and cancellation machinery as shutdown. It never disables enrollment, never edits configuration and never touches another executor's claim.

## Reading

- **Injection** — the memory block placed into context at session start (knowledge) and at compaction (knowledge, recent facts, pending compressed Raw views). Knowledge is grouped by category in a fixed order; selected facts use Fact groups. Bytes change only when content or its rendering changes.
- **Compaction** — replacement of the context with the injection block. It escalates through three tiers over a frozen snapshot of every pending entry: the normal compressed Raw views, then the same entries rendered under the tighter tier-2 profile, then a request that the host's own native compaction take over. The first two are instant and call no model; only the third reaches one, and that call is the host's.
- **Tier-2 entry view** — the same entry renderer under compaction's tighter profile (a smaller per-call budget and entry cap), used when the normal views no longer fit: order, source addresses, user boundaries, tool names and statuses kept, arguments and results cut to their label-plus-marker minimum, text cut with the same omission marker family. Never a Noter's input, never a source.
- **Compaction boundary** — the last compaction the host successfully persisted on the selected ancestry. A request to compact, a failed or cancelled attempt and a compaction on a sibling path are not one. A Noter whose frozen entries include any entry before it runs with fresh context for the whole batch.
- **Trace** — the tool that walks addresses: knowledge → its facts → the source turn; knowledge revisions (`K7@2`, `K7@2..4`); a fact's later strong negations (`F101..`). Also the project name.
- **Search** — lexical lookup over facts and knowledge (and optionally a session's raw) returning addresses. No hit does not mean absent.
- **Mark** — the user's verified / flagged / clear annotation on a knowledge revision, applied through `/trace mark K<n>[@<commit>] <kind>` (or the menu's Current session > Mark) and the façade. Project declaration is a separate user command.
- **Global preference** — one of the four defaults the Pi menu's Settings entry saves under `trace-memory` in the resolved agent settings file: each phase's execution mode and its model. They are the existing canonical configuration keys, not a second system; a project or environment layer still overrides them, and a saved value reaches tasks admitted afterwards while running tasks keep the mode and model frozen with them.

## Process

- **Accounting** — after each consolidation run, every user fact and every question in the range must be cited by a knowledge item or listed in `skipped` with a reason; missing accounting is a diagnostic.
- **NEAR** — the lexically nearest existing knowledge shown for every new or edited knowledge; the Consolidator must edit, merge, or state why the claim differs.
- **CLOSER** — new facts lexically near each open or goal knowledge, shown as candidate closing evidence.
- **Fork** — inherited-context execution: the run happens in a child of the conversation itself, continuing from its persisted state. The execution mode, never the evidence path called branch. Runs recorded before this name existed carry the old spelling and are read as legacy request-copy execution.
- **Subagent** — fresh-context execution: the run happens in a private child prepared from the frozen material alone. The alternative to fork.
- **Material** — the frozen parts one memory run works from: the active knowledge, the historical facts, the compressed Raw views of its selected entries, its own range and cues, and the budget receipts. A task freezes it once; both execution modes read that one.
- **Increment** — what an inherited-context run adds to a conversation that already carries the raw, the delivered facts and the injected knowledge: its instruction, the range, and the head reply and source index, or the exact fact list and review cues. Never a second copy of the material.
- **Run record** — one record per noting or consolidation run holding the exact input sent to the model, the prompt version, the model, the execution mode, and the output. Knowledge revisions point at the run that produced them.
- **Worker log** — the child session's own JSONL, written by Pi, named in the run record as `nativeLog`. By default it is a direct child of the agent's `sessions/trace-memory` directory — one level under Pi's session root, where external daily-cost readers look, and where Pi's all-session browser lists it. Logs written under an earlier default stay at their original paths.
- **Completion level** — the prefix on an event fact: completed (result evidence visible), reported (claimed only), dispatched, attempted.
- **Local handle** — `$n`, the n-th fact of the current noting batch, used for in-batch relations before ids exist; the writer resolves it.

## Languages

Memory content is written in the language of the conversation. Everything that is work — code, comments, docs, prompts, subagent briefs — is English.
