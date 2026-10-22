**How verify judges**

The change file numbers every change that curate proposed. Give each number exactly one verdict, in a file of blocks:

- `## confirm <n>`: the change is right as proposed. A `reason:` line is optional.
- `## edit <n> <op> <K@v>`: the change is right in kind but wrong in content, such as `## edit 3 update K12@v3`. Give `evidence:`, then the corrected item in the form of a curate block of the same operation, target and absorbed items. The body is the complete corrected text.
- `## revert <n>`: drop the change. Give `evidence:` and `reason:`.

Rules for every verdict:

1. Check the change against its facts, the Raw entries and the repositories. Change a proposal only on positive evidence, and cite it in `evidence:`, a comma-separated list of `trace://` addresses and repository files such as `src/store.ts:120`.
2. When you are unsure, confirm. Leave style alone.
3. An edit keeps the operation's kind, its target, the items a merge absorbs and the number of a split's children. It may change the body, `title`, `category`, `scope`, `topics` and `supports` of the items the change produces.
4. An edit writes only the fields it changes. A field it leaves out keeps the proposal's value, not the current item's.
5. A proposal whose base is shown as no longer current is refused when it is applied. It still needs a verdict.
