import { expect, test } from "vitest";
import { copyFileSync, existsSync, unlinkSync } from "node:fs";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { fixture, say } from "./native-fixture.ts";
import { host } from "./test-host.ts";

// Ticket 84: `synchronous=NORMAL` accepts that a power loss or OS crash can roll the database back
// to an earlier committed state while Pi's own session JSONL (and this extension's own persisted
// state, appended as a custom entry in that same file) stay at whatever they last reached. This
// simulates exactly that gap — not real WAL/power semantics, but the maintainer's stated acceptance
// test: restore an earlier copy of the database while the host-side files stay latest, start the
// host, and require no operator step.

/** Copy (or restore) every WAL-mode SQLite file that exists for `dbPath`. A suffix absent at the
 * destination is removed, so a restore leaves exactly the source's file set. */
function copyDbFiles(from: string, to: string): void {
  for (const suffix of ["", "-wal", "-shm"]) {
    const src = `${from}${suffix}`, dst = `${to}${suffix}`;
    if (existsSync(src)) copyFileSync(src, dst);
    else try { unlinkSync(dst); } catch { /* nothing to remove */ }
  }
}

test("84: restoring an earlier database copy while the native session stays latest re-imports lost Raw and re-arms the rolled-back Note, automatically", async () => {
  const quiet = { "noting.triggerTokens": 1_000_000_000, "consolidation.triggerTokens": 1_000_000_000 };
  const f = await fixture(quiet);
  try {
    f.script(() => say("answer"));

    // Turn 1, Noted before the snapshot: this work must survive the restore.
    await f.turn("FIRST");
    const store = f.h.memory.store;
    const headTurnId = () => store.listTurns(1).at(-1)!.id;
    const turn1Entries = store.listSourceEntries(1);
    expect(store.hydrateSourceEntries(turn1Entries.map(e => e.id)).map(e => e.text)).toEqual(["FIRST", "answer"]);
    const notedTurn1 = store.commitNotingRun({ run: { kind: "manual", sessionId: 1, branch: "main", createdAt: "before-snapshot" },
      entryIds: turn1Entries.map(e => e.id), facts: [] });
    if (!notedTurn1.ok) throw new Error(notedTurn1.problems.join("; "));
    expect(store.pendingEntries(1, "main", headTurnId())).toEqual([]);

    // The restore point: a copy of the database exactly as it stands after turn 1's import and Note.
    const dbPath = f.h.dbPath, snapshotPath = `${dbPath}.snapshot`;
    copyDbFiles(dbPath, snapshotPath);

    // Turn 2, Noted after the snapshot: this is the work an OS crash or power loss may roll back.
    // The real Pi session file (and this extension's own state entry inside it) both advance past
    // the snapshot, exactly as production files would.
    await f.turn("SECOND");
    const turn2Entries = store.pendingEntries(1, "main", headTurnId());
    expect(store.hydrateSourceEntries(turn2Entries.map(e => e.id)).map(e => e.text)).toEqual(["SECOND", "answer"]);
    const notedTurn2 = store.commitNotingRun({ run: { kind: "manual", sessionId: 1, branch: "main", createdAt: "after-snapshot" },
      entryIds: turn2Entries.map(e => e.id), facts: [] });
    if (!notedTurn2.ok) throw new Error(notedTurn2.problems.join("; "));
    expect(store.pendingEntries(1, "main", headTurnId())).toEqual([]);
    const sessionFile = f.manager().getSessionFile()!;

    // The crash: the database rolls back to the snapshot. The real Pi session file is untouched —
    // it still holds turn 2 and this extension's own latest saved state, exactly as production
    // leaves it after a power loss or OS crash.
    await f.h.emit("session_shutdown", { reason: "quit" });
    copyDbFiles(snapshotPath, dbPath);

    // Restart: a fresh host and a freshly reopened session manager, no operator step, reading the
    // same (unrolled-back) session file against the rolled-back database.
    const manager = SessionManager.open(sessionFile);
    const restarted = host({ ...quiet, dbPath }, { native: () => manager, fetch: false });
    try {
      await restarted.emit("session_start");
      const restartedStore = restarted.memory.store;
      // Missing Raw (turn 2, rolled back with the snapshot) is re-imported from the session alone.
      const sources = restartedStore.listSourceEntries(1);
      expect(restartedStore.hydrateSourceEntries(sources.map(e => e.id)).map(e => e.text))
        .toEqual(["FIRST", "answer", "SECOND", "answer"]);
      // Turn 1's Note commit predates the snapshot and survived: its entries are not pending again.
      // Turn 2's Note commit was rolled back with the snapshot: its (re-imported) entries are
      // pending again, so an ordinary Noting trigger will simply redo that work.
      const pendingAfterRecovery = restartedStore.pendingEntries(1, "main", restartedStore.listTurns(1).at(-1)!.id);
      expect(restartedStore.hydrateSourceEntries(pendingAfterRecovery.map(e => e.id)).map(e => e.text))
        .toEqual(["SECOND", "answer"]);
      // The rolled-back run's own record is gone with it; nothing here claims to recover its spend.
      expect(restartedStore.listRuns(1).filter(run => run.kind === "manual")).toHaveLength(1);
    } finally { await restarted.dispose(); }
  } finally { await f.dispose(); }
});

