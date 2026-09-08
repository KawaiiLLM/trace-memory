# Ticket 20c acceptance report

**Ready for acceptor review.** Baseline: `91688b8`, *Ticket 20b: hard material budgets, token-based
Consolidation batches, capacity re-freeze*, read with `git log -1 --oneline` before implementation.
The initial working tree was clean; HEAD is unchanged, nothing is staged and nothing is committed —
every change below is in the working tree. No pre-existing file under `.scratch/v1/issues/` was
touched; only this report is new there. **No `core/prompts/*.md` file was changed**: neither
`noting.md` nor `consolidation.md` mentions compaction, a compaction view or a catchup drain, so both
prompt hashes are unchanged (`noting.md` `2703264817a3…`, `consolidation.md` `c42db300ad1b…`).

**The native Pi acceptance check of this ticket is the acceptor's**, not mine: it needs a live
provider, and this slice was implemented and verified with deterministic tests only — no credentials,
no live provider, public SDK only. The exact steps are at the end of this report.

---

## Verification

Every command ran in the foreground on Node 24.6.0 with an explicit timeout; no background waits.

| Check | Before | After |
|---|---:|---:|
| `npm test` | 533 passed, 26 files | 533 passed, 26 files |
| `npm test` (baseline `91688b8`) | 521 passed, 25 files | — |
| `npm run typecheck` | Passed | Passed (also after every probe restoration) |
| `npm run smoke:pi` | Passed | Passed: one native Noting run and one fact |
| `git diff --check` | Clean | Clean |
| Revert probes | Not applicable | Four applied, each red on a named test, each restored byte-for-byte |
| HEAD / staged / commits by this slice | `91688b8` / none / none | `91688b8` / none / none |

Twelve new cases, all titled **20c 2026-09-08…**: three in `core/api/read.test.ts`, one in
`core/api/rulings.test.ts`, six in the new `hosts/pi/compaction.test.ts`, two in
`hosts/pi/manual-catchup.test.ts`. 521 + 12 = 533. Three pre-existing cases changed meaning where 20c
supersedes what they pinned; they are listed under **Existing tests that moved** below.

## Scenario-to-test mapping

| Ticket checkbox | Implementation | Named test |
|---|---|---|
| Scenario 9: all normal views fit; the result holds them, historical facts take the remaining shared space, no worker starts, no progress changes | tier 1 in `compact` (`core/api/read.ts`), through the unchanged `budgetMaterial` | **20c 2026-09-08 scenario 9: all pending primary views fit, historical facts take the remaining shared space, and no worker starts or progress changes** (`core/api/read.test.ts`) |
| Scenario 10: normal views over the Raw cap, secondary views fit; every selected entry represented; tool arguments/results absent, names and trace identity present; truncation marked; original trace output unchanged | `renderEntrySecondary` (`core/render/index.ts`), `RAW_SECONDARY_TITLE` (`core/render/material.ts`), tier 2 in `compact` | **20c 2026-09-08 scenario 10: primary views over the shared ceiling become labelled secondary views that keep every selected entry, drop tool arguments and results, and mark truncation** (`core/api/read.test.ts`) and **20c 2026-09-08 scenario 10: the host hands Pi the labelled secondary summary and names the tier in its own diagnostics** (`hosts/pi/compaction.test.ts`) |
| Scenario 11: even secondary metadata over the cap; no custom replacement; Pi's native path runs; failure and cancellation create no boundary, erase no sources, confirm no deliveries | tier 3 in `compact`; the `session_before_compact` handler returns nothing (`hosts/pi/index.ts`) | **20c 2026-09-08 scenario 11: when even secondary views miss a cap compact asks for native compaction with the reason, and changes nothing** (`core/api/read.test.ts`) and **20c 2026-09-08 scenario 11: the host returns no custom replacement when compact delegates, and an attempt that never persists establishes no boundary** (`hosts/pi/compaction.test.ts`) |
| Scenario 12: a Noter held open across compact; compact neither waits nor launches; committed data survives; duplicate Raw harmless; summaries never re-enter the queue | no change needed — the handler's `flush()` is `reconcile(false)`, and `compact` takes no claim | **20c 2026-09-08 scenario 12: compact neither waits for nor launches a Noter, a concurrent commit survives it, and no summary re-enters the source queue** (`hosts/pi/compaction.test.ts`) |
| Scenario 13: after custom and after native compaction, a task with pre-boundary entries runs subagent with full primary material and a recorded reason; mixed batches; a task prepared but not launched; a reopen; a sibling compaction | `preCompactionEvidence` + `effectiveMode` at admission and the `NotForkable` recheck in the fork arm (`hosts/pi/index.ts`) | **20c 2026-09-08 scenario 13: a persisted compaction on the selected ancestry sends a Noter with pre-boundary entries to subagent with a recorded reason; a sibling path's does not** (fake host) and **20c 2026-09-08 scenario 13/14 (native): a real persisted compaction downgrades the next Noter, while the fork already running keeps its own frozen context** (real `SessionManager.appendCompaction`) |
| Scenario 14: a started fork keeps its frozen context across foreground compaction; a post-only task may use the normal mode; cache suppression and requested/actual audit unchanged | nothing restarts or cancels a running fork; the rule is per-task | the native case above, plus **20c 2026-09-08 scenario 14: a task whose frozen entries all follow the boundary keeps the configured mode, and the requested/actual audit is unchanged** (`hosts/pi/compaction.test.ts`) |
| Scenario 16: a frozen catchup target of more than one batch in both phases with a below-trigger tail drains Noting then Consolidation in subagent, excluding later entries and unrelated facts; stop leaves committed work and the remaining target pending | no production change: `driveCatchup`'s existing chain plus 20b's Consolidation batch ceiling already drain both phases (see **Catchup** below) | **20c 2026-09-08 scenario 16: 18b's single Consolidation call is superseded — catchup drains successive bounded batches in both phases until the frozen target is exhausted** and **20c 2026-09-08 scenario 16: stop between Consolidation batches discards the remaining plan only, leaving the committed batch and the rest of the frozen target** (`hosts/pi/manual-catchup.test.ts`) |
| Superseded rulings | — | **20c 2026-09-08: 'compaction never calls a model' is superseded only by Pi's native fallback, and no core tier calls one** (`core/api/rulings.test.ts`); 18b's single Consolidation call is named in the scenario-16 test title |
| Native check | — | the acceptor's, steps below |
| Revert probes | — | see **Probes** |

