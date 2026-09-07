# Ticket 10 implementation report

Implemented ticket 10 against baseline `770aee1069a0042d218a72db2ee045fbeed5773d`. The initial working tree was clean. Changes remain uncommitted and unstaged.

The memory tool now accepts one uniform atomic batch. Consolidation makes one host `runAgent` invocation whose tool loop submits twice: the first valid batch returns review guidance without writes, and the second commits. The provider may take additional tool turns to correct rejected batches or finish after commit; these are not additional review rounds.

## Verification

The complete suite passes, including preserved historical tests and new boundary regressions.

| Check | Before | After |
| --- | --- | --- |
| `npm test` | 266 passing tests, 13 files | 285 passing tests, 14 files |
| `npm run typecheck` | Not separately run before changes | Passed |
| `git diff --check` | Clean initial tree | Passed |

The 19 added tests comprise four dated rulings, 14 memory behavior cases, and one real Anthropic adapter test. Test-name comparison against HEAD found no removed names in rulings, Consolidation, or the three host test files, including parameterized name templates. Existing dates and time labels remain verbatim.

## Acceptance evidence

Each ticket item is implemented through the façade's tool path.

| Acceptance item | Implementation and observable evidence |
| --- | --- |
| Uniform operation schema | `core/api/tools.ts` defines one schema with conditional required/forbidden fields. `prepareMemory` independently checks all supplied fields, required because, full resulting state and address types. The dated operation-shape test checks every archive-forbidden field, missing resulting fields, missing because and ordered atomic rejection. |
| Per-item results and frozen targets | Validation returns ordered `ok` / `rejected: reason` results for operations, then skipped items. Invalid items prevent all writes. Targets and every absorb participant must be visible, active, and on the start revision; manual executions look up current revisions each time. Store application rechecks revisions inside an immediate transaction. Tests cover missing/foreign/late facts, unread or moved targets, duplicate targets, self/duplicate/empty absorb and inactive knowledge. |
| Full supports and history | Create/update/merge use complete replacement supports. Creation now also stores because, separately from supports. The dated history test checks both revision snapshots and manual run request/result, and the inherited merge test checks revision triggering facts. |
| Atomic merge | Survivor revision, absorbed status and links commit together. Any rejected sibling operation prevents the merge too. Absorbed knowledge retains its last revision and traces to the survivor's new revision. Both dated and inherited tests observe these facts. |
| Two submissions | First valid batch returns `feedback: {role: "user", content}` with the system guidance line, NEAR, CLOSER and the prompt's entire second-round section verbatim. Hosts append that feedback as one user-role message. The second valid batch commits; later submissions return `already committed`. Invalid submissions do not consume a valid round. |
| First-only stop and run outcomes | A normal first-only stop is bounced and preserves candidate plus tool input/result. An uncorrected invalid batch also bounces. Normal no-submission stop succeeds with zero knowledge. Pre-commit failure/cancellation writes only audit data; post-commit failure/cancellation/thrown Error/AbortError preserves success and appends problems. |
| Accounting and diagnostics | Accounting inspects actual post-application visible knowledge inside the committing transaction, including concurrent changes to untouched knowledge. Uncited user facts/questions, unanswered NEAR, unsupported numbers and over-200-token texts are diagnostics only. Because never satisfies accounting. Skipped validates a range fact and non-empty explanation. |
| Façade marks/project | `mark(knowledgeId, kind)` preserves revision-bound rendering. `declareProject(sessionId, name, source?)` separates attribution; optional source preserves existing marker precedence. `MarkInput`, the mark tool and the project branch of mark are deleted. Existing mark/render/attribution tests pass through the new methods or commands. |
| Prompt and JSON removal | Output and second-round sections describe memory submissions, complete replacement state and skipped. Removed production `validateConsolidationOutput`, its legacy types/helpers and Consolidation model-output JSON parsing. No production near_ack/not_admitted or ticket-10 placeholder remains. README and glossary describe the new protocol. |
| Ticket 03 inheritance | Frozen inputs, complete relation/reminder visibility, lexical hints, exact checklist, corrected/unchanged submissions, branch/session deduplication, Chinese fixtures, revision history, diff/negation navigation, merge links and transaction rollback remain covered. Superseded rejection behavior is detailed below. |

## Historical test migration

