# Ticket 19c, second half — cutover and deletion of the request-copy runner: acceptance report

**Ready for acceptor review.** Baseline: `864e492`, *Ticket 19c (first half): launch readiness,
cache-miss latch and cancellation pins behind nativeRunner*, read with `git log -1 --oneline` before
implementation. The initial working tree was clean; HEAD is unchanged, nothing is staged and nothing
is committed. No pre-existing file under `.scratch/v1/issues/` was touched; only this report is new
there. **Nothing was renamed**: `branch` and `subagent` are still the execution-mode spellings, and
`CONTEXT.md` is untouched — that is part 3's work, together with the legacy labelling of historical
runs and the glossary.

---

## Verification

Every command ran in the foreground on Node 24.6.0 with an explicit timeout; no background waits, no
credentials, no live provider. The whole suite takes ~23 s.

| Check | Before | After |
|---|---:|---:|
| `npm test` | 506 passed, 26 files | 487 passed, 25 files |
| `npm run typecheck` | Passed | Passed, including after both probe restorations |
| `npm run smoke:pi` | Passed | Passed: one **native** Noting run, one fact, the child's own log |
| `git diff --check` | Clean | Clean |
| Revert probes | Not applicable | Two applied, each red on its named test, each restored byte-for-byte |
| HEAD / staged / commits | `864e492` / none / none | `864e492` / none / none |

Test count falls by 19: **23 old-runner cases deleted** (see the test-seam section) and **4 new cases
added**, all titled `19c 2026-09-08:`. Every remaining pre-existing case still runs; the ones that
had to change are listed one by one below.

## Owned checkbox

> After deletion no legacy loop, prefix builder or settings reader remains; `verifyRequest` remains
> and still runs on every fork request; the report shows production lines added and removed against
> the 19a baseline.

| Requirement | Where it is now | Named test |
|---|---|---|
| No legacy loop | `runAgent` has two arms, both `runNative`: fork, then fresh child. A child that cannot be constructed is a run failure with a reason (outer catch); nothing else exists to fall back to | **19c 2026-09-08: no legacy loop remains: a fork that cannot be prepared runs in a fresh native child, not a hand-built request** (asserts the fallback's own `nativeLog` exists under `runsDir`, its system prompt is core's, its tool list is the four memory tools) |
| No prefix builder | `buildRequest`, `appendNativeRequest`, `providerMessage`, `list` and `verifyRequest` are gone from `branch.ts`; the child's body is Pi's own serialization | the gate tests below, plus the type checker: nothing imports them |
| No settings reader | `retrySettings` and its stale "needs pi-server" comment are gone; the child's `SettingsManager` is the only source of retry/provider policy | **19c 2026-09-08: the child's retry policy is Pi's own, read from settings.json by SettingsManager** |
| `verifyRequest` remains and runs on every fork request | `verifyForkRequest` (the byte-level family: `verifyNativeRequest` + `stripCacheControl` + `hash`/`serialize`) runs inside `onPayload` on the first body and on every later round | **19c 2026-09-08: every fork round is verified against the previous request and the run stores the last request sent**, plus the retained 19a gate cases on both APIs and 19c1's prefix-failed case |
| Line delta | See **Production line delta** | — |

Rulings this dispatch had to satisfy, and where each is pinned:

- **Gate 1 (amended)** — "custom message construction, the duplicated model/tool loop and the
  handwritten settings reader go; the verification stays": the three deletions above; the
  verification is exercised by every fork test in `native.test.ts`.
- **Gate 6 / Runtime settings** — the retry-policy test above; the mutation that ignores
  `settings.json` is probe (b).
- **Gate 5** — `runsDir` is untouched; the fallback test asserts the child log still lands under
  `<runsDir>/<parent id>/`.
- **18a** — configuration still comes from the `trace-memory` key of the global and project
  `settings.json` with `TRACE_MEMORY_CONFIG` on top, read-only, with per-key sources in the menu; the
  18a tests are unchanged and green. `nativeRunner` now falls under 18a's unknown-key rule (below).
- **17b/17c/18b/19a gate/19b boundary** — unchanged except where deletion forced a call site; the
  three test edits that follow from deletion are listed and justified below.

## Design choices

