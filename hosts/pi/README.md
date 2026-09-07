# Pi host (tickets 05–07)

`index.ts` is a Pi extension: its default export takes `ExtensionAPI`. It opens
one facade for the global database and uses only `core/api/index.ts`, including
its exposed store. Notes use verified branch mode by default; settle uses
subagent mode. Threshold-triggered runs start at turn stop (`agent_settled`); tree navigation
also finishes the abandoned branch note.

Run the extension with Pi 0.85.0 on Node 24.6.0. The core uses Node's built-in
`node:sqlite` (`DatabaseSync`), with no native dependency to install. From the
repository root, run `npm install`, `npm test`, `npm run typecheck`, and
`npm run smoke:pi`. The smoke script loads the extension directly under Node
using the host tests' stub ExtensionAPI and commits one note through a fake
provider into a temporary database. See below for launching a real Pi session.

## Configuration

Set `TRACE_MEMORY_CONFIG` to one flat JSON object. Environment configuration was
chosen because this ticket permits settings or environment; the extension does
not discover or modify Pi settings files. Example:

```sh
export TRACE_MEMORY_CONFIG='{"dbPath":"~/.trace-memory/trace.db","note.triggerAnsweredTurns":5,"note.triggerTokens":50000,"settle.triggerUnsettledFacts":50}'
```

- `dbPath` defaults to `~/.trace-memory/trace.db`; its parent is created on load.
- `noteModel` and `settleModel` accept `provider/model-id`, or `session`. Omission
  and `session` both resolve to the current session model's audited provider/id.
- Core settings use dotted names: every `render.*`, `note.*`, and `settle.*` key
  in `DEFAULT_CONFIG` is accepted with the core's default and value type.
- `note.branchModeDefault` defaults to `true`. Set it to `false` for subagent
  notes. Branch notes always use the session model, including on fallback;
  `noteModel` applies only when subagent mode is explicitly configured.
