import { afterEach, expect, test } from "vitest";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, sep } from "node:path";
import { toolDefinitions } from "../../src/core/api/index.ts";
import { renderToolDefinitions } from "../../src/core/api/tools.ts";
import { ccPluginToolNames } from "../../src/hosts/cc/tool-names.ts";
import { Store } from "../../src/core/store/index.ts";
import { readBinding, recordSessionStart } from "../../src/hosts/cc/binding.ts";
import { resolveCcHostConfig } from "../../src/hosts/cc/config.ts";
import { CC_MCP_SERVER_NAME, CC_PLUGIN_NAME, CcImporter } from "../../src/hosts/cc/importer.ts";
import { CcCoordinator } from "../../src/hosts/cc/lifecycle.ts";
import { CC_MAX_RESULT_CHARS, CcForegroundTools } from "../../src/hosts/cc/tools.ts";

const directories: string[] = [];
afterEach(() => { for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true }); });
const line = (value: unknown) => `${JSON.stringify(value)}\n`;

async function fixture(nativePrefix = "mcp__traceMemory__", forkToolCall: (id: string, name: "note" | "memory") => "retired" | null = () => null) {
  const directory = mkdtempSync(join(tmpdir(), "tm-cc-tools-")); directories.push(directory);
  const transcriptPath = join(directory, "native.jsonl"), nativeSessionId = "cc-tools-session";
  const config = resolveCcHostConfig({ dbPath: join(directory, "memory.sqlite"), stateDir: join(directory, "state"),
    baseline: "2025-01-01T00:00:00.000Z", pollIntervalMs: 5, writeSourceTimeoutMs: 50 });
  const records: any[] = [
    { uuid: "user", parentUuid: null, type: "user", timestamp: "2026-01-01T00:00:00.000Z", promptId: "p1", promptSource: "typed",
      message: { role: "user", content: "run a write" } },
    { uuid: "call", parentUuid: "user", type: "assistant", timestamp: "2026-01-01T00:00:01.000Z",
      message: { role: "assistant", content: [
        { type: "tool_use", id: "call-note", name: `${nativePrefix}note`, input: {} },
        { type: "tool_use", id: "call-memory", name: `${nativePrefix}memory`, input: {} },
      ] } },
  ];
  writeFileSync(transcriptPath, records.map(line).join(""));
  const binding = await recordSessionStart(config, { hook_event_name: "SessionStart", session_id: nativeSessionId, transcript_path: transcriptPath }, records[0]!.timestamp);
  const importer = new CcImporter(config, binding), result = await importer.reconcile();
  const exact = importer.persistedCall("call-note", "note")!;
  const coordinator = {
    spill: new CcCoordinator(config, nativeSessionId, () => {}).spill,
    forkToolCall,
    toolProjection: async () => ({ memory: importer.memory, binding: { coreSessionId: result.coreSessionId!, branch: result.branch,
      headTurnId: result.headTurnId!, triggerEntryId: result.selectedEntryIds.at(-1)! } }),
    waitForToolCall: async (id: string, name: "note" | "memory") => {
      const call = importer.persistedCall(id, name);
      if (!call) throw new Error(`source-not-ready: ${id}`);
      return { memory: importer.memory, ...call };
    },
  };
  return { importer, result, records, transcriptPath, exact, tools: new CcForegroundTools(coordinator as never), config, nativeSessionId };
}

const text = (result: Awaited<ReturnType<CcForegroundTools["call"]>>) => result.content[0]!.text;

test("installed native identity stays derived from the fixed plugin manifest and MCP server name", () => {
  const manifest = JSON.parse(readFileSync("plugin/.claude-plugin/plugin.json", "utf8"));
  const mcp = JSON.parse(readFileSync("plugin/.mcp.json", "utf8"));
  expect(manifest.name).toBe(CC_PLUGIN_NAME);
  expect(Object.keys(mcp)).toEqual([CC_MCP_SERVER_NAME]);
  expect(`mcp__plugin_${CC_PLUGIN_NAME}_${CC_MCP_SERVER_NAME}__note`).toBe("mcp__plugin_trace-memory_traceMemory__note");
});

