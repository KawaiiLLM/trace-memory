# Curate: merge and split

This run's operations are **merge** and **split**. For each item, decide which of the two it needs, or none, and propose only that. An item may appear in only one block of the file, whether as a primary, an absorbed item or a split item.

Check every item of the batch against both smell lists below, and do only what these two operations can fix. A problem they cannot fix is left for the later runs of the other operations. Never write `create`, and never propose another operation.

A merge block names the fuller item as the primary and absorbs the items it fully covers:

```
## merge K41@v2
absorb: K7@v2, K9@v1
reason: K7 and K9 repeat K41 with no added condition

The package manager is pnpm; npm is acceptable for one-off scripts (「npm is fine too」).
```

- `## merge K<id>@v<n>` names the primary and takes `absorb:` with the other items, and `reason`. The `title`, `topics` and `supports` are inherited from the primary when omitted.
- The body is the complete merged text. Keep unique valid information, conditions, reasons and evidence strength.
- Merged items share one category and one scope. The primary keeps its identity, and each absorbed item is archived into it when the merge is applied.
- Look for merge partners beyond your batch. Your group shows one part of the knowledge, and a category may be split across groups: search for items that repeat one of yours.

A split block separates an item that mixes topics needing independent maintenance:

```
## split K41@v2
reason: One item held the package rule and the release process

The package manager is pnpm; npm is acceptable for one-off scripts.

### child
title: Release process
category: understanding
scope: project
topics: release
supports: F340

Releases are cut from main after the full test run.
```

- `## split K<id>@v<n>` takes `reason`. Its body is the new text of the item, which keeps its identity as the primary part.
- Each `### child` section becomes a new item, and takes `title`, `category`, `scope`, `topics`, `supports` and `reason`, then its body.
- Each result must be understandable on its own and meet admission. A child may take another category.

Nothing is applied until verify passes. A batch file that passes the check when you stop is kept for verify.

<!-- include: smells-merge -->

<!-- include: smells-split -->
