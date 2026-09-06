import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { homedir } from "node:os";
import { randomUUID } from "node:crypto";
import type { ExtensionAPI, ExtensionContext, ToolDefinition } from "@earendil-works/pi-coding-agent";
import { DEFAULT_CONFIG, TraceMemory, type ConfigOverride, type NoteAgentInput, type SettleAgentInput, type MarkInput, type ListingOptions, type SearchScope } from "../../core/api/index.ts";

type Registry = ExtensionContext["modelRegistry"];
type Conversation = Parameters<Registry["complete"]>[1];
type Reply = Awaited<ReturnType<Registry["complete"]>>;
type FlatConfig = Record<string, string | number | boolean>;
const tag = "trace-memory";
const now = () => new Date().toISOString();
const text = (message: { content?: unknown }) => typeof message.content === "string" ? message.content
  : Array.isArray(message.content) ? message.content.filter(c => c.type === "text").map(c => c.text).join("\n") : "";
const estimate = (s: string) => {
  let cjk = 0;
  for (const c of s) if (/[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}\u3000-\u303f\uff00-\uffef]/u.test(c)) cjk++;
  return Math.ceil(cjk * .75 + (s.length - cjk) * .25);
};

function configuration(): { flat: FlatConfig; core: ConfigOverride } {
  const flat: FlatConfig = JSON.parse(process.env.TRACE_MEMORY_CONFIG ?? "{}");
  const core: ConfigOverride = {};
  for (const section of ["render", "note", "settle"] as const) {
    const values: Record<string, number | boolean> = {};
    for (const [key, value] of Object.entries(DEFAULT_CONFIG[section])) {
      const override = flat[`${section}.${key}`];
      if (override !== undefined && (typeof override !== typeof value ||
        (typeof override === "number" && (!Number.isFinite(override) || override < 0)))) throw new Error(`Invalid ${section}.${key}`);
      values[key] = (override ?? value) as number | boolean;
    }
    Object.assign(core, { [section]: values });
  }
  for (const key of Object.keys(flat)) if (!["dbPath", "noteModel", "settleModel"].includes(key) &&
    !["render", "note", "settle"].some(s => key.startsWith(`${s}.`) && key.slice(s.length + 1) in DEFAULT_CONFIG[s as keyof typeof DEFAULT_CONFIG])) throw new Error(`Unknown setting ${key}`);
  for (const key of ["dbPath", "noteModel", "settleModel"]) if (flat[key] !== undefined && typeof flat[key] !== "string") throw new Error(`Invalid ${key}`);
  return { flat, core };
}
function marker(cwd: string): string | undefined {
  for (let dir = resolve(cwd); ; dir = dirname(dir)) {
    const path = join(dir, ".trace-memory");
    if (existsSync(path)) {
      const name = readFileSync(path, "utf8").trim();
      if (!name) throw new Error(`Empty project marker: ${path}`);
      return name;
    }
    if (dirname(dir) === dir) return;
  }
}

