import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { homedir } from "node:os";
import { randomUUID } from "node:crypto";
import type { ExtensionAPI, ExtensionContext, ToolDefinition } from "@earendil-works/pi-coding-agent";
import { complete } from "@earendil-works/pi-ai/compat";
import type { Tool, ToolCall } from "@earendil-works/pi-ai";
import { buildRequest, verifyRequest, hash, snapshot, type Body, type Appended } from "./branch.ts";
import { DEFAULT_CONFIG, TraceMemory, tokens, type ConfigOverride, type RecordResult, type RecordingAgentInput, type IntegrationAgentInput, type ListingOptions, type SearchScope } from "../../core/api/index.ts";

type Registry = ExtensionContext["modelRegistry"];
type Conversation = Parameters<Registry["complete"]>[1];
type Reply = Awaited<ReturnType<Registry["complete"]>>;
type FlatConfig = Record<string, string | number | boolean>;
const tag = "trace-memory";
const now = () => new Date().toISOString();
const text = (message: { content?: unknown }) => typeof message.content === "string" ? message.content
  : Array.isArray(message.content) ? message.content.filter(c => c.type === "text").map(c => c.text).join("\n") : "";

function configuration(): { flat: FlatConfig; core: ConfigOverride } {
  const flat: FlatConfig = JSON.parse(process.env.TRACE_MEMORY_CONFIG ?? "{}");
  const core: ConfigOverride = {};
  for (const section of ["render", "recording", "integration"] as const) {
    const values: Record<string, number | boolean> = {};
    for (const [key, value] of Object.entries(DEFAULT_CONFIG[section])) {
      const override = flat[`${section}.${key}`];
      if (override !== undefined && (typeof override !== typeof value ||
        (typeof override === "number" && (!Number.isFinite(override) || override < 0)))) throw new Error(`Invalid ${section}.${key}`);
      values[key] = (override ?? value) as number | boolean;
    }
    Object.assign(core, { [section]: values });
  }
  for (const key of Object.keys(flat)) if (!["dbPath", "recordingModel", "integrationModel"].includes(key) &&
    !["render", "recording", "integration"].some(s => key.startsWith(`${s}.`) && key.slice(s.length + 1) in DEFAULT_CONFIG[s as keyof typeof DEFAULT_CONFIG])) throw new Error(`Unknown setting ${key}`);
  for (const key of ["dbPath", "recordingModel", "integrationModel"]) if (flat[key] !== undefined && typeof flat[key] !== "string") throw new Error(`Invalid ${key}`);
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

function reviewMessage(result: string): string | undefined {
  try { const value = JSON.parse(result); return value.feedback?.role === "user" ? value.feedback.content : undefined; }
  catch { return undefined; }
}

export default function (pi: ExtensionAPI) {
  const { flat, core } = configuration();
  const dbPath = String(flat.dbPath ?? join(homedir(), ".trace-memory", "trace.db")).replace(/^~\//, `${homedir()}/`);
  if (dbPath !== ":memory:") mkdirSync(dirname(resolve(dbPath)), { recursive: true });
  let ctx: ExtensionContext;
  type Capture = { payload: Body; model: string; provider: string; branch: string };
  // One extension instance serves one Pi session: Pi tears the runtime down and re-runs the
  // factory on new/resume/fork, so the capture state is a single object.
  const session: { capture?: Capture; verified?: string; notified?: boolean } = {};
  const memory = TraceMemory(dbPath, async raw => {
    const input = raw as RecordingAgentInput | IntegrationAgentInput;
    const callContext = ctx;
    const callPiId = callContext.sessionManager.getSessionId();
    const registry = callContext.modelRegistry;
    const slash = input.model.indexOf("/");
    // The model is frozen with the run (a branch run freezes the session model at launch), so a
    // model switch during a two-round integration cannot redirect its final round.
    const current = callContext.model;
    const model = input.model === "session" || (current && `${current.provider}/${current.id}` === input.model) ? current
      : registry.find(input.model.slice(0, slash), input.model.slice(slash + 1));
    let request: unknown = null;
    let verification: (ReturnType<typeof verifyRequest> & { key: string; firstForKey: boolean; cache_read?: number }) | undefined;
    let fallbackReason: string | undefined;
    let mode: "branch" | "subagent" = "subagent";
    try {
      if (!model) throw new Error(`Unavailable model: ${input.model}`);
      if (input.mode === "branch") {
        let candidate: Body | undefined;
        try {
          // Recording and integration candidate: the captured prefix plus one instruction. Integration final: the
          // verified candidate request plus the candidate reply replayed and the feedback message;
          // it depends on nothing the main session changes after the candidate was sent.
          let prefix: Body, appended: Appended[];
          {
            const captured = session.capture;
            if (!captured || captured.branch !== input.branch) throw new Error("No current-branch provider payload captured");
            if (captured.model !== model.id || captured.provider !== model.provider) throw new Error("Session model changed since capture");
            prefix = captured.payload;
            appended = [{ role: "user", text: `${input.prompt}\n\n${input.input}` }];
          }
          candidate = buildRequest(prefix, model.api, appended);
          // The Anthropic adapter enforces this after onPayload; audit that exact body.
          if (model.api === "anthropic-messages") candidate.stream = true;
          const key = JSON.stringify([model.id, model.provider, hash(prefix.tools ?? null)]);
          verification = { ...verifyRequest(prefix, candidate, model.api, appended), key, firstForKey: session.verified !== key };
          if (!verification.passed) throw new Error(`Prefix mismatch at ${verification.differingPath}`);
          session.verified = key;
        } catch (error) {
          fallbackReason = String(error);
          session.verified = undefined;
          if (!session.notified) { contextNotice(input.kind, fallbackReason); session.notified = true; }
        }
        if (!fallbackReason && candidate) {
          mode = "branch";
          const auth = await registry.getApiKeyAndHeaders(model);
          if (!auth.ok) throw new Error(auth.error);
          let reply: Reply;
          const prefix = candidate;
          const key = model.api === "openai-responses" || model.api === "openai-codex-responses" ? "input" : "messages";
          let suffix: Conversation["messages"] = [];
          for (let round = 0; ; round++) {
            reply = await complete({ ...model, ...(auth.baseUrl ? { baseUrl: auth.baseUrl } : {}) },
              { messages: suffix }, { apiKey: auth.apiKey, headers: auth.headers, env: auth.env, sessionId: callPiId,
                onPayload(native) {
                  // Let the installed adapter preserve thinking signatures and native tool IDs.
                  // Only its serialized suffix is appended; captured settings and tools stay exact.
                  const append = suffix.length ? (native as Body)[key] : [];
                  if (!Array.isArray(append)) throw new Error("Missing native branch continuation messages");
                  candidate = { ...prefix, [key]: [...prefix[key] as unknown[], ...append] };
                  request = snapshot(candidate); input.reportRequest(request); return snapshot(candidate);
                } });
            if (verification && typeof reply.usage?.cacheRead === "number") verification.cache_read = reply.usage.cacheRead;
            const calls = reply.content.filter((c): c is ToolCall => c.type === "toolCall");
            if (input.kind !== "integration" || reply.stopReason !== "toolUse" || !calls.length) break;
            if (round >= 16) throw new Error("tool rounds exceeded");
            const results = calls.map(call => {
              const content = input.tools.find(t => t.name === call.name)?.execute(call.arguments) ?? `rejected: unknown tool ${call.name}`;
              return { role: "toolResult" as const, toolCallId: call.id, toolName: call.name, content: [{ type: "text" as const, text: content }], isError: content.includes("rejected:"), timestamp: Date.now() };
            });
            suffix = [...suffix, reply, ...results, ...results.flatMap(r => {
              const feedback = reviewMessage(r.content[0]!.text);
              return feedback ? [{ role: "user" as const, content: feedback, timestamp: Date.now() }] : [];
            })];
          }
          return { outcome: reply.stopReason === "aborted" ? "cancelled" : (reply.stopReason === "error" || reply.stopReason === "length") ? "failure" : "success",
            output: text(reply), usage: reply.usage, request, mode, verification };
        }
      }
      // Subagent mode: a fresh call. A recording may fetch cut evidence through the trace tool (spec,
      // overflow policy); like pi-om's observer, the host executes the call and continues.
      let conversation: Conversation = { systemPrompt: input.prompt, messages: [{ role: "user", content: input.kind === "recording" && fallbackReason ? input.subagentInput : input.input, timestamp: Date.now() }],
        tools: input.tools.map(({ execute: _execute, ...definition }) => definition as unknown as Tool) };
      let reply: Reply;
      for (let round = 0; ; round++) {
        reply = await registry.complete(model, conversation, { onPayload(payload: unknown) { request = JSON.parse(JSON.stringify(payload)); input.reportRequest(request); } });
        const calls = reply.content.filter((c): c is ToolCall => c.type === "toolCall");
        if (reply.stopReason !== "toolUse" || !calls.length) break;
        if (round >= 16) throw new Error("tool rounds exceeded"); // a run that never stops is a failure, not an empty batch
        const results = calls.map(call => {
          let content: string, isError = false;
          try { const tool = input.tools.find((t) => t.name === call.name);
            content = tool ? tool.execute(call.arguments) : `rejected: unknown tool ${call.name}`; isError = content.includes("rejected:"); } catch (error) { content = String(error); isError = true; }
          return { role: "toolResult" as const, toolCallId: call.id, toolName: call.name, content: [{ type: "text" as const, text: content }], isError, timestamp: Date.now() };
        });
        conversation = { ...conversation, messages: [...conversation.messages, reply, ...results, ...results.flatMap(r => { const feedback = input.kind === "integration" ? reviewMessage(r.content[0]!.text) : undefined; return feedback ? [{ role: "user" as const, content: feedback, timestamp: Date.now() }] : []; })] };
      }
      const outcome = reply.stopReason === "aborted" ? "cancelled" : (reply.stopReason === "error" || reply.stopReason === "length") ? "failure" : "success";
      return { outcome, output: text(reply), usage: reply.usage, request, mode, verification, fallbackReason };
    } catch (error) {
      return { outcome: error instanceof Error && error.name === "AbortError" ? "cancelled" : "failure", output: String(error), request, mode, verification, fallbackReason };
    }
  }, core);
  const contextNotice = (kind: string, reason: string) => ctx.ui.notify(`Trace Memory: ${kind} fell back to subagent mode. ${reason}`, "warning");
  type State = { sessionId?: number; projectId: number; branch: string; head?: number; piId: string; injected?: boolean; project?: string };
  let state: State;
  let current: { prompt: string; started: string; id?: number; completed: string; partial: string; replied?: boolean } | undefined;
  const pending = new Set<Promise<unknown>>();
  const recordings = new Map<string, Promise<RecordResult>>();
  const modelName = (kind: "recording" | "integration") => String(flat[`${kind}Model`] && flat[`${kind}Model`] !== "session"
    ? flat[`${kind}Model`] : ctx.model ? `${ctx.model.provider}/${ctx.model.id}` : "session");
  // Ruling 17:01: recording and integration each configure their mode (recording defaults to branch, integration to
  // subagent); branch mode always runs on the session model, subagent mode on the configured one.
  const launch = (kind: "recording" | "integration") => {
    const branch = kind === "recording" ? memory.config.recording.branchModeDefault : !memory.config.integration.subagentModeDefault;
    return { mode: branch ? "branch" as const : "subagent" as const, model: branch ? (ctx.model ? `${ctx.model.provider}/${ctx.model.id}` : "session") : modelName(kind) };
  };
  const recording = (input: Parameters<typeof memory.record>[0]) => {
    const key = `${input.sessionId}/${input.branch}`;
    const existing = recordings.get(key);
    if (existing) return existing;
    const promise = memory.record(input).finally(() => { recordings.delete(key); pending.delete(promise); });
    recordings.set(key, promise); pending.add(promise);
    return promise;
  };
  const save = () => pi.appendEntry(tag, { ...state, dbPath });
  const restore = (context: ExtensionContext, fork = false) => {
    ctx = context;
    const saved = ctx.sessionManager.getBranch().filter(e => e.type === "custom" && e.customType === tag)
      .map(e => (e as { data: State & { dbPath: string } }).data).filter(d => d.dbPath === dbPath).at(-1);
    const piId = ctx.sessionManager.getSessionId();
    // A tree switch invalidates the old branch body, even when returning to a saved head.
    session.capture = undefined;
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
      if (name) memory.declareProject(state.sessionId, name, "marker");
      state.projectId = memory.store.getSession(state.sessionId)!.projectId;
      if (memory.store.projectDeclaration(state.sessionId) === "mark") state.project = memory.store.getProject(state.projectId)!.name;
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
  pi.on("before_provider_request", (event, context) => {
    ensure(context);
    if (context.model) session.capture = { payload: snapshot(event.payload) as Body,
      model: context.model.id, provider: context.model.provider, branch: state.branch };
  });
  pi.on("session_start", (_event, context) => restore(context));
  pi.on("session_tree", (_event, context) => { restore(context, true); save(); });
  pi.on("before_agent_start", (event, context) => {
    ensure(context);
    current = { prompt: event.prompt, started: now(), completed: "", partial: "" };
    append();
    // Knowledge once per session (the compaction block carries them afterwards); deliveries on every prompt.
    const parts: string[] = [];
    if (!state.injected) {
      const block = memory.inject(state.sessionId ?? { projectId: state.projectId });
      if (block) { parts.push(block); state.injected = true; save(); } // nothing yet: try again next prompt
    }
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
    if (!current || (!text(message) && (!Array.isArray(message.content) ||
      !message.content.some(c => c.type === "toolCall" || (c.type === "thinking" && c.thinking))))) return;
    current.replied = true;
    if (!state.sessionId) {
      const name = marker(ctx.cwd);
      // A marker may disappear between the initial injection and the first reply.
      if (!name) state.projectId = (memory.store.findProjectByName(`pi:${state.piId}`)
        ?? memory.store.createProject({ name: `pi:${state.piId}`, declaredBy: "marker" })).id;
      state.sessionId = memory.store.createSession({ host: `pi:${state.piId}`, startedAt: current.started, firstReplyAt: now(), projectId: state.projectId, projectDeclaration: name ? "marker" : "undeclared" }).id;
      if (name) memory.declareProject(state.sessionId, name, "marker");
      state.projectId = memory.store.getSession(state.sessionId)!.projectId;
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
    for (let id: number | null = head; id && id !== watermark?.lastRecordedTurn;) {
      const turn: NonNullable<ReturnType<typeof memory.store.getTurn>> = memory.store.getTurn(id)!;
      turns.push(turn); id = turn.parentTurnId;
    }
    const answered = turns.filter(t => t.kind === "turn" && t.assistantText !== null).length;
    const growth = turns.reduce((n, t) => n + tokens((t.userPrompt ?? "") + (t.assistantText ?? "") + memory.store.listToolCalls(t.id).map(c => (c.input ?? "") + (c.result ?? "")).join("")), 0);
    const background = (promise: Promise<unknown>) => {
      pending.add(promise);
      void promise.catch(error => context.ui.notify(String(error), "error")).finally(() => pending.delete(promise));
    };
    const recordingLaunch = launch("recording");
    // A branch recording carries only the range (ruling 08:53): it presumes every earlier recording result is
    // already in the conversation. A result committed after this prompt started is not delivered
    // until the next prompt, so the recording waits for that prompt's turn stop.
    const undelivered = memory.store.listPendingDeliveries(sessionId, branch).length > 0;
    if ((answered >= memory.config.recording.triggerAnsweredTurns || growth >= memory.config.recording.triggerTokens) && !(recordingLaunch.mode === "branch" && undelivered))
      background(recording({ sessionId, branch, headTurnId: head, ...recordingLaunch }));
    const count = memory.store.listBranchFacts(sessionId, branch).filter(f => f.id > (watermark?.lastIntegratedFact ?? 0)).length;
    if (count >= memory.config.integration.triggerUnintegratedFacts)
      background(memory.integrate({ sessionId, branch, ...launch("integration") }));
  });
  pi.on("session_before_tree", async (_event, context) => {
    ensure(context); flush(true);
    const { sessionId, branch, head } = state;
    if (!sessionId || !head) return { summary: { summary: "" } };
    try {
      // A pending run owns its frozen range. Later raw stays in the summary.
      await recording({ sessionId, branch, headTurnId: head, mode: "subagent", model: modelName("recording") });
    } catch (error) { context.ui.notify(String(error), "error"); }
    return { summary: { summary: memory.branchSummary(sessionId, branch, head) } };
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
  // Pi tears the extension runtime down and re-runs the factory for every reason, including
  // session replacement (new, resume, fork); this instance never serves the next session.
  let closed = false;
  pi.on("session_shutdown", async () => {
    if (closed) return;
    closed = true;
    flush(true);
    await Promise.allSettled([...pending]);
    memory.close();
  });
  const result = (value: string) => ({ content: [{ type: "text" as const, text: value }], details: {} });
  const schema = (properties: object, required: string[]) => ({ type: "object", properties, required, additionalProperties: false }) as ToolDefinition["parameters"];
  pi.registerTool({ name: "trace", label: "Trace", description: "Read memory evidence by address or project name.",
    parameters: schema({ address: { type: "string" }, options: { type: "object", properties: { cap: { type: "integer", minimum: 1 }, cursor: { type: "string" } } } }, ["address"]),
    async execute(_id, raw) { const args = raw as { address: string; options?: ListingOptions }; return result(memory.trace(args.address, args.options)); } });
  pi.registerTool({ name: "search", label: "Search", description: "Search stored memory. No hit does not mean absent.",
    parameters: schema({ query: { type: "string" }, scope: { enum: ["facts", "knowledge", "all", "raw"] } }, ["query"]),
    async execute(_id, raw) { const args = raw as { query: string; scope?: SearchScope }; return result(memory.search(args.query, args.scope, { sessionId: state.sessionId })); } });
  pi.registerCommand("trace", { description: "Read Trace Memory status without running extraction.",
    async handler(args, context) {
      const parts = args.trim().split(/\s+/);
      if (parts[0] === "project") {
        if (!state.sessionId) throw new Error("A session requires an assistant reply");
        const marked = memory.declareProject(state.sessionId, parts.slice(1).join(" "));
        state.projectId = memory.store.getSession(state.sessionId)!.projectId;
        state.project = memory.store.getProject(state.projectId)!.name; save();
        context.ui.notify(`${marked}\n\n${memory.inject(state.sessionId)}`, "info"); return;
      }
      if (parts[0] === "mark") {
        if (!/^K[1-9]\d*$/.test(parts[1] ?? "") || parts.length !== 3) throw new Error("Use /trace mark K<n> verified|flagged|clear");
        context.ui.notify(memory.mark(Number(parts[1]!.slice(1)), parts[2] as "verified" | "flagged" | "clear"), "info"); return;
      }
      context.ui.notify(state?.sessionId ? memory.status(state.sessionId) : "Trace Memory: no assistant reply; no session id.", "info"); } });
}
