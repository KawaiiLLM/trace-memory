# 23 — One entry view, two budgets

Label: ready-for-agent. Tracker: local issue files; this file is the ticket. Baseline: `5370775` plus ticket 22 (this ticket lands after 22b, which memoizes entry views by configuration and view version; the two must not be in flight together on the renderer).

## Problem Statement

Every token of the conversation is paid for once by the main agent and, when it reaches the Noter, again. On the user's own 236-turn session the pending backlog renders to 534K tokens under the current entry view (measured on a database copy), which at the 10K batch ceiling is an estimated 54 Noting runs; the eleven runs observed so far averaged $0.22 (measured, one provider, mostly cached second rounds). The underlying conversation text is 1.12M tokens: the view halves the volume but no more, and what it keeps is largely not what the Noter uses.

Measured on that backlog (1,566 pending entries):

- Tool payloads are 80% of the view: 684 tool results at 451 tokens each and 489 tool-call entries at 248, against 393 user/assistant texts that average 74 tokens (p90 511, max 1,319).
- The view excerpts the raw JSON of each argument object and result envelope, so a `read` result is escaped file body, an `edit` result is an escaped diff, and every label carries an 80-character call id. Labels alone are 28% of the tool-entry tokens; short user messages render larger than their original text (105 vs 63 tokens).
- The per-tool rules that exist for explicit `trace` reads (read as name plus path, bash as command plus stdout head/tail, report head/tail) never apply to the entry view. Of their six budget keys, `commandTokens`, `reportHeadTokens` and `reportTailTokens` still shape explicit `trace` output on Pi; the stdout/stderr branch keys on a Claude Code result shape that Pi never produces, so `stdoutHeadTokens`, `stdoutTailTokens` and `stderrTailTokens` have no effect on any Pi run.
- The compaction-only secondary view is a second implementation with its own excerpt rules that omits tool content entirely.

The user's requirement: one compression method for every source entry, simple rules that do not name particular tools, one budget for tool calls because tool calls are the low-value part, an entry cap that protects the context from long tails, and the same renderer for both compaction tiers with different parameters.

## Solution

Every source entry is rendered by one rule with two numbers. A tool call is worth at most `B` tokens; an entry is worth at most `E`. Within an entry, tool calls give way first, down to a one-line minimum; only when they are at the minimum does natural text yield. Tool arguments become `name` plus one `key: value` line per argument, each value cut at its head under a fair share of the arguments budget, so a target path after a long content string still appears; tool results become plain text (the host unwraps its envelope) cut head and tail with an honest omission count, and structured result data the host drops is marked with its size rather than silently lost; call ids and native-identity headers leave the model-facing text, since the address the Noter cites is `T<n>#t<k>`. Explicit `trace` reads assemble the same per-entry rendering; `full` is unchanged. Compaction's second tier is the same renderer with a smaller `B` and `E`.

Measured on the same backlog with a prototype (arguments were cut head and tail there, and the prototype does not enforce the budget contract below; the numbers are direction, not acceptance), tokens per entry and total:

| | entries | raw text | current view (B=1000, halves) | tier 1: B=300, E=10K | tier 2 prototype: B=100, E=1K |
|---|---|---|---|---|---|
| tool result | 684 | 1,306 | 451 | 177 | 67 |
| tool call entry | 489 | 276 | 248 | 71 | 31 |
| assistant text with calls | 56 | 513 | 402 | 161 | 113 |
| assistant text | 167 | 340 | 382 | 339 | 334 |
| user | 170 | 63 | 105 | 61 | 61 |
| total | 1,566 | 1,125K | 534K | 232K (−57%) | 133K (−75%) |
| Noting runs to drain (10K batches, estimate) | | | 54 | 24 | |

Tier-1 `E` above 1K never fires on this data; it exists for pasted logs and very long replies. Text is not exempt by rule, only by size. The tier-2 column is the prototype at `E = 1,000` and is too loose for its purpose (see the tier-2 decision below); the shipped tier-2 `E` is smaller.

## User Stories

