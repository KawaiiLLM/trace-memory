# Ticket 67 cutover

Code validation does not authorize deployment. Pi loads repository source directly: changing its live checkout can change newly spawned workers before their foreground sessions restart. Keep implementation and testing in isolated worktrees until a coordinated cutover is approved.

## Stop, back up, convert

1. **Stop every shared-database executor.** Exit all Pi and CC hosts and their memory workers. Prevent Hooks or replacement executors from reopening the database. Confirm there are no remaining database users; one stopped foreground is not sufficient.
2. **Take a consistent backup.** Back up the latest database through SQLite's backup interface, plus installed plugin files and both hosts' configuration. Record paths and candidate commit. Do not copy just the main database file if WAL sidecars are present; never delete sidecars as a shortcut. Check the backup's integrity and foreign keys before changing the original.
3. **Install the validated code.** Update the Pi checkout and rebuild/install the matching CC bundle while executors remain stopped. Preserve phase models, credentials and all existing participation settings. Do not mix old and new executors.
4. **Convert explicitly.** Using a maintenance SQLite connection to the intended database, run `PRAGMA journal_mode = WAL` outside a transaction. Require the returned mode to be `wal`, then close the maintenance connection. For this existing production database, complete the first conversion here rather than leaving it to a worker's first open. If conversion fails, stop and report it rather than proceeding or substituting another database.
5. **Upgrade and verify before restart.** With every executor still stopped, open and close the candidate Store once in a maintenance process. This applies the new partial index and any required schema migration, including its one-time full foreign-key check, before multiple workers compete to open it. Confirm `PRAGMA journal_mode` returns `wal`. Record the backup, migration result, conversion result and installed commit before restarting hosts. Verify imports, foreground responsiveness and actual N/C/D progress separately; a live process or successful MCP initialization is not readiness.

Store requests and verifies WAL on every file-database open, before its schema transaction. New installations therefore start in WAL; an already-WAL file remains WAL. In-memory Stores keep SQLite's MEMORY mode. Failure to obtain WAL is an explicit open error, not a silent fallback. Opening an unconverted DELETE file with the new code can convert it: the stopped-executor procedure above, not a permanent ban in Store, controls the first production conversion. WAL still serializes writers and does not prove that long transactions or repeated projections have been repaired.

## Validation boundaries

- **Schema open:** an unchanged schema must not run a full foreign-key scan. An actual schema migration validates foreign keys once before the atomic commit; failure rolls back. Ordinary foreign-key enforcement remains on.
- **Concurrency:** synthetic tests use separate processes to read during a write and write during a read in WAL initialized by Store. They do not certify production conversion, real-host recovery or model behavior.
- **Rollback:** stop all executors again before restoring. Treat the database and any WAL state as one SQLite-managed unit; do not attach old sidecars to a restored file or downgrade pre-64 executors against a post-64 database.

No production conversion or deployment is performed by the ticket's implementation tests. Native Pi/CC and real-model checks must be reported independently from offline tests.
