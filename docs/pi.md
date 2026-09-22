# Pi host reference

The current [entry-address and budget contract](unified-entry.md) supersedes older ticket descriptions below of Raw labels, source previews, thinking-only entry storage and full-read scope. Pi normalizes its native ordered blocks once; rendering and exact citations share that authority. Thinking is stored for explicit reads but excluded from automatic Raw text. E ordinals are persisted, never recalculated from the selected branch.

`index.ts` is a Pi extension: its default export takes `ExtensionAPI`. It opens
one facade for the global database and uses only `src/core/api/index.ts`, including
its exposed store. Both Noting and Consolidation use subagents by default and may be configured
to use verified fork mode. Dreamer is always a fresh subagent. Each reconciled eligible entry
completion checks all three phase queues. Shutdown and tree navigation launch no phase;
compaction uses bounded, threshold-gated Noting/Consolidation/Dreamer recovery (32f).

**One runner (19c).** Every memory task runs inside a real Pi child `AgentSession`
(`native.ts`): fork mode in a child forked from the parent session file at its persisted
leaf, every fresh-context task in a private child session. Pi owns the model call, the tool
loop, the retry policy, cancellation and persistence; this adapter keeps the byte-level gate
on a fork's first request and the run record. The request-copy runner — its own conversation
loop, its provider-message construction and its handwritten retry-settings reader — was
deleted in 19c; there is no second runtime and no fallback to one.

Run the extension with Pi 0.85.1 on Node 24.6.0. The core uses Node's built-in
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
overflow would never reach the fallback below. The override is in memory only: it writes no file,
and the foreground agent — with Pi's compaction hooks and the user's own settings — is untouched.
The plugin never writes settings.
For example, either settings file can contain:

```json
{
  "trace-memory": {
    "noting.forkModeDefault": false,
    "consolidation.forkModeDefault": false,
    "noting.triggerTokens": 10000,
    "noting.batchTokens": 10000,
    "noting.nearThreshold": 0.4,
    "consolidation.triggerTokens": 5000,
    "dreaming.triggerTokens": 5000,
    "dreaming.maxToolRounds": 0,
    "dreaming.timeoutMs": 600000,
    "dreaming.model": "session",
    "dreaming.thinking": "inherit",
    "consolidation.batchTokens": 10000,
    "compaction.factsTokens": 10000,
    "compaction.rawTokens": 10000
  }
}
```

`compaction.factsTokens` and `compaction.rawTokens` are the two file-configured 10,000-token
material bases. The Knowledge base is database-owned: Settings edits Global, Project and Session
pool budgets for the bound database, defaulting to 4,000, 15,000 and 1,000. Their safe-integer sum
is the 20,000-token Knowledge base. The shared allowance across Knowledge, facts and Raw is derived
from the configured N, C and D triggers, counted once each: 20,000 at defaults. Pool budgets do not
enter this derivation. It has no separate setting or database migration. Required pending Raw, unconsolidated facts
and Knowledge state notices reserve shared excess first; optional Knowledge, historical Raw and historical facts then use the remainder in that order.
The three bases never lend directly to one another.

`render.knowledgeBlockTokens` and `consolidation.knowledgeTokens` are retired. Remove those two keys
from every settings file and `TRACE_MEMORY_CONFIG`; finding a removed key is a named load error.
`dreaming.triggerTokens` is configurable again: its default cap is 5,000, and each pool's effective
pending trigger is `min(cap, pool budget)` (4,000/5,000/1,000 by default). Consolidator Knowledge and foreground publication may use the Knowledge base plus
the shared allowance. Dreamer uses that same maximum for its Changed-plus-reference input, while a
single due pool's Changed range is capped by that pool's budget. Database budget edits accept exact
decimal nonnegative safe integers, commit transactionally, write no Pi settings file and affect all
connections to that database. Budgets are maintenance triggers, not write gates: an over-budget pool
is reported and scheduled rather than rejecting a Knowledge write. Running Dreamer and Consolidator
requests keep their frozen admitted capacities; later admissions use the current policy. Actual
provider context capacity remains an independent hard gate.

Environment override example:

```sh
export TRACE_MEMORY_CONFIG='{"dbPath":"~/.trace-memory/trace.db","noting.triggerTokens":10000,"noting.batchTokens":10000,"consolidation.triggerTokens":5000,"consolidation.batchTokens":10000,"noting.maxToolRounds":0,"consolidation.maxToolRounds":0}'
```

- `dbPath` defaults to `~/.trace-memory/trace.db`; its parent is created on load.
- `dreaming.model` and `dreaming.thinking` use the same model/thinking Settings selectors,
  defaults and precedence as the other phases. Dreamer has no fork option or new settings page.
  `dreaming.maxToolRounds` is fixed at 0 (unlimited). The shared `dreaming.timeoutMs` default is
  600,000 milliseconds; this adds a wall-clock bound to Pi. Expiry fails the run, fences writes and
  releases its claim. Provider retries do not reset the deadline. Budget checks no longer trigger a host-generated repair pass; the model may correct rejected
  tool calls within the same bounded run.
- `notingModel` and `consolidationModel` accept `provider/model-id`, or `session`. Omission
  and `session` both resolve to the current session model's audited provider/id.
- `notingThinking` and `consolidationThinking` (26d) accept `inherit` (the default) or one of Pi's
  own levels `off`, `minimal`, `low`, `medium`, `high`, `xhigh`, `max`; anything else is rejected at
  load by name with that list. They set the level this phase's **subagent** runs think at; `inherit`
  and omission both mean the foreground level frozen at admission (26b). A fork run keeps inheriting
  either way, so on a forking Noter the value reaches only the fallback child.
- Core settings use dotted names: every `render.*`, `noting.*`, `consolidation.*`, and `dreaming.*` key
  in `DEFAULT_CONFIG` is accepted with the core's default and value type.
- `noting.forkModeDefault` defaults to `false` (subagent). Set it to `true` for fork
  notings. Defaults apply only when no explicit override is supplied; existing `true` settings,
  including the accepted legacy `noting.branchModeDefault` alias, keep selecting fork. A noting that really runs as a fork uses the session model, because that is the context it
  inherits. **27c: every other noting uses `notingModel`** — explicit subagent mode, and a requested
  fork that does not run as one for any reason at all, which is admitted as a subagent on that model
  and priced by that model's own capacity (see "Per-task fork fallback" below).
- `consolidation.forkModeDefault` (**29e**, superseding 25b) is the same option for the other phase,
  and defaults to **`false`**: the choice is restored, the existing default is not switched. Set it
  to `true` to consolidate in a fork of the foreground. Everything the Noter's mode implies applies
  unchanged — the session model for a fork, `consolidationModel` for every other consolidation, the
  same capacity rule, the same one re-admission, the same audit. The one phase difference is
  evidence: 29c's Raw-availability rule is the Noter's alone, because the Consolidator processes
  facts and its material carries the complete body of every selected fact the child cannot see (29b).
- `nativeRunner` (19a) is **gone** (19c). The native runner is the only runner, so the key
  selects nothing; like any other unrecognized key it is rejected at load with
  `Unknown setting nativeRunner`, which is 18a's rule for configuration that does not exist.
  When a fork cannot be prepared, or its first body fails prefix verification before anything
  is sent, the task is admitted once more as a subagent (27c) and that run records `fallbackReason`
  (`native runner: …`) together with the rejected gate result under `verification.native`. If
  the second admission cannot fit the batch either, its own refusal is what is reported and the
  queue stays pending for the next permitted trigger.
- `runsDir` (19a) **defaults to `<resolved Pi agent directory>/sessions/trace-memory` (24c)** —
  ordinarily `~/.pi/agent/sessions/trace-memory/`, or under `PI_CODING_AGENT_DIR` when that is set.
  A new fork or subagent log is a *direct* child of it, named with Pi's own
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
- **Consolidation runs as a subagent unless `consolidation.forkModeDefault` is set** (ticket 29e,
  superseding 25 amendment 2). The ordinary slot follows that preference; borrowed closed-session
  work, manual catchup and compaction recovery stay fresh-context. The first valid `memory`
  submission commits immediately. `consolidation.subagentModeDefault`
  — the retired *inverse* key — stays **removed**. Tree navigation launches no extraction.

