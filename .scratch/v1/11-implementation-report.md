# Ticket 11 implementation report

Implemented against baseline `cd4719dbdd489c128e3bd19196ad26532d41f4ec`. The starting working tree was clean. Ticket 10's Integration loops, command routing and removed continuation state were retained and extended. Nothing was staged or committed.

## Verification

| Check | Before | After |
| --- | --- | --- |
| `npm test` | 285 tests, 14 files passing | 294 tests, 14 files passing |
| `npm run typecheck` | Not separately run at baseline | Passed |
| `npm run smoke:pi` | Historical assertions were stale | Passed after registration and last-request assertions were updated |
| `git diff --check` | Clean starting tree | Passed |

Nine expanded test cases were added. Existing test names remain, including historical names referring to the retired continuation protocol. The registration assertion now expects trace/search/note/memory. The standalone smoke now compares the stored request to the final provider request, as required by the existing tool-round contract.

## Acceptance evidence

| Ticket item | Implementation and tests |
| --- | --- |
| Same four definitions, nothing added per branch run | Core exports the existing façade metadata once. Each host instance creates four Pi-compatible objects using those exact schemas and descriptions, registers them, and passes those same outer objects to subagent conversations. Pi execution fields are non-enumerable, so serialized definitions contain only façade metadata. `capture with the four tools, run, verification passed, tools unchanged` checks captured-prefix preservation; `subagent runs receive the exact four definition objects registered for the main agent` checks reference identity. |
| Branch Recording and Integration tools | Recording now enters ticket 10's existing branch loop. The installed adapter serializes each new assistant/tool suffix; `branch.ts` appends it to the immediately preceding request. `branch Recording verifies every trace and note round against the previous request and stores the last request` executes trace/full followed by note, checks fetched evidence, every hash and the final stored request. The existing real Anthropic Integration test checks memory's two submissions, signed thinking, results, review feedback and every round. Responses and Codex parameterized tests check native function-call IDs/results. |
| Verify every appended round | `verification.rounds` records each comparison's `capturedHash` (previous request), `requestHash` (new request), `appendedMessages`, `passed` and `differingPath`. Initial hashes retain their original meanings. A later failure sets overall passed false, rejects before send, preserves the last sent request and does not fall back. `a mutated branch tool round is rejected before sending and retains the last sent request` checks this behavior and the unchanged watermark. |
| Subagent loop and Integration review | Both run kinds continue through `modelRegistry.complete`, dispatching through the run-bound façade executors. The first valid memory receipt adds one user feedback message in the same conversation; the second commits. Existing Integration tests preserve this coverage. The inherited 16-round cutoff was removed to implement the spec's until-stop contract. No continuation state was reintroduced. |
| Manual immediate commit and raw calls | Every Pi execute binds `tools({kind: "manual", sessionId, branch, currentTurnId})` at call time. `main facade tools bind each call to the current turn, commit immediately and record raw only at tool_result` checks first tool-only reply allocation, two turns, immediate facts/knowledge, manual request metadata and exactly one raw row per call. Host execution adds no raw row itself. |
| Commands and no mark tool | Retained ticket 10's project/mark commands; command context is refreshed and mark kinds are explicitly validated. Existing project attribution tests cover persistence, declaration precedence and immediate refreshed injection. The new manual test exercises all three mark kinds and read-only status; registration tests exclude mark. |
| Documentation and live run | README documents four tools, both loops, exact-object sharing, native suffix verification, removed mark/continuation state and both commands. Its live script now reconstructs the complete hash chain backwards. LIVE-VERIFICATION has a ticket 11 procedure and explicitly marks live evidence pending the acceptor. |

Recording remains branch mode by default and uses the captured session model. The main agent receives no additional instruction to maintain memory. Project declarations and marks remain user commands. Main-agent note/memory receipts commit once through the façade and are separately captured once as raw tool results by the existing hook; background run calls never enter that raw hook.

## Design and review

