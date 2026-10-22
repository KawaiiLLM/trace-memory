# Curate: merge

This run's operation is **merge**. Propose only merges: name the fuller item as the primary and absorb the items it fully covers. A problem a merge cannot fix is left for the later runs of the other operations. Never write `create`, and never propose another operation.

A merge block:

```
## merge K41@v2
absorb: K7@v2, K9@v1
reason: K7 and K9 repeat K41 with no added condition

The package manager is pnpm; npm is acceptable for one-off scripts (「npm is fine too」).
```

- `## merge K<id>@v<n>` names the primary and takes `absorb:` with the other items, and `reason`. The `title`, `topics` and `supports` are inherited from the primary when omitted.
- The body is the complete merged text. Keep unique valid information, conditions, reasons and evidence strength.
- Merged items share one category and one scope. The primary keeps its identity, and each absorbed item is archived into it when the merge is applied.
- An item may appear in only one block of the file, as a primary or as an absorbed item.

<!-- include: smells-merge -->
