import { afterEach, expect, test } from "vitest";
import { appendFileSync, mkdtempSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { resolveCcHostConfig } from "../../src/hosts/cc/config.ts";
import { bindingPath, readBinding, recordSessionStart } from "../../src/hosts/cc/binding.ts";
import { CcImporter } from "../../src/hosts/cc/importer.ts";
import { classifySourceRecord, selectedNativePath, type CcNativeRecord } from "../../src/hosts/cc/transcript.ts";

const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });
const at = (second: number) => `2026-02-01T00:00:${String(second).padStart(2, "0")}.000Z`;
const line = (value: unknown) => `${JSON.stringify(value)}\n`;
const prompt = (uuid: string, parentUuid: string | null, second: number, text = uuid): CcNativeRecord => ({
  uuid, parentUuid, type: "user", timestamp: at(second), promptId: `prompt-${uuid}`, promptSource: "sdk", userType: "external",
  message: { role: "user", content: text },
});
const assistant = (uuid: string, parentUuid: string | null, second: number, content: unknown[]): CcNativeRecord => ({
  uuid, parentUuid, type: "assistant", timestamp: at(second), message: { role: "assistant", content },
});
async function setup(records: CcNativeRecord[], nativeSessionId = "repair-session") {
  const dir = mkdtempSync(join(tmpdir(), "tm-43a-repair-")); dirs.push(dir);
  const transcriptPath = join(dir, "native.jsonl");
  const config = resolveCcHostConfig({ dbPath: join(dir, "memory.sqlite"), stateDir: join(dir, "state"),
    baseline: "2025-01-01T00:00:00.000Z" });
  writeFileSync(transcriptPath, records.map(line).join(""));
  const binding = await recordSessionStart(config,
    { hook_event_name: "SessionStart", session_id: nativeSessionId, transcript_path: transcriptPath }, at(1));
  return { dir, transcriptPath, config, nativeSessionId, importer: new CcImporter(config, binding) };
}

const base = () => [prompt("u", null, 1), assistant("a", "u", 2, [{ type: "text", text: "answer" }])];

test("strict parent decoding rejects malformed physical and logical identities without fallback", async () => {
  for (const malformed of [
    { ...prompt("bad-physical", null, 3), parentUuid: 42 } as unknown as CcNativeRecord,
    { ...prompt("bad-logical", "a", 3), logicalParentUuid: 42 } as unknown as CcNativeRecord,
  ]) {
    expect(selectedNativePath([...base(), malformed]).problem).toBe(`native lineage parent of ${malformed.uuid} is invalid`);
    const f = await setup([...base(), malformed], `strict-${malformed.uuid}`);
    try {
      const result = await f.importer.reconcile();
      expect(result).toMatchObject({ state: "not-ready", problems: [`native lineage parent of ${malformed.uuid} is invalid`] });
      expect(f.importer.memory.store.findSourceEntry(result.coreSessionId!, f.nativeSessionId, malformed.uuid!)).toBeNull();
      expect(readBinding(f.config, f.nativeSessionId)!.selectedLeafUuid).toBeNull();
    } finally { f.importer.close(); }
  }
});