## The secondary view: versioned constants and an example

One constant set, in `core/render/index.ts`, documented at its definition and exercised by the tier
tests. These lengths are an implementation choice, not a user ruling (confirmation 2026-09-08):

| Constant | Value | Meaning |
|---|---|---|
| `SECONDARY_VIEW_VERSION` | `"20c-v1-bounded-excerpts"` | printed in every secondary entry header, so a reader can tell which truncation rule produced the text |
| `SECONDARY_EXCERPT_TOKENS.user` | 120 | token budget of a user excerpt, *including* its source label and its omission marker |
| `SECONDARY_EXCERPT_TOKENS.assistant` | 60 | the same for an assistant excerpt; the user side keeps more because it is the instruction the rest of the work answers |

Tool fragments have no budget at all: they are one fixed line each, and an entry with hundreds of
them is exactly the "excessive mandatory metadata" case that escalates to tier 3.

Before (primary view, `renderEntry`) and after (secondary view, `renderEntrySecondary`) for one
assistant entry with a tool call:

```
[S1/T2] [entry ["pi-abc","e14"]]
[Source entry id: T2#assistant]
I will read the config and then patch the loader. The plan has several steps … (1,196 characters)
[T2#t1] tool=Bash call=call_991 status=attempted arguments:
{"command":"rg -n loader src"}
```

```
[S1/T2] [entry ["pi-abc","e14"]] [compact-only view 20c-v1-bounded-excerpts]
[Source entry id: T2#assistant]
I will read the config and then patch the loader. The plan has several steps that 
[omitted 1146 characters; middle not inspected]
hrough one by one. The plan has several steps that we will go through one by one. 
[T2#t1] tool=Bash call=call_991 status=attempted [arguments omitted]
```

The header, the `[Source entry id: …]` boundary, the occurrence address `T2#t1`, the tool name, the
call id and the status survive; the arguments do not; the omission marker is the wording the primary
view already uses. The block itself is titled
`Raw (compact-only secondary views; tool arguments and results omitted, text excerpted):` instead of
`Raw:`, so the label is charged to the episodic budget exactly once and replaces nothing else.

## Design choices

