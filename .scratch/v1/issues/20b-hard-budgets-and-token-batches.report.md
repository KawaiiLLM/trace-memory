# Ticket 20b acceptance report

**Ready for acceptor review.** Baseline: `ea3db87`, *Ticket 20a: core owns the domain text of every
memory consumer…*, read with `git log -1 --oneline` before implementation. The initial working tree
was clean; nothing of this slice is staged or committed, and every change below is in the working
tree. **HEAD moved during the work, by someone else:** two unrelated commits landed on this tree at
17:59 (`21d420b` *Ticket 21: commit reasons and knowledge topics…* and `a7196d6` *Ticket 21a: the
because column is replaced by reason, not kept*), and both touch only `.scratch/v1/issues/21*.md`.
They share no file with this slice, nothing of this slice was swept into them, and the suite below
was last run against the tree as it now stands. No pre-existing file under `.scratch/v1/issues/` was
touched by me; only this report is new there. **No prompt file was changed**:
neither `core/prompts/noting.md` nor `core/prompts/consolidation.md` states a budget, a trigger or a
batch size, so both prompt hashes are unchanged.

---

## Verification

Every command ran in the foreground on Node 24.6.0 with an explicit timeout; no background waits, no
credentials, no live provider.

| Check | Before | After |
|---|---:|---:|
| `npm test` | 509 passed, 25 files | 521 passed, 25 files |
| `npm run typecheck` | Passed | Passed (also after every probe restoration) |
| `npm run smoke:pi` | Passed | Passed: one native Noting run and one fact |
| `git diff --check` | Clean | Clean |
| Revert probes | Not applicable | Four applied, each red on a named test, each restored byte-for-byte |
| HEAD / staged / commits by this slice | `ea3db87` / none / none | `a7196d6` (moved by two unrelated ticket-21 commits) / none / none |

Twelve new cases (all titled **20b 2026-09-08…**); two existing cases were renamed in place because
the ruling they pinned was superseded (17b's fifty-fact trigger test became scenario 6's host case;
the knowledge soft-cap test became scenario 4). 509 + 12 = 521.

## Scenario-to-test mapping

