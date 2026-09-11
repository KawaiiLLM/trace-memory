# Entry addresses and read budgets

Raw reads use stable Turn-local entry identities and the same ordered blocks as automatic memory material. Existing source bytes and fact citation strings are never rewritten.

## Addresses

The selection hierarchy is Turn → entry → content. These forms compose without introducing a query language:

| Address | Selection |
| --- | --- |
| `T792` | Entries of one Turn, in selected source order |
| `T792#E2` | One immutable native entry |
| `T792#E2..E7` | Inclusive entry interval; branch gaps are allowed |
| `T792#E2,E7` | Entry list, preserving order and repetitions |
| `T792#E2,E7@text` | Text projection of every selected entry |
| `T792@user`, `@assistant`, `@toolResult` | Complete messages of that role; an empty collection is valid |
| `T792@text` | Text blocks, including tool-result text, preserving entry boundaries |
| `T792#E2@thinking` | Actual stored, non-redacted thinking, only on explicit request |
| `T792#E2@opaqueCallId` | That entry's stored call or result fragment |
| `T792@F*` | Facts owned by the Turn, not facts merely citing it |

An E shorthand inherits its Turn. The trailing selector applies to the entire E selection. A complete T/F/K target begins a separate component: `T792#E2,E7@text,F81,K7@2`. Delimiter-containing or reserved call IDs use JSON quoting, for example `T792#E2@"call,with@delimiters"` and `T792#E2@"text"`. Quotes in ordinary project names do not activate call-ID scanning.

A stored branch path stays authoritative even when it contains no entries of the requested Turn or is explicitly empty. Only a read without a path, or legacy data without a stored path, falls back to all session occurrences. `full` never widens this membership.

Missing exact entries or fragments report errors. There are no generic globs, Boolean expressions, chained selectors, relative addresses or public `part` parameter. Fact intervals (`F81-F90`), negation walks (`F81..`), knowledge commits/diffs (`K7@2`, `K7@2..4`, `K7@2..K7@4`) and history (`K7..`) retain their separate grammar. Selected fact collections display in owning-Turn chronology, then ascending F IDs; mixed components retain request order. Knowledge collections retain category order.

## Content and page limits

`itemBudget` limits each child of the selected container, not the entire expression. A Turn caps each E separately; one E caps each content block; a selected fragment or semantic leaf is one item. Automatic Raw always budgets whole entries.

| Parameter | Default | Meaning of null |
| --- | ---: | --- |
| `itemBudget` | 2,000 | Disable this content ceiling |
| `toolCallBudget` | 100 | Disable the additional call ceiling |
| `toolResultBudget` | 100 | Disable the additional result ceiling |
| `pageBudget` | 2,000 | Internal assembly only; rejected by model-facing tools |

The configured Raw profile supplies the corresponding defaults. To remove **all** content ceilings, set all three content budgets to null; setting `itemBudget: null` alone retains the call/result ceilings. `full: true` is the compatibility alias for disabling all three and rejects a conflicting finite content budget. The legacy `tool` ordinal selector remains supported, but conflicts with a hierarchical selection. Search retains its independent `maxTokens` contract.

Labels, separators and omission markers count. A single entry with a selector still budgets each selected block, including multiple text blocks. Semantic previews include their owning group's first heading and separators; negation-walk items include indentation and terminal annotations before fitting the body.

IDs are never cut to make a cap fit; insufficient identity/marker capacity is an error. Automatic Raw preserves the existing staged policy: result payloads yield first, then call arguments, then text. Thinking is never added to automatic Raw bodies. Complete automatic facts and knowledge remain whole under their material windows; a 2k trace preview is not their supplied representation.

Pages have an independent token budget and line cap. Cursors freeze membership, path, annotations, profile and budgets. Continuation cannot change the content limits or consume another session/project's cursor. Search cursors may continue through trace, never the reverse. Oversized lines continue losslessly at Unicode code-point boundaries; follow the receipt's newline-joining rule. A completed truncated knowledge preview does not grant an exact write handle: the complete semantic body must reach the reader.

## Source authority and upgrades

The host normalizes its own ordered content blocks once at ingestion or upgrade. Rendering and exact source validation consume that persisted authority; core never guesses a host's raw JSON shape. Legacy projections without block proof retain their readable whole-entry and historical aliases, but cannot invent exact call/text/thinking fragments.

Entry ordinals are allocated transactionally across all branches of a Turn and stored with a unique Turn/ordinal index. Reopening, compaction and tree navigation do not rank or renumber entries. The stored ordinal avoids repeated read-time ranking and remains stable even when a sibling leaves a gap. Source membership metadata keeps coverage checks off large Raw bodies.

Legacy `#user`, `#assistant` and `#tN` retain their original projection meaning, and old facts keep their citation strings. New Noter guidance uses exact frozen E/block labels. Calls and results are separate entries linked by an opaque call ID; a dispatch alone is not completion evidence.

Citation resolution returns the actual entries and selected blocks once for eligibility, binding and completion. A whole mixed text/call entry cannot promote its dispatch to completed: every cited dispatch requires a cited corresponding result from the same Turn on this path. Explicit text sources remain valid evidence for text deliverables themselves; reported/dispatched events do not require results. Historical role aliases keep their text-projection meaning.

Non-text markers cannot establish text evidence. A legacy compaction summary is readable as a summary, never fabricated as a native source.

## Fork increments

The source index is an identity mapping over the complete frozen entry range, using the same entry/block addresses as Raw. It contains no body previews. A fork supplements only the selected path's last assistant entry when that entry belongs to the batch and its body was withheld from Raw; earlier assistant messages in the same Turn are not repeated.

A head body already supplied in Raw is never repeated in the supplement. Head and index framing count toward both episodic and model-context capacity; the supplied-body audit includes the head view.

## Accounting and verification

Noting triggers, batch selection and pending-status weights measure the same joined rendered entry bytes. Consolidation does the same for complete grouped facts. Thresholds (Noting 10k, Consolidation 5k), batch ceilings and material windows are unchanged. Longer exact addresses therefore legitimately move crossings and batch boundaries; the estimator and thresholds must not be adjusted to conceal that overhead.

The [verification record](unified-entry-verification.md) contains the fixed-fixture byte/token comparison and check logs. Offline fake-provider checks establish local behavior, not live provider quality, billing or cache reuse.
