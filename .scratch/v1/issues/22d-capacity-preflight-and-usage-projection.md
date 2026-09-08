# 22d — Cheap capacity rejection, and spend from usage rather than audit bodies

**Parent:** 22 — Responsive memory processing (hotspot families 6 "Repeated material refreezing when mandatory costs already exceed model capacity" and 7 "Loading complete run audit bodies merely to aggregate usage and spend"; section "Capacity and accounting"; user stories 30–33, 37–38).

**What to build:** a freeze whose fixed mandatory costs (instructions, tool definitions, inherited prefix for the effective mode) already exceed the input allowance is rejected before any candidate material is built; within a feasible freeze, fixed costs and immutable views are computed once; and the session's spend is aggregated from each run's usage without loading request and response bodies.

**Verbatim constraints from the parent (apply as written):**
- "Perform a cheap rejection when unavoidable instruction, tool, or inherited-prefix costs already exceed the effective mode's input allowance. Do not repeatedly re-freeze candidate batches when no candidate can possibly fit."
- "Retain optional-history priority, oldest-first whole evidence, mandatory reminders, final hard-budget verification, and execution of the exact prepared material that was priced. A fast preflight supplements the final guard; it does not replace it."
- "Spend and footer accounting should read usage metadata or correctly maintained totals, not full request and response audit bodies. Preserve exact run accounting when usage is added or amended on an existing run."
- "Unknown or failed-response placeholder usage remains distinct from observed usage. Do not manufacture zero observations to make aggregation easier."
- No schema change: a SQL projection of the existing `runs.response` column (`json_extract`) or a correctly maintained in-process total are the allowed shapes; a new column or table is not.
- The review pins of 2026-09-08 in `tests/core/api/budget-repairs.test.ts` (capacity priced by effective mode; optional history yields before selected evidence; `Receipts:` heading charged; Noting runs the prepared material it priced) stay green; the preflight sits in front of them, never instead of them.

**Blocked by:** 22a — the `tests/perf/` fixture and runner.

**Status:** ready-for-agent (after 22a)

- [ ] Baseline recorded on the generated fixture before any change (audit numbers: a normal Noting freeze selected 23 entries in 297 ms; an impossible 2,000-token allowance spent 1,427 ms before rejection while instructions and tools alone cost 3,896 estimated tokens; spend for 200 synthetic runs with 256 KiB requests and 64 KiB responses loaded 65.6 million characters in 20 ms, a usage projection 2.4 ms).
- [ ] Mandatory costs are derived from the actual instructions, tool definitions and effective mode; an allowance below them is rejected within 100 ms, with no model dispatch, no progress advance, no run record, and no candidate material constructed (assert on a render counter).
- [ ] Fitting-capacity and optional-history-reduction cases from the review pins still pass; the priced material is the material that runs.
- [ ] Spend over about 200 synthetic runs with large audit bodies returns the same totals as the pre-change implementation at least five times faster and without reading `request`/`response` bodies into JavaScript; a usage update on an existing run changes the subsequent total correctly; a placeholder/unknown usage contributes no observed zero.
- [ ] Revert probes: (1) remove the preflight and name the test that goes red on time or on the render counter; (2) let the preflight replace the final guard (skip the hard-cap check when the preflight passes) and name the test that goes red; (3) restore `SELECT *` body loading in spend and name the test that goes red.
- [ ] `npm test`, `npm run typecheck`, `npm run smoke:pi`, `npm run smoke:package` pass.
