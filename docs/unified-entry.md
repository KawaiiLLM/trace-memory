# Fact slices and entry reads

Facts restore an episode; knowledge retains its durable conclusions. A new fact has a title and one text segment per contributing entry. The address selects the reading level, without a separate `layer` parameter.

## Writing facts

Both manual writers and the Noter use the same shape. This example illustrates a two-source slice:

```json
{
  "facts": [{
    "title": "Choosing the package manager",
    "sources": [
      {"address": "T12#E1", "text": "The user required pnpm instead of npm."},
      {"address": "T12#E3@assistant", "text": "Pi agent proposed updating the lockfile."}
    ]
  }]
}
```

Core validates and orders the segments by their entries' positions on the selected path. It derives source roles, joins segment text with line breaks and assigns the earliest source Turn as the new fact's owner. The writer supplies neither a fact-level body nor a fact-wide actor. Two spellings resolving to the same entry are rejected as duplicates. Titles must be nonempty and single-line; segment text must be nonempty.

A slice ends at a topic pivot, the Noter batch boundary or the fact-size limit, not merely when the speaker or activity changes. Assistant segments name the original harness. A result segment reports the result; an inference belongs to the agent entry that drew it. Later corrections form a new slice rather than rewriting the earlier fact.

Noter bodies have a 1,000-estimated-token limit, excluding the title and generated citation markers. Manual facts keep their size exemption. Material windows charge the complete rendering. The existing held-slot protocol is unchanged: Noter publication is atomic at normal termination; manual writes commit immediately. Optional support/negate relations remain available.

## Addresses and views

Navigation follows the identities printed by each view:

| Address | View |
| --- | --- |
| `T792` | Facts contributing to this Turn, with only its segments; legacy facts shown whole. Unprocessed entries appear as Raw, processed uncited entries as addresses. |
| `T792#E2` | One immutable native entry, including stored thinking and tool calls. |
| `T792#E2..E7` | Inclusive entry range, intersected with the selected path; branch gaps are allowed. |
| `T792#E2,T792#E7,T792#E2` | Explicit components in request order, preserving repetitions. |
| `T792@user`, `T792@assistant`, `T792@observation` | Raw entries of that role; an empty collection is valid. |
| `T792#E2@assistant` | The whole entry, with its role checked. |
| `F81` | Full fact segments and knowledge backlinks. |
| `K7`, `K7#qfzt` | Reader-visible current knowledge, or one exact tagged version. |
| `K7@v2`, `K7@v2..v4` | Numbered history or a comparison of two versions. |

A stored path remains authoritative even when it contains no entries of the requested Turn. `full` removes compression, never widens membership. Ordinary Turn views omit thinking from their pending-Raw supplement; `full: true` retains it. Direct entry, entry-range and role-filtered Raw reads include stored thinking, subject to their budgets.

The public grammar rejects block selectors (`@text`, `@thinking`, call IDs), `@toolResult`, `T792@F*`, E-list shorthand, fact intervals, `F81..`, `K7..` and global-commit addresses. A role filter belongs to its own address, not to every item in a comma list. `trace.layer` and `trace.tool` are removed; `search.layer` remains supported.

A fact backlink includes each knowledge identity once if any version cited that fact and its current version is visible to the reader. It points to the current version and identifies the citing ordinals, without historical bodies or version tags. An invisible current identity is omitted, not replaced by an older visible version. Archived current identities can have body-free backlinks.

Fact listings show titles. Search shows the title and a matching excerpt. Knowledge supports read through trace/search include fact IDs and titles; injected knowledge retains IDs only.

## Content and page budgets

Content limits apply independently of pagination. A Turn caps each Raw entry; a single entry caps each content block. Automatic Raw always budgets whole entries.

| Parameter | Default | Meaning of null |
| --- | ---: | --- |
| `itemBudget` | 2,000 | Disable this content ceiling. |
| `toolCallBudget` | 100 | Disable the additional call ceiling. |
| `toolResultBudget` | 100 | Disable the additional result ceiling. |
| `pageBudget` | 2,000 | Internal assembly only; public tools reject null. |

Configured Raw profiles supply content defaults. `itemBudget: null` alone does not remove the call/result ceilings. Set all three to null, or use `full: true`, for uncompressed content. `full` rejects conflicting finite content budgets. Labels, separators and omission markers count; insufficient space for required identity/framing is an error, not permission to cut an ID.

Pages have their own token budget and line cap. Public pages are capped at 8,000 estimated tokens, including receipts. Cursors freeze membership, path, annotations, profile and effective budgets. Continuations cannot change them or consume another reader's cursor. Oversized lines continue losslessly at Unicode code-point boundaries; follow the receipt's newline-joining rule.

Complete knowledge bodies expose their exact version tag only after the final fragment. Previews and body-free receipts expose no tag. There is no read-grant ledger: a tag identifies a version, while current-base, scope, evidence and claim checks independently control writes. For example, `trace({address: 'K12@v3', itemBudget: null})` still requires following every cursor to read the complete body.

## Historical data and source authority

Legacy fact bodies, authored source strings, actors, categories, statuses and quotes are not rewritten or backfilled into segments. Display resolves their historical selectors internally and prints only whole-entry addresses. Missing entry bindings and inconsistent stored segments fail as data corruption; they do not create an unresolved-source display state.

The host normalizes ordered blocks once at ingestion or upgrade. Core consumes this persisted authority rather than guessing native JSON shapes. Recognized legacy mapping failures retain the old projection, bytes and ordinals; unexpected decoder, database or I/O errors still fail initialization. Entry ordinals are allocated transactionally across all branches of a Turn and never renumber on navigation or reopening.

Reading thinking does not make it admissible fact evidence. New manual and Noter facts reject thinking-only entries; mixed entries remain usable for their non-thinking content. Automatic Noter, compaction and branch-carry material omit thinking. Injected summaries and non-text placeholders are not Raw evidence.

## Accounting

Pending-token status and trigger eligibility price joined bounded Raw views. Batch capacity additionally prices its full material framing, so an entry can fit the bare-Raw trigger total while exceeding a batch window. Facts and knowledge charge their full displayed forms, including titles and citations where those are shown. Address changes may move boundary crossings; neither the estimator nor the thresholds should be adjusted to hide that cost.

Scripted and simulated-provider checks establish local behavior, not live extraction quality, billing or cache reuse. Historical measurements remain in the [earlier verification record](unified-entry-verification.md); they are not measurements of the current format.
