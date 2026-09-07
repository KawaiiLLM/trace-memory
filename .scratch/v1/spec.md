# Trace Memory v1 — spec

Label: ready-for-agent. Tracker: none configured; this file is the ticket.
Glossary: CONTEXT.md at the repo root. Design of record: the user's design note (outside the repo). Language: everything in this repo is English; memory content follows the conversation.

## Problem Statement

A coding agent forgets what was discussed, decided, and found a few compactions ago. Hand-written memory files go stale because nobody maintains them, and they cannot show the conversation that produced a decision. The user has twice watched an agent re-discover and re-solve a problem it had already solved, and once rebuild a pipeline worse than the version it had forgotten.

## Solution

Two layers of memory extracted automatically from the conversation, each claim traceable back to its source turn. Recordings turn raw turns into facts; integration turns facts into durable knowledge; the agent gets knowledge at session start and at compaction, and can trace any knowledge to its facts and to the raw. Compaction is instant and never calls a model. The main agent and the user carry no memory duty.

## User Stories

1. As a user, I want my rulings ("use pnpm, not npm") to survive compaction and reappear in the next session, so that I never repeat them.
2. As a user, I want a question I asked but never got answered to be listed as open, so that the next session brings it back instead of dropping it.
3. As a user, I want a problem I already analyzed to be recognized when it comes up again, so that the agent does not re-discover it.
4. As a user, I want to ask "why can't we use npm" and get the original conversation, so that I can check the reason rather than trust a summary.
5. As a user, I want to change my mind and have the old ruling marked as overturned but still visible in history, so that nothing silently disappears.
6. As a user, I want compaction to be instant, so that a long session never pauses for a summary call.
7. As a user, I want memory extraction to run in the background after a turn, so that I never wait for it and never have to trigger it.
8. As a user, I want to declare which project a session belongs to, and never have it guessed, so that memories from unrelated sessions in my home directory do not mix.
9. As a user, I want an undeclared session to keep its own memory and be mergeable into a project later, so that nothing is lost while I decide.
10. As a user, I want memory content written in the language I spoke, so that I can read my own memories.
11. As a user, I want to mark a knowledge item as verified or flagged, so that the agent knows which memories I have checked.
12. As a user, I want a status command showing what the memory system has done in this session, so that I can tell whether it is working.
13. As a main agent, I want knowledge injected at session start grouped by category with constraints first, so that I read the rules before anything else.
14. As a main agent, I want the injected block to be byte-stable when nothing changed, so that the prompt cache stays warm.
15. As a main agent, I want to trace a knowledge item to its facts and a fact to its source turn in one call each, so that I can verify before relying on it.
16. As a main agent, I want to see a specific tool call's full output when the preview was truncated, so that I never conclude from a cut-off result.
17. As a main agent, I want to search facts and knowledge by words and get addresses, so that I can find prior work without a full replay.
18. As a main agent, I want a compaction block that contains the knowledge, the recent facts, and the raw since the last recording, so that I can continue work without a summary.
19. As a main agent, I want a fact's later strong negations shown when I trace it, so that I do not act on an overturned claim.
20. As a main agent, I want a knowledge item's revision history with the facts that triggered each revision, so that I can see how a conclusion evolved.
21. As a Recorder, I want the raw since the watermark rendered per turn with tool calls structured (metadata, command, stdout, stderr), so that I can judge completion levels from evidence.
22. As a Recorder, I want the facts written earlier in the session shown to me, so that I do not rewrite what exists.
23. As a Recorder, I want to reference facts written earlier in this batch by a local handle, so that I never guess ids.
24. As a Recorder, I want my output validated on shape only (categories, actors, relations to existing facts, event prefixes, no ids in text), so that structural mistakes bounce back immediately.
25. As a Integrator, I want all facts in my range with their support/negate annotations, none hidden, so that I judge what is outdated myself.
26. As a Integrator, I want the lexically nearest existing knowledge shown for each knowledge item I add or edit, so that I merge or edit instead of duplicating.
27. As a Integrator, I want new facts near each open or goal knowledge shown, so that I can close open items on evidence.
28. As a Integrator, I want to be told which user facts and questions in my range I neither cited nor declined, so that nothing the user said is silently dropped.
29. As a Integrator, I want to edit, merge, and archive knowledge with full supports and a reason, so that revisions are auditable.
30. As a maintainer, I want every recording and integration run recorded with the exact model input, prompt version, model, and output, so that I can see what the model actually saw.
31. As a maintainer, I want one renderer used for recording input, compaction, integration lines, and trace, so that there is one format to get right.
32. As a maintainer, I want the core to compile without any host SDK, so that hosts stay thin.
33. As a maintainer, I want the Pi host to run recordings as a prefix-identical call by default and integration as a fresh call, both with configurable models, so that cost and quality can be tuned.
34. As a maintainer, I want a scripted fake model in tests, so that the whole core can be tested through one seam.
35. As a maintainer, I want fixtures cut from the simulation data, so that the regression cases that shaped the design keep guarding it.

