# 07 — Project attribution, merge, branch switch

**What to build:** A session belongs to a project only by a `.trace-memory` marker found upward from cwd or by `mark(project=…)` in the session (the in-session call wins); an undeclared session is its own project; merging an undeclared project into another relabels its facts and project-scoped entries retroactively, leaving session-scoped entries in place, with duplicates surfacing through NEAR at the next settle. `session_before_tree` finishes notes on the abandoned branch and returns its committed facts plus rendered unnoted raw as the branch summary.

**Blocked by:** 05 — Pi host, subagent mode.

**Status:** ready-for-agent

- [ ] Marker file discovery walks upward and stops at the first hit; a worktree shares the repo's marker
- [ ] `mark(project=…)` overrides the marker for that session only
- [ ] Merge relabels in one transaction and is reflected by `inject` immediately
- [ ] Branch switch while a note run is pending: the run finishes against its frozen branch, delivery goes there only, the summary never drops unnoted raw (behaviour test)
- [ ] Session ids are allocated at the first assistant reply; an empty session leaves no row