test("main-session prompt shapes open Turns and own their following assistant and tools", async () => {
  const compact: CcNativeRecord = { uuid: "compact", parentUuid: "a", type: "system", subtype: "compact_boundary", timestamp: at(3) };
  const notification: CcNativeRecord = { uuid: "notification", parentUuid: "compact", type: "user", timestamp: at(4),
    promptSource: "system", message: { role: "user", content: "<task-notification>completed</task-notification>" } };
  const notified = assistant("notified", "notification", 5, [{ type: "text", text: "handled notification" }]);
  const crossSession: CcNativeRecord = { uuid: "cross-session", parentUuid: "notified", type: "user", timestamp: at(6),
    promptSource: "system", isMeta: true, origin: { kind: "peer" }, message: { role: "user", content: "Message from another session" } };
  const crossReply = assistant("cross-reply", "cross-session", 7, [{ type: "text", text: "handled message" }]);
  const queued: CcNativeRecord = { uuid: "queued", parentUuid: "cross-reply", type: "user", timestamp: at(8),
    promptSource: "queued", message: { role: "user", content: "queued human prompt" } };
  const call = assistant("queued-call", "queued", 9,
    [{ type: "tool_use", id: "queued-tool", name: "Read", input: { path: "/tmp/queued" } }]);
  const result: CcNativeRecord = { uuid: "queued-result", parentUuid: "queued-call", type: "user", timestamp: at(10),
    message: { role: "user", content: [{ type: "tool_result", tool_use_id: "queued-tool", content: "done" }] } };
  const f = await setup([...base(), compact, notification, notified, crossSession, crossReply, queued, call, result], "prompt-shapes");
  try {
    const cursor = (f.importer as unknown as { projection: { transcript: { scan: Function } } }).projection.transcript;
    const scan = cursor.scan.bind(cursor); let visits = 0;
    cursor.scan = (path: string, visit: Function, collect?: boolean) => scan(path, (...args: unknown[]) => {
      visits += 1;
      expect(f.importer.memory.store.db.isTransaction).toBe(false);
      return visit(...args);
    }, collect);
    const imported = await f.importer.reconcile();
    expect(imported).toMatchObject({ state: "ready", problems: [] });
    expect(visits).toBeGreaterThan(0);
    const entries = f.importer.memory.store.listSourceEntries(imported.coreSessionId!);
    for (const ids of [["notification", "notified"], ["cross-session", "cross-reply"], ["queued", "queued-call", "queued-result"]]) {
      const owned = ids.map(id => entries.find(entry => entry.nativeId === id)!);
      expect(owned.every(entry => entry && entry.turnId === owned[0]!.turnId)).toBe(true);
    }
    expect(f.importer.memory.store.listToolCalls(entries.find(entry => entry.nativeId === "queued")!.turnId)[0])
      .toMatchObject({ name: "Read", status: "success" });
    expect(imported.selectedEntryIds.map(id => f.importer.memory.store.getSourceEntry(id)!.nativeId).slice(-7))
      .toEqual(["notification", "notified", "cross-session", "cross-reply", "queued", "queued-call", "queued-result"]);
  } finally { f.importer.close(); }
});

