# Trace Memory v1 — spec

Label: ready-for-agent. Tracker: none configured; this file is the ticket.
Glossary: CONTEXT.md at the repo root. Design of record: the user's design note (outside the repo). Language: everything in this repo is English; memory content follows the conversation.

## Problem Statement

A coding agent forgets what was discussed, decided, and found a few compactions ago. Hand-written memory files go stale because nobody maintains them, and they cannot show the conversation that produced a decision. The user has twice watched an agent re-discover and re-solve a problem it had already solved, and once rebuild a pipeline worse than the version it had forgotten.

## Solution

Two layers of memory extracted automatically from the conversation, each claim traceable back to its source turn. Notings turn completed source entries into facts; consolidation turns facts into durable knowledge; the agent gets knowledge at session start and at compaction, and can trace any knowledge to its facts and to the raw. Compaction is instant and never calls a model. The main agent and the user carry no memory duty.

## User Stories

1. As a user, I want my rulings ("use pnpm, not npm") to survive compaction and reappear in the next session, so that I never repeat them.
2. As a user, I want a question I asked but never got answered to be listed as open, so that the next session brings it back instead of dropping it.
3. As a user, I want a problem I already analyzed to be recognized when it comes up again, so that the agent does not re-discover it.
4. As a user, I want to ask "why can't we use npm" and get the original conversation, so that I can check the reason rather than trust a summary.
5. As a user, I want to change my mind and have the old ruling marked as overturned but still visible in history, so that nothing silently disappears.
6. As a user, I want compaction to be instant, so that a long session never pauses for a summary call.
7. As a user, I want memory extraction to run in the background when a source entry completes, so that I never wait for it and never have to trigger it.
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
18. As a main agent, I want a compaction block that contains the knowledge, the recent facts, and the raw since the last noting, so that I can continue work without a summary.
19. As a main agent, I want a fact's later strong negations shown when I trace it, so that I do not act on an overturned claim.
20. As a main agent, I want a knowledge item's revision history with the facts that triggered each revision, so that I can see how a conclusion evolved.
21. As a Noter, I want pending completed entries rendered with their owning Turn addresses, tool identity and execution status, so that I can judge completion levels from evidence.
22. As a Noter, I want the facts written earlier in the session shown to me, so that I do not rewrite what exists.
23. As a Noter, I want to reference facts written earlier in this batch by a local handle, so that I never guess ids.
24. As a Noter, I want each fact validated on shape only (categories, actors, event status, relations to existing facts, no ids in text) with per-item results, so that structural mistakes come back immediately and nothing half-written lands.
25. As a Consolidator, I want all facts in my range with their support/negate annotations, none hidden, so that I judge what is outdated myself.
26. As a Consolidator, I want the lexically nearest existing knowledge shown for each knowledge item I add or edit, so that I merge or edit instead of duplicating.
27. As a Consolidator, I want new facts near each open or goal knowledge shown, so that I can close open items on evidence.
28. As a Consolidator, I want to be told which user facts and questions in my range I neither cited nor declined, so that nothing the user said is silently dropped.
29. As a Consolidator, I want to edit, merge, and archive knowledge with full supports and a reason, so that revisions are auditable.
30. As a maintainer, I want every noting and consolidation run recorded with the exact model input, prompt version, model, and output, so that I can see what the model actually saw.
31. As a maintainer, I want one renderer used for noting input, compaction, consolidation lines, and trace, so that there is one format to get right.
32. As a maintainer, I want the core to compile without any host SDK, so that hosts stay thin.
33. As a maintainer, I want the Pi host to run notings as a prefix-identical call by default and consolidation as a fresh call, both with configurable models, so that cost and quality can be tuned.
34. As a maintainer, I want a scripted fake model in tests, so that the whole core can be tested through one seam.
35. As a maintainer, I want fixtures cut from the simulation data, so that the regression cases that shaped the design keep guarding it.

## Implementation Decisions

### Modules

