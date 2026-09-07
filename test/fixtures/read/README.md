# Read goldens

Injection uses the Chinese knowledge and fact content in `../noting/facts.json`.
Compaction adds the second user prompt cut from `../noting/turns.json`.
Allocated addresses and timestamps are fixed by `core/api/read.test.ts`;
memory wording remains unchanged. Goldens are checked-in expected strings,
not generated during tests.
