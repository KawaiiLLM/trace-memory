# Ticket 19c, third dispatch — the rename to fork, legacy labelling and the closing bookkeeping: acceptance report

**Ready for acceptor review.** Baseline: `aebb9c0`, *Ticket 19c (second half): the native runner is
the only runner; the request-copy runner and the handwritten settings reader are deleted*, read with
`git log -1 --oneline` before implementation. The initial working tree was clean; HEAD is unchanged,
nothing is staged and nothing is committed. No pre-existing file under `.scratch/v1/issues/` was
touched; only this report is new there.

This dispatch renames the **execution mode** from `branch` to `fork` in types, configuration, status
and notice wording, run metadata, docs and the glossary, accepts the old configuration spelling as an
alias, and labels historical `branch`-mode runs as legacy request-copy execution on the read side
without rewriting a single stored value. The **evidence path** called branch is untouched everywhere.

---

## Verification

Every command ran in the foreground on Node 24.6.0 with an explicit timeout; no background waits, no
credentials, no live provider. The suite takes ~23 s.

| Check | Before | After |
|---|---:|---:|
| `npm test` | 487 passed, 25 files | 494 passed, 25 files |
| `npm run typecheck` | Passed | Passed, including after each probe restoration |
| `npm run smoke:pi` | Passed | Passed: one native Noting run, one fact |
| `git diff --check` | Clean | Clean |
| Revert probes | Not applicable | Four applied, each red on its named test, each restored byte-for-byte |
| HEAD / staged / commits | `aebb9c0` / none / none | `aebb9c0` / none / none |

Test count rises by 7: **7 new cases**, all titled `19c 2026-09-08:` (4 in `core/api/rulings.test.ts`,
3 in `hosts/pi/enrollment.test.ts`). No case was deleted. Existing cases changed only by the
mechanical rename of mode strings and configuration keys, plus one added row in an 18a validation
table (below). File count stays 25 because `hosts/pi/branch.test.ts` was renamed, not removed.

## Owned checkbox

> **Checkbox 4.** Rename: canonical `fork` in new metadata and configuration, `branch` accepted as an
> alias with the canonical form winning and the conflict reported; historical runs keep their actual
> mode; docs, prompts, status wording and the glossary change together.

