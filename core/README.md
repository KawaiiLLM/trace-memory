core/ is host-agnostic: it must not import any host SDK.

- model/   Turn, Fact, Entry types and write-time validation (shape only).
- store/   SQLite: global ids, sessions, project attribution, facts, entries, entry revisions, run records.
- note/    build note input, parse output, validate, commit.
- settle/  build settle input (NEAR / CLOSER hints), parse output, accounting, apply new/edit/merge/delete.
- render/  one renderer for note input, compaction tail, branch summary, trace; XML injection blocks.
- prompts/ note.md, settle.md — versioned prompt texts (from simulation v7).

Model calls go through one interface, runAgent(input) → {outcome: success | failure | cancelled, output, usage, request}, where request is the exact provider request the host sent; hosts implement it (Pi: branch mode = prefix-identical call, or subagent mode = fresh call).

## Runtime and verification

Use Node 24.6.0 and install dependencies with `npm install` at the repository
root. The store uses built-in `node:sqlite` (`DatabaseSync`), prepared statements,
and immediate transactions with a five-second busy timeout. Nested transactions
use savepoints. No external SQLite dependency is needed.

Run `npm test` for the Vitest suite, `npm run typecheck` for TypeScript, and
`npm run smoke:pi` for a direct Node extension import and fake-provider note run.

## Note and trace host contract (ticket 02)

Call `note({ sessionId, branch, headTurnId, model?, mode? })` after recording raw
through the façade's existing `store` interface. `headTurnId` is the last turn
present on the selected branch at trigger time. Hosts link consecutive turns
with `parentTurnId`; a null parent starts a root. Branch names identify lineages:
use a new name when forking before a branch's watermark. Ancestry must stay
within the session. The core freezes ancestry, tool calls, session-wide recent
facts and visible active entry revisions before calling the model.

The note result has `outcome`: `success` with `runId` and facts; `bounced`,
`failure` or `cancelled` with `runId` and problems; or `dropped`/`empty` without
a run record. A duplicate is dropped per database/session/branch across façade
instances in this process. No automatic retry or feedback call follows a bounce.
An empty JSON array is valid and advances the watermark; omitted turn objects
mean zero facts. Returned turn objects must be unique and in frozen range order.
Compaction turns cannot acquire facts. Local handles count across the entire
batch; the store resolves them. Existing fact relations must target the session's
fact pool frozen at start, including facts left out of the context budget.

`runAgent` receives `NoteAgentInput`: prompt text and SHA-256 hash, rendered
`input`, session, branch, range, read entry revisions, model, mode and a `trace`
callback for fetching evidence. The host maps these into a provider request and
returns that exact JSON-serializable request. Successful results without a
request fail; thrown failures have a null request because none is available.
The `runs.request` column stores only the provider request. The existing
`runs.response` column holds `{ output, usage, readEntryRevisions, fetched,
problems }`; `output` preserves the returned string or parsed JSON value.
Fetches record both address and returned text. Exceptions named `AbortError`
count as cancellation. The default model value `session` is a host-resolved
alias; hosts should pass their actual model identifier for exact auditing.
The note config chooses branch/subagent mode; provider prefix verification
remains the host's responsibility.

## Rendering decisions

`CONTEXT.md` currently defines terms but no display grammar. Ticket 02 uses the
prompt's fields with the spec's continuation lines: `[F<n>] time
[category/actor] text`, relations at line end, then optional JSON-quoted `quote:`
and mandatory `source:` lines. Outbound relations say `support|negate F<n>
strong|weak`; inbound relations add `inbound`. Entry context uses
`[E<n>@<rev>] [category/scope] text` and a `supports:` continuation. Turn messages
carry source addresses; tools use `[T<n>#t<n>] tool=… status=… omitted=…`.
Receipts follow all content, including assistant text, and list omitted calls
(including partially omitted calls) and expansion addresses.

`trace("T1 tool=2 full cap=100")` accepts a tool ordinal, optional full expansion,
and a nonnegative integer cap. The cap applies to each tool text field, split
in its configured head/tail proportion; it takes precedence over `full`.
Without a cap, `full` removes standard cuts and expands read/write payloads.
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
in `note`, `settle`, `mark`, `remember`, or `forget`, optionally after an MCP
`__` prefix. Other results use report head/tail cuts. The host records tool
status; the renderer does not infer completion from text.

