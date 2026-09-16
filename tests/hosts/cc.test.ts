import { afterEach, expect, test } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { TraceMemory } from "../../src/core/api/index.ts";
import { resolveCcHostConfig } from "../../src/hosts/cc/config.ts";
import { piSourceBlocks } from "../../src/hosts/pi/source.ts";
import { recordSessionStart, readBinding } from "../../src/hosts/cc/binding.ts";
import { CcImporter } from "../../src/hosts/cc/importer.ts";
import { ccSourceBlocks, classifySourceRecord, readCompleteTranscript, selectedNativePath,
  type CcNativeRecord } from "../../src/hosts/cc/transcript.ts";

const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });
const at = (second: number) => `2026-01-01T00:00:${String(second).padStart(2, "0")}.000Z`;
const line = (value: unknown) => `${JSON.stringify(value)}\n`;
const sdkPrompt = (promptId: string) => ({ promptId, promptSource: "sdk", userType: "external" });
function fixture() {
  const dir = mkdtempSync(join(tmpdir(), "tm-cc-import-")); dirs.push(dir);
  const transcriptPath = join(dir, "native.jsonl"), nativeSessionId = "native-session-1";
  const config = resolveCcHostConfig({ dbPath: join(dir, "memory.sqlite"), stateDir: join(dir, "state"), baseline: "2025-01-01T00:00:00.000Z",
    pollIntervalMs: 10, finalSyncTimeoutMs: 500, finalSyncStablePolls: 2 });
  const records = [
    { uuid: "u1", parentUuid: null, type: "user", timestamp: at(1), ...sdkPrompt("p1"), message: { role: "user", content: "first" } },
    { uuid: "a1", parentUuid: "u1", type: "assistant", timestamp: at(2), message: { id: "reused-message-id", role: "assistant", content: [
      { type: "thinking", thinking: "reason" }, { type: "text", text: "answer" }, { type: "tool_use", id: "call-1", name: "Read", input: { path: "/tmp/a" } }] } },
    { uuid: "r1", parentUuid: "a1", type: "user", timestamp: at(3), toolUseResult: { stdout: "kept in Raw" },
      message: { role: "user", content: [{ type: "tool_result", tool_use_id: "call-1", content: [{ type: "text", text: "result" }] }] } },
    { uuid: "hook", parentUuid: "r1", type: "progress", timestamp: at(4), data: { type: "hook_progress" } },
    { uuid: "command", parentUuid: "r1", type: "user", timestamp: at(4), message: { role: "user", content: "<command-name>/compact</command-name>" } },
    { uuid: "side", parentUuid: "a1", type: "assistant", isSidechain: true, timestamp: at(4), message: { role: "assistant", content: [{ type: "text", text: "side" }] } },
    { uuid: "summary", parentUuid: "r1", type: "user", isCompactSummary: true, timestamp: at(4), message: { role: "user", content: "summary" } },
    { uuid: "compact", parentUuid: null, logicalParentUuid: "r1", type: "system", subtype: "compact_boundary", isMeta: false, timestamp: at(5) },
    { uuid: "u2", parentUuid: "compact", type: "user", timestamp: at(8), ...sdkPrompt("p2"), message: { role: "user", content: [{ type: "text", text: "abandoned" }] } },
    { uuid: "a2", parentUuid: "u2", type: "assistant", timestamp: at(9), message: { id: "reused-message-id", role: "assistant", content: [{ type: "text", text: "old sibling" }] } },
    { type: "last-prompt", leafUuid: "a2" },
    { uuid: "local-meta", parentUuid: "r1", type: "user", isMeta: true, timestamp: at(5),
      message: { role: "user", content: "<local-command-caveat>generated locally</local-command-caveat>" } },
    { uuid: "local-command", parentUuid: "local-meta", type: "user", timestamp: at(5),
      message: { role: "user", content: "<command-name>/model</command-name>" } },
    { uuid: "hook-control", parentUuid: "local-command", type: "system", subtype: "stop_hook_summary", timestamp: at(5) },
    { uuid: "u3", parentUuid: "hook-control", type: "user", timestamp: at(6), ...sdkPrompt("p3"), message: { role: "user", content: "replacement" } },
    { uuid: "a3", parentUuid: "u3", type: "assistant", timestamp: at(7), message: { id: "reused-message-id", role: "assistant", content: [{ type: "text", text: "selected" }] } },
  ];
  return { dir, transcriptPath, nativeSessionId, config, records };
}
async function importerFixture() {
  const f = fixture(); writeFileSync(f.transcriptPath, f.records.map(line).join(""));
  const binding = await recordSessionStart(f.config, { hook_event_name: "SessionStart", session_id: f.nativeSessionId,
    transcript_path: f.transcriptPath }, at(1));
  return { ...f, importer: new CcImporter(f.config, binding) };
}

