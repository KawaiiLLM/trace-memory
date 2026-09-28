import { afterEach, expect, test, vi } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn } from "node:child_process";
import { DatabaseSync } from "node:sqlite";
import { Store } from "../../src/core/store/index.ts";
import { resolveCcHostConfig } from "../../src/hosts/cc/config.ts";
import { coreHostOf, readBinding, updateBinding, type CcSessionBinding } from "../../src/hosts/cc/binding.ts";
import { handleCcHook } from "../../src/hosts/cc/index.ts";
import { CcCoordinator, recordCcSessionEnd } from "../../src/hosts/cc/lifecycle.ts";
import { CcImporter } from "../../src/hosts/cc/importer.ts";
import { nativeSessionDirectory, nativeSessionPath, publishNativeSession } from "../../src/hosts/cc/native-session.ts";
import * as nativeSession from "../../src/hosts/cc/native-session.ts";
import type { CcNativeRecord } from "../../src/hosts/cc/transcript.ts";

// 102: `/clear` ends the cleared session like an exit and starts an ordinary new session, which this
// Claude Code process's executor follows as it attaches at startup. Native sessions 63 already linked
// (`clearedFrom`, four in production) keep their inherited path, and one core session still holds
// several native lineages (86, 89).

const dirs: string[] = [];
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllEnvs(); for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });
const sleep = (milliseconds: number) => new Promise(resolve => setTimeout(resolve, milliseconds));
const until = async (condition: () => boolean, timeoutMs = 3_000) => {
  const deadline = Date.now() + timeoutMs;
  while (!condition()) { if (Date.now() > deadline) throw new Error("condition not met in time"); await sleep(10); }
};
const sdkPrompt = (promptId: string) => ({ promptId, promptSource: "sdk", userType: "external" });
const line = (value: unknown) => `${JSON.stringify(value)}\n`;
const exchange = (id: string, parentUuid: string | null, minute: number): CcNativeRecord[] => {
  const at = `2026-01-01T00:${String(minute).padStart(2, "0")}`;
  return [
    { uuid: `${id}u`, parentUuid, type: "user", timestamp: `${at}:00.000Z`, ...sdkPrompt(`${id}p`), message: { role: "user", content: `${id} question` } },
    { uuid: `${id}a`, parentUuid: `${id}u`, type: "assistant", timestamp: `${at}:01.000Z`, message: { role: "assistant", content: [{ type: "text", text: `${id} answer` }] } },
  ];
};

function fixture(label: string, overrides: Record<string, unknown> = {}) {
  const dir = mkdtempSync(join(tmpdir(), `tm-cc-clear-${label}-`)); dirs.push(dir);
  const stateDir = mkdtempSync("/tmp/tmcc-clr-"); dirs.push(stateDir);
  const config = resolveCcHostConfig({ dbPath: join(dir, "memory.sqlite"), stateDir, baseline: "2025-01-01T00:00:00.000Z",
    pollIntervalMs: 10, finalSyncTimeoutMs: 300, finalSyncStablePolls: 2, ...overrides });
  const parentId = `parent-${label}`, childId = `child-${label}`;
  const parentTranscriptPath = join(dir, "parent.jsonl"), childTranscriptPath = join(dir, "child.jsonl");
  const parentRecords: CcNativeRecord[] = [
    { uuid: "pu1", parentUuid: null, type: "user", timestamp: "2026-01-01T00:00:00.000Z", ...sdkPrompt("p1"), message: { role: "user", content: "question" } },
    { uuid: "pa1", parentUuid: "pu1", type: "assistant", timestamp: "2026-01-01T00:00:01.000Z", message: { role: "assistant", content: [{ type: "text", text: "answer" }] } },
  ];
  writeFileSync(parentTranscriptPath, parentRecords.map(line).join(""));
  return { dir, config, parentId, childId, parentTranscriptPath, childTranscriptPath, parentRecords,
    writeParent: (records: CcNativeRecord[]) => writeFileSync(parentTranscriptPath, records.map(line).join("")),
    writeChild: (records: CcNativeRecord[]) => writeFileSync(childTranscriptPath, records.map(line).join("")) };
}

