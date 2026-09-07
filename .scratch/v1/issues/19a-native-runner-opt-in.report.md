# Ticket 19a acceptance report

**Ready for acceptor review — with one decision required (see GATE RESULT).** Baseline: `4c7d94f`, **Ticket 18b: manual catchup and stop over 17c's slots, claims and cancellation**, read with `git log -1 --oneline` before implementation. The initial working tree was clean; HEAD remains unchanged and every implementation change is unstaged and uncommitted. No pre-existing file under `.scratch/v1/issues/` was touched; only this report is new there.

---

## GATE RESULT

**PASSED on `openai-completions`. FAILED, structurally and unavoidably, on `anthropic-messages`.**

Both results come from the same implementation, the production `core/prompts/noting.md` / `core/prompts/consolidation.md`, the production tool definitions, a real parent Pi `AgentSession` on a real session file, a real native child fork, and the real installed pi-ai adapters with only HTTP stubbed.

| API | `verifyNativeRequest` | `differingPath` | captured hash | child request hash |
|---|---|---|---|---|
| `openai-completions` | **passed** | `null` | `17c1d558a4e0eb136d6827817509aa22ad924741d70e9f77b02fc2a1d108efff` | `c0b7995def8f7d3886b45f650b04c9022b09928cc03da1c2a9f0fb594dbed8ec` |
| `anthropic-messages` | **failed** | `$.messages.0.content.0.cache_control` | `9f66965c535f69ddc272188f938e58204b367fb659837abaf833647301b19429` | `1839bdb941f245e7b753d4550256415d991f72d0510c978a6e15992c70aa649d` |