export default function (pi: ExtensionAPI) {
  const { flat, core } = configuration();
  const dbPath = String(flat.dbPath ?? join(homedir(), ".trace-memory", "trace.db")).replace(/^~\//, `${homedir()}/`);
  if (dbPath !== ":memory:") mkdirSync(dirname(resolve(dbPath)), { recursive: true });
  let ctx: ExtensionContext;
  const continuations = new Map<string, { conversation: Conversation; reply: Reply; owner: string }>();
  const memory = TraceMemory(dbPath, async raw => {
    const input = raw as NoteAgentInput | SettleAgentInput;
    const registry = ctx.modelRegistry;
    const slash = input.model.indexOf("/");
    const model = input.model === "session" ? ctx.model : registry.find(input.model.slice(0, slash), input.model.slice(slash + 1));
    let request: unknown = null;
    try {
      if (!model) throw new Error(`Unavailable model: ${input.model}`);
      let conversation: Conversation = { systemPrompt: input.prompt, messages: [{ role: "user", content: input.input, timestamp: Date.now() }] };
      if (input.kind === "settle" && input.continuation) {
        const key = JSON.stringify(input.continuation.request);
        const prior = continuations.get(key);
        continuations.delete(key);
        if (!prior) throw new Error("Missing settle candidate conversation");
        conversation = { ...prior.conversation, messages: [...prior.conversation.messages, prior.reply,
          { ...input.continuation.message, timestamp: Date.now() }] };
      }
      const reply = await registry.complete(model, conversation, {
        onPayload(payload: unknown) { request = JSON.parse(JSON.stringify(payload)); },
      });
      const outcome = reply.stopReason === "aborted" ? "cancelled" : reply.stopReason === "error" ? "failure" : "success";
      if (input.kind === "settle" && input.round === "candidate" && outcome === "success")
        continuations.set(JSON.stringify(request), { conversation: structuredClone(conversation), reply: structuredClone(reply), owner: `${input.sessionId}/${input.branch}` });
      return { outcome, output: text(reply), usage: reply.usage, request };
    } catch (error) {
      return { outcome: error instanceof Error && error.name === "AbortError" ? "cancelled" : "failure", output: String(error), request };
    }
  }, core);
  type State = { sessionId?: number; projectId: number; branch: string; head?: number; piId: string; injected?: boolean };
  let state: State;
  let current: { prompt: string; started: string; id?: number; completed: string; partial: string; replied?: boolean } | undefined;
  const pending = new Set<Promise<unknown>>();
  const save = () => pi.appendEntry(tag, { ...state, dbPath });
  const restore = (context: ExtensionContext, fork = false) => {
    ctx = context;
    const saved = ctx.sessionManager.getBranch().filter(e => e.type === "custom" && e.customType === tag)
      .map(e => (e as { data: State & { dbPath: string } }).data).filter(d => d.dbPath === dbPath).at(-1);
    const piId = ctx.sessionManager.getSessionId();
    if (saved) {
      const tip = ctx.sessionManager.getEntries().filter(e => e.type === "custom" && e.customType === tag)
        .map(e => (e as { data: State & { dbPath: string } }).data)
        .filter(d => d.dbPath === dbPath && d.sessionId === saved.sessionId && d.branch === saved.branch).at(-1);
      state = { ...saved, piId, branch: (fork && tip?.head !== saved.head) || saved.piId !== piId ? randomUUID() : saved.branch };
    } else {
      const name = marker(ctx.cwd);
      const project = name && memory.store.findProjectByName(name);
      state = { projectId: project ? project.id : memory.store.createProject({ name: name ?? `pi:${piId}`, declaredBy: "marker" }).id, branch: "main", piId };
    }
    current = undefined;
    if (state.sessionId) {
      const name = marker(ctx.cwd);
      if (name) memory.mark({ sessionId: state.sessionId, project: name, source: "marker" });
    }
  };
  const ensure = (context: ExtensionContext) => { ctx = context; if (!state || state.piId !== context.sessionManager.getSessionId()) restore(context); };
  const append = () => {
    if (current && state.sessionId && !current.id) {
      const turn = memory.store.appendTurn({ sessionId: state.sessionId, parentTurnId: state.head, kind: "turn", userPrompt: current.prompt, startedAt: current.started });
      current.id = state.head = turn.id;
      save();
    }
  };
  const flush = (ended = false) => {
    if (current?.id && current.replied) memory.store.updateTurn(current.id, { assistantText: [current.completed, current.partial].filter(Boolean).join("\n"), ...(ended ? { endedAt: now() } : {}) });
  };
  pi.on("session_start", (_event, context) => restore(context));
  pi.on("session_tree", (_event, context) => { restore(context, true); save(); });
  pi.on("before_agent_start", (event, context) => {
    ensure(context);
    current = { prompt: event.prompt, started: now(), completed: "", partial: "" };
    append();
    // Entries once per session (the compaction block carries them afterwards); deliveries on every prompt.
    const parts: string[] = [];
    if (!state.injected) { parts.push(memory.inject(state.sessionId ?? { projectId: state.projectId })); state.injected = true; save(); }
    if (state.sessionId) { const delivery = memory.deliver(state.sessionId, state.branch); if (delivery) parts.push(delivery); }
    if (!parts.length) return;
    return { message: { customType: tag, content: parts.join("\n\n"), display: false } };
  });
  pi.on("message_start", (event, context) => {
    ensure(context);
    if (event.message.role === "user" && (!current || current.replied || current.prompt !== text(event.message))) {
      flush(true);
      current = { prompt: text(event.message), started: now(), completed: "", partial: "" };
      append();
    }
  });
  const assistant = (message: { content?: unknown }, context: ExtensionContext, ended: boolean) => {
    ensure(context);
    if (!current || (!text(message) && (!Array.isArray(message.content) || !message.content.length))) return;
    current.replied = true;
    if (!state.sessionId) {
      state.sessionId = memory.store.createSession({ host: `pi:${state.piId}`, startedAt: current.started, firstReplyAt: now(), projectId: state.projectId, projectDeclaration: "undeclared" }).id;
      const name = marker(ctx.cwd);
      if (name) memory.mark({ sessionId: state.sessionId, project: name, source: "marker" });
      append();
    }
    current.partial = text(message);
    flush();
    if (ended) { current.completed = [current.completed, current.partial].filter(Boolean).join("\n"); current.partial = ""; save(); }
  };
  pi.on("message_update", (event, context) => { if (event.message.role === "assistant") assistant(event.message, context, false); });
  pi.on("message_end", (event, context) => { if (event.message.role === "assistant") assistant(event.message, context, true); });
  pi.on("tool_result", event => {
    if (current?.id) memory.store.appendToolCall({ turnId: current.id, name: event.toolName, input: JSON.stringify(event.input), result: JSON.stringify({ content: event.content, details: event.details }), status: event.isError ? "failure" : "success" });
  });
  pi.on("agent_settled", (_event, context) => {
    ensure(context);
    if (!state.sessionId || !state.head) return;
    if (current?.id && memory.store.getTurn(current.id)?.assistantText !== null) flush(true);
    const { sessionId, branch, head } = state;
    const watermark = memory.store.getWatermark(sessionId, branch);
    const turns = [];
    for (let id: number | null = head; id && id !== watermark?.lastNotedTurn;) {
      const turn: NonNullable<ReturnType<typeof memory.store.getTurn>> = memory.store.getTurn(id)!;
      turns.push(turn); id = turn.parentTurnId;
    }
    const answered = turns.filter(t => t.kind === "turn" && t.assistantText !== null).length;
    const tokens = turns.reduce((n, t) => n + estimate((t.userPrompt ?? "") + (t.assistantText ?? "") + memory.store.listToolCalls(t.id).map(c => (c.input ?? "") + (c.result ?? "")).join("")), 0);
    const model = (kind: "note" | "settle") => {
      const selected = flat[`${kind}Model`];
      return String(selected && selected !== "session" ? selected : ctx.model ? `${ctx.model.provider}/${ctx.model.id}` : "session");
    };
    const background = (promise: Promise<unknown>) => {
      pending.add(promise);
      void promise.catch(error => context.ui.notify(String(error), "error")).finally(() => pending.delete(promise));
    };
    if (answered >= memory.config.note.triggerAnsweredTurns || tokens >= memory.config.note.triggerTokens)
      background(memory.note({ sessionId, branch, headTurnId: head, mode: "subagent", model: model("note") }));
    const count = memory.store.listBranchFacts(sessionId, branch).filter(f => f.id > (watermark?.lastSettledFact ?? 0)).length;
    if (count >= memory.config.settle.triggerUnsettledFacts)
      background(memory.settle({ sessionId, branch, mode: "subagent", model: model("settle") }).then(result => {
        if (result.outcome !== "dropped") for (const [key, value] of continuations) if (value.owner === `${sessionId}/${branch}`) continuations.delete(key);
        return result;
      }));
  });
  pi.on("session_before_compact", (event, context) => {
    ensure(context); flush();
    return { compaction: { summary: state.sessionId ? memory.compact(state.sessionId, state.branch, state.head) : memory.inject({ projectId: state.projectId }),
      firstKeptEntryId: "", tokensBefore: event.preparation.tokensBefore } };
  });
  pi.on("session_compact", event => {
    if (state.sessionId) {
      const turn = memory.store.appendTurn({ sessionId: state.sessionId, parentTurnId: state.head, kind: "compaction", assistantText: event.compactionEntry.summary, startedAt: now(), endedAt: now() });
      state.head = turn.id; save();
    }
  });
  pi.on("session_shutdown", async event => {
    flush(true);
    if (event.reason === "quit" || event.reason === "reload") { await Promise.allSettled([...pending]); memory.close(); }
  });
  const result = (value: string) => ({ content: [{ type: "text" as const, text: value }], details: {} });
  const schema = (properties: object, required: string[]) => ({ type: "object", properties, required, additionalProperties: false }) as ToolDefinition["parameters"];
  pi.registerTool({ name: "trace", label: "Trace", description: "Read memory evidence by address or project name.",
    parameters: schema({ address: { type: "string" }, options: { type: "object", properties: { cap: { type: "integer", minimum: 1 }, cursor: { type: "string" } } } }, ["address"]),
    async execute(_id, raw) { const args = raw as { address: string; options?: ListingOptions }; return result(memory.trace(args.address, args.options)); } });
  pi.registerTool({ name: "search", label: "Search", description: "Search stored memory. No hit does not mean absent.",
    parameters: schema({ query: { type: "string" }, scope: { enum: ["facts", "entries", "all", "raw"] } }, ["query"]),
    async execute(_id, raw) { const args = raw as { query: string; scope?: SearchScope }; return result(memory.search(args.query, args.scope, { sessionId: state.sessionId })); } });
  pi.registerTool({ name: "mark", label: "Mark", description: "Declare the current project or mark an entry revision.",
    parameters: schema({ input: { anyOf: [schema({ project: { type: "string" } }, ["project"]), schema({ entryId: { type: "integer", minimum: 1 }, kind: { enum: ["verified", "flagged", "clear"] } }, ["entryId", "kind"])] } }, ["input"]),
    async execute(_id, raw) {
      const args = raw as { input: { project: string } | Exclude<MarkInput, { project: string }> };
      if ("project" in args.input && !state.sessionId) throw new Error("A session requires an assistant reply");
      return result(memory.mark("project" in args.input ? { project: args.input.project, sessionId: state.sessionId!, source: "mark" } : args.input as MarkInput));
    } });
  pi.registerCommand("trace", { description: "Read Trace Memory status without running extraction.",
    async handler(_args, context) { context.ui.notify(state?.sessionId ? memory.status(state.sessionId) : "Trace Memory: no assistant reply; no session id.", "info"); } });
}