test("CC transcript parsing is newline-safe and structurally normalizes native source", () => {
  const f = fixture();
  writeFileSync(f.transcriptPath, f.records.slice(0, 3).map(line).join("") + '{"uuid":"partial"');
  const snapshot = readCompleteTranscript(f.transcriptPath);
  expect(snapshot.records).toHaveLength(3);
  expect(snapshot.incompleteBytes).toBeGreaterThan(0);
  expect(classifySourceRecord(f.records[0]!)).toMatchObject({ kind: "user", text: "first" });
  expect(classifySourceRecord(f.records[2]!)).toMatchObject({ kind: "toolResult" });
  expect(classifySourceRecord(f.records[4]!)).toBeNull();
  expect(classifySourceRecord(f.records[5]!)).toBeNull();
  const selected = selectedNativePath(f.records);
  expect(selected).toMatchObject({ leafUuid: "a3" });
  expect(selected.records.map(record => record.uuid)).toEqual([
    "u1", "a1", "r1", "local-meta", "local-command", "hook-control", "u3", "a3",
  ]);
  expect(selected.records.some(record => classifySourceRecord(record) === null)).toBe(true);
  expect(selectedNativePath(f.records.filter(record => record.type !== "last-prompt"))).toEqual(selected);
  expect(Date.parse(f.records.find(record => record.uuid === "a3")!.timestamp as string))
    .toBeLessThan(Date.parse(f.records.find(record => record.uuid === "a2")!.timestamp as string));
  const assistant = classifySourceRecord(f.records[1]!)!;
  expect(ccSourceBlocks({ sessionId: 1, turnId: 1, nativeLineage: "n", nativeId: "a1", role: "assistant",
    text: "answer", raw: JSON.stringify(f.records[1]), calls: assistant.kind === "assistant" ? [{ ...assistant.calls[0]!, ordinal: 1 }] : [] }))
    .toEqual([{ kind: "thinking", text: "reason" }, { kind: "text", text: "answer" },
      { kind: "call", call: expect.objectContaining({ callId: "call-1", ordinal: 1 }) }]);
});

test("source classification uses native provenance rather than user-controlled payload text", () => {
  const payloads = ["<command-name>please explain this XML tag, not a local command",
    "<local-command-caveat>this is literal text", "<local-command-stdout>this is also literal text"];
  for (const [index, payload] of payloads.entries()) {
    const typed = { uuid: `typed-${index}`, parentUuid: null, type: "user", timestamp: at(1), promptId: `typed-prompt-${index}`,
      promptSource: "typed", userType: "external", origin: { kind: "human" }, message: { role: "user", content: payload } };
    const sdk = { ...typed, uuid: `sdk-${index}`, promptId: `sdk-prompt-${index}`, promptSource: "sdk", origin: undefined };
    const generated = { ...typed, uuid: `generated-${index}`, promptSource: undefined, origin: undefined };
    expect(classifySourceRecord(typed)).toMatchObject({ kind: "user", text: payload });
    expect(classifySourceRecord(sdk)).toMatchObject({ kind: "user", text: payload });
    expect(classifySourceRecord(generated)).toBeNull();
  }
  const typed = { uuid: "typed", parentUuid: null, type: "user", timestamp: at(1), promptId: "typed-prompt",
    promptSource: "typed", userType: "external", origin: { kind: "human" }, message: { role: "user", content: "evidence" } };
  expect(classifySourceRecord({ ...typed, uuid: "meta", isMeta: true })).toBeNull();
  expect(classifySourceRecord({ ...typed, uuid: "side", isSidechain: true })).toBeNull();
  expect(classifySourceRecord({ ...typed, uuid: "summary", isCompactSummary: true })).toBeNull();
});