test("host synthetic assistants remain ancestry connectors without becoming Raw or leaf authority", async () => {
  const compact: CcNativeRecord = { uuid: "compact", parentUuid: "a", type: "system", subtype: "compact_boundary", timestamp: at(3) };
  const summary: CcNativeRecord = { uuid: "summary", parentUuid: "compact", type: "user", isCompactSummary: true, timestamp: at(4),
    message: { role: "user", content: "summary" } };
  const metaPrompt: CcNativeRecord = { uuid: "meta-prompt", parentUuid: "summary", type: "user", isMeta: true, timestamp: at(5),
    message: { role: "user", content: "Continue from where you left off." } };
  const synthetic: CcNativeRecord = { uuid: "synthetic", parentUuid: "meta-prompt", type: "assistant", timestamp: at(6),
    message: { role: "assistant", model: "<synthetic>", content: [{ type: "text", text: "No response requested." }] } };
  const notification: CcNativeRecord = { uuid: "notification", parentUuid: "synthetic", type: "user", timestamp: at(7),
    promptSource: "system", message: { role: "user", content: "task completed" } };
  const call = assistant("actual", "notification", 8,
    [{ type: "tool_use", id: "actual-call", name: "Read", input: { path: "/tmp/actual" } }]);
  const result: CcNativeRecord = { uuid: "actual-result", parentUuid: "actual", type: "user", timestamp: at(9),
    message: { role: "user", content: [{ type: "tool_result", tool_use_id: "actual-call", content: "done" }] } };
  const f = await setup([...base(), compact, summary, metaPrompt, synthetic, notification, call, result], "host-synthetic-connector");
  try {
    const imported = await f.importer.reconcile();
    expect(imported).toMatchObject({ state: "ready", problems: [] });
    const entries = f.importer.memory.store.listSourceEntries(imported.coreSessionId!);
    expect(entries.map(entry => entry.nativeId)).toEqual(["u", "a", "notification", "actual", "actual-result"]);
    expect(imported.selectedEntryIds.map(id => f.importer.memory.store.getSourceEntry(id)!.nativeId))
      .toEqual(["u", "a", "notification", "actual", "actual-result"]);
    expect(entries.find(entry => entry.nativeId === "notification")!.turnId).toBe(entries.find(entry => entry.nativeId === "actual-result")!.turnId);
  } finally { f.importer.close(); }

  const tail = await setup([...base(), compact, summary, metaPrompt, synthetic], "host-synthetic-compaction-leaf");
  try {
    const imported = await tail.importer.reconcile();
    expect(imported).toMatchObject({ state: "ready", problems: [] });
    expect(readBinding(tail.config, tail.nativeSessionId)!.selectedLeafUuid).toBe("compact");
    expect(imported.selectedEntryIds.map(id => tail.importer.memory.store.getSourceEntry(id)!.nativeId)).toEqual(["u", "a"]);
  } finally { tail.importer.close(); }

  const quota = { ...synthetic, uuid: "synthetic-quota", message: { role: "assistant", model: "<synthetic>",
    content: [{ type: "text", text: "Host quota notice" }] }, isApiErrorMessage: true };
  const normalSameText = { ...synthetic, uuid: "normal-same-text", message: { role: "assistant", model: "claude-test",
    content: [{ type: "text", text: "No response requested." }] } };
  expect(classifySourceRecord(synthetic)).toBeNull();
  expect(classifySourceRecord(quota)).toBeNull();
  expect(classifySourceRecord(normalSameText)).toMatchObject({ kind: "assistant", text: "No response requested." });
});

test("a fatal later record preserves earlier commits and does not leak rolled-back call identity", async () => {
  const f = await setup(base(), "record-fatal-retry");
  try {
    const first = await f.importer.reconcile();
    const next = prompt("fatal-u", "a", 3, "survives fatal sibling");
    const reply = assistant("fatal-a", "fatal-u", 4,
      [{ type: "tool_use", id: "fatal-call", name: "Read", input: { path: "/tmp/fatal" } }]);
    appendFileSync(f.transcriptPath, line(next) + line(reply));
    const appendEntry = f.importer.memory.appendEntry; let failed = false;
    f.importer.memory.appendEntry = input => {
      if (input.nativeId === "fatal-a" && !failed) { failed = true; throw new Error("injected later-record failure"); }
      return appendEntry(input);
    };
    await expect(f.importer.reconcile()).rejects.toThrow("injected later-record failure");
    const committedPrompt = f.importer.memory.store.findSourceEntry(first.coreSessionId!, f.nativeSessionId, "fatal-u")!;
    expect(committedPrompt).not.toBeNull();
    expect(f.importer.memory.store.findSourceEntry(first.coreSessionId!, f.nativeSessionId, "fatal-a")).toBeNull();
    expect(f.importer.memory.store.listToolCalls(committedPrompt.turnId)).toEqual([]);
    f.importer.memory.appendEntry = appendEntry;
    const retried = await f.importer.reconcile();
    expect(retried).toMatchObject({ state: "ready", problems: [] });
    expect(f.importer.memory.store.listTurns(first.coreSessionId!).filter(turn => turn.userPrompt === "survives fatal sibling")).toHaveLength(1);
    expect(f.importer.memory.store.listSourceEntries(first.coreSessionId!).filter(entry => entry.nativeId.startsWith("fatal-"))).toHaveLength(2);
    expect(f.importer.memory.store.listToolCalls(committedPrompt.turnId)).toHaveLength(1);
  } finally { f.importer.close(); }
});