| Ticket checkbox | Implementation | Named test |
|---|---|---|
| Scenario 3: exactly-at and one-over limits with labels, separators and receipts included; no cap silently overflowed | `budgetMaterial` in `core/render/material.ts`; `charge` in `core/render/index.ts` | **20b 2026-09-08 scenario 3: exactly-at fits and one over does not, with labels, separators and receipts charged** and **20b 2026-09-08 scenario 3: at the default limits no consumer's block overflows its cap or the 30,000-token total** (`core/render/material.test.ts`) |
| Scenario 4: high-priority knowledge no longer bypasses the cap; retained items whole and deterministic; omitted visible and traceable; empty and single-oversized bounded | `budgetKnowledge` rewritten (`core/render/index.ts`) | **20b 2026-09-08 scenario 4: no knowledge category bypasses the cap, constraints keep first priority, and omitted items stay traceable** (`core/api/noting.test.ts`); the zero-budget and partial-prefix cases also in `core/api/read.test.ts` *category order…* and `core/api/consolidation.test.ts` *context uses timestamp freshness…* |
| Scenario 5: 9,999 starts nothing / 10,000 eligible; oldest fitting whole-entry prefix; no chaining; small oldest before a near-10,000 entry | `freezeNoting` selection (default now 10,000) | existing **17b 2026-09-08: Noting threshold is exactly compressed tokens (9999 / 10000)**, **17b 2026-09-08 (batch ceiling superseded by 20b): oldest whole-entry batches cross Turns or split one Turn…**, and new **20b 2026-09-08 scenario 5: a small oldest entry is not joined with a near-ceiling entry, and no smaller later entry jumps the queue** (`hosts/pi/batching.test.ts`) |
| Scenario 6: short facts wait, long facts trigger; 4,999/5,000 and the 10,000 batch cap on the same rendered representation | `taskEligibility` (`core/api/index.ts`) and `freezeConsolidation` selection | **20b 2026-09-08 scenario 6: Consolidation is due on rendered fact tokens, exactly at the trigger, and one batch takes at most its token ceiling** (`core/api/consolidation.test.ts`) and **20b 2026-09-08 scenario 6: many short facts below the trigger wait, the tokens that reach it start one Consolidation despite pending same-Turn sources** (`hosts/pi/batching.test.ts`) |
| Scenario 7: several token-bounded batches, exact membership, no watermark, late facts eligible, failed batches advance nothing | `consolidated_facts` progress unchanged; selection is the only new part | **20b 2026-09-08 scenario 7: successive token-bounded batches advance exactly their selected fact ids, and a failed batch advances nothing** (`core/api/consolidation.test.ts`); the committed-batch-survives-later-failure half stays pinned by the existing *a committed batch survives…* cases |
| Scenario 8: oldest fact over the cap pending with a useful error; a primary entry with impossible metadata never an oversized success | capacity error in `freezeConsolidation`; `renderEntry` unchanged | **20b 2026-09-08 scenario 8: an oldest fact over the batch ceiling stays pending with a capacity problem and is never bypassed** (`core/api/consolidation.test.ts`) and **20b 2026-09-08 scenario 8: an entry whose mandatory metadata cannot fit is a capacity failure, never an oversized success** (`core/api/noting.test.ts`) |
| Scenario 15: smaller host window reduces and re-freezes before the only model call; evidence, audit and writable sources match | `freezeNoting` capacity loop now prices `text.fresh`/`text.inherited` | **20b 2026-09-08 scenario 15: a smaller host window reduces and re-freezes the task, with evidence, audit membership and writable sources moving together** (`core/api/boundary.test.ts`), beside the retained 19b gate-4 pair |
| Scenario 17: new settings validate, layer and display read-only; removed key errors by name; superseded rulings recorded | `DEFAULT_CONFIG`, `REMOVED_SETTINGS` (`core/api/index.ts`) | **20b 2026-09-08 scenario 17: the new token settings validate and layer, and the removed fact-count key errors by name** (`hosts/pi/batching.test.ts`); display and precedence stay pinned by **18a 2026-09-08: read-only settings show precedence, effective defaults and masked values** (`hosts/pi/enrollment.test.ts`), now over `consolidation.triggerTokens` |
| Revert probes | — | See Probes below |

## The accounting table (which component charges which budget)

One function, `budgetMaterial`, charges every emitted component exactly once:

| Component | Budget | Default |
|---|---|---:|
| knowledge block, its `<category>` tags, its omission receipts | `render.knowledgeBlockTokens` | 10,000 |
| the selected current material — Raw entry views (Noter, compact) or pending fact lines (Consolidator) — with their own source labels, omission markers and joining separators | `noting.batchTokens` (the one effective Raw ceiling, shared by Noting and compact) / `consolidation.batchTokens` | 10,000 |
| block titles, the range line, mandatory cues (the negation reminders), block-level receipts, and the historical facts that fill the rest | `render.episodicBlockTokens` | 20,000 |
| fresh material in total | knowledge + episodic | 30,000 |

Outer framing is never charged against the inner ceiling, so a valid 10,000-token entry stays
batchable. The current material and the mandatory cues are reserved first; historical facts then fill
what is left, in the existing freshness order (`budgetFacts` is now exactly that filler). Raw takes
at most its own ceiling, and Consolidation has no automatic Raw block — its selected pending facts
take the current-material allowance instead.

## Design choices

**Reused, not rebuilt.** `tokens`, `renderEntry` (its per-entry cap is untouched), `budgetKnowledge`,
`budgetFacts`, `finish`, `xmlBlock`, `renderKnowledgeBlock`, the 20a per-consumer text functions,
`freezeNoting`'s existing capacity loop, `store.consolidationBatch`, `consolidated_facts` progress,
the `CONFIG_ALIASES` mechanism and 18a's positive-safe-integer validation all stayed. The new code is
one budgeting function plus two small selection rules.