## Implementation Decisions

### Modules

- `core/model`: types for Turn, Fact, Knowledge, KnowledgeRevision, RunRecord; shape validation only (category enums, actor enum, relation shape `[id, strong|weak]`, event prefix, no ids in fact text, local handle syntax `$n`).
- `core/store`: SQLite behind one interface. Global autoincrement ids for turns, facts, knowledge. Tables: sessions, projects, turns, tool_calls (name, input, result, status, ordinal within turn), facts, fact_relations (from, to, kind support|negate, strength), knowledge, knowledge_revisions (text, category, scope, supports, because, op, run id, time; creation is revision 1), knowledge_links (merged_into with the survivor's revision; split_from), runs (kind, session, range, prompt version, model, input as sent, output, outcome success|failure|cancelled, time), knowledge_marks (knowledge revision, verified|flagged, time), pending_deliveries (recording results awaiting injection into a session). Referential checks and revision matching live here. All writes of one run are one transaction.
- `core/recording`: builds the recording input (rendered raw since the watermark, recent facts by freshness, active knowledge, the range), calls `runAgent`, parses the JSON, resolves local handles, validates, commits facts and the run record, advances the watermark, and queues a pending delivery.
- `core/integration`: builds the integration input (all facts in range with annotations, context facts by freshness, active knowledge, NEAR and CLOSER hints), calls `runAgent`, parses, runs accounting (every user fact and question in range cited or declined), applies new/edit/merge/delete as revisions, commits with the run record. Diagnostics (numbers not found in cited facts, knowledge over 200 tokens, NEAR without acknowledgement after the feedback round) are reported, never rejected.
- `core/render`: one renderer. Turn rendering: user message and assistant text uncut; per tool call a fixed metadata line (ordinal `#t<n>`, tool, status, omission flag), command cut at line boundaries to a token cap, stdout head/tail, stderr tail, reads and searches as name plus path, memory-tool writes as a receipt line, reports head/tail; every cut carries an omission marker with the count. Fact line and knowledge line formats per CONTEXT.md, relations at line end with continuation lines for quote and source. XML injection blocks with a fixed header, category tags in fixed order, no volatile attributes; dynamic receipts appended after the stable content. Budgets are parameters; defaults: command 120 tokens, stdout 60 head 120 tail, stderr 120 tail, reports 200 head 80 tail, knowledge block 10K, episodic block 20K (oldest facts dropped first, raw tail kept). Token estimate is a local heuristic, no tokenizer dependency: 0.75 per CJK character, 0.25 per other character (user ruling, grilling Q12).
- `core/api`: the façade `TraceMemory(dbPath, runAgent, config)` exposing `record`, `integrate`, `compact`, `inject`, `deliver`, `trace`, `search`, `status`, `declareProject`, `mark`, and `tools(context)` returning the four model-facing tool definitions bound to a run or to the main agent's session. Hosts call only this.
- `core/prompts`: `recording.md`, `integration.md`, versioned by content hash recorded in runs.
- `hosts/pi`: registers `agent_settled` (triggers recording when ≥5 answered turns or ≥50K tokens since the watermark; triggers integration when ≥50 unintegrated facts), `session_before_compact` (returns the compaction block, cancels nothing, calls no model), `session_before_tree` (finishes recordings on the abandoned branch, returns its facts as the summary), `before_agent_start` (injects the knowledge block at session start and any pending recording deliveries), the four tools from `tools(context)` (`trace`, `search`, `note`, `memory`), command `/trace` (read-only status; `/trace project <name>` declares the project; `/trace mark K<n> <kind>` marks a knowledge item). Implements `runAgent` two ways: branch mode builds a pi-ai call whose system prompt and messages are byte-identical to the session's current request plus one appended user message; subagent mode builds a fresh call with the rendered input. Recording defaults to branch mode with the session model; integration defaults to subagent mode with the session model; both overridable. In branch mode the appended message carries only the recording prompt and the range: the raw turns, the facts delivered after earlier recordings, and the injected knowledge are already in the conversation (user ruling 2026-09-06 08:53). That premise fails for a recording result committed after the current prompt started, since deliveries land at prompt start: the host does not start a branch recording while such a result is undelivered and lets the next turn stop start it. Subagent mode carries the full rendered input. In integration branch mode the candidate round appends the integration prompt and the full integration input to the captured prefix, and the final round appends the candidate reply (replayed in the provider's native assistant shape) and the feedback message to the verified candidate request. Tool calls in either mode are executed and the model is called again on the extended request (see Write tools).
- `hosts/cc`: placeholder; not in v1.

