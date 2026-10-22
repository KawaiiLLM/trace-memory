# Pi host reference

The current [entry-address and budget contract](unified-entry.md) supersedes older ticket descriptions below of Raw labels, source previews, thinking-only entry storage and full-read scope. Pi normalizes its native ordered blocks once; rendering and exact citations share that authority. Thinking is stored for explicit reads but excluded from automatic Raw text. E ordinals are persisted, never recalculated from the selected branch.

`index.ts` is a Pi extension: its default export takes `ExtensionAPI`. It opens
one facade for the global database and uses only `src/core/api/index.ts`, including
its exposed store. Noting and Dreamer always use a fresh subagent (the Noter runs fresh only, ruling 2026-10-22); Live Consolidation is retired. Automatic N/D checks occur after
each persisted main-session entry (141), not only at main-turn settlement. Ordinary task completion
launches no phase. The current scheduling and publication contracts supersede turn-end-only checks,
chained runs and live C settings in the historical numbered sections below. Historical `note({facts: []})`, immediate N commit and NEAR examples below are not current call guidance.

**One runner (19c).** Every memory task runs inside a real Pi child `AgentSession`
(`native.ts`): every task in a private child session. Pi owns the model call, the tool
loop, the retry policy, cancellation and persistence; this adapter keeps the run record. The request-copy runner — its own conversation
loop, its provider-message construction and its handwritten retry-settings reader — was
deleted in 19c; there is no second runtime and no fallback to one.

The declared minimum is Pi >=0.86.0 on Node >=24.6.0; the current host tests use Pi 0.87.1. The core uses Node's built-in
`node:sqlite` (`DatabaseSync`), with no native dependency to install. From the
repository root, run `npm install`, `npm test`, `npm run typecheck`, and
`npm run smoke:pi`. The smoke script loads the extension directly under Node
using the host tests' stub ExtensionAPI and commits one noting through the native
runner into a temporary database, with the provider stubbed at the wire. See below for launching a real Pi session.

