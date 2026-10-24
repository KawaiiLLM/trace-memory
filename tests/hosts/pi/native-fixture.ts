// The native-runner test seam, shared by native.test.ts (19a/19b) and readiness.test.ts. It exercises
// the real installed SDK: a real Pi SessionManager and AgentSession for the parent, a real fresh
// native child, the real pi-ai adapters and a real temporary SQLite database. Only HTTP is stubbed,
// so every request below is one the adapter really serialized.
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, vi } from "vitest";
import { createAgentSession, DefaultResourceLoader, ModelRuntime, SessionManager, SettingsManager, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { host } from "./test-host.ts";
import { toolDefinitions, memoryFiles } from "../../../src/core/api/index.ts";
import { renderToolDefinitions } from "../../../src/core/api/tools.ts";
import { canonicalToolNames } from "../../../src/core/prompts/tool-names.ts";
import type { NativeTask, ThinkingLevel } from "../../../src/hosts/pi/native.ts";
import { memoryReadTool } from "../../../src/hosts/pi/memory-files.ts";
import { factsFile, withVerdicts } from "../../support/noter.ts";
import { clusteredItems, decisionText } from "../../support/dreamer.ts";

export type Body = Record<string, any>;
export const sse = (events: unknown[]) => new Response(events.map(e => `data: ${JSON.stringify(e)}\n\n`).join("") + "data: [DONE]\n\n",
  { headers: { "content-type": "text/event-stream" } });
export const usage = (input = 10, output = 2, cached = 0) => ({ prompt_tokens: input, completion_tokens: output, total_tokens: input + output, prompt_tokens_details: { cached_tokens: cached } });
export const say = (text: string, tokens = usage()) => sse([
  { id: "c", object: "chat.completion.chunk", created: 1, model: "test", choices: [{ index: 0, delta: { role: "assistant", content: text }, finish_reason: "stop" }], usage: tokens }]);
export const call = (id: string, name: string, args: unknown, tokens = usage()) => sse([
  { id: "c", object: "chat.completion.chunk", created: 1, model: "test", choices: [{ index: 0, delta: { role: "assistant", tool_calls: [{ index: 0, id, type: "function", function: { name, arguments: JSON.stringify(args) } }] }, finish_reason: "tool_calls" }], usage: tokens }]);
/** 127: one response carrying several calls of one tool, such as a Dreamer's operations and skips. */
export const calls = (id: string, name: string, args: readonly unknown[], tokens = usage()) => sse([
  { id: "c", object: "chat.completion.chunk", created: 1, model: "test", choices: [{ index: 0, delta: { role: "assistant", tool_calls: args.map((value, index) =>
    ({ index, id: `${id}-${index + 1}`, type: "function", function: { name, arguments: JSON.stringify(value) } })) }, finish_reason: "tool_calls" }], usage: tokens }]);
/** Four conversations; each checks first, writes only its deliverable and stops. */
export const noterTurn = (body: Body, fact: Record<string, unknown> = {}, tokens = usage(), knowledge = "## none\n"): Response => {
  const text = (message: Body) => typeof message.content === "string" ? message.content : (message.content ?? []).map((part: Body) => part.text ?? "").join("");
  const mentions = (body.messages ?? []).filter((m: Body) => m.role !== "assistant" && m.role !== "system").map(text).filter((value: string) => /^Task: (extract-facts|check-facts|write-knowledge|check-knowledge)/m.test(value));
  if (!mentions.length) return call("check-1", "check", {}, tokens);
  const [, task, file] = /^Task: ([\w-]+).*?File: (\S+?\.md)(?:\.|\s|$)/ms.exec(mentions.at(-1)!) ?? [];
  const written = (body.messages ?? []).flatMap((m: Body) => (m.tool_calls ?? []).filter((c: Body) => c.function?.name === "write").map((c: Body) => JSON.parse(c.function.arguments).path));
  if (!file || written.includes(file)) return say("Done.", tokens);
  const content = task!.startsWith("check-") ? withVerdicts(readFileSync(file, "utf8"))
    : task === "extract-facts" ? (Object.keys(fact).length ? factsFile([fact as never]) : "## none\n") : knowledge;
  return call(`write-${written.length + 1}`, "write", { path: file, content }, tokens);
};
/** Native wire replies fill the grouped Dreamer's pre-made files. */
export const dreamerTurn = (body: Body, tokens = usage(), changes = "## none\n"): Response => {
  const text = (message: Body) => typeof message.content === "string" ? message.content : (message.content ?? []).map((part: Body) => part.text ?? "").join("");
  const named = (body.messages ?? []).filter((m: Body) => m.role !== "assistant" && m.role !== "system").map(text).filter((value: string) => /Task: (notes|clustering|curate|scoring)/.test(value));
  if (!named.length) return call("check-1", "check", {}, tokens);
  const report = named.at(-1)!;
  const written = (body.messages ?? []).flatMap((m: Body) => (m.tool_calls ?? []).filter((c: Body) => c.function?.name === "write").map((c: Body) => JSON.parse(c.function.arguments).path));
  const stage = /Task: (notes|clustering|curate|scoring)/.exec(report)![1]!;
  const path = (label: string) => new RegExp(`${label}: (\\S+?\\.md)`).exec(report)![1]!;
  if (stage === "clustering") {
    const output = path("Output");
    if (written.includes(output)) return say("Done.", tokens);
    const items = readFileSync(path("Input"), "utf8").trim().split("\n").map(line => line.split(" ")[0]!);
    const size = Number(/Group size: at most (\d+)/.exec(report)?.[1] ?? 50);
    return call("groups", "write", { path: output, content: clusteredItems(items, size) }, tokens);
  }
  const files = stage === "notes" ? [{ path: path("File"), content: "No repository-specific notes." }]
    : stage === "curate" ? [{ path: path("Decisions"), content: decisionText(readFileSync(path("Decisions"), "utf8"), changes) }, { path: path("Changes"), content: changes }]
    : [{ path: path("Scores"), content: [...(report.match(/Items: ([^\n]*)/)?.[1] ?? "").matchAll(/K\d+(?:\.child\d+)?/g)].map(match => `${match[0]} 50`).join("\n") }];
  const writes = files.filter(file => !written.includes(file.path));
  if (!writes.length) return say("Done.", tokens);
  return writes.length === 1 ? call(`write-${written.length + 1}`, "write", writes[0], tokens) : calls(`write-${written.length + 1}`, "write", writes, tokens);
};
export const broken = () => new Response(JSON.stringify({ error: { message: "provider exploded" } }), { status: 500, headers: { "content-type": "application/json" } });

/** Tell the child's requests from the parent's by the production prompt they carry. */
export const worker = (body: Body, phase = "Noting") => JSON.stringify(body).includes(phase === "Noting" ? "Noting (facts and knowledge)" : `# ${phase}`);
export const toolResults = (body: Body) => (body.messages ?? []).filter((m: Body) => m.role === "tool").length;
/** 26a: whether this body already carries the child's own `note` submission, so a scripted Noter
 * answers with its closing reply instead of submitting twice. Unlike `toolResults`, an inherited
 * tool call of the parent conversation is not mistaken for the worker's own. */
export const submitted = (body: Body) => (body.messages ?? []).some((m: Body) =>
  (m.tool_calls ?? []).some((c: Body) => c.function?.name === "write"));

export const noteBatch = { title: "选择 pnpm", sources: "[T1#E1] 用 pnpm，不要 npm" };
export const memoryBatch = {};

/** A real Pi parent session that really runs extensions: `DefaultResourceLoader` accepts inline
 * `extensionFactories`, so `compact()` finds real handlers. Nothing here touches ~/.pi or
 * ~/.trace-memory. */
export async function piSession(options: { extensions: ((pi: ExtensionAPI) => void)[];
  compaction?: { enabled?: boolean; keepRecentTokens?: number; reserveTokens?: number }; contextWindow?: number;
  /** Foreground tools the session registers, for the trigger that fires between tool rounds (28b). */
  tools?: { name: string; description: string; parameters: unknown; execute: () => Promise<unknown> }[];
  /** Explicit SDK allowlist, including names registered by the real extension under test. */
  activeTools?: string[];
  /** Set while the extension factories run, so an extension that reads its configuration from the
   * environment (this host does) is built against this fixture's own database. */
  env?: Record<string, string>;
  /** Runs once the fixture's directories exist and before any extension is built — where a case
   * seeds a file an extension reads at construction. */
  prepare?: (dirs: { dir: string; agentDir: string }) => void;
  /** Extra top-level keys merged into the isolated global `settings.json`, such as `{ images: { autoResize: false } }`. */
  settings?: Record<string, unknown>;
  /** The load diagnostics a case expects Pi itself to report, such as two extensions' same-name tools. */
  extensionErrors?: unknown[] }) {
  const dir = mkdtempSync(join(tmpdir(), "trace-memory-baseline-"));
  const agentDir = join(dir, "agent"); mkdirSync(agentDir, { recursive: true });
  const origin = "https://fake-baseline.invalid";
  // `keepRecentTokens: 1` is what lets a tiny scripted session compact at all; `retry.enabled: false`
  // keeps a scripted failure one failure.
  options.prepare?.({ dir, agentDir });
  const compaction = { enabled: false, keepRecentTokens: 1, reserveTokens: 1, ...options.compaction };
  writeFileSync(join(agentDir, "settings.json"), JSON.stringify({ retry: { enabled: false }, compaction, ...options.settings }));
  const contextWindow = options.contextWindow ?? 200_000;
  writeFileSync(join(agentDir, "models.json"), JSON.stringify({ providers: { fake: { name: "Fake", baseUrl: `${origin}/v1`, apiKey: "fake-key",
    api: "openai-completions", models: [{ id: "test", name: "Test", reasoning: false, input: ["text"], contextWindow, maxTokens: 8192,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } }] } } }));
  const sent: Record<string, any>[] = [];
  // `signal` is the request's own: a case that holds a reply open needs it to end that reply when the
  // user aborts, exactly as a real provider call ends.
  let respond: (body: Record<string, any>, signal?: AbortSignal) => Response | Promise<Response> = () => say("Done.");
  vi.stubGlobal("fetch", vi.fn(async (_url: unknown, init: RequestInit) => {
    const body = JSON.parse(String(init.body)); sent.push(body); return respond(body, init.signal as AbortSignal | undefined);
  }));
  const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = agentDir;
  const previousEnv = Object.fromEntries(Object.keys(options.env ?? {}).map(key => [key, process.env[key]]));
  Object.assign(process.env, options.env ?? {});
  const modelRuntime = await ModelRuntime.create({ authPath: join(agentDir, "auth.json"), modelsPath: join(agentDir, "models.json") });
  const model = modelRuntime.getModel("fake", "test")!;
  const settingsManager = SettingsManager.create(dir, agentDir);
  const resourceLoader = new DefaultResourceLoader({ cwd: dir, agentDir, settingsManager, noExtensions: true, noSkills: true,
    noPromptTemplates: true, noThemes: true, noContextFiles: true, extensionFactories: options.extensions as never });
  await resourceLoader.reload();
  const manager = SessionManager.create(dir, join(agentDir, "sessions", "parent"));
  const tools = (options.tools ?? []).map(tool => ({ ...tool, label: tool.name }));
  const { session, extensionsResult } = await createAgentSession({ cwd: dir, agentDir, model, modelRuntime, settingsManager,
    resourceLoader, sessionManager: manager, noTools: "all", tools: options.activeTools ?? tools.map(t => t.name), customTools: tools as never });
  for (const [key, value] of Object.entries(previousEnv)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; }
  expect(extensionsResult.errors).toEqual(options.extensionErrors ?? []); // an inline factory that failed to load would silently drop the hooks
  return { dir, agentDir, session, manager, sent, model,
    script: (fn: (body: Record<string, any>, signal?: AbortSignal) => Response | Promise<Response>) => { respond = fn; },
    dispose() {
      session.dispose(); vi.unstubAllGlobals();
      if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR; else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
      rmSync(dir, { recursive: true, force: true });
    } };
}