async function startParent(f: ReturnType<typeof fixture>, pid = process.pid) {
  vi.stubEnv("CLAUDE_PID", String(pid));
  await handleCcHook(f.config, { hook_event_name: "SessionStart", source: "startup", session_id: f.parentId, transcript_path: f.parentTranscriptPath });
  // 97: the executor's import allocates and projects; a SessionStart Hook only reads what it published.
  const importer = new CcImporter(f.config, readBinding(f.config, f.parentId)!);
  try { await importer.reconcile(); } finally { importer.close(); }
  return readBinding(f.config, f.parentId)!;
}
const clearInto = (f: ReturnType<typeof fixture>) => handleCcHook(f.config,
  { hook_event_name: "SessionStart", source: "clear", session_id: f.childId, transcript_path: f.childTranscriptPath });

/** A native session 63 linked to its parent's core session before 102, as production still has four:
 * the SessionStart(clear) binding and this process's assignment, continued from a compaction Turn
 * appended under the parent's head, on the child's own branch and the parent's core session. */
async function link(f: ReturnType<typeof fixture>, parent: CcSessionBinding): Promise<CcSessionBinding> {
  await clearInto(f);
  const store = new Store(f.config.dbPath);
  try {
    const core = parent.coreSessionId!, at = "2026-01-01T00:05:00.000Z";
    const head = store.findSourceEntry(core, f.parentId, parent.selectedLeafUuid!)!.turnId;
    const turn = store.appendTurn({ sessionId: core, parentTurnId: head, kind: "compaction", assistantText: "compaction", startedAt: at, endedAt: at });
    const clearedFrom = { nativeSessionId: f.parentId, at, compactionTurnId: turn.id, inheritedEntryIds: store.selectedSourceEntryIds(core, parent.branch)! };
    await updateBinding(f.config, f.childId, current => ({ ...current!, enrollment: parent.enrollment, coreSessionId: core,
      projectId: parent.projectId, branch: `cc:${f.childId}`, coreHost: coreHostOf(parent), clearedFrom }));
    await updateBinding(f.config, f.parentId, current => ({ ...current!, clearedInto: { nativeSessionId: f.childId, at } }));
  } finally { store.close(); }
  return readBinding(f.config, f.childId)!;
}

test("102: /clear ends the cleared session like an exit, and the executor follows the process into the new one as at startup", async () => {
  const f = fixture("follow");
  const parent = await startParent(f);
  const coordinator = new CcCoordinator(f.config, f.parentId, () => {});
  try {
    await coordinator.start();
    const before = readBinding(f.config, f.parentId)!.executor!;
    expect(before.pid).toBe(process.pid);
    expect(await recordCcSessionEnd(f.config, { hook_event_name: "SessionEnd", session_id: f.parentId,
      transcript_path: f.parentTranscriptPath, reason: "clear" })).toMatchObject({ confirmed: true });
    // A row the executor has not imported when it leaves: only its final sync, as on exit, can import it.
    f.writeParent([...f.parentRecords, ...exchange("tail", "pa1", 2)]);
    await clearInto(f);
    const fresh = readBinding(f.config, f.childId)!;
    expect(fresh).toMatchObject({ coreSessionId: null, projectId: null, executor: null, branch: "main" });
    expect(fresh.clearedFrom).toBeUndefined();
    expect(await coordinator.retargetTo(f.childId)).toBe(true);
    expect(coordinator.nativeSessionId).toBe(f.childId);

    const store = new Store(f.config.dbPath);
    try {
      const core = parent.coreSessionId!;
      expect(store.findSourceEntry(core, f.parentId, "taila")).not.toBeNull();
      expect(store.getSession(core)!.closedAt).not.toBeNull();
      expect(readBinding(f.config, f.parentId)!.executor).toBeNull();
      // The new session is served by a fresh attach and becomes its own core session at its first reply.
      f.writeChild(exchange("c", null, 10));
      await until(() => readBinding(f.config, f.childId)!.coreSessionId !== null);
      const child = readBinding(f.config, f.childId)!;
      expect(child.executor).toMatchObject({ pid: process.pid });
      expect(child.executor!.executorId).not.toBe(before.executorId);
      expect(child.coreSessionId).not.toBe(core);
      expect(store.getSession(child.coreSessionId!)).toMatchObject({ host: `cc:${f.childId}`, closedAt: null });
      await until(() => store.findSourceEntry(child.coreSessionId!, f.childId, "ca") !== null);
    } finally { store.close(); }
  } finally { await coordinator.shutdown("test"); }
});

