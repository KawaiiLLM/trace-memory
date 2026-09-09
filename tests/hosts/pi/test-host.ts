import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import extension, { piResultText } from "../../../src/hosts/pi/index.ts";
import { TraceMemory } from "../../../src/core/api/index.ts";

type Conversation = Parameters<ExtensionContext["modelRegistry"]["complete"]>[1];
export type Reply = Awaited<ReturnType<ExtensionContext["modelRegistry"]["complete"]>>;
export const usage = { input: 1, output: 2, cacheRead: 0, cacheWrite: 0, reasoning: 0, totalTokens: 3, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } };
export const reply = (output: string): Reply => ({ role: "assistant", content: [{ type: "text", text: output }], api: "openai-completions", provider: "fake", model: "test", stopReason: "stop", timestamp: 1, usage });
/** 19a: a real Pi SessionManager backing the fake context, so native fork work has a real file. */
export type NativeSource = () => { getSessionId(): string; getSessionFile(): string | undefined; getLeafId(): string | null;
  getBranch(): unknown[]; getEntries(): unknown[]; appendCustomEntry(customType: string, data?: unknown): string } | undefined;
/** The scripted-reply seam (19c cutover). The request-copy runner is gone: every task this fake host
 * admits runs in a real Pi child `AgentSession` built by `hosts/pi/native.ts`, so the only place a
 * test can script a reply is the wire. `provider(fn)` keeps its old signature — it is handed the
 * conversation reconstructed from the body the real pi-ai adapter serialized, and its `Reply` is
 * returned as `openai-completions` SSE, exactly as `native-fixture.ts` does for the fork tests.
 * `requests` holds the real outgoing bodies; `conversations` their reconstruction. */
type Message = Conversation["messages"][number];
const partsText = (content: unknown): string => typeof content === "string" ? content
  : Array.isArray(content) ? content.filter((c: any) => c?.type === "text" || typeof c?.text === "string").map((c: any) => c.text ?? "").join("") : "";
/** A rejection receipt is not a successful tool result — the same rule the adapter applies. */
const rejectedResult = (name: string, content: string): boolean => {
  if (content.startsWith("rejected:")) return true;
  if (name !== "note" && name !== "memory") return false;
  try { const { results } = JSON.parse(content); return Array.isArray(results) && results.some((r: unknown) => typeof r === "string" && r.startsWith("rejected:")); }
  catch { return false; }
};
/** The body the child actually sent, read back as the conversation the tests assert on. */
export function conversationOf(body: any): Conversation {
  const messages: Message[] = [];
  const names = new Map<string, string>();
  let systemPrompt: string | undefined;
  for (const message of body.messages ?? []) {
    if (message.role === "system" || message.role === "developer") { systemPrompt = partsText(message.content); continue; }
    if (message.role === "user") { messages.push({ role: "user", content: partsText(message.content), timestamp: 1 } as Message); continue; }
    if (message.role === "assistant") {
      const content: any[] = [];
      const text = partsText(message.content);
      if (text) content.push({ type: "text", text });
      for (const call of message.tool_calls ?? []) {
        names.set(call.id, call.function.name);
        content.push({ type: "toolCall", id: call.id, name: call.function.name, arguments: JSON.parse(call.function.arguments || "{}") });
      }
      messages.push({ role: "assistant", content, timestamp: 1 } as Message);
      continue;
    }
    if (message.role === "tool") {
      const text = partsText(message.content), name = names.get(message.tool_call_id) ?? "";
      messages.push({ role: "toolResult", toolCallId: message.tool_call_id, toolName: name, content: [{ type: "text", text }],
        isError: rejectedResult(name, text), timestamp: 1 } as unknown as Message);
    }
  }
  return { systemPrompt, messages, tools: (body.tools ?? []).map((tool: any) => tool.function ?? tool) } as Conversation;
}
/** A scripted `Reply` as the SSE the installed openai-completions adapter parses. A scripted provider
 * error comes back as an HTTP error carrying the scripted message, which is where a real one arrives
 * and where Pi's own retry policy classifies it (the status itself is deliberately one Pi does not
 * treat as transient, so the scripted text decides). */