In branch mode the note `input` carries only the range: the raw turns, the
facts delivered after earlier notes, and the injected entries are already in the
conversation the host appends to. Subagent mode carries the full context below.

Note context uses the episodic budget for all rendered raw plus recent facts
by descending timestamp, then id. Raw is never dropped; overage is receipted.
Older facts are dropped first. Active entries use the entries budget in glossary
category order, dropping whole trailing categories; constraint/open/dispute
remain even above budget. Budgets exclude framing and receipts. Every visible
entry revision read at start is recorded, including budget-omitted entries.
Entry expansion addresses are emitted for future trace support; this ticket
implements only `T<n>` and `F<n>` trace targets. The other façade methods retain
their ticket-01 placeholders.


## Entry trace and negation walks (ticket 03a)

`trace("E1")` renders the current entry, status, outbound entry links, and all
revisions in ascending order. Each revision line carries its address, operation,
stored time, and `because` fact addresses (`none` for an empty/null list).
Supports and triggering facts are addresses; `trace("F1")` expands their content.
`E1@2` is only that snapshot and its revision metadata, without today's status
or links. Merged entries retain their own last revision; `merged_into` names the
exact survivor revision stored in the link, even if that survivor later changes.
Archives render the stored archive revision, including its triggering facts.

`E1@2..4` compares endpoint snapshots and lists revisions 3 and 4, including
changes later reverted. Equal endpoints are allowed (no transitions); descending
ranges are invalid. Added/removed supports use set membership in stored order;
unchanged category and scope fields are omitted. Text uses lossless lexical
LCS tokens: individual Han characters, other word/number runs, whitespace runs,
and individual punctuation/symbols. Adjacent removals use `[-text-]`, additions
use `{+text+}`, and unchanged spans remain in place. LCS ties prefer removal.
These display markers are not a patch serialization format. LCS uses quadratic
time and space in the two token counts; trace does not truncate entry text.

`F1..` includes the starting fact and follows later inbound strong negations
(newer facts point to older facts in storage), depth first, in ascending fact-id
order. Two spaces per level show branching. Shared descendants appear on each
branch; every leaf ends with `no later strong negation recorded`. Fact lines
retain all normal relation annotations, even though weak negations and supports
are not traversed. Later means allocation order, not potentially backdated fact
timestamps. No model call or derived fact status is involved.

IDs and revisions must be positive safe integers without leading zeros. Entry
and negation-walk addresses reject options; malformed addresses and missing
entries/facts/revisions raise descriptive errors. Session addresses, comma lists,
and cursors remain for later tickets.

The trace fixture in `api/fixtures/trace.json` is cut from simulation v7m's
`entries.json` (entry 2, both revisions) and `facts.jsonl` (facts 2, 8, 35, 81).
Only required records/fields are copied. Category and strength enums are mapped
to English; Chinese text, quotes, and source addresses are preserved. Tests remap
entry/fact IDs to allocated IDs. Simulation revision `at` values are retained as
stored times because the source has settle-boundary labels, not wall-clock times.
Four checked-in goldens cover current entry, snapshot, diff, and negation walk.

## Settle feedback host contract (ticket 03b)

`settle({ sessionId, branch, model?, mode? })` returns `empty` without a call
when there are no facts of this session on this branch after its own
`lastSettledFact`. Branch membership follows turn ancestry ending at the branch's
`lastNotedTurn`; hosts must record notes with their branch watermark. A branch
without a noted head has no settle range. Shared ancestors belong to both branches.
The range freezes these facts in allocation-id order, visible active entry
revisions (including budget omissions), relation lines, and reminders before the
candidate call. Context remains project-wide: facts covered by their own
session/branch settlement watermarks, excluding the current range,
ordered by descending timestamp then id. All range facts are retained; their
rendered size consumes the episodic budget before context. Entries follow the
note category budget policy. Reminders and feedback are unbudgeted so every
matching visible entry and both relation strengths remain available.

