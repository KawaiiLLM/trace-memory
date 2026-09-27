# Engineering lessons

Before adding, changing or deleting a test, read [`docs/testing.md`](docs/testing.md): what the suite keeps, where a ticket's evidence goes, and how tests build data.

- **Validate before scaling.** Before a broad migration, prove the approach on representative success and failure cases, then reuse it across the affected code.
- **Preserve contracts, not obsolete setup.** When tests break, distinguish changed requirements from invalid fixtures. Repair setup without bypassing required checks, manufacturing lifecycle outcomes, weakening assertions, or skipping guarantees that still apply.
- **Test the boundary you claim.** An upstream rejection does not prove downstream validation or transaction rollback. Exercise the intended boundary and assert its observable effects.
- **Parallelize coherent work.** Divide independent changes into non-overlapping ownership groups with focused handoffs. Review representative changes early, then validate the integrated batch; local green tests alone do not establish completion.