function responseOf(value: Reply): Response {
  if (value.stopReason === "error") return new Response(JSON.stringify({ error: { message: value.errorMessage ?? "provider error" } }),
    { status: 400, headers: { "content-type": "application/json" } });
  const calls = value.content.filter((c: any) => c.type === "toolCall") as any[];
  const text = value.content.filter((c: any) => c.type === "text").map((c: any) => c.text).join("");
  const reported = (value.usage ?? usage) as typeof usage;
  const cacheRead = reported.cacheRead ?? 0;
  const chunk = { id: "c", object: "chat.completion.chunk", created: 1, model: "test",
    choices: [{ index: 0, finish_reason: calls.length ? "tool_calls" : value.stopReason === "length" ? "length" : "stop",
      delta: calls.length ? { role: "assistant", tool_calls: calls.map((call, index) => ({ index, id: call.id, type: "function", function: { name: call.name, arguments: JSON.stringify(call.arguments) } })) }
        : { role: "assistant", content: text } }],
    usage: { prompt_tokens: (reported.input ?? 0) + cacheRead, completion_tokens: reported.output ?? 0,
      total_tokens: (reported.input ?? 0) + cacheRead + (reported.output ?? 0), prompt_tokens_details: { cached_tokens: cacheRead } } };
  return new Response(`data: ${JSON.stringify(chunk)}\n\ndata: [DONE]\n\n`, { headers: { "content-type": "text/event-stream" } });
}

/** One global `fetch` stub serves every live host: several 17c cases run two hosts at once, so each
 * host answers only its own provider base URL. Unknown URLs fall through to whatever was installed
 * before (a fixture's own stub, or the real fetch). */
const wires = new Map<string, (init: RequestInit) => Promise<Response>>();
let replaced: typeof globalThis.fetch | undefined;
let wireCount = 0;
function install(origin: string, wire: (init: RequestInit) => Promise<Response>) {
  wires.set(origin, wire);
  if (replaced) return;
  replaced = globalThis.fetch;
  globalThis.fetch = (async (url: unknown, init: RequestInit) => {
    const wired = wires.get(new URL(String(url)).origin);
    return wired ? wired(init) : replaced!(url as never, init as never);
  }) as typeof globalThis.fetch;
}
function uninstall(origin: string) {
  wires.delete(origin);
  if (wires.size || !replaced) return;
  globalThis.fetch = replaced;
  replaced = undefined;
}