test("63: a linked child's compaction-only selected path publishes its inherited Raw and head", async () => {
  const f = fixture("compaction-only-child");
  const child = await link(f, await startParent(f));
  f.writeChild([{ uuid: "child-compact", parentUuid: null, type: "system", subtype: "compact_boundary",
    timestamp: "2026-01-01T00:10:00.000Z" }]);
  const importer = new CcImporter(f.config, child);
  try {
    const projected = await importer.reconcile();
    const store = importer.memory.store;
    const compact = store.findNativeTurn(child.coreSessionId!, f.childId, "child-compact")!;
    expect(projected).toMatchObject({ state: "ready", headTurnId: compact.turnId,
      selectedCount: child.clearedFrom!.inheritedEntryIds.length,
      selectedTailId: child.clearedFrom!.inheritedEntryIds.at(-1), selectedAppendedEntryIds: [] });
    expect(projected.selectedEntryIds).toEqual(child.clearedFrom!.inheritedEntryIds);
    expect(store.selectedSourceEntryIds(child.coreSessionId!, child.branch)).toEqual(projected.selectedEntryIds);
    expect(store.db.prepare("SELECT branch, head_turn_id FROM session_lineage_cursors WHERE session_id = ? AND lineage = ?")
      .get(child.coreSessionId!, f.childId)).toEqual({ branch: child.branch, head_turn_id: compact.turnId });
  } finally { importer.close(); }
});

test("63: a linked child's first Turn descends from the compaction Turn, its path is the inherited prefix plus its own entries, facts stay applicable, and Noting sees only the child's own entries", async () => {
  const f = fixture("descend");
  const parent = await startParent(f);
  const child = await link(f, parent);
  const core = child.coreSessionId!;

  f.writeChild([
    { uuid: "cu1", parentUuid: null, type: "user", timestamp: "2026-01-01T00:10:00.000Z", ...sdkPrompt("cp1"), message: { role: "user", content: "child question" } },
    { uuid: "ca1", parentUuid: "cu1", type: "assistant", timestamp: "2026-01-01T00:10:01.000Z", message: { role: "assistant", content: [{ type: "text", text: "child answer" }] } },
  ]);
  const importer = new CcImporter(f.config, readBinding(f.config, f.childId)!);
  const result = await importer.reconcile();
  importer.close();
  expect(result.state).toBe("ready");

  const store = new Store(f.config.dbPath);
  try {
    const childUserTurnId = store.findNativeTurn(core, f.childId, "cu1")!.turnId;
    const childTurn = store.getTurn(childUserTurnId)!;
    expect(childTurn.parentTurnId).toBe(child.clearedFrom!.compactionTurnId);

    const childEntryIds = [store.findSourceEntry(core, f.childId, "cu1")!.id, store.findSourceEntry(core, f.childId, "ca1")!.id];
    const persistedPath = store.selectedSourceEntryIds(core, child.branch)!;
    expect(persistedPath).toEqual([...child.clearedFrom!.inheritedEntryIds, ...childEntryIds]);
    expect(store.selectedSourceEntryIds(core, parent.branch)).toEqual(child.clearedFrom!.inheritedEntryIds);

    // Mark the inherited prefix noted (as the parent's own Noting would have) and put one fact on
    // it; both must stay applicable and un-duplicated on the child.
    const inherited = child.clearedFrom!.inheritedEntryIds;
    const parentHead = store.getSourceEntry(inherited.at(-1)!)!.turnId;
    const committed = store.commitNotingRun({ run: { kind: "noting", sessionId: core, branch: parent.branch,
      rangeFrom: `S${core}/T${parentHead}`, rangeTo: `S${core}/T${parentHead}`, createdAt: "2026-01-01T00:05:00.000Z" },
      facts: [{ turnId: parentHead, category: "observation", actor: "user", text: "a parent fact", source: [], createdAt: "2026-01-01T00:05:00.000Z", entryIds: inherited }],
      entryIds: inherited });
    expect(committed.ok).toBe(true);

    const childHead = childTurn.id;
    const path = { sessionId: core, branch: child.branch, headTurnId: childHead };
    const snapshot = store.pathSnapshot(path);
    if (committed.ok) expect(store.factOnPath(committed.facts[0]!, path, snapshot)).toBe(true);

    // Noting on the child's own path sees exactly its own two entries; the inherited prefix, already
    // noted, is not offered again.
    expect(store.pendingEntryIds(core, child.branch, childHead).sort((a, b) => a - b)).toEqual([...childEntryIds].sort((a, b) => a - b));
  } finally { store.close(); }

  // Reopening the parent facade adopts its retained lineage cursor; it neither copies nor moves the
  // child's cursor. An edit-resend in the child then moves only that lineage to a fresh stable branch.
  const reopenedParent = new CcImporter(f.config, readBinding(f.config, f.parentId)!);
  expect((await reopenedParent.reconcile()).state).toBe("ready");
  reopenedParent.close();
  f.writeChild([
    { uuid: "cu2", parentUuid: null, type: "user", timestamp: "2026-01-01T00:20:00.000Z", ...sdkPrompt("cp2"), message: { role: "user", content: "edited child question" } },
    { uuid: "ca2", parentUuid: "cu2", type: "assistant", timestamp: "2026-01-01T00:20:01.000Z", message: { role: "assistant", content: [{ type: "text", text: "edited child answer" }] } },
  ]);
  const editedChild = new CcImporter(f.config, readBinding(f.config, f.childId)!);
  const edited = await editedChild.reconcile();
  editedChild.close();
  expect(edited).toMatchObject({ state: "ready", branch: "cc:ca2" });

  const reopened = new Store(f.config.dbPath);
  const database = new DatabaseSync(f.config.dbPath);
  try {
    const inherited = child.clearedFrom!.inheritedEntryIds;
    const firstChildIds = [reopened.findSourceEntry(core, f.childId, "cu1")!.id, reopened.findSourceEntry(core, f.childId, "ca1")!.id];
    const editedChildIds = [reopened.findSourceEntry(core, f.childId, "cu2")!.id, reopened.findSourceEntry(core, f.childId, "ca2")!.id];
    expect(reopened.selectedSourceEntryIds(core, parent.branch)).toEqual(inherited);
    expect(reopened.selectedSourceEntryIds(core, child.branch)).toEqual([...inherited, ...firstChildIds]);
    expect(reopened.selectedSourceEntryIds(core, edited.branch)).toEqual([...inherited, ...editedChildIds]);
    const cursors = database.prepare(`SELECT lineage, branch FROM session_lineage_cursors WHERE session_id = ? ORDER BY lineage`).all(core);
    expect(cursors).toEqual([
      { lineage: f.childId, branch: "cc:ca2" },
      { lineage: f.parentId, branch: parent.branch },
    ]);
  } finally { database.close(); reopened.close(); }
});