**Reused, not rebuilt.** `budgetMaterial` (unchanged apart from reporting how far over each cap it
is), `compactText`, `renderEntry`, `entryExcerpt` and its omission wording, `finish`, `xmlBlock`,
`checkpointReadiness`, `forkable`, `NotForkable`, the `effectiveMode` resolution of 19c, the
`attemptPhase` admission path and the whole catchup controller all stayed. The new production code is
one render function, one budgeting field, one escalation function body and two host functions.

1. **`compact` returns a tier, not a string.** `CompactResult` is
   `{tier: "primary" | "secondary"; text} | {tier: "native"; reason}`. The tier is the whole
   contract: there is no fourth outcome, no empty success and no "text plus a warning". The host's
   handler binds tiers 1–2 to `compaction.summary` and returns nothing for tier 3, which is exactly
   how a Pi extension declines a custom replacement.
2. **One `build(views, title)` closure for both tiers**, so the recheck of step 4 is literally the
   same accounting as step 2 — it cannot drift. Only the view function and the block title differ.
3. **`budgetMaterial` gained `over: {current, episodic}`** instead of compact string-matching its own
   receipts. Two lines, one caller that reads it (compact); every other caller ignores it. This is
   the smallest honest way to ask "did it fit?" of the function that decided.
4. **The secondary view lives beside `renderEntry`**, in `core/render/index.ts`, because it reuses
   `entryExcerpt` (and therefore the omission marker) and because the two views must stay comparable.
   It takes no `Budgets`: its constants are fixed and versioned, not configurable, so no new setting
   was added and 20b's "one effective Raw ceiling" is untouched.
5. **The boundary is read, never stored.** `preCompactionEvidence(context, nativeIds)` scans
   `sessionManager.getBranch()` for the last `type: "compaction"` entry and compares ancestry
   positions. Pi appends that entry only after a compaction persisted, and only on the path it
   happened on, so "a request", "a failed or cancelled attempt" and "a sibling path" establish
   nothing *by construction* rather than by a check I had to write. Nothing is cached, so reopen and
   tree navigation re-derive it; nothing consults wall clocks, database entry ids or a
   current-context flag.
6. **Two call sites, one rule.** `effectiveMode(requested, {kind, target})` resolves a requested fork
   to subagent at admission — so the delivery pause, the readiness wait and the capacity budget all
   follow what will really run — and the fork arm of `runAgent` rechecks against the *exact frozen
   set* (`input.entryAudit.entries`) at the actual launch, throwing `NotForkable`. That reuses 19c's
   fallback route wholesale: `fallbackReason`, the one-per-session notice, the preserved
   `requestedMode` in the run record and the existing model-selection rule all come for free. At
   admission the check uses the pending set, which is exact for this purpose: Noting selects an
   oldest-first prefix, so if any pending entry precedes the boundary, the oldest one does.
