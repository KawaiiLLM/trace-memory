# Ticket 09 implementation report

Implemented against `.scratch/v1/issues/09-note-tool.md`, the governing spec sections, and the two additional user rulings in this session. Baseline: `0ded9fb8f5fbe50baa002d7d81aaddaed3aba87f`. The working tree was clean before implementation. No commit or staging was performed.

## Verification

| Check | Before | After |
| --- | --- | --- |
| `npm test` | 233 passing tests, 11 files | 266 passing tests, 13 files |
| `npm run typecheck` | Not separately run before changes | Passed |
| `git diff --check` | Clean initial worktree | Passed |

Net test increase: 33. Original ruling names and date/time labels are preserved. All host test names are preserved. The 12 former Integration validator cases now exercise `integrate()` through the facade in `core/api/validation.test.ts`; they were not discarded. The all-sections fixture uses separate edit and merge targets because the facade also enforces referential/application rules, unlike the old shape-only test.

## Acceptance

| Ticket item | Implementation and evidence |
| --- | --- |
| Four definitions, run/manual binding, writer descriptions | `core/api/tools.ts`, facade `tools(context)`, dated four-tools ruling test. Bound context is copied, including range and read revisions. |
| Atomic batch, ordered per-item errors, corrected resubmission, handles and sources | `note.execute`, shared fact-shape validator, store immediate transaction. Ruling and tool tests observe zero facts after rejection and committed IDs after correction. Source existence, frozen ancestry, session ownership, forward/self handles, duplicate relations and malformed items are covered. |
| Event status field and renderer prefix | Model/store `status`; renderer supplies the prefix. All four statuses, missing/forbidden/invalid status and prefixed input are tested. |
| System-derived time | First source turn supplies both `turnId` and `createdAt`; model timestamp fields are rejected. Multi-source/tool-source tests verify the first source rule. |
| Distinct run outcomes | Normal no-submission success advances without delivery; uncorrected rejection persists `bounced` without advance; pre-commit failure/cancellation advances nothing. Dated ruling and Recording tests cover these. Pi maps provider length stops to failure. |
| Read parameters and visibility | `trace({address,tool,full,cursor,cap})`, `search({query,layer,cursor,cap})`; obsolete address flags rejected; listing cap is the sole cap. Hints use parameter form. Project/session knowledge and raw/fact visibility, cursor ownership, history and negation navigation are covered. |
| One committed batch and atomic run/watermark/delivery | A successful execute writes facts, receipt-bearing run record, frozen watermark and nonempty delivery together. Further calls return `already committed`. Tests inspect committed state before the fake provider returns. |
| Zero-fact run without delivery | Normal stop without submission commits only run/watermark. Explicit empty committed batches also queue no empty delivery. |
| Manual writes and Integration | Immediate manual run records exact input/result, session/branch/turn, and branch facts enter Integration. Manual facts on a common ancestor cannot leak into a sibling branch. |
| Last request, tool sequence, fetched | Host calls `reportRequest` at provider payload capture; final returned request is stored. Response preserves final text, tool inputs/results, read revisions, fetched evidence, problems and fact IDs. |
| Fake runAgent seam / facade-only imports | Recording fakes receive definitions and execute tools themselves. All tests import core implementation only through `core/api`; store tests use its existing store interface. |
| Prompt / JSON removal / named rulings | Recording Output describes note, assistant sources, status, time, whole-batch correction and the exact negate definition. Relation tuples and semantics remain support/negate with strong/weak. Recording JSON parsing and batch validator were deleted. All four requested dated ruling tests were added. |
| Core line delta | Detailed below. |

Additional transaction ruling: after a batch commits, outcome stays success even on a later provider error or cancellation. Only audit data is updated; trailing problems identify the post-commit failure. Return and thrown Error/AbortError paths are tested. A known provider request is stored at execute time; the final audit retains the last request. No rollback, staging, or temporary fact lifecycle exists.

Existing databases migrate the status column and run enums on open. Legacy event prefixes become status values while rendered content, existing facts, watermarks, deliveries and foreign keys survive. A reopening test covers this migration.

## Exact Pi implementation changes

Only `hosts/pi/index.ts` runtime code changed:

- Replace the hand-written trace-only subagent definition with the four facade-supplied definitions from the Recording input, omitting execute functions from provider schemas.
- Dispatch subagent tool calls by name to their bound `execute`, append tool results, and continue until the provider stops. Remove the former eight-round cutoff.
- Report the captured provider request to core before tool execution, in the existing payload hooks.
- Classify provider length stops as failure; preserve aborted/error handling.

