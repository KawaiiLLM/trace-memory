import { existsSync, mkdirSync, readFileSync, writeFileSync, linkSync, unlinkSync, renameSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { homedir } from "node:os";
import { randomUUID } from "node:crypto";
import type { ExtensionAPI, ExtensionContext, ToolDefinition } from "@earendil-works/pi-coding-agent";
import { hash, snapshot, type Body } from "./fork.ts";
import { runNative, checkpointReadiness, NotForkable, type NativeForkTask, type Verification as NativeVerification } from "./native.ts";
import { CONFIG_ALIASES, DEFAULT_CONFIG, TraceMemory, canonicalFlatConfig, enrollmentDefault, validateConfig, validateReadInput, tokens, toolDefinitions, type ConfigOverride, type NotingAgentInput, type ConsolidationAgentInput, type Enrollment, type ResultExtractor } from "../../core/api/index.ts";

type FlatConfig = Record<string, string | number | boolean>;
type NativeModel = NativeForkTask["model"];
const tag = "trace-memory";
const contextMargin = 0.85; // reserve 15% for the shared estimator and provider framing
const now = () => new Date().toISOString();
const text = (message: { content?: unknown }) => typeof message.content === "string" ? message.content
  : Array.isArray(message.content) ? message.content.filter(c => c.type === "text").map(c => c.text).join("\n") : "";

/** Ticket 23 "Host contract": this adapter's result-text extractor, registered with the façade at
 * construction. It unwraps the `{content, details}` result this host stores: the text blocks joined,
 * every other block marked by its type, and `details` reported as dropped structured data with its
 * serialized size — core marks the size, never the content. Evidence is unchanged: the raw message and
 * the raw result are stored exactly as before and `trace` with `full` still renders them uncut. Edit
 * diffs live only in `details`, so they leave the Noter view with a marker in their place. */
export const piResultText: ResultExtractor = (result) => {
  let envelope: { content?: unknown; details?: unknown };
  try { envelope = JSON.parse(result); } catch { return { text: result }; }
  if (!envelope || typeof envelope !== "object" || Array.isArray(envelope)) return { text: result };
  const blocks = Array.isArray(envelope.content) ? envelope.content as { type?: string; text?: unknown }[] : [];
  const text = Array.isArray(envelope.content)
    ? blocks.map(block => block?.type === "text" ? String(block.text ?? "") : `[${block?.type ?? "unknown"} omitted]`).join("\n")
    : typeof envelope.content === "string" ? envelope.content : "";
  const details = envelope.details;
  const empty = details == null || (typeof details === "object" && !Object.keys(details as object).length);
  return { text, ...(empty ? {} : { details: JSON.stringify(details) }) };
};

const agentDirectory = () => process.env.PI_CODING_AGENT_DIR ?? join(homedir(), ".pi", "agent");
function settings(cwd: string, agentDir = agentDirectory()) {
  const read = (path: string): Record<string, any> => {
    try { return JSON.parse(readFileSync(path, "utf8")); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return {}; throw new Error(`Invalid settings.json ${path}: ${String(error)}`); }
  };
  return { global: read(join(agentDir, "settings.json")), project: read(join(cwd, ".pi", "settings.json")) };
}
// Host settings that are not core config sections. `runsDir` places the native worker logs
// (default: dbPath's directory/runs). 19c deleted `nativeRunner`: the native runner is the only
// runner, so the key no longer selects anything and 18a's unknown-key rule rejects it like any
// other misspelling instead of silently accepting a setting that does nothing.
const hostStrings = ["dbPath", "notingModel", "consolidationModel", "runsDir"];
function configuration(cwd: string, environment = process.env.TRACE_MEMORY_CONFIG, agentDir = agentDirectory()) {
  const files = settings(cwd, agentDir);
  const supplied = { Global: files.global[tag] ?? {}, Project: files.project[tag] ?? {}, Environment: JSON.parse(environment ?? "{}") };
  for (const [name, layer] of Object.entries(supplied)) if (!layer || typeof layer !== "object" || Array.isArray(layer)) throw new Error(`Invalid trace-memory ${name}: expected an object`);
  // Ticket 19 "Legacy input": every layer's legacy execution-mode key (`noting.branchModeDefault`)
  // is mapped onto the canonical one by core's own alias table, keeping that layer as its source, so
  // an existing settings.json keeps working and the read-only menu shows the canonical key. A layer
  // supplying both spellings with different values fails the load naming both keys. Layers still
  // mask one another exactly as before, so a project layer may override a global legacy spelling.
  const layers = Object.fromEntries(Object.entries(supplied).map(([name, values]) => [name, canonicalFlatConfig(values as FlatConfig)])) as Record<keyof typeof supplied, FlatConfig>;
  const spelling: Record<string, string> = {};
  for (const values of Object.values(supplied)) for (const key of Object.keys(values)) spelling[CONFIG_ALIASES[key] ?? key] = key;
  // A value rejected under an accepted legacy spelling names the key the user actually wrote (18a).
  const named = (key: string) => spelling[key] && spelling[key] !== key ? `${key} (supplied as ${spelling[key]})` : key;
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
          (typeof override === "number" && (!Number.isFinite(override) || override < 0)))) throw new Error(`Invalid ${named(`${section}.${key}`)}`);
        values[key] = (override ?? value) as number | boolean;
      }
      Object.assign(core, { [section]: values });
    }
    for (const key of Object.keys(flat)) if (!hostStrings.includes(key) &&
      !["render", "noting", "consolidation"].some(s => key.startsWith(`${s}.`) && Object.hasOwn(DEFAULT_CONFIG[s as keyof typeof DEFAULT_CONFIG], key.slice(s.length + 1)))) throw new Error(`Unknown setting ${key}`);
    for (const key of hostStrings) if (flat[key] !== undefined && typeof flat[key] !== "string") throw new Error(`Invalid ${key}`);
    validateConfig(core);
    return core;
  };
  for (const values of Object.values(layers)) parse(values);
  const core = parse(flat);
  return { flat, core, sources, layers };
}
function rejected(name: string, content: string): boolean {
  if (content.startsWith("rejected:")) return true;
  if (name !== "note" && name !== "memory") return false;
  try {
    const { results } = JSON.parse(content);
    return Array.isArray(results) && results.some(r => typeof r === "string" && r.startsWith("rejected:"));
  } catch { return false; }
}