| Requirement | Where it is now | Named test |
|---|---|---|
| Canonical `fork` in new metadata | `RunAgentResult.mode`, `NotingInput`/`ConsolidateInput.mode`, the two `*AgentInput.mode`, `NativeForkTask.mode`, `composeTask`'s selector, `taskEligibility`, `launch`, `attemptPhase`, `forkWait`. A committed run row gets `mode = "fork"` through `run.mode = result.mode ?? mode` | **19c 2026-09-08: new work records the canonical fork spelling, in the task input and in the run record** |
| Canonical `fork` in configuration | `noting.forkModeDefault` in `TraceMemoryConfig`, `DEFAULT_CONFIG`, `validateConfig`, the host's flat key space, the read-only settings menu and the README examples. `consolidation.subagentModeDefault` keeps its name — it already names the fresh-context mode | **19c 2026-09-08: the legacy execution-mode key still selects the mode, and the menu shows the canonical key with its source** |
| `branch` accepted as an alias | `CONFIG_ALIASES` in `core/api/index.ts`, applied to the nested `ConfigOverride` (`canonicalConfig`) and to each flat settings layer (`canonicalFlatConfig`, used by `hosts/pi`) | **19c 2026-09-08: the legacy branchModeDefault spelling is accepted, mapped onto forkModeDefault, and not kept** |
| Canonical wins, conflict reported | Same value under both spellings → the canonical one, silently. Different values in one layer → the load fails naming both keys | **19c 2026-09-08: both execution-mode spellings with different values fail the load naming both keys** (core) and **19c 2026-09-08: one layer supplying both execution-mode spellings with different values fails the load naming both** (host) |
| Historical runs keep their actual mode | Nothing writes to `runs.mode` except a new run's own commit. No migration, no update on open, no rewrite on read; the read side labels instead | **19c 2026-09-08: a stored branch-mode run reads as legacy request-copy execution and is never rewritten** |
| Docs, prompts, status wording, glossary together | `CONTEXT.md` (new **Fork**/**Subagent** terms), `core/README.md`, `hosts/pi/README.md`, `.scratch/v1/spec.md`, `hosts/pi/LIVE-VERIFICATION.md` (procedure only), status/notice strings. Prompts name no execution mode, so no prompt changed and no prompt hash moved | the grep-style claim is stated below and verified by review, not by a test (see *Honest limits*) |

Rulings this dispatch had to satisfy, and where each is pinned:

- **User ruling 「branch 改名为 fork」** — delivered by the sweep listed under *What was renamed*.
- **Execution mode** ("New task options, configuration, status text, prompts and run metadata use
  fork … Rename the Noting branch-mode configuration to its fork equivalent; do not introduce a
  second overlapping mode-selection scheme") — one key, `noting.forkModeDefault`, with one alias
  entry that maps onto it. No second switch, no per-task new option, no mode registry.
- **Path identity** — no session id, branch id, source address, knowledge commit address or
  evidence-path term changed. The complete list of untouched `branch` occurrences is below.
- **Legacy input** — the alias table, the canonical-wins rule, the reported conflict, and no runner
  behind the alias (there is only one runner since 19c2; the alias selects a *mode*, not a runtime).
- **Historical truth** — the read-side label plus the probe that a rewrite goes red.
- **18a** — unknown keys still throw with the key named; the alias is a *known* key, so it does not
  throw; per-key sources still show, under the canonical name, with masking intact. A value rejected
  under the legacy spelling names the key the user actually wrote:
  `Invalid noting.forkModeDefault (supplied as noting.branchModeDefault)`.
- **17b thresholds, 17c claims/cancellation, 18a enrollment, 18b catchup, the 19a gate, 19b's
  material/compose boundary, 19c1's readiness/latch, 19c2's single runner** — unchanged. The only
  behavioural additions are the alias resolution and the read-side label.

## What was renamed

**Files** (git shows them as one delete plus one untracked add):

| Before | After | Why |
|---|---|---|
| `hosts/pi/branch.ts` | `hosts/pi/fork.ts` | after 19c2 the module is only the fork gate (`verifyForkRequest`, `verifyNativeRequest`, `stripCacheControl`, `capturedSystemPrompt`, `capturedTools`, `hash`/`serialize`); its name was the execution mode's, never the path's. Importers updated: `hosts/pi/index.ts`, `hosts/pi/native.ts`, `hosts/pi/native.test.ts`, the README's manual-verification script |
| `hosts/pi/branch.test.ts` | `hosts/pi/fork.test.ts` | same module's tests; `import * as branch` → `import * as fork` |

**Symbols, keys and strings**, by file (production):

| File | Renamed |
|---|---|
| `core/api/index.ts` | `TraceMemoryConfig.noting.branchModeDefault` → `forkModeDefault`; the same key in `DEFAULT_CONFIG`; `RunAgentResult.mode` union; `TraceMemory.taskEligibility(..., mode)` union and its `mode === "fork"` pause rule; `execute`'s admission-time mode resolution (`cfg.noting.forkModeDefault ? "fork" : "subagent"`, `cfg.consolidation.subagentModeDefault ? "subagent" : "fork"`) |
| `core/noting/index.ts` | `NotingInput.mode`, `NotingAgentInput.mode` unions; `freezeNoting`'s default; local `branchTokens` → `forkTokens` |
| `core/consolidation/index.ts` | `ConsolidateInput.mode`, `ConsolidationAgentInput.mode` unions; `freezeConsolidation`'s default |
| `core/store/index.ts` | the `RunInput.mode` doc comment (now states that new work writes `fork`/`subagent` and that the column stays a free string because pre-rename rows carry `branch`); "what each **fork-mode** consumer reads out of the conversation" |
| `core/render/index.ts` | new `runMode(mode)`; `renderRun`'s mode line now prints `runMode(run.mode)` |
| `hosts/pi/index.ts` | the `runAgent` local `mode` union; `composed(selected)` union and `composed("fork")`; the fork arm `input.mode === "fork"`; `mode: "fork"` in the `NativeForkTask`; `mode = "fork"` after a successful fork; `launch()`'s local `branch` → `fork` and its returned `"fork"`; `attemptPhase`'s `selected.mode` union and the `prefixTokens` guard; `forkWait`'s union and `mode !== "fork"` guard; the 17:01 comment ("noting defaults to fork"), the model-freeze comment ("a fork run freezes the session model at launch") |
| `hosts/pi/native.ts` | `NativeForkTask.mode: "fork"`; the four `task.mode === "fork"` / `!== "fork"` guards (child preparation, verification construction, parent session identity, the `onPayload` gate) |
| `hosts/pi/compose.ts` | `composeMaterial(input, "fork"\|"subagent")`, `composeTask(input, "fork"\|"subagent")` and their branches |
| `hosts/pi/fork.ts` | the error string `Unsupported branch payload API` → `Unsupported fork payload API` |
| `hosts/pi/native-fixture.ts` (test fixture) | `mode: "fork"` in the fork task builder |

**Status, notice and menu wording.** `"…fell back to subagent mode. <reason>"` is unchanged, as
instructed. `/trace status`'s latch line (`Fork: suppressed since …; Retry fork in the /trace menu`)
and the menu's `Retry fork` item already said fork (19c1) and are unchanged. The settings menu now
lists `noting.forkModeDefault` because it is generated from `DEFAULT_CONFIG`. `renderRun` is the only
read surface that prints a mode; `/trace runs` prints each run's first line, which carries no mode.

**Documentation.**

| File | Changed |
|---|---|
| `CONTEXT.md` | added **Fork** and **Subagent** to *Process*, terms only, each stating it is the execution mode and not the evidence path; the *Run record* term now names the execution mode as part of what a run holds. The path-meaning entries (*Target*, *Claim*, *Trace*, *Manual catchup*) are untouched |
| `core/README.md` | the `runAgent` line ("Pi: fork mode = inherited context"), "The noting config chooses fork/subagent mode", "fork work runs in a native Pi child", "In fork mode the host sends the range, head reply and frozen source index", "the native prefix … fork Noting gains nothing from the compressed view" |
| `hosts/pi/README.md` | 25 lines: the opening two paragraphs, the settings example and the two configuration bullets, the delivery-gating and Consolidation paragraphs, the budget paragraph, `fork.ts` in the gate section, `requestedMode: fork` in the fallback sections, the compose section's **Inherited context (`fork`)**, the cache-miss latch bullets, the footer indicator, the manual-verification recipe (config key, database path `fork.db`, `hosts/pi/fork.ts`, `assert.equal(run.mode, 'fork')`), and the compressed-view section's "Fork-mode Noting … the accepted 2026-09-08 fork-mode choice" |
| `.scratch/v1/spec.md` | the `hosts/pi` contract paragraph (four places), the tool-inheritance sentence, the delivery-gating bullet, the executor paragraph's "fork-delivery gating", the 19a bullet's "fork-mode work", "Fork-mode Noting reads the uncompressed captured provider prefix", "Fork-mode verification compares request bodies", "The native fork prefix is never rewritten" |
| `hosts/pi/LIVE-VERIFICATION.md` | **procedure only**: the 19c note, the configuration to set, steps 2 and 4. Every recorded session below them keeps its historical wording, including the pre-08 key spellings (`note.branchModeDefault`) and the per-run `branch` mode column — those describe runs that really were request-copy runs |

**Prompts.** `core/prompts/noting.md` and `core/prompts/consolidation.md` mention no execution mode.
Their two `branch` occurrences are the evidence path ("sources must belong to the exact frozen entry
set on this branch"; "the … branch carry … are never fact sources"). **No prompt file changed, so no
prompt hash moved and no run record's `prompt_hash` is affected.** `git diff --stat core/prompts` is
empty.

**Tests.** Mechanical sweep of mode strings and configuration keys in
`core/api/{boundary,consolidation,rulings}.test.ts`, `hosts/pi/{native,index,cache-miss,compose,
readiness,enrollment,catchup,batching,manual-catchup,entries,fork}.test.ts`: `mode: "branch"` →
`mode: "fork"`, `.toBe("branch")` → `.toBe("fork")`, `"noting.branchModeDefault"` →
`"noting.forkModeDefault"`, `composeMaterial(x, "branch")` → `"fork"`, the `branchMode` parameter and
`branchInput` variable, and three comments/one title that said "branch mode"/"a branch note". Ruling
names and dates in test titles are unchanged. One addition inside an existing 18a case: the invalid
value row `["noting.branchModeDefault", "fork"]` next to the canonical row, so the legacy spelling's
type validation stays covered and still names the key as written.

## What was deliberately NOT renamed

Every remaining `branch` in the repository is the **evidence path** (a memory session's branch id) or
a Pi/Git branching word, not the execution mode:

| File | Count | Meaning |
|---|---:|---|
| `core/store/index.ts` | 72 | `runs.branch`, `source_paths.branch`, `pending_deliveries.branch`, `KnowledgePath.branch`, the schema columns, `listBranchFacts`, sibling-branch selection |
| `hosts/pi/index.ts` | 36 | `state.branch`, `Capture.branch`, target branches, `branch_summary` entries, the tree-switch comments; plus `NotForkable("No current-branch provider payload captured")` and `("The selected branch changed after admission")`, which are about the path |
| `core/api/index.ts` | 23 | façade parameters (`selectEntries`, `pendingEntries`, `deliver`, `compact`, `branchSummary`), the knowledge commit-tree text "all branches"; 3 of the 23 are the deliberate alias references (`CONFIG_ALIASES`, the `ConfigOverride` legacy field and its comment) |
| `core/api/read.ts` | 18 | path parameters, `<branch_carry>`, the "another branch" search status |
| `core/api/tools.ts` | 15 | `ToolContext.branch`, path construction, the source-eligibility message |
| `core/noting/index.ts` / `core/consolidation/index.ts` | 13 / 10 | the frozen target's branch, `RunInput.branch` |
| `core/render/index.ts` | 4 | `renderRun`'s `branch` field and its `S… / branch …` line; the two literals inside `runMode`, which exist precisely to recognise the historical value |
| `core/model/index.ts`, `core/consolidation/memory.ts` | 2 / 1 | `Run.branch`, `pendingDelivery.branch` |
| `core/prompts/noting.md` | 2 | "on this branch", "branch carry" |
| `CONTEXT.md` | 4 | *Target*, *Manual catchup*, *Trace*, and the new *Fork* entry's own disclaimer |
| `core/README.md`, `hosts/pi/README.md`, `.scratch/v1/spec.md` | 22 / 35 / 28 | path semantics, `branchSummary`, `<branch_carry>`, sibling branches, tree navigation, the `runs` schema line |
| `hosts/pi/LIVE-VERIFICATION.md` | 24 | historical session records (Historical truth) |

## The alias rule, and where it lives

It lives in **core**, in one table, because both hosts and the façade's own tests need the same rule:

```ts
export const CONFIG_ALIASES: Readonly<Record<string, string>> = { "noting.branchModeDefault": "noting.forkModeDefault" };
```

- `canonicalFlatConfig(values)` maps one **flat** `section.key` layer (a `settings.json` layer or
  `TRACE_MEMORY_CONFIG`); `hosts/pi`'s `configuration()` calls it on each layer before flattening, so
  the alias inherits that layer's source and the menu shows the canonical key with it.
- `canonicalConfig(override)` does the same for the **nested** `ConfigOverride` the façade takes, and
  `mergeConfig` calls it before 18a's unknown-key check — so `{ noting: { branchModeDefault: false } }`
  is accepted and `noting.branchModeDefault` never reaches the config object.
- `ConfigOverride`'s type gained one optional legacy field so the alias typechecks at the boundary.
- **Both spellings, same value → the canonical one wins silently.** There is no notice channel at the
  configuration boundary (the first `configuration()` call happens before any `ExtensionContext`
  exists), and an agreeing pair carries no information to report.
- **Both spellings in one layer, different values → the load fails**, naming both:
  `Conflicting settings noting.branchModeDefault and noting.forkModeDefault: true vs false;
  noting.branchModeDefault is the legacy spelling of noting.forkModeDefault — supply
  noting.forkModeDefault alone`. This is 18a's shape: a configuration problem is thrown at load with
  the keys named, never silently resolved.

**One interpretation stated openly.** The dispatch said "if both keys are supplied in the *effective*
configuration and disagree, loading fails". I applied the rule **per layer**, not across layers:
Global supplying the legacy key while Project or the environment supplies the canonical one is
ordinary 18a precedence (the later layer wins, the earlier is shown as `masked`), because that is
exactly the migration the alias exists for — a user updating one layer at a time must not be locked
out. Within one layer there is no ordering to appeal to, so the two spellings disagreeing is a real
ambiguity and the load fails. Both behaviours are pinned by name (the masking case as
**19c 2026-09-08: a legacy key in one layer is masked by the canonical key in a later layer, as any
other setting is**). If the acceptor wants the stricter cross-layer reading, it is a two-line change
in `configuration()` and one test edit.

The parent's "the canonical form wins **and** the conflict is reported" is satisfied literally in the
agreeing case (the canonical key is what survives) and, in the disagreeing case, by refusing rather
than guessing — nothing silently wins. I flag this because it is the one place where "wins" and
"reported" could be read as a value plus a warning instead of an error.

## The legacy label

`core/render/index.ts`:

```ts
export const runMode = (mode: string | null): string =>
  mode === "branch" ? "legacy request-copy execution (branch)" : mode ?? "?";
```

`trace R<n>` therefore prints `model old/model  mode legacy request-copy execution (branch)` for a
pre-rename run, `mode fork` and `mode subagent` for new ones. The wording is a statement of fact:
the rename shipped in the same ticket that deleted the request-copy runner, so every stored `branch`
belongs to a run that runner executed — it never ran in an `AgentSession`. Nothing writes to
`runs.mode` except the run's own commit; there is no migration, no update on open, no rewrite on read
(the probes below verify all three).

## Revert probes

Each mutation was applied alone, run in the foreground, then restored; the restored SHA-256 is listed
so the acceptor can confirm the tree is byte-identical to the reviewed state.

**(a) A terminology migration rewrites history.** `core/store/index.ts`, in the `Store` constructor:

```diff
     this.db.exec(SCHEMA_SQL);
+    this.db.exec("UPDATE runs SET mode = 'fork' WHERE mode = 'branch'");
   }
```

Red: **19c 2026-09-08: a stored branch-mode run reads as legacy request-copy execution and is never
rewritten** — `expected 'fork' to be 'branch'`; 1 failed, 48 passed (49) in `core/api/rulings.test.ts`.
Restored: `93126c3ccb907feff246b8a40f84f7b15913c03a0c7086d83d2658dfdcbaa235`.

**(b) The read side relabels an old run as a native fork.** `core/render/index.ts`:

```diff
-  mode === "branch" ? "legacy request-copy execution (branch)" : mode ?? "?";
+  mode === "branch" ? "fork" : mode ?? "?";
```

Red: the same named test — `expected 'R1 noting success …' to contain 'mode legacy request-copy
execution (branch)'`; 1 failed, 48 passed (49). Restored:
`817726c23281a5a65c91b9e2865d4f5bc3abbcad42931abb3db7e3245363a950`.

**(c) The alias conflict is resolved silently.** `core/api/index.ts`, both `throw aliasConflict(...)`
lines deleted (canonical simply wins). Red: **19c 2026-09-08: both execution-mode spellings with
different values fail the load naming both keys** and **19c 2026-09-08: one layer supplying both
execution-mode spellings with different values fails the load naming both**; 2 failed, 78 passed (80)
across `core/api/rulings.test.ts` and `hosts/pi/enrollment.test.ts`. Restored:
`7b6d3d5a82e0e27ba2a2b9170b4d67dc8456740f5315154ada1bc13e84440dbb`.

**(d) New work records the old spelling.** `core/noting/index.ts`:

```diff
-  run.mode = result.mode ?? mode;
+  run.mode = (result.mode ?? mode) === "fork" ? "branch" : (result.mode ?? mode);
```

Red: **19c 2026-09-08: new work records the canonical fork spelling, in the task input and in the run
record** (`expected 'branch' to be 'fork'`) and the historical-truth case
(`expected [ 'branch', 'branch' ] to deeply equal [ 'branch', 'fork' ]`); 2 failed, 47 passed (49).
Restored: `7076ac01ae465f8fea85726a2d4d796fc32db0e3ea91ff684164591481c63988`.

A first attempt at (d) mutated the *initial* `RunInput` instead of `run.mode`, and nothing went red —
because the committed row takes its mode from `run.mode = result.mode ?? mode` after the agent
returns. That is worth recording: the run record's mode has one writer, and it is that line.

Other files after the probes: `hosts/pi/index.ts`
`513d8ad58c376635f9a37d172622faeed7949408fb1934de246b5a329c1958bc`, `hosts/pi/fork.ts`
`a6212e8c81393a36dd7da901a5e8cef7bcf3a9abee3a74ad951822c31eafaaa1`.

## Production line delta

Production TypeScript only (`core/**` and `hosts/pi/*.ts`, excluding `*.test.ts`, `test-host.ts`,
`native-fixture.ts` and `smoke.ts`), with `hosts/pi/branch.ts` and `hosts/pi/fork.ts` compared as the
same file so the module rename does not inflate both columns.

**This dispatch**, against `aebb9c0`:

| File | + | − |
|---|---:|---:|
| `core/api/index.ts` | 60 | 9 |
| `core/render/index.ts` | 9 | 1 |
| `hosts/pi/index.ts` | 30 | 20 |
| `hosts/pi/native.ts` | 6 | 6 |
| `hosts/pi/compose.ts` | 5 | 5 |
| `core/noting/index.ts` | 5 | 5 |
| `core/store/index.ts` | 4 | 1 |
| `core/consolidation/index.ts` | 3 | 3 |
| `hosts/pi/fork.ts` | 1 | 1 |
| **Total** | **123** | **51** |

**Net +72.** About 51 of those lines are pure rename (equal counts on both sides). The growth is the
new mechanism this dispatch had to add: the alias table with its two resolvers and the widened
`ConfigOverride` (60 added lines in `core/api/index.ts`, 13 of them comments citing the rulings), the
host's per-layer canonicalization and supplied-spelling error naming (~10 lines), and `runMode` with
its Historical-truth comment (~9 lines). `core/api/index.ts` goes from 380 to 431 lines,
`hosts/pi/index.ts` from 839 to 849, `core/render/index.ts` from 380 to 388.

**Cumulative against the 19a baseline `d4a2df5`** (19b + 19c1 + 19c2 + this dispatch):

| File | + | − |
|---|---:|---:|
| `hosts/pi/native.ts` | 175 | 56 |
| `hosts/pi/index.ts` | 141 | 188 |
| `core/api/index.ts` | 66 | 11 |
| `core/noting/index.ts` | 66 | 27 |
| `core/consolidation/index.ts` | 54 | 22 |
| `hosts/pi/compose.ts` | 47 | 0 |
| `core/store/index.ts` | 34 | 2 |
| `hosts/pi/fork.ts` (was `branch.ts`) | 16 | 23 |
| `core/render/index.ts` | 9 | 1 |
| **Total** | **608** | **330** |

**Cumulatively +278 production lines, and it is honest to say so.** (These totals are measured
against the baseline blobs, so they do not equal 19c2's numbers plus this dispatch's: a line this
dispatch rewrote after 19b or 19c1 had already touched it counts once here. 19c2 reported +506/−300;
+123/−51 on top measures as +608/−330, not +629/−351.)

**Against the pre-ticket-19 commit `4c7d94f`: +846/−247**, i.e. **+599**. The single largest item is
`hosts/pi/native.ts` (360 lines, all new): the native child, the gate plumbing, the readiness probe
and the cache-miss eligibility table. `hosts/pi/index.ts` is roughly flat (+164/−163) although it lost
a whole conversation loop, because the fork arm, the latch and the readiness wait moved in.

What the diff *does* show for gate 2 is the shape of the simplification, not a smaller total: one
runner instead of two, no provider-message construction, no duplicated model/tool loop, no second
retry policy, no handwritten settings reader — while tickets 19b and 19c added structured material,
budget-before-selection, readiness, the latch and now the alias in the same window.

## Honest limits

- **A pre-existing flaky test, not caused by this dispatch.** `hosts/pi/catchup.test.ts` >
  *17c 2026-09-08: busy borrowed slots are not preempted or chained; later entries take oldest tails
  with stable branch order* asserts that `h.conversations[0]` is the borrowed **Noting**; both
  borrowed phases start in the same tick and the winner is whichever native child reaches the wire
  first. It failed 2 of 16 full-suite runs on the current tree and **1 of 15 on the untouched baseline
  `aebb9c0`** (extracted with `git archive` into a scratch directory and run there; the scratch copies
  were deleted afterwards). The final verification run above is green, and every isolated run of that
  file passes. Nothing in this dispatch touches scheduling; the assertion is order-sensitive by
  construction. Worth a separate fix (assert by content, not by index).
- **No grep-style "no execution-mode `branch` remains" test.** Distinguishing the two meanings needs
  an allowlist that would have to name almost every path-meaning line in the repository; per the
  dispatch's own option, I skipped it and relied on review. The classification table above is the
  audit, produced by reading every occurrence.
- **`hosts/pi/LIVE-VERIFICATION.md` now mixes spellings on purpose**: a fork-spelled procedure above,
  branch-spelled historical records below. That is Historical truth applied to prose, but a reader
  skimming the file will see both words.
- **The alias has one entry.** If a later ticket renames another key, `CONFIG_ALIASES` is the place;
  nothing else needs to know.
- **`RunInput.mode` stays `string | null`.** I narrowed it to `"fork" | "subagent"` briefly; it
  breaks the legitimate `updateRun(id, run)` round-trip that re-writes a row read back from the
  database — which is exactly the operation that must *preserve* a historical `branch`. The guarantee
  that new work writes `fork` is pinned by test, not by the type.
- **Not verified live.** No provider was called; the smoke test is the only end-to-end run, and it
  exercises fork mode against a fake provider.

## Ticket 19 as a whole, against the parent's gates

| Gate | State after this dispatch |
|---|---|
| **1. Prefix verification is the gate, not a deletion** | Satisfied. `verifyForkRequest` (now in `hosts/pi/fork.ts`) runs inside `onPayload` on the first body and every later round; the 2026-09-08 amendment's normalization (`cache_control` stripped from both sides, hashes of the raw bodies, `normalized` recorded) is in place and pinned on both `openai-completions` and `anthropic-messages`. A rejected body sends nothing and falls back with the rejected gate result recorded |
| **2. Net simplification is shown by the diff** | Reported, not claimed. One runner, no message construction, no duplicated loop, no second retry policy: **−150 production lines in 19c2**, and **+278 cumulative since `d4a2df5`** / **+599 since `4c7d94f`**, because 19b/19c added new obligations. The numbers are above; the ticket asked for them stated, and they are stated as they are |
| **3. The cache-miss latch counts only server-side misses** | Satisfied by 19c1: the deterministic prefix check runs first and a prefix-failed request is routed to subagent without touching the latch; one eligible `cacheRead = 0` after a passing check sets it, warns once, survives reopen, and clears only through the menu's Retry fork. Unchanged here except that its wording already said fork |
| **4. Budget is supplied before selection** | Satisfied by 19b/19c1: the adapter reports `capacity` (`inputTokens`, `prefixTokens`) before core freezes; core selects once. This dispatch renamed the local `branchTokens` to `forkTokens` and the `prefixTokens` guard's mode check, nothing more |
| **5. Native worker logs live next to the database** | Satisfied by 19a and untouched: `dirname(dbPath)/runs/<parent Pi session id>/`, configurable as `runsDir`, absolute path in the run record, retention documented as a v1 limit |
| **6. Settings come from Pi's `SettingsManager`** | Satisfied by 19c2 and untouched: the child is built with `SettingsManager.create(cwd, agentDir)`; the handwritten retry reader and its stale comment are gone |

Checkbox state of ticket 19c after this dispatch: readiness and launch (19c1), latch eligibility and
reset (19c1), deletion and the line delta (19c2 and the totals above), **rename (this dispatch)**, and
the revert probes across all three — restoring a lifecycle-style launch (19c1), counting a
prefix-failed request toward the latch (19c1), and rewriting historical run modes (probes (a) and (b)
above) each make a named test fail.
