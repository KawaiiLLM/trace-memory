# Ticket 11 acceptance — pending acceptor live run

Worker verification uses fake providers and installed adapters with stub HTTP.
The historical records below do not satisfy ticket 11 live acceptance.

The acceptor should use an isolated database and the README's capture extension
and reverse-chain verification script, loaded after payload-rewriting extensions.
Set `recording.branchModeDefault: true`, `recording.triggerAnsweredTurns: 1`,
`integration.triggerUnintegratedFacts: 1`; choose Integration mode explicitly
(`integration.subagentModeDefault: false` exercises branch mode as well).

1. Start Pi with all four tools active. Save the captured main-agent body and
   verify its tool schemas are `trace`, `search`, `note`, `memory` (alongside any
   other main-agent tools), with no `mark` tool.
2. Produce a turn containing a cut tool result. Obtain a branch Recording that
   actually fetches full evidence through `trace` and submits through `note`.
   If the model elects not to fetch, that attempt does not satisfy this check.
3. After committed facts have been delivered on the next prompt, let a turn stop
   trigger Integration. Obtain two valid `memory` submissions in one run: review
   guidance after the first, commit after the second, then a normal stop.
4. Save the run records and actual request bodies. For each branch run, apply
   the README script: strip suffixes backwards and verify each previous/new
   hash, unchanged tools/settings and exact captured-prefix bytes. Check native
   call IDs/results, the single review user message, and the final stored request.
5. Exercise a manual `note` and `memory` call; check immediate kind `manual`
   receipts and one raw `tool_result` row per call. Exercise `/trace project <name>`
   and `/trace mark K<n> verified|flagged|clear`; verify `/trace` alone changes
   neither stored runs nor watermarks.

Record Pi/pi-ai versions, model/provider, config, capture and database paths,
Recording/Integration run IDs, tool sequences, all verification hashes and outcomes.
Report cache-read counters separately as observations. **No ticket 11 live run
has been performed by the worker.**

---

Note: The history entries below predate the 2026-09-07 vocabulary rename.

# Live verification record (2026-09-07)