- `settle.subagentModeDefault` defaults to `true`. Set it to `false` for branch
  settlement: the candidate round appends the settle prompt and input to the
  captured prefix, the final round appends the candidate reply (in the
  provider's native assistant shape) and the feedback message to the candidate
  request. Tree navigation explicitly uses subagent mode with `noteModel` for a
  new note.

The peer dependency supplies Pi SDK types. Verification uses the installed
`@earendil-works/pi-coding-agent` 0.85.0. Tests use Vitest on Node; the standalone
smoke uses Node's built-in TypeScript support and does not load Vitest.

## Host decisions and boundaries

- The nearest upward `.trace-memory` file contains the trimmed project name. An
  empty marker is an error. Without one, `pi:<Pi session UUID>` names a private
  project. A project may exist before any assistant reply; a Trace Memory session
  cannot. The first prompt is buffered until that reply permits its turn row to
  be appended. Later prompts append immediately. Marker declarations go through
  `mark(..., source: "marker")`; a persisted in-session mark wins on resume.
- `before_agent_start` injects the entries block once per session (by project
  before allocation, by session afterward; after compaction the compaction block
  already carries the entries) and, on every prompt, the pending note deliveries
  for this branch. It performs no search. The facade controls category order,
  chronological ordering, constraints first, and atomic delivery consumption.
- Assistant streaming updates persist intermediate text. Completed assistant
  messages within one user turn are joined with a newline. Tool results retain
  their input, content and details as JSON, with success/failure status. Tools
  are recorded at `tool_result`; individual model/tool-loop steps do not create
  additional answered turns. Queued user messages start new raw turns.
- Only `agent_settled` checks extraction thresholds. Answered turns have recorded
  assistant content; a tool-call-only assistant message also counts as a reply.
  Slash commands without replies do not count. Token growth is the core's local
  CJK/UTF-16 heuristic over stored prompts, assistant text, tool inputs and
  results since the branch watermark. It is not cumulative provider billing
  usage, which would recount context on every tool iteration. Trigger settings
  apply to this estimate, including raw that exceeds rendering budgets.
- Settlement counts only the current branch's facts beyond its settle watermark.
  A note completion never triggers settlement; new facts wait for the next
  `agent_settled`. Calls are launched without awaiting them in that hook. The
  facade drops duplicates. Quit/reload waits for pending runs before closing
  SQLite; session replacement leaves them running against their frozen ranges.
- Pi custom entries persist session/turn/branch references, using Pi's own
  `appendEntry` facility. Resuming restores the selected lineage. Returning to a
  branch tip reuses its name; selecting an earlier point creates a new branch.
  Pi forks carrying these references stay in the same Trace Memory conversation
  lineage with a new branch name. A fresh Pi session gets a fresh Trace Memory
  session on its first reply. The before-tree hook finishes notes as described below.
- Compaction flushes partial assistant text and returns `memory.compact(...)` as
  `compaction.summary`. `firstKeptEntryId: ""` retains no old Pi messages: the
  facade block replaces the context. Pi 0.85.0's context builder searches for
  that id, finds none, and keeps the compaction plus later messages. Successful
  compaction is then recorded as a `compaction` turn; it receives no facts.
  Pre-reply compaction returns project injection without allocating a session.
- Tools return the facade string in Pi text content. `mark({input: ...})` supplies
  the current session id for project declarations. `/trace` only displays
  `memory.status` (or an empty-session notice); it does not extract or inject.

## SDK signatures and request auditing

Signatures were read from the installed 0.85.0 package, not inferred from the
older vendored implementation:

| API | Declaration under the installed package |
| --- | --- |
| Hooks, tool execution/schema, command, `appendEntry`, context | `dist/core/extensions/types.d.ts` |
| `ctx.modelRegistry.find(provider, id)` and `.complete(model, context, options)` | `dist/core/model-registry.d.ts` |
| Read-only `getSessionId`, `getBranch`, `getEntries` | `dist/core/session-manager.d.ts` |
| `Context`, `AssistantMessage`, `ProviderRequestOptions.onPayload` | `node_modules/@earendil-works/pi-ai/dist/types.d.ts` |

`modelRegistry.complete` supplies Pi's configured provider/model/auth access. A
fresh call has exactly the input prompt as system prompt and one user message
with the input text. A note call also carries one tool, `trace`, through which
the model fetches a cut tool call's full text by its expansion address (spec,
overflow policy); the host executes it through the core's read path and calls
the model again, up to eight rounds, the way pi-om's observer loop executes its
tool. A settle call carries no tools. `options.onPayload` snapshots the
provider-native JSON body without modifying it; the last body sent (which
embeds any earlier tool rounds) is returned as `request`; the facade records it
along with output and usage, including provider failures.
No authorization headers are included in this request-body audit.

For settle's final round in subagent mode, the candidate call returns its SDK
conversation and complete assistant message as `state` on the run result; the
core hands that back inside `continuation.response`, so the host keeps nothing
between rounds. The final call replays that conversation and appends
`continuation.message` exactly once; the SDK serializes the request and
`onPayload` captures that body independently. The model is resolved from the
run's frozen model name, so switching the session model mid-settlement does not
redirect the final round.

The vendored 0.84.4 `types.ts`, extension/SDK/session/compaction docs, and
`custom-compaction.ts`/`handoff.ts` were used for implementation patterns only.
No Pi source was copied. Compaction retention was additionally checked in the
installed `dist/core/session-manager.js` context builder.

## Automated verification

```sh
npm run smoke:pi
npm test -- hosts/pi/index.test.ts
npm test
npm run typecheck
```

The registration test imports the default extension with a stub ExtensionAPI, checks
registration, runs `/trace`, and asserts that it created no session or model
request. The host suite also checks trigger boundaries, request-body capture,
settle continuation, incremental raw, compaction, marker precedence, deliveries
on branch return, frozen in-flight ranges, duplicate note/settle calls, provider
failures, and absence of Pi imports in core.

## Manual verification in a real Pi session

Use an isolated database and a directory with a `.trace-memory` marker so the
observations are easy to inspect. Launch Pi under Node with the extension
explicitly selected:

```sh
export TRACE_MEMORY_CONFIG='{"dbPath":"/private/tmp/trace-memory-manual/trace.db"}'
node /opt/homebrew/lib/node_modules/@earendil-works/pi-coding-agent/dist/bundle/cli.js \
  --extension /Users/zhaoqixuan/Projects/trace-memory/hosts/pi/index.ts
```

