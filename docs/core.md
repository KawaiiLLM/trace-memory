src/core/ is host-agnostic: it must not import any host SDK.

- model/   Turn, Fact, Knowledge types and write-time validation (shape only).
- store/   SQLite: global ids, sessions, project attribution, facts, knowledge, knowledge revisions, run records.
- noting/    freeze the task material, provide tools, record the last provider request and final text.
- api/tools.ts  four bound model-facing tools; atomic note validation and commit.
- consolidation/  freeze the Consolidation material, produce NEAR/CLOSER feedback, validate memory operations, account and commit revisions.
- render/  one renderer for noting material, compaction tail, branch summary, trace; XML injection blocks.
- render/material.ts  the shared material contract and the block layout of every consumer (20a).
- prompts/ noting.md, consolidation.md — the prompt texts, versioned by content hash in every run record. Lineage (kept out of the model-facing text): the Noter descends from pi-observational-memory's observer prompt, the Consolidator from its reflector plus Magic Context's historian and curate tasks; the six fact categories, the relation model (support/negate with confidence strength, annotations only), scope fidelity, and disputes are this project's own.

Model calls go through one interface, runAgent(input) → {outcome: success | failure | cancelled, output, usage, request}, where request is the exact provider request the host sent; hosts implement it (Pi: fork mode = inherited context, or subagent mode = fresh context). Optional result fields ride along into the run record's response JSON: `verification`, `fallbackReason`, `retries`, `audit`, and `nativeLog`, the absolute path of a host-side native worker log for the run (19a). The core never reads that file.