test("selected native ancestry honors logical compaction parents and reports missing parents and cycles", () => {
  const records: CcNativeRecord[] = [
    { uuid: "root", parentUuid: null, type: "user", timestamp: at(9), ...sdkPrompt("root-prompt"), message: { role: "user", content: "root" } },
    { uuid: "fragment", parentUuid: "root", type: "assistant", timestamp: at(9),
      message: { id: "same-message", role: "assistant", content: [{ type: "thinking", thinking: "work" }] } },
    { uuid: "compact", parentUuid: "not-the-logical-parent", logicalParentUuid: "fragment", type: "system",
      subtype: "compact_boundary", timestamp: at(8) },
    { uuid: "attachment", parentUuid: "compact", type: "attachment", timestamp: at(7) },
    { uuid: "next", parentUuid: "attachment", type: "user", timestamp: at(6), ...sdkPrompt("next-prompt"), message: { role: "user", content: "next" } },
    { uuid: "answer", parentUuid: "next", type: "assistant", timestamp: at(5),
      message: { id: "same-message", role: "assistant", content: [{ type: "text", text: "answer" }] } },
    { type: "last-prompt", leafUuid: "fragment" },
  ];
  expect(selectedNativePath(records).records.map(record => record.uuid)).toEqual([
    "root", "fragment", "compact", "attachment", "next", "answer",
  ]);
  expect(selectedNativePath([...records, { uuid: "missing", parentUuid: "absent", type: "assistant", timestamp: at(4),
    message: { role: "assistant", content: [{ type: "text", text: "broken" }] } }]).problem)
    .toBe("native lineage parent absent is missing");
  expect(selectedNativePath([
    { uuid: "cycle-user", parentUuid: "cycle-answer", type: "user", timestamp: at(1), ...sdkPrompt("cycle-prompt"), message: { role: "user", content: "cycle" } },
    { uuid: "cycle-answer", parentUuid: "cycle-user", type: "assistant", timestamp: at(2),
      message: { role: "assistant", content: [{ type: "text", text: "cycle" }] } },
  ]).problem).toBe("native lineage cycle at cycle-answer");
});

test("CC import is idempotent, preserves all source evidence, and projects only native selected lineage", async () => {
  const f = await importerFixture();
  try {
    const first = await f.importer.reconcile();
    expect(first.state).toBe("ready");
    expect(first.appendedEntryIds).toHaveLength(7);
    expect(first.selectedEntryIds).toHaveLength(5);
    const sessionId = first.coreSessionId!;
    expect(f.importer.memory.store.getSession(sessionId)).toMatchObject({ host: `cc:${f.nativeSessionId}`, startedAt: at(1) });
    expect(f.importer.memory.store.listTurns(sessionId).map(turn => ({ kind: turn.kind, parent: turn.parentTurnId, user: turn.userPrompt })))
      .toEqual([{ kind: "turn", parent: null, user: "first" }, { kind: "compaction", parent: 1, user: null },
        { kind: "turn", parent: 2, user: "abandoned" }, { kind: "turn", parent: 1, user: "replacement" }]);
    const entries = f.importer.memory.store.listSourceEntries(sessionId);
    expect(entries.map(entry => entry.nativeId)).toEqual(["u1", "a1", "r1", "u2", "a2", "u3", "a3"]);
    expect(entries.filter(entry => entry.turnId === 1).map(entry => entry.entryOrdinal)).toEqual([1, 2, 3]);
    expect(entries.find(entry => entry.nativeId === "r1")!.calls[0]).toMatchObject({ ordinal: 1, name: "Read", status: "success" });
    expect(f.importer.memory.store.listToolCalls(1)[0]).toMatchObject({ status: "success" });
    expect(f.importer.memory.store.db.prepare("SELECT entry_ids FROM source_paths WHERE session_id = ? AND branch = ?").get(sessionId, first.branch))
      .toEqual({ entry_ids: JSON.stringify(first.selectedEntryIds) });
    expect(first.selectedEntryIds.map(id => f.importer.memory.store.getSourceEntry(id)!.nativeId)).toEqual(["u1", "a1", "r1", "u3", "a3"]);
    expect(readBinding(f.config, f.nativeSessionId)!.selectedPathUuids).toEqual([
      "u1", "a1", "r1", "local-meta", "local-command", "hook-control", "u3", "a3",
    ]);
    expect(entries.filter(entry => entry.role === "assistant").map(entry => entry.nativeId)).toEqual(["a1", "a2", "a3"]);
    expect(f.importer.memory.trace("T1#E2@call-1", { full: true })).toContain("Read");
    expect(f.importer.memory.trace("T1#E3@call-1", { full: true })).toContain("result");
    expect((await f.importer.reconcile()).appendedEntryIds).toEqual([]);
    expect(f.importer.memory.store.listTurns(sessionId)).toHaveLength(4);
    expect(f.importer.memory.store.db.prepare("SELECT native_id, kind FROM native_turns ORDER BY turn_id").all())
      .toEqual([{ native_id: "u1", kind: "turn" }, { native_id: "compact", kind: "compaction" },
        { native_id: "u2", kind: "turn" }, { native_id: "u3", kind: "turn" }]);
  } finally { f.importer.close(); }
});

