# 21 — Commit reasons and knowledge topics

Label: ready-for-agent. Tracker: none configured; this file is the ticket.

Status: specified; held pending implementation authorization. Writing this ticket does not dispatch implementation. Committed baseline: `ea3db87` (20a shared material assembly). Ticket 20b/20c work is in progress in the worktree; implement against its accepted contracts rather than overwriting it or reverting its budgets.

This ticket records two user rulings: one `supports` list supplies a knowledge commit's fact evidence, with `reason` as its commit message; and versioned knowledge `topics` provide subject grouping independently of category. It supersedes the separate commit-level `because` fact array and the rule that an archive has empty supports. Fact fields, phase names, scope and native execution strategy are unchanged.

## Problem Statement

A knowledge commit currently has two fact-id arrays: `supports` for the resulting conclusion and `because` for facts that prompted the change. They often overlap, yet neither directly explains why the edit, merge or archive was chosen. Treating `because` as if it were already a human-readable commit message obscures its other role: it participates in evidence validation and path applicability, especially for archives whose supports are currently empty.

Knowledge also lacks a subject dimension. Categories such as constraint, mechanism and open describe the kind of knowledge, not whether it concerns the extraction module, database design or authentication. Related knowledge is mixed together unless a reader reconstructs the subject from each text.

The intended change is not a second taxonomy or evidence mechanism. Consolidator already reads existing knowledge and can reuse topic names visible there; core already renders knowledge, traces revisions and performs literal search. Extend those contracts rather than add a tagging agent, topic registry or host-specific knowledge browser.

## Solution

Every new knowledge operation carries a nonempty `supports` fact array and a nonempty `reason` string. Supports now means **evidence for this commit**, not necessarily an assertion that every cited fact agrees with the resulting prose. A create/update/merge must still have enough evidence for its complete resulting conclusion; an archive cites facts justifying its retirement. Reason explains the operation but cannot establish evidence or applicability.

Knowledge content commits also carry a `topics` string array. Labels describe subjects, can overlap and may be empty. They belong to the immutable revision, not the stable knowledge identity. Archive retains its parent's topics for historical navigation. Topic membership changes by a normal knowledge commit and never edits past revisions in place.

Core renders topics with knowledge and exposes them as structured revision data. Literal knowledge search matches topic labels as well as text, allowing a subject to retrieve knowledge whose prose uses different terms. Topic groups are a projection of the selected revisions; they do not replace category-first injection, change scope or confer citation rights.

## User Stories

1. As a user, I want one fact-reference list per knowledge commit, so that I do not have to distinguish two overlapping arrays.
2. As a user, I want a readable explanation of a commit, so that I can understand why knowledge changed without reconstructing intent from fact ids alone.
3. As a Consolidator, I want to state the full evidence for an updated conclusion, so that an update does not accidentally preserve only the newly added citations.
4. As a user, I want an archive to retain its factual justification, so that retirement remains traceable rather than becoming a deletion flag.
5. As a user, I want an archive based on a sibling-only fact to stay on that sibling's applicable path, so that unifying fields cannot retire knowledge elsewhere.
6. As a user, I want project/global evidence rules checked on every support, so that the new field semantics do not relax existing scope restrictions.
7. As a user, I want commit messages kept out of the evidence model, so that explanatory prose cannot manufacture a ruling or source.
8. As a user, I want all operations in a batch to remain atomic, so that a malformed reason or topic list cannot leave half a revision batch committed.
9. As a user, I want the two-submission review protocol retained, so that a new schema does not bypass Consolidator review.
10. As a user, I want concurrent stale-base updates still rejected, so that changing metadata cannot bypass the knowledge DAG's conflict rules.
11. As a user, I want existing commits and run audits retained, so that a field change does not rewrite my history or invent past commit messages.
12. As a user, I want knowledge grouped by subjects such as a module or database design, so that related knowledge can be found together despite different categories.
13. As a user, I want one knowledge item to belong to multiple subjects, so that cross-cutting design decisions are not forced into one folder.
14. As a user, I want category and topics to remain distinct, so that a database constraint is still a constraint rather than merely a database item.
15. As a Consolidator, I want to reuse topic names already visible in knowledge, so that each batch does not invent synonyms for the same subject.
16. As a user, I want genuinely new subjects allowed without configuration, so that topic assignment does not require a registry or manual enrollment step.
17. As a user, I want unclassified knowledge represented honestly, so that missing topics are not filled by unsupported guesses.
18. As a user, I want labels in the conversation's language and recognizable module terminology, so that topic names are understandable without automatic translation.
19. As a user, I want topic changes versioned, so that an old commit keeps its old classification when I trace it.
20. As a user, I want classification cleanup to use existing knowledge updates, so that no mutable global rename table silently changes unrelated commits.
21. As a user, I want knowledge search to find a topic absent from the conclusion text, so that labels provide an actual retrieval benefit.
22. As a user, I want archived and superseded matches labelled as history, so that topic search does not present retired knowledge as current.
23. As a user, I want multiple applicable tips shown separately even when their labels match, so that grouping does not become another largest-id-wins rule.
24. As a main agent, I want constraints to retain their context priority, so that topic grouping does not move important rules behind a large subject group.
25. As a user, I want topic labels counted in the existing knowledge budget, so that adding metadata does not quietly exceed the context ceiling.
26. As a maintainer, I want identical selected knowledge and topics rendered identically across consumers, so that host implementations do not diverge or spoil a stable prefix.
27. As a user, I want related facts reachable through a knowledge commit's supports, so that facts do not need a duplicate topic field for this feature.
28. As a user, I want partial or concurrent topic naming to remain a recoverable classification issue, so that imperfect labels never break evidence or business commits.