test("a projection failure keeps the suffix retryable after record commits", async () => {
  const f = await setup(base(), "projection-retry");
  try {
    const first = await f.importer.reconcile();
    const next = prompt("projection-u", "a", 3, "projection retry");
    const reply = assistant("projection-a", "projection-u", 4,
      [{ type: "tool_use", id: "projection-call", name: "Read", input: { path: "/tmp/projection" } }]);
    appendFileSync(f.transcriptPath, line(next) + line(reply));
    const publish = f.importer.memory.store.publishSourcePath.bind(f.importer.memory.store); let failed = false;
    f.importer.memory.store.publishSourcePath = (...args: Parameters<typeof publish>) => {
      if (!failed) { failed = true; throw new Error("injected projection failure"); }
      return publish(...args);
    };
    await expect(f.importer.reconcile()).rejects.toThrow("injected projection failure");
    expect(f.importer.memory.store.findSourceEntry(first.coreSessionId!, f.nativeSessionId, "projection-u")).not.toBeNull();
    expect(f.importer.memory.store.findSourceEntry(first.coreSessionId!, f.nativeSessionId, "projection-a")).not.toBeNull();
    f.importer.memory.store.publishSourcePath = publish;
    const retried = await f.importer.reconcile();
    expect(retried).toMatchObject({ state: "ready", problems: [] });
    expect(retried.selectedEntryIds.slice(-2).map(id => f.importer.memory.store.getSourceEntry(id)!.nativeId))
      .toEqual(["projection-u", "projection-a"]);
    expect(f.importer.memory.store.listSourceEntries(first.coreSessionId!).filter(entry => entry.nativeId.startsWith("projection-"))).toHaveLength(2);
    expect(f.importer.memory.store.listTurns(first.coreSessionId!).filter(turn => turn.userPrompt === "projection retry")).toHaveLength(1);
    expect(f.importer.memory.store.listToolCalls(retried.headTurnId!)).toHaveLength(1);
  } finally { f.importer.close(); }
});

test("a physically forward result dependency converges in one suffix while contradictions do not trap later siblings", async () => {
  const call = assistant("call", "a", 3, [{ type: "tool_use", id: "call-1", name: "Read", input: { path: "/tmp/a" } }]);
  const result: CcNativeRecord = { uuid: "result", parentUuid: "call", type: "user", timestamp: at(4),
    message: { role: "user", content: [{ type: "tool_result", tool_use_id: "call-1", content: "done" }] } };
  const f = await setup([...base(), result, call]);
  try {
    const imported = await f.importer.reconcile();
    expect(imported.state).toBe("ready");
    expect(f.importer.memory.store.listSourceEntries(imported.coreSessionId!).map(entry => entry.nativeId))
      .toEqual(["u", "a", "call", "result"]);
    expect(f.importer.memory.store.listToolCalls(imported.headTurnId!)[0]).toMatchObject({ status: "success" });

    const duplicate = assistant("duplicate", "call", 5,
      [{ type: "tool_use", id: "call-1", name: "Read", input: { path: "/tmp/b" } }]);
    const later = prompt("later-sibling", "call", 6, "valid after conflict");
    writeFileSync(f.transcriptPath, [...base(), result, call, duplicate, later].map(line).join(""));
    const partial = await f.importer.reconcile();
    expect(partial).toMatchObject({ state: "not-ready", problems: ["native tool call call-1 repeats within one Turn"] });
    expect(f.importer.memory.store.findSourceEntry(imported.coreSessionId!, f.nativeSessionId, "duplicate")).toBeNull();
    expect(f.importer.memory.store.findSourceEntry(imported.coreSessionId!, f.nativeSessionId, "later-sibling")).not.toBeNull();
    expect(readBinding(f.config, f.nativeSessionId)!.selectedLeafUuid).toBe("later-sibling");
  } finally { f.importer.close(); }
});