test("86: a SessionEnd on a linked child with no live sibling confirms the close of the shared core session", async () => {
  const f = fixture("session-end");
  await startParent(f);
  await link(f, readBinding(f.config, f.parentId)!);
  f.writeChild([
    { uuid: "cu1", parentUuid: null, type: "user", timestamp: "2026-01-01T00:10:00.000Z", ...sdkPrompt("cp1"), message: { role: "user", content: "child question" } },
    { uuid: "ca1", parentUuid: "cu1", type: "assistant", timestamp: "2026-01-01T00:10:01.000Z", message: { role: "assistant", content: [{ type: "text", text: "child answer" }] } },
  ]);
  const childImporter = new CcImporter(f.config, readBinding(f.config, f.childId)!);
  await childImporter.reconcile();
  childImporter.close();
  const child = readBinding(f.config, f.childId)!;
  const deadChild = spawn(process.execPath, ["-e", ""]); const deadPid = deadChild.pid!;
  await new Promise<void>(resolveExit => deadChild.once("exit", () => resolveExit()));
  const executor = { executorId: "dead-child-owner", pid: deadPid, token: "dead-token", socketPath: join(f.dir, "dead.sock"), startedAt: new Date().toISOString() };
  await updateBinding(f.config, f.childId, current => ({ ...current!, executor }));
  const closeInput = { hook_event_name: "SessionEnd" as const, session_id: f.childId, transcript_path: f.childTranscriptPath, reason: "prompt_input_exit" };
  expect(await recordCcSessionEnd(f.config, closeInput)).toMatchObject({ confirmed: true });
  const verified = new Store(f.config.dbPath);
  try { expect(verified.getSession(child.coreSessionId!)!.closedAt).not.toBeNull(); } finally { verified.close(); }
});

