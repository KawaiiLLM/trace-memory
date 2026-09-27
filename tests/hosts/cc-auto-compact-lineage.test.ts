import { afterEach, expect, test } from "vitest";
import { appendFileSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resolveCcHostConfig } from "../../src/hosts/cc/config.ts";
import { readBinding, recordSessionStart } from "../../src/hosts/cc/binding.ts";
import { CcImporter } from "../../src/hosts/cc/importer.ts";
import { selectedNativePath, type CcNativeRecord } from "../../src/hosts/cc/transcript.ts";

const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });
const at = (second: number) => `2026-02-01T00:00:${String(second).padStart(2, "0")}.000Z`;
const prompt = (uuid: string, parentUuid: string | null, second: number): CcNativeRecord => ({
  uuid, parentUuid, type: "user", timestamp: at(second), promptId: `prompt-${uuid}`, promptSource: "sdk", userType: "external",
  message: { role: "user", content: uuid },
});
const assistant = (uuid: string, parentUuid: string, second: number): CcNativeRecord => ({
  uuid, parentUuid, type: "assistant", timestamp: at(second), message: { role: "assistant", content: [{ type: "text", text: uuid }] },
});
const attachment = (uuid: string, parentUuid: string, second: number): CcNativeRecord =>
  ({ uuid, parentUuid, type: "attachment", timestamp: at(second), attachment: { type: "total_tokens_reminder" } }) as CcNativeRecord;

/** Claude Code 2.1.280's automatic compaction, as recorded in a production transcript (2026-09-23):
 * the boundary's logical parent and the last preserved message is an attachment written after the
 * summary, so it descends from the boundary itself. Every earlier preserved message precedes it. */
const autoCompacted = (): CcNativeRecord[] => [
  prompt("u1", null, 1), assistant("a1", "u1", 2), attachment("x1", "a1", 3),
  { uuid: "boundary", parentUuid: null, logicalParentUuid: "t", type: "system", subtype: "compact_boundary", timestamp: at(4),
    compactMetadata: { trigger: "auto", preservedSegment: { headUuid: "a1", anchorUuid: "summary", tailUuid: "t" },
      preservedMessages: { anchorUuid: "summary", uuids: ["a1", "x1", "t"] } } } as CcNativeRecord,
  ({ uuid: "instructions", parentUuid: "boundary", type: "attachment", timestamp: at(4), attachment: { type: "instructions" } }) as CcNativeRecord,
  { uuid: "summary", parentUuid: "instructions", type: "user", isCompactSummary: true, timestamp: at(5),
    message: { role: "user", content: "summary" } } as CcNativeRecord,
  attachment("t", "summary", 6), prompt("u2", "t", 7), assistant("a2", "u2", 8),
];

async function imported(records: CcNativeRecord[]) {
  const dir = mkdtempSync(join(tmpdir(), "tm-cc-auto-compact-")); dirs.push(dir);
  const transcriptPath = join(dir, "native.jsonl");
  const config = resolveCcHostConfig({ dbPath: join(dir, "memory.sqlite"), stateDir: join(dir, "state"), baseline: "2025-01-01T00:00:00.000Z" });
  writeFileSync(transcriptPath, records.map(record => `${JSON.stringify(record)}\n`).join(""));
  const binding = await recordSessionStart(config, { hook_event_name: "SessionStart", session_id: "auto-compact", transcript_path: transcriptPath }, at(1));
  const importer = new CcImporter(config, binding);
  try {
    const result = await importer.reconcile(), store = importer.memory.store;
    return { problems: result.problems ?? [], path: result.selectedEntryIds.map(id => store.getSourceEntry(id)!.nativeId),
      turns: store.db.prepare("SELECT kind, parent_turn_id FROM turns ORDER BY id").all() };
  } finally { importer.close(); }
}

test("an automatic compaction whose logical parent is written after it continues from its last earlier preserved message", async () => {
  const records = autoCompacted();
  const selected = selectedNativePath(records);
  expect(selected.problem).toBeUndefined();
  expect(selected.records.map(record => record.uuid)).toEqual(["u1", "a1", "x1", "boundary", "instructions", "summary", "t", "u2", "a2"]);

  // It imports exactly as the same records do when the boundary names its earlier preserved tail.
  const normal = records.map(record => record.uuid === "boundary" ? { ...record, logicalParentUuid: "x1" } : record);
  const auto = await imported(records);
  expect(auto.problems).toEqual([]);
  expect(auto.path).toEqual(["u1", "a1", "u2", "a2"]);
  expect(auto).toEqual(await imported(normal));
});

test("a boundary whose logical parent is written after it, with no earlier preserved message, still fails as a cycle", () => {
  const records = autoCompacted().map(record => record.uuid === "boundary"
    ? { ...record, compactMetadata: { trigger: "auto", preservedMessages: { anchorUuid: "summary", uuids: ["t"] } } } : record);
  expect(selectedNativePath(records).problem).toBe("native lineage cycle at t");
});