test("failed required ancestry blocks dependent sources without blocking an independent sibling", async () => {
  const failedPrompt = { ...prompt("bad-u", "a", 3, "must own descendants"), promptSource: "queued", timestamp: "invalid" };
  const dependentCall = assistant("bad-child", "bad-u", 4,
    [{ type: "tool_use", id: "blocked-call", name: "Read", input: { path: "/tmp/blocked" } }]);
  const dependentResult: CcNativeRecord = { uuid: "bad-result", parentUuid: "bad-child", type: "user", timestamp: at(5),
    message: { role: "user", content: [{ type: "tool_result", tool_use_id: "blocked-call", content: "must stay blocked" }] } };
  const sibling = prompt("valid-sibling", "a", 6, "independent progress");
  const f = await setup([...base(), failedPrompt, dependentCall, dependentResult, sibling], "failed-required-ancestry");
  try {
    const result = await f.importer.reconcile();
    expect(result).toMatchObject({ state: "not-ready", problems: ["native source bad-u has no valid timestamp"] });
    for (const nativeId of ["bad-u", "bad-child", "bad-result"])
      expect(f.importer.memory.store.findSourceEntry(result.coreSessionId!, f.nativeSessionId, nativeId)).toBeNull();
    expect(f.importer.memory.store.findSourceEntry(result.coreSessionId!, f.nativeSessionId, "valid-sibling")).not.toBeNull();
    const firstTurn = f.importer.memory.store.findSourceEntry(result.coreSessionId!, f.nativeSessionId, "u")!.turnId;
    expect(f.importer.memory.store.listToolCalls(firstTurn)).toEqual([]);
    expect(result.selectedEntryIds.map(id => f.importer.memory.store.getSourceEntry(id)!.nativeId))
      .toEqual(["u", "a", "valid-sibling"]);
    expect(readBinding(f.config, f.nativeSessionId)!.selectedLeafUuid).toBe("valid-sibling");
  } finally { f.importer.close(); }
});

test("all record diagnostics survive unchanged and append wakes and clear on a clean reset", async () => {
  const badOne = { ...prompt("bad-one", "a", 3), timestamp: "invalid-one" };
  const badTwo = { ...prompt("bad-two", "a", 4), promptSource: "system", timestamp: "invalid-two" };
  const f = await setup([...base(), badOne, badTwo], "stable-record-diagnostics");
  try {
    const expected = ["native source bad-one has no valid timestamp", "native source bad-two has no valid timestamp"];
    expect((await f.importer.reconcile()).problems).toEqual(expected);
    expect((await f.importer.reconcile()).problems).toEqual(expected);

    const valid = prompt("valid", "a", 5, "valid append");
    appendFileSync(f.transcriptPath, line(valid));
    const appended = await f.importer.reconcile();
    expect(appended.problems).toEqual(expected);
    expect(f.importer.memory.store.findSourceEntry(appended.coreSessionId!, f.nativeSessionId, "valid")).not.toBeNull();
    expect((await f.importer.reconcile()).problems).toEqual(expected);

    writeFileSync(f.transcriptPath, [...base(), valid].map(line).join(""));
    expect(await f.importer.reconcile()).toMatchObject({ state: "ready", problems: [] });
    expect((await f.importer.reconcile()).problems).toEqual([]);
  } finally { f.importer.close(); }
});