1. **`budgetMaterial(input)` in `core/render/material.ts`** — the single budgeting of the shared
   material, with four callers (`core/noting`, `core/consolidation`, `core/api/read.ts` compact, and
   the boundary tests). It takes the knowledge candidates (+ optional `knowledgeLine`), the joined
   `current` material, the `framing` this consumer emits, the frozen `range`, the historical `facts`
   with their `factLine`, the three `caps` and a `label` (`raw` | `range`); it returns
   `{ knowledge, facts, receipts }`. It lives beside the layout it budgets, so the components it
   charges and the components the text emits cannot drift apart.
2. **`budgetKnowledge` lost its exemption** and now charges the block frame, the category tags, each
   retained line with its separator and its own omission receipts against one hard cap. Retention is
   a *prefix* of (category priority, within-category order): once an item does not fit, later items
   are not pulled forward to fill the gap. `// ponytail:` the prefix cost is summed part by part
   rather than by re-rendering the block at every step — the estimator's own rounding makes a summed
   split an over-count, which is the safe direction for a budget; the upgrade path if exactness ever
   matters is to render `renderKnowledgeBlock` per candidate prefix (O(n²) over the whole block text).
3. **Bounded receipts.** `expandList` names at most eight addresses and then says how many more it
   covers, up to the last one, so a long omitted list cannot defeat the cap it is charged against.
   The existing short-list wording (`omitted 1 goal knowledge; expand: K5`) is unchanged.