- `core/model`: types for Turn, Fact, Knowledge, KnowledgeRevision, RunRecord; shape validation only (category enums, actor enum, relation shape `[id, strong|weak]`, event `status`, no ids in fact text, local handle syntax `$n`, the one knowledge operation shape).
- `core/store`: SQLite behind one interface. Global autoincrement ids for turns, facts, knowledge. Tables: sessions, projects, turns, tool_calls (name, input, result, status, ordinal within turn), facts, fact_relations (from, to, kind support|negate, strength), knowledge, knowledge_revisions (text, category, scope, supports, because, op, run id, time; creation is revision 1), knowledge_links (merged_into with the survivor's revision; split_from), runs (kind, session, range, prompt version, model, input as sent, output, outcome success|failure|cancelled, time), knowledge_marks (knowledge revision, verified|flagged, time), pending_deliveries (noting results awaiting injection into a session). Referential checks and revision matching live here. All writes of one run are one transaction.
- `core/noting`: freezes the noting material (rendered pending entry views, recent facts by freshness, active knowledge, the head reply, the source index, the range) as structured parts, never as a message, calls `runAgent` with the four tool definitions bound to the run, and commits the one `note` batch the model submits (facts, run record, exact entry progress, pending delivery) in one transaction.
- `core/consolidation`: freezes the consolidation material (the fact addresses, all facts in range with annotations, context facts by freshness, active knowledge, the negated-evidence reminder) as structured parts, never as a message, calls `runAgent` with the bound tools, answers the first `memory` batch with NEAR, CLOSER and the checklist, and on the second batch runs accounting (every user fact and question in range cited or listed in `skipped`), applies create/update/merge/archive as revisions, and commits with the run record. Diagnostics (numbers not found in cited facts, an item over 200 tokens, NEAR without an update or merge after the feedback round) are reported, never rejected.
- `core/render`: one shared entry renderer for automatic Raw (see Completed source entries and compressed Raw below). Explicit Turn preview rendering: user message and assistant text uncut; per tool call a fixed metadata line (ordinal `#t<n>`, tool, status, omission flag), command cut at line boundaries to a token cap, stdout head/tail, stderr tail, reads and searches as name plus path, memory-tool writes as a receipt line, reports head/tail; every cut carries an omission marker with the count. Fact line and knowledge line formats per CONTEXT.md, relations at line end with continuation lines for quote and source. XML injection blocks with a fixed header, category tags in fixed order, no volatile attributes; dynamic receipts appended after the stable content. Budgets are parameters; defaults: command 120 tokens, stdout 60 head 120 tail, stderr 120 tail, reports 200 head 80 tail, knowledge block 10K, episodic block 20K (oldest facts dropped first, raw tail kept). Token estimate is a local heuristic, no tokenizer dependency. Grilling Q12 ruled two weights over character classes, 0.75 per CJK character and 0.25 per other; measured against a real tokenizer that ran 28% low on Chinese and 46% high on English prose, and refitting the two constants left the Chinese shortfall at 23%, because the residual is not on that axis. The user ruled for the segment method on 2026-09-07: the text is split on whitespace and punctuation runs and each segment is priced by its own rule (CJK by script, digit runs by three, short segments and common lowercase words at one token, punctuation runs, a default ratio otherwise), the shape used by tokenx, whose ratios are calibrated against o200k_base. Two rules are ours and measured here: runs are priced across letter/digit boundaries, because this project's own addresses are that shape in every line a budget measures, and a run of horizontal whitespace costs the single token a tokenizer holds for it whatever its width. Accuracy over 20 corpora of this project's text: 7.2% mean absolute error, at worst 15% under and 19% over. Over-counting only wastes budget room while under-counting overruns it, so the estimate is allowed to run high and held close on the low side. `core/render/index.test.ts` pins the bound against true counts recorded offline; Claude's tokenizer is not public, so o200k stands in for it.
- `core/api`: the façade `TraceMemory(dbPath, runAgent, config)` exposing `noting`, `consolidate`, `compact`, `inject`, `deliver`, `trace`, `search`, `status`, `declareProject`, `mark`, and `tools(context)` returning the four model-facing tool definitions bound to a run or to the main agent's session. Hosts call only this.
- `core/prompts`: `noting.md`, `consolidation.md`, versioned by content hash recorded in runs.
- `hosts/pi`: reconciles persisted eligible entry completions at safe hooks (checks Noting at ≥10,000 pending compressed-view tokens and Consolidation at ≥50 applicable unconsolidated committed facts; `agent_settled` retains delivery confirmation), `session_before_compact` (returns the compaction block, cancels nothing, calls no model), `session_before_tree` (returns committed memory plus pending compressed Raw as the summary without extraction), `before_agent_start` (injects the knowledge block at session start and any pending noting deliveries), the four tools from `tools(context)` (`trace`, `search`, `note`, `memory`), command `/trace` (native enrollment/settings/runs/status menu; `/trace status` reads status; `/trace project <name>` declares the project; `/trace mark K<n> <kind>` marks a knowledge item). Owns all model-context assembly (ticket 19b): `hosts/pi/compose.ts` lays core's frozen material out into messages, and both runners use it. Implements `runAgent` two ways: branch mode builds a pi-ai call whose system prompt and messages are byte-identical to the session's current request plus one appended user message; subagent mode builds a fresh call with the full rendered material. Noting defaults to branch mode with the session model; consolidation defaults to subagent mode with the session model; both overridable. In branch mode the appended message carries the noting prompt, range, head reply and frozen source index: the raw turns, the facts delivered after earlier notings, and the injected knowledge are already in the conversation (user ruling 2026-09-06 08:53). That premise fails for a noting result committed after the current prompt started, since deliveries land at prompt start: the host does not start a branch noting while such a result is undelivered and lets the next eligible completion after delivery confirmation start it. Subagent mode carries the full rendered material. In consolidation branch mode the candidate round appends the consolidation prompt, the range and the exact list of facts to integrate to the captured prefix, and the final round appends the candidate reply (replayed in the provider's native assistant shape) and the feedback message to the verified candidate request. Tool calls in either mode are executed and the model is called again on the extended request (see Write tools).
- `hosts/cc`: placeholder; not in v1.

### Contracts

- `runAgent(input) → {outcome: success|failure|cancelled, output, usage, request}`; the model writes only through the core's write tools (see Write tools), never to the store directly. `input` is structured task material — domain prompt and hash, frozen range and knowledge commits, mode, the `material` parts, `entryAudit`, tools, `reportRequest`, and for Consolidation `reviewFeedback` — and never a system or user message, a provider body or a mode-specific concatenated string (ticket 19b). A host that cannot expose a provider request returns `audit: {available: false, reason}` instead of `request`.
- Triggers, budgets, models, and modes are configuration with the defaults above.
- Facts are never hidden or deleted; relations are annotations. Knowledge changes only through immutable commits (see Knowledge commits and paths).
- Project attribution: `.trace-memory` marker found upward from cwd, or the host command `/trace project <name>` (the user's act, not the model's); the in-session declaration wins; an undeclared session is its own project; merging relabels facts and project-scoped knowledge.
- Session ids are allocated at the first assistant reply.
- Addresses: `K<n>`, `K<n>@<commit>`, `K<n>@<a>..K<n>@<b>`, `K<n>..`, `F<n>`, `F<n>..` (later strong negations, branching), `T<n>`, `S<n>/T<m>`, `S<n>`, comma lists; `cursor` continues any listing; `tool` and `full` are trace parameters, not address flags.
- Prefix-identical calls are verified once by comparing provider request bodies through `before_provider_request` and checking cache-read usage; if the check fails, noting falls back to subagent mode and the run record says so.

### Vocabulary (user ruling 2026-09-07)

The two phases are Noting (the Noter writes facts) and Consolidation (the Consolidator writes knowledge). "Note", "settle", "entry" as a synonym for knowledge, and "settlement" are retired: modules, prompts, run kinds (`noting` | `consolidation` | `manual`), configuration keys, façade methods, tables (`knowledge`, `knowledge_revisions`, `knowledge_links`, `knowledge_marks`), and the address prefix (`K<n>` replaces `E<n>`) follow the new words. Source entry now names a completed native conversation occurrence; it is never a synonym for knowledge.

### Write tools (user ruling 2026-09-07, shape refined 2026-09-07)

Four tools and no other model-facing surface: `trace` and `search` read; `note` writes facts; `memory` writes knowledge. The Pi host registers all four for the main agent, and Noting and Consolidation runs use the same definitions. Because the extension's own tool definitions are part of the captured provider request, branch mode inherits them with the prefix unchanged; nothing is added per run. The main agent may call the write tools but is not prompted to: writing is the runs' job, and the tool descriptions say so.

- Both write tools take one batch and treat it atomically: every item is validated with the existing shape rules; if all pass, the batch commits in one transaction; if any fails, the result lists each item's outcome in order (`ok` or `rejected: <reason>`) and nothing is written. The model corrects and resubmits the whole batch. There is no staging and no temporary object lifecycle.
- Read tools: `trace({address, tool, full, cursor, cap})` and `search({query, layer, cursor, cap})`. The address grammar is location only (`F<n>`, `F<n>..`, `K<n>`, `K<n>@<rev>`, `K<n>@<a>..<b>`, `T<n>`, `S<n>/T<m>`, `S<n>`, comma lists); display options `tool` (ordinal) and `full` are parameters, and the former per-output `cap=` address flag is gone, leaving the listing `cap` as the one budget entry. Expansion hints in rendered output name the parameter form. `F<n>..` is navigation along later strong negations, showing every intermediate fact and relation and branching; it ends with "no later strong negation recorded" and never implies a current conclusion. `layer` (facts | knowledge | raw | all) is the memory layer; `scope` keeps its meaning of session | project | global. Visibility is bound to the calling session: global knowledge, the project's knowledge, the session's own session-scoped knowledge; facts and raw within the session's project.
- `note({facts})`: each fact carries category, actor, text, quote (optional), source, support, negate, and `status` (completed | reported | dispatched | attempted; required for `event`, forbidden otherwise; the text carries no prefix, the renderer prints one). The fact's time is taken by the system from the turn of its first source; the model writes no timestamp. Sources address `T<id>#user`, `T<id>#assistant`, or `T<id>#t<n>`. `$n` refers to an earlier fact of the same batch, nothing else; after a commit the result lists each fact's `F<id>`.
- Run outcomes are distinguished, never conflated: a run whose model stops normally without ever submitting is a success with zero facts and only the selected entry identities advance (zero output is normal); a run whose last submission was rejected and never corrected before the model stopped is `bounced`, the batch stays in the run record, entry progress does not move and the next trigger retries; length, cancellation and provider errors are `failure` or `cancelled` and advance nothing. A Noting run commits at most one batch.
- `memory({operations, skipped})`: every operation has one shape: `op` (create | update | merge | archive), `id`, `absorb`, `text`, `category`, `scope`, `supports`, `because`. `because` is always required. create, update and merge state the complete resulting knowledge (text, category, scope, supports all present; supports is the full replacement set, earlier supports stay in revision history). `id` names the target of update and archive and the survivor of merge; `absorb` lists the merged-away items and appears only on merge; archive carries only `id` and `because`. A field that does not apply to the operation is rejected, never ignored. merge is one transaction: the survivor's new revision, the absorbed items' status and links. `skipped` lists `{fact, because}` for range facts that form no knowledge and replaces `not_admitted`.
- Consolidation keeps its two rounds through the tool: the first valid batch is not committed; the system computes NEAR and CLOSER over it and returns them with the checklist as the tool result; the second valid batch (unchanged or corrected) commits after accounting and diagnostics. NEAR is answered by update or merge; an unanswered NEAR is a diagnostic. Concurrency: a run applies operations on the revisions it read at start and rejects an operation whose target moved on; main-agent calls use the current revision; SQLite immediate transactions serialise writers.
- A main-agent call commits at once as a run of kind `manual` bound to the calling session, branch and turn; the tool input is its request and the tool result its response. Such facts count toward Consolidation and accounting like any other; fact sources must belong to the calling session.
- Marks (verified | flagged | clear on a knowledge item) and project declaration are the user's acts, not the model's: host commands `/trace mark K<n> <kind>` and `/trace project <name>`, backed by façade methods. The former `mark` tool is gone.
- Hosts execute tool calls in both modes and call the model again until it stops (an optional per-kind budget `maxToolRounds`, default 0 = unlimited, turns a run that exceeds it into a failure; by design Noting takes one round, two or three with fetches or a corrected batch, Consolidation two, three with a correction): in subagent mode by extending the conversation, in branch mode by appending the assistant call and the tool results to the verified request, so the prefix never changes and branch Noting can fetch cut evidence through `trace` as well. The run record stores the last request sent (which embeds every earlier round) and the sequence of tool results.
- Rejected alternatives: whole-batch JSON text output (one malformed character bounces the batch, no per-item errors, output bounded by one reply); provider structured outputs (provider-specific, and they change sampling fields inside the branch prefix); a staging protocol with handles, withdraw and acknowledgement operations (a second object lifecycle for no demonstrated need); mark and skipped as knowledge operations (usage feedback and accounting are not knowledge management).

### Knowledge commits and paths (user rulings 2026-09-07)

Knowledge is git-like: `K<n>` is a stable identity; every change is an immutable commit with a global integer id, addressed `K<n>@<commit>`. A commit carries text, category, scope, supports, because, its parent commit (several for a merge), and the run that made it. Nothing is edited in place; `current_revision` and `status` are gone, the current commit is computed per conversation path.

- **Applicability** (user, A): a commit applies on the path from the session's root to the target turn when every fact it cites (supports and because) from this session lies on that path; facts from other sessions do not restrict, and a session-scope commit applies only in its own session, a project-scope commit in its project, a global commit everywhere. The current commit of `K<n>` on a path is an applicable commit with no applicable successor. Rewind is therefore computed, not snapshotted: on an ancestor node, later commits of this session drop out by their evidence; other sessions' commits are shared regardless of time.
- **Citation rule** (user): supports and because may cite facts on the writer's own path; a project-scope commit may also cite facts of other sessions of the project; a global commit facts of any session. A sibling branch's facts are never citable: adopt them by noting a fact on the current path first (the fact may quote the source address). Reads stay unrestricted.
- **Concurrency** (user, B): a batch names, for each update, merge or archive, the commit it was based on (the path current when the Consolidator read); at commit time that base must have no applicable successor on the writer's path, otherwise the whole batch is rejected with the current commit and the Consolidator re-reads and resubmits. Cross-session edits of a shared commit therefore stay linear; branches of one session diverge; another session that sees several tips of one identity gets them as labelled alternatives and the Consolidator merges them, never last-writer-wins. No shared-head registry.
- **Archive and merge** are commits: an archive commit has no text and retires its parent on the paths where it applies; a merge commit has several parents. Other paths keep using the old commits.
- **Marks** attach to commits (`/trace mark K1@57 verified`); a bare `K1` resolves to the caller's path current, and a write with a bare `K1` is rejected when several tips exist.
- **Addresses**: `K1` (path current; without a path context: the single tip, or the list of tips labelled newest-created), `K1@57` (one commit), `K1@57..K1@61` (diff between two commits of the same identity), `K1..` (the commit tree, all branches). Commit ids are global integers like every other id (ruling 09:43); no hashes.
- **Tree switch** (user ruling 2026-09-07): the summary carried to the new position is one XML block (`<branch_carry>`) listing the leaving branch's facts, its commits, and unrecorded raw, computed by evidence. It opens with a fixed reminder: this is knowledge from another branch; it must not be written as facts; the Noter's facts come only from the current branch's conversation, never from messages this plugin injected. Nothing in it becomes a constraint of the current path until adopted through a fact recorded on this path.
- **Injected messages are not sources** (same ruling): the knowledge block, deliveries, the compaction block and the branch carry are the plugin's own messages; a fact may cite only `T<id>#user`, `T<id>#assistant` and `T<id>#t<n>` of the current branch, and the Noter prompt says so.

### Schema note (from the simulation driver)

The simulation driver's validation and application logic is the executable prototype of `core/model`, `core/consolidation` accounting, and revision application; port its behaviour, not its Python.

### Completed source entries and compressed Raw (17a, 2026-09-08)

A source entry is a completed user, assistant or tool-result message, identified by
its native entry id within its session lineage and owning Trace Memory session.
It retains its owning Turn and native tool-call occurrence identities with stable
Turn tool ordinals. Repeated identical assistant messages are distinct occurrences.
Only persisted ancestry supplies identities: Pi persists messages after extension
`message_end` hooks, so the host reconciles at the next safe boundary and on attach.
Earlier native history is imported, known identities reused and missing parents or
owning user entries reported without inventing content. Streaming, thinking-only,
empty, plugin, state, compaction-summary and background-worker messages are excluded.

One renderer supplies subagent Noting, fallback, compaction and branch-carry Raw.
`render.toolCallTokens = 1000` limits each call's name, identity, arguments, result,
status and labels; arguments and result permanently reserve half each, leaving two
tokens for joining fragments. `render.entryTokens = 10000` then limits the complete
entry, including natural language, all source labels and omission markers. Values
are decimal positive safe integers in the existing configuration system. Oversized
lines and JSON values retain character-level head and tail with omission counts
and `middle not inspected` markers. Impossible metadata capacity reports an error;
unprocessed entries remain pending. Existing outer budgets measure the compressed
views, retain whole pending views with overage receipts, and omit whole older facts.
The shared token estimator is unchanged. Original native messages and complete tool
arguments/results are retained; explicit full trace reads retrieve them under the
existing pagination protocol. Default explicit trace previews retain their contract.

Branch-mode Noting reads the uncompressed captured provider prefix and gains
nothing from this view, as accepted on 2026-09-08. Its request remains that exact
prefix plus one user message containing the instruction, range, head reply and
frozen source index. Exact-prefix verification and fallback stay unchanged.

Noting progress is exact entry membership on a path. Each run freezes its entry
set and records native identities, owning Turns, branch, view-budget version/values
and exact omission markers in `entryAudit`. Success, including zero facts, commits
only those entries atomically with facts, the run and applicable deliveries. Later
same-Turn entries remain pending and cannot become eligible citations for that run.
Reads remain unrestricted. Shared processed entries are inherited on forks; native
ancestry determines selected membership, independent of delivery confirmation.
There is no Turn-coverage migration, compatibility translation or second delivery
protocol. Ticket 17b removed the derived Turn boundary and its readers/status line.
Ticket 17c adds the shared task admission and lifecycle below.

### Enrollment, baseline and settings (18a, 2026-09-08)

Enrollment is one durable switch per memory identity. The store saves the derived
default separately from a nullable explicit choice; explicit intent wins permanently.
The host supplies the native Pi header creation timestamp and installation baseline;
core imports no Pi SDK. Native timestamps strictly after the baseline default enabled;
earlier, equal, missing or malformed values default disabled. Database presence is
not an opt-in. The host atomically publishes one `trace-memory-baseline.json` in Pi's
agent directory at first successful initialization and retains it across restarts and
upgrades. This cannot recover an earlier package-manager installation date.

Before the first assistant reply, a persisted Pi custom state holds provisional
intent. Because Pi defers native file creation until an assistant exists, an atomic
host-state receipt in the agent directory also preserves this provisional entry.
Allocation transfers it without an artificial Turn; afterward the database switch
is authoritative. Restoring tree position
recovers the current allocated identity independently of historical state; forks and
clones carrying that identity share its current database switch even with newer headers.

Enabled sessions ingest and reconcile current-path native sources, inject knowledge,
deliver both result kinds, accept manual writes and check 17b thresholds. Enable and
re-enable import available history, including the paused interval, locally through
17a reconciliation without any provider call or synthetic completion. Import does
not drain work; the next ordinary eligible completion checks queues.

Disable persists first. Core gates source mutation, automatic admission, automatic
blocks and delivery confirmation; Noting and Consolidation reread enrollment inside
their immediate commit transactions. Late business writes and progress are rejected;
failure audit records remain valid. A batch committed before disable stays successful.
Stored Raw, facts, knowledge, scope and runs remain. Disabled hosts return no compaction
or carry override, allowing Pi's native fallback. Unseen deliveries remain unconfirmed;
already-injected text is not removed. Trace, search and status remain unrestricted.
Disabling this executor also requests cancellation of its workers after persisting enrollment and invalidating their tokens. Other executors still recheck target enrollment at commit.

Configuration is a flat object under `trace-memory` in Pi's global `settings.json`
(`PI_CODING_AGENT_DIR` or `~/.pi/agent`) and project `.pi/settings.json`, project over
global, with flat `TRACE_MEMORY_CONFIG` JSON on top. The retry-settings file reader is
shared. Every layer is validated, including masked values; unknown/removed keys fail
by name. Counts and token budgets are positive safe integers; the existing
`maxToolRounds: 0` unlimited sentinel and `nearThreshold` similarity in [0,1] retain
their meanings. Modes are booleans. Impossible source-view capacity still reports
an error and retains pending work. The plugin never writes settings.

Bare `/trace` uses native select/confirm/input dialogs for Current session (state,
default or explicit origin, enable/disable and shared-identity scope), Catch up,
Stop, Settings (labelled Global, read-only, effective values, sources and masked
values), Runs and Status. Cancel changes no enrollment choice. Headless bare
`/trace` prints status and available commands. `/trace enable`, `/trace disable`,
`/trace catchup`, `/trace stop`, `/trace status`, `/trace runs [n]`, `/trace
project <name>` and `/trace mark K<n>@<commit> <kind>` share existing operations;
menu actions and commands call the same operations, and the catchup handler
returns control to the TUI immediately so stop can be invoked while it runs. The
existing footer adds Disabled while retaining its indicator, colors, counts and
spend.

### Manual catchup and stop (18b, 2026-09-08)

`/trace catchup` targets the current enabled session's selected branch only. If
disabled, it rejects with the enable instruction rather than silently enrolling
the session. It first reconciles available native history (17a), then freezes a
finite target: the highest currently-pending source-entry id for Noting
(`undefined`/nothing if none is pending) and the exact set of currently-pending
fact ids for Consolidation. An empty target completes with no model call.
Repeating `/trace catchup` while one is active reports the existing operation;
it never creates a second one or extends the snapshot.

The drain runs bounded Noting batches against the frozen entry-id boundary —
ignoring `noting.triggerTokens` and `consolidation.triggerUnconsolidatedFacts`,
not `noting.batchTokens` or model context — then one Consolidation batch against
the frozen fact set extended with every fact those Noting batches went on to
produce. Both phases run in subagent mode, regardless of configured defaults or
a session's automatic fork downgrade; normal task delivery and audit attribution
stay bound to the target session. A host-local controller (not the core façade,
not `checkQueues`) is the sole place that schedules the next batch on completion
of the previous one — the one explicit exception to 17b/17c's no-completion-
chaining rule. Ordinary entry events never expand the frozen target or start a
second local scheduling loop; a failure or cancellation ends the invocation and
leaves unprocessed work pending, with native bounded provider retries inside a
run unaffected.

The core façade enforces the same frozen target: `noting`/`consolidate` accept
an optional `boundary: { maxEntryId?, factIds? }` on their input, threaded into
`freezeNoting`/`freezeConsolidation`'s existing selection queries and into
`execute`'s pre-freeze emptiness check, so a bounded call cannot silently see
past its snapshot even if a host bug tried to let it. The drain reuses 17c's one
Noter slot, one Consolidator slot and one target-phase claim per executor;
no second queue, worker pool or claim table exists. An occupied slot or a live
foreign claim on the same target is exposed as Waiting, never stolen, and is
retried only on that slot's release or the next ordinary eligible-entry
opportunity — no polling timer.

`/trace stop` first sets the controller's own stop flag, disabling further
chaining regardless of what the in-flight batch returns, then calls the
façade's existing `cancelTasks()` — the same fenced cancellation 17c's shutdown
uses — for this executor's active model calls and retry waits, both the
catchup's own and any ordinary/borrowed work. It does not set the shutdown
`stopping` flag, so future ordinary or explicit admission for this executor
remains possible; it never changes enrollment or configuration, never touches
the foreground agent, and never releases another executor's claim (the store's
per-executor invalidation and token-conditional release already scope to the
calling executor). With nothing running or waiting it is a harmless no-op. A
batch already committed before cancellation wins stays successful and is never
replayed; a cancellation that wins leaves its queue entries pending.

Disable, executor shutdown/session replacement, and switching away from the
catchup's frozen session or branch all end an active catchup through the same
cancellation path, never retargeting its frozen task to a newly selected branch
and never resuming the drain automatically on reopen or re-enable; none of
these events launch a lifecycle flush. `/trace status`, the menu's Current-
session entry and the footer text report the drain's actual state: running
(phase and bounded progress), waiting (occupied phase), completed, stopped
(with how much of the frozen target was processed and that it stays pending)
or failed (with the diagnostic).

### Run boundaries

- A noting run freezes, at start: the session, the branch, the oldest contiguous pending source-entry prefix on the selected ancestry within `noting.batchTokens` (default 50,000 compressed-view tokens including separators), their owning Turns and immutable views, and the knowledge revisions it read. On success it commits its facts, the run record, only those entry identities marked processed, and a pending delivery bound to that branch — all in one transaction. It never processes entries that arrived while it ran, even inside the same Turn; those wait for the next eligible entry completion. The effective batch can be smaller to reserve instructions, knowledge, tool definitions, output and existing model context. If the oldest entry cannot fit, it stays pending with a capacity problem; it is never skipped. The host uses the shared estimator with a 15% context margin and the model output limit. The native branch prefix is never rewritten; its size is additional to the 50,000-token new-material limit.
- An Consolidation run freezes the fact range and the knowledge revisions it read. It applies operations only on top of those revisions; if an item moved on meanwhile, that operation is rejected with the reason and, as for any rejection, the batch writes nothing: the Consolidator resubmits without it or after re-reading. (Supersedes the earlier "the rest commit" rule; the write-tools ruling makes every batch atomic.)
- Each enabled active Pi executor has one Noting slot and one Consolidation slot, reserved before asynchronous admission. Each target memory session has at most one valid claim per phase across branches, hosts and processes. Both ordinary and borrowed work acquire this claim. Each Consolidation run covers only its frozen target path; sessions of one project consolidate separately (user ruling 2026-09-06 09:43).
- Failure or cancellation commits nothing but the run record. A run's business result is whether a batch committed: once the write tool has committed the batch, the run record, entry progress and the delivery in one transaction, the run is a `success` whatever the model does afterwards; a provider failure after that point is recorded in the run record's response only, and a committed batch is never undone. `failure` / `cancelled` (nothing committed), `bounced` (last submission rejected, never corrected), and success with zero facts (stopped normally without submitting) are therefore mutually exclusive. A branch switch while a noting run is pending lets the run finish against its frozen branch; its delivery goes to that branch only. The branch summary for the abandoned branch uses committed facts plus the rendered raw for anything still unrecorded; it never silently drops raw.
- Two behaviour cases the tests must cover: a new turn arrives while the model has not returned; the user switches branch while the model has not returned.
- Consolidation batches (2026-09-07 ruling superseded 2026-09-08 by 17b): fifty applicable unconsolidated committed facts trigger a run; selection takes eligible facts on the frozen path without Turn grouping, whole-Turn completion or a first-Noting gate. The threshold is not a promise to take exactly fifty. Consolidation progress remains the `consolidated_facts` set (peer review 2026-09-07): each run records its exact membership, and a fact counts as consolidated on a path when one of the runs that took it took only facts on that path. Late facts on earlier Turns are neither skipped nor reconsolidated because of their ids.
- Each eligible entry completion checks both queues independently. `noting.triggerTokens` defaults to 10,000 compressed-view tokens from `renderEntry` over `pendingEntries`; no entry-count or answered-Turn trigger exists. `noting.batchTokens` defaults to 50,000; both and the view limits are validated positive safe integers. Unknown and removed configuration keys are errors. Finishing a worker starts nothing; excess work waits for a fresh eligible completion. Existing provider retries remain within a run.
- Compaction, shutdown and tree switching launch neither extraction phase and preserve pending work. Tree summaries and compaction use committed memory plus the shared pending view. Shutdown cancels and fences workers under the bounded lifecycle below; tree navigation lets its already-running worker retain the frozen path.

- A Pi fork or clone whose copied path carries Trace Memory state continues the same Trace Memory session on a new branch id: same facts, same project, sibling-branch rules apply, and the new branch inherits processed shared entry identities, so shared entries are recorded once; consolidation progress needs no inheritance, since it is per fact and judged against the new branch's own path. A copy without plugin state starts a new session.
- **Enrollment controls delivery** (user ruling 2026-09-08, superseding the 2026-09-07 consumer matrix): enabled sessions receive both `<noted>` facts and `<consolidated>` knowledge commits regardless of Noting or Consolidation mode. Worker modes control execution only. Facts absent from conversation, including manual notes, remain available through unrestricted `trace`. Initial knowledge injection and compaction are separately enrollment-gated.
- A branch run does not start while a delivery it would read is pending: a branch Noting waits for a pending fact delivery, a branch Consolidation waits for either kind. The next eligible completion after settled delivery confirmation supplies another opportunity; confirmation remains at `agent_settled`.
- Deliveries and the first knowledge injection are confirmed at the turn's `agent_settled`, after Pi has persisted the message; only the run ids that prompt took are confirmed, results committed during the turn wait for the next prompt, and confirmation is bound to the ids, not to the current session state. A turn that never settles delivers or injects again: duplicates are allowed before confirmation, silent loss is not (user ruling 2026-09-07).

### Shared tasks and lifecycle (17c, 2026-09-08)

An executor is an enabled active Pi runtime; a target is the memory session and
branch it processes. Each eligible entry completion offers one opportunity in each
free phase slot. Own work under the normal 10,000 compressed-token / fifty-fact
thresholds wins. If it cannot be claimed, consider other enabled normally closed
targets with nonempty phase queues, ignoring thresholds. Order those targets by
oldest pending source-entry id or fact id, then session id and branch name. Global
allocation ids supply stable pending arrival order. A phase may select a branch
with no pending work in the other phase. Never combine sibling branch ranges.

The existing source/progress memberships supply the logical queue; only ownership
is newly persisted. Claim acquisition and eligibility checking share an immediate
transaction, which ends before a model call. Claims carry executor id, random
ownership token and a thirty-minute expiry. A failed acquisition may try another
target. Freeze target project, branch and evidence before calling the model.
Borrowed work always uses subagent mode; own work retains configured/effective
mode and branch-delivery gating. Runs, cost, commits, progress, audit and deliveries
belong to the target. A changed target project rejects a commit rather than
silently moving the frozen batch's attribution.

Both commit transactions recheck the current unexpired token and target enrollment;
borrowed work also requires the target still closed. Pi supplies its own memory
session id for an enrollment recheck at admission and commit, so an externally
disabled executor cannot keep borrowing enabled targets. Releases compare tokens and
executor ids. Expiry can recover ownership but never implies closure. A running
borrowed worker is not preempted by new own work. Slots release only when workers
finish or teardown fences them. Completion launches nothing; later eligible
entries supply the next bounded opportunity. No heartbeat, liveness discovery,
polling or continuous drain exists.

Normal shutdown sets `sessions.closed_at`; runtime restoration clears it. Restore
immediately replaces another executor's claims with fresh reserved tokens for the
restoring executor, without launching work or waiting for expiry/release. The next
eligible admission consumes the reservation after checking current queues and
thresholds. Old workers cannot commit or release the replacement. This also lets
a crashed conversation resume despite its abandoned own claim. A crash creates no
closed mark; until resume its unclosed tails are ineligible for borrowing. Ordinary
tree navigation is not executor restoration and retains its existing worker.

Shutdown and foreground session replacement stop scheduling, invalidate owned
tokens, close their tool bindings and signal active provider calls and retry waits.
One five-second cleanup deadline covers both slots. Teardown switches SQLite busy
waiting off so competing writers cannot multiply the deadline by blocking the
event loop. At the deadline, finish local waits with cancellation diagnostics,
retaining available request/usage, then release claims conditionally, mark only
the executor's own session closed and close SQLite. Borrowed targets keep their
closure state. Late promises are rejection-handled and cannot access the closed
store. No model is started for shutdown or compaction.

A business commit that wins first stays successful, even if its final reply, audit
update or claim release fails. Cancellation that wins first permits no business
writes or progress. Uncommitted work remains queued. Cancellation without returned
usage is labelled unknown; partial counters are known usage only, not total cost.
Cleanup/audit failures are reported without undoing business commits or waiting
indefinitely. If a locked/unavailable database prevents persisting closure, report
that failure: do not infer normal closure afterward. Forced process death retains
the existing precommit audit gap. No child session runtime or manual catch-up/stop
command is part of this slice.

### Overflow policy

- Compaction never refuses and never calls a model. The episodic block is assembled in this order: pending completed entry views (kept whole, each bounded by the shared view limits), then recent facts newest-first until the 20K budget is reached. If the raw alone exceeds the budget it is still kept whole and the receipt states the overage; nothing unrecorded is dropped.
- The knowledge block is assembled in category order; whole categories from the end of the order (reference, term, mechanism, …) are left out when the 10K budget is reached, and the receipt names the count and the trace address to fetch them. Constraints, open items, and disputes are never left out.
- A noting run in subagent mode may fetch any tool call's full text by address (the same read path as trace); the run record lists what it fetched. Evidence it did not fetch stays at the level the preview supports: a cut result cannot justify `completed:`; a cut report is `reported:`.

### Run record contract

- `runAgent(input) → {outcome: success|failure|cancelled, output, usage, request}` where `request` is the exact request as sent to the provider (system prompt, messages, tool definitions), filled by the host. The core stores `request` as the record of what the model saw; since 19b it has no assembled input of its own to store. A host that declares `audit: {available: false, reason}` records that limitation in the response JSON instead of the missing-request problem; a host that returns neither still gets the problem. The response also carries `requestedMode` beside the run's actual `mode`.
- Every attempt that ends is recorded: success, bounced outputs, feedback rounds, failures, and cancellations. A process death before the commit leaves no run record; the raw and entry progress are untouched and the range is re-run at the next trigger (user ruling 2026-09-07: business safety, not per-attempt audit). Business writes are one transaction per successful run; run records are written regardless.
- Branch-mode verification compares request bodies structurally (system prompt and message prefix) against the session's own last provider request; cache-read usage is an additional observation, never the proof. The verification is re-run whenever the model, provider, or tool definitions change.
- Optional host result fields: `nativeLog` is the absolute path of a host-side native worker log for the run, stored in the response JSON alongside `verification` and `fallbackReason`. The core never opens it; it is a pointer for inspection, not an audit of the provider request (19a).
- 19a adds a second Pi implementation of the same contract behind `nativeRunner`: a native Pi child session forked at the parent's persisted leaf runs branch-mode work, and its first outgoing body and every later round face the same byte-level prefix verification with one normalization (user ruling 2026-09-08): `cache_control` markers are stripped from both sides before comparison, because pi-ai moves the Anthropic breakpoint to the body's last user message; nothing else is ignored, hashes are of the raw bodies, and the verification records `normalized`. When the child cannot be prepared or its body is rejected, nothing is sent and the task continues with `fallbackReason` and the rejected gate result under `verification.native`. 19b extends the same runner to fresh-context work: explicit subagent tasks, fork fallbacks and borrowed closed-session work run in a private `SessionManager.create` child in the runs directory, with discovery disabled, only the four memory tools registered, core's domain prompt as its system prompt and no gate (there is no parent body to reproduce); with `nativeRunner` on the request-copy runner serves only a child that cannot be constructed at all.

### Consolidation feedback loop

The initial consolidation input separately lists every visible active knowledge whose current `supports` contains a fact negated by a fact in the frozen consolidation range. Include the knowledge, the cited fact, and the new negating fact with the relation's recorded strength, using the shared renderer. Include all matching knowledge, not just lexical neighbours; both strong and weak negations are review cues. This listing derives no status and requires no new acknowledgement field: the Consolidator judges whether to edit, merge, archive, or retain each knowledge. Missing or incorrect relations and incomplete supports can still cause misses; this is not a complete consistency check.

1. The Consolidator submits its candidate batch through `memory`; the system labels new items by their position in the batch for the feedback, and update or merge name the target knowledge.
2. The system computes NEAR for each candidate text against active knowledge and CLOSER for open and goal knowledge, then sends one user-role feedback message containing these hints and the second-round checklist in the consolidation prompt. The checklist checks adoption versus proposal, completion versus approval/reporting, object and condition fidelity, knowledge maintenance, and support from facts available in this run. This system-generated message is review guidance, not a human ruling or adoption evidence.
3. The Consolidator submits the complete batch again: unchanged if the check finds no problems, corrected otherwise. No checklist report, acknowledgement fields, or third review round. Each remaining NEAR is answered by update or merge; an unanswered NEAR is committed with a diagnostic, not rejected.
4. Accounting runs against the knowledge set as it will be after applying this round's operations (updates and archives included), listing user facts and questions in range that no resulting item cites; each must be cited or listed in `skipped`.

### Visibility rule

- Injection and consolidation see: global knowledge, the current project's project knowledge, and session knowledge of the current session only. Another session's session knowledge is never visible. An undeclared session's project is itself.
- Reads are not restricted (user ruling 2026-09-07: no need to restrict visibility): `trace` and `search` resolve any existing address in any project or session; the scope rule above applies to injection and Consolidation only. Writes still cite only the calling session's sources.

### Prompt and spec synchronization

- The prompts under core/prompts are the contract the model sees; this spec and CONTEXT.md govern their wording. The Output sections describe the `note` and `memory` tools exactly as the façade defines them; a difference between prompt and schema is a defect in whichever is newer.
- The simulation driver is reference only, at its frozen v7 version; its retired behaviours (hiding superseded facts, link-based accounting exemptions, hard number gates) are not to be ported.

### Schema

```text
sessions        id · host · enrollment_default (boolean) · enrollment_choice (nullable boolean) · started_at · first_reply_at · closed_at (nullable normal-close timestamp) · project_id · parent_session_id
projects        id · name · declared_by (marker | mark) · merged_into
turns           id · session_id · ordinal · parent_turn_id · kind (turn | compaction) · user_prompt · assistant_text · started_at · ended_at
tool_calls      id · turn_id · ordinal · name · input · result · status
facts           id · turn_id · category · actor · text · quote · source · created_at
fact_relations  from_fact · to_fact · kind (support | negate) · strength (strong | weak)
knowledge         id · project_id · origin_session_id · author
knowledge_revisions id · knowledge_id · parent_id · text · category · scope · supports · op · because · run_id · created_at
knowledge_links     from_knowledge · from_commit · kind (merged_into | split_from) · to_knowledge · to_commit
runs            id · kind (noting | consolidation | manual) · session_id · branch · range_from · range_to · prompt_hash · model · mode · request · response · outcome · created_at
knowledge_marks knowledge_id · commit_id · kind (verified | flagged) · created_at
pending_deliveries  run_id · session_id · branch · delivered_at
source_entries  id · session_id · native_lineage · native_id · turn_id · content (role, text, raw message, stable tool fragments)
source_paths    session_id · branch · entry_ids (selected native ancestry, not queue state)
noted_entries entry_id · run_id (successful processing membership)
consolidated_facts  fact_id · run_id
task_claims     session_id · phase (noting | consolidation) · executor_id · token · expires_at (epoch milliseconds) · borrowed · reserved (reopen reservation); primary key (session_id, phase)
```

Indexes: knowledge by project; runs by session. Search is a literal substring match (LIKE) over fact text, knowledge revision text and raw; no FTS, no ranking (user ruling 2026-09-07).

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
- Manual catch-up/stop commands and native child-session runtimes. Automatic closed-session tails and claims are included by 17c.
- Per-prompt automatic retrieval hints.
- Cross-project sharing beyond global scope.
- Any confidence score; any model-judged pruning of facts.
- Tuning the truncation defaults by experiment (recorded as a follow-up).

## Further Notes

- The number-in-cited-facts check and the 200-character knowledge cap are diagnostics, not gates.
- The consolidation prompt's strength rule: strong support only from explicit user adoption; execution and agent agreement are weak.
- Ids in a noting batch: the Noter references earlier facts of the same batch by `$n`; the store resolves them; predicting ids is forbidden.
- Simulation results that shaped this spec live in /tmp/mnemo-sim and the peer's regression suite; they are not part of the repo.
