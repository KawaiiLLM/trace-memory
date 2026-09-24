import { afterEach, expect, test, vi } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn } from "node:child_process";
import { DatabaseSync } from "node:sqlite";
import { Store } from "../../src/core/store/index.ts";
import { resolveCcHostConfig } from "../../src/hosts/cc/config.ts";
import { readBinding, updateBinding } from "../../src/hosts/cc/binding.ts";
import { operateCcSession } from "../../src/hosts/cc/operator.ts";
import { handleCcHook } from "../../src/hosts/cc/index.ts";
import { ccHandleClear } from "../../src/hosts/cc/clear.ts";
import { CcCoordinator, recordCcSessionEnd } from "../../src/hosts/cc/lifecycle.ts";
import { CcImporter } from "../../src/hosts/cc/importer.ts";
import { publishNativeSession } from "../../src/hosts/cc/native-session.ts";
import type { CcNativeRecord } from "../../src/hosts/cc/transcript.ts";

// 63: `/clear` binds the cleared-into native session as another lineage of the SAME core session as
// the one it was cleared from — Claude Code's equivalent of Pi's in-place compaction.

const dirs: string[] = [];
afterEach(() => { vi.unstubAllEnvs(); for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });
const sleep = (milliseconds: number) => new Promise(resolve => setTimeout(resolve, milliseconds));
const until = async (condition: () => boolean, timeoutMs = 3_000) => {
  const deadline = Date.now() + timeoutMs;
  while (!condition()) { if (Date.now() > deadline) throw new Error("condition not met in time"); await sleep(10); }
};
const sdkPrompt = (promptId: string) => ({ promptId, promptSource: "sdk", userType: "external" });
const line = (value: unknown) => `${JSON.stringify(value)}\n`;
// The second line of an envelope is always `TRACE-MEMORY-CC/1 <json header>` (encodeCcInjection).
const envelopeHeader = (additionalContext: string) => JSON.parse(additionalContext.split("\n")[1]!.slice("TRACE-MEMORY-CC/1 ".length));

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
  return readBinding(f.config, f.parentId)!;
}
const clearInto = (f: ReturnType<typeof fixture>) => handleCcHook(f.config,
  { hook_event_name: "SessionStart", source: "clear", session_id: f.childId, transcript_path: f.childTranscriptPath });

test("SessionStart clear with a bound parent links the same core session and injects compact() material", async () => {
  const f = fixture("full");
  const parent = await startParent(f);
  expect(parent.coreSessionId).not.toBeNull();
  const output = await clearInto(f);
  expect(output).not.toBeNull();

  const child = readBinding(f.config, f.childId)!;
  expect(child.coreSessionId).toBe(parent.coreSessionId);
  expect(child.projectId).toBe(parent.projectId);
  expect(child.branch).toBe(`cc:${f.childId}`);
  expect(child.branch).not.toBe(parent.branch);
  expect(child.enrollment).toEqual(parent.enrollment);
  expect(child.coreHost).toBe(`cc:${f.parentId}`);
  expect(child.clearedFrom).toMatchObject({ nativeSessionId: f.parentId, compactionTurnId: expect.any(Number) });
  expect(child.clearedFrom!.inheritedEntryIds.length).toBe(2); // pu1's and pa1's source entries

  const reloadedParent = readBinding(f.config, f.parentId)!;
  expect(reloadedParent.clearedInto).toMatchObject({ nativeSessionId: f.childId });

  const store = new Store(f.config.dbPath);
  try {
    const parentHead = store.findSourceEntry(parent.coreSessionId!, f.parentId, "pa1")!.turnId;
    const turn = store.getTurn(child.clearedFrom!.compactionTurnId!)!;
    expect(turn).toMatchObject({ kind: "compaction", parentTurnId: parentHead });
    expect(turn.assistantText).toBeTruthy();
    expect(store.selectedSourceEntryIds(parent.coreSessionId!, parent.branch)).toEqual(child.clearedFrom!.inheritedEntryIds);
    const header = envelopeHeader(output!.hookSpecificOutput.additionalContext);
    expect(header).toMatchObject({ n: f.childId, s: parent.coreSessionId });
    // The injected text is exactly the compaction Turn's stored material (29a: content and receipt are one carrier).
    expect(output!.hookSpecificOutput.additionalContext).toContain(turn.assistantText!);
  } finally { store.close(); }
});