4. **`freezeNoting` prices the rendered text.** The capacity loop now measures `tokens(text.fresh)`
   (plus prompt and tool definitions) and `tokens(text.inherited)` (plus the host's prefix), instead
   of summing the material parts, and still shrinks by whole entries. Because `notingMaterial` is
   recomputed inside the loop, the material, the write eligibility and the audit membership re-freeze
   together — the anti-pattern probe (d) targets exactly that.
5. **`freezeConsolidation` selects an oldest-first whole-fact prefix** under `consolidation.batchTokens`,
   using the same `renderFact` lines and `"\n"` separator the trigger counts, and raises
   `Consolidation capacity: oldest fact exceeds consolidation.batchTokens; left pending` in the shape
   Noting already uses. Progress remains the exact selected fact ids.
6. **Removed key by table.** `REMOVED_SETTINGS` sits beside `CONFIG_ALIASES` and is enforced in the
   same two functions (`canonicalFlatConfig` for the host's flat layers, `canonicalConfig` for the
   nested override), so an old fact count is rejected by name in both settings spaces and is shown
   nowhere — the read-only menu builds itself from `DEFAULT_CONFIG`.
7. **Where a real corner was cut.** `// ponytail:` `charge()` bills every part one separator token,
   including the leading part, which over-counts a block by about one token per part; the upgrade
   path is to bill `parts.length - 1` separators once the assembled string is available at budget
   time. Deliberate: over-counting cannot overflow a cap, under-counting can.

**The one interpretation the acceptor should check.** "Complete task evidence" says that when
mandatory material prevents the combined block from fitting, the task is reduced rather than the
evidence dropped. The reduction path implemented is the ruled one: the host's reported capacity
(scenario 15) and the inner batch ceilings (scenarios 5, 6, 8). A *domain* episodic budget that the
mandatory part alone exceeds — only reachable by configuring `episodicBlockTokens` below the current
material, since both phases select under a 10,000-token ceiling inside a 20,000-token budget — keeps
the evidence whole and reports the excess in the existing `raw overage:` / `range overage:` receipt.
Reducing on that signal instead would make an otherwise valid entry unbatchable under a small
configured budget, which the "Boundary accounting" ruling forbids in its own terms.

## Probes

Each probe ran the full suite in the foreground and was reverted before the next step; restoration was
verified with `shasum -a 256` against the pre-probe hash of the file touched.

| # | Mutation | Red test(s) | Failed / total | Restored |
|---|---|---|---|---|
| a | A receipt allowed to overflow its cap: `budgetKnowledge`'s `cost` stopped charging `charge(receipts(kept))` (`core/render/index.ts`) | **20b 2026-09-08 scenario 4: no knowledge category bypasses the cap…**; **20b 2026-09-08: the knowledge-category soft-cap exemption is superseded…** | 2 / 521 | `core/render/index.ts` `ebd1b69ed9eca709fd43bb5b4b491d9285225257ef2f144b3ee584f68ed9c4f6` |
| b | The 17b constraint/open/dispute exemption restored over the knowledge cap (both retention loops exempt the first three categories) | **20b 2026-09-08 scenario 4: …**; **20b 2026-09-08: the knowledge-category soft-cap exemption is superseded…**; **context uses timestamp freshness while range remains complete and categories follow noting budgets**; **category order, chronological ties, whole trailing category omissions; lines are never escaped** | 4 / 521 | same hash as above |
| c | Consolidation triggering by count again: `taskEligibility` back to `consolidationBatch(...).length >= 50` (`core/api/index.ts`) | **20b 2026-09-08 scenario 6: Consolidation is due on rendered fact tokens…**; **20b 2026-09-08: 17b's fifty-fact Consolidation trigger and unbounded batch are superseded…**; **20b 2026-09-08 scenario 6: many short facts below the trigger wait…**; plus 20 host/core cases that depend on a Consolidation actually starting | 23 / 521 | `core/api/index.ts` `8d41878aa139bd70481693bde5f094d5b75c9b4ea42a03deea19ea8469fb6670` |
| d | Material removed while the progress range is preserved: `runNoting` built the material from `entries.slice(0, -1)` while `entryAudit`/`entryIds` kept the full frozen set (`core/noting/index.ts`) | **20b 2026-09-08 scenario 15: a smaller host window reduces and re-freezes the task…**; **19b 2026-09-08 gate 4: the supplied budget shrinks the batch…**; **19b 2026-09-08: a host stub that receives structured material…**; **20a 2026-09-08: the Noter's fresh order…**; **17a 2026-09-08: Noting, fallback, compaction and carry supply identical bounded entry bytes**; and five more | 10 / 521 | `core/noting/index.ts` `24a05f456765194f83afb1b7d0a5ca36be7b5a358ab31b9a2af4d549e2ec179d` |

## Production line delta

| Area | Added | Removed | Net |
|---|---:|---:|---:|
| `core/render/index.ts` (`charge`, `expandList`, `budgetKnowledge`, `budgetFacts`) | 44 | 20 | **+24** |
| `core/render/material.ts` (`budgetMaterial`) | 52 | 1 | **+51** |
| `core/noting/index.ts` | 19 | 17 | **+2** |
| `core/consolidation/index.ts` | 28 | 9 | **+19** |
| `core/api/index.ts` (config, removed key, trigger) | 26 | 4 | **+22** |
| `core/api/read.ts` (compact) | 14 | 9 | **+5** |
| Production total | 183 | 60 | **+123** |
| Tests | 433 | 65 | +368 |
| Documentation | 104 | 42 | +62 |

No host production file changed: 20b is entirely a core-side budget and selection change, and the Pi
adapter keeps reporting the same `capacity {inputTokens, prefixTokens}` it already reported.

## Superseded rulings recorded

Recorded by name and date in `core/api/rulings.test.ts`, keeping the old names:

- **17b, 2026-09-08: `noting.batchTokens` defaults to 50,000 compressed-view tokens** → superseded by
  ticket 20 on 2026-09-08. Test: **20b 2026-09-08: 17b's 50,000-token Noting batch is superseded by a
  10,000-token ceiling shared with compact**. The 17b batching test keeps its name with the marker
  *(batch ceiling superseded by 20b)*.
- **17b, 2026-09-08: fifty applicable unconsolidated facts trigger a run, with no batch ceiling** →
  superseded by ticket 20 on 2026-09-08. Test: **20b 2026-09-08: 17b's fifty-fact Consolidation
  trigger and unbounded batch are superseded by 5,000 trigger tokens and a 10,000-token batch**.
- **The knowledge-category soft-cap exemption (constraints, open items and disputes never omitted)** →
  superseded by ticket 20, confirmed by the user on 2026-09-08. Test: **20b 2026-09-08: the
  knowledge-category soft-cap exemption is superseded; constraints keep first priority inside a hard
  cap**.

## Documentation

- `core/README.md`: new section **Material budgets (20b)** with the accounting table, the reserve-then-fill
  rule, the bounded receipts and the hard knowledge cap; the gate-4 paragraph now states that core
  prices its prepared text and re-freezes material, eligibility and audit together; the Noting-context
  and Consolidation-contract paragraphs lost the exemption wording and the fifty-fact threshold;
  `compact` now names the shared Raw ceiling.
- `hosts/pi/README.md` (Configuration): `noting.batchTokens` 10,000 and its role as the one effective
  Raw ceiling; new `consolidation.triggerTokens` (5,000) and `consolidation.batchTokens` (10,000) with
  the shared rendered representation; the removed `consolidation.triggerUnconsolidatedFacts` with its
  exact error text; both examples and the catchup/validation paragraphs updated.
- `.scratch/v1/spec.md`: the 50,000-token batch, the fifty-fact trigger and the soft-cap exemption are
  superseded in place under **Run boundaries** and **Overflow policy**, with the new accounting and the
  30,000-token total stated as a domain limit rather than a request-size promise.
- `CONTEXT.md`: the **Noting** and **Consolidation** term definitions carry the new numbers. No term
  changed meaning, so no term was added or removed.
- `hosts/pi/LIVE-VERIFICATION.md`: only the forward-looking acceptor instruction was updated to
  `consolidation.triggerTokens`; the two historical session records keep the settings those sessions
  actually ran with.
- No `core/prompts/*.md` change, so both prompt hashes are unchanged.

## Honest limits

- **The estimator is an estimate.** Every limit is measured with the existing local estimator over the
  exact rendered view (7.2% mean absolute error on this project's own text), not a provider tokenizer.
  The host's real-context reserve and request-capacity checks remain independent, as ruled.
- **`charge()` over-counts one separator per part** (design choice 7) and `budgetKnowledge` sums its
  prefix cost part by part (design choice 2). Both over-count, so caps bind slightly conservatively;
  neither can let a block exceed its cap.
- **A receipt is never dropped to fit.** When a cap holds nothing at all, the block is empty and the
  bounded omission receipt is still emitted: nothing else would say the item exists. The scenario-3
  and scenario-4 tests pin that shape rather than a receipt-free empty block.
- **Domain-episodic mandatory overflow is receipted, not reduced** — see the interpretation note under
  Design choices. Under the ruled defaults (10,000 inside 20,000) the case is unreachable.
- **Compact still keeps every pending entry**, now with an explicit `raw ceiling:` receipt when the
  block exceeds the shared Raw ceiling. Escalating to a lossier view or to native compaction is 20c.
- **Fixture sizes moved, behaviour did not.** Several host fixtures were built around a 50,000-token
  batch or fifty facts (`hosts/pi/batching.test.ts`, `manual-catchup.test.ts`, `catchup.test.ts`,
  `entries.test.ts`); they were rescaled or given an explicit trigger so they keep testing what they
  named, not the new defaults by accident. Every rescaling is commented at its site.
- **No live provider run.** `npm run smoke:pi` is the only real-runtime check, as in 19b/19c/20a.

## What 20c must know

- **The Raw ceiling is `noting.batchTokens`** (`config.noting.batchTokens`), passed as
  `caps.current`. There is deliberately no second Raw knob; a secondary compact view must be measured
  against this same number.
- **The budgeting function** is
  `budgetMaterial({ knowledge, knowledgeLine?, current, framing, range?, facts, factLine, caps: { knowledge, episodic, current }, label? })
  → { knowledge, facts, receipts }`, exported from `core/render/material.ts` (re-exported nowhere
  else yet). `current` is the already-joined current material, so a secondary view only changes the
  string passed there.
- **Compact calls it in `core/api/read.ts`**, inside `compact(sessionId, branch, headTurnId)`, with
  `framing: [xmlBlock("episodic", ""), FACTS_TITLE, RAW_TITLE]` and `caps.current =
  config.noting.batchTokens`. A Raw block over that ceiling already produces the receipt
  `raw ceiling: <n> tokens over <cap>; all unrecorded raw kept` — that receipt is the signal 20c
  turns into escalation (secondary view, then native delegation).
- **Nothing in 20b decides compaction tiers.** `compact` still returns a custom replacement in every
  case, and no caller was given a "decline" path.