The design options were duplicate host schemas or shared façade metadata with separately bound execution. Shared metadata was chosen. To satisfy literal outer-object identity as well, the same per-host Pi-compatible objects serve registration and subagent requests. Their execute/label fields are non-enumerable; installed Pi stores definitions directly and its wrapper accesses those properties explicitly. Run dispatch still uses the core's frozen run binding, never the main-agent execute callback.

Native serialization remains delegated to the installed adapter, rather than rebuilding provider tool and thinking shapes. Only the latest suffix is serialized, so previously sent messages cannot change during later serialization. Anthropic suffix serialization uses `cacheRetention: "none"`: captured cache controls remain exact, and new rounds do not accumulate cache markers. The real-adapter regression begins with three captured markers and verifies that all three requests still contain exactly three.

Parallel standards/spec reviews identified cache-marker accumulation, literal definition identity, and manual rejection status. These were fixed. A follow-up identified successful trace evidence containing the literal `rejected:`; rejection classification now checks a leading façade rejection or a write receipt's individual results, not arbitrary quoted evidence. Dedicated tests cover rejected manual writes and successful retrieval of historical rejected output. Final spec re-review found no remaining actionable blocker.

Installed API evidence: coding-agent 0.85.0 `dist/core/extensions/types.d.ts` declares the five-argument execute callback; `extensions/loader.js` stores the definition reference and `tools/tool-definition-wrapper.js` accesses its fields directly. Pi's executor maps thrown errors to failed raw results. Workspace pi-ai 0.85.1 supplies native conversion and `cacheRetention`; existing documentation distinguishes Pi's nested 0.85.0 adapter. Tests use stub providers/HTTP, not live external calls.

## Revert probes

Each listed probe was actually run, observed red, then restored byte-for-byte. Focused host tests passed after restoration.

| Ticket probe | Mutation | Test turned red | Observed assertion |
| --- | --- | --- | --- |
| A branch tool round not verified | Remove the appended-round verification/audit block | `branch Recording verifies every trace and note round against the previous request and stores the last request` | Expected verification rounds length 2, received 0 |
| A tool added per run | Append an extra tool to the initial branch candidate | `capture with the four tools, run, verification passed, tools unchanged` | Expected branch mode, received subagent after prefix rejection |
| The mark tool still registered | Register an additional mark tool | `smoke: the default extension loads and registers the Pi hooks, tools, and read-only command` | Expected exactly trace/search/note/memory; received an additional mark |

Mutation logs are in `/private/tmp/ticket11-probe-unverified-round.log`, `/private/tmp/ticket11-probe-tool-added-per-run.log`, and `/private/tmp/ticket11-probe-mark-still-registered.log`. No mutation remains in the worktree.

## Exact line accounting

Physical lines and `git diff --numstat` are relative to the baseline above. Production-host accounting includes only the two changed runtime files.

| Production host file | Before | After | Added | Deleted | Net |
| --- | ---: | ---: | ---: | ---: | ---: |
| `hosts/pi/index.ts` | 361 | 382 | 49 | 28 | +21 |
| `hosts/pi/branch.ts` | 55 | 66 | 15 | 4 | +11 |
| Total | 416 | 448 | 64 | 32 | +32 |

All changed files under `hosts/pi`, including tests, README, live procedure and smoke: **337 added / 87 deleted, net +250**. The two core façade files add **14 lines and delete 6, net +8**; this exposes/reuses existing descriptions and schemas without changing write semantics. The report itself is outside those counts.

## 验收自查

- All worker-owned ticket 11 acceptance items are satisfied; typecheck, 294 tests, smoke and whitespace checks pass.
- Live Recording through trace and Integration through memory remain unperformed because the user explicitly assigns live acceptance to the acceptor. Historical live records and stub HTTP tests are not presented as ticket 11 live evidence.
- Both requested commands remain user acts; four tools are registered; Recording defaults to branch; every appended branch round is verified; the final sent request is stored.
- Changes remain unstaged and uncommitted for review.
