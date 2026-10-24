# Curate

1. Read `group.md`: the contents give full titles, followed by each item's versions, every version's supporting facts, files and flags with reasons. Every supplied item is in scope; read every body and examine its grounds. Repository notes are shared across groups; incremental runs have changes in `seeds.md`, while a full check orders the group by labeled clusters.
2. Fill every pre-made block in `decisions.md`, keeping its `## item K<id>@v<n>` heading. Keys: `title`, `accuracy` (`ok`, `outdated: <why>`, `wrong: <why>` or `unverified`), `grounds`, `norms`, `evidence`, `files`, `decision`, `reason`. Evidence is comma-separated `trace://` addresses or repository paths, optionally `path@commit`; use `None` when absent. Files are comma-separated code paths or `None`. Decision is `keep`, `update`, `archive`, `merge`, `split` or `merged into K<primary>`. A keep may correct title or files without changing the body; code creates a metadata-only version when needed.
3. Write changes together in `changes.md`, one operation per item; write `## none` if there are no changes. Decisions and changes must agree. Update, merge and split bodies are complete replacements; omitted category, scope and topics retain their values, and empty supports use the exact parents' supports. Split children must explicitly name their supports and files. Use the forms below; `reason` is required on every operation and child. Archive kinds are `invalid` or `inadmissible`, with a substantive explanation of grounds and evidence. Do not archive duplicates.
4. Call {{tool.check}}, correct its findings, then stop. The stop hook continues this conversation with scoring, not a verify task. Budget: in principle at most 100 steps and +200k context for a 50-item group; check reports the configured budgets and usage.

```markdown
## update K41@v2
title: Package manager
supports: F340
reason: Preserve the ruling and describe current implementation

Use pnpm. The current implementation invokes npm.

## merge K52@v1
absorb: K53@v1
reason: Duplicate knowledge with the same scope and category

The complete merged understanding, including its conditions and reasons.

## split K60@v1
supports: F340
reason: Separate independently maintained facets

The primary part's complete understanding.

### child
title: Release process
category: understanding
scope: project
topics: release
supports: F341
files: None
reason: This facet is maintained independently

The child's complete understanding.

## archive K70@v1
kind: invalid
reason: The time-limited understanding has expired

The recorded condition no longer holds, as shown by its cited evidence.
```

## Review before stopping

Compare every proposed change with its facts, Raw entries and repository evidence. Correct a proposal on positive evidence and cite it in `evidence`, using Trace Memory addresses or pinned repository files. Do not reverse a supported change for stylistic preference or unavailable grounds: record missing grounds for a stale flag instead.

- **Update**: look for a wrong attribution, a dropped condition or qualifier, a ruling rewritten as pending, and a paraphrased quote whose wording is the constraint. Correct a wrong rewrite by restoring what the facts support.
- **Archive**: look for an item archived although it still holds, or archived with a successor that is not current. Withdraw an archive proposal when positive evidence shows that its content still holds. A mention elsewhere does not replace a merge.
- **Merge**: look for an absorbed item's valid content, conditions or evidence strength that the merged body dropped or distorted. Restore it in the complete merged body rather than discarding valid parts. Keep a merge whose parts all hold; abandon it only when none of the absorbed content holds or the merge fails the scope/category and independent-maintenance rules.
- **Split**: look for a part that lost its conditions, a child that cannot be understood alone, or a split that is merely mechanical. Correct a wrong part or withdraw the split. Every result must meet admission and have explicit supports and files.

<!-- include: smells-dreamer-update -->

<!-- include: smells-archive -->

<!-- include: smells-merge -->

<!-- include: smells-split -->
