# 23c — Pi's line format, the half split, one marker and `full` on the renderer (report)

Baseline `b3fa426` (main). Everything is left unstaged and uncommitted; `.claude/` is untouched. No
schema change, no migration, no new dependency, no new production module.

`npx vitest run --dir tests`: **616 → 634 passed**, 35 files. `npm run typecheck`, `npm run smoke:pi`,
`npm run smoke:package`, `git diff --check` all pass. `npm run perf -- --repeats=2` below.

## What was built, per ruling

| Ruling (23c) | Implementation | Reference / prior ruling |
|---|---|---|
| 1. Line format | `[T<n>#user]: <text>`, `[T<n>#assistant]: <text>`, one line `[T<n>#t<k>] <name>(<key>=<JSON>, …)` in stored key order, `[T<n>#t<k>] <name> <status>: <text>` continuing on the following lines. Non-object payload `<name>(<raw>)`; a key that is not `/^[A-Za-z_$][A-Za-z0-9_$]*$/` is JSON-quoted | line shape and marker family copied from Pi's `core/compaction/utils.js` (`serializeConversation`, `truncateForSummary`); addresses, budgets and head-and-tail cuts stay ours |
| 2. Half split, head and tail | `ARGUMENTS_SHARE = 0.5` — arguments and result each `floor(B/2)`. A value that fits its fair share is whole; one that does not is cut head and tail, a string inside its JSON string with each half encoded separately, anything else on its compact JSON text. `cutUnits`/`units` make every cut fall on a whole code point and, in JSON text, on a whole escape sequence (`\"`, `\\`, `\n`, `\uXXXX`, and an escaped surrogate pair) | **supersedes 23a's** quarter/three-quarters, which had superseded 17a's halves; fair shares unchanged from the parent (equal shares, remainders to the earliest keys, one return pass) |
| 3. One marker family | `[... N characters truncated]` and `[... N characters of details truncated]`; the sealed/starved call floor is `[T<n>#t<k>] <name>(...)` + one marker. `[omitted …]`, `[omitted …; middle not inspected]` and `[details omitted: …]` are gone from `src/`, including the branch-carry receipt in `read.ts` and the run-preview cut in `renderRun`, which are omissions in a view too. The run audit's regex is `/\[\.\.\. [^\]]+ truncated\]/g` | parent "markers keep the wording the run audit already detects", re-pointed at the new family |
| 4. `full` on the renderer, unbounded | `renderEntryWhole(entry, resultText, choose)` — no profile parameter, no cut, no allocation, no character-array split, no `tokens` call. `renderTrace` takes it when `options.full`; `api/index.ts` passes `rawResultText` and an **unrestricted** entry list for `full`. `renderTurn`, the `tool=`/`status=`/`omitted=` labels, the `input:`/`result:` blocks and the `multiple results` merge are deleted | 17a "shared-call fork results retain both originals through unrestricted full trace"; 23b's sibling exclusion still applies to the read *without* `full` |
| 4. Noting's head reply | **exported text-part function** (`renderText(turnId, role, text)`), used by `sourceParts` for the entry view and by `core/noting/index.ts` for the head reply — one shape, no entry-shaped stand-in | the implementer's choice the ticket left open |
| 5. Everything downstream | `ENTRY_VIEW_VERSION = "23-v2-pi-lines"`; the tier-2 compaction title, the run audit's view version, the Noter prompt sentence (hash `7cb862df…` → `864d1697…`, fork gate re-run), `docs/core.md`, `docs/pi.md`, `CONTEXT.md` and every golden moved with the bytes. Tier 2 keeps `B = 100`, `E = 1,000` (50 / 50) | |