/** `model`/`thinkingLevel`: the parent session's model and the level it is created at (26b). The
 * default model declares no reasoning support, so Pi clamps every level on it to `off`. */
export async function fixture(config: Record<string, unknown> = {}, provider = "fake", parent: { model?: string; thinkingLevel?: ThinkingLevel } = {}) {
  const sent: Body[] = [];
  let respond: (body: Body, index: number) => Response | Promise<Response> = () => say("Done.");
  // Requests this fixture is still answering. A case that holds a reply open holds one here, and
  // `host`'s `drain` needs to see it: a worker kept open on purpose is not a wait that failed.
  let inflight = 0;
  vi.stubGlobal("fetch", vi.fn(async (_url: unknown, init: RequestInit) => {
    const body = JSON.parse(String(init.body));
    sent.push(body);
    inflight++;
    try { return await respond(body, sent.length - 1); } finally { inflight--; }
  }));
  let manager: SessionManager | undefined;
  // `fetch: false`: this fixture stubs the wire itself (above), for both the real parent session and
  // the child the adapter builds.
  // The short scripted main turn reaches N's trigger when its entries are imported.
  // Production's 10k threshold is unchanged.
  const h = host({ "noting.triggerTokens": 1, ...config }, { native: () => manager as never, fetch: false, inflight: () => inflight });
  // 24c: the parent lives where real Pi puts a foreground session — one directory level under the
  // agent's own sessions root — so the worker logs the host writes are its siblings, exactly as they
  // are in production, and an external reader of that root sees the same tree a user would have.
  const agentDir = join(h.dir, "agent"), sessionsRoot = join(agentDir, "sessions"), sessionsDir = join(sessionsRoot, "parent");
  /** The 24c default worker-log directory for this fixture's agent root. */
  const runsDir = join(sessionsRoot, "trace-memory");
  const modelRuntime = await ModelRuntime.create({ authPath: join(agentDir, "auth.json"), modelsPath: join(agentDir, "models.json") });
  const model = modelRuntime.getModel(provider, parent.model ?? "test")!;
  (h.ctx as { model: unknown }).model = model;
  const settingsManager = SettingsManager.create(h.dir, agentDir);
  const resourceLoader = new DefaultResourceLoader({ cwd: h.dir, agentDir, settingsManager, noExtensions: true, noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true });
  await resourceLoader.reload();
  manager = SessionManager.create(h.dir, sessionsDir);
  // This fixture tests enrolled work, not installation-age defaults: native headers can precede
  // the temporary baseline on a replayed clock. Opt this native session in explicitly.
  await h.emit("session_start");
  await h.commands.get("trace")!.handler("on", h.ctx);
  // The parent registers its own foreground tool plus the four memory tools, as the real foreground does.
  const tools = [{ name: "read", description: "Read a file", parameters: { type: "object", properties: { path: { type: "string" } }, required: ["path"] } },
    ...renderToolDefinitions(toolDefinitions, canonicalToolNames)].map(definition => ({ ...definition, label: definition.name,
    async execute() { return { content: [{ type: "text", text: "ok" }], details: {} }; } }));
  const { session } = await createAgentSession({ cwd: h.dir, agentDir, model, modelRuntime, settingsManager, resourceLoader,
    sessionManager: manager, thinkingLevel: parent.thinkingLevel, noTools: "all", tools: tools.map(t => t.name), customTools: tools as never });
  const original = { id: manager.getSessionId(), file: manager.getSessionFile()! };
  return { h, parent: session, model, agentDir, sessionsRoot, sessionsDir, runsDir, sent, original,
    manager: () => manager!,
    script: (fn: (body: Body, index: number) => Response | Promise<Response>) => { respond = fn; },
    /** One real parent turn, then the extension hooks the foreground would have fired. */
    async turn(prompt = "用 pnpm，不要 npm", options: { settled?: boolean } = {}) {
      const started = await this.h.emit("before_agent_start", { prompt });
      // 26c0: the parent runs with `noExtensions`, so the write Pi would make for a handler's
      // returned message is made here, through Pi's own API. `agent-session.ts:1286-1293` turns the
      // returned message into a `role: "custom"` message and `:674-684` persists it with
      // `appendCustomMessageEntry(customType, content, display, details)`; `sendCustomMessage` is the
      // public door to the same two writes (`:1483-1526`) — session state and session file together,
      // which is what keeps the parent's request and the file the child forks from in step. Pi
      // appends it just after the user message of the turn; here it is just before, which puts it on
      // the same ancestry and inside the same `buildContextEntries()` result.
      if (started?.message) await session.sendCustomMessage(started.message);
      const at = sent.length;
      await session.prompt(prompt);
      const captured = sent[at]!;
      await this.h.emit("before_provider_request", { payload: captured });
      if (options.settled !== false) await this.h.emit("agent_settled");
      await this.h.drain();
      return captured;
    },
    /** The same child the host builds, for the checks that need it without the host's scheduling. */
    task(overrides: Partial<NativeTask> = {}): NativeTask {
      const path = h.memory.store.currentPath(1), session = h.memory.store.getSession(1)!;
      const reader = memoryFiles(h.memory, { sessionId: session.id, projectId: session.projectId,
        branch: path?.branch, headTurnId: path?.headTurnId });
      return { kind: "noting", runsDir, cwd: h.dir, agentDir, systemPrompt: "# Noting (facts and knowledge)",
        model: model as never, task: "Range: S1/T1..S1/T1\n\nnote what happened", tools: [],
        read: memoryReadTool(h.dir, address => reader.read(address), { memoryOnly: true }),
        maxToolRounds: 0,
        onRequest: () => {}, onProgress: () => {}, ...overrides };
    },
    async dispose() { session.dispose(); await h.dispose(); vi.unstubAllGlobals(); },
  };
}
/** Waits out a Noter batch: its first (write) run is recorded, and when that task passed, so is the second task's run. Returns the first. */
export const settled = async (f: Awaited<ReturnType<typeof fixture>>, kind: "noting" | "consolidation" = "noting") =>
  await vi.waitFor(() => {
    const runs = f.h.memory.store.listRuns(1).filter(r => r.kind === kind), first = runs[0];
    expect(first?.response).toBeTruthy();
    if (kind === "noting" && first!.outcome === "success") expect(runs.length).toBeGreaterThan(1);
    return first!;
  }, { timeout: 5000 });
