import { afterEach, expect, test } from "vitest";
import { appendFileSync, mkdtempSync, renameSync, rmSync, writeFileSync } from "node:fs";
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
import { copyThenTypedRecords, copyTypedPrompt, modelThenTypedRecords, modelTypedPrompt, toSpecPrompt, toSpecRecords }
  from "../fixtures/cc-ticket-52.ts";

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
async function importerForRecords(records: CcNativeRecord[], nativeSessionId: string) {
  const f = fixture(); writeFileSync(f.transcriptPath, records.map(line).join(""));
  const binding = await recordSessionStart(f.config, { hook_event_name: "SessionStart", session_id: nativeSessionId,
    transcript_path: f.transcriptPath }, records[0]!.timestamp as string);
  return { ...f, nativeSessionId, importer: new CcImporter(f.config, binding) };
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
  for (const [index, promptSource] of ["typed", "queued", "sdk", "system"].entries()) {
    const nativePrompt = { uuid: `prompt-${promptSource}`, parentUuid: null, type: "user", timestamp: at(index + 1), isMeta: true,
      promptSource, message: { role: "user", content: `native ${promptSource} prompt` } };
    expect(classifySourceRecord(nativePrompt)).toMatchObject({ kind: "user", text: `native ${promptSource} prompt` });
  }
  const typed = { uuid: "typed", parentUuid: null, type: "user", timestamp: at(1), promptId: "typed-prompt",
    promptSource: "typed", userType: "external", origin: { kind: "human" }, message: { role: "user", content: "evidence" } };
  expect(classifySourceRecord({ ...typed, uuid: "meta-control", promptSource: undefined, isMeta: true })).toBeNull();
  expect(classifySourceRecord({ uuid: "assistant-meta", parentUuid: "typed", type: "assistant", timestamp: at(2), isMeta: true,
    message: { role: "assistant", model: "claude-test", content: [{ type: "text", text: "host control" }] } })).toBeNull();
  expect(classifySourceRecord({ ...typed, uuid: "side", isSidechain: true })).toBeNull();
  expect(classifySourceRecord({ ...typed, uuid: "summary", isCompactSummary: true })).toBeNull();
});

test("human command provenance opens a prompt without reinterpreting existing prompt sources", () => {
  const human = { uuid: "human", parentUuid: null, type: "user", timestamp: at(1), origin: { kind: "human" },
    message: { role: "user", content: "ordinary human text" } };
  expect(classifySourceRecord(human)).toMatchObject({ kind: "user", text: "ordinary human text" });
  expect(classifySourceRecord({ ...human, uuid: "command-args", message: { role: "user", content:
    "<command-message>review</command-message>\n<command-name>/review</command-name>\n<command-args>  focused scope  </command-args>" } }))
    .toMatchObject({ kind: "user", text: "/review focused scope" });
  expect(classifySourceRecord({ ...human, uuid: "command-no-args", message: { role: "user", content:
    "<command-message>markdown-writing</command-message>\n<command-name>/markdown-writing</command-name>" } }))
    .toMatchObject({ kind: "user", text: "/markdown-writing" });
  const literal = "Discuss <command-name>/review</command-name> as literal XML";
  expect(classifySourceRecord({ ...human, uuid: "literal", message: { role: "user", content: literal } }))
    .toMatchObject({ kind: "user", text: literal });
  const typedEnvelope = { ...human, uuid: "typed-envelope", promptSource: "typed",
    message: { role: "user", content: "<command-message>review</command-message>\n<command-name>/review</command-name>" } };
  expect(classifySourceRecord(typedEnvelope)).toMatchObject({ kind: "user", text: typedEnvelope.message.content });
  expect(classifySourceRecord({ ...human, uuid: "meta", isMeta: true })).toBeNull();
  expect(classifySourceRecord({ ...human, uuid: "visible", isVisibleInTranscriptOnly: true })).toBeNull();
  expect(classifySourceRecord({ ...human, uuid: "sidechain", isSidechain: true })).toBeNull();
  expect(classifySourceRecord({ ...human, uuid: "summary", isCompactSummary: true })).toBeNull();
  expect(classifySourceRecord({ ...human, uuid: "local", origin: undefined,
    message: { role: "user", content: "<command-name>/model</command-name>\n<command-message>model</command-message>" } })).toBeNull();
  expect(classifySourceRecord({ ...human, uuid: "interrupted", origin: undefined,
    message: { role: "user", content: "[Request interrupted by user]" } })).toBeNull();
});

