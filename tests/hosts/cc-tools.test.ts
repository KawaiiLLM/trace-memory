import { afterEach, expect, test } from "vitest";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { toolDefinitions } from "../../src/core/api/index.ts";
import { Store } from "../../src/core/store/index.ts";
import { readBinding, recordSessionStart } from "../../src/hosts/cc/binding.ts";
import { resolveCcHostConfig } from "../../src/hosts/cc/config.ts";
import { CC_MCP_SERVER_NAME, CC_PLUGIN_NAME, CcImporter } from "../../src/hosts/cc/importer.ts";
import { CcCoordinator } from "../../src/hosts/cc/lifecycle.ts";
import { CC_MAX_RESULT_CHARS, CcForegroundTools } from "../../src/hosts/cc/tools.ts";

const directories: string[] = [];
afterEach(() => { for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true }); });
const line = (value: unknown) => `${JSON.stringify(value)}\n`;

async function fixture(nativePrefix = "mcp__traceMemory__") {
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

test("CC foreground list reuses exactly the four core schemas and no Dreamer capability", async () => {
  const f = await fixture();
  try {
    const listed = f.tools.list(), expected = toolDefinitions.filter(tool => tool.name !== "check");
    expect(listed.map(tool => tool.name)).toEqual(["trace", "search", "note", "memory"]);
    expect(listed.map(tool => tool.description)).toEqual(expected.map(tool => tool.description));
    expect(listed.map(tool => tool.inputSchema)).toEqual(expected.map(tool => tool.parameters));
    const note = listed.find(tool => tool.name === "note")!.inputSchema as { properties: Record<string, any> };
    const fact = note.properties.facts.items;
    expect(fact.required).toContain("title");
    expect(fact.required).toContain("sources");
    expect(fact.properties).not.toHaveProperty("text");
    expect(fact.properties).not.toHaveProperty("source");
    const trace = listed.find(tool => tool.name === "trace")!.inputSchema as { properties: Record<string, unknown> };
    expect(trace.properties).not.toHaveProperty("tool");
    expect(trace.properties).not.toHaveProperty("layer");
    expect(trace.properties).toHaveProperty("toolCallBudget");
    expect(trace.properties).toHaveProperty("toolResultBudget");
    expect(listed.map(tool => tool._meta)).toEqual(expected.map(() => ({ "anthropic/maxResultSizeChars": CC_MAX_RESULT_CHARS })));
  } finally { f.importer.close(); }
});

test("CC foreground reads keep one core cursor across calls without a read-authority ledger", async () => {
  const f = await fixture();
  try {
    const note = await f.tools.call("note", { facts: [{ title: "Persisted write", sources: [{ address: `T${f.exact.headTurnId}#E2`, text: "Claude Code dispatched the persisted write call" }] }] }, { "claudecode/toolUseId": "call-note" });
    expect(note.isError).toBeUndefined();
    expect(f.importer.memory.store.listTurnFacts(f.exact.headTurnId)[0]?.title).toBe("Persisted write");
    const removedTool = await f.tools.call("trace", { address: `T${f.exact.headTurnId}#E1`, tool: 0 }, undefined);
    expect(removedTool.isError).toBe(true);
    const create = await f.tools.call("memory", { operations: [{ op: "create", text: "body ".repeat(3000), category: "reference", scope: "session",
      supports: ["F1"], reason: "fixture", topics: [] }], skipped: [] }, { "claudecode/toolUseId": "call-memory" });
    expect(create.isError).toBeUndefined();
    const preview = await f.tools.call("search", { query: "body", layer: "knowledge" }, undefined);
    expect(preview.isError).toBeUndefined();
    const refused = await f.tools.call("memory", { operations: [{ op: "update", id: "K1@v1", text: "updated", category: "reference", scope: "session",
      supports: ["F1"], reason: "history is not a write base", topics: [] }], skipped: [] }, { "claudecode/toolUseId": "call-memory" });
    expect(refused.isError).toBe(true);
    let page = await f.tools.call("trace", { address: "K1@v1", itemBudget: null, pageBudget: 100 }, undefined);
    expect(text(page)).toContain("cursor=");
    const firstCursor = /cursor=([^\s]+)/.exec(text(page))![1];
    page = await f.tools.call("trace", { address: "", cursor: firstCursor }, undefined);
    while (/cursor=([^\s]+)/.test(text(page))) page = await f.tools.call("trace", { address: "", cursor: /cursor=([^\s]+)/.exec(text(page))![1] }, undefined);
    const update = await f.tools.call("memory", { operations: [{ op: "update", id: /K1#[a-z]+/.exec(text(page))![0], text: "updated", category: "reference", scope: "session",
      supports: ["F1"], reason: "tagged base does not grant manual update", topics: [] }], skipped: [] }, { "claudecode/toolUseId": "call-memory" });
    expect(update.isError).toBe(true); expect(text(update)).toContain("update belongs to the Dreamer");
    const second = new CcImporter(f.config, readBinding(f.config, f.nativeSessionId)!);
    try {
      const projection = await second.reconcile();
      const reconnect = new CcForegroundTools({ toolProjection: async () => ({ memory: second.memory,
        binding: { coreSessionId: projection.coreSessionId!, branch: projection.branch, headTurnId: projection.headTurnId!, triggerEntryId: projection.selectedEntryIds.at(-1)! } }) } as never);
      const unknown = await reconnect.call("trace", { address: "", cursor: firstCursor }, undefined);
      expect(unknown.isError).toBe(true);
    } finally { second.close(); }
  } finally { f.importer.close(); }
});

test("CC character pages withhold the version tag until the final page, not a read-authority grant", async () => {
  const f = await fixture();
  try {
    expect((await f.tools.call("note", { facts: [{ title: "Knowledge evidence", sources: [{ address: `T${f.exact.headTurnId}#E1`, text: "large knowledge evidence" }] }] }, { "claudecode/toolUseId": "call-note" })).isError).toBeUndefined();
    const body = `BEGIN${" ".repeat(600_000)}END`;
    expect((await f.tools.call("memory", { operations: [{ op: "create", text: body, category: "reference", scope: "session",
      supports: ["F1"], reason: "large fixture", topics: [] }], skipped: [] }, { "claudecode/toolUseId": "call-memory" })).isError).toBeUndefined();
    const first = await f.tools.call("trace", { address: "K1@v1", itemBudget: null, pageBudget: 8_000 }, undefined);
    expect(first.isError).toBeUndefined(); expect(text(first).length).toBeLessThanOrEqual(CC_MAX_RESULT_CHARS);
    expect(text(first)).not.toContain("page limited by");
    const cursor = /cursor=([^\s]+)/.exec(text(first))![1]!;
    const refused = await f.tools.call("memory", { operations: [{ op: "update", id: "K1@v1", text: "history is not a tagged base", category: "reference",
      scope: "session", supports: ["F1"], reason: "before final page", topics: [] }], skipped: [] }, { "claudecode/toolUseId": "call-memory" });
    expect(refused.isError).toBe(true); expect(text(refused)).toContain("supply an exact K#tag");
    expect(text(first)).not.toMatch(/K1#[a-z]+/);
    const second = await f.tools.call("trace", { address: "", cursor }, undefined);
    expect(second.isError).toBeUndefined(); expect(text(second).length).toBeLessThanOrEqual(CC_MAX_RESULT_CHARS);
    expect(text(second)).not.toContain("cursor=");
    const update = await f.tools.call("memory", { operations: [{ op: "update", id: /K1#[a-z]+/.exec(text(second))![0], text: "fully read", category: "reference",
      scope: "session", supports: ["F1"], reason: "after final page", topics: [] }], skipped: [] }, { "claudecode/toolUseId": "call-memory" });
    expect(update.isError).toBe(true); expect(text(update)).toContain("update belongs to the Dreamer");
    const hidden = await f.tools.call("trace", { address: "K1@v2", maxChars: 1 }, undefined);
    expect(hidden.isError).toBe(true); expect(text(hidden)).toContain("unexpected parameter");
  } finally { f.importer.close(); }
});

test("ticket 41 filters, representatives, cursors and ceilings execute through the CC surface", async () => {
  const f = await fixture();
  try {
    expect((await f.tools.call("note", { facts: [{ title: "Surface evidence", sources: [{ address: `T${f.exact.headTurnId}#E1`, text: "surface evidence" }] }] }, { "claudecode/toolUseId": "call-note" })).isError).toBeUndefined();
    expect((await f.tools.call("memory", { operations: [
      { op: "create", text: "session alpha ".repeat(200), category: "reference", scope: "session", supports: ["F1"], reason: "seed", topics: ["alpha"] },
      { op: "create", text: "global beta", category: "open", scope: "global", supports: ["F1"], reason: "seed", topics: ["beta"] },
    ], skipped: [] }, { "claudecode/toolUseId": "call-memory" })).isError).toBeUndefined();
    let exact = await f.tools.call("trace", { address: "K1@v1", itemBudget: null }, undefined);
    while (/cursor=([^\s]+)/.test(text(exact))) exact = await f.tools.call("trace", { address: "", cursor: /cursor=([^\s]+)/.exec(text(exact))![1] }, undefined);
    const maintenance = await f.tools.call("memory", { operations: [{ op: "update", id: /K1#[a-z]+/.exec(text(exact))![0], text: "session alpha current",
      category: "reference", scope: "session", supports: ["F1"], reason: "current", topics: ["alpha"] }], skipped: [] },
      { "claudecode/toolUseId": "call-memory" });
    expect(maintenance.isError).toBe(true); expect(text(maintenance)).toContain("update belongs to the Dreamer");
    const defaults = text(await f.tools.call("search", { query: "", layer: "knowledge" }, undefined));
    expect(defaults).toContain("One representative per K"); expect(defaults).toContain("session alpha"); expect(defaults).toContain("global beta");
    const session = text(await f.tools.call("search", { query: "", layer: "knowledge", scope: "session" }, undefined));
    expect(session).toContain("session alpha"); expect(session).not.toContain("global beta");
    const category = text(await f.tools.call("search", { query: "", category: "open", scope: "global", fields: [] }, undefined));
    expect(category).toContain("K2@v1"); expect(category).not.toContain("global beta");
    const history = text(await f.tools.call("search", { query: "alpha", layer: "knowledge", versions: "history" }, undefined));
    expect(history).toContain("[K1@v1]"); expect(history).toContain("session alpha"); expect(history).not.toContain("session alpha current");
    const all = text(await f.tools.call("search", { query: "alpha", layer: "knowledge", versions: "all" }, undefined));
    expect(all.match(/\[K1@v/g)).toHaveLength(1);
    const page = await f.tools.call("search", { query: "", layer: "knowledge", cap: 1 }, undefined);
    const cursor = /cursor=([^\s]+)/.exec(text(page))?.[1];
    expect(cursor).toBeTruthy();
    const changed = await f.tools.call("search", { query: "", cursor, fields: ["status"] }, undefined);
    expect(changed.isError).toBe(true); expect(text(changed)).toContain("cursor");
    const continued = await f.tools.call("search", { query: "", cursor }, undefined);
    expect(continued.isError).toBeUndefined();
    const ceiling = await f.tools.call("search", { query: "", maxTokens: 8001 }, undefined);
    expect(ceiling.isError).toBe(true); expect(text(ceiling)).toContain("at most 8000");
  } finally { f.importer.close(); }
});

test("CC foreground writes fail closed on missing, malformed and mismatched native metadata", async () => {
  const f = await fixture();
  try {
    for (const meta of [undefined, {}, { "claudecode/toolUseId": 3 }, { "claudecode/toolUseId": "other" }]) {
      const result = await f.tools.call("note", { facts: [] }, meta);
      expect(result.isError).toBe(true);
    }
    expect(f.importer.memory.store.listTurnFacts(f.exact.headTurnId)).toEqual([]);
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
    const late = await f.tools.call("note", { facts: [{ title: "Late source", sources: [{ address: `T${f.exact.headTurnId}#E4`, text: "too late" }] }] }, { "claudecode/toolUseId": "call-note" });
    expect(late.isError).toBe(true); expect(text(late)).toContain("invalid source");
    const wrong = await f.tools.call("memory", { operations: [], skipped: [] }, { "claudecode/toolUseId": "call-note" });
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
    const timedOut = await tools.call("note", { facts: [] }, { "claudecode/toolUseId": "late-call" });
    expect(timedOut.isError).toBe(true); expect(text(timedOut)).toContain("source-not-ready");
    const controller = new AbortController(), pending = tools.call("note", { facts: [] }, { "claudecode/toolUseId": "cancelled-call" }, controller.signal);
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
    const disabled = await tools.call("search", { query: "" }, undefined);
    expect(disabled.isError).toBeUndefined(); expect(text(disabled)).toContain("Search uses literal substring search");
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
