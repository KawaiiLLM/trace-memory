core/ is host-agnostic: it must not import any host SDK.

- model/   Turn, Fact, Knowledge types and write-time validation (shape only).
- store/   SQLite: global ids, sessions, project attribution, facts, knowledge, knowledge revisions, run records.
- recording/    freeze input, provide tools, record the last provider request and final text.
- api/tools.ts  four bound model-facing tools; atomic note validation and commit.
- integration/  build Integration input and NEAR/CLOSER feedback, validate memory operations, account and commit revisions.
- render/  one renderer for recording input, compaction tail, branch summary, trace; XML injection blocks.
- prompts/ recording.md, integration.md — the prompt texts, versioned by content hash in every run record. Lineage (kept out of the model-facing text): the Recorder descends from pi-observational-memory's observer prompt, the Integrator from its reflector plus Magic Context's historian and curate tasks; the six fact categories, the relation model (support/negate with confidence strength, annotations only), scope fidelity, and disputes are this project's own.

Model calls go through one interface, runAgent(input) → {outcome: success | failure | cancelled, output, usage, request}, where request is the exact provider request the host sent; hosts implement it (Pi: branch mode = prefix-identical call, or subagent mode = fresh call).

## Runtime and verification

Use Node 24.6.0 and install dependencies with `npm install` at the repository
root. The store uses built-in `node:sqlite` (`DatabaseSync`), prepared statements,
and immediate transactions with a five-second busy timeout. Nested transactions
use savepoints. No external SQLite dependency is needed.

Run `npm test` for the Vitest suite, `npm run typecheck` for TypeScript, and
`npm run smoke:pi` for a direct Node extension import and fake-provider recording run.

## Recording and trace host contract (ticket 02)

Call `record({ sessionId, branch, headTurnId, model?, mode? })` after recording raw
through the façade's existing `store` interface. `headTurnId` is the last turn
present on the selected branch at trigger time. Hosts link consecutive turns
with `parentTurnId`; a null parent starts a root. Branch names identify lineages:
use a new name when forking before a branch's watermark. Ancestry must stay
within the session. The core freezes ancestry, tool calls, session-wide recent
facts and visible active knowledge revisions before calling the model.

The recording result has `outcome`: `success` with `runId` and facts; `bounced`,
`failure` or `cancelled` with `runId` and problems; or `dropped`/`empty` without
a run record. A duplicate is dropped per database/session/branch across façade
instances in this process. No automatic retry or feedback call follows a bounce.
Stopping normally without submitting is a zero-fact success: advance the frozen
watermark without a delivery. An uncorrected rejected submission is `bounced`
and advances nothing. Failure/cancellation before commit also advances nothing.
A committed batch keeps outcome `success` even if the provider subsequently
fails or is cancelled; the trailing problem is recorded without undoing business
writes (user ruling 2026-09-07).

`runAgent` receives `RecordingAgentInput` with the four `tools` definitions:
`trace`, `search`, `note`, `memory`. Each has a name, description, JSON-schema
parameters, and synchronous `execute(input): string`. Hosts execute calls and
continue the provider conversation until it stops. `reportRequest(request)`
reports each exact provider request before tool execution; the returned `request`
is the last request sent. Final text is audit content, never parsed for facts.
`runs.response` holds final text, usage, frozen read knowledge revisions, fetched
trace evidence, the tool-call input/result sequence, problems and committed IDs.

`tools(context)` also binds these definitions to a main agent with
`{kind: "manual", sessionId, branch, currentTurnId}`, or to a Recording context
with `{kind: "recording", sessionId, branch, range: {from, to},
readKnowledgeRevisions}`. `note({facts})` validates every item and commits nothing
on any rejection; a corrected whole batch may be resubmitted. Success returns
`results` in order (`ok: F<id>`) plus `factIds`; rejection results are `ok` or
`rejected: <reason>`. A Recording binding commits at most one batch. The batch,
run record, frozen watermark and nonempty delivery commit in one transaction.
Manual writes commit immediately as a `manual` run with the tool input/result
as request/response and enter only that branch's Integration range. They do not
advance Recording. `memory` writes knowledge with the uniform batch contract below.