The peer dependency supplies Pi SDK types. Verification uses the installed
`@earendil-works/pi-coding-agent` 0.85.1. Tests use Vitest on Node; the standalone
smoke uses Node's built-in TypeScript support and does not load Vitest.

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
  attribution; the next ordinary prompt runs the same predicate. Worker `note`/`memory` tool receipts,
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
  consume the Knowledge base plus derived allowance, 40,000 tokens at the default policy. Missing state
  transitions fit as a deterministic whole-item prefix before complete new bodies; only selected
  transition receipts persist. Knowledge keeps category groups and chronological display inside each
  group. The common header says larger commit numbers are newer and a newer same-object item stands
  until maintenance merges it. Capacity selection omits the oldest optional items first, preserving
  newer ones. An unfit next mandatory transition is not skipped, and exact fit is accepted.

  Immediately before returning a publication, the host revalidates enrollment, Pi/native binding,
  selected leaf, path head/branch and project attribution. Any retarget or disable discards the stale
  offer; a later prompt recomputes. Persistence, not an offered hook return, establishes visibility.
  Reopen, rewind and sibling navigation therefore derive solely from the selected native ancestry.

  A fork Noting appends control material only (25a): the range, the head turn's
  final reply and the source-address index. It adds no knowledge block, no
  historical-fact block, no fact index and no Raw view — the foreground it inherits
  already carries the injected knowledge (29d: not the facts of earlier runs, which are no longer
  delivered to it; a fork that needs one reads it by address). A
  fork that falls back to a subagent sends the complete subagent material — history
  within 10,000 tokens and bounded Raw within 10,000, independently capped — and is
  priced on it.
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
  are retained. `trace` with `full: true` retrieves the original tool argument and
  result strings, whatever the envelope carries. An explicit `trace` without `full`
  is assembled from that Turn's selected source entries under the configured entry view
  (ticket 23b), so a branch's own occurrences are what a bound read shows; pagination
  retains its existing protocol.
- Every eligible persisted entry completion checks the active branch's queues at
  reconciliation; the unchanged native leaf-id guard keeps streaming updates O(1).
  `noting.triggerTokens` defaults to **10,000 compressed-view tokens** measured
  with `renderEntry` over `pendingEntries`, including separators. Original Raw size,
  entry count and answered Turns do not trigger runs. Excluded sources contribute nothing.
  `noting.nearThreshold` defaults to **0.40** and accepts a finite number in [0,1]. It controls
  the Noter's pre-commit same-session/path lexical review and is not one of the façade's dynamically
  replaced keys. Consolidation has no lexical threshold.
- `noting.batchTokens` defaults to **10,000** (ticket 20; it was 50,000 through 17b): the oldest
  contiguous whole-entry prefix, without Turn boundaries. An entry is never skipped so that smaller
  later entries can fill the remaining space, and a partly filled batch is valid. Excess waits for
  another eligible completion.
  It bounds this phase only: since 28a compact measures its pending views against its own Raw window
  (`compaction.rawTokens`) inside the three-window envelope, so changing this key — or
  `render.episodicBlockTokens`, which stayed the Noter's — does not change what compaction keeps.
  The effective batch also reserves instructions, knowledge, tools and the existing
  context: since 27a the host reports `contextWindow - 10,000` as the input allowance
  (see "Request capacity" below). An oldest entry that cannot fit remains
  pending with a capacity notification — unless it was a *fork* that could not fit, which 27b
  re-admits once as a subagent instead. Unknown model capacity still leaves work pending.
  Native fork context is additional to the new-material budget and is never compressed.
- Dreaming is checked **per pool** on every reconciled eligible entry: `global`, this session's
  project and this session. Pending is each pool's current visible, non-archived revision lacking a
  `(pool, revision)` processing record, one revision per identity at its full rendered size. A pool is
  due at `min(dreaming.triggerTokens, pool budget)` (4,000/5,000/1,000 by default), or when over budget and re-armed. One run handles one due pool; its Changed range is capped at that pool's full budget,
  4,000 / 15,000 / 1,000 by default. Changed material and current same-scope references share the
  40,000-token Knowledge-base-plus-derived-allowance window; direct facts have a separate 10,000-token cap.
  There is no automatic Raw block or `note` tool.

  Dreamer may update, binary-merge, binary-split or archive, but never create. Evidence-driven
  operations cite their direct facts. A trusted maintenance operation may submit empty supports;
  core then materializes the exact parent supports: one parent for update/archive/split and both
  parents' union for merge. Exact current bases and the live database-wide Dreamer claim are checked
  atomically. Processing records skipped frozen versions and the run's own commits, including on
  failure or cancellation. Untouched versions remain pending; own outputs do not trigger themselves.
  An over-budget pool stays due while pending remains. With no pending material, unchanged recorded
  size and budget suppress repeat maintenance. A run's range ends once; remaining material may form
  a later range.
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
  reconciles it. Manual `memory` writes allow fact-backed `create` and `archive` only.
- `consolidation.triggerUnconsolidatedFacts` is **removed** (ticket 20). Any layer that still supplies
  it fails the load with `Removed setting consolidation.triggerUnconsolidatedFacts: use
  consolidation.triggerTokens (tokens, not a count)`; an old fact count is never reinterpreted as a
  token budget. The menu never offers it: the menu edits mode/model preferences and closed-session scope only,
  and the advanced keys live in the settings files.
- `consolidation.knowledgeTokens` is **removed** (ticket 45). Consolidator Knowledge uses the bound
  database's Knowledge base plus shared allowance, frozen at task admission. Any configuration layer
  that supplies the old key fails by name and directs the user to the three database Knowledge budgets
  in Settings; the value is never reinterpreted or ignored.
- `consolidation.subagentModeDefault` is **removed** (ticket 25 amendment 2; still removed under 29e,
  which restored the choice under `consolidation.forkModeDefault`). It stays a removed setting rather
  than becoming an alias because it is the **inverse** boolean: reading a saved `true` as fork mode
  would silently switch the meaning of the value. A saved value of either polarity fails the load with
  `Removed setting consolidation.subagentModeDefault: use consolidation.forkModeDefault (the inverse
  boolean: true means fork)`. Nothing is normalized behind the setting and no settings file is
  rewritten. Runs recorded in fork mode before 25b keep that mode and read back as themselves in Runs
  and `trace R<n>`.
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
- Main-agent registration and subagent requests use the exact same four definition
  objects, with façade descriptions and schema objects. Pi execution fields are
  non-enumerable, so provider serialization includes only shared metadata. The read
  forms are `trace({address, versions?, category?, scope?, fields?,
  itemBudget?, toolCallBudget?, toolResultBudget?, pageBudget?, tool?, full?,
  cursor?, cap?})` and `search({query, layer?, versions?, category?, scope?,
  fields?, itemBudget?, maxTokens?, cursor?, cap?})`.

  `scope` alone controls material selection; obsolete `where` is rejected. Omitted
  search scope selects project facts/Raw and applicable global/project/session
  knowledge. Session/project/global selects that scope's knowledge and respectively
  session/project/all-session facts and Raw. Global knowledge is shared regardless
  of author project. Only category implies the knowledge layer; scope does not.
  Explicit project/session scope requires context; unbound omission discovers all owners.

  `versions` selects current/history/all candidates within each K. Every search or
  project collection returns one representative per K, chosen before pagination.
  Literal admission is unchanged; lexical text/topic similarity chooses only among
  matching revisions of the same K. Ties prefer current, then newer commit; empty
  queries and collections use that tie order without scoring. K-ID ordering remains.
  Explicit K history/all or K.. expands the named identity's history. Exact evidence
  and comma-list order/repeats remain unrestricted.

  Named session trace remains only that session's Raw under every scope. Named
  projects retain their own facts; scope narrows only their global/project knowledge
  and never widens those facts. Project plus session scope rejects rather than
  borrowing the caller's session. Collection receipts describe the actual selection.
  Collections grant no handles, and omitted alternative versions or history reference
  lines never prove a full-body read. Current search defaults to text-only one-line fact and knowledge
  previews; knowledge history/all defaults to text plus the existing computed status.
  Explicit fields, including text-only or none, remain authoritative. The item budget
  defaults to 80 tokens; embedded line breaks render as ` ⏎ ` and long bodies keep a
  head plus the inline character-truncation marker. Raw search
  hits keep their entry profile. Search returns no knowledge write handle. Trace
  defaults to full semantic fields except reason for current/exact reads; explicit K
  history/all and `K1..` also default to commit reasons. Explicit fields remain authoritative.

  One trace address may carry a comma list (`F81,F90,F95`, preserving order and
  repeats) and inclusive fact-id intervals (`F81-F90`, combinable as
  `F81-F90,F95`). Both tools default to 2,000 estimated tokens per response, and
  public `maxTokens`/`pageBudget` values are capped at 8,000; `cap` separately
  counts output lines. Every search receipt names the effective filters and preview
  fields and the one-representative/history route. Cursors freeze exact representatives,
  owner selection, statuses, effective filters, fields, content budgets, page-budget aliases, and
  line cap; omitted or equivalent repeated values continue, while a
  changed value rejects without consuming the cursor. Oversized transport content
  continues in lossless Unicode-safe fragments, but a fragment is not a complete
  hit. Follow receipts: continue search with an empty query and trace with its cursor.
  See [the core search contract](core.md) for budget rejection and joining rules.
  `note({facts})` writes facts and `memory({operations, skipped})` writes Knowledge within the
  caller's authority. Every operation carries `supports` and a `reason`; create/update/merge also
  carry the revision's complete `topics` set. Consolidator permits only create; manual calls permit
  fact-backed create/archive; Dreamer alone may update, merge, split or submit support-inheriting
  maintenance operations. Main-agent executions call `tools(context)` with kind `manual` and
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