test.each(["attachment-first", "assistant-first"])("a rejected sole assistant never authorizes bootstrap allocation (%s)", async order => {
  const conflictingAssistant = assistant("dup", "u", 2, [{ type: "text", text: "rejected assistant" }]);
  const conflictingAttachment: CcNativeRecord = { uuid: "dup", parentUuid: "u", type: "attachment", timestamp: at(2),
    attachment: { type: "hook_additional_context", content: ["synthetic"] } };
  const duplicates = order === "attachment-first" ? [conflictingAttachment, conflictingAssistant] : [conflictingAssistant, conflictingAttachment];
  const f = await setup([prompt("u", null, 1), ...duplicates], `bootstrap-${order}`);
  try {
    const result = await f.importer.reconcile();
    expect(result).toMatchObject({ state: "not-ready", coreSessionId: null,
      problems: ["native transcript UUID dup changed within the completed file"] });
    expect(readBinding(f.config, f.nativeSessionId)!.coreSessionId).toBeNull();
  } finally { f.importer.close(); }
});

test("a later accepted assistant authorizes allocation while the earlier conflict remains diagnosed", async () => {
  const conflictingAttachment: CcNativeRecord = { uuid: "dup", parentUuid: "u", type: "attachment", timestamp: at(2),
    attachment: { type: "hook_additional_context", content: ["synthetic"] } };
  const conflictingAssistant = assistant("dup", "u", 2, [{ type: "text", text: "rejected assistant" }]);
  const f = await setup([prompt("u", null, 1), conflictingAttachment, conflictingAssistant], "bootstrap-later-valid");
  try {
    expect(await f.importer.reconcile()).toMatchObject({ state: "not-ready", coreSessionId: null });
    appendFileSync(f.transcriptPath, line(assistant("accepted", "u", 3, [{ type: "text", text: "accepted assistant" }])));
    const result = await f.importer.reconcile();
    expect(result).toMatchObject({ state: "not-ready", coreSessionId: expect.any(Number),
      problems: ["native transcript UUID dup changed within the completed file"] });
    const binding = readBinding(f.config, f.nativeSessionId)!;
    expect(f.importer.memory.store.getSession(binding.coreSessionId!)?.firstReplyAt).toBe(at(3));
    expect(f.importer.memory.store.findSourceEntry(binding.coreSessionId!, f.nativeSessionId, "accepted")?.text).toBe("accepted assistant");
  } finally { f.importer.close(); }
});

test("a conflicting UUID is reported per record while later valid progress remains durable", async () => {
  const first = assistant("duplicate-id", "a", 3, [{ type: "text", text: "first" }]);
  const conflict = assistant("duplicate-id", "a", 3, [{ type: "text", text: "changed" }]);
  const later = prompt("later", "a", 4, "later valid sibling");
  const f = await setup([...base(), first, conflict, later], "uuid-conflict-progress");
  try {
    const result = await f.importer.reconcile();
    expect(result).toMatchObject({ state: "not-ready", problems: ["native transcript UUID duplicate-id changed within the completed file"] });
    expect(f.importer.memory.store.findSourceEntry(result.coreSessionId!, f.nativeSessionId, "duplicate-id")!.text).toBe("first");
    expect(f.importer.memory.store.findSourceEntry(result.coreSessionId!, f.nativeSessionId, "later")).not.toBeNull();
    const next = prompt("next", "later", 5, "next valid source");
    writeFileSync(f.transcriptPath, [...base(), first, conflict, later, next].map(line).join(""));
    const appended = await f.importer.reconcile();
    expect(appended.problems).toContain("native transcript UUID duplicate-id changed within the completed file");
    expect(f.importer.memory.store.findSourceEntry(result.coreSessionId!, f.nativeSessionId, "next")).not.toBeNull();

    writeFileSync(f.transcriptPath, [...base(), first, later, next].map(line).join(""));
    const rebuilt = await f.importer.reconcile();
    expect(rebuilt).toMatchObject({ state: "ready", problems: [] });
  } finally { f.importer.close(); }
});

