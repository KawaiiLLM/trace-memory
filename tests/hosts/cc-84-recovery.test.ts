import { afterEach, expect, test } from "vitest";
import { copyFileSync, existsSync, mkdtempSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resolveCcHostConfig } from "../../src/hosts/cc/config.ts";
import { readBinding, recordSessionStart } from "../../src/hosts/cc/binding.ts";
import { CcImporter } from "../../src/hosts/cc/importer.ts";
import { operateCcSession } from "../../src/hosts/cc/operator.ts";
import { Store } from "../../src/core/store/index.ts";
import type { CcNativeRecord } from "../../src/hosts/cc/transcript.ts";

// Ticket 84: `synchronous=NORMAL` accepts that a power loss or OS crash can roll the database back
// to an earlier committed state while the native transcript and this host's own binding file (under
// `stateDir`) stay at whatever they last reached. This simulates exactly that gap — not real WAL/power
// semantics, but the maintainer's stated acceptance test: restore an earlier copy of the database
// while the host-side files stay latest, start the host, and require no operator step.

const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });
const at = (second: number) => `2026-03-01T00:00:${String(second).padStart(2, "0")}.000Z`;
const line = (value: unknown) => `${JSON.stringify(value)}\n`;
const turn = (n: number, parent: string | null): CcNativeRecord[] => [
  { uuid: `u${n}`, parentUuid: parent, type: "user", timestamp: at(n * 2), promptId: `p${n}`, promptSource: "sdk", userType: "external",
    message: { role: "user", content: `question ${n}` } } as CcNativeRecord,
  { uuid: `a${n}`, parentUuid: `u${n}`, type: "assistant", timestamp: at(n * 2 + 1),
    message: { role: "assistant", content: [{ type: "text", text: `answer ${n}` }] } } as CcNativeRecord,
];

/** Copy (or restore) every WAL-mode SQLite file that exists for `dbPath`: the main file plus `-wal`
 * and `-shm` when present. A suffix absent at the destination is removed, so a restore leaves exactly
 * the source's file set, never a leftover WAL from a later, larger database. */
function copyDbFiles(from: string, to: string): void {
  for (const suffix of ["", "-wal", "-shm"]) {
    const src = `${from}${suffix}`, dst = `${to}${suffix}`;
    if (existsSync(src)) copyFileSync(src, dst);
    else try { unlinkSync(dst); } catch { /* nothing to remove */ }
  }
}

test("84: restoring an earlier database copy while the binding and transcript stay latest re-imports lost Raw and re-arms the rolled-back Noting commit, automatically", async () => {
  const dir = mkdtempSync(join(tmpdir(), "tm-84-cc-recovery-")); dirs.push(dir);
  const transcriptPath = join(dir, "native.jsonl"), nativeSessionId = "recovery-native", snapshotPath = join(dir, "snapshot.sqlite");
  const config = resolveCcHostConfig({ dbPath: join(dir, "memory.sqlite"), stateDir: join(dir, "state"), baseline: "2025-01-01T00:00:00.000Z" });

  // Turn 1, imported and Noted before the snapshot: this work must survive the restore.
  writeFileSync(transcriptPath, turn(1, null).map(line).join(""));
  const binding1 = await recordSessionStart(config,
    { hook_event_name: "SessionStart", session_id: nativeSessionId, transcript_path: transcriptPath }, at(0));
  let importer = new CcImporter(config, binding1);
  const first = await importer.reconcile();
  expect(first.state).toBe("ready");
  const sessionId = first.coreSessionId!, branch = first.branch;
  const pendingTurn1 = importer.memory.store.pendingEntries(sessionId, branch, first.headTurnId!);
  expect(pendingTurn1.map(e => e.nativeId).sort()).toEqual(["a1", "u1"]);
  const notedTurn1 = importer.memory.store.commitNotingRun({ run: { kind: "manual", sessionId, branch, createdAt: at(3) },
    entryIds: pendingTurn1.map(e => e.id), facts: [] });
  if (!notedTurn1.ok) throw new Error(notedTurn1.problems.join("; "));
  expect(importer.memory.store.pendingEntries(sessionId, branch, first.headTurnId!)).toEqual([]);
  importer.close();

  // The restore point: a copy of the database exactly as it stands after turn 1's import and Note.
  copyDbFiles(config.dbPath, snapshotPath);

  // Turn 2, imported and Noted after the snapshot: this is the work an OS crash or power loss may
  // roll back. The transcript and the binding file (this host's own state under `stateDir`) both
  // advance past the snapshot, exactly as production files would.
  writeFileSync(transcriptPath, [...turn(1, null), ...turn(2, "a1")].map(line).join(""));
  importer = new CcImporter(config, readBinding(config, nativeSessionId)!);
  const second = await importer.reconcile();
  expect(second.state).toBe("ready");
  const pendingTurn2 = importer.memory.store.pendingEntries(sessionId, branch, second.headTurnId!);
  expect(pendingTurn2.map(e => e.nativeId).sort()).toEqual(["a2", "u2"]);
  const notedTurn2 = importer.memory.store.commitNotingRun({ run: { kind: "manual", sessionId, branch, createdAt: at(6) },
    entryIds: pendingTurn2.map(e => e.id), facts: [] });
  if (!notedTurn2.ok) throw new Error(notedTurn2.problems.join("; "));
  expect(importer.memory.store.pendingEntries(sessionId, branch, second.headTurnId!)).toEqual([]);
  const bindingBeforeCrash = readBinding(config, nativeSessionId)!;
  importer.close();

  // The crash: the database rolls back to the snapshot. The transcript on disk and the binding file
  // are untouched — they still name turn 2 and its selected leaf, exactly as production leaves them.
  copyDbFiles(snapshotPath, config.dbPath);
  expect(readBinding(config, nativeSessionId)).toEqual(bindingBeforeCrash);

  // Restart: a fresh importer, no operator step, reading the same (unrolled-back) binding and
  // transcript against the rolled-back database.
  const restarted = new CcImporter(config, readBinding(config, nativeSessionId)!);
  try {
    const recovered = await restarted.reconcile();
    expect(recovered.problems).toEqual([]);
    expect(recovered.state).toBe("ready");
    expect(recovered.coreSessionId).toBe(sessionId); // turn 1's session-creation commit predates the snapshot; it survived
    // Missing Raw (turn 2, rolled back with the snapshot) is re-imported from the transcript alone.
    expect(restarted.memory.store.findKnownSourceEntry(sessionId, nativeSessionId, "u2")).not.toBeNull();
    expect(restarted.memory.store.findKnownSourceEntry(sessionId, nativeSessionId, "a2")).not.toBeNull();
    // Turn 1's Note commit predates the snapshot and survived: its entries are not pending again.
    // Turn 2's Note commit was rolled back with the snapshot: its (re-imported) entries are pending
    // again, so an ordinary Noting trigger will simply redo that work.
    const pendingAfterRecovery = restarted.memory.store.pendingEntries(sessionId, branch, recovered.headTurnId!);
    expect(pendingAfterRecovery.map(e => e.nativeId).sort()).toEqual(["a2", "u2"]);
    // The rolled-back run's own record is gone with it; nothing here claims to recover its spend.
    // Turn 1's Note run (before the snapshot) survived; turn 2's (after it) did not.
    expect(restarted.memory.store.listRuns(sessionId).filter(run => run.kind === "manual")).toHaveLength(1);
  } finally { restarted.close(); }
});

