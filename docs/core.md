src/core/ is host-agnostic: it must not import any host SDK.

- model/   Turn, Fact, Knowledge types and write-time validation (shape only).
- store/   SQLite: global ids, sessions, project attribution, facts, knowledge, knowledge revisions, run records.
- noting/    freeze the task material, provide tools, record the last provider request and final text.
- api/tools.ts  role-bound tools; atomic note/memory validation and commit; Dreamer's read-only check.
- dreaming/  bounded frozen knowledge/facts material, exact-family checks and transactional completion.
- consolidation/  freeze the Consolidation material, produce NEAR/CLOSER feedback, validate memory operations, account and commit revisions.
- render/  one renderer for noting material, compaction tail, branch summary, trace; XML injection blocks.
- render/material.ts  the shared material contract and the block layout of every consumer (20a).
- prompts/ noting.md, consolidation.md, dreaming.md — the prompt texts, versioned by content hash in every run record. Lineage (kept out of the model-facing text): the Noter descends from pi-observational-memory's observer prompt, the Consolidator from its reflector plus Magic Context's historian and curate tasks; the six fact categories, the relation model (support/negate with confidence strength, annotations only), scope fidelity, and disputes are this project's own.

Model calls go through one interface, runAgent(input) → {outcome: success | failure | cancelled, output, usage, request}, where request is the exact provider request the host sent; hosts implement it (Pi: fork mode = inherited context, or subagent mode = fresh context). Optional result fields ride along into the run record's response JSON: `verification`, `fallbackReason`, `retries`, `audit`, and `nativeLog`, the absolute path of a host-side native worker log for the run (19a). The core never reads that file. One result field is not recorded at all: `refused` (27c), by which a host says it would not run the frozen task in the mode it was admitted for and will admit it once more itself — core records no run for that attempt and returns the value to the caller unread, with `outcome: "dropped"`.

**Core builds no provider message or body; core owns the domain text (ticket 19b, revised by the
user's ruling of 2026-09-08 in ticket 20).** `runAgent` receives structured task material and core's
prepared text, never a system or user message, a provider body, a message sequence or an SDK type:
the domain prompt and its hash, the frozen range and knowledge commits, the mode, the tools,
`reportRequest`, `entryAudit`, one `material` object of rendered, budgeted parts, `text` — one
prepared string, whatever mode runs the task (29b; the `{fresh, inherited}` pair is gone) — and
`supplied`, the identities that text actually carries. The host decides which message carries the
text; it lays out no block of its own and chooses between no representations. Consolidation additionally supplies
`reviewFeedback(toolResult)`, core's own reader of a `memory` receipt: the host delivers the returned
guidance as a user message but does not parse the protocol.

**Audit availability.** A host that cannot expose a provider request returns
`audit: {available: false, reason}` instead of `request`; core records the limitation in the run
record and does not report a missing request. A host that returns neither a request nor that
declaration still gets the "runAgent must return the exact provider request" problem. The run
record's response also carries `requestedMode` beside the run's actual `mode`, so a fallback is
visible as requested-versus-actual.

## Dreamer execution (32d)

`dream({sessionId, branch, headTurnId, model?, thinkingLevel?, subagentThinkingLevel?})`
uses the existing claim/admission/cancellation path, always in subagent mode. Eligibility is
rechecked at admission. The retained range keeps its original anchor, path and writable family
through retries; the current exact versions are resolved afresh. Admission freezes material,
model/thinking and profile. It supplies processed knowledge within 20k, changed knowledge within
10k and whole direct facts within 10k, with framing and explicit omitted-fact receipts. Runtime
reads never extend the family. A retained body too large for admission stays pending, not clipped.
Only processed material exceeding 20k uses lexical relevance, with stable category/time/id ties.
The shared `budgetKnowledge` keeps optional `required` exact-commit IDs in its fifth argument and
an optional priority comparator in its sixth: required bodies are protected before optional selection,
including category and receipt framing. Ordinary callers without priority keep their stable order.

The host calls `Store.bindDreamingRun` only after claiming the target and assigning an execution.
It returns a capability object registered in a Store-local WeakMap, bound to the session, range,
claim token, execution and one run record. Tool arguments and role strings cannot construct it;
other database connections cannot reuse it. All batches reference that same admitted run. Legal
memory calls commit immediately; rejected batches roll back only themselves. Create is restricted
to an atomic split with a family update/archive; every compound participant keeps exact-handle
validation. Consolidator still uses candidate/review and fact accounting but rejects merge.

Only a capability-bound archive may use empty supports. Its nonempty reason is a maintenance
judgment, not factual evidence. The nullable `knowledge_revisions.actor_role` column is added to
existing databases, with a SQLite CHECK limiting populated values to `dreaming`; no history is
relabeled. The immutable revision carries role, run, parent and reason. Empty-support archive
applicability follows the exact parent (including original attribution), not an empty-list
vacuous truth. Trace and search distinguish maintenance retirement while preserving predecessor
text and factual evidence.

`DreamingAgentInput.passEnd(rounds)` is a host callback after the native prompt's complete tool
loop and retries, never after an intermediate tool turn. One system-generated custom message may
repair an invalid pass in the same child. `reportRounds` exposes the native counter to check;
`dreaming.maxToolRounds` defaults to 50 and accepts 1–50, shared across both passes. The child's
automatic compaction remains disabled through the existing in-memory Settings override.

The check tool and final host check use the existing full `checkProcessedScopes` routine:
global 4k, each project 10k, each session 1k, applicable 15k, framing included. No truncated view
proves fit. Current versions must be exact admission versions or this retained range's own outputs;
reading alone never certifies an external successor, and outside-family identities remain read-only. Completion
updates the run outcome, revalidates claims/versions/totals, settles exact event IDs, certifies
separate result IDs and settles the execution in one transaction. Replay has no second streak
effect. Failed/cancelled tasks keep prior commits and pending ranges without certification.

Prompt lineage: pi-om `ce9fc982b3a219a7839f07c9f4a3e054e81a2b21`,
`src/agents/dropper/prompts.ts`; Magic Context `246a1c390e9a81944b867c1cd94ae5b7166e26e3`,
`packages/plugin/src/features/magic-context/dreamer/task-prompts.ts` and
`curate-memory-safety.ts`. The prompt borrows conservative comparison and unique-detail retention,
not their scheduler, taxonomy, mandatory edits, citation-count scores or refusal heuristics.
This project's explicit hard-budget retirement can deliberately lose active information with an
honest reason and retained history; it does not require Magic Context's same-category survivor.

## Runtime and verification

Use Node 24.6.0 and install dependencies with `npm install` at the repository
root. The store uses built-in `node:sqlite` (`DatabaseSync`), prepared statements,
and immediate transactions with a five-second busy timeout. Nested transactions
use savepoints. No external SQLite dependency is needed.

Run `npm test` for the Vitest suite, `npm run typecheck` for TypeScript, and
`npm run smoke:pi` for a direct Node extension import and fake-provider noting run.

## Logical-task outcomes (32c)

A logical task is `(target session, phase, oldest selected backlog item)`, independent of its
execution's run ids and the changing leaf. Noting uses the first frozen source entry;
Consolidation uses the first selected fact, not a numeric minimum; Dreamer uses its retained
range's original event anchor, even after committed partial edits.

`Store.beginExecution(task, previous?)` creates a durable execution or continues the same
unsettled execution after fork refusal. Each attempt run carries `RunInput.executionId` and
is linked through `execution_runs`. The façade returns that identity with a refused attempt;
the host carries it in `TaskOptions.executionId` on fallback. Attempt audit outcomes do not
settle executions. Interrupted executions remain unresolved rather than inheriting an
intermediate attempt's failure or inventing success.

`Store.settleExecution(id, outcome, runId, reason?)` records one authoritative terminal outcome
and updates the logical task's streak in the same transaction. Replay observes the existing
outcome without applying it again. Successful Noting/Consolidation commits settle inside the
business transaction; subsequent provider or audit errors cannot reverse success. Dreamer
writes do not settle success: `completeDreaming` settles the linked execution only with its
validated exact completion sets. The Dreamer worker reuses the façade's existing terminal settlement and target cancellation path.
Its native provider retries and one repair remain inside the same execution; only final failure
updates the streak.

Final business failure includes incomplete Noting, unresolved submission refusal and failed
Dreamer acceptance after partial writes. Cancellation, shutdown, busy admission and corrected
refusals do not count. `Store.taskFailures(sessionId)` returns each key's count, latest reason,
last run and update time. Success resets its key; explicit enrollment on clears all target
streaks, while reopen does not.

The third failure atomically persists enrollment off and expires every target claim. The façade
then closes and aborts locally owned target tasks. Only the transitioning settlement returns
`automaticOff` for the host's single notification. Committed data and backlog survive; other
targets and a borrowing executor remain enabled. No automatic retry or re-enable follows.

## Noting and trace host contract (ticket 02)

Hosts pass completed source identities/content through `appendEntry(SourceInput)`
and select the persisted ancestry with `selectEntries(sessionId, branch, entryIds)`.
The exposed store's transaction groups ingestion with Turn/tool projections.
`notingBatch(target, boundary?)` answers what a Noting freeze of that target would
select — the pending set the boundary admits, cut to the oldest prefix that fits
`noting.batchTokens` — through the same selection `freezeNoting` uses, without
freezing, claiming or diagnosing anything (29c: the Pi host decides a fork's Raw
availability against exactly the entries the task will process).
`pendingEntries(sessionId, branch, headTurnId)` derives work from native path
membership and committed entry processing; it is not a queue of results for the foreground.
Call `noting({ sessionId, branch, headTurnId, model?, mode? })` at the existing
trigger boundary. The core freezes exact pending entries, owning Turns, rendered
views, recent facts and applicable knowledge before calling the model. A fork
uses a new branch identity even when its native source head changes inside the
same Turn. Shared processed entries are inherited by identity.

The noting result has `outcome`: `success` with `runId` and facts; `bounced`,
`failure` or `cancelled` with `runId` and problems; or `dropped`/`empty` without
a run record. A duplicate is dropped per target session and phase across branches,
hosts and processes by a thirty-minute SQLite claim. No automatic retry or feedback call follows a bounce.
A batch is completed only by a `note` call (26a). `note({facts: []})` is the explicit
empty submission: it commits a successful zero-fact run, processes exactly the frozen
entries, and closes the batch to later `note` calls.
Stopping normally without submitting is **incomplete**: outcome `failure` with the
exported `NOTING_INCOMPLETE` diagnostic and the oldest frozen entry on
`incompleteHeadEntryId`, the attempt and its usage recorded, and no business progress —
the same entries are frozen again next time. Final prose is never read as facts nor as an
implicit empty submission. An uncorrected rejected submission is `bounced`
and advances nothing. Failure/cancellation before commit also advances nothing.
A committed batch keeps outcome `success` even if the provider subsequently
fails or is cancelled; the trailing problem is recorded without undoing business
writes (user ruling 2026-09-07).

`runAgent` receives `NotingAgentInput` (material and control, above) with the four `tools` definitions:
`trace`, `search`, `note`, `memory`. Each has a name, description, JSON-schema
parameters, and synchronous `execute(input): string`. Hosts execute calls and
continue the provider conversation until it stops. `reportRequest(request)`
reports each exact provider request before tool execution; the returned `request`
is the last request sent. A result carrying no request — `null` or absent — leaves the last reported
request in the run record instead of erasing it; both phases finalize their run audit by one rule
(`core/api/audit.ts`). Final text is audit content, never parsed for facts.
`runs.response` holds final text, usage, frozen read knowledge revisions, fetched
trace evidence, the tool-call input/result sequence, problems and committed IDs.

`tools(context)` also binds these definitions to a main agent with
`{kind: "manual", sessionId, branch, currentTurnId}`, or to a Noting context
with `{kind: "noting", sessionId, branch, range: {from, to},
readKnowledgeCommits, entryIds}`. `note({facts})` validates every item and commits nothing
on any rejection; a corrected whole batch may be resubmitted. Success returns
`results` in order (`ok: F<id>`) plus `factIds`; rejection results are `ok` or
`rejected: <reason>`. An accepted empty batch returns `results: []`, `factIds: []` and
`committed: "zero facts; this batch is complete"`; a refused one, having no item slot to
carry the reason, returns a plain `rejected: <reason>`. A Noting binding commits at most one batch. The batch,
run record and frozen entry progress commit in one transaction.
Manual writes commit immediately as a `manual` run with the tool input/result
as request/response and enter only that branch's Consolidation range. They do not
advance Noting. `memory` writes knowledge with the uniform batch contract below.

Sources are `T<id>#user`, `T<id>#assistant`, or `T<id>#t<n>` in the frozen entry set
(Noting) or current selected source path (manual). Time is the first source turn's
`started_at`; timestamps from the model are rejected. Event facts require
`status` (completed, reported, dispatched, attempted); other categories reject
status. Text has no completion prefix; the shared renderer supplies it. Relations
retain `[target, strength]`, with `$n` restricted to earlier facts in the batch.
The v1 schema changes in place. No production-data migration, legacy coverage
translation or compatibility shim is provided.

Each phase's config chooses its fork/subagent mode (29e: `noting.forkModeDefault`,
`consolidation.forkModeDefault`), both defaulting to `false` (subagent) only when no explicit
configuration is supplied. Explicit `true`, the legacy `noting.branchModeDefault` alias and a task's
own `mode: "fork"` remain supported; provider prefix verification
remains the host's responsibility, as is the choice of runner behind a mode. Since 19c the Pi
host has one runner: fork work runs in a native Pi child forked from the session file, and
every subagent task — explicit, fallback or borrowed — in a fresh native child. Core sees the
same `runAgent` contract either way, and a host that cannot construct its worker at all returns
a failed run with a reason, which leaves the queue pending.

