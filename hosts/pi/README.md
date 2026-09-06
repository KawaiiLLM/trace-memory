# Pi host (ticket 05)

`index.ts` is a Pi extension: its default export takes `ExtensionAPI`. It opens
one facade for the global database and uses only `core/api/index.ts`, including
its exposed store. Both note and settle use subagent mode. No core files changed.

**Live verification is blocked on the installed runtime combination.** Node can
launch Pi 0.85.0, but cannot import the core's `bun:sqlite`. Bun 1.3.11 fails while
loading Pi's bundled Undici, before extension loading. The automated tests below
load this extension under Bun with a stub ExtensionAPI and a fake provider; they
are not a transcript of a real model conversation.

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
- This ticket explicitly overrides the two mode defaults at each call: both are
  `subagent`, even if a configured mode default requests branch mode. Branch-mode
  calls and abandoned-branch summaries belong to ticket 06.

The existing peer dependency supplies types. For this verification, the local
`node_modules/@earendil-works/pi-coding-agent` was linked to the installed
`/opt/homebrew/lib/node_modules/@earendil-works/pi-coding-agent` (0.85.0), replacing
local resolution of 0.85.1. No devDependency or lockfile change was needed.

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
  session on its first reply. No branch-switch extraction runs in this ticket.
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
fresh call has exactly the input prompt as system prompt, one user message with
the input text, and no tools. `options.onPayload` snapshots the provider-native
JSON body without modifying it. That body alone is returned as `request`; the
facade records it along with output and usage, including provider failures.
No authorization headers are included in this request-body audit.

For settle's final round, the host locates the SDK conversation by the exact
candidate request body supplied in `continuation.request`. It replays those
original request messages and the complete assistant candidate message (including
provider metadata), then appends `continuation.message` exactly once. The SDK
serializes the final request and `onPayload` captures that body independently.
Candidate conversations are discarded after settlement, including bounces.

The vendored 0.84.4 `types.ts`, extension/SDK/session/compaction docs, and
`custom-compaction.ts`/`handoff.ts` were used for implementation patterns only.
No Pi source was copied. Compaction retention was additionally checked in the
installed `dist/core/session-manager.js` context builder.

## Automated verification

```sh
bun test hosts/pi/index.test.ts --test-name-pattern smoke
bun test hosts/pi/index.test.ts
bun run test
bun run typecheck
```

The smoke test imports the default extension with a stub ExtensionAPI, checks
registration, runs `/trace`, and asserts that it created no session or model
request. The host suite also checks trigger boundaries, request-body capture,
settle continuation, incremental raw, compaction, marker precedence, deliveries
on branch return, frozen in-flight ranges, duplicate note/settle calls, provider
failures, and absence of Pi imports in core.

## Manual verification in a real Pi session

Run this after resolving the runtime blocker below. Use an isolated database and
a directory with a `.trace-memory` marker so the observations are easy to inspect.
Launch a Bun-compatible Pi runtime with the extension explicitly selected:

```sh
export TRACE_MEMORY_CONFIG='{"dbPath":"/private/tmp/trace-memory-manual/trace.db"}'
bun /opt/homebrew/lib/node_modules/@earendil-works/pi-coding-agent/dist/bundle/cli.js \
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

Observed preflight on 2026-09-07 (not a completed manual conversation):

```text
node <installed Pi>/dist/bundle/cli.js --version
0.85.0
node import("bun:sqlite")
ERR_UNSUPPORTED_ESM_URL_SCHEME: Received protocol 'bun:'
bun <installed Pi>/dist/bundle/cli.js --version
TypeError: webidl.util.markAsUncloneable is not a function
Bun v1.3.11 (macOS arm64)
```

The last failure is in bundled Undici's cache initialization, before this
extension loads. No real six-turn transcript or live provider request was
produced. Resolving Pi/Bun compatibility, or adding a Node-compatible core store,
is necessary for the live acceptance check; neither was patched silently here.