Sample (the ticket's own example, produced by the renderer):

```
[T42#user]: 看一下最新的导出。
[T42#assistant]: Two things at once.
[T42#t3] bash(command="cd /tmp && wc -l core/*.ts", timeout=30)
[T42#t4] edit success: Edited /tmp/x.ts
[... 21 characters of details truncated]
[T7#t1] write(content="章章章…"[... 271 characters truncated]"…章章章", file_path="/tmp/target.md", mode="overwrite")
[T7#t2] read(...)
[... 9 characters truncated]
```

## GPT review of `b3fa426`: the two findings that land here

**Finding 4 — null argument values rendered as empty strings.** Fixed by 23c's rule itself: `items()`
renders a non-string value as its compact JSON, so `{"value":null}` is `value=null` and `{"value":""}`
is `value=""`. The shared `string()` helper is no longer used by the entry renderer at all (its only
remaining caller is `renderRun`'s run-record preview, which is not entry evidence and was not
changed). Test: `23c (GPT review 2026-09-09): a null argument value renders as null, never as an empty
string` — it also pins `false`, `0`, `[]` and `{}` apart from each other.

**Finding 3 — a displayed non-text user address could not be traced.** `renderTrace`'s existence check
now uses a new `displayedAddresses(entry)`, not `sourceAddresses(entry)`: the two answer different
questions, and the one that says what a fact may cite as evidence must not widen because a placeholder
is displayable. `speaks(entry)` is the single predicate both `sourceParts` and `displayedAddresses`
use, so the check cannot drift from what is displayed. `sourceAddresses` and its four fact-validation
callers in `core/api/tools.ts` are untouched. Test: `23c (GPT review 2026-09-09): a displayed non-text
user address is readable on its own` — `trace T<n>#user` returns the placeholder, while an assistant
entry with no text of its own (only tool calls) is still not a readable part.

Nothing else from that review was touched: the search/cursor snapshot finding and the cache-miss
reopen finding belong to other workers and their files were not opened.

## One correction inside 23c's own slice

An empty JSON object payload (`{}`) rendered as `<name>({})` in the first cut, because "no keys" was
read as "not an object". `object()` now returns `null` for a payload that is not a JSON object, so
`{}` renders as `<name>()` and only a genuinely non-object payload renders raw. Pinned in the
non-object golden.

## Numbers

`node v24.6.0`, darwin/arm64, `npm run perf -- --repeats=2`, 22a baseline fixture (63.6 MB, 1,999
source entries, 14.8 M Raw characters, 647 turns, heaviest T324 with 40 tool calls, 1,996 pending).

| Measurement | 23a / 23b | 23c |
|---|---|---|
| tier-1 total, baseline backlog | 320,109 tokens (−42.2%) | **262,573 (−52.6%)** — the parent's 50% target is reached on this fixture for the first time |
| tier-2 total, baseline backlog | 183,655, 1 entry over its `E` | 185,517, **0 entries over its `E`** |
| tier-1 / tier-2 rendering time, 1,996 entries | 1,268 / 1,744 ms | 1,146 / 1,085 ms |
| `trace full` (heaviest Turn) | 10.0 ms / 42 reads | **10.0 ms / 42 reads** |
| `trace assembled` (heaviest Turn) | 83.2 ms / 42 reads | 75.1 ms / 42 reads |
| large fixture, tier 1 | 628,912 | 516,995 (−52.4%) |

Two performance notes, both found by the perf runner during this slice and fixed in it:

1. The first cut computed a cut's omitted-character count by joining and spreading the omitted middle
   on **every** `fit` probe — `trace full` went to 46 ms, the tier-1 total to 6.2 s. `cutUnits` now
   builds a prefix sum once (only for JSON text; for code-point units the count is arithmetic), so a
   probe counts in constant time. That is what brings the numbers above below 23a's and 23b's.
2. The unbounded path must not build a character array, so the three floors (`textFloor`,
   `argumentsFloor`, `resultFloor`) count code points without allocating and are shared with the
   budgeted `Part`, which is why a `full` read with `tool:` selection stays at 10 ms.

The acceptor records the real-log total separately; this worker never opened `~/.trace-memory/`.

## Tests

New file: none. `tests/core/render/entry.test.ts` rewritten to the new format (25 cases) and
`tests/core/api/trace-assembly.test.ts` extended (13 cases); `tests/hosts/pi/entries.test.ts` gained
two (23 cases).

Per checkbox:

- **Goldens, byte for byte** (`entry.test.ts`): user; assistant text; assistant with two parallel
  calls (one line each, `key=JSON` in stored order); a non-object payload (plus `{}` and an array);
  a result with text and an image block; a result larger than its half of `B`; an argument value
  larger than its share (head and tail inside the JSON string, marker between the quoted halves, the
  short siblings whole); a sealed call at its floor; a result with empty text and only `details`
  (compact-JSON head on the label line, no blank); a result with text and `details`; an entry larger
  than `E` with and without tool parts.
- **The half split**: `23c: the half split — a call's arguments and its result each get floor(B / 2)`
  over `B ∈ {60, 100, 300, 301, 1000}`, and the ruling record
  `23c 2026-09-09: 23a's quarter/three-quarter call split is superseded…` in `rulings.test.ts`. The
  23a budget-contract scan is re-run under the new format with `share = floor(B/2)`.
- **One marker family**: `23c: one marker family — no "[omitted " and no "details omitted" is left in
  src` (greps every `.ts` under `src/`, comment lines stripped, the device `boundary.test.ts` uses),
  and `23c 2026-09-09: the run audit records the new marker family for a cut entry and nothing for an
  uncut one` (fake Pi host, captured run audit: the short user entry has no markers, the cut
  arguments one has one, the cut result one has the text marker and the details marker).
- **`full` goldens**: `23c golden: full is the same renderer with no budget…` (a Turn read with `full`
  equals `renderEntryWhole` of each of its native entries, in entry order); `details` whole through
  the Pi extractor test; `23b golden: a call with several native result occurrences shows each
  occurrence` now asserts the same two entries under `full`; `23c: a full read through the registered
  trace tool keeps its unrestricted scope, the assembled read does not` (bound to a session and
  branch, through `memory.tools(...)`); 23b's sibling-exclusion golden and
  `paged-reads.test.ts`'s read counter are green and unchanged.
- **JSON boundaries**: `23c JSON boundaries: a cut string value stays two valid JSON strings around
  the marker` (a value of `\n`, `\"`, `\\` and an astral pair, over a dense budget scan producing >40
  distinct cut positions; each half parses and is really the head or the tail); `… a long array and a
  long nested object are cut on their compact text, edges outside every escape` (cut edges scanned for
  a partial escape, an orphan surrogate and a broken `\uXXXX`); `… a key that is not a plain
  identifier renders JSON-quoted, as one argument`.
- **`full` cost**: (a) `23c full cost: the unbounded path copies a 2 MB result as its label plus the
  stored bytes` and the same 2 MB assertion through the façade inside the cost test in
  `trace-assembly.test.ts`; (b) the perf runner's `trace full` at 10.0 ms, equal to 23b's; (c) **a
  guard that demonstrably fires**: `tokens` is module-internal, but it is the module's only caller of
  `String.prototype.split`, which *is* a prototype method, so a counting wrapper around a render
  counts token measurement. `23c full cost: the unbounded path measures no tokens, while the budgeted
  path does` asserts the budgeted count is positive **first** and the unbounded count is zero second;
  `23c full cost: a full read measures no tokens, so its cost follows neither the payload nor the
  parts` does the same through the public `trace`, where the read's own address parsing accounts for a
  fixed handful of splits. No production hook, no module split, no configuration.
- **Deletions**: `23c: renderTurn, the tool= / omitted= labels, the input:/result: blocks and the
  multiple-results merge are gone from src` (greps `renderTurn`, `omitted=`, `multiple results`,
  `["input", call.input`, `characters of input/result`). Noting's head reply as
  `[T<n>#assistant]: <text>` is pinned in `rulings.test.ts` (`material.head`) and
  `material.test.ts` (the inherited increment that goes into the captured request).
- **Fake Pi host**: the captured request carries the new lines and markers, no call ids, no native
  identity (`entries.test.ts`); `23c 2026-09-09: the Noter prompt names the labels, the half split and
  the honesty clause once` reads `src/core/prompts/noting.md` and pins the four label forms, "one half
  for its arguments and one half for its result", both markers, and that "not inspected" occurs
  **exactly once** in the prompt; the fork gate was re-run against the updated parent request (the
  real fork runs in `native.test.ts`, 29 green) after the hash moved; the tier-2 compaction title
  names `23-v2-pi-lines`.

Mechanical test changes forced by the smaller view, listed so they are not mistaken for behaviour
changes: the host tests' eager Noting trigger went from 30 to 20 tokens (a default fake turn now
renders 26 tokens against 34 before) and the 17b CJK-label case from 18 to 16; the trigger fixture's
prompts grew from 40 to 50 words so the backlog still passes the 10,000-token default; scenario 9's
episodic budget went from 120 to 105 tokens (at 120 both facts now fit); `tests/fixtures/noting/
turn.txt`, `read.txt`, `tests/fixtures/read/compact.txt` and one snapshot were regenerated.