The current schema migrates supported recent databases transactionally. The 64d migration removes
the retired Knowledge annotation and legacy acceptance-state schema, backfills historical empty revision
supports parent-first, migrates unchanged old-default Knowledge budgets from 4,000/10,000/1,000 to
4,000/15,000/1,000, and retains custom budget rows. It seeds per-pool processing records only for
legacy-recorded current visible revisions; it does not treat all current Knowledge as handled or
fabricate records. Revision ids, parents, links, Raw and run audit remain intact. This is the intended
migration contract, not a claim that a production copy has passed acceptance. Stop older executors
before opening the upgraded database; mixed-runtime writes are unsupported. Preserve backups and
logs. See the [installation guide](../README.md#install) before loading the package.

## Memory reads (118)

Models read `trace://` through Pi's native `read` and `grep`; public `trace` is removed, while the human `/trace` controls and private audit remain. The root is a navigation index: a bound reader's own branch/head and recent Turn ids, knowledge-directory counts, and sessions with Turns ordered by latest activity; it has no per-fact lines. `trace://S<n>` lists all Turns newest first, one line per Turn with id, UTC minute, source-entry count, nonstandard kind and earliest contributed fact title (or legacy heading), cut to 80 characters with `…`. Additional facts add `(+m)`. Factless Turns outside the selected ancestry show `(other branch)`, even if already noted; on that ancestry, they show `(not yet noted)` while a selected entry is pending Noting, otherwise `(no fact)`.

Turn listings select counts and fact contributions in bulk using the same source selection as facts views, without rendering every facts view or loading Raw bodies. The reader's own session uses its bound branch/head, including a historical head; other sessions use their latest selected path. Turns outside the preferred ancestry fall back to a containing source path by highest entry high-water mark, then path id. Empty selected paths remain empty, while orphan Turns use stored entries without a branch binding. Legacy corruption does not block Turn navigation; reading the affected facts view still reports its integrity diagnostic.

Content paths are `trace://<layer>/S<n>[/T<t>]`; raw alone accepts entry and role suffixes. Ordinary reads use native 2,000-line/50KB paging, while session knowledge, compaction views and exact raw entries are whole. Offset/limit continuations use the original virtual path and render again; non-virtual main reads remain native, and N/D child reads are restricted to `trace://`. No child grep or glob is added.

The single Core guide is shared by injection, compaction and N/D materials, once per material. Its native tool names are `read`/`grep`; no extra adapter reading lesson is appended to tool descriptions. Fresh admission prices native Read metadata, and forks preserve captured definitions plus the final SDK capacity gate. These are implementation contracts; actual host/provider acceptance must be reported separately.

## Noter tasks and workspace files (144)

Pi exposes the flat `note` and `memory` definitions to manual callers; the Noter does not use them (144). One `note` call carries one fact in top-level `title` and `sources` fields; `sources` is a string of segments, each beginning on a line with `[T12#E3@user] ` (role optional), with no text before the first marker. Core trims trailing whitespace from each source segment while preserving internal line breaks. One `memory` call carries one top-level operation (`op`, `supports`, `reason` and applicable fields); Manual writes commit each call immediately, with memory limited to fact-backed create/update/archive (135). An update uses exactly one of complete `text` with required metadata or ordered exact `edits:[{old,new}]`; edits inherit omitted category/scope/topics. Every writer's title and body are held to `writing.titleWords` and `writing.bodyWords` (144; 字/词 since 145, refused only above target + 10%), an update's resulting body included; `create` requires a `title`, and an update without one inherits its base's. The Dreamer's `memory` also takes one item per call: one operation, or one `{skip, because}`; each legal call commits at once, and a refused one holds an `Mn` slot until `slot` resubmits or `drop` withdraws it (127). See [update and merge contracts](core.md#operations-and-supports) for atomic match refusals, complete-result storage and live merge swapping.

A Noter batch is two runs, `write` and `verify`, each a fresh native child with the same system prompt, tools (`search`, `check`, `read`, `write`, `edit`) and task text. The child's `write` and `edit` are Pi's own tools with operations that touch exactly the run's two workspace files (`facts.md`, `knowledge.md`); any other path, a symbolic link or a file outside the run's directory is refused before the filesystem is reached. The child's `read` also opens those two files. `check` names the task, the step and its file, lists problems and measured lengths, and carries the step's instructions the first time; the stop hook runs the same check: a failing step gets one repair message, its second failure fails the run, and a passing step 1 sends the step-2 message as a native user message. Nothing is published before the second task passes; a task 2 failure keeps task 1's files for the next trigger.

## Automatic checkpoints (141)

Pi checks own N/D downstream of the committed ancestry transaction, once per import that persists new main-session entries, anchored at the selected `state.head` after import with the newest persisted entry's id as trigger. The selected head can be a compaction Turn even when the newest entry belongs to an earlier user Turn. Historical bootstrap at `session_start` or enabling memory publishes the complete selected path before this one check. Fully imported restart/resume and zero-append scans do not check; `session_tree` never checks, even when it imports new history. Manual catchup freezes its own boundary instead. Pi persists after `message_end`; tool preflight, tool-result/next-message boundaries, provider requests and agent-end/settlement import the entries once available. Unchanged native leaves do no work. Before admission, the adapter saves its native state so a fork freezes a stable checkpoint. A busy phase queues nothing; the next entry after settlement checks afresh. Ordinary task success or failure starts no new check. Stop and path changes fence subsequent borrowed-candidate launches as well as current-session work.

Noting uses the existing incremental pending counter, stopping at its trigger. Dreaming caches a not-due result until restore, enrollment or the database progress signal (coverage, the Dreamer's hand-off and failure rows, scores) re-arms it; a knowledge commit changes that signal, while Raw ingestion does not. Failures retry at a later entry end; three consecutive failures still disable memory. Closed-session borrowing stays at the deduplicated `agent_settled` checkpoint, and manual catchup remains an independent drain. See the [Core scheduling contract](core.md#automatic-scheduling-141).

## Configuration

Read configuration from the `trace-memory` namespace in Pi's global `settings.json`
(`PI_CODING_AGENT_DIR` or `~/.pi/agent`) and project `.pi/settings.json`. Project
values override global values; `TRACE_MEMORY_CONFIG` is the final flat JSON override.
Pi's own runtime settings — `retry` and provider policy — are not read here at all: the
child session is built with Pi's `SettingsManager` and uses whatever that reports (19c
gate 6), with one deliberate exception. The memory child applies
`applyOverrides({ compaction: { enabled: false } })` to its **own** manager (27b, parent 27
amendment 1), after the resource loader's reload, which rebuilds the merged settings from the
files and would otherwise drop it. Automatic compaction of a worker session would answer a
provider overflow by deleting the failed reply, paying for a native summary and retrying, and the
overflow would never reach the adapter. The override is in memory only: it writes no file,
and the foreground agent — with Pi's compaction hooks and the user's own settings — is untouched.
The plugin never writes settings.
For example, either settings file can contain:

```json
{
  "trace-memory": {
    "noting.triggerTokens": 10000,
    "noting.batchTokens": 10000,
    "noting.nearThreshold": 0.4,
    "consolidation.triggerTokens": 5000,
    "dreaming.triggerTokens": 10000,
    "dreaming.timeoutMs": 600000,
    "dreaming.model": "session",
    "dreaming.thinking": "inherit",
    "consolidation.batchTokens": 10000,
    "compaction.factsTokens": 10000,
    "compaction.rawTokens": 10000
  }
}
```

`compaction.factsTokens` and `compaction.rawTokens` retain their independent 10,000-token bases.
The database-owned Knowledge base is the safe-integer sum of Global, Project and Session budgets,
defaulting to 4,000, 15,000 and 1,000. The one temporary allowance, `compaction.temporaryTokens` (10,000; ticket 144), is not derived from phase triggers
(`compaction.sharedAllowanceTokens` is a removed setting). Knowledge fills its base in score order; the allowance is
filled in order: pending Raw overflow, then unscored Knowledge (newest first), then titles of scored Knowledge that missed the
base, then human user words within `compaction.userTurns` (100) and uncovered fact
titles within `compaction.titleTurns` (100), filled together turn by turn, newest first (each turn's
user entries, then its titles), so both reach the same depth; the first item that does not fit stops
both. Both reaches include the anchor and count path turns; unused room never reaches older turns.
User entries use the renderer's middle cut with `compaction.userEntryTokens` (300). All four new settings require positive safe integers.
Full facts do not borrow, and none of the bases lends to another.

`render.knowledgeBlockTokens` and `consolidation.knowledgeTokens` are retired. Remove those two keys
from every settings file and `TRACE_MEMORY_CONFIG`; finding a removed key is a named load error.
`dreaming.triggerTokens` is configurable: its default is 10,000, compared with the tokens of knowledge the
Noter created or changed since the last covered Dreamer pass (144 stage 4). Foreground publication may use the Knowledge base and what the context's
temporary allowance has left. Database budget edits accept exact
decimal nonnegative safe integers, commit transactionally, write no Pi settings file and affect all
connections to that database. The budgets size injection and compaction only: they trigger no Dreamer run and decide none's success.
Running requests keep their frozen admitted capacities; later admissions use the current policy. Actual
provider context capacity remains an independent hard gate.

Environment override example:

```sh
export TRACE_MEMORY_CONFIG='{"dbPath":"~/.trace-memory/trace.db","noting.triggerTokens":10000,"noting.batchTokens":10000,"consolidation.triggerTokens":5000,"consolidation.batchTokens":10000,"noting.maxToolRounds":0,"consolidation.maxToolRounds":0}'
```

- `dbPath` defaults to `~/.trace-memory/trace.db`; its parent is created on load.
- `dreaming.model` and `dreaming.thinking` use the same model/thinking Settings selectors,
  defaults and precedence as the other phases. Dreamer has no new settings page. The classify task has its own
  `dreaming.classifyModel` and `dreaming.classifyThinking` rows in the same Settings; admission resolves both triples and freezes them for the run.
  `dreaming.maxToolRounds` is a removed setting (the Dreamer has no tool-round limit); a leftover key fails the load by name. The shared `dreaming.timeoutMs` default is
  1,800,000 milliseconds, applied to each of the Dreamer's three tasks (curate, verify, classify). Expiry fails the
  task, fences its workspace and releases its claim. Provider retries do not reset the deadline. After a pass the host asks
  for one repair of a file that fails its check, then ends the task.
- `notingModel` and `consolidationModel` accept `provider/model-id`, or `session`. Omission
  and `session` both resolve to the current session model's audited provider/id.
- `notingThinking` and `consolidationThinking` (26d) accept `inherit` (the default) or one of Pi's
  own levels `off`, `minimal`, `low`, `medium`, `high`, `xhigh`, `max`; anything else is rejected at
  load by name with that list. They set the level this phase's **subagent** runs think at; `inherit`
  and omission both mean the foreground level frozen at admission (26b).
- Core settings use dotted names: every `render.*`, `noting.*`, `consolidation.*`, and `dreaming.*` key
  in `DEFAULT_CONFIG` is accepted with the core's default and value type.
- `noting.forkModeDefault` and its legacy alias `noting.branchModeDefault` are **removed settings** (ruling 2026-10-22: the Noter runs fresh only, because a fork's prefix is the main conversation, not the compaction memory the Noter starts from). Finding either in any settings layer, `TRACE_MEMORY_CONFIG` or `memory.configure` fails the load by name: `Removed setting noting.forkModeDefault: the Noter runs fresh only; remove this key`. Every noting uses `notingModel`, priced by that model's own capacity.
- `nativeRunner` (19a) is **gone** (19c). The native runner is the only runner, so the key
  selects nothing; like any other unrecognized key it is rejected at load with
  `Unknown setting nativeRunner`, which is 18a's rule for configuration that does not exist.
- `runsDir` (19a) **defaults to `<resolved Pi agent directory>/sessions/trace-memory` (24c)** —
  ordinarily `~/.pi/agent/sessions/trace-memory/`, or under `PI_CODING_AGENT_DIR` when that is set.
  A new worker log is a *direct* child of it, named with Pi's own
  `<timestamp>_<child id>.jsonl`, with no per-parent subdirectory. **This supersedes ticket 19's
  ruling 19:5** ("native worker logs live next to the database … not Pi's session directory"), whose
  default was `<dbPath's directory>/runs/<parent Pi session id>/`. The reason is external
  accounting: the file-based daily-cost readers scan the sessions root plus exactly one directory
  level, so a worker log anywhere else is invisible to them and a second level would hide it again.
  The tradeoff, accepted deliberately, is that worker sessions now appear in Pi's all-session
  browser under `trace-memory`. There is no hiding framework and no discovery-driven import:
  worker resource/extension discovery stays disabled and nothing imports a directory.
- An explicit `runsDir` keeps 19a's precedence and 19a's layout,
  `<runsDir>/<parent Pi session id>/<timestamp>_<child id>.jsonl`. Unless it *is* Pi's sessions
  root, that layout puts the logs outside the tree those readers scan, and the menu's Settings entry
  says so under its `Worker logs:` line (24b moved that disclosure when it replaced the read-only view). Each run record still stores the absolute path as `nativeLog`
  inside its response JSON; a directory or persistence failure fails the run rather than recording a
  success naming a file that does not exist.
- Changing the default moved nothing. Logs written under an earlier default stay where they are —
  never moved, copied, symlinked, deleted or rewritten — and their run records keep naming them.
  Logs outside the scanned tree are not retroactively part of anyone's daily total. Retention is
  still a documented v1 limit: nothing prunes either directory.
- Borrowed closed-session work and manual catchup run fresh-context like every other task. The first valid `memory`
  submission of historical Consolidation committed immediately. `consolidation.subagentModeDefault`
  — the retired *inverse* key — stays **removed**. Tree navigation launches no extraction.

The peer dependency supplies Pi SDK types. The declared minimum is Pi >=0.86.0;
the current host tests use Pi 0.87.1. Tests use Vitest on Node;
the standalone smoke uses Node's built-in TypeScript support and does not load Vitest.

## Host decisions and boundaries

- `/trace project <name>` declares shared project membership after the first assistant reply. The
  same name in the same database identifies the same project. A new session conservatively joins the
  one project already associated with its repository-root or real-cwd key; zero or several candidates
  leave it private. Home and temporary directories never key, and no marker file or Git remote
  supplies attribution. A project may exist before any assistant reply; a Trace Memory session cannot.
  The first prompt is buffered until that reply permits its Turn to be appended. Stored declarations
  persist across resume and tree navigation.
- Knowledge projection is stateless. Core derives one current revision per identity from the immutable
  commit graph and the current applicability of each revision's **direct supports**. Parent and
  merge/split links preserve provenance but do not recursively add applicability conditions. When two
  applicable operations consume the same base, the branch containing the later applicable commit wins;
  if it ceases to apply, the earlier branch can return. Archives participate in this resolution before
  body filtering. Core selects that one global current revision first and then applies reader scope;
  an invisible current revision hides the identity rather than falling back to an older body. Reads and
  transactional stale-base checks share this resolver.
- `before_agent_start` evaluates foreground Knowledge publication on **every enabled ordinary
  prompt**. Worker completion is not itself a delivery trigger, and there are no initial-only or
  `/trace on`/`/trace project` generation triggers. Those commands only change enrollment or project
  attribution; the next ordinary prompt runs the same predicate. Worker `memory` tool receipts,
  manual foreground tool results, explicit reads and compaction content are unchanged.

  The host obtains Pi's selected compaction-aware entries, builds their trusted visible view, and asks
  core for applicable current exact revisions. A visible exact Knowledge body suppresses itself. A
  change is also suppressed when every direct support is visibly present as a Fact, or when every
  support is proven from complete Noting source bindings to retained original or marked bounded Raw.
  A bounded carrier's database/native pair must name an entry in the selected memory-session path; a
  valid pair from another or sibling path proves nothing. The bounded view counts as evidence even if
  its truncation omitted the relevant text. Empty supports, partial/missing bindings and legacy-unknown
  mappings suppress nothing. Evidence and applicability are path-scoped; no abandoned sibling or
  guessed working-directory project can contribute.

  Carriers persist the exact Knowledge commit ids whose bodies were actually returned plus stable
  identities for archive/supersede/merge/split notices. Notice visibility is separate and never grants
  a replacement body. The publication contains no Fact, Raw, pool-scheduling metadata,
  command-generation metadata or omission-only block. Retained applicable Knowledge bodies and notices
  consume the Knowledge base (20,000 tokens at the default policy); what the context's temporary allowance has charged limits the unscored items and titles. Missing state
  transitions fit as a deterministic whole-item prefix before complete new bodies; only selected
  transition receipts persist. Knowledge keeps category groups and chronological display inside each
  group. The common header says items are grouped by category, position does not compare items across categories, and a newer same-object item within a category stands
  until maintenance merges it; each group opens with a `## <category> (<n>)` line (132). Capacity selection omits the oldest optional items first, preserving
  newer ones. An unfit next mandatory transition is not skipped, and exact fit is accepted.

  Immediately before returning a publication, the host revalidates enrollment, Pi/native binding,
  selected leaf, path head/branch and project attribution. Any retarget or disable discards the stale
  offer; a later prompt recomputes. Persistence, not an offered hook return, establishes visibility.
  Reopen, rewind and sibling navigation therefore derive solely from the selected native ancestry.

- Source identity is `(Trace Memory session, native session lineage, Pi entry id)`. Pi publishes one
  persisted lineage cursor for its selected foreground on reconcile and Turn end. Each lineage moves
  independently; closing retains its cursor and reopening adopts the same key. Fact liveness requires
  one complete cursor path to contain its Turn, all source Turns and bound entries — sibling paths are
  never spliced. A legacy session with no cursor treats all stored paths as active. The host reconciles
  completed messages from the selected persisted ancestry on attach and at safe subsequent boundaries. Pi runs `message_end` extension hooks
  before `SessionManager.appendMessage`, so a completion event alone supplies no
  entry identity. Streaming content, custom/plugin messages,
  compaction summaries and worker messages are not source entries. Repeated text
  is never deduplicated. Earlier native history is imported on attach, known
  identities are reused, and missing native parents or owning user messages are
  reported in the UI. No replacement source is invented.
- Each completed entry owns a Turn. An assistant entry persists its tool-call
  occurrences immediately; a subsequent tool result is a separate source entry
  using the same stable Turn tool ordinal. Original messages, arguments and results
  are retained. `trace://raw/S<n>/T<t>#E<k>` reads one complete source entry, including original
  tool arguments and results. `trace://raw/S<n>/T<t>` assembles the Turn's selected entries
  under the configured compressed profile; ordinary paging follows Pi's native `read`.
- Each newly ingested main-session entry checks the active branch's N/D queues (141).
  The unchanged native leaf-id guard keeps streaming updates O(1); busy phases queue nothing.
  `noting.triggerTokens` defaults to **10,000 compressed-view tokens** measured
  with `renderEntry` over `pendingEntries`, including separators. Original Raw size,
  entry count and answered Turns do not trigger runs. Excluded sources contribute nothing.
  The old `noting.nearThreshold` and pre-commit lexical review are removed. Explicit configuration of that key is rejected.
- `noting.batchTokens` defaults to **10,000** (ticket 20; it was 50,000 through 17b): the oldest
  contiguous whole-entry prefix, without Turn boundaries. An entry is never skipped so that smaller
  later entries can fill the remaining space, and a partly filled batch is valid. Excess waits for
  a later main-turn checkpoint or an explicit catchup batch.
  It bounds this phase only: since 28a compact measures its pending views against its own Raw window
  (`compaction.rawTokens`) inside the three-window envelope, so changing this key — or
  `render.episodicBlockTokens`, which stayed the Noter's — does not change what compaction keeps.
  The effective batch also reserves instructions, knowledge, tools and the existing
  context: since 27a the host reports `contextWindow - 10,000` as the input allowance
  (see "Request capacity" below). An oldest entry that cannot fit remains
  pending with a capacity notification. Unknown model capacity still leaves work pending.
- Dreaming is checked **per session** at each entry end through arming, over `global`, this session's
  project and this session together. A run is due when the Noter-changed tokens since the last covered Dreamer pass reach
  `dreaming.triggerTokens` (10,000 by default; each changed live item counted once at its title plus body, manual and
  Dreamer revisions never counted), or when a hand-off row asks for a retry or resume. One run covers all three pools and
  runs three tasks: **curate** (per category, blocks of the run's one operation, rotating `update`, `merge`, `split`, `archive`, kept
  batch by batch and never applied before verify), **verify** (one confirm, edit or revert for every proposal, against
  facts, Raw and the session's repositories; its pass applies the confirmed and edited ones) and **classify** (importance scores 1 to 100, in fresh passes of at most 100 items). Each task writes a
  file in its own workspace with Pi's `write`/`edit` and `check`, and ends when the model stops; a task with nothing to do
  makes no model call. A passed task leaves a hand-off, so a stop or failure resumes where it left off; a transient
  failure is retried at later checks up to three times, any other waits for a further trigger's worth of changes, and a
  Dreamer failure never switches memory off. Curate's first request is the knowledge prefix (at most 50,000 tokens) and
  verify reuses it. Exact current bases and the live database-wide Dreamer claim are checked atomically; a stale base is
  refused for that operation only. Ordinary completion starts no next run, even while the session remains due. The earlier
  pool-budget Dreamer (a frozen 10,000-token range, `memory` skips, an end review) is removed. There is no automatic Raw
  block or `note` tool.
- `consolidation.triggerTokens` defaults to **5,000 rendered fact tokens** and
  `consolidation.batchTokens` to **10,000** (ticket 20). Both count the same rendered fact view —
  the fact line with its relations and the joining separator — the trigger over the whole applicable
  unconsolidated set, the batch over the oldest-first whole-fact prefix it selects. Historical facts
  and knowledge contribute to neither. Committed facts are eligible
  immediately, even from partly recorded Turns. Selection takes applicable facts
  without Turn grouping; path-aware per-fact progress is unchanged. There is no
  first-Noting gate and no scalar fact cursor. An oldest fact larger than the batch ceiling stays
  pending with a capacity problem rather than being clipped or skipped. Consolidator accepts only
  `create`; its first valid submission commits. A changed claim is a new identity until Dreamer later
  reconciles it. Current manual `memory` writes allow fact-backed create/update/archive (135).
- `consolidation.triggerUnconsolidatedFacts` is **removed** (ticket 20). Any layer that still supplies
  it fails the load with `Removed setting consolidation.triggerUnconsolidatedFacts: use
  consolidation.triggerTokens (tokens, not a count)`; an old fact count is never reinterpreted as a
  token budget. The menu never offers it: the menu edits mode/model preferences and closed-session scope only,
  and the advanced keys live in the settings files.
- `consolidation.knowledgeTokens` is **removed** (ticket 45). Consolidator Knowledge uses the bound
  database's Knowledge base, frozen at task admission. Any configuration layer
  that supplies the old key fails by name and directs the user to the database Knowledge base
  in Settings; the value is never reinterpreted or ignored.
- `consolidation.subagentModeDefault` is **removed** (ticket 25 amendment 2). A saved value of either polarity fails the load with
  `Removed setting consolidation.subagentModeDefault: Consolidation is retired; remove this key`. Nothing is normalized behind the setting and no settings file is
  rewritten. Runs recorded in fork mode before the Noter became fresh-only keep that mode and read back as themselves in Runs
  and in the historical internal run audit.
- `render.stdoutHeadTokens`, `render.stdoutTailTokens` and `render.stderrTailTokens` are **removed**
  (ticket 23). They budgeted a stdout/stderr result shape Pi never produces, so they were never
  effective on any Pi run; a layer that still supplies one fails the load with `Removed setting
  render.<key>: use render.toolInputTokens (the whole rendered call part) and render.toolResultTokens
  (the whole rendered result part)`.
- `render.commandTokens`, `render.reportHeadTokens` and `render.reportTailTokens` are **removed**
  (ticket 23b) with the same message and the same replacement. They shaped the per-tool branches of
  the explicit Turn preview; that preview is now the entry view under the configured profile, and
  `full` renders the stored evidence uncut, so neither has a budget of its own.
- `render.toolCallTokens`, `render.secondaryToolCallTokens` and `render.secondaryEntryTokens` are
  **removed** (ticket 30). `B` was one budget for a call and its result, split in half, so its value
  is not `C` or `R` and is never reinterpreted as either; the tier-2 pair went with the second tier
  itself. A layer that still supplies one fails the load naming the key and the new ones.
- Worker completion starts nothing. A fresh eligible entry completion provides
  the next opportunity; no polling or draining is added. Each runtime reserves one
  slot per phase before asynchronous admission. Quit/reload cancels its workers
  under one five-second cleanup deadline and starts no flush.
- Pi custom entries persist session/turn/branch references, using Pi's own
  `appendEntry` facility. Resuming restores the selected lineage. Returning to a
  branch tip reuses its name; selecting an earlier point creates a new branch.
  Pi forks carrying these references stay in the same Trace Memory conversation
  lineage with a new branch name. A fresh Pi session gets a fresh Trace Memory
  session on its first reply. The before-tree hook returns a read-only summary as described below.
- Compaction reconciles persisted source entries and asks core to render that
  frozen snapshot (see **Compaction and the post-compaction boundary** below). For a custom
  replacement the adapter returns the prepared text as `compaction.summary`; for a native
  delegation it returns nothing at all, so Pi runs its own compaction. `firstKeptEntryId: ""` retains no old Pi
  messages: the facade block replaces the context. Pi 0.85.0's context builder
  searches for that id, finds none, and keeps the compaction plus later messages.
  Successful compaction is then recorded as a `compaction` turn; it receives no facts.
  Pre-reply compaction returns project injection without allocating a session.
- Main-agent registration and subagent requests share Core's `search`, `note` and `memory`
  definitions; model reads use Pi's native `read` (and `grep` on the main session) over `trace://`.
  Pi execution fields are non-enumerable, so provider serialization includes only shared metadata.
  Search is `search({query?, scope?, layer?, topk?, code?})` (ticket 136); see
  [the core search contract](core.md). It lists every applicable knowledge version with its status, prints one
  line per hit, and runs `code` over the structured hits in a QuickJS sandbox. Only a call with `code` answers
  asynchronously. An over-long output keeps its start and end and is saved to a file made on first use under the
  temporary directory (Pi has no per-session render directory for `trace://`, which is virtual) and removed at
  session shutdown. A Noter or Dreamer worker saves into a temporary directory of its own, made on first use and
  removed when the run ends; its `trace://`-only `read` may also open files under that directory. Search returns no
  knowledge write handle; use `trace://K<id>` for a complete tagged current body and `trace://K<id>.history`
  for its history. `trace://` rejects the retired comma lists and `K..` forms and reads with native offset/limit
  on the original virtual path.
  Manual `note({title, sources: "[T1#E1@user] Authored text", ...})` takes one top-level
  string of `[address] text` segments (multiline segments allowed, no preamble) and writes one fact;
  `memory({op, supports, reason, ...})`
  writes one Knowledge operation immediately within the caller's authority; `note({})` and
  `memory({})` are explicit empty calls. The Noter and the Dreamer write workspace files instead (144). Every operation
  carries `supports` and a `reason`; create/update/merge also
  carry the revision's complete `topics` set. The Noter's file permits create/update; manual calls permit
  fact-backed create/archive; only the Dreamer's curate file may merge or split, and its files may submit
  support-inheriting operations. Main-agent executions call `tools(context)` with kind `manual` and
  the current session, branch and turn. Writes commit immediately; `tool_result`
  records each raw call once. No prompt asks the main agent to maintain memory.
- `/trace` opens the native menu described below, or prints status and the command forms when there
  is no dialog-capable UI. `/trace on` and `/trace off` change this memory session's participation.
  `/trace project <name>` declares the project, saves host state and displays refreshed injection.
  `/trace catchup` and `/trace stop` start and cancel the manual finite drain described below.

## Executor slots, claims and shutdown

Each enabled active Pi runtime has one local slot per phase. Noting and Consolidation may overlap
and may borrow a normally closed target under `closedSessionScope`; they prefer the executor's own
eligible work. Dreaming never borrows a closed-session task. All Pi and CC executors and all
projects sharing this database compete for one database-wide Dreamer seat, represented by the
live Dreaming claim. Worker completion only releases capacity; it starts no next batch.

Pi passes the exact persisted source-entry head at admission. Core freezes the target, path and
phase boundary before later entries or navigation can move them. A SQLite claim records executor,
random token and thirty-minute expiry and excludes another worker of that target phase. Dreaming's
unexpired claim also occupies the database-wide seat. Commits require the exact live token and
frozen target checks; reopening replaces another executor's token immediately. An expired or
replaced worker may leave audit history but cannot commit or release its successor's claim.

Closed-session scope applies only to Noting and Consolidation: `project` (default) allows a closed
target in the executor's project, `global` allows any project, and `off` leaves closed tails pending.
The executor must remain enabled and open. Borrowed work is a fresh subagent on the executor's
configured phase model, but evidence, commits, costs and run records remain attributed to the target.
Its target must still be closed, and a frozen project-scoped borrowing relation must still hold at
commit. Current-session work, manual catchup, explicit reads and Dreaming are independent of this
setting.

Changing a session's project requires that declaring session to have no running N/C/D and no reached
N/C/D trigger, including every applicable knowledge pool. Refusal names the running phase or backlog
and starts no catchup or queued declaration. Other sessions do not block the move; their in-flight
writes retain ordinary authority checks. Relabel creates no Knowledge revision and clears only
moved-in project versions' destination processing records, making return moves pending again.

Normal shutdown stops admission and cancels this executor's model calls under one five-second
cleanup deadline. Cancellation closes the tools and workspaces at once (the cancellation fence); the hand-off keeps
the task that was cut off, so the next due check resumes there. `/trace off` does the same.
Token, expiry, takeover, target project and frozen-range checks remain mandatory. After terminal
processing or a pre-commit cancellation, the claim is released conditionally.

A business commit that wins before cancellation survives; no committed batch is replayed to obtain
a final response. Normal shutdown then marks only the executor's own session closed and closes
SQLite. Session-start restore clears that closed state and reserves new claim tokens for the executor;
if it imports new main-session entries, it checks own N/D once at the final selected head, triggered by the newest imported entry. Tree navigation does not check. A direct synchronous facade close is a hard close rather than this graceful host sequence
and may abandon terminal bookkeeping, so hosts must await normal shutdown.

The child `AgentSession` receives a per-worker `AbortSignal`. Abort stops its provider request or
retry wait without touching the foreground or sibling workers. A provider may ignore remote
cancellation and continue billing, but disposed tools and claim fences prevent late local writes.
Known usage and cancellation diagnostics are retained; missing cancelled usage remains unknown.

## Enrollment and native menu

One enrollment switch belongs to each memory identity. Three failures of the same logical
task can turn it off automatically; see [Three failures turn memory off](#three-failures-turn-memory-off-32c).
Explicit `/trace on` clears that identity's persisted failure streaks; reopening does not.

New native sessions whose
`ctx.sessionManager.getHeader().timestamp` is strictly after the baseline default
Enabled; older, equal, missing or malformed timestamps default Disabled. The
baseline is atomically published in `trace-memory-baseline.json` in Pi's agent
directory at first successful initialization. It survives restart and upgrade,
independently of the configured database. This operational baseline cannot infer
when the package was installed before its first run. A native session created
before that first run therefore defaults Disabled. No migration exists in v1;
database presence is never explicit enrollment.

Use `/trace on` to opt in or `/trace off` to pause; both act on this memory session
alone, immediately and without a reload (24b supersedes the `enable`/`disable`
spellings, which are retired without aliases). There is no global participation
switch. Explicit choices survive
reopen, configuration reload and tree navigation. Before a memory identity exists,
the host persists provisional intent in a native custom entry and transfers it at
allocation after the first assistant reply. Pi defers writing a new native file until
that reply, so an atomic host-state receipt under the agent directory
(`trace-memory-enrollment/<identity hash>.json`) also preserves provisional intent.
It is enrollment state, not configuration; the database switch takes authority
after allocation. No artificial Turn is created. Forks
and clones carrying an identity share its current switch; a copied file's newer
creation timestamp cannot override it.

Enabling reconciles available current-path history, including the paused interval,
through the same identity-based importer as ordinary entries. An import that persists new entries
checks normal own N/D thresholds once at the final selected head, triggered by its newest entry; enabling synthesizes no completion.
Repeating enable does not duplicate imported sources or check without a new import.

Disabled sessions ingest nothing, inject nothing and start no new worker. Manual `note` and
`memory` reject with `/trace on`; `trace://` reads, `search` and status remain available even before
allocation. Compaction and tree hooks return no plugin override so Pi proceeds with native context
handling. Stored Raw, facts, Knowledge, runs and scopes stay intact; other sessions still see shared
Knowledge. Already-injected text remains in context.

Disabling cancels this executor's active model calls and closes their tools and workspaces. Late business
writes are fenced, a Dreamer's included: the cancelled task's claim expires at once and what the task already
applied stays. Another executor still must pass the ordinary target and claim checks.

### Commands, menu and global settings (24b)

The direct command forms are exactly these, and nothing else acts:

| Form | Behaviour |
|---|---|
| `/trace` | Opens the menu; without dialog-capable UI (`-p`, rpc) prints status and this table's forms |
| `/trace on` / `/trace off` | Enables or disables **this** memory-session identity, at once, without a reload |
| `/trace catchup` / `/trace stop` | Start and cancel the manual finite drain described below |
| `/trace project <name>` | Declares the project after the first assistant reply |

`enable`, `disable`, `status` and `runs` are **retired without aliases**: status and
runs live in the menu's Current session, and a headless bare `/trace` prints status.
A retired spelling, an unknown word or a malformed argument prints the usage above, names where
the retired function went, and changes nothing — no enrollment change, project declaration or
worker. The retained forms exist because `-p` and rpc sessions have no menu; they are documented
forms of the same operations the menu performs, not hidden aliases.

Bare `/trace` opens a native menu with four top-level entries:

- **Current session:** a compact context-capacity map and pending/trigger estimates,
  enrollment, project, the session's spend by phase and recovery warnings in a scrollable Pi-themed panel, with
  `On`/`Off` with confirmation and shared fork/clone scope, `Runs` with a count input,
  and `Project` with a name input.
- **Catch up:** starts (or reports) the manual finite drain described below.
- **Stop:** cancels this executor's background work, including a running or
  waiting catchup. It never changes participation.
- **Settings:** the global preferences below.

Cancelling any dialog or input changes nothing and makes no model request. Menu and
command paths call the same functions, so validation, confirmations and core's own rejection of a
project declaration without an assistant reply are identical from either. The catchup handler starts
the cancellable drain and returns
immediately, so stop can be invoked while it runs.

#### Current session measurements

The context panel combines two independent measurements. Pi's `getContextUsage()` value
and the model window determine occupied and free capacity. A selected
`buildContextEntries()` snapshot supplies only the occupied region's color proportions,
using Pi's public message APIs and the core text estimator. This local census covers the
current system prompt and active tool definitions, but it is not final provider wire or
an exact tokenizer bill. Its legend always reports the actual, unscaled local estimates;
an incomplete census adds `(partial)` to the heading.

A nominal full cell is 0.5% of the model window. The renderer projects each positive local
leaf into the SDK-reported occupied capacity, gives that leaf its own full cells plus one
`⛀` partial glyph for any positive sub-cell remainder, and rounds free capacity up with
`⛶`. Because partial remainders are represented separately instead of competing for 200
slots, a truthful grid can contain more than 200 glyphs and automatically grows beyond ten
20-cell rows. The legend states the projected occupancy rule, full/partial/free glyph
counts and the nominal tokens per full cell.

The grid has no Difference category and never treats an SDK/local mismatch as image or
other non-text usage. System, Tools, Skill catalog, Knowledge, Facts, Raw, Unclassified,
Conversation and Other retain their fixed order and colors even when the local sum is
above or below SDK usage. When SDK usage is positive but every local estimate is zero, a
neutral `Unclassified occupied` segment represents the known footprint without inventing
a local category estimate.

Raw values select capacity states before formatting or floating-point rounding. Missing
SDK usage or window omits the grid and names the missing input; exact cell boundaries do
not gain a spurious partial glyph. Usage above the window preserves the projected category
colors, caps only the occupied footprint at 200 nominal units, reports the numeric overage
and shows zero free capacity. Reopening takes a new snapshot, so later valid SDK data
replaces an unavailable display without reloading the extension.

- **Memory:** every retained initial injection, on/project supplement and metadata-bearing custom
  compaction, including Pi's summary framing. Repeated occurrences count repeatedly;
  changing project or disabling enrollment does not subtract text still retained. Memory
  remains one local aggregate in the legend, while its positive Knowledge, Facts, Raw and
  Unclassified leaves receive separate grid segments and detail rows in that order.
- **Memory metadata:** Knowledge, Facts and Raw estimates come from the same assembled
  material and require a matching body hash, nonnegative safe-integer parts and a sum no
  larger than the body estimate. Titles, receipts and other framing remain Unclassified.
  Old, malformed or body-mismatched metadata makes the entire carrier Unclassified.
  Coverage IDs and database inventory never measure capacity.
- **Skill catalog:** Pi's formatted names, descriptions and locations, deducted from
  System only when the full catalog has one exact occurrence in the actual prompt,
  using Pi's selected-tools semantics (read preferred, bash fallback, neither omits it).
  An uncertain match stays System. Loaded SKILL.md and reference bodies remain Conversation.
- **Conversation / Other:** retained ordinary messages and native summaries / other
  extensions' custom messages. Pi-excluded bash executions contribute nothing.

At 80 columns or wider, the panel uses a 39-column spaced, 20-cell-wide grid, a
three-column gap and the wrapped legend beside it. From 20 through 79 columns, the
unspaced 20-cell-wide grid and complete wrapped legend stack. Grid height follows the
actual glyph count. Below 20 columns the text stays width-safe without manufacturing a
one-cell-per-row grid. Pi's ANSI-aware display-width utilities wrap the
complete section before pagination. In the TUI, this panel alone uses the
public `ui.custom` overlay API, not an oversized native selector title. The overlay
uses the terminal's available screen rather than the fullscreen editor dock. Its
component supplies every allocated viewport row; Pi's public compositor supplies the
horizontal padding, so ordinary conversation, editor, footer and background text do
not show through. Dismissal restores the current underlying frame and focus.
**Known host limitation:** Pi 0.85.1 bypasses overlay composition for Kitty/iTerm2
inline-image protocol rows. Existing terminal graphics may therefore remain visible
while the panel is open; complete image occlusion and restoration are not guaranteed.
Beta.7 accepts this boundary rather than patching private host internals, replacing
the compositor or deleting terminal images. Text coverage is tested through the real
compositor; actual terminal-image appearance has not been manually verified.
Recovery warnings lead the scrollable body; the action list stays visible. The
usual arrows (or `j`/`k`), Enter and Escape retain selection/cancellation semantics;
Page Up/Down scroll status without moving the selected action. Configured Pi
selection keys are honored. At 24 rows all actions fit; shorter screens show the
selected action and let navigation reveal the others. Below three rows the panel
accepts only cancellation until resized. Resizing reflows the same snapshot,
including switching between side-by-side and stacked context layouts. No footer
content or configuration changes.

The separate **Pending / trigger** bars are estimated trigger material, not task
completion. Bars cap at 100%; numbers and percentages do not:

- **Noting:** joined rendered pending entries on the selected branch/head, under
  the effective entry profile and Pi result extractor. Only imported evidence counts.
- **Consolidation:** applicable unconsolidated facts, including group framing and
  relations, through the same renderer and threshold calculation as eligibility.
- **Dreaming:** one row (144 stage 4): the tokens of knowledge the Noter changed since the last covered Dreamer pass against
  `dreaming.triggerTokens`. The bar does not imply that the database-wide seat is available. The notice area also shows the
  Dreamer's latest failure while no later run has succeeded: `Dreamer failed: <task>: <class>, retry k/3 | waits for threshold (R<run>, <UTC time>)`.
  A Dreamer failure never switches memory off, so this notice does not depend on the automatic-off state.

Thresholds come from the live core configuration. Off retains stored measurements;
no memory identity and unavailable reads are shown separately from zero. Opening
or cancelling the panel neither imports history nor freezes/claims tasks, grants
read handles, changes visibility, writes weight caches or calls a model. Cold
weights are computed with the existing renderer without caching. Measurements are
read once per opening, not refreshed by a timer or footer updates. Run history
stays under **Runs**; automatic-off reasons and fork recovery remain in the panel.
Headless bare `/trace` uses the same read-only composition snapshot and classification as
the UI, retaining its verbose enrollment, pending/trigger, shared-identity and recovery
explanations and command forms. Both paths read once per opening, never per render.
On/off notifications share only the lightweight identity, enrollment, project, cost and recovery
wording. They do not rebuild context composition or measure pending tokens; enabling still imports
available native history through the existing reconciliation path without starting a worker.

#### Global preferences

**Ticket 18a's read-only settings menu is superseded.** The menu no longer lists every
effective key with its source; it edits these preferences.

Noter and Dreamer each expose model and thinking preferences on one select-and-write
path (the Noter has no execution-mode preference: it runs fresh only, 2026-10-22).

| Preference | Choices | Key | Default |
|---|---|---|---|
| Noter model | Follow foreground / an available `provider/model-id` | `notingModel` | `session` |
| Noter thinking | inherit / `off` / `minimal` / `low` / `medium` / `high` / `xhigh` / `max` | `notingThinking` | `inherit` |
| Dreamer model | Follow foreground / an available `provider/model-id` | `dreaming.model` | `session` |
| Dreamer thinking | inherit / one of Pi's levels | `dreaming.thinking` | `inherit` |
| Classifier model | Follow foreground / an available `provider/model-id` | `dreaming.classifyModel` | the Dreamer's model, which follows the main agent's until set (user ruling, 2026-10-22) |
| Classifier thinking | inherit / one of Pi's levels | `dreaming.classifyThinking` | the Dreamer's thinking |
| Closed-session scope | off / project / global | `closedSessionScope` | `project` |

**The thinking entries (26d/32d)** choose the level this phase's runs think at;
`inherit` is 26b's rule, the foreground level frozen at admission. A saved level reaches tasks admitted afterwards; a running
task keeps the level it was frozen with, and Pi's own clamp still normalizes a level the worker
model cannot do (visible as `thinking: { requested, effective }` in the run record).

Each line shows the effective value, its `Default`/`Global`/`Project`/`Environment`
source and every masked layer, exactly as the old read-only view did for these keys;
the dialog's header names the settings file a save writes to and where new worker logs
go. Removing the display of the advanced keys did **not** remove them: every file and
environment value is still loaded, still validated by name, and still documented above.

Models come from Pi's own registry (`getAvailable`, the auth-resolved snapshot, plus
the foreground model). Nothing asks for a credential and nothing calls a model to
validate a selection; a chosen identity is checked with `find(provider, id)`.

A save re-reads the resolved global settings file, merges the one canonical key into
its `trace-memory` section, validates the merged layer through the load path, and
replaces the file atomically. Everything else in the file — Trace Memory's advanced
values and every other extension's settings — survives. A malformed file, a
`trace-memory` section that is not an object, a value the next load would reject, or a
failed write reports the failure and changes nothing; no edit ever reports a success it
did not achieve. If the same preference is present under its legacy spelling
(`noting.branchModeDefault`), the write replaces it with the canonical key and says so,
so the next load has no alias conflict.

Precedence is unchanged (defaults, global, project, environment). A higher-priority
override is displayed as the effective source and is **never** erased to make a global
edit look effective; the notice names the layer that keeps winning.

A saved preference applies to memory tasks admitted afterwards **in this instance**,
without a reload: the settings layers are re-read exactly as a session start reads
them, the host's model selection follows them, and core's `closedSessionScope` is replaced through the
façade's `configure`; every other core key is refused there. A task already running keeps its admission scope, model,
evidence and budgets. Setting scope to `off` does not cancel it; use Stop to end
running work. Another Pi process sees the new
global default through its own settings load; there is no cross-process watcher.
Editing a preference starts no worker and starts nothing else. The same Settings
screen separately edits the bound database's Knowledge base. That
value is database policy, not a Pi global preference, and saves never copy it into `settings.json`.
The screen shows the Knowledge base, the temporary allowance and their maximum Knowledge input separately.

All configuration layers validate before use, including masked values. Unknown or
removed keys fail by name. Counts and token limits require positive safe integers;
`maxToolRounds` retains its documented zero-unlimited sentinel, and `noting.nearThreshold` is a
similarity in [0,1]. Mode settings require booleans. Impossible view capacity
still fails with a capacity message and retains pending sources. Changing `dbPath` requires reloading the extension. The enabled footer's `memory: 9->54/306`
means 9 applicable facts still need Consolidation, 306 Knowledge versions are currently visible, and
54 of those current versions lack a processing record in their owner pool. This is scheduling state,
not a validity partition. Archives are excluded from the visible count. A disabled session's footer
is the compact `🧠 ○ off` line; Enabled but idle keeps the dim hollow indicator and its counts.

## Current context snapshot for other extensions

Use the synchronous helper from an extension handler; the consumer owns child creation and injection:

```ts
import { requestCurrentContextSnapshot } from "trace-memory/src/hosts/pi/context-snapshot.ts";
const snapshot = requestCurrentContextSnapshot(pi.events);
if (!snapshot.available) throw new Error(`${snapshot.reason}: ${snapshot.message}`);
// Inject snapshot.text; node identifies the native session/leaf.
// estimatedTokens, composition and supplied describe the returned material.
```

The channel `trace-memory:current-context-snapshot:v1` takes a synchronous reply callback.
The helper rejects zero/multiple replies. The provider reuses `compact(..., [])` with configured
budgets and no retained coverage; it never runs workers/models, changes the parent or writes state.
Only the current persisted, fully ingested node is supported (not unpersisted streaming content).
Unavailable states return `available: false` with `reason` and `message`; a host-caught error surfaces
this way too, never as native compaction (73: `compact` no longer refuses for capacity). Successful
results are detached from later changes.

## Memory files under trace://

The extension extends Pi's native `read` and `grep` for the read-only virtual `trace://` namespace. `read trace://` shows the navigation index described above; node views use `trace://<layer>/S<n>[/T<t>]`, with knowledge, compact, facts and raw layers. Raw alone accepts entry and role suffixes. `trace://knowledge/S<n>` gives a child the knowledge a fresh context there receives; `trace://compact/S<n>` gives it continuation material. Grep lists matching files by default, supports content/count modes and searches full Raw entries, not duplicate overviews. Recursive Grep from `trace://` finds facts through session Turn facts views, without separate `trace://F` leaves. Public `trace` is removed; private rendering and human `/trace` controls remain. Every other path goes to Pi's native tool unchanged. Writes under `trace://` are refused and reads record no delivery. Fresh N/D child reads are restricted to `trace://`; ordinary subagents with the extension can use these paths too. A session-start warning reports an earlier extension's conflicting `read` or `grep` registration.

## Compaction and the post-compaction boundary

`session_before_compact` reconciles persisted history and asks core to allocate one frozen selected-path
snapshot. Allocation is local and model-free: it takes no claim and advances no phase. Under 133 R1,
Pi returns no replacement when `truncated.raw` reports any omitted pending entry, so Pi compacts
natively. Absent material or unexpected host-caught errors, including a live-task lookup error,
also delegate. Optional historical omissions alone remain custom; a capacity-empty window with
no omitted pending Raw may still produce the existing foreground omission notice.

A failed initial allocation stays native even if a later live-task lookup could recover.
Successful allocations are repriced before publication; cancellation still publishes nothing.

| Outcome | Condition | Adapter result |
|---|---|---|
| `{text, supplied, charged, truncated?}` with no pending Raw omission | Eligible material exists | Return `compaction.summary` with its custom carrier |
| `truncated.raw` | At least one pending Raw entry cannot fit Raw base plus temporary | Delegate without a custom delivery; Raw stays pending |
| No material candidates | Nothing to supply or omit; guide or tasks alone are not material | Delegate without a custom delivery |
| `{native: true, reason}` | Unexpected host-caught error, including a live-task lookup failure | Delegate to Pi's native compaction |

The default envelope is 50,000 tokens: Knowledge 20,000, full facts 10,000, Raw 10,000
and the one temporary allowance 10,000.
Pending Raw has first claim on the temporary allowance; unscored Knowledge, knowledge titles, earlier user words and fact titles
fill only its remainder, in that order. Each emitted section's headings, groups and receipts are charged.

Inside `<episodic>` the order is fact titles, full facts, earlier user messages, Raw, running tasks.
The optional pi-subagents service at `Symbol.for("@gotgenes/pi-subagents:service")` supplies
queued/running agents. With no service there is no task block or package dependency.
Tasks count in the delivered text but not any budget. Noter uses the same allowance at its
batch's newest turn and trims it before full historical facts when capacity must shrink.

Historical Raw is displayed in source order. Historical facts are displayed in chronological Turn
groups. A fact — consolidated or still pending — is omitted as redundant only when its complete
nonempty source binding is covered by retained originals or the Raw span selected for this
replacement. Unknown, incomplete or partly covered bindings stay eligible, as does a fact whose
sources straddle the span's start. Omitted material starts no worker and changes no processing state.

The adapter passes the native ids that Pi will retain, so historical Raw is not duplicated. A custom
replacement supplies every kept entry as the shared bounded `renderEntry` view and returns
`firstKeptEntryId: ""`; the replacement, rather than old Pi messages, carries those views. The same
entry labels, budgets and truncation markers are used by Noting and `trace://raw` overviews. A carrier
records only the entries, fact ids and Knowledge commits actually emitted. Native compaction writes
no Trace Memory carrier.

### Native fallback and omission notices

133 R1 supersedes ticket 73's host policy for pending Raw: if its bounded views cannot all fit
the Raw base plus temporary allowance, Pi compacts natively. The core `trace://compact` view
still truncates with receipts. Neither path runs Noting or Dreaming during compaction, and
pending entries remain in the store. N is unchanged because its frozen batch fits its Raw base.

Native compaction carries no Trace Memory delivery; ordinary Knowledge publication recovers
at the next prompt, as after ticket 130's native compaction. No pending-Raw truncation warning
can accompany a custom carrier, because that carrier is no longer returned. Any other reachable
omission notice is given only after Pi appends the matching custom carrier; cancelled or failed
attempts warn about nothing.

`event.signal` is Pi's compaction abort controller (behind Esc and `session.abortCompaction()`). A
cancelled compaction returns `{cancel: true}`, publishes nothing and starts no native fallback; compact
itself launches no worker, so there is no in-flight recovery task to cancel. An unexpected host-caught
error or omitted pending Raw surfaces as `native delegation — …` in the preparing notice.

Pi reaches this sequence from its automatic compaction points and `/compact`. Preparation notifications
are not completion. Only `session_compact`, after Pi persists the result, updates `lastCompaction` and
reports success. Failed or cancelled attempts leave the last successful boundary unchanged. A native
summary is accepted as lossy and carries no promise that pending Raw or facts survived.

## Visible material carriers (29a)

Two entries put memory material into the conversation, and each states what it supplied in
its own `details`, under `traceMemory`:

| Entry | Written by | Payload |
|---|---|---|
| `custom_message` (`customType: trace-memory`) | the message `before_agent_start` returns, when it carries the initial knowledge block | `{db, session, pi, supplied}` |
| `compaction` | `CompactionResult.details` of a custom replacement | the same shape |

`supplied` is what the renderer actually kept, never what it considered: the selected pending
entries as `{id, nativeId, view: "bounded"}` (30; a carrier written earlier says `tier: 1` or
`tier: 2` instead, and both are read as that same view), the complete
fact ids and the exact knowledge commit ids. `db` is the resolved database path — the same
value `restore` compares its own state entries by — so another database's equal integers
match nothing. `session` is the memory session id, or `null` on an injection written before
the first reply allocated one; such a carrier is recognised afterwards through `pi`, the Pi
session id it was written under.

The receipt and the content are one entry, so nothing else has to be kept in step: a planned
injection Pi never persists, and a cancelled or failed compaction (which appends no entry at
all), change no baseline. A native delegation writes no `traceMemory`; Pi's own compaction
entry has its own `details` (`{readFiles, modifiedFiles}`), so a reader tests for
`details.traceMemory`, never for an empty slot. Nothing of ours is appended around a
compaction — there is no preparation entry, no frozen `considered` set and no database table
mirroring any of this — and the `session_compact` event's entry id is never keyed on: it
resolves by summary text and hands back the first entry with that text.

`hosts/pi/visible.ts` owns the Pi entry types, binding and parser. It derives core's host-neutral
`VisibleView` contract from `buildContextEntries()` without reading the database. Membership comes
only from carrier metadata. New `supplied.knowledgeTokens` is bound to the retained text by
`knowledgeHash`; legacy text is parsed only for cost, with ambiguous content charged in full and
reported on the host's diagnostic stream. Runtime
validation covers complete arrays, safe integer identities, source representation, binding and
legacy generation; any malformed field rejects the entire envelope without donating visibility or
completion. Valid empty injections and legacy tier markers remain readable. Command generations
belong to the originating Pi session even when a Pi session fork legitimately inherits material bound to the
same memory session.

`visibility(sessionManager)` (exported from `hosts/pi/index.ts`) owns one mutable selected-context
view. An unchanged leaf and identity return it without enumerating entries; an append-only parent
chain extends it using only new entries. Navigation, compaction and binding changes rebuild it from
the native selected context. Readers do not mutate this view. Database changes do not invalidate delivery: current applicability is
resolved independently, so an external commit at the same leaf remains observable.

## Manual catchup and stop (18b)

`/trace catchup` operates on the current enabled session's selected branch, not
every closed session. Handler order: require enabled (reject with the enable
instruction otherwise, never silently enrolling); reconcile available native
history (17a); freeze the Raw target as the highest currently-pending source-entry id
(an empty boundary when nothing is pending). Even with no pending Raw, the initial checkpoint
checks C and D's ordinary eligibility. Only a target with no due work completes without a model call. Repeating
`/trace catchup` while one is active reports its current state instead of
starting a second one or extending its snapshot.

Ticket 68 uses one checkpoint at start and after each successful catchup-owned N, C or D completion.
It checks all three phases: N drains the frozen entry boundary even below `noting.triggerTokens`,
while C and D use ordinary eligibility, with D due only on the pending threshold. Batch and context
limits still apply. Several C batches or due D pools can therefore run without another N batch.
Completion requires no frozen Raw left, neither C nor D due, and no owned task still running.
Below-threshold tails remain. Empty/dropped results do not re-arm. A failed catchup step immediately
retries the same phase under the existing boundary, without checking other phases. Ordinary failure
accounting disables memory after three consecutive failures of the same logical task and ends the
drain. Cancellation also ends it. A waiting state need not imply an in-flight task when a due phase could not progress.

N and C can overlap. Successful owned completions remain checkpoints after the final N batch.
Stop/off/shutdown/path changes fence those callbacks. This remains the sole exception to ordinary
no-completion-chaining; entry events do not expand the frozen N boundary.
Core enforces that boundary through `boundary.maxEntryId`. Other exact-membership
forms remain available to a host that re-admits a frozen batch; they do not force a catchup C tail.

The drain reuses ordinary capacity: one N and one C per session, independently
concurrent, and one database-wide D seat. The explicit frozen N drain retains its
existing cancellable wait when its own N slot or claim is occupied. A completion-triggered
C or D check instead behaves exactly like normal extraction: busy means skip that
opportunity, with no retained trigger or release-time retry. A later legitimate
check reevaluates eligibility. There is no extra queue, claim table or polling timer.

`/trace stop` sets the controller's own stop flag (so it schedules no further
batch, whatever the in-flight one returns) and then calls the façade's existing
`cancelTasks()` — the same cancellation 17c's shutdown uses, fencing tokens and
aborting this executor's active model calls and retry waits, both catchup's own
and any ordinary/borrowed work. It does not set the shutdown `stopping` flag, so
future ordinary or explicit admission for this executor remains possible; it
never touches enrollment, configuration or another executor's claim (the
store's per-executor invalidation and token-conditional release already scope
to this executor). It does not touch the foreground agent. With nothing
running or waiting, it is a harmless no-op. A batch already committed before
cancellation wins stays successful and is not replayed; cancellation that wins
leaves that batch's queue entries pending for a later drain.

Disable, executor shutdown/session replacement, and switching away from the
catchup's frozen session or branch all end an active catchup and request the
same cancellation — never retargeting its frozen task to a newly selected
branch, and never resuming the drain automatically on reopen or re-enable. None
of these events launch a flush. The menu's Current-session entry, headless bare
`/trace` and the footer's underlying status text report the drain honestly:
running (with phase and bounded progress), waiting (with the occupied phase),
completed, stopped (with how much of the frozen target was processed) or
failed (with the diagnostic).

## SDK signatures and request auditing

Signatures were read from the installed 0.85.0 package, not inferred from the
older vendored implementation:

| API | Declaration under the installed package |
| --- | --- |
| Hooks, tool execution/schema, command, `appendEntry`, context | `dist/core/extensions/types.d.ts` |
| `ctx.modelRegistry.find(provider, id)` | `dist/core/model-registry.d.ts` |
| Read-only `getSessionId`, `getSessionFile`, `getLeafId`, `getBranch`, `getEntries` | `dist/core/session-manager.d.ts` |
| `createAgentSession`, `SessionManager`, `SettingsManager`, `DefaultResourceLoader` | `dist/index.d.ts` (public SDK) |
| `Context`, `AssistantMessage`, `ProviderRequestOptions.onPayload` | `node_modules/@earendil-works/pi-ai/dist/types.d.ts` |

The registry resolves a configured `provider/model-id`; the adapter itself does not implement a
provider. Noting and Consolidation run in a child `AgentSession`, which executes model tool calls
through run-bound façade tools and continues until the model stops. Consolidator's first valid
`memory` submission commits. The Noter's stop check sends one follow-up message when its files fail the check (144).

`agent.onPayload` snapshots the provider-native body of every round; the last request sent
embeds all earlier rounds and is stored with tool results, output and usage. The child's own
adapter serializes the whole body, including native tool ids and thinking signatures — this
adapter no longer builds provider messages at all. Session model and auth stay frozen for the
whole run (the model is resolved once, at launch). No auth headers are included in the
request-body audit.

The vendored 0.84.4 `types.ts`, extension/SDK/session/compaction docs, and
`custom-compaction.ts`/`handoff.ts` were used for implementation patterns only.
No Pi source was copied. Compaction retention was additionally checked in the
installed `dist/core/session-manager.js` context builder.

## Automated verification

```sh
npm run smoke:pi
npm test -- tests/hosts/pi/index.test.ts
npm test
npm run typecheck
```

The registration test imports the default extension with a stub ExtensionAPI, checks
registration, runs `/trace`, and asserts that it created no session or model
request. The host suite also checks trigger boundaries,
consolidation continuation, incremental raw, compaction, explicit project attribution, the absence of
any receipt on branch return (29d), frozen in-flight ranges, duplicate noting/consolidation calls,
provider failures, and absence of Pi imports in core.

## Manual verification in a real Pi session

Use an isolated database so the observations are easy to inspect. To share a
project, run `/trace project <name>` after the first assistant reply, or start the
sessions in one repository that already has exactly one project; marker files are
ignored. Launch Pi under Node with the extension explicitly selected:

```sh
export TRACE_MEMORY_CONFIG='{"dbPath":"/private/tmp/trace-memory-manual/trace.db"}'
node /opt/homebrew/lib/node_modules/@earendil-works/pi-coding-agent/dist/bundle/cli.js \
  --extension /absolute/path/to/trace-memory/src/hosts/pi/index.ts
```

1. Run `/trace` before speaking (headless it prints status; in the TUI open Current session). Expect no Trace Memory session id. Use `/trace on` if this session predates the first initialization baseline.
2. Send these six prompts separately, waiting for each assistant reply:
   “For this project use pnpm.”; “Do not use npm.”; “Keep code and comments in
   English.”; “Preserve the language of quoted conversation.”; “Please repeat
   those constraints.”; “What constraints are we following?”
3. Read the status again after the replies. Short exchanges below 10,000 compressed-view
   tokens produce no Noting. Continue with substantial conversation material
   until an eligible completion reaches the threshold; inspect the resulting run's
   entry audit and exact progress. The reply after it carries no receipt of that run (29d): read the
   new facts with `read` on `trace://F<id>` if you want to see them. Invalid model output fails the run; inspect the run
   result.
4. Run `/compact`. Expect immediate compaction with `<knowledge>` and `<episodic>`,
   pending compressed Raw views, recent facts, and no compaction model request. The
   notice says the bounded entry views were used. To see truncation, set
   `compaction.rawTokens` and `compaction.temporaryTokens` low enough that the
   pending views no longer fit: the compaction still succeeds with bounded entry
   views, but a second, `warning`-level notice reports the omitted pending entries
   and that they remain pending for Noting.
5. Ask the agent to call `search` for `pnpm`, then `read` on the returned `trace://F<id>`
   and its source `trace://raw/S<n>/T<t>#E<k>`. Expect the original conversation text and
   source addresses. Search and Read calls are recorded as Raw tool calls.
6. Save the actual prompt/reply transcript, `/trace` outputs, observed fact ids,
   compaction content, and `trace://` Read result. Check `runs.request`, `mode`, `model`
   and `response.usage` using the facade. Consolidation is retired; this manual
   exercise does not expect a new C run.

Automated verification uses a fake provider; it does not establish live provider
credentials or replace the manual conversation above.


## Message binding (20a)

This adapter composes no domain text. Core prepares ONE text per frozen task (29b) and this host
only binds it to a native message (user ruling 2026-09-08; `compose.ts` and its test were deleted
with the layout that lived in them): `input.prompt` becomes the child's system prompt and
`input.text` its first user message. What the text contains is decided by core from the frozen
task alone, and the titles, block order and separators inside it are core's, pinned in
`tests/core/render/material.test.ts`.

## The visible view (29a)

`visibility(context.sessionManager)` (29a) is created in `restore` and held for the session; it
memoizes by leaf id, entry count and binding, so a streaming token re-reads the cached view while a
rewind, a new entry, a compaction and the memory-session allocation each invalidate it. It serves the
foreground injection and compaction; admission passes a worker nothing from it (the Noter runs fresh
only, 2026-10-22). The Noter's stop check follows its task's end (144). Historical Consolidation's first valid
submission committed immediately. If a later corrective request after a rejected tool call exceeds
capacity, the normal overflow/refusal path applies.

## The runner (19a/19b, sole runner since 19c)

The runner is real Pi child sessions: every task — ordinary, borrowed closed-session catch-up and
manual catchup — runs in a private fresh child. There is no other runner: a child that cannot be
constructed at all is a run failure with a reason, and the queue stays pending. `native.ts` builds
the child with `SessionManager.create(cwd, runsDir)` — Pi's own new-session constructor, in the
runs directory (24c: `<agent dir>/sessions/trace-memory` by default), with no parent file and
therefore no inherited history — and hands that manager to `createAgentSession`. The foreground
manager is never passed in and never mutated. Its `getSessionFile()` is the run's `nativeLog`.

- **System prompt.** One inline extension, supplied explicitly by the adapter, returns core's domain
  prompt from `before_agent_start`.
- **Tools.** The child registers only the tools core bound for the run (the Noter's `search` and `check`; the
  Dreamer's `search` and `check`), plus restricted native Read and, for the Noter and the Dreamer, Pi's own `write` and `edit`
  confined to the task's workspace files (the Dreamer's verify may also read the session's repositories, never `.env` or key files), with `noTools: "all"` and an explicit `tools` allowlist so nothing else can appear;
  tool EXECUTION is whitelisted to them. Any other call returns an error result and never runs.
  Execution is sequential (`agent.toolExecution` plus a per-tool `executionMode`); Pi's tested default is parallel.
- **Discovery.** Extensions, skills, prompt templates, themes and project context files are
  all disabled in the worker.
- **Task delivery.** The text core prepared is the child's user prompt. The Noter's stop-check follow-up is delivered as a native user message when its files fail the check; ordinary tool rejections remain tool results.
- **Thinking level (26b, extended by 26d).** The child is created with Pi's own `thinkingLevel`
  option. Admission freezes **two** levels with the task, beside its model and its material: the
  foreground level the host reads once there (`pi.getThinkingLevel()`), and the phase's
  level — `notingThinking` when that preference is not `inherit`, the same
  foreground level otherwise. **Every child takes the configured level** — ordinary work, borrowed
  closed-session work and `/trace catchup` alike. The frozen level wins over the per-model
  preference and over the global default, and Pi's own clamp normalizes a level the worker model does
  not support. Borrowed work uses the active executor's levels, never a historical target session's.
  Both values are frozen as values, so a foreground switch or a preference saved while a worker runs
  reaches none of that worker's later rounds. The run record's response carries
  `thinking: { requested, effective }` — the level this run asked for (configured or inherited) and
  the level the child really ran at, side by side, so a clamp is visible instead of silent.

Usage is summed from the child's newly generated assistant messages only. `auto_retry_start`
events are recorded as `retries`, and a failed attempt's usage is included. A cancelled child with
no reported usage records unknown, not zero. The outcome comes from the child's terminal assistant
response, never from `prompt()` resolving; a provider error after a memory tool committed leaves the
commit in place and core records the problem.

Limits: the runs directory is never pruned, and no live provider run was made — every check above
uses stubbed HTTP with the real adapters.

## Three failures turn memory off (32c)

Three terminal business failures of one **logical task** persistently disable its target's memory.
The key is target session, phase and stable oldest selected backlog item: a source entry for Noting,
the first fact in Consolidation order; since 126 the Dreamer's key is its session alone. A new leaf,
a growing tail, another executor or partial Dreamer edits do not reset it. Cancellation is not a
business failure. A failed Dreamer task keeps its hand-off and is retried by the rule above; a Dreamer failure is
never counted toward switching memory off. Ordinary worker
completion starts no next task beyond the Dreamer check after a successful run; later eligible entries supply new opportunities (compaction no
longer runs recovery tasks: 73). Manual catchup alone rechecks all phases after its own successful
completions.

A terminal failure adds one. A Noting run that does not finish
normally, in either task (a lost execution claim included), counts; cancellation, busy admission and audit errors
after business success do not. Duplicate observers and process restarts cannot count an
execution twice. A successful task resets its own streak.

The third failure atomically disables enrollment and fences the target's outstanding claims.
Locally owned work for that target is aborted; committed data and pending work survive. A
borrowed failure disables the target, not its executor or another session. One notification
names the phase, failed runs, latest reason and `/trace on`; the footer becomes `🧠 ○ off`.
Compaction with disabled memory delegates natively rather than publishing an empty custom
summary; user cancellation still takes precedence.

**Only explicit `/trace on` resets all target streaks and re-enables memory.** Reopening and
`/trace catchup` do neither. Status retains the automatic-off cause. This replaces the old
process-local two-incomplete-Noting pause; it adds no retry loop, scheduler or setting.

## Attribution and tree navigation (ticket 07)

`session_before_tree` reconciles persisted source history and immediately returns
`branchSummary(sessionId, branch, headTurnId)`. It launches neither Noting nor
Consolidation, and does not await a worker. Committed lineage facts and evidence-selected
knowledge commits precede the same pending compressed entry views used by Noting.
Entries arriving during a frozen run remain in the summary. Reading it never
calls a provider. Compaction and shutdown also launch nothing;
pending work remains durable; shutdown cancels and fences in-flight runs under one
shared five-second cleanup deadline.

The hook returns `{ summary: { summary: text } }`. Installed Pi **0.85.0**
`dist/core/extensions/types.d.ts:481–510` declares `TreePreparation`,
`SessionBeforeTreeEvent`, and `SessionTreeEvent`; lines **861–874** declare the
result and **917–918** register both hooks. `dist/core/agent-session.js:2520`
accepts the supplied summary only when navigation requested summarization
(`options.summarize`). The public result cannot force insertion for a user's
no-summary navigation. The host returns its summary in either case and never
calls Pi's summarizer itself. The hook's abort signal does not cancel a frozen
noting. Existing `session_tree` restoration gives an earlier branch point a fresh
identity and preserves the identity when returning to a saved branch tip.

Project attribution uses an explicit declaration or conservative directory inference. A new session
records its repository root — the parent of Git's common directory, so worktrees agree — or the real
path of its current directory. It joins that directory's already-recorded project only when exactly
one project is represented. No match or several matches keeps the session's private project; home and
temporary directories never key, and pre-62 sessions contribute no directory evidence. Marker files
and Git remotes are ignored. An explicit `/trace project <name>` always wins, persists in Pi custom
state and returns refreshed Knowledge immediately.

A declaration relabels the affected sessions and their project-owned Knowledge while preserving
scope, revisions and pool processing records. Facts follow their owning session's project. Global and
session pools are unchanged. A reached Noting or Dreamer trigger, knowledge overflow included, refuses
the declaration, as do the active-Dreamer guards described above. Duplicate Knowledge is left for ordinary Dreamer maintenance;
the declaration itself neither consolidates nor deletes it.

An empty text content block is not an assistant reply. Nonempty text, thinking,
or a tool call permits allocation; the tool-call case permits `note` or `memory` as the
first assistant action. A prompt, compaction or tree event without such a reply
creates neither a session row nor a turn row. Project records may precede replies.

The host tests cover conservative directory inference, worktree identity, ignored home/temp paths,
ambiguous project membership, explicit same-name sharing, persisted assignments, relabel guards,
immediate injection, session-Knowledge isolation, deferred Noting, sibling exclusion and empty or
tool-only replies.

## Retries

Retrying is Pi's, not this adapter's (19c gate 6). The child `AgentSession` retries with the
policy its `SettingsManager` reports from `settings.json` (`retry.enabled`, `maxRetries`,
`baseDelayMs`, and `retry.provider`), the same policy Pi applies to a foreground turn.
Transient errors (429, 5xx, overloaded, timeouts, fetch failures) back off exponentially;
other errors fail at once. A retry re-runs the assistant turn only: tool execution and commits
happen after a reply, so a retried call never repeats a write. The adapter subscribes to Pi's
`auto_retry_start`/`auto_retry_end`, records the attempts in the run record and posts one
notice per scheduled attempt; the footer indicator does not change while one waits (51).

## Run records

Every Noting and manual write leaves a row in `runs`; historical Consolidation runs remain. Runs record the
exact last provider request, the final output, summed usage, the tool-call
sequence, fetches and problems. The response envelope also carries
`thinking: { requested, effective }`, the level frozen at admission and the level
Pi's clamp left the child at (26b). The menu's Current session > Runs lists the
session's last n runs with a count input (`/trace runs [n]` was retired in 24b).

## Footer status item

Background workers are separate Pi sessions and therefore do not enter the foreground session's own
usage totals. The host publishes one status item through `ctx.ui.setStatus("trace-memory", …)`:

```text
🧠 <indicator> notes: 24->102 memory: 9->54/306 cost: $0.12
```

| Field | Meaning |
|---|---|
| `notes: 24->102` | 24 imported source entries still await Noting; 102 facts are applicable on this path |
| `memory: 9->54/306` | 9 applicable facts await Consolidation; 54 of the 306 live Knowledge items were created or changed by the Noter since the last covered Dreamer pass |
| `cost` | Database-wide memory-run spend since local midnight, using recorded model usage and Pi's configured rates |

`changedKnowledge` counts the live Knowledge items the Noter created or changed since the last covered Dreamer pass (items, not tokens).
It is a scheduling measurement only, not a validity status and not a second visible partition. The Dreaming bar
in Current session shows the same changes in tokens, which is what the trigger compares.

A disabled session shows `🧠 ○ off`. Before allocation or when a read fails, counts are `?`, never an
invented zero. Counts describe imported evidence only: enabling imports available native history and
then refreshes them. An admitted task remains pending until its business commit; provider failure after
a commit does not restore the old queue. Below-threshold work is idle, not failed.

The indicator uses Pi theme roles: Noting `accent`, Consolidation `success`, Dreaming
`customMessageLabel`, in that precedence when phases overlap; idle and off use `dim`. It describes this
executor, including N/C work borrowed for another target. The counts remain this foreground session's.
Warnings, retries and failures are reported separately and do not recolor the indicator.

Progress is one core query over one selected-path snapshot. It renders no Raw or Knowledge, tokenizes
nothing, freezes no task and loads no run audit body. Spend is projected from stored usage. There is no
timer: lifecycle, commit, control and status events refresh the line, so another connection's changes
appear at the next refresh. `/trace` shows the current session's cumulative spend and phase breakdown.

## Fact presentation

All newly composed fact material uses the same chronological Turn groups: Noter history,
Consolidator current facts, compaction and branch carry. A heading such as `[T42] 2026-09-09T10:30:00Z (selected facts)` is followed by facts in
ascending F-id order. Multi-Turn citations remain intact on a single fact under its owning Turn.

Grouping happens after priority selection: recent historical facts still get the available space
first, while pending Consolidation facts retain oldest-F-id-first selection and exact progress.
A batch may contain only part of a Turn. The group headings count toward the existing budgets and
the grouped pending-fact view is also what the Consolidation trigger measures. Explicit single-fact
reads and search listings are unchanged. See [Fact groups](core.md#fact-groups) for the core contract.

## Known limits

- No heartbeat or process-liveness discovery exists. A crash does not mark a session
  closed; that conversation waits until resumed. Claim expiry only recovers ownership.
- Catch-up needs later eligible entries in another enabled runtime. There is no
  timer, completion chaining or continuous drain. A lease that expires during a
  long provider request fences its eventual commit; there is no renewal timer.
- Cancellation requests cannot guarantee that a remote provider stops billing.
  Available usage is retained; missing cancelled usage is unknown, never free.

- A queued (steering or follow-up) user message bypasses `before_agent_start`. Since 29d there is
  nothing for it to miss: no result is delivered at any prompt, and what a prompt did supply is
  stated on the entry Pi persisted for it rather than on a settle-time confirmation.
- Pi's `--fork` and clone continue the same Trace Memory session on a new branch;
  redeclaring the project there changes the shared session's project.
- Nothing prunes `runsDir`, and since 24c its default sits inside Pi's own
  sessions tree, so worker conversations are listed by Pi's all-session browser.

## Entry views and Noting progress (17a, rule replaced in 23)

One renderer renders every source entry (ticket 23), in Pi's own compaction line
shape with our addresses as the labels (23c, copied from `core/compaction/utils.js`).
An entry is a list of parts: at most one natural-text part, `[T<n>#user]: <text>` or
`[T<n>#assistant]: <text>`, and one part per tool call. A tool-call part is one line,
`[T<n>#t<k>] <tool>(<key>=<JSON>, <key>=<JSON>)`, the arguments in stored key order,
each value whole if it fits its fair share of the part's budget and otherwise cut head
and tail with the marker between the two halves; a payload that is not a JSON object
renders as `<tool>(<raw>)`. A tool-result part is `[T<n>#t<k>] <tool> <status>: <text>`,
the host's result text following the colon and continuing on the following lines, cut
head and tail, with structured data the host dropped marked as
`[... N characters of details truncated]` and non-text content marked by its type. A
result with no text at all shows the head of that structured data instead of a blank.
No call id and no native-identity header enters the model-facing text: the addresses the
labels carry are what the Noter cites, and native identity, lineage and the view budgets
stay in storage and in the run's entry audit.

The profile is three independently named budgets (ticket 30): `render.entryTokens` (`E`)
defaults to **2,000**, `render.toolInputTokens` (`C`, the whole rendered call part) to
**100** and `render.toolResultTokens` (`R`, the whole rendered result part) to **100**, the
two part budgets with a hard ceiling of **1,000**, rejected above it. An explicitly
configured value is honoured as written. All three are positive safe integers
through the existing flat configuration, are configuration rather than per-batch
decisions, and count the rendered text of the part or the entry — label lines, key
names, separators and every marker included. `C` and `R` are independent allowances,
superseding 23c's single `B` split in half: room a short call leaves does not enlarge a
result, or the other way round. Allocation is staged:
each tool part is capped by its own budget first; if the entry is still over `E`, result
payloads give way, then call arguments, each shared fairly down to their label-plus-marker
minimum, and only when they are all at the minimum does the text part yield, head and tail.
A rendered part never exceeds its allocation, the entry never exceeds `E`, and no part is
emitted empty or shorter than its minimum. Excerpts retain head and tail, including within
one huge line or JSON value, and never cut inside a surrogate pair or a JSON escape
sequence. One marker family states the count of omitted characters —
`[... N characters truncated]`, and `[... N characters of details truncated]` for
dropped structured data — and the honesty clause "the omitted middle was not inspected"
is stated once in the Noter prompt instead of in every marker. `trace` with `full: true`
uses the same renderer without content compression: the same labels, the stored
arguments and result text uncut, each native occurrence of a call as its own entry,
and its read scope unrestricted whatever branch the reader is bound to (17a).
The outer trace paginator still applies the default 2,000 estimated-token budget
and line cap, preserving the complete text through lossless cursor continuation. A budget too
small for an entry's labels and markers reports a capacity error and leaves the
entry pending (compaction delegates to the host's own over it).

The host registers one result-text extractor with the façade at construction; core
applies it wherever it renders an entry and never inspects envelope fields itself.
The Pi extractor joins the text blocks of the stored `{content, details}` result,
marks every other block by its type, and reports `details` as dropped structured
data with its serialized size. Evidence is unchanged: the raw message and the raw
result are stored exactly as before, and `trace` with `full: true` renders them
uncut. Edit diffs live only in `details`, so they leave the Noter view with a
marker in their place.

The same entry bytes supply Noting, compaction
Raw, branch-carry Raw and the explicit `trace` of a Turn without `full` (23b),
which assembles that Turn's selected entries in path order and seals every call
`tool` did not select at its label line and omission marker. Existing episodic budgets count these compressed bytes
when deciding which whole facts fit. A Noting batch whose views, framing and cues cannot
fit the episodic budget or the model's reported capacity is reduced oldest-first and
re-frozen, or left pending with a capacity error (review 2026-09-08); compact is the one
consumer that escalates to lossier views instead. The shared estimator is unchanged. Native request capacity is checked before each Noting and
Consolidation provider call, including continuations, without rewriting the prefix; both
phases receive the model's capacity before selection (review 2026-09-08).

**Request capacity (ticket 27a; parent 27 "Decision" and amendment 9).** Both memory-worker guards —
phase admission and the last check before a request leaves — decide by one rule:

```text
context measure + 10,000 <= context window
```

The 10,000 tokens are fixed headroom, not an output reserve, not a promised output size and not a
setting; `CONTEXT_HEADROOM` in `src/hosts/pi/index.ts` is the only place it is written. The 85%
window multiplier and the subtraction of `model.maxTokens` are gone from both guards, and no
accounting of ours reads a provider request body for tokens any more. A window that cannot exceed the headroom, and an
invalid one, fail with a diagnostic before anything is sent.

The measure is Pi's, taken where Pi takes it:

- **Admission** hands core `contextWindow - 10,000` as its input allowance.
- **A subagent** is priced by the existing core material accounting alone — instructions, tool
  definitions and the frozen material — because a fresh child inherits no context to measure.
- **Every round the child sends** is checked in `hosts/pi/native.ts` on the child session's own
  `getContextUsage()` — Pi's getter, which runs pi-ai's `estimateContextTokens` over the child's
  messages: its latest real assistant usage once it has one, plus an estimate of what follows it. For
  The guard is handed that number and nothing else, so it reads no provider shape at all and a child on any API
  the SDK can call keeps running.

  Pi's getter is used rather than importing `estimateContextTokens` directly because a subpath import
  of `@earendil-works/pi-ai` does not resolve inside an installed Pi extension — the loader maps the
  package to its compat entry, and `npm run smoke:package` fails on it. The one cost is that a child
  with no assistant usage yet, which is the first round of a fresh subagent, is measured on its
  messages alone, without the system prompt and tool definitions that admission has already priced
  against the same allowance. `tokens: null` is Pi's unknown — a compaction inside the child with no
  valid reply after it — and refuses nothing: unknown is not zero, and it is not an overflow either.

Generation limits, `noting.batchTokens`, `consolidation.batchTokens`, `render.episodicBlockTokens`,
the database-derived Knowledge capacity and foreground compaction are unchanged by this rule.

Noting freezes entry identities on the selected path, not whole Turns. A
successful zero-fact run — both files holding `## none` and both tasks passed — processes only its selected entries; later entries in that
same Turn remain pending. A run whose files fail the check twice, or whose second task fails, publishes nothing and processes no entries. Address aliases are interpreted against the frozen
entry set. A later matching source occurrence makes that address ineligible for
the earlier writer, even if an explicit `trace://raw` read can display it. Run records
include `entryAudit`: native identities, owning Turns, frozen branch, view-budget
version and values, and the exact omission markers. Entry processing, facts, run
audit commit atomically. Rejected or failed work remains
pending.

The derived `getWatermark`/`listWatermarks` readers and the status watermark line
are removed in 17b, along with the already-removed writable watermark table.
Noting and Consolidation retain their exact per-entry/per-fact progress. Source-path
membership is native ancestry, not a delivery queue. Attach reconciliation performs
no model call; missing history is reported and retained originals remain readable.
`noting.triggerAnsweredTurns`, the removed `consolidation.triggerUnconsolidatedFacts` and every
unknown setting are rejected explicitly.
`noting.triggerTokens`, `noting.batchTokens`, `consolidation.triggerTokens`,
`consolidation.batchTokens`, `compaction.factsTokens`, `compaction.rawTokens` and both view limits
accept only positive safe integers.
