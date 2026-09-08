# Ticket 20a acceptance report

**Ready for acceptor review.** Baseline: `1e1fd90`, *Ticket 20: shared memory material and bounded
compaction, split into 20a/20b/20c*, read with `git log -1 --oneline` before implementation. The
initial working tree was clean; HEAD is unchanged, nothing is staged and nothing is committed. No
pre-existing file under `.scratch/v1/issues/` was touched; only this report is new there. **No prompt
file was changed**: neither `core/prompts/noting.md` nor `core/prompts/consolidation.md` names a block
title, so the new order needed no prompt edit and both prompt hashes are unchanged.

---

## Verification

Every command ran in the foreground on Node 24.6.0 with an explicit timeout; no background waits, no
credentials, no live provider.

| Check | Before | After |
|---|---:|---:|
| `npm test` | 500 passed, 25 files | 509 passed, 25 files |
| `npm run typecheck` | Passed | Passed after both probe restorations |
| `npm run smoke:pi` | Passed | Passed: one native Noting run and one fact |
| `git diff --check` | Clean | Clean |
| Revert probes | Not applicable | Two applied, each red on a named test, each restored byte-for-byte |
| HEAD / staged / commits | `1e1fd90` / none / none | `1e1fd90` / none / none |

Twelve new cases: seven in the new `core/render/material.test.ts`, two in `core/api/boundary.test.ts`,
three in `core/api/rulings.test.ts`; all titled **20a 2026-09-08…**. Three cases were deleted with
`hosts/pi/compose.test.ts`; their byte pins were moved into `core/render/material.test.ts` in the new
order (500 − 3 + 12 = 509). Every other pre-existing case is retained and green.

## Checkbox and scenario mapping

| Ticket checkbox | Implementation | Named test |
|---|---|---|
| 1. Scenario 1: a host stub with no Pi/CC message types receives core-prepared text and completes note and two-submission memory runs; injection, compact and both phases share the rendering; no host file lays out the blocks | `core/render/material.ts` (one function per consumer); `text: {fresh, inherited}` on both agent inputs; `core/api/read.ts` calls `injectionText`/`compactText` | **20a 2026-09-08 scenario 1: a host stub with no provider message types runs note and the two-submission memory protocol from core's prepared text** and **20a 2026-09-08: no host file lays out the knowledge, fact, Raw or review blocks** (both `core/api/boundary.test.ts`) |
| 2. Scenario 2: two Noter tasks with identical knowledge and different Raw/ranges are byte-identical through the knowledge block; facts precede the range; receipts follow the dynamic material; Consolidation uses its ruled order | one `knowledgeBlock` for all four consumers, containing nothing task-specific; per-consumer block order | **20a 2026-09-08 scenario 2: two Noter tasks with the same knowledge and different Raw and ranges are byte-identical through the knowledge block**, **20a 2026-09-08 scenario 2: budget receipts follow the dynamic material in both phases**, **20a 2026-09-08: the Consolidator's fresh order is knowledge, already-consolidated facts, range, the pending facts, the reminders, then receipts** (`core/render/material.test.ts`), **20a 2026-09-08: nothing task-specific enters the leading knowledge block, and all four consumers render it identically** (`core/api/rulings.test.ts`) |
| 3. Inherited-context increment and full material come from one frozen task; the fork appends only the increment and the writable range is identical in both modes | `notingMaterial` / `runConsolidation` build both representations from the one frozen material; the host concatenates `prompt` + `text.inherited` | **20a 2026-09-08: the full text and the inherited increment come from one frozen task, and the writable range is identical in both modes** (`core/api/rulings.test.ts`), plus the two increment pins **…for ruling 08:53: the Noter's / the Consolidator's inherited increment is …alone** |
| 4. Revert probes | — | See Probes below |

Byte-wise order pins for the four consumers (all `core/render/material.test.ts`): **the Noter's fresh
order is knowledge, historical facts, range, the selected Raw, then receipts**; **the Consolidator's
fresh order is knowledge, already-consolidated facts, range, the pending facts, the reminders, then
receipts**; **the main agent's initial injection is knowledge and receipts only, and compact is
knowledge, historical facts, pending Raw, receipts**. Each asserts one full string, not a substring.

