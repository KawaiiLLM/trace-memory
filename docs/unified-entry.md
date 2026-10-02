# Fact slices and memory reads

Facts restore an episode; knowledge retains its durable conclusions. Ticket 118 replaces the model-callable `trace` tool with `/tm` virtual files. Internal rendering, historical source parsing and write authority remain separate from this navigation change.

## Writing facts

Manual writers and the Noter use one fact per call, with fields at the top level:

```json
{
  "title": "Choosing the package manager",
  "sources": "[T12#E1@user] The user required pnpm instead of npm.\n[T12#E3@assistant] Pi agent proposed updating the lockfile."
}
```

Each source starts on a line with `[address] ` and may continue on following lines. Text before the first marker is rejected. Core trims each segment's trailing whitespace, orders segments by their entries' positions, derives source roles, joins the body and assigns the earliest source Turn. Duplicate resolved entries, empty segments and multiline titles are rejected. The writer supplies neither a fact-level body nor a fact-wide actor.

A slice ends at a topic pivot, batch boundary or size limit, not merely a speaker change. Assistant segments name the original harness. Results and the agent's interpretation use their own sources; later corrections form a new slice. Noter bodies have a 1,000-estimated-token limit, excluding title and generated citations; manual facts keep their size exemption. Material windows charge complete rendering. Noter publication is atomic at normal termination; manual writes commit immediately. Sources cite whole frozen entries, not `/tm` paths.

## Paths and views

Every session view names its session. Omitting T selects that session's current head:

| Path | View |
| --- | --- |
| `/tm` | Shared reading guide and top-level paths. |
| `/tm/S<n>` | One line per Turn, listing its facts and raw paths. |
| `/tm/knowledge/S<n>[/T<t>]` | Knowledge a fresh context at that node receives. |
| `/tm/compact/S<n>[/T<t>]` | Manual compaction material: knowledge, facts and Raw, without a continue sentence. |
| `/tm/facts/S<n>[/T<t>]` | Contributed fact segments, then paths of entries without fact coverage. |
| `/tm/raw/S<n>[/T<t>]` | Compressed Raw overview. |
| `/tm/raw/S<n>/T<t>@role` | Overview filtered to user, assistant or observation. |
| `/tm/raw/S<n>/T<t>#E<k>[@role]` | Whole immutable entry, including stored thinking; role mismatch is refused. |
| `/tm/F<id>` | Full fact with source session and visible knowledge backlinks. |
| `/tm/K<id>`, `/tm/K<id>#<tag>` | Current knowledge or one exact tagged version. |
| `/tm/K<id>@v<n>`, `/tm/K<id>.history` | One numbered version or history. |
| `/tm/knowledge`, `/tm/knowledge-all` | Knowledge identity lists, not inheritance bodies. |

An explicit T prefers the branch used by omitted T when that branch contains it; otherwise it selects a containing source path by greatest `hwm_entry_id`, then greatest path id. One exact E is independent of branch selection. E numbers are Turn-local and therefore require T. Only raw accepts E and role suffixes. Old session-first content paths, event ranges, comma lists and arbitrary trace-address fallback are removed.

Recursive Grep searches facts and full Raw entries, not duplicate compressed overviews or knowledge/compact injection views. Knowledge-all still searches every immutable version. A fact backlink names each identity once when its current version is visible, including historical citing versions; invisible current identities do not fall back to older bodies. Knowledge views and search show support titles; injection retains support IDs only.

## Host limits and teaching

Ordinary `/tm` reads use the host's existing pagination and notices. CC rewrites Read to a newly rendered immutable file; continuation reads that file, while a new `/tm` read creates a new snapshot. Pi uses native Read operations and truncation. There is no `/tm` cursor or separate 8,000-token cap. Search keeps its own existing parameters and pagination.

Session knowledge and exact raw entries are whole on Pi and CC main sessions. CC fresh workers retain the native SDK Read cap because the hook cannot directly return content; their task material already supplies knowledge. Reading records no delivery or state change.

The same guide, at most 200 Core-estimated tokens, appears once per injection, compaction or N/D material and at `/tm`. Only host tool names and session number vary. Root paths expose the session-list entry without adding guide text. Receipts and errors give navigation paths, not another reading lesson. Changed prompt sentences and the final guide require review before merging.

## Source authority and accounting

Legacy bodies, sources and metadata are not rewritten. Display resolves historical selectors internally to whole-entry citations. Missing entry bindings or inconsistent stored segments fail as data corruption. Host-normalized blocks, transactionally assigned E ordinals and persisted branch selection remain authoritative; navigation never renumbers entries. Reading thinking does not admit it as fact evidence. New facts reject thinking-only entries, and injected summaries are never Raw sources.

A tag identifies an immutable knowledge version, not proof of reading or permission to write. Current-base, scope, evidence and claim checks independently guard mutation. Native pagination must deliver a complete body before a model judges it; previews and body-free receipts have no tag.

Pending-token status prices joined bounded Raw. Admission additionally prices all instructions, tool definitions and emitted framing, including the reading guide. Facts and knowledge charge their complete displayed forms. Do not change estimator weights or thresholds to hide a boundary shift. Scripted or simulated-provider checks establish local behavior, not paid-model quality, billing or cache reuse; older measurements remain in the [historical verification record](unified-entry-verification.md).