test("pinned native command sequences preserve command ownership and exclude local companions", async () => {
  const skill = await importerForRecords(toSpecRecords, "ticket-52-skill");
  try {
    const result = await skill.importer.reconcile();
    expect(result).toMatchObject({ state: "ready", problems: [] });
    const turns = skill.importer.memory.store.listTurns(result.coreSessionId!);
    expect(turns.map(turn => turn.userPrompt)).toEqual(["fixture root", toSpecPrompt]);
    const entries = skill.importer.memory.store.listSourceEntries(result.coreSessionId!);
    expect(entries.map(entry => entry.nativeId)).toEqual([
      "fixture-root", "ad9dd570-96fc-439c-b695-d2f7ffa931f3", "76daf7a6-7627-43f9-8d70-022fe70111ad",
      "d94f596d-76c6-4fcf-921f-4a2fa4103e95", "431be203-fb8e-44b4-9c21-b714d748cc5c",
    ]);
    const command = entries.find(entry => entry.nativeId === "76daf7a6-7627-43f9-8d70-022fe70111ad")!;
    expect(command).toMatchObject({ text: toSpecPrompt, entryOrdinal: 1 });
    expect(command.raw).toBe(JSON.stringify(toSpecRecords[2]));
    expect(ccSourceBlocks(command)).toEqual([{ kind: "text", text: toSpecPrompt }]);
    expect(entries.slice(-3).map(entry => entry.turnId)).toEqual([turns[1]!.id, turns[1]!.id, turns[1]!.id]);
    expect(entries.slice(-3).map(entry => entry.entryOrdinal)).toEqual([1, 2, 3]);
  } finally { skill.importer.close(); }

  const local = await importerForRecords(modelThenTypedRecords, "ticket-52-model");
  try {
    const result = await local.importer.reconcile();
    expect(result).toMatchObject({ state: "ready", problems: [] });
    const turns = local.importer.memory.store.listTurns(result.coreSessionId!);
    expect(turns.map(turn => turn.userPrompt)).toEqual(["fixture root", modelTypedPrompt]);
    expect(local.importer.memory.store.listSourceEntries(result.coreSessionId!).map(entry => entry.nativeId)).toEqual([
      "model-root", "adfb1f65-bdbb-4c40-b83d-deb5eeee7648", "6abc4870-0861-44bf-baed-33c8173bb7d1", "model-typed-reply",
    ]);
    expect(turns[1]!.parentTurnId).toBe(turns[0]!.id);
  } finally { local.importer.close(); }

  const copy = await importerForRecords(copyThenTypedRecords, "ticket-52-copy");
  try {
    const result = await copy.importer.reconcile();
    expect(result).toMatchObject({ state: "ready", problems: [] });
    const turns = copy.importer.memory.store.listTurns(result.coreSessionId!);
    expect(turns).toHaveLength(2);
    expect(turns[1]).toMatchObject({ userPrompt: copyTypedPrompt, parentTurnId: turns[0]!.id });
    expect(copy.importer.memory.store.listSourceEntries(result.coreSessionId!).map(entry => entry.nativeId)).toEqual([
      "copy-root", "d528ce68-372d-46b3-a66a-2f0fe58101c9", "7d69b574-e463-4d3c-be2f-b43ceb5b32d6", "copy-typed-reply",
    ]);
  } finally { copy.importer.close(); }
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
    expect(readBinding(f.config, f.nativeSessionId)).toMatchObject({ selectedLeafUuid: "a3", branch: first.branch });
    expect(f.importer.memory.store.db.prepare("SELECT branch, head_turn_id FROM session_lineage_cursors WHERE session_id = ? AND lineage = ?")
      .get(sessionId, f.nativeSessionId)).toEqual({ branch: first.branch, head_turn_id: first.headTurnId });
    expect(Object.hasOwn(readBinding(f.config, f.nativeSessionId)!, "selectedPathUuids")).toBe(false);
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
    expect(importer.memory.store.db.prepare("SELECT branch, head_turn_id FROM session_lineage_cursors WHERE session_id = ? AND lineage = ?")
      .get(second.coreSessionId!, f.nativeSessionId)).toEqual({ branch: second.branch, head_turn_id: second.headTurnId });
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
    const conflict = await f.importer.reconcile();
    expect(conflict).toMatchObject({ state: "not-ready", problems: ["native source a1 changed after persistence"] });
    expect((await f.importer.reconcile()).problems).toEqual(conflict.problems);
    expect(f.importer.memory.store.listSourceEntries(first.coreSessionId!)).toHaveLength(count + 2);
  } finally { f.importer.close(); }
});

