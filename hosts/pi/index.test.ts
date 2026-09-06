import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import extension from "./index";
import { TraceMemory } from "../../core/api/index";

type Conversation = Parameters<ExtensionContext["modelRegistry"]["complete"]>[1];
type Reply = Awaited<ReturnType<ExtensionContext["modelRegistry"]["complete"]>>;
const usage = { input: 1, output: 2, cacheRead: 0, cacheWrite: 0, totalTokens: 3, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } };
const reply = (output: string): Reply => ({ role: "assistant", content: [{ type: "text", text: output }], api: "openai-completions", provider: "fake", model: "test", stopReason: "stop", timestamp: 1, usage });
const disposers: (() => Promise<void>)[] = [];
afterEach(async () => { for (const dispose of disposers.splice(0)) await dispose(); });
function host(config: Record<string, unknown> = {}, marker?: string) {
  const dir = mkdtempSync("/private/tmp/trace-memory-host-");
  if (marker) writeFileSync(join(dir, ".trace-memory"), marker);
  const dbPath = join(dir, "trace.db");
  const hooks = new Map<string, (event: any, ctx: ExtensionContext) => any>();
  const tools = new Map<string, any>(), commands = new Map<string, any>(), entries: any[] = [], allEntries: any[] = [], notices: string[] = [];
  const requests: unknown[] = [], conversations: Conversation[] = [];
  let provider = async (_conversation: Conversation) => reply("[]");
  const model = { provider: "fake", id: "test" };
  const ctx = { cwd: dir, model, ui: { notify: (s: string) => notices.push(s) },
    sessionManager: { getSessionId: () => "pi-test", getBranch: () => entries, getEntries: () => allEntries },
    modelRegistry: { find: (p: string, id: string) => p === "fake" ? { ...model, id } : undefined,
      complete: async (selected: unknown, conversation: Conversation, options: any) => {
        conversations.push(structuredClone(conversation));
        const payload = { providerSpecific: true, model: selected, system: conversation.systemPrompt, messages: structuredClone(conversation.messages), tools: [] };
        await options.onPayload(payload);
        requests.push(structuredClone(payload));
        payload.providerSpecific = false; // The saved request must not alias provider state.
        return provider(conversation);
      } },
  } as unknown as ExtensionContext;
  const pi = { on: (name: string, fn: any) => hooks.set(name, fn), registerTool: (tool: any) => tools.set(tool.name, tool),
    registerCommand: (name: string, command: any) => commands.set(name, command),
    appendEntry: (customType: string, data: unknown) => { const entry = { id: `e${allEntries.length}`, type: "custom", customType, data: structuredClone(data) }; entries.push(entry); allEntries.push(entry); },
  } as unknown as ExtensionAPI;
  const previous = process.env.TRACE_MEMORY_CONFIG;
  process.env.TRACE_MEMORY_CONFIG = JSON.stringify({ dbPath, ...config });
  try { extension(pi); } finally { if (previous === undefined) delete process.env.TRACE_MEMORY_CONFIG; else process.env.TRACE_MEMORY_CONFIG = previous; }
  const memory = TraceMemory(dbPath, async () => { throw new Error("observer cannot call a model"); });
  const emit = async (name: string, event: object = {}) => hooks.get(name)?.({ type: name, ...event }, ctx);
  const drain = async () => { for (let i = 0; i < 10; i++) await new Promise(r => setImmediate(r)); };
  const prompt = (prompt = "用 pnpm，不要 npm") => emit("before_agent_start", { prompt, systemPrompt: "host" });
  const answer = (value = "好的。") => emit("message_end", { message: reply(value) });
  const turn = async () => { await prompt(); await answer(); await emit("agent_settled"); await drain(); };
  disposers.push(async () => { await emit("session_shutdown", { reason: "quit" }); memory.close(); rmSync(dir, { recursive: true, force: true }); });
  return { dir, ctx, entries, hooks, tools, commands, notices, memory, emit, prompt, answer, turn, drain, requests, conversations,
    provider: (fn: typeof provider) => { provider = fn; } };
}
function noteFact(conversation: Conversation) {
  const input = String(conversation.messages[0]!.content);
  const address = /S(\d+)\/T(\d+)/.exec(input)!;
  return reply(JSON.stringify([{ turn: address[0], title: "Package manager", topic: "tooling", facts: [
    { category: "observation", actor: "user", text: "用 pnpm，不要 npm", timestamp: "2026-09-07T00:00:00Z", source: [`T${address[2]}#user`] },
  ] }]));
}

