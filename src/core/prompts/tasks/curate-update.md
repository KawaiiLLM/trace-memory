# Curate: update

This run's operation is **update**. Propose only updates: rewrite an item from the current view and keep its identity. A problem an update cannot fix is left for the later runs of the other operations. Never write `create`, and never propose another operation.

An update block:

```
## update K41@v2
reason: Merged duplicate wording; the rule is unchanged

The package manager is pnpm; npm is acceptable for one-off scripts (「npm is fine too」).
```

- `## update K<id>@v<n>` takes `reason`. The `title`, `category`, `scope`, `topics` and `supports` are inherited when omitted.
- The body is the complete new text, in the language of its facts.
- Change a wrong `category` or `scope` here, with an update, so that later runs can merge or split correctly.
- Nothing is applied until verify passes. A batch file that passes the check when you stop is kept for verify.

<!-- include: smells-update -->