1. As a Pi user paying for background Noting, I want each source token to cost a fraction of a second pass rather than a whole one, so that memory extraction is affordable on long sessions.
2. As a Pi user, I want the Noter to see what a tool was called on and how it ended (path, command, status, the head and tail of its output), so that event facts stay correct.
3. As a Pi user, I want file bodies and diffs fetched by tools not to be replayed to the Noter, so that the budget goes to conversation and outcomes.
4. As a Pi user, I want user messages and assistant replies rendered at their own size, so that facts are extracted from the text they came from.
5. As a Pi user, I want a pasted 40K log or a very long reply bounded, so that one entry cannot consume a whole Noting batch.
6. As a Pi user, I want one budget knob for tool calls and one entry cap, so that tuning cost does not mean learning six field budgets.
7. As a Pi user, I want the same rule whatever tool was called, so that a new tool or a renamed one is not silently treated differently.
8. As a Pi user, I want raw evidence stored exactly as the host produced it, so that `trace` with `full` still shows the original arguments and result envelope.
9. As a Pi user reading a tool result through `trace`, I want the same compact rendering I see in memory material, so that there is one representation to learn.
10. As a Pi user, I want compaction's second tier to be the same rendering with tighter numbers, so that what survives compaction is predictable from what Noting saw.
11. As a Pi user, I want the tier-2 view to still say which tool ran and whether it succeeded, so that a compacted context is not blind to what was done.
12. As a Pi user, I want images and other non-text tool content marked rather than dropped silently, so that a missing element is visible.
13. As a Pi user, I want omission markers to state how much was cut, so that I know when to fetch the original by address.
14. As a Pi user with an existing Beta database, I want the change to apply without touching stored data, so that my memory survives the upgrade.
15. As a Pi user, I want run records to say which view version and budgets a run saw, so that facts can be audited against what the Noter was shown.
16. As a Pi user, I want the fork gate re-verified after the prompt changes, so that inherited-context runs still reproduce the parent request.
17. As a user of a future Claude Code host, I want the unwrapping of tool results to be the host's job, so that core needs no knowledge of transcript formats.
18. As a maintainer, I want the six dead budget keys rejected by name, so that a stale settings file fails loudly instead of silently doing nothing.
19. As a maintainer, I want the compaction-only secondary renderer deleted, so that there is one renderer to test.
20. As a maintainer, I want the rule pinned by goldens on synthetic entries, so that a regression in labels, cuts or ordering is caught byte by byte.
21. As a maintainer, I want the token saving measured on the ticket-22 perf fixture, so that the −57% claim is reproducible without private data.

## Implementation Decisions

### The rule

- One renderer for every source entry, used by Noting material, compaction tier 1 and tier 2, branch carry, and explicit `trace` reads without `full`.
- An entry is a list of parts: at most one natural-text part (the user message or the assistant text) and one part per tool call: the arguments in an assistant entry, the result in a tool-result entry. Parallel calls are separate parts of the same entry.
- Part rendering: natural text is the text as stored; a tool-call part is the label line `[T<n>#t<k>] <name>` followed by one `<key>: <value>` line per top-level argument, values rendered as compact JSON for non-strings and as the string itself otherwise, each value cut at its head; a tool-result part is `[T<n>#t<k>] <name> <status>` followed by the result text cut head and tail in equal halves with an omission marker naming the omitted character count, and, when the host reports dropped structured data, a marker naming its size (`[details omitted: N characters]`); when the result text is empty and structured data exists, the head of that data's compact JSON is rendered under the result budget in place of the marker, so a tool that answers only structurally is not shown as blank. Markers keep the `[omitted … characters …]` wording the run audit already detects. Images and other non-text blocks become `[<type> omitted]`. Cuts fall on code-point boundaries, never inside a surrogate pair (the existing excerpt helper already iterates code points).
- Budget contract: `B` and `E` count the rendered text of the part or entry as the token estimator measures it — label lines, key names, separators and every marker included; nothing is charged outside them. A part's minimum is its label line plus one omission marker; an argument part with several keys shares its budget fairly among values (equal shares, remainders to the earliest keys, a value shorter than its share returns the rest to the pool in one pass). Allocation rounds down; a rendered part never exceeds its allocation, and the renderer verifies the final entry against `E` and each tool part against its `B` share before returning. When even the minima of an entry's parts exceed `E`, the renderer raises the existing capacity error and the entry stays pending; it never emits a shorter-than-minimum or empty part and never exceeds a budget to make room. How a cut position is found is the implementation's choice — a first guess from the estimator's character ratio verified once and shrunk once is enough; the contract is the budget, not a search procedure.
- No call ids and no native-identity header in the model-facing text. Native identity, lineage and view budgets remain in the run's entry audit; the Noter cites `T<n>#user`, `T<n>#assistant`, `T<n>#t<k>`, which the labels carry. The Noter prompt sentence describing entries as "labelled with its native identity" is updated to the addresses actually shown; the prompt hash moves and the fork gate is re-run against the updated parent request, as in 21a.
- Two numbers per profile: `B`, the maximum tokens of one tool-call part (arguments parts get one quarter of `B`, result parts three quarters — arguments are rendered before their result exists and views are immutable, so the split is fixed, and measured argument needs are small); `E`, the maximum tokens of one entry.
- Allocation inside an entry: first cap each tool part at its `B` share. If the entry still exceeds `E`, tool parts give way first, shared fairly down to a minimum of the label line plus a few tokens of body (what was called, whether it succeeded). Only when every tool part is at its minimum does the text part yield, head and tail. The existing largest-fragment shrink loop is replaced by this two-stage order; the "impossible capacity" error when labels and markers alone cannot fit `E` stays.
- Profiles: tier 1 (Noting material, compaction tier 1, branch carry, `trace`) `B = 300`, `E = 10,000`; tier 2 (compaction only) `B = 100`, `E = 150`. Tier-1 `E` keeps the 17a value. Tier 2 exists to make a frozen pending set fit the compaction block after tier 1 could not; the retired secondary view held an entry to roughly a label plus a 60–120-token excerpt, and a tier-2 `E` of 1,000 would leave long replies at their full size (a synthetic set of twelve long replies: about 1,080 tokens under the retired view against about 12,000 at `E = 1,000`), sending cases that used to compact locally to the native tier. `E = 150` matches the retired excerpt sizes; it is the default and is confirmed or adjusted by the conversation-dense acceptance below, not left open.
- **Amendment 2026-09-09 (user, 「二阶E用1k吧」):** tier-2 `E` is **1,000**, not 150. Consequence accepted with it: tier 2 no longer guarantees fitting a conversation-dense set the retired 20c view fitted (a dozen thousand-token replies now escalate to native with the reason); the conversation-dense acceptance is re-pinned to that behaviour. On the real dogfood log (1,988 entries) tier 2 at `B = 100`, `E = 1,000` totals 190K tokens against 126K at `E = 150` and 312K for tier 1.
- `trace` assembly: the per-entry renderer is the unit; an explicit read of a Turn assembles that Turn's selected source entries in path order and renders each with the tier-1 profile, so a Turn with several assistant messages shows each one, a tool call with several result occurrences shows each occurrence, and a sibling branch's entries never appear. The `tool` option selects which call's parts are rendered in full within their budgets; unselected calls keep their label line and an omission receipt (ticket 22c's "metadata for unselected calls, multiple results, omission receipts" is unchanged). `full` renders the stored arguments and result envelope uncut, as today. Native identity stays bound in storage and in the run audit; only the model-facing text drops it.
- Budgets are configuration, static per installation, never adjusted per batch: views stay immutable and versioned, and an over-full batch is still handled by selecting fewer entries. `B` has a hard upper bound of 1,000 (the 17a value), rejected above it.

