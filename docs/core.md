# Core reference

`src/core/` is host-agnostic: it must not import any host SDK.

## Current facts and reads (93/118)

The [fact-slice and entry-reading contract](unified-entry.md) is the current public reference. It supersedes the historical source, rendering and address forms recorded in the numbered ticket sections below.

- Each new `note` call writes one fact with a single-line `title` and one nonempty top-level `sources` string. Each source segment starts on a line with `[T12#E3@user] ` (the role suffix is optional) and may continue across lines; text before the first marker is rejected. Core parses the markers, trims each segment's trailing whitespace, orders segments by the selected path, joins their bodies, derives source roles and assigns the earliest source Turn. Duplicate resolved entries are rejected. Every writer is held to the length target (144; counted in units since 145, see `CONTEXT.md` Length target): the title at `writing.titleWords` (20) and the body, its segments counted one by one and summed, at `writing.bodyWords` (200); a check refuses only above 22 and 220. Windows charge the full rendering in tokens.
- Model reads use `trace://<layer>/S<n>[/T<t>]`, with knowledge, compact, facts and raw layers. Facts show contributed segments and uncovered-entry paths; raw is the compressed overview, with raw-only `#E<k>` for one full entry and `@role` for filtering/checking. `trace://S<n>` lists every Turn newest first, one line per Turn with its id, UTC start minute, source-entry count, nonstandard kind and earliest contributed fact title. Additional facts add `(+m)`; legacy facts use their heading, and titles are cut to 80 characters with `…`. Factless Turns outside the selected ancestry show `(other branch)`, even if already noted. On that ancestry, they show `(not yet noted)` while any selected entry awaits Noting, otherwise `(no fact)`. Exact facts retain visible knowledge backlinks. Knowledge views and search show support titles; injection does not. Public trace registration, event ranges, comma lists and old path fallback are removed; internal source parsing remains.
- Public `@` selectors are only role filters. Block selectors, E-list shorthand, fact intervals, negation walks, `K..`, `trace.layer` and `trace.tool` are removed. Knowledge versions use tags or `@v` ordinals, not global commit numbers. Search retains its `layer` parameter.
- Legacy stored bodies, sources and metadata remain unchanged. Fact-body reads normalize sources to whole-entry addresses; missing bindings or inconsistent stored segments fail explicitly. Turn listings do not validate legacy bodies or bindings, so corruption cannot prevent navigation to the offending Turn. New facts still reject thinking-only evidence. Ordinary Turn views omit thinking; explicit full or entry Raw reads retain it.

Turn listings select sources and fact contributions in bulk, without rendering each Turn's facts view or hydrating Raw bodies. Counts and titles use the same contribution selection as facts reads: the reader's own branch/head for its session, otherwise that session's latest selected path. A Turn outside the preferred ancestry uses a containing source path with the highest entry high-water mark, then highest path id. An empty selected source path stays empty; orphan Turns use their stored entries without a branch binding. Fact titles reflect contributions in the displayed Turn, including facts spanning several Turns, rather than requiring the whole fact to apply there.

`trace://` is a navigation index, not a fact-body listing. After the guide, a bound reader sees its session, own branch/head and last 10 branch Turn ids; unbound readers omit that block. Knowledge directories carry visible-current and all-scope/history counts. Sessions with Turns are listed by newest activity, with host, project, Turn count and latest Turn's UTC start time; undeclared project names equal to the host identity display `no project name`. There are no per-fact `trace://F` lines, but exact fact reads remain available. Recursive Grep follows the knowledge directories and session Turn views, finding facts through their facts views without separate `trace://F` leaves.

The guide names Pi's `read` and `grep`, but only `Read` on Claude Code main sessions and fresh N/D workers. Claude Code main sessions have no Grep or Glob tool; ticket 137 removed the `trace://` hooks that never fired.

Ticket 137: the retrieval policy (`src/core/render/retrieval-policy.ts`) says when to look memory up, apart from the guide. One text, each host's own search tool name; with the guide it stays within 500 estimated tokens. It sits once in the system prompt of each run: a section `trace-memory-retrieval` that the CC plugin's `prompt.compose` function hook appends to the main session's system prompt (Claude Code 2.1.293 keeps a plugin MCP server's `instructions` as a message it may drop at `/compact`, so the executor sends none), a Pi prompt section set in `before_agent_start`, and the system prompt of a fresh Noter or Dreamer (`prompt`). Claude Code renders its system prompt once per session and again only at `/compact` and `/clear`, so the CC hook's answer (memory on, by the rule injection uses) takes effect at those points: a session turned on or off by `/trace` changes at its next `/compact`, and a new session whose first prompt still reads as not enrolled has the policy from its first `/compact` or `/clear`. Without the function module, a CC main session gets no policy.

Ordinary reads use host-native limits; offset/limit continuations use the original `trace://` path and render again without exposing backing paths or adding model-visible text. Session knowledge, compaction views and exact entries are whole on main sessions and Pi children; CC fresh workers retain SDK Read limits. One shared guide (at most 200 Core-estimated tokens) is emitted once per injection/material, never once per knowledge block. It is fixed framing outside the Knowledge, facts, Raw and shared selection windows; its actual bytes still count toward delivered text and model capacity. Read records no delivery or state. Search pagination is unchanged.

## Propagation data (154)

The store accepts fact objects and causal annotations now; Noter and Dreamer workspace formats and prompts remain unchanged until 155/156.

- **Fact objects:** optional names must occur case-insensitively in the body, not merely the title. Core trims names, removes case-insensitive duplicates while keeping the first spelling, and stores the authored list in `facts.objects`. `fact_objects(fact_id, name, object_key)` and its `(object_key, fact_id)` index serve `factsMentioningObject(name)` without scanning bodies. Old facts have no objects record and are not backfilled.
- **Relations:** `caused_by` accepts at most two existing fact targets and renders through the same relation renderer as `support` and `negate`. Causation is an annotation, never a trigger or an applicability rule. `support` remains accepted for the current writers; its removal from new Noter output belongs to 155.
- **Files:** each Store operation requires its own `files` property, including every split child. An array contains opaque code-file paths; `#` has no special meaning. JSON `null` means explicitly no code files; SQL `NULL` means no mapping record. A maintenance writer may explicitly pass `undefined` only when copying an unmapped parent. Omission is refused, and a create cannot pass `undefined`. Duplicate paths are removed exactly, without interpreting or resolving them.
- **Status:** `knowledge_file_verifications(revision_id, file, verified_commit, verified_at)` stores code-authored verification for a linked path. `setKnowledgeFileVerification`, `clearKnowledgeFileVerification` and `knowledgeFileVerifications` mutate/read it without a version. An update or archive whose explicit mapping equals its parent's copies verification; a different mapping, merge, split or create starts unverified.
- **Staleness:** `knowledge_stale_reasons(revision_id, reason, detail)` represents the flag by one or more reasons. Supported reasons are `negated_fact`, `file_changed`, `unresolved_check`, `unverified_file` and `missing_grounds`. `setKnowledgeStale` adds a reason, `clearKnowledgeStale` removes one exact reason/detail or all reasons, and `knowledgeStaleReasons` reads them. The final Noter transaction applies stage-4 flags as `unresolved_check`; no automatic scanner is introduced. Status changes affect neither applicability, rewind, scores nor version history.
- **Derived objects:** `knowledgeObjects(revisionId)` follows that exact version's parent and merged-parent ancestry, stopping at each split. It counts distinct cited facts per case-insensitive object, ranks by count descending, and breaks ties by object key. The returned spelling is the minimum stored spelling for that key. Nothing is stored on knowledge as authored objects.
- **Candidate text:** contentless trigram `knowledge_fts(title, text)` indexes every version, including archives and superseded versions. Version publication writes it in the same transaction. Migration backfills it once. `searchKnowledge(terms)` returns distinct knowledge ids for versions containing all literal terms across title and body, using indexed candidates and a real-column recheck; short terms use the same substring fallback as Raw. An empty term list returns none. Visibility belongs to the caller; public `search` retains its existing topics-aware contract.

Current writers author or inherit file mappings as follows:

| Writer | Files rule |
|---|---|
| Manual `memory` create/update/archive | Required array or `null`, authored by the caller; no file inheritance |
| Noter workspace create | Required explicit `files:` list or `None`; resolve relative paths from the session root and require existence |
| Noter workspace update | Required explicit `files:` list or `None`, with the same path validation; no inheritance |
| Noter concurrent update converted to create | Keep explicit paths or `null`; an unmapped base becomes `null` on the new identity |
| Dreamer curate/verify update/archive | Copy the exact base's mapping, including no record |
| Dreamer merge | Copy the primary parent's mapping; never union mappings implicitly |
| Dreamer split primary | Copy its parent's mapping |
| Dreamer split children | `null` per new identity |

Dreamer proposal reload restores an explicit `undefined` property lost in JSON, so an unmapped-parent copy remains explicit through the existing curate/verify handoff. Metadata-only maintenance uses an ordinary update with the parent's body and empty Dreamer supports; existing support inheritance copies the parent's facts. The pre-144 deployment revival runs before this migration and remains historical unmapped data; its versions are included in the FTS backfill.

The migration adds only metadata columns/tables and the FTS index, except for rebuilding the existing fact-relation CHECK to admit `caused_by`. It preserves relation rows and indexes, and runs inside Store's schema transaction and foreign-key check. Production deployment still requires an SQLite-backup-API backup and stopped executors; measuring a disposable production copy is not a deployment migration.

## Noter publication (92/04)

