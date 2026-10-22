# Testing

What the long-term suite in `tests/` keeps, where a ticket's own evidence goes, and how tests build their data. A change that conflicts with this file updates this file first.

## What the suite protects

A long-term test protects one of these:

- **Tool contracts.** What `note`, `memory` and `search` accept, reject and return; what `trace://` paths render before host-native pagination.
- **The workspace file contract.** What `src/core/workspace/` accepts, refuses and publishes for each task kind: the block format and its parse errors, the operations a task may write, caps and host-measured lengths, references that must resolve, and the Store effects of apply (identities, merge and split lineage, stale refusals).
- **Host delivery.** What reaches the model on each host: injection, compaction, carriers and their accounting.
- **Storage.** Migrations, atomic publication and rollback, idempotence, and preservation of existing rows.
- **Ruled performance bounds.** Tickets 79, 80, 87, 88, 104 and 136 (a project-sized Raw search with code), and Claude Code's 100 ms heartbeat gate.
- **A real regression.** A defect a user or a review found, reproduced at the boundary where it occurred.

It does not protect:

- the wording of rendered text, beyond one snapshot per view kind;
- private call order, internal helper shapes or accidental defaults;
- a restatement of the implementation's own logic.

A low-risk, reversible change does not get a new test only to have one.

## Rendered text

Rendered-output tests assert structure: ids, order, roles, counts, token totals and rejection reasons. A test reads the field it checks rather than comparing unrelated surrounding text; a complete-body delivery test compares the complete body after validating the host's framing.

## Rulings

A ruling an implementation could silently deviate from has a named test in `tests/core/api/rulings.test.ts`. When a ruling is superseded, the same change deletes its test rather than migrating it, and the superseding ruling gets its own test.

## A ticket's evidence stays with the ticket

Probes, native-host runs, benchmarks and acceptance reproductions written for one ticket live in that ticket's working directory, not in `tests/`. A ticket adds to `tests/` only what "What the suite protects" covers, in the test file of the module it concerns. Test files are named after a module or a behaviour, never after a ticket.

## Test data

Tests build sessions, Raw, facts and knowledge through the shared builders in `tests/support/`, the one place that knows the public write shape. A legacy fact is seeded with its entry bindings, as production rows have them. A test calls `note` or `memory` directly only when that tool's contract is what it tests.

A test that needs a Noter run scripts the model with `tests/support/noter.ts` (`scriptedNoter`, `submit`, `verifyUnchanged`, `submitEmpty`): it calls `check`, writes the two workspace files and meets the stop hook, as a host's model does, and the test states only WHAT is written (facts as `{title, sources}`, operations as `memory` inputs, or raw file text). `submit` writes one file per step and consumes the step-advance message; `probe` reads what `check` says about an invalid file without spending the step's repair. Each batch is two runs (write, then verify) and eight requests on a Pi wire (`NOTER_BATCH_REQUESTS`).

## Running performance tests

Run each performance test file in its own Vitest process, one at a time: `core/api/search-performance.test.ts`, `core/api/ticket-80-append-performance.test.ts`, `hosts/cc-67-performance.test.ts`, `hosts/cc-70-performance.test.ts`, `hosts/cc-performance.test.ts` and `perf-fixture.test.ts`. Run together in one invocation they compete for CPU, which has pushed the 100 ms heartbeat gate to 115–556 ms without a regression.

## When a change breaks tests

Classify each failure before touching it:

- **Product defect:** fix the product.
- **Obsolete test:** the contract it protects was superseded, so delete it and name the superseding ruling or change in the commit.
- **Old-shape data:** fix the builder, not each test.

Never weaken an assertion on a contract that still holds.
