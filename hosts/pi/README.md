# Pi host (tickets 05–11)

`index.ts` is a Pi extension: its default export takes `ExtensionAPI`. It opens
one facade for the global database and uses only `core/api/index.ts`, including
its exposed store. Notings use verified branch mode by default; consolidation uses
subagent mode. Each reconciled eligible entry completion checks both extraction queues.
Compaction, shutdown and tree navigation launch neither phase.

Run the extension with Pi 0.85.1 on Node 24.6.0. The core uses Node's built-in
`node:sqlite` (`DatabaseSync`), with no native dependency to install. From the
repository root, run `npm install`, `npm test`, `npm run typecheck`, and
`npm run smoke:pi`. The smoke script loads the extension directly under Node
using the host tests' stub ExtensionAPI and commits one noting through a fake
provider into a temporary database. See below for launching a real Pi session.

v1 is unreleased. Databases created before the 17c closure/claim schema are not read;
there is no migration. Start with a new database.

## Configuration

Read configuration from the `trace-memory` namespace in Pi's global `settings.json`
(`PI_CODING_AGENT_DIR` or `~/.pi/agent`) and project `.pi/settings.json`. Project
values override global values; `TRACE_MEMORY_CONFIG` is the final flat JSON override.
The same file reader supplies Pi retry settings. The plugin never writes settings.
For example, either settings file can contain:

```json
{
  "trace-memory": {
    "noting.branchModeDefault": true,
    "consolidation.subagentModeDefault": true,
    "noting.triggerTokens": 10000,
    "noting.batchTokens": 50000
  }
}
```

Environment override example:

```sh
export TRACE_MEMORY_CONFIG='{"dbPath":"~/.trace-memory/trace.db","noting.triggerTokens":10000,"noting.batchTokens":50000,"consolidation.triggerUnconsolidatedFacts":50,"noting.maxToolRounds":0,"consolidation.maxToolRounds":0}'
```

- `dbPath` defaults to `~/.trace-memory/trace.db`; its parent is created on load.
- `notingModel` and `consolidationModel` accept `provider/model-id`, or `session`. Omission
  and `session` both resolve to the current session model's audited provider/id.
- Core settings use dotted names: every `render.*`, `noting.*`, and `consolidation.*` key
  in `DEFAULT_CONFIG` is accepted with the core's default and value type.
- `noting.branchModeDefault` defaults to `true`. Set it to `false` for subagent
  notings. Branch notings always use the session model, including on fallback;
  `notingModel` applies only when subagent mode is explicitly configured.