| Parent testing scenario | Named test |
|---|---|
| 1. Shared domain assembly | the two scenario-1 cases above; the injection/compact pin proves the shared component rendering (`inject(...)` equals the Noter's leading block, and `compact(...)` starts with it) |
| 2. Prefix ordering | the two scenario-2 cases and the stable-prefix ruling case above |
| 15 (host-stub part). Capacity negotiation | unchanged 19b gate-4 cases retained green (`core/api/boundary.test.ts`); the budget arithmetic itself is 20b |

Ruling coverage: ruling 2026-09-06 08:53 is pinned twice more, once per phase, on core's increment
bytes; the ticket-20 rulings "Core assembly", "Host binding", "Inherited context", "Stable prefix"
and "No cache simulation" each have a named test listed above.

## Design choices

**What moved, from where**

- `hosts/pi/compose.ts` (47 lines) and `hosts/pi/compose.test.ts` (72 lines) are **deleted**. Their
  layout is now `core/render/material.ts`, next to the renderers it calls, as one function per
  consumer over the material types: `notingText`, `notingIncrement`, `consolidationText`,
  `consolidationIncrement`, `injectionText`, `compactText`, plus the shared `knowledgeBlock`. Titles
  and the block separator are exported constants in that module; `finish` still appends receipts.
- `NotingMaterial` and `ConsolidationMaterial` moved into that module and are re-exported from
  `core/noting/index.ts` and `core/consolidation/index.ts`, so the public type names and
  `core/api/index.ts` exports are unchanged. The direction matters: `core/render` must not import the
  phases, so the contract lives with the rendering and the phases depend on it, not the reverse.
- `core/api/read.ts`'s `knowledgeFor` now returns a `SharedMaterial` instead of a pre-rendered
  `{content, receipts}`, and `inject`/`compact` call the shared functions. `branchSummary` was left
  alone: the parent's table does not list `<branch_carry>`, and it already reuses the shared
  renderers.
- `hosts/pi/index.ts` binds only: `task: ${input.prompt}\n\n${input.text.inherited}` for a fork,
  `systemPrompt: input.prompt, task: input.text.fresh` for a fresh child — the same two bytes-shapes
  the deleted `composeTask` produced.

**Evolved, not replaced** (ruling "Shared contract"). `SharedMaterial` names the four common parts —
knowledge (category groups), historical facts, compressed Raw entry views with their source identity,
receipts. `NotingMaterial` adds the head reply and the source index; `ConsolidationMaterial` adds the
fact addresses, the range fact lines and the review cues. `facts` and `entries` are optional in the
shared type so a consumer omits what its order has no block for (injection carries knowledge and
receipts only; Consolidation has no Raw part at all, rather than an empty one). There is no
ContextBuilder, no strategy registry and no per-consumer duplicate of the budgeting.

**Mine, and why**

1. **One knowledge block for four consumers means one existing shape wins.** Injection and compact
   render `<knowledge>` with per-category tags; the workers rendered a bare `Active knowledge:` title
   over the same lines. "One function used by all four consumers" cannot keep both. I kept the XML
   block (`renderKnowledgeBlock`, already in `core/render`) because it is the main-agent contract with
   goldens and spec text behind it, because the repo's own convention is that tags delimit blocks
   while the lines inside stay byte-for-byte trace lines, and because it restores category
   information the flat worker form was dropping. **This is the one byte change beyond ordering**: a
   worker's knowledge block goes from `Active knowledge:\n\n<lines>` to
   `<knowledge>\n<constraint>\n…\n</constraint>\n</knowledge>`, and empty knowledge now renders no
   block at all instead of a bare title (the injection rule "nothing to inject: no block at all").
   Everything else keeps today's bytes; only the block order changes, exactly where the parent's table
   says so.
2. **`material.knowledge` is now category groups**, not flat strings, because the shared block
   function needs the category to tag it. Four assertions in existing tests were adjusted
   (`.knowledge.map(g => g.text).join(...)`).
3. **`ConsolidationMaterial.consolidated` is renamed `facts`**, so "historical facts" is one field
   name across the contract rather than two names around the same budgeting.
4. **The frozen range travels beside the material**, as a function argument, not inside it. It keeps
   19b's still-standing pin meaningful (no material part is a composed string containing `Range: `)
   and avoids storing the same label twice, since the agent input already carries `range`.
5. **`text: {fresh, inherited}`** on both agent inputs, built from the one frozen material; `prompt`
   stays a separate field, so placement (system slot, appended user message, steering) remains the
   host's.
6. **The test helper `materialText` in `test/source-fixture.ts` is deleted.** It existed to flatten
   the parts in the order a run would show them; core now produces exactly that, so its ~25 call
   sites read `input.text.fresh` — the real bytes instead of a test-side imitation.
7. **Pricing is untouched.** `freezeNoting` still sums the frozen parts (adapted to the group shape)
   rather than the rendered text, so gate-4 thresholds and batch shrinking behave exactly as before.
   Charging titles and separators is 20b's "boundary accounting" decision, not a side effect of this
   slice.

**Byte delta of what a run sends**

| Consumer | Change |
|---|---|
| Noter, fresh | order → knowledge, facts, range, Raw, receipts; knowledge block form (see above) |
| Noter, inherited | none |
| Consolidator, fresh | order → knowledge, consolidated facts, range, range facts, reminders, receipts; knowledge block form |
| Consolidator, inherited | none |
| Main-agent initial injection | none |
| Main-agent compact | facts and Raw swapped inside `<episodic>`; knowledge block unchanged (golden `test/fixtures/read/compact.txt` updated; `inject.txt` untouched) |

## Probes

Both probes ran the full suite in the foreground and were reverted before the next step; restoration
was verified with `shasum -a 256` against the pre-probe hash of every file touched.

| # | Mutation | Red test(s) | Failed / total | Restored |
|---|---|---|---|---|
| a | Recreated `hosts/pi/compose.ts` with its own `Range:` / `Recent facts (newest first):` / `Raw:` layout and consumed it in `runAgent`'s subagent arm (`task: input.kind === "noting" ? composeMaterial(input) : input.text.fresh`) | **20a 2026-09-08: no host file lays out the knowledge, fact, Raw or review blocks** | 1 / 509 | `hosts/pi/index.ts` `5104a8337a32c6e0ba655bf8309474aac555a7575b874e2739034bfd4787bd21`; `hosts/pi/compose.ts` deleted again |
| b | Leaked task data into the knowledge block: in `core/noting/index.ts`, each knowledge group's text gained `\n  (batch <entry ids>, range <from>..<to>)` | **20a 2026-09-08: nothing task-specific enters the leading knowledge block, and all four consumers render it identically**; **20a 2026-09-08 scenario 2: two Noter tasks with the same knowledge and different Raw and ranges are byte-identical through the knowledge block**; **20a 2026-09-08: the Noter's fresh order is knowledge, historical facts, range, the selected Raw, then receipts**; **20a 2026-09-08 scenario 1: a host stub with no provider message types runs note and the two-submission memory protocol from core's prepared text** | 4 / 509 | `core/noting/index.ts` `3cf591d2b23849eaa5afbaf8bd4a621b886b109bc3ba7b1c95646cafa8afc6d1` |

## Production line delta (this slice)

| Area | Added | Removed | Net |
|---|---:|---:|---:|
| Core production (`core/render/material.ts` new 139; `api/index.ts`, `api/read.ts`, `noting`, `consolidation`) | 190 | 54 | **+136** |
| Host production (`hosts/pi/index.ts`; `hosts/pi/compose.ts` deleted) | 6 | 55 | **−49** |
| Production total | 196 | 109 | **+87** |
| Tests and fixtures (`core/render/material.test.ts` new 127) | 333 | 138 | +195 |
| Documentation | 120 | 40 | +80 |

The host lost its layout module and kept two binding expressions; core gained one module that now
serves four consumers where the layout previously lived in two places (the adapter and `read.ts`).

## Superseded rulings recorded

- **19b, "no core module builds a message sequence or a provider body, and no host receives composed
  domain text"** → superseded by the user's ruling of **2026-09-08**: *core builds no provider message
  or body; core owns the domain text.* Recorded by name and date in the header comment of
  `core/api/boundary.test.ts`, on `assertNoProviderMessage` (renamed from `assertNoComposedMessage`;
  it now forbids `messages`/`system`/`conversation`/`body`/`subagentInput` and an array `input`, and
  requires `text`), and in the named test **20a 2026-09-08: core owns the host-neutral domain text and
  still builds no provider message or body**.
- **19b's assignment of host-neutral text layout to the adapter** (spec §Modules, `hosts/pi`) →
  superseded; the spec line now says the host binds core's prepared text and that
  `hosts/pi/compose.ts` is deleted.
- **Compact's episodic order (pending Raw first, then recent facts)** → superseded by ticket 20's
  material-order table; `.scratch/v1/spec.md` §Overflow policy and `core/README.md` §Read facade now
  state the new order, and the golden was regenerated.
- Ruling **2026-09-06 08:53** is *not* superseded: it is re-pinned per phase on core's increment.

## Documentation

- `core/README.md`: the boundary paragraph now reads "Core builds no provider message or body; core
  owns the domain text (ticket 19b, revised…)"; new section **Shared material and block layout (20a)**
  with the contract, the four-consumer order table, the increment and the stable-prefix rule; the
  module list gained `render/material.ts`; the compact paragraph states the new episodic order.
- `hosts/pi/README.md`: **Message composition (19b)** is replaced by **Message binding (20a)** — host
  binding only (which representation, which native message, steering for the review round); the
  runner's "Task delivery" bullet and the fallback paragraph no longer name `compose.ts`.
- `.scratch/v1/spec.md`: new subsection **Shared memory material and block order (20a, 2026-09-08)**;
  the `hosts/pi` module line, the `runAgent` contract line, the run-record line, the module list and
  the compaction order line updated.
- `CONTEXT.md`: two terms added under Process — **Material** and **Increment** — because both are now
  load-bearing vocabulary across core and hosts. No existing term changed meaning.
- No prompt file changed; both prompt hashes are unchanged.

## Honest limits

- **The "no host layout" test is a source scan.** It reads every non-test `.ts` under `hosts/` and
  fails on core's title constants, `<knowledge>` or a `Range: ${…}` template. A host that invented
  *different* wording for the same blocks would not be caught; the scan pins the boundary, not every
  possible re-implementation. `hosts/pi/native-fixture.ts` keeps a literal fixture task string
  (`"Range: S1/T1..S1/T1\n\nnote what happened"`) that is test scaffolding, not a layout, and is not
  flagged.
- **No cache claim.** Nothing here measures or promises a provider cache hit; the stable-prefix tests
  are byte-layout tests. Request identities, cache keys, transports, thinking levels, model selection,
  the fork prefix gate, cache-miss suppression and Retry behaviour are untouched.
- **The worker knowledge block changed shape** (design choice 1). If the acceptor prefers the old
  `Active knowledge:` title for workers, the alternative is two knowledge-block functions, which the
  slice's "one function used by all four consumers" instruction rules out; say which side gives.
- **Budgets, triggers, batch sizes, compaction tiers and catchup are untouched**, as instructed. A
  task whose material is exactly at a limit behaves exactly as before this slice.
- `branchSummary`'s `<branch_carry>` text is still assembled in `core/api/read.ts` with its own labels.
  It is core-side (no host owns it) and outside the parent's order table, so it was left alone.
- No live Pi session was run; `npm run smoke:pi` is the only real-runtime check, as in 19b/19c.

## What 20b must know

- **Where budgets attach.** Selection and part budgeting stay where they are (`budgetKnowledge`,
  `budgetFacts` in `core/noting`, `core/consolidation`, `core/api/read.ts`); the *block-level*
  accounting the parent describes ("outer section headings, the task range and block-level receipts
  consume the enclosing episodic budget") now has exactly one place to measure: the per-consumer
  functions in `core/render/material.ts`, whose output is the run's text. `tokens(input.text.fresh)`
  minus the summed parts is precisely the framing cost 20b must charge.
- **`freezeNoting` still prices parts, not text** (`cost([...knowledge texts, ...facts, ...views,
  ...receipts])`). Switching it to `tokens(text.fresh)` is a one-line change but moves the gate-4
  capacity thresholds, so it was deliberately left to 20b together with the new limits.
- **The knowledge omission receipt is already a `material.receipts` entry** rendered last by `finish`;
  the "budgeted receipts" rule (bounded expansion instruction instead of unbounded enumeration)
  changes `budgetKnowledge`/`budgetFacts`, not the assembly.
- **Consolidation has no Raw part** (`entries` is absent from its material, not empty) — the parent's
  "Consolidation has no automatic Raw block" is structural, and 20b's shared-episodic-space rule can
  rely on it.
- **For 20c**, `compactText` takes a `SharedMaterial`: a secondary compact view only replaces
  `entries[].view` and adds receipts; the escalation decision has no layout work to redo.