1. Run `/trace` before speaking. Expect no Trace Memory session id.
2. Send these six prompts separately, waiting for each assistant reply:
   “For this project use pnpm.”; “Do not use npm.”; “Keep code and comments in
   English.”; “Preserve the language of quoted conversation.”; “Please repeat
   those constraints.”; “What constraints are we following?”
3. Run `/trace` after replies four, five and six. After four, expect no note run.
   After five, expect an asynchronous note attempt, a watermark through turn
   five on success, and possibly pending delivery. After six, expect the pending
   delivery consumed if the note finished before that prompt. If it finished
   later, the next prompt consumes it. Invalid model output may bounce: inspect
   status rather than assuming facts were committed.
4. Run `/compact`. Expect immediate compaction with `<entries>` and `<episodic>`,
   raw since the watermark, recent facts, and no compaction model request.
5. Ask the agent to call `search` for `pnpm`, then `trace` on a returned fact and
   its source turn. Expect the original conversation text and source addresses.
   The search/trace tools themselves are recorded as raw tool calls.
6. Save the actual prompt/reply transcript, `/trace` outputs, observed fact ids,
   compaction content, and trace result. Check `runs.request`, `mode`, `model`
   and `response.usage` using the facade. Default settlement requires 50
   unsettled facts; six short turns need not produce any settle run. For a
   separate settlement exercise set `settle.triggerUnsettledFacts` to 1 and wait
   for another turn stop after the note commits.

Automated verification uses a fake provider; it does not establish live provider
credentials or replace the manual conversation above.


## Branch request and verification contract

Branch mode inherits the latest captured provider request: system instructions,
messages, tools, and all body options (including cache controls, sampling and
reasoning settings). It appends exactly one user message containing the note
prompt, two newlines, and the core's range-only input. Subagent mode has the note
prompt as system instructions, one full rendered input message, and the `trace`
tool. Inherited tools in branch mode are definitions only: this one-call path
does not execute model tool calls.

`before_provider_request` captures a detached JSON snapshot for this extension instance (one per Pi session) in
memory. It is never appended to the Pi session file. Session/tree restoration
invalidates the capture; missing captures and model changes since capture fall
back. Captures are the **last request**, not a reconstruction of the session:
the assistant response to that request is not in its own input. The mandated
single range-only append does not add that response. Live extraction quality
for the final reply therefore needs human evaluation separately from identity.

`branch.ts` supports `anthropic-messages`, `openai-completions`, and
`openai-responses` payloads. Other APIs fall back with an explicit reason.
Anthropic system content blocks and OpenAI system/developer messages retain all
fields byte for byte under deterministic serialization; Responses uses `input`
and `instructions`. No provider-native messages are converted back into Pi
messages. `complete` receives an empty serialization context and `onPayload`
replaces the generated body with the built branch body. The request record is a
snapshot of **that replacement object**, not the discarded callback argument.
The supported installed adapters send this replacement (Anthropic enforces
`stream: true`, already present in its captured streaming request).

Direct completion uses `@earendil-works/pi-ai/compat.complete`, verified in
`dist/compat.d.ts:64` of Pi's nested pi-ai **0.85.0**, and the workspace's pi-ai
**0.85.1**. `dist/types.d.ts:52–104` declares payload replacement and auth options.
Coding-agent **0.85.0** signatures were checked in
`dist/core/extensions/types.d.ts:519` and `dist/core/model-registry.d.ts:30–33`.
The host resolves auth, headers, environment and base URL with
`getApiKeyAndHeaders`, and passes the same Pi session id for cache routing.
All request-body options are copied. The hook does **not** expose Pi's private
transport, retry, timeout settings, or other extensions' header rewrites; direct
completion uses pi-ai defaults for those transport settings. Full transport-option
parity cannot be established through this public hook.

Every branch attempt is compared, stronger than checking only the first per key.
The key is `(model id, provider, SHA-256 of tool definitions)`; `firstForKey` marks
initial verification and any change from the previous successful key. Comparison
sorts JSON object keys recursively, preserves array order and every string
character (including whitespace and Unicode), and compares the complete bodies
allowing only the appended message. It therefore covers each message prefix,
tools, system instructions and other body options. `differingPath` identifies the
first unequal path. Hashes cover the two complete deterministically serialized
UTF-8 bodies, so the captured hash and request hash normally **differ**.