test("86: a native child with no MCP executor keeps the core open until its SessionEnd", async () => {
  const f = fixture("native-sibling");
  const parent = await startParent(f);
  await link(f, parent);
  expect(readBinding(f.config, f.childId)!.executor).toBeNull();
  expect(await recordCcSessionEnd(f.config, { hook_event_name: "SessionEnd", session_id: f.parentId,
    transcript_path: f.parentTranscriptPath, reason: "other" })).toMatchObject({ confirmed: true });
  const store = new Store(f.config.dbPath);
  try {
    expect(store.getSession(parent.coreSessionId!)!.closedAt).toBeNull();
    expect(await recordCcSessionEnd(f.config, { hook_event_name: "SessionEnd", session_id: f.childId,
      transcript_path: f.childTranscriptPath, reason: "logout" })).toMatchObject({ confirmed: true });
    expect(store.getSession(parent.coreSessionId!)!.closedAt).not.toBeNull();
  } finally { store.close(); }
});

test("86: a parent resumed in another native process remains live without an executor", async () => {
  const f = fixture("resumed-parent");
  const parent = await startParent(f);
  await link(f, parent);
  const resumed = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"]);
  try {
    vi.stubEnv("CLAUDE_PID", String(resumed.pid!));
    await handleCcHook(f.config, { hook_event_name: "SessionStart", source: "resume", session_id: f.parentId,
      transcript_path: f.parentTranscriptPath });
    expect(readBinding(f.config, f.parentId)!.executor).toBeNull();
    vi.stubEnv("CLAUDE_PID", String(process.pid));
    expect(await recordCcSessionEnd(f.config, { hook_event_name: "SessionEnd", session_id: f.childId,
      transcript_path: f.childTranscriptPath, reason: "other" })).toMatchObject({ confirmed: true });
    const store = new Store(f.config.dbPath);
    try {
      expect(store.getSession(parent.coreSessionId!)!.closedAt).toBeNull();
      vi.stubEnv("CLAUDE_PID", String(resumed.pid!));
      expect(await recordCcSessionEnd(f.config, { hook_event_name: "SessionEnd", session_id: f.parentId,
        transcript_path: f.parentTranscriptPath, reason: "logout" })).toMatchObject({ confirmed: true });
      expect(store.getSession(parent.coreSessionId!)!.closedAt).not.toBeNull();
    } finally { store.close(); }
  } finally {
    resumed.kill("SIGTERM");
    if (resumed.exitCode === null && resumed.signalCode === null)
      await new Promise<void>(resolve => resumed.once("exit", () => resolve()));
  }
});

test.each(["none", "dead", "reused", "live"] as const)("86: legacy sibling liveness comes from native-session records (%s)", async state => {
  const f = fixture(`legacy-${state}`);
  const parent = await startParent(f);
  await link(f, parent); // This process's assignment now points at the child, not the parent.
  await updateBinding(f.config, f.parentId, current => {
    const { nativeProcess: _oldIdentity, ...legacy } = current!;
    return legacy;
  });
  const processForRecord = state === "none" ? null : spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"]);
  try {
    if (processForRecord) {
      const record = publishNativeSession(f.config, { hook_event_name: "SessionStart", session_id: f.parentId,
        transcript_path: f.parentTranscriptPath }, processForRecord.pid!)!;
      expect(record.startedAt).not.toBeNull();
      if (state === "dead") {
        processForRecord.kill("SIGTERM");
        await new Promise<void>(resolve => processForRecord.once("exit", () => resolve()));
      } else if (state === "reused") {
        writeFileSync(nativeSessionPath(f.config, processForRecord.pid!), JSON.stringify({ ...record, startedAt: "older process" }));
      }
    }
    expect(readBinding(f.config, f.parentId)!.nativeProcess).toBeUndefined();
    expect(await recordCcSessionEnd(f.config, { hook_event_name: "SessionEnd", session_id: f.childId,
      transcript_path: f.childTranscriptPath, reason: "other" })).toMatchObject({ confirmed: true });
    const store = new Store(f.config.dbPath);
    try {
      const closedAt = store.getSession(parent.coreSessionId!)!.closedAt;
      if (state === "live") expect(closedAt).toBeNull();
      else expect(closedAt).not.toBeNull();
    } finally { store.close(); }
  } finally {
    if (processForRecord && processForRecord.exitCode === null && processForRecord.signalCode === null) {
      processForRecord.kill("SIGTERM");
      await new Promise<void>(resolve => processForRecord.once("exit", () => resolve()));
    }
  }
});