Sources are `T<id>#user`, `T<id>#assistant`, or `T<id>#t<n>` in the frozen range
(Recording) or calling session (manual). Time is the first source turn's
`started_at`; timestamps from the model are rejected. Event facts require
`status` (completed, reported, dispatched, attempted); other categories reject
status. Text has no completion prefix; the shared renderer supplies it. Relations
retain `[target, strength]`, with `$n` restricted to earlier facts in the batch.
Existing databases gain the status column and manual/bounced run values on open;
legacy event text prefixes are moved to status while retaining rendered content.

The recording config chooses branch/subagent mode; provider prefix verification
remains the host's responsibility.

## Rendering decisions

`CONTEXT.md` currently defines terms but no display grammar. Ticket 02 uses the
prompt's fields with the spec's continuation lines: `[F<n>] time
[category/actor] text`, relations at line end, then optional JSON-quoted `quote:`
and mandatory `source:` lines. Outbound relations say `support|negate F<n>
strong|weak`; inbound relations add `inbound`. Knowledge context uses
`[K<n>@<rev>] [category/scope] text` and a `supports:` continuation. Turn messages
carry source addresses; tools use `[T<n>#t<n>] tool=… status=… omitted=…`.
Receipts follow all content, including assistant text, and list omitted calls
(including partially omitted calls) and expansion addresses.

`trace("T1", {tool: 2, full: true})` selects a tool ordinal and removes standard
cuts, including read/write payloads. The optional listing cap paginates the
rendered lines; it never becomes a tool-output token cap.
Filtering keeps other calls' metadata and counted omission markers. User and
assistant text are always uncut. Cuts occur at whole-line boundaries, including
stdout, stderr and reports; an oversized single line can be omitted entirely.
Counts describe omitted lines and UTF-16 characters. Token estimates weigh
CJK characters at 0.75 and other characters at 0.25 (user ruling); they are
approximate; caps bound retained payload, not metadata or omission markers.

Hosts may store plain strings or JSON in tool input/result. JSON command inputs
use `command` or `cmd`; execution results use `stdout` and `stderr`. Read/search
names are `Read`, `read_file`, `Search`, `Grep`, or `Glob` (case-insensitive), with
`path`/`file_path` (or a plain input); they show name plus path. Memory writes end
in `note`, `memory`, `mark`, `remember`, or `forget`, optionally after an MCP
`__` prefix. Other results use report head/tail cuts. The host records tool
status; the renderer does not infer completion from text.

In branch mode the recording `input` carries only the range: the raw turns, the
facts delivered after earlier recordings, and the injected knowledge are already in the
conversation the host appends to. Subagent mode carries the full context below.

Recording context uses the episodic budget for all rendered raw plus recent facts
by descending timestamp, then id. Raw is never dropped; overage is receipted.
Older facts are dropped first. Active knowledge items use the knowledge budget in glossary
category order, dropping whole trailing categories; constraint/open/dispute
remain even above budget. Budgets exclude framing and receipts. Every visible
knowledge revision read at start is recorded, including budget-omitted knowledge.
Knowledge expansion addresses are emitted for future trace support; this ticket
implements only `T<n>` and `F<n>` trace targets. The other façade methods retain
their ticket-01 placeholders.


## Knowledge trace and negation walks (ticket 03a)

`trace("K1")` renders the current knowledge, status, outbound knowledge links, and all
revisions in ascending order. Each revision line carries its address, operation,
stored time, and `because` fact addresses (`none` for an empty/null list).
Supports and triggering facts are addresses; `trace("F1")` expands their content.
`K1@2` is only that snapshot and its revision metadata, without today's status
or links. Merged knowledge items retain their own last revision; `merged_into` names the
exact survivor revision stored in the link, even if that survivor later changes.
Archives render the stored archive revision, including its triggering facts.

`K1@2..4` compares endpoint snapshots and lists revisions 3 and 4, including
changes later reverted. Equal endpoints are allowed (no transitions); descending
ranges are invalid. Added/removed supports use set membership in stored order;
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

IDs and revisions must be positive safe integers without leading zeros. Knowledge
and negation-walk addresses reject options; malformed addresses and missing
knowledge/facts/revisions raise descriptive errors. Session addresses, comma lists,
and cursors remain for later tickets.