## Implementation Decisions

### Unified evidence and commit messages

- **One evidence field.** New create, update, merge and archive operations require nonempty, valid fact references in `supports`. Remove the commit-level `because` array from new write input. Reject the removed field by name rather than silently ignore it, parse it as a reason or retain two active write schemes.
- **Commit meaning.** Supports can include affirmative evidence, changed circumstances, corrections and withdrawal facts needed to justify the operation. For content-producing operations, the complete resulting conclusion must remain grounded; citing only a trigger does not replace the need for evidence for the text. Do not require all cited facts to agree with each other or derive truth from the field's name.
- **Complete replacement.** Each content commit supplies its full support set, not only additions relative to its parent. Keep evidence needed to explain the resulting conclusion and determine where this change applies. Do not carry unrelated old citations merely to preserve a numerical union forever.
- **Reason string.** Require a string with non-whitespace content for every operation. It describes the change and why it was chosen: initial admission, substantive correction, merge, topic-only cleanup or archival. It is not a new durable claim and has no authority independent of supports. It may mention addresses for explanation, but core never parses those mentions into citations.
- **No reason overloading.** Reason cannot establish scope, applicability, accounting coverage, human adoption or a completion level. Do not apply the knowledge-text rule against embedded ids to the commit message; do not use numbers in a reason to satisfy or trigger the conclusion's numeric-evidence diagnostic.
- **Skipped unchanged.** `skipped[].because` is already a textual explanation for a declined range fact, not the commit-level fact array being replaced. Keep that protocol unchanged; do not perform a repository-wide replacement of every property named because.

### Archive and path safety

- **Archive evidence.** Archive accepts target, supports and reason. It writes a new immutable archive revision with those supports retained; it no longer clears them. Scope, category and topics come from the selected parent revision, with no new knowledge body. Supplying replacement text, scope, category or topics to archive remains an inapplicable-field error.
- **Applicability.** All new commits use the same supports for scope validation and entry-aware path applicability. Every cited fact from the writer/reader's own session constrains the applicable ancestry through its concrete source entries; foreign-session citations retain the existing session/project/global matrix. There is no separate reason-based path and no substitution of the worker's frozen head for evidence applicability.
- **Branch scenario.** An archive whose only basis is a withdrawal fact on branch A applies on A. Branch B before that fact retains the former active commit. A withdrawal fact from a shared ancestor may make the archive applicable on both paths. Topic labels and the text of the reason cannot change this result.
- **Unchanged DAG.** Keep stable K identities, immutable revision ids, parent/merge links, stale applicable-base checks and path-selected tips. Topic or reason changes do not grant permission to update an archived/inapplicable target or choose one of several tips silently. Historical text and facts remain readable.
- **Accounting adaptation.** Preserve the resulting-active-knowledge accounting rule, with one narrow addition: a range fact cited by a successfully applied archive in this batch is accounted for as archival evidence. It need not also appear in skipped solely because an archive has no active conclusion. Candidate-only, rejected or historical archive citations do not satisfy current accounting; reason and topics never satisfy it. This does not reactivate archived knowledge or turn all historical citations into current coverage.
- **Review cues.** Negation reminders continue to inspect structured fact references, now the unified commit evidence. They are cues to reconsider a commit, not proof that its whole conclusion is false; a negated support may have justified a change rather than affirmed every word. NEAR/CLOSER and conclusion diagnostics remain based on knowledge text and facts, not similarity between commit messages or topic names.