7. **`// ponytail:`** — none was needed. The one place I would have cut a corner (deciding "did it
   fit?" by matching the `raw ceiling:` receipt text) is the two-line `over` field instead, which is
   cheaper *and* correct. If a future ticket wants per-tier receipts inside the block, the
   `build` closure is the single place to add them.

**Catchup: no production change was required, and that is the finding.** 18b's `driveCatchup` already
re-enters itself after every batch and re-derives the phase from the frozen target
(`remainingEntries ? "noting" : remainingFacts ? "consolidation" : done`). Once 20b gave Consolidation
a 10,000-token batch ceiling, that loop *became* a multi-batch Consolidation drain; the "one
Consolidation call" wording had already stopped describing the code. So this slice supersedes the
wording, pins the behaviour with a named test, and adds a revert probe that reinstates the single
call. The stop path is likewise unchanged: stop sets `c.stopped`, the settled handler makes stop win
the race, and nothing durable is deleted.

**Where a fake-host test could not carry the whole rule.** A fake-host fork always falls back for
"No current-branch provider payload captured", so "a running fork survives compaction" cannot be shown
there. That half is in the native fixture, against a real `SessionManager.appendCompaction`, a real
child `AgentSession` and a real fork gate.

## Probes

Each probe ran the full suite in the foreground and was reverted before the next; restoration was
verified with `shasum -a 256` against the pre-probe hash
(`core/api/read.ts` `5bc5fccc2e30c1936d41fc2c9a63d11b5b3592db66314224c5e02ec280337119`,
`hosts/pi/index.ts` `543d8be4ce32322f3dbdfeb4b217b155347f9d93eb7bc435f5d8e8de88939585`).

| # | Mutation | Red test(s) | Failed / total | Restored |
|---|---|---|---|---|
| a | A tier that hides selected entries to fit: after the secondary block misses a cap, drop the oldest views one by one until it fits and return `{tier: "secondary"}` (`core/api/read.ts`) | **20c 2026-09-08 scenario 11: when even secondary views miss a cap…**; **20c 2026-09-08 scenario 11: the host returns no custom replacement…**; **20c 2026-09-08: 'compaction never calls a model' is superseded only by Pi's native fallback…** | 3 / 533 | `core/api/read.ts`, hash above |
| b | Compact launching a Noter: `checkQueues()` at the top of the `session_before_compact` handler (`hosts/pi/index.ts`) | **20c 2026-09-08 scenario 12: compact neither waits for nor launches a Noter…** | 1 / 533 | `hosts/pi/index.ts`, hash above |
| c | A boundary inferred from an attempt rather than a persisted entry: a `compactRequested` flag set in the handler, honoured by `preCompactionEvidence` when the ancestry holds no compaction entry (`hosts/pi/index.ts`) | **20c 2026-09-08 scenario 11: …an attempt that never persists establishes no boundary** | 1 / 533 | `hosts/pi/index.ts`, hash above |
| d | Catchup stopping after one Consolidation call: the settled handler completes the drain as soon as a Consolidation batch returns (`hosts/pi/index.ts`) | **20c 2026-09-08 scenario 16: 18b's single Consolidation call is superseded…**; **20c 2026-09-08 scenario 16: stop between Consolidation batches…** | 2 / 533 | `hosts/pi/index.ts`, hash above |

Probe (b) is worth a note: in its first form it turned nothing red, because the two existing
"compaction launches nothing" cases either had the Noting slot already occupied or had no due work at
that moment. Scenario 12 was strengthened with a third phase — due work, a free slot, then compact —
before the probe was accepted. The rule was under-tested, not the probe wrong.

## Production line delta

| Area | Added | Removed | Net |
|---|---:|---:|---:|
| `core/render/index.ts` (`SECONDARY_VIEW_VERSION`, `SECONDARY_EXCERPT_TOKENS`, `renderEntrySecondary`) | 31 | 0 | **+31** |
| `core/render/material.ts` (`RAW_SECONDARY_TITLE`, `budgetMaterial.over`, `compactText`'s title) | 15 | 5 | **+10** |
| `core/api/read.ts` (`CompactResult`, the five escalation steps) | 46 | 16 | **+30** |
| `core/api/index.ts` (exports, façade signature) | 6 | 4 | **+2** |
| `hosts/pi/index.ts` (`preCompactionEvidence`, `effectiveMode`, the compact handler, the launch recheck, the status line) | 58 | 8 | **+50** |
| Production total | 156 | 33 | **+123** |
| Tests (incl. the new `hosts/pi/compaction.test.ts`, 185 lines) | 469 | 34 | +435 |
| Documentation | 106 | 31 | +75 |

## Superseded rulings recorded

- **"Compaction is instant and never calls a model"** (`.scratch/v1/spec.md` §Solution and user story
  6; `CONTEXT.md` **Compaction**) → superseded by ticket 20 on 2026-09-08, and **only** by the native
  fallback. Test: **20c 2026-09-08: 'compaction never calls a model' is superseded only by Pi's
  native fallback, and no core tier calls one**, which walks all three tiers and asserts the façade's
  `runAgent` is never reached, that tier 3 carries no `text`, and that a Noter's material still uses
  primary views.
- **18b's single Consolidation call** ("…then one Consolidation batch against the frozen fact set",
  `.scratch/v1/spec.md` §Manual catchup and stop, `hosts/pi/README.md`) → superseded by ticket 20 on
  2026-09-08: both phases drain successive bounded batches. Test: **20c 2026-09-08 scenario 16: 18b's
  single Consolidation call is superseded — catchup drains successive bounded batches in both phases
  until the frozen target is exhausted**.
- 20b's own note that "compact still keeps every pending entry with a `raw ceiling:` receipt" is
  retired by this slice's escalation; `core/README.md` now says where an over-ceiling block can still
  occur (a worker's outer framing, never compact).

## Existing tests that moved

Three pre-existing cases pinned behaviour 20c changes; each keeps its subject and says why it moved.

- `core/api/read.test.ts` *compaction retains oversized raw with standard tool cuts and receipts
  outside XML* → *…with standard tool cuts, in its primary views*. It squeezed `episodicBlockTokens`
  to 70 and asserted `raw overage:` — the superseded "keep it and receipt it" behaviour. It now gives
  the shared caps room, asserts `tier === "primary"`, and keeps every 17a excerpt assertion. The
  receipt placement and the historical-fact omission it also carried are pinned by scenario 9 and by
  the neighbouring *newest facts fit before older facts* case.
- `core/api/rulings.test.ts` *20b … 50,000-token Noting batch is superseded…* asserted a
  `raw ceiling:` receipt from compact. It now asserts that the same Raw escalates to `secondary` under
  the one shared ceiling and returns to `primary` when that one ceiling is raised — the same ruling
  ("one effective Raw ceiling, no second knob"), pinned through the new behaviour.
- `hosts/pi/entries.test.ts` *17a … identical bounded entry bytes* compares compact, carry, Noter and
  fallback bytes. Its host now gets `noting.batchTokens: 100_000`, exactly as the subagent Noter in
  the same test already did, so all four consumers are comparable instead of one of them escalating.
- `hosts/pi/manual-catchup.test.ts` *18b … drains bounded Noting batches then integrates…* kept its
  `toHaveLength(1)` on Consolidation runs; only its comment changed, from "Consolidation is not
  chunked like Noting" to the truth (those few short facts fit one bounded batch).

Every other call site changed only because `compact` returns a tier: they read it through the new
test helper `compacted(result)` in `test/source-fixture.ts`, which throws with the delegation reason
if a case unexpectedly reaches tier 3 instead of silently comparing against `undefined`.

## Documentation

- `hosts/pi/README.md`: new section **Compaction tiers and the post-compaction boundary (20c)** with
  the tier table, the secondary view's contract, the native fallback and the whole admission rule; the
  compaction bullet under *Host decisions and boundaries* now describes the tiered return; the manual
  catchup section says *successive bounded Consolidation batches* and names the superseded 18b
  wording; the manual-verification step 4 says how to reach each of the three tiers.
- `core/README.md`: `compact` documented as a tier-returning function with its condition table, the
  secondary view's guarantees and its non-use everywhere else; the compact row of the material-order
  table now names the two possible view kinds; the "a current block over its ceiling" sentence
  corrected, since compact can no longer produce one.
- `.scratch/v1/spec.md`: the "never calls a model" rule superseded in the Solution paragraph, in user
  story 6, in the `hosts/pi` responsibilities line and in **Overflow policy**, where the five
  escalation steps are now stated; the post-compaction admission rule added beside the existing
  "compaction launches neither phase" bullet; **Manual catchup and stop (18b)** now says successive
  Consolidation batches, naming 20c and the date.
- `CONTEXT.md` (terms only): **Compaction** rewritten around the three tiers; two terms added —
  **Compact-only secondary view** and **Compaction boundary** (the term the ticket suggested).
- No `core/prompts/*.md` change; both prompt hashes are unchanged.

## Honest limits

- **The estimator is an estimate.** Every cap here is measured with the project's local estimator over
  the exact rendered text (7.2% mean absolute error on this project's own corpora), not a provider
  tokenizer. Tier boundaries therefore sit where the estimator puts them, and the host's real-context
  reserve stays independent, as ruled.
- **The excerpt budgets are untuned.** 120/60 tokens are a documented, versioned choice, not a
  measured optimum; the ticket explicitly says not to present one as a user ruling. Changing them is
  a version bump of `SECONDARY_VIEW_VERSION` and nothing else.
- **Tier 2 is not a guarantee.** Secondary rendering may fail capacity and delegate; it does not
  promise to fit an arbitrarily large backlog, and many tiny entries reach tier 3 sooner than one
  large one does.
- **An entry the selected ancestry no longer carries counts as pre-boundary.** That is the
  conservative direction (a fork would not inherit it either), and it can only be reached once a
  compaction entry exists on the path — with no compaction, the function returns immediately.
- **The admission-side check reads the pending set, the launch-side check reads the frozen set.** The
  first is a prefix argument, not an identity; the launch recheck is what the ruling actually
  requires, and it is exact.
- **The fallback reason is prefixed `native runner: `** by the existing 19c route
  (`native runner: pre-compaction evidence: 3 selected entries precede the persisted compaction e14`).
  I reused that route rather than adding a second one; the reason text itself is unambiguous.
- **No live provider run.** `npm run smoke:pi` is the only real-runtime check, as in 19b/19c/20a/20b.
  The native fixture exercises a real `SessionManager`, a real `appendCompaction`, a real child
  `AgentSession` and the real fork gate, but its HTTP is stubbed.

## The native Pi check the acceptor must perform

A fake compaction event does not prove that declining reaches Pi's own compaction, nor that only a
persisted compaction establishes the boundary. Run this against a real provider.

**Setup.** Use a scratch database so nothing else is disturbed:

```sh
export TRACE_MEMORY_CONFIG='{"dbPath":"/private/tmp/trace-memory-20c/trace.db"}'
pi --mode rpc --extension /Users/zhaoqixuan/Projects/trace-memory/hosts/pi/index.ts
```

RPC drives compaction with `{"type": "compact"}` (docs/rpc.md §Compaction); `{"type":"prompt", …}`
sends turns, and `{"type":"get_entries"}` reads the session tree. The TUI equivalent is `/compact`,
and the same observations hold. The session JSONL is the file `sessionManager.getSessionFile()`
reports (under `~/.pi/agent/sessions/…`).

1. **Tier 1 reaches Pi as a custom summary, with no model call of ours.** Send two or three short
   prompts, then `{"type":"compact"}`. Expect the `Trace Memory: compaction used primary views.`
   notice, and a `compact` response whose `data.summary` starts with `<knowledge>` or `<episodic>`.
   In the JSONL, the appended `{"type":"compaction"}` entry must carry `"fromHook": true` and no
   `usage` field. `/trace runs` must show **no new run** at that moment, and `/trace status` must show
   `Compaction: primary views`.
2. **Tier 2.** Restart with `render.episodicBlockTokens` small enough that the pending views no longer
   fit (e.g. `'{"dbPath":"…","render.episodicBlockTokens":400}'`), build up a few hundred tokens of
   pending Raw, and compact. Expect `compaction used secondary views`, and a summary whose Raw block
   is titled `Raw (compact-only secondary views; …)` with `[compact-only view 20c-v1-bounded-excerpts]`
   headers, tool lines ending `[arguments omitted]` / `[result omitted]`, and no tool argument or
   result text anywhere. The JSONL entry is again `"fromHook": true`, still with no `usage`.
3. **Tier 3 actually reaches Pi's own compaction (the point of this check).** Restart with
   `render.episodicBlockTokens` very small (e.g. 40) over the same pending Raw and compact. Expect
   `compaction used native delegation — …exceed the episodic budget by N tokens (cap 40)`. The
   `compact` response's `data.summary` is now **Pi's** structured summary, not `<knowledge>`; the
   JSONL compaction entry has **no** `fromHook: true` and **does** carry a `usage` object — that
   usage is the proof a real provider call happened on Pi's path. `/trace runs` still shows no Trace
   Memory run for it, and `/trace status` reads `Compaction: native delegation — …`.
4. **A failed or cancelled compaction persists nothing.** With tier 3 still forced, abort the
   compaction (interrupt during the summarization call, or point the model at an unreachable
   provider). Count the compaction entries before and after
   (`grep -c '"type":"compaction"' <session>.jsonl`): the count must not change, and `pendingEntries`
   / `/trace status` must be unchanged. This is what makes step 6 meaningful.
5. **Post-compaction admission, before and after.** Reset `TRACE_MEMORY_CONFIG` to the plain
   `dbPath`, then converse until an automatic Noting fires while no compaction exists on the path.
   `trace R<n>` must show `mode fork` and no `fallbackReason`.
6. **Post-compaction admission, after the boundary.** Compact successfully (step 1 or 3), then
   converse enough for another Noting to fire while entries from *before* that compaction entry are
   still pending. `trace R<n> full` must show `mode subagent`, and the run's response JSON must carry
   `"requestedMode": "fork"` together with a `fallbackReason` containing `pre-compaction evidence`.
   Confirm that `/trace status` shows **no** `Fork: suppressed` line: this is a per-task decision, not
   the cache-miss latch.
7. **Only the persisted entry matters.** Repeat step 6 in a session where step 4's failed attempt is
   the only compaction: the run must be `mode fork` again. And after a batch whose entries all follow
   the boundary, the run must return to `mode fork` with no pre-compaction reason.
8. **Catchup drains both phases.** With `consolidation.batchTokens` set small (e.g. 400) and a
   backlog, run `/trace catchup` and confirm from `/trace runs` that more than one Consolidation run
   was recorded, all `mode subagent`, and that `/trace status` ends at `Catchup: completed`.
