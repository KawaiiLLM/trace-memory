import { afterEach, expect, test } from "vitest";
import { copyFileSync, existsSync, mkdtempSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resolveCcHostConfig } from "../../src/hosts/cc/config.ts";
import { readBinding, recordSessionStart } from "../../src/hosts/cc/binding.ts";
import { CcImporter } from "../../src/hosts/cc/importer.ts";
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
