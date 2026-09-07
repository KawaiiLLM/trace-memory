import { existsSync, mkdirSync, readFileSync, writeFileSync, linkSync, unlinkSync, renameSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { homedir } from "node:os";
import { randomUUID } from "node:crypto";
import type { ExtensionAPI, ExtensionContext, ToolDefinition } from "@earendil-works/pi-coding-agent";
import { complete } from "@earendil-works/pi-ai/compat";
import { retryAssistantCall, type Tool, type ToolCall } from "@earendil-works/pi-ai";
import { buildRequest, verifyRequest, appendNativeRequest, verifyNativeRequest, messageKey, hash, snapshot, type Body, type Appended } from "./branch.ts";
import { DEFAULT_CONFIG, TraceMemory, enrollmentDefault, validateConfig, validateReadInput, tokens, renderEntry, toolDefinitions, type ConfigOverride, type NotingAgentInput, type ConsolidationAgentInput, type Enrollment } from "../../core/api/index.ts";

type Registry = ExtensionContext["modelRegistry"];
type Conversation = Parameters<Registry["complete"]>[1];
type Reply = Awaited<ReturnType<Registry["complete"]>>;
type FlatConfig = Record<string, string | number | boolean>;
const tag = "trace-memory";
const contextMargin = 0.85; // reserve 15% for the shared estimator and provider framing
const now = () => new Date().toISOString();
const text = (message: { content?: unknown }) => typeof message.content === "string" ? message.content
  : Array.isArray(message.content) ? message.content.filter(c => c.type === "text").map(c => c.text).join("\n") : "";

const agentDirectory = () => process.env.PI_CODING_AGENT_DIR ?? join(homedir(), ".pi", "agent");
function settings(cwd: string, agentDir = agentDirectory()) {
  const read = (path: string): Record<string, any> => {
    try { return JSON.parse(readFileSync(path, "utf8")); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return {}; throw new Error(`Invalid settings.json ${path}: ${String(error)}`); }
  };
  return { global: read(join(agentDir, "settings.json")), project: read(join(cwd, ".pi", "settings.json")) };
}
function configuration(cwd: string, environment = process.env.TRACE_MEMORY_CONFIG, agentDir = agentDirectory()) {
  const files = settings(cwd, agentDir);
  const layers = { Global: files.global[tag] ?? {}, Project: files.project[tag] ?? {}, Environment: JSON.parse(environment ?? "{}") };
  for (const [name, layer] of Object.entries(layers)) if (!layer || typeof layer !== "object" || Array.isArray(layer)) throw new Error(`Invalid trace-memory ${name}: expected an object`);
  const flat: FlatConfig = Object.assign({}, ...Object.values(layers));
  const sources: Record<string, string> = {};
  for (const [layer, values] of Object.entries(layers)) for (const key of Object.keys(values)) sources[key] = layer;

  const parse = (flat: FlatConfig) => {
    const core: ConfigOverride = {};
    for (const section of ["render", "noting", "consolidation"] as const) {
      const values: Record<string, number | boolean> = {};
      for (const [key, value] of Object.entries(DEFAULT_CONFIG[section])) {
        const override = flat[`${section}.${key}`];
        if (override !== undefined && (typeof override !== typeof value ||
          (typeof override === "number" && (!Number.isFinite(override) || override < 0)))) throw new Error(`Invalid ${section}.${key}`);
        values[key] = (override ?? value) as number | boolean;
      }
      Object.assign(core, { [section]: values });
    }
    for (const key of Object.keys(flat)) if (!["dbPath", "notingModel", "consolidationModel"].includes(key) &&
      !["render", "noting", "consolidation"].some(s => key.startsWith(`${s}.`) && Object.hasOwn(DEFAULT_CONFIG[s as keyof typeof DEFAULT_CONFIG], key.slice(s.length + 1)))) throw new Error(`Unknown setting ${key}`);
    for (const key of ["dbPath", "notingModel", "consolidationModel"]) if (flat[key] !== undefined && typeof flat[key] !== "string") throw new Error(`Invalid ${key}`);
    validateConfig(core);
    return core;
  };
  for (const values of Object.values(layers)) parse(values);
  const core = parse(flat);
  return { flat, core, sources, layers };
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
function retrySettings(cwd: string, agentDir: string) {
  type Retry = { enabled?: boolean; maxRetries?: number; baseDelayMs?: number; provider?: { timeoutMs?: number; maxRetries?: number; maxRetryDelayMs?: number } };
  const files = settings(cwd, agentDir);
  const global: Retry = files.global.retry ?? {}, project: Retry = files.project.retry ?? {};
  const retry: Retry = { ...global, ...project, provider: { ...global.provider, ...project.provider } }; // nested like Pi's own merge
  return { policy: { enabled: retry.enabled ?? true, maxRetries: retry.maxRetries ?? 3, baseDelayMs: retry.baseDelayMs ?? 2000 },
    provider: { timeoutMs: retry.provider?.timeoutMs, maxRetries: retry.provider?.maxRetries, maxRetryDelayMs: retry.provider?.maxRetryDelayMs ?? 60000 } };
}

export default function (pi: ExtensionAPI) {
  const environment = process.env.TRACE_MEMORY_CONFIG;
  const agentDir = agentDirectory();
  let { flat, core, sources, layers } = configuration(process.cwd());
  const dbPath = String(flat.dbPath ?? join(homedir(), ".trace-memory", "trace.db")).replace(/^~\//, `${homedir()}/`);
  if (dbPath !== ":memory:") mkdirSync(dirname(resolve(dbPath)), { recursive: true });
  let ctx: ExtensionContext;
  type Capture = { entries: { id: string; raw: string }[]; payload: Body; model: string; provider: string; branch: string };
  // One extension instance serves one Pi session: Pi tears the runtime down and re-runs the
  // factory on new/resume/fork, so the capture state is a single object.
  const session: { capture?: Capture; verified?: string; notified?: boolean } = {};
  const memory = TraceMemory(dbPath, async raw => {
    const input = raw as NotingAgentInput | ConsolidationAgentInput;
    const callContext = ctx;
    const callPiId = callContext.sessionManager.getSessionId();
    const registry = callContext.modelRegistry;
    const slash = input.model.indexOf("/");
    // The model is frozen with the run (a branch run freezes the session model at launch), so a
    // model switch during a two-round consolidation cannot redirect its final round.
    const current = callContext.model;
    const model = input.model === "session" || (current && `${current.provider}/${current.id}` === input.model) ? current
      : registry.find(input.model.slice(0, slash), input.model.slice(slash + 1));
    let request: unknown = null;
    let verification: (ReturnType<typeof verifyRequest> & { key: string; firstForKey: boolean; cache_read?: number; rounds: ReturnType<typeof verifyNativeRequest>[] }) | undefined;
    let fallbackReason: string | undefined;
    let mode: "branch" | "subagent" = "subagent";
    try {
      if (!model) throw new Error(`Unavailable model: ${input.model}`);
      const checkCapacity = (payload: unknown) => {
        if (input.kind !== "noting") return;
        const body = payload as Record<string, unknown>;
        const output = Math.max(model.maxTokens, ...["max_tokens", "max_output_tokens", "max_completion_tokens"]
          .map(key => typeof body[key] === "number" ? body[key] as number : 0));
        if (tokens(JSON.stringify(payload)) + output > Math.floor(model.contextWindow * contextMargin))
          throw new Error("Noting capacity: provider request exceeds model context with output reserved");
      };
      // One loop for both modes (pi-om's observer shape): handle a reply, execute its tool calls,
      // append the Consolidation feedback, call the model again until it stops. Only sending differs.
      // Each model call goes through Pi's retry helper with Pi's settings (the one Pi uses for its
      // own compaction and branch-summary calls): transient provider errors back off and retry;
      // tool execution and commits happen only after a reply, so a retry never repeats a write.
      const retry = retrySettings(callContext.cwd, agentDir);
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
          const feedback = input.kind === "consolidation" ? results.flatMap(r => { const f = reviewMessage(r.content[0]!.text); return f ? [{ role: "user" as const, content: f, timestamp: Date.now() }] : []; }) : [];
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
            if (input.kind === "noting" && input.entryIds.some(id => {
              const entry = memory.store.getSourceEntry(id)!;
              if (captured.entries.some(e => e.id === entry.nativeId && e.raw === entry.raw)) return false;
              // The unchanged branch suffix carries the head's natural-language reply in full.
              return entry.role !== "assistant" || entry.calls.length > 0 || !input.range.to.endsWith(`/T${entry.turnId}`);
            })) throw new Error("Captured prefix does not contain selected source entries");
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
                checkCapacity(candidate);
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
        return () => registry.complete(model, fixed, { ...retry.provider, onPayload(payload: unknown) { checkCapacity(payload); request = JSON.parse(JSON.stringify(payload)); input.reportRequest(request); } });
      });
      return { outcome: outcomeOf(reply), output: outputOf(reply), usage, request, mode, verification, fallbackReason, ...(retries.length ? { retries } : {}) };
    } catch (error) {
      return { outcome: error instanceof Error && error.name === "AbortError" ? "cancelled" : "failure", output: String(error), request, mode, verification, fallbackReason };
    }
  }, core);
  const contextNotice = (kind: string, reason: string) => ctx.ui.notify(`Trace Memory: ${kind} fell back to subagent mode. ${reason}`, "warning");
  type State = { enrollment?: { defaultEnabled: boolean; choice: boolean | null }; shared?: boolean; sourceHead?: number; originPiId?: string; sessionId?: number; projectId: number; branch: string; head?: number; piId: string; injected?: boolean; project?: string };
  let state: State;
  let baseline: string;
  const baselinePath = join(agentDir, "trace-memory-baseline.json");
  const enrollment = () => state.sessionId ? memory.store.enrollment(state.sessionId) : state.enrollment!;
  const enabled = () => { const e = enrollment(); return e.choice ?? e.defaultEnabled; };

  // Pi does not flush a new native file before its first assistant message. Keep the
  // provisional enrollment entry durable without manufacturing a reply or a Turn.
  const provisionalPath = () => join(agentDir, "trace-memory-enrollment", `${hash([dbPath, state.piId])}.json`);
  const provisional = (): Enrollment | undefined => {
    try {
      const value = JSON.parse(readFileSync(provisionalPath(), "utf8"));
      if (!value || typeof value.defaultEnabled !== "boolean" || (value.choice !== null && typeof value.choice !== "boolean")) throw new Error("Invalid provisional enrollment state");
      return value;
    }
    catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return; throw error; }
  };
  const persistProvisional = (value: Enrollment, replace = false) => {
    const path = provisionalPath(), temporary = `${path}.${randomUUID()}`;
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(temporary, JSON.stringify(value), { flag: "wx" });
    try { if (replace) renameSync(temporary, path); else linkSync(temporary, path); }
    catch (error) { if (replace || (error as NodeJS.ErrnoException).code !== "EEXIST") throw error; }
    finally { if (existsSync(temporary)) unlinkSync(temporary); }
  };
  let current: { started: string; id?: number } | undefined;
  // What this agent run has shown the model and must confirm when it settles. Kept apart from
  // `current`, which a queued (steering or follow-up) user message replaces mid-run.
  const unconfirmed: { deliveries: number[]; injected: boolean } = { deliveries: [], injected: false };
  const pending = new Set<Promise<unknown>>();
  const modelName = (kind: "noting" | "consolidation") => String(flat[`${kind}Model`] && flat[`${kind}Model`] !== "session"
    ? flat[`${kind}Model`] : ctx.model ? `${ctx.model.provider}/${ctx.model.id}` : "session");
  // Ruling 17:01: noting and consolidation each configure their mode (noting defaults to branch, consolidation to
  // subagent); branch mode always runs on the session model, subagent mode on the configured one.
  const launch = (kind: "noting" | "consolidation") => {
    const branch = kind === "noting" ? memory.config.noting.branchModeDefault : !memory.config.consolidation.subagentModeDefault;
    return { mode: branch ? "branch" as const : "subagent" as const, model: branch ? (ctx.model ? `${ctx.model.provider}/${ctx.model.id}` : "session") : modelName(kind) };
  };
  // A committed run may still carry problems (audit update or provider failure after the commit): warn, keep success.
  // The plugin's own model spend as a footer status item (Pi's setStatus, the shape ponytail uses);
  // background runs never enter Pi's session totals, which only count entries of the session file.
  // Footer status item (user ruling 2026-09-07): one indicator in Pi theme colours — dim ○ idle,
  // accent ● noting running, success ● consolidation running, warning ● paused or committed with
  // problems, error ● the last run failed — then today's plugin spend as ☉ $x.xx, reset daily.
  const activity = { running: new Map<"noting" | "consolidation", number>(), retrying: false, last: "ok" as "ok" | "warning" | "error" };
  const runningKind = (kind: "noting" | "consolidation") => (activity.running.get(kind) ?? 0) > 0;
  const showSpend = (context: ExtensionContext) => {
    if (!context.ui?.setStatus) return;
    const theme = (context.ui as { theme?: { fg?: (color: string, text: string) => string } }).theme;
    const paint = (color: string, text: string) => { try { return theme?.fg ? theme.fg(color, text) : text; } catch { return text; } };
    const indicator = !enabled() ? paint("dim", "○") : activity.retrying ? paint("warning", "●") : runningKind("noting") ? paint("accent", "●") : runningKind("consolidation") ? paint("success", "●")
      : activity.last === "error" ? paint("error", "●") : activity.last === "warning" ? paint("warning", "●") : paint("dim", "○");
    // Fixed reading (user ruling 2026-09-07): applicable current knowledge / facts on this branch;
    // $ = this session's cumulative spend.
    let facts = 0, knowledge = 0, cost = 0;
    if (state?.sessionId) {
      facts = memory.store.listBranchFacts(state.sessionId, state.branch, state.head).length;
      knowledge = memory.store.listCurrentKnowledge({ sessionId: state.sessionId, headTurnId: state.head ?? null }).length;
      cost = memory.spend(state.sessionId).cost;
    }
    context.ui.setStatus("trace-memory", `🧠 ${indicator} trace-memory${enabled() ? "" : " Disabled"} ${knowledge}/${facts} $${cost.toFixed(2)}`);
  };
  const reportProblems = (result: unknown, context: ExtensionContext) => {
    const r = result as { outcome?: string; problems?: string[] } | undefined;
    if (r?.outcome === "dropped") return; // a duplicate trigger says nothing about the run still in flight
    activity.last = r?.outcome === "failure" || r?.outcome === "cancelled" ? "error" : r?.outcome === "bounced" || r?.problems?.length ? "warning" : "ok";
    showSpend(context);
    if (r?.outcome === "success" && r.problems?.length) context.ui.notify(`Trace Memory: committed with problems. ${r.problems.join("; ")}`, "warning");
  };
  let savedSourceHead: number | undefined;
  const save = () => { pi.appendEntry(tag, { ...state, dbPath }); savedSourceHead = state.sourceHead; };
  const restore = (context: ExtensionContext, fork = false) => {
    ctx = context;
    const loaded = configuration(ctx.cwd, environment, agentDir);
    if (loaded.flat.dbPath !== flat.dbPath) throw new Error("dbPath changed; reload the extension to reopen the database");
    ({ flat, core, sources, layers } = loaded);
    Object.assign(memory.config, validateConfig(core));
    marker(ctx.cwd); // An invalid initialization must not establish the baseline.
    if (!baseline) {
      mkdirSync(dirname(baselinePath), { recursive: true });
      const temporary = `${baselinePath}.${randomUUID()}`;
      writeFileSync(temporary, JSON.stringify(now()), { flag: "wx" });
      try { linkSync(temporary, baselinePath); }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error; }
      finally { unlinkSync(temporary); }
      baseline = JSON.parse(readFileSync(baselinePath, "utf8"));
      if (typeof baseline !== "string" || !Number.isFinite(Date.parse(baseline))) throw new Error("Invalid Trace Memory baseline");
    }
    const saved = ctx.sessionManager.getBranch().filter(e => e.type === "custom" && e.customType === tag)
      .map(e => (e as { data: State & { dbPath: string } }).data).filter(d => d.dbPath === dbPath).at(-1);
    const piId = ctx.sessionManager.getSessionId();
    // A tree switch invalidates the old branch body, even when returning to a saved head.
    session.capture = undefined;
    if (saved) {
      const tip = ctx.sessionManager.getEntries().filter(e => e.type === "custom" && e.customType === tag)
        .map(e => (e as { data: State & { dbPath: string } }).data)
        .filter(d => d.dbPath === dbPath && d.sessionId === saved.sessionId && d.branch === saved.branch).at(-1);
      state = { ...saved, piId, branch: (fork && (tip?.head !== saved.head || tip?.sourceHead !== saved.sourceHead)) || saved.piId !== piId ? randomUUID() : saved.branch };
    } else {
      const name = marker(ctx.cwd);
      const project = name && memory.store.findProjectByName(name);
      state = { projectId: project ? project.id : memory.store.createProject({ name: name ?? `pi:${piId}`, declaredBy: "marker" }).id, branch: "main", piId };
    }
    // Branch history restores position only; the database and latest provisional choice own intent.
    const latest = ctx.sessionManager.getEntries().filter(e => e.type === "custom" && e.customType === tag)
      .map(e => (e as { data: State & { dbPath: string } }).data).filter(d => d.dbPath === dbPath && d.piId === piId).at(-1);
    if (!state.sessionId && latest?.sessionId) {
      state.sessionId = latest.sessionId;
      state.originPiId = latest.originPiId;
      state.branch = randomUUID();
    }
    state.enrollment = state.sessionId ? memory.store.enrollment(state.sessionId)
      : provisional() ?? latest?.enrollment ?? saved?.enrollment ?? { defaultEnabled: enrollmentDefault(ctx.sessionManager.getHeader()?.timestamp, baseline), choice: null };
    if (!state.sessionId) { persistProvisional(state.enrollment); state.enrollment = provisional()!; }
    state.shared = state.shared || (!!state.sessionId && memory.store.getSession(state.sessionId)!.host !== `pi:${piId}`);
    current = undefined;
    reconciledLeaf = undefined;
    reconcile(false);
    showSpend(ctx);
    if (state.sessionId) {
      const name = marker(ctx.cwd);
      if (name) memory.declareProject(state.sessionId, name, "marker");
      state.projectId = memory.store.getSession(state.sessionId)!.projectId;
      if (memory.store.projectDeclaration(state.sessionId) === "mark") state.project = memory.store.getProject(state.projectId)!.name;
    }
    save(); // Provisional intent is durable before the first reply, too.
  };
  const ensure = (context: ExtensionContext) => { ctx = context; if (!state || state.piId !== context.sessionManager.getSessionId()) restore(context); };
  const allocate = (started: string) => {
    if (state.sessionId) return;
    const name = marker(ctx.cwd);
    if (!name) state.projectId = (memory.store.findProjectByName(`pi:${state.piId}`)
      ?? memory.store.createProject({ name: `pi:${state.piId}`, declaredBy: "marker" })).id;
    state.sessionId = memory.store.createSession({ host: `pi:${state.piId}`, startedAt: started, firstReplyAt: now(), projectId: state.projectId, projectDeclaration: name ? "marker" : "undeclared", nativeCreatedAt: ctx.sessionManager.getHeader()?.timestamp, baseline, enrollmentChoice: (provisional() ?? state.enrollment!).choice }).id;
    state.originPiId = state.piId;
    if (name) memory.declareProject(state.sessionId, name, "marker");
    try { unlinkSync(provisionalPath()); } catch { /* no receipt, or already consumed */ } // the store owns enrollment from here
  };
  const historyProblems = new Set<string>();
  const missing = (problem: string) => {
    if (!historyProblems.has(problem)) { historyProblems.add(problem); ctx.ui.notify(`Trace Memory: missing native history: ${problem}`, "warning"); }
  };
  // Pi persists AFTER message_end extension hooks. Only the ancestry supplies native identities.
  // The walk is linear in the ancestry with one lookup per entry, and hooks fire on every streaming
  // update, so it runs only when the persisted leaf has moved (10 ms per update at 400 entries otherwise).
  let reconciledLeaf: string | null | undefined;
  const reconcile = (check = true) => {
    if (!enabled()) return;
    const leaf = ctx.sessionManager.getLeafId();
    if (state.sessionId && leaf === reconciledLeaf) return;
    const previous = state.sourceHead;
    walk();
    // A walk before the memory session exists creates no Turn; the first walk after allocation must run.
    reconciledLeaf = state.sessionId ? leaf : undefined;
    if (check && state.sourceHead !== previous && state.sourceHead !== undefined) checkQueues();
  };
  const walk = () => memory.store.transaction(() => {
    const ancestry = ctx.sessionManager.getBranch();
    if (!state.sessionId && ancestry.some(e => e.type === "message" && e.message.role === "assistant" &&
      (text(e.message) || e.message.content.some(c => c.type === "toolCall" || c.type === "thinking")))) allocate(ancestry[0]?.timestamp ?? now());
    if (!state.sessionId) return;
    let lineage = state.originPiId ?? state.piId;
    let turnId: number | undefined;
    const selected: number[] = [], seen = new Set<string>();
    for (const entry of ancestry) {
      if (entry.parentId && !seen.has(entry.parentId)) missing(`parent ${entry.parentId} before ${entry.id}`);
      seen.add(entry.id);
      if (entry.type === "custom" && entry.customType === tag) {
        const data = entry.data as State & { dbPath?: string };
        if (data.dbPath === dbPath) lineage = data.piId;
        continue;
      }
      if (entry.type !== "message") continue;
      const message = entry.message;
      if (message.role !== "user" && message.role !== "assistant" && message.role !== "toolResult") continue;
      const natural = message.role === "toolResult" ? "" : text(message);
      const calls = message.role === "assistant" ? message.content.filter(c => c.type === "toolCall") : [];
      // A user message is a Turn boundary whatever it carries (an image-only message has no text); only an
      // assistant message with neither text nor tool calls is nothing (review 2026-09-08).
      if (!natural && !calls.length && message.role === "assistant") continue;
      const known = memory.store.findSourceEntry(state.sessionId, lineage, entry.id);
      if (known) {
        if (known.raw !== JSON.stringify(message)) missing(`entry ${entry.id} changed after persistence`);
        selected.push(known.id); turnId = known.turnId; continue;
      }
      if (message.role === "user") {
        turnId = memory.store.appendTurn({ sessionId: state.sessionId, parentTurnId: turnId ?? null, kind: "turn", userPrompt: natural, startedAt: entry.timestamp }).id;
      }
      if (!turnId) { missing(`owning user entry for ${entry.id}`); continue; }
      const fragments: Parameters<typeof memory.appendEntry>[0]["calls"] = [];
      for (const call of calls) {
        const input = JSON.stringify(call.arguments);
        const stored = memory.store.appendToolCall({ turnId, name: call.name, input, status: "attempted" });
        fragments.push({ ordinal: stored.ordinal, name: call.name, callId: call.id, input, status: "attempted" });
      }
      if (message.role === "toolResult") {
        const call = selected.map(id => memory.store.getSourceEntry(id)!).reverse()
          .filter(e => e.turnId === turnId && e.role === "assistant").flatMap(e => e.calls).find(c => c.callId === message.toolCallId);
        if (!call) { missing(`tool call ${message.toolCallId} for ${entry.id}`); continue; }
        const result = JSON.stringify({ content: message.content, details: message.details });
        const status = message.isError ? "failure" : "success";
        memory.store.completeToolCall(turnId, call.ordinal, result, status);
        fragments.push({ ordinal: call.ordinal, name: call.name, callId: call.callId, result, status });
      }
      const stored = memory.appendEntry({ sessionId: state.sessionId, nativeLineage: lineage, nativeId: entry.id, turnId,
        role: message.role, text: natural, raw: JSON.stringify(message), calls: fragments });
      selected.push(stored.id);
      if (message.role === "assistant") {
        const value = memory.store.getTurn(turnId)!;
        memory.store.updateTurn(turnId, { assistantText: [value.assistantText, natural].filter(Boolean).join("\n") });
      }
    }
    if (state.head && !turnId && memory.store.listSourceEntries(state.sessionId).length) missing("selected ancestry contains no available source entries");
    memory.selectEntries(state.sessionId, state.branch, selected);
    state.sourceHead = selected.at(-1);
    if (turnId) { state.head = turnId; if (current) current.id = turnId; }
  });
  const persistState = () => { reconcile(); if (state.sessionId && state.sourceHead !== savedSourceHead) save(); };
  const flush = (ended = false) => { reconcile(false); if (enabled() && ended && current?.id) memory.store.updateTurn(current.id, { endedAt: now() }); };
  pi.on("before_provider_request", (event, context) => {
    ensure(context);
    if (!enabled()) { showSpend(context); return; }
    const previous = state.sourceHead;
    reconcile(false);
    const ancestry = context.sessionManager.getBranch();
    // Persisted originals before a context reset are not proof that the provider received them.
    const reset = ancestry.reduce((last, e, i) => e.type === "compaction" || e.type === "branch_summary" ? i : last, -1);
    if (context.model) session.capture = { entries: ancestry.slice(reset + 1).filter(e => e.type === "message").map(e => ({ id: e.id, raw: JSON.stringify(e.message) })), payload: snapshot(event.payload) as Body,
      model: context.model.id, provider: context.model.provider, branch: state.branch };
    if (state.sourceHead !== previous && state.sourceHead !== undefined) checkQueues();
  });
  pi.on("session_start", (_event, context) => restore(context));
  pi.on("session_tree", (_event, context) => { restore(context, true); state.injected = false; save(); });
  pi.on("before_agent_start", (event, context) => {
    ensure(context);
    current = { started: now() };
    if (!enabled()) { showSpend(context); return; }
    reconcile();
    // Knowledge once per session (the compaction block carries them afterwards); deliveries on every prompt.
    // Both are confirmed at this turn's agent_settled, after Pi has persisted the message (ruling
    // 2026-09-07): a turn that never settles injects or delivers again; duplicates over silent loss.
    const parts: string[] = [];
    if (!state.injected) {
      const block = memory.inject(state.sessionId ? { sessionId: state.sessionId, headTurnId: state.head ?? null, branch: state.branch } : { projectId: state.projectId });
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
    ensure(context); reconcile();
    if (event.message.role === "user") {
      flush(true);
      current = { started: now() };
      reconcile();
    }
  });
  const assistant = (message: { content?: unknown }, context: ExtensionContext) => {
    ensure(context);
    if (!enabled()) return;
    persistState(); // the user message is in the session file once the assistant has started
    if (!current || (!text(message) && (!Array.isArray(message.content) ||
      !message.content.some(c => c.type === "toolCall" || (c.type === "thinking" && c.thinking))))) return;
    allocate(current.started);
    reconcile();
  };
  pi.on("message_update", (event, context) => { if (event.message.role === "assistant") assistant(event.message, context); });
  pi.on("message_end", (event, context) => { if (event.message.role === "assistant") assistant(event.message, context); });
  pi.on("tool_result", (_event, context) => { ensure(context); persistState(); });
  pi.on("agent_end", (_event, context) => { ensure(context); persistState(); });
  pi.on("agent_settled", (_event, context) => {
    ensure(context); persistState();
    if (!enabled()) { unconfirmed.deliveries = []; unconfirmed.injected = false; showSpend(context); return; }
    // Pi appended and flushed this turn's messages before settling: confirm what this prompt took.
    if (unconfirmed.deliveries.length) { memory.confirmDelivery(unconfirmed.deliveries); unconfirmed.deliveries = []; }
    if (unconfirmed.injected) { state.injected = true; unconfirmed.injected = false; save(); }
    if (!state.sessionId || !state.head) return;
    if (current?.id && memory.store.getTurn(current.id)?.assistantText !== null) flush(true);
  });
  const checkQueues = () => {
    if (!enabled()) return;
    if (!state.sessionId || !state.head) return;
    const context = ctx;
    const { sessionId, branch, head } = state;
    const background = (kind: "noting" | "consolidation", promise: Promise<unknown>) => {
      pending.add(promise); activity.running.set(kind, (activity.running.get(kind) ?? 0) + 1); showSpend(context);
      void promise.then(result => reportProblems(result, context), error => { activity.last = "error"; context.ui.notify(String(error), "error"); })
        .finally(() => { pending.delete(promise); activity.running.set(kind, (activity.running.get(kind) ?? 1) - 1); showSpend(context); });
    };
    const count = memory.store.consolidationBatch(sessionId, branch, head).length;
    const notingLaunch = launch("noting");
    // A branch run carries only its instruction (ruling 08:53): it presumes every earlier result is already
    // in the conversation. A result committed after this prompt started is not delivered until the next
    // prompt, so a branch run waits for that prompt's turn stop.
    // A branch Noter reads earlier facts, so a pending fact delivery holds it; a branch Consolidator reads
    // facts and current knowledge, so either pending kind holds it (user ruling 2026-09-07).
    const undelivered = new Set(memory.store.listPendingDeliveries(sessionId, branch).map(p => memory.store.getRun(p.runId)?.kind));
    const paused = (kind: "noting" | "consolidation", mode: string | undefined) =>
      mode === "branch" && (kind === "noting" ? undelivered.has("noting") : undelivered.size > 0);
    let due = false;
    try { due = tokens(memory.pendingEntries(sessionId, branch, head).map(e => renderEntry(e, memory.config.render).content).join("\n\n")) >= memory.config.noting.triggerTokens; }
    catch (error) { context.ui.notify(String(error), "error"); }
    if (due && paused("noting", notingLaunch.mode)) { activity.last = "warning"; showSpend(context); }
    if (due && !paused("noting", notingLaunch.mode)) {
      const [provider, ...id] = notingLaunch.model.split("/");
      const model = notingLaunch.model === "session" || notingLaunch.model === `${context.model?.provider}/${context.model?.id}` ? context.model : context.modelRegistry.find(provider!, id.join("/"));
      if (!model || !Number.isFinite(model.contextWindow) || !Number.isFinite(model.maxTokens)) context.ui.notify("Noting capacity: unavailable model context/output limits; left pending", "error");
      else background("noting", memory.noting({ sessionId, branch, headTurnId: head, ...notingLaunch,
        capacity: { inputTokens: Math.max(0, Math.floor(model.contextWindow * contextMargin) - model.maxTokens),
          prefixTokens: notingLaunch.mode === "branch" && session.capture?.branch === branch ? tokens(JSON.stringify(session.capture.payload)) : 0 } }));
    }
    const consolidationLaunch = launch("consolidation");
    if (count >= memory.config.consolidation.triggerUnconsolidatedFacts && paused("consolidation", consolidationLaunch.mode)) { activity.last = "warning"; showSpend(context); }
    if (count >= memory.config.consolidation.triggerUnconsolidatedFacts && !paused("consolidation", consolidationLaunch.mode))
      background("consolidation", memory.consolidate({ sessionId, branch, headTurnId: head, ...consolidationLaunch }));
  };
  pi.on("session_before_tree", async (_event, context) => {
    ensure(context); if (!enabled()) return; flush(true);
    const { sessionId, branch, head } = state;
    if (!sessionId || !head) return { summary: { summary: "" } };
    return { summary: { summary: memory.branchSummary(sessionId, branch, head) } };
  });
  pi.on("session_before_compact", (event, context) => {
    ensure(context); if (!enabled()) return; flush();
    return { compaction: { summary: state.sessionId ? memory.compact(state.sessionId, state.branch, state.head) : memory.inject({ projectId: state.projectId }),
      firstKeptEntryId: "", tokensBefore: event.preparation.tokensBefore } };
  });
  pi.on("session_compact", event => {
    if (enabled() && state.sessionId) {
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
    if (state) flush(true);
    await Promise.allSettled([...pending]);
    memory.close();
  });
  const result = (value: string) => ({ content: [{ type: "text" as const, text: value }], details: {} });
  // The main agent registers the façade metadata (same name, description, schema the runs send)
  // wrapped with an executor bound to the current session and turn.
  const definitions = toolDefinitions.map(definition => ({ ...definition, label: definition.name,
    async execute(_id: string, raw: unknown, _signal: unknown, _update: unknown, context: ExtensionContext) {
      ensure(context); reconcile();
      if (definition.name === "trace" || definition.name === "search") {
        const input = validateReadInput(definition.name, raw);
        const options = { ...input, sessionId: state.sessionId, headTurnId: state.head };
        return result(definition.name === "trace" ? memory.trace(input.address as string, options)
          : memory.search(input.query as string, input.layer as import("../../core/api/index.ts").SearchScope, options));
      }
      if (!enabled()) throw new Error("Trace Memory is Disabled; use /trace enable to enable memory.");
      if (!state.sessionId || !current?.id) throw new Error("A tool call requires an assistant reply and current turn");
      const bound = memory.tools({ kind: "manual", sessionId: state.sessionId, branch: state.branch, currentTurnId: current.id });
      const content = bound.find(t => t.name === definition.name)!.execute(raw);
      if (rejected(definition.name, content)) throw new Error(content);
      return result(content);
    } }) as unknown as ToolDefinition);
  for (const definition of definitions) pi.registerTool(definition);
  const status = () => {
    const e = enrollment();
    return state.sessionId ? memory.status(state.sessionId) : `Enrollment: ${enabled() ? "Enabled" : "Disabled"} (${e.choice === null ? "default" : "explicit choice"})\nTrace Memory: no assistant reply; no session id.`;
  };
  const toggle = (value: boolean) => {
    if (state.sessionId) memory.store.setEnrollment(state.sessionId, value);
    else { state.enrollment = { ...enrollment(), choice: value }; persistProvisional(state.enrollment, true); }
    state.injected = false;
    unconfirmed.deliveries = []; unconfirmed.injected = false;
    save();
    reconciledLeaf = undefined;
    if (value) { reconcile(false); save(); }
    showSpend(ctx);
    ctx.ui.notify(`${status()}\n${value ? "Available history, including the paused interval, is queued; ordinary completions check thresholds." : "Processing and future injection are paused. Stored memory and already-injected text remain."}`, "info");
  };
  const commands = "/trace enable | disable | status | runs [n] | project <name> | mark K<n>@<commit> verified|flagged|clear";
  const runView = (limit = 10) => {
    const runs = state.sessionId ? memory.store.listRuns(state.sessionId).slice(-limit).reverse() : [];
    ctx.ui.notify(runs.length ? runs.map(r => memory.trace(`R${r.id}`).split("\n")[0]!).join("\n") : "Trace Memory: no runs yet.", "info");
  };
  const menu = async () => {
    const selected = await ctx.ui.select("Trace Memory", ["Current session", "Settings (Global, read-only)", "Runs", "Status"]);
    if (selected === "Current session") {
      const action = enabled() ? "Disable" : "Enable";
      const shared = state.shared ? " Shared identity: this switch also affects forks or clones carrying this memory identity." : " Forks or clones carrying this memory identity share this switch.";
      const choice = await ctx.ui.select(`${status()}${shared}`, [action]);
      if (choice && await ctx.ui.confirm(`${action} Trace Memory?`, shared + (action === "Disable"
        ? " Processing and future injection stop; stored memory and already-injected text remain."
        : " Available history, including the paused interval, will be queued without a model call."))) toggle(action === "Enable");
    } else if (selected === "Settings (Global, read-only)") {
      const defaults = { dbPath: "~/.trace-memory/trace.db", notingModel: "session", consolidationModel: "session",
        ...Object.fromEntries(Object.entries(DEFAULT_CONFIG).flatMap(([s, values]) => Object.entries(values).map(([k, v]) => [`${s}.${k}`, v]))) };
      ctx.ui.notify("Settings — Global, read-only (project and environment overrides apply)\n" + Object.entries(defaults).map(([key, fallback]) => {
        const masked = Object.entries(layers).filter(([layer, values]) => layer !== sources[key] && Object.hasOwn(values, key)).map(([layer, values]) => `${layer}=${JSON.stringify(values[key])} masked`);
        return `${key}: ${JSON.stringify(flat[key] ?? fallback)} (${sources[key] ?? "Default"})${masked.length ? `; ${masked.join("; ")}` : ""}`;
      }).join("\n"), "info");
    } else if (selected === "Runs") {
      const count = await ctx.ui.input("Runs: number to show", "10");
      if (count !== undefined) runView(Math.max(1, Number(count) || 10));
    } else if (selected === "Status") ctx.ui.notify(status(), "info");
  };
  pi.registerCommand("trace", { description: "Trace Memory enrollment, read-only settings, runs and status.",
    async handler(args, context) {
      ensure(context);
      if (!args.trim()) { if (context.hasUI) await menu(); else context.ui.notify(`${status()}\n${commands}`, "info"); return; }
      const parts = args.trim().split(/\s+/);
      if (parts[0] === "enable" || parts[0] === "disable") { toggle(parts[0] === "enable"); return; }
      if (parts[0] === "project") {
        if (!state.sessionId) throw new Error("A session requires an assistant reply");
        const marked = memory.declareProject(state.sessionId, parts.slice(1).join(" "));
        state.projectId = memory.store.getSession(state.sessionId)!.projectId;
        state.project = memory.store.getProject(state.projectId)!.name;
        state.injected = false; save(); // the new project's knowledge is injected at the next prompt through the usual path
        context.ui.notify(marked, "info"); return;
      }
      if (parts[0] === "runs") {
        runView(Math.max(1, Number(parts[1] ?? 10) || 10)); return;
      }
      if (parts[0] === "mark") {
        if (!/^K[1-9]\d*(?:@[1-9]\d*)?$/.test(parts[1] ?? "") || parts.length !== 3 || !["verified", "flagged", "clear"].includes(parts[2]!)) throw new Error("Use /trace mark K<n>@<commit> verified|flagged|clear");
        context.ui.notify(memory.mark(parts[1]!, parts[2] as "verified" | "flagged" | "clear", state.sessionId ? { sessionId: state.sessionId, headTurnId: state.head ?? null } : undefined), "info"); return;
      }
      context.ui.notify(status(), "info"); } });
}