### Host contract

- Core renders a host-neutral shape: tool name, status, arguments as a JSON object, result as text. The host registers one result-text extractor with the façade at construction; core applies it when rendering and never inspects envelope fields itself. Default extractor: the stored result string as is.
- The Pi host's extractor joins the text blocks of the result content, marks non-text blocks, and reports `details` as dropped structured data with its serialized size (it does not render it). Evidence is unchanged: the host keeps storing the raw message and the raw `{content, details}` result exactly as today; `trace` with `full` renders them uncut as today. Edit diffs, which live only in `details`, therefore leave the Noter view with a marker in their place; this is the trade pi-observational-memory also makes, made visible.
- No schema change, no migration, no rewrite of stored entries. Existing databases render under the new rule on next use because views are computed, not stored.

### Deletions and settings

- Deleted: the compaction-only secondary renderer and its version constant; the per-tool branches of the explicit Turn preview (read/search as path, bash command plus stdout/stderr, report head/tail) and the tool-name regex; the budget keys `commandTokens`, `reportHeadTokens`, `reportTailTokens` (replaced by the uniform rule and `B` for explicit `trace`) and `stdoutHeadTokens`, `stdoutTailTokens`, `stderrTailTokens` (never effective on Pi). The removed keys join the removed-settings table (20b) and are rejected by name with the replacement named.
- Kept: `toolCallTokens` (now `B` of tier 1, default 300, maximum 1,000) and `entryTokens` (`E` of tier 1, default 10,000). Added: the tier-2 pair under the same namespace, defaults 100 and 1,000. Values are positive safe integers as today.
- The entry view version constant changes; run audits record the version and both numbers of the profile used. The compaction custom entry that names the secondary view version names the new version and profile instead.

### Rulings touched (stated so acceptance can diff against them)

- 17a "arguments and result permanently reserve half each" is superseded by the quarter/three-quarter split (user, 2026-09-09, uniform tool-stage method with one per-call budget).
- 17a `toolCallTokens = 1000` default becomes 300 with 1,000 as the ceiling; `entryTokens = 10000` unchanged.
- 20c "compact-only secondary view" is no longer a separate rendering; tier 2 is the same renderer with the tier-2 profile. The three-tier escalation and the "native" tier are unchanged.
- The Noting trigger, batch ceiling, episodic and knowledge budgets, and the 22b trigger algorithm are unchanged; they consume the new view.

## Testing Decisions

Seams (the three confirmed for ticket 22, no new ones):