test("a cleared child's compaction-only selected path publishes its inherited Raw and head", async () => {
  const f = fixture("compaction-only-child");
  await startParent(f);
  await clearInto(f);
  const child = readBinding(f.config, f.childId)!;
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

test("73: clear truncates the Raw window rather than falling back, and warns in the foreground", async () => {
  const f = fixture("native-fallback");
  // A reply whose bounded view fills the entry profile, over a Raw window shrunk below it with the
  // allowance pinned to its configuration floor: 73 What to build 1.4 — compact() omits it with a
  // receipt instead of falling back — `/clear` has no knowledge-only fallback to substitute.
  f.writeParent([
    { uuid: "pu1", parentUuid: null, type: "user", timestamp: "2026-01-01T00:00:00.000Z", ...sdkPrompt("p1"), message: { role: "user", content: "question" } },
    { uuid: "pa1", parentUuid: "pu1", type: "assistant", timestamp: "2026-01-01T00:00:01.000Z", message: { role: "assistant", content: [{ type: "text", text: "word ".repeat(5_000) }] } },
  ]);
  await startParent(f);
  // Called directly, not through `handleCcHook`: the latter re-resolves its config input from
  // scratch, and mutations to an already-resolved config do not survive resolving it twice.
  f.config.coreConfig.compaction.rawTokens = 1_000;
  f.config.coreConfig.compaction.sharedAllowanceTokens = 1;
  const cleared = await ccHandleClear(f.config, { hook_event_name: "SessionStart", source: "clear", session_id: f.childId, transcript_path: f.childTranscriptPath });
  expect(cleared.handled).toBe(true);
  const output = cleared.handled ? cleared.output : null;
  const child = readBinding(f.config, f.childId)!;
  expect(child.clearedFrom).toBeTruthy();
  expect(output).not.toBeNull();
  expect(output!.hookSpecificOutput.additionalContext).not.toContain("word word");
  // The foreground truncation warning: a top-level `systemMessage` beside `additionalContext`.
  expect(output!.systemMessage).toContain("compaction omitted");
  expect(output!.systemMessage).toContain("pending Raw");
  expect(output!.systemMessage).toContain("pending for Noting and Consolidation");
  expect(output!.systemMessage!.length).toBeLessThan(4_000);
});

test("clear without CLAUDE_PID, without a native-session record, or with an unbound parent is an ordinary new session", async () => {
  const f = fixture("fallback");
  const ordinary = (nativeSessionId: string) => {
    const binding = readBinding(f.config, nativeSessionId)!;
    expect(binding.coreSessionId).toBeNull();
    expect(binding.coreHost).toBeUndefined();
    expect(binding.clearedFrom).toBeUndefined();
  };

  // (a) no CLAUDE_PID
  vi.stubEnv("CLAUDE_PID", "");
  await handleCcHook(f.config, { hook_event_name: "SessionStart", source: "clear", session_id: `${f.childId}-a`, transcript_path: join(f.dir, "a.jsonl") });
  ordinary(`${f.childId}-a`);

  // (b) CLAUDE_PID set, but no native-session record ever published for that pid
  vi.stubEnv("CLAUDE_PID", "90777");
  await handleCcHook(f.config, { hook_event_name: "SessionStart", source: "clear", session_id: `${f.childId}-b`, transcript_path: join(f.dir, "b.jsonl") });
  ordinary(`${f.childId}-b`);

  // (c) CLAUDE_PID set and a record is published, but it names a session with no binding at all
  publishNativeSession(f.config, { hook_event_name: "SessionStart", session_id: "ghost-parent", transcript_path: join(f.dir, "ghost.jsonl"), source: "startup" }, 90_778);
  vi.stubEnv("CLAUDE_PID", "90778");
  await handleCcHook(f.config, { hook_event_name: "SessionStart", source: "clear", session_id: `${f.childId}-c`, transcript_path: join(f.dir, "c.jsonl") });
  ordinary(`${f.childId}-c`);
});

test("a provisional parent passes only its project and enrollment forward", async () => {
  const f = fixture("provisional");
  vi.stubEnv("CLAUDE_PID", "90888");
  // The parent's own SessionStart never gets a transcript, so it stays provisional (no core session).
  await handleCcHook(f.config, { hook_event_name: "SessionStart", source: "startup", session_id: f.parentId, transcript_path: join(f.dir, "missing.jsonl") });
  await updateBinding(f.config, f.parentId, current => ({ ...current!, enrollment: { ...current!.enrollment, choice: true } }));
  await handleCcHook(f.config, { hook_event_name: "SessionStart", source: "startup", session_id: f.parentId, transcript_path: join(f.dir, "missing.jsonl") });
  const parent = readBinding(f.config, f.parentId)!;
  expect(parent.coreSessionId).toBeNull();
  expect(parent.projectId).not.toBeNull();

  await handleCcHook(f.config, { hook_event_name: "SessionStart", source: "clear", session_id: f.childId, transcript_path: f.childTranscriptPath });
  const child = readBinding(f.config, f.childId)!;
  expect(child.coreSessionId).toBeNull();
  expect(child.projectId).toBe(parent.projectId);
  expect(child.enrollment).toEqual(parent.enrollment);
  expect(child.clearedFrom).toBeUndefined();
});

test("the child's first Turn descends from the compaction Turn, its path is the inherited prefix plus its own entries, facts stay applicable, and Noting sees only the child's own entries", async () => {
  const f = fixture("descend");
  const parent = await startParent(f);
  await clearInto(f);
  const child = readBinding(f.config, f.childId)!;
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

    // Mark the inherited prefix noted (as the parent's own Noting, or the child's after retarget,
    // would have) and put one fact on it; both must stay applicable and un-duplicated on the child.
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

test("an attached executor re-targets on the child's clearedFrom assignment", async () => {
  const f = fixture("retarget");
  await startParent(f);
  const coordinator = new CcCoordinator(f.config, f.parentId, () => {});
  try {
    await coordinator.start();
    const parentExecutor = readBinding(f.config, f.parentId)!.executor!;
    expect(parentExecutor).not.toBeNull();

    await clearInto(f);
    const retargeted = await coordinator.retargetTo(f.childId);
    expect(retargeted).toBe(true);
    expect(coordinator.nativeSessionId).toBe(f.childId);
    const childBinding = readBinding(f.config, f.childId)!;
    expect(childBinding.executor).toMatchObject({ executorId: parentExecutor.executorId, pid: parentExecutor.pid, token: parentExecutor.token });
    expect(readBinding(f.config, f.parentId)!.executor).toBeNull();

    // The child's own entries import into the SAME core session; tasks and claims are untouched.
    f.writeChild([
      { uuid: "cu1", parentUuid: null, type: "user", timestamp: "2026-01-01T00:10:00.000Z", ...sdkPrompt("cp1"), message: { role: "user", content: "child question" } },
      { uuid: "ca1", parentUuid: "cu1", type: "assistant", timestamp: "2026-01-01T00:10:01.000Z", message: { role: "assistant", content: [{ type: "text", text: "child answer" }] } },
    ]);
    const store = new Store(f.config.dbPath);
    try {
      await until(() => store.findSourceEntry(childBinding.coreSessionId!, f.childId, "ca1") !== null);
      expect(store.findSourceEntry(childBinding.coreSessionId!, f.childId, "ca1")!.sessionId).toBe(childBinding.coreSessionId);
      expect(store.getClaim(childBinding.coreSessionId!, "noting")).toBeNull();
    } finally { store.close(); }
  } finally { await coordinator.shutdown("test"); }
});

test("a parent enrolled after its executor attached still re-targets to its clear child", async () => {
  // Production 2026-09-22 16:02: the executor attached while the parent was provisional, `/trace on` gave it a core
  // session, and the control server's stale copy of the binding refused the clear child as "another core session".
  const f = fixture("late-enroll");
  const provisional = resolveCcHostConfig({ ...f.config, baseline: "2099-01-01T00:00:00.000Z" }); // default off at attach
  vi.stubEnv("CLAUDE_PID", "90007");
  await handleCcHook(provisional, { hook_event_name: "SessionStart", source: "startup", session_id: f.parentId, transcript_path: f.parentTranscriptPath });
  expect(readBinding(provisional, f.parentId)!.coreSessionId).toBeNull();
  const coordinator = new CcCoordinator(provisional, f.parentId, () => {});
  try {
    await coordinator.start();
    expect((await operateCcSession(provisional, f.parentId, "on")).command).toBe("on");
    await until(() => readBinding(provisional, f.parentId)!.coreSessionId !== null);
    const parent = readBinding(provisional, f.parentId)!;
    await handleCcHook(provisional, { hook_event_name: "SessionStart", source: "clear", session_id: f.childId, transcript_path: f.childTranscriptPath });
    const child = readBinding(provisional, f.childId)!;
    expect(child.coreSessionId).toBe(parent.coreSessionId);
    expect(await coordinator.retargetTo(f.childId)).toBe(true);
    expect(readBinding(provisional, f.childId)!.executor).not.toBeNull();
    expect(readBinding(provisional, f.parentId)!.executor).toBeNull();
  } finally { await coordinator.shutdown("test"); }
});

test("a child naming another live executor is refused and journaled", async () => {
  const f = fixture("retarget-conflict");
  await startParent(f);
  await clearInto(f);
  const other = { executorId: "other-live", pid: process.pid, token: "other-token", socketPath: join(f.dir, "other.sock"), startedAt: new Date().toISOString() };
  await updateBinding(f.config, f.childId, current => ({ ...current!, executor: other }));

  const diagnostics: string[] = [];
  const coordinator = new CcCoordinator(f.config, f.parentId, message => diagnostics.push(message));
  try {
    await coordinator.start();
    const retargeted = await coordinator.retargetTo(f.childId);
    expect(retargeted).toBe(false);
    expect(coordinator.nativeSessionId).toBe(f.parentId);
    expect(readBinding(f.config, f.childId)!.executor).toEqual(other);
    expect(diagnostics.some(message => message.includes("already has a live executor"))).toBe(true);
  } finally { await coordinator.shutdown("test"); }
});

test("SessionEnd prompt_input_exit on the child confirms the close; SessionEnd clear on the parent leaves it open", async () => {
  const f = fixture("session-end");
  const parent = await startParent(f);
  await clearInto(f);

  // `clear` on the parent is not a normal close.
  const clearEnd = await recordCcSessionEnd(f.config, { hook_event_name: "SessionEnd", session_id: f.parentId,
    transcript_path: f.parentTranscriptPath, reason: "clear" });
  expect(clearEnd.confirmed).toBe(false);
  const store = new Store(f.config.dbPath);
  try { expect(store.getSession(parent.coreSessionId!)!.closedAt).toBeNull(); } finally { store.close(); }

  // A normal close on the child, with no live sibling, confirms and closes the shared core session.
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

test("a SessionEnd on one lineage while another lineage's executor is live releases only its own executor and does not close the core session", async () => {
  const f = fixture("session-end-sibling");
  await startParent(f);
  await clearInto(f);
  const parent = readBinding(f.config, f.parentId)!, child = readBinding(f.config, f.childId)!;
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