test("smoke: the default extension loads and registers the Pi hooks, tools, and read-only command", async () => {
  const h = host();
  expect([...h.tools.keys()]).toEqual(["trace", "search", "mark"]);
  for (const name of ["agent_settled", "session_before_compact", "before_agent_start", "message_update", "message_end", "tool_result", "session_start", "session_tree"]) expect(h.hooks.has(name)).toBe(true);
  await h.emit("session_start");
  await h.commands.get("trace").handler("", h.ctx);
  expect(h.notices.at(-1)).toContain("no session id");
  expect(h.memory.store.getSession(1)).toBeNull();
  expect(h.requests).toHaveLength(0);
});

test("five answered turns trigger only at stop, reset at the watermark, and slash commands do not count", async () => {
  const h = host();
  for (let i = 0; i < 4; i++) { await h.turn(); await h.commands.get("trace").handler("", h.ctx); }
  expect(h.requests).toHaveLength(0);
  await h.prompt(); await h.answer();
  expect(h.requests).toHaveLength(0);
  await h.emit("agent_settled"); await h.drain();
  expect(h.requests).toHaveLength(1);
  expect(h.memory.store.getWatermark(1, "main")?.lastNotedTurn).toBe(5);
  await h.turn();
  expect(h.requests).toHaveLength(1);
  expect(h.memory.store.listTurns(1)).toHaveLength(6);
});

test("50K raw context growth triggers note, including tool results; no assistant means no answered turn", async () => {
  const h = host();
  await h.prompt(); await h.answer();
  await h.emit("tool_result", { toolName: "read", input: { path: "large.txt" }, content: [{ type: "text", text: "x".repeat(200_000) }], isError: false });
  expect(h.requests).toHaveLength(0);
  await h.emit("agent_settled"); await h.drain();
  expect(h.requests).toHaveLength(1);
  await h.prompt("/a-command-without-a-reply");
  await h.emit("session_before_compact", { preparation: { tokensBefore: 10 } });
  await h.emit("agent_settled");
  expect(h.memory.store.listTurns(1).at(-1)?.assistantText).toBeNull();
  expect(h.requests).toHaveLength(1);
});

test("note through runAgent commits the exact provider request, prompt, model, usage and subagent mode", async () => {
  const h = host({ "note.triggerAnsweredTurns": 1 });
  h.provider(async c => noteFact(c));
  await h.turn();
  const run = h.memory.store.listRuns(1)[0]!;
  expect(run.outcome).toBe("success");
  expect(run.mode).toBe("subagent"); expect(run.model).toBe("fake/test");
  expect(JSON.parse(run.request!)).toEqual(h.requests[0]);
  expect(h.conversations[0]!.systemPrompt).toBe(readFileSync(new URL("../../core/prompts/note.md", import.meta.url), "utf8"));
  expect(h.conversations[0]!.messages).toHaveLength(1);
  expect(h.conversations[0]!.tools).toBeUndefined();
  expect(JSON.parse(run.response!).usage).toEqual(usage);
  expect(h.memory.store.listSessionFacts(1)[0]!.text).toBe("用 pnpm，不要 npm");
});

test("first prompt injects project/global entries without allocating a session; marker is declared and mark wins", async () => {
  const h = host({}, "project-name");
  const p = h.memory.store.createProject({ name: "project-name", declaredBy: "marker" });
  const s = h.memory.store.createSession({ host: "fixture", projectId: p.id, startedAt: "now", firstReplyAt: "now" });
  const t = h.memory.store.appendTurn({ sessionId: s.id, kind: "turn", startedAt: "now", userPrompt: "规则" });
  const noted = h.memory.store.commitNoteRun({ run: { kind: "note", sessionId: s.id, createdAt: "now" }, facts: [
    { turnId: t.id, category: "observation", actor: "user", text: "规则", source: [`T${t.id}#user`], createdAt: "now" },
  ] });
  if (!noted.ok) throw new Error(noted.problems.join("; "));
  const seeded = h.memory.store.commitSettleRun({ run: { kind: "settle", sessionId: s.id, createdAt: "now" }, operations: [
    { op: "new", handle: "$e1", author: "fixture", text: "项目规则", supports: [noted.facts[0]!.id], createdAt: "now", category: "constraint", scope: "project" },
    { op: "new", handle: "$e2", author: "fixture", text: "全局规则", supports: [noted.facts[0]!.id], createdAt: "now", category: "constraint", scope: "global" },
  ] });
  expect(seeded.ok && seeded.rejected.length === 0).toBe(true);
  const injection = await h.prompt();
  expect(injection.message.content).toContain("项目规则"); expect(injection.message.content).toContain("全局规则");
  expect(h.memory.store.getSession(2)).toBeNull();
  await h.answer();
  expect(h.memory.store.projectDeclaration(2)).toBe("marker");
  await h.tools.get("mark").execute("id", { input: { project: "override" } });
  await h.emit("session_start");
  expect(h.memory.status(2)).toContain("override (mark)");
  expect(h.requests).toHaveLength(0);
});

