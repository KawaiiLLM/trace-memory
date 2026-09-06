core/ is host-agnostic: it must not import any host SDK.

- model/   Turn, Fact, Entry types and write-time validation (shape only).
- store/   SQLite: global ids, sessions, project attribution, facts, entries, entry revisions, run records.
- note/    build note input, parse output, validate, commit.
- settle/  build settle input (NEAR / CLOSER hints), parse output, accounting, apply new/edit/merge/delete.
- render/  one renderer for note input, compaction tail, branch summary, trace; XML injection blocks.
- prompts/ note.md, settle.md — versioned prompt texts (from simulation v7).

Model calls go through one interface, runAgent(input) → {outcome: success | failure | cancelled, output, usage, request}, where request is the exact provider request the host sent; hosts implement it (Pi: branch mode = prefix-identical call, or subagent mode = fresh call).

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
Counts describe omitted lines and UTF-16 characters. Token estimates are
approximate; caps bound retained payload, not metadata or omission markers.

Hosts may store plain strings or JSON in tool input/result. JSON command inputs
use `command` or `cmd`; execution results use `stdout` and `stderr`. Read/search
names are `Read`, `read_file`, `Search`, `Grep`, or `Glob` (case-insensitive), with
`path`/`file_path` (or a plain input); they show name plus path. Memory writes end
in `note`, `settle`, `mark`, `remember`, or `forget`, optionally after an MCP
`__` prefix. Other results use report head/tail cuts. The host records tool
status; the renderer does not infer completion from text.

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