### Versioned topics

The operation schema makes replacement versus inheritance explicit:

| Operation | Topics behavior |
| --- | --- |
| create | Required array; an empty array means unclassified |
| update | Required complete replacement array; an empty array explicitly clears labels |
| merge | Required complete topic set for the surviving result; no implicit union of every parent's tags |
| archive | Not accepted in the operation; inherit the selected parent's array |

- **Revision ownership.** Persist labels on the knowledge revision, never as mutable fields of the stable K identity and never on facts. A topic-only edit uses an ordinary update with the complete unchanged text/category/scope/evidence and a reason describing classification cleanup. No metadata-only bypass around review or conflict checking is introduced.
- **Label validation.** Accept strings only, trim surrounding whitespace, reject empty labels and normalize exact duplicates into a deterministic set order. Keep case, language and substantive spelling intact. Do not equate synonyms, translate labels, infer hierarchy from punctuation or introduce a primary-topic meaning based on array order.
- **Reuse first.** Consolidator reads topics beside the knowledge already supplied and prefers those exact names for the same subject. Use concrete module names or recognizable domain terms, not category words masquerading as subjects. Add a new label when existing visible labels do not describe the subject; allow an empty list rather than force an arbitrary label.
- **Bounded awareness.** Fully rendered individual knowledge is not proof that all knowledge or all topic names fit the prompt. Do not inject an unbounded independent topic catalog to compensate. Explicit reads can provide more context when needed; budget omissions and concurrent label creation may still produce near-synonyms.
- **Gradual cleanup.** Synonym cleanup is ordinary Consolidation maintenance of selected knowledge, with a reason and preserved evidence. It is not a global mutable rename, a mass rewrite on every run, a new agent duty or a requirement for the main agent to maintain a taxonomy. No claim of globally unique topic names is made.
- **Classification only.** Topics neither declare a project nor alter scope, evidence permissions, knowledge lifecycle, extraction eligibility or processing progress. Sharing a label never merges K identities or makes a sibling fact citable.

### Rendering, grouping and search

- **Shared knowledge view.** Include the revision's topics with its text, category/scope, exact commit address and supports in the common core knowledge renderer. Labels must be clearly metadata, not appended into the conclusion as new factual prose. All automatic consumers use that shared rendering through 20a.
- **Commit history.** Show reason in commit trace/history and run operation results. Knowledge diff reports reason, topic and evidence changes even when the conclusion text is unchanged. Keep routine automatic knowledge blocks compact: reason is commit-history metadata, not a requirement to repeat every commit message in each injection.
- **Group projection.** Expose topics in structured knowledge reads so consumers can group selected applicable revisions without parsing text. A topic group contains references to the original exact commits, not cloned knowledge records. One commit can occur in several topic groups; no-topic items remain available as unclassified. A core grouping/read projection can be added to the existing facade without a new model tool or slash command; a standalone topic-browser UI is not required here.
- **Literal retrieval.** Extend knowledge-layer search to match topic labels even when the label is absent from the conclusion. Use the same literal substring semantics and escaping as existing text search. Match label text, not JSON punctuation or escape syntax. A hit on several labels or on both text and labels returns one result per exact commit before normal pagination.
- **History and scope.** Explicit search/trace remain unrestricted and retain their historical/applicable/superseded labels. Automatic material still uses the reader's scope/path-selected knowledge. Grouping never collapses divergent applicable tips just because their subjects match. Searching a reason as a new indexed field or inventing topic addresses is not necessary for this ticket; reasons remain reachable through commit history.
- **Priority and budgets.** Topic grouping is a read organization feature, not a change to category-first automatic injection. Do not duplicate a multi-topic commit inside the automatic knowledge budget. Count rendered labels and metadata within Ticket 20's effective knowledge cap and omission policy, and preserve its stable knowledge-first ordering. Topic rendering must not introduce run ids, clocks or task ranges into the leading block.