### Contracts

- `runAgent(input) → {outcome: success|failure|cancelled, output, usage, request}`; the model writes only through the core's write tools (see Write tools), never to the store directly.
- Triggers, budgets, models, and modes are configuration with the defaults above.
- Facts are never hidden or deleted; relations are annotations. Knowledge changes only through revisions; status is active|merged|archived and system-maintained.
- Project attribution: `.trace-memory` marker found upward from cwd, or the host command `/trace project <name>` (the user's act, not the model's); the in-session declaration wins; an undeclared session is its own project; merging relabels facts and project-scoped knowledge.
- Session ids are allocated at the first assistant reply.
- Addresses: `K<n>`, `K<n>@<rev>`, `K<n>@<a>..<b>`, `F<n>`, `F<n>..` (later strong negations, branching), `T<n>`, `S<n>/T<m>`, `S<n>`, comma lists; `cursor` continues any listing; `tool=`, `full`, `cap=` on turns.
- Prefix-identical calls are verified once by comparing provider request bodies through `before_provider_request` and checking cache-read usage; if the check fails, recording falls back to subagent mode and the run record says so.

### Vocabulary (user ruling 2026-09-07)

The two phases are Recording (the Recorder writes facts) and Integration (the Integrator writes knowledge). "Note", "settle", "entry", and "settlement" are retired: modules, prompts, run kinds (`recording` | `integration` | `manual`), configuration keys, façade methods, tables (`knowledge`, `knowledge_revisions`, `knowledge_links`, `knowledge_marks`), and the address prefix (`K<n>` replaces `E<n>`) follow the new words. The rest of this document is swept by the rename ticket; until then, read note = recording, settle = integration, entry = knowledge.

### Write tools (user ruling 2026-09-07, shape refined 2026-09-07)

Four tools and no other model-facing surface: `trace` and `search` read; `note` writes facts; `memory` writes knowledge. The Pi host registers all four for the main agent, and Recording and Integration runs use the same definitions. Because the extension's own tool definitions are part of the captured provider request, branch mode inherits them with the prefix unchanged; nothing is added per run. The main agent may call the write tools but is not prompted to: writing is the runs' job, and the tool descriptions say so.

- Both write tools take one batch and treat it atomically: every item is validated with the existing shape rules; if all pass, the batch commits in one transaction; if any fails, the result lists each item's outcome in order (`ok` or `rejected: <reason>`) and nothing is written. The model corrects and resubmits the whole batch. There is no staging and no temporary object lifecycle.
- `note({facts})`: each fact carries category, actor, text, quote (optional), timestamp, source, support, negate. `$n` refers to an earlier fact of the same batch, nothing else. A Recording run may commit at most one batch; when the model stops without one, the run is a success with zero facts and the watermark still advances (zero output is normal).
- `memory({operations, skipped})`: every operation has one shape: `op` (create | update | merge | archive), `id`, `absorb`, `text`, `category`, `scope`, `supports`, `because`. `because` is always required. create, update and merge state the complete resulting knowledge (text, category, scope, supports all present; supports is the full replacement set, earlier supports stay in revision history). `id` names the target of update and archive and the survivor of merge; `absorb` lists the merged-away items and appears only on merge; archive carries only `id` and `because`. A field that does not apply to the operation is rejected, never ignored. merge is one transaction: the survivor's new revision, the absorbed items' status and links. `skipped` lists `{fact, because}` for range facts that form no knowledge and replaces `not_admitted`.
- Integration keeps its two rounds through the tool: the first valid batch is not committed; the system computes NEAR and CLOSER over it and returns them with the checklist as the tool result; the second valid batch (unchanged or corrected) commits after accounting and diagnostics. NEAR is answered by update or merge; an unanswered NEAR is a diagnostic. Concurrency: a run applies operations on the revisions it read at start and rejects an operation whose target moved on; main-agent calls use the current revision; SQLite immediate transactions serialise writers.
- A main-agent call commits at once as a run of kind `manual` bound to the calling session, branch and turn; the tool input is its request and the tool result its response. Such facts count toward Integration and accounting like any other; fact sources must belong to the calling session.
- Marks (verified | flagged | clear on a knowledge item) and project declaration are the user's acts, not the model's: host commands `/trace mark K<n> <kind>` and `/trace project <name>`, backed by façade methods. The former `mark` tool is gone.
- Hosts execute tool calls in both modes and call the model again until it stops: in subagent mode by extending the conversation, in branch mode by appending the assistant call and the tool results to the verified request, so the prefix never changes and branch Recording can fetch cut evidence through `trace` as well. The run record stores the last request sent (which embeds every earlier round) and the sequence of tool results.
- Rejected alternatives: whole-batch JSON text output (one malformed character bounces the batch, no per-item errors, output bounded by one reply); provider structured outputs (provider-specific, and they change sampling fields inside the branch prefix); a staging protocol with handles, withdraw and acknowledgement operations (a second object lifecycle for no demonstrated need); mark and skipped as knowledge operations (usage feedback and accounting are not knowledge management).

