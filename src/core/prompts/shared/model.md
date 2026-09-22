### Memory model

- A knowledge item is an identity `K1` with immutable commits `K1@57`; a commit has a global id and its parent commits.
- Bare `K1` reads the current commit on this conversation path. Without a path, a read lists each identity's current version.
- Reads are unrestricted.
- A knowledge commit cites facts on its own path, plus other sessions' facts its scope allows; a sibling fact needs an adoption fact from this path first.
- Facts are immutable. A fact is corrected by a new fact with a relation to it.
- Relations are annotations: they hide or retire nothing and change no fact's state.