test("raw is incremental and compaction contains intermediate assistant text without calling a model", async () => {
  const h = host();
  await h.prompt();
  expect(h.memory.store.getSession(1)).toBeNull();
  await h.emit("message_update", { message: reply("partial") });
  expect(h.memory.store.listTurns(1)[0]?.assistantText).toBe("partial");
  await h.emit("tool_result", { toolName: "bash", input: { command: "pwd" }, content: [{ type: "text", text: "result" }], isError: false });
  expect(h.memory.store.listToolCalls(1)).toHaveLength(1);
  const block = await h.emit("session_before_compact", { preparation: { tokensBefore: 99, firstKeptEntryId: "old" } });
  expect(block.compaction.summary).toBe(h.memory.compact(1, "main", 1));
  expect(block.compaction.summary).toContain("partial"); expect(block.compaction.firstKeptEntryId).toBe("");
  expect(h.requests).toHaveLength(0);
  await h.emit("session_compact", { compactionEntry: { summary: block.compaction.summary } });
  expect(h.memory.store.listTurns(1)[1]!.kind).toBe("compaction");
  await h.answer("finished"); await h.emit("agent_settled");
  await h.prompt("next");
  expect(h.memory.store.listTurns(1)[2]!.assistantText).toBeNull();
});

test("pending delivery is injected once on its own branch", async () => {
  const h = host({ "note.triggerAnsweredTurns": 1 });
  let release!: (value: Reply) => void;
  h.provider(async () => new Promise(resolve => { release = resolve; }));
  await h.turn();
  const original = [...h.entries];
  await h.prompt("second"); await h.answer();
  const mainTip = [...h.entries];
  release(noteFact(h.conversations[0]!)); await h.drain();
  expect(h.memory.store.listPendingDeliveries(1, "main")).toHaveLength(1);
  h.entries.splice(0, h.entries.length, ...original);
  await h.emit("session_tree");
  const injected = async () => (await h.prompt())?.message?.content ?? "";
  expect(await injected()).not.toContain("pending_notes");
  h.entries.splice(0, h.entries.length, ...mainTip); await h.emit("session_tree");
  expect(await injected()).toContain("pending_notes");
  expect(await injected()).not.toContain("pending_notes");
  expect(h.memory.store.listPendingDeliveries(1, "main")).toHaveLength(0);
});

test("in-flight duplicate is dropped; new raw and branch switches cannot change its frozen range", async () => {
  const h = host({ "note.triggerAnsweredTurns": 1 });
  let release!: (value: Reply) => void;
  h.provider(async () => new Promise(resolve => { release = resolve; }));
  await h.prompt(); await h.answer(); await h.emit("agent_settled");
  await h.emit("agent_settled"); expect(h.requests).toHaveLength(1);
  const old = [...h.entries];
  await h.prompt("later raw"); await h.answer();
  h.entries.splice(0, h.entries.length, ...old);
  await h.emit("session_tree");
  release(noteFact(h.conversations[0]!)); await h.drain();
  expect(h.memory.store.getWatermark(1, "main")?.lastNotedTurn).toBe(1);
  expect(h.memory.store.listPendingDeliveries(1, "main")).toHaveLength(1);
  expect(h.conversations[0]!.messages[0]!.content).not.toContain("later raw");
});