**Budget before selection (ticket 19 gate 4, ticket 20 capacity negotiation, ticket 27a).** The host
reports its available material budget (`capacity {inputTokens, prefixTokens}`) in the same
`noting(...)` call that starts the task. Since 27a `inputTokens` is the model's context window minus
the host's fixed 10,000-token headroom — no output reserve and no 85% multiplier enter it — and
`prefixTokens` is the host's own measure of the context an inherited-context run starts from, counted
once (in the Pi host, `ctx.getContextUsage()` frozen at admission; docs/pi.md "Request capacity").
Core prices against those two numbers and never learns how either was obtained: it reads no provider
request body, no image and no transport field.

Core selects and freezes once inside that call: it prices the domain text it prepared for that
frozen task — labels, titles, the range line and receipts included — drops the newest whole entries until the task fits, and leaves
every unselected entry pending. The material, the write eligibility and the audit membership are
re-frozen together, so a reduced task can never keep the larger progress range. Extra context a host
can supply is never evidence permission — the frozen range bounds what may be written whatever the
model can see. If the oldest entry alone does not fit, core raises a capacity problem (opening with
`NOTING_CAPACITY`) and advances nothing. The host may answer that problem by admitting the same task
once more without an inherited prefix — the Pi host does, on its subagent model (27b) — which is an
ordinary second `noting(...)` call, freezing its own material: core neither loops nor retries. The
same is true of a task the host refuses *after* admission (`refused`, 27c): the re-admission is one
more ordinary call, bounded to the frozen batch by `boundary.entryIds` — exact membership, 27d — if
the host wants the same entries. Most of what core carries for either is opaque and unread —
`fallbackReason` and `forkAttempt`, handed back with the frozen task beside `thinkingLevel`.
`cancellation` is not: it is core's own generation, exposed for host preflight, frozen at admission, handed to the run and
compared when the host admits the task again (27d, parent 27 line 83), so a task cancelled while its
attempt was in flight is dropped with `reason: "cancelled before fallback"` instead of launching a
fallback. 27d also made each attempt its own run record: a refusal whose result carries a `request`
really sent one, so core finalizes that attempt (`fork`/`failure`, its own usage, retries, request
and `nativeLog`) and returns its id as `NotingResult.runId`; a refusal with no request recorded
nothing, and the run the re-admission makes charges only itself. Before releasing a refused attempt,
core atomically verifies its original claim token, executor and expiry. A lost claim drops the
continuation; only still-owned work authorizes the release and fresh admission.

