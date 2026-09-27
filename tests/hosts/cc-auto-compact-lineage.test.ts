import { afterEach, expect, test } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resolveCcHostConfig } from "../../src/hosts/cc/config.ts";
import { recordSessionStart } from "../../src/hosts/cc/binding.ts";
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
