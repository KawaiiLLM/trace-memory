# Curate: archive

This run's operation is **archive**. Propose only archives: remove an item that no longer belongs in the knowledge. A problem an archive cannot fix is left for the later runs of the other operations. Never write `create`, and never propose another operation.

An archive block:

```
## archive K52@v1
kind: inadmissible
reason: A running log

This item only records who implemented what; its lasting content is in K41.
```

- `## archive K<id>@v<n>` takes `kind`, either `invalid` or `inadmissible`, and `reason`. The body is the archive statement.
- State the grounds, the evidence and the replacement, if any. A bare status is refused.
- Content that now lives in another item is merged in a merge run, not archived here.

<!-- include: smells-archive -->
