### Memory model

- A knowledge item is an identity `K1` with immutable revisions. `K1#qfzt` names an exact version and is required for a mutation base; it matches a version, not proof of reading. Scope, applicability and current-base checks still apply.
- Bare `K1` reads the current version on this conversation path. Without a path, a read lists each identity's current version. `K1@v3` reads the third revision across all branches; `K1@v2..v5` compares two revisions and `K1..` reads all history. History numbers never renumber with reader scope or path.
- Reads are unrestricted.
- A knowledge commit cites facts on its own path, plus other sessions' facts its scope allows; a sibling fact needs an adoption fact from this path first.
- Facts are immutable. A fact is corrected by a new fact with a relation to it.
- Relations are annotations: they hide or retire nothing and change no fact's state.