test("CC foreground lists only search and writers, with no trace or Dreamer capability", async () => {
  const f = await fixture();
  try {
    const listed = f.tools.list(), expected = renderToolDefinitions(toolDefinitions.filter(tool => tool.name !== "check"), ccPluginToolNames);
    expect(listed.map(tool => tool.name)).toEqual(["search", "note", "memory"]);
    expect(listed.map(tool => tool.description)).toEqual(expected.map(tool => tool.description));
    expect(listed.map(tool => tool.inputSchema)).toEqual(expected.map(tool => tool.parameters));
    const note = listed.find(tool => tool.name === "note")!.inputSchema as { properties: Record<string, any>; else: { then: { required: string[] } } };
    expect(note).not.toHaveProperty("anyOf");
    expect(note.else.then.required).toEqual(["title", "sources"]);
    expect(note.properties).toHaveProperty("title");
    expect(note.properties.sources).toMatchObject({ type: "string" });
    expect(note.properties).not.toHaveProperty("facts");
    expect(note.properties).not.toHaveProperty("text");
    expect(note.properties).not.toHaveProperty("source");
    expect(listed.find(tool => tool.name === "trace")).toBeUndefined();
    expect(listed.map(tool => tool._meta)).toEqual(expected.map(() => ({ "anthropic/maxResultSizeChars": CC_MAX_RESULT_CHARS })));
  } finally { f.importer.close(); }
});

test("CC foreground rejects removed trace and keeps search separate from write authority", async () => {
  const f = await fixture();
  try {
    const note = await f.tools.call("note", { title: "Persisted write", sources: `[T${f.exact.headTurnId}#E2] Claude Code dispatched the persisted write call` }, { "claudecode/toolUseId": "call-note" });
    expect(note.isError).toBeUndefined();
    expect(f.importer.memory.store.listTurnFacts(f.exact.headTurnId)[0]?.title).toBe("Persisted write");
    const removedTool = await f.tools.call("trace", { address: `T${f.exact.headTurnId}#E1` }, undefined);
    expect(removedTool.isError).toBe(true); expect(text(removedTool)).toContain("unknown foreground tool");
    const create = await f.tools.call("memory", { op: "create", text: "body ".repeat(3000), category: "reference", scope: "session",
      supports: ["F1"], reason: "fixture", topics: [] }, { "claudecode/toolUseId": "call-memory" });
    expect(create.isError).toBeUndefined();
    const preview = await f.tools.call("search", { query: "body", layer: "knowledge" }, undefined);
    expect(preview.isError).toBeUndefined();
    const refused = await f.tools.call("memory", { op: "update", id: "K1@v1", text: "updated", category: "reference", scope: "session",
      supports: ["F1"], reason: "history is not a write base", topics: [] }, { "claudecode/toolUseId": "call-memory" });
    expect(refused.isError).toBe(true);
    const tagged = `K1#${f.importer.memory.store.versionTag(1, 1)}`;
    const update = await f.tools.call("memory", { op: "update", id: tagged, text: "updated", category: "reference", scope: "session",
      supports: ["F1"], reason: "tagged base does not grant manual update", topics: [] }, { "claudecode/toolUseId": "call-memory" });
    expect(update.isError).toBe(true); expect(text(update)).toContain("update belongs to the Dreamer");
  } finally { f.importer.close(); }
});

test("search scope, layer and code execute through the CC surface; removed parameters are refused", async () => {
  const f = await fixture();
  try {
    expect((await f.tools.call("note", { title: "Surface evidence", sources: `[T${f.exact.headTurnId}#E1] surface evidence` }, { "claudecode/toolUseId": "call-note" })).isError).toBeUndefined();
    expect((await f.tools.call("memory", { op: "create", text: "session alpha ".repeat(200), category: "reference", scope: "session", supports: ["F1"], reason: "seed", topics: ["alpha"] }, { "claudecode/toolUseId": "call-memory" })).isError).toBeUndefined();
    expect((await f.tools.call("memory", { op: "create", text: "global beta", category: "open", scope: "global", supports: ["F1"], reason: "seed", topics: ["beta"] }, { "claudecode/toolUseId": "call-memory" })).isError).toBeUndefined();
    const maintenance = await f.tools.call("memory", { op: "update", id: `K1#${f.importer.memory.store.versionTag(1, 1)}`, text: "session alpha current",
      category: "reference", scope: "session", supports: ["F1"], reason: "current", topics: ["alpha"] },
      { "claudecode/toolUseId": "call-memory" });
    expect(maintenance.isError).toBe(true); expect(text(maintenance)).toContain("update belongs to the Dreamer");
    const defaults = text(await f.tools.call("search", { layer: "knowledge" }, undefined));
    expect(defaults).toContain("session alpha"); expect(defaults).toContain("global beta");
    const session = text(await f.tools.call("search", { layer: "knowledge", scope: "session" }, undefined));
    expect(session).toContain("session alpha"); expect(session).not.toContain("global beta");
    const global = text(await f.tools.call("search", { layer: "knowledge", scope: "global" }, undefined));
    expect(global).toContain("K2@v1"); expect(global).not.toContain("session alpha");
    // The script runs through the CC surface: items arrive as structured values.
    const scripted = text(await f.tools.call("search", { layer: "knowledge", code: "text(hits.map(h => h.address + ' ' + h.scope).join(', '))" }, undefined));
    expect(scripted).toContain("Script completed"); expect(scripted).toContain("trace://K1@v1 session"); expect(scripted).toContain("trace://K2@v1 global");
    for (const removed of [{ cursor: "x" }, { cap: 1 }, { maxTokens: 8000 }, { versions: "all" }, { category: "open" }, { fields: [] }])
      expect((await f.tools.call("search", { layer: "knowledge", ...removed }, undefined)).isError).toBe(true);
  } finally { f.importer.close(); }
});

