# 16b — Knowledge commits: addresses, rendering, search notes, prompts, tree-switch carry, live run

**What to build:** Everything the model and the user see follows the commit model. `trace` resolves `K1` to the path current (or lists tips without a context), `K1@57` to one commit, `K1@57..K1@61` to a diff, `K1..` to the commit tree across branches; the knowledge trace shows parents and children; search notes say "current on this path", "superseded on this path by K1@61", "another branch", or "archived on this path"; `/trace mark` takes a commit address; the prompts describe identities and commits; the tree-switch summary carries the leaving branch's facts, commits and unrecorded raw labelled as from another branch for reference.

**Blocked by:** 16a.

**Status:** implemented — awaiting acceptor live run

- [x] Address grammar and `checkAddress` updated; `K<n>@<rev>` forms are gone; missing commits rejected as missing
- [x] `renderKnowledge` prints `[K1@57]`; the trace of an identity prints its path current with the commit's parent(s), the applicable history along the path, and the other branches' tips; diffs work between any two commits of one identity
- [x] Search notes per the spec; injection and compaction blocks unchanged in shape but built from the path current set
- [x] `/trace mark K1@57 verified|flagged|clear`; bare `K1` resolves through the session's path
- [x] integration.md and recording.md describe identities, commits and the citation rule in one paragraph each; the memory tool description names the base-commit rejection
- [x] `branchSummary` returns one XML block `<branch_carry>` whose first line is the fixed reminder from the spec (knowledge from another branch; not to be written as facts; facts come only from the current branch's conversation, never from messages this plugin injected), followed by the leaving branch's facts, its commits (by evidence) and the unrecorded raw; the host passes it unchanged as the Pi summary
- [x] recording.md states that the plugin's injected messages (knowledge block, deliveries, compaction block, branch carry) are never fact sources; a test shows a fact citing content that exists only in an injected message is rejected for lacking a raw source
- [ ] Live run recorded by the acceptor: a fork, a commit on one branch, the other branch injected with the old commit, the fork ancestor with the pre-fork commit
- [x] Revert probes named in the report: path current replaced by global newest; base check dropped; sibling citation allowed
