core/ is host-agnostic: it must not import any host SDK.

- model/   Turn, Fact, Knowledge types and write-time validation (shape only).
- store/   SQLite: global ids, sessions, project attribution, facts, knowledge, knowledge revisions, run records.
- noting/    freeze the task material, provide tools, record the last provider request and final text.
- api/tools.ts  four bound model-facing tools; atomic note validation and commit.
- consolidation/  freeze the Consolidation material, produce NEAR/CLOSER feedback, validate memory operations, account and commit revisions.
- render/  one renderer for noting material, compaction tail, branch summary, trace; XML injection blocks.
- prompts/ noting.md, consolidation.md — the prompt texts, versioned by content hash in every run record. Lineage (kept out of the model-facing text): the Noter descends from pi-observational-memory's observer prompt, the Consolidator from its reflector plus Magic Context's historian and curate tasks; the six fact categories, the relation model (support/negate with confidence strength, annotations only), scope fidelity, and disputes are this project's own.

Model calls go through one interface, runAgent(input) → {outcome: success | failure | cancelled, output, usage, request}, where request is the exact provider request the host sent; hosts implement it (Pi: branch mode = inherited context, or subagent mode = fresh context). Optional result fields ride along into the run record's response JSON: `verification`, `fallbackReason`, `retries`, `audit`, and `nativeLog`, the absolute path of a host-side native worker log for the run (19a). The core never reads that file.

**Core assembles no model context (ticket 19b).** `runAgent` receives structured task material, never a
system or user message, a provider body or a mode-specific concatenated string: the domain prompt and
its hash, the frozen range and knowledge commits, the mode, the tools, `reportRequest`, `entryAudit`,
and one `material` object of rendered, budgeted parts — for Noting the ordered entry views, the head
reply, the source index, the knowledge lines, the earlier facts and the budget receipts; for
Consolidation the fact addresses, the fact lines, the knowledge lines, the already-consolidated facts,
the negated-evidence reminders and the receipts. Which parts an execution mode needs, which header
introduces them and which message carries them is the adapter's decision (Pi: `hosts/pi/compose.ts`).
Consolidation additionally supplies `reviewFeedback(toolResult)`, core's own reader of a `memory`
receipt: the adapter delivers the returned guidance as a user message but does not parse the protocol.

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

The noting config chooses branch/subagent mode; provider prefix verification
remains the host's responsibility, as is the choice of runner behind a mode: with its
own `nativeRunner` switch on, the Pi host runs branch work in a native Pi child forked
from the session file and every subagent task — explicit, fallback or borrowed — in a
fresh native child (19a, 19b); with it off, both modes use the request-copy runner.
Core sees the same contract either way.

**Budget before selection (ticket 19 gate 4).** The host reports its available material budget
(`capacity {inputTokens, prefixTokens}`, the model window minus output reserve and inherited prefix)
in the same `noting(...)` call that starts the task. Core selects and freezes once inside it: it
prices the material it froze part by part, drops the newest entries until the batch fits, and leaves
every unselected entry pending. Extra context a host can supply is never evidence permission — the
frozen range bounds what may be written whatever the model can see. If the oldest entry alone does
not fit, core raises a capacity problem and advances nothing.

## Rendering decisions

`CONTEXT.md` currently defines terms but no display grammar. Ticket 02 uses the
prompt's fields with the spec's continuation lines: `[F<n>] time
[category/actor] text`, relations at line end, then optional JSON-quoted `quote:`
and mandatory `source:` lines. Outbound relations say `support|negate F<n>
strong|weak`; inbound relations add `inbound`. Knowledge context uses
`[K<n>@<commit>] [category/scope] text` and a `supports:` continuation. Turn messages
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

In branch mode the host sends the range, head reply and frozen source index from the material: the
raw turns, the facts delivered after earlier notings, and the injected knowledge are already in the
conversation the host appends to. The native prefix remains uncompressed; branch
Noting gains nothing from the compressed view (accepted 2026-09-08). Subagent
Noting and fallback send the shared entry views below. Core freezes one material for both.