1. Core façade: goldens for the renderer on synthetic entries — user, assistant text, assistant with parallel calls, tool results with text and image blocks, a result larger than `B`, an entry larger than `E` with and without tool parts — pinned byte for byte; the two-stage allocation pinned by an entry whose text only yields after tools reach the minimum; the budget contract pinned by scanning `B` and `E` over a range on a fixed entry set and asserting every rendered part and entry is within its allocation, no part is empty or below its minimum, and `E` below the minima raises the capacity error; a cut placed inside a surrogate pair never appears; fidelity cases that need no tool knowledge — an argument object with a long string before the target path shows the path; a result with empty text and only structured data shows the size marker, not a blank; a result whose key line sits in the middle is omitted with a marker whose address fetches it through `trace` with `full`; `trace` assembly — a Turn with several assistant messages, a call with several result occurrences, a sibling-branch entry excluded, `tool` selection keeping other calls' labels and receipts, `full` equal to the stored envelope; compaction tier 2 output equals the renderer under the tier-2 profile.
4. Conversation-dense compaction: a frozen pending set of long replies with few tool calls that tier 1 cannot fit into the compaction block but the retired secondary view could; tier 2 under the default profile must fit it too (no escalation to the native tier that did not happen before), and its total must not exceed the retired view's total by more than half. This is what confirms or adjusts the tier-2 `E`.
2. Fake Pi host: the Noter's captured request contains the new labels and no call id or native header; the Pi extractor's behaviour on a real Pi tool-result message shape (text blocks, an image block, `details` present); the run audit's view version and budgets; the removed keys rejected at load; the fork gate green on the updated prompt (re-run, not assumed).
3. Perf fixture from 22a: the tier-1 total on the baseline workload is at most half the current view's total (the private measurement was −57%); recorded in the report with Node version and fixture size.

What makes a good test here: byte-identical expected text on small synthetic entries; token-level assertions only where the rule is about a budget; no assertion on how the cut position is found. Prior art: `tests/core/render/index.test.ts` goldens and the 17a entry-view tests, `tests/core/render/compact-text.test.ts`, `tests/hosts/pi/compaction.test.ts`, `tests/hosts/pi/entries.test.ts`, the 21a fork-gate re-run.

Revert probes for acceptance: restore the half/half split and name the red golden; restore the call-id label and name the red test; let text yield before tools reach the minimum and name the red test; drop the removed-settings rejection and name the red test.

## Out of Scope

- Any tool-specific rule, including a read/grep exemption that shows only the target. The measured residual (content-fetching results are 27% of the tier-1 total) is accepted for now; revisit after facts from the new view have been reviewed.
- Per-batch or adaptive budgets; changing `E` for tier 1; the Noting trigger or batch ceilings; the episodic and knowledge budgets.
- Storing rendered views or extracted result text; any schema change; migration.
- A Claude Code or Codex host extractor (the contract is defined here; their implementations are not).
- Prompt wording beyond the one sentence describing entry labels.

## Further Notes

- Prototype and measurements: `/tmp/tm-uniform.ts`, `/tmp/tm-entrycap.ts`, `/tmp/tm-grid.ts` against a copy of the user's database; diagnostic only, not fixtures, and not evidence of budget correctness: the reviewer found the prototype exceeding `E` (175 tokens at `E = 100`), returning empty strings below small budgets, and cutting inside surrogate pairs, and it cut arguments head and tail where this spec says head. The grid over `B ∈ {1000,500,300,200,100}` × `E ∈ {10K,2K,1K,500}` showed `E` inert above 1K and `B` as the only lever (14% / 42% / 57% / 65% / 75% saving over the current view); the defaults 300 / 100, the quarter split and the 1,000 ceiling stand as defaults to be confirmed by the budget-contract, conversation-dense and fidelity acceptance above, not as measured conclusions.
- Review of this spec (GPT, 2026-09-09) shaped the budget contract, the tier-2 `E`, the `trace` assembly rule, the fidelity cases and the evidence corrections above. A parallel proposal from the user's Pi session (arguments and result at 512 characters each, half/half cuts, native id kept per entry, `details` as a fallback when the text is empty, Noter input only) contributed the empty-text fallback and the cut-method freedom; its per-entry native id was not adopted because source binding already resolves same-Turn ambiguity by entry identity at write time, and its character budgets were not adopted because every budget and ruling in this project is in tokens.
- Entry-only budgets were tried and rejected: an entry cap with fair sharing gives 560K at `E = 1,000` (no gain, most tool results are under 1K and pass whole) and cuts 26K tokens of text by the time it reaches 244K at `E = 250`. A single per-part budget cuts 21K of text at 300. The per-call budget is the one that separates tool payloads from text without naming tools.
- pi-observational-memory (3.0.4) was read as the reference: text blocks only, `details` ignored, `name(JSON)` argument lines, half/half excerpts; its absence of a per-call budget was not copied because it contradicts the 17a per-call ruling and lets one result take most of a batch.