`core/api/consolidation.test.ts` retains all 52 expanded cases and their names. Its scripted fake provider now executes memory and continues with the receipt plus one user message within the same run. Audit assertions inspect one run's last request and ordered tool results instead of candidate/final run IDs. Historical fixture vocabulary is converted only in `test/memory-batch.ts`; production has no compatibility parser.

The following historical assertions change because of the new rulings:

- Accounting tests, including post-edit/archive/merge supports, because-only evidence and narrowing another session's global knowledge, now assert `uncited_facts` diagnostics on success instead of bounce.
- Revision-conflict tests now assert whole-batch bounce, no new knowledge, unchanged Consolidation watermark and preserved submissions instead of partial commit/lost-citation diagnostics.
- The duplicate-handle case now submits a forbidden handle field: model-assigned handles no longer exist. NEAR ack fixtures no longer acknowledge anything; retaining the candidate leaves a diagnostic unless an update/merge answers it.
- Former JSON syntax/shape cases submit malformed tool arguments. Bounce records use outcome `bounced`. Captured requests survive missing-returned-request and thrown-error paths.
- Candidate/final audit cases observe both tool submissions inside the same run record. The last request includes earlier assistant calls, results and feedback.

`core/api/validation.test.ts` retains its 12 test names. Every case executes the Consolidation memory tool. The all-sections case becomes a batch containing all four operations; omitted legacy sections convert to explicit empty arrays. Malformed handle is now a forbidden-field case. The two near_ack cases become valid skipped accounting and rejection of the obsolete near_ack field. Assertions inspect the run's recorded tool input rather than reconstructing output JSON.

All original ruling names/dates remain. Only the former memory-unimplemented assertion changes to validation rejection; four named dated rulings are added. `core/api/read.test.ts` changes only mark/project façade call signatures. Store, trace, read goldens, Noting, rendering and existing generic tools tests otherwise remain unchanged.

## Exact Pi runtime changes

Only `hosts/pi/index.ts` changes production host code; `branch.ts` is unchanged.

- Consolidation receives the same four run-bound definitions as Noting in subagent mode, executes calls by name, appends tool results, and continues. `reportRequest` now runs for both kinds.
- Memory's first receipt supplies a user-role feedback message, appended after its tool result. Removed core-driven candidate/final continuation handling and host continuation state.
- Branch Consolidation loops using the captured request plus an appended suffix. The installed Pi adapter serializes the suffix, preserving native tool IDs, assistant content and thinking signatures. Only serialized messages/input are appended; captured settings, system and tools remain unchanged. Model/auth/session context remains frozen for the entire run.
- Removed mark registration and its import. Marker attribution calls declareProject. Added `/trace project <name>` and `/trace mark K<n> <kind>` routing through the new façade methods; project state persists and the command notification includes refreshed injection. Bare `/trace` retains status behavior.

Ticket 11 still owns main-agent registration of all four façade definitions, Noting branch tool execution, verification of every appended round, live acceptance and host documentation. This intermediate host registers trace/search only after mark removal. Consolidation's original prefix verification remains in its record; `verification.requestHash` describes that initial verified request, while `run.request` is the last actual request.

## Replaced host assertions

All host test names remain exactly as before, even where a name mentions the retired protocol. Unlisted host assertions are unchanged.