### Schema note (from the simulation driver)

The simulation driver's validation and application logic is the executable prototype of `core/model`, `core/integration` accounting, and revision application; port its behaviour, not its Python.

### Run boundaries

- A recording run freezes, at start: the session, the branch, the raw range end (the last turn present when the trigger fired), and the knowledge revisions it read. On success it commits its facts, the run record, the watermark advanced exactly to that range end, and a pending delivery bound to that branch — all in one transaction. It never advances to turns that arrived while it ran; those wait for the next trigger.
- An Integration run freezes the fact range and the knowledge revisions it read. It applies revisions only on top of those revisions; if a knowledge item moved on meanwhile, that operation is rejected and recorded, the rest commit.
- Within one process, at most one recording run and one integration run per session-branch at a time; a trigger that fires while one is running is dropped (the next trigger re-evaluates). An Integration run covers only that session-branch's own facts; sessions of one project integrate separately (user ruling 2026-09-06 09:43). No leases across processes in v1.
- Failure or cancellation commits nothing but the run record. A branch switch while a recording run is pending lets the run finish against its frozen branch; its delivery goes to that branch only. The branch summary for the abandoned branch uses committed facts plus the rendered raw for anything still unrecorded; it never silently drops raw.
- Two behaviour cases the tests must cover: a new turn arrives while the model has not returned; the user switches branch while the model has not returned.

### Overflow policy

- Compaction never refuses and never calls a model. The episodic block is assembled in this order: raw since the watermark (kept whole, rendered with the standard cuts), then recent facts newest-first until the 20K budget is reached. If the raw alone exceeds the budget it is still kept whole and the receipt states the overage; nothing unrecorded is dropped.
- The knowledge block is assembled in category order; whole categories from the end of the order (reference, term, mechanism, …) are left out when the 10K budget is reached, and the receipt names the count and the trace address to fetch them. Constraints, open items, and disputes are never left out.
- A recording run in subagent mode may fetch any tool call's full text by address (the same read path as trace); the run record lists what it fetched. Evidence it did not fetch stays at the level the preview supports: a cut result cannot justify `completed:`; a cut report is `reported:`.

### Run record contract

- `runAgent(input) → {outcome: success|failure|cancelled, output, usage, request}` where `request` is the exact request as sent to the provider (system prompt, messages, tool definitions), filled by the host. The core stores `request`, never its own assembled input, as the record of what the model saw.
- Every attempt is recorded, including bounced outputs, feedback rounds, failures, and cancellations. Business writes are one transaction per successful run; run records are written regardless.
- Branch-mode verification compares request bodies structurally (system prompt and message prefix) against the session's own last provider request; cache-read usage is an additional observation, never the proof. The verification is re-run whenever the model, provider, or tool definitions change.

### Integration feedback loop

The initial integration input separately lists every visible active knowledge whose current `supports` contains a fact negated by a fact in the frozen integration range. Include the knowledge, the cited fact, and the new negating fact with the relation's recorded strength, using the shared renderer. Include all matching knowledge, not just lexical neighbours; both strong and weak negations are review cues. This listing derives no status and requires no new acknowledgement field: the Integrator judges whether to edit, merge, archive, or retain each knowledge. Missing or incorrect relations and incomplete supports can still cause misses; this is not a complete consistency check.