**Core builds no provider message or body; core owns the domain text (ticket 19b, revised by the
user's ruling of 2026-09-08 in ticket 20).** `runAgent` receives structured task material and core's
prepared text, never a system or user message, a provider body, a message sequence or an SDK type:
the domain prompt and its hash, the frozen range and knowledge commits, the mode, the tools,
`reportRequest`, `entryAudit`, one `material` object of rendered, budgeted parts, and `text` with the
two representations of that same frozen task (`fresh` for a fresh child, `inherited` for a run whose
context is inherited). The host chooses which representation its native context capability needs and
which message carries it; it lays out no block of its own. Consolidation additionally supplies
`reviewFeedback(toolResult)`, core's own reader of a `memory` receipt: the host delivers the returned
guidance as a user message but does not parse the protocol.

**Audit availability.** A host that cannot expose a provider request returns
`audit: {available: false, reason}` instead of `request`; core records the limitation in the run
record and does not report a missing request. A host that returns neither a request nor that
declaration still gets the "runAgent must return the exact provider request" problem. The run
record's response also carries `requestedMode` beside the run's actual `mode`, so a fallback is
visible as requested-versus-actual.

## Runtime and verification

Use Node 24.6.0 and install dependencies with `npm install` at the repository
root. The store uses built-in `node:sqlite` (`DatabaseSync`), prepared statements,
and immediate transactions with a five-second busy timeout. Nested transactions
use savepoints. No external SQLite dependency is needed.

Run `npm test` for the Vitest suite, `npm run typecheck` for TypeScript, and
`npm run smoke:pi` for a direct Node extension import and fake-provider noting run.

## Noting and trace host contract (ticket 02)

Hosts pass completed source identities/content through `appendEntry(SourceInput)`
and select the persisted ancestry with `selectEntries(sessionId, branch, entryIds)`.
The exposed store's transaction groups ingestion with Turn/tool projections.
`pendingEntries(sessionId, branch, headTurnId)` derives work from native path
membership and committed entry processing; it is not a second delivery queue.
Call `noting({ sessionId, branch, headTurnId, model?, mode? })` at the existing
trigger boundary. The core freezes exact pending entries, owning Turns, rendered
views, recent facts and applicable knowledge before calling the model. A fork
uses a new branch identity even when its native source head changes inside the
same Turn. Shared processed entries are inherited by identity.

The noting result has `outcome`: `success` with `runId` and facts; `bounced`,
`failure` or `cancelled` with `runId` and problems; or `dropped`/`empty` without
a run record. A duplicate is dropped per target session and phase across branches,
hosts and processes by a thirty-minute SQLite claim. No automatic retry or feedback call follows a bounce.
Stopping normally without submitting is a zero-fact success: process exactly the frozen
entries without a delivery. An uncorrected rejected submission is `bounced`
and advances nothing. Failure/cancellation before commit also advances nothing.
A committed batch keeps outcome `success` even if the provider subsequently
fails or is cancelled; the trailing problem is recorded without undoing business
writes (user ruling 2026-09-07).

`runAgent` receives `NotingAgentInput` (material and control, above) with the four `tools` definitions:
`trace`, `search`, `note`, `memory`. Each has a name, description, JSON-schema
parameters, and synchronous `execute(input): string`. Hosts execute calls and
continue the provider conversation until it stops. `reportRequest(request)`
reports each exact provider request before tool execution; the returned `request`
is the last request sent. Final text is audit content, never parsed for facts.
`runs.response` holds final text, usage, frozen read knowledge revisions, fetched
trace evidence, the tool-call input/result sequence, problems and committed IDs.

`tools(context)` also binds these definitions to a main agent with
`{kind: "manual", sessionId, branch, currentTurnId}`, or to a Noting context
with `{kind: "noting", sessionId, branch, range: {from, to},
readKnowledgeCommits, entryIds}`. `note({facts})` validates every item and commits nothing
on any rejection; a corrected whole batch may be resubmitted. Success returns
`results` in order (`ok: F<id>`) plus `factIds`; rejection results are `ok` or
`rejected: <reason>`. A Noting binding commits at most one batch. The batch,
run record, frozen entry progress and applicable nonempty delivery commit in one transaction.
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

The noting config chooses fork/subagent mode; provider prefix verification
remains the host's responsibility, as is the choice of runner behind a mode. Since 19c the Pi
host has one runner: fork work runs in a native Pi child forked from the session file, and
every subagent task — explicit, fallback or borrowed — in a fresh native child. Core sees the
same `runAgent` contract either way, and a host that cannot construct its worker at all returns
a failed run with a reason, which leaves the queue pending.

**Budget before selection (ticket 19 gate 4, ticket 20 capacity negotiation).** The host reports its
available material budget (`capacity {inputTokens, prefixTokens}`, the model window minus output
reserve and inherited prefix) in the same `noting(...)` call that starts the task. Core selects and
freezes once inside it: it prices the domain text it prepared for that frozen task — labels, titles,
the range line and receipts included — drops the newest whole entries until the task fits, and leaves
every unselected entry pending. The material, the write eligibility and the audit membership are
re-frozen together, so a reduced task can never keep the larger progress range. Extra context a host
can supply is never evidence permission — the frozen range bounds what may be written whatever the
model can see. If the oldest entry alone does not fit, core raises a capacity problem and advances
nothing.

## Rendering decisions

`CONTEXT.md` currently defines terms but no display grammar. Ticket 02 uses the
prompt's fields with the spec's continuation lines: `[F<n>] time
[category/actor] text`, relations at line end, then optional JSON-quoted `quote:`
and mandatory `source:` lines. Outbound relations say `support|negate F<n>
strong|weak`; inbound relations add `inbound`. Knowledge context uses
`[K<n>@<commit>] [category/scope] text` and a `supports:` continuation, which ends
with ` · topics: ["<label>", "<label>"]` (a JSON array, so a label may contain a comma) when the revision carries subject labels (21b);
labels are metadata beside the evidence, never appended to the conclusion. Turn messages
carry source addresses; tools use `[T<n>#t<n>] tool=… status=… omitted=…`.
Receipts follow all content, including assistant text, and list omitted calls
(including partially omitted calls) and expansion addresses.

`trace("T1", {tool: 2, full: true})` selects a tool ordinal and removes standard
cuts, including read/write payloads. The optional listing cap paginates the
rendered lines; it never becomes a tool-output token cap.
Default explicit trace previews retain the existing field cuts and pagination.
Full reads preserve original input/result strings; when a shared call has results
on several forks, full trace labels and returns each original result occurrence.
Automatic Raw instead uses `renderEntry`: tool fragments first share a fixed
1,000-token budget, then the entire entry fits 10,000 tokens, including all labels
and omission markers. Natural language receives only the entry limit. Huge lines
and JSON values keep character-level head/tail excerpts; omissions never claim
the middle was inspected. All four consumers use identical entry bytes. The
shared segment-based token estimator remains unchanged (ruling 2026-09-07).

Hosts may store plain strings or JSON in tool input/result. JSON command inputs
use `command` or `cmd`; execution results use `stdout` and `stderr`. Read/search
names are `Read`, `read_file`, `Search`, `Grep`, or `Glob` (case-insensitive), with
`path`/`file_path` (or a plain input); they show name plus path. Memory writes end
in `note`, `memory`, `mark`, `remember`, or `forget`, optionally after an MCP
`__` prefix. Other results use report head/tail cuts. The host records tool
status; the renderer does not infer completion from text.

In fork mode the run sends core's inherited increment — the range, the head reply and the frozen
source index: the raw turns, the facts delivered after earlier notings, and the injected knowledge
are already in the conversation the host appends to. The native prefix remains uncompressed; fork
Noting gains nothing from the compressed view (accepted 2026-09-08). Subagent
Noting and fallback send the shared entry views below. Core freezes one material for both.

Noting context uses the episodic budget for the selected raw plus recent facts
by descending timestamp, then id. Raw is never dropped or clipped: a selected batch whose
mandatory material (its views, the framing, the negation cues) cannot fit the episodic budget
or the host's reported capacity is reduced oldest-first and re-frozen, and an oldest unit that
cannot fit alone stays pending with a capacity error (review 2026-09-08; no overage receipt
lets a task run over a hard budget). Older facts are dropped first. Active knowledge items use the knowledge budget in glossary
category order. Every visible
knowledge revision read at start is recorded, including budget-omitted knowledge.
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
run's own label. A consumer whose order has no facts or Raw block simply omits those parts: sharing
the type never adds a block to an order, and initial injection stays knowledge-only.

One function per consumer renders that contract, in the ruled order (ticket 20):

| Consumer | Block order |
| --- | --- |
| Noter (`notingText`) | knowledge → historical facts → range → selected Raw → receipts |
| Consolidator (`consolidationText`) | knowledge → already-consolidated facts → range → selected pending facts → negation reminders → receipts |
| Main-agent injection (`injectionText`) | knowledge → receipts |
| Main-agent compact (`compactText`) | knowledge → historical facts → pending Raw (primary or, in tier 2, compact-only secondary views) → receipts |

Both workers also get the inherited-context increment from that same frozen task (`notingIncrement`,
`consolidationIncrement`; user ruling 2026-09-06 08:53): the instruction, the range, and then the
head reply and source index, or the exact fact list and the review cues. It is what the inherited
conversation does not already carry, never a second copy of the knowledge, facts and Raw. Both
representations are prepared for every run as `input.text.fresh` and `input.text.inherited`, so the
execution mode cannot change the writable evidence range.

The leading knowledge block is `renderKnowledgeBlock`, the same `<knowledge>` block all four
consumers use; nothing task-specific may enter it — no range, no entry id of the new batch, no
timestamp, run id or omission count — so two tasks with the same selected knowledge render the same
leading bytes even when the range and the Raw differ. That is a byte-layout rule, not a cache
promise: knowledge is revised, archived and dropped under budget, repeated material is not
automatically an append-only prefix, and the Noter and the Consolidator have different instructions
and are not one cache chain. The existing historical-fact freshness order was not changed for it.

Titles and separators are constants in that module (`FACTS_TITLE`, `RAW_TITLE`, …), and `finish`
still appends the receipts. Nothing here knows a host message type, and no host file lays out these
blocks (pinned by a source check in `tests/core/api/boundary.test.ts`).

## Material budgets (20b)

`budgetMaterial` in the same module is the one budgeting of that shared material: every consumer
passes the knowledge candidates, its selected current material (Raw entry views, or a Consolidation's
pending fact lines), the block titles and mandatory cues it will emit, the frozen range and the
historical facts, and gets back what fits with the receipts for what did not. The limits are hard,
measured by the existing estimator over the exact rendered view, and every emitted component is
charged once, to the block that emits it:

| Component | Budget | Default |
| --- | --- | ---: |
| knowledge block, its category tags and its omission receipts | `render.knowledgeBlockTokens` | 10,000 |
| selected current material — entry or fact views with their own source labels, omission markers and joining separators | `noting.batchTokens` (Raw, shared with compact) / `consolidation.batchTokens` (pending facts) | 10,000 |
| block titles, the range line, mandatory cues, block receipts and the historical facts beside them | `render.episodicBlockTokens` | 20,000 |

The current material and the mandatory cues are reserved first; historical facts then fill whatever
episodic space is left, in the existing freshness order. Raw consumes at most its own ceiling, not a
guaranteed allocation, and Consolidation has no automatic Raw block at all — its selected pending
facts take the current-material allowance. Outer framing is never charged against the inner ceiling,
so an otherwise valid 10,000-token entry stays batchable. Fresh material is therefore at most 30,000
estimated tokens by default; system instructions, tool definitions, the output reserve, inherited
native history and later tool/review messages are additional context costs, which is why the host's
real-context capacity check stays independent of these domain limits.

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
candidate call. Context remains project-wide: already-consolidated facts outside the range,
ordered by descending timestamp then id. All range facts are retained; their
rendered size takes the current-material allowance before context. Knowledge follows the
same hard knowledge budget. Reminders are mandatory cues charged to the episodic budget; feedback is
unbudgeted so every matching visible knowledge and both relation strengths remain available.

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
fact membership and a nonempty knowledge-change delivery commit together; absorbed
items retain their own last revision. Enabled sessions receive both delivery kinds
regardless of worker mode (2026-09-08 supersession). Supports cite project facts available at start.

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
shared lines before XML escaping and exclude framing and receipts. Protected
categories survive overage; optional categories form a retained prefix.
`<noted>` follows knowledge, without a budget, and is consumed atomically
only after rendering succeeds. Pass `null` explicitly for legacy null branches.
Successful noting commits now record `factIds` in the existing response envelope;
this identifies exact deliveries even when runs overlap in their source turns.
Legacy pending runs without this metadata raise an error and remain pending;
the core cannot safely reconstruct their ownership from turn ranges alone.

`compact(sessionId, branch = "main", headTurnId?)` escalates over one frozen read snapshot of every
pending entry on the path and returns a tier, not a string (ticket 20c):

| Tier | Condition | Result |
| --- | --- | --- |
| `{tier: "primary", text}` | the pending entries' normal shared views fit `noting.batchTokens` and the framing fits `render.episodicBlockTokens` | knowledge, `<episodic>` with session facts newest-first, then those views |
| `{tier: "secondary", text}` | the primary views miss a cap but the compact-only views of the same entries fit | the same order, with `RAW_SECONDARY_TITLE` announcing the lossier views |
| `{tier: "native", reason}` | not even those fit | an explicit ask that the host decline and let its own native compaction run, naming the cap and the overage |

Compact measures Raw against the same effective ceiling as Noting (`noting.batchTokens`), never a
second knob of its own, and both tiers are rechecked under the same `budgetMaterial` accounting as
normal material. No tier hides a selected entry to fit, falsifies an omission count or relaxes a cap;
no tier calls a provider or consumes a delivery, and core contains no summarizer — reaching a model
is the host's native fallback alone. `renderEntrySecondary` (`src/core/render`, versioned by
`SECONDARY_VIEW_VERSION` with per-role budgets in `SECONDARY_EXCERPT_TOKENS`) keeps entry order,
source and native identity, user boundaries, non-text placeholders and each tool fragment's name,
`T<id>#t<n>` occurrence, call id and status, drops tool arguments and results, and cuts user and
assistant text with the primary view's own omission marker. It is used nowhere else: Noter input,
token counters and trace keep the primary views, and neither view becomes a source entry, a fact or a
processing receipt. Pass `headTurnId` for precise ancestry; without it, the latest Turn selects one
path. Sibling queues are never combined into an automatic Raw view.