test.each(["directory", "json", "record", "record-start", "process-start", "permission"] as const)(
  "86: unknown legacy sibling state rejects close rather than guessing dead (%s)", async fault => {
    const f = fixture(`legacy-unknown-${fault}`);
    const parent = await startParent(f);
    await link(f, parent);
    await updateBinding(f.config, f.parentId, current => {
      const { nativeProcess: _oldIdentity, ...legacy } = current!;
      return legacy;
    });
    // A second assignment points at the old parent while the ending child's binding remains intact.
    const sibling = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"]);
    try {
      const record = publishNativeSession(f.config, { hook_event_name: "SessionStart", session_id: f.parentId,
        transcript_path: f.parentTranscriptPath }, sibling.pid!)!;
      const path = nativeSessionPath(f.config, sibling.pid!);
      if (fault === "directory") {
        rmSync(nativeSessionDirectory(f.config), { recursive: true });
        writeFileSync(nativeSessionDirectory(f.config), "not a directory");
      } else if (fault === "json") writeFileSync(path, "{");
      else if (fault === "record") writeFileSync(path, JSON.stringify({ ...record, pid: 0 }));
      else if (fault === "record-start") writeFileSync(path, JSON.stringify({ ...record, startedAt: null }));
      else if (fault === "process-start") {
        const actual = nativeSession.processStartedAt;
        vi.spyOn(nativeSession, "processStartedAt").mockImplementation(pid => pid === sibling.pid ? null : actual(pid));
      } else {
        const actual = process.kill;
        vi.spyOn(process, "kill").mockImplementation((pid, signal) => {
          if (pid === sibling.pid && signal === 0) throw Object.assign(new Error("permission denied"), { code: "EPERM" });
          return actual(pid, signal);
        });
      }
      const result = await recordCcSessionEnd(f.config, { hook_event_name: "SessionEnd", session_id: f.childId,
        transcript_path: f.childTranscriptPath, reason: "other" });
      expect(result.confirmed).toBe(false);
      expect(result.diagnostic).toBeTruthy();
      expect(readBinding(f.config, f.childId)!.lastClose?.confirmed).not.toBe(true);
      const store = new Store(f.config.dbPath);
      try { expect(store.getSession(parent.coreSessionId!)!.closedAt).toBeNull(); } finally { store.close(); }
    } finally {
      vi.restoreAllMocks();
      sibling.kill("SIGTERM");
      if (sibling.exitCode === null && sibling.signalCode === null)
        await new Promise<void>(resolve => sibling.once("exit", () => resolve()));
    }
  });

test("a SessionEnd on one lineage while another lineage's executor is live releases only its own executor and does not close the core session", async () => {
  const f = fixture("session-end-sibling");
  await startParent(f);
  await link(f, readBinding(f.config, f.parentId)!);
  const parent = readBinding(f.config, f.parentId)!;
  const coreSessionId = parent.coreSessionId!;

  // The child names a live executor (this test process); the parent's own executor is dead.
  const live = { executorId: "sibling-live", pid: process.pid, token: "sibling-token", socketPath: join(f.dir, "sibling.sock"), startedAt: new Date().toISOString() };
  await updateBinding(f.config, f.childId, current => ({ ...current!, executor: live }));
  const deadParent = spawn(process.execPath, ["-e", ""]); const deadPid = deadParent.pid!;
  await new Promise<void>(resolveExit => deadParent.once("exit", () => resolveExit()));
  const parentExecutor = { executorId: "dead-parent-owner", pid: deadPid, token: "dead-parent-token", socketPath: join(f.dir, "dead-parent.sock"), startedAt: new Date().toISOString() };
  await updateBinding(f.config, f.parentId, current => ({ ...current!, executor: parentExecutor }));

  const closeInput = { hook_event_name: "SessionEnd" as const, session_id: f.parentId, transcript_path: f.parentTranscriptPath, reason: "prompt_input_exit" };
  expect(await recordCcSessionEnd(f.config, closeInput)).toMatchObject({ confirmed: true });
  expect(readBinding(f.config, f.parentId)!.executor).toBeNull();
  expect(readBinding(f.config, f.childId)!.executor).toEqual(live); // untouched
  const store = new Store(f.config.dbPath);
  try { expect(store.getSession(coreSessionId)!.closedAt).toBeNull(); } finally { store.close(); }
});
