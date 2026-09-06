core/ is host-agnostic: it must not import any host SDK.

- model/   Turn, Fact, Entry types and write-time validation (shape only).
- store/   SQLite: global ids, sessions, project attribution, facts, entries, entry revisions, run records.
- note/    build note input, parse output, validate, commit.
- settle/  build settle input (NEAR / CLOSER hints), parse output, accounting, apply new/edit/merge/delete.
- render/  one renderer for note input, compaction tail, branch summary, trace; XML injection blocks.
- prompts/ note.md, settle.md — versioned prompt texts (from simulation v7).

Model calls go through one interface, runAgent(input) → {outcome: success | failure | cancelled, output, usage, request}, where request is the exact provider request the host sent; hosts implement it (Pi: branch mode = prefix-identical call, or subagent mode = fresh call).
