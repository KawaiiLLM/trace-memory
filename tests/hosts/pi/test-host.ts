import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { buildContextEntries, createEventBus, type ExtensionAPI, type ExtensionContext, type SessionEntry } from "@earendil-works/pi-coding-agent";
import extension, { piResultText } from "../../../src/hosts/pi/index.ts";
import type { ThinkingLevel } from "../../../src/hosts/pi/native.ts";
import { TraceMemory, toolRejected } from "../../../src/core/api/index.ts";

type Conversation = Parameters<ExtensionContext["modelRegistry"]["complete"]>[1];
export type Reply = Awaited<ReturnType<ExtensionContext["modelRegistry"]["complete"]>>;
export const usage = { input: 1, output: 2, cacheRead: 0, cacheWrite: 0, reasoning: 0, totalTokens: 3, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } };
export const reply = (output: string): Reply => ({ role: "assistant", content: [{ type: "text", text: output }], api: "openai-completions", provider: "fake", model: "test", stopReason: "stop", timestamp: 1, usage });
/** 19a: a real Pi SessionManager backing the fake context, so native fork work has a real file. */
export type NativeSource = () => { getSessionId(): string; getSessionFile(): string | undefined; getLeafId(): string | null;
  getBranch(): unknown[]; getEntries(): unknown[]; getEntry(id: string): unknown; buildContextEntries(): unknown[];
  appendCustomEntry(customType: string, data?: unknown): string } | undefined;
/** The scripted-reply seam (19c cutover). The request-copy runner is gone: every task this fake host
 * admits runs in a real Pi child `AgentSession` built by `hosts/pi/native.ts`, so the only place a
 * test can script a reply is the wire. `provider(fn)` keeps its old signature — it is handed the
 * conversation reconstructed from the body the real pi-ai adapter serialized, and its `Reply` is
 * returned as `openai-completions` SSE, exactly as `native-fixture.ts` does for the fork tests.
 * `requests` holds the real outgoing bodies; `conversations` their reconstruction. */
type Message = Conversation["messages"][number];
const partsText = (content: unknown): string => typeof content === "string" ? content
  : Array.isArray(content) ? content.filter((c: any) => c?.type === "text" || typeof c?.text === "string").map((c: any) => c.text ?? "").join("") : "";
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
        isError: toolRejected(name, text), timestamp: 1 } as unknown as Message);
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
 * host answers only its own provider base URL. An unknown URL reaches an upstream stub a fixture
 * deliberately installed before this one — and otherwise fails closed, because the alternative is a
 * test suite that quietly talks to the internet. */
const wires = new Map<string, (init: RequestInit) => Promise<Response>>();
const network = globalThis.fetch; // the process's real fetch, captured before any fixture stubs it
let replaced: typeof globalThis.fetch | undefined;
let wireCount = 0;
function install(origin: string, wire: (init: RequestInit) => Promise<Response>) {
  wires.set(origin, wire);
  if (replaced) return;
  replaced = globalThis.fetch;
  globalThis.fetch = (async (url: unknown, init: RequestInit) => {
    const wired = wires.get(new URL(String(url)).origin);
    if (wired) return wired(init);
    if (replaced === network) throw new Error(`test host: refusing to reach ${new URL(String(url)).origin}; no stub answers it`);
    return replaced!(url as never, init as never);
  }) as typeof globalThis.fetch;
}
function uninstall(origin: string) {
  wires.delete(origin);
  if (wires.size || !replaced) return;
  globalThis.fetch = replaced;
  replaced = undefined;
}

/** The models `models.json` declares, and which of them Pi treats as reasoning-capable. */
const MODELS = ["test", "test-mini", "test-thinking"];
const reasoning = (id: string) => id === "test-thinking";

/** `PI_CODING_AGENT_DIR` is process-wide and several cases run two hosts at once, so the fixture
 * borrows it rather than owning it: the first live host remembers what was there, each host points
 * it at its own agent directory, and the last one to be disposed puts the original value back —
 * including a value that was absent, and including a host whose shutdown threw. */