The trace fixture in `test/fixtures/trace.json` is cut from simulation v7m's
`knowledge.json` (knowledge 2, both revisions) and `facts.jsonl` (facts 2, 8, 35, 81).
Only required records/fields are copied. Category and strength enums are mapped
to English; Chinese text, quotes, and source addresses are preserved. Tests remap
knowledge/fact IDs to allocated IDs. Simulation revision `at` values are retained as
stored times because the source has integration-boundary labels, not wall-clock times.
Four checked-in goldens cover current knowledge, snapshot, diff, and negation walk.

## Integration feedback host contract (ticket 03b)

`integrate({ sessionId, branch, model?, mode? })` returns `empty` without a call
when there are no facts of this session on this branch after its own
`lastIntegratedFact`. Branch membership follows turn ancestry ending at the branch's
`lastRecordedTurn`; hosts must record recordings with their branch watermark. A branch
without a recorded head has no integration range. Shared ancestors belong to both branches.
The range freezes these facts in allocation-id order, visible active knowledge
revisions (including budget omissions), relation lines, and reminders before the
candidate call. Context remains project-wide: facts covered by their own
session/branch integration watermarks, excluding the current range,
ordered by descending timestamp then id. All range facts are retained; their
rendered size consumes the episodic budget before context. Knowledge follow the
recording category budget policy. Reminders and feedback are unbudgeted so every
matching visible knowledge and both relation strengths remain available.

The host receives one `IntegrationAgentInput` with frozen `input`, the four bound
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
`integration.nearThreshold` (default 0.28); targets exclude themselves. CLOSER lists
range facts near each open/goal item. Budget omissions do not limit either search.
Update or merge answers NEAR; archiving a neighbour does not. Initial create review
obligations remain conservatively while creates remain in the final batch, so
reordering operations cannot silently discard a warning. No acknowledgement field
or third review round exists.

Targets must match the visible active revisions frozen at run start; manual calls
use current revisions. Every item is checked before writing and every participant
is rechecked in the immediate transaction. Any rejection writes no operations.
The survivor revision, merged status and links, run record and frozen Integration
watermark commit together; absorbed items retain their own last revision. No pending
delivery is created. Supports and because cite project facts available at start.

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
uncorrected rejection or first-only submission ends bounced. Run deduplication is
per database/session/branch across facades in this process.

The fixture `test/fixtures/integration.json` copies K2 from v7m's first Integration output and its
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
`<recorded>` follows knowledge, without a budget, and is consumed atomically
only after rendering succeeds. Pass `null` explicitly for legacy null branches.
Successful recording commits now record `factIds` in the existing response envelope;
this identifies exact deliveries even when runs overlap in their source turns.
Legacy pending runs without this metadata raise an error and remain pending;
the core cannot safely reconstruct their ownership from turn ranges alone.

`compact(sessionId, branch = "main", headTurnId?)` returns knowledge followed by
`<episodic>`: standard-cut raw first, then session facts by descending timestamp
and id. All unrecorded raw survives budget overflow. It neither calls the model nor
consumes pending deliveries. The schema does not record branch heads: provide
`headTurnId` for precise ancestry, as for recording. Without it, compaction retains
all session turns allocated after that branch's watermark, conservatively
including other branches. Receipts follow both XML blocks.

`search(query, scope = "all", { sessionId?, cap?, cursor? })` uses FTS5 query
syntax over fact text and all knowledge revisions, including historical revisions.
Bound tools restrict facts/raw to the session's project, and knowledge to global,
project and the caller's own session scope (including visible history). Unbound
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
count, all branch watermarks, latest attempts by run id, and pending run count.


## Branch summary read (ticket 07)

`branchSummary(sessionId, branch, headTurnId)` renders committed facts on the
branch's recorded ancestry, then raw between its current recording watermark and the
explicit head. It uses the existing core fact/turn renderer and omission
receipts, without a fact budget, knowledge, or delivery consumption. A host awaits
its frozen pending recording before reading; later unrecorded turns remain raw. Unlike
`compact`, this read excludes sibling facts and never budgets away committed
branch facts. This missing read is the only core implementation change in 07;
project declaration, transactional merge, watermarks and delivery writes reuse
the ticket 04 store contract.
