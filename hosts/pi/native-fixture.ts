// The native-runner test seam, shared by native.test.ts (19a/19b), readiness.test.ts and
// cache-miss.test.ts (19c). It exercises the real installed SDK: a real Pi SessionManager and
// AgentSession for the parent, a real native child fork, the real pi-ai adapters and a real temporary
// SQLite database. Only HTTP is stubbed, so every request below is one the adapter really serialized.
import { join } from "node:path";
import { expect, vi } from "vitest";
import { createAgentSession, DefaultResourceLoader, ModelRuntime, SessionManager, SettingsManager } from "@earendil-works/pi-coding-agent";
import { host } from "./test-host.ts";
import { toolDefinitions } from "../../core/api/index.ts";
import type { NativeForkTask } from "./native.ts";

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

export const noteBatch = { facts: [{ category: "observation", actor: "user", text: "用 pnpm，不要 npm", source: ["T1#user"] }] };
export const memoryBatch = { operations: [], skipped: [{ fact: "F1", because: "Not durable." }] };

export async function fixture(config: Record<string, unknown> = {}, provider = "fake") {
  const sent: Body[] = [];
  let respond: (body: Body, index: number) => Response | Promise<Response> = () => say("Done.");
  vi.stubGlobal("fetch", vi.fn(async (_url: unknown, init: RequestInit) => {
    const body = JSON.parse(String(init.body));
    sent.push(body);
    return respond(body, sent.length - 1);
  }));
  let manager: SessionManager | undefined;
  // `fetch: false`: this fixture stubs the wire itself (above), for both the real parent session and
  // the child the adapter builds.
  const h = host({ "noting.triggerTokens": 60, ...config }, undefined, { native: () => manager as never, fetch: false });
  const agentDir = join(h.dir, "agent"), sessionsDir = join(h.dir, "sessions");
  const modelRuntime = await ModelRuntime.create({ authPath: join(agentDir, "auth.json"), modelsPath: join(agentDir, "models.json") });
  const model = modelRuntime.getModel(provider, "test")!;
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
  const { session: parent } = await createAgentSession({ cwd: h.dir, agentDir, model, modelRuntime, settingsManager, resourceLoader,
    sessionManager: manager, noTools: "all", tools: tools.map(t => t.name), customTools: tools as never });
  const original = { id: manager.getSessionId(), file: manager.getSessionFile()! };
  return { h, parent, model, agentDir, sessionsDir, sent, original,
    manager: () => manager!,
    script: (fn: (body: Body, index: number) => Response | Promise<Response>) => { respond = fn; },
    /** One real parent turn, then the extension hooks the foreground would have fired. `capture`
     * off omits `before_provider_request`, the hook that supplies the fork's parent body. */
    async turn(prompt = "用 pnpm，不要 npm", options: { capture?: boolean } = {}) {
      await this.h.emit("before_agent_start", { prompt });
      const at = sent.length;
      await parent.prompt(prompt);
      const captured = sent[at]!;
      if (options.capture !== false) await this.h.emit("before_provider_request", { payload: captured });
      await this.h.emit("agent_settled");
      await this.h.drain();
      return captured;
    },
    /** The same child the host builds, for the checks that need it without the host's scheduling. */
    task(captured: Body, overrides: Partial<NativeForkTask> = {}): NativeForkTask {
      return { mode: "fork", parentFile: manager!.getSessionFile()!, parentSessionId: manager!.getSessionId(),
        checkpoint: manager!.getLeafId()!, runsDir: join(h.dir, "runs", manager!.getSessionId()), cwd: h.dir, agentDir,
        model: model as never, captured, task: "Range: S1/T1..S1/T1\n\nnote what happened", tools: [], maxToolRounds: 0,
        onRequest: () => {}, onProgress: () => {}, ...overrides };
    },
    async dispose() { parent.dispose(); await h.dispose(); vi.unstubAllGlobals(); },
  };
}
export const settled = async (f: Awaited<ReturnType<typeof fixture>>, kind: "noting" | "consolidation" = "noting") =>
  await vi.waitFor(() => { const run = f.h.memory.store.listRuns(1).find(r => r.kind === kind); expect(run?.response).toBeTruthy(); return run!; }, { timeout: 5000 });
