# Ticket 19b acceptance report

**Ready for acceptor review.** Baseline: `c614453`, *Ticket 19 gate 1 amendment: the fork gate strips
cache_control from both sides and nothing else*, read with `git log -1 --oneline` before
implementation. The initial working tree was clean; HEAD is unchanged, nothing is staged and nothing
is committed. No pre-existing file under `.scratch/v1/issues/` was touched; only this report is new
there. **No prompt file was changed** (see Documentation).

---

## Verification

Every command ran in the foreground on Node 24.6.0 with an explicit timeout; no background waits, no
credentials, no live provider.

| Check | Before | After |
|---|---:|---:|
| `npm test` | 479 passed, 22 files | 492 passed, 24 files |
| `npm run typecheck` | Passed | Passed after both probe restorations |
| `npm run smoke:pi` | Passed | Passed: one Noting run and one fact |
| `git diff --check` | Clean | Clean |
| Revert probes | Not applicable | Two applied, each red on a named test, each restored byte-for-byte |
| HEAD / staged / commits | `c614453` / none / none | `c614453` / none / none |

Thirteen new cases, all titled **19b 2026-09-08:**; six in the new `core/api/boundary.test.ts`, three
in the new `hosts/pi/compose.test.ts`, four appended to `hosts/pi/native.test.ts`. Every pre-existing
case is retained and green. Four pre-existing ruling tests were rewritten in place, because their
subject moved: they asserted the bytes of a core-composed string, and core no longer composes one.
Their byte-level content is preserved in `hosts/pi/compose.test.ts` against the adapter's composition
module; the core copies now assert the frozen material parts. They are listed under Design choices.

## Checkbox and scenario mapping

