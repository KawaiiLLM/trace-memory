# 16b — Knowledge commits: addresses, rendering, search notes, prompts, tree-switch carry, live run

**What to build:** Everything the model and the user see follows the commit model. `trace` resolves `K1` to the path current (or lists tips without a context), `K1@57` to one commit, `K1@57..K1@61` to a diff, `K1..` to the commit tree across branches; the knowledge trace shows parents and children; search notes say "current on this path", "superseded on this path by K1@61", "another branch", or "archived on this path"; `/trace mark` takes a commit address; the prompts describe identities and commits; the tree-switch summary carries the leaving branch's facts, commits and unrecorded raw labelled as from another branch for reference.

**Blocked by:** 16a.

**Status:** ready-for-agent

- [ ] Address grammar and `checkAddress` updated; `K<n>@<rev>` forms are gone; missing commits rejected as missing
- [ ] `renderKnowledge` prints `[K1@57]`; the trace of an identity prints its path current with the commit's parent(s), the applicable history along the path, and the other branches' tips; diffs work between any two commits of one identity
- [ ] Search notes per the spec; injection and compaction blocks unchanged in shape but built from the path current set
- [ ] `/trace mark K1@57 verified|flagged|clear`; bare `K1` resolves through the session's path
- [ ] integration.md and recording.md describe identities, commits and the citation rule in one paragraph each; the memory tool description names the base-commit rejection
- [ ] `branchSummary` carries the leaving branch's commits (by evidence) under a "from another branch, for reference; not adopted" heading
- [ ] Live run recorded by the acceptor: a fork, a commit on one branch, the other branch injected with the old commit, the fork ancestor with the pre-fork commit
- [ ] Revert probes named in the report: path current replaced by global newest; base check dropped; sibling citation allowed
