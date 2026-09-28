# Testing

What the long-term suite in `tests/` keeps, where a ticket's own evidence goes, and how tests build their data. A change that conflicts with this file updates this file first.

## What the suite protects

A long-term test protects one of these:

- **Tool contracts.** What `note`, `memory`, `trace` and `search` accept, reject and return, by structure.
- **Host delivery.** What reaches the model on each host: injection, compaction, carriers and their accounting.
- **Storage.** Migrations, atomic publication and rollback, idempotence, and preservation of existing rows.
- **Ruled performance bounds.** Tickets 79, 80, 87, 88 and 104, and Claude Code's 100 ms heartbeat gate.
- **A real regression.** A defect a user or a review found, reproduced at the boundary where it occurred.

It does not protect:

- the wording of rendered text, beyond one snapshot per view kind;
- private call order, internal helper shapes or accidental defaults;
- a restatement of the implementation's own logic.

A low-risk, reversible change does not get a new test only to have one.

## Rendered text

Each view kind keeps one snapshot test: Turn, entry or entry range, fact, knowledge, search page and injection block. Every other test asserts structure: ids, order, roles, counts, token totals and rejection reasons. It reads the field it checks rather than comparing the whole string.

## Rulings

A ruling an implementation could silently deviate from has a named test in `tests/core/api/rulings.test.ts`. When a ruling is superseded, the same change deletes its test rather than migrating it, and the superseding ruling gets its own test.

## A ticket's evidence stays with the ticket

Probes, native-host runs, benchmarks and acceptance reproductions written for one ticket live in that ticket's working directory, not in `tests/`. A ticket adds to `tests/` only what "What the suite protects" covers, in the test file of the module it concerns. Test files are named after a module or a behaviour, never after a ticket.

## Test data

Tests build sessions, Raw, facts and knowledge through the shared builders in `tests/support/`, the one place that knows the public write shape. A legacy fact is seeded with its entry bindings, as production rows have them. A test calls `note` or `memory` directly only when that tool's contract is what it tests.

## When a change breaks tests

Classify each failure before touching it:

- **Product defect:** fix the product.
- **Obsolete test:** the contract it protects was superseded, so delete it and name the superseding ruling or change in the commit.
- **Old-shape data:** fix the builder, not each test.

Never weaken an assertion on a contract that still holds.