The host receives `SettleAgentInput` with `round: candidate|final`. Candidate
`input` contains the frozen context. Final `input` is the feedback text; its
`continuation` carries the prior exact provider `request`, full `response`
(`RunAgentResult`), and one `{ role: "user", content }` message with that same
text. Continue the candidate conversation and append this message once; do not
append `input` again. The host chooses the provider-specific continuation form.
The checklist is the exact body between the prompt's second-round heading and
the next heading, preserving Markdown quote markers and boundary whitespace.
The prompt itself mentions NEAR/CLOSER in both calls; computed hints appear only
in the final call. Default model is the host-resolved `session` alias; default
mode is `subagent`, controlled by `settle.subagentModeDefault` or the call.

Lexical matching uses sets of adjacent Unicode characters after lowercasing
and removing everything except letters and numbers. Empty bigram sets score
zero. NEAR includes every visible active entry at or above
`settle.nearThreshold` (default `0.28`), sorted by descending Jaccard score with
entry-id ties; there is no top-k cap. Edit/merge targets exclude themselves.
CLOSER applies the same threshold to range facts for every visible open/goal,
with fact-id ties. Both searches include entries omitted by the initial budget.

Success returns the validated `output`, final `runId`, `candidateRunId`, frozen
`range` (inclusive `from`/`to` addresses and exact `facts`), read revisions, and
`unansweredNear`. These are the original feedback pairs whose candidate identity
remains in the final output and whose neighbour is neither edited, merged into,
nor acknowledged by that exact candidate/entry pair. Withdrawn candidates have
no remaining pair; archiving a neighbour is not one of the prompt's answers.
Changed text under the same identity retains its review obligation. No new
neighbour search or third round follows the final output.

Every model attempt records the exact provider request, raw output, usage,
read revisions, problems, and round. Bounces return problems and record failure;
there is no automatic retry. Missing requests and thrown errors follow note's
failure/cancellation policy. Successful candidate records survive final failure.
Final success applies settlement (ticket 03c). Deduplication is per database,
session and branch across facades in this process. Other sessions and branches
remain independent while either round is pending. `dropped` creates no record.

## Settle commit contract (ticket 03c)

The final output resolves entry targets against frozen visible active revisions.
Supports, because, and not-admitted addresses must be project facts present at
freeze time with IDs no greater than the frozen range end (including facts from
other sessions and budget-omitted context). The same rule applies to not_admitted;
valid earlier facts may be declined without changing the range. Missing,
foreign, or later facts and unread entries bounce. Duplicate new handles,
repeated operation targets (including absorbed entries), self-merges and empty
merges bounce rather than depending on array order. Operations apply in
new/edit/merge/delete order; delete maps to the store's archive operation.
New entries use the selected model identifier as their author.

Accounting projects the complete final operations onto the frozen visible entry
set, removing archived and absorbed entries and replacing edited supports.
Resulting session scope retains the entry's original creating session, matching
the store's visibility contract. Every user fact and every question in range
must remain cited or have a not_admitted reason. Because is change rationale,
not a support citation. Accounting failures list uncited fact addresses and
write only the final failure record; there is no third model call.

Success adds `committed`, `rejected`, and `diagnostics` to the 03b result fields.
Committed operations carry `op`, `entryId`, `rev`, and `handle` for new entries;
rejections carry the resolved operation and its reason. The final record's
response includes these same arrays. Revision conflicts reject only their
operation, including the whole merge if any participant moved. The run record,
revisions, merge links, diagnostics and this session/branch's lastSettledFact
advance to the frozen range end in one transaction, preserving lastNotedTurn.
No pending delivery is created. Candidate records survive transaction failure.

Diagnostics are structured objects: `unsupported_numbers` (entry identity and
numbers), `over_200_tokens` (entry identity and estimated tokens),
`unanswered_near` (03b pairs), and `lost_citations` (fact addresses). Number and
length checks cover all proposed new/edit/merge texts, even rejected operations;
new entry identities use their local handles. Numeric matching compares exact
ASCII digit lexemes with internal decimal/grouping separators against supports'
text and quote, without numeric normalization; because does not count as evidence.
The length threshold is strictly greater than 200 using render.tokens, resolving
the stale 200-character wording in Further Notes. Lost citations include any
fact supported in the proposed resulting set by a rejected operation but absent
from all actual resulting visible entries, including earlier and agent facts.
They do not bounce or undo the watermark. These checks derive no entry status.