test("unchanged reconciliation does no historical SQL and append work is bounded to its suffix", async () => {
  const f = fixture();
  const records: CcNativeRecord[] = [];
  let parent: string | null = null;
  for (let index = 0; index < 250; index++) {
    const user = `perf-u-${index}`, assistant = `perf-a-${index}`;
    records.push({ uuid: user, parentUuid: parent, type: "user", timestamp: new Date(Date.parse(at(0)) + index * 2_000).toISOString(),
      ...sdkPrompt(`perf-p-${index}`), message: { role: "user", content: `question ${index}` } });
    records.push({ uuid: assistant, parentUuid: user, type: "assistant", timestamp: new Date(Date.parse(at(0)) + index * 2_000 + 1_000).toISOString(),
      message: { role: "assistant", content: [{ type: "text", text: `answer ${index}` }] } });
    parent = assistant;
  }
  writeFileSync(f.transcriptPath, records.map(line).join(""));
  const binding = await recordSessionStart(f.config, { hook_event_name: "SessionStart", session_id: f.nativeSessionId,
    transcript_path: f.transcriptPath }, at(0));
  const importer = new CcImporter(f.config, binding);
  try {
    expect((await importer.reconcile()).appendedEntryIds).toHaveLength(500);
    const database = importer.memory.store.db as typeof importer.memory.store.db & { prepare: typeof importer.memory.store.db.prepare };
    const prepare = database.prepare.bind(database); let prepares = 0;
    database.prepare = ((sql: string) => { prepares += 1; return prepare(sql); }) as typeof database.prepare;
    for (let index = 0; index < 3; index++) {
      const idle = await importer.reconcile();
      expect(idle.snapshot.changed).toBe(false); expect(idle.appendedEntryIds).toEqual([]);
    }
    expect(prepares).toBeLessThanOrEqual(6);
    prepares = 0;
    const user = { uuid: "perf-u-final", parentUuid: parent, type: "user", timestamp: new Date(Date.parse(at(0)) + 501_000).toISOString(),
      ...sdkPrompt("perf-p-final"), message: { role: "user", content: "final" } };
    const assistant = { uuid: "perf-a-final", parentUuid: user.uuid, type: "assistant", timestamp: new Date(Date.parse(at(0)) + 502_000).toISOString(),
      message: { role: "assistant", content: [{ type: "text", text: "final answer" }] } };
    appendFileSync(f.transcriptPath, line(user) + line(assistant));
    const appended = await importer.reconcile();
    expect(appended.appendedEntryIds).toHaveLength(2); expect(appended.snapshot.reset).toBe(false);
    expect(prepares).toBeLessThan(80);
  } finally { importer.close(); }
});

