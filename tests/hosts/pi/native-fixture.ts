// The native-runner test seam, shared by native.test.ts (19a/19b), readiness.test.ts and
// cache-miss.test.ts (19c). It exercises the real installed SDK: a real Pi SessionManager and
// AgentSession for the parent, a real native child fork, the real pi-ai adapters and a real temporary
// SQLite database. Only HTTP is stubbed, so every request below is one the adapter really serialized.
import { join } from "node:path";
import { expect, vi } from "vitest";
import { createAgentSession, DefaultResourceLoader, ModelRuntime, SessionManager, SettingsManager } from "@earendil-works/pi-coding-agent";
import { host } from "./test-host.ts";
import { toolDefinitions } from "../../../src/core/api/index.ts";
import type { NativeForkTask, ThinkingLevel } from "../../../src/hosts/pi/native.ts";

export type Body = Record<string, any>;
export const sse = (events: unknown[]) => new Response(events.map(e => `data: ${JSON.stringify(e)}\n\n`).join("") + "data: [DONE]\n\n",
  { headers: { "content-type": "text/event-stream" } });
export const usage = (input = 10, output = 2, cached = 0) => ({ prompt_tokens: input, completion_tokens: output, total_tokens: input + output, prompt_tokens_details: { cached_tokens: cached } });
export const say = (text: string, tokens = usage()) => sse([
  { id: "c", object: "chat.completion.chunk", created: 1, model: "test", choices: [{ index: 0, delta: { role: "assistant", content: text }, finish_reason: "stop" }], usage: tokens }]);
export const call = (id: string, name: string, args: unknown, tokens = usage()) => sse([
  { id: "c", object: "chat.completion.chunk", created: 1, model: "test", choices: [{ index: 0, delta: { role: "assistant", tool_calls: [{ index: 0, id, type: "function", function: { name, arguments: JSON.stringify(args) } }] }, finish_reason: "tool_calls" }], usage: tokens }]);
export const broken = () => new Response(JSON.stringify({ error: { message: "provider exploded" } }), { status: 500, headers: { "content-type": "application/json" } });

/** Tell the child's requests from the parent's by the production prompt they carry. */
export const worker = (body: Body, phase = "Noting") => JSON.stringify(body).includes(`${phase} (${phase === "Noting" ? "fact" : "knowledge"} extraction)`);
export const toolResults = (body: Body) => (body.messages ?? []).filter((m: Body) => m.role === "tool").length;
/** 26a: whether this body already carries the child's own `note` submission, so a scripted Noter
 * answers with its closing reply instead of submitting twice. Unlike `toolResults`, an inherited
 * tool call of the parent conversation is not mistaken for the worker's own. */
export const submitted = (body: Body) => (body.messages ?? []).some((m: Body) =>
  (m.tool_calls ?? []).some((c: Body) => c.function?.name === "note"));

export const noteBatch = { facts: [{ category: "observation", actor: "user", text: "用 pnpm，不要 npm", source: ["T1#user"] }] };
export const memoryBatch = { operations: [], skipped: [{ fact: "F1", because: "Not durable." }] };

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
  const h = host({ "noting.triggerTokens": 20, ...config }, { native: () => manager as never, fetch: false, inflight: () => inflight });
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
  // The parent registers its own foreground tool plus the four memory tools, as the real
  // foreground does: the child must reproduce all five definitions but may execute only the memory ones.
  const tools = [{ name: "read", description: "Read a file", parameters: { type: "object", properties: { path: { type: "string" } }, required: ["path"] } },
    ...toolDefinitions].map(definition => ({ ...definition, label: definition.name,
    async execute() { return { content: [{ type: "text", text: "ok" }], details: {} }; } }));
  const { session } = await createAgentSession({ cwd: h.dir, agentDir, model, modelRuntime, settingsManager, resourceLoader,
    sessionManager: manager, thinkingLevel: parent.thinkingLevel, noTools: "all", tools: tools.map(t => t.name), customTools: tools as never });
  // 27a: the fork base the host freezes at admission is Pi's own measure, so the fixture reports the
  // REAL parent session's getter — the usage of its latest valid reply (whatever the scripted wire
  // reported for it) plus Pi's estimate of the messages after it.
  (h.ctx as unknown as { getContextUsage: () => unknown }).getContextUsage = () => session.getContextUsage();
  const original = { id: manager.getSessionId(), file: manager.getSessionFile()! };
  return { h, parent: session, model, agentDir, sessionsRoot, sessionsDir, runsDir, sent, original,
    manager: () => manager!,
    script: (fn: (body: Body, index: number) => Response | Promise<Response>) => { respond = fn; },
    /** One real parent turn, then the extension hooks the foreground would have fired. `capture`
     * off omits `before_provider_request`, the hook that supplies the fork's parent body. */
    async turn(prompt = "用 pnpm，不要 npm", options: { capture?: boolean } = {}) {
      await this.h.emit("before_agent_start", { prompt });
      const at = sent.length;
      await session.prompt(prompt);
      const captured = sent[at]!;
      if (options.capture !== false) await this.h.emit("before_provider_request", { payload: captured });
      await this.h.emit("agent_settled");
      await this.h.drain();
      return captured;
    },
    /** The same child the host builds, for the checks that need it without the host's scheduling. */
    task(captured: Body, overrides: Partial<NativeForkTask> = {}): NativeForkTask {
      return { mode: "fork", parentFile: manager!.getSessionFile()!, parentSessionId: manager!.getSessionId(),
        checkpoint: manager!.getLeafId()!, runsDir, cwd: h.dir, agentDir,
        model: model as never, captured, task: "Range: S1/T1..S1/T1\n\nnote what happened", tools: [], maxToolRounds: 0,
        onRequest: () => {}, onProgress: () => {}, ...overrides };
    },
    async dispose() { session.dispose(); await h.dispose(); vi.unstubAllGlobals(); },
  };
}
export const settled = async (f: Awaited<ReturnType<typeof fixture>>, kind: "noting" | "consolidation" = "noting") =>
  await vi.waitFor(() => { const run = f.h.memory.store.listRuns(1).find(r => r.kind === kind); expect(run?.response).toBeTruthy(); return run!; }, { timeout: 5000 });