## Rendering decisions

`CONTEXT.md` currently defines terms but no display grammar. Ticket 02 uses the
prompt's fields with the spec's continuation lines: `[F<n>] time
[category/actor] text`, relations at line end, then optional JSON-quoted `quote:`
and mandatory `source:` lines. Outbound relations say `support|negate F<n>
strong|weak`; inbound relations add `inbound`. Knowledge context uses
`[K<n>@<commit>] [category/scope] text` and a `supports:` continuation, which ends
with ` · topics: ["<label>", "<label>"]` (a JSON array, so a label may contain a comma) when the revision carries subject labels (21b);
labels are metadata beside the evidence, never appended to the conclusion. Turn messages
carry source addresses in Pi's own compaction line shape (ticket 23c, copied from
`core/compaction/utils.js`): a natural-text part is `[T<n>#user]: <text>` or
`[T<n>#assistant]: <text>`, a tool call is one line `[T<n>#t<k>] <name>(<key>=<JSON>,
<key>=<JSON>)` in stored key order, and its result is `[T<n>#t<k>] <name> <status>:
<text>`, the text continuing on the following lines as stored. `full` renders the same
labels through the renderer's unbounded path; the older `tool=… status=… omitted=…`
line and its `input:`/`result:` blocks are gone with `renderTurn`.
Receipts follow all content, including assistant text, and list omitted calls
(including partially omitted calls) and expansion addresses.

An explicit `trace` of a Turn without `full` is assembled from that Turn's selected
source entries, in path order, each rendered by `renderEntry` under the configured
profile (ticket 23b): several assistant messages each show, a call with several
native result occurrences shows each occurrence, and a sibling branch's entries do
not appear when the reader's branch is known — an unbound read stays unrestricted.
`trace("T1", {tool: 2})` renders that call's parts within their budgets and seals
every other call at its label line and omission marker, with the receipt that
fetches it whole via `trace("T1#t2", {full: true})`, without repeating user/assistant
text or other calls' omission labels. `trace("T1", {tool: 2, full: true})` keeps its
existing selection semantics. Full rendering removes content compression, not
pagination; its read scope stays unrestricted, so when a shared call has results
on several forks, a full trace shows each original occurrence as its own entry.

Trace uses search's shared paginator and token estimator: every response defaults
to at most 2,000 estimated tokens, including pagination receipts, and `cap` also
limits output lines (default 100). A long single line continues through the same
cursor, split only at Unicode code-point boundaries; concatenate fragments without
a newline as the receipt directs, before interpreting any JSON escapes. Nothing is
permanently truncated by pagination. The query freezes its material, scope and
rendering profile; later writes or branch changes cannot alter its continuation.
Named components resolve once without child cursors; fact intervals retain lazy
record rendering and batched relation snapshots. A knowledge read refreshes handles
only after the entire expression's final page. Rejected continuation requests do
not consume a valid cursor. No new tool parameter is introduced.