(The hashes cover the two complete bodies, whose system prompt embeds the run's temporary cwd, so they differ between runs. The tests assert `hash(capturedBody)`/`hash(childBody)` computed from the same two bodies, never these literals.)

### What passes, and why it is not a synthetic result

On `openai-completions` the child's first outgoing body is byte-identical to the captured parent body once the child's own appended messages are removed — system message, the whole tool list in the parent's order, `model`, `stream`, `stream_options`, `store`, `max_completion_tokens`, and every earlier message. `verifyNativeRequest` was applied unchanged and nothing was excluded from the comparison. The appended tail is exactly two items: the head assistant reply the child inherited from the persisted leaf, and the task user message carrying the production Noter prompt. Test: **19a 2026-09-08: the native child's first request passes prefix verification against the captured parent request**, which additionally recomputes the gate in the test body over the two real bodies.

Two adapter facts made it reachable, both handled through Pi's own options rather than by editing a body:

- Pi's `buildSystemPrompt` appends `\nCurrent working directory: <cwd>\n` to **any** custom prompt, so `DefaultResourceLoader`'s `systemPrompt` option can never yield the parent's exact bytes. The child instead gets them from one adapter-supplied inline extension returning `systemPrompt` from `before_agent_start` — the same hook Pi itself uses to let an extension replace the system prompt for a turn, and the same hook Trace Memory already uses in the foreground.
- Tool definitions are the parent's, synthesized from the captured body and registered as `customTools` with `noTools: "all"` and an explicit ordered allowlist, so the serialized `tools` array matches item for item.

### Why `anthropic-messages` cannot pass

`pi-ai`'s Anthropic adapter puts the ephemeral cache breakpoint on **the last user message of the body it is currently building** (`dist/api/anthropic-messages.js`, "Add cache_control to the last user message to cache conversation history"). In the captured parent body that was the message the child now inherits. In the child's body the last user message is the appended task, so the inherited message loses the `cache_control` field the captured body carries. The mismatch is therefore in the compared prefix, at the first differing path above, and it is deterministic: it happens on every Anthropic fork, on the first request, for any task text.

No public option removes it: `cacheRetention: "none"` deletes every marker (including the system block's, which the parent has), so the body differs from the parent in the other direction. Reproducing the parent's marker placement requires writing the message array by hand — the custom message builder ticket 19 exists to delete.

Per the ticket's instruction I stopped there rather than adapting the check:

- `verifyRequest`/`verifyNativeRequest` are **unchanged**; no field is stripped or excluded from the comparison; the gate is not marked passed.
- The mismatch is a **fallback, not a failure**: the check runs inside `onPayload`, so the child's request never leaves the process, nothing is billed, and the task continues on the untouched request-copy runner. The run record keeps `fallbackReason: "native runner: native prefix mismatch at $.messages.0.content.0.cache_control"` and the rejected result (both hashes and the path) under `verification.native`, alongside the request-copy runner's own passing verification. Test: **19a 2026-09-08: the anthropic-messages child cannot reproduce the parent's cache breakpoint**.
- 19a therefore ships behind the opt-in switch with the old runner as default and as fallback. **The decision is yours:** accept the native path for the OpenAI-family APIs only; accept a documented normalization of adapter-placed cache markers before comparison (a real weakening of the byte gate, and the reason I did not do it); or hold 19b/19c until the Anthropic case has an answer.

---

## Verification

Every command was run in the foreground on Node 24.6.0 with an explicit timeout; no background waits, no credentials, no live provider.

| Check | Before | After |
|---|---:|---:|
| `npm test` | 465 passed, 21 files | 478 passed, 22 files |
| `npm run typecheck` | Passed | Passed after all probe restorations |
| `npm run smoke:pi` | Passed | Passed: one Noting run and one fact |
| `git diff --check` | Clean | Clean |
| Revert probes | Not applicable | Four applied, each red on a named test, each restored byte-for-byte |
| HEAD / staged / commits | `4c7d94f` / none / none | `4c7d94f` / none / none |

Thirteen new cases, all in the new `hosts/pi/native.test.ts`, all titled **19a 2026-09-08:**. Every pre-existing case is retained and green; the switch defaults to off, so no existing behaviour changed.

## Checkbox-to-test mapping

| Checkbox | Implementation | Named test |
|---|---|---|
| 1. Production prompts and tools pass `verifyRequest`; the run record stores both hashes and the result | `native.ts` `runNative` wraps `agent.onPayload`, compares the first body against `session.capture.payload` with `verifyNativeRequest`, and returns it as `verification`; core writes it into `runs.response.verification` | **the native child's first request passes prefix verification against the captured parent request** (openai-completions, passing) and **the anthropic-messages child cannot reproduce the parent's cache breakpoint** (recorded failure, hashes and path) |
| 2. Parent file, id and tree position byte-identical; child has its own id and JSONL under the runs directory; `/resume` does not show it | `SessionManager.open(parentFile, runsDir)` + `createBranchedSession`; the foreground manager is never passed to `native.ts`; `runsDirectory()` = `dirname(dbPath)/runs/<parent Pi session id>` | **a child run leaves the parent file, id and tree position byte-identical and logs under the runs directory** (compares `readFileSync` bytes, `getSessionId`, `getSessionFile`, `getLeafId` across a second child run; asserts two distinct child logs under the runs directory and `SessionManager.list(cwd, sessionsDir)` returning only the parent id) and **the child copies the selected ancestry only, not a sibling branch** |
| 3. Real Noting write and two-submission Consolidation through native tool execution; out-of-range sources rejected despite copied history; trailing provider error after a commit keeps the commit and records the problem | Whitelisted `execute` calls core's bound tool and returns its receipt; the Consolidation review answer is delivered with `sendUserMessage(..., { deliverAs: "steer" })`; outcome comes from the terminal assistant message | **a Noting write commits through native tool execution**; **Consolidation's two submissions and its review round run natively** (asserts two `memory` calls and that the NEAR feedback reached the child as a user message before the second); **a source entry outside the frozen range is rejected although the child copied it**; **a provider error after the commit keeps the commit and records the problem** |
| 4. Copied plugin custom state activates no extension and starts no worker; whitelist and sequential execution visible in call order | `DefaultResourceLoader` with `noExtensions/noSkills/noPromptTemplates/noThemes/noContextFiles`; non-memory tools throw a rejection before any execution; `agent.toolExecution = "sequential"` plus per-tool `executionMode` | **copied plugin custom state activates no extension and starts no worker** (the child JSONL really contains the foreground's `"customType":"trace-memory"` entries, and one run, one child log, the parent's tool list) and **only the memory tools execute; other copied tools are rejected in call order** (a batch of `read` + `trace`: `read` never runs, results come back in call order) |
| 5. Usage counts new assistant messages including failed attempts; copied usage excluded; cancelled without usage is unknown | `message_end` subscription sums only messages this run produced; `auto_retry_start` → `retries`; `usage` starts `undefined` | **usage counts the child's new responses only, including a failed attempt** (parent usage 777/555 is absent from the total 50/7) and **a cancelled child without reported usage records unknown, not zero** |
| 6. Cache reads recorded as observations; no test asserts a hit | `verification.cache_read` copied from the summed `usage.cacheRead` when numeric, exactly as the request-copy runner does | **each child response's reported cache read is recorded as an observation** — it asserts the recording and that the outcome does not depend on it; no test requires a nonzero cache read anywhere |

## Design choices

**Reused from Pi, not invented** (per the standing ruling to copy Pi's own shape first):

- `SessionManager.open(file, sessionDir)` + `createBranchedSession(leafId)` is Pi's own "extract one conversation path into a new session file" operation, and it writes into the manager's session directory — which is why the independent manager is opened *with the runs directory*. `SessionManager.forkFrom` (whole-file copy) is explicitly not used, per the parent's "Independent manager" bullet.
- `createAgentSession` with `sessionManager`, `resourceLoader`, `settingsManager`, `noTools`, `tools`, `customTools` — all public options. The child's `ModelRuntime` and retry/provider policy come from `SettingsManager` and Pi's own runtime, so the child needs none of the handwritten retry reader, which stays untouched in `index.ts` for the old runner (ruling 19:6).
- The system prompt is supplied through `before_agent_start`'s `systemPrompt` result, which is Pi's documented per-turn system-prompt override, delivered by one inline extension supplied explicitly by the adapter (the parent's "unless a resource is explicitly supplied by the adapter" carve-out). The alternative resource-loader option is unusable for byte equality, as shown above.
- Steering (`sendUserMessage(..., { deliverAs: "steer" })`) is Pi's own way to put a message in front of the next model call while a run is in flight; the two-submission protocol in `core/consolidation/memory.ts` is unchanged.
- Verification of later rounds against the previous round reuses the request-copy runner's existing `verifyNativeRequest` shape one-for-one.

**Mine, and why:**

- **`verifyNativeRequest` rather than `verifyRequest` for the gate.** `verifyRequest` is `verifyNativeRequest` plus one assumption — that the appended messages have the string-content shape the old builder emits (`{role:"user", content:"…"}`). A native child serializes its user message as `{role:"user", content:[{type:"text",…}]}`, and the fork's tail also contains the inherited head assistant reply. `verifyNativeRequest` is the repo's own verifier for adapter-serialized appends (added for the continuation rounds), and the gate it performs is identical: the whole captured body against the child's body with the tail removed. The tail is not taken on trust — the tests assert its length and that its last item is the task message.
- **A rejected gate is a fallback, not a run failure.** The check runs inside `onPayload`, before the request is sent, so no work and no money is lost; the task continues on the old runner and the record carries both the native reason and the native hashes (`verification.native`). Without this, turning the switch on with an Anthropic model would fail every memory task instead of degrading to today's behaviour.
- **Tool definitions vs. tool execution split.** The gate section of the parent wins over its "omit unrelated execution tools" bullet, so the child registers the parent's whole tool list and refuses to *run* anything but the four memory tools. A non-whitelisted call throws inside `execute`, so Pi records an error tool result in the child's history and the model sees it — the copied history cannot turn a worker into a file editor.
- **Checkpoint = the parent's persisted leaf**, with two readiness refusals: an entry that is not in the reopened file, and an ancestry containing an assistant tool-call group with missing results (`forkable`). Both fall back with a recorded reason; 19c makes readiness first-class.
- **`nativeLog` is the narrowest run-record addition.** It is one optional field on `RunAgentResult` written into the existing response JSON — no store schema change, no new column, no new table.
- **`agent.sessionId` is set to the parent's Pi session id** (the adapter decision the parent ruling requires) while the child's `SessionManager` id, file and Trace Memory target attribution are untouched.

## Revert probes

Each probe: apply the mutation, confirm the diff, run the **full** suite in the foreground, record the red titles and counts, restore the original bytes, reverify with `shasum -a 256`, then confirm the suite is green again.

| Probe | Mutation | Named red test(s) | Failed / total | Restored SHA-256 |
|---|---|---|---|---|
| 1. Use the foreground `SessionManager` | `hosts/pi/index.ts` passes `foreground: callContext.sessionManager` into `runNative`; `hosts/pi/native.ts` uses it instead of `SessionManager.open(task.parentFile, task.runsDir)` | all thirteen `19a 2026-09-08:` cases, led by **a child run leaves the parent file, id and tree position byte-identical and logs under the runs directory** (the foreground manager's id and file are replaced by `createBranchedSession`, so every later host interaction reads the child's file) | 13 / 478 | `native.ts` `000b9a59efb41184019783ade0a82345b17f0aa3bbd4665437cff14c5f5a6beb`, `index.ts` `75f4a70d03f6ea94feba685b1076cdf7b66213628cede57700ee90b2dd467762` |
| 2. Copy the whole tree | `SessionManager.forkFrom(parentFile, cwd, runsDir)` + `getSessionFile()` instead of `open` + `createBranchedSession` | **the child copies the selected ancestry only, not a sibling branch** | 1 / 478 | `native.ts` `000b9a59efb41184019783ade0a82345b17f0aa3bbd4665437cff14c5f5a6beb` |
| 3. Sum copied usage | `usage = session.getSessionStats().tokens` instead of summing this run's `message_end` assistant usage | **usage counts the child's new responses only, including a failed attempt** (the copied parent's 777 input tokens reappear) | 1 / 478 | `native.ts` `000b9a59efb41184019783ade0a82345b17f0aa3bbd4665437cff14c5f5a6beb` |
| 4. Treat a resolved `prompt()` as success | `const outcome = "success"` regardless of the terminal response | **a provider error after the commit keeps the commit and records the problem** and **a cancelled child without reported usage records unknown, not zero** | 2 / 478 | `native.ts` `000b9a59efb41184019783ade0a82345b17f0aa3bbd4665437cff14c5f5a6beb` |

Probe 1's blast radius is wider than the other three because every native case shares the fixture whose parent manager the mutation corrupts; the parent-preservation test is the one that names the violated ruling.

## Production line delta

| File | + | − |
|---|---:|---:|
| `hosts/pi/native.ts` (new) | 241 | 0 |
| `hosts/pi/index.ts` | 54 | 6 |
| `hosts/pi/branch.ts` | 28 | 0 |
| `core/api/index.ts` | 2 | 0 |
| `core/noting/index.ts` | 1 | 0 |
| `core/consolidation/index.ts` | 1 | 0 |
| **Production total** | **327** | **6** |
| `hosts/pi/native.test.ts` (new, tests) | 334 | 0 |
| `hosts/pi/test-host.ts` (tests) | 17 | 3 |
| Docs (`hosts/pi/README.md`, `core/README.md`, `.scratch/v1/spec.md`) | 90 | 2 |

19a is additive by construction: nothing is deleted, the old runner is untouched in behaviour, and the net simplification the parent asks for is 19c's to show once the old runner goes.

## Documentation

- `hosts/pi/README.md`: `nativeRunner` and `runsDir` in Configuration; a new **Native runner (19a, opt-in)** section covering the child's construction, the tool definition/execution split, the identity decision, the gate result for both APIs including the Anthropic diagnosis, usage and outcome rules, and the carried limits; one new Known limits bullet.
- `core/README.md`: the `runAgent` result line now lists the optional fields that ride into the run record, including `nativeLog`, and the mode paragraph states that the runner behind a mode is the host's choice.
- `.scratch/v1/spec.md`: Run record contract gains the `nativeLog` field and the 19a second implementation of the same contract.
- `CONTEXT.md`: **unchanged.** The glossary does not name execution modes or runners (the `branch`/`subagent` mode names are not glossary terms), and 19a introduces no new domain term — "native worker log" is implementation detail, which that file excludes by its own rule. 19c's `branch` → `fork` rename is the change that will touch it.

## Honest limits

- **No live provider run.** Every check uses stubbed HTTP against the real installed adapters. Nothing here claims a real cache hit; the cache-read observation test only asserts that a reported number is recorded.
- **The gate fails on `anthropic-messages`** and that is not fixable inside 19a. See the first section.
- **The native path still needs the parent request capture**, because that capture is what the gate compares against. The parent's "no capture dependency" launch property therefore does not arrive in 19a; it belongs with 19b/19c, which is also where the checkpoint readiness rules become first-class instead of a fallback.
- **`runsDir` is never pruned**, per the parent's documented v1 retention limit, and a gate rejection that happens after `createBranchedSession` leaves that unused child JSONL behind.
- **Subagent mode and borrowed (closed-session) work never take the native path** in 19a, as instructed; 17c's admission, claims, token fence, `cancelTasks`/`forceTasks`, the five-second shutdown cleanup and 18b's catchup controller are untouched — the native runner is only an alternative implementation of the host's `runAgent` callback.
- **The child is disposed, the parent is not.** Cancellation wires the task's `AbortSignal` into `session.abort()` and disposes only the child runtime and its subscriptions.
- **The test's parent is a real Pi `AgentSession`, not a running foreground Pi.** That is the strongest deterministic parent available without credentials: its system prompt is Pi's own default prompt (not a synthetic string), its tool list contains a foreground-style tool plus the four production memory tools, and the child reproduces those bytes without being told them by the test.