test("persisted call identity survives truncation, restart, and reset", async () => {
  const firstCall = assistant("call-one", "u", 2,
    [{ type: "tool_use", id: "same-call", name: "Read", input: { path: "/tmp/one" } }]);
  const f = await setup([prompt("u", null, 1), firstCall], "restart-call-identity");
  let importer = f.importer;
  try {
    const first = await importer.reconcile();
    importer.close();
    const result: CcNativeRecord = { uuid: "result", parentUuid: "call-one", type: "user", timestamp: at(3),
      message: { role: "user", content: [{ type: "tool_result", tool_use_id: "same-call", content: "done" }] } };
    writeFileSync(f.transcriptPath, [prompt("u", null, 1), firstCall, result].map(line).join(""));
    importer = new CcImporter(f.config, readBinding(f.config, f.nativeSessionId)!);
    const append = importer.memory.appendEntry; let failed = false;
    importer.memory.appendEntry = input => { if (input.nativeId === "result" && !failed) { failed = true; throw new Error("injected append failure"); } return append(input); };
    await expect(importer.reconcile()).rejects.toThrow("injected append failure");
    importer.memory.appendEntry = append;
    expect((await importer.reconcile()).appendedEntryIds.map(id => importer.memory.store.getSourceEntry(id)!.nativeId)).toEqual(["result"]);

    importer.close();
    writeFileSync(f.transcriptPath, [prompt("u", null, 1), assistant("call-two", "u", 4,
      [{ type: "tool_use", id: "same-call", name: "Read", input: { path: "/tmp/two" } }])].map(line).join(""));
    importer = new CcImporter(f.config, readBinding(f.config, f.nativeSessionId)!);
    const conflict = await importer.reconcile();
    expect(conflict).toMatchObject({ state: "not-ready", problems: ["native tool call same-call repeats within one Turn"] });
    expect(importer.memory.store.listToolCalls(first.headTurnId!)).toHaveLength(1);
    expect(importer.memory.store.findSourceEntry(first.coreSessionId!, f.nativeSessionId, "call-two")).toBeNull();
  } finally { importer.close(); }
});

test("a failed binding receipt reuses the database-published rewind branch in-process and after restart", async () => {
  const f = await setup([...base(), prompt("old-u", "a", 3), assistant("old-a", "old-u", 4, [{ type: "text", text: "old" }])],
    "binding-retry");
  let importer = f.importer;
  const injectReceiptFailure = async () => {
    const original = importer.memory.store.publishSourcePath.bind(importer.memory.store);
    const bindingDirectory = dirname(bindingPath(f.config, f.nativeSessionId)), moved = `${bindingDirectory}.held`;
    importer.memory.store.publishSourcePath = (...args: Parameters<typeof original>) => {
      const value = original(...args); renameSync(bindingDirectory, moved); return value;
    };
    await expect(importer.reconcile()).rejects.toThrow("binding disappeared");
    renameSync(moved, bindingDirectory); importer.memory.store.publishSourcePath = original;
  };
  try {
    const initial = await importer.reconcile();
    const rewind = [...base(), prompt("new-u", "a", 5), assistant("new-a", "new-u", 6, [{ type: "text", text: "new" }])];
    writeFileSync(f.transcriptPath, rewind.map(line).join(""));
    await injectReceiptFailure();
    const published = importer.memory.store.db.prepare(
      "SELECT branch, entry_ids FROM source_paths WHERE session_id = ? ORDER BY branch").all(initial.coreSessionId!) as { branch: string; entry_ids: string }[];
    expect(published).toHaveLength(2);
    const retried = await importer.reconcile();
    expect(retried.branch).toBe(published.find(row => row.branch !== initial.branch)!.branch);
    expect(importer.memory.store.db.prepare("SELECT branch FROM source_paths WHERE session_id = ?").all(initial.coreSessionId!)).toHaveLength(2);

    importer.close();
    importer = new CcImporter(f.config, readBinding(f.config, f.nativeSessionId)!);
    const secondRewind = [...base(), prompt("third-u", "a", 7), assistant("third-a", "third-u", 8, [{ type: "text", text: "third" }])];
    writeFileSync(f.transcriptPath, secondRewind.map(line).join(""));
    await injectReceiptFailure();
    importer.close(); importer = new CcImporter(f.config, readBinding(f.config, f.nativeSessionId)!);
    const afterRestart = await importer.reconcile();
    const matching = importer.memory.store.db.prepare(
      "SELECT branch FROM source_paths WHERE session_id = ? AND entry_ids = ?").all(initial.coreSessionId!, JSON.stringify(afterRestart.selectedEntryIds));
    expect(matching).toHaveLength(1);
  } finally { importer.close(); }
});