A project declaration preserves existing Noting and Consolidation due/live-claim guards. Dreaming
being due or an inactive range being open does not block it. It waits only when the active Dreamer's
session belongs to an affected project or its frozen range touches an affected project pool. This
prevents the relabel from invalidating later commits or consuming the wrong pool. Relabel creates no
Knowledge revision and clears no processing record; a moved project revision is pending in the
destination only when that pool has not handled that exact revision.

Normal shutdown stops admission and cancels this executor's model calls under one five-second
cleanup deadline. Cancellation closes Knowledge tools immediately, but an exact Dreaming claim is
retained through terminal processing. Processing covers only skipped frozen versions and own
revisions, including on cancellation; untouched items remain pending.
`/trace off` uses the same terminal exception: disabling future work cannot block this bookkeeping.
Token, expiry, takeover, target project and frozen-range checks remain mandatory. After terminal
processing or a pre-commit cancellation, the claim is released conditionally.

A business commit that wins before cancellation survives; no committed batch is replayed to obtain
a final response. Normal shutdown then marks only the executor's own session closed and closes
SQLite. Restore clears that closed state and reserves new claim tokens for the executor; it launches
no phase. A direct synchronous facade close is a hard close rather than this graceful host sequence
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
through the same identity-based importer as ordinary entries. It makes no provider
call and does not synthesize a completion. The next eligible completion checks
normal queue thresholds. Repeating enable does not duplicate imported sources.

Disabled sessions ingest nothing, inject nothing and start no new worker. Manual `note` and
`memory` reject with `/trace on`; `trace`, `search` and status remain available even before
allocation. Compaction and tree hooks return no plugin override so Pi proceeds with native context
handling. Stored Raw, facts, Knowledge, runs and scopes stay intact; other sessions still see shared
Knowledge. Already-injected text remains in context.

Disabling cancels this executor's active model calls and closes their tools. Ordinary late business
writes are fenced. A Dreamer that already committed retains its exact claim only long enough to
perform terminal processing, then releases it; disabling enrollment does not suppress that
transaction. Another executor still must pass the ordinary target and claim checks.

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
  `Project` with a name input, and `Retry fork` only while this session is automatically downgraded.
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
- **Dreaming:** rendered pending current revisions of the selected applicable pool. Each pool has its
  own pending measurement against `min(dreaming.triggerTokens, pool budget)`; the panel shows one representative
  pool, not a sum of all pools. The bar
  does not imply that the database-wide seat or an executable range is available.

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

Noter and Consolidator each expose mode, model and thinking preferences on one select-and-write
path; both default to subagent mode. Dreamer is always a fresh subagent and therefore exposes only
model and thinking. A model or thinking line discloses an inherited foreground value exactly when
Noter or Consolidator is configured for fork.

| Preference | Choices | Key | Default |
|---|---|---|---|
| Noter mode | fork / subagent | `noting.forkModeDefault` | subagent |
| Noter model | Follow foreground / an available `provider/model-id` | `notingModel` | `session` |
| Noter thinking | inherit / `off` / `minimal` / `low` / `medium` / `high` / `xhigh` / `max` | `notingThinking` | `inherit` |
| Consolidator mode | fork / subagent | `consolidation.forkModeDefault` | subagent |
| Consolidator model | Follow foreground / an available `provider/model-id` | `consolidationModel` | `session` |
| Consolidator thinking | inherit / one of Pi's levels | `consolidationThinking` | `inherit` |
| Dreamer model | Follow foreground / an available `provider/model-id` | `dreaming.model` | `session` |
| Dreamer thinking | inherit / one of Pi's levels | `dreaming.thinking` | `inherit` |
| Closed-session scope | off / project / global | `closedSessionScope` | `project` |

**The three thinking entries (26d/32d)** choose the level this phase's *subagent* runs think at;
`inherit` is 26b's rule, the foreground level frozen at admission. A fork keeps inheriting the
foreground level whatever is configured, so the Noter's line and its selection dialog disclose that
while Noting or Consolidation is in fork mode the value reaches only a fallback child. Dreamer
is always a subagent, so its configured level always applies. A saved level reaches tasks admitted afterwards; a running
task keeps the level it was frozen with, and Pi's own clamp still normalizes a level the worker
model cannot do (visible as `thinking: { requested, effective }` in the run record).

Each line shows the effective value, its `Default`/`Global`/`Project`/`Environment`
source and every masked layer, exactly as the old read-only view did for these keys;
the dialog's header names the settings file a save writes to and where new worker logs
go. Removing the display of the advanced keys did **not** remove them: every file and
environment value is still loaded, still validated by name, and still documented above.

Models come from Pi's own registry (`getAvailable`, the auth-resolved snapshot, plus
the foreground model). Nothing asks for a credential and nothing calls a model to
validate a selection; a chosen identity is checked with `find(provider, id)`. In fork
mode the model line discloses that the child inherits the foreground model, and the
selection dialog says the choice applies to subagent runs — a saved subagent model is
preserved across mode switches, and selecting a model never switches the mode.

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
them, the host's model selection follows them, and core's two `forkModeDefault` booleans and
`closedSessionScope` are replaced through the façade's `configure` (29e); every other core key is
refused there. A task already running keeps its admission scope, mode, model,
evidence and budgets. Setting scope to `off` does not cancel it; use Stop to end
running work. Another Pi process sees the new
global default through its own settings load; there is no cross-process watcher.
Editing a preference starts no worker and does not touch the cache-miss latch. The same Settings
screen separately edits the bound database's Global, Project and Session Knowledge budgets. Those
values are database policy, not Pi global preferences, and saves never copy them into `settings.json`.
The screen shows the Knowledge base, shared allowance and their maximum Knowledge input separately.

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
Unavailable states return `available: false` with `reason` and `message`; capacity refusal never
triggers recovery or native compaction. Successful results are detached from later changes.

## Compaction and the post-compaction boundary

`session_before_compact` reconciles persisted history and asks core to allocate one frozen selected-path
snapshot. Allocation is local and model-free: it takes no claim and advances no phase. Core either
returns a complete custom replacement or requests native Pi compaction.

| Outcome | Condition | Adapter result |
|---|---|---|
| `{text, supplied, charged}` | Required pending Raw and unconsolidated facts fit their bases plus the shared allowance | Return the text as `compaction.summary` |
| `{native: true, reason, over?}` | Required material still exceeds the envelope, or an entry's minimum view cannot fit its profile | Run bounded recovery, then return a fitting replacement or decline so Pi compacts natively |

The default bases are Knowledge 20,000 tokens from the database policy, facts 10,000 and Raw 10,000.
All three share one allowance derived from the N, C and D triggers, 20,000 tokens at defaults.
Required bounded Raw, unconsolidated facts and Knowledge state notices reserve shared excess first. Current Knowledge is optional material, regardless of its pool
processing record. The remaining capacity is allocated in this order: current Knowledge, newest
already-extracted Raw, then newest already-consolidated facts. Each base remains independent; only the
single shared remainder crosses windows. Framing, state notices and omission receipts are charged once.
The default maximum envelope is therefore 60,000 tokens.

Historical Raw is displayed in source order. Historical facts are displayed in chronological Turn
groups. An optional fact is omitted as redundant only when its complete nonempty source binding is
covered by retained originals or bounded Raw selected for this replacement. Unknown, incomplete or
partly covered bindings stay eligible. Pending facts are never filtered this way. Omitted optional
material starts no worker and changes no processing state.

The adapter passes the native ids that Pi will retain, so historical Raw is not duplicated. A custom
replacement supplies every pending entry as the shared bounded `renderEntry` view and returns
`firstKeptEntryId: ""`; the replacement, rather than old Pi messages, carries those views. The same
entry labels, budgets and truncation markers are used by Noting and explicit bounded trace. A carrier
records only the entries, fact ids and Knowledge commits actually emitted. Native compaction writes
no Trace Memory carrier.

### Bounded recovery inside the hook

Recovery is attempted only when required facts, Raw or mandatory Knowledge state notices exceed their
bases plus the shared allowance. Current Knowledge bodies are optional and do not force recovery. A phase must still satisfy ordinary
eligibility: Noting at 10,000 pending Raw tokens, Consolidation at 5,000 fact tokens, and Dreaming
when one applicable pool reaches `min(dreaming.triggerTokens, pool budget)` or is re-armed over budget. Overflow alone
never makes a phase eligible.

For one compaction attempt, each phase may be launched or compatibly awaited at most once. Independent
Noting and Consolidation work may run concurrently; after their committed progress is remeasured,
Dreaming may run once if an applicable pool is due. A completed Dreamer range is never reopened or
retried. If required material still does not fit after every useful bounded opportunity, Pi's native
compaction takes over. Recovery does not enlarge a normal batch to manufacture a fit.

