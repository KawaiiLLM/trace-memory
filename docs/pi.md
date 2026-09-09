# Pi host reference

`index.ts` is a Pi extension: its default export takes `ExtensionAPI`. It opens
one facade for the global database and uses only `src/core/api/index.ts`, including
its exposed store. Notings use verified fork mode by default; consolidation uses
subagent mode. Each reconciled eligible entry completion checks both extraction queues.
Compaction, shutdown and tree navigation launch neither phase.

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

This Beta requires a database created by the current schema. Older development databases,
including those before commit reasons and versioned topics (21a/21b), are not supported;
there is no migration. Preserve old databases and logs and choose a new, unused `dbPath`.
See the [installation guide](../README.md#install) before loading the package.

## Configuration

Read configuration from the `trace-memory` namespace in Pi's global `settings.json`
(`PI_CODING_AGENT_DIR` or `~/.pi/agent`) and project `.pi/settings.json`. Project
values override global values; `TRACE_MEMORY_CONFIG` is the final flat JSON override.
Pi's own runtime settings — `retry` and provider policy — are not read here at all: the
child session is built with Pi's `SettingsManager` and uses whatever that reports (19c
gate 6). The plugin never writes settings.
For example, either settings file can contain:

```json
{
  "trace-memory": {
    "noting.forkModeDefault": true,
    "consolidation.subagentModeDefault": true,
    "noting.triggerTokens": 10000,
    "noting.batchTokens": 10000,
    "consolidation.triggerTokens": 5000,
    "consolidation.batchTokens": 10000
  }
}
```

Environment override example:

```sh
export TRACE_MEMORY_CONFIG='{"dbPath":"~/.trace-memory/trace.db","noting.triggerTokens":10000,"noting.batchTokens":10000,"consolidation.triggerTokens":5000,"consolidation.batchTokens":10000,"noting.maxToolRounds":0,"consolidation.maxToolRounds":0}'
```

- `dbPath` defaults to `~/.trace-memory/trace.db`; its parent is created on load.
- `notingModel` and `consolidationModel` accept `provider/model-id`, or `session`. Omission
  and `session` both resolve to the current session model's audited provider/id.
- Core settings use dotted names: every `render.*`, `noting.*`, and `consolidation.*` key
  in `DEFAULT_CONFIG` is accepted with the core's default and value type.
- `noting.forkModeDefault` defaults to `true`. Set it to `false` for subagent
  notings. Fork notings always use the session model, including on fallback;
  `notingModel` applies only when subagent mode is explicitly configured.