test("136 review STD1: the first over-long search output of a brand-new native session is saved and readable", async () => {
  const f = await fixture();
  try {
    const rendered = join(f.config.stateDir, "rendered", f.nativeSessionId);
    expect(existsSync(rendered)).toBe(false); // no trace:// Read has rendered anything for this session yet
    const out = text(await f.tools.call("search", { layer: "knowledge", code: "text('HEAD ' + 'word '.repeat(60000) + ' TAIL')" }, undefined));
    expect(out).not.toContain("Could not save");
    const path = /\[Full output: (.+)\]/.exec(out)![1]!;
    expect(path.startsWith(rendered + sep)).toBe(true);
    const saved = readFileSync(path, "utf8");
    expect(saved.startsWith("HEAD word")).toBe(true); expect(saved.endsWith(" TAIL")).toBe(true);
    expect(saved.length).toBeGreaterThan(300_000);
  } finally { f.importer.close(); }
});

test("CC foreground writes fail closed on missing, malformed and mismatched native metadata", async () => {
  const f = await fixture();
  try {
    for (const meta of [undefined, {}, { "claudecode/toolUseId": 3 }, { "claudecode/toolUseId": "other" }]) {
      const result = await f.tools.call("note", {}, meta);
      expect(result.isError).toBe(true);
    }
    expect(f.importer.memory.store.listTurnFacts(f.exact.headTurnId)).toEqual([]);
  } finally { f.importer.close(); }
});

test("expired fork calls never fall through to the persisted main manual write", async () => {
  const f = await fixture("mcp__traceMemory__", id => id === "call-note" ? "retired" : null);
  try {
    const expired = await f.tools.call("note", {}, { "claudecode/toolUseId": "call-note" });
    expect(expired.isError).toBe(true);
    expect(text(expired)).toContain("expired");
    const manual = await f.tools.call("memory", {}, { "claudecode/toolUseId": "call-memory" });
    expect(manual.isError).toBeUndefined();
    expect(f.importer.memory.store.listTurnFacts(f.exact.headTurnId)).toEqual([]);
  } finally { f.importer.close(); }
});

test("a restarted executor cannot turn an old fork-only call into a manual write", async () => {
  const f = await fixture();
  try {
    // The old fork's native call is not in this main-session transcript. Fresh executor
    // authority has no registration, so the exact persisted main-call check must reject it.
    const stale = await f.tools.call("note", {}, { "claudecode/toolUseId": "old-fork-call" });
    expect(stale.isError).toBe(true);
    expect(text(stale)).toContain("source-not-ready: old-fork-call");
    expect(f.importer.memory.store.listTurnFacts(f.exact.headTurnId)).toEqual([]);
    const manual = await f.tools.call("memory", {}, { "claudecode/toolUseId": "call-memory" });
    expect(manual.isError).toBeUndefined();
  } finally { f.importer.close(); }
});