test("a tool result appended after its call is imported incrementally into the owning Turn", async () => {
  const f = fixture();
  writeFileSync(f.transcriptPath, [f.records[0], f.records[1], { type: "last-prompt", leafUuid: "a1" }].map(line).join(""));
  const binding = await recordSessionStart(f.config, { hook_event_name: "SessionStart", session_id: f.nativeSessionId,
    transcript_path: f.transcriptPath }, at(1));
  const importer = new CcImporter(f.config, binding);
  try {
    const first = await importer.reconcile();
    expect(importer.memory.store.listToolCalls(first.headTurnId!)[0]).toMatchObject({ status: "attempted", result: null });
    writeFileSync(f.transcriptPath, f.records.map(line).join(""));
    const second = await importer.reconcile();
    expect(second.appendedEntryIds.map(id => importer.memory.store.getSourceEntry(id)!.nativeId)).toContain("r1");
    expect(importer.memory.store.listToolCalls(first.headTurnId!)[0]).toMatchObject({ status: "success" });
  } finally { importer.close(); }
});

test("a persisted rewind creates a new core branch without deleting its sibling or moving the frozen source path", async () => {
  const f = fixture();
  const replacementStart = f.records.findIndex(record => record.uuid === "local-meta");
  writeFileSync(f.transcriptPath, f.records.slice(0, replacementStart).map(line).join(""));
  const binding = await recordSessionStart(f.config, { hook_event_name: "SessionStart", session_id: f.nativeSessionId,
    transcript_path: f.transcriptPath }, at(1));
  const importer = new CcImporter(f.config, binding);
  try {
    const first = await importer.reconcile();
    expect(first.selectedEntryIds.map(id => importer.memory.store.getSourceEntry(id)!.nativeId)).toEqual(["u1", "a1", "r1", "u2", "a2"]);
    writeFileSync(f.transcriptPath, f.records.map(line).join(""));
    const second = await importer.reconcile();
    expect(second.branch).not.toBe(first.branch);
    expect(second.selectedEntryIds.map(id => importer.memory.store.getSourceEntry(id)!.nativeId)).toEqual(["u1", "a1", "r1", "u3", "a3"]);
    expect(importer.memory.store.listSourceEntries(second.coreSessionId!)).toHaveLength(7);
    expect(importer.memory.store.db.prepare("SELECT entry_ids FROM source_paths WHERE session_id = ? AND branch = ?").get(second.coreSessionId!, first.branch))
      .toEqual({ entry_ids: JSON.stringify(first.selectedEntryIds) });
  } finally { importer.close(); }
});

test("an incomplete tail stays pending while the complete prefix projects, and changed sources fail", async () => {
  const f = await importerFixture();
  try {
    const first = await f.importer.reconcile(), count = f.importer.memory.store.listSourceEntries(first.coreSessionId!).length;
    const continuation = [
      { uuid: "u4", parentUuid: "a3", type: "user", timestamp: at(10), ...sdkPrompt("p4"), message: { role: "user", content: "continued" } },
      { uuid: "a4", parentUuid: "u4", type: "assistant", timestamp: at(11), message: { role: "assistant", content: [{ type: "text", text: "continued answer" }] } },
    ];
    writeFileSync(f.transcriptPath, [...f.records, ...continuation].map(line).join("") + '{"uuid":');
    const partial = await f.importer.reconcile();
    expect(partial.state).toBe("ready"); expect(partial.problems).toEqual([]); expect(partial.snapshot.incompleteBytes).toBeGreaterThan(0);
    expect(partial.appendedEntryIds.map(id => f.importer.memory.store.getSourceEntry(id)!.nativeId)).toEqual(["u4", "a4"]);
    expect(f.importer.memory.store.listSourceEntries(first.coreSessionId!)).toHaveLength(count + 2);
    expect(readBinding(f.config, f.nativeSessionId)!.selectedLeafUuid).toBe("a4");
    expect(f.importer.memory.store.db.prepare("SELECT entry_ids FROM source_paths WHERE session_id = ? AND branch = ?")
      .get(first.coreSessionId!, first.branch)).toEqual({ entry_ids: JSON.stringify(partial.selectedEntryIds) });
    const changed = f.records.map(record => (record as { uuid?: string }).uuid === "a1"
      ? { ...record, message: { role: "assistant", content: [{ type: "text", text: "rewritten" }] } } : record);
    writeFileSync(f.transcriptPath, changed.map(line).join(""));
    await expect(f.importer.reconcile()).rejects.toThrow("native source a1 changed after persistence");
    expect(f.importer.memory.store.listSourceEntries(first.coreSessionId!)).toHaveLength(count + 2);
  } finally { f.importer.close(); }
});