- `nativeRunner` (19a) is **gone** (19c). The native runner is the only runner, so the key
  selects nothing; like any other unrecognized key it is rejected at load with
  `Unknown setting nativeRunner`, which is 18a's rule for configuration that does not exist.
  When a fork cannot be prepared, or its first body fails prefix verification before anything
  is sent, the task runs in a fresh native child instead and the run records `fallbackReason`
  (`native runner: …`) together with the rejected gate result under `verification.native`. If
  even that child cannot be constructed, the run fails with the reason and the queue stays
  pending for the next permitted trigger.
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
- `consolidation.subagentModeDefault` defaults to `true`. Set it to `false` for fork
  consolidation: the candidate round appends the consolidation prompt and input to the
  captured prefix, the final round appends the candidate reply (in the
  provider's native assistant shape) and the feedback message to the candidate
  request. Tree navigation launches no extraction.

The peer dependency supplies Pi SDK types. Verification uses the installed
`@earendil-works/pi-coding-agent` 0.85.1. Tests use Vitest on Node; the standalone
smoke uses Node's built-in TypeScript support and does not load Vitest.

## Host decisions and boundaries

- Only `/trace project <name>` declares shared project membership, after the first
  assistant reply. The same name in the same database identifies the same project.
  Otherwise, `pi:<Pi session UUID>` names a private project. No marker file,
  working directory or Git remote supplies attribution. A project may exist before
  any assistant reply; a Trace Memory session cannot. The first prompt is buffered
  until that reply permits its turn row to be appended. Later prompts append
  immediately. Stored project declarations persist across resume and tree navigation.
- `before_agent_start` injects the knowledge block once per session (by project
  before allocation, by session afterward; after compaction the compaction block
  already carries the knowledge) and, on every prompt, the pending deliveries for
  this branch: a Noting's facts as `<noted>`, an Consolidation's knowledge
  changes as `<consolidated>`. It performs no search. The facade controls category
  order, chronological ordering, constraints first, and atomic delivery consumption.

  Enabled sessions receive both delivery kinds in every worker-mode combination
  (2026-09-08 supersedes the 2026-09-07 consumer matrix). A fork run still waits
  while a delivery it would read is pending; mode controls execution, not delivery.

  A fork Consolidation appends the range plus the exact list of facts to
  integrate, never the fact lines or the knowledge block again. The list is
  explicit because other paths and already-consolidated facts can fall between the
  range ends. Anything the conversation does not
  hold, a manual note or a fact dropped by a compaction budget, is fetched with
  `trace`.

  A fork Noting appends control material only (25a): the range, the head turn's
  final reply and the source-address index. It adds no knowledge block, no
  historical-fact block, no fact index and no Raw view — the foreground it inherits
  already carries the injected knowledge and the `<noted>` receipts of earlier runs,
  and those receipts are the same bytes a subagent's history block would show. A
  fork that falls back to a subagent sends the complete subagent material — history
  within 10,000 tokens and tier-1 Raw within 10,000, independently capped — and is
  priced on it.
- Source identity is `(Trace Memory session, native session lineage, Pi entry id)`.
  The host reconciles completed messages from the selected persisted ancestry on
  attach and at safe subsequent boundaries. Pi runs `message_end` extension hooks
  before `SessionManager.appendMessage`, so a completion event alone supplies no
  entry identity. Streaming and thinking-only content, custom/plugin messages,
  compaction summaries and worker messages are not source entries. Repeated text
  is never deduplicated. Earlier native history is imported on attach, known
  identities are reused, and missing native parents or owning user messages are
  reported in the UI. No replacement source is invented.
- Each completed entry owns a Turn. An assistant entry persists its tool-call
  occurrences immediately; a subsequent tool result is a separate source entry
  using the same stable Turn tool ordinal. Original messages, arguments and results
  are retained. `trace` with `full: true` retrieves the original tool argument and
  result strings, whatever the envelope carries. An explicit `trace` without `full`
  is assembled from that Turn's selected source entries under the tier-1 entry view
  (ticket 23b), so a branch's own occurrences are what a bound read shows; pagination
  retains its existing protocol.
- Every eligible persisted entry completion checks the active branch's queues at
  reconciliation; the unchanged native leaf-id guard keeps streaming updates O(1).
  `noting.triggerTokens` defaults to **10,000 compressed-view tokens** measured
  with `renderEntry` over `pendingEntries`, including separators. Original Raw size,
  entry count and answered Turns do not trigger runs. Excluded sources contribute nothing.
- `noting.batchTokens` defaults to **10,000** (ticket 20; it was 50,000 through 17b): the oldest
  contiguous whole-entry prefix, without Turn boundaries. An entry is never skipped so that smaller
  later entries can fill the remaining space, and a partly filled batch is valid. Excess waits for
  another eligible completion.
  This is also the one effective Raw ceiling compact measures its pending views against; there is no
  second Raw knob. The effective batch also reserves instructions, knowledge, tools, output and the
  existing context: the host uses the model context window with a 15% estimation
  margin and reserves its output limit. An oldest entry that cannot fit remains
  pending with a capacity notification. Unknown model capacity also leaves work pending.
  Native fork context is additional to the new-material budget and is never compressed.
- `consolidation.triggerTokens` defaults to **5,000 rendered fact tokens** and
  `consolidation.batchTokens` to **10,000** (ticket 20). Both count the same rendered fact view —
  the fact line with its relations and the joining separator — the trigger over the whole applicable
  unconsolidated set, the batch over the oldest-first whole-fact prefix it selects. Historical facts
  and knowledge contribute to neither. Committed facts are eligible
  immediately, even from partly recorded Turns. Selection takes applicable facts
  without Turn grouping; path-aware per-fact progress is unchanged. There is no
  first-Noting gate and no scalar fact cursor. An oldest fact larger than the batch ceiling stays
  pending with a capacity problem rather than being clipped or skipped.
- `consolidation.triggerUnconsolidatedFacts` is **removed** (ticket 20). Any layer that still supplies
  it fails the load with `Removed setting consolidation.triggerUnconsolidatedFacts: use
  consolidation.triggerTokens (tokens, not a count)`; an old fact count is never reinterpreted as a
  token budget. The menu never offers it: the menu edits mode/model preferences and closed-session scope only,
  and the advanced keys live in the settings files.
- `render.stdoutHeadTokens`, `render.stdoutTailTokens` and `render.stderrTailTokens` are **removed**
  (ticket 23). They budgeted a stdout/stderr result shape Pi never produces, so they were never
  effective on any Pi run; a layer that still supplies one fails the load with `Removed setting
  render.<key>: use render.toolCallTokens (one budget for the whole tool call)`.
- `render.commandTokens`, `render.reportHeadTokens` and `render.reportTailTokens` are **removed**
  (ticket 23b) with the same message and the same replacement. They shaped the per-tool branches of
  the explicit Turn preview; that preview is now the entry view under the tier-1 profile, and `full`
  renders the stored evidence uncut, so neither has a budget of its own.
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
- Compaction reconciles persisted source entries and asks core to escalate over that
  frozen snapshot (see **Compaction tiers** below). For tiers 1 and 2 the adapter
  returns the prepared text as `compaction.summary`; for tier 3 it returns nothing at
  all, so Pi runs its own compaction. `firstKeptEntryId: ""` retains no old Pi
  messages: the facade block replaces the context. Pi 0.85.0's context builder
  searches for that id, finds none, and keeps the compaction plus later messages.
  Successful compaction is then recorded as a `compaction` turn; it receives no facts.
  Pre-reply compaction returns project injection without allocating a session.
- Main-agent registration and subagent requests use the exact same four definition
  objects, with façade descriptions and schema objects. Pi execution fields are
  non-enumerable so provider serialization includes only the shared metadata. `trace({address,
  tool, full, cursor, cap})` and `search({query, layer, cursor, cap})` read session-visible
  evidence without visibility restrictions; `note({facts})` writes facts and `memory({operations, skipped})` writes
  knowledge; every knowledge operation carries its own `supports` evidence and a
  `reason` commit message, and create/update/merge also carry the revision's complete
  `topics` label set, whose schema core owns. Main-agent executions call `tools(context)` with kind `manual` and
  the current session, branch and turn. Writes commit immediately; `tool_result`
  records each raw call once. No prompt asks the main agent to maintain memory.
- `/trace` opens the native menu described below, or prints status and the command
  forms when there is no dialog-capable UI. `/trace on` and `/trace off` change this
  memory session's participation. `/trace project <name>` declares the project, saves
  host state and displays refreshed injection. `/trace mark K<n>[@<commit>]
  verified|flagged|clear` marks a knowledge revision. These are user commands; the
  former model-facing `mark` tool is removed. `/trace catchup` and `/trace stop` (18b)
  start and cancel the manual finite drain described below.

## Executor slots, claims and shutdown

Each enabled active Pi runtime is an executor with one Noting slot and one
Consolidation slot, including borrowed tasks. Each eligible entry completion checks
free slots. Own eligible work has priority under the normal thresholds and branch
pending-delivery gates. If no own task can be claimed, one enabled normally closed
target with a nonempty phase queue may use that slot, even for one entry or one
fact. `closedSessionScope` controls both phases: `project` (default) requires matching
project ids, `global` permits any project, and `off` leaves closed tails pending.
An executor must itself be enabled and open. This setting does not restrict
current-session work, manual current-session catchup, or explicit reads. Closed targets are ordered by oldest pending entry/fact allocation id, then
session id and branch name; sibling paths never combine into one writable range.
Failed claims may try another target. Completion only releases capacity; it never
launches another batch. New own work does not preempt a borrowed worker.

The facade shares the threshold/delivery predicate with host preselection and
rechecks eligibility during atomic admission. A SQLite claim excludes other
workers of the same target phase across branches, hosts and processes. It records
executor id, a random token and a thirty-minute expiry; no transaction spans a
provider request. Commits require the current unexpired token and target enrollment.
Borrowed commits also require a closed target and an enabled, open executor. The
scope is frozen at admission; under `project`, the two sessions must still share a
project at commit. Target project changes remain fenced under either scope.
Release compares token and executor.
Pi supplies the executor's memory-session id so external disable is rechecked at
admission and commit as well.
Borrowed work uses subagent mode and the configured phase model, with `session`
resolved from the executor's model. Its target project, branch and evidence freeze
before launch; a later project change rejects the commit. All business results,
usage, run records and deliveries remain attributed to that target.

Normal shutdown marks only the executor's own memory session closed. Restore clears
the mark and immediately reserves new tokens for that executor in place of another
owner's claims. The next eligible completion can consume them under normal
thresholds without waiting for the old worker. Old commits/releases are fenced.
Resume also takes abandoned own claims from a crashed runtime; ordinary tree
navigation does not change worker ownership. Restoring launches no extraction.

Shutdown/session replacement performs this sequence:

1. Stop admission; invalidate owned tokens before aborting model calls and retry
   waits. Close bound tools so cancellation cannot permit a late write.
2. Allow one five-second cleanup deadline across both slots. SQLite busy waiting
   is disabled for teardown, so lock contention reports errors promptly.
3. At the deadline close bindings and finish local worker waits, retaining available
   request/usage and cancellation diagnostics. Consume late provider failures.
4. Release claims conditionally, mark the own session closed, and close SQLite.
   Borrowed targets keep their closure state.

A commit that wins before cancellation stays successful. Cancellation that wins
first preserves the pending batch. No committed batch is restarted to obtain a
final reply. Audit/cleanup failure is reported without changing a committed result
or delaying exit indefinitely. Unknown cancelled usage renders as `cost unknown`;
partial usage identifies known cost only. Session spend totals sum returned counters
and cannot recover unknown provider charges. If SQLite is locked or unavailable,
closure/audit writes can fail; the host reports them and still closes. The absence
of a persisted closed mark is never repaired by guessing.

The runner wires its per-worker `AbortSignal` into the child `AgentSession`: an abort calls
`session.abort()`, which stops the in-flight provider request, interrupts a retry backoff and
leaves the parent session and any sibling worker untouched. Only the child runtime and its
subscriptions are disposed. No provider-global cancellation or foreground cancellation is used.
A provider that ignores cancellation may keep its remote request alive, but cannot hold local
shutdown past cleanup or write through disposed tools.

## Enrollment and native menu

One enrollment switch belongs to each memory identity. New native sessions whose
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

Disabled sessions ingest nothing, inject nothing and start neither worker. Manual
`note` and `memory` reject with `/trace on`; `trace`, `search` and status remain
available even before allocation. Compaction and tree hooks return no plugin
override so Pi proceeds with native context handling. Stored Raw, facts, knowledge,
runs and knowledge scope stay intact; other sessions still see shared knowledge.
Already-injected text remains in context. Unseen deliveries remain unconfirmed.
The transactional commit checks reject late business writes and leave their batch
pending; a batch committed before disable remains successful. Disabling this
executor invalidates its tokens and cancels active model calls and retry waits.
Another executor still rechecks the disabled target inside its commit transaction.

### Commands, menu and global settings (24b)

The direct command forms are exactly these, and nothing else acts:

| Form | Behaviour |
|---|---|
| `/trace` | Opens the menu; without dialog-capable UI (`-p`, rpc) prints status and this table's forms |
| `/trace on` / `/trace off` | Enables or disables **this** memory-session identity, at once, without a reload |
| `/trace catchup` / `/trace stop` | Start and cancel the manual finite drain described below |
| `/trace project <name>` | Declares the project after the first assistant reply |
| `/trace mark K<n>[@<commit>] verified\|flagged\|clear` | Marks a knowledge revision |

`enable`, `disable`, `status` and `runs` are **retired without aliases**: status and
runs live in the menu's Current session, and a headless bare `/trace` prints status.
A retired spelling, an unknown word or a malformed argument prints the usage above,
names where the retired function went, and changes nothing — no enrollment change, no
project declaration, no mark, no worker. The four retained forms exist because `-p`
and rpc sessions have no menu (parent 24, amendment 1); they are documented forms of
the same operations the menu performs, not hidden aliases of a menu entry.

Bare `/trace` opens four native dialogs:

- **Current session:** the status text (enrollment, 24a's pending counts, deliveries,
  runs, spend, catchup state, fork suppression) as the dialog's own title, then
  `On`/`Off` with confirmation and shared fork/clone scope, `Runs` with a count input,
  `Project` with a name input, `Mark` with an address input and a kind selection, and
  `Retry fork` only while this session is automatically downgraded.
- **Catch up:** starts (or reports) the manual finite drain described below.
- **Stop:** cancels this executor's background work, including a running or
  waiting catchup. It never changes participation.
- **Settings:** the global preferences below.

Cancelling any dialog or input changes nothing and makes no model request. Menu and
command paths call the same functions, so validation, confirmations and core's own
rejections (an ambiguous mark address, a project without an assistant reply) are
identical from either. The catchup handler starts the cancellable drain and returns
immediately, so stop can be invoked while it runs.

#### Global preferences

**Ticket 18a's read-only settings menu is superseded.** The menu no longer lists every
effective key with its source; it edits these preferences:

| Preference | Choices | Key | Default |
|---|---|---|---|
| Noter mode | fork / subagent | `noting.forkModeDefault` | fork |
| Noter model | Follow foreground / an available `provider/model-id` | `notingModel` | `session` |
| Consolidator mode | fork / subagent | `consolidation.subagentModeDefault` | subagent |
| Consolidator model | Follow foreground / an available `provider/model-id` | `consolidationModel` | `session` |
| Closed-session scope | off / project / global | `closedSessionScope` | `project` |

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
them, the host's model selection follows them, and core's mode booleans and
`closedSessionScope` are replaced through the façade's `configure`; other core keys
are refused there. A task already running keeps its admission scope, mode, model,
evidence and budgets. Setting scope to `off` does not cancel it; use Stop to end
running work. Another Pi process sees the new
global default through its own settings load; there is no cross-process watcher.
Editing a setting starts no worker and does not touch the cache-miss latch.

All configuration layers validate before use, including masked values. Unknown or
removed keys fail by name. Counts and token limits require positive safe integers;
`maxToolRounds` retains its documented zero-unlimited sentinel, and `nearThreshold`
is a similarity in [0,1]. Mode settings require booleans. Impossible view capacity
still fails with a capacity message and retains pending sources. Changing `dbPath`
requires reloading the extension. A disabled session's footer is the compact
`🧠 ○ off` line (24a); Enabled but idle keeps the dim hollow indicator and its counts.

## Compaction tiers and the post-compaction boundary (20c)

`session_before_compact` reconciles persisted history, then asks core to escalate over
one frozen read snapshot of every pending entry on the selected path. Rendering never
changes that set: compact takes no claim, waits for no worker, starts no worker and
advances no progress, so a Noter finishing concurrently can make the snapshot redundant
but never incomplete. `memory.compact(...)` returns a tier rather than a string:

| Tier | When | What the adapter returns |
|---|---|---|
| `primary` | every pending entry's normal shared view fits `noting.batchTokens` and the framing fits `render.episodicBlockTokens` | the text, as `compaction.summary` |
| `secondary` | the tier-1 views miss a cap but the tier-2 views of *all* the same entries fit | the text, as `compaction.summary` |
| `native` | not even the tier-2 views fit, or an entry's minima exceed the tier-2 `E` | nothing at all, with a reason naming the cap and the overage |

Tier 2 is the same entry renderer under the tier-2 profile (ticket 23, superseding 20c's
separate compact-only renderer and its version constant): `render.secondaryToolCallTokens`
(100) and `render.secondaryEntryTokens` (1,000). It is deterministic local work: entry order,
the source addresses, user boundaries and the non-text placeholder are preserved; each tool
part keeps its name, its `T<id>#t<n>` address and, for a result, its status, and shows what
the tighter budget holds of its arguments or result; text is cut with the same
`[... N characters truncated]` marker tier 1 uses. The block title names the
view version and both numbers of the profile. It is never a Noter's input and never a token
counter's input — those keep using tier 1 — and no view or summary becomes a source entry, a
fact or a processing receipt.

Tier 3 is the one place where compaction reaches a model, and the call is Pi's: the
adapter declines the custom replacement and Pi's own compaction runs, succeeds, fails or
is cancelled under its own outcome handling. The adapter manufactures no summary, appends
no oversized block to Pi's result and starts no extraction flush; an unused custom summary
prepared before the fallback confirms no delivery and no initial injection. The tier used
and its reason go to a `ui.notify` info line and to a `Compaction:` line in the status text
(the menu's Current session, or headless bare `/trace`).

**Post-compaction worker mode.** A compaction entry that Pi persisted on the target's
selected ancestry — whatever produced its summary — is the boundary. A request to compact,
a failed or cancelled attempt and a compaction on a sibling path establish nothing, by
construction: Pi writes the entry only on success, and only on the path it happened on.
After such a boundary, a Noter whose frozen entry set contains any entry preceding it runs
as a fresh subagent child for the whole batch, because a fork would inherit a context those
entries are no longer in. The check is made from `sessionManager.getBranch()` at admission
and again at the actual launch, so a task prepared before the compaction but held for a
slot, a claim or native readiness is caught too; nothing is cached, so reopening and tree
navigation give the same answer. A fork already running against its own frozen context is
never restarted, replayed or cancelled for this. It is a per-task evidence-readiness
decision, not the cache-miss latch: the requested/configured mode is preserved in the run
record, the actual `subagent` mode and a `pre-compaction evidence: …` fallback reason are
recorded, and enrollment, configuration and fork suppression are untouched. A batch whose
entries all follow the boundary uses the normal configured mode.

## Manual catchup and stop (18b)

`/trace catchup` operates on the current enabled session's selected branch, not
every closed session. Handler order: require enabled (reject with the enable
instruction otherwise, never silently enrolling); reconcile available native
history (17a); freeze the target as the highest currently-pending source-entry id
(`undefined` when nothing is pending) plus the exact set of currently-pending
fact ids. An empty target completes immediately with no model call. Repeating
`/trace catchup` while one is active reports its current state instead of
starting a second one or extending its snapshot.

The drain runs successive bounded Noting batches — ignoring `noting.triggerTokens`
and `consolidation.triggerTokens` but not `noting.batchTokens`,
`consolidation.batchTokens` or model context — against the frozen entry-id boundary,
then successive bounded Consolidation batches against the frozen fact-id set
extended with every fact those Noting batches went on to produce, until the frozen
target is exhausted. (Ticket 20 superseded 18b's single Consolidation call on
2026-09-08: with a 10,000-token Consolidation batch ceiling, one call can no longer
be assumed to cover a frozen target.) Both phases always run in subagent mode. Batch-to-batch
chaining happens only inside this host-local controller (`driveCatchup`), which
is the sole exception to 17b/17c's no-completion-chaining rule; ordinary entry
events never expand the frozen target or start a second scheduling loop. The
core façade enforces the same boundary through an optional `boundary:
{maxEntryId, factIds}` on `noting`/`consolidate` input, so a host bug cannot
silently widen what a bounded call is allowed to see.

The drain reuses 17c's one Noter slot, one Consolidator slot and one target
phase claim per executor — no second queue, worker pool or claim table. An
occupied local slot or a live foreign claim on the same target shows Waiting
and is retried only when that slot next releases or the next ordinary eligible
entry gives the executor another opportunity; there is no polling timer.

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

The registry is used to resolve a configured `provider/model-id` only; nothing in this
adapter calls a model. Noting and Consolidation run in a child `AgentSession`, which executes
the model's tool calls through the run-bound façade tools and continues until the model stops.
Consolidation's first valid `memory` submission returns review guidance, delivered to the child
as a native user message queued with `deliverAs: "steer"`; the second valid submission commits
in the same child session and run. Rejected batches can be corrected through further tool
rounds.

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
consolidation continuation, incremental raw, compaction, explicit project attribution, deliveries
on branch return, frozen in-flight ranges, duplicate noting/consolidation calls, provider
failures, and absence of Pi imports in core.

## Manual verification in a real Pi session

Use an isolated database so the observations are easy to inspect. To share a
project, run `/trace project <name>` after the first assistant reply; marker files
are ignored. Launch Pi under Node with the extension explicitly selected:

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
   entry audit and exact progress. Deliveries are confirmed only after a prompt
   takes them and settles. Invalid model output may bounce; inspect the run result.
4. Run `/compact`. Expect immediate compaction with `<knowledge>` and `<episodic>`,
   pending compressed Raw views, recent facts, and no compaction model request. The
   notice names the tier that was used. To see the other two tiers, set
   `render.episodicBlockTokens` low enough that the pending views no longer fit
   (tier-2 views, labelled `Raw (tier-2 entry views, <version>, tool call budget …)`) and then low
   enough that even those miss the cap (native delegation, where Pi runs its own
   summarization call and writes its own `compaction` entry).
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

A rejected first body throws inside `onPayload`, before anything is sent: nothing is billed,
the same run continues in a fresh native child with the full fresh-context material, and it
records `mode: subagent`, `requestedMode: fork`, `response.fallbackReason` and the rejected
gate result (both hashes and the differing path) under `verification.native`. Missing or
unsupported captures have a reason but no fabricated comparison or hashes. Notification happens
once per Pi session. A later round mismatch fails that round with no fallback; the record
retains the last request actually sent and the failed comparison, and a prior committed batch
stays committed. Provider failures after a passed comparison stay fork failures; they never
trigger another billable call.

Fallback keeps the run honest: it accepts the actual returned `mode`, records `requestedMode`
beside it, and preserves `verification`/`fallbackReason` in the response envelope. Since 19b
the fresh-context material comes from the same frozen task as the inherited increment rather
than from a second core string, so a fallback cannot send range-only context or falsely record
fork mode.
No store schema changed.

## Message binding (20a)

This adapter composes no domain text. Core prepares both representations of one frozen task and
this host only binds them to native messages (user ruling 2026-09-08; `compose.ts` and its test
were deleted with the layout that lived in them):

- **Inherited context (`fork`)**: `${input.prompt}\n\n${input.text.inherited}` as the appended
  user message. A fork has no system slot of its own, so the instructions ride in that message;
  core's increment is the range, the head turn's final reply and the source index (Noting) or the
  range, the exact fact list and the review cues (Consolidation), because the raw turns, the
  delivered facts and the injected knowledge are already in that conversation (user ruling
  2026-09-06 08:53).
- **Fresh context (`subagent`)**: `input.prompt` becomes the child's system prompt and
  `input.text.fresh` its first user message.

Choosing the representation is this host's decision, made from the native context capability it
actually has; the titles, block order and separators inside the text are core's, pinned in
`tests/core/render/material.test.ts`. Consolidation's review guidance is still read back from the
`memory` receipt with core's own `input.reviewFeedback(result)`; the adapter only chooses how to
put that message in front of the model (here: a native user message queued with `deliverAs:
"steer"`).

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
- **Task delivery.** The text core prepared is the child's user prompt; the
  Consolidation review answer is delivered as a native user message queued with
  `deliverAs: "steer"`, so the two-submission protocol in core is untouched.

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

A fork that cannot be prepared records `requestedMode: "fork"`, run `mode: "subagent"` and
`fallbackReason: "native runner: <reason>"`, warns once per Pi session, and continues on the
fresh child without a second billable attempt (nothing had been sent). If that child cannot be
constructed either, the run fails with both reasons; nothing is committed and nothing advances.

`agent.onPayload` is wrapped (the extension runner's own handler is still called): the first
body is checked against the captured parent request with `verifyForkRequest`, appended messages
being everything past the captured message count. Later rounds are checked the same way against
the previous round. A rejected first body throws inside `onPayload`, **before** the request
leaves, so the task continues in a fresh native child with `fallbackReason: native runner: …`
and the rejected result under `verification.native` (both hashes and the differing path).
Nothing is billed twice.

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
consumes a delivery or calls a provider. Compaction and shutdown also launch nothing;
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

File-based project discovery has been removed. `.trace-memory` files and directories
at cwd or any ancestor are ignored, including the default data directory. New
sessions remain private even when their cwd, clone or worktree is shared. Existing
stored project assignments are retained; their provenance does not trigger discovery.
An explicit `/trace project <name>` saves the project name and current project ID
in the Pi custom state and returns the updated injection immediately in the command
notification. The database declaration remains authoritative when restoring older
tree state, so a session's command declaration wins on every branch. Peers remain
in their existing project. Only an undeclared own space is merged.
Facts change project membership through their session join; session knowledge
retain scope, ownership and revisions while their project ID follows the
session. Duplicate project knowledge now share the next consolidation's NEAR pool;
merge itself neither consolidates nor deletes duplicates.

An empty text content block is not an assistant reply. Nonempty text, thinking,
or a tool call permits allocation; the tool-call case permits `note` or `memory` as the
first assistant action. A prompt, compaction or tree event without such a reply
creates neither a session row nor a turn row. Project records may precede replies.

The host tests cover ignored files/directories at cwd and ancestors, private
sessions in a shared directory, explicit same-name project sharing, persisted
project assignments, retroactive merge and immediate
injection, session-knowledge isolation, shared duplicate visibility, deferred noting
completion with later raw and branch-only delivery, fresh subagent notings,
failure/unavailable models, sibling exclusion, and empty/tool-only replies.

## Retries

Retrying is Pi's, not this adapter's (19c gate 6). The child `AgentSession` retries with the
policy its `SettingsManager` reports from `settings.json` (`retry.enabled`, `maxRetries`,
`baseDelayMs`, and `retry.provider`), the same policy Pi applies to a foreground turn.
Transient errors (429, 5xx, overloaded, timeouts, fetch failures) back off exponentially;
other errors fail at once. A retry re-runs the assistant turn only: tool execution and commits
happen after a reply, so a retried call never repeats a write. The adapter subscribes to Pi's
`auto_retry_start`/`auto_retry_end`, records the attempts in the run record, shows the warning
indicator while one waits and posts one notice per scheduled attempt.

## Run records

Every Noting, Consolidation and manual write leaves a row in `runs` with the
exact last provider request, the final output, summed usage, the tool-call
sequence, fetches and problems. `trace R<n>` renders a run as a summary (kind,
outcome, range, model, mode, what it created, usage, cost, tool counts,
problems); `full` adds each tool round and cut previews of the raw request and
response. The menu's Current session > Runs lists the session's last n runs, with a
count input (the `/trace runs [n]` subcommand was retired in 24b).

## Footer status item

Background runs never enter Pi's session totals: Pi only counts entries of the
session file (assistant messages, tool results and summaries carrying usage).
The host therefore publishes one footer status item through
`ctx.ui.setStatus("trace-memory", …)`, the shape the ponytail extension uses,
which a statusline extension renders as a segment:

```text
🧠 <indicator> notes: 24->102 memory: 15->54 cost: $0.12
```

Every number describes the current memory session's **selected branch and head**
(24a). The two arrows are stage inputs and existing outputs, not percentages and
not expected model-request counts:

| Field | Left of the arrow | Right of the arrow |
|---|---|---|
| `notes` | imported source entries no Noting run has committed yet | every committed fact applicable on this branch, already consolidated ones included |
| `memory` | those applicable facts Consolidation has not taken on this path | applicable current knowledge, counted in current-tip units, so two divergent tips of one identity are two items |
| `cost` | — | this session's cumulative memory-run spend at the model's configured API rates (Pi's own cost formula) |

A disabled session shows the compact line `🧠 ○ off`, with no counting at all;
the stored counts and diagnostics stay available under Current session, which
also prints them as a `Pending:` line. A value that cannot be read is `?` — an
unknown is never a fabricated zero — and a Pi session that has not yet allocated
a memory identity shows `notes: ?->? memory: ?->? cost: $?` and says so in its
status details rather than claiming four zeros.

The counts describe **imported evidence**. A disabled interval may hold native
history that was never imported, so a zero is not proof that every available
native message has been processed; enabling imports the paused interval through
the ordinary path and the counts then say so. Work stays pending until its
business commit: an admitted or running batch is still pending, a precommit
failure or a cancellation advances nothing, and a provider failure *after* the
commit restores nothing. A nonzero queue below its token trigger is idle, not a
failure and not a request to drain.

`cost` is this session's cumulative memory spend and nothing else: work another
executor performed for this session counts, work this executor performed for a
borrowed session is charged to that session. A statusline's own daily aggregate
is a separate number over other sessions and the foreground; the two are not
added together and this one is not today's total.

The indicator is a Pi theme role, never a literal colour, in one precedence: off,
active retry, running Noting, running Consolidation, last failure, last warning,
idle. If both phases run, Noting is shown.

| State | Indicator | Theme role |
|---|---|---|
| Off | `○ off` | `dim` |
| Enabled, idle | `○` | `dim` |
| Noting running | `●` | `accent` |
| Consolidation running | `●` | `success` |
| Retrying, blocked on a launch condition, or committed with problems | `●` | `warning` |
| Last task failed | `●` | `error` |

The indicator describes this executor, including while it works on a borrowed
target; the counts and the cost stay this session's. Where colour support is
absent the same line is printed unpainted. Merely staying below a trigger never
turns it yellow, and colour is not the only way to find a condition: status
details explain warnings, the actual fallback mode and the target of active work.

A refresh costs a status refresh. The four counts are one core progress query
over one path snapshot (22a) and the pending-entry identities (22b); it renders
no Raw, tokenizes nothing, freezes no task and loads no run audit body, and
spend projects usage in SQL. There is no timer and no polling scheduler: the
existing lifecycle, commit, control and status points refresh it — session
start and restore, tree switch, `tool_result`, `agent_end`, `agent_settled`,
every phase admission and settle, a scheduled retry, a run's outcome, and the
enable/disable/stop/retry-fork controls. Streaming `message_update` deltas do
not. Another connection's commits therefore appear at the next refresh.

`/trace` prints the session's breakdown by run kind. Tree switching contributes
no extraction usage to Pi totals.

## Fact presentation

All newly composed fact injections use the same chronological Turn groups: Noter history,
Consolidator history/current facts and review cues, `<noted>` deliveries, compaction, and branch
carry. A heading such as `[T42] 2026-09-09T10:30:00Z (selected facts)` is followed by facts in
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

- A queued (steering or follow-up) user message bypasses `before_agent_start`, so
  noting results that finish during such a message are delivered at the next
  ordinary prompt. Confirmation state is kept per agent run, so nothing is lost.
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

`render.toolCallTokens` (`B`) defaults to **300** with a hard ceiling of **1,000**,
rejected above it; `render.entryTokens` (`E`) keeps its 17a **10,000**. The
compaction tier-2 pair is `render.secondaryToolCallTokens` (**100**) and
`render.secondaryEntryTokens` (**1,000**). All four are positive safe integers
through the existing flat configuration, are configuration rather than per-batch
decisions, and count the rendered text of the part or the entry — label lines, key
names, separators and every marker included. Inside `B`, arguments and the result take
one half each (23c, superseding 23a's quarter and three quarters on the measurement that
the quarter cut 218 of 337 bash commands while three quarters still cut 573 of 835
results): arguments are rendered before their result exists and views are immutable, so
the split is fixed. Allocation is two
staged: `B` caps each tool part first; if the entry is still over `E`, tool parts
give way, shared fairly down to their label-plus-marker minimum; only when they
are all at the minimum does the text part yield, head and tail. A rendered part
never exceeds its allocation, the entry never exceeds `E`, and no part is emitted
empty or shorter than its minimum. Excerpts retain head and tail, including within
one huge line or JSON value, and never cut inside a surrogate pair or a JSON escape
sequence. One marker family states the count of omitted characters —
`[... N characters truncated]`, and `[... N characters of details truncated]` for
dropped structured data — and the honesty clause "the omitted middle was not inspected"
is stated once in the Noter prompt instead of in every marker. `trace` with `full: true`
is the same renderer with no budget: the same labels, the stored arguments and result
text uncut, each native occurrence of a call as its own entry, and its read scope
unrestricted whatever branch the reader is bound to (17a). A budget too
small for an entry's labels and markers reports a capacity error and leaves the
entry pending (compaction escalates a tier over it).

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

Noting freezes entry identities on the selected path, not whole Turns. A
successful zero-fact run processes only its selected entries; later entries in
that same Turn remain pending. Address aliases are interpreted against the frozen
entry set. A later matching source occurrence makes that address ineligible for
the earlier writer, even if an unrestricted trace fetch can read it. Run records
include `entryAudit`: native identities, owning Turns, frozen branch, view-budget
version and values, and the exact omission markers. Entry processing, facts, run
audit and applicable deliveries commit atomically. Rejected or failed work remains
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
`consolidation.batchTokens` and both view limits accept only
positive safe integers.
