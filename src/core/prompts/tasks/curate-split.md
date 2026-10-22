# Curate: split

This run's operation is **split**. Propose only splits: separate an item that mixes topics needing independent maintenance. A problem a split cannot fix is left for the later runs of the other operations. Never write `create`, and never propose another operation.

A split block:

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

<!-- include: smells-split -->