The Noting boundary is the frozen entry ceiling. Consolidation is limited to the initially frozen fact
set plus facts created by the exact Noting task this recovery launched or reused. Dreamer processes
one frozen due pool under the database-wide seat. Reallocation counts actual committed state only;
launching or awaiting a task grants no credit. Final publication rechecks the selected path and project
binding immediately before returning the carrier.

A local slot holding a compatible task — same target and frozen boundary — is awaited and counts as
that phase's one use. An unrelated occupant is waited out only as capacity, then eligibility is checked
once; there is no polling queue. A foreign claim refuses admission. Dreamer reuse requires the exact
open pool range and live claim; foreground head movement does not rewrite that frozen identity.

`event.signal` is Pi's compaction abort controller. It cancels only workers this operation launched;
cancelling a compatible wait leaves the reused task alone. A cancelled compaction publishes nothing
and starts no native fallback. Committed N/C progress survives. For Dreaming, a pre-commit cancellation
records nothing, while cancellation after a commit retains the exact claim through terminal range
processing as described above. After a non-cancellation worker failure, material is remeasured: a fit
may still publish, otherwise Pi receives native delegation. A third terminal business failure follows
the ordinary automatic-off rule.

Pi reaches this sequence from its automatic compaction points and `/compact`. Preparation notifications
are not completion. Only `session_compact`, after Pi persists the result, updates `lastCompaction` and
reports success. Failed or cancelled attempts leave the last successful boundary unchanged. A native
summary is accepted as lossy and carries no promise that pending Raw or facts survived.

## Noter fork eligibility by Raw availability (29c)

A requested Noter fork runs as a fork **exactly when every entry of its target is available
in the inherited context in a representation it may extract from**:

```text
available Raw = native ids the visible view marks "source"  (Pi retained the entry)
              ∪ native ids it marks "view"                  (a carrier supplied its bounded view)
fork allowed  ⇔ every entry of the target ∈ available Raw
```

That set is 29a's `VisibleView.raw` as 30 left it — every marked compressed view counts, the one
bounded representation and both legacy tiers alike — so what does **not** count needs no rule of
its own: a summary with no carrier behind it (a compaction Pi wrote itself), an id that appears
only in rendered prose, and an absent tool result are simply not in `raw`.
An incomplete tool-call group stays where it already was — `forkable()` rejects the checkpoint
in the native gate and defers the launch through `checkpointReadiness` — and 29c adds nothing
there.

**The target is the batch this task would freeze**, not everything still pending: the pending
set the task's boundary admits (18b's `maxEntryId`, 27d's exact `entryIds`), cut to the oldest
prefix that fits `noting.batchTokens`. The host asks core for it (`memory.notingBatch(target,
boundary)`), which runs the very selection `freezeNoting` runs, so admission and the freeze can
never disagree about which entries the task is about. Rendering that batch costs what a freeze
costs, so it is asked for only once the whole pending set — a superset of the batch — is known
to be missing something; when nothing pending is missing, neither is the batch.

**The decision is made at admission, before the freeze**, and again at the actual launch against
the exact frozen entry set, so a task admitted before a compaction but held for a slot, a claim
or native readiness is caught too. Nothing is cached beyond 29a's per-context memo, so reopening
and tree navigation give the same answer.

One unavailable entry sends the **whole** target down the existing fallback (27c): the task runs
as a subagent on the configured Noter model, priced by that model's capacity, with fresh material
and its exact membership. The invisible entry is never skipped to manufacture a forkable batch.
The reason names the first unavailable entry and becomes the run's `fallbackReason`:

```text
Raw availability: entry 7 (T3, native 9e89d8e6) of this batch is not in the inherited context:
Pi retained no source for it and no compaction carrier supplied its primary view
```

**An unknown view is not availability.** A selected context holding no conversation entry of ours
establishes nothing about what a fork would inherit, so it is refused the same way ticket 27a
refuses an unknown context measure — `Raw availability: the selected context holds no conversation
entry of ours, …` — rather than being read as "nothing is missing".

**The head reply needs no exception.** It is the one entry `buildContextEntries()` holds that a
fork's captured request stops before, which is why 29b's increment always restates it — but it is
also not a member of the target while it is the head reply: Noting's target ends before the head
Turn's own reply. Once the head moves on and a later task does select it, the view marks it a
retained `source` like any other entry. So a target whose only non-inherited entry is the head
reply forks, and the view is the right authority as it stands.

Untouched by this rule: the cache-miss latch, checkpoint readiness, `forkable()`, prefix
verification and capacity. Visibility is necessary, not proof that a prefix check or provider
caching will succeed.

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
`VisibleView` contract from `buildContextEntries()` without reading the database or prose. Runtime
validation covers complete arrays, safe integer identities, source representation, binding and
legacy generation; any malformed field rejects the entire envelope without donating visibility or
completion. Valid empty injections and legacy tier markers remain readable. Command generations
belong to the originating Pi session even when a fork legitimately inherits material bound to the
same memory session.

`visibility(sessionManager)` (exported from `hosts/pi/index.ts`) memoizes that Pi reader by leaf id,
entry count and identity binding, so a rewind, new entry, compaction or memory-session allocation
invalidates it while a streaming token recomputes nothing. Database state is deliberately absent
from the key: applicability must observe a new fact or commit even when the native leaf has not moved.

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
while C and D use ordinary eligibility, including re-armed over-budget pools. Batch and context
limits still apply. Several C batches or due D pools can therefore run without another N batch.
Completion requires no frozen Raw left, neither C nor D due, and no owned task still running.
Below-threshold tails remain. Empty/dropped results do not re-arm; failure or cancellation ends the
drain. A waiting state need not imply an in-flight task when a due phase could not progress.

N and C can overlap. Successful owned completions remain checkpoints after the final N batch.
Stop/off/shutdown/path changes fence those callbacks. This remains the sole exception to ordinary
no-completion-chaining; entry events do not expand the frozen N boundary.
Core enforces that boundary through `boundary.maxEntryId`. Other exact-membership
forms remain available for fork fallback; they do not force a catchup C tail.

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
`memory` submission commits. Noter retains its own NEAR review when a valid candidate has lexical
neighbours. Rejected submissions may be corrected in later tool rounds.

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
request. The host suite also checks trigger boundaries, request-body capture,
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
   new facts with `trace` if you want to see them. Invalid model output may bounce; inspect the run
   result.
4. Run `/compact`. Expect immediate compaction with `<knowledge>` and `<episodic>`,
   pending compressed Raw views, recent facts, and no compaction model request. The
   notice says the bounded entry views were used. To see the other outcome, set
   `render.episodicBlockTokens` low enough that the pending views no longer fit: the
   notice then reads `native delegation — …`, Pi runs its own summarization call and
   writes its own `compaction` entry.
5. Ask the agent to call `search` for `pnpm`, then `trace` on a returned fact and
   its source turn. Expect the original conversation text and source addresses.
   The search/trace tools themselves are recorded as raw tool calls.
6. Save the actual prompt/reply transcript, `/trace` outputs, observed fact ids,
   compaction content, and trace result. Check `runs.request`, `mode`, `model`
   and `response.usage` using the facade. Default consolidation requires 5,000 rendered fact
   tokens; six short turns need not produce any consolidation run. For a
   separate consolidation exercise set `consolidation.triggerTokens` to 1 and wait
   for another eligible source entry completion after the Noting commits.

Automated verification uses a fake provider; it does not establish live provider
credentials or replace the manual conversation above.


## Fork request and verification contract (the gate)

A fork inherits the parent's persisted conversation, not a copy of its request: the child is
branched from the parent session file at its persisted leaf, and Pi's own adapter serializes
the body. What the capture is still for is the **gate**: the byte-level comparison that proves
the child's first outgoing body reproduces the parent's request prefix, so the provider's cache
lookup walks identical bytes.

`before_provider_request` captures a detached JSON snapshot for this extension instance (one
per Pi session) in memory. It is never appended to the Pi session file. Session/tree
restoration invalidates the capture; a missing capture, a capture from another branch and a
session model change since the capture all refuse the fork and take the fresh-context fallback
with a recorded reason. Persisted originals before the latest compaction or branch-summary
boundary are conservatively excluded from capture coverage. Payload-rewriting extensions must
run before this capture hook; native ancestry is not proof against arbitrary later rewrites.

A fork needs no *new* capture: once the checkpoint is persisted and reopenable, the capture
already held for this branch is enough, and the fork may run while the foreground is still
inside the same Turn (19c readiness). A capture older than the newest entries is not a
correctness problem: the child forks the real ancestry, so those entries are in its context,
and the gate compares only the prefix.

`fork.ts` supports `anthropic-messages`, `openai-completions`, and `openai-responses`
(including `openai-codex-responses`) payloads: it reads the parent's system prompt and tool
definitions out of the captured body so the child can be built with the same bytes, and it
compares bodies. Other APIs refuse the fork with an explicit reason. It no longer builds any
provider message — that ended with the request-copy runner (19c).