export function host(config: Record<string, unknown> = {}, options: { native?: NativeSource; fetch?: boolean; extension?: typeof extension } = {}) {
  const dir = mkdtempSync(join(tmpdir(), "trace-memory-host-"));
  const origin = `https://fake-${wireCount++}.invalid`;
  // Pi settings the child reads through its own SettingsManager (19c gate 6): a fast, deterministic
  // retry policy instead of the user's ~/.pi/agent.
  const agentDir = join(dir, "agent"); mkdirSync(agentDir, { recursive: true });
  writeFileSync(join(agentDir, "settings.json"), JSON.stringify({ retry: { enabled: true, maxRetries: 1, baseDelayMs: 5, ...(config.retry as object ?? {}) } }));
  // Models the native child resolves through Pi's own ModelRuntime; the stubbed fetch answers them.
  writeFileSync(join(agentDir, "models.json"), JSON.stringify({ providers: Object.fromEntries((["openai-completions", "anthropic-messages"] as const).map((api, i) => [
    i === 0 ? "fake" : "fakeanthropic", { name: "Fake", baseUrl: `${origin}/v1`, apiKey: "fake-key", api,
      models: ["test", "test-mini"].map(id => ({ id, name: `Test ${id}`, reasoning: false, input: ["text"], contextWindow: 200000, maxTokens: 8192, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } })) }])) }));
  process.env.PI_CODING_AGENT_DIR = agentDir;
  const native = () => options.native?.();
  const dbPath = String(config.dbPath ?? join(dir, "trace.db"));
  const hooks = new Map<string, (event: any, ctx: ExtensionContext) => any>();
  const tools = new Map<string, any>(), commands = new Map<string, any>(), entries: any[] = [], allEntries: any[] = [], notices: string[] = [];
  const requests: unknown[] = [], conversations: Conversation[] = [], signals: AbortSignal[] = [];
  let provider = async (_conversation: Conversation, _signal?: AbortSignal) => reply("[]");
  let autoStop = true; // the fake model stops by itself after a write unless a test drives the rounds
  let ignoreAbort = false; // a wedged connection that a cancelled child cannot end
  const model = { provider: "fake", id: "test", api: "openai-completions", name: "Test", baseUrl: `${origin}/v1`,
    reasoning: false, input: ["text"], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 200_000, maxTokens: 8192 };
  const dialogs: { title: string; options?: string[] }[] = [];
  const answers: (string | boolean | undefined)[] = [];
  let headerTimestamp: unknown = "2099-01-01T00:00:00.000Z";
  const statuses = new Map<string, string | undefined>();
  // A notice is host activity: it keeps `drain` waiting through a short retry backoff, which
  // otherwise looks idle (a scheduled retry paints the footer warning, not the running indicator).
  const ctx = { cwd: dir, model, hasUI: false, ui: { notify: (s: string) => { activity++; notices.push(s); }, setStatus: (key: string, text: string | undefined) => statuses.set(key, text),
      select: async (title: string, options: string[]) => { dialogs.push({ title, options }); return answers.shift(); },
      confirm: async (title: string, message: string) => { dialogs.push({ title: `${title} ${message}` }); return answers.shift() ?? false; },
      input: async (title: string) => { dialogs.push({ title }); return answers.shift(); },
      theme: { fg: (color: string, text: string) => `<${color}>${text}</${color}>` } },
    sessionManager: { getHeader: () => ({ timestamp: headerTimestamp }), getSessionId: () => native()?.getSessionId() ?? "pi-test",
      getSessionFile: () => native()?.getSessionFile(),
      getLeafId: () => native() ? native()!.getLeafId() : entries.at(-1)?.id ?? null,
      getBranch: () => native()?.getBranch() ?? entries, getEntries: () => native()?.getEntries() ?? allEntries },
    modelRegistry: { getApiKeyAndHeaders: async () => ({ ok: true, apiKey: "fake-key", headers: { "x-test": "header" }, env: {}, baseUrl: "https://fake.invalid" }),
      find: (p: string, id: string) => p === "fake" ? { ...model, id } : undefined,
      // 24b: the models a settings edit may choose from. Pi's registry answers `getAvailable` with
      // the auth-resolved snapshot; the fake answers the two its models.json defines.
      getAvailable: () => ["test", "test-mini"].map(id => ({ ...model, id })),
      getAll: () => ["test", "test-mini"].map(id => ({ ...model, id })),
      complete: async () => { throw new Error("19c: the host has no request-copy runner; scripted replies arrive at the wire"); } },
  } as unknown as ExtensionContext;
  // The wire. A test that brings its own parent AgentSession (native-fixture.ts) stubs `fetch` itself.
  let inflight = 0, activity = 0, shuttingDown = false;
  const stubbed = options.fetch !== false;
  if (stubbed) install(origin, (async (init: RequestInit) => {
    const body = JSON.parse(String(init.body));
    const conversation = conversationOf(body);
    signals.push(init.signal as AbortSignal);
    conversations.push(structuredClone(conversation));
    requests.push(structuredClone(body));
    inflight++; activity++;
    try {
      if (autoStop && conversation.tools?.some(t => t.name === "note") && conversation.messages.some(m => m.role === "toolResult" && (m as { toolName?: string }).toolName === "note")) return responseOf(reply("Done."));
      if (autoStop && conversation.messages.some(m => m.role === "toolResult" && (m as { toolName?: string }).toolName === "memory" && ((m as { content: { text: string }[] }).content[0]!.text.includes('"committed"')))) return responseOf(reply("Done."));
      // A held reply is a request in flight: cancelling the child must end it, as a real one would.
      const signal = init.signal as AbortSignal | undefined;
      const scripted = provider(conversation, signal as AbortSignal);
      if (!signal || ignoreAbort) return responseOf(await scripted);
      const cancelled = new Promise<never>((_resolve, reject) => signal.addEventListener("abort",
        () => reject(Object.assign(new Error("The operation was aborted"), { name: "AbortError" })), { once: true }));
      cancelled.catch(() => {}); // a late abort after the reply arrived is nobody's failure
      return responseOf(await Promise.race([scripted, cancelled]));
    } finally { inflight--; activity++; }
  }));
  const pi = { on: (name: string, fn: any) => hooks.set(name, fn), registerTool: (tool: any) => tools.set(tool.name, tool),
    registerCommand: (name: string, command: any) => commands.set(name, command),
    appendEntry: (customType: string, data: unknown) => {
      if (native()) { native()!.appendCustomEntry(customType, structuredClone(data)); return; }
      const entry = { id: `e${allEntries.length}`, parentId: entries.at(-1)?.id ?? null, timestamp: new Date().toISOString(), type: "custom", customType, data: structuredClone(data) }; entries.push(entry); allEntries.push(entry); },
  } as unknown as ExtensionAPI;
  const previous = process.env.TRACE_MEMORY_CONFIG;
  const { retry: _retry, ...extensionConfig } = config as { retry?: unknown } & Record<string, unknown>;
  process.env.TRACE_MEMORY_CONFIG = JSON.stringify({ dbPath, ...extensionConfig });
  const originalCwd = process.cwd();
  try { process.chdir(dir); (options.extension ?? extension)(pi); } finally { process.chdir(originalCwd); if (previous === undefined) delete process.env.TRACE_MEMORY_CONFIG; else process.env.TRACE_MEMORY_CONFIG = previous; }
  // The observer reads what the extension wrote, so it registers the same result-text extractor (23).
  const memory = TraceMemory(dbPath, async () => { throw new Error("observer cannot call a model"); }, {}, piResultText);
  const persist = (message: unknown, id = `e${allEntries.length}`) => {
    const entry = { id, parentId: entries.at(-1)?.id ?? null, timestamp: new Date().toISOString(), type: "message", message: structuredClone(message) };
    if (native()) return entry; // the real Pi session already persisted this message
    entries.push(entry); allEntries.push(entry); return entry;
  };
  /** 20c: a successfully persisted native compaction entry on the selected ancestry — the only thing
   * that establishes the post-compaction boundary, and the entry Pi appends only after a compaction
   * succeeded. `sibling` writes it outside the selected ancestry, where it must establish nothing. */
  const compaction = (summary = "native summary", options: { sibling?: boolean } = {}) => {
    const entry = { id: `e${allEntries.length}`, parentId: entries.at(-1)?.id ?? null, timestamp: new Date().toISOString(),
      type: "compaction", summary, firstKeptEntryId: entries.at(-1)?.id ?? "", tokensBefore: 0 };
    if (!options.sibling) entries.push(entry);
    allEntries.push(entry); return entry;
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
    if (name === "session_shutdown") shuttingDown = true;
    const result = await hooks.get(name)?.({ type: name, ...event }, ctx);
    if (name === "message_end") persist(event.message);
    return result;
  };
  // A worker is a real child AgentSession now, so waiting is wall-clock, not a fixed number of
  // microtasks: keep ticking while the footer says a phase is running (Pi theme accent = noting,
  // success = consolidation, both set synchronously when the phase is admitted and cleared when it
  // settles), and return immediately when a scripted reply is being held open by the test.
  // After shutdown the footer is frozen (showSpend returns early once the executor is closed), so the
  // indicator says nothing about work in flight.
  const busy = () => !shuttingDown && /<(accent|success)>●</.test(statuses.get("trace-memory") ?? "");
  // `setImmediate`, not `setTimeout`: two 17c cases install fake timers, and the check phase still
  // lets Pi's own timers, file I/O and the stubbed wire run. Wall-clock comes from `performance`,
  // which those cases do not fake.
  const drain = async () => {
    const started = performance.now();
    let idleSince = started, seen = activity;
    while (performance.now() - started < 5_000) {
      await new Promise(r => setImmediate(r));
      if (busy() || activity !== seen) { seen = activity; idleSince = performance.now(); }
      else if (performance.now() - idleSince > 10) return;
      // A scripted reply held open by the test keeps its phase busy forever; give any sibling phase
      // time to reach the wire too, then hand control back.
      if (inflight > 0 && performance.now() - started >= 150) return;
    }
  };
  const prompt = async (prompt = "用 pnpm，不要 npm") => {
    const result = await emit("before_agent_start", { prompt, systemPrompt: "host" });
    await emit("message_start", { message: { role: "user", content: prompt, timestamp: 1 } });
    await emit("message_end", { message: { role: "user", content: prompt, timestamp: 1 } });
    return result;
  };
  const answer = async (value = "好的。") => { await emit("message_end", { message: reply(value) }); await emit("agent_end"); };
  const turn = async () => { await prompt(); await answer(); await emit("agent_settled"); await drain(); };
  const dispose = async () => { await emit("session_shutdown", { reason: "quit" }); memory.close();
    if (stubbed) uninstall(origin); rmSync(dir, { recursive: true, force: true }); };
  return { setHeaderTimestamp: (value: unknown) => { headerTimestamp = value; }, dialogs, answers, dispose, dir, dbPath, signals, ctx, entries, allEntries, persist, compaction, hooks, tools, commands, notices, statuses, memory, emit, prompt, answer, turn, drain, requests, conversations,
    provider: (fn: typeof provider, options: { autoStop?: boolean; ignoreAbort?: boolean } = {}) => { provider = fn; autoStop = options.autoStop ?? true; ignoreAbort = options.ignoreAbort ?? false; } };
}
export function notingFact(conversation: Conversation) {
  const input = String(conversation.messages[0]!.content);
  const address = /S(\d+)\/T(\d+)/.exec(input)!;
  const source = /\[(T\d+#user)\]:/.exec(input)?.[1] ?? `T${address[2]}#user`;
  if (conversation.messages.some((m) => m.role === "toolResult" && m.toolName === "note")) return reply("Done.");
  return { ...reply(""), stopReason: "toolUse" as const, content: [{ type: "toolCall" as const, id: "note-1", name: "note", arguments: { facts: [
    { category: "observation", actor: "user", text: "用 pnpm，不要 npm", source: [source] },
  ] } }] };
}

export const consolidationBatch = { operations: [], skipped: [{ fact: "F1", because: "Not durable." }] };
export const consolidationReply = (): Reply => ({ ...reply(""), stopReason: "toolUse", content: [{ type: "toolCall", id: "memory-1", name: "memory", arguments: consolidationBatch }] });