**Reused, not invented** (per the standing ruling to copy Pi's own shape first):

- The retry surface is Pi's own event pair. The adapter no longer calls `retryAssistantCall`; it
  subscribes to the child's `auto_retry_start` / `auto_retry_end` and reports what Pi decided
  (attempt, maxAttempts, delay, error). The footer indicator and the one notice per scheduled attempt
  are the pre-cutover behaviour, driven by Pi's events instead of by a policy of ours.
- The retry, provider and timeout policy is whatever `SettingsManager.create(cwd, agentDir)` reports,
  which is what `native.ts` already passed to `createAgentSession` in 19a.
- The test seam's wire is `native-fixture.ts`'s: a stubbed `fetch` answering `openai-completions`
  SSE against the real installed pi-ai adapter.

**Mine, and why:**

- **`nativeRunner` is rejected, not accepted as a no-op.** 18a's rule is that any key outside the
  known set throws `Unknown setting <key>` at load, and that rule exists so a misspelling cannot
  silently do nothing. A key that no longer selects anything is exactly that case, so it now throws
  like any other. v1 is unreleased, and the switch shipped only inside these three dispatches, so no
  released configuration breaks. (The alternative — a warning and a no-op — would be the only choice
  if the key had ever been documented as stable.)
- **The run record stores the *last* request sent, restoring the documented contract.** 19a's native
  runner recorded the *first* (gate-verified) body; the spec's Run record contract says "the last
  request sent (which embeds every earlier round)", and every host test that inspects `runs.request`
  asserts that. With the old runner gone, the two conventions could no longer coexist, so `native.ts`
  now records the last body and the gate keeps the first body's hashes in `verification`. The 19a
  case that compared `run.request` to the child's first body now compares it to the last (in that run
  they are the same body; the assertion is one line and is annotated).
- **A cancelled fork request really is cancelled at the wire.** The scripted-reply seam races the
  scripted reply against the request's `AbortSignal`, because a real provider request ends when the
  child aborts. One 17c case deliberately wants the opposite — a wedged connection that ignores
  cancellation, so the five-second shutdown deadline is what fences it — and it now says so with
  `provider(fn, { ignoreAbort: true })`.