test("incremental bytes preserve an incomplete UTF-8 tail and commit it exactly once", async () => {
  const f = fixture();
  writeFileSync(f.transcriptPath, f.records.slice(0, 2).map(line).join(""));
  const binding = await recordSessionStart(f.config, { hook_event_name: "SessionStart", session_id: f.nativeSessionId,
    transcript_path: f.transcriptPath }, at(1));
  const importer = new CcImporter(f.config, binding);
  try {
    const first = await importer.reconcile();
    const next = Buffer.from(line({ uuid: "u-utf8", parentUuid: "a1", type: "user", timestamp: at(3), ...sdkPrompt("utf8"),
      message: { role: "user", content: "split € bytes" } }));
    const split = next.indexOf(Buffer.from("€")) + 1;
    appendFileSync(f.transcriptPath, next.subarray(0, split));
    const partial = await importer.reconcile();
    expect(partial.appendedEntryIds).toEqual([]); expect(partial.snapshot.incompleteBytes).toBeGreaterThan(0);
    appendFileSync(f.transcriptPath, next.subarray(split));
    const complete = await importer.reconcile();
    expect(complete.appendedEntryIds).toHaveLength(1);
    expect(importer.memory.store.getSourceEntry(complete.appendedEntryIds[0]!)!.text).toBe("split € bytes");
    expect((await importer.reconcile()).appendedEntryIds).toEqual([]);
    expect(importer.memory.store.listSourceEntries(first.coreSessionId!)).toHaveLength(3);
  } finally { importer.close(); }
});

test("same-size rewrite, truncation, and inode replacement rebuild projection without rewriting Raw", async () => {
  const f = fixture();
  const initial = f.records.slice(0, 10);
  writeFileSync(f.transcriptPath, initial.map(line).join(""));
  const binding = await recordSessionStart(f.config, { hook_event_name: "SessionStart", session_id: f.nativeSessionId,
    transcript_path: f.transcriptPath }, at(1));
  const importer = new CcImporter(f.config, binding);
  try {
    const first = await importer.reconcile();
    const originalRaw = importer.memory.store.findSourceEntry(first.coreSessionId!, f.nativeSessionId, "a1")!.raw;
    const paddedOld = line({ uuid: "control-old", parentUuid: "a2", type: "progress", value: "aaaa" });
    const paddedNew = line({ uuid: "control-new", parentUuid: "a2", type: "progress", value: "bbbb" });
    appendFileSync(f.transcriptPath, paddedOld);
    await importer.reconcile();
    const bytes = Buffer.byteLength(paddedOld); expect(Buffer.byteLength(paddedNew)).toBe(bytes);
    const content = initial.map(line).join("") + paddedNew;
    writeFileSync(f.transcriptPath, content);
    expect((await importer.reconcile()).snapshot.reset).toBe(true);
    writeFileSync(f.transcriptPath, f.records.slice(0, 3).map(line).join(""));
    const truncated = await importer.reconcile(); expect(truncated.snapshot.reset).toBe(true); expect(truncated.branch).not.toBe(first.branch);
    const replacement = `${f.transcriptPath}.replacement`;
    writeFileSync(replacement, f.records.slice(0, 3).map(line).join("")); renameSync(replacement, f.transcriptPath);
    expect((await importer.reconcile()).snapshot.reset).toBe(true);
    expect(importer.memory.store.findSourceEntry(first.coreSessionId!, f.nativeSessionId, "a1")!.raw).toBe(originalRaw);
  } finally { importer.close(); }
});