Main-agent registration, branch transport, triggers, shutdown, project/mark commands, branch switching and Integration implementation remain for their existing scope; ticket 11 finishes host tool wiring. No branch tool-loop implementation was added here.

## Protocol-forced host assertion replacements

All test names and their trigger, watermark, delivery, branch-switch, fallback, shutdown and Integration-continuation checks remain. Changes are:

| Existing test or fixture | Replacement under tool protocol |
| --- | --- |
| `recordingFact` fixture | JSON text batch becomes a note tool call without timestamp; the fake provider returns final text after observing the note result. Captured fake payloads include actual definitions. |
| `recording through runAgent commits the exact provider request, prompt, model, usage and subagent mode` | Run request equals the last provider request instead of the first. Preserve the one-message initial request assertion and additionally assert the final user/assistant/toolResult sequence. Tool list changes from trace alone to trace/search/note/memory. |
| `integration waits for a turn stop after facts arrive and final replays candidate plus one feedback message` | Recording takes two requests rather than one; total after two Integration rounds is four rather than three. Candidate/final conversation and final request indexes shift by one; replay and no-extra-trigger checks remain. |
| `shutdown for session replacement (%s) waits for pending runs, launches nothing, and closes the store` (new/resume/fork) | Completed pending Recording uses two requests rather than one. Waiting, no new run and closed-store assertions remain. |
| `integration in-flight duplicates cannot erase the candidate continuation` | Total requests while candidate waits change from two to three; after final from three to four. Duplicate and continuation assertions remain. |
| `08:53 premise: a branch note (%s) waits until a note result committed mid-turn has been delivered; subagent mode does not` | Totals change from 1/2 to 2/4, then 2/3 to 4/6, accounting for note plus final-text requests in each Recording. Delivery gate and frozen ranges remain. |
| `spec overflow policy: a subagent recording fetches cut evidence through the trace tool; the run records the fetch and the last request` | Trace arguments move from address flags into tool/full fields; two provider requests become three (trace, note, final text). Preserve the trace-result conversation assertion, full-evidence comparison and call ID. Four-name tool list replaces trace-only; fetched audit includes parameter input; stored last-request index changes from one to two. |
| `an integration call carries no tools; a recording tool call for a bad address returns an error result and the recording still completes` | The tool-free Integration conversations start after three Recording requests instead of two. Bad-address error and all run outcomes remain asserted. |
| `a model switch during the integration candidate round does not redirect or break the final round` | Preparatory Recording explicitly uses the implemented subagent note loop; Integration stays in branch mode. Two branch model calls are asserted, with a separate assertion of the preparatory Recording model. Both frozen-model Integration outcomes and prefix verification remain. |
| `17:01 settle is branch-capable: candidate appends to the captured prefix, final replays the candidate reply plus the feedback on that request` | Preparatory Recording uses the subagent note loop (two registry requests); the two Integration branch requests remain the compared candidate/final pair. Add Recording's final tool conversation assertion. Every Integration prefix/replay/feedback/hash assertion remains. This avoids expanding branch-tool transport into ticket 09. |
| `integration branch mode without a capture falls back to subagent for both rounds and notifies once` | Total requests change from three to four; both Integration fallback outcomes, reasons, model and single-notice assertions remain. |

## Line accounting

Counts are physical source lines, including blank lines inside the identified spans, compared with the baseline commit. Tests, docs and host files are excluded from the production-core total.

| Deleted Recording JSON path | Lines |
| --- | ---: |
| `RecordingTurnBatch` type and separator | 7 |
| `validateRecordingOutput` batch validator and separator | 42 |
| `runRecording` JSON parse and per-turn batch-validation block | 24 |
| Total removed JSON-specific path | 73 |

The new `core/api/tools.ts` tool layer adds 147 lines: **73 deleted JSON-path lines versus 147 new tool-layer lines**. Related facade, run orchestration, visibility, renderer, store transaction/migration and type changes yield **298 added / 152 deleted production-core lines, net +146**. This broader number includes the 147-line new file.

## Review and remaining scope

Standards review found no hard violations. Its Integration-test coverage concern was resolved by facade migration; the README contract was updated. Spec review found the common-ancestor manual branch leak; the fix and regression passed re-review, with verdict READY. A suggested internal visibility-helper consolidation remains a nonblocking maintenance observation.

Unsatisfied ticket 09 acceptance items: **none**. Knowledge operations are intentionally unimplemented until ticket 10. Full Pi branch/main-agent tool wiring remains ticket 11 as requested.