- **A stale capture is no longer a correctness problem, and the check that guarded it is gone.** The
  request-copy runner replayed a captured body, so a capture that predated the selected entries could
  send evidence-free context; it refused with "Captured prefix does not contain selected source
  entries". A fork branches the parent's *persisted ancestry*, so those entries are in the child's
  context by construction, and the gate compares only the prefix (a longer child history still
  matches the parent's prefix bytes). The two 17b cases that named that message now assert the
  fallback and the complete evidence, with the reasoning in a comment. Stated here because it is the
  one deleted check whose *rule* is now satisfied structurally rather than by code.
- **`h.drain()` waits on the footer, not on a tick count.** A worker is a real child session now, so
  "the run is in flight" is wall-clock, not a fixed number of microtasks. The seam keeps ticking while
  the footer shows the running indicator (set synchronously when a phase is admitted, cleared when it
  settles), returns ~150 ms after a scripted reply is held open, and uses `setImmediate` +
  `performance` so the two 17c cases that install fake timers still work.

## The deletion

| File | Symbol | Lines | What replaced it |
|---|---|---:|---|
| `hosts/pi/index.ts` | `converse` (the model/tool loop), `outcomeOf`, `outputOf`, the branch candidate block (`buildRequest`/`verifyRequest`/`stripCacheControl`/`appendNativeRequest` rounds, `getApiKeyAndHeaders`, `complete`), the `registry.complete` subagent path | 132 → 3 | the two `runNative` calls that were already there |
| `hosts/pi/index.ts` | `retrySettings` + its stale "a value import of SettingsManager needs pi-server" comment, and `addUsage` | 20 → 4 (a comment naming gate 6) | the child's `SettingsManager`; `native.ts` sums usage itself |
| `hosts/pi/index.ts` | `nativeRunner` in `hostFlags`, the whole `hostFlags` list and its type check; the switch in the fork arm, the subagent arm, `forkWait` and the settings menu | ~8 | nothing: one runner |
| `hosts/pi/index.ts` | `retryAssistantCall`, `complete`, `Tool`, `ToolCall` imports; `Registry`/`Conversation`/`Reply` types; `session.verified` and the `Verified`/`firstForKey` verification type | ~10 | `NativeVerification` from `native.ts` |
| `hosts/pi/branch.ts` | `buildRequest`, `appendNativeRequest`, `providerMessage`, `list`, `verifyRequest`, the `Appended` type | 26 | Pi's own serialization; the gate keeps `verifyForkRequest`, `verifyNativeRequest`, `stripCacheControl`, `capturedSystemPrompt`, `capturedTools`, `messageKey`, `hash`, `serialize`, `snapshot`, `difference` |
| `hosts/pi/branch-wire.test.ts` | the whole file | 98 | 19a's gate cases on both APIs, on a real child |

`verifyRequest`'s string-append form has **no caller left** and is deleted. The checkbox's
"`verifyRequest` remains" is satisfied by the byte-level family it belonged to: `verifyForkRequest`
runs on every fork request, and `verifyNativeRequest` — the function `verifyRequest` was a thin
wrapper around — is still the comparison underneath it and is still unit-tested directly.

Kept deliberately: the parent request capture in `before_provider_request` (the gate's comparand),
`runsDir`, the fallback/notice wiring, and the `rejected()` receipt check (the registered foreground
tools use it too).

## Test-seam migration

`hosts/pi/test-host.ts` keeps its whole scripting API — `provider(fn, {autoStop, ignoreAbort})`,
`requests`, `conversations`, `signals`, `notices`, `statuses`, `drain`, `turn` — and now implements
it at the wire: one global `fetch` stub (registered per host by provider base URL, because several
17c cases run two hosts at once) that records the real outgoing body, reconstructs the conversation
from it (`conversationOf`) for the scripted callback, and returns the callback's `Reply` as
`openai-completions` SSE. A scripted `stopReason: "error"` becomes an HTTP error carrying the scripted
message, so Pi's own retry classifier sees the text the test wrote. `native-fixture.ts` stubs the wire
itself and asks the host not to (`fetch: false`).

Consequence worth stating plainly: in the fake host there is no persisted parent session file, so
**every branch-mode task there falls back to a fresh native child** with
`fallbackReason: "native runner: The parent session is not persisted"`. Inherited-context behaviour is
therefore tested only on `native-fixture.ts`, which has a real parent `AgentSession` — which is where
19a/19b/19c1 already put it.

Changed tests (all in place, none weakened silently):

| Test | Change | Why |
|---|---|---|
| `batching.test.ts` — stale branch capture (user, toolResult) and capture after compaction | expect `fallbackReason` to contain `native runner:` instead of "does not contain selected source entries" | that refusal belonged to the deleted runner; see Design choices |
| `batching.test.ts` — native payload overhead is capacity-checked | drives the real overhead (a 6k-token window that admits the material and cannot hold the body) instead of wrapping `modelRegistry.complete` to inflate the payload | the wrapped seam no longer exists; the new form tests the real overhead (system prompt + tool schemas) |
| `catchup.test.ts` — shutdown cancels retry waits | `usage.input` is 1, not 2 | a transport failure reports no usage of its own; the ruling ("retains available usage") is unchanged |
| `catchup.test.ts` — five-second shutdown deadline | scripts the wedged provider with `{ ignoreAbort: true }` | otherwise the abort ends the request and the deadline is not exercised |
| `index.test.ts` — three shutdown-for-replacement cases | dropped `expect(closed).toBe(false)` | 17c's ruling is that shutdown *cancels*; an aborted request now ends promptly, so shutdown no longer waits |
| `index.test.ts` — consolidation replay, in-flight duplicate, consolidation duplicates, footer indicator | one `await h.drain()` added, or an assistant message compared with `toMatchObject({role, content})` | the child needs wall-clock time to reach the wire; a conversation read back from a body has no provider fields |
| `index.test.ts` — retry re-sends the same request | usage counts only attempts that reported usage; the recorded retry error is Pi's text | as above |
| `cache-miss.test.ts` — two phases reporting a miss together | the *first* turn's Noting response now reports below-minimum input | with a drain that really waits, that run finishes before the two-phase opportunity and would arm the latch first; the ruling under test (one transition, one warning for two concurrent misses) is unchanged and now deterministic |
| `native.test.ts` — the two gate cases | `run.request` compared to the last body sent | the restored Run record contract, above |

Deleted tests, and where each ruling is pinned now:

| Deleted | Ruling | Pinned by |
|---|---|---|
| `branch-wire.test.ts`: real pi-ai serialization sends the preserved body and reports cache reads | the outgoing body preserves the captured prefix byte for byte; cache reads are recorded | 19a **the native child's first request passes prefix verification against the captured parent request** (real adapter, real child) and **each child response's reported cache read is recorded as an observation** |
| `branch-wire.test.ts`: real Anthropic Consolidation continuation preserves signed thinking and the captured prefix | Anthropic rounds keep the prefix and native thinking signatures | 19a **the anthropic-messages child passes the gate with cache_control stripped from both sides and nothing else** plus 19c **every fork round is verified against the previous request…**; signature/tool-id preservation is now pi-ai's own serialization, which is exactly what the deletion buys |
| `branch.test.ts`: branch noting preserves prefix bytes, options and tools | the fork's first body equals the captured body outside the appended tail; the record carries both hashes | 19a gate case (same assertion on a real child) |
| `branch.test.ts`: mutated system/tools fails before send, falls back with full input, notifies once (×2) | a mismatch is rejected **before** sending; the run continues fresh-context; one warning per session | 19c1 **a request that failed the prefix check does not count toward the latch** (doctored capture → gate rejection → fresh-context run) and 19b **an unforkable branch task falls back…** (which asserts the single "fell back" notice) |
| `branch.test.ts`: verification runs on every attempt and resets after model/provider/tool changes | every attempt is verified; a model change invalidates the capture | 19c **every fork round is verified…** (every round, unconditionally — stronger than `firstForKey`) and 19c **a session model change after the capture refuses the fork instead of reusing a stale body** |
| `branch.test.ts`: cache reads are observations only (×3) | a cache read never decides `passed` | 19a cache-read observation case; 19c1's ten-case eligibility table |
| `branch.test.ts`: capture invalidates on tree switch and cannot be inherited by a new Pi session | a tree switch or a new Pi session drops the capture | 19c1 **a tree switch before the launch does not substitute the new branch's history for the waiting task** (both go through the same `restore()` that clears the capture) |
| `branch.test.ts`: model change without a fresh capture falls back; explicit subagent never uses a capture | as above; a subagent run ignores captures | 19c model-change case; the fresh child has no capture input at all (19b **an explicit subagent task runs in a fresh native child…**) |
| `branch.test.ts`: `%s` uses its native append without changing any prefix character (×3); the verifier independently rejects extra appends and provider option changes | the verifier catches appended-message and body-option differences | retained **19a ruling 2026-09-08: the fork gate ignores cache_control placement and no other difference** (temperature, system byte, tool description and message-content mutations all still asserted) |
| `branch.test.ts`: an in-flight branch request keeps its captured body across a tree switch and a later capture | a running task is not re-targeted by a later capture | structural now: the captured body is passed into `runNative` at launch and never re-read; the tree-switch half is 19c1's readiness case. **No dedicated test**, declared here |
| `branch.test.ts`: 17:01 settle is branch-capable (candidate + final replay) | Consolidation's two submissions and its review round run in inherited context | 19a **Consolidation's two submissions and its review round run natively** |
| `branch.test.ts`: capture with the four tools, verification passed, tools unchanged | the child re-registers the parent's tool list unchanged | 19a gate case asserts `f.sent[1].tools` equals the parent's `tools`, item for item |
| `branch.test.ts`: branch Noting verifies every trace and note round; a mutated tool round is rejected and retains the last sent request | rounds are verified against the previous request; the record keeps the last request | 19c **every fork round is verified against the previous request and the run stores the last request sent** (trace + note rounds, hash chain, `runs.request` = last body). The *mutation* half has no equivalent: its target (`appendNativeRequest`) no longer exists, and the child's body cannot be corrupted from outside |
| `branch.test.ts`: `openai-responses`/`openai-codex-responses` rounds preserve native function call IDs and results (×2) | responses-family rounds keep call ids | none, deliberately: this adapter no longer builds those messages, so the behaviour is Pi's. Declared as a coverage loss below |
| `branch.test.ts`: a branch retry re-sends the same request built from the same base | a retry re-sends the same body, never a re-appended one | `index.test.ts` **a retry re-sends the same request…** (unchanged assertion `retried.messages == failed.messages`, now over Pi's retry) |

Two `branch.test.ts` cases were **rewritten rather than deleted** because they test host rules, not the
runner: *17:01 a model switch during the consolidation candidate round does not redirect or break the
final round* (now asserts the frozen model over the real wire) and *consolidation without a usable
capture falls back to fresh context for both rounds and notifies once*.

New cases (4, all `19c 2026-09-08:`): the no-legacy-loop pin, the round-chain/last-request pin, the
`SettingsManager` retry-policy pin, and the model-change-after-capture pin.

## Revert probes

Each probe: apply the mutation, confirm the diff, run the **full** suite in the foreground, record the
red titles and counts, restore the original bytes, reverify with `shasum -a 256`, then confirm the
suite is green again.

| Probe | Mutation | Named red test(s) | Failed / total | Restored SHA-256 |
|---|---|---|---:|---|
| (a) Reintroduce a request-copy fallback | `hosts/pi/index.ts`: on `NotForkable` from the fork path, drive the task through a hand-built request — pi-ai `compat.complete` with the composed fresh-context conversation, this adapter's own tool loop and `onPayload` audit — instead of the native subagent | **19c 2026-09-08: no legacy loop remains: a fork that cannot be prepared runs in a fresh native child, not a hand-built request** (`response.nativeLog` is undefined: a hand-built request leaves no child session) | 40 / 487 | `hosts/pi/index.ts` `49d2d46bc9f1e4069198470ac28bd886a9983a2daaac324bfec9cf6b08aa36e7` |
| (b) Read retry settings from a handwritten merge | `hosts/pi/native.ts`: `SettingsManager.inMemory({retry: {enabled: true, maxRetries: 1, baseDelayMs: 1}})` instead of `SettingsManager.create(cwd, agentDir)`, so `settings.json`'s `retry.maxRetries` is ignored | **19c 2026-09-08: the child's retry policy is Pi's own, read from settings.json by SettingsManager** (`[1]` instead of `[1, 2]`), plus **17c … shutdown cancels retry waits** and **the footer shows the warning indicator while a retry waits**, which also depend on the file's policy | 3 / 487 | `hosts/pi/native.ts` `053265f874d71d4256cde9c8f5b5382b28698967733ad185e577ab4228ec1078` |

Probe (a)'s blast radius is wide (40 cases) because in the fake host *every* branch-mode task takes
the fallback, so the mutation replaces the runner for most host tests; the one named above is the one
that names the violated ruling. Probe (b) is narrow and its three failures are all retry-policy
assertions.

## Production line delta

Production TypeScript only (`core/**` and `hosts/pi/*.ts`, excluding `*.test.ts`, `test-host.ts`,
`native-fixture.ts` and `smoke.ts`).

**This dispatch**, against `864e492`:

| File | + | − |
|---|---:|---:|
| `hosts/pi/index.ts` | 51 | 187 |
| `hosts/pi/branch.ts` | 0 | 26 |
| `hosts/pi/native.ts` | 20 | 8 |
| `hosts/pi/compose.ts` | 3 | 3 |
| **Total** | **74** | **224** |

**Net −150 production lines.** `hosts/pi/index.ts` goes from 975 to 839 lines and
`hosts/pi/branch.ts` from 110 to 84.

**Cumulative against the 19a baseline `d4a2df5`** (i.e. 19b + 19c1 + this dispatch):

| Area | + | − |
|---|---:|---:|
| `core/**` (19b's material contract, 19c1's latch columns) | 150 | 46 |
| `hosts/pi/*.ts` production | 356 | 254 |
| **Total** | **506** | **300** |

**Cumulatively this is +206, not negative, and it is honest to say so.** What that number contains:
19b moved context assembly out of core into `compose.ts` (+47) and grew core's *declared* contract
(the two `Material` interfaces, `EntryAudit`, `audit`, `reviewFeedback`); 19c1 added the readiness
probe, the cache-miss eligibility table and the latch (+173, of which 63 lines are comments citing
their sources and rulings); this dispatch removed 150. Against the pre-ticket-19 commit `4c7d94f`
the production delta is +743/−217 — the native runner (`native.ts`, 359 lines) is simply larger than
the request-copy loop it replaced, because it also carries the readiness probe, the cache-miss
eligibility rules and the gate plumbing that 19c added on top.

The simplification that *is* visible in the diff is the one gate 2 asks about: one runner instead of
two, no provider-message construction, no duplicated model/tool loop, no second retry policy, and
132 lines of conversation loop replaced by three. What did not shrink is the total, because tickets
19b and 19c added new obligations (structured material, budget-before-selection, readiness, the
latch) in the same window.

## Documentation

- `hosts/pi/README.md`: a new opening paragraph — one runner, what Pi owns, what was deleted;
  Configuration says Pi's runtime settings are not read here and that `nativeRunner` is gone and now
  rejected as an unknown key; **SDK signatures and request auditing** no longer describes an adapter
  conversation loop; **Branch request and verification contract** is rewritten as **Fork request and
  verification contract (the gate)**; the runner section is retitled *The runner (19a/19b, sole runner
  since 19c)* and its fallback paragraphs updated; **Retries** now describes Pi's own policy and the
  `auto_retry_*` surface; the cancellation paragraph describes `session.abort()`; the live prefix
  procedure updates its reverse-chain script (last request, `stripCacheControl` on both sides, the
  two-item tail, `nativeLog`) and its step 5; two Known limits bullets replaced.
- `core/README.md`: the runner paragraph now says one runner and states what an unconstructible
  worker means for the queue.
- `.scratch/v1/spec.md`: the tool-loop line says the child runs the loop; the 19a/19b line gains the
  19c cutover sentence (deletions, `nativeRunner` no longer a setting, `SettingsManager`, no
  second runtime).
- `hosts/pi/LIVE-VERIFICATION.md`: a 19c note that every record below it was produced by the deleted
  runner, and what a new live run looks like instead.
- `CONTEXT.md`, `core/prompts/*`: **unchanged** (the glossary rename is part 3; no prompt changed).

## Honest limits

- **No live provider run.** Every check stubs HTTP against the real installed pi-ai adapters, as in
  19a/19b/19c1.
- **Inherited-context behaviour is only tested on the native fixture.** The fake host has no
  persisted parent file, so its fork tasks always fall back. That is a real reduction in where fork
  behaviour is observed (the old runner could fork in the fake host from a synthetic capture); the
  fixture tests it against a real parent `AgentSession` instead, which is stronger but slower, so
  there are fewer of them.
- **Responses-family round preservation lost its test.** `openai-responses` /
  `openai-codex-responses` call-id and result preservation was asserted against our own builder; the
  builder is gone and the behaviour is Pi's adapter's. Nothing in this repository asserts it now.
- **A mutated later round has no test.** The old case spied on `appendNativeRequest`; there is no
  supported way to corrupt the child's body from outside, so only the passing round chain is pinned.
- **The scripted-reply seam is a reconstruction.** `conversations` is rebuilt from the outgoing body,
  so an assistant message carries role and content but not the provider fields the old fake echoed,
  and a tool result's `isError` is inferred from the receipt text (the same rule the adapter applies)
  because the provider body does not carry that flag.
- **`drain` is heuristic.** It waits on the footer indicator and on wire activity with a 5-second
  ceiling, and returns ~150 ms after a scripted reply is held open. It is deterministic in practice
  (487 green over repeated runs) but it is a timing heuristic, not a completion signal from the host.
- **The run-record `request` convention changed** from the first body to the last, restoring the
  spec's contract and 17-era test expectations. It is a behaviour change beyond pure deletion, and it
  is declared here rather than buried in the diff.
- **The deleted "captured prefix does not contain selected source entries" check has no
  replacement**, by design: see Design choices. If the acceptor disagrees that a fork's inherited
  ancestry satisfies that rule, this is the place to say so.
- **17b thresholds, 17c claims/cancellation, 18a enrollment/settings layering, 18b catchup, the 19a
  gate and 19b's material/compose boundary are otherwise unchanged.**
- **No conflict with any ruling was found.** The three places where I had to choose a reading are
  declared above: `nativeRunner` rejected rather than warned, the last-request audit convention, and
  the prefix-containment check whose rule is now structural.

## What part 3 still has to do

1. **Rename** `branch` → `fork` in configuration, status, prompts and run metadata, with `branch`
   accepted as an alias, the canonical form winning and the conflict reported: `noting.branchModeDefault`,
   the `mode` values in `RunAgentResult`/`RunInput`, `NativeForkTask.mode`, `composeTask(input, "branch")`,
   `hosts/pi/branch.ts`'s own name and the wording in `compose.ts`/`native.ts`/`README.md`.
2. **Legacy labelling** of historical `branch`-mode runs as legacy request-copy execution on the read
   side, without rewriting stored modes, plus its revert probe.
3. **Glossary** (`CONTEXT.md`) and the remaining doc/prompt wording.
4. **The final production line delta against the 19a baseline**, restated after the rename, with the
   net-simplification argument gate 2 asks for (this report gives the numbers as they stand today:
   −150 for this dispatch, +206 cumulative since `d4a2df5`).