## Revert probes

Each applied alone, the file restored from a pre-probe copy and verified with `cmp` (all byte-for-byte
clean; the suite is green again after each).

| Probe | Named red tests |
|---|---|
| restore the per-key argument lines (`argumentsWhole` joins `key: value` on its own lines) | 17 red, including `23c golden: an assistant message, and one with parallel calls as one line each, key=JSON in stored order`, `23c golden: a payload that is not a JSON object renders as name(raw)`, `23c golden: a sealed call keeps its name, its brackets and one marker for the whole part`, `fixture turn golden and noting input use identical rendering with receipts last` |
| restore the quarter / three-quarter split (`ARGUMENTS_SHARE = 0.25`) | 8 red, including `23c: the half split — a call's arguments and its result each get floor(B / 2)`, `23c 2026-09-09: 23a's quarter/three-quarter call split is superseded…`, `23 budget contract: over a range of B and E every part is within its allocation…` |
| restore the old marker wording (`[omitted N characters; middle not inspected]`) | 18 red, including `23c 2026-09-09: the run audit records the new marker family for a cut entry and nothing for an uncut one` and `23c: one marker family — no "[omitted " and no "details omitted" is left in src` |
| render `full` through a second code path (an inline `tool=…` + `input:`/`result:` renderer in `renderTrace`) | 10 red, including `23c golden: full is the same renderer with no budget…`, `17a 2026-09-08: shared-call fork results retain both originals through unrestricted full trace`, `22c: a full trace obtains the Turn's occurrences once…` |
| narrow `full` by the reader's branch (pass `display.branch` for `full` too) | `23c: a full read through the registered trace tool keeps its unrestricted scope, the assembled read does not` |
| route `full` through the budgeted path (`renderEntry` with a 1e9 profile) | `23c full cost: a full read measures no tokens, so its cost follows neither the payload nor the parts` (the payload dimension alone does not catch it — a one-shot `tokens(whole)` is one split whatever the size — the **parts** dimension does: 125 splits against 11). The perf runner also catches it: `trace full` doubles to 21.4 ms |