test("a reply that goes on after an automatic compaction belongs to the Turn of the prompt it interrupted", async () => {
  // As in the production transcript: no new prompt follows the summary; the reply continues.
  const records = autoCompacted().filter(record => record.uuid !== "u2" && record.uuid !== "a2");
  records.push(assistant("a1-continued", "t", 7), prompt("u2", "a1-continued", 8), assistant("a2", "u2", 9));
  const dir = mkdtempSync(join(tmpdir(), "tm-cc-auto-compact-")); dirs.push(dir);
  const transcriptPath = join(dir, "native.jsonl");
  const config = resolveCcHostConfig({ dbPath: join(dir, "memory.sqlite"), stateDir: join(dir, "state"), baseline: "2025-01-01T00:00:00.000Z" });
  writeFileSync(transcriptPath, records.map(record => `${JSON.stringify(record)}\n`).join(""));
  const binding = await recordSessionStart(config, { hook_event_name: "SessionStart", session_id: "auto-compact", transcript_path: transcriptPath }, at(1));
  const importer = new CcImporter(config, binding);
  try {
    const result = await importer.reconcile(), store = importer.memory.store;
    expect(result.problems ?? []).toEqual([]);
    const entries = result.selectedEntryIds.map(id => store.getSourceEntry(id)!);
    expect(entries.map(entry => entry.nativeId)).toEqual(["u1", "a1", "a1-continued", "u2", "a2"]);
    const turnOf = (native: string) => entries.find(entry => entry.nativeId === native)!.turnId;
    expect(turnOf("a1-continued")).toBe(turnOf("u1"));
    expect(store.getTurn(turnOf("u2"))!.userPrompt).toBe("u2");
  } finally { importer.close(); }
});

/** Claude Code 2.1.280's automatic compaction in the middle of a reply, while a tool call is in flight, as recorded in a
 * production transcript (2026-09-27): after the summary it writes the in-flight message again under new uuids, one row per
 * content block as before, with the same message id and content and only its usage changed; the tool result follows again,
 * naming the call's original row as its parent, and differs from the first only in its uuid. */
const inFlight = (uuid: string, parentUuid: string, second: number, block: Record<string, unknown>): CcNativeRecord => ({
  uuid, parentUuid, type: "assistant", timestamp: at(second),
  message: { id: "msg-1", role: "assistant", content: [block], usage: { output_tokens: 7 } },
});
const toolResult = (uuid: string, parentUuid: string, second: number, callId = "call-1", content = "listing"): CcNativeRecord => ({
  uuid, parentUuid, type: "user", timestamp: at(second), sourceToolAssistantUUID: parentUuid,
  message: { role: "user", content: [{ type: "tool_result", tool_use_id: callId, content }] },
});
const copied = (record: CcNativeRecord, uuid: string, parentUuid: string): CcNativeRecord => record.type === "assistant"
  ? { ...record, uuid, parentUuid, message: { ...record.message, usage: { output_tokens: 0 } } } : { ...record, uuid, parentUuid };
const midReplyCompacted = (): CcNativeRecord[] => {
  const thinking = inFlight("thinking", "u1", 2, { type: "thinking", thinking: "plan", signature: "sig" });
  const call = inFlight("call", "thinking", 3, { type: "tool_use", id: "call-1", name: "Bash", input: { command: "ls" } });
  const result = toolResult("result", "call", 4);
  return [prompt("u1", null, 1), thinking, call, result, attachment("x1", "result", 5),
    { uuid: "boundary", parentUuid: null, logicalParentUuid: "x1", type: "system", subtype: "compact_boundary", timestamp: at(6),
      compactMetadata: { trigger: "auto", preTokens: 967295 } } as CcNativeRecord,
    { uuid: "summary", parentUuid: "boundary", type: "user", isCompactSummary: true, isVisibleInTranscriptOnly: true, timestamp: at(6),
      message: { role: "user", content: "summary" } } as CcNativeRecord,
    copied(thinking, "thinking-copy", "summary"), copied(call, "call-copy", "thinking-copy"), copied(result, "result-copy", "call"),
    attachment("x2", "result-copy", 7)];
};

test("a message and its tool result that an automatic compaction writes again under new uuids are imported once", async () => {
  const dir = mkdtempSync(join(tmpdir(), "tm-cc-auto-compact-")); dirs.push(dir);
  const transcriptPath = join(dir, "native.jsonl");
  const config = resolveCcHostConfig({ dbPath: join(dir, "memory.sqlite"), stateDir: join(dir, "state"), baseline: "2025-01-01T00:00:00.000Z" });
  writeFileSync(transcriptPath, midReplyCompacted().map(record => `${JSON.stringify(record)}\n`).join(""));
  const binding = await recordSessionStart(config, { hook_event_name: "SessionStart", session_id: "auto-compact", transcript_path: transcriptPath }, at(1));
  const importer = new CcImporter(config, binding);
  try {
    const result = await importer.reconcile(), store = importer.memory.store;
    expect(result.problems).toEqual([]);
    const prompted = store.findSourceEntry(result.coreSessionId!, "auto-compact", "u1")!.turnId;
    // The two rows sharing one message id with different content remain two entries; the result written again is the result.
    expect(store.listSourceEntries(result.coreSessionId!, prompted).map(entry => entry.nativeId))
      .toEqual(["u1", "thinking", "call", "result"]);
    expect(store.listToolCalls(prompted).map(call => call.name)).toEqual(["Bash"]);
  } finally { importer.close(); }
});