`runs.response.verification` contains `passed`, `capturedHash`, `requestHash`,
`appendedMessage`, `differingPath`, `key`, and `firstForKey`. Reply
`usage.cacheRead` is also copied to `verification.cache_read` when numeric;
it never affects `passed`. Missing usage leaves the observation absent. Pi-ai
normalizes some absent provider counters to zero: zero is not proof of an
explicit provider measurement. Its Anthropic adapter maps
`cache_read_input_tokens`; OpenAI maps `cached_tokens` (verified in nested
`dist/api/anthropic-messages.js:411`, `openai-completions.js:1180`, and
`openai-responses-shared.js:441`). `response.usage` preserves the full SDK usage.

A mismatch prevents the branch provider call. The same note run uses the full
frozen subagent input, records `mode: subagent`, `response.fallbackReason`, and
the failed verification with both hashes. `runs.request` is the actual fallback
request, while the failed branch hash describes the rejected candidate. Missing
or unsupported captures have a reason but no fabricated comparison/hashes.
Notification happens once per Pi session. Provider/auth failures after a passed
comparison remain branch failures; they do not trigger another billable call.

The small core contract correction for this ticket exposes the already-frozen
full note input as `subagentInput`, accepts the actual returned `mode`, and
preserves `verification`/`fallbackReason` in the response envelope. Without it,
fallback would send range-only context and falsely record branch mode. No store
schema or settle behavior changed.

## Live prefix identity procedure

This is a human-run check, not an automated claim of live cache hits.

1. Create `/private/tmp/trace-memory-manual` and place this diagnostic extension
   in `/private/tmp/trace-memory-manual/capture.ts`. It writes only a diagnostic
   body outside the Pi session file:

   ```ts
   import { writeFileSync } from "node:fs";
   export default function (pi) {
     pi.on("before_provider_request", event => {
       writeFileSync("/private/tmp/trace-memory-manual/captured.json", JSON.stringify(event.payload));
     });
   }
   ```

2. Enable branch mode and a one-turn trigger with an isolated database:

   ```sh
   export TRACE_MEMORY_CONFIG='{"dbPath":"/private/tmp/trace-memory-manual/branch.db","note.branchModeDefault":true,"note.triggerAnsweredTurns":1}'
   node /opt/homebrew/lib/node_modules/@earendil-works/pi-coding-agent/dist/bundle/cli.js \
     --extension /private/tmp/trace-memory-manual/capture.ts \
     --extension /Users/zhaoqixuan/Projects/trace-memory/hosts/pi/index.ts
   ```

   Use a session model with one of the three supported APIs. Load both diagnostic
   and Trace Memory hooks **after all payload-rewriting extensions**, in the
   order above. Pi runs hooks in load order; a later rewriter can invalidate the
   capture without this host seeing it. Verify the active extension order in Pi.
   No payload rewriter should follow Trace Memory.

3. Send a substantial prompt with several explicit project constraints. Wait for
   the assistant and the note to finish before another prompt; `/trace` is
   read-only. From a second terminal, in the repository root, run:

   ```sh
   node --input-type=module <<'JS'
   import assert from 'node:assert/strict';
   import { readFileSync } from 'node:fs';
   import { DatabaseSync } from 'node:sqlite';
   import { hash, serialize } from './hosts/pi/branch.ts';
   const db = new DatabaseSync('/private/tmp/trace-memory-manual/branch.db', { readOnly: true });
   const run = db.prepare("SELECT * FROM runs WHERE kind='note' ORDER BY id DESC LIMIT 1").get();
   assert.ok(run, 'Wait for the note to finish');
   const response = JSON.parse(run.response);
   console.log({ mode: run.mode, model: run.model, outcome: run.outcome, ...response });
   assert.equal(run.mode, 'branch');
   const captured = JSON.parse(readFileSync('/private/tmp/trace-memory-manual/captured.json', 'utf8'));
   const sent = JSON.parse(run.request);
   const key = Array.isArray(captured.messages) ? 'messages' : 'input';
   assert.equal(sent[key].length, captured[key].length + 1);
   assert.deepEqual(Buffer.from(serialize(sent[key].slice(0, -1))), Buffer.from(serialize(captured[key])));
   assert.deepEqual({ ...sent, [key]: sent[key].slice(0, -1) }, captured);
   assert.equal(hash(captured), response.verification.capturedHash);
   assert.equal(hash(sent), response.verification.requestHash);
   assert.deepEqual(sent[key].at(-1), response.verification.appendedMessage);
   assert.equal(response.verification.passed, true);
   assert.equal(response.verification.differingPath, null);
   db.close();
   JS
   ```