test("divergent compaction leaves use native identity and retry deterministically after restart", async () => {
  const compact = (uuid: string): CcNativeRecord => ({ uuid, parentUuid: null, logicalParentUuid: "a", type: "system",
    subtype: "compact_boundary", timestamp: at(3) });
  const one = [...base(), compact("compact-one")], two = [...base(), compact("compact-two")];
  const f = await setup(one, "compaction-branch-identity");
  let importer = f.importer;
  try {
    const first = await importer.reconcile();
    expect(first.branch).toBe("main");
    writeFileSync(f.transcriptPath, two.map(line).join(""));

    const publish = importer.memory.store.publishSourcePath.bind(importer.memory.store);
    const bindingDirectory = dirname(bindingPath(f.config, f.nativeSessionId)), moved = `${bindingDirectory}.held`;
    importer.memory.store.publishSourcePath = (...args: Parameters<typeof publish>) => {
      const value = publish(...args); renameSync(bindingDirectory, moved); return value;
    };
    await expect(importer.reconcile()).rejects.toThrow("binding disappeared");
    renameSync(moved, bindingDirectory); importer.memory.store.publishSourcePath = publish;
    expect(importer.memory.store.selectedSourceEntryIds(first.coreSessionId!, "cc:compact-two")).toEqual(first.selectedEntryIds);

    importer.close(); importer = new CcImporter(f.config, readBinding(f.config, f.nativeSessionId)!);
    const restarted = await importer.reconcile();
    expect(restarted).toMatchObject({ branch: "cc:compact-two", selectedEntryIds: first.selectedEntryIds });

    writeFileSync(f.transcriptPath, one.map(line).join(""));
    const returned = await importer.reconcile();
    expect(returned.branch).toBe("cc:compact-one");
    expect(returned.branch).not.toBe(first.branch);

    writeFileSync(f.transcriptPath, two.map(line).join(""));
    expect((await importer.reconcile()).branch).toBe(restarted.branch);
  } finally { importer.close(); }
});

test("bootstrap retains scalars only and a compact boundary can remain the native head across restart", async () => {
  const compact: CcNativeRecord = { uuid: "compact", parentUuid: "a", type: "system", subtype: "compact_boundary", timestamp: at(3) };
  const f = await setup([...base(), compact], "bootstrap-release");
  let importer = f.importer;
  try {
    const first = await importer.reconcile();
    const retained = (importer as unknown as { projection: { bootstrap: unknown } }).projection.bootstrap as Record<string, unknown>;
    expect(retained).toEqual(expect.objectContaining({ createdAt: at(1), firstAssistantAt: at(2) }));
    expect(retained).not.toHaveProperty("snapshot");
    expect(readBinding(f.config, f.nativeSessionId)!.selectedLeafUuid).toBe("compact");
    importer.close(); importer = new CcImporter(f.config, readBinding(f.config, f.nativeSessionId)!);
    const restarted = await importer.reconcile();
    expect(restarted.state).toBe("ready");
    expect(restarted.selectedEntryIds).toEqual(first.selectedEntryIds);
    expect(importer.memory.store.findNativeTurn(first.coreSessionId!, f.nativeSessionId, "compact")?.kind).toBe("compaction");
  } finally { importer.close(); }
});