test("84 edge case: restoring a database copy from before this session's own creation reallocates a fresh core session, automatically", async () => {
  const dir = mkdtempSync(join(tmpdir(), "tm-84-cc-recovery-edge-")); dirs.push(dir);
  const transcriptPath = join(dir, "native.jsonl"), nativeSessionId = "recovery-edge-native", presessionSnapshot = join(dir, "presession.sqlite");
  const config = resolveCcHostConfig({ dbPath: join(dir, "memory.sqlite"), stateDir: join(dir, "state"), baseline: "2025-01-01T00:00:00.000Z" });

  // The restore point: the database exactly as it stood before this native session's core session
  // -- or even its own schema-creating first open -- ever existed.
  new Store(config.dbPath).close();
  copyDbFiles(config.dbPath, presessionSnapshot);

  // Turn 1, imported and Noted before the snapshot: all of this is the work an OS crash or power
  // loss reaching back to before this session's own creation would roll back.
  writeFileSync(transcriptPath, turn(1, null).map(line).join(""));
  const binding1 = await recordSessionStart(config,
    { hook_event_name: "SessionStart", session_id: nativeSessionId, transcript_path: transcriptPath }, at(0));
  let importer = new CcImporter(config, binding1);
  const first = await importer.reconcile();
  expect(first.state).toBe("ready");
  const sessionId = first.coreSessionId!;
  const pendingTurn1 = importer.memory.store.pendingEntries(sessionId, first.branch, first.headTurnId!);
  expect(pendingTurn1.map(e => e.nativeId).sort()).toEqual(["a1", "u1"]);
  importer.close();
  // An explicit choice, not merely the default -- this is the "user's persisted enrollment choice"
  // recovery must carry forward as the provisional one.
  await operateCcSession(config, nativeSessionId, "on");
  expect(readBinding(config, nativeSessionId)!.enrollment.choice).toBe(true);

  // The crash: the database rolls back to before this session ever existed. The transcript on disk
  // and the binding file are untouched -- the binding still names the core session the rollback
  // erased, exactly as production leaves it.
  copyDbFiles(presessionSnapshot, config.dbPath);
  const staleBinding = readBinding(config, nativeSessionId)!;
  expect(staleBinding.coreSessionId).toBe(sessionId);

  // Restart: a fresh importer, no operator step, reading the same (unrolled-back) binding and
  // transcript against the rolled-back database.
  const restarted = new CcImporter(config, staleBinding);
  try {
    const recovered = await restarted.reconcile();
    expect(recovered.problems).toEqual([]);
    expect(recovered.state).toBe("ready");
    // The old core session is gone -- rolled back along with everything else in the presession
    // snapshot -- and a fresh one is allocated for the same host identity (a fresh database's
    // AUTOINCREMENT can coincidentally reuse the same numeric id; the host identity is what matters).
    expect(recovered.coreSessionId).not.toBeNull();
    expect(restarted.memory.store.getSession(recovered.coreSessionId!)?.host).toBe(`cc:${nativeSessionId}`);
    // Missing Raw (turn 1, rolled back with the snapshot and the session that owned it) is
    // re-imported from the transcript alone.
    expect(restarted.memory.store.findKnownSourceEntry(recovered.coreSessionId!, nativeSessionId, "u1")).not.toBeNull();
    expect(restarted.memory.store.findKnownSourceEntry(recovered.coreSessionId!, nativeSessionId, "a1")).not.toBeNull();
    // The explicit enrollment choice made before the crash survives as the provisional choice, and
    // is what the freshly allocated session was created with.
    expect(readBinding(config, nativeSessionId)!.enrollment.choice).toBe(true);
    expect(restarted.memory.store.enrollment(recovered.coreSessionId!).choice).toBe(true);
  } finally { restarted.close(); }
});