This contract supersedes the older immediate-Noting and NEAR descriptions below. Live Consolidation is retired; historical C records remain readable. The numbered sections retain implementation history, not permission to use superseded schemas or stages. In particular, ticket 02's `note({facts})`, `note({facts: []})`, immediate N commit and NEAR descriptions below are historical, not current tool guidance.

- The foreground `note` and `memory` tools are manual writers: each call carries one fact or one knowledge operation in top-level fields and commits at once; manual fact relations cite existing F IDs. Manual `memory` allows fact-backed create/update/archive (135); D's own `memory` takes one operation or one `{skip, because}` per call and commits each legal call at once; a refused one holds an `Mn` slot that blocks success until `slot` resubmits or `drop` withdraws it (127).
- N has no `note` or `memory`. Ticket 155 replaces its two tasks with four independent `runAgent` calls: `extract-facts`, `check-facts`, `write-knowledge`, `check-knowledge`. Their system prompt, tool schemas, compact-memory prefix and first message are identical; only the first `check` result carries the stage's instructions.
- Core pre-makes `facts.md` and `knowledge.md` templates. A stage owns only its deliverable: stages 1–2 write facts and stages 3–4 write knowledge. Before stage 2, code writes `related-facts.md` using object lookup and lexical matches of new titles and objects, including Raw FTS. Before stage 4 it writes `related-knowledge.md` using visible knowledge's derived objects and its full-text index, also querying knowledge-change titles. Lists default to 20 entries each, a dispatcher proposal awaiting maintainer confirmation.
- Check stages require a trailing `verdict: ok`, `verdict: edited — <why>` or `verdict: reverted — <why>` on every block, including `none`. Reverted blocks do not publish. Stage 4 may replace a duplicate create with `update K<id>`, update overturned knowledge citing the new fact, or write `flag K<id>` with a reason for Dreamer-only resolution. Flags set `unresolved_check` with detail `Noter check could not resolve` in the terminal transaction.
- The stop hook checks the current stage, allows one repair and makes its second failure terminal. A passed intermediate stage records only its audit and handoff (`commitNotingStage`); it owns no facts, knowledge or processed entries. The next admission resumes the failed stage from the last passed snapshot if its whole batch remains pending. Cancellation keeps the snapshot without counting a failure; a failure in any stage counts once. Only stage 4's pass publishes through `applyWorkspace` and `commitNotingRun`, together with frozen progress, flags and successful execution.
- New facts carry `objects`, `negate` and at most two `caused_by` annotations; new `support` is refused. Every Noter knowledge operation requires `files:`: conversation-named code paths or `None`, never implicit inheritance. Checks resolve relative paths against the session directory, else its start directory, refuse nonexistent paths and store absolute paths.
- Each check reports model responses and context growth against the stage's settings. Defaults: extract facts 10 steps/+15k tokens, check facts 8/+10k, write knowledge 8/+15k, check knowledge 8/+15k. A response with several calls spends one step. CC deduplicates native assistant response ids; Pi uses native assistant turn events. Growth is the latest response's input plus cache read/write minus the first response's input side. Budgets do not stop the agent. CC remains Sonnet and Pi follows the main agent.
- An applicable, authorized predecessor consumed by a visible effective descendant permits N's update-to-annotated-create conversion. Missing tags, invalid evidence or authority do not convert. The converted identity enters ordinary D pending accounting.
- Live NEAR capture, feedback and its configuration are removed. Historical audit types and reading remain. Explicit `noting.nearThreshold` configuration now reports a removed-setting error.

The [entry-address contract](unified-entry.md) supersedes older ticket descriptions below of Raw labels, source previews, trace content limits and full-read branch scope. It is the current reference for stable E identities, ordered normalized blocks, per-child budgets and semantic read completion.

- model/   Turn, Fact, Knowledge types and write-time validation (shape only).
- store/   SQLite: global ids, sessions, project attribution, facts, knowledge, knowledge revisions, run records.
- noting/    freeze the task material, provide tools, record the last provider request and final text.
- api/tools.ts  role-bound tools; atomic note/memory validation and commit; Dreamer's read-only check.
- dreaming/  freeze the session's Knowledge pools, provide maintenance tools, and record terminal pool consumption.
- render/  one renderer for noting material, compaction tail, branch summary, trace; XML injection blocks.
- render/material.ts  the shared material contract and the block layout of every consumer (20a).
- prompts/ noting.md, dreaming.md — the live stage prompts, each declaring the shared memory-model blocks it includes (`shared/model.md`, `facts.md`, `knowledge.md` — definitions; `admission.md`, `atomicity.md`, `evidence.md`, `grounding.md`, `identity.md`, `authority.md`, `protection.md`, `body.md`, `reading.md` — principles; `formats.md`, `live.md` — inputs) at `<!-- include: name -->` markers that `load.ts` splices in — the prompt texts, versioned by content hash in every run record. Lineage (kept out of the model-facing text): the Noter descends from pi-observational-memory's observer prompt, the Consolidator from its reflector plus Magic Context's historian and curate tasks; the six fact categories, the relation model (support/negate with confidence strength, annotations only), scope fidelity, and disputes are this project's own.

Model calls go through one interface, runAgent(input) → {outcome: success | failure | cancelled, output, usage, request}, where request is the exact provider request the host sent; hosts implement it (a fresh child; the Noter has no inherited-context mode, ruling 2026-10-22). Optional result fields ride along into the run record's response JSON: `verification`, `retries`, `audit`, and `nativeLog`, the absolute path of a host-side native worker log for the run (19a). The core never reads that file. 