test("settle waits for a turn stop after facts arrive and final replays candidate plus one feedback message", async () => {
  const h = host({ "note.triggerAnsweredTurns": 1, "settle.triggerUnsettledFacts": 1, settleModel: "fake/settler" });
  const output = JSON.stringify({ new: [], edit: [], merge: [], delete: [], not_admitted: [{ id: "F1", because: "Not durable." }], near_ack: [], over_budget: false });
  h.provider(async c => c.systemPrompt!.includes("### Second-round user message") ? reply(output) : noteFact(c));
  await h.turn();
  expect(h.requests).toHaveLength(1); // No post-note completion trigger.
  await h.emit("agent_settled"); await h.drain();
  expect(h.requests).toHaveLength(3);
  const candidate = h.conversations[1]!, final = h.conversations[2]!;
  expect(final.systemPrompt).toBe(candidate.systemPrompt);
  expect(final.messages.slice(0, 1)).toEqual(candidate.messages);
  expect(final.messages[1]).toEqual(reply(output));
  expect(final.messages).toHaveLength(3); expect(final.messages[2]!.role).toBe("user");
  const runs = h.memory.store.listRuns(1).filter(r => r.kind === "settle");
  expect(runs.map(r => r.outcome)).toEqual(["success", "success"]);
  expect(runs.map(r => r.model)).toEqual(["fake/settler", "fake/settler"]);
  expect(JSON.parse(runs[1]!.request!)).toEqual(h.requests[2]);
});

test("session replacement does not close the facade or launch extraction", async () => {
  const h = host(); await h.turn();
  await h.emit("session_shutdown", { reason: "new" });
  await h.emit("session_start"); await h.turn();
  expect(h.memory.store.listTurns(1)).toHaveLength(2); expect(h.requests).toHaveLength(0);
});

test("core contains no Pi imports and host imports core only through the facade", () => {
  const files = (dir: string): string[] => readdirSync(dir, { withFileTypes: true }).flatMap(e => e.isDirectory() ? files(join(dir, e.name)) : [join(dir, e.name)]);
  for (const file of files("core").filter(f => f.endsWith(".ts"))) expect(readFileSync(file, "utf8")).not.toMatch(/(?:from\s*|import\s*\(|require\s*\()["'][^"']*(?:pi-coding-agent|pi-ai|pi-agent-core|hosts\/pi)/);
  expect(readFileSync("hosts/pi/index.ts", "utf8").match(/from "\.\.\/\.\.\/core\/[^\"]+"/g)).toEqual(['from "../../core/api/index"']);
});

test("token threshold uses growth since watermark, including the CJK heuristic", async () => {
  const h = host({ "note.triggerTokens": 4 });
  await h.prompt("一"); await h.answer("a"); await h.emit("agent_settled");
  expect(h.requests).toHaveLength(0); // 0.75 + 0.25 = 1.
  await h.prompt("一一一"); await h.answer("aaa"); await h.emit("agent_settled"); await h.drain();
  expect(h.requests).toHaveLength(1); // Three more tokens, exactly four since watermark.
  await h.prompt("一一一"); await h.answer("aaa"); await h.emit("agent_settled");
  expect(h.requests).toHaveLength(1); // Three since the new watermark.
});

test("provider failures retain captured request and do not advance a watermark", async () => {
  const h = host({ "note.triggerAnsweredTurns": 1 });
  h.provider(async () => { throw new Error("provider unavailable"); });
  await h.turn();
  const run = h.memory.store.listRuns(1)[0]!;
  expect(run.outcome).toBe("failure"); expect(JSON.parse(run.request!)).toEqual(h.requests[0]);
  expect(h.memory.store.getWatermark(1, "main")).toBeNull();
});

test("settle in-flight duplicates cannot erase the candidate continuation", async () => {
  const h = host({ "note.triggerAnsweredTurns": 1, "settle.triggerUnsettledFacts": 1 });
  h.provider(async c => noteFact(c)); await h.turn();
  const output = JSON.stringify({ new: [], edit: [], merge: [], delete: [], not_admitted: [{ id: "F1", because: "Not durable." }], near_ack: [], over_budget: false });
  let release!: (value: Reply) => void;
  h.provider(async c => c.messages.length === 1 ? new Promise(resolve => { release = resolve; }) : reply(output));
  await h.emit("agent_settled"); await h.emit("agent_settled");
  expect(h.requests).toHaveLength(2);
  release(reply(output)); await h.drain();
  expect(h.requests).toHaveLength(3);
  expect(h.memory.store.listRuns(1).map(r => r.outcome)).toEqual(["success", "success", "success"]);
});

test("entries are injected once per session; later prompts carry only deliveries", async () => {
  const h = host();
  const first = await h.prompt();
  expect(first?.message?.content).toContain("<entries>");
  await h.answer();
  const second = await h.prompt("again");
  expect(second?.message?.content ?? "").not.toContain("<entries>");
});