1. The Integrator returns candidate operations; a new knowledge item carries a candidate handle `$e<n>`, an edit or merge names the target knowledge.
2. The system computes NEAR for each candidate text against active knowledge and CLOSER for open and goal knowledge, then sends one user-role feedback message containing these hints and the second-round checklist in the integration prompt. The checklist checks adoption versus proposal, completion versus approval/reporting, object and condition fidelity, knowledge maintenance, and support from facts available in this run. This system-generated message is review guidance, not a human ruling or adoption evidence.
3. The Integrator submits the complete batch again: unchanged if the check finds no problems, corrected otherwise. No checklist report, acknowledgement fields, or third review round. Each remaining NEAR is answered by update or merge; an unanswered NEAR is committed with a diagnostic, not rejected.
4. Accounting runs against the knowledge set as it will be after applying this round's operations (updates and archives included), listing user facts and questions in range that no resulting item cites; each must be cited or listed in `skipped`.

### Visibility rule

- Injection and integration see: global knowledge, the current project's project knowledge, and session knowledge of the current session only. Another session's session knowledge is never visible. An undeclared session's project is itself.

### Prompt and spec synchronization

- The prompts under core/prompts are the contract the model sees; this spec and CONTEXT.md govern their wording. Differences found at review: batch arrays and `$n` in recording.md; candidate handles and `near_ack` shape in integration.md; the 200-token diagnostic; the `runAgent` signature in core/README. These are fixed before implementation starts.
- The simulation driver is reference only, at its frozen v7 version; its retired behaviours (hiding superseded facts, link-based accounting exemptions, hard number gates) are not to be ported.

### Schema

```text
sessions        id · host · started_at · first_reply_at · project_id · parent_session_id
projects        id · name · declared_by (marker | mark) · merged_into
turns           id · session_id · ordinal · parent_turn_id · kind (turn | compaction) · user_prompt · assistant_text · started_at · ended_at
tool_calls      id · turn_id · ordinal · name · input · result · status
facts           id · turn_id · category · actor · text · quote · source · created_at
fact_relations  from_fact · to_fact · kind (support | negate) · strength (strong | weak)
knowledge         id · project_id · status (active | merged | archived) · author · current_revision
knowledge_revisions id · knowledge_id · rev (from 1) · text · category · scope · supports · op · because · run_id · created_at
knowledge_links     from_knowledge · from_rev · kind (merged_into | split_from) · to_knowledge · to_rev
runs            id · kind (recording | integration) · session_id · branch · range_from · range_to · prompt_hash · model · mode · request · response · outcome · created_at
knowledge_marks knowledge_id · rev · kind (verified | flagged) · created_at
pending_deliveries  run_id · session_id · branch · delivered_at
watermarks      session_id · branch · last_recorded_turn · last_integrated_fact
```

Indexes: FTS over facts and knowledge; knowledge by project and status; runs by session.

## Testing Decisions

- A good test drives the façade and observes only what a host could observe: rows in the store via the façade's read methods, rendered strings, trace output. No test imports a module below the façade.
- The fake `runAgent` is a scripted function returning canned JSON per call; tests assert what got committed, what bounced, and what the run record holds.
- Fixtures: a small set cut from the simulation data (a few raw turns with tool calls, their facts, their knowledge) under `test/fixtures/`; memory content in fixtures stays in its conversation language (grilling Q13).
- Ruling test points: every user ruling that an implementation could silently deviate from is pinned by a test in `core/api/rulings.test.ts`, named after the ruling.
- Golden tests for the renderer (turn, fact line, knowledge line, injection block, compaction block) and for byte stability of the injection block when content is unchanged.
- Property-style tests for validation: every category enum, relation shape, local handle resolution, event prefix, no ids in text.
- Accounting, NEAR bounce, CLOSER hints, revision log replay, trace address parsing, cursor continuation, truncation markers each get behaviour tests through the façade.
- Host tests: one manual verification script for the prefix-identical call; hook wiring exercised by hand in Pi.
- Prior art: the simulation driver's checks and the regression suite's cases (outside the repo).

## Out of Scope

- Claude Code host.
- Proxy integration of closed sessions, task claims and leases (ruled at grilling Q9; planned as ticket 08 after the host tickets).
- Per-prompt automatic retrieval hints.
- Cross-project sharing beyond global scope.
- Any confidence score; any model-judged pruning of facts.
- Tuning the truncation defaults by experiment (recorded as a follow-up).

## Further Notes

- The number-in-cited-facts check and the 200-character knowledge cap are diagnostics, not gates.
- The integration prompt's strength rule: strong support only from explicit user adoption; execution and agent agreement are weak.
- Ids in a recording batch: the Recorder references earlier facts of the same batch by `$n`; the store resolves them; predicting ids is forbidden.
- Simulation results that shaped this spec live in /tmp/mnemo-sim and the peer's regression suite; they are not part of the repo.
