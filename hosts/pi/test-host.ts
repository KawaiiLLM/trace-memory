import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import extension from "./index.ts";
import { TraceMemory } from "../../core/api/index.ts";

type Conversation = Parameters<ExtensionContext["modelRegistry"]["complete"]>[1];
export type Reply = Awaited<ReturnType<ExtensionContext["modelRegistry"]["complete"]>>;
export const usage = { input: 1, output: 2, cacheRead: 0, cacheWrite: 0, totalTokens: 3, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } };
export const reply = (output: string): Reply => ({ role: "assistant", content: [{ type: "text", text: output }], api: "openai-completions", provider: "fake", model: "test", stopReason: "stop", timestamp: 1, usage });
export function host(config: Record<string, unknown> = {}, marker?: string) {
  const dir = mkdtempSync(join(tmpdir(), "trace-memory-host-"));
  if (marker) writeFileSync(join(dir, ".trace-memory"), marker);
  const dbPath = join(dir, "trace.db");
  const hooks = new Map<string, (event: any, ctx: ExtensionContext) => any>();
  const tools = new Map<string, any>(), commands = new Map<string, any>(), entries: any[] = [], allEntries: any[] = [], notices: string[] = [];
  const requests: unknown[] = [], conversations: Conversation[] = [];
  let provider = async (_conversation: Conversation) => reply("[]");
  let autoStop = true; // the fake model stops by itself after a write unless a test drives the rounds
  const model = { provider: "fake", id: "test", api: "openai-completions" };
  const ctx = { cwd: dir, model, ui: { notify: (s: string) => notices.push(s) },
    sessionManager: { getSessionId: () => "pi-test", getBranch: () => entries, getEntries: () => allEntries },
    modelRegistry: { getApiKeyAndHeaders: async () => ({ ok: true, apiKey: "fake-key", headers: { "x-test": "header" }, env: {}, baseUrl: "https://fake.invalid" }),
      find: (p: string, id: string) => p === "fake" ? { ...model, id } : undefined,
      complete: async (selected: unknown, conversation: Conversation, options: any) => {
        conversations.push(structuredClone(conversation));
        const payload = { providerSpecific: true, model: selected, system: conversation.systemPrompt, messages: structuredClone(conversation.messages), tools: structuredClone(conversation.tools ?? []) };
        await options.onPayload(payload);
        requests.push(structuredClone(payload));
        payload.providerSpecific = false; // The saved request must not alias provider state.
        if (autoStop && conversation.tools?.some((t) => t.name === "note") && conversation.messages.some((m) => m.role === "toolResult" && m.toolName === "note")) return reply("Done.");
        if (conversation.messages.some(m => m.role === "toolResult" && m.toolName === "memory" && (m.content[0] as { text: string }).text.includes('"committed"'))) return reply("Done.");
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
  const dispose = async () => { await emit("session_shutdown", { reason: "quit" }); memory.close(); rmSync(dir, { recursive: true, force: true }); };
  return { dispose, dir, ctx, entries, hooks, tools, commands, notices, memory, emit, prompt, answer, turn, drain, requests, conversations,
    provider: (fn: typeof provider, options: { autoStop?: boolean } = {}) => { provider = fn; autoStop = options.autoStop ?? true; } };
}
export function recordingFact(conversation: Conversation) {
  const input = String(conversation.messages[0]!.content);
  const address = /S(\d+)\/T(\d+)/.exec(input)!;
  if (conversation.messages.some((m) => m.role === "toolResult" && m.toolName === "note")) return reply("Done.");
  return { ...reply(""), stopReason: "toolUse" as const, content: [{ type: "toolCall" as const, id: "note-1", name: "note", arguments: { facts: [
    { category: "observation", actor: "user", text: "用 pnpm，不要 npm", source: [`T${address[2]}#user`] },
  ] } }] };
}

export const integrationBatch = { operations: [], skipped: [{ fact: "F1", because: "Not durable." }] };
export const integrationReply = (): Reply => ({ ...reply(""), stopReason: "toolUse", content: [{ type: "toolCall", id: "memory-1", name: "memory", arguments: integrationBatch }] });