test("a failed source transaction leaves the byte cursor retryable", async () => {
  const f = fixture();
  writeFileSync(f.transcriptPath, f.records.slice(0, 2).map(line).join(""));
  const binding = await recordSessionStart(f.config, { hook_event_name: "SessionStart", session_id: f.nativeSessionId,
    transcript_path: f.transcriptPath }, at(1));
  const importer = new CcImporter(f.config, binding);
  try {
    await importer.reconcile();
    const next = { uuid: "retry-u", parentUuid: "a1", type: "user", timestamp: at(3), ...sdkPrompt("retry"),
      message: { role: "user", content: "retry" } };
    appendFileSync(f.transcriptPath, line(next));
    const original = importer.memory.appendEntry; let failed = false;
    importer.memory.appendEntry = input => { if (!failed) { failed = true; throw new Error("injected append failure"); } return original(input); };
    await expect(importer.reconcile()).rejects.toThrow("injected append failure");
    importer.memory.appendEntry = original;
    const retried = await importer.reconcile();
    expect(retried.appendedEntryIds).toHaveLength(1);
    expect(importer.memory.store.listSourceEntries(retried.coreSessionId!).at(-1)).toMatchObject({ nativeId: "retry-u", entryOrdinal: 1 });
    expect(importer.memory.store.listTurns(retried.coreSessionId!)).toHaveLength(2);
  } finally { importer.close(); }
});

test("missing appended ancestry is diagnosed once and remains idle-fast", async () => {
  const f = fixture();
  writeFileSync(f.transcriptPath, f.records.slice(0, 2).map(line).join(""));
  const binding = await recordSessionStart(f.config, { hook_event_name: "SessionStart", session_id: f.nativeSessionId,
    transcript_path: f.transcriptPath }, at(1));
  const importer = new CcImporter(f.config, binding);
  try {
    const first = await importer.reconcile();
    appendFileSync(f.transcriptPath, line({ uuid: "missing-parent", parentUuid: "absent", type: "assistant", timestamp: at(3),
      message: { role: "assistant", content: [{ type: "text", text: "broken" }] } }));
    expect(await importer.reconcile()).toMatchObject({ state: "not-ready", problems: ["native lineage parent absent is missing"] });
    const database = importer.memory.store.db as typeof importer.memory.store.db & { prepare: typeof importer.memory.store.db.prepare };
    const prepare = database.prepare.bind(database); let prepares = 0;
    database.prepare = ((sql: string) => { prepares += 1; return prepare(sql); }) as typeof database.prepare;
    expect((await importer.reconcile()).problems).toEqual(["native lineage parent absent is missing"]);
    expect(prepares).toBeLessThanOrEqual(2);
    expect(importer.memory.store.listSourceEntries(first.coreSessionId!)).toHaveLength(2);
  } finally { importer.close(); }
});

test("exact duplicate UUID evidence is idempotent while a repeated same-Turn call stays explicitly blocked", async () => {
  const f = fixture();
  writeFileSync(f.transcriptPath, f.records.slice(0, 2).map(line).join(""));
  const binding = await recordSessionStart(f.config, { hook_event_name: "SessionStart", session_id: f.nativeSessionId,
    transcript_path: f.transcriptPath }, at(1));
  const importer = new CcImporter(f.config, binding);
  try {
    const first = await importer.reconcile();
    appendFileSync(f.transcriptPath, line(f.records[1]));
    expect((await importer.reconcile()).appendedEntryIds).toEqual([]);
    const repeated = { uuid: "a-repeat", parentUuid: "a1", type: "assistant", timestamp: at(3),
      message: { role: "assistant", content: [{ type: "tool_use", id: "call-1", name: "Read", input: { path: "/tmp/b" } }] } };
    appendFileSync(f.transcriptPath, line(repeated));
    const blocked = await importer.reconcile();
    expect(blocked).toMatchObject({ state: "not-ready", problems: ["native tool call call-1 repeats within one Turn"] });
    const database = importer.memory.store.db as typeof importer.memory.store.db & { prepare: typeof importer.memory.store.db.prepare };
    const prepare = database.prepare.bind(database); let prepares = 0;
    database.prepare = ((sql: string) => { prepares += 1; return prepare(sql); }) as typeof database.prepare;
    expect((await importer.reconcile()).problems).toEqual(blocked.problems);
    expect(prepares).toBeLessThanOrEqual(2);
    expect(importer.memory.store.listSourceEntries(first.coreSessionId!)).toHaveLength(2);
  } finally { importer.close(); }
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
