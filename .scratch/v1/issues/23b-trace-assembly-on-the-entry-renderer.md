# 23b — Explicit `trace` assembled from the entry renderer

**Parent:** 23 — One entry view, two budgets (the "`trace` assembly" decision and the deletion of the explicit Turn preview's per-tool branches, the tool-name regex and the keys `commandTokens`, `reportHeadTokens`, `reportTailTokens`).

**What to build:** an explicit read of a Turn without `full` assembles that Turn's selected source entries in path order and renders each with the tier-1 profile of 23a's renderer, so a Turn with several assistant messages shows each one, a tool call with several result occurrences shows each occurrence, and a sibling branch's entries never appear. The `tool` option selects which call's parts are rendered in full within their budgets; unselected calls keep their label line and an omission receipt, exactly the metadata 22c preserved. `full` renders the stored arguments and result envelope uncut, as today. The per-tool branches of the explicit Turn preview (read/search as path, bash command plus stdout/stderr, report head/tail) and the tool-name regex are deleted; `commandTokens`, `reportHeadTokens` and `reportTailTokens` join the removed-settings table as replaced by the uniform rule and `B`. Native identity stays bound in storage and in the run audit.

**Blocked by:** 22c — Turn-scoped trace (its Turn-scoped source read is what this slice assembles from; its byte-identity pins are replaced here by the new goldens) and 23a — the renderer.

**Status:** ready-for-agent (after 22c and 23a)

- [ ] `trace` goldens: a Turn with several assistant messages; a call with several result occurrences; a sibling-branch entry excluded; `tool` selection keeping other calls' labels and receipts; `full` equal to the stored envelope; a non-`full` read of a tool result equal to the entry renderer's tier-1 rendering of that entry.
- [ ] 22c's Turn-scoped read is reused (read counter unchanged from 22c's pin) and its ≥10× target still holds.
- [ ] The three keys rejected by name with the replacement named; the tool-name regex and the per-tool branches are gone (grep in a test, as the boundary test does for host imports).
- [ ] Revert probes: restore a per-tool branch → named red golden; drop the omission receipt for unselected calls → named red test.
- [ ] `npm test`, `npm run typecheck`, `npm run smoke:pi`, `npm run smoke:package` pass; report at `.scratch/v1/issues/23b-trace-assembly-on-the-entry-renderer.report.md`.
