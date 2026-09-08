# 23a — The entry renderer, its two budgets and two profiles (report)

Branch `ticket-23a`, from `e7cd633`. 601 tests green (588 at the baseline), `npm run typecheck`,
`npm run smoke:pi`, `npm run smoke:package`, `npm run perf` all pass. Explicit `trace` output is
unchanged for every budget that still exists; `renderTurn`'s rule was not touched (23b owns it).

## What changed, per decision

| Parent decision | Implementation | Ruling |
|---|---|---|
| One renderer for every source entry | `renderEntry(entry, profile, resultText)` in `src/core/render/index.ts`: parts, two-stage allocation, budget contract | supersedes 17a's single-cap-per-fragment shrink loop |
| Part rendering | text part as stored; tool call = `[T<n>#t<k>] <name>` + one `key: value` line per argument, head cut; result = `[T<n>#t<k>] <name> <status>` + host text cut head/tail; `[details omitted: N characters]`; compact-JSON head when the text is empty; non-text blocks marked by the host | new, satisfies user stories 11–13 |
| Budget contract | `B`/`E` count the rendered part/entry as `tokens` measures it; minimum = label + marker(s); fair shares with one return pass; every part verified against its `B` share and the entry against `E` before returning; capacity error otherwise | new |
| Quarter / three quarters | `ARGUMENTS_SHARE = 0.25`; arguments `floor(B/4)`, result `floor(B·3/4)` | **supersedes** 17a "arguments and result permanently reserve half each" |
| `B` default and ceiling | `render.toolCallTokens` 1,000 → **300**, `TOOL_CALL_CEILING = 1000` rejected above (both profiles' `B`) | **supersedes** 17a's 1,000 default; `entryTokens` unchanged at 10,000 |
| No call ids, no native-identity header | the `[S<n>/T<n>] [entry [...]]` header and `call=<id>` are gone from the model-facing text; identity stays in storage and in `entryAudit` | satisfies 17a "native identity stays bound" (it is bound in the audit, not in the text) |
| Two profiles | tier 1 `{300, 10000}`; tier 2 `{render.secondaryToolCallTokens 100, render.secondaryEntryTokens 150}` | **supersedes** 20c "compact-only secondary view": tier 2 is the same renderer |
| Host contract | `TraceMemory(dbPath, runAgent, config, resultText)`; default `rawResultText` = the stored string; `piResultText` exported from `src/hosts/pi/index.ts` and registered there; core never inspects envelope fields | new (user story 17) |
| Settings removed | `render.stdoutHeadTokens`, `render.stdoutTailTokens`, `render.stderrTailTokens` in `REMOVED_SETTINGS`, rejected by name with `render.toolCallTokens` as the replacement | satisfies 20b's removed-settings table |
| Version and audit | `ENTRY_VIEW_VERSION = "23-v1-uniform-parts"`; `entryAudit.viewVersion` + `viewBudgets` record the profile used; the compaction block title names the version and both numbers (`secondaryRawTitle`) | satisfies 17a "run records say which view version and budgets a run saw" |
| Prompt | one sentence in `src/core/prompts/noting.md` rewritten to the addresses actually shown; the hash moved; the fork gate re-run (not skipped) — `tests/hosts/pi/native.test.ts` drives real fork runs against the new prompt bytes and passes | 21a's rule for a prompt change |

`commandTokens`, `reportHeadTokens` and `reportTailTokens` stay: the explicit Turn preview still
reads them until 23b. The stdout/stderr branch of that preview now reads three module constants with
the 17a values (`STDOUT_HEAD_TOKENS = 60`, `STDOUT_TAIL_TOKENS = 120`, `STDERR_TAIL_TOKENS = 120`),
so production trace bytes are identical while the settings are gone. 23b deletes the branch.

## Sample renderings (goldens, `tests/core/render/entry.test.ts`)

```
[Source entry id: T7#user]
看一下最新的导出。
```

```
[Source entry id: T7#assistant]
Two things at once.
[T7#t1] read
file_path: /tmp/notes.md
limit: 40
[T7#t2] bash
command: grep -n TODO src/*.ts
timeout: 30
```

```
[T7#t1] read success
line one
[image omitted]
line three
```

```
[T7#t1] bash success
HEAD output output …                        (225 tokens: three quarters of B)
[omitted 1400 characters; middle not inspected]
… output output TAIL
```

```
[T7#t1] edit success
Edited /tmp/x.ts
[details omitted: 21 characters]
```

```
[T7#t1] edit success                        (empty result text: the head of the dropped data)
{"diff":"-old\n+new","path":"/tmp/x.ts"}
```

```
[Source entry id: T7#assistant]             (E = 90: the tool parts give way, the text does not)
Short note. word word … word
[T7#t1] bash
command: echo aaaaaaaaaaaaaaaaaaaaaaaaaaaa[omitted 272 characters]
[T7#t2] bash
command: echo bbbbbbbbbbbbbbbbbbbbbbbbbbbb[omitted 272 characters]
```

## Numbers

Node v24.6.0, darwin/arm64. Fixture: `tests/perf` baseline, 63.6 MB, 1,999 source entries,
14.8 M Raw characters, 647 turns (heaviest 40 tool calls), 1,996 entries pending on the backlog copy.

| Measurement | Pre-23 view | Tier 1 | Tier 2 |
|---|---|---|---|
| perf fixture backlog (1,996 pending entries) | 553,980 tokens | **320,109 (−42.2%)** | 183,655 (−66.9%), 1 entry over its `E` |
| perf fixture `large` (3,948 pending entries) | 1,086,050 | 628,912 (−42.1%) | 364,568 |
| perf fixture's own pending tail (30 entries) | 8,082 | 4,715 (−41.7%) | — |
| rendering time, 1,996 entries | 1,968 ms | 1,268 ms | 1,744 ms |

The pre-23 totals were measured by re-running the deleted `e7cd633` renderer verbatim over the same
fixture; they are recorded in `tests/perf/run.ts` as `VIEW_TOKENS_BEFORE_23` and the runner prints the
saving on every run.

Conversation-dense acceptance (`tests/core/api/read.test.ts`, 12 long replies plus their prompts and
one tool call, 26 pending entries):

| | tokens |
|---|---|
| tier 1 | 12,745 — over the 10,000 Raw ceiling, so this set escalates |
| retired 20c secondary view | 2,124 — it fitted |
| **tier 2 at the default `E = 150`** | **2,377 — fits, 1.12× the retired view (bound 1.5×)** |

The tier-2 default of 150 therefore stands as shipped; no default was changed to make a test pass.

## Unmet

**The perf acceptance "at most half of the current view's total" is not reached on the shared
fixture: the tier-1 total is 42.2% below it, not 50%.** The reason is fixture composition, not a
budget that failed to bite. On this fixture the tier-1 total splits as 158,400 tokens of tool results
(all exactly at the 225-token result share, down from 362,209), 94,749 of assistant text with
arguments, 38,950 of user text and 28,010 of assistant text: about 51% of what remains is natural
language, which the rule keeps at its own size on purpose. In the private 1,566-entry backlog that
produced the −57% figure, tool payloads were 80% of the view and text 5%. `B` is the only lever on
the difference, and it is a ruled default; reaching −50% here would mean cutting text by rule, which
the parent forbids ("text is not exempt by rule, only by size"). The runner prints the saving and the
unmet target on every run and fails only on a real regression (tier 1 not below the pre-23 total).

One further honest note: the fixture's heaviest entry (40 tool calls) cannot be rendered under the
tier-2 `E` of 150 — 40 label-plus-marker minima exceed it. That raises the capacity error, `compact`
catches it as a tier-2 capacity failure and delegates to the native tier with that reason, which is
the ruled behaviour for "no complete representation fits"; it is not a silent omission.

## Tests

`tests/core/render/entry.test.ts` (new, 14 tests): the nine goldens byte for byte; the two-stage
order; the budget-contract scan over `B ∈ {60, 100, 300, 1000}` × `E ∈ {40, 150, 1000, 10000}` on a
fixed six-entry set (every part within its allocation, every entry within `E`, no empty or
below-minimum part, capacity error below the minima); no cut inside a surrogate pair; both fidelity
cases (a target path after a 4,000-character value; an honest omission count whose address fetches
the original through `trace` with `full`); the profiles and the ceiling.
`tests/core/api/entries.test.ts` (the 17a bounds file) was deleted: the same subject, pinned by the
new file under the new rule.

Also updated or added: three ruling tests in `tests/core/api/rulings.test.ts` (the halves, the
default and ceiling, the retired secondary renderer); the conversation-dense acceptance and the
rewritten tier-2 scenario 10 in `tests/core/api/read.test.ts`; three fake-host pins in
`tests/hosts/pi/entries.test.ts` (the Pi extractor on a real Pi tool-result shape with text blocks,
an image block and `details`; the Noter's captured request carrying the labels and neither call ids
nor native identity; the removed keys and the ceiling rejected at load); the compaction title pin in
`tests/hosts/pi/compaction.test.ts`; the token-total scenario in `tests/perf/run.ts`.

Two mechanical test changes were forced by the smaller view: the host tests' eager Noting trigger
went from 60 to 30 tokens (one default fake turn now renders 34 tokens against about 74 before, and
the 17b CJK-label test from 50 to 18), and `tests/fixtures/read/compact.txt`, the branch-carry
snapshot and one stdout excerpt in `tests/fixtures/noting/turn.txt` were regenerated (the entry
header is gone; the stdout budget is a constant now, so the golden's 12-token override no longer
applies).

## Revert probes

| Probe | Red test |
|---|---|
| restore the half/half split (`Math.floor(B / 2)`) | `23 golden: a result larger than B keeps head and tail with an honest count, inside its share of B`, plus the budget-contract scan and `23 2026-09-09: 17a's permanent half/half call split is superseded…` (3 failures) |
| restore the call-id label | 8 failures, including `23 golden: an assistant message, and one with parallel calls as label plus one key: value line each` and `23 2026-09-09: the Noter's captured request carries the address labels and neither call ids nor native identity` |
| let text yield before tools reach the minimum | `23: the two stages in order — text yields only after every tool part is at its minimum` |
| drop the removed-settings rejection | `23 2026-09-09: the three removed budget keys and a per-call budget above the ceiling are rejected at load, by name`, and `23: stdout keeps head and tail at its own constants…` |

Each probe was applied alone and the file restored byte for byte (`cmp` clean) before the next.

## `src/` line delta

`src/**/*.ts` 5,447 → 5,563 lines: **+116**, not the expected net deletion. Per file:
`core/render/index.ts` +69 (the uniform rule — parts, fair shares, two-stage allocation, budget
verification, the host contract types — replaces two simpler renderers, of which the retired
secondary one was 30 lines), `core/api/index.ts` +17 (the tier-2 settings, the ceiling, the removed
keys, the extractor parameter), `hosts/pi/index.ts` +19 (the extractor), `core/api/read.ts` +8,
`core/noting/index.ts` +1, `core/render/material.ts` +2. About a third of the renderer's growth is
comment lines carrying the rulings. 23b removes the rest of the old path (`renderTurn`'s per-tool
branches, the tool-name regex and three more budget keys).