`search(query, scope = "all", { sessionId?, cap?, cursor? })` uses literal
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
Every search page states that no hit does not mean absent.

`trace` additionally accepts session addresses, exact project names, comma lists,
and `{ cap?, cursor? }`. Projects list global/project knowledge and project facts;
sessions list turns. Listing caps count output lines, default 100. Tool input is
`trace({address, tool?, full?, cursor?, cap?})` or
`search({query, layer?, cursor?, cap?})`, with layer facts|knowledge|raw|all.
Display options are parameters, never address flags. The per-output cap flag is
removed; cap is the listing budget. Expansion hints use the trace parameter form.
`F<n>..` is navigation through later strong negations, including every intermediate
fact and branching; its terminal sentence is not a current-conclusion claim.
Cursors freeze rendered output, are single-use, belong to this facade instance
and calling session/project, and preserve the remaining lines on later pages.

`mark(knowledgeId, kind)` (`verified` | `flagged` | `clear`) replaces or clears
only the current revision's mark; historical marks remain on their revisions.
`declareProject(sessionId, name, source?: "marker" | "mark")` declares attribution;
source defaults to `mark`. Hosts report marker files through this same path.
A persisted session mark wins over subsequent markers. The additive
`sessions.project_declaration` column defaults existing sessions to `marker`;
new session-owned projects must use `createSession({ …, projectDeclaration:
"undeclared" })`. Only undeclared projects merge via `mergeProject`; leaving a
named project moves the declaring session and its session knowledge, not peers.
`status(sessionId)` reports session/project fact counts, visible active knowledge
count, latest attempts by run id, and pending delivery count. The derived Turn
watermark readers and status line were removed by 17b.