test("CC foreground authenticates direct-MCP and installed-plugin identities without suffix matching", async () => {
  const plugin = await fixture("mcp__plugin_trace-memory_traceMemory__");
  try {
    expect(plugin.importer.persistedCall("call-note", "note")).toEqual(plugin.exact);
    expect(plugin.importer.persistedCall("call-memory", "memory")).not.toBeNull();
  } finally { plugin.importer.close(); }

  const f = await fixture();
  try {
    f.records.push(
      { uuid: "lookalike", parentUuid: "call", type: "assistant", timestamp: "2026-01-01T00:00:02.000Z",
        message: { role: "assistant", content: [{ type: "tool_use", id: "lookalike-note", name: "mcp__another-server_traceMemory__note", input: {} }] } },
      { uuid: "later-evidence", parentUuid: "lookalike", type: "assistant", timestamp: "2026-01-01T00:00:03.000Z",
        message: { role: "assistant", content: [{ type: "text", text: "later evidence" }] } },
    );
    writeFileSync(f.transcriptPath, f.records.map(line).join(""));
    await f.importer.reconcile();
    expect(() => f.importer.persistedCall("lookalike-note", "note")).toThrow("not mcp__traceMemory__note or mcp__plugin_trace-memory_traceMemory__note");
    const late = await f.tools.call("note", { title: "Late source", sources: `[T${f.exact.headTurnId}#E4] too late` }, { "claudecode/toolUseId": "call-note" });
    expect(late.isError).toBe(true); expect(text(late)).toContain("invalid source");
    const wrong = await f.tools.call("memory", {}, { "claudecode/toolUseId": "call-note" });
    expect(wrong.isError).toBe(true); expect(text(wrong)).toContain("not mcp__traceMemory__memory");
    expect(f.importer.memory.store.listTurnFacts(f.exact.headTurnId)).toEqual([]);
  } finally { f.importer.close(); }
});

test("repeated native call IDs remain ambiguous instead of selecting a carrier", async () => {
  const f = await fixture();
  try {
    f.records.push(
      { uuid: "u2", parentUuid: "call", type: "user", timestamp: "2026-01-01T00:00:02.000Z", promptSource: "typed",
        message: { role: "user", content: "again" } },
      { uuid: "duplicate", parentUuid: "u2", type: "assistant", timestamp: "2026-01-01T00:00:03.000Z",
        message: { role: "assistant", content: [{ type: "tool_use", id: "call-note", name: "mcp__plugin_trace-memory_traceMemory__note", input: {} }] } },
    );
    writeFileSync(f.transcriptPath, f.records.map(line).join("")); await f.importer.reconcile();
    expect(() => f.importer.persistedCall("call-note", "note")).toThrow("ambiguous");
  } finally { f.importer.close(); }
});

test("write wait timeout and cancellation commit nothing and queue no later write", async () => {
  const f = await fixture(); f.importer.close();
  const coordinator = new CcCoordinator(f.config, f.nativeSessionId, () => {}), tools = new CcForegroundTools(coordinator);
  await coordinator.start();
  try {
    const timedOut = await tools.call("note", {}, { "claudecode/toolUseId": "late-call" });
    expect(timedOut.isError).toBe(true); expect(text(timedOut)).toContain("source-not-ready");
    const controller = new AbortController(), pending = tools.call("note", {}, { "claudecode/toolUseId": "cancelled-call" }, controller.signal);
    setTimeout(() => controller.abort(new DOMException("cancel", "AbortError")), 5);
    const cancelled = await pending;
    expect(cancelled.isError).toBe(true); expect(text(cancelled)).toContain("cancelled");
    f.records.push({ uuid: "late", parentUuid: "call", type: "assistant", timestamp: "2026-01-01T00:00:02.000Z",
      message: { role: "assistant", content: [{ type: "tool_use", id: "late-call", name: "mcp__traceMemory__note", input: {} }] } });
    writeFileSync(f.transcriptPath, f.records.map(line).join(""));
    await coordinator.requestReconcile("late source");
    const binding = readBinding(f.config, f.nativeSessionId)!;
    expect(binding.coreSessionId).not.toBeNull();
    const store = new Store(f.config.dbPath);
    try {
      expect(store.listTurnFacts(1)).toEqual([]);
      store.setEnrollment(binding.coreSessionId!, false);
    } finally { store.close(); }
    const disabled = await tools.call("search", { query: "anything" }, undefined);
    expect(disabled.isError).toBeUndefined(); expect(text(disabled)).toContain("No hit does not mean absent");
  } finally { await coordinator.shutdown("test"); }
});

test("persisted call resolution follows its native ancestry after the selected branch rewinds", async () => {
  const f = await fixture();
  try {
    const before = f.importer.persistedCall("call-note", "note");
    f.records.push(
      { uuid: "sibling", parentUuid: "user", type: "assistant", timestamp: "2026-01-01T00:00:02.000Z",
        message: { role: "assistant", content: [{ type: "text", text: "replacement" }] } },
    );
    writeFileSync(f.transcriptPath, f.records.map(line).join(""));
    const moved = await f.importer.reconcile();
    expect(moved.branch).not.toBe(before!.branch);
    expect(f.importer.persistedCall("call-note", "note")).toEqual(before);
  } finally { f.importer.close(); }
});
