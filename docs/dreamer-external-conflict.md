# Dreamer path competition and exact processing

## Path-write rule

Every knowledge operation names immutable exact bases. Inside the write transaction, core rechecks every update, archive and split base and both merge parents against direct consuming update, archive, split and `merged_into` edges.

The comparison authority is the run's admitted trigger origin: the target memory-session identity and ordered native `source_entries.id` prefix through the exact trigger entry. Equal origins and either prefix direction are comparable and cannot produce competing consumers. Valid non-prefix origins in the same target session are divergent sibling paths and may derive independently, even when shared evidence makes the first result applicable on both paths. Independent target sessions retain the applicable-successor stale check. Applicability does not include trigger provenance.

Origins are never recomputed from current branch rows, Turn identity, timestamps or executors. Retries and reads do not move them. If a historical origin is absent and the decision depends on ancestry, the write fails explicitly instead of guessing.

A whole atomic batch rolls back on a refused base. Consolidator may completely read an applicable current successor, reconsider the same frozen facts and submit normally against that exact version. It receives no extra facts, family expansion, applicability bypass or neutral outcome; an unresolved refusal is an ordinary failure.

## Dreamer candidate and event rules

Final acceptance constructs candidates in core from:

1. exact formally supplied processing versions; and
2. every legitimate descendant committed by this retained Dreamer run from those versions.

The model does not enumerate candidates. Arbitrary reads, processed reference material, outside successors and writable-family membership add none.

Core rechecks the committed global successor graph in the final transaction. Only candidates with no consuming successor of any kind receive a new exact-version certificate. Unchanged supplied leaves, both own split children and own archive-state leaves qualify. Consumed supplied versions and own intermediates do not. Existing historical certificates are never removed.

Each formally supplied event is judged independently. An accepted candidate or core-verified consumption of its selected base accounts for that event. Success settles exactly those accounted event IDs and certifies the separate successor-free candidate IDs. The consuming rival and its own event are not adopted, settled or certified. Thus an all-consumed batch may succeed with an empty certificate set and close immediately.

A transaction refusal is forgivable only when its structured base/successor identities still match a committed consuming edge for a formally supplied version. Model text cannot manufacture the exception. A later invalid batch replaces that refusal state and still fails; earlier legal batches remain audited and committed but uncertified until a final success.

## Narrow neutral outcome

`conflict` remains only when an independently verified post-freeze successor of **reference-only processed material** is the sole remaining acceptance blocker after event accounting and leaf filtering. It is Dreamer-only and requires the live claim/range/execution capability. Provider, request, tool, validation, scope or processed-cap failures are never hidden by it.

Conflict adds no settlement or certificate and neither increments nor resets the logical-task failure streak. Cancellation and lost ownership remain cancellation. Consumed formal input is not conflict; it follows normal success semantics and resets that task's streak.

## Restored versions and scheduling

Pending processing is the union of applicable unsettled events, unfinished retained obligations and currently applicable uncertified exact versions not already represented by those events. This discovers an uncertified predecessor restored by navigation even if its historical event was settled. A restored certified predecessor is not new work. The projection deduplicates by stored identity; it resets no settlement and creates no synthetic event.

Retained event and version obligations, original anchor, path and writable family stay immutable. Admission resolves their current results and selects whole shared-result components within the existing 10,000-token changed-material cap. An oversized component is never partially supplied and does not pin an independent fitting retained component. Numeric triggers, logical-task identity, compaction protection and footer counts read the same exact-version projection.

Worker completion and tree navigation launch nothing. A later eligible entry completion or existing bounded compaction recovery may admit pending work. Repeated unchanged blocked work does not create a polling or retry loop.

## Atomic finalization

The final immediate transaction rechecks claim ownership, retained path, committed graph, host-derived candidates and all shared processed caps before writing the run outcome, exact event settlements, exact certificates, completion and execution settlement. Repeated settlement is idempotent. Failure, cancellation, unfinished execution and neutral conflict add neither settlement nor certification.

No foreground delivery predicate is changed here; that belongs to Ticket 34c.
