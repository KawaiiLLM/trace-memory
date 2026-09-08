# 23 — One entry view, two budgets

Label: ready-for-agent. Tracker: local issue files; this file is the ticket. Baseline: `5370775` plus ticket 22 (this ticket lands after 22b, which memoizes entry views by configuration and view version; the two must not be in flight together on the renderer).

## Problem Statement

Every token of the conversation is paid for once by the main agent and, when it reaches the Noter, a second time. On the user's own 236-turn session the pending backlog renders to 534K tokens under the current entry view, 54 Noting runs at roughly $0.22 each, while the underlying conversation text is 1.12M tokens: the view halves the bill but no more, and what it keeps is largely not what the Noter uses.

Measured on that backlog (1,566 pending entries):

- Tool payloads are 80% of the view: 684 tool results at 451 tokens each and 489 tool-call entries at 248, against 393 user/assistant texts that average 74 tokens (p90 511, max 1,319).
- The view excerpts the raw JSON of each argument object and result envelope, so a `read` result is escaped file body, an `edit` result is an escaped diff, and every label carries an 80-character call id. Labels alone are 28% of the tool-entry tokens; short user messages render larger than their original text (105 vs 63 tokens).
- The per-tool rules that exist for explicit `trace` reads (read as name plus path, bash as command plus stdout head/tail, the stdout/stderr/report budgets) never apply to the entry view, and the stdout/stderr branch keys on a Claude Code result shape that Pi never produces, so six configuration keys have no effect on any Pi run.
- The compaction-only secondary view is a second implementation with its own excerpt rules that omits tool content entirely.

The user's requirement: one compression method for every source entry, simple rules that do not name particular tools, one budget for tool calls because tool calls are the low-value part, an entry cap that protects the context from long tails, and the same renderer for both compaction tiers with different parameters.

## Solution

Every source entry is rendered by one rule with two numbers. A tool call is worth at most `B` tokens; an entry is worth at most `E`. Within an entry, tool calls give way first, down to a one-line minimum; only when they are at the minimum does natural text yield. Tool arguments become one `name(JSON)` line cut at the head; tool results become plain text (the host unwraps its envelope) cut head and tail with an honest omission count; call ids and native-identity headers leave the model-facing text, since the address the Noter cites is `T<n>#t<k>`. Explicit `trace` reads use the same rule; `full` is unchanged. Compaction's second tier is the same renderer with a smaller `B` and `E`.

Measured on the same backlog (prototype), tokens per entry and total:

| | raw text | current view (B=1000, halves) | tier 1: B=300, E=10K | tier 2: B=100, E=1K |
|---|---|---|---|---|
| tool result (684) | 1,306 | 451 | 177 | 67 |
| tool call entry (489) | 276 | 248 | 71 | 31 |
| assistant text (167) | 340 | 382 | 339 | 334 |
| user (170) | 63 | 105 | 61 | 61 |
| total | 1,125K | 534K | 232K (−57%) | 133K (−75%) |
| Noting runs to drain | | 54 | 24 | |

`E` above 1K never fires on this data; it exists for pasted logs and very long replies. Text is not exempt by rule, only by size.

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
- Part rendering: natural text is the text as stored; a tool-call part is the label line `[T<n>#t<k>] <name>` followed by `<name>(<compact JSON of the arguments>)` cut at the head; a tool-result part is `[T<n>#t<k>] <name> <status>` followed by the result text cut head and tail in equal halves with an omission marker naming the omitted character count. The marker keeps the `[omitted … characters …]` wording the run audit already detects. Images and other non-text blocks become `[<type> omitted]`.
- No call ids and no native-identity header in the model-facing text. Native identity, lineage and view budgets remain in the run's entry audit; the Noter cites `T<n>#user`, `T<n>#assistant`, `T<n>#t<k>`, which the labels carry. The Noter prompt sentence describing entries as "labelled with its native identity" is updated to the addresses actually shown; the prompt hash moves and the fork gate is re-run against the updated parent request, as in 21a.
- Two numbers per profile: `B`, the maximum tokens of one tool-call part (arguments parts get one quarter of `B`, result parts three quarters — arguments are rendered before their result exists and views are immutable, so the split is fixed, and measured argument needs are small); `E`, the maximum tokens of one entry.
- Allocation inside an entry: first cap each tool part at its `B` share. If the entry still exceeds `E`, tool parts give way first, shared fairly down to a minimum of the label line plus a few tokens of body (what was called, whether it succeeded). Only when every tool part is at its minimum does the text part yield, head and tail. The existing largest-fragment shrink loop is replaced by this two-stage order; the "impossible capacity" error when labels and markers alone cannot fit `E` stays.
- Profiles: tier 1 (Noting material, compaction tier 1, branch carry, `trace`) `B = 300`, `E = 10,000`; tier 2 (compaction only) `B = 100`, `E = 1,000`. Tier-1 `E` keeps the 17a value; the tier-2 `E` is provisional until compaction blocks are measured with the new renderer.
- Budgets are configuration, static per installation, never adjusted per batch: views stay immutable and versioned, and an over-full batch is still handled by selecting fewer entries. `B` has a hard upper bound of 1,000 (the 17a value), rejected above it.