| Existing test | Replaced assertion or stimulus |
| --- | --- |
| `smoke: the default extension loads and registers the Pi hooks, tools, and read-only command` | Registered list changes from trace/search/mark to trace/search. Four main-agent registrations remain ticket 11. Hook and read-only status assertions remain. |
| `first prompt injects project/global knowledge without allocating a session; marker is declared and mark wins` | Project override stimulus moves from mark.execute to `/trace project override`; marker precedence, allocation, persistence and zero model requests remain asserted. |
| `consolidation waits for a turn stop after facts arrive and final replays candidate plus one feedback message` | Fake JSON reply becomes memory tool call. Total requests 4 → 5: Noting two, Consolidation candidate/second submission/final stop three. Second Consolidation conversation has four messages rather than three: user, assistant call, toolResult, user checklist. Two Consolidation records/model entries become one. Exact stored-request comparison moves from request index 3/run index 1 to index 4/run index 0. |
| `consolidation in-flight duplicates cannot erase the candidate continuation` | Released fake response is a memory call. While blocked request count stays 3; completed total 4 → 5. Overall success records 3 → 2. Duplicate-trigger and continued-conversation coverage remain. |
| `mark persists in host state across tree restoration without merging marker peers` | Override uses `/trace project override`; state/tree/peer assertions unchanged. |
| `declaring an own project moves facts and project knowledge, preserves session scope, and injects immediately` | Declaration uses `/trace project named`. Injection assertion reads command notification instead of tool result; merge, facts, duplicate knowledge and session scope assertions unchanged. |
| `a tool-call-only first assistant reply allocates the session before mark executes` | After the same tool-only assistant stimulus, project action uses `/trace project named`. Session allocation and attribution assertions remain. |
| `removing a marker before first reply cannot turn its shared project into an undeclared merge source` | Override uses `/trace project override`; shared-project preservation assertions unchanged. |
| `an consolidation call carries no tools; a noting tool call for a bad address returns an error result and the noting still completes` | Two undefined Consolidation tool lists become three lists of trace/search/note/memory. Overall run outcomes change from Noting plus two Consolidation successes to Noting plus one Consolidation success. Bad-address error and Noting completion assertions remain. |
| `a model switch during the consolidation candidate round does not redirect or break the final round` | Fake branch replies become memory calls and final stop. Frozen-model branch calls 2 → 3; Consolidation records 2 → 1. Verification lookup uses run index 0. Preparatory Noting model assertion remains. |
| `17:01 settle is branch-capable: candidate appends to the captured prefix, final replays the candidate reply plus the feedback on that request` | Branch calls 2 → 3. Second request suffix now has assistant native tool_calls, tool result and user feedback, so strip count 2 → 3. Native arguments and tool-call ID are asserted. Stored request is the third request; an additional assertion strips its assistant/result suffix and compares to the second. Two run records become one. Verification hashes identify original capture/initial candidate, because core no longer launches a separate final branch request; exact last request is separately compared. Existing prefix, prompt, feedback, frozen model and empty-knowledge assertions remain. |
| `consolidation branch mode without a capture falls back to subagent for both rounds and notifies once` | Total requests 4 → 5; two Consolidation records become one. The obsolete second failure reason `not a branch request` becomes an assertion of two recorded memory calls. Initial missing-capture reason, no branch call, frozen model and exactly one notice remain. |

Shared host fixtures now provide memory calls with `{operations, skipped}` and stop after two memory results. Branch fakes use the installed native converter for their appended messages. The new real Anthropic adapter test replaces HTTP only and checks signed thinking, tool replay, user feedback, preserved prefix/settings/tools and the exact last stored request.

## Core line accounting

Counts use physical source lines, including blank lines within named spans, relative to the baseline. Tests, docs, prompts and host files are excluded from production TypeScript totals.

| Retired JSON-specific source span | Lines |
| --- | ---: |
| Legacy Consolidation output types, helpers and validator section in model/index.ts | 198 |
| Two unused legacy knowledge/handle regex declarations | 2 |
| Model-output JSON parse/validate/bounce block in consolidation/index.ts | 5 |
| Total retired JSON-path spans | 205 |

The replacement memory implementation occupies 163 lines: operation/batch types 15, schema 11, preparation/accounting module 95, and new memory submission state machine 42. These are implementation-span counts, including reused diagnostic work, not a claim that all 163 are new diff insertions.

The literal production-core diff is **215 added / 361 deleted, net −146**, including the new 42-line memory.ts. Thus the requested comparison is **205 retired JSON-path lines versus 215 added production-core lines**; the broader deletion total also includes obsolete orchestration and mark plumbing.

## Review and limits

Parallel standards/spec review found three issues, all fixed: stale accounting for concurrently changed untouched knowledge, reordered create operations losing NEAR diagnostics, and handwritten branch replay dropping provider thinking signatures. Focused re-review found no remaining actionable blocker. Regressions reproduce all three paths.

NEAR diagnostics retain unanswered first-round create hints conservatively while any create remains. Candidate labels refer to the preserved first batch. Withdrawing one create while retaining an unrelated create can therefore retain a warning; arbitrary corrected text has no persistent model-supplied identity. This affects diagnostics only and is documented in core/README.md.

Unsatisfied ticket 10 acceptance items under the current rulings: **none**. Ticket 03's partial-commit-on-conflict and accounting-bounce requirements are deliberately superseded by ticket 10 and the user's explicit atomicity/diagnostic rulings; they cannot simultaneously hold. No real external provider call or live Pi acceptance was performed; the adapter test uses stub HTTP. Ticket 11's remaining host work is listed above.