Noting context uses the episodic budget for all rendered raw plus recent facts
by descending timestamp, then id. Raw is never dropped; overage is receipted.
Older facts are dropped first. Active knowledge items use the knowledge budget in glossary
category order, dropping whole trailing categories; constraint/open/dispute
remain even above budget. Budgets exclude framing and receipts. Every visible
knowledge revision read at start is recorded, including budget-omitted knowledge.
Knowledge expansion addresses are emitted for future trace support; this ticket
implements only `T<n>` and `F<n>` trace targets. The other façade methods retain
their ticket-01 placeholders.


## Knowledge trace and negation walks (ticket 03a)

`trace("K1")` renders the path current, its parents and children, applicable
commit history, and the other branches' tips. Without context it labels tips
newest-created and never calls one current. `K1@57` reads one immutable global
commit, `K1@57..K1@61` compares any two commits of the same identity (including
siblings and reverse order), and `K1..` shows the commit tree across branches.
Commit metadata includes operation, stored time, and `because` fact addresses.
Supports and triggering facts expand through `trace("F1")`.

Diff metadata lists commits unique to either endpoint ancestry, preserving
changes later reverted. Equal endpoints have no transitions. Added/removed supports use set membership in stored order;
unchanged category and scope fields are omitted. Text uses lossless lexical
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

The trace fixture in `test/fixtures/trace.json` is cut from simulation v7m's
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
rule, never a maximum-id cursor. The fifty-fact threshold only triggers a run.
The range freezes these facts in allocation-id order, visible active knowledge
revisions (including budget omissions), relation lines and reminders before the
candidate call. Context remains project-wide: already-consolidated facts outside the range,
ordered by descending timestamp then id. All range facts are retained; their
rendered size consumes the episodic budget before context. Knowledge follow the
noting category budget policy. Reminders and feedback are unbudgeted so every
matching visible knowledge and both relation strengths remain available.

The host receives one `ConsolidationAgentInput` with frozen `input`, the four bound
`tools`, and `reportRequest`. It executes tool calls and extends the same conversation
until the provider stops. `reportRequest` captures each exact provider request before
execution; the final returned request is the last one sent.

`memory({operations, skipped})` accepts one operation shape: `op`, `id`, `absorb`,
`text`, `category`, `scope`, `supports`, `because`. `because` is always an array of
triggering fact addresses. Create/update/merge require complete resulting text,
category, scope and non-empty supports; supports replaces the old set. Create forbids
id; update/archive/merge require it. Merge alone requires absorb. Archive permits
only op, id and because. Inapplicable and unknown fields are rejected. Skipped items
are `{fact, because}` with a range fact and a non-empty explanation.

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
regardless of worker mode (2026-09-08 supersession). Supports and because cite project facts available at start.

Accounting runs on actual visible knowledge after applying the batch inside that
transaction, including concurrent changes to untouched knowledge. Uncited user facts
and questions missing from skipped yield `uncited_facts`. Other diagnostics are
`unanswered_near`, `unsupported_numbers`, and `over_200_tokens`. Numbers compare exact
numeric lexemes against supporting facts' text and quotes; because is not evidence.
All diagnostics commit and derive no fact or knowledge status.

One run record retains tool inputs/results, candidate, fetched evidence, exact last
request, final output, usage, read revisions and problems. Once committed, business
outcome is success even if the provider later fails or is cancelled; trailing errors
only append problems. Before commit, failure/cancellation advances nothing; an
uncorrected rejection or first-only submission ends bounced. Run admission uses the same target-wide phase claim as Noting, across facades,
branches and processes.

The fixture `test/fixtures/consolidation.json` copies K2 from v7m's first Consolidation output and its
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

`compact(sessionId, branch = "main", headTurnId?)` returns knowledge followed by
`<episodic>`: shared pending entry views first, then session facts by descending
timestamp and id. All pending views survive the outer budget with an overage
receipt. No provider is called and deliveries are not consumed. Pass `headTurnId`
for precise ancestry; without it, the latest Turn selects one path. Sibling queues
are never combined into an automatic Raw view.

`search(query, scope = "all", { sessionId?, cap?, cursor? })` uses literal
substring matching over fact text, knowledge commits and original Raw. Trace and
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