### Host contract

- Core renders a host-neutral shape: tool name, status, arguments as a JSON object, result as text. The host registers one result-text extractor with the façade at construction; core applies it when rendering and never inspects envelope fields itself. Default extractor: the stored result string as is.
- The Pi host's extractor joins the text blocks of the result content, marks non-text blocks, and ignores `details`. Evidence is unchanged: the host keeps storing the raw message and the raw `{content, details}` result exactly as today; `trace` with `full` renders them uncut as today. Edit diffs, which live only in `details`, therefore leave the Noter view; this is the trade pi-observational-memory also makes.
- No schema change, no migration, no rewrite of stored entries. Existing databases render under the new rule on next use because views are computed, not stored.

### Deletions and settings

- Deleted: the compaction-only secondary renderer and its version constant; the per-tool branches of the explicit Turn preview (read/search as path, bash command plus stdout/stderr, report head/tail) and the tool-name regex; the budget keys `commandTokens`, `stdoutHeadTokens`, `stdoutTailTokens`, `stderrTailTokens`, `reportHeadTokens`, `reportTailTokens`. The removed keys join the removed-settings table (20b) and are rejected by name with the replacement named.
- Kept: `toolCallTokens` (now `B` of tier 1, default 300, maximum 1,000) and `entryTokens` (`E` of tier 1, default 10,000). Added: the tier-2 pair under the same namespace, defaults 100 and 1,000. Values are positive safe integers as today.
- The entry view version constant changes; run audits record the version and both numbers of the profile used. The compaction custom entry that names the secondary view version names the new version and profile instead.

### Rulings touched (stated so acceptance can diff against them)

- 17a "arguments and result permanently reserve half each" is superseded by the quarter/three-quarter split (user, 2026-09-09, uniform tool-stage method with one per-call budget).
- 17a `toolCallTokens = 1000` default becomes 300 with 1,000 as the ceiling; `entryTokens = 10000` unchanged.
- 20c "compact-only secondary view" is no longer a separate rendering; tier 2 is the same renderer with the tier-2 profile. The three-tier escalation and the "native" tier are unchanged.
- The Noting trigger, batch ceiling, episodic and knowledge budgets, and the 22b trigger algorithm are unchanged; they consume the new view.

## Testing Decisions

Seams (the three confirmed for ticket 22, no new ones):

1. Core façade: goldens for the renderer on synthetic entries — user, assistant text, assistant with parallel calls, tool results with text and image blocks, a result larger than `B`, an entry larger than `E` with and without tool parts — pinned byte for byte; the two-stage allocation pinned by an entry whose text only yields after tools reach the minimum; the impossible-capacity error; `trace` without `full` equals the material view, with `full` equals the stored envelope; compaction tier 2 output equals the renderer under the tier-2 profile.
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

- Prototype and measurements: `/tmp/tm-uniform.ts`, `/tmp/tm-entrycap.ts`, `/tmp/tm-grid.ts` against a copy of the user's database; diagnostic only, not fixtures. The grid over `B ∈ {1000,500,300,200,100}` × `E ∈ {10K,2K,1K,500}` showed `E` inert above 1K and `B` as the only lever (14% / 42% / 57% / 65% / 75% saving over the current view).
- Entry-only budgets were tried and rejected: an entry cap with fair sharing gives 560K at `E = 1,000` (no gain, most tool results are under 1K and pass whole) and cuts 26K tokens of text by the time it reaches 244K at `E = 250`. A single per-part budget cuts 21K of text at 300. The per-call budget is the one that separates tool payloads from text without naming tools.
- pi-observational-memory (3.0.4) was read as the reference: text blocks only, `details` ignored, `name(JSON)` argument lines, half/half excerpts; its absence of a per-call budget was not copied because it contradicts the 17a per-call ruling and lets one result take most of a batch.