## `src/` line delta — **not a net deletion**

`src/**/*.ts` 5,736 → 5,866: **+130**. Non-comment, non-blank: 4,515 → 4,586, **+71**. Per file:
`core/render/index.ts` +232 −102, `core/api/index.ts` +8 −13 (the `multiple results` merge and the
occurrence walk are gone), `core/noting/index.ts` +8 −3 (the audit regex with its ruling comment),
`core/api/read.ts` ±1.

The ticket expected the deletion of `renderTurn` and the `full` path to make this a net deletion; it
did not. Honestly: what was deleted is 24 code lines of `renderTurn` plus 10 in `api/index.ts`, and
what replaced it is larger — the escape-safe unit split and its constant-time prefix counting
(`units`, `codePoints`, `cutUnits`), the `key=JSON` encoding with its identifier rule and the three
value kinds, a `whole` and a `floor` per part kind so both paths produce identical bytes from one
definition, and the unbounded path itself. Roughly 40 of the 232 added lines are comments carrying the
rulings. Nothing here was written for a future need; the only removable candidate would be the prefix
sum in `cutUnits`, which the perf fixture says is worth 5× on the tier-1 total.

## Unmet / stated plainly

1. **"Cut at every kept length" is approximated by a dense budget scan.** The JSON-boundary cases scan
   `B` from 40 to 800 in steps of one and assert the number of *distinct* cut positions observed (>40
   for the string case, >20 for the array and the nested object), so the scan cannot silently
   degenerate; but the renderer offers no way to ask for an exact kept length without a production
   hook, so a handful of kept lengths no budget selects are not exercised.
2. **The escape-boundary property is pinned by its own cases, not inside the budget-contract scan.**
   The scan pins allocations, minima, emptiness and surrogate pairs (as in 23a); the three JSON
   boundary tests pin the escape edges. Both run on every `npm test`.
3. **The `full` no-measurement guard is a `String.prototype.split` counter.** It is honest about what
   it proves — that the unbounded path calls the estimator zero times, because the estimator is the
   module's only splitter — and it is shown to fire on the budgeted path first, in the same test. It
   would not catch a hypothetical measurement that avoided `split`.
4. **Two markers outside the entry view moved with the family**, because the ticket's grep is over all
   of `src/`: the branch-carry receipt (`[... N earlier pending entries beyond the carry budget
   truncated; read them with trace]`) and `renderRun`'s line cut (`[... N lines, M characters
   truncated]`). Both are omissions in a view, so the family fits; neither is an entry view and
   neither is read by the run audit.
5. **`renderSources` still emits `tool=`** in the frozen source index (`T7#t1 tool=bash …`). That is
   the inherited-run index, not the entry view, and the ticket's deletion list names `renderTurn`'s
   labels; the grep test therefore looks for the exact dead strings rather than for `tool=`.
6. **Tier 2 is 1,862 tokens larger than 23a's** on the baseline fixture (185,517 against 183,655),
   because at `B = 100` the arguments share doubled from 25 to 50 tokens while the result share fell
   from 75 to 50. In exchange the tier-2 view now fits every entry of that fixture (23a's heaviest
   entry raised the capacity error and escalated); tier 1, the number the parent budgets against, is
   57,536 tokens smaller.
