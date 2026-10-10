### Formats

- A new fact starts with `[F<id>] title`, followed by one segment per source, such as `[T12#E3@assistant] Pi agent proposed the change.` Core fills each citation and role. Legacy facts retain their saved category, actor, status and quote; displayed sources use whole-entry addresses. Inbound relations are labelled `inbound`.
- Automatic material groups facts under `[T<id>] <Turn start time> (selected facts)`, Turns in order, ids ascending. Each fact appears under its owning Turn with all its sources; a group need not contain every fact of that Turn.
- A title-only index appears before full facts under `Earlier facts (titles only; read trace://F<id> for the body):`, grouped by `[T<id>] <Turn start time>` with `[F<id>] <title>` lines. These are pointers, not fact bodies.
- `Earlier user messages:` holds human user words missing from Raw, in chronological order, with a head/tail middle cut per entry. They are historical context.
- A Turn's facts view shows only that Turn's source segments; a legacy fact is shown whole. Entries not covered by a fact appear as paths.
- A fact read links each visible knowledge identity that cited it, including in an earlier version. The link names the current version and the citing versions without expanding their bodies.
- A complete knowledge item renders as `[K1#qfzt] [category/scope] text`, then its supports and topics; topics are absent when it has none. Injected items are grouped under `## <category> (<n>)` lines in the order constraint, understanding, goal, open, reference, and ordered oldest to newest inside a group. Knowledge views and `{{tool.search}}` show supporting fact IDs with titles; injection lists supporting IDs only.
- Previews, omissions and state notices carry no tag. A tag identifies an exact version, not proof that its complete body was received.
- History reads also show the item's own `K1@v3` address. Committed `update`, `merge` and `split` receipts carry each newly written version's `K#tag`, usable for the next mutation without a read; other body-free receipts retain history addresses. Uncommitted Noter receipts remain `Mn` handles.
- `(N tokens)` is an item's pool cost, as write receipts report it; `(B/1000 tokens)` is its body against the item cap.
- In Dreamer material the pool cost may read `(N tokens; facts 2026-10-01..2026-10-05)`: the UTC date range of the conversations its supporting facts cite, a single date when they share one.
- Raw labels address whole entries, with optional role filters: `[T12#E1@user] user: <text>` or `[T12#E2@assistant] assistant: <text>`. An assistant entry also contains its tool calls; a separate result entry uses `@observation`. Explicit reads include stored thinking; automatic material omits it.
- Calls render as `<tool>(<key>=<value>, …)` after their entry label; results render as `<tool> <status>: <result text>`. E ordinals stay stable within a Turn, including branch gaps. Copy the entry address, never a block selector or call ID.
- Arguments are `key=JSON` in stored order. Dropped structured data is marked by its size, non-text content by its type (`[<type> omitted]`).
- An omission is `[... N characters truncated]` or `[... N characters of details truncated]`; what a marker stands for was not inspected.
- `{{tool.search}}` matches one contiguous literal substring over every version applicable here, archived and superseded included and marked as such; several words match only that exact sequence. On no hit, change the word; never add one.