// 19c gate 6: retry and provider policy are Pi's own, read by the `SettingsManager` the native child
// is built with (hosts/pi/native.ts). The handwritten `retry` merge that used to live here — and its
// stale "a value import of SettingsManager needs pi-server" comment — went with the request-copy
// runner; nothing in this adapter reads or duplicates Pi's runtime settings any more.

export default function (pi: ExtensionAPI) {
  const environment = process.env.TRACE_MEMORY_CONFIG;
  const agentDir = agentDirectory();
  let { flat, core, sources, layers } = configuration(process.cwd());
  const dbPath = String(flat.dbPath ?? join(homedir(), ".trace-memory", "trace.db")).replace(/^~\//, `${homedir()}/`);
  if (dbPath !== ":memory:") mkdirSync(dirname(resolve(dbPath)), { recursive: true });
  // Ruling 19:5 — native worker logs live next to the database, never in Pi's own sessions
  // directory (which /resume scans) and never in the project tree. Retention is a v1 limit.
  const runsDirectory = (piId: string) => join(resolve(String(flat.runsDir ?? join(dirname(resolve(dbPath === ":memory:" ? join(homedir(), ".trace-memory", "trace.db") : dbPath)), "runs")).replace(/^~\//, `${homedir()}/`)), piId);
  let ctx: ExtensionContext;
  let closed = false;
  type Capture = { payload: Body; model: string; provider: string; branch: string };
  // One extension instance serves one Pi session: Pi tears the runtime down and re-runs the
  // factory on new/resume/fork, so the capture state is a single object.
  const session: { capture?: Capture; notified?: boolean } = {};
  const memory = TraceMemory(dbPath, async raw => {
    const input = raw as NotingAgentInput | ConsolidationAgentInput;
    const callContext = ctx;
    const callPiId = callContext.sessionManager.getSessionId();
    const registry = callContext.modelRegistry;
    const slash = input.model.indexOf("/");
    // The model is frozen with the run (a fork run freezes the session model at launch), so a
    // model switch during a two-round consolidation cannot redirect its final round.
    const current = callContext.model;
    const model = input.model === "session" || (current && `${current.provider}/${current.id}` === input.model) ? current
      : registry.find(input.model.slice(0, slash), input.model.slice(slash + 1));
    let request: unknown = null;
    // The fork gate's result: the passing verification of a fork run, or — under `native` — the
    // rejected one a fallback still records, with both hashes and the differing path.
    let verification: (Partial<NativeVerification> & { rounds: NativeVerification["rounds"]; native?: NativeVerification }) | undefined;
    let fallbackReason: string | undefined;
    let mode: "fork" | "subagent" = "subagent";
    let usage: unknown;
    const retries: { attempt: number; error: string }[] = [];
    const progress = () => input.reportProgress?.({ usage, retries: [...retries], request, mode, verification, fallbackReason });
    try {
      input.signal?.throwIfAborted();
      if (!model) throw new Error(`Unavailable model: ${input.model}`);
      // The last check before a request leaves, for both phases (review 2026-09-08): the frozen batch
      // fit the reported capacity, and the real body with the instructions, the tools and the output
      // reserve must still fit the model.
      const checkCapacity = (payload: unknown) => {
        const body = payload as Record<string, unknown>;
        const output = Math.max(model.maxTokens, ...["max_tokens", "max_output_tokens", "max_completion_tokens"]
          .map(key => typeof body[key] === "number" ? body[key] as number : 0));
        if (tokens(JSON.stringify(payload)) + output > Math.floor(model.contextWindow * contextMargin))
          throw new Error(`${input.kind === "noting" ? "Noting" : "Consolidation"} capacity: provider request exceeds model context with output reserved`);
      };
      // Pi's own retry policy runs inside the child; the footer and the one warning per scheduled
      // backoff stay the adapter's, exactly as they were before the cutover.
      const retryNotice = (event: { attempt: number; maxAttempts: number; delayMs: number; error: string }) => {
        activity.retrying = true; showSpend(callContext);
        callContext.ui.notify(`Trace Memory: ${input.kind} retry ${event.attempt}/${event.maxAttempts} in ${Math.round(event.delayMs / 1000)}s: ${event.error}`, "warning");
      };
      const retryFinished = () => { activity.retrying = false; showSpend(callContext); };
      // 20a: core prepares the domain text of both representations from one frozen task; this adapter
      // only binds it to native messages. A fork has no system slot of its own, so its appended user
      // message carries the instructions and then the increment; a fresh child takes the instructions
      // as its system prompt and the whole material as its first user message.
      // 19a/19b/19c: the only runner. A fork task runs in Pi's own child `AgentSession` branched at
      // the parent's persisted leaf; an unforkable fork task and every subagent task (explicit, a fork
      // fallback, or borrowed closed-session work) run in a fresh private child session. Pi owns the
      // model call, the tool loop, the retry policy and cancellation in both; this adapter keeps only
      // the byte-level gate on a fork's first request.
      if (input.mode === "fork") {
        try {
          // 19c cache-miss latch: the requested mode stays fork; admission resolves it to subagent
          // while this memory session is automatically downgraded. Every task rechecks it here, so a
          // task queued before the transition cannot bypass it.
          const suppression = memory.store.forkSuppression(input.sessionId);
          if (suppression) throw new NotForkable(`cache miss latch: fork suppressed for this session since ${suppression.at}`);
          // Ticket 20 "Post-compaction worker mode", rechecked here at the actual launch against the
          // exact frozen entry set — a task prepared before a compaction but held for a slot, a claim
          // or native readiness reaches this line with its evidence range already frozen. A fork
          // would inherit a context those entries are no longer in, so the whole batch runs as a
          // fresh child instead, recorded like any other fallback: requested mode fork, actual mode
          // subagent, reason named. This is a per-task readiness decision, not the cache-miss latch.
          if (input.kind === "noting") {
            const evidence = preCompactionEvidence(callContext, input.entryAudit.entries.map(e => e.nativeId));
            if (evidence) throw new NotForkable(evidence);
          }
          // A tree switch since admission invalidates this launch context; the new branch's history is
          // never substituted for the task frozen on the old one.
          if (state.branch !== input.branch) throw new NotForkable("The selected branch changed after admission");
          const captured = session.capture;
          if (!captured || captured.branch !== input.branch) throw new NotForkable("No current-branch provider payload captured");
          if (captured.model !== model.id || captured.provider !== model.provider) throw new NotForkable("Session model changed since capture");
          const parentFile = callContext.sessionManager.getSessionFile?.();
          if (!parentFile) throw new NotForkable("The parent session is not persisted");
          const checkpoint = callContext.sessionManager.getLeafId();
          if (!checkpoint) throw new NotForkable("The parent session has no persisted leaf entry");
          const native = await runNative({
            onCache: observation => {
              // User rulings 2026-09-09: every eligible miss is noticed once, with its count; a hit
              // resets the count; the second consecutive miss downgrades the session — one transition,
              // decided by the store's guarded UPDATE, so two phases reaching it together notice once.
              // This run continues in its own native session; the first miss of a run is audited under
              // `verification.cacheMiss` in its run record.
              if (!observation.miss) { cacheMisses.delete(input.sessionId); return; }
              const misses = (cacheMisses.get(input.sessionId) ?? 0) + 1;
              cacheMisses.set(input.sessionId, misses);
              callContext.ui.notify(`Trace Memory: fork cache miss ${Math.min(misses, 2)}/2 (${observation.cacheRead} of ${observation.total} input tokens read from cache).`, "warning");
              if (misses < 2 || !memory.store.suppressFork(input.sessionId)) return;
              missDetected.add(input.kind);
              callContext.ui.notify("Trace Memory: fork downgraded after two consecutive cache misses. Future memory tasks in this session will use subagent.", "warning");
            },
            mode: "fork", parentFile, parentSessionId: callPiId, checkpoint, runsDir: runsDirectory(callPiId),
            cwd: callContext.cwd, agentDir, model: model as unknown as NativeModel, captured: captured.payload,
            task: `${input.prompt}\n\n${input.text.inherited}`, tools: input.tools, maxToolRounds: memory.config[input.kind].maxToolRounds,
            signal: input.signal, feedback: input.kind === "consolidation" ? input.reviewFeedback : undefined,
            onRequest: body => { checkCapacity(body); request = body; input.reportRequest(body); },
            onProgress: state => { usage = state.usage; retries.splice(0, retries.length, ...state.retries); progress(); },
            onRetry: retryNotice, onRetryEnd: retryFinished,
          });
          mode = "fork";
          usage = native.usage; request = native.request ?? request; verification = native.verification;
          retries.splice(0, retries.length, ...native.retries);
          return { outcome: native.outcome, output: native.output, usage, request, mode, verification,
            ...(native.nativeLog ? { nativeLog: native.nativeLog } : {}), ...(retries.length ? { retries } : {}) };
        } catch (error) {
          if (!(error instanceof NotForkable)) throw error;
          // Nothing was sent and nothing was committed: this task continues as a native subagent.
          fallbackReason = `native runner: ${error.message}`;
          if (error.verification) verification = { rounds: [], native: error.verification }; // a rejected gate still records both hashes
          if (!session.notified) { contextNotice(input.kind, fallbackReason); session.notified = true; }
        }
      }
      // Native subagent parity (19b): explicit subagent mode, a fork fallback and borrowed
      // closed-session work all run in the same native runner, on a fresh private SessionManager in
      // the runs directory. A child that cannot be constructed at all is a run failure with a reason
      // (the outer catch below): there is no second runtime to fall back to, and the queue stays
      // pending for the next permitted trigger.
      const native = await runNative({
        mode: "subagent", runsDir: runsDirectory(callPiId), cwd: callContext.cwd, agentDir,
        model: model as unknown as NativeModel, systemPrompt: input.prompt, task: input.text.fresh,
        tools: input.tools, maxToolRounds: memory.config[input.kind].maxToolRounds,
        signal: input.signal, feedback: input.kind === "consolidation" ? input.reviewFeedback : undefined,
        onRequest: body => { checkCapacity(body); request = body; input.reportRequest(body); },
        onProgress: state => { usage = state.usage; retries.splice(0, retries.length, ...state.retries); progress(); },
        onRetry: retryNotice, onRetryEnd: retryFinished,
      });
      mode = "subagent";
      usage = native.usage; request = native.request ?? request;
      retries.splice(0, retries.length, ...native.retries);
      return { outcome: native.outcome, output: native.output, usage, request, mode, verification, fallbackReason,
        ...(native.nativeLog ? { nativeLog: native.nativeLog } : {}), ...(retries.length ? { retries } : {}) };
    } catch (error) {
      return { outcome: input.signal?.aborted || (error instanceof Error && error.name === "AbortError") ? "cancelled" : "failure",
        output: String(error), usage, retries, request, mode, verification, fallbackReason };
    }
  }, core, piResultText);
  const contextNotice = (kind: string, reason: string) => ctx.ui.notify(`Trace Memory: ${kind} fell back to subagent mode. ${reason}`, "warning");
  type State = { enrollment?: { defaultEnabled: boolean; choice: boolean | null }; shared?: boolean; sourceHead?: number; originPiId?: string; sessionId?: number; projectId: number; branch: string; head?: number; piId: string; injected?: boolean; project?: string };
  let state: State;
  // 18b: one manual catchup at a time per executor, host-local state only (no new queue/claim
  // system — it drives 17c's own executor slot and target claim under a frozen entry/fact snapshot).
  type Catchup = {
    sessionId: number; branch: string; headTurnId: number;
    maxEntryId?: number; entryTotal: number; // Noting boundary: undefined means nothing was pending to note
    factIds: Set<number>; factTotal: number; // Consolidation boundary: pending-at-freeze plus produced-by-this-drain
    stopped: boolean;
    runningPhase?: "noting" | "consolidation";
    waitingPhase?: "noting" | "consolidation";
    outcome?: "completed" | "stopped" | "failed";
    diagnostic?: string;
  };
  let catchup: Catchup | undefined;
  /** Which tier the last compaction of this executor used, for `/trace status` (ticket 20 "Failure
   * visibility"). A diagnostic string, not a state machine: nothing reads it back. */
  let lastCompaction: string | undefined;
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
  const slots = new Set<"noting" | "consolidation">();
  // 19c: the phase whose run observed the eligible cache miss, so the run id can be linked to the
  // session's suppression once core has allocated it (the miss is seen before any run row exists).
  const missDetected = new Set<"noting" | "consolidation">();
  // Consecutive eligible fork cache misses per memory session, in this process only (user ruling
  // 2026-09-09): a reopen starts at zero; the persisted latch itself is the session-scoped state.
  const cacheMisses = new Map<number, number>();
  const suppressed = () => (state.sessionId ? memory.store.forkSuppression(state.sessionId) : null);
  /** Ticket 20 "Post-compaction worker mode". The boundary is the last compaction entry on the
   * target's currently selected ancestry. Pi writes that entry only when a compaction was persisted
   * successfully, whatever produced its summary, so a request to compact, a failed or cancelled
   * attempt and a compaction on a sibling path establish nothing here by construction. The ancestry
   * is re-read on every call — never cached, never compared by wall clock, database entry id or a
   * current-context flag — so reopen and tree navigation restore the same answer.
   *
   * An entry the selected ancestry no longer carries is counted as preceding the boundary: a fork
   * would not inherit evidence Pi is not carrying either, and entries Pi happens to have retained
   * past a compaction do not waive the rule. */
  const preCompactionEvidence = (context: ExtensionContext, nativeIds: string[]): string | undefined => {
    const ancestry = context.sessionManager.getBranch() as { id: string; type: string }[];
    let boundary = -1;
    for (let i = 0; i < ancestry.length; i++) if (ancestry[i]!.type === "compaction") boundary = i;
    if (boundary < 0) return;
    const position = new Map(ancestry.map((entry, i) => [entry.id, i]));
    const before = nativeIds.filter(id => (position.get(id) ?? -1) < boundary).length;
    return before ? `pre-compaction evidence: ${before} selected ${before === 1 ? "entry precedes" : "entries precede"} the persisted compaction ${ancestry[boundary]!.id}` : undefined;
  };
  /** The mode a task of this session will actually run in: a requested fork resolves to subagent while
   * the cache-miss latch is set, and — ticket 20's admission rule — while the entries a Noter would
   * select include evidence from before a persisted compaction. Used for the delivery pause, the
   * readiness wait and the budget; the requested mode is still what the task is launched with, so the
   * run record keeps it. Neither resolution is a latch: both are re-decided for every task. */
  const effectiveMode = (requested: "fork" | "subagent", task?: { kind: "noting" | "consolidation"; target: { sessionId: number; branch: string; headTurnId: number } }) => {
    if (requested !== "fork") return requested;
    if (suppressed()) return "subagent" as const;
    // Noting's batch is the oldest pending prefix, so any pending pre-boundary entry is in it.
    if (task?.kind === "noting" && preCompactionEvidence(ctx, memory.pendingEntries(task.target.sessionId, task.target.branch, task.target.headTurnId).map(e => e.nativeId))) return "subagent" as const;
    return "fork" as const;
  };
  const modelName = (kind: "noting" | "consolidation") => String(flat[`${kind}Model`] && flat[`${kind}Model`] !== "session"
    ? flat[`${kind}Model`] : ctx.model ? `${ctx.model.provider}/${ctx.model.id}` : "session");
  // Ruling 17:01: noting and consolidation each configure their mode (noting defaults to fork, consolidation to
  // subagent); fork mode always runs on the session model, subagent mode on the configured one.
  const launch = (kind: "noting" | "consolidation") => {
    const fork = kind === "noting" ? memory.config.noting.forkModeDefault : !memory.config.consolidation.subagentModeDefault;
    return { mode: fork ? "fork" as const : "subagent" as const, model: fork ? (ctx.model ? `${ctx.model.provider}/${ctx.model.id}` : "session") : modelName(kind) };
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
    if (closed || !context.ui?.setStatus) return;
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
  // One admission path for ordinary (own/borrowed) and manual-catchup work (18b): only the target,
  // mode/model and admission flags differ. `boundary` is absent for ordinary automatic work.
  const attemptPhase = (context: ExtensionContext, kind: "noting" | "consolidation", target: { sessionId: number; branch: string; headTurnId: number },
      selected: { mode: "fork" | "subagent"; model: string }, options: { borrowed: boolean; automatic: boolean; boundary?: { maxEntryId?: number; factIds?: number[] } }) => {
    if (closed || !enabled()) return Promise.resolve({ outcome: "dropped" } as const);
    const effective = effectiveMode(selected.mode, { kind, target }); // admission pauses by what will run, not by what was asked
    const [provider, ...id] = selected.model.split("/");
    const model = selected.model === "session" || selected.model === `${context.model?.provider}/${context.model?.id}` ? context.model : context.modelRegistry.find(provider!, id.join("/"));
    if (!model || !Number.isFinite(model.contextWindow) || !Number.isFinite(model.maxTokens)) {
      const permanent = `${kind === "noting" ? "Noting" : "Consolidation"} capacity: unavailable model context/output limits; left pending`;
      context.ui.notify(permanent, "error");
      // A configuration error, not a transient wait: a manual catchup must fail on it, never retry (review 2026-09-08).
      return Promise.resolve({ outcome: "dropped", permanent } as const);
    }
    // Both phases negotiate capacity before selection (gate 4; review 2026-09-08 for Consolidation):
    // the model window minus the output reserve, and the inherited prefix when the task will fork.
    // A session the cache-miss latch has downgraded runs with fresh context, so there is no prefix.
    const capacity = { inputTokens: Math.max(0, Math.floor(model.contextWindow * contextMargin) - model.maxTokens),
      prefixTokens: effective === "fork" && session.capture?.branch === target.branch ? tokens(JSON.stringify(session.capture.payload)) : 0 };
    const common = { ...target, ...selected, effectiveMode: effective, borrowed: options.borrowed, automatic: options.automatic, executorSessionId: state.sessionId!, capacity,
      ...(options.boundary ? { boundary: options.boundary } : {}) };
    return kind === "consolidation" ? memory.consolidate(common) : memory.noting(common);
  };
  // Keep the existing storage provenance value; session.project_declaration controls sharing.
  const ownProject = (piId: string) => (memory.store.findProjectByName(`pi:${piId}`)
    ?? memory.store.createProject({ name: `pi:${piId}`, declaredBy: "marker" })).id;
  let savedSourceHead: number | undefined;
  const save = () => { pi.appendEntry(tag, { ...state, dbPath }); savedSourceHead = state.sourceHead; };
  const restore = (context: ExtensionContext, fork = false) => {
    ctx = context;
    const loaded = configuration(ctx.cwd, environment, agentDir);
    if (loaded.flat.dbPath !== flat.dbPath) throw new Error("dbPath changed; reload the extension to reopen the database");
    ({ flat, core, sources, layers } = loaded);
    Object.assign(memory.config, validateConfig(core));
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
      // A provisional state cannot have a user project declaration; do not restore a former file-derived project.
      state = { ...saved, projectId: saved.sessionId ? saved.projectId : ownProject(piId), piId, branch: (fork && (tip?.head !== saved.head || tip?.sourceHead !== saved.sourceHead)) || saved.piId !== piId ? randomUUID() : saved.branch };
    } else {
      state = { projectId: ownProject(piId), branch: "main", piId };
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
    if (state.sessionId && !fork) memory.store.reopenSession(state.sessionId, memory.executorId);
    // 18b lifecycle: switching away from a catchup's frozen path ends it and cancels its owned
    // in-flight work; it is never retargeted to the newly selected branch or resumed on reopen.
    if (catchup && !catchup.outcome && (catchup.sessionId !== state.sessionId || catchup.branch !== state.branch)) {
      catchup.stopped = true;
      if (!catchup.runningPhase) catchup.outcome = "stopped";
      memory.cancelTasks();
    }
    current = undefined;
    reconciledLeaf = undefined; reconciled = undefined; // 22b: a restored session reconciles its ancestry from the start
    reconcile(false);
    showSpend(ctx);
    if (state.sessionId) {
      state.projectId = memory.store.getSession(state.sessionId)!.projectId;
      if (memory.store.projectDeclaration(state.sessionId) === "mark") state.project = memory.store.getProject(state.projectId)!.name;
    }
    save(); // Provisional intent is durable before the first reply, too.
  };
  const ensure = (context: ExtensionContext) => { if (closed) throw new Error("Trace Memory executor is closed"); ctx = context; if (!state || state.piId !== context.sessionManager.getSessionId()) restore(context); };
  const allocate = (started: string) => {
    if (state.sessionId) return;
    state.projectId = ownProject(state.piId);
    state.sessionId = memory.store.createSession({ host: `pi:${state.piId}`, startedAt: started, firstReplyAt: now(), projectId: state.projectId, projectDeclaration: "undeclared", nativeCreatedAt: ctx.sessionManager.getHeader()?.timestamp, baseline, enrollmentChoice: (provisional() ?? state.enrollment!).choice }).id;
    state.originPiId = state.piId;
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
  // 22b: what the previous walk established, kept in process memory only. `ids` is the ancestry
  // prefix it covered; the rest is the state that prefix produced, including the tool calls each
  // Turn has offered, so a tool result finds its call without rereading the entries before it. The
  // next walk trusts this only when the ancestry still begins with exactly `ids` — tree navigation, a
  // fork, a lineage change or a shortened ancestry is not a prefix, and rebuilds. Restoration and the
  // enrollment switch drop it outright. Every entry the walk does check keeps its content-identity
  // check: this state decides what is new, never that a changed message is unchanged.
  let reconciled: { ids: string[]; lineage: string; turnId?: number; selected: number[]; seen: Set<string>;
    toolCalls: Map<string, { ordinal: number; name: string; callId: string }> } | undefined;
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
    const resume = reconciled && reconciled.ids.length <= ancestry.length
      && reconciled.ids.every((id, i) => (ancestry[i] as { id: string }).id === id) ? reconciled : undefined;
    reconciled = undefined; // a walk that throws leaves nothing to resume from
    let lineage = resume ? resume.lineage : state.originPiId ?? state.piId;
    let turnId = resume?.turnId;
    const ids = resume ? resume.ids : [], selected = resume ? resume.selected : [];
    const seen = resume ? resume.seen : new Set<string>();
    const toolCalls = resume ? resume.toolCalls : new Map<string, { ordinal: number; name: string; callId: string }>();
    // One Turn's offer of a call id. A later entry supersedes an earlier one and the first occurrence
    // inside an entry wins, which is the order the per-result rescan searched in.
    const offer = (turn: number, list: { ordinal: number; name: string; callId: string }[]) => {
      const own = new Set<string>();
      for (const call of list) {
        const key = `${turn} ${call.callId}`;
        if (own.has(key)) continue;
        own.add(key); toolCalls.set(key, call);
      }
    };
    for (let index = ids.length; index < ancestry.length; index++) {
      const entry = ancestry[index]!;
      ids.push(entry.id);
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
        selected.push(known.id); turnId = known.turnId;
        if (known.role === "assistant") offer(known.turnId, known.calls);
        continue;
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
        const call = toolCalls.get(`${turnId} ${message.toolCallId}`);
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
        offer(turnId, fragments);
        const value = memory.store.getTurn(turnId)!;
        memory.store.updateTurn(turnId, { assistantText: [value.assistantText, natural].filter(Boolean).join("\n") });
      }
    }
    if (state.head && !turnId && memory.store.listSourceEntries(state.sessionId).length) missing("selected ancestry contains no available source entries");
    memory.selectEntries(state.sessionId, state.branch, selected);
    state.sourceHead = selected.at(-1);
    if (turnId) { state.head = turnId; if (current) current.id = turnId; }
    reconciled = { ids, lineage, turnId, selected, seen, toolCalls };
  });
  const persistState = () => { reconcile(); if (state.sessionId && state.sourceHead !== savedSourceHead) save(); };
  const flush = (ended = false) => { reconcile(false); if (enabled() && ended && current?.id) memory.store.updateTurn(current.id, { endedAt: now() }); };
  pi.on("before_provider_request", (event, context) => {
    ensure(context);
    if (!enabled()) { showSpend(context); return; }
    const previous = state.sourceHead;
    reconcile(false);
    // The capture is the fork gate's comparand and nothing else: the request-copy runner that also
    // read the ancestry behind it was deleted in 19c, so only the body is kept (review 2026-09-08).
    if (context.model) session.capture = { payload: snapshot(event.payload) as Body, model: context.model.id, provider: context.model.provider, branch: state.branch };
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
      // A knowledge cap that cannot hold even its omission receipt is reported, never injected over (review 2026-09-08).
      try {
        const block = memory.inject(state.sessionId ? { sessionId: state.sessionId, headTurnId: state.head ?? null, branch: state.branch } : { projectId: state.projectId });
        if (block) { parts.push(block); unconfirmed.injected = true; } // nothing yet: try again next prompt
      } catch (error) { context.ui.notify(String(error), "error"); }
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
  // The reason a due fork-mode task must wait for a later boundary, or undefined when it may launch
  // now. Only the inherited-context path has a checkpoint to be ready: a fresh-context run and a
  // session already downgraded by the cache-miss latch have none.
  const forkWait = (context: ExtensionContext, mode: "fork" | "subagent"): string | undefined => {
    if (mode !== "fork" || suppressed()) return;
    const parentFile = context.sessionManager.getSessionFile?.();
    if (!parentFile) return; // no native file at all: the documented subagent fallback applies, not a wait
    const checkpoint = context.sessionManager.getLeafId();
    if (!checkpoint) return "the parent session has no persisted leaf entry";
    return checkpointReadiness(parentFile, checkpoint);
  };
  const checkQueues = () => {
    if (closed || !enabled() || !state.sessionId || !state.head) return;
    const context = ctx;
    const own = { sessionId: state.sessionId, branch: state.branch, headTurnId: state.head };
    for (const kind of ["noting", "consolidation"] as const) {
      if (slots.has(kind)) continue;
      const selected = launch(kind);
      // The delivery pause and the readiness wait follow the mode that will actually run: a session
      // the cache-miss latch has downgraded runs fresh-context work, which reads nothing from the
      // conversation and forks nothing. The requested mode stays what it is, for the audit
      // (review 2026-09-08).
      const effective = effectiveMode(selected.mode, { kind, target: own });
      let due = false, paused = false;
      try { ({ due, paused } = memory.taskEligibility(kind, own, effective)); }
      catch (error) { context.ui.notify(String(error), "error"); }
      if (due && paused) { activity.last = "warning"; showSpend(context); }
      // 19c "Trigger versus launch": the threshold above decides that this task is due; the checkpoint
      // decides when it may launch. A due fork-mode task whose native checkpoint is not yet persisted,
      // reopenable and free of an open tool-call group waits for the next safe boundary — no timer, no
      // duplicate task, no progress, and starting later is not a new extraction trigger. Borrowed
      // closed-session work is fresh-context and is never held back by this.
      const waiting = due && !paused ? forkWait(context, effective) : undefined;
      const candidates = [...(due && !paused && !waiting ? [{ ...own, borrowed: false }] : []),
        ...memory.store.closedTasks(kind, own.sessionId).map(target => ({ ...target, borrowed: true }))];
      if (!candidates.length) continue;
      slots.add(kind); // Reserve before any asynchronous admission or model work.
      const work = async () => {
        for (const { borrowed, ...target } of candidates) {
          if (closed || !enabled()) return;
          try {
            const selected = borrowed ? { mode: "subagent" as const, model: modelName(kind) } : launch(kind);
            const result = await attemptPhase(context, kind, target, selected, { borrowed, automatic: true });
            // The run that detected the cache miss now has an id: link it, so status and the audit
            // name the response that downgraded this session. Its own mode stays fork.
            const runId = (result as { runId?: number }).runId;
            if (missDetected.delete(kind) && typeof runId === "number") memory.store.linkForkSuppression(target.sessionId, runId);
            if (result.outcome !== "dropped" && result.outcome !== "empty") return result;
          } catch (error) {
            context.ui.notify(String(error), "error");
            if (!(error instanceof Error && error.cause === "task admission")) return;
          }
        }
      };
      const promise = work();
      pending.add(promise); activity.running.set(kind, 1); showSpend(context);
      // The handled promise includes cleanup; no detached rejecting finally chain survives disposal.
      const settled = promise.then(result => reportProblems(result, context), error => {
        activity.last = "error"; context.ui.notify(String(error), "error");
      }).finally(() => { slots.delete(kind); pending.delete(settled); activity.running.delete(kind); showSpend(context);
        if (catchup) driveCatchup(); }); // 18b: a slot release is one of the two events that may resume a waiting catchup.
      pending.delete(promise); pending.add(settled);
      void settled.catch(error => { try { context.ui.notify(`Trace Memory cleanup failed: ${String(error)}`, "error"); } catch { /* exit must still finish */ } });
    }
    if (catchup) driveCatchup(); // 18b: an ordinary eligible-entry opportunity is the other resumption event.
  };
  // 18b: manual catchup drains a frozen snapshot (18-"Manual catchup and stop"). It shares 17c's
  // executor slots and target claim through `attemptPhase`; no second scheduler or queue is added.
  // `driveCatchup` is the sole place that starts a batch on completion of the previous one — the
  // one explicit exception to 17b/17c's no-completion-chaining rule.
  const catchupProgress = (c: Catchup) => {
    const remainingEntries = c.maxEntryId === undefined ? 0 : memory.pendingEntries(c.sessionId, c.branch, c.headTurnId).filter(e => e.id <= c.maxEntryId!).length;
    const remainingFacts = memory.store.consolidationBatch(c.sessionId, c.branch, c.headTurnId).filter(f => c.factIds.has(f.id)).length;
    return { entriesDone: c.entryTotal - remainingEntries, remainingEntries, factsDone: c.factIds.size - remainingFacts, remainingFacts };
  };
  const catchupLine = (): string | undefined => {
    if (!catchup) return undefined;
    const c = catchup, p = catchupProgress(c);
    if (c.outcome === "completed") return `Catchup: completed (${c.entryTotal} entries noted, ${c.factTotal} facts integrated)`;
    if (c.outcome === "stopped") return `Catchup: stopped (${p.entriesDone}/${c.entryTotal} entries, ${p.factsDone}/${c.factTotal} facts processed; unprocessed work stays pending; /trace catchup resumes it)`;
    if (c.outcome === "failed") return `Catchup: failed — ${c.diagnostic} (${p.entriesDone}/${c.entryTotal} entries, ${p.factsDone}/${c.factTotal} facts processed)`;
    if (c.waitingPhase) return `Catchup: waiting for ${c.waitingPhase} (${p.entriesDone}/${c.entryTotal} entries, ${p.factsDone}/${c.factTotal} facts)`;
    if (c.runningPhase) return `Catchup: running ${c.runningPhase} (${p.entriesDone}/${c.entryTotal} entries, ${p.factsDone}/${c.factTotal} facts)`;
    return `Catchup: idle (${p.entriesDone}/${c.entryTotal} entries, ${p.factsDone}/${c.factTotal} facts)`;
  };
  const hasBackgroundWork = () => runningKind("noting") || runningKind("consolidation") || !!(catchup && !catchup.outcome);
  const driveCatchup = () => {
    const c = catchup;
    if (!c || c.stopped || c.outcome || closed) return;
    const context = ctx;
    const own = { sessionId: c.sessionId, branch: c.branch, headTurnId: c.headTurnId };
    const p = catchupProgress(c);
    const phase: "noting" | "consolidation" | undefined = p.remainingEntries ? "noting" : p.remainingFacts ? "consolidation" : undefined;
    if (!phase) {
      c.outcome = "completed"; c.waitingPhase = undefined; c.runningPhase = undefined;
      context.ui.notify(`Trace Memory: catchup completed (${c.entryTotal} entries noted, ${c.factTotal} facts integrated).`, "info");
      showSpend(context); return;
    }
    if (slots.has(phase)) { c.waitingPhase = phase; c.runningPhase = undefined; return; } // 17c's slot is not stolen; wait for its release.
    const foreign = memory.store.getClaim(own.sessionId, phase);
    if (foreign && foreign.expiresAt > Date.now() && foreign.executorId !== memory.executorId) {
      c.waitingPhase = phase; c.runningPhase = undefined; return; // A live foreign claim on our own target is exposed as Waiting, not stolen.
    }
    c.waitingPhase = undefined; c.runningPhase = phase;
    slots.add(phase); activity.running.set(phase, 1); showSpend(context);
    const boundary = phase === "noting" ? { maxEntryId: c.maxEntryId } : { factIds: [...c.factIds] };
    const promise = attemptPhase(context, phase, own, { mode: "subagent", model: modelName(phase) }, { borrowed: false, automatic: false, boundary });
    pending.add(promise);
    let waited = false; // this attempt itself ended in Waiting (a concurrent drive may set waitingPhase too, and that must not stop the chain)
    const settled = promise.then(result => {
      if (phase === "noting" && result && Array.isArray((result as { facts?: unknown }).facts))
        for (const f of (result as { facts: { id: number }[] }).facts) if (!c.factIds.has(f.id)) { c.factIds.add(f.id); c.factTotal++; }
      reportProblems(result, context);
      const outcome = (result as { outcome?: string }).outcome;
      if (c.stopped) { c.outcome = "stopped"; return; } // Stop wins the race: no further chaining, whatever this batch returned.
      const permanent = (result as { permanent?: string }).permanent;
      if (outcome === "dropped" && permanent) { c.outcome = "failed"; c.diagnostic = permanent; return; } // a configuration error ends the drain
      if (outcome === "dropped") { c.waitingPhase = phase; waited = true; return; } // A foreign claim on our own target; retry on the next opportunity.
      if (outcome !== "success" && outcome !== "empty") {
        c.outcome = outcome === "cancelled" ? "stopped" : "failed";
        c.diagnostic = (result as { problems?: string[]; output?: unknown }).problems?.join("; ") ?? String((result as { output?: unknown }).output ?? outcome);
      }
    }, error => { c.outcome = "failed"; c.diagnostic = String(error); context.ui.notify(String(error), "error"); })
      .finally(() => { slots.delete(phase); c.runningPhase = undefined; pending.delete(settled); activity.running.delete(phase); showSpend(context);
        // The explicit drain exception: only this active catchup schedules its own next batch. A batch
        // that ended in Waiting is resumed by a slot release or the next ordinary opportunity, never by
        // this line: re-driving a wait immediately is a loop without a wait (review 2026-09-08).
        if (!waited) driveCatchup(); });
    pending.delete(promise); pending.add(settled);
    void settled.catch(error => { try { context.ui.notify(`Trace Memory cleanup failed: ${String(error)}`, "error"); } catch { /* exit must still finish */ } });
  };
  const startCatchup = () => {
    if (!enabled()) throw new Error("Trace Memory is Disabled; use /trace enable to enable memory.");
    if (catchup && !catchup.outcome) { ctx.ui.notify(catchupLine()!, "info"); return; } // Repeating catchup reports the active operation, never a second one.
    if (!state.sessionId || !state.head) { ctx.ui.notify("Trace Memory: no assistant reply yet; nothing to catch up.", "info"); return; }
    reconcile(false); // Reconcile available native history (17a) before freezing the boundary.
    const { sessionId, branch } = state, headTurnId = state.head;
    const pendingNow = memory.pendingEntries(sessionId, branch, headTurnId);
    const maxEntryId = pendingNow.length ? Math.max(...pendingNow.map(e => e.id)) : undefined;
    const factsNow = memory.store.consolidationBatch(sessionId, branch, headTurnId).map(f => f.id);
    catchup = { sessionId, branch, headTurnId, maxEntryId, entryTotal: pendingNow.length, factIds: new Set(factsNow), factTotal: factsNow.length, stopped: false };
    if (!pendingNow.length && !factsNow.length) { catchup.outcome = "completed"; ctx.ui.notify("Trace Memory: catchup found nothing pending; already caught up.", "info"); return; }
    driveCatchup(); // Starts the cancellable operation and returns; stop remains available while it runs.
    ctx.ui.notify(catchupLine()!, "info"); // Honestly reports the immediate result: running or Waiting for an occupied phase/claim.
  };
  const stopCatchup = () => {
    const active = hasBackgroundWork();
    if (catchup && !catchup.outcome) { catchup.stopped = true; if (!catchup.runningPhase) catchup.outcome = "stopped"; }
    memory.cancelTasks(); // Not the `stopping` form: future ordinary/explicit admission for this executor remains possible.
    showSpend(ctx);
    ctx.ui.notify(active ? "Trace Memory: stop requested. This executor's background work is being cancelled; future automatic triggers remain enabled."
      : "Trace Memory: nothing to stop.", "info");
  };
  pi.on("session_before_tree", async (_event, context) => {
    ensure(context); if (!enabled()) return; flush(true);
    const { sessionId, branch, head } = state;
    if (!sessionId || !head) return { summary: { summary: "" } };
    return { summary: { summary: memory.branchSummary(sessionId, branch, head) } };
  });
  // Ticket 20 "Compaction escalation": core escalates over its own frozen read snapshot and this
  // handler only binds the outcome. Tiers 1 and 2 are a complete custom replacement; tier 3 returns
  // nothing at all, so Pi proceeds through its normal compaction path — which may call a model, and
  // may fail or be cancelled, with Pi's own outcome handling (this is the one place where compaction
  // reaches a model, and it is Pi's call, not ours). Nothing here waits for or starts a worker, and
  // an unused custom summary confirms no delivery and no injection.
  pi.on("session_before_compact", (event, context) => {
    ensure(context); if (!enabled()) return; flush();
    let result: ReturnType<typeof memory.compact>;
    try {
      result = state.sessionId ? memory.compact(state.sessionId, state.branch, state.head)
        : { tier: "primary" as const, text: memory.inject({ projectId: state.projectId }) };
    } catch (error) { result = { tier: "native", reason: String(error) }; } // a capacity error is a reason to delegate, never oversized material
    lastCompaction = result.tier === "native" ? `native delegation — ${result.reason}` : `${result.tier} views`;
    context.ui.notify(`Trace Memory: compaction used ${lastCompaction}.`, "info");
    if (result.tier === "native") return; // no custom replacement: Pi's own compaction runs and reports
    return { compaction: { summary: result.text, firstKeptEntryId: "", tokensBefore: event.preparation.tokensBefore } };
  });
  pi.on("session_compact", event => {
    if (enabled() && state.sessionId) {
      const turn = memory.store.appendTurn({ sessionId: state.sessionId, parentTurnId: state.head, kind: "compaction", assistantText: event.compactionEntry.summary, startedAt: now(), endedAt: now() });
      state.head = turn.id; save();
    }
  });
  // Pi tears the extension runtime down and re-runs the factory for every reason, including
  // session replacement (new, resume, fork); this instance never serves the next session.
  pi.on("session_shutdown", async () => {
    if (closed) return;
    closed = true;
    const report = (error: unknown) => { try { ctx?.ui.notify(`Trace Memory cleanup failed: ${String(error)}`, "error"); } catch { /* reporting cannot block exit */ } };
    let timer: ReturnType<typeof setTimeout> | undefined;
    const deadline = new Promise<void>(resolve => { timer = setTimeout(resolve, 5_000); });
    try {
      try { memory.cancelTasks(true); if (catchup && !catchup.outcome) { catchup.stopped = true; catchup.outcome = "stopped"; } } catch (error) { report(error); }
      try { if (state) flush(true); } catch (error) { report(error); }
      await Promise.race([Promise.allSettled([...pending]), deadline]);
      memory.forceTasks(); // Close bindings and end only local waits, retaining partial audit.
      await Promise.allSettled([...pending]);
      try { if (state?.sessionId) memory.store.closeSession(state.sessionId); } catch (error) { report(error); }
    } finally {
      clearTimeout(timer);
      try { memory.close(); } catch (error) { report(error); }
    }
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
    const base = state.sessionId ? memory.status(state.sessionId) : `Enrollment: ${enabled() ? "Enabled" : "Disabled"} (${e.choice === null ? "default" : "explicit choice"})\nTrace Memory: no assistant reply; no session id.`;
    // 19c: the automatic downgrade is session state a user can act on, so status shows it and names
    // its one reset. The run that detected it keeps its own fork mode in the run record.
    const downgrade = suppressed();
    const fork = downgrade ? `Fork: suppressed since ${downgrade.at} (cache miss${downgrade.runId ? ` on R${downgrade.runId}` : ""}); Retry fork in the /trace menu` : undefined;
    return [base, fork, lastCompaction && `Compaction: ${lastCompaction}`, catchupLine()].filter(Boolean).join("\n");
  };
  const toggle = (value: boolean) => {
    if (state.sessionId) memory.store.setEnrollment(state.sessionId, value);
    else { state.enrollment = { ...enrollment(), choice: value }; persistProvisional(state.enrollment, true); }
    // Disable ends a manual catchup the same way it cancels any other owned in-flight work (18b lifecycle).
    if (!value) { memory.cancelTasks(); if (catchup && !catchup.outcome) { catchup.stopped = true; if (!catchup.runningPhase) catchup.outcome = "stopped"; } }
    state.injected = false;
    unconfirmed.deliveries = []; unconfirmed.injected = false;
    save();
    reconciledLeaf = undefined; reconciled = undefined; // 22b: the enrollment switch reconciles from the start too
    if (value) { reconcile(false); save(); }
    showSpend(ctx);
    ctx.ui.notify(`${status()}\n${value ? "Available history, including the paused interval, is queued; ordinary completions check thresholds." : "Processing and future injection are paused. Stored memory and already-injected text remain."}`, "info");
  };
  const commands = "/trace enable | disable | catchup | stop | status | runs [n] | project <name> | mark K<n>@<commit> verified|flagged|clear";
  const runView = (limit = 10) => {
    const runs = state.sessionId ? memory.store.listRuns(state.sessionId).slice(-limit).reverse() : [];
    ctx.ui.notify(runs.length ? runs.map(r => memory.trace(`R${r.id}`).split("\n")[0]!).join("\n") : "Trace Memory: no runs yet.", "info");
  };
  const menu = async () => {
    const selected = await ctx.ui.select("Trace Memory", ["Current session", "Catch up", "Stop", "Settings (Global, read-only)", "Runs", "Status"]);
    if (selected === "Current session") {
      const action = enabled() ? "Disable" : "Enable";
      const shared = state.shared ? " Shared identity: this switch also affects forks or clones carrying this memory identity." : " Forks or clones carrying this memory identity share this switch.";
      // 19c "Menu-only reset": Retry fork exists only while this session is automatically downgraded.
      // No slash subcommand and no permanent menu item; it clears the suppression only.
      const downgrade = suppressed();
      const choice = await ctx.ui.select(`${status()}${shared}`, [action, ...(downgrade ? ["Retry fork"] : [])]);
      if (choice === "Retry fork") {
        memory.store.clearForkSuppression(state.sessionId!);
        cacheMisses.delete(state.sessionId!);
        showSpend(ctx);
        ctx.ui.notify("Trace Memory: fork retry enabled for this session. The next memory task may request fork again; no task was started and global settings are unchanged.", "info");
        return;
      }
      if (choice && await ctx.ui.confirm(`${action} Trace Memory?`, shared + (action === "Disable"
        ? " Processing and future injection stop; stored memory and already-injected text remain."
        : " Available history, including the paused interval, will be queued without a model call."))) toggle(action === "Enable");
    } else if (selected === "Catch up") {
      try { startCatchup(); } catch (error) { ctx.ui.notify(String(error), "error"); }
    } else if (selected === "Stop") {
      stopCatchup();
    } else if (selected === "Settings (Global, read-only)") {
      const defaults = { dbPath: "~/.trace-memory/trace.db", notingModel: "session", consolidationModel: "session",
        runsDir: "<dbPath directory>/runs",
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
  pi.registerCommand("trace", { description: "Trace Memory enrollment, manual catchup/stop, read-only settings, runs and status.",
    async handler(args, context) {
      ensure(context);
      if (!args.trim()) { if (context.hasUI) await menu(); else context.ui.notify(`${status()}\n${commands}`, "info"); return; }
      const parts = args.trim().split(/\s+/);
      if (parts[0] === "enable" || parts[0] === "disable") { toggle(parts[0] === "enable"); return; }
      if (parts[0] === "catchup") { startCatchup(); return; }
      if (parts[0] === "stop") { stopCatchup(); return; }
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