## Branch summary read (ticket 07)

`branchSummary(sessionId, branch, headTurnId)` returns one `<branch_carry>` XML
block with the fixed other-branch reminder, facts whose raw evidence lies on the
leaving path, commits selected by that evidence, and shared pending entry views.
As in every block, tags delimit and content lines remain byte-identical. There is no fact budget or delivery
consumption. The host passes the block immediately as Pi's summary, launching
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
queue inspection remain available; automatic blocks and confirmation are gated.
No Pi SDK or migration enters core. The facade owns an executor id, atomic task
admission, cancellation signals and conditional claim release. `taskEligibility`
shares the threshold/delivery predicate with host preselection; `automatic: true`
rechecks it in admission. `borrowed: true` requires a closed target and forces
subagent mode. `cancelTasks(true)` stops admission and fences tokens before abort;
`forceTasks()` ends local waits at the host cleanup deadline. The host awaits those
local tasks before `close()`. Cancellation preserves available audit and unknown
usage; closed tools and rejection handlers prevent late store access.


## Manual catchup boundary (18b)

`TaskOptions` (shared by `NotingInput` and `ConsolidateInput`) gains an optional
`boundary: { maxEntryId?: number; factIds?: number[] }`. Absent, selection is
the ordinary unbounded pending set; nothing about existing automatic callers
changes. When present, `freezeNoting` filters `pendingEntries` to ids no later
than `maxEntryId` before its usual batch-token loop, and `freezeConsolidation`
filters `consolidationBatch` to exactly `factIds` before building its range;
both reuse the same store readers rather than adding a second selection query.
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
