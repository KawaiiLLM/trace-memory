### Formats

- A new fact starts with `[F<id>] title`, followed by one segment per source, such as `[T12#E3@assistant] Pi agent proposed the change.` Core fills each citation and role. Legacy facts retain their saved category, actor, status and quote; displayed sources use whole-entry addresses. Inbound relations are labelled `inbound`.
- Automatic material groups facts under `[T<id>] <Turn start time> (selected facts)`, Turns in order, ids ascending. Each fact appears under its owning Turn with all its sources; a group need not contain every fact of that Turn.
- A Turn read shows facts with only that Turn's source segments; a legacy fact is shown whole. Unprocessed entries appear as Raw, and uncited processed entries as addresses. Follow the printed entry range to read the Turn's Raw.
- A fact read links each visible knowledge identity that cited it, including in an earlier version. The link names the current version and the citing versions without expanding their bodies.
- A complete knowledge item renders as `[K1#qfzt] [category/scope] text`, then its supports and topics; topics are absent when it has none. Items are listed oldest first. Knowledge reads through `{{tool.trace}}` and `{{tool.search}}` show supporting fact IDs with titles; injection lists supporting IDs only.
- Previews, omissions and state notices carry no tag. A paged body has an untagged header and its version tag follows only its final fragment; each complete item's tag is independent of other items' cursors.
- History reads also show the item's own `K1@v3` address. Mutation receipts without bodies use history addresses, not tags.
- Raw labels address whole entries, with optional role filters: `[T12#E1@user] user: <text>` or `[T12#E2@assistant] assistant: <text>`. An assistant entry also contains its tool calls; a separate result entry uses `@observation`. Explicit reads include stored thinking; automatic material omits it.
- Calls render as `<tool>(<key>=<value>, …)` after their entry label; results render as `<tool> <status>: <result text>`. E ordinals stay stable within a Turn, including branch gaps. Copy the entry address, never a block selector or call ID.
- Arguments are `key=JSON` in stored order. Dropped structured data is marked by its size, non-text content by its type (`[<type> omitted]`).
- An omission is `[... N characters truncated]` or `[... N characters of details truncated]`; what a marker stands for was not inspected. `{{tool.trace}}` with `full: true` (or itemBudget, toolCallBudget and toolResultBudget all null) returns the original; pages stay bounded, so follow every cursor.
- `{{tool.search}}` matches one contiguous literal substring over the versions applicable here; several words match only that exact sequence. On no hit, change the word; never add one.