Every fork request is compared, first body and every later round. Comparison sorts JSON object
keys recursively, preserves array order and every string character (including whitespace and
Unicode), and compares the complete bodies allowing only the appended items. It therefore
covers each message prefix, tools, system instructions and other body options. `differingPath`
identifies the first unequal path. Hashes cover the two complete deterministically serialized
UTF-8 bodies, so the captured hash and request hash normally **differ**. The one normalization
is the ruled `cache_control` stripping described under The runner; nothing else is ignored.

`runs.response.verification` contains `passed`, `capturedHash`, `requestHash`,
`appendedMessages`, `differingPath`, `normalized`, `key`, and `rounds`. The top-level hashes
identify the capture and the child's first request. Each `rounds` entry records `capturedHash`
(the previous request), `requestHash` (the new request), `appendedMessages`, `passed`, and
`differingPath`. `runs.request` is the **last** request sent, which embeds every earlier round.
Top-level `passed` becomes false if any round fails. Reply `usage.cacheRead` is also copied to
`verification.cache_read` when numeric; it never affects `passed`. Missing usage leaves the
observation absent. Pi-ai normalizes some absent provider counters to zero: zero is not proof
of an explicit provider measurement. Its Anthropic adapter maps `cache_read_input_tokens`;
OpenAI maps `cached_tokens` (verified in nested `dist/api/anthropic-messages.js:411`,
`openai-completions.js:1180`, and `openai-responses-shared.js:441`). `response.usage`
preserves the full SDK usage.

A rejected first body throws inside `onPayload`, before anything is sent: nothing is billed, and
the task is admitted once more as a subagent (27c) with the full fresh-context material on the
configured Noter model. That run records `mode: subagent`, `requestedMode: fork`,
`response.fallbackReason` and the rejected gate result (both hashes and the differing path) under
`verification.native`. Missing or unsupported captures have a reason but no fabricated comparison
or hashes. Notification happens once per Pi session. A later round mismatch fails that round with no fallback; the record
retains the last request actually sent and the failed comparison, and a prior committed batch
stays committed. Provider failures after a passed comparison stay fork failures, with one
exception, which is 27b's post-attempt fallback below: a rejection pi-ai's own `isContextOverflow`
classifies as a context overflow, in a run that committed nothing and was not cancelled.

Fallback keeps the run honest: it accepts the actual returned `mode`, records `requestedMode`
beside it, and preserves `verification`/`fallbackReason` in the response envelope. Since 19b the
fresh-context material comes from the same frozen task rather than from a second core string, and
since 29b from the same builder: the re-admission carries no visible view, so its material is the
complete fresh one and a fallback cannot send range-only context or falsely record fork mode.
No store schema changed.

## Message binding (20a)

This adapter composes no domain text. Core prepares ONE text per frozen task (29b) and this host
only binds it to a native message (user ruling 2026-09-08; `compose.ts` and its test were deleted
with the layout that lived in them):

- **Inherited context (`fork`)**: `${input.prompt}\n\n${input.text}` as the appended user message.
  A fork has no system slot of its own, so the instructions ride in that message.
- **Fresh context (`subagent`)**: `input.prompt` becomes the child's system prompt and `input.text`
  its first user message.

There is no representation to choose any more: what the text contains is decided by the initial
state this host froze with the task at admission — the 29a visible view for a fork, nothing for a
fresh child — and the titles, block order and separators inside it are core's, pinned in
`tests/core/render/material.test.ts`.

## The visible view at admission (29b)

`visibility(context.sessionManager)` (29a) is created in `restore` and held for the session; it
memoizes by leaf id, entry count and binding, so a streaming token re-reads the cached view while a
rewind, a new entry, a compaction and the memory-session allocation each invalidate it. Admission
passes `visible` to core only for a task whose effective mode is `fork`, beside the
`capacity.prefixTokens` measure it freezes at the same moment. An explicit subagent, and a fork re-admitted as a subagent after any refusal (`fallbackReason` makes
the effective mode subagent), pass none and get the complete fresh material. Noter's lexical NEAR
review remains part of its own write path. Consolidation's first valid submission commits. If a
later corrective request after a rejected tool call exceeds
capacity, the normal overflow/refusal path applies.

## The runner (19a/19b, sole runner since 19c)

The runner is real Pi child sessions for **both** modes. Branch work runs in a child forked
from the parent session file; every fresh-context task — explicit subagent mode, a fork that
could not be prepared, and borrowed closed-session catch-up — runs in a private child. There is
no other runner: a child that cannot be constructed at all is a run failure with a reason, and
the queue stays pending. `native.ts` opens the parent's own JSONL through an **independent**
`SessionManager` whose session directory is the runs directory, calls
`createBranchedSession` at the parent's persisted leaf, and hands that manager to
`createAgentSession`. The foreground manager is never passed in and never mutated;
`SessionManager.forkFrom` (whole-file copy) is not used, so sibling branches and later
foreground entries stay out of the child.

The child is built to reproduce the parent's request bytes through the SDK's own options:

- **System prompt.** One inline extension, supplied explicitly by the adapter, returns the
  parent's captured system prompt bytes from `before_agent_start`. Pi's
  `DefaultResourceLoader` `systemPrompt` option cannot be used for this: `buildSystemPrompt`
  appends `\nCurrent working directory: <cwd>\n` to any custom prompt, so the child's prompt
  would differ from the parent's by that line.
- **Tools.** The child registers the parent's *whole* tool list, in the parent's order, as
  `customTools` synthesized from the captured body (name, description, schema), with
  `noTools: "all"` and an explicit `tools` allowlist so nothing else can appear. Tool
  DEFINITIONS are the parent's because the gate compares them; tool EXECUTION is whitelisted
  to the four memory tools core bound for the run. Any other call — including one the copied
  history invites — returns an error result and never runs. Execution is sequential
  (`agent.toolExecution` plus a per-tool `executionMode`); Pi's tested default is parallel.
- **Discovery.** Extensions, skills, prompt templates, themes and project context files are
  all disabled in the worker. Copied `trace-memory` custom entries travel into the child's
  JSONL and activate nothing.
- **Identity.** `agent.sessionId` is set to the parent's Pi session id so the provider sees
  the parent's request/transport identity for cache affinity. The child's own SessionManager
  id and file stay its own, as does Trace Memory's target attribution.
- **Task delivery.** The text core prepared is the child's user prompt. Noter NEAR guidance is delivered
  as a native user message; ordinary tool rejections remain tool results.
- **Thinking level (26b, extended by 26d).** The child is created with Pi's own `thinkingLevel`
  option. Admission freezes **two** levels with the task, beside its model and its material: the
  foreground level the host reads once there (`pi.getThinkingLevel()`), and the phase's subagent
  level — `notingThinking` / `consolidationThinking` when that preference is not `inherit`, the same
  foreground level otherwise. A **fork run keeps inheriting the foreground level**, because its
  request prefix must still match the captured parent request; **every fresh child takes the
  subagent level** — explicit subagent mode, a fork fallback, borrowed closed-session work and
  `/trace catchup` alike. A Consolidation fork inherits the foreground level like any other fork, so
  its configured level reaches a fork task only through that task's fallback child (29e).
  The frozen level wins over the level a forked ancestry carries, over the per-model preference and
  over the global default, and Pi's own clamp normalizes a level the worker model does not support.
  Borrowed work uses the active executor's levels, never a historical target session's. Both values
  are frozen as values, so a foreground switch or a preference saved while a worker runs reaches
  neither that worker's later rounds nor its fallback. The gate is untouched: a level that makes the
  inherited request differ from the captured parent request is refused by the existing prefix
  verification and falls back like any other mismatch — and that fallback child, being fresh, runs at
  the configured level. The run record's response carries `thinking: { requested, effective }` — the
  level this run asked for (configured or inherited) and the level the child really ran at, side by
  side, so a clamp is visible instead of silent.

### The fresh child (19b subagent parity)

The same `runNative` serves `mode: "subagent"` with four differences and no second runtime:

- The manager is `SessionManager.create(cwd, runsDir)` — Pi's own new-session constructor, in the
  runs directory (24c: `<agent dir>/sessions/trace-memory` by default), with no parent file and
  therefore no inherited history. Its `getSessionFile()` is the run's `nativeLog`.
- The system prompt is core's domain prompt (through the same inline `before_agent_start`
  extension), and only the four memory tools core bound for the run are registered at all: there
  is no parent body whose tool list has to be matched.
- No gate runs and no `verification` is recorded, for the same reason. Everything else — the
  execution whitelist, sequential execution, disabled discovery, usage from new assistant
  messages only, outcome from the terminal response, cancellation, disposal — is identical.
- The child keeps its own `agent.sessionId`; the parent's request identity is a fork-only
  decision.

**Per-task fork fallback: one path (27c; 27b before it; parent 27 "Per-task fork fallback",
amendments 1, 4, 5 and 6).** One rule covers every reason a requested fork does not run as one:

> the task runs as a **subagent on that phase's configured model** (`notingModel` /
> `consolidationModel` (29e), the `session`
> preference included), priced by **that model's** capacity (`contextWindow − 10,000`), with fresh
> material, and the run audit records the requested mode `fork`, the effective mode `subagent`, the
> reason (`fallbackReason`) and the model that actually ran.

The reasons, and where each is decided:

- **At admission, from this host's live state.** The cache-miss latch, and — for a Noter only —
  29c's Raw availability. Nothing is frozen yet, so this admission simply selects the phase's model
  and its capacity: no second admission, and the reason is frozen with the task
  (`TaskOptions.fallbackReason`, opaque to core) as the run's `fallbackReason`.
- **At admission, from the freeze (27b).** A fork whose inherited context plus instructions cannot
  fit the allowance, and a session Pi reports no context measure for (no fork base at all). Instead
  of leaving feasible work pending, the host admits the task **once more** with the model, the
  capacity and the fresh material above, under the ordinary exact selection.
- **After admission, at the launch.** Every condition `forkLaunch` rechecks against the live state
  for the task it is about to run — the latch, Raw availability, a branch changed since
  admission, a missing or foreign capture, a session model changed since the capture, an
  unpersisted parent, no persisted leaf — and the native gate's rejection of the child's first body
  (`native runner: <reason>`, with the rejected comparison under `verification.native`). Nothing
  was sent. `runWorker` returns the refusal rather than rerunning the frozen task itself, and the
  host admits it once more.
- **After a real attempt (27b).** A provider rejection that pi-ai's own `isContextOverflow`
  classifies as a context overflow of this model's window — called with the child's terminal
  assistant message, never a pattern list or an error string of ours — in a run whose core commit
  state shows no business submission (`note` or `memory` returned a non-rejection receipt; a tool
  name or a display string is never read as one) and that was not cancelled.
  `fallbackReason: "context overflow: <the provider's own words> (fork attempt log: <the fork
  child's own JSONL>)"`. Authentication, network and rate-limit rejections are not capacity failures
  and end the run as themselves; so does any failure after a commit, a cancellation, a stop, a
  shutdown, a lost claim and a disabled enrollment (all of which reach the run as an aborted signal).

**One transition per task, structurally.** A re-admitted task carries its reason, and a task
carrying one is not offered a fork at all, so it cannot be refused one — its own failure is the
run's failure, never hidden by the warning. A task that already ran keeps its frozen evidence
membership across the re-admission through the task boundary — **27d/29e: `exactEntryIds` and
`exactFactIds`, the frozen batch's exact ids, never `maxEntryId`'s upper bound or a manual catchup's
larger `allowedFactIds` set** (parent 27 amendment 6; the two meanings are separated by name since
29e). The freeze takes those members whole: it trims optional material if that is what makes them
fit — the Noter's history, the Consolidator's knowledge block — never pops one, and leaves the whole
batch pending under the existing `NOTING_CAPACITY` / `CONSOLIDATION_CAPACITY` diagnostic when the
fallback model cannot hold it. A member that is no longer pending was completed by another executor
under its own claim, and drops this task with the `NOTING_MEMBERSHIP` / `CONSOLIDATION_MEMBERSHIP`
reason instead of re-processing the rest. Evidence that arrived while the attempt was in flight
waits for the next batch either way.

**Consolidation takes this path unchanged (29e).** Before its first valid submission, a fork overflow
may be re-admitted on the same exact frozen fact target. A valid submission is already the business
commit; any later provider failure belongs to that run and starts no second execution.

