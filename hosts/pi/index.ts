import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { homedir } from "node:os";
import { randomUUID } from "node:crypto";
import type { ExtensionAPI, ExtensionContext, ToolDefinition } from "@earendil-works/pi-coding-agent";
import { complete } from "@earendil-works/pi-ai/compat";
import { retryAssistantCall, type Tool, type ToolCall, type Usage } from "@earendil-works/pi-ai";
import { buildRequest, verifyRequest, appendNativeRequest, verifyNativeRequest, messageKey, hash, snapshot, type Body, type Appended } from "./branch.ts";
import { DEFAULT_CONFIG, TraceMemory, tokens, toolDefinitions, type ConfigOverride, type RecordResult, type RecordingAgentInput, type IntegrationAgentInput } from "../../core/api/index.ts";

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

function rejected(name: string, content: string): boolean {
  if (content.startsWith("rejected:")) return true;
  if (name !== "note" && name !== "memory") return false;
  try {
    const { results } = JSON.parse(content);
    return Array.isArray(results) && results.some(r => typeof r === "string" && r.startsWith("rejected:"));
  } catch { return false; }
}

// Sum every numeric field of the per-call usage objects so a multi-round run reports its whole cost.
function addUsage(total: unknown, usage: unknown): unknown {
  if (usage === undefined || usage === null) return total;
  if (typeof usage === "number") return (typeof total === "number" ? total : 0) + usage;
  if (typeof usage !== "object") return usage;
  const left = (total && typeof total === "object" ? total : {}) as Record<string, unknown>;
  return Object.fromEntries(Object.keys(usage as object).map(key => [key, addUsage(left[key], (usage as Record<string, unknown>)[key])]));
}
function stripCacheControl<T>(value: T): T {
  if (Array.isArray(value)) return value.map(stripCacheControl) as T;
  if (value && typeof value === "object") return Object.fromEntries(Object.entries(value as object).filter(([k]) => k !== "cache_control").map(([k, v]) => [k, stripCacheControl(v)])) as T;
  return value;
}
function reviewMessage(result: string): string | undefined {
  try { const value = JSON.parse(result); return value.feedback?.role === "user" ? value.feedback.content : undefined; }
  catch { return undefined; }
}