**Core builds no provider message or body; core owns the domain text (ticket 19b, revised by the
user's ruling of 2026-09-08 in ticket 20).** `runAgent` receives structured task material and core's
prepared text, never a system or user message, a provider body, a message sequence or an SDK type:
the domain prompt and its hash, the frozen range and knowledge commits, the mode, the tools,
`reportRequest`, `entryAudit`, one `material` object of rendered, budgeted parts, `text` — one
prepared string, whatever mode runs the task (29b; the `{fresh, inherited}` pair is gone) — and
`supplied`, the identities that text actually carries. The host decides which message carries the
text; it lays out no block of its own and chooses between no representations. Noting additionally supplies `passEnd()`, the Noter's stop check (144): the repair or step-advance message, or nothing when the task is over; the host asks it after every normal end of a pass, and the step machine bounds the count (at most four passes per task). Historical NEAR receipts no longer run. Consolidation is retired.

**Audit availability.** A host that cannot expose a provider request returns
`audit: {available: false, reason}` instead of `request`; core records the limitation in the run
record and does not report a missing request. A host that returns neither a request nor that
declaration still gets the "runAgent must return the exact provider request" problem. The run
record's response also carries `requestedMode` beside the run's actual `mode`, so a fallback is
visible as requested-versus-actual.

## Automatic scheduling (141)

Both hosts check Noting and Dreaming after each persisted main-session user, assistant or observation entry, admitting at most one run per phase under the existing seats and claims. Subagent entries are excluded. A busy phase queues nothing; ordinary completion schedules nothing. The first entry after settlement checks afresh, so a tail left after the last entry waits for the next entry.

An import that persists new selected entries checks own N/D once after publishing the complete path, using the selected head after import as `headTurnId` and the newest persisted entry as `triggerEntryId`. This includes live imports and historical bootstrap: CC executor startup, Pi `session_start` restore and enabling memory, only when they actually persist new selected history. Fully imported restart/resume, zero-append scans and sibling-only imports create no opportunity. Pi tree switches never check, even when they import new history. Manual catchup freezes its own boundary; CC's function turn-end reconcile retains the turn-end check instead.

Noting uses the incremental pending count, stopping at its trigger. Dreaming retains a not-due result until a knowledge commit, restore or enrollment, or a change of `Store.progressSignal` (which includes coverage, the Dreamer's hand-off and failure rows and the latest score) re-arms it; Raw ingestion alone does not re-arm it. Failed automatic tasks retry at a later entry end; three consecutive business failures still disable memory. Explicit catchup retains its drain and completion checkpoints. Closed-session borrowing remains turn-end-driven. Thresholds, batch limits and project-declaration checks are unchanged.

## Dreamer execution

Dreaming (144, stage 4) maintains the quality and readability of the knowledge a session sees. It no longer keeps
knowledge inside a budget: nothing is archived to make it fit, and the pool budgets decide no trigger, success or
failure. One run is one admission, one claim and one execution of three tasks, in order, each through `runAgent`:
**curate**, **verify** and **classify**. Every task delivers a file that `check` verifies; the hosts' follow-up loop
and the tools are shared with the Noter's workspace files (`src/core/workspace/`).

**Trigger and coverage.** The pool identities are `global`, `project:<id>` and `session:<id>`. A version is *covered*
when `knowledge_processed` holds `(pool, revision)` for the pool that owns it, written by a passed curate or verify
pass (never on failure) for the versions its batches showed and wrote. At every main-session entry end (above) a run is
due when `Store.dreamingDue` says so: a hand-off row asks for a retry or resume, or `Store.noterOperations` reaches
`dreaming.triggerOperations` (30 by default). That count is the number of Noter `create` and `update` revisions that no
covered revision of their pool hides, each revision once, reached by walking back from the live items (the walk goes on
past a Noter revision, so a second update of one item counts again); manual and Dreamer revisions never count, so the
Dreamer cannot retrigger itself. A failure resets no count and sets no floor. The footer's changed count is the exact
number (`Store.noterOperations`), and the `/trace` Dreaming row shows it against the trigger as `n / 30 Noter ops`. One database-wide
Dreamer seat remains (the live claim). The claim lease outlives the execution backstop; a stale or lost claim cannot
commit, and cancellation closes every tool binding and workspace of the task at once (the cancellation fence), so a
late write or pass end changes nothing.

### Current revisions and write bases

Knowledge resolution is stateless. A revision's applicability depends only on its own direct
`supports`; parent and merge/split links are provenance, not recursively inherited conditions. A fact
is live when one complete cursor path of its owning session contains its Turn, every source Turn and
every bound source entry. A session without a cursor treats all stored paths as active.

Core first resolves one reader-independent valid branch for each identity. Among applicable
conflicting branches, the subtree containing the greatest applicable commit wins; each base is
consumed by at most one operation, a split consumes its source once, and a merge result is valid only
when selected at both parents. An older branch becomes current again when the later branch's direct
facts cease to apply. No validity state or restoration order is stored.

Visibility is applied only after that global current revision is selected. Session scope requires its
direct facts on the reader's active branch; project scope requires the fact owners in the reader's
project and their facts live; global scope requires its direct facts live. If the globally current
revision is outside the reader's scope, the identity is hidden rather than falling back. Archives
participate in current selection and then hide the identity.

An `update`, `archive` or `split` base must be the visible current revision on the writer's branch; a
`merge` requires its primary and every absorbed parent current in its authorized pool. The existing revival exception allows
an applicable archived primary to absorb an active item; it does not permit arbitrary writes
against archives. Resolution, claim validation and mutation happen in one transaction. Exact
historical reads do not make stale revisions writable.

### Operations and supports

N and manual writers may update a visible current tagged base; only the Dreamer may merge or split.
The Dreamer's files may also archive and create. Manual Knowledge writes expose
fact-backed create/update/archive; the retired Consolidation stage historically exposed only create.

An update accepts exactly one body form (135):
- **Full text:** `text` is the complete replacement; category, scope and topics remain required.
- **Exact edits:** `edits` is a non-empty array of `{old, new}`. Each non-empty `old` must occur
  exactly once in the exact tagged base body as it stands at that step; edits apply in order.
  An empty `new` deletes. A failed edit refuses the whole operation and names its position and
  zero/multiple matches, including overlapping occurrences.
- **Metadata:** omitted category, scope or topics inherit only with edits; supplied fields replace
  them under the existing rules. Inherited legacy categories remain unchanged, not reclassified.
  Supports and reason retain the role's existing requirements.

The complete result passes the same admission, supports and scope checks as a full-text update, and
the title and body length checks of every writer (144), applied to the resulting body, so updating a long legacy item must also fit. An update without `title` inherits its base's; a base without one requires it.
The Noter's file carries the complete result against the exact base it names.

Untitled legacy knowledge is never displayed as if its body's opening were a title (153).
A whole item's header shows `(no title)`, followed by the body on the next line.
Title-only delivery instead shows `(opening only) <opening>…`; standalone labels, including search
and bodyless trace views, show `(no title) <opening>…`. The opening keeps its existing
`writing.titleWords` unit target and `titleWords * 8` character bound. Authored titles are unchanged,
and token budgets charge the rendered markers and text.

The audited concurrent update-to-create conversion retains inherited legacy classification too;
ordinary creates still cannot author a legacy category.
Storage, Knowledge history and injection use complete revisions, never edit lists;
the original request remains in the human audit. Immediate update receipts carry the new tag and
pool item cost before/after without echoing the result body.

A merge joins identities of one scope and keeps the identity of the primary the call names, whether
older or newer (2026-10-22; no older-survivor rule, no swap); `id` is the primary, `absorb` lists one or
more other parents. A merge may omit `text`, in which case the latest exact parent's body is copied verbatim.
A split keeps the named item as its primary part: the call's own text (or `edits`) and fields are the
item's new version, and each child, one or more, is a new identity inheriting the item's scope and
recorded as split from it. The split item is not archived.

Evidence-driven maintenance stores the submitted direct facts. A trusted Dreamer maintenance
operation may submit empty `supports`; core materializes the parents' supports in the same commit:
`update` and `archive` copy one parent, `merge` takes all parents' union, and the split item and each
child copy the split parent. There is no system maintenance fact. Historical empty supports are repaired by the
schema migration in parent-before-child order; an all-empty ancestry remains empty.

### Tasks

**curate** runs one conversation for each **group**: the pool's live items are split into groups of at most 100 items
(`formGroups`, `src/core/dreaming/curate.ts`: largest category first, each category whole into the first group with room
by item count and by the model's input allowance, a category cut only when it fits no empty group), frozen as knowledge
ids in the hand-off (`detail.groups`). A group's first message is its prefix (every item whole, by category) and tells the
model to call `check`, whose first result lists the group's **batches**, at most 20 items of one category each, with one
file per batch, and carries the task's instructions (`prompts/tasks/curate-<pair>.md`, priced in the capacity check). Groups
curate and verify side by side; each group's verify follows its own curate, and classify follows all groups. A group's
failure does not stop its siblings. A run performs **one pair of operations** (146 ruling 13), alternating per project `update`+`archive` and `merge`+`split`
(`Store.nextCuratePair`, derived from the newest finished run that advanced it; a project with none starts at `update-archive`; the hand-off's `detail.pair`
repeats a failed run's pair on resume). The curate agent of a group decides item by item which operation of the pair to propose, or none, so proposals never conflict,
and checks each item against both operations' smell lists; verify is the same for both pairs. The agent writes the batch files in order, one block per item, of the run's two operations only (never `create`), and stops
once: the stop hook runs one final check over every file (a file never written fails it) and allows one repair. When the
conversation ends, whatever the outcome but a cancellation, each file that passes is **kept** in its run record as a
proposal and recorded as the batch's `run`; a resume does only the batches without one. A batch may act on any live item of
the session's pools. Nothing is applied before verify passes. A merge names its primary, which keeps its identity; a split keeps the named
item as its primary part. An archive is `invalid` or `inadmissible` with a statement. Files that fail the check
twice fail the group's curate. It reads the repositories of the session's directories like verify.

**verify** gives every proposal one verdict, in a second conversation with the same first request (so it reads the
cache curate wrote). Its change file numbers each proposal with its current and proposed text (a stale base is shown);
its file holds `## confirm <n>`, `## edit <n> <op> <K@v>` (same operation and target; body, title, category, scope,
topics and supports of what the change produces; omitted fields keep the proposal's) or `## revert <n>`. Its pass applies
the confirmed and edited operations in change order in one transaction: a stale base or an operation over the caps in
force now is refused for that operation and left for the next run. It makes no model call when curate proposed nothing,
and it writes coverage.

**classify** scores items 1 to 100 by what forgetting them would cost, in passes of at most 100 items, each in a fresh
conversation; the passes run side by side under one deadline. A pass is two steps: its file passes the check, the stop hook
sends the self-check message, and the file is applied once it passes again after the model's Edit. The pass whose commit
finds every other pass applied finishes the run. The set is fixed when the task starts: all items up to 100, above that the unscored and changed ones with
up to 30 scored items as anchors. A score is stored beside the version chain, for the version the scorer was shown, and
an item keeps its score when it changes. It makes no model call when there is nothing to score.

### Hand-off, retry and completion

A passed task writes a hand-off row, so a restart, a stop or a failure resumes at the first task (and, for curate, the
batches without a kept file) not done; coverage, applied batches and scores are written in the same transaction as the pass. A
failed run leaves its hand-off, so the next entry-end check is due and resumes there: no wait for a threshold, no
`waitFrom` floor, and the Noter-operation count is not reset. A failure counts toward switching memory off like the
Noter's (see "Final business failure" below). Each task has the wall-clock bound `dreaming.timeoutMs`
(1,800,000 ms by default, no tool-round ceiling), clamped by the execution backstop; expiry fences the task and fails it.
A run completes when classify has finished and no hand-off remains: the final classify pass (or the no-work classify) commits
`finished: { operation, advanced }` into its run body in the same transaction that removes the hand-off, and settlement
never reopens a run that carries it (a later failure is recorded and nothing more).

Evidence rules, titles and lengths are the Noter's (`src/core/workspace/`). Pending changes, change files and range reads
use the same lossless sentence-first unified diff. Project relabelling creates no processing event or revision; it
removes destination-pool coverage only for moved-in project versions, so returning versions count again.

**History.** The earlier Dreamer (pool budgets, a frozen 10,000-token pending range, `memory` calls with skips and
numbered refusals, an end review, a budget-checked success and a three-failure switch-off) is removed; its tickets (103,
104, 125, 126, 127, 131, 143) and the old [external-conflict design](dreamer-external-conflict.md) with its
[verification record](dreamer-external-conflict-verification.md) are historical evidence only.

## Runtime and verification

Use Node 24.6.0 and install dependencies with `npm install` at the repository
root. The store uses built-in `node:sqlite` (`DatabaseSync`), prepared statements,
and immediate transactions with a five-second busy timeout. Nested transactions
use savepoints. No external SQLite dependency is needed.

Run `npm test` for the Vitest suite, `npm run typecheck` for TypeScript, and
`npm run smoke:pi` for a direct Node extension import and fake-provider noting run.

## Logical-task outcomes (32c)

A logical task is `(target session, phase, backlog key)`, independent of its run ids. Noting uses the first frozen source entry and Consolidation the first selected fact (`head`); since 126 the Dreamer's task is its session alone, stored under the fixed pool key `all`, whatever each run's range holds. Rows before 104 keep their revision `head` and no pool; executions from 104 to 126 keep the pool they ran under. The 126 upgrade folds a session's per-pool Dreamer streaks into its one streak at the largest count, in the schema transaction. A Dreamer range is terminal after one run; a catchup retry admits a new range and preserves prior committed work.

Ticket 86's one-time normal-open upgrade clears only legacy Dreamer failure counters, whose heads used range IDs and could collide with revision IDs. SQLite `user_version = 1` records completion in the same transaction; reopening preserves new counters. N/C counters, run/execution audit and enrollment are unchanged. Historical execution heads retain their original meaning; they are not rewritten.

`Store.beginExecution(task)` creates a durable execution. Each attempt run carries `RunInput.executionId` and is linked through `execution_runs`. Attempt audit outcomes do not settle executions.

`Store.settleExecution(id, outcome, runId, reason?)` records one authoritative terminal outcome and updates the logical task's streak in the same transaction. Successful Noting and Consolidation commits settle inside their business transactions. Dreamer processing records skipped frozen versions and own commits, then settles that one execution. Failure and cancellation retain the same partial processing semantics: untouched versions remain pending, and partial writes survive.

Final business failure includes a Noting run that does not finish normally in either task (144), including one whose execution claim was lost. A Dreamer run that does not finish normally counts once however many tasks failed, including one whose claim was lost, and the third consecutive failure switches memory off, as the Noter's does; only a run that finishes resets the streak (a kept batch or an applied verify does not). Cancellation, shutdown, busy admission and corrected refusals do not count. `Store.taskFailures(sessionId)` returns each key's count, latest reason, last run and update time. Success resets its key; explicit enrollment on clears all target streaks, while reopen does not.

The third failure atomically persists enrollment off and expires every target claim. The façade
then closes and aborts locally owned target tasks. Only the transitioning settlement returns
`automaticOff` for the host's single notification. Committed data and backlog survive; other
targets and a borrowing executor remain enabled. No automatic retry or re-enable follows.

## Historical Noting and trace host contract (ticket 02)

The tool shapes, publication timing and NEAR behavior in this section describe the retired ticket-02 protocol. Use [Noter publication](#noter-publication-9204) and [Current facts and reads](#current-facts-and-reads-93) for current calls and outcomes.

Hosts pass completed source identities/content through `appendEntry(SourceInput)`
and select the persisted ancestry with `selectEntries(sessionId, branch, entryIds)`.
The exposed store's transaction groups ingestion with Turn/tool projections.
`notingBatch(target, boundary?)` answers what a Noting freeze of that target would
select — the pending set the boundary admits, cut to the oldest prefix that fits
`noting.batchTokens` — through the same selection `freezeNoting` uses, without
freezing, claiming or diagnosing anything.
`pendingEntries(sessionId, branch, headTurnId)` derives work from native path
membership and committed entry processing; it is not a queue of results for the foreground.
Call `noting({ sessionId, branch, headTurnId, model? })` at the existing
trigger boundary. The core freezes exact pending entries, owning Turns, rendered
views, recent facts and applicable knowledge before calling the model.

The noting result has `outcome`: `success` with `runId` and facts;
`failure` or `cancelled` with `runId` and problems; or `dropped`/`empty` without
a run record. A duplicate is dropped per target session and phase across branches,
hosts and processes by a thirty-minute SQLite claim. No automatic retry or feedback call follows a failure.
Historically, one `note({facts})` submitted a batch; `note({facts: []})` submitted zero facts.
The current N protocol is the four-stage workspace run of [Noter publication](#noter-publication-9204):
both layers and frozen progress publish together when stage 4 passes. A stage that does not end normally,
or whose files still fail the terminal check, fails the run without publication; earlier passed stage files
are kept for retry on the same frozen batch. Final prose is never read as facts.
Failure/cancellation before commit also advances nothing.
A committed batch keeps outcome `success` even if the provider subsequently
fails or is cancelled; the trailing problem is recorded without undoing business
writes (user ruling 2026-09-07).

`runAgent` receives `NotingAgentInput` (material and control, above) with its `tools` definitions: the Noter's own `search` and `check` (144; `trace://` reads and the two workspace files use the host's native read, write and edit). The retired ticket-02 protocol gave it `trace`, `search`, `note` and `memory`. Each definition has a name, description, JSON-schema parameters, and synchronous `execute(input): string`. Hosts execute calls and
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
readKnowledgeCommits, entryIds}` (`search` and `check` only since 144). The rest of this paragraph describes the retired
ticket-02 `note({facts})` batch and its NEAR review, kept as history. `note({facts})` validates every item and commits nothing
on any rejection; a corrected whole batch may be resubmitted. On the first valid Noting submission,
the binding reads and holds the same-session facts applicable to its immutable source-path snapshot.
It uses character-bigram Jaccard at `noting.nearThreshold` (default 0.40) and selects at most three
neighbours per submitted fact by descending score then ascending fact ID. Any neighbour returns
per-item results plus user-role NEAR feedback and writes nothing. After the host reports the next
provider request, the next valid submission commits its complete batch without another review. No
neighbour commits on the first valid call. Manual notes bypass review. Success returns `results` in
order (`ok: F<id>`) plus `factIds`; rejection results are `ok` or `rejected: <reason>`. An accepted
empty batch returns `results: []`, `factIds: []` and `committed: "zero facts; this batch is complete"`;
a refused one, having no item slot to carry the reason, returns a plain `rejected: <reason>`. A Noting
binding commits at most one batch. Candidate facts, applicability bindings and relations use three
batched queries in one database snapshot; rejected submissions do not read the pool. The synthetic
scale method, executable bounds and recorded measurements are in [Ticket 38 performance](perf-38.md).
The shown first batch, pairs and effective
threshold remain unchanged in `notingNearReview`, while the complete historical pool remains
binding-local. On commit, `diagnostics` compares every actual final fact with every unique held fact ID
shown anywhere in that attempt. The same bigram similarity and captured threshold apply, without
pairing by original position or selecting another top three. An explicit final `support` or `negate` of
either strength answers the identity pair; otherwise a still-near pair is recorded as
`{kind: "unanswered_near", pairs: [{fact: "F…", neighbour: "F…", score: …}]}`. Dropped and
rewritten-below-threshold facts contribute no pair, while inserted final facts may contribute pairs only
for IDs that were actually shown. Duplicate identity pairs collapse. Empty diagnostics are `[]` on a
successful automatic Noting commit; no-review, empty-batch and answered reviews therefore add no
placeholder problem. Manual notes remain outside this automatic diagnostic.

The diagnostic is audit output only: it derives no relation or state and never gates the commit. It is
computed from the binding's held pool and actual committed identities inside the commit response path,
without rereading current facts. A pre-commit failure has no committed diagnostic. Ordinary finalization
and provider failure, overflow or cancellation after commit retain it beside the provider problem and
business-success outcome. Failed and committing attempts retain
their own shown evidence and cannot share diagnostic inputs. The batch, run record and frozen entry
progress commit in one transaction.
Manual writes commit immediately as a `manual` run with the tool input/result
as request/response and enter only that branch's Consolidation range. They do not
advance Noting. `memory` writes knowledge with the uniform batch contract below.

Noting's NEAR message renders each selected earlier fact with existing relations and identifies the
guidance as system-generated, not evidence. Review is not initial material and does not debit the
Noting material windows, but it enters child context and therefore remains subject to the actual-request
capacity guard. A failure, cancellation or overflow after review but before commit advances nothing; a
provider problem after commit retains business success and records the problem. A fresh fallback attempt
receives a new binding and may review again.

New sources are exact `T<id>#E<n>` entries or their actual `@text`, `@thinking` or opaque-call-ID blocks in the frozen entry set (Noting) or selected source path (manual). Legacy `#user`, `#assistant` and `#t<n>` retain their historical meaning and stored spelling. The host supplies ordered normalized blocks once; raw JSON shape guesses cannot invent precise fragments. Time is the first source turn's
`started_at`; timestamps from the model are rejected. Event facts require
`status` (completed, reported, dispatched, attempted); other categories reject
status. Text has no completion prefix; the shared renderer supplies it. Relations
retain `[target, strength]`, with `$n` restricted to earlier facts in the batch.
The v1 schema changes in place. No production-data migration, legacy coverage
translation or compatibility shim is provided.

Every task runs in a fresh child (ruling 2026-10-22: the Noter runs fresh only, because a fork's prefix is the main conversation, not the compaction memory the Noter starts from). `noting.forkModeDefault` and its alias `noting.branchModeDefault` are removed settings that fail the load by name. Provider prefix verification no longer exists: the Pi host has one runner, a fresh native child for every task — ordinary, borrowed or catchup — and a host that cannot construct its worker at all returns a failed run with a reason, which leaves the queue pending.

**Budget before selection (ticket 19 gate 4, ticket 20 capacity negotiation, ticket 27a).** The host
reports its available material budget (`capacity {inputTokens}`) in the same
`noting(...)` call that starts the task. Since 27a `inputTokens` is the model's context window minus
the host's fixed 10,000-token headroom — no output reserve and no 85% multiplier enter it.
Core prices against `inputTokens` and never learns how it was obtained: it reads no provider
request body, no image and no transport field.

Core selects and freezes once inside that call: it prices the domain text it prepared for that
frozen task — labels, titles, the range line and receipts included — drops the newest whole entries until the task fits, and leaves
every unselected entry pending. The material, the write eligibility and the audit membership are
re-frozen together, so a reduced task can never keep the larger progress range. Extra context a host
can supply is never evidence permission — the frozen range bounds what may be written whatever the
model can see. If the oldest entry alone does not fit, core raises a capacity problem (opening with
`NOTING_CAPACITY`) and advances nothing. `boundary.exactEntryIds` (27d) takes exactly the named
members together or leaves them pending, so a host that wants the same entries again names them.
`cancellation` is core's own generation, exposed for host preflight: it advances on every cancellation, and a host that
queues work freezes it before admitting anything and abandons the queue once it has moved.

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

Trace uses the shared paginator and token estimator. Every response defaults
to at most 2,000 estimated tokens, including pagination receipts; public
`pageBudget` values are capped at 8,000, and `cap` also limits output lines
(default 100). A long line continues through the same cursor, split only at Unicode
code-point boundaries; concatenate fragments without a newline as the receipt
directs before interpreting JSON escapes. Transport pagination is lossless, but a
page fragment is not a complete hit.

The query freezes its material and effective options: page-budget aliases, line cap,
content budgets, fields, session/version filters, and configured entry profile.
Omitted continuation options and explicitly repeated equivalent effective values
both succeed; a changed value is rejected without consuming the cursor. Named
components resolve once without child cursors, and fact intervals retain lazy record
rendering and batched relation snapshots. A knowledge read refreshes handles only
after the entire expression's final page, only when `text` was selected, and only
when the delivered semantic body equals its untruncated rendering. Search previews
never grant a handle. Trace content parameters are `itemBudget`, `toolCallBudget`,
and `toolResultBudget`; `pageBudget` independently caps pages and cannot be disabled
by a public tool call.

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
identical entry bytes, and `full` is the same renderer without content compression;
the outer trace paginator still applies its default 2,000 estimated-token budget and
line cap. The shared segment-based token estimator remains unchanged (ruling 2026-09-07).

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

The Noter always starts from the empty view and sends the complete entry views below; it is priced as the instructions plus the tool definitions plus the text it supplies.

Noter's frozen Raw batch and full historical facts retain independent 10,000-token bases,
`noting.batchTokens` and `compaction.factsTokens`. Historical facts must be applicable on the
selected path; unused Raw space never enlarges their base. Fresh material is assembled by
the same `compact()` allocator as main-agent compaction.

Thinking-only entries (every normalized block is thinking) remain members of the frozen
processing batch but supply no Noting body, label, marker, source-index line or head reply.
The pending token count joins only the other entries' views; batch and model-capacity pricing
likewise charge only material Noting reads. A successful publication marks every frozen member
processed, including thinking-only entries. An all-thinking pending path weighs zero; an explicit
catchup can still process it. Compaction, `trace://raw`, search and citation validation are unchanged:
thinking-only entries remain readable but cannot support new facts.

Ticket 133 added `compaction.temporaryTokens`, 10,000 by default; since ticket 144 it is the one temporary allowance of a context (below).
The anchor is the batch's newest turn. Its frozen batch already fits its Raw base, so no
Noter Raw borrows: the allowance holds human user words and uncovered fact titles, filled
together by turn as in compaction (140), each from the anchor and 99 preceding path turns by
default. User entries use the normal head/tail middle cut at 300 tokens each. Neither these excerpts
nor titles grant full-body coverage or enlarge the frozen processing batch.

When the host's measured input capacity is insufficient, optional temporary material is
trimmed first, then full historical facts, then the selected batch is reduced and re-frozen.
An oldest admissible unit that cannot fit stays pending with a capacity diagnostic.
Noter material also carries current Knowledge: scored items within the Knowledge base in score order, then, from the temporary allowance, unscored items and titles of scored items that missed the base (144 §7). Visible
revisions at admission remain the frozen read base.
The budgets themselves, and what each one charges, are in "Material budgets (20b)" below.
Historically, this ticket emitted expansion addresses for future trace support and
implemented only `T<n>` and `F<n>` trace targets. Current model reads use `trace://`.


## Shared material and block layout (20a)

`src/core/render/material.ts` holds one material contract and the block layout of every memory consumer.
The shared parts are the rendered knowledge (in category groups), the historical facts, the
compressed Raw entry views with their source identity, and the budget receipts. A task adds its own
parts: Noting the head reply and the source index, Consolidation the pending facts as addresses and lines. The frozen range travels beside the material as the
run's own label. A consumer whose order has no knowledge, no facts or no Raw block simply omits those
parts: sharing the type never adds a block to an order, and foreground delivery stays Knowledge-only.

One function per consumer renders that contract, in the ruled order (ticket 20, as ticket 25a
corrected it):

| Consumer | Block order |
| --- | --- |
| Noter (`notingText`) | target/range → knowledge/status → fact titles → full historical facts → earlier user words → selected Raw → receipts → head/source index |
| Consolidator (`consolidationText`) | knowledge → range → selected pending facts → negation reminders → receipts |
| Main-agent knowledge block (`injectionText`) | knowledge → inherited-knowledge status (31) → receipts |
| Main-agent compact (`compactText`) | knowledge/status → fact titles → full historical facts → earlier user words → Raw → running tasks → receipts |

25a retired the Consolidator's already-consolidated history block. Ticket 92 restored current
Knowledge to Noter material.

## One material builder (29b)

Each phase has ONE builder. Since the Noter became fresh-only (2026-10-22) the Noter's child always starts from the empty
view, so its supplied material is its whole processing target; the foreground compaction subtracts the view it retains (29a).
`notingIncrement` and the `MaterialText` pair are gone.

A task has two sets, frozen separately. The **processing target** is chosen regardless of visibility —
Noting's oldest whole-entry prefix within `noting.batchTokens`, Consolidation's oldest applicable
pending whole-fact prefix — and it is what the run may write for, what the audit lists and what
progress advances. The **newly supplied material** is that target minus what the view proves visible
at the same identity and representation, then the optional material minus visible ids, and only then
the injection budget. Never a budget-limited prefix with visibility subtracted afterwards: with the
newest facts already visible, the whole history allowance goes to the older ones the child cannot see.
The allowance is a ceiling, never a target — fewer needed facts make a smaller block, not filler.

- **Noting.** The whole target is supplied. Optional: the applicable historical facts, within the same `render.episodicBlockTokens - noting.batchTokens` ceiling, and the current knowledge within its own base and the temporary allowance (144).
- **Consolidation.** Target fact bodies the view does not hold by id, with `factAddresses` still naming
  the whole target. Optional: the current applicable knowledge the view does not hold at that exact
  commit — a visible predecessor covers nothing — plus one status line per inherited commit that is no
  longer current (superseded, archived or merged), charged inside the task's frozen database-derived
  Knowledge injection capacity with the block it corrects. No historical-fact block and no automatic Raw block.

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
fact reads through `trace://F<n>` and search results retain their rendering; already-persisted injections are not
rewritten merely to change their layout.

## Material budgets (20b)

`budgetMaterial` in the same module is the one budgeting of that shared material: every consumer
passes the knowledge candidates, its selected current material (Raw entry views, or a Consolidation's
pending fact lines), the block titles and mandatory cues it will emit, the frozen range and the
historical facts, and gets back what fits with the receipts for what did not. The limits are hard,
measured by the existing estimator over the exact rendered view, and every emitted component is
charged once to the block that emits it:

| Component | Budget | Default |
| --- | --- | ---: |
| main knowledge block, category tags, state notices and omission receipts (ordinary-prompt delivery and compact window) | Knowledge base (scored items, score order); omission receipts when the base has room for them | 20,000 |
| Consolidator knowledge references, category tags, inherited status lines and omission receipts | frozen Knowledge base | 20,000 |
| Noter's selected Raw / Consolidator's pending fact lines — views with their own source labels, omission markers and joining separators | `noting.batchTokens` / `consolidation.batchTokens` | 10,000 |
| Noter's full historical facts and framing | `compaction.factsTokens` | 10,000 |
| compact's full facts and their framing/receipts; no borrowing | `compaction.factsTokens` | 10,000 |
| compact's Raw, pending overflow borrowing only the temporary allowance | `compaction.rawTokens` | 10,000 |
| the one temporary allowance (144): pending Raw → unscored Knowledge, newest first → titles of scored Knowledge that missed the base → user words within 100 turns and fact titles within 100 turns, filled together by turn; framing/receipts included. It replaces the Knowledge-only shared allowance (73/133) | `compaction.temporaryTokens` | 10,000 |
| Consolidator: its titles, range line and receipts, charged with the facts they frame | `consolidation.batchTokens` | 10,000 |

Required task material is reserved first; historical facts then fill whatever episodic space is left, in the existing freshness order. A Noter batch consumes at most its own
ceiling, not a guaranteed allocation, and Consolidation has no automatic Raw block and no history
block at all — its selected pending facts and their required framing share the current-material
allowance. Outer framing is never charged against the Noter's inner Raw ceiling, so an otherwise valid
10,000-token entry stays batchable.

Each database stores one Knowledge policy row: Global 4,000, Project 15,000 and Session 1,000 tokens by default. Their safe-integer sum derives the 20,000-token Knowledge base. Knowledge, Facts and Raw retain 20,000/10,000/10,000 base windows. `compaction.temporaryTokens` adds one 10,000 allowance per context (ticket 144; `compaction.sharedAllowanceTokens` is a removed setting). It is not derived from triggers or pool sizes. Owner pools remain independent: each project has the full Project budget and each session the full Session budget, never multiplied into one global total. Pool sizes count current visible non-archived revisions whether or not they have processing records. Processing state triggers maintenance; it does not change capacity, validity or visibility.

Supported schema creation and upgrade, source/lineage migration, policy initialization and policy
validation commit as one database transaction. A failed later migration or integrity check therefore
publishes neither a partial schema upgrade nor a new default-policy row; reopening retries idempotently.
Single-field edits are separate ordinary database transactions. Reads and no-op edits do not rewrite unrelated memory or Pi settings. Every new selection, compact allocation and ordinary injection reads current database policy. Dreamer and Consolidator freeze their input capacity at admission so a running provider request cannot change shape; later runs use the current policy. Safe-integer overflow is an
explicit error. The retired `render.knowledgeBlockTokens` file/environment key is always a named
configuration error.

Ticket 25 amendment 3 (25c) removed compaction's inner Raw cap: a foreground backlog is not a Noter
batch, so `noting.batchTokens` does not bound it. Ticket 28a replaced 25c's "knowledge plus one shared
20,000-token envelope" with three windows and its own allocator (below); compaction no longer reads
`render.episodicBlockTokens` at all, and that key stayed exactly what it was for the Noter.
Noter now assembles through `compact()` with its own frozen batch and endpoint; the legacy
`budgetMaterial` API does not select that batch's history. Its Raw and full-fact bases remain
independent, with the separate temporary allowance described above. At default policy the
main-agent envelope is 50,000 estimated tokens: Knowledge 20,000, full facts 10,000, Raw 10,000
and the one temporary allowance 10,000. Live running tasks and the
fixed reading guide are additional measured text. System instructions, tools, inherited context
and later model-loop messages remain subject to the host's independent real-input capacity check.

Selected evidence is never dropped to fit: the reducible unit is the task itself
(`freezeNoting`/`freezeConsolidation` take a smaller oldest-first prefix), and a current block over
its ceiling — which since 20c only a Noter's or Consolidator's *outer* framing can produce, because
compact escalates instead of keeping an over-ceiling block — is reported by an honest receipt rather
than cut. Receipts are bounded: an omission names at most eight addresses and
then says how many more it covers, so a long omitted list cannot defeat the cap it is charged
against. Nothing is deleted; omitted knowledge and facts remain stored, readable and traceable, and
no omission advances knowledge lifecycle or processing progress.

The knowledge cap is hard (user confirmation 2026-09-08): constraints, open items and disputes do
not bypass it. Retained items are whole — a claim is never rewritten to make it fit — and each omitted
category is named in its own receipt. All Knowledge consumers keep category groups, each opened by a `## <category> (<n>)` line charged to the
budget, and chronological display inside a group (132), but capacity selection retains newer commits before older optional items. The shared header
explains grouping and newer same-object claims within a category; lexical relevance no longer controls this budget cut.

## Knowledge trace and negation walks (ticket 03a)

`trace("K1")` defaults to the statelessly resolved current revision visible on the path and its parents, children and links. `versions: "history"` additionally admits applicable superseded and archived revisions; `versions: "all"` additionally admits other branches' revisions in the selected scope, including their history and archives. Such inapplicable revisions are never write bases on this path, and reading never bypasses write validation. Without a bound session, the resolved current revision is labelled newest-created and all history appears once. `K1@57` reads one immutable global commit,
`K1@57..K1@61` compares any two commits of the same identity, and `K1..` shows the
complete commit tree across branches. These explicit addresses ignore data filters.

Trace fields are `text`, `supports`, `topics`, `status`, `reason`, and `links`.
Current and exact reads default to all except `reason`; history/all reads
and `K1..` additionally default to `reason`, which appears on commit-history lines.
An explicit `fields` list is authoritative. Commit metadata can include operation,
stored time, supports, topics, and the authored reason. Supports expand through
`trace("F1")`.

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
branch; every leaf ends with `no later strong negation recorded`. Fact lines retain all normal relation annotations, even though weak negations and supports are not traversed. Automatic material and path-scoped collections retain an annotation only when both Fact endpoints satisfy the selected path snapshot. Exact `F<n>` reads remain unrestricted and receipt relations whose other endpoint is inapplicable there. Later means allocation order, not potentially backdated fact
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
A short transaction freezes the necessary values, relations and annotations for the
request snapshot. Named rendering and page estimation happen after it exits; immutable
interval fact bodies remain lazy. No transaction stays open between pages. The
annotations 22c freezes for a search (a fact's relations and a Turn's
occurrences and Raw profile) cannot move under a later page either. A read through
a run's tools is recorded and audited as
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
or marked consolidated unpresented. The range freezes those facts and the visible current Knowledge revisions, including budget omissions, before the model call. Since tickets 25a and 45 the automatic material is exactly two blocks: visible current Knowledge
within the frozen Knowledge base (20,000 by default),
and pending facts within `consolidation.batchTokens`, which also carry their titles and range line.
Required framing is charged to the allowance of the material it frames, never to a second budget. A fitting
knowledge pool retains the stable category/time/id presentation with no omission receipt. An over-cap pool
keeps the newer optional commits first through the shared Knowledge selection rule; retained versions
render in category groups and bounded receipts name omitted IDs. **There is no already-consolidated
history block and no automatic Raw block**; both were reached by explicit `trace` in historical Consolidation. No new C worker runs. All range facts are
retained: a batch whose facts and framing cannot fit that allowance is reduced oldest-first and
re-frozen, and one that cannot fit its smallest admissible unit stays pending with the capacity
diagnostic (`CONSOLIDATION_CAPACITY`). Since 29e the optional knowledge block goes first: it is
dropped whole — with one receipt line saying so, charged inside the text the freeze prices — before
any selected fact is given up, the twin of the Noter's history trim. It is dropped whole rather than
by a lowered cap because a cap small enough to matter is also too small for the block's own omission
receipt, which `budgetKnowledge` refuses outright.


The host receives one `ConsolidationAgentInput` with frozen `input`, the four bound tools and `reportRequest`. It executes tool calls and extends the same conversation
until the provider stops. `reportRequest` captures each exact provider request before
execution; the final returned request is the last one sent.

Consolidator's `memory({operations, skipped})` accepts only `create`. Each create requires
non-empty direct `supports`, a non-empty `reason`, and complete text, category, scope and topics. A
state change, correction or refinement is another created item; its reason may name the older item it
supersedes so the Dreamer can reconcile them later. Update, merge, split and archive are rejected.
Manual callers expose only fact-backed `create` and `archive`.

The first valid submission commits. A rejected submission may be corrected and resubmitted as a
whole; a call after commit is rejected. There is no Consolidator NEAR/CLOSER review, second-round
message, checklist or uncited-fact accounting. The Noter's separate NEAR review is unchanged. A run
that stops without a submission succeeds with zero created items and advances the frozen fact range.
The revisions, run record and frozen Consolidation membership commit atomically.

Every create is revalidated in the immediate transaction against the frozen fact range, evidence
scope and current project. A rejected batch writes nothing. The Knowledge block remains available for
Admission's duplicate test, but reading an existing revision grants no maintenance authority.

Ticket 29d retired automatic foreground receipt delivery, which the 2026-09-08 supersession had made
unconditional: worker completion itself delivers no receipt to any conversation, in either worker
mode. A later ordinary prompt may independently publish an applicable current Knowledge revision when
that prompt's selected persisted context does not already hold the exact body or all of its proven
change evidence. A child receiving material does not mean the parent received it. Supports cite
project facts available at start.

The `unsupported_numbers` and `over_200_tokens` diagnostics remain audit-only: numbers compare
submitted direct evidence, never the commit reason. Neither diagnostic establishes Knowledge status.

One run record retains tool inputs/results, fetched evidence, the exact last request, final output, usage, read revisions and problems. Once committed, business
outcome is success even if the provider later fails or is cancelled; trailing errors
only append problems. Before commit, failure or cancellation advances nothing; an uncorrected rejection ends bounced. Run admission uses the same target-wide phase claim as Noting, across facades,
branches and processes.

The fixture `tests/fixtures/consolidation.json` copies K2 from v7m's first Consolidation output and its
supporting facts F2/F35 from facts.jsonl. Chinese memory content is preserved;
only the knowledge category and candidate handle are adapted to the core contract.
Tests remap fact addresses to allocated IDs. Existing 03b tests now expect
application and session/branch ranges, explicitly decline unretained facts, and
add fresh facts before repeat runs; committed Knowledge participates in later duplicate checks.

## Read facade contract (ticket 04)

Knowledge marks and the mark API are retired. Trace, search and injection expose no mark field or annotation.

`inject(sessionId, branch = "main")` returns attribute-free `<knowledge>` XML,
with nonempty category groups in glossary order, each opened by a `## <category> (<n>)` line. Within each category, current
revision time ascends, with knowledge-id ties. XML text is never escaped; shared lines stay byte-identical trace lines and remain the display grammar. Budgets measure
shared lines, including framing and receipts. Every category obeys the hard cap;
whole items retain category/time display order, while budget selection omits the oldest optional items first.
Pass `null` explicitly for legacy null branches.

92 replaces 34c's evidence suppression: `injection(target, visible?)` subtracts actually delivered exact
versions from the current visible graph. Facts and Raw do not replace missing Knowledge bodies.
The host reconstructs delivery from its latest retained compact and subsequent actual carriers, never
from a historical visibility query. Core reuses 88's reader projection; SQLite transactional reads use
their own graph input. Source coverage still governs compact selection.

Every retained carrier occurrence is charged first against
the Knowledge base (20,000 under the default policy), and what the context's temporary allowance has charged so far against that allowance. Missing state transitions then fit as complete items in
their stable prefix order, followed by complete candidate bodies in oldest-first revision order. An
unfit next transition is not skipped for a body; a fitting transition prefix remains publishable. Exact
fit is accepted; zero or negative remainder and a single unfit item emit nothing, and omission receipts
alone never create a message. Archive/supersede/merge/split notices have
stable carrier identities separate from exact body visibility, so persisting a notice never grants a
replacement body. Fact, Raw, command-generation state and processed/unprocessed status are absent from
foreground publication. New carriers retain their complete Knowledge-window cost, including notices,
framing and Knowledge receipts, bound to their text by integrity validation. Legacy carriers without
that field are measured individually; ambiguous unescaped delimiters produce a diagnostic and a
conservative whole-content charge, not an error or a zero. Repeated bodies and inapplicable old bodies
still consume context. CC checks the sum of final segment Knowledge costs against the remaining
allowance after packing; repeated domain framing counts, but host JSON and Fact/Raw do not.
Fresh Noter material uses the same Knowledge capacity and renderer; the Dreamer's curate prefix has its own 50,000-token cap. The historical Consolidator-era
synthetic method and 250/1,000-candidate measurements remain in [perf-34c.md](perf-34c.md);
they are not performance evidence for the current N/D implementation.

Successful noting commits record `factIds` in the
existing response envelope; this identifies a run's own facts even when runs overlap in their source
turns. (29d: the `<noted>` block that used to follow knowledge on every prompt is gone. The
`pending_deliveries` table is not created in new databases. Existing legacy tables retain their
schema and rows unchanged; nothing writes, reads, drains or migrates them, and their timestamps
are never read as visibility.)

`compact(sessionId, branch = "main", headTurnId?, retainedView = [])` renders one frozen read
snapshot of the path and returns one outcome for any valid path, not a string (ticket 20c, one view
since 30, one allocation since 73):

| Outcome | Condition | Result |
| --- | --- | --- |
| `{text, supplied, charged, truncated?}` | any valid path | knowledge/status, then `<episodic>` title index → full facts → earlier user words → Raw → live tasks; `truncated` reports omitted pending Raw entries |
| `{native: true, reason}` | an unexpected host-caught error (a store error, an invalid path) | explicit native delegation; never returned for capacity |

**Allowances (133, 144).** Knowledge retains its database-derived 20,000-token base and spends it on
scored items in score order (ties: newer version first); the first scored item that does not fit stops
the base (user ruling, 2026-10-22: a smaller item behind it does not skip ahead). Facts and Raw retain 10,000-token bases.
One 10,000-token temporary allowance per context is filled in order: pending Raw overflow first (compaction only);
then unscored Knowledge whole, newest first; then titles of scored Knowledge that missed the base, in score order
(`[K12#tag] [category/scope] (title only) <title>`; a delivered title is not re-sent and a later body still
arrives); then the user's words and uncovered titles together, turn by turn,
newest first (140). For each turn on the anchor's path, that turn's missing human user entries
within `compaction.userTurns` (100) path turns, then its titles within `compaction.titleTurns`
(100) path turns, so both kinds reach the same depth while the allowance lasts. A kind past its
own reach drops out and the other continues alone to its reach. Both configurable reaches include
the anchor; no older material fills spare room. Each kind keeps a newest-first whole-item prefix,
and the first item that does not fit stops both kinds. User entries use the normal renderer with
`compaction.userEntryTokens` (300) as their middle-cut cap. All four temporary-allowance settings require positive safe integers. Framing is charged to whoever needs it: the base pays for the window its own items and state notices make, the temporary allowance for the rest, so both caps hold with the base full. A compaction records what it charged to the temporary allowance in its delivery row (`temporary_tokens`), so the next prompt has none left (ordinary prompts spend what remains, knowledge the Noter has just written included: user ruling, 2026-10-22).

Full facts and Raw preserve their selection and coverage rules. Framing and receipts are
charged in their owning window or allowance. Raw omissions stay pending; hosts delegate to
native compaction whenever `truncated.raw` reports an omitted pending entry (133 R1).
Omitted user entries have an address receipt and omitted titles join the existing
bare-id fact receipt. `supplied` claims ordinary Raw views and complete facts only, never
500-token user excerpts or title-only facts. `trace://compact` has the same stored material;
running tasks are live host state supplied only at actual compaction.

**Raw-first span, then facts.** Walk the selected path newest-first and take one contiguous Raw span:
a pending entry may use the Raw base and then the temporary allowance; an already-noted entry
continues the same span only within the Raw base remainder. The walk never skips an entry to reach an
older one — the first entry that cannot be taken (too large for the remaining budget, or whose bounded
view cannot fit its own profile) ends the span, and everything older is omitted and counted in the
receipt. The optional `retainedView` argument has type `readonly string[] | VisibleView`: legacy
native-ID arrays describe retained Raw only; the existing `VisibleView` describes actually retained
Raw, fact and knowledge identities, including recognized carrier identities. Its position and default
empty array are unchanged. The discarded summary establishes no retained coverage. Display selected
Raw in source order.

Then filter facts — consolidated and unconsolidated alike — before selection: exclude only facts whose
nonempty, complete `fact_sources` bindings are fully covered by retained Raw or the Raw span just
chosen. Unknown, incomplete or partly covered bindings remain eligible, as does a fact whose sources
straddle the span's start. Select eligible whole facts newest first, deduplicated against retained
fact IDs, and display chronological Turn groups. All full facts use only the facts base,
regardless of historical processing; excluded facts gain no
supplied fact IDs. Pending membership is exact entry/fact processing membership, never a timestamp
tail; old pending holes remain protected.

An item that does not fit its window is omitted with a receipt; core rendering starts no worker
and resets no processing. `trace://compact` retains that bounded view. At the CC/Pi host boundary,
pending Raw omission instead selects native compaction before recording a custom delivery.
Optional fact/user/title omission alone does not delegate. Spare space stays empty; `charged`
reports each window's spend and the envelope, not a second allocator outcome.

Facts and knowledge are the ones **applicable on the selected path** (26 amendment 2), in
`listSessionFacts`' freshness order: a sibling branch's fact is not a candidate here, and its absence
is membership, not a budget omission. One path snapshot answers that membership for the whole
operation, the knowledge block included.

Ticket 30 removed the second, tighter rendering; ticket 73 removed native fallback for capacity.
Ticket 133 R1 restores host-native fallback only when pending Raw would be omitted. The core
allocator still calls no provider and contains no summarizer. It never falsifies omission counts,
relaxes a cap or changes processing to force a fit. A native fallback records no custom carrier.
Pi's bounded recovery — Noting, Consolidation or Dreaming during a compaction — stays deleted:
neither capacity nor errors launch an extraction worker. Live-task lookup errors retain the
existing host-native fallback (133 R2); malformed individual agent records are left out.

The views it emits are `renderEntry` under the configured profile, the same bytes Noter input,
the token counters and the internal renderer behind `trace://` use, and no view or summary
becomes a source entry, a fact or a processing receipt. Pass `headTurnId` for precise ancestry; without it, the latest Turn selects one
path. Sibling queues are never combined into an automatic Raw view.

`search({query?, scope?, layer?, topk?, code?})` matches every query term in one item
(ticket 150). Terms split on any whitespace, including U+3000; double quotes keep an exact phrase
and its inner spaces. An unmatched quote keeps the rest as a phrase. Empty terms are discarded;
a supplied query with no terms is refused. Omitting the query still lists items.

Terms are case-insensitive literal substrings under the existing SQLite `LIKE` semantics
(ASCII case folding), not FTS syntax or wildcards. Every term must occur in one knowledge version,
one fact or one Raw entry. Terms may occur in different searched fields of that item: facts search
text and title; knowledge searches text, title and topic values. Topics are read with SQLite
`json_each`, so serialized JSON punctuation and escapes never match.

`topicGroups(sessionId, headTurnId?, branch?)` projects the same path-selected
visible current Knowledge as `{topics: [{topic, commits}], unclassified}`, where a commit
is the `{knowledgeId, commit}` reference of the revision it was read from. A
multi-topic commit appears in each of its groups, and nothing is cloned or ranked: this is read
organization, not a second injection order. This reference projection is distinct from search results.

`scope` is the only material-range parameter. Search selects material as follows:

| Scope | Facts and Raw | Knowledge |
|---|---|---|
| project (the default; omitted means the same) | current project's sessions | global + current project's project-scoped + current session's session-scoped |
| session | current session | this session's session-scoped |
| global | every session | global-scoped, regardless of author project |

`project` is the default and means everything this project can see (ticket 136 ruling, 2026-10-10): the project's
facts and Raw, and the knowledge of every scope applicable here, so a default search and the Dreamer's all-pool
revival search reach global and session knowledge. Writing it and omitting it give identical results. An unbound
reader discovers all owners. `session` requires a session context; a missing one is an error, never an inferred
session. Exact `trace://F<n>` and raw-entry reads remain independent of search
selection; selection grants no source or write authority.

`layer` is `knowledge`, `facts`, `raw` or `all` (default). `topk` caps the hits across the layers together:
10 with a query, none without. Without a query, hits are the newest first across the layers; with one,
knowledge comes first (closest lexical match to its text or a topic, using the original query string,
then current, then newer), then facts and Raw, each newest first. Every knowledge version applicable
on the reader's path is a candidate, current, superseded and archived alike; other branches' versions
are not. Raw hits are entries whose searched text contains every term, found newest Turn first a chunk
at a time, so a small `topk` reads a few Turns. Raw
candidates are listed from metadata alone (entry id and ordinal): a body is read, for the whole chunk of Turns at
once, when a query filter, a printed line or a script first needs a hit's `text`, `role` or `matchLines`, so
a search that only counts its hits reads none. A Raw hit's `text` is the exact Read of its `address` (the same
renderer and result extractor as `trace://raw/…#E<k>`, never the host's), and its matching and `matchLines`
are taken from that text.

Each hit is one structured item (`layer`, `address`, `time`, `text`, plus the fields of its layer, declared as
TypeScript in the tool description). Facts and Raw also carry `session` and `turn`; a knowledge version belongs
to no single Turn, so knowledge carries neither (a script reaches a Turn through `supports`). It prints as one line:
`[K12@v3] (archived) [category/scope] …snippet…` (no mark for the current version), `[F25081] title — …snippet…`
or `[S173/T8727#E1@user] …snippet…`. One snippet rule serves all three layers: about 200 characters centred on
the earliest occurrence of any term, cut with `…`; without a query it is the start of the body (a fact shows its title alone).
A Raw snippet starts after the entry's own `[T..#E..@role]` label and role word, which the line's label already says.
Search never grants a knowledge write handle; read the complete `trace://K<id>` body for a tagged mutation base.

`code` is the body of an async function run over the hits in a QuickJS sandbox (no Node API, file system,
network, modules or timers; built-ins frozen; nothing kept between calls). The sandbox is a worker thread (as
Pi's codemode runs it), so a script that spins never blocks the host's event loop: the hits' metadata is sent
to it as JSON, and a Raw entry's `text` and `matchLines` stay on the host until the script reads them, when the
worker asks for them and waits for the answer. The engine stack is Pi's 512 KiB. It sees `hits`, `text()`,
`console.log()`, a top-level `return`, `exit()` and `render(hit)` (the hit's default line). The result starts
with `Script completed` or `Script failed` and the wall time; text items are numbered when there are several,
console lines come in one block, and a failure keeps its partial output before `Script error:`. A script is
ended at 10 s (the engine is interrupted, and the worker terminated if it does not stop) or at 256 MB; output is capped at 10,000 estimated tokens, keeping its start and end, with the
full text written to a file whose path the result gives and the caller's own Read can open. A search without `code` is capped the same way.
Every caller has such a place: a Claude Code session's render directory for `trace://` reads (made when first needed), Pi's
temporary directory, and for a fresh Noter or Dreamer the run's own: Claude Code's worker render directory, whose files
its restricted Read may open, and a Pi worker's temporary directory, which its `trace://`-only Read may also open and which
is removed when the run ends. Raw `text`, `role` and `matchLines` (1-based, numbered as a Read of the hit's address) load on first access. The first read of `role` or `matchLines` answers for every hit of that hit's chunk of 25 Turns in a single reply, which the worker keeps, so reading it for every hit of a project costs one request per chunk and not one per hit. `text` answers for the asked hit alone, so a script never holds bodies it did not read.

Raw matching includes tool names, inputs, and results; `%`, `_` and backslashes are escaped for `LIKE`.
Terms of at least three Unicode code points use the existing trigram index. Because each indexed field
has its own row, per-term FTS5 phrase candidates are intersected by Turn, allowing different fields
and calls within an entry to satisfy different terms. Search has no term-count cap: SQL expands at
most 64 terms per statement in every layer, carrying surviving row ids between batches through
`json_each` so compound SELECTs, expression depth and binding counts stay bounded. Raw processes all
indexable batches before rechecking every term, including shorter ones, against real columns with
`LIKE`; these rechecks remain bounded to the indexed candidates. The API then requires every term in
one exact entry Read. When all terms are short, the first batch uses the existing full scan and later
batches narrow its survivors. A NUL-containing term cannot be sent to FTS5 and stays in the recheck;
if no term can use FTS5, the scan is retained.
`matchLines` lists the 1-based lines containing at least one term. A miss explains that every term must
appear in one item, suggests fewer terms, and retains “No hit does not mean absent.”
`trace://` reads and Grep are unchanged.

The following trace-only address and option behavior is historical, not a public tool contract:
session and project addresses, comma lists, fact intervals and trace `pageBudget`/`tool`/`full`/`cursor` options.
Models read exact facts and versions via `trace://F<id>` and `trace://K<id>`; sessions and entries use `trace://<layer>/S<n>[/T<t>]`.

For public reads, bare `trace://K1` selects current, `trace://K1.history` shows history and `trace://K1@v<n>` selects an exact ordinal. Search collections grant no complete-read handles; a tagged mutation base requires the complete exact body. Suppressed alternatives and historical commit-reference lines grant no write authority. Search listing `cap` counts output lines, not facts or tokens; its cursor is single-use, bound to the calling facade and session/project, and preserves remaining lines.

`declareProject(sessionId, name, source, path)` declares attribution through an explicit user
command and the host's currently selected path. Pi does not discover marker files. An ownership
change requires the declaring session to have no running N/C/D and no reached N/C/D trigger,
including its applicable global/project/session knowledge pools. Refusal names the phase and starts
no work. Other sessions do not block the move; their in-flight commits retain ordinary authority
checks and may fail visibly. Relabelling creates no Knowledge revision or processing event; only
moved-in project versions lose destination processing records and become pending again. Global,
session and unrelated destination records are unchanged. Existing project assignment provenance is retained. Only undeclared projects merge via `mergeProject`; leaving a named
project moves the declaring session and its session Knowledge, not peers.
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

Core owns the host-neutral `VisibleView` contract in `core/api/visible.ts`: `raw` maps a native
entry id to `source` for a retained original or `view` for a bounded supplied representation, while
`factIds`, `knowledgeCommitIds` and `knowledgeStates` identify complete retained material. Legacy
metadata remains part of the contract for worker and fixture compatibility. Core also owns
`SuppliedMaterial`, `InitialContext`, the empty view and the canonical state-notice identity helper.
A persisted envelope can only understate coverage; it cannot establish material it did not carry.

Each host reads its own persisted envelope and produces this contract. Core knows no host entry
shape, binding identity, SDK type or parsing rule, and imports no host module. Pi's reader and its
binding validation live in `hosts/pi/visible.ts`; malformed Pi payloads fail closed there. A new
fact or commit may change applicability without changing the host-derived view because applicability
remains a separate core authority. See `docs/pi.md` for Pi's concrete format and reader behavior.

## Branch summary read (ticket 07)

`branchSummary(sessionId, branch, headTurnId)` returns one `<branch_carry>` XML
block with the fixed other-branch reminder, facts whose raw evidence lies on the
leaving path, commits selected by that evidence, and shared pending entry views.
As in every block, tags delimit and content lines remain byte-identical. There is no fact budget.
The optional Raw sub-block keeps the newest whole suffix within `render.episodicBlockTokens`,
including its title, separators and omission receipt. An oversized newest entry may leave no Raw
body; an envelope too small even for the title and required omission receipt raises a capacity
error. Omission neither processes entries nor supplies coverage identities. This is not compact's
Raw window, which prioritizes pending entries over already-noted ones and reports truncation
with a receipt. Hosts delegate when that report includes pending Raw (133 R1).
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
29d it answers `{due}` alone: the delivery pause that used to hold a Noting task until its
predecessor's facts had reached the foreground is gone. For Noting and Consolidation only, `borrowed: true` requires a closed target and an enabled, open `executorSessionId`, and runs as a fresh subagent. Dreaming never borrows closed-session work. `closedSessionScope` defaults to
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
to its signal. Introduced for the Pi host's compaction recovery, which passed Pi's own
compaction `AbortSignal` (28b); that caller is gone with recovery itself (73), so today nothing
threads a signal through admission. Nothing else about admission, freezing, claims, slots or
`cancelTasks(stopping?)` changes.

`compact`'s outcomes are a complete custom replacement, with an optional `truncated` receipt for
omitted unprocessed material, or `{native: true, reason}` for an unexpected host-caught error —
never for capacity (73). The `over` field that used to flag required-window excess against the
derived shared allowance is gone with the fallback it served.

## Manual catchup boundary (18b)

`TaskOptions` (shared by `NotingInput` and `ConsolidateInput`) gains an optional
`boundary: { maxEntryId?: number; allowedFactIds?: number[]; exactEntryIds?: number[]; exactFactIds?: number[] }`.
Absent, selection is the ordinary unbounded pending set; nothing about existing
automatic callers changes. **29e names the two meanings apart.** The *allowable* set is a
bounded caller's snapshot: `freezeNoting` filters `pendingEntries`
to ids no later than `maxEntryId` before its usual batch-token loop, and
`freezeConsolidation` filters `consolidationBatch` to `allowedFactIds` (27d's `factIds`) before
building its range; both reuse the same store readers rather than adding a second
selection query. Manual catchup drains its frozen Noting boundary. Ticket 68 checks N, C and D
at start and after every successful catchup-owned phase completion; C and D use ordinary eligibility.
Ticket 86 immediately retries a failed Noting step in the same phase and boundary, without checking
other phases. A failed Dreaming run is not retried inside the drain (146, ruling 10: it retries at the next entry-end check): it ends the drain for the same session and path, whoever started the run, and counts once toward the Dreamer's streak. Both phases use the ordinary three-consecutive-failures rule; off or cancellation also ends the drain.
`dream({ manual: true })` (146 §18) starts a Dreaming run now: it skips only the due test, and keeps enrollment, the database-wide seat, the claim and the lease. It resumes a hand-off with the hand-off's pair, writes coverage, advances the rotation and counts toward the streak like any run. A refusal creates no execution: `dropped` carries its reason (memory off, another session holds the seat, a Dreamer already runs for this session) and `empty` means there is nothing to curate and no hand-off.
It no longer freezes a fact set for forced below-threshold Consolidation. The *exact* target is what a host that re-admits a frozen batch names: `exactEntryIds`
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


## Spend and the retired cache-miss latch (108)

Ticket 19c's cache-miss latch (`sessions.fork_suppressed_at` and `fork_suppressed_run`) is gone in both hosts, and a
migration drops the two columns from an existing database. The fork cache-miss audit that replaced it went with the Noter fork (2026-10-22).

Spend keeps an unknown cost apart from a zero (108). `runs.usage_cost` is null when a run recorded tokens without a
price. `spend` and `spendSince` count such runs in `unknown` (tokens without a price, or a cancelled run with no usage)
and leave them out of `cost`; every display marks the total as a lower bound instead of counting them as free.