const agentDirs: string[] = [];
let borrowedAgentDir: string | undefined;
function claimAgentDir(agentDir: string) {
  if (!agentDirs.length) borrowedAgentDir = process.env.PI_CODING_AGENT_DIR;
  agentDirs.push(agentDir);
  process.env.PI_CODING_AGENT_DIR = agentDir;
}
function releaseAgentDir(agentDir: string) {
  const at = agentDirs.lastIndexOf(agentDir);
  if (at < 0) return;
  agentDirs.splice(at, 1);
  const still = agentDirs.at(-1);
  if (still !== undefined) { process.env.PI_CODING_AGENT_DIR = still; return; }
  if (borrowedAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
  else process.env.PI_CODING_AGENT_DIR = borrowedAgentDir;
  borrowedAgentDir = undefined;
}

/** 26a: the default worker reply of a Noting run. A batch is completed only by a `note` call, so a
 * worker with nothing to record submits the explicit empty batch instead of stopping on prose (which
 * is now incomplete). Every other conversation, Consolidation included, keeps the old text reply. */
export const emptyNoteReply = (): Reply => ({ ...reply(""), stopReason: "toolUse",
  content: [{ type: "toolCall", id: "note-empty", name: "note", arguments: { facts: [] } }] });
const latestNoteResult = (conversation: Conversation) => conversation.messages
  .filter(m => m.role === "toolResult" && (m as { toolName?: string }).toolName === "note").at(-1) as Message | undefined;
const parsedNoteResult = (conversation: Conversation): Record<string, unknown> | undefined => {
  const result = latestNoteResult(conversation);
  if (!result) return undefined;
  try { const value = JSON.parse(partsText((result as { content: unknown }).content));
    return value && typeof value === "object" && !Array.isArray(value) ? value : undefined;
  } catch { return undefined; }
};
/** A NEAR review receipt is a successful tool result but not a business commit. */
export const noteCommitted = (conversation: Conversation): boolean => Array.isArray(parsedNoteResult(conversation)?.factIds);
export const emptyNote = (conversation: Conversation): Reply | undefined =>
  conversation.systemPrompt?.startsWith("# Noting") && !latestNoteResult(conversation) ? emptyNoteReply() : undefined;

export function host(config: Record<string, unknown> = {}, options: { native?: NativeSource; fetch?: boolean; extension?: typeof extension; inflight?: () => number } = {}) {
  const dir = mkdtempSync(join(tmpdir(), "trace-memory-host-"));
  const origin = `https://fake-${wireCount++}.invalid`;
  // Pi settings the child reads through its own SettingsManager (19c gate 6): a fast, deterministic
  // retry policy instead of the user's ~/.pi/agent.
  const agentDir = join(dir, "agent"); mkdirSync(agentDir, { recursive: true });
  // `defaultThinkingLevel` and `modelThinkingLevels` are Pi's own settings, not this extension's
  // configuration: 26b's cases put a global default and a per-model preference here to prove that
  // neither of them decides a worker's level.
  // 27b: `compaction` is Pi's own setting too. A case that wants the user's file to ask for automatic
  // compaction — the state the memory child overrides in memory — states it here.
  writeFileSync(join(agentDir, "settings.json"), JSON.stringify({ retry: { enabled: true, maxRetries: 1, baseDelayMs: 5, ...(config.retry as object ?? {}) },
    ...(config.compaction ? { compaction: config.compaction } : {}),
    ...(config.defaultThinkingLevel ? { defaultThinkingLevel: config.defaultThinkingLevel } : {}),
    ...(config.modelThinkingLevels ? { modelThinkingLevels: config.modelThinkingLevels } : {}) }));
  // Models the native child resolves through Pi's own ModelRuntime; the stubbed fetch answers them.
  // `test-thinking` is the one reasoning-capable model: Pi clamps every level to `off` on a model
  // that declares `reasoning: false`, so a case that needs a level to survive runs on this one.
  // 27a: the window the fake models declare, to both this fixture's `ctx.model` and the real child the
  // adapter builds through Pi's own ModelRuntime. A case that needs another window states it once here
  // (`contextWindow`), like `retry` and the thinking levels below: it is Pi's model metadata, not this
  // extension's configuration, and is stripped from TRACE_MEMORY_CONFIG with them.
  const contextWindow = Number(config.contextWindow ?? 200_000);
  writeFileSync(join(agentDir, "models.json"), JSON.stringify({ providers: Object.fromEntries((["openai-completions", "anthropic-messages"] as const).map((api, i) => [
    i === 0 ? "fake" : "fakeanthropic", { name: "Fake", baseUrl: `${origin}/v1`, apiKey: "fake-key", api,
      models: MODELS.map(id => ({ id, name: `Test ${id}`, reasoning: reasoning(id), input: ["text", "image"], contextWindow, maxTokens: 8192, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } })) }])) }));
  claimAgentDir(agentDir);
  const native = () => options.native?.();
  const dbPath = String(config.dbPath ?? join(dir, "trace.db"));
  const hooks = new Map<string, (event: any, ctx: ExtensionContext) => any>();
  const tools = new Map<string, any>(), commands = new Map<string, any>(), entries: any[] = [], allEntries: any[] = [], notices: string[] = [];
  const requests: unknown[] = [], conversations: Conversation[] = [], signals: AbortSignal[] = [];
  let provider = async (conversation: Conversation, _signal?: AbortSignal) => emptyNote(conversation) ?? reply("[]");
  let autoStop = true; // the fake model stops by itself after a write unless a test drives the rounds
  let ignoreAbort = false; // a wedged connection that a cancelled child cannot end
  const model = { provider: "fake", id: "test", api: "openai-completions", name: "Test", baseUrl: `${origin}/v1`,
    reasoning: false, input: ["text", "image"], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow, maxTokens: 8192 };
  // 27a: Pi's own measure of this session's context, which the host reads once at admission as a
  // fork's inherited prefix. The default is a session that has sent nothing yet; a case sets its own,
  // including `{tokens: null}` for the unknown measure right after a compaction and `undefined` for a
  // context with no model. `native-fixture.ts` replaces it with the real parent session's getter.
  let contextUsage: { tokens: number | null; contextWindow: number; percent: number | null } | undefined = { tokens: 0, contextWindow, percent: 0 };
  const dialogs: { title: string; options?: string[] }[] = [];
  const answers: (string | boolean | undefined)[] = [];
  let headerTimestamp: unknown = "2099-01-01T00:00:00.000Z";
  let thinkingLevel: ThinkingLevel = "off";
  const statuses = new Map<string, string | undefined>();
  // A notice is host activity: it keeps `drain` waiting through a short retry backoff. 51: the footer
  // no longer paints a retry wait, so the host reads it from the retry notice itself and treats the
  // next status refresh (the worker refreshes at retry end, commit and result) as its end.
  let backingOff = false;
  const ctx = { cwd: dir, model, hasUI: false, getContextUsage: () => contextUsage, getSystemPrompt: () => "", getSystemPromptOptions: () => ({ skills: [] }), ui: { notify: (s: string) => { activity++; notices.push(s); if (/ retry \d+\/\d+ in /.test(s)) backingOff = true; }, setStatus: (key: string, text: string | undefined) => { statuses.set(key, text); backingOff = false; },
      select: async (title: string, options: string[]) => { dialogs.push({ title, options }); return answers.shift(); },
      confirm: async (title: string, message: string) => { dialogs.push({ title: `${title} ${message}` }); return answers.shift() ?? false; },
      input: async (title: string) => { dialogs.push({ title }); return answers.shift(); },
      theme: { fg: (color: string, text: string) => `<${color}>${text}</${color}>` } },
    sessionManager: { getHeader: () => ({ timestamp: headerTimestamp }), getSessionId: () => native()?.getSessionId() ?? "pi-test",
      getSessionFile: () => native()?.getSessionFile(),
      getLeafId: () => native() ? native()!.getLeafId() : entries.at(-1)?.id ?? null,
      getBranch: () => native()?.getBranch() ?? entries, getEntries: () => native()?.getEntries() ?? allEntries,
      getEntry: (id: string) => native() ? native()!.getEntry(id) : allEntries.find(e => e.id === id),
      // 26c0: the carriers are read off Pi's own compaction-aware view, so the fake host answers it
      // with Pi's own exported function (`session-manager.ts:418-453`: the selected ancestry, or
      // `[latestCompaction, ...entries from firstKeptEntryId, ...entries after]`) over the entries
      // and leaf it holds — never a second implementation of that rule.
      buildContextEntries: () => native()?.buildContextEntries()
        ?? buildContextEntries(allEntries as SessionEntry[], entries.at(-1)?.id ?? null) },
    modelRegistry: { getApiKeyAndHeaders: async () => ({ ok: true, apiKey: "fake-key", headers: { "x-test": "header" }, env: {}, baseUrl: "https://fake.invalid" }),
      find: (p: string, id: string) => p === "fake" ? { ...model, id, reasoning: reasoning(id) } : undefined,
      // 24b: the models a settings edit may choose from. Pi's registry answers `getAvailable` with
      // the auth-resolved snapshot; the fake offers the two ordinary ones (`test-thinking` exists in
      // models.json for the cases that need reasoning support, and is resolved by `find`).
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
      if (autoStop && conversation.tools?.some(t => t.name === "note") && noteCommitted(conversation)) return responseOf(reply("Done."));
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
  const eventBus = createEventBus();
  const pi = { on: (name: string, fn: any) => hooks.set(name, fn), registerTool: (tool: any) => tools.set(tool.name, tool),
    events: eventBus,
    getActiveTools: () => [...tools.keys()], getAllTools: () => [...tools.values()],
    registerCommand: (name: string, command: any) => commands.set(name, command),
    // 26b: the foreground thinking level, as Pi's own extension API exposes it. The default is the
    // level a real Pi foreground would hold on these models: they declare `reasoning: false`, so Pi
    // clamps every level to `off`. A case that wants another foreground level sets it.
    getThinkingLevel: () => thinkingLevel,
    setThinkingLevel: (level: ThinkingLevel) => { thinkingLevel = level; },
    appendEntry: (customType: string, data: unknown) => {
      if (native()) { native()!.appendCustomEntry(customType, structuredClone(data)); return; }
      const entry = { id: `e${allEntries.length}`, parentId: entries.at(-1)?.id ?? null, timestamp: new Date().toISOString(), type: "custom", customType, data: structuredClone(data) }; entries.push(entry); allEntries.push(entry); },
  } as unknown as ExtensionAPI;
  const previous = process.env.TRACE_MEMORY_CONFIG;
  const { retry: _retry, compaction: _compaction, defaultThinkingLevel: _level, modelThinkingLevels: _levels, contextWindow: _window, ...extensionConfig } = config as Record<string, unknown>;
  process.env.TRACE_MEMORY_CONFIG = JSON.stringify({ dbPath, ...extensionConfig });
  const originalCwd = process.cwd();
  try { process.chdir(dir); (options.extension ?? extension)(pi); } finally { process.chdir(originalCwd); if (previous === undefined) delete process.env.TRACE_MEMORY_CONFIG; else process.env.TRACE_MEMORY_CONFIG = previous; }
  // The observer reads what the extension wrote, so it registers the same result-text extractor (23).
  const memory = TraceMemory(dbPath, async () => { throw new Error("observer cannot call a model"); }, {}, piResultText);
  const persist = (message: any, id = `e${allEntries.length}`) => {
    // 26c0: Pi persists a `role: "custom"` message — the shape a `before_agent_start` handler's
    // returned message is given (`agent-session.ts:1286-1293`) — as a `custom_message` entry through
    // `appendCustomMessageEntry(customType, content, display, details)` (`agent-session.ts:674-684`,
    // `session-manager.ts:1172-1192`), so its `details` are a real on-disk field. Every other role
    // becomes an ordinary message entry.
    const entry = message?.role === "custom"
      ? { id, parentId: entries.at(-1)?.id ?? null, timestamp: new Date().toISOString(), type: "custom_message",
          customType: message.customType, content: message.content ?? [], display: message.display, details: structuredClone(message.details) }
      : { id, parentId: entries.at(-1)?.id ?? null, timestamp: new Date().toISOString(), type: "message", message: structuredClone(message) };
    if (native()) return entry; // the real Pi session already persisted this message
    entries.push(entry); allEntries.push(entry); return entry;
  };
  // 26c0: what the last `session_before_compact` handler asked Pi to write. Pi passes a hook result's
  // `compaction.details` straight into `appendCompaction(summary, firstKeptEntryId, tokensBefore,
  // details, fromExtension, usage)` (`agent-session.ts:2025`, automatic path `:2350`) with
  // `fromExtension = true`, and the entry keeps both (`session-manager.ts:1098-1120`). One hook
  // result belongs to one appended entry, so `compaction()` consumes it.
  let hookCompaction: { details?: unknown } | undefined;
  /** 20c: a successfully persisted native compaction entry on the selected ancestry — the only thing
   * that establishes the post-compaction boundary, and the entry Pi appends only after a compaction
   * succeeded. `sibling` writes it outside the selected ancestry, where it must establish nothing. */
  const compaction = (summary = "native summary", options: { sibling?: boolean; details?: unknown } = {}) => {
    const hook = hookCompaction; hookCompaction = undefined;
    // 29c: `details` states the persisted payload directly, for a row that wants one exact carrier —
    // a tier-2 supply, ids with no supplied entry at all, a partial one — without driving a real
    // budget to produce it. A real hook result still arrives through `hookCompaction` above.
    const carried = options.details !== undefined ? { details: options.details } : hook ? { details: structuredClone(hook.details), fromHook: true } : {};
    const entry = { id: `e${allEntries.length}`, parentId: entries.at(-1)?.id ?? null, timestamp: new Date().toISOString(),
      type: "compaction", summary, firstKeptEntryId: entries.at(-1)?.id ?? "", tokensBefore: 0, ...carried };
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
    if (name === "session_before_compact") hookCompaction = result?.compaction;
    return result;
  };
  // A worker is a real child AgentSession now, so waiting is wall-clock, not a fixed number of
  // microtasks: keep ticking while the footer says a phase is running (Pi theme accent = noting,
  // success = consolidation, both set synchronously when the phase is admitted and cleared when it
  // settles), and return immediately when a scripted reply is being held open by the test.
  // After shutdown the footer is frozen (showSpend returns early once the executor is closed), so the
  // indicator says nothing about work in flight.
  //
  // This is the wait for "whatever this host still has to do", and it still reads the indicator
  // because nothing else in reach says the same thing: the open task claim, the obvious candidate,
  // outlives a cancelled child and is released before a scheduled retry ends. A test that knows its
  // own completion condition — a request sent, a fact committed, a run recorded — states it with
  // `vi.waitFor` on that condition instead, as the native cases already do.
  const busy = () => !shuttingDown && !backingOff && /<(accent|success|customMessageLabel)>●</.test(statuses.get("trace-memory") ?? "");
  // `setImmediate`, not `setTimeout`: two 17c cases install fake timers, and the check phase still
  // lets Pi's own timers, file I/O and the stubbed wire run. Wall-clock comes from `performance`,
  // which those cases do not fake.
  const BUDGET = 5_000;
  /** Wait out this host's in-flight work. Exhausting the budget is a failure, not a quiet return: a
   * wait that gave up must say so instead of letting the case continue as if the work had settled. */
  const drain = async () => {
    const started = performance.now();
    let idleSince = started, seen = activity;
    while (performance.now() - started < BUDGET) {
      await new Promise(r => setImmediate(r));
      if (busy() || activity !== seen) { seen = activity; idleSince = performance.now(); }
      else if (performance.now() - idleSince > 10) return;
      // A scripted reply held open by the test keeps its phase busy forever; give any sibling phase
      // time to reach the wire too, then hand control back.
      if (inflight + (options.inflight?.() ?? 0) > 0 && performance.now() - started >= 150) return;
    }
    throw new Error(`test host: work was still in flight after ${BUDGET}ms of draining`);
  };
  const prompt = async (prompt = "用 pnpm，不要 npm") => {
    const result = await emit("before_agent_start", { prompt, systemPrompt: "host" });
    await emit("message_start", { message: { role: "user", content: prompt, timestamp: 1 } });
    await emit("message_end", { message: { role: "user", content: prompt, timestamp: 1 } });
    // 26c0: Pi builds the turn's messages as the user message followed by every message a
    // `before_agent_start` handler returned, each as `role: "custom"` (`agent-session.ts:1286-1293`),
    // and each is persisted at its own `message_end` (`:674-684`). That is where the receipt lands.
    if (result?.message) await emit("message_end", { message: { role: "custom", ...result.message, content: result.message.content ?? [], timestamp: 1 } });
    return result;
  };
  const answer = async (value = "好的。") => { await emit("message_end", { message: reply(value) }); await emit("agent_end"); };
  const turn = async () => { await prompt(); await answer(); await emit("agent_settled"); await drain(); };
  // Cleanup this fixture owns runs whether or not the shutdown hook succeeded: a host that failed to
  // shut down must still give the process-wide agent directory back.
  const dispose = async () => {
    try { await emit("session_shutdown", { reason: "quit" }); memory.close(); if (stubbed) uninstall(origin); }
    finally { releaseAgentDir(agentDir); rmSync(dir, { recursive: true, force: true }); }
  };
  return { setHeaderTimestamp: (value: unknown) => { headerTimestamp = value; },
    /** 27a: the context measure `ctx.getContextUsage()` reports, switchable per case. */
    setContextUsage: (value: { tokens: number | null; contextWindow: number; percent: number | null } | undefined) => { contextUsage = value; },
    /** The foreground level this host reports to the extension, switchable mid-run by a case. */
    setThinkingLevel: (level: ThinkingLevel) => { thinkingLevel = level; }, getThinkingLevel: () => thinkingLevel, dialogs, answers, dispose, dir, dbPath, signals, ctx, eventBus, entries, allEntries, persist, compaction, hooks, tools, commands, notices, statuses, memory, emit, prompt, answer, turn, drain, requests, conversations,
    provider: (fn: typeof provider, options: { autoStop?: boolean; ignoreAbort?: boolean } = {}) => { provider = fn; autoStop = options.autoStop ?? true; ignoreAbort = options.ignoreAbort ?? false; } };
}
export function notingFact(conversation: Conversation) {
  const input = String(conversation.messages[0]!.content);
  const address = /S(\d+)\/T(\d+)/.exec(input)!;
  const source = /\[(T\d+#E\d+@text)\] (?:user|assistant):/.exec(input)?.[1] ?? `T${address[2]}#user`;
  const previous = latestNoteResult(conversation), review = parsedNoteResult(conversation)?.feedback;
  if (previous && (!review || typeof review !== "object")) return reply("Done.");
  return { ...reply(""), stopReason: "toolUse" as const, content: [{ type: "toolCall" as const,
    id: previous ? "note-2" : "note-1", name: "note", arguments: { facts: [
      { category: "observation", actor: "user", text: "用 pnpm，不要 npm", source: [source] },
    ] } }] };
}

export const consolidationBatch = { operations: [], skipped: [{ fact: "F1", because: "Not durable." }] };
export const consolidationReply = (conversation?: Conversation): Reply => {
  const range = conversation ? String(conversation.messages[0]!.content).split("Range facts:\n")[1]?.split("\nNegated-evidence")[0] ?? "" : "";
  const facts = [...new Set(range.match(/\bF[1-9]\d*\b/g) ?? [])];
  const batch = conversation ? { operations: [], skipped: facts.map(fact => ({ fact, because: "Not durable." })) } : consolidationBatch;
  return { ...reply(""), stopReason: "toolUse", content: [{ type: "toolCall", id: "memory-1", name: "memory", arguments: batch }] };
};
