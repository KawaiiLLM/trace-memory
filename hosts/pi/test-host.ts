import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
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
  // Pi settings the host reads for retries: a fast, deterministic policy instead of the user's ~/.pi/agent.
  const agentDir = join(dir, "agent"); mkdirSync(agentDir, { recursive: true });
  writeFileSync(join(agentDir, "settings.json"), JSON.stringify({ retry: { enabled: true, maxRetries: 1, baseDelayMs: 5, ...(config.retry as object ?? {}) } }));
  process.env.PI_CODING_AGENT_DIR = agentDir;
  if (marker) writeFileSync(join(dir, ".trace-memory"), marker);
  const dbPath = join(dir, "trace.db");
  const hooks = new Map<string, (event: any, ctx: ExtensionContext) => any>();
  const tools = new Map<string, any>(), commands = new Map<string, any>(), entries: any[] = [], allEntries: any[] = [], notices: string[] = [];
  const requests: unknown[] = [], conversations: Conversation[] = [];
  let provider = async (_conversation: Conversation) => reply("[]");
  let autoStop = true; // the fake model stops by itself after a write unless a test drives the rounds
  const model = { provider: "fake", id: "test", api: "openai-completions" };
  const statuses = new Map<string, string | undefined>();
  const ctx = { cwd: dir, model, ui: { notify: (s: string) => notices.push(s), setStatus: (key: string, text: string | undefined) => statuses.set(key, text),
      theme: { fg: (color: string, text: string) => `<${color}>${text}</${color}>` } },
    sessionManager: { getSessionId: () => "pi-test", getLeafId: () => entries.at(-1)?.id ?? null, getBranch: () => entries, getEntries: () => allEntries },
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
    appendEntry: (customType: string, data: unknown) => { const entry = { id: `e${allEntries.length}`, parentId: entries.at(-1)?.id ?? null, timestamp: new Date().toISOString(), type: "custom", customType, data: structuredClone(data) }; entries.push(entry); allEntries.push(entry); },
  } as unknown as ExtensionAPI;
  const previous = process.env.TRACE_MEMORY_CONFIG;
  const { retry: _retry, ...extensionConfig } = config as { retry?: unknown } & Record<string, unknown>;
  process.env.TRACE_MEMORY_CONFIG = JSON.stringify({ dbPath, ...extensionConfig });
  try { extension(pi); } finally { if (previous === undefined) delete process.env.TRACE_MEMORY_CONFIG; else process.env.TRACE_MEMORY_CONFIG = previous; }
  const memory = TraceMemory(dbPath, async () => { throw new Error("observer cannot call a model"); });
  const persist = (message: unknown, id = `e${allEntries.length}`) => {
    const entry = { id, parentId: entries.at(-1)?.id ?? null, timestamp: new Date().toISOString(), type: "message", message: structuredClone(message) };
    entries.push(entry); allEntries.push(entry); return entry;
  };
  const emit = async (name: string, event: any = {}) => {
    if (name === "tool_result") {
      const id = event.toolCallId ?? `call-${allEntries.length}`;
      if (!entries.some(e => e.type === "message" && e.message.role === "assistant" && e.message.content.some((c: any) => c.type === "toolCall" && c.id === id))) {
        await emit("message_end", { message: { ...reply(""), content: [{ type: "toolCall", id, name: event.toolName, arguments: event.input }] } });
      }
      const result = await hooks.get(name)?.({ type: name, ...event, toolCallId: id }, ctx);
      await emit("message_end", { message: { role: "toolResult", toolCallId: id, toolName: event.toolName, content: event.content, details: event.details, isError: event.isError, timestamp: 1 } });
      await emit("message_start", { message: reply("") });
      return result;
    }
    const result = await hooks.get(name)?.({ type: name, ...event }, ctx);
    if (name === "message_end") persist(event.message);
    return result;
  };
  const drain = async () => { for (let i = 0; i < 10; i++) await new Promise(r => setImmediate(r)); };
  const prompt = async (prompt = "用 pnpm，不要 npm") => {
    const result = await emit("before_agent_start", { prompt, systemPrompt: "host" });
    await emit("message_start", { message: { role: "user", content: prompt, timestamp: 1 } });
    await emit("message_end", { message: { role: "user", content: prompt, timestamp: 1 } });
    return result;
  };
  const answer = async (value = "好的。") => { await emit("message_end", { message: reply(value) }); await emit("agent_end"); };
  const turn = async () => { await prompt(); await answer(); await emit("agent_settled"); await drain(); };
  const dispose = async () => { await emit("session_shutdown", { reason: "quit" }); memory.close(); rmSync(dir, { recursive: true, force: true }); };
  return { dispose, dir, ctx, entries, allEntries, persist, hooks, tools, commands, notices, statuses, memory, emit, prompt, answer, turn, drain, requests, conversations,
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