4. Save the two bodies and printed response. Check `usage.cacheRead` and
   `verification.cache_read` for cached input tokens. A positive count is an
   observation, not identity proof; zero/missing counts do not fail comparison.
   Hashes should each match their respective body, not each other. Inspect the
   appended message: note prompt followed by range-only input, no copied raw.
5. Change the session model, then send another prompt and wait. Repeat the check:
   a supported model's first new run should have `firstForKey: true`. Repeat
   after changing active tool definitions. For an unsupported API expect
   subagent mode, a fallback reason and one notice, rather than invented hashes.
   Compare with a separate database using `note.branchModeDefault: false` to
   evaluate extraction quality and cost before choosing the operational default.


## Attribution and tree navigation (ticket 07)

`session_before_tree` flushes recorded assistant text and awaits the abandoned
session/branch's pending note, if any. It does not retry that run or extend its
frozen range. With no pending note it attempts one subagent note through the
captured head, regardless of normal thresholds. Failure or an unavailable model
leaves the watermark unchanged. No settlement is triggered by this hook.

The only new core capability is the read `branchSummary(sessionId, branch,
headTurnId)`. `compact` is unsuitable because it includes session-wide recent
facts and applies a fact budget. The summary instead uses core `renderFact`,
`renderTurn`, and `finish`: committed lineage facts through the note watermark,
followed by all raw after it, with standard tool cuts and omission receipts.
There is no summary fact budget. This resolves "since its watermark" as raw
coverage: previously committed branch facts remain represented, rather than
being lost when a pending note advances the watermark. Sibling facts are
excluded. Reading a summary never consumes a pending delivery. A pending run's
later, unfrozen raw remains raw in the summary, without a second extraction.
When no facts committed, failed extraction produces rendered raw alone.

The hook returns `{ summary: { summary: text } }`. Installed Pi **0.85.0**
`dist/core/extensions/types.d.ts:481–510` declares `TreePreparation`,
`SessionBeforeTreeEvent`, and `SessionTreeEvent`; lines **861–874** declare the
result and **917–918** register both hooks. `dist/core/agent-session.js:2520`
accepts the supplied summary only when navigation requested summarization
(`options.summarize`). The public result cannot force insertion for a user's
no-summary navigation. The host returns its summary in either case and never
calls Pi's summarizer itself. The hook's abort signal does not cancel a frozen
note. Existing `session_tree` restoration gives an earlier branch point a fresh
identity and preserves the identity when returning to a saved branch tip.

Marker discovery is a plain ancestor walk; the first file wins and an empty
file is an error. Worktrees share a marker only when their directories share
its ancestor; no Git lookup is performed. Marker-attributed sessions are
created with declaration `marker`, so they cannot accidentally merge a shared
named space as if it were private. An explicit `mark` saves the project name
and current project ID in the Pi custom state and returns the updated injection
immediately in its tool result. The database declaration remains authoritative
when restoring older tree state, so a session's mark wins on every branch.
Peers remain in the marker project. Only an undeclared own space is merged.
Facts change project membership through their session join; session entries
retain scope, ownership and revisions while their project ID follows the
session. Duplicate project entries now share the next settlement's NEAR pool;
merge itself neither settles nor deletes duplicates.

An empty text content block is not an assistant reply. Nonempty text, thinking,
or a tool call permits allocation; the tool-call case permits `mark` as the
first assistant action. A prompt, compaction or tree event without such a reply
creates neither a session row nor a turn row. Project records may precede replies.

Ticket 07's stub-host tests cover ancestor/nearest/worktree markers, session-only
mark precedence and persisted host state, retroactive merge and immediate
injection, session-entry isolation, shared duplicate visibility, deferred note
completion with later raw and branch-only delivery, fresh subagent notes,
failure/unavailable models, sibling exclusion, and empty/tool-only replies.
