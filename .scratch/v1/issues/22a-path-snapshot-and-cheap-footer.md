# 22a — One path snapshot per operation, and a footer that costs nothing

**Parent:** 22 — Responsive memory processing (hotspot family 3 "Repeated path applicability work in fact selection, Consolidation, branch carry, and footer counts, including disabled sessions"; sections "Applicability and lightweight status"; user stories 7–10, 12–16, 20–22, 40–42). Amended 2026-09-09 (user-approved): the seven families share one cause and one repair primitive, see below.

**What to build:** every read or operation that asks "is this fact / commit / entry on the selected path" answers it from one snapshot built once for that operation, and never by reloading and parsing Raw payloads per fact. The footer refreshes from cheap counts, on enabled and disabled sessions alike, and a disabled session's callbacks never enter the automatic-history path.

**The primitive (amendment, 2026-09-09):** the parent's seven hotspot families are one cause in the code — `source_entries.content` is the whole message JSON, and identity questions (which Turn, which role, which callId, on the path or not) are answered by parsing it. This slice introduces the one repair primitive the later slices reuse: a per-operation **path snapshot** holding the selected path's Turn set and its source-entry metadata (entry id → Turn, role, tool-call ordinals/callIds), read without parsing `content` (SQLite `json_extract` on the column is allowed; a new column or table is not). `content` is parsed only when a view is rendered. The snapshot is read-scoped: built at the start of an operation, passed through `factOnPath`, `consolidatedOnPath`, `citationProblem`, `listBranchFacts`, `consolidationBatch`, `branchSummary` and the footer, discarded at the end. No process-lifetime cache of applicability.

**Verbatim constraints from the parent (apply as written):**
- "Preserve existing database contents and schemas. This work does not introduce a migration, delete a database, rewrite historical sources, or require users to reset their memory."
- "A performance problem alone is not authorization for a new scheduler, service, persistent job system, dependency, or worker-process architecture."
- "Retain source-occurrence checks for same-Turn divergence and the existing treatment of facts without explicit entry bindings."
- "Read-scoped reuse is the default. Any longer-lived derived cache or aggregate must account for branch/head changes and writes by other executors, not only writes performed by the current process."
- "Footer refresh must not independently enumerate and revalidate the full history to obtain counts. Disabled callbacks must not enter the expensive automatic-history path merely to display disabled status."
- "Keep status truthful: use inexpensive current statistics or explicitly distinguish unavailable/stale values. Do not silently label an old cached value as a fresh count."
- Footer reading is fixed by the user ruling of 2026-09-07 (see `src/hosts/pi/index.ts` `showSpend`): applicable current knowledge / facts on this branch; $ = this session's cumulative spend. A cheap count must be the same number the enumeration gave.

**Also in this slice — the shared performance fixture (parent "Workloads and acceptance"):** a deterministic generator with a fixed seed producing the baseline workload ("approximately 2,000 source entries and 15 million Raw characters, with at least 126 applicable facts and tool-heavy Turns", plus a larger size to expose quadratic growth), covering "long conversations, many tool results, nontext user boundaries, repeated text, multiple native occurrences, and mixed CJK/Latin tool payloads without copying private conversation content into the repository". Put it under `tests/perf/` with a serial runner that is not part of `npm test` and records runtime version, fixture size and warm/cold state. Later slices (22b–22d) measure against this fixture; record this slice's baseline numbers in the report before changing the implementation.

**Blocked by:** None — can start immediately.

**Status:** ready-for-agent

- [ ] Baseline recorded on the generated fixture before any change (the audit's numbers on the private copy were: `listBranchFacts` 7,368 ms / 238,392 source reads; `consolidationBatch` 11,007 ms; `branchSummary` 9,096 ms; disabled-session `session_start` / `before_agent_start` / `before_provider_request` 7.7–8.2 s each with zero model requests).
- [ ] `listBranchFacts`, `consolidationBatch`, `branchSummary` and citation validation return byte-identical ordered results, content and receipts to the pre-change implementation on the fixture, and run at least ten times faster than the recorded baseline (parent target: "improve by at least an order of magnitude").
- [ ] Path semantics pinned: same-Turn sibling occurrences on another branch are not applicable; tree restoration, shared ancestors, foreign-session evidence, explicit project change, new relations, archive/update/merge commits, and a second store connection writing between two reads all give the uncached answer.
- [ ] Footer refresh and every enabled-session callback that only refreshes status add at most 100 ms at p95 on the baseline workload; the displayed counts equal the enumeration's.
- [ ] A disabled session with the baseline history: session restoration, pre-prompt and pre-provider callbacks meet the same 100 ms target, make no model dispatch, do no source reconciliation, keep all data, and show "Disabled" with truthful counts (or an explicit unavailable marker, never a stale number presented as current).
- [ ] No schema change; `git diff` shows no new table or column.
- [ ] Revert probes: (1) restore the per-fact path rebuild in `factOnPath`'s default arguments and name the test that goes red on time or on read count; (2) let the footer call the enumeration on a disabled session and name the test that goes red; (3) make the snapshot outlive the operation across a second-connection write and name the test that goes red.
- [ ] `npm test`, `npm run typecheck`, `npm run smoke:pi`, `npm run smoke:package` pass; the perf runner's results are in the report with runtime version, fixture size and warm/cold state.