- `consolidation.subagentModeDefault` defaults to `true`. Set it to `false` for branch
  consolidation: the candidate round appends the consolidation prompt and input to the
  captured prefix, the final round appends the candidate reply (in the
  provider's native assistant shape) and the feedback message to the candidate
  request. Tree navigation launches no extraction.

The peer dependency supplies Pi SDK types. Verification uses the installed
`@earendil-works/pi-coding-agent` 0.85.1. Tests use Vitest on Node; the standalone
smoke uses Node's built-in TypeScript support and does not load Vitest.

## Host decisions and boundaries

- The nearest upward `.trace-memory` file contains the trimmed project name. An
  empty marker is an error. Without one, `pi:<Pi session UUID>` names a private
  project. A project may exist before any assistant reply; a Trace Memory session
  cannot. The first prompt is buffered until that reply permits its turn row to
  be appended. Later prompts append immediately. Marker declarations go through
  `declareProject(..., "marker")`; a persisted `/trace project` declaration wins on resume.
- `before_agent_start` injects the knowledge block once per session (by project
  before allocation, by session afterward; after compaction the compaction block
  already carries the knowledge) and, on every prompt, the pending deliveries for
  this branch: a Noting's facts as `<noted>`, an Consolidation's knowledge
  changes as `<consolidated>`. It performs no search. The facade controls category
  order, chronological ordering, constraints first, and atomic delivery consumption.

  Enabled sessions receive both delivery kinds in every worker-mode combination
  (2026-09-08 supersedes the 2026-09-07 consumer matrix). A branch run still waits
  while a delivery it would read is pending; mode controls execution, not delivery.

  A branch Consolidation appends the range plus the exact list of facts to
  integrate, never the fact lines or the knowledge block again. The list is
  explicit because other paths and already-consolidated facts can fall between the
  range ends. Anything the conversation does not
  hold, a manual note or a fact dropped by a compaction budget, is fetched with
  `trace`.
- Source identity is `(Trace Memory session, native session lineage, Pi entry id)`.
  The host reconciles completed messages from the selected persisted ancestry on
  attach and at safe subsequent boundaries. Pi runs `message_end` extension hooks
  before `SessionManager.appendMessage`, so a completion event alone supplies no
  entry identity. Streaming and thinking-only content, custom/plugin messages,
  compaction summaries and worker messages are not source entries. Repeated text
  is never deduplicated. Earlier native history is imported on attach, known
  identities are reused, and missing native parents or owning user messages are
  reported in the UI. No replacement source is invented.
- Each completed entry owns a Turn. An assistant entry persists its tool-call
  occurrences immediately; a subsequent tool result is a separate source entry
  using the same stable Turn tool ordinal. Original messages, arguments and results
  are retained. `trace` with `full: true` retrieves the original tool argument and
  result strings, including fields outside command/stdout/stderr. Default explicit
  trace previews and pagination retain their existing protocol.
- Every eligible persisted entry completion checks the active branch's queues at
  reconciliation; the unchanged native leaf-id guard keeps streaming updates O(1).
  `noting.triggerTokens` defaults to **10,000 compressed-view tokens** measured
  with `renderEntry` over `pendingEntries`, including separators. Original Raw size,
  entry count and answered Turns do not trigger runs. Excluded sources contribute nothing.
- `noting.batchTokens` defaults to **50,000**: the oldest contiguous whole-entry
  prefix, without Turn boundaries. Excess waits for another eligible completion.
  The effective batch also reserves instructions, knowledge, tools, output and the
  existing context: the host uses the model context window with a 15% estimation
  margin and reserves its output limit. An oldest entry that cannot fit remains
  pending with a capacity notification. Unknown model capacity also leaves work pending.
  Native branch context is additional to the new-material budget and is never compressed.
- `consolidation.triggerUnconsolidatedFacts` stays at **50**. Committed facts are eligible
  immediately, even from partly recorded Turns. Selection takes applicable facts
  without Turn grouping; path-aware per-fact progress is unchanged. There is no
  first-Noting gate and no scalar fact cursor.
- Worker completion starts nothing. A fresh eligible entry completion provides
  the next opportunity; no polling or draining is added. Each runtime reserves one
  slot per phase before asynchronous admission. Quit/reload cancels its workers
  under one five-second cleanup deadline and starts no flush.
- Pi custom entries persist session/turn/branch references, using Pi's own
  `appendEntry` facility. Resuming restores the selected lineage. Returning to a
  branch tip reuses its name; selecting an earlier point creates a new branch.
  Pi forks carrying these references stay in the same Trace Memory conversation
  lineage with a new branch name. A fresh Pi session gets a fresh Trace Memory
  session on its first reply. The before-tree hook returns a read-only summary as described below.
- Compaction reconciles persisted source entries and returns `memory.compact(...)` as
  `compaction.summary`. `firstKeptEntryId: ""` retains no old Pi messages: the
  facade block replaces the context. Pi 0.85.0's context builder searches for
  that id, finds none, and keeps the compaction plus later messages. Successful
  compaction is then recorded as a `compaction` turn; it receives no facts.
  Pre-reply compaction returns project injection without allocating a session.
- Main-agent registration and subagent requests use the exact same four definition
  objects, with façade descriptions and schema objects. Pi execution fields are
  non-enumerable so provider serialization includes only the shared metadata. `trace({address,
  tool, full, cursor, cap})` and `search({query, layer, cursor, cap})` read session-visible
  evidence without visibility restrictions; `note({facts})` writes facts and `memory({operations, skipped})` writes
  knowledge. Main-agent executions call `tools(context)` with kind `manual` and
  the current session, branch and turn. Writes commit immediately; `tool_result`
  records each raw call once. No prompt asks the main agent to maintain memory.
- `/trace` opens the native menu described below; `/trace status` reads status. `/trace project <name>`
  declares the project, saves host state and displays refreshed injection.
  `/trace mark K<n> verified|flagged|clear` marks a knowledge revision. These are
  user commands; the former model-facing `mark` tool is removed.

## Executor slots, claims and shutdown

Each enabled active Pi runtime is an executor with one Noting slot and one
Consolidation slot, including borrowed tasks. Each eligible entry completion checks
free slots. Own eligible work has priority under the normal thresholds and branch
pending-delivery gates. If no own task can be claimed, one enabled normally closed
target with a nonempty phase queue may use that slot, even for one entry or one
fact. Closed targets are ordered by oldest pending entry/fact allocation id, then
session id and branch name; sibling paths never combine into one writable range.
Failed claims may try another target. Completion only releases capacity; it never
launches another batch. New own work does not preempt a borrowed worker.

The facade shares the threshold/delivery predicate with host preselection and
rechecks eligibility during atomic admission. A SQLite claim excludes other
workers of the same target phase across branches, hosts and processes. It records
executor id, a random token and a thirty-minute expiry; no transaction spans a
provider request. Commits require the current unexpired token and target enrollment.
Borrowed commits also require a closed target; release compares token and executor.
Pi supplies the executor's memory-session id so external disable is rechecked at
admission and commit as well.
Borrowed work uses subagent mode and the configured phase model, with `session`
resolved from the executor's model. Its target project, branch and evidence freeze
before launch; a later project change rejects the commit. All business results,
usage, run records and deliveries remain attributed to that target.

Normal shutdown marks only the executor's own memory session closed. Restore clears
the mark and immediately reserves new tokens for that executor in place of another
owner's claims. The next eligible completion can consume them under normal
thresholds without waiting for the old worker. Old commits/releases are fenced.
Resume also takes abandoned own claims from a crashed runtime; ordinary tree
navigation does not change worker ownership. Restoring launches no extraction.

Shutdown/session replacement performs this sequence:

1. Stop admission; invalidate owned tokens before aborting model calls and retry
   waits. Close bound tools so cancellation cannot permit a late write.
2. Allow one five-second cleanup deadline across both slots. SQLite busy waiting
   is disabled for teardown, so lock contention reports errors promptly.
3. At the deadline close bindings and finish local worker waits, retaining available
   request/usage and cancellation diagnostics. Consume late provider failures.
4. Release claims conditionally, mark the own session closed, and close SQLite.
   Borrowed targets keep their closure state.

A commit that wins before cancellation stays successful. Cancellation that wins
first preserves the pending batch. No committed batch is restarted to obtain a
final reply. Audit/cleanup failure is reported without changing a committed result
or delaying exit indefinitely. Unknown cancelled usage renders as `cost unknown`;
partial usage identifies known cost only. Session spend totals sum returned counters
and cannot recover unknown provider charges. If SQLite is locked or unavailable,
closure/audit writes can fail; the host reports them and still closes. The absence
of a persisted closed mark is never repaired by guessing.

The runner passes its per-worker `AbortSignal` to pi-ai `complete`, registry
`complete`, and `retryAssistantCall`. Installed `dist/types.d.ts` declares the
signal option; `dist/utils/retry.d.ts` declares the retry signal, whose implementation
interrupts backoff. No provider-global cancellation or foreground cancellation is
used. A provider that ignores cancellation may keep its remote request alive,
but cannot hold local shutdown past cleanup or write through disposed tools.

## Enrollment and native menu

One enrollment switch belongs to each memory identity. New native sessions whose
`ctx.sessionManager.getHeader().timestamp` is strictly after the baseline default
Enabled; older, equal, missing or malformed timestamps default Disabled. The
baseline is atomically published in `trace-memory-baseline.json` in Pi's agent
directory at first successful initialization. It survives restart and upgrade,
independently of the configured database. This operational baseline cannot infer
when the package was installed before its first run. A native session created
before that first run therefore defaults Disabled. No migration exists in v1;
database presence is never explicit enrollment.

Use `/trace enable` to opt in or `/trace disable` to pause. Explicit choices survive
reopen, configuration reload and tree navigation. Before a memory identity exists,
the host persists provisional intent in a native custom entry and transfers it at
allocation after the first assistant reply. Pi defers writing a new native file until
that reply, so an atomic host-state receipt under the agent directory
(`trace-memory-enrollment/<identity hash>.json`) also preserves provisional intent.
It is enrollment state, not configuration; the database switch takes authority
after allocation. No artificial Turn is created. Forks
and clones carrying an identity share its current switch; a copied file's newer
creation timestamp cannot override it.

Enabling reconciles available current-path history, including the paused interval,
through the same identity-based importer as ordinary entries. It makes no provider
call and does not synthesize a completion. The next eligible completion checks
normal queue thresholds. Repeating enable does not duplicate imported sources.

Disabled sessions ingest nothing, inject nothing and start neither worker. Manual
`note` and `memory` reject with `/trace enable`; `trace`, `search` and status remain
available even before allocation. Compaction and tree hooks return no plugin
override so Pi proceeds with native context handling. Stored Raw, facts, knowledge,
runs and knowledge scope stay intact; other sessions still see shared knowledge.
Already-injected text remains in context. Unseen deliveries remain unconfirmed.
The transactional commit checks reject late business writes and leave their batch
pending; a batch committed before disable remains successful. Disabling this
executor invalidates its tokens and cancels active model calls and retry waits.
Another executor still rechecks the disabled target inside its commit transaction.

Bare `/trace` opens native dialogs:

- **Current session:** Enabled/Disabled, default or explicit origin, enable/disable
  with confirmation and shared fork/clone scope.
- **Settings (Global, read-only):** every effective value, its Default/Global/Project/
  Environment source, and masked file values. Edit files by hand; there is no editor.
- **Runs:** the existing run view, with an optional count input.
- **Status:** enrollment, counts, pending deliveries, last runs and spend.

Cancel leaves enrollment unchanged. Headless bare `/trace` prints status and the
available commands. `/trace enable`, `/trace disable`, `/trace status`,
`/trace runs [n]`, `/trace project <name>` and `/trace mark K<n>@<commit>
verified|flagged|clear` remain available; menu and command actions share operations.
Catch up and Stop belong to 18b and are not exposed in this slice.

All configuration layers validate before use, including masked values. Unknown or
removed keys fail by name. Counts and token limits require positive safe integers;
`maxToolRounds` retains its documented zero-unlimited sentinel, and `nearThreshold`
is a similarity in [0,1]. Mode settings require booleans. Impossible view capacity
still fails with a capacity message and retains pending sources. Changing `dbPath`
requires reloading the extension. The footer adds `Disabled` to its existing shape;
Enabled but idle retains the dim hollow indicator without that label.

## SDK signatures and request auditing

Signatures were read from the installed 0.85.0 package, not inferred from the
older vendored implementation:

| API | Declaration under the installed package |
| --- | --- |
| Hooks, tool execution/schema, command, `appendEntry`, context | `dist/core/extensions/types.d.ts` |
| `ctx.modelRegistry.find(provider, id)` and `.complete(model, context, options)` | `dist/core/model-registry.d.ts` |
| Read-only `getSessionId`, `getBranch`, `getEntries` | `dist/core/session-manager.d.ts` |
| `Context`, `AssistantMessage`, `ProviderRequestOptions.onPayload` | `node_modules/@earendil-works/pi-ai/dist/types.d.ts` |

`modelRegistry.complete` supplies Pi's configured provider/model/auth access.
Subagent Noting and Consolidation start with the run prompt, one rendered input
message and the four shared façade definitions. Both modes execute model tool
calls through run-bound façade tools and continue until the model stops. Each
round appends the assistant call and its tool results. Consolidation's first valid
`memory` submission returns review guidance, appended as one user-role message;
the second valid submission commits in the same conversation and run. Rejected
batches can be corrected through further tool rounds. The former continuation
state and separate candidate/final invocations are gone.

`onPayload` snapshots the provider-native body; the last request sent embeds all
earlier rounds and is stored with tool results, output and usage. In branch
mode the installed adapter serializes only the new assistant/tool suffix,
preserving native IDs and thinking signatures. Suffix serialization uses
`cacheRetention: "none"` so Anthropic does not accumulate cache markers on every
round; all captured cache controls remain untouched. `branch.ts` appends those native
items to the previous request and independently verifies its preserved prefix
before sending. Session model/auth remain frozen for the whole run. No auth
headers are included in the request-body audit.

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
consolidation continuation, incremental raw, compaction, marker precedence, deliveries
on branch return, frozen in-flight ranges, duplicate noting/consolidation calls, provider
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

1. Run `/trace status` before speaking. Expect no Trace Memory session id. Use `/trace enable` if this session predates the first initialization baseline.
2. Send these six prompts separately, waiting for each assistant reply:
   “For this project use pnpm.”; “Do not use npm.”; “Keep code and comments in
   English.”; “Preserve the language of quoted conversation.”; “Please repeat
   those constraints.”; “What constraints are we following?”
3. Run `/trace status` after the replies. Short exchanges below 10,000 compressed-view
   tokens produce no Noting. Continue with substantial conversation material
   until an eligible completion reaches the threshold; inspect the resulting run's
   entry audit and exact progress. Deliveries are confirmed only after a prompt
   takes them and settles. Invalid model output may bounce; inspect the run result.
4. Run `/compact`. Expect immediate compaction with `<knowledge>` and `<episodic>`,
   pending compressed Raw views, recent facts, and no compaction model request.
5. Ask the agent to call `search` for `pnpm`, then `trace` on a returned fact and
   its source turn. Expect the original conversation text and source addresses.
   The search/trace tools themselves are recorded as raw tool calls.
6. Save the actual prompt/reply transcript, `/trace` outputs, observed fact ids,
   compaction content, and trace result. Check `runs.request`, `mode`, `model`
   and `response.usage` using the facade. Default consolidation requires 50
   unconsolidated facts; six short turns need not produce any consolidation run. For a
   separate consolidation exercise set `consolidation.triggerUnconsolidatedFacts` to 1 and wait
   for another eligible source entry completion after the Noting commits.

Automated verification uses a fake provider; it does not establish live provider
credentials or replace the manual conversation above.


## Branch request and verification contract

Branch mode inherits the latest captured provider request: system instructions,
messages, the four tools already registered for the main agent, and all body
options (cache controls, sampling and reasoning settings). Nothing is added to
the tool list per run. The first request appends one user instruction: Noting
uses the prompt, range, head reply and frozen source index; Consolidation uses its
prompt, range, exact fact list and reminders.
Subsequent requests append native assistant/tool items and any Consolidation review
message to the immediately preceding verified request.

`before_provider_request` captures a detached JSON snapshot for this extension instance (one per Pi session) in
memory. It is never appended to the Pi session file. Session/tree restoration
invalidates the capture; missing captures and model changes since capture fall
back. Captures are the **last request**, not a reconstruction of the session:
the assistant response to that request is not in its own input, so Noting
appends the selected head reply. A selected user or tool source not captured in
that prefix uses the existing subagent fallback. Persisted originals before the
latest compaction or branch-summary boundary are conservatively excluded from
capture coverage. As before, payload-rewriting extensions must run before this
capture hook; native ancestry is not a proof against arbitrary later rewrites.

`branch.ts` supports `anthropic-messages`, `openai-completions`, and
`openai-responses` (including `openai-codex-responses`) payloads. Other APIs fall back with an explicit reason.
Anthropic system content blocks and OpenAI system/developer messages retain all
fields byte for byte under deterministic serialization; Responses uses `input`
and `instructions`. No provider-native messages are converted back into Pi
messages. `complete` receives the new suffix as its serialization context and `onPayload`
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
allowing only the appended items. It therefore covers each message prefix,
tools, system instructions and other body options. `differingPath` identifies the
first unequal path. Hashes cover the two complete deterministically serialized
UTF-8 bodies, so the captured hash and request hash normally **differ**.

`runs.response.verification` contains `passed`, `capturedHash`, `requestHash`,
`appendedMessages`, `differingPath`, `key`, `firstForKey`, and `rounds`.
The top-level hashes identify the capture and first request. Each `rounds` entry
records `capturedHash` (the previous request), `requestHash` (the new request),
`appendedMessages`, `passed`, and `differingPath`. The final passing round's
request hash identifies `runs.request`. Top-level `passed` becomes false if any
round fails. Reply
`usage.cacheRead` is also copied to `verification.cache_read` when numeric;
it never affects `passed`. Missing usage leaves the observation absent. Pi-ai
normalizes some absent provider counters to zero: zero is not proof of an
explicit provider measurement. Its Anthropic adapter maps
`cache_read_input_tokens`; OpenAI maps `cached_tokens` (verified in nested
`dist/api/anthropic-messages.js:411`, `openai-completions.js:1180`, and
`openai-responses-shared.js:441`). `response.usage` preserves the full SDK usage.

An initial mismatch prevents the branch provider call. The same noting run uses the full
frozen subagent input, records `mode: subagent`, `response.fallbackReason`, and
the failed verification with both hashes. `runs.request` is the actual fallback
request, while the failed branch hash describes the rejected candidate. Missing
or unsupported captures have a reason but no fabricated comparison/hashes.
Notification happens once per Pi session. A later round mismatch rejects that
round with no fallback; the record retains the last request actually sent and
the failed comparison. A prior committed batch remains committed. Provider/auth failures after a passed
comparison remain branch failures; they do not trigger another billable call.

The small core contract correction for this ticket exposes the already-frozen
full noting input as `subagentInput`, accepts the actual returned `mode`, and
preserves `verification`/`fallbackReason` in the response envelope. Without it,
fallback would send range-only context and falsely record branch mode. No store
schema or consolidation behavior changed.

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

2. Enable branch mode and a low compressed-token trigger with an isolated database:

   ```sh
   export TRACE_MEMORY_CONFIG='{"dbPath":"/private/tmp/trace-memory-manual/branch.db","noting.branchModeDefault":true,"noting.triggerTokens":100}'
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
   the assistant and the noting to finish before another prompt; `/trace status` is
   read-only. From a second terminal, in the repository root, run:

   ```sh
   node --input-type=module <<'JS'
   import assert from 'node:assert/strict';
   import { readFileSync } from 'node:fs';
   import { DatabaseSync } from 'node:sqlite';
   import { hash, serialize } from './hosts/pi/branch.ts';
   const db = new DatabaseSync('/private/tmp/trace-memory-manual/branch.db', { readOnly: true });
   const run = db.prepare("SELECT * FROM runs WHERE kind='noting' ORDER BY id DESC LIMIT 1").get();
   assert.ok(run, 'Wait for the noting to finish');
   const response = JSON.parse(run.response);
   console.log({ mode: run.mode, model: run.model, outcome: run.outcome, ...response });
   assert.equal(run.mode, 'branch');
   const captured = JSON.parse(readFileSync('/private/tmp/trace-memory-manual/captured.json', 'utf8'));
   const sent = JSON.parse(run.request);
   const key = Array.isArray(captured.messages) ? 'messages' : 'input';
   const verification = response.verification;
   assert.equal(verification.passed, true);
   let body = sent;
   for (const round of [...verification.rounds].reverse()) {
     assert.equal(round.passed, true);
     assert.equal(hash(body), round.requestHash);
     const count = round.appendedMessages.length;
     assert.deepEqual(body[key].slice(-count), round.appendedMessages);
     body = { ...body, [key]: body[key].slice(0, -count) };
     assert.equal(hash(body), round.capturedHash);
   }
   assert.equal(hash(body), verification.requestHash);
   assert.deepEqual(body[key].slice(-1), verification.appendedMessages);
   const prefix = { ...body, [key]: body[key].slice(0, -1) };
   assert.deepEqual(Buffer.from(serialize(prefix)), Buffer.from(serialize(captured)));
   assert.equal(hash(captured), verification.capturedHash);
   assert.deepEqual(sent.tools, captured.tools);
   db.close();
   JS
   ```

4. Save the two bodies and printed response. Check `usage.cacheRead` and
   `verification.cache_read` for cached input tokens. A positive count is an
   observation, not identity proof; zero/missing counts do not fail comparison.
   Hashes should each match their respective body, not each other. Inspect the
   appended message: noting prompt followed by range-only input, no copied raw.
5. Change the session model, then send another prompt and wait. Repeat the check:
   a supported model's first new run should have `firstForKey: true`. Repeat
   after changing active tool definitions. For an unsupported API expect
   subagent mode, a fallback reason and one notice, rather than invented hashes.
   Compare with a separate database using `noting.branchModeDefault: false` to
   evaluate extraction quality and cost before choosing the operational default.


## Attribution and tree navigation (ticket 07)

`session_before_tree` reconciles persisted source history and immediately returns
`branchSummary(sessionId, branch, headTurnId)`. It launches neither Noting nor
Consolidation, and does not await a worker. Committed lineage facts and evidence-selected
knowledge commits precede the same pending compressed entry views used by Noting.
Entries arriving during a frozen run remain in the summary. Reading it never
consumes a delivery or calls a provider. Compaction and shutdown also launch nothing;
pending work remains durable; shutdown cancels and fences in-flight runs under one
shared five-second cleanup deadline.

The hook returns `{ summary: { summary: text } }`. Installed Pi **0.85.0**
`dist/core/extensions/types.d.ts:481–510` declares `TreePreparation`,
`SessionBeforeTreeEvent`, and `SessionTreeEvent`; lines **861–874** declare the
result and **917–918** register both hooks. `dist/core/agent-session.js:2520`
accepts the supplied summary only when navigation requested summarization
(`options.summarize`). The public result cannot force insertion for a user's
no-summary navigation. The host returns its summary in either case and never
calls Pi's summarizer itself. The hook's abort signal does not cancel a frozen
noting. Existing `session_tree` restoration gives an earlier branch point a fresh
identity and preserves the identity when returning to a saved branch tip.

Marker discovery is a plain ancestor walk; the first file wins and an empty
file is an error. Worktrees share a marker only when their directories share
its ancestor; no Git lookup is performed. Marker-attributed sessions are
created with declaration `marker`, so they cannot accidentally merge a shared
named space as if it were private. An explicit `/trace project <name>` saves the project name
and current project ID in the Pi custom state and returns the updated injection
immediately in the command notification. The database declaration remains authoritative
when restoring older tree state, so a session's command declaration wins on every branch.
Peers remain in the marker project. Only an undeclared own space is merged.
Facts change project membership through their session join; session knowledge
retain scope, ownership and revisions while their project ID follows the
session. Duplicate project knowledge now share the next consolidation's NEAR pool;
merge itself neither consolidates nor deletes duplicates.

An empty text content block is not an assistant reply. Nonempty text, thinking,
or a tool call permits allocation; the tool-call case permits `note` or `memory` as the
first assistant action. A prompt, compaction or tree event without such a reply
creates neither a session row nor a turn row. Project records may precede replies.

Ticket 07's stub-host tests cover ancestor/nearest/worktree markers, session-only
mark precedence and persisted host state, retroactive merge and immediate
injection, session-knowledge isolation, shared duplicate visibility, deferred noting
completion with later raw and branch-only delivery, fresh subagent notings,
failure/unavailable models, sibling exclusion, and empty/tool-only replies.

## Retries

Every model call of a run goes through pi-ai's `retryAssistantCall`, the helper
Pi uses for its own compaction and branch-summary calls, with the policy from
Pi's `settings.json` (`retry.enabled`, `maxRetries`, `baseDelayMs`; provider
timeouts and SDK retries from `retry.provider`). Transient errors (429, 5xx,
overloaded, timeouts, fetch failures) back off exponentially; other errors
fail at once. A retry wraps one model call only: tool execution and commits
happen after a reply, so a retried call never repeats a write. While a retry
waits, the footer shows the warning indicator and a notice names the attempt.

## Run records

Every Noting, Consolidation and manual write leaves a row in `runs` with the
exact last provider request, the final output, summed usage, the tool-call
sequence, fetches and problems. `trace R<n>` renders a run as a summary (kind,
outcome, range, model, mode, what it created, usage, cost, tool counts,
problems); `full` adds each tool round and cut previews of the raw request and
response. `/trace runs [n]` lists the session's last n runs.

## Footer status item

Background runs never enter Pi's session totals: Pi only counts entries of the
session file (assistant messages, tool results and summaries carrying usage).
The host therefore publishes one footer status item through
`ctx.ui.setStatus("trace-memory", …)`, the shape the ponytail extension uses,
which a statusline extension renders as a segment:

```text
🧠 <indicator> trace-memory 7/38 $22.58
```

The ratio is the applicable current knowledge over the facts on this branch; the
amount is this session's cumulative spend at the model's configured API rates
(Pi's own cost formula).

The indicator uses Pi theme colours: dim `○` idle, accent `●` a Noting run in
flight, success `●` an Consolidation run in flight, warning `●` a branch Noting
paused until the next prompt delivers or the last run committed with problems,
error `●` the last run failed. `/trace` prints the session's breakdown by run
kind. Tree switching contributes no extraction usage to Pi totals.

## Known limits

- No heartbeat or process-liveness discovery exists. A crash does not mark a session
  closed; that conversation waits until resumed. Claim expiry only recovers ownership.
- Catch-up needs later eligible entries in another enabled runtime. There is no
  timer, completion chaining or continuous drain. A lease that expires during a
  long provider request fences its eventual commit; there is no renewal timer.
- Cancellation requests cannot guarantee that a remote provider stops billing.
  Available usage is retained; missing cancelled usage is unknown, never free.

- A queued (steering or follow-up) user message bypasses `before_agent_start`, so
  noting results that finish during such a message are delivered at the next
  ordinary prompt. Confirmation state is kept per agent run, so nothing is lost.
- Pi's `--fork` and clone continue the same Trace Memory session on a new branch;
  redeclaring the project there changes the shared session's project.

## Entry views and Noting progress (17a)

`render.toolCallTokens` defaults to **1,000** and `render.entryTokens` to
**10,000** (decimal); both accept positive safe integers through the existing
flat configuration. Tool name, native call identity, source address, status,
labels and omission markers count inside the budget. Each call permanently
reserves half of its budget for arguments and half for its eventual result,
with two tokens reserved for joining the fragments. The entry cap applies next
across natural language and all tool fragments. Excerpts retain head and tail,
including within one huge line or JSON value, with a count of omitted characters
and an explicit `middle not inspected` label. An impossibly small configured
budget reports a capacity error and leaves the entries pending.

The same entry bytes supply subagent Noting, subagent fallback, compaction
Raw and branch-carry Raw. Existing episodic budgets count these compressed bytes
when deciding which whole facts fit. Pending Raw views remain present with an
overage receipt when their combined views exceed that outer budget. The shared
estimator is unchanged. **Branch-mode Noting keeps reading the uncompressed
native provider prefix and gains nothing from the compressed view.** This is the
accepted 2026-09-08 branch-mode choice: its value is prefix reuse. The captured
prefix is never rewritten or compressed. Its one appended user message still
contains the Noting instruction, range, head reply and source index; the index
contains only the frozen sources. Existing exact-prefix verification and fallback
remain authoritative. A capture that predates a selected user or tool source falls
back to the same compressed subagent input; source previews are not evidence of
full prefix coverage. Native request capacity is checked before each Noting
provider call, including continuations, without rewriting the prefix.

Noting freezes entry identities on the selected path, not whole Turns. A
successful zero-fact run processes only its selected entries; later entries in
that same Turn remain pending. Address aliases are interpreted against the frozen
entry set. A later matching source occurrence makes that address ineligible for
the earlier writer, even if an unrestricted trace fetch can read it. Run records
include `entryAudit`: native identities, owning Turns, frozen branch, view-budget
version and values, and the exact omission markers. Entry processing, facts, run
audit and applicable deliveries commit atomically. Rejected or failed work remains
pending. A fork inherits processed shared entries and keeps its sibling entries
out of the selected ancestry.

The derived `getWatermark`/`listWatermarks` readers and the status watermark line
are removed in 17b, along with the already-removed writable watermark table.
Noting and Consolidation retain their exact per-entry/per-fact progress. Source-path
membership is native ancestry, not a delivery queue. Attach reconciliation performs
no model call; missing history is reported and retained originals remain readable.
`noting.triggerAnsweredTurns` and every unknown setting are rejected explicitly.
`noting.triggerTokens`, `noting.batchTokens` and both view limits accept only
positive safe integers.
