# Curate: update and archive

This run's operations are **update** and **archive**. For each item, decide which of the two it needs, or none, and propose only that. An item takes at most one block.

Check every item of the batch against both smell lists below, and do only what these two operations can fix. A problem they cannot fix is left for the later runs of the other operations. Never write `create`, and never propose another operation.

An update block rewrites an item from the current view and keeps its identity:

```
## update K41@v2
reason: Merged duplicate wording; the rule is unchanged

The package manager is pnpm; npm is acceptable for one-off scripts (「npm is fine too」).
```

- `## update K<id>@v<n>` takes `reason`. The `title`, `category`, `scope`, `topics` and `supports` are inherited when omitted.
- The body is the complete new text, in the language of its facts.
- Change a wrong `category` or `scope` here, with an update, so that later runs can merge or split correctly.

An archive block removes an item that no longer belongs in the knowledge:

```
## archive K52@v1
kind: inadmissible
reason: A running log

This item only records who implemented what; its lasting content is in K41.
```

- `## archive K<id>@v<n>` takes `kind`, either `invalid` or `inadmissible`, and `reason`. The body is the archive statement.
- State the grounds, the evidence and the replacement, if any. A bare status is refused.
- Content that now lives in another item is merged in a merge run, not archived here.

Nothing is applied until verify passes. A batch file that passes the check when you stop is kept for verify.

<!-- include: smells-update -->

<!-- include: smells-archive -->