// Pi's own retry settings: settings.json `retry` from the agent dir (PI_CODING_AGENT_DIR or ~/.pi/agent),
// overridden by the project's .pi/settings.json, with Pi's defaults. Read as files: a value import of Pi's
// SettingsManager pulls the package entry, which needs @earendil-works/pi-server on this machine.
function retrySettings(cwd: string) {
  type Retry = { enabled?: boolean; maxRetries?: number; baseDelayMs?: number; provider?: { timeoutMs?: number; maxRetries?: number; maxRetryDelayMs?: number } };
  const read = (path: string): Retry => { try { return (JSON.parse(readFileSync(path, "utf8")) as { retry?: Retry }).retry ?? {}; } catch { return {}; } };
  const agentDir = process.env.PI_CODING_AGENT_DIR ?? join(homedir(), ".pi", "agent");
  const global = read(join(agentDir, "settings.json")), project = read(join(cwd, ".pi", "settings.json"));
  const retry: Retry = { ...global, ...project, provider: { ...global.provider, ...project.provider } }; // nested like Pi's own merge
  return { policy: { enabled: retry.enabled ?? true, maxRetries: retry.maxRetries ?? 3, baseDelayMs: retry.baseDelayMs ?? 2000 },
    provider: { timeoutMs: retry.provider?.timeoutMs, maxRetries: retry.provider?.maxRetries, maxRetryDelayMs: retry.provider?.maxRetryDelayMs ?? 60000 } };
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
    let verification: (ReturnType<typeof verifyRequest> & { key: string; firstForKey: boolean; cache_read?: number; rounds: ReturnType<typeof verifyNativeRequest>[] }) | undefined;
    let fallbackReason: string | undefined;
    let mode: "branch" | "subagent" = "subagent";
    try {
      if (!model) throw new Error(`Unavailable model: ${input.model}`);
      // One loop for both modes (pi-om's observer shape): handle a reply, execute its tool calls,
      // append the Integration feedback, call the model again until it stops. Only sending differs.
      // Each model call goes through Pi's retry helper with Pi's settings (the one Pi uses for its
      // own compaction and branch-summary calls): transient provider errors back off and retry;
      // tool execution and commits happen only after a reply, so a retry never repeats a write.
      const retry = retrySettings(callContext.cwd);
      // `prepare` builds one round's request context exactly once (suffix appended, base fixed) and
      // returns the send; the retry helper re-sends that same request, never a re-appended one.
      const converse = async (prepare: (suffix: Conversation["messages"]) => () => Promise<Reply>) => {
        let suffix: Conversation["messages"] = [], rounds = 0, usage: unknown, reply: Reply;
        const retries: { attempt: number; error: string }[] = [];
        const cap = memory.config[input.kind].maxToolRounds; // 0 = unlimited (spec: the model is called again until it stops)
        for (;;) {
          const produce = prepare(suffix);
          reply = await retryAssistantCall(async () => { const r = await produce(); usage = addUsage(usage, r.usage); return r; }, retry.policy, undefined, {
            onRetryScheduled: (attempt, maxAttempts, delayMs, message) => { retries.push({ attempt, error: message }); activity.retrying = true; showSpend(callContext);
              callContext.ui.notify(`Trace Memory: ${input.kind} retry ${attempt}/${maxAttempts} in ${Math.round(delayMs / 1000)}s: ${message}`, "warning"); },
            onRetryAttemptStart: () => { activity.retrying = false; showSpend(callContext); },
            onRetryFinished: () => { activity.retrying = false; showSpend(callContext); },
          });
          const calls = reply.content.filter((c): c is ToolCall => c.type === "toolCall");
          if (reply.stopReason !== "toolUse" || !calls.length) break;
          if (cap && ++rounds > cap) throw new Error(`tool rounds exceeded (${cap})`); // over budget is a failure, not an empty batch
          const results = calls.map(call => {
            let content: string;
            try { content = input.tools.find(t => t.name === call.name)?.execute(call.arguments) ?? `rejected: unknown tool ${call.name}`; }
            catch (error) { content = `rejected: ${String(error)}`; }
            return { role: "toolResult" as const, toolCallId: call.id, toolName: call.name, content: [{ type: "text" as const, text: content }], isError: rejected(call.name, content), timestamp: Date.now() };
          });
          const feedback = input.kind === "integration" ? results.flatMap(r => { const f = reviewMessage(r.content[0]!.text); return f ? [{ role: "user" as const, content: f, timestamp: Date.now() }] : []; }) : [];
          suffix = [reply, ...results, ...feedback];
        }
        return { reply, usage, retries };
      };
      const outcomeOf = (reply: Reply) => reply.stopReason === "aborted" ? "cancelled" as const : (reply.stopReason === "error" || reply.stopReason === "length") ? "failure" as const : "success" as const;
      // A stream that died mid-reply reports its error, not the partial text it managed to produce.
      const outputOf = (reply: Reply) => outcomeOf(reply) === "success" ? text(reply)
        : `${reply.stopReason}${reply.errorMessage ? `: ${reply.errorMessage}` : ""}${text(reply) ? ` (partial output: ${text(reply).slice(0, 200)})` : ""}`;
      if (input.mode === "branch") {
        let candidate: Body | undefined;
        try {
          // Both run kinds start with the captured prefix plus one instruction.
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
          verification = { ...verifyRequest(prefix, candidate, model.api, appended), key, firstForKey: session.verified !== key, rounds: [] };
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
        const key = messageKey(model.api);
        const { reply, usage, retries } = await converse(suffix => {
          const previous = candidate!; // this round's base, fixed before any attempt: a retry rebuilds the same request
          let verified = false;
          return () => complete({ ...model, ...(auth.baseUrl ? { baseUrl: auth.baseUrl } : {}) },
            { messages: suffix }, { apiKey: auth.apiKey, headers: auth.headers, env: auth.env, sessionId: callPiId, ...retry.provider,
              onPayload(native) {
                // The installed adapter serializes only the new suffix (native tool ids, thinking
                // signatures). Its cache markers are stripped so rounds add none to the captured
                // prefix's own; the session id stays so routing and connection reuse are unchanged.
                const append = suffix.length ? stripCacheControl((native as Body)[key]) : [];
                if (!Array.isArray(append)) throw new Error("Missing native branch continuation messages");
                if (suffix.length) {
                  candidate = appendNativeRequest(previous, model.api, append);
                  const checked = verifyNativeRequest(previous, candidate, model.api, append);
                  if (!verified) { verification!.rounds.push(checked); verified = true; }
                  if (!checked.passed) { verification!.passed = false; throw new Error(`Prefix mismatch at ${checked.differingPath}`); }
                }
                request = snapshot(candidate); input.reportRequest(request); return snapshot(candidate);
              } });
        });
        if (verification && typeof (usage as { cacheRead?: unknown } | undefined)?.cacheRead === "number") verification.cache_read = (usage as { cacheRead: number }).cacheRead;
        return { outcome: outcomeOf(reply), output: outputOf(reply), usage, request, mode, verification, ...(retries.length ? { retries } : {}) };
        }
      }
      // Subagent mode: a fresh call with the four façade definitions; the conversation grows by each round's suffix.
      let conversation: Conversation = { systemPrompt: input.prompt, messages: [{ role: "user", content: fallbackReason ? input.subagentInput : input.input, timestamp: Date.now() }],
        tools: toolDefinitions as unknown as Tool[] };
      const { reply, usage, retries } = await converse(suffix => {
        conversation = { ...conversation, messages: [...conversation.messages, ...suffix] }; // once per round
        const fixed = conversation;
        return () => registry.complete(model, fixed, { ...retry.provider, onPayload(payload: unknown) { request = JSON.parse(JSON.stringify(payload)); input.reportRequest(request); } });
      });
      return { outcome: outcomeOf(reply), output: outputOf(reply), usage, request, mode, verification, fallbackReason, ...(retries.length ? { retries } : {}) };
    } catch (error) {
      return { outcome: error instanceof Error && error.name === "AbortError" ? "cancelled" : "failure", output: String(error), request, mode, verification, fallbackReason };
    }
  }, core);
  const contextNotice = (kind: string, reason: string) => ctx.ui.notify(`Trace Memory: ${kind} fell back to subagent mode. ${reason}`, "warning");
  type State = { sessionId?: number; projectId: number; branch: string; head?: number; piId: string; injected?: boolean; project?: string };
  let state: State;
  let current: { prompt: string; started: string; id?: number; completed: string; partial: string; replied?: boolean; saved?: boolean } | undefined;
  // What this agent run has shown the model and must confirm when it settles. Kept apart from
  // `current`, which a queued (steering or follow-up) user message replaces mid-run.
  const unconfirmed: { deliveries: number[]; injected: boolean } = { deliveries: [], injected: false };
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
  // A committed run may still carry problems (audit update or provider failure after the commit): warn, keep success.
  // The plugin's own model spend as a footer status item (Pi's setStatus, the shape ponytail uses);
  // background runs never enter Pi's session totals, which only count entries of the session file.
  // Footer status item (user ruling 2026-09-07): one indicator in Pi theme colours — dim ○ idle,
  // accent ● recording running, success ● integration running, warning ● paused or committed with
  // problems, error ● the last run failed — then today's plugin spend as ☉ $x.xx, reset daily.
  const activity = { running: new Map<"recording" | "integration", number>(), retrying: false, last: "ok" as "ok" | "warning" | "error" };
  const runningKind = (kind: "recording" | "integration") => (activity.running.get(kind) ?? 0) > 0;
  const showSpend = (context: ExtensionContext) => {
    if (!context.ui?.setStatus) return;
    const theme = (context.ui as { theme?: { fg?: (color: string, text: string) => string } }).theme;
    const paint = (color: string, text: string) => { try { return theme?.fg ? theme.fg(color, text) : text; } catch { return text; } };
    const indicator = activity.retrying ? paint("warning", "●") : runningKind("recording") ? paint("accent", "●") : runningKind("integration") ? paint("success", "●")
      : activity.last === "error" ? paint("error", "●") : activity.last === "warning" ? paint("warning", "●") : paint("dim", "○");
    // Fixed reading (user ruling 2026-09-07): applicable current knowledge / facts on this branch;
    // $ = this session's cumulative spend.
    let facts = 0, knowledge = 0, cost = 0;
    if (state?.sessionId) {
      facts = memory.store.listBranchFacts(state.sessionId, state.branch, state.head).length;
      knowledge = memory.store.listCurrentKnowledge({ sessionId: state.sessionId, headTurnId: state.head ?? null }).length;
      cost = memory.spend(state.sessionId).cost;
    }
    context.ui.setStatus("trace-memory", `🧠 ${indicator} trace-memory ${knowledge}/${facts} $${cost.toFixed(2)}`);
  };
  const reportProblems = (result: unknown, context: ExtensionContext) => {
    const r = result as { outcome?: string; problems?: string[] } | undefined;
    if (r?.outcome === "dropped") return; // a duplicate trigger says nothing about the run still in flight
    activity.last = r?.outcome === "failure" || r?.outcome === "cancelled" ? "error" : r?.outcome === "bounced" || r?.problems?.length ? "warning" : "ok";
    showSpend(context);
    if (r?.outcome === "success" && r.problems?.length) context.ui.notify(`Trace Memory: committed with problems. ${r.problems.join("; ")}`, "warning");
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
      // A new branch (Pi fork, clone, or tree switch off a saved head) inherits the recording watermark of
      // its nearest recorded ancestor, whichever branch recorded it, so shared turns are recorded once.
      // Integration progress needs no inheritance: it is per fact and judged against the branch's own path.
      if (state.branch !== saved.branch && saved.sessionId && state.head && !memory.store.getWatermark(saved.sessionId, state.branch)) {
        const recorded = memory.store.lastRecordedAncestor(saved.sessionId, state.head);
        if (recorded) memory.store.setWatermark(saved.sessionId, state.branch, recorded);
      }
    } else {
      const name = marker(ctx.cwd);
      const project = name && memory.store.findProjectByName(name);
      state = { projectId: project ? project.id : memory.store.createProject({ name: name ?? `pi:${piId}`, declaredBy: "marker" }).id, branch: "main", piId };
    }
    current = undefined;
    showSpend(ctx);
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
      // Not saved yet: Pi persists the user message only after message_end, and a state entry
      // written before it would survive a rewind to the point before that message.
    }
  };
  const persistState = () => { if (current?.id && !current.saved) { current.saved = true; save(); } };
  const flush = (ended = false) => {
    if (current?.id && current.replied) memory.store.updateTurn(current.id, { assistantText: [current.completed, current.partial].filter(Boolean).join("\n"), ...(ended ? { endedAt: now() } : {}) });
  };
  pi.on("before_provider_request", (event, context) => {
    ensure(context);
    if (context.model) session.capture = { payload: snapshot(event.payload) as Body,
      model: context.model.id, provider: context.model.provider, branch: state.branch };
  });
  pi.on("session_start", (_event, context) => restore(context));
  pi.on("session_tree", (_event, context) => { restore(context, true); state.injected = false; save(); });
  pi.on("before_agent_start", (event, context) => {
    ensure(context);
    current = { prompt: event.prompt, started: now(), completed: "", partial: "" };
    append();
    // Knowledge once per session (the compaction block carries them afterwards); deliveries on every prompt.
    // Both are confirmed at this turn's agent_settled, after Pi has persisted the message (ruling
    // 2026-09-07): a turn that never settles injects or delivers again; duplicates over silent loss.
    const parts: string[] = [];
    if (!state.injected) {
      const block = memory.inject(state.sessionId ? { sessionId: state.sessionId, headTurnId: state.head ?? null } : { projectId: state.projectId });
      if (block) { parts.push(block); unconfirmed.injected = true; } // nothing yet: try again next prompt
    }
    if (state.sessionId) {
      const delivery = memory.deliver(state.sessionId, state.branch);
      if (delivery.text) parts.push(delivery.text);
      unconfirmed.deliveries.push(...delivery.runIds); // only what this prompt took; later results wait for the next prompt
    }
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
    persistState(); // the user message is in the session file once the assistant has started
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
    persistState();
    if (current?.id) memory.store.appendToolCall({ turnId: current.id, name: event.toolName, input: JSON.stringify(event.input), result: JSON.stringify({ content: event.content, details: event.details }), status: event.isError ? "failure" : "success" });
  });
  pi.on("agent_settled", (_event, context) => {
    ensure(context); persistState();
    // Pi appended and flushed this turn's messages before settling: confirm what this prompt took.
    if (unconfirmed.deliveries.length) { memory.confirmDelivery(unconfirmed.deliveries); unconfirmed.deliveries = []; }
    if (unconfirmed.injected) { state.injected = true; unconfirmed.injected = false; save(); }
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
    const growth = turns.reduce((n, t) => n + tokens([t.userPrompt ?? "", t.assistantText ?? "",
      ...memory.store.listToolCalls(t.id).flatMap(c => [c.input ?? "", c.result ?? ""])].join("\n")), 0);
    const background = (kind: "recording" | "integration", promise: Promise<unknown>) => {
      pending.add(promise); activity.running.set(kind, (activity.running.get(kind) ?? 0) + 1); showSpend(context);
      void promise.then(result => reportProblems(result, context), error => { activity.last = "error"; context.ui.notify(String(error), "error"); })
        .finally(() => { pending.delete(promise); activity.running.set(kind, (activity.running.get(kind) ?? 1) - 1); showSpend(context); });
    };
    const recordingLaunch = launch("recording");
    // A branch run carries only its instruction (ruling 08:53): it presumes every earlier result is already
    // in the conversation. A result committed after this prompt started is not delivered until the next
    // prompt, so a branch run waits for that prompt's turn stop.
    // A branch Recorder reads earlier facts, so a pending fact delivery holds it; a branch Integrator reads
    // facts and current knowledge, so either pending kind holds it (user ruling 2026-09-07).
    const undelivered = new Set(memory.store.listPendingDeliveries(sessionId, branch).map(p => memory.store.getRun(p.runId)?.kind));
    const paused = (kind: "recording" | "integration", mode: string | undefined) =>
      mode === "branch" && (kind === "recording" ? undelivered.has("recording") : undelivered.size > 0);
    const due = answered >= memory.config.recording.triggerAnsweredTurns || growth >= memory.config.recording.triggerTokens;
    if (due && paused("recording", recordingLaunch.mode)) { activity.last = "warning"; showSpend(context); }
    if (due && !paused("recording", recordingLaunch.mode))
      background("recording", recording({ sessionId, branch, headTurnId: head, ...recordingLaunch }));
    const integrationLaunch = launch("integration");
    const count = memory.store.integrationBatch(sessionId, branch, memory.config.integration.triggerUnintegratedFacts).length;
    if (count >= memory.config.integration.triggerUnintegratedFacts && paused("integration", integrationLaunch.mode)) { activity.last = "warning"; showSpend(context); }
    if (count >= memory.config.integration.triggerUnintegratedFacts && !paused("integration", integrationLaunch.mode))
      background("integration", memory.integrate({ sessionId, branch, headTurnId: head, ...integrationLaunch }));
  });
  pi.on("session_before_tree", async (_event, context) => {
    ensure(context); flush(true);
    const { sessionId, branch, head } = state;
    if (!sessionId || !head) return { summary: { summary: "" } };
    let usage: Usage | undefined;
    try {
      // A pending run owns its frozen range. Later raw stays in the summary.
      const result = await recording({ sessionId, branch, headTurnId: head, mode: "subagent", model: modelName("recording") });
      reportProblems(result, context);
      // The switch's own recording cost rides on the branch summary, which Pi counts in the session totals.
      if ("runId" in result) { try { usage = JSON.parse(memory.store.getRun(result.runId)?.response ?? "{}").usage ?? undefined; } catch { usage = undefined; } }
    } catch (error) { context.ui.notify(String(error), "error"); }
    return { summary: { summary: memory.branchSummary(sessionId, branch, head), ...(usage ? { usage } : {}) } };
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
  // The main agent registers the façade metadata (same name, description, schema the runs send)
  // wrapped with an executor bound to the current session and turn.
  const definitions = toolDefinitions.map(definition => ({ ...definition, label: definition.name,
    async execute(_id: string, raw: unknown, _signal: unknown, _update: unknown, context: ExtensionContext) {
      ensure(context);
      if (!state.sessionId || !current?.id) throw new Error("A tool call requires an assistant reply and current turn");
      const bound = memory.tools({ kind: "manual", sessionId: state.sessionId, branch: state.branch, currentTurnId: current.id });
      const content = bound.find(t => t.name === definition.name)!.execute(raw);
      if (rejected(definition.name, content)) throw new Error(content);
      return result(content);
    } }) as unknown as ToolDefinition);
  for (const definition of definitions) pi.registerTool(definition);
  pi.registerCommand("trace", { description: "Read Trace Memory status without running extraction.",
    async handler(args, context) {
      ensure(context);
      const parts = args.trim().split(/\s+/);
      if (parts[0] === "project") {
        if (!state.sessionId) throw new Error("A session requires an assistant reply");
        const marked = memory.declareProject(state.sessionId, parts.slice(1).join(" "));
        state.projectId = memory.store.getSession(state.sessionId)!.projectId;
        state.project = memory.store.getProject(state.projectId)!.name;
        state.injected = false; save(); // the new project's knowledge is injected at the next prompt through the usual path
        context.ui.notify(marked, "info"); return;
      }
      if (parts[0] === "runs") {
        if (!state.sessionId) throw new Error("A session requires an assistant reply");
        const limit = Math.max(1, Number(parts[1] ?? 10) || 10);
        const runs = memory.store.listRuns(state.sessionId).slice(-limit).reverse();
        context.ui.notify(runs.length ? runs.map(r => memory.trace(`R${r.id}`).split("\n")[0]!).join("\n") : "Trace Memory: no runs yet.", "info"); return;
      }
      if (parts[0] === "mark") {
        if (!/^K[1-9]\d*(?:@[1-9]\d*)?$/.test(parts[1] ?? "") || parts.length !== 3 || !["verified", "flagged", "clear"].includes(parts[2]!)) throw new Error("Use /trace mark K<n>@<commit> verified|flagged|clear");
        context.ui.notify(memory.mark(parts[1]!, parts[2] as "verified" | "flagged" | "clear", state.sessionId ? { sessionId: state.sessionId, headTurnId: state.head ?? null } : undefined), "info"); return;
      }
      context.ui.notify(state?.sessionId ? memory.status(state.sessionId) : "Trace Memory: no assistant reply; no session id.", "info"); } });
}