Environment: Pi 0.85.0 under Node 24.6.0, provider openai-codex, model gpt-5.6-sol
(the machine's default), extension loaded with `-e hosts/pi/index.ts`, isolated
database `/tmp/tm-live/trace.db`, marker file `/tmp/tm-live/.trace-memory`
containing `tm-live`, cwd `/tmp/tm-live/sub` (marker found one level up).
Config: `note.triggerAnsweredTurns=1`, `settle.triggerUnsettledFacts=3`.
All prompts were sent with `pi -p --session-id <id>` so each turn is one process;
the host awaits its background runs at shutdown.

## Session 1 (`tmlive1`), five turns

| Turn | Prompt (abridged) | Note run | Facts |
|---|---|---|---|
| 1 | use pnpm, not npm | run 1, subagent (fallback) | F1 decision/user |
| 2 | code comments in English | run 2, subagent (fallback) | F2 decision/user |
| 3 | what two rules? | run 3, subagent (fallback) | none (a recall, correctly nothing) |
| 4 | never commit to main | run 4, branch, verified | F3 decision/user |
| 5 | summarize the rules | run 5, branch, verified | none |

- Session row created at the first assistant reply, attributed to project `tm-live` by marker.
- First prompt: no entries existed, so nothing was injected (after the fix below).
- Prompts 2 and 3 each received the previous note's facts as a `pending_notes`
  block; deliveries were consumed once (delivered_at set).
- Runs 1–3 fell back to subagent mode with `fallbackReason: Unsupported branch
  payload API: openai-codex-responses`; the API name was added to the branch
  builder (same body shape as openai-responses) and runs 4–5 then ran in branch
  mode with `verification.passed = true`, both body hashes and the appended
  message recorded.
- `cacheRead` was 0 on every call, including the main agent's own calls in the
  Pi session file: this provider does not report cache reads, so the number is
  uninformative here, as the design expects (observation, never proof).
- After F3 the settle trigger fired: run 6 (candidate) and run 7 (final), both
  recorded; three constraint entries E1–E3 created, one per ruling, cited to
  F1–F3. Watermark: noted T5, settled F3.

## Session 2 (`tmlive3`), one turn

Prompt: "New session. Which project rules apply here? One sentence."

- The first prompt injected `<entries>` with E1–E3 (constraint/project).
- Reply: "Use pnpm instead of npm, write all code comments in English, and
  create a branch before committing—never commit directly to main."
- Note run 8 ran in branch mode and verified.

One earlier attempt at the second session (`tmlive2`) stalled for three minutes
before any assistant message and left no session file and no rows; the retry
above completed normally. Not reproduced; noted for watching.

Observed with the `json` output mode: the injected block appears as a custom
message (`role: custom`, `customType: trace-memory`) before the assistant turn.

## Session 3 (`tmsettle1`, after the review fixes in ebaba06): settle in branch mode

Fresh database `/tmp/tm-live2/trace.db`, marker `tm-live2`, config
`note.triggerAnsweredTurns=1`, `settle.triggerUnsettledFacts=2`,
`settle.subagentModeDefault=false`; three one-rule prompts, each a `pi -p` process.

| Run | Kind | Mode | Verified | cacheRead | Result |
|---|---|---|---|---|---|
| 1–3 | note | branch | yes | — | F1–F3 decision/user |
| 4 | settle candidate | branch | yes (prefix = captured main request) | 2176 | candidate JSON |
| 5 | settle final | branch | yes (prefix = candidate request) | 2048 | E1, E2 constraint/project |

- The final request's tail is `[user (settle prompt + input), message/assistant
  (candidate reply replayed as an `output_text` item), user (NEAR/CLOSER +
  checklist)]`; the openai-codex backend accepted the replayed item.
- The settle range froze at F1..F2 while note run 3 was still in flight; F3
  stays unsettled for the next trigger, as designed.
- This provider reported non-zero `cacheRead` on both settle calls, unlike the
  earlier sessions; still recorded as an observation only.

## Session 4 (`tmtrace1`, after the second review in 4a7c191): subagent note fetches cut evidence

Fresh database `/tmp/tm-live3/trace.db`, config `note.triggerAnsweredTurns=1`,
`note.branchModeDefault=false`; one prompt asking Pi to run a 2,500-line command
and report the count and last line.

- The raw turn rendered the 43.5K-character bash result with the standard
  head/tail cut. The note run called the `trace` tool once with
  `T1 tool=1 full` (43,926 characters returned), then wrote one event fact
  `completed: … printed exactly 2,500 lines, ending with "2500 item"` with
  source `T1#t1` and the command as quote.
- The run record lists the fetch under `fetched` and stores the last request
  sent: four input items (user, reasoning, function_call, function_call_output)
  and the single `trace` tool definition.

## Session 5 (`tmtools1`, after tickets 08–11): the four tools end to end

Fresh database `/tmp/tm-live4/trace.db`, defaults (Recording branch, Integration
subagent), `recording.triggerAnsweredTurns=1`, `integration.triggerUnintegratedFacts=2`;
three prompts, the first also running a 2,500-line command.

| Run | Kind | Mode | Verified | Tool rounds | Result |
|---|---|---|---|---|---|
| 1 | recording | branch | yes, round 1 verified | `note` → F1, F2 | two decision facts |
| 2 | recording | branch | yes, cacheRead 10752 | `note` → F3 | one decision fact |
| 3 | integration | subagent | — | `memory` ×2: feedback, then commit | K1 constraint/project, K2 goal/session |
| 4 | recording | branch | yes | `note` → F4 | one decision fact |

- Branch runs inherited the main agent's tool set unchanged (read, bash, edit,
  write, trace, search, note, memory): the four are in the captured prefix, so
  nothing was added per run; every appended round was verified against the
  previous request.
- The first Integration submission returned the NEAR/CLOSER/checklist feedback
  without committing; the second committed with empty diagnostics; the watermark
  moved to F2 while F3 waited for the next trigger.
- The recorder did not call `trace` in branch mode: the main agent's own bash
  result was already in the conversation, so there was nothing to fetch. It
  recorded no event fact for the command, a content judgment, not a defect.
- Facts carry system-derived times and no `status` (none were events).
