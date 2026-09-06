# 03a — Trace slice: entries, revisions, diffs, negation walks

Split of ticket 03 (Codex judged the whole too large for one chunk). Spec: .scratch/v1/spec.md. Glossary: CONTEXT.md. Prompt: core/prompts/settle.md. English only in the repo; fixture memory content stays in its conversation language. Follow the patterns of tickets 01–02 (core/README.md); no host SDK imports; no new store tables (read methods may be added); reuse core/render for every line.

**What to build:** `trace E<n>` shows the current text, category, scope, supports and a revision summary; `E<n>@<rev>` shows that revision as a snapshot; `E<n>@a..b` shows the diff: changed spans within the line via LCS over tokens, supports added and removed, category and scope changes, intermediate revisions listed with their triggering facts (`because`). `F<n>..` walks later strong negations, branching, ending with "no later strong negation recorded". A merged entry still traces to its own last revision and names the survivor revision it was merged into. All lines through core/render.

**Blocked by:** 02 — Note slice.

**Status:** ready-for-agent

- [ ] `E<n>`, `E<n>@<rev>`, `E<n>@a..b`, `F<n>..` addresses parsed in the façade's trace; invalid addresses and missing ids error clearly
- [ ] Diff lists within-line changed spans, supports added/removed, category and scope changes, and every intermediate revision with its triggering facts
- [ ] Merged entry traces to its last revision plus the survivor's revision; archived entry shows its archive revision
- [ ] `F<n>..` branches over multiple strong negations and terminates with the fixed sentence
- [ ] Golden tests from a fixture cut from the simulation data; behaviour tests drive the façade only (revisions created through commitSettleRun)