`renderEntry` is the one view, under one profile of three independent budgets (ticket 30,
superseding 23c's single `B` split in half): a tool-call part is worth at most `C`
(`render.toolInputTokens`), a tool-result part at most `R` (`render.toolResultTokens`) and one
entry at most `E` (`render.entryTokens`), including all labels, omission markers and separators.
Each following part owns its leading newline inside its own cap as well as `E`. Room one
side leaves unused never enlarges the other. Natural language receives only the entry limit.
When the parts together exceed `E`, result payloads give way first, then call arguments, then
natural text; parts of equal priority share the reduction through the same per-part allocator. Huge lines and JSON values keep character-level head/tail
excerpts. One marker family says what was left out: `[... N characters truncated]`,
`[... N characters of details truncated]` for structured data the host dropped, and
`[<type> omitted]` for a non-text block; the honesty clause "the omitted middle was not
inspected" is stated once in the Noter prompt instead of in every marker. Every consumer
— Noting material, compaction, branch carry and the assembled `trace` — uses
identical entry bytes, and `full` is the same renderer with no budget. The shared
segment-based token estimator remains unchanged (ruling 2026-09-07).

Hosts may store plain strings or JSON in tool input/result; no rule names a tool.
Arguments render as `key=JSON.stringify(value)`, concatenated on the call's one line, so
a value's boundary is never ambiguous; a key that is not a plain identifier is
JSON-quoted. A value that fits its fair share is whole, one that does not is cut head
and tail — inside its JSON string for a string value, each half encoded on its own, and
on its compact JSON text for anything else, never inside an escape sequence or a
surrogate pair. A payload that is not a JSON object renders as `<name>(<raw>)`. A result
is the text the host's extractor returns, cut head and tail. The rules that named `Read`,
`read_file`, `Search`, `Grep`, `Glob`, `command`/`cmd`, `stdout`, `stderr` and the
memory writers are gone (ticket 23b), and so are their budgets. The host records
tool status; the renderer does not infer completion from text.

In fork mode the run sends what its own context does not already hold (29b): with the whole target
visible that is the range, the head reply and the frozen source index — the shape 20a fixed by layout
— but it is now the output of one subtraction, so a partly visible target sends the Raw of the rest,
and the missing applicable history is supplied in either mode (superseding 25a's "a Noter fork never
adds historical facts"). The native prefix remains uncompressed; fork Noting gains nothing from the
compressed view (accepted 2026-09-08). Subagent Noting and fallback start from the empty view and
therefore send the complete entry views below. A fork is priced as its inherited measure plus the
instructions plus the text it supplies — never the cost of a fresh representation it does not build
(29b, superseding 22d/25a's "a fork is priced on the complete subagent material"); the fallback is
guarded instead by the re-admitted subagent's own freeze, which re-prices the fresh material at the
fresh model's capacity and refuses the batch there if it does not fit.

Noting context is two independent allowances (25a): the selected raw within `noting.batchTokens`,
and the historical facts within what remains of `render.episodicBlockTokens` once that Raw ceiling is
reserved — 10,000 each at the defaults. Those historical facts are the facts **applicable on the
selected path** (26 amendment 2), from the freeze's own path snapshot: a sibling branch's fact is
never this Noter's history. The reservation is what makes them independent: an
under-budget Raw batch never enlarges the fact slice, and unused fact space never enlarges the batch.
Facts are selected by descending timestamp, then id. Raw is never dropped or clipped: a selected
batch whose mandatory material (its views, the framing) cannot fit the episodic budget or the host's
reported capacity is reduced oldest-first and re-frozen, and an oldest unit that cannot fit alone
stays pending with a capacity error (review 2026-09-08; no overage receipt lets a task run over a
hard budget). Older facts are dropped first. **Neither Noter mode receives a knowledge block** (25a,
superseding ticket 20's leading knowledge block for this consumer): a Noter reads knowledge by
address when it needs it. Every visible knowledge revision current at the start is still recorded, so
such a read is judged against a frozen base.
The budgets themselves, and what each one charges, are in "Material budgets (20b)" below.
Knowledge expansion addresses are emitted for future trace support; this ticket
implements only `T<n>` and `F<n>` trace targets. The other façade methods retain
their ticket-01 placeholders.


## Shared material and block layout (20a)

`src/core/render/material.ts` holds one material contract and the block layout of every memory consumer.
The shared parts are the rendered knowledge (in category groups), the historical facts, the
compressed Raw entry views with their source identity, and the budget receipts. A task adds its own
parts: Noting the head reply and the source index, Consolidation the pending facts (as addresses and
as lines) and the negated-evidence review cues. The frozen range travels beside the material as the
run's own label. A consumer whose order has no knowledge, no facts or no Raw block simply omits those
parts: sharing the type never adds a block to an order, and initial injection stays knowledge-only.

One function per consumer renders that contract, in the ruled order (ticket 20, as ticket 25a
corrected it):

| Consumer | Block order |
| --- | --- |
| Noter (`notingText`) | historical facts → range → selected Raw → receipts |
| Consolidator (`consolidationText`) | knowledge → range → selected pending facts → negation reminders → receipts |
| Main-agent knowledge block (`injectionText`) | knowledge → inherited-knowledge status (31) → receipts |
| Main-agent compact (`compactText`) | knowledge → historical facts → pending Raw (the one bounded entry view) → receipts |

25a supersedes ticket 20 on two blocks of that table: the Noter's leading knowledge block, in both
modes, and the Consolidator's already-consolidated history block. Both consumers reach that material
by explicit read instead, and knowledge a fork already inherited from the foreground is untouched.

## One material builder, two initial states (29b)

Each phase has ONE builder, and the only thing that separates a fork's material from a fresh child's
is the initial state it is given: `{visible: VisibleView, inheritedTokens}` — the empty view and zero
for a fresh child, the parent's real view (29a) and the host's context measure for a fork.
`notingIncrement` and the `MaterialText` pair are gone.

A task has two sets, frozen separately. The **processing target** is chosen regardless of visibility —
Noting's oldest whole-entry prefix within `noting.batchTokens`, Consolidation's oldest applicable
pending whole-fact prefix — and it is what the run may write for, what the audit lists and what
progress advances. The **newly supplied material** is that target minus what the view proves visible
at the same identity and representation, then the optional material minus visible ids, and only then
the injection budget. Never a budget-limited prefix with visibility subtracted afterwards: with the
newest facts already visible, the whole history allowance goes to the older ones the child cannot see.
The allowance is a ceiling, never a target — fewer needed facts make a smaller block, not filler.

- **Noting.** A target entry is withheld when the view holds its native id as a retained `source` or a
  carrier's bounded `view` (30: one representation, and a legacy tier-1 or tier-2 carrier counts as it).
  Withheld
  bodies leave the mandatory framing standing: the range, the source index for the whole frozen range,
  and the head reply — restated only when the head entry's own body was withheld, because the captured
  request a fork inherits stops before the reply it produced. Optional: the applicable historical facts
  the view does not hold, within the same `render.episodicBlockTokens - noting.batchTokens` ceiling; no
  knowledge block, and no borrowing from the Raw allowance.
- **Consolidation.** Target fact bodies the view does not hold by id, with `factAddresses` still naming
  the whole target. Optional: the current applicable knowledge the view does not hold at that exact
  commit — a visible predecessor covers nothing — plus one status line per inherited commit that is no
  longer current (superseded, archived or merged), charged inside `consolidation.knowledgeTokens` with
  the block it corrects. No historical-fact block and no automatic Raw block.

Both builders return `supplied: SuppliedMaterial` beside the text: what the text really carries, after
budgeting, for the carrier a host persists with it (29a). Later tool rounds add nothing — the child
keeps its own earlier messages, and core prepares one material per task.

The leading knowledge block is `renderKnowledgeBlock`, the same `<knowledge>` block the three
consumers that carry one use; nothing task-specific may enter it — no range, no entry id of the new batch, no
timestamp, run id or omission count — so two tasks with the same selected knowledge render the same
leading bytes even when the range and the Raw differ. That is a byte-layout rule, not a cache
promise: knowledge is revised, archived and dropped under budget, repeated material is not
automatically an append-only prefix, and the Consolidator and the main agent have different
instructions and are not one cache chain. The existing historical-fact freshness order was not changed for it.

Titles and separators are constants in that module (`FACTS_TITLE`, `RAW_TITLE`, …), and `finish`
still appends the receipts. Nothing here knows a host message type, and no host file lays out these
blocks (pinned by a source check in `tests/core/api/boundary.test.ts`).

## Fact groups

Rendered fact lists share `renderFactGroups`: Noter history, the Consolidator range facts,
compaction, branch carry, and the facts in review reminders/feedback. It is the one full-fact
renderer of ticket 25: the same selected facts and annotation snapshot give the same bytes in a
branch carry and in a Noter subagent history block; only the enclosing title differs. (29d removed
its fifth consumer, the `<noted>` foreground receipt, with automatic delivery itself.)
Groups use the owning Turn's start time in ascending chronological order, with Turn id as a tie-break;
within a group, facts use ascending F ids. Unknown Turn times remain explicit and sort last by id.
A group heading looks like `[T42] 2026-09-09T10:30:00Z (selected facts)`: it identifies a selected
subset, never claims the entire Turn was supplied or processed.

Selection and display are separate. Historical facts are selected newest-first by source time and id
before grouping; this also corrects the Consolidator history query that previously returned oldest
ids despite its freshness label. Current Consolidation facts still select the oldest F-id prefix,
one whole fact at a time, and may split a Turn across batches. Its range, write eligibility and
progress retain that selected membership, even if chronological display puts another F id first.

Every fact retains its verbatim single-fact rendering, including relations, quote and all source
addresses. A fact citing several Turns appears once under its owning Turn, not once per citation.
The renderer reads Turn timestamps from a metadata projection rather than loading conversation
bodies. All group headings and separators are charged to the same historical/current material
budgets as their facts; the Consolidation trigger uses that same grouped current-fact view. Individual
`trace F…` and search results keep their existing rendering, and already-persisted injections are not
rewritten merely to change their layout.

## Material budgets (20b)

`budgetMaterial` in the same module is the one budgeting of that shared material: every consumer
passes the knowledge candidates, its selected current material (Raw entry views, or a Consolidation's
pending fact lines), the block titles and mandatory cues it will emit, the frozen range and the
historical facts, and gets back what fits with the receipts for what did not. The limits are hard,
measured by the existing estimator over the exact rendered view, and every emitted component is
charged once, to the block that emits it:

| Component | Budget | Default |
| --- | --- | ---: |
| main knowledge block, category tags, status lines and omission receipts (initial injection, one-shot supplement, compact window) | `render.knowledgeBlockTokens` | 20,000 |
| Consolidator knowledge references, category tags, inherited status lines and omission receipts | `consolidation.knowledgeTokens` | 10,000 |
| Noter's selected Raw / Consolidator's pending fact lines — views with their own source labels, omission markers and joining separators | `noting.batchTokens` / `consolidation.batchTokens` | 10,000 |
| Noter: block titles, the range line, block receipts and the historical facts beside them | `render.episodicBlockTokens` | 20,000 |
| compact's facts window — the pending facts, then the consolidated refill, with the `<episodic>` tag, the facts title and their receipts | `compaction.factsTokens` | 10,000 |
| compact's Raw window — the pending entry views, then the already-extracted refill, with the Raw title | `compaction.rawTokens` | 10,000 |
| compact's shared allowance — required excess only, never optional refill | `compaction.overflowTokens` | 10,000 |
| Consolidator: its titles, range line, mandatory review cues and receipts, charged with the facts they frame | `consolidation.batchTokens` | 10,000 |

The current material and the mandatory cues are reserved first; historical facts then fill whatever
episodic space is left, in the existing freshness order. A Noter batch consumes at most its own
ceiling, not a guaranteed allocation, and Consolidation has no automatic Raw block and no history
block at all — its selected pending facts and their required framing share the current-material
allowance. Outer framing is never charged against the Noter's inner Raw ceiling, so an otherwise valid
10,000-token entry stays batchable.

Ticket 25 amendment 3 (25c) removed compaction's inner Raw cap: a foreground backlog is not a Noter
batch, so `noting.batchTokens` does not bound it. Ticket 28a replaced 25c's "knowledge plus one shared
20,000-token envelope" with three windows and its own allocator (below); compaction no longer reads
`render.episodicBlockTokens` at all, and that key stayed exactly what it was for the Noter.
`budgetMaterial` keeps serving the Noter and the Consolidator unchanged — it is not compaction's
allocator any more.

The Noter's two allowances are independent, and the reservation is what makes them so: its historical
facts are capped at `render.episodicBlockTokens − noting.batchTokens` (10,000 at the defaults), so the
Raw ceiling is subtracted whether or not this batch fills it. A small Raw batch never buys a larger
fact slice, and a small fact slice never buys a larger Raw batch. No new configuration key expresses
this; the cap is derived from the two that already exist.

Fresh material is therefore at most 20,000 estimated tokens for the Noter and 20,000 for the
Consolidator by default; system instructions, tool definitions, inherited native history and later
tool/review messages are additional context costs, which is why the host's real-context capacity
check stays independent of these domain limits.

Selected evidence is never dropped to fit: the reducible unit is the task itself
(`freezeNoting`/`freezeConsolidation` take a smaller oldest-first prefix), and a current block over
its ceiling — which since 20c only a Noter's or Consolidator's *outer* framing can produce, because
compact escalates instead of keeping an over-ceiling block — is reported by an honest receipt rather
than cut. Receipts are bounded: an omission names at most eight addresses and
then says how many more it covers, so a long omitted list cannot defeat the cap it is charged
against. Nothing is deleted; omitted knowledge and facts remain stored, readable and traceable, and
no omission advances knowledge lifecycle or processing progress.

The knowledge cap is hard (user confirmation 2026-09-08): category priority and the deterministic
within-category order are unchanged, but constraints, open items and disputes no longer bypass the
budget. Retained items are whole — a claim is never rewritten to make it fit — and each omitted
category is named in its own receipt.

## Knowledge trace and negation walks (ticket 03a)

`trace("K1")` renders the path current, its parents and children, applicable
commit history, and the other branches' tips. Without context it labels tips
newest-created and never calls one current. `K1@57` reads one immutable global
commit, `K1@57..K1@61` compares any two commits of the same identity (including
siblings and reverse order), and `K1..` shows the commit tree across branches.
Commit metadata includes operation, stored time, the commit's `supports`
fact addresses and its `reason` (the authored commit message).
Supports expand through `trace("F1")`.

Diff metadata lists commits unique to either endpoint ancestry, preserving
changes later reverted. Equal endpoints have no transitions. Added/removed supports use set membership in stored order;
unchanged category, scope, reason and topics fields are omitted, so a diff reports a
reason, topic or evidence change even when the conclusion text is identical. Text uses lossless lexical
LCS tokens: individual Han characters, other word/number runs, whitespace runs,
and individual punctuation/symbols. Adjacent removals use `[-text-]`, additions
use `{+text+}`, and unchanged spans remain in place. LCS ties prefer removal.
These display markers are not a patch serialization format. LCS uses quadratic
time and space in the two token counts; trace does not truncate knowledge text.

`F1..` includes the starting fact and follows later inbound strong negations
(newer facts point to older facts in storage), depth first, in ascending fact-id
order. Two spaces per level show branching. Shared descendants appear on each
branch; every leaf ends with `no later strong negation recorded`. Fact lines
retain all normal relation annotations, even though weak negations and supports
are not traversed. Later means allocation order, not potentially backdated fact
timestamps. No model call or derived fact status is involved.

IDs and commits must be positive safe integers without leading zeros. Knowledge
and negation-walk addresses reject options; malformed addresses and missing
knowledge/facts/commits raise descriptive errors. Session addresses, comma lists,
and listing cursors are supported.

## Batch trace: comma lists and fact intervals (ticket 25d)

One `address` string may carry several addresses, comma separated: `F81,F90,F95`.
Kinds may be mixed (`K1@57,T12,F81`), components are read in the order asked, and
repeats are kept — nothing is deduplicated. `F81-F90` is the inclusive fact-id
interval: a hyphen, so `..` keeps its single meaning (`F81..` walks later strong
negations, `K1@57..K1@61` diffs two commits, `K1..` shows the commit tree). It
combines with the rest as `F81-F90,F95`.

An interval reads the facts that **exist** in the numeric range, in ascending id
order: one indexed range query selects the existing ids and each of them is
rendered as the full record `F<n>` prints, so `F1-F1000000000` costs what its facts
cost rather than what its span suggests, and nothing is allocated per integer.
A range with no facts prints `F81-F90: no facts exist in this range`; an
individual `F81` keeps its own missing-record error. Endpoints are positive safe
integers without leading zeros in ascending order, a one-element interval
(`F81-F81`) included; a reversed, unsafe, zero-padded or non-fact pair of that
shape (`F90-F81`, `T1-T9`) is rejected by name. Every component of an expression is
parsed before the read begins, so a refused expression leaves no continuation
state behind. Interval grammar is recognized only for address-shaped components
(an uppercase letter and digits on both sides), so a hyphenated project name such
as `trace-memory` still resolves as a project.

A batch is one read: named components resolve at query time, in request order,
while intervals keep fact identities and render only the page plus one lookahead.
The shared token budget and `cap`/`cursor` page that one line stream — no child
cursor is nested inside a page and no remainder of an address is dropped. Deferred
interval relations are frozen in one batched read, not by rendering all facts.
A short transaction fixes the request snapshot; no transaction stays open between
pages. The annotations 22c freezes for a search (a fact's relations, a commit's
marks, a Turn's occurrences and Raw profile) cannot move under a later page either. A read through a run's tools is recorded and audited as
the expression the model wrote, and the knowledge components of a mixed expression
still update that run's knowledge read base.

The trace fixture in `tests/fixtures/trace.json` is cut from simulation v7m's
`knowledge.json` (knowledge 2, both revisions) and `facts.jsonl` (facts 2, 8, 35, 81).
Only required records/fields are copied. Category and strength enums are mapped
to English; Chinese text and quotes are preserved. Tests remap knowledge/fact
IDs and raw-source addresses into the fixture database. Simulation revision `at` values are retained as
stored times because the source has consolidation-boundary labels, not wall-clock times.
Four checked-in goldens cover current knowledge, snapshot, diff, and negation walk.

## Consolidation feedback host contract (ticket 03b)

`consolidate({ sessionId, branch, headTurnId?, model?, mode? })` returns `empty`
without a call when there are no applicable unconsolidated committed facts on the
selected path. Facts become eligible immediately, including on partly recorded
Turns; there is no Turn grouping or first-Noting gate. Shared ancestors belong
to both paths. Progress is the exact `consolidated_facts` set with the existing path
rule, never a maximum-id cursor. Since 20b the threshold is `consolidation.triggerTokens`
(default 5,000) measured over the rendered lines of the whole applicable set — the same
representation, relations and separator the batch selects with — and it only triggers a run.
The range is the oldest-first whole-fact prefix within `consolidation.batchTokens` (default 10,000)
in allocation-id order; the rest stays pending for the next batch. An oldest fact that cannot fit
alone is a capacity problem and stays pending: it is never clipped, skipped for a smaller later fact
or marked consolidated unpresented. The range freezes those facts, the visible active knowledge
revisions (including budget omissions), relation lines and reminders before the
candidate call. Since 25a the automatic material is exactly two blocks: the active knowledge within
`consolidation.knowledgeTokens` (default 10,000), and the pending facts within `consolidation.batchTokens`, which also
carries their review cues, the titles and the range line — required framing is charged to the
allowance of the material it frames, never to a second budget. **There is no already-consolidated
history block and no automatic Raw block**; both are reached by explicit `trace`. All range facts are
retained: a batch whose facts and mandatory cues cannot fit that allowance is reduced oldest-first and
re-frozen, and one that cannot fit its smallest admissible unit stays pending with the capacity
diagnostic (`CONSOLIDATION_CAPACITY`). Since 29e the optional knowledge block goes first: it is
dropped whole — with one receipt line saying so, charged inside the text the freeze prices — before
any selected fact is given up, the twin of the Noter's history trim. It is dropped whole rather than
by a lowered cap because a cap small enough to matter is also too small for the block's own omission
receipt, which `budgetKnowledge` refuses outright. Feedback is unbudgeted so every matching visible
knowledge and both relation strengths remain available.

**Two execution modes (29e, superseding 25b).** `mode` is the request's own or
`consolidation.forkModeDefault` (default `false`), exactly as Noting reads `noting.forkModeDefault`;
`effectiveMode` still decides what the material and the price are built for. A fork is priced as its
inherited measure plus the instructions plus the text it newly supplies (29b), and its preflight
floor is that same price. There is no Raw prerequisite for this phase: its selected pending facts are
present either in the inherited context or in the complete fact block the builder injects (29b case
14), and inherited unrelated Raw grants no citation authority. A refused fork comes back to the host
as `{ outcome: "dropped", refused }`, with the `runId` of the attempt's own record when it sent a
request — the same 27c/27d contract Noting has. A candidate accepted for review is not a business
commit, so that refusal is reachable after one; the re-admitted run restarts candidate and review on
the same frozen fact target.

The host receives one `ConsolidationAgentInput` with frozen `input`, the four bound
`tools`, and `reportRequest`. It executes tool calls and extends the same conversation
until the provider stops. `reportRequest` captures each exact provider request before
execution; the final returned request is the last one sent.

`memory({operations, skipped})` accepts one operation shape: `op`, `id`, `absorb`,
`text`, `category`, `scope`, `supports`, `reason`, `topics`. Every operation requires non-empty
`supports` — this commit's evidence, which may mix the grounds of the resulting text
with the correction or withdrawal that prompted it — and a non-empty `reason`, its
commit message. A reason establishes no evidence, scope, applicability or accounting,
and core never parses addresses out of it. Create/update/merge also require complete
resulting text, category, scope and `topics`; supports replaces the old set, and so
does topics — an empty array is unclassified or an explicit clearing, and a merge
states the survivor's own labels rather than the union of its parents'. Labels are
strings, trimmed, non-empty, deduplicated and stored in code-point order; case,
language and spelling are untouched, and the submitted order carries no meaning.
Create forbids
id; update/archive/merge require it. Merge alone requires absorb. Archive permits
only op, id, supports and reason, and inherits category, scope and topics from its parent.
Inapplicable and unknown fields are rejected, and a commit-level `because` is rejected
by name. Skipped items are `{fact, because}` with a range fact and a non-empty
explanation; that protocol is unchanged.

The first valid batch writes nothing. Its tool result contains ordered item results
and `feedback: {role: "user", content}`. The host appends this feedback once as a user
message after the tool result. Content combines the system-generated guidance line,
NEAR, CLOSER, and the exact body between the prompt's second-round heading and the
next heading. The second valid batch commits; invalid batches can be corrected and
resubmitted without a further review round. A third submission is already committed.
Stopping after the first valid batch is bounced and preserves the candidate. Normal
stopping without any submission succeeds with zero knowledge and advances the range.

Lexical matching uses Unicode character bigram Jaccard after removing punctuation
and whitespace. NEAR includes all visible active neighbours at or above
`consolidation.nearThreshold` (default 0.28); targets exclude themselves. CLOSER lists
range facts near each open/goal item. Budget omissions do not limit either search.
Update or merge answers NEAR; archiving a neighbour does not. Initial create review
obligations remain conservatively while creates remain in the final batch, so
reordering operations cannot silently discard a warning. No acknowledgement field
or third review round exists.

Targets must match the visible active revisions frozen at run start; manual calls
use current revisions. Every item is checked before writing and every participant
is rechecked in the immediate transaction. Any rejection writes no operations.
The survivor revision, merged status and links, run record and frozen Consolidation
fact membership commit together; absorbed items retain their own last revision.
Ticket 29d retired automatic foreground receipt delivery, which the 2026-09-08 supersession had made
unconditional: a commit is delivered to no conversation, in either worker mode. The foreground learns
a background result through a later compaction, an explicit read, or — ticket 31, the one exception —
the single knowledge supplement its host asks for after a project change or a re-enable; a child
receiving material does not mean the parent received it. Supports cite project facts available at start.

Accounting runs on actual visible knowledge after applying the batch inside that
transaction, including concurrent changes to untouched knowledge. A range fact cited
by an archive that applied in this batch counts as archival evidence and needs no
duplicate skipped entry; a candidate-only or rejected archive does not. Uncited user
facts and questions missing from skipped yield `uncited_facts`. Other diagnostics are
`unanswered_near`, `unsupported_numbers`, and `over_200_tokens`. Numbers compare exact
numeric lexemes against supporting facts' text and quotes; the reason is never read by
that diagnostic, and never by any other.
All diagnostics commit and derive no fact or knowledge status.

One run record retains tool inputs/results, candidate, fetched evidence, exact last
request, final output, usage, read revisions and problems. Once committed, business
outcome is success even if the provider later fails or is cancelled; trailing errors
only append problems. Before commit, failure/cancellation advances nothing; an
uncorrected rejection or first-only submission ends bounced. Run admission uses the same target-wide phase claim as Noting, across facades,
branches and processes.

The fixture `tests/fixtures/consolidation.json` copies K2 from v7m's first Consolidation output and its
supporting facts F2/F35 from facts.jsonl. Chinese memory content is preserved;
only the knowledge category and candidate handle are adapted to the core contract.
Tests remap fact addresses to allocated IDs. Existing 03b tests now expect
application and session/branch ranges, explicitly decline unretained facts, and
add fresh facts before repeat runs; committed knowledge participate in later NEAR.

## Read facade contract (ticket 04)

`inject(sessionId, branch = "main")` returns attribute-free `<knowledge>` XML,
with nonempty category tags in glossary order. Within each category, current
revision time ascends, with knowledge-id ties. XML text is never escaped (lines stay trace lines byte for byte); shared lines,
including revision-bound marks, remain the display grammar. Budgets measure
shared lines, including framing and receipts. Every category obeys the hard cap;
whole items form a retained prefix in category order.
Pass `null` explicitly for legacy null branches.

31: this is **one selection**, and its two triggers are the host's. `injection(target, visible?)`
selects the applicable knowledge at the node minus the commit ids `visible` (29a's view of the
reader's own context) already holds, and annotates the visible commits that are no longer current with
29b's status lines, inside `render.knowledgeBlockTokens` (default 20,000 since 32a). Explicit values
are honored unchanged; Consolidator references use their separate `consolidation.knowledgeTokens`
allowance (default 10,000). Both keys use the existing positive-safe-integer validation; neither adds
an interactive Settings item. An empty visible view selects from the whole applicable set under
that budget. At the same configured budget and visible set, initial injection and the supplement
produce identical text; the raised default may include more knowledge. An empty delta renders no block at all — the status lines annotate a block and never become one on their own,
so a re-enable with nothing new to say says nothing.

Successful noting commits record `factIds` in the
existing response envelope; this identifies a run's own facts even when runs overlap in their source
turns. (29d: the `<noted>` block that used to follow knowledge on every prompt is gone. The
`pending_deliveries` table is still created so a published Beta database opens unchanged, but nothing
writes, reads, drains or migrates it, and its timestamps are never read as visibility.)

`compact(sessionId, branch = "main", headTurnId?, retainedView = [])` renders one frozen read
snapshot of the path and returns one of two outcomes, not a string (ticket 20c, one view since 30,
three windows since 28a):

| Outcome | Condition | Result |
| --- | --- | --- |
| `{text, supplied, charged}` | the complete required set fits the fixed bases plus shared overflow | knowledge/status, `<episodic>` facts in chronological Turn groups, then bounded Raw in source order |
| `{native: true, reason, over?}` | required excess exceeds the shared allowance, or an entry's minima exceed its profile | explicit native delegation; `over` identifies all contributing required windows, including knowledge |

**Fixed bases and required-only overflow (32e).** Bases are knowledge 20,000
(`render.knowledgeBlockTokens`), facts 10,000 (`compaction.factsTokens`) and Raw 10,000
(`compaction.rawTokens`). `compaction.overflowTokens` defaults to 10,000 and is shared only by
required excess. The maximum is their derived sum, 50,000, not a separate total-budget key.
For charged required sizes U and bases B, admission requires `sum(max(U_i - B_i, 0)) <= overflowTokens`.
Equality fits; no window lends its unused base. Required 20k/14k/16k fits, but 5k/20k/15k fails
with 15k excess despite a 40k total. Diagnostics give per-window excess and shared shortfall.

Required knowledge is each current applicable exact version not certified by Dreamer, including
legacy unclassified knowledge and committed unfinished edits. Consolidating its supporting facts
does not make it optional. Unprocessed archives retain required accounting/status until completion;
retained superseded versions receive required status framing. Bodies are never truncated or replaced
by an ID or omission receipt to pass admission. Titles, labels, source references, status lines,
separators and emitted receipts are charged to their owning window.

Processed knowledge uses the existing category/version priority, within its own positive base
remainder. Each optional increment is at most `max(B_i - U_i, 0)`, including extra framing; optional
material cannot use overflow. Required 25k/8k/6k leaves optional capacities 0/2k/4k.

**Raw-first refill.** Select newest already-extracted Raw as whole bounded E/C/R views, excluding
exact pending entries and originals or recognized bounded carriers actually retained after compact.
The optional `retainedView` argument has type `readonly string[] | VisibleView`: legacy native-ID
arrays describe retained Raw only; the existing `VisibleView` describes actually retained Raw,
fact and knowledge identities, including recognized carrier identities. Its position and default
empty array are unchanged. The discarded summary establishes no retained coverage. Display selected
Raw in source order.

Then filter already-consolidated facts before budget selection: exclude only facts whose nonempty,
complete `fact_sources` bindings are fully covered by retained Raw, required pending Raw or selected
historical Raw. Unknown, incomplete or partly covered bindings remain eligible. Required pending
facts are never removed. Select eligible whole facts newest first, deduplicated against pending and
retained fact IDs, and display chronological Turn groups. Excluded facts gain no supplied fact IDs.
Raw-first affects filtering, not the independent facts remainder. Pending membership is exact
processing membership, never a timestamp tail; old pending holes remain protected.

Both refills are optional in the strict sense: an item that does not fit is left out, and that
omission starts no worker, causes no native delegation, resets no processing and enters no carrier.
Spare space left over stays empty. `charged` reports what each window spent, the envelope, and what
the required material alone cost — diagnostics for 28b, never a third outcome.

Facts and knowledge are the ones **applicable on the selected path** (26 amendment 2), in
`listSessionFacts`' freshness order: a sibling branch's fact is not a candidate here, and its absence
is membership, not a budget omission. One path snapshot answers that membership for the whole
operation, the knowledge block included.

Ticket 30 removed the second, tighter rendering that used to stand between a custom replacement and
the fallback: an overflowing required Raw set requests host recovery or native delegation, never a
smaller rendering profile. Nothing here selects a smaller pending set, advances extraction progress or touches
injection state, and a native delegation builds no custom summary at all.
Compaction never hides a selected entry to fit, falsifies an omission count or relaxes a cap;
the core allocator calls no provider and contains no summarizer. Host-managed bounded recovery may
run eligible Noting, Consolidation and Dreaming tasks before either a custom replacement or native
fallback. Each phase is used at most once; at most three rounds accommodate newly eligible downstream
work, while independently eligible phases may overlap.

The views it emits are `renderEntry` under the configured profile, the same bytes Noter input,
the token counters and `trace` use, and no view or summary
becomes a source entry, a fact or a processing receipt. Pass `headTurnId` for precise ancestry; without it, the latest Turn selects one
path. Sibling queues are never combined into an automatic Raw view.

`search(query, scope = "all", { sessionId?, maxTokens?, cap?, cursor? })` uses literal
substring matching over fact text, knowledge commits and original Raw. A knowledge
hit matches the conclusion text or any of the revision's topic labels, under the
same escaping; matching runs over the label values (SQLite `json_each`), so the
serialized JSON's punctuation and escapes never match, and a commit whose text and
several labels all match is still one result.

`topicGroups(sessionId, headTurnId?, branch?)` projects the same path-selected
applicable knowledge as `{topics: [{topic, commits}], unclassified}`, where a commit
is the `{knowledgeId, commit}` reference of the revision it was read from. A
multi-topic commit appears in each of its groups, divergent applicable tips stay
separate entries, and nothing is cloned or ranked: this is read organization, not a
second injection order. Trace and
search reads are unrestricted; source eligibility constrains writes only. Unbound
facade reads remain available to hosts. Raw uses literal substring LIKE
(including tool names, inputs and results); `%` and `_` are escaped. `all` in a
bound search includes raw as well as facts and knowledge. Each hit is
one flattened shared rendering line, with ` ⏎ ` preserving line boundaries.
Results order facts by id, then knowledge id/revision; raw orders turns by id.
Search defaults to **2000 estimated tokens per complete response**, including all
content and receipts, under the shared `tokens` estimator. `maxTokens` must be a
positive safe integer; budgets too small for pagination hints and progress are
rejected. `cap` remains a second limit on output lines (default 100), not tokens.
Whole hits are preferred; an oversized hit is split at Unicode code-point boundaries,
with its remaining text carried by the existing cursor rather than truncated. A
`Hit continues on next page` receipt means concatenate the next page's content
without a newline; otherwise join page contents with a newline. Receipts are not
part of the hit content. Search previews and fragments never grant a complete
knowledge-read permission; use an explicit complete `trace` for that.

Continue with `search({query: "", cursor: "…"})`. The original token budget is
frozen: omit `maxTokens` or repeat the same value; a different value is rejected
without consuming the cursor. The same budget applies through `trace` continuation;
a trace-origin cursor cannot be continued through search. Continue a cursor alone,
not inside a comma address list. Invalid parameters do not
consume a valid cursor. Owner isolation and the shared 16-continuation cache remain
unchanged. Trace's own default remains line-budgeted, with no new token limit.

Every search page states that no hit does not mean absent. A `cursor` continues the
query that issued it, not the database as it now stands: the hits, the commit labels,
and the mutable annotations each line prints — a fact's relations, a commit's marks,
and the Turn occurrences a raw hit assembles — are the ones that query saw. Writing
any of them between two pages adds no hit, drops none and moves no label, and nothing
is held between pages: no open transaction, no reserved connection.

`trace` additionally accepts session addresses, exact project names, comma lists,
fact intervals (`F81-F90`, see **Batch trace** above) and `{ cap?, cursor? }`.
Projects list global/project knowledge and project facts;
sessions list turns. Listing caps count output lines, default 100 — the unit is
lines, not facts and not tokens. Tool input is
`trace({address, tool?, full?, cursor?, cap?})` or
`search({query, layer?, maxTokens?, cursor?, cap?})`, with layer facts|knowledge|raw|all.
Display options are parameters, never address flags. The per-output cap flag is
removed; cap is the listing line budget. Expansion hints use the trace parameter form.
`F<n>..` is navigation through later strong negations, including every intermediate
fact and branching; its terminal sentence is not a current-conclusion claim.
Cursors freeze rendered output, are single-use, belong to this facade instance
and calling session/project, and preserve the remaining lines on later pages.

`mark(knowledgeId, kind)` (`verified` | `flagged` | `clear`) replaces or clears
only the current revision's mark; historical marks remain on their revisions.
`declareProject(sessionId, name)` declares attribution through an explicit user
command; its source defaults to `mark`. Pi no longer discovers project marker
files. The storage contract retains `marker` provenance and existing assignments,
without any schema migration or new file-based declarations. New session-owned
projects must use `createSession({ …, projectDeclaration: "undeclared" })`.
Only undeclared projects merge via `mergeProject`; leaving a
named project moves the declaring session and its session knowledge, not peers.
`status(sessionId)` reports session/project fact counts, visible active knowledge
count and latest attempts by run id. The derived Turn watermark readers and status line were removed
by 17b; the pending-delivery count went with the queue in 29d.


## Kept identities and the visible view (29a)

Renderers return what they kept beside their text, so nothing is recovered by parsing
rendered prose. `injection(target, visible?)` is the main agent's knowledge block plus the exact
`knowledgeCommitIds` inside it (`inject` is the same call read for its text alone), and a custom
`compact` result carries `supplied: {entries, factIds, knowledgeCommitIds}` —
every selected pending entry as `{id, nativeId, view: "bounded"}`, plus the historical facts and
commits that survived budgeting. Identities a budget dropped are receipted in the text and
absent from these lists, so a consumer that persists them as coverage can only understate it.
`budgetKnowledge`, `budgetFacts` and `budgetMaterial` report the same identities; no block's
bytes changed.

`visibleView(contextEntries, {db, session, pi})` (in `core/api/visible.ts`) is the one
derived view: given the entries a host's context builder returns for the selected leaf, it
yields `raw` (native entry id → `source` for a retained conversation entry, `view` for one a
carrier supplied a bounded view of — 30: a legacy `tier: 1` or `tier: 2` carrier counts as that
same view, and a retained view is never compared with the current profile to demand a richer
replacement), `factIds` and `knowledgeCommitIds`. It is pure, reads no
database and imports no host SDK type — it reads only `{id, type, customType, details}`. An
id that appears only in text, a free-form summary and a compaction without our
`details.traceMemory` contribute nothing; entries retained past such a compaction still count;
a carrier from another database or another memory session contributes nothing, and one written
before the memory session id existed is matched through its host session id. Applicability is a
separate authority and is never folded in: a new fact or commit changes what is applicable
without changing this view. Only our identified custom messages and structured compactions can
carry plugin coverage. Runtime parsing validates the complete arrays, safe integer identities,
source representation, binding and generation; any malformed field rejects the entire carrier
without donating visibility or completion. Valid empty injections and legacy tier markers remain
readable. Command generations belong to the originating Pi session, even when a fork legitimately
inherits material bound to the same memory session. The carrier format itself is host-side (see `docs/pi.md`).

## Branch summary read (ticket 07)

`branchSummary(sessionId, branch, headTurnId)` returns one `<branch_carry>` XML
block with the fixed other-branch reminder, facts whose raw evidence lies on the
leaving path, commits selected by that evidence, and shared pending entry views.
As in every block, tags delimit and content lines remain byte-identical. There is no fact budget.
The host passes the block immediately as Pi's summary, launching
neither phase and awaiting no Noting; unprocessed entries remain Raw views. Injected messages
are never raw sources for new facts.


## Enrollment (18a)

`store.createSession` accepts host-supplied `nativeCreatedAt`, `baseline` and optional
`enrollmentChoice`. Only a valid native creation timestamp strictly after baseline
derives Enabled; missing metadata derives Disabled. Test fixtures opt in explicitly.
`store.enrollment`, `enabled` and `setEnrollment` retain the derived default separately
from explicit intent. Source mutations and automatic facade admission check this
state; both run commits reread it inside their immediate transaction. Failure audits
remain possible, but disabled business writes/progress cannot commit. Reads and pending
queue inspection remain available; automatic blocks are gated.
No Pi SDK or migration enters core. The facade owns an executor id, atomic task
admission, cancellation signals and conditional claim release. `taskEligibility(phase, target)`
shares the trigger threshold with host preselection; `automatic: true` rechecks it in admission. Since
29d it answers `{due}` alone: the delivery pause that used to hold a fork-mode Noting task until its
predecessor's facts had reached the foreground is gone, so the worker mode no longer changes it. `borrowed: true` requires a closed target and an enabled,
open `executorSessionId`, and forces subagent mode. `closedSessionScope` defaults to
`project` (matching project ids); `global` allows any project and `off` leaves closed
tails pending. Hosts pass `memory.config.closedSessionScope` to `store.closedTasks`;
core rechecks the policy transactionally at admission and commit. `configure` accepts
this scalar and the two mode booleans, retaining other configuration and applying
changes only to future admissions. Running tasks retain their admission scope, but
project-scoped commits still require matching projects. Current-session work and
manual catchup are unaffected. `cancelTasks(true)` stops admission and fences tokens before abort;
`forceTasks()` ends local waits at the host cleanup deadline. The host awaits those
local tasks before `close()`. Cancellation preserves available audit and unknown
usage; closed tools and rejection handlers prevent late store access.


### One task's cancellation signal (28b)

`TaskOptions.signal?: AbortSignal` is the per-task counterpart of the executor-wide
`cancelTasks`, and the only cancellation entry point ticket 28 needed. `execute` links the
signal to the controller that task already owns: an abort closes that task's tool binding —
so a commit still in flight is fenced by the existing rule, not by a new one — immediately
releases that task's claim through the Store's token-and-executor-matched release, and aborts
that task's run. Release does not wait for the runner to settle; a replacement claim and
unrelated claims survive both the abort and the old task's finalization. Already committed
progress keeps its success. A signal
already aborted when the task is admitted cancels it before its first request. The listener
is removed when the task settles, so an operation that ends normally leaves nothing attached
to its signal. Its one caller today is the Pi host's compaction recovery, which passes Pi's
own compaction `AbortSignal` (28b): Esc during a compaction ends that compaction's own
recovery work and nothing else. Nothing else about admission, freezing, claims, slots or
`cancelTasks(stopping?)` changes.

`compact`'s native arm carries `over?: { knowledge: boolean; facts: boolean; raw: boolean }` when
the sum of required-window excesses exceeds the shared overflow allowance. Each flag identifies a
positive excess above that window's own base, not whether its processing phase meets the trigger.
The host separately checks phase eligibility before recovery. A delegation for another reason
(such as an entry whose minima exceed the view profile) carries no `over` and starts no recovery
worker. The two outcomes remain a custom replacement or native delegation; `reason` explains the
required demands, per-window excesses and shared-allowance shortfall.

## Manual catchup boundary (18b)

`TaskOptions` (shared by `NotingInput` and `ConsolidateInput`) gains an optional
`boundary: { maxEntryId?: number; allowedFactIds?: number[]; exactEntryIds?: number[]; exactFactIds?: number[] }`.
Absent, selection is the ordinary unbounded pending set; nothing about existing
automatic callers changes. **29e names the two meanings apart.** The *allowable* set is a manual
catchup's snapshot, which a drain takes in bounded batches: `freezeNoting` filters `pendingEntries`
to ids no later than `maxEntryId` before its usual batch-token loop, and
`freezeConsolidation` filters `consolidationBatch` to `allowedFactIds` (27d's `factIds`) before
building its range; both reuse the same store readers rather than adding a second
selection query. The *exact* target is what a fork fallback re-admits on: `exactEntryIds`
(27d's `entryIds`) and `exactFactIds` (29e). Under either, the freeze selects exactly those pending
members, trims optional material to fit them — the Noter's history, the Consolidator's knowledge
block — never pops one, raises `NOTING_CAPACITY` / `CONSOLIDATION_CAPACITY` when they
do not fit whole, and raises `NOTING_MEMBERSHIP` / `CONSOLIDATION_MEMBERSHIP` — which `execute`
turns into `{ outcome: "dropped", reason }` — when one of them is no longer pending, because
another executor's claim already completed it.
`execute`'s pre-freeze emptiness check applies the identical filter so a target
that is empty within its frozen boundary reports `"empty"` without acquiring a
claim, even while unrelated later entries or facts remain pending outside it.
This is the only mechanism a manual catchup needs from core: freezing,
chaining, slots, waiting and cancellation are entirely host-local (18b), reusing
17c's claims, token fence and `cancelTasks()` unchanged.


## Host-observed fork suppression (19c)

The `sessions` table gains `fork_suppressed_at` and `fork_suppressed_run`, and the store
gains four methods over them: `suppressFork(sessionId, at?)`, `forkSuppression(sessionId)`,
`linkForkSuppression(sessionId, runId)` and `clearForkSuppression(sessionId)`. They hold one
piece of host-observed session state — a host saw an eligible inherited-context cache miss for
this memory session — so that it is shared by every executor of that session, survives reopen
and is not a global setting. `suppressFork` is a single UPDATE guarded by `IS NULL` and returns
whether it changed the row, which is how two concurrent phases produce one transition and one
warning. Core neither reads nor enforces this state: it decides no execution mode, changes no
threshold and gates no write. The Pi adapter reads it at fork admission, records the miss in its
own run record and clears it from its menu. `reopenSession` and enrollment leave it untouched;
`closeSession` does too. v1 is unreleased, so the two columns are added in place with no
migration, as the earlier tickets' schema additions were.
