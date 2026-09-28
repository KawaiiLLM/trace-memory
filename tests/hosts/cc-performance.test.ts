import { expect, test } from "vitest";
import { appendFileSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { performance } from "node:perf_hooks";
import { resolveCcHostConfig } from "../../src/hosts/cc/config.ts";
import { recordSessionStart } from "../../src/hosts/cc/binding.ts";
import { CcImporter } from "../../src/hosts/cc/importer.ts";

const line = (value: unknown) => `${JSON.stringify(value)}\n`;

test("a 30k transcript has sub-millisecond unchanged wakes and suffix-proportional append work", async () => {
  const dir = mkdtempSync(join(tmpdir(), "tm-43a-30k-"));
  const transcriptPath = join(dir, "native.jsonl"), nativeSessionId = "performance-30k";
  const config = resolveCcHostConfig({ dbPath: join(dir, "memory.sqlite"), stateDir: join(dir, "state"),
    baseline: "2025-01-01T00:00:00.000Z" });
  const records: unknown[] = [];
  let parent: string | null = null;
  for (let index = 0; index < 15_000; index++) {
    const user = `u-${index}`, assistant = `a-${index}`;
    records.push({ uuid: user, parentUuid: parent, type: "user", timestamp: new Date(Date.UTC(2026, 0, 1) + index * 2).toISOString(),
      promptId: `p-${index}`, promptSource: "sdk", userType: "external", message: { role: "user", content: `q ${index}` } });
    records.push({ uuid: assistant, parentUuid: user, type: "assistant", timestamp: new Date(Date.UTC(2026, 0, 1) + index * 2 + 1).toISOString(),
      message: { id: `msg-${index}`, role: "assistant", content: [{ type: "text", text: `a ${index}` }] } });
    parent = assistant;
  }
  writeFileSync(transcriptPath, records.map(line).join(""));
  const binding = await recordSessionStart(config,
    { hook_event_name: "SessionStart", session_id: nativeSessionId, transcript_path: transcriptPath }, "2026-01-01T00:00:00.000Z");
  const importer = new CcImporter(config, binding);
  try {
    expect((await importer.reconcile()).appendedEntryIds).toHaveLength(30_000);
    const nodes = (importer as unknown as { projection: { transcript: { nodes: Map<string, unknown> } } }).projection.transcript.nodes;
    const values = nodes.values.bind(nodes); let historicalNodeVisits = 0;
    nodes.values = function* () { for (const node of values()) { historicalNodeVisits += 1; yield node; } } as typeof nodes.values;
    const database = importer.memory.store.db as typeof importer.memory.store.db & { prepare: typeof importer.memory.store.db.prepare };
    const prepare = database.prepare.bind(database); let prepares = 0;
    database.prepare = ((sql: string) => { prepares += 1; return prepare(sql); }) as typeof database.prepare;
    const parse = JSON.parse; let parses = 0;
    JSON.parse = ((text: string) => { parses += 1; return parse(text); }) as typeof JSON.parse;
    const idle: number[] = [];
    try {
      for (let index = 0; index < 5; index++) {
        const started = performance.now(); const result = await importer.reconcile(); idle.push(performance.now() - started);
        expect(result.snapshot.changed).toBe(false);
      }
      expect(Math.max(...idle)).toBeLessThan(1);
      expect(prepares).toBeLessThanOrEqual(10);
      expect(parses).toBeLessThanOrEqual(5);
      prepares = 0; parses = 0; historicalNodeVisits = 0;
      const nextUser = { uuid: "u-final", parentUuid: parent, type: "user", timestamp: "2026-01-02T00:00:00.000Z",
        promptId: "p-final", promptSource: "sdk", userType: "external", message: { role: "user", content: "final" } };
      const nextAssistant = { uuid: "a-final", parentUuid: "u-final", type: "assistant", timestamp: "2026-01-02T00:00:01.000Z",
        message: { id: "msg-final", role: "assistant", content: [{ type: "text", text: "final" }] } };
      appendFileSync(transcriptPath, line(nextUser) + line(nextAssistant));
      const appended = await importer.reconcile();
      expect(appended.appendedEntryIds).toHaveLength(2);
      expect(appended.snapshot.reset).toBe(false);
      expect(historicalNodeVisits).toBe(0);
      expect(prepares).toBeLessThan(80);
      expect(parses).toBeLessThan(30);
      // A parallel batch whose results arrive after its calls extends the path the same way (108).
      const call = (index: number) => ({ uuid: `c-${index}`, parentUuid: index ? `c-${index - 1}` : "u-batch", type: "assistant",
        timestamp: `2026-01-02T00:00:0${3 + index}.000Z`, message: { id: "msg-batch", role: "assistant",
          content: [{ type: "tool_use", id: `toolu-${index}`, name: "Read", input: {} }] } });
      const result = (index: number) => ({ uuid: `r-${index}`, parentUuid: `c-${index}`, type: "user", timestamp: `2026-01-02T00:00:0${6 + index}.000Z`,
        message: { role: "user", content: [{ type: "tool_result", tool_use_id: `toolu-${index}`, content: "read" }] } });
      appendFileSync(transcriptPath, line({ uuid: "u-batch", parentUuid: "a-final", type: "user", timestamp: "2026-01-02T00:00:02.000Z",
        promptId: "p-batch", promptSource: "sdk", userType: "external", message: { role: "user", content: "read two" } }) + line(call(0)) + line(call(1)));
      await importer.reconcile();
      appendFileSync(transcriptPath, line(result(0)) + line(result(1)));
      const batch = await importer.reconcile();
      expect(batch.snapshot.reset).toBe(false);
      expect(batch.selectedEntryIds.slice(-5).map(id => importer.memory.store.getSourceEntry(id)!.nativeId))
        .toEqual(["u-batch", "c-0", "c-1", "r-0", "r-1"]);
      expect(historicalNodeVisits).toBe(0);
    } finally { JSON.parse = parse; }
  } finally { importer.close(); rmSync(dir, { recursive: true, force: true }); }
}, 120_000);