**One run record per attempt** (user ruling 2026-09-10; it supersedes 27c's "one run record for
both attempts", which was ticket text and never a ruling). An attempt that **sent a provider
request** and was then refused is finalized by core before the refusal goes back to the host:
requested mode `fork`, outcome `failure`, the refusal reason among its `problems`, and exactly the
usage, retries, request and `nativeLog` it reported — no `fallbackReason`, which belongs to the run
that fell back. Core returns that record's id with the refusal (`NotingResult.runId`), and the
re-admitted run names it in its own reason (`… (fork attempt recorded as R<n>)`) while charging
only what it spent itself. A refusal that **sent nothing** — a launch-time refusal, the native
gate's rejection inside `onPayload` — is not an attempt: it records no run, and its rejected gate
result travels in `TaskOptions.forkAttempt` into the re-admitted run's record. So a task whose
fallback never runs (an unavailable fallback model, a batch the fallback cannot hold) still leaves
the attempt's own accounting behind. A rejected request reports the SDK's placeholder zeros, which
stay unknown: never a paid successful generation, never a zero.

**The levels and the cancellation fence travel with the refusal** (27d). The `thinkingLevel` and
`subagentThinkingLevel` frozen at the first admission are reused by the re-admission, which reads
neither `pi.getThinkingLevel()` nor the phase's `…Thinking` preference again — repricing fresh
material is not permission to reread a frozen policy choice (parent 27 line 96; 26d's freeze rule).
Under ticket 29's policy freeze, the configured subagent model is also selected at first admission,
including the concrete model for `session`. Core exposes its cancellation generation, which
`cancelTasks()` advances whether or not it is stopping. The host freezes it before preflight, so even
an unknown-measure or freeze-capacity refusal carries both levels and the cancellation fence. A
re-admission that arrives after a `/trace stop`, a shutdown or a disabled enrollment is dropped
with `reason: "cancelled before fallback"` — it launches nothing and warns nothing (parent 27
line 83). Before releasing a refused attempt's claim, core checks the original token, executor and
expiry in the same Store transaction. Lost ownership suppresses continuation even if another
executor already released its replacement and the exact target is still pending. A still-owned
claim may be released for the authorized fallback; that release is not mistaken for ownership loss.
Sent attempts retain their own run records and usage in either case.

Every one of these is a warning, not an error: none sets the cache-miss latch, changes a setting, a
default mode or a persisted mode, and a later task may request fork again. One warning per Pi
session names the reason.

`agent.onPayload` is wrapped (the extension runner's own handler is still called): the first
body is checked against the captured parent request with `verifyForkRequest`, appended messages
being everything past the captured message count. Later rounds are checked the same way against
the previous round. A rejected first body throws inside `onPayload`, **before** the request
leaves, so the task is admitted once more as a subagent (27c) with
`fallbackReason: native runner: …` and the rejected result under `verification.native` (both hashes
and the differing path). Nothing is billed twice.

**Gate result (19a).** With the production Noter and Consolidator prompts and the production
tool definitions, driven through the real installed pi-ai adapter:

- `openai-completions` (and, by the same construction, the other APIs with no adapter-placed
  cache markers): **passes**. The child's first body is byte-identical to the captured parent
  body outside the appended messages — system prompt, tool definitions and order, model
  parameters, and the whole message prefix.
- `anthropic-messages`: **passes with one normalization** (user ruling 2026-09-08, amending
  ticket 19 gate 1). The adapter places the ephemeral cache breakpoint on *the last user message
  of the body it is building*: in the parent that is the message the child inherits, in the
  child it is the appended task message, so the raw bodies always differ at
  `$.messages.<parent's last user message>.content.<n>.cache_control`. No public option changes
  that placement (`cacheRetention: "none"` removes every marker, which differs the other way),
  and reproducing it would need the custom message builder ticket 19 exists to delete. The
  marker is a caching hint, not content: the provider's cache lookup walks the identical bytes
  before it. So the gate (`verifyForkRequest`) compares both bodies with `cache_control`
  stripped from both sides and **nothing else**; the hashes stay those of the raw bodies and
  the verification records `normalized: ["cache_control"]`. Any other difference still fails.

Usage is summed from the child's newly generated assistant messages only — copied parent
responses are restored into the child's state but were never re-sent, so native session
statistics must not be used. `auto_retry_start` events are recorded as `retries`, and a failed
attempt's usage is included. A cancelled child with no reported usage records unknown, not zero.
The outcome comes from the child's terminal assistant response, never from `prompt()`
resolving; a provider error after a memory tool committed leaves the commit in place and core
records the problem.

Limits: the fork path still requires the parent request capture, because that capture is what
the gate compares against; the runs directory is never pruned; a gate rejection after the child
file was created leaves that (unused) child log behind; and no live provider run was made —
every check above uses stubbed HTTP with the real adapters.

## Launch readiness and the cache-miss latch (19c)

### Readiness: trigger and launch are different authorities

17b's thresholds still decide that a task is *due*. Whether it may *launch* as a fork is a
separate question about the native checkpoint, asked in `checkQueues` before admission:

- The checkpoint is the persisted leaf of the selected path. `checkpointReadiness(parentFile,
  checkpoint)` reopens the parent's own file through an independent `SessionManager.open` — the
  same reopen the launch performs, read-only, creating nothing — and refuses when the entry is
  not in the file yet, when the file cannot be reopened, or when the ancestry contains an
  assistant tool-call group whose results are missing (`forkable`). Pi's message-completion
  callback runs *before* persistence, so a message the extension has just seen completed is not
  a checkpoint.
- A refusal is a **wait**, not a failure: the own-branch candidate is left out of this
  opportunity, no claim is taken, no progress is made, no duplicate task is created and no timer
  is set. The next persistence boundary asks again; starting there is not a new extraction
  trigger. Borrowed closed-session work is fresh-context and is never held back by this.
- A fork that is impossible for this task rather than merely early — no capture for this branch,
  no persisted parent file, an unforkable checkpoint at launch — still takes 19b's documented
  native subagent fallback with `requestedMode`, actual `mode` and `fallbackReason` recorded.
- **No capture dependency, read with gate 1.** A fork never waits for a *new* provider request:
  a persisted, valid checkpoint plus the capture already held for this branch is enough, and the
  fork may run while the foreground is still inside the same Turn. It does need *that* capture,
  because it is what the fork gate compares the child's first body against; without one the task
  takes the subagent fallback instead of waiting.
- A tree switch invalidates a stale launch context instead of retargeting it: `restore()` drops
  the capture and gives the memory session a new branch identity, and the fork branch refuses to
  run when the task's frozen branch is no longer the selected one. The waiting task's entries
  stay pending on their own branch; the new position's work is its own task.

### Cache-miss latch

Gate 3: the deterministic prefix check runs first on every fork request. A body that differs
from the parent prefix is a known miss, routed to subagent for that task **without touching the
latch**. Only a response whose request passed the gate can count, which is why the observation is
recorded inside `verification` and why the fresh-context runner is never given the callback.

An eligible miss is judged per completed fork response, on that response's own usage:

| Provider family | Minimum cacheable input | Source |
|---|---:|---|
| `anthropic-messages`, Haiku family | 2048 tokens | Anthropic prompt caching |
| `anthropic-messages`, other models | 1024 tokens | Anthropic prompt caching |
| `openai-completions`, `openai-responses`, `openai-codex-responses` | 1024-token prefix | OpenAI automatic prompt caching |
| anything else | unknown — never a miss | no universal minimum is invented |

**Read-ratio rule (user rulings 2026-09-09, after the beta dogfood; supersede the 2026-09-08
30,000-uncached-token rule):** a completed fork response is a **miss when its `cacheRead` is below
half of its input** (`CACHE_MISS_READ_RATIO = 0.5`; input is `input + cacheRead + cacheWrite`), and
a **hit** otherwise. A response whose input is below the provider's documented cacheable minimum
(table above) is neither: it could not have been cached. The observation carries
`{model, api, minimum, ratio, input, cacheRead, cacheWrite, total, miss}`.

The session is downgraded only on the **second consecutive** eligible miss. The count lives in
the executor process, per memory session: an eligible hit resets it, an unknown response neither
counts nor resets, a reopen starts at zero (the persisted latch below is the session-scoped
state), and the menu's **Retry fork** resets it with the latch. The reopen boundary is the one
`restore()` reopens the memory session at; a tree switch moves position inside the same session,
so its misses stay consecutive and only the position changes. Every eligible miss emits one TUI
notice with its count — `Trace Memory: fork cache miss 1/2 (… of … input tokens read from cache).`
— and the downgrade emits its own single notice: `Trace Memory: fork downgraded after two
consecutive cache misses. Future memory tasks in this session will use subagent.`

pi-ai normalizes both families to one counting convention: `input` excludes `cacheRead` and
`cacheWrite` (`openai-completions` subtracts them from `prompt_tokens`; `anthropic-messages`
copies `input_tokens`, which already excludes them). The compared quantity is therefore
`input + cacheRead + cacheWrite`, never compressed Raw size. Everything unknown is not a miss:
missing usage, non-numeric or absent cache counts, the SDK's placeholder zeros on an errored or
cancelled response, an Anthropic body that carried no `cache_control` marker (a disabled cache),
and an unlisted provider.

On the second consecutive eligible miss:

- `store.suppressFork(sessionId)` sets `sessions.fork_suppressed_at` with an `IS NULL` guard, so
  two phases reaching the second miss in the same instant produce **one** transition; only the
  winner emits the downgrade notice. Headless operation records the same state without any UI.
- The detecting run continues untouched: same native session, same tool protocol, same trailing
  replies, no replay, no extra trigger, and its run record keeps `mode: "fork"`. The run's first
  miss is audited as `verification.cacheMiss = {model, api, minimum, ratio, input, cacheRead,
  cacheWrite, total, miss}`, and the run id is linked to the session's suppression once core has
  allocated it (the miss is seen before any run row exists).
- Every later task rechecks the latch at fork admission, so a task queued before the transition
  cannot bypass it. The configured requested mode is retained: the run records
  `requestedMode: "fork"`, `mode: "subagent"` and `fallbackReason: "cache miss latch: …"`.
  Sibling tasks already running stay frozen. Global configuration and other sessions are
  unchanged; branches and copied hosts sharing the memory session share the latch, and it
  survives reopen because it lives in the database.

The status text adds one line while the latch is set:

```
Fork: suppressed since <ISO timestamp> (cache miss on R<n>); Retry fork in the /trace menu
```

The reset is menu-only. `/trace` → **Current session** lists a **Retry fork** action *only while
the session is downgraded*; choosing it clears the suppression, says so, and starts no
extraction. There is no `/trace retry` subcommand and no permanent top-level item, and neither a
reopen nor a settings refresh clears the state. Two later consecutive eligible misses begin a new
episode and may downgrade once again.

## Three failures turn memory off (32c)

Three terminal business failures of one **logical task** persistently disable its target's memory.
The key is target session, phase and stable oldest selected backlog item: a source entry for Noting,
the first fact in Consolidation order, or the frozen Dreamer pool range's first revision. A new leaf,
a growing tail, another executor or partial Dreamer edits do not reset it. Cancellation is not a
business failure. Dreamer ranges end once: processing covers skips and own output, leaving untouched
material pending. Residual over-budget state alone is not a new logical failure. Ordinary worker
completion starts no next task; later eligible entries or bounded compaction recovery supply new
opportunities. Manual catchup alone rechecks all phases after its own successful completions.

Provider retries and fork fallback share one durable execution identity. A refused fork followed
by successful fresh execution adds no failure; a terminal fresh failure adds one. Incomplete
Noting and unresolved submission refusal count; cancellation, busy admission and audit errors
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

## Live prefix identity procedure

This is a human-run check, not an automated claim of live cache hits.

1. Create `/private/tmp/trace-memory-manual` and place this diagnostic extension
   in `/private/tmp/trace-memory-manual/capture.ts`. It writes only a diagnostic
   body outside the Pi session file:

   ```ts
   import { writeFileSync } from "node:fs";
   export default function (pi) {
     pi.on("before_provider_request", event => {
       writeFileSync("/private/tmp/trace-memory-manual/captured.json", JSON.stringify(event.payload));
     });
   }
   ```

2. Enable fork mode and a low compressed-token trigger with an isolated database:

   ```sh
   export TRACE_MEMORY_CONFIG='{"dbPath":"/private/tmp/trace-memory-manual/fork.db","noting.forkModeDefault":true,"noting.triggerTokens":100}'
   node /opt/homebrew/lib/node_modules/@earendil-works/pi-coding-agent/dist/bundle/cli.js \
     --extension /private/tmp/trace-memory-manual/capture.ts \
     --extension /absolute/path/to/trace-memory/src/hosts/pi/index.ts
   ```

   Use a session model with one of the three supported APIs. Load both diagnostic
   and Trace Memory hooks **after all payload-rewriting extensions**, in the
   order above. Pi runs hooks in load order; a later rewriter can invalidate the
   capture without this host seeing it. Verify the active extension order in Pi.
   No payload rewriter should follow Trace Memory.

3. Send a substantial prompt with several explicit project constraints. Wait for
   the assistant and the noting to finish before another prompt; reading the status is
   read-only. From a second terminal, in the repository root, run:

   ```sh
   node --input-type=module <<'JS'
   import assert from 'node:assert/strict';
   import { readFileSync } from 'node:fs';
   import { DatabaseSync } from 'node:sqlite';
   import { hash, serialize, stripCacheControl } from './src/hosts/pi/fork.ts';
   const db = new DatabaseSync('/private/tmp/trace-memory-manual/fork.db', { readOnly: true });
   const run = db.prepare("SELECT * FROM runs WHERE kind='noting' ORDER BY id DESC LIMIT 1").get();
   assert.ok(run, 'Wait for the noting to finish');
   const response = JSON.parse(run.response);
   console.log({ mode: run.mode, model: run.model, outcome: run.outcome, ...response });
   assert.equal(run.mode, 'fork');
   const captured = JSON.parse(readFileSync('/private/tmp/trace-memory-manual/captured.json', 'utf8'));
   const sent = JSON.parse(run.request);
   const key = Array.isArray(captured.messages) ? 'messages' : 'input';
   const verification = response.verification;
   assert.equal(verification.passed, true);
   let body = sent; // runs.request is the LAST body sent; walk the rounds back to the first
   for (const round of [...verification.rounds].reverse()) {
     assert.equal(round.passed, true);
     assert.equal(hash(body), round.requestHash);
     const count = round.appendedMessages.length;
     assert.deepEqual(stripCacheControl(body[key].slice(body[key].length - count)), round.appendedMessages);
     body = { ...body, [key]: body[key].slice(0, body[key].length - count) };
     assert.equal(hash(body), round.capturedHash);
   }
   assert.equal(hash(body), verification.requestHash);
   // The child's own tail: the inherited head reply plus the task message. The gate compares
   // both bodies with cache_control stripped and nothing else (ruling 2026-09-08).
   const appended = verification.appendedMessages.length;
   const prefix = stripCacheControl({ ...body, [key]: body[key].slice(0, body[key].length - appended) });
   assert.deepEqual(Buffer.from(serialize(prefix)), Buffer.from(serialize(stripCacheControl(captured))));
   assert.equal(hash(captured), verification.capturedHash);
   assert.deepEqual(sent.tools, captured.tools);
   assert.ok(response.nativeLog); // the child's own JSONL, under runsDir
   db.close();
   JS
   ```

4. Save the two bodies and printed response. Check `usage.cacheRead` and
   `verification.cache_read` for cached input tokens. A positive count is an
   observation, not identity proof; zero/missing counts do not fail comparison — but note that
   one *eligible* zero-cache fork response arms the session's cache-miss latch (19c), which the
   `/trace` menu's Retry fork clears. Hashes should each match their respective body, not each
   other. Inspect the appended tail: the inherited head reply, then the noting prompt with
   range-only input and no copied raw. `response.nativeLog` points at the child's own JSONL.
5. Change the session model, then send another prompt and wait. A model change since the
   capture must refuse the fork with a reason, not reuse the stale body; after a new capture
   the next run forks again. Repeat after changing active tool definitions. For an unsupported
   API expect subagent mode, a fallback reason and one notice, rather than invented hashes.
   Compare with a separate database using `noting.forkModeDefault: false` to
   evaluate extraction quality and cost before choosing the operational default.


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
session pools are unchanged. Dreaming being due does not block the declaration; only the affected
active-Dreamer guards described above do. Duplicate Knowledge is left for ordinary Dreamer maintenance;
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

Every Noting, Consolidation and manual write leaves a row in `runs` with the
exact last provider request, the final output, summed usage, the tool-call
sequence, fetches and problems. The response envelope also carries
`thinking: { requested, effective }`, the level frozen at admission and the level
Pi's clamp left the child at (26b). `trace R<n>` renders a run as a summary (kind,
outcome, range, model, mode, what it created, usage, cost, tool counts,
problems); `full` adds each tool round and cut previews of the raw request and
response. The menu's Current session > Runs lists the session's last n runs, with a
count input (the `/trace runs [n]` subcommand was retired in 24b).

## Footer status item

Background workers are separate Pi sessions and therefore do not enter the foreground session's own
usage totals. The host publishes one status item through `ctx.ui.setStatus("trace-memory", …)`:

```text
🧠 <indicator> notes: 24->102 memory: 9->54/306 cost: $0.12
```

| Field | Meaning |
|---|---|
| `notes: 24->102` | 24 imported source entries still await Noting; 102 facts are applicable on this path |
| `memory: 9->54/306` | 9 applicable facts await Consolidation; 54 of 306 current visible Knowledge revisions are changed for their owner pools |
| `cost` | Database-wide memory-run spend since local midnight, using recorded model usage and Pi's configured rates |

`changedKnowledge` means the current owner pool has no processing record for that current revision.
It is a scheduling measurement only, not a validity status and not a second visible partition. A new
revision may become changed; archives are absent from the current visible total. Pool-level token bars
in Current session are the authority for Dreamer triggers, because this footer count is revision count,
not rendered tokens.

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
- On `anthropic-messages` the gate passes only with the ruled `cache_control` normalization
  (see The runner). Nothing prunes `runsDir`, and since 24c its default sits inside Pi's own
  sessions tree, so worker conversations are listed by Pi's all-session browser.
- A fork inherits the parent's persisted ancestry, so a capture older than the newest entries
  is not a correctness problem any more: the child's context holds them and the gate compares
  only the prefix. The request-copy runner's "captured prefix does not contain the selected
  source entries" refusal went with it (19c).
- The readiness probe reopens the parent's session file once per launch decision, and again at
  each boundary while a task waits. It is read-only and creates nothing, but on a very large
  session file it is repeated read I/O, bounded by how often a task is actually due.
- The cacheable-minimum table is a documented constant, not a provider query. A provider that
  changes its minimum, or a model family the table does not name, yields "unknown", which can
  never downgrade a session — the conservative direction.
- The latch never expires by itself and is not time-boxed: only the menu's Retry fork clears it.
  Between the miss and the end of the detecting run, status shows the timestamp without a run id.
- No live provider run backs any of it: the eligibility numbers in the tests are stubbed usage
  values fed through the real pi-ai adapters, so nothing here claims a real cache hit or miss.

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

The same entry bytes supply subagent Noting, subagent fallback, compaction
Raw, branch-carry Raw and the explicit `trace` of a Turn without `full` (23b),
which assembles that Turn's selected entries in path order and seals every call
`tool` did not select at its label line and omission marker. Existing episodic budgets count these compressed bytes
when deciding which whole facts fit. A Noting batch whose views, framing and cues cannot
fit the episodic budget or the model's reported capacity is reduced oldest-first and
re-frozen, or left pending with a capacity error (review 2026-09-08); compact is the one
consumer that escalates to lossier views instead. The shared estimator is unchanged. **Fork-mode Noting keeps reading the uncompressed
native provider prefix and gains nothing from the compressed view.** This is the
accepted 2026-09-08 fork-mode choice: its value is prefix reuse. The captured
prefix is never rewritten or compressed. Its one appended user message still
contains the Noting instruction, range, head reply and source index; the index
contains only the frozen sources. Existing exact-prefix verification and fallback
remain authoritative. A capture that predates a selected user or tool source falls
back to the same compressed subagent input; source previews are not evidence of
full prefix coverage. Native request capacity is checked before each Noting and
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
accounting of ours reads a provider request body for tokens any more (the fork gate's own byte
comparison of the captured body is untouched). A window that cannot exceed the headroom, and an
invalid one, fail with a diagnostic before anything is sent.

The measure is Pi's, taken where Pi takes it:

- **Admission** hands core `contextWindow - 10,000` as its input allowance. For a fork it also hands
  it `prefixTokens`, the value of `ctx.getContextUsage().tokens` read **once** at admission and frozen
  with the task beside the model and the thinking level: Pi's real usage of the latest valid reply on
  the path (`input + cacheRead + cacheWrite + output`, since that reply is history at the checkpoint)
  plus Pi's own estimate of the messages after it. A foreground turn after admission cannot move it.
  Because it is Pi's number, images and encrypted reasoning in the parent history need no rule of
  ours — whatever they really cost is already inside it.
- **Not a fork base:** an unknown measure (`tokens: null`, which is what Pi reports right after a
  compaction until a valid reply answers on the new prefix), a missing model, or a capture whose model
  or provider is not the current one. A capture from another branch or model is refused at launch and
  runs as a fresh child, as before; an unknown measure is refused at admission instead, because
  nothing downstream would. No whole-body estimate ever stands in for the measure. Since 27b that
  refusal — and the freeze's own capacity refusal of a fork — is not a wait but one re-admission as a
  subagent ("Per-task fork fallback" above).
- **A subagent** is priced by the existing core material accounting alone — instructions, tool
  definitions and the frozen material — because a fresh child inherits no context to measure.
- **Every round the child sends** is checked in `hosts/pi/native.ts` on the child session's own
  `getContextUsage()` — Pi's getter, which runs pi-ai's `estimateContextTokens` over the child's
  messages: its latest real assistant usage once it has one, plus an estimate of what follows it. For
  a fork's first round that is the parent's reported prompt cost plus the increment. The guard is
  handed that number and nothing else, so it reads no provider shape at all and a subagent on any API
  the SDK can call keeps running; the four-API table belongs to the fork gate alone.

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
successful zero-fact run — an explicit `note({facts: []})`, the only way to complete an
empty batch since 26a — processes only its selected entries; later entries in
that same Turn remain pending. A run that ends without any submission is incomplete: it
processes nothing at all. Address aliases are interpreted against the frozen
entry set. A later matching source occurrence makes that address ineligible for
the earlier writer, even if an unrestricted trace fetch can read it. Run records
include `entryAudit`: native identities, owning Turns, frozen branch, view-budget
version and values, and the exact omission markers. Entry processing, facts, run
audit commit atomically. Rejected or failed work remains
pending. A fork inherits processed shared entries and keeps its sibling entries
out of the selected ancestry.

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