| Ticket checkbox | Implementation | Named test |
|---|---|---|
| 1. No core module builds a message sequence or a provider body; a host stub that accepts the structured material and reports unavailable request audit passes the same core validation and commit contract | `NotingMaterial` / `ConsolidationMaterial` replace `prompt`+`input`+`subagentInput`; `RunAgentResult.audit` | **a host stub that receives structured material and declares its request audit unavailable still commits**, **the same stub still fails core validation, and a host expected to capture a request still reports the audit problem**, **a Consolidation stub with unavailable audit runs the two submissions and commits** (all `core/api/boundary.test.ts`; the shared `assertNoComposedMessage` refuses any `input`/`subagentInput`/`messages`/`system`/`conversation`/`body` field and any material part that begins a composed section) |
| 2. Native subagent runs use the native runner with a fresh manager; no legacy custom tool loop runs in either mode; the fallback reason and actual mode are recorded when fork is unavailable | `native.ts` `NativeTask` is a union; `mode: "subagent"` builds `SessionManager.create(cwd, runsDir)`; `index.ts` routes every subagent task there while `nativeRunner` is on | **an explicit subagent task runs in a fresh native child with only the memory tools and no legacy loop** and **an unforkable branch task falls back to the native subagent and records requested and actual mode** (`hosts/pi/native.test.ts`; both assert `h.conversations` is empty, which is the request-copy runner's only route to a model) |
| 3. A budget below the 50k ceiling freezes a smaller oldest-first batch before the only model call, with matching request material, audit range and write eligibility; an oldest entry that cannot fit stays pending with a capacity problem | `freezeNoting` prices the frozen material part by part against the host-supplied `capacity` | **gate 4: the supplied budget shrinks the batch before the only model call, and the excluded tail stays pending and unwritable** and **gate 4: an oldest entry that does not fit the supplied budget leaves the queue pending with a capacity problem and no progress** |
| 4. The Consolidation review round uses native messages or steering and preserves the two valid submissions | core's `reviewFeedback(toolResult)` hook; `sendUserMessage(…, {deliverAs: "steer"})` in both native modes | **Consolidation's two submissions and its review round run in the fresh child** (19b) plus the retained 19a fork case **Consolidation's two submissions and its review round run natively**, and **a Consolidation stub with unavailable audit runs the two submissions and commits** for the core protocol |
| 5. Revert probes | — | See Probes below |

| Parent testing scenario | Named test |
|---|---|
| 5. Core protocol (real writes, out-of-range rejection, atomic progress) | Retained 19a cases plus **gate 4: the supplied budget shrinks the batch…**, which rejects a citation of an excluded entry inside the same run and then commits the eligible one |
| 7. Fresh-context path (explicit subagent, closed-session, precommit fallback, no legacy tool loop) | **an explicit subagent task runs in a fresh native child with only the memory tools and no legacy loop**, **an unforkable branch task falls back to the native subagent and records requested and actual mode** (closed-session/borrowed work reaches the same single `runAgent` subagent branch; see Honest limits) |
| 13. Task-context ownership (host stub, no core-prescribed messages, unavailable audit) | the three `core/api/boundary.test.ts` stub cases above |
| 17. Budget negotiation | the two gate-4 cases above |

Ruling coverage, per the standing rule that every ruling an implementation could silently deviate
from gets a named test: ruling 2026-09-06 08:53 is now pinned twice — on the material in
**19b 2026-09-08 for ruling 08:53: core freezes one material; the parts an inherited run needs are the
head reply and the source index** (`core/api/rulings.test.ts`) and on the bytes in the three
`hosts/pi/compose.test.ts` cases.

## Design choices

**Reused, not invented** (per the standing ruling to copy Pi's own shape first, and 19a's):

- `SessionManager.create(cwd, sessionDir)` is Pi's own new-session constructor and the exact
  counterpart of 19a's `SessionManager.open(...)` + `createBranchedSession(...)`: same manager class,
  same runs directory, same `getSessionFile()` as the run's `nativeLog`. Nothing about the child's
  construction is new — the resource loader, the inline `before_agent_start` system-prompt extension,
  `noTools: "all"` plus an explicit allowlist, `agent.toolExecution = "sequential"`, the `message_end`
  usage subscription, the `auto_retry_start` retries, the abort wiring and the disposal are 19a's,
  shared by both modes because `runNative` is one function with a two-armed prepare step.
- Steering for the review round is 19a's, unchanged.
- The composed bytes are the previous core strings, byte for byte: `hosts/pi/compose.ts` reproduces
  the old `subagentInput` / branch-`input` / `branchInput` layouts exactly (same headers, same `\n\n`
  section separator, same `finish` receipts), which is why every pre-existing host test that inspects
  a sent conversation still passes untouched.

**Mine, and why:**

- **One material for both modes, selected by the adapter.** Core freezes every part once
  (`entries`, `head`, `sources`, `knowledge`, `facts`, `receipts`; `factAddresses`, `rangeFacts`,
  `knowledge`, `consolidated`, `reminders`, `receipts`) and does not decide which a mode uses. That
  is what makes 08:53 an adapter ruling now, and it removes the old asymmetry where core shipped a
  second full string (`subagentInput`) purely so a host could fall back.
- **`range` is not duplicated into `material`.** It is already a top-level field of the agent input;
  the composer reads it there.
- **`audit: {available: false, reason}` as the narrowest extension.** `available` is the literal
  `false`, so a host cannot declare success and skip capture: the only declarable state is the
  limitation. Core treats it as a substitute for `request` in the two problem branches and records it
  in the response JSON; nothing else changed.
- **`requestedMode` in the response JSON.** The run's `mode` column stays the actual mode (19a), so
  the requested one had nowhere to live. It is recorded for every run, not only on fallback, so
  "requested equals actual" is an observation rather than an absence.
- **`reviewFeedback(toolResult)` on the Consolidation input.** The two-submission protocol and the
  receipt shape are core's; before this the Pi host parsed core's receipt JSON itself in
  `reviewMessage`. The hook deletes that duplicate and leaves the adapter with the one decision that
  is really its own — which mechanism puts the message in front of the model.
- **With `nativeRunner` on, the request-copy runner is not a fallback for a rejected fork.** 19a fell
  back to it; checkbox 2 requires that no legacy custom tool loop runs in either mode, and the parent's
  "Subagent parity" bullet says the point is to stop keeping a second runtime for fallback. It is now
  reached only when the native child itself cannot be constructed, which is a defect, not a routing
  choice. With the switch off nothing changed at all.
- **Core still prices the material it froze.** Gate 4 puts the budget call before selection, which is
  where it already was (`capacity {inputTokens, prefixTokens}`, supplied in the same `noting(...)`
  call). What changed is that the estimate sums the frozen parts instead of a composed string, so it
  no longer counts headers the adapter owns. The difference is about 25 tokens on a budget of tens of
  thousands and no existing capacity test moved.
- **Four ruling tests rewritten rather than deleted.** `core/api/rulings.test.ts` "08:53 … branch uses
  conversation context", "branch input premise repair", "branch source previews" and
  `core/api/consolidation.test.ts` "a branch Consolidation appends the exact fact list" asserted bytes
  core no longer produces. Each now asserts the frozen parts (`material.head`, `material.sources`,
  `material.factAddresses`, and that one material serves both modes), and the byte assertions moved
  verbatim into `hosts/pi/compose.test.ts`. No ruling lost a test; two gained one.
- **`materialText` in `test/source-fixture.ts`.** A test-only flattening of the fresh-context parts,
  so the many "the input contains X / does not contain Y" assertions stayed one-line and honest. It is
  not used by any production path.

## Revert probes

Each probe: apply the mutation, confirm the diff, run the **full** suite in the foreground, record the
red titles and counts, restore the original bytes, reverify with `shasum -a 256`, then confirm the
suite is green again.

| Probe | Mutation | Named red test | Failed / total | Restored SHA-256 |
|---|---|---|---:|---|
| 1. Restore a core-built message string | `core/noting/index.ts` rebuilds the inherited-context message (`Range: …`, head reply, `Sources:`) inside `notingMaterial` and adds it back to `NotingAgentInput` as `input`; `hosts/pi/index.ts` sends `${input.prompt}\n\n${input.input}` for a Noting fork instead of `composeTask(input, "branch")` | **19b 2026-09-08: a host stub that receives structured material and declares its request audit unavailable still commits** (its `assertNoComposedMessage` sees the `input` field) | 1 / 492 | `core/noting/index.ts` `69e6ac257f163e9e0e3a60ab854bafda7a08cf50f1a7a3cf63d8e9e7d9f21d46`, `hosts/pi/index.ts` `a00ddde68ec3dfa9cd8e2ab6db1a06e77e2a2cf56e476afa422db1f3c87ef63d` |
| 2. Activate inherited extensions in the subagent manager | `hosts/pi/native.ts` `DefaultResourceLoader` `noExtensions: true` → `false` | **19b 2026-09-08: the fresh child activates no inherited extension** (the probe extension in the temporary agent directory is discovered, loads, and writes its marker file) | 1 / 492 | `hosts/pi/native.ts` `a93502bcd9e9779b93ce112e757773cfed46040488da919d531cf44b004e2965` |

Both blast radii are narrow because each probe violates one ruling that one test owns. Probe 1's
mutation is deliberately the *smallest* real regression — core composing one message that the adapter
consumes — rather than a wholesale revert; a wholesale revert reddens the same test plus the three
`compose.test.ts` cases.

## Production line delta

| File | + | − |
|---|---:|---:|
| `core/noting/index.ts` | 62 | 23 |
| `core/consolidation/index.ts` | 51 | 19 |
| `core/api/index.ts` | 7 | 3 |
| **Core total** | **120** | **45** |
| `hosts/pi/compose.ts` (new) | 47 | 0 |
| `hosts/pi/index.ts` | 45 | 16 |
| `hosts/pi/native.ts` | 72 | 43 |
| **Adapter total** | **164** | **59** |
| `core/api/boundary.test.ts` (new, tests) | 189 | 0 |
| `hosts/pi/compose.test.ts` (new, tests) | 72 | 0 |
| `hosts/pi/native.test.ts` (tests) | 96 | 7 |
| Other tests (`core/api/{noting,consolidation,rulings}.test.ts`, `hosts/pi/entries.test.ts`, `test/source-fixture.ts`) | 91 | 82 |
| Docs (`core/README.md`, `hosts/pi/README.md`, `.scratch/v1/spec.md`) | 101 | 30 |

**The core delta is +75 net, and it is honest to say core grew.** What left core is context
assembly: the `subagentInput` builder, the branch-`input` builder, the Consolidation
`subagentInput`/`branchInput`/`initial` builders and the `finish` import — about fifteen executable
lines, all of which reappear (with the same bytes) in the adapter's 47-line `compose.ts`. What
arrived in core is declaration, not behaviour: about 56 of the 120 added lines are the two `Material`
interfaces, `EntryAudit`, the `audit` field and their doc comments, and the rest is the material
builder writing the same parts into an object instead of into a string, plus the audit/`requestedMode`
recording and the six-line `reviewFeedback` reader. Core's executable surface is roughly flat; its
declared contract is larger by design, because the boundary is now stated in types instead of implied
by a string. The net simplification the parent asks for is 19c's to show, when the request-copy runner
and its verification plumbing go.

## Documentation

- **`core/prompts/noting.md`, `core/prompts/consolidation.md`: unchanged, zero edits.** Both contain
  one bullet that begins "When this message carries …", which reads as layout but is a domain rule: it
  tells the model how to interpret a context it did not receive in full ("the rest of the range raw …
  are already in this conversation", "Integrate exactly the listed facts, not every address between
  the range ends"). Removing them would delete instruction, not layout. They also stay accurate: the
  adapter composes exactly the shapes those sentences describe, and `compose.test.ts` pins that.
- `core/README.md`: the module list now says *freeze the material*; the `runAgent` line gains the
  optional `audit` field; two new paragraphs state the 19b boundary (structured material, no message
  or provider body, `reviewFeedback`) and audit availability with `requestedMode`; the mode paragraph
  now describes both native modes; the branch/subagent rendering paragraph says core freezes one
  material for both; a new paragraph states gate 4 (budget before selection, one freeze, unselected
  entries pending, inherited context is not evidence permission).
- `hosts/pi/README.md`: a new **Message composition (19b)** section (the two modes' layouts, the
  single composition module, `reviewFeedback`); the fallback paragraph now records requested versus
  actual mode; the native section is retitled 19a/19b, states that both modes run natively, and gains
  a **The fresh child (19b subagent parity)** subsection listing the four differences from the fork.
- `.scratch/v1/spec.md`: the `core/noting`, `core/consolidation` and `hosts/pi` module lines; the
  `runAgent` contract line in **Contracts**; the `runAgent` and 19a lines in **Run record contract**.
- `CONTEXT.md`: **unchanged.** No glossary term changed — the glossary names targets, claims and
  catchup, not execution modes, runners or the run-agent payload, and "task material" is
  implementation vocabulary that file excludes by its own rule. 19c's `branch` → `fork` rename is the
  change that will touch it.

## Honest limits

- **No live provider run.** Every check stubs HTTP against the real installed pi-ai adapters, as 19a
  did and as instructed.
- **Borrowed closed-session work is covered by construction, not by its own native test.** 17c forces
  `mode: "subagent"` for borrowed targets and 18b's catchup passes `mode: "subagent"` explicitly; both
  reach the same single `runAgent` subagent branch that the two new native tests exercise. I added no
  native test for them because the fixture would have to build a second closed Pi session, and the
  routing has no branch of its own to get wrong. If the acceptor wants it observed rather than
  argued, that is a small addition to `hosts/pi/catchup.test.ts`.
- **The fresh child's system prompt still goes through the inline extension**, not
  `DefaultResourceLoader`'s `systemPrompt` option, which would append Pi's
  `Current working directory:` line. That is a deliberate reuse of 19a's mechanism (one code path for
  both modes), not a byte-equality requirement — a fresh child has no parent bytes to match.
- **Core still prices material to enforce the budget**, which is arithmetic over its own frozen parts,
  not context assembly; but it does mean core's estimate excludes the adapter's headers and
  separators. The adapter's own `checkCapacity` on the outgoing body remains the check that a real
  request fits, exactly as before.
- **`entryAudit` is supplied to the host and the Pi adapter does not consume it.** It is on the input
  because the ticket lists it and because a host that surfaces view omissions has no other route to
  them; it is asserted in the core stub test so it cannot silently rot.
- **19c items untouched**, as instructed: the request-copy runner still exists (and still serves both
  modes with the switch off), nothing was renamed `fork`, no cache-miss latch and no first-class
  readiness were added. 17b thresholds, 17c claims/cancellation, 18a enrollment and 18b catchup are
  unchanged.
- **No conflict with any ruling was found.** The one place where a bullet had to yield to another is
  recorded above under Design choices: the parent's "Fallback" bullet ("apply the adapter's explicit
  subagent fallback") and checkbox 2 ("no legacy custom tool loop runs in either mode") together
  decide that a rejected fork now goes to the native subagent instead of 19a's request-copy runner.