test("84 edge case: restoring a database copy from before this session's own creation reallocates a fresh core session, automatically", async () => {
  const quiet = { "noting.triggerTokens": 1_000_000_000, "consolidation.triggerTokens": 1_000_000_000 };
  const f = await fixture(quiet);
  try {
    // The restore point: the database exactly as it stood before this Pi session's core session
    // ever existed -- captured right after the fixture's own observer opened it (and created the
    // schema), before this session's very first restore.
    const dbPath = f.h.dbPath, presessionSnapshot = `${dbPath}.presession`;
    copyDbFiles(dbPath, presessionSnapshot);

    // An explicit choice, made while still provisional (before any turn) -- not merely the default
    // -- this is the "user's persisted enrollment choice" recovery must carry forward.
    await f.h.commands.get("trace")!.handler("on", f.h.ctx);

    f.script(() => say("answer"));
    // Turn 1: creates the core session and imports Raw. All of this is the work an OS crash or
    // power loss reaching back to before this session's own creation would roll back.
    await f.turn("FIRST");
    const store = f.h.memory.store;
    const turn1Entries = store.listSourceEntries(1);
    expect(store.hydrateSourceEntries(turn1Entries.map(e => e.id)).map(e => e.text)).toEqual(["FIRST", "answer"]);
    const sessionFile = f.manager().getSessionFile()!;

    // The crash: the database rolls back to before this session ever existed. Pi's own session
    // file (and this extension's own state entry inside it) stay at their latest state, exactly as
    // production files would after a power loss or OS crash.
    await f.h.emit("session_shutdown", { reason: "quit" });
    copyDbFiles(presessionSnapshot, dbPath);

    // Restart: a fresh host and a freshly reopened session manager, no operator step, reading the
    // same (unrolled-back) session file against the rolled-back database.
    const manager = SessionManager.open(sessionFile);
    const restarted = host({ ...quiet, dbPath }, { native: () => manager, fetch: false });
    try {
      await restarted.emit("session_start");
      const restartedStore = restarted.memory.store;
      // The old core session is gone -- rolled back along with everything else in the presession
      // snapshot -- and a fresh one exists for the same host identity (a fresh database's
      // AUTOINCREMENT can coincidentally reuse the same numeric id; the host identity is what matters).
      const session = restartedStore.findSessionByHost(`pi:${f.original.id}`);
      expect(session).not.toBeNull();
      // Missing Raw (turn 1, rolled back with the snapshot and the session that owned it) is
      // re-imported from the session alone.
      const sources = restartedStore.listSourceEntries(session!.id);
      expect(restartedStore.hydrateSourceEntries(sources.map(e => e.id)).map(e => e.text)).toEqual(["FIRST", "answer"]);
      // The explicit enrollment choice made before the crash survives as the provisional choice,
      // and is what the freshly allocated session was created with.
      expect(restartedStore.enrollment(session!.id).choice).toBe(true);
    } finally { await restarted.dispose(); }
  } finally { await f.dispose(); }
});