### Storage and compatibility

- **Additive, bounded change.** Support the immediately preceding committed schema with the smallest atomic additive upgrade needed for revision reason/topics and archive evidence. Do not create a general migration framework or attempt to import every earlier incompatible development database. Never delete or silently reset a user's database to perform this feature.
- **Old evidence retained.** Existing revision rows, ids, parents, scopes, supports/because values and exact run requests/responses remain unchanged. For legacy revisions, effective commit evidence remains the union of their original supports and because references wherever applicability or citation display requires the new semantics. A shared read compatibility rule must preserve old archive and sibling-path behavior; dropping old because at read time is not a migration.
- **Missing metadata honest.** Old revisions have no authored commit message or topic assignment. Render reason as unavailable when necessary and topics as empty/unclassified. Do not invent a reason from cited fact text, auto-classify all history on open, or rewrite historical tool payloads to look like the new schema.
- **New writes canonical.** New revisions use supports, reason and topics exclusively. A legacy because storage column may remain for historical reads but receives no new commit evidence. Do not infer the data generation solely from an empty supports list: new archives now have supports, and old data may contain empty lists.
- **Atomicity.** A malformed reason, bad topic label or invalid support rejects the entire batch before business writes. Revision metadata, resulting knowledge, exact fact progress, run audit and applicable deliveries commit together. Failure/rejection/cancellation and postcommit success-with-problems retain existing semantics.
- **Core ownership.** Evolve existing model/schema validation, store operations, facade reads and common renderers. Hosts receive the updated tool schema and prepared text; no host-specific reason/topic model, extra dependency, queue, tagging service or second provider loop is needed.

## Testing Decisions

Use the established public TraceMemory facade with a temporary real SQLite database, plus the existing fake Pi/native host seam where tool-schema or prepared-text delivery needs to be observed. Reuse existing knowledge DAG, path-entry, atomicity, shared-material and renderer tests. No paid model call or new concurrency harness is required.

Acceptance scenarios:

1. **All operations.** Create, update, merge and archive accept valid supports/reason; the content operations require a complete topics array. Archive inherits its parent's topics and stores its own nonempty supports. Omitted, wrongly typed or empty required values reject the whole batch.
2. **Retired field boundary.** A new operation with commit-level because is rejected by name, including when new fields are also present. Existing skipped explanations still work unchanged.
3. **Full evidence.** Updating knowledge requires evidence for the complete result; relations may include correction/withdrawal context without being treated as automatically contradictory or invalid. A reason mentioning F ids neither adds supports nor makes an otherwise empty support set valid.
4. **Archive isolation.** Create shared-ancestor knowledge, archive it using an A-only fact and read A/B/ancestor paths. A sees retirement; B and the ancestor retain the old applicable commit. Include multiple source entries in the same Turn so Turn-only checks cannot pass incorrectly.
5. **Scope matrix.** Session/project/global citation boundaries apply to every new support, including archive and topic-only edits. Topic names and commit-message claims cannot bypass them. Shared-ancestor-only evidence retains cross-branch applicability.
6. **Review and atomicity.** The first valid memory submission commits nothing; only the reviewed second submission commits. Make one reason, topic or support invalid among otherwise valid operations and assert no partial knowledge, progress or delivery. Postcommit provider/audit problems preserve success.
7. **Conflict handling.** Race a topic-only update with another update/archive on the same applicable base. The stale batch rejects as before. Divergent sibling commits and several applicable tips retain their existing semantics.
8. **Archive accounting.** A range withdrawal fact cited by a successfully committed archive is accounted for without a duplicate skipped entry. A rejected/candidate-only archive, an address in reason or a matching topic does not provide that coverage; unrelated uncited user facts still produce the existing diagnostic.
9. **Reason rendering.** Commit trace/history and diffs show authored messages without presenting them as conclusion evidence. A reason-only change is visible even with unchanged text. Routine material does not duplicate the entire commit history, and numeric/text diagnostics are not accidentally run on the reason.
10. **Topic validation.** Multiple labels, empty arrays, surrounding whitespace, duplicates, malformed arrays and empty labels follow the declared normalization. Reordering the same exact topic set yields stable rendered metadata. No automatic case folding, translation or synonym merge occurs.
11. **Topic versioning.** Change topics without changing text. Old exact commits retain old labels; the new applicable commit has the replacement list. Clearing topics is explicit, merge supplies the survivor's full set, and archive retains classification for historical reads.
12. **Grouping and retrieval.** Put knowledge of different categories under one topic and one knowledge commit under two topics. Structured reads support both groups without cloning K identities. Search by a topic absent from text finds the correct commit; multiple matching labels do not duplicate results or pagination entries.
13. **Literal edge cases.** Topic labels containing Chinese, spaces, percent, underscore, quotes or backslashes match literal label content under existing search semantics, not serialized JSON syntax. Empty topics do not hide otherwise searchable knowledge.
14. **Path-aware presentation.** Matching topic labels on sibling-only, historical, archived and multiple-tip knowledge do not alter applicability. Explicit reads retain their history labels, automatic injection excludes inapplicable revisions, and grouping does not choose the largest id.
15. **Shared material and budget.** Noter, Consolidator, initial injection and compact all receive topics through the same core renderer. Large topic metadata is included in the knowledge budget; multi-topic membership does not multiply automatic copies. Identical selected revisions/topics yield the same leading bytes when only Raw/range changes.
16. **Legacy database.** Open a database from the immediately preceding schema containing active, merged and archived revisions with distinct supports/because lists. Upgrade atomically without changing original rows or run payloads. Effective legacy evidence still preserves path decisions; missing reason/topics remain honest. Reopen is idempotent and a new canonical commit can reference an applicable legacy parent.
17. **No added maintenance system.** Facts and note input have no topics field; the main agent has no new duty; the tool count remains four. No independent topic catalog is injected, no model is called merely to upgrade storage, and synonym ambiguity does not become a business rejection.