The fixture `api/fixtures/settle.json` copies E2 from v7m's settle_1.json and its
supporting facts F2/F35 from facts.jsonl. Chinese memory content is preserved;
only the entry category and candidate handle are adapted to the core contract.
Tests remap fact addresses to allocated IDs. Existing 03b tests now expect
application and session/branch ranges, explicitly decline unretained facts, and
add fresh facts before repeat runs; committed entries participate in later NEAR.

## Read facade contract (ticket 04)

`inject(sessionId, branch = "main")` returns attribute-free `<entries>` XML,
with nonempty category tags in glossary order. Within each category, current
revision time ascends, with entry-id ties. XML text is never escaped (lines stay trace lines byte for byte); shared lines,
including revision-bound marks, remain the display grammar. Budgets measure
shared lines before XML escaping and exclude framing and receipts. Protected
categories survive overage; optional categories form a retained prefix.
`<pending_notes>` follows entries, without a budget, and is consumed atomically
only after rendering succeeds. Pass `null` explicitly for legacy null branches.
Successful note commits now record `factIds` in the existing response envelope;
this identifies exact deliveries even when runs overlap in their source turns.
Legacy pending runs without this metadata raise an error and remain pending;
the core cannot safely reconstruct their ownership from turn ranges alone.

`compact(sessionId, branch = "main", headTurnId?)` returns entries followed by
`<episodic>`: standard-cut raw first, then session facts by descending timestamp
and id. All unnoted raw survives budget overflow. It neither calls the model nor
consumes pending deliveries. The schema does not record branch heads: provide
`headTurnId` for precise ancestry, as for note. Without it, compaction retains
all session turns allocated after that branch's watermark, conservatively
including other branches. Receipts follow both XML blocks.

`search(query, scope = "all", { sessionId?, cap?, cursor? })` uses FTS5 query
syntax over fact text and all entry revisions, including historical revisions.
Search is database-wide; the injection visibility rule does not restrict explicit
address lookup. Raw scope requires a session and uses literal substring LIKE
(including tool names, inputs and results); `%` and `_` are escaped. Each hit is
one flattened shared rendering line, with ` ⏎ ` preserving line boundaries.
Results order facts by id, then entry id/revision; raw orders turns by id.
Every search page states that no hit does not mean absent.

`trace` additionally accepts session addresses, exact project names, comma lists,
and `{ cap?, cursor? }`. Projects list global/project entries and project facts;
sessions list turns. Listing caps count output lines, default 100. `cap=n` in
listing addresses is equivalent; on a single turn it retains its existing tool
field budget meaning. Receipts carry `cursor=<opaque string>`; continue through
`trace("cursor=…")` or a listing's cursor option. Cursors freeze rendered output,
are single-use, and last only for this facade instance. User/assistant text is
never shortened by pagination; further pages retain the remaining lines.

`mark({ entryId, kind: "verified" | "flagged" | "clear" })` replaces or clears
only the current revision's mark; historical marks remain on their revisions.
`mark({ sessionId, project, source?: "marker" | "mark" })` declares attribution;
source defaults to `mark`. Hosts report marker files through this same path.
A persisted session mark wins over subsequent markers. The additive
`sessions.project_declaration` column defaults existing sessions to `marker`;
new session-owned projects must use `createSession({ …, projectDeclaration:
"undeclared" })`. Only undeclared projects merge via `mergeProject`; leaving a
named project moves the declaring session and its session entries, not peers.
`status(sessionId)` reports session/project fact counts, visible active entry
count, all branch watermarks, latest attempts by run id, and pending run count.


## Branch summary read (ticket 07)

`branchSummary(sessionId, branch, headTurnId)` renders committed facts on the
branch's noted ancestry, then raw between its current note watermark and the
explicit head. It uses the existing core fact/turn renderer and omission
receipts, without a fact budget, entries, or delivery consumption. A host awaits
its frozen pending note before reading; later unnoted turns remain raw. Unlike
`compact`, this read excludes sibling facts and never budgets away committed
branch facts. This missing read is the only core implementation change in 07;
project declaration, transactional merge, watermarks and delivery writes reuse
the ticket 04 store contract.