test("tool results that share only their content, or only their call, stay distinct", async () => {
  const call = (uuid: string, parentUuid: string, second: number, id: string) =>
    inFlight(uuid, parentUuid, second, { type: "tool_use", id, name: "Bash", input: { command: id } });
  const records = [prompt("u1", null, 1), call("call", "u1", 2, "call-1"), toolResult("result", "call", 3),
    call("call-2", "result", 4, "call-2"), toolResult("result-2", "call-2", 5, "call-2"),
    toolResult("result-changed", "result-2", 6, "call-1", "changed")];
  const dir = mkdtempSync(join(tmpdir(), "tm-cc-auto-compact-")); dirs.push(dir);
  const transcriptPath = join(dir, "native.jsonl");
  const config = resolveCcHostConfig({ dbPath: join(dir, "memory.sqlite"), stateDir: join(dir, "state"), baseline: "2025-01-01T00:00:00.000Z" });
  writeFileSync(transcriptPath, records.map(record => `${JSON.stringify(record)}\n`).join(""));
  const importer = new CcImporter(config, await recordSessionStart(config,
    { hook_event_name: "SessionStart", session_id: "auto-compact", transcript_path: transcriptPath }, at(1)));
  try {
    const result = await importer.reconcile(), store = importer.memory.store;
    expect(result.problems).toEqual([]);
    expect(result.selectedEntryIds.map(id => store.getSourceEntry(id)!.nativeId)).toEqual(records.map(record => record.uuid));
  } finally { importer.close(); }
});

test("rows arriving one by one across that compaction import the same entries, Turns and selected path as one scan of the finished file", async () => {
  const project = async (records: CcNativeRecord[], oneByOne: boolean) => {
    const dir = mkdtempSync(join(tmpdir(), "tm-cc-auto-compact-")); dirs.push(dir);
    const transcriptPath = join(dir, "native.jsonl");
    const config = resolveCcHostConfig({ dbPath: join(dir, "memory.sqlite"), stateDir: join(dir, "state"), baseline: "2025-01-01T00:00:00.000Z" });
    writeFileSync(transcriptPath, oneByOne ? "" : records.map(record => `${JSON.stringify(record)}\n`).join(""));
    const importer = new CcImporter(config, await recordSessionStart(config,
      { hook_event_name: "SessionStart", session_id: "auto-compact", transcript_path: transcriptPath }, at(1)));
    try {
      let result = await importer.reconcile();
      const store = importer.memory.store, compaction = () => store.db.prepare("SELECT id FROM turns WHERE kind = 'compaction'").get() as { id: number };
      for (const record of oneByOne ? records : []) {
        appendFileSync(transcriptPath, `${JSON.stringify(record)}\n`);
        result = await importer.reconcile();
        expect(result.problems).toEqual([]);
        // While the copies are the last rows, the head a prompt would follow is the compaction.
        if (record.uuid === "thinking-copy" || record.uuid === "call-copy" || record.uuid === "result-copy")
          expect(readBinding(config, "auto-compact")!.selectedHeadTurnId).toBe(compaction().id);
      }
      expect(result.problems).toEqual([]);
      const sessionId = result.coreSessionId!;
      return {
        entries: store.listSourceEntries(sessionId).map(entry => [entry.nativeId, entry.turnId, entry.entryOrdinal]),
        turns: store.db.prepare("SELECT id, kind, parent_turn_id FROM turns ORDER BY id").all().map(row => ({ ...row })),
        paths: store.db.prepare("SELECT branch FROM source_paths").all().map(row => row.branch),
        branch: result.branch, head: result.headTurnId, path: result.selectedEntryIds.map(id => store.getSourceEntry(id)!.nativeId),
        promptParent: readBinding(config, "auto-compact")!.selectedHeadTurnId,
      };
    } finally { importer.close(); }
  };
  // Up to the compaction's last source row, the copied result is the leaf.
  const compacted = midReplyCompacted(), leaf = await project(compacted, false);
  expect(leaf.path).toEqual(["u1", "thinking", "call", "result"]);
  expect(leaf.promptParent).toBe(2);
  expect(await project(compacted, true)).toEqual(leaf);
  const records = [...compacted, assistant("a1", "x2", 8), prompt("u2", "a1", 9), assistant("a2", "u2", 10)];
  const fresh = await project(records, false);
  expect(fresh.path).toEqual(["u1", "thinking", "call", "result", "a1", "u2", "a2"]);
  expect(fresh.turns).toEqual([{ id: 1, kind: "turn", parent_turn_id: null }, { id: 2, kind: "compaction", parent_turn_id: 1 },
    { id: 3, kind: "turn", parent_turn_id: 2 }]);
  expect(await project(records, true)).toEqual(fresh);
});