Behavioral revert probes should fail if archive clears supports again, any applicability reader ignores legacy because, reason text becomes a citation source, topics are stored mutably on K rather than revisions, labels bypass the budget, or topic search returns duplicate hits for one commit.

## Out of Scope

- Fact-level tags/topics, rewriting Raw, changing Fact support/negate relation semantics or adding a new memory layer.
- Topic ids, a registry, hierarchy, controlled vocabulary, synonym/translation service, embeddings or a dedicated classification worker.
- Global topic-renaming commands, a new sidebar/dashboard, or a fifth model-facing tool.
- Replacing category-first injection with topic-first context allocation or changing Ticket 20's trigger/batch/compaction rules.
- Renaming Consolidator to Memorizer, changing native execution/cache identities, or adding thinking-level configuration.
- Rewriting historical commits/audits, inventing past reasons/topics, importing arbitrary obsolete database schemas, or automatic data deletion.
- A reason length/quality score, semantic proof of correctness, or a parser that promotes ids mentioned in prose into evidence.

## Further Notes

**Why knowledge topics, not fact tags.** The user's concrete need is to organize durable module/database knowledge that is otherwise mixed by category. The knowledge revision is the right level; its facts remain reachable through supports. This avoids duplicating topic assignment on every Raw-derived fact before the stable subject is known.

**Naming consistency is best effort.** Existing knowledge often supplies enough examples for Consolidator to reuse labels. It does not guarantee a complete vocabulary: budgets, scope and concurrent work can hide other names. Prefer visible names and ordinary later cleanup over a registry introduced solely to prevent every possible synonym.

**Implementation starting points.** Commit validation and operation preparation are in `core/consolidation/commit.ts`, review/commit binding in `core/consolidation/memory.ts`, and revision storage/applicability in `core/store/index.ts`. The shared field/schema types live in `core/model/index.ts` and `core/api/tools.ts`; revision rendering and consumer assembly are in `core/render/index.ts` and `core/render/material.ts`. Reuse the current read facade for search/group projections. These are baseline pointers, not permission to overwrite concurrent 20b/20c work.

**Synchronization.** Update the glossary, main specification, Consolidator instructions, memory tool schema/help, commit examples, host-facing prepared material and regression fixtures together. In particular, replace “supports proves only the new text” with “supports supplies the commit's evidence, including the complete result's basis”; remove new-write commit because; and remove the archive-empty-supports exception. Historical reports and exact old run payloads remain historical.

This local ticket is the specification artifact. No implementation files were changed and no external tracker issue was published.