test("same-cwd native sessions remain isolated by trusted session and transcript bindings", async () => {
  const f = fixture(), otherPath = join(f.dir, "other.jsonl"), otherId = "native-session-2";
  writeFileSync(f.transcriptPath, f.records.map(line).join(""));
  const otherRecords = f.records.map(record => JSON.parse(JSON.stringify(record).replaceAll('"a1"', '"b1"').replaceAll('"u1"', '"v1"')
    .replaceAll('"a2"', '"b2"').replaceAll('"u2"', '"v2"').replaceAll('"a3"', '"b3"').replaceAll('"u3"', '"v3"')
    .replaceAll('"r1"', '"q1"').replaceAll('"compact"', '"compact-2"')));
  writeFileSync(otherPath, otherRecords.map(line).join(""));
  const [one, two] = await Promise.all([
    recordSessionStart(f.config, { hook_event_name: "SessionStart", session_id: f.nativeSessionId, transcript_path: f.transcriptPath, cwd: f.dir }, at(1)),
    recordSessionStart(f.config, { hook_event_name: "SessionStart", session_id: otherId, transcript_path: otherPath, cwd: f.dir }, at(1)),
  ]);
  const importers = [new CcImporter(f.config, one), new CcImporter(f.config, two)];
  try {
    const results = await Promise.all(importers.map(importer => importer.reconcile()));
    expect(results.map(result => result.coreSessionId)).toEqual([1, 2]);
    expect(importers[0]!.memory.store.getSession(1)!.host).toBe(`cc:${f.nativeSessionId}`);
    expect(importers[1]!.memory.store.getSession(2)!.host).toBe(`cc:${otherId}`);
    expect(importers[0]!.memory.store.listSourceEntries(1).every(entry => !entry.nativeId.startsWith("b"))).toBe(true);
    expect(importers[1]!.memory.store.listSourceEntries(2).every(entry => !entry.nativeId.startsWith("a"))).toBe(true);
  } finally { importers.forEach(importer => importer.close()); }
});

test("disabled provisional sessions do not allocate and mixed-host legacy Raw stays owned by its decoder", async () => {
  const f = fixture(); f.config.baseline = "2027-01-01T00:00:00.000Z"; writeFileSync(f.transcriptPath, f.records.map(line).join(""));
  const foreign = TraceMemory(f.config.dbPath, async () => ({ outcome: "cancelled", output: null }), {}, undefined, piSourceBlocks);
  const project = foreign.store.createProject({ name: "foreign", declaredBy: "mark" });
  const session = foreign.store.createSession({ projectId: project.id, host: "pi", startedAt: at(1), firstReplyAt: at(2), enrollmentChoice: true });
  const turn = foreign.store.appendTurn({ sessionId: session.id, kind: "turn", startedAt: at(1) });
  foreign.store.appendSourceEntry({ sessionId: session.id, turnId: turn.id, nativeLineage: "pi", nativeId: "pi-entry", role: "assistant",
    text: "foreign", raw: JSON.stringify({ role: "assistant", content: [{ type: "text", text: "foreign" }] }), calls: [] }); foreign.close();
  const binding = await recordSessionStart(f.config, { hook_event_name: "SessionStart", session_id: f.nativeSessionId, transcript_path: f.transcriptPath }, at(1));
  const importer = new CcImporter(f.config, binding);
  try { expect((await importer.reconcile()).state).toBe("disabled"); expect(importer.currentBinding().coreSessionId).toBeNull(); }
  finally { importer.close(); }
  const db = new DatabaseSync(f.config.dbPath);
  expect(JSON.parse(String(db.prepare("SELECT blocks FROM source_entries WHERE native_id = 'pi-entry'").get()!.blocks)))
    .toEqual([{ kind: "text", text: "foreign" }]); db.close();
  expect(readBinding(f.config, f.nativeSessionId)!.enrollment).toEqual({ defaultEnabled: false, choice: null });
});
