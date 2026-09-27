### Memory model

Preserve experiences and understanding for an agent that no longer has this context. Help it recognize related problems, understand current views and find details to check.

The three layers have different purposes, not long, medium and short versions of the same content.
- Raw is the original conversation and execution record, for checking wording, evidence and detail.
- Facts are topic slices over continuous stretches of conversation: what happened then.
- Knowledge is the continuing understanding of a topic: what should be remembered now.

A knowledge item is an identity `K1` with immutable versions, not a fixed body.
- `K1#qfzt` names an exact version and is required for a mutation base. A tag identifies a version, not proof of reading.
- Bare `K1` reads the current version on this conversation path. Without a path, a read lists each identity's current version.
- `K1@v3` reads the third version across all branches; `K1@v2..v5` compares two versions. History numbers never renumber with reader scope or path.
- Reads are unrestricted; a read grants no scope or mutation authority. Scope, applicability and current-base checks still apply.
- A knowledge version cites facts on its own path, plus other sessions' facts its scope allows. A sibling fact needs an adoption fact from this path first.
- Facts are immutable. Record a correction in a new fact; a relation may link it to the earlier fact.
- Relations are annotations: they hide or retire nothing and change no fact's state.

The evidence chain is knowledge version, supporting facts, source addresses, then Raw. A fact belongs to no knowledge item and may support none, one or several.
