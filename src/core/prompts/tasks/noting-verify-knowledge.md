## Stage 4 of 4: check knowledge

The facts file passed the check and is now fixed. Do not change it.

Read the new facts, knowledge changes and `related-knowledge.md`; check only knowledge.

1. Read the knowledge file. Go through the lists below item by item for each `create` and each `update`.
2. Correct or rewrite a record when evidence shows it is wrong, or mark it reverted; put `verdict: ok`, `verdict: edited — <why>` or `verdict: reverted — <why>` under every block.
3. Turn a duplicate create into `update K<id>@v<n>` of the retrieved version; add an update for an item a new fact overturns, citing that fact in `supports:`.
4. For an archive or merge only the Dreamer can resolve, write `## flag K<id>` with `reason:` and a verdict; do not archive, merge or split.

<!-- include: smells-create -->

<!-- include: smells-update -->
