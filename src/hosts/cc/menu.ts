import { TraceMemory, knowledgeStateKey } from "../../core/api/index.ts";
import { Store } from "../../core/store/index.ts";
import type { SettingsInput, TraceMenuInput } from "../trace-menu.ts";

import type { ResolvedCcHostConfig } from "./config.ts";
import type { CcCatchupStatus } from "./scheduler.ts";
import { assertOperatorBinding, coreHostOf, readBinding, sessionEnabled, validateNativeSessionId } from "./binding.ts";
const localMidnight = () => { const now = new Date(); return new Date(now.getFullYear(), now.getMonth(), now.getDate()).toISOString(); };
import { ccContextEvidence, type CcContextSnapshot } from "./menu-context.ts";

export interface CcMenuRun { id: number; phase: string; status: string; cost: number; at: string }
/** Match Pi's one-line catchup progress, from the executor's existing in-memory drain. */
export function ccCatchupNotice(status: CcCatchupStatus | null): string | null {
  if (!status) return null;
  const entries = `${status.entriesDone}/${status.entriesTotal} entries`;
  if (status.state === "completed")
    return `Catchup: completed (${status.entriesDone} entries noted; below-threshold knowledge may remain pending)`;
  if (status.state === "stopped")
    return `Catchup: stopped (${entries} processed; unprocessed work stays pending; /trace catchup resumes it)`;
  if (status.state === "failed")
    return `Catchup: failed — ${status.diagnostic ?? "executor reported failure"} (${entries} processed)`;
  if (status.state === "starting") return "Catchup: starting (syncing the transcript); reopen /trace for progress";
  if (status.state === "waiting") return `Catchup: waiting for ${status.phase ?? "a task"} (${entries})`;
  return `Catchup: running${status.phase ? ` ${status.phase}` : ""} (${entries})`;
}
export interface CcMenuReply {
  menu: TraceMenuInput;
  settings: SettingsInput;
  context: ReturnType<typeof ccContextEvidence>;
  runs: CcMenuRun[];
}
function runsFor(store: Store, sessionId: number, limit: number): CcMenuRun[] {
  return (store.db.prepare(`SELECT id, kind, outcome, usage_cost, created_at FROM runs
    WHERE session_id = ? ORDER BY id DESC LIMIT ?`).all(sessionId, limit) as
    { id: number; kind: string; outcome: string; usage_cost: number | null; created_at: string }[]).map(run => ({
    id: run.id, phase: run.kind, status: run.outcome, cost: run.usage_cost ?? 0, at: run.created_at,
  }));
}

export function readCcRuns(config: ResolvedCcHostConfig, nativeSessionId: string, limit: number): CcMenuRun[] {
  if (!Number.isSafeInteger(limit) || limit < 1) throw new Error("Runs count must be a positive safe integer");
  const binding = readBinding(config, validateNativeSessionId(nativeSessionId));
  if (!binding) throw new Error("current Claude Code session has no active binding");
  const store = new Store(config.dbPath);
  try {
    assertOperatorBinding(config, binding, store);
    return binding.coreSessionId === null ? [] : runsFor(store, binding.coreSessionId, limit);
  } finally { store.close(); }
}

export function readCcMenu(config: ResolvedCcHostConfig, nativeSessionId: string,
  effective?: ResolvedCcHostConfig, runLimit = 10, catchup: CcCatchupStatus | null = null,
  current?: CcContextSnapshot): CcMenuReply {
  if (!Number.isSafeInteger(runLimit) || runLimit < 1) throw new Error("Runs count must be a positive safe integer");
  const id = validateNativeSessionId(nativeSessionId), binding = readBinding(config, id);
  if (!binding) throw new Error(`Claude Code session ${id} is not bound`);
  const memory = TraceMemory(config.dbPath, async () => { throw new Error("menu cannot run model work"); }, config.coreConfig);
  try {
    const store = memory.store;
    assertOperatorBinding(config, binding, store);
    const session = binding.coreSessionId === null ? null : store.getSession(binding.coreSessionId);
    const project = binding.projectId === null ? null : store.getProject(binding.projectId);
    const enabled = sessionEnabled(binding, store);
    const head = binding.coreSessionId !== null && binding.selectedLeafUuid
      ? store.findSourceEntry(binding.coreSessionId, id, binding.selectedLeafUuid)?.turnId
        ?? store.findNativeTurn(binding.coreSessionId, id, binding.selectedLeafUuid)?.turnId : undefined;
    const target = binding.coreSessionId !== null && head
      ? { sessionId: binding.coreSessionId, branch: binding.branch, headTurnId: head } : undefined;
    const pending = (phase: "noting") => {
      const result = memory.pendingTokens(phase, target, true);
      return { tokens: result.tokens, trigger: result.trigger,
        ...(result.state === "known" && result.atLeast ? { atLeast: true, entries: result.entries } : {}) };
    };
    const dreaming = memory.dreamingPending(target);
    const spend = session ? memory.spend(session.id) : null;
    const budgets = memory.knowledgeBudgets();
    const active = effective ?? config;
    const workers: SettingsInput["workers"] = (["noting", "dreaming"] as const).map((phase, index) => {
      const name = (["Noter", "Dreamer"] as const)[index]!;
      const current = effective?.worker?.phases[phase];
      const saved = config.worker?.phases[phase];
      const sources = !effective ? { model: "effective configuration unavailable", thinking: "effective configuration unavailable" }
        : saved && current && (saved.model !== current.model || saved.thinking !== current.thinking)
          ? { ...(saved.model !== current.model ? { model: "saved file differs from running executor" } : {}),
              ...(saved.thinking !== current.thinking ? { thinking: "saved file differs from running executor" } : {}) } : undefined;
      return { phase: name, model: current?.model ?? "unavailable", thinking: current?.thinking ?? "unavailable", ...(sources ? { sources } : {}) };
    });
    const settings: SettingsInput = { database: config.dbPath,
      budgets: { global: budgets.global, project: budgets.project, session: budgets.session,
        sharedAllowanceTokens: active.coreConfig.compaction.sharedAllowanceTokens }, workers,
      closedSessionScope: active.closedSessionScope,
      ...(!effective ? { closedSessionSource: "saved file; effective configuration unavailable" }
        : active.closedSessionScope !== config.closedSessionScope
          ? { closedSessionSource: "saved file differs from running executor" } : {}) };
    const runs: CcMenuRun[] = session ? runsFor(store, session.id, runLimit) : [];
    const notices: string[] = [];
    if (binding.lastCompactionNotice) notices.push(binding.lastCompactionNotice);
    if (session && !enabled) for (const task of store.taskFailures(session.id).filter(value => value.count >= 3))
      notices.push(`Automatic off: ${task.phase} failed ${task.count} times (R${task.lastRunId}: ${task.lastReason}). Turn on to resume.`);
    if (!effective) notices.push("Running executor configuration unavailable");
    else if (active.closedSessionScope !== config.closedSessionScope || workers.some(w => w.sources))
      notices.push("Saved file settings differ from running executor");
    const progress = ccCatchupNotice(catchup);
    if (progress) notices.push(progress);
    if (binding.clearedFrom || binding.clearedInto) notices.push("Shared identity");
    const data: TraceMenuInput = {
      header: { session: session ? `S${session.id}` : "unbound", project: project?.name ?? "unavailable", enabled,
        explicit: binding.enrollment.choice !== null },
      context: { model: "Claude Code" },
      pending: { noting: pending("noting"), dreaming: {
        pending: dreaming.pending ?? { tokens: null, trigger: null },
        knowledge: dreaming.knowledge ? { tokens: dreaming.knowledge.tokens, trigger: dreaming.knowledge.window } : { tokens: null, trigger: null } } },
      spend: { session: spend?.cost ?? 0,
        noting: { runs: spend?.runs.noting ?? 0, cost: spend?.costs.noting ?? 0 },
        consolidation: { runs: spend?.runs.consolidation ?? 0, cost: spend?.costs.consolidation ?? 0 },
        dreaming: { runs: spend?.runs.dreaming ?? 0, cost: spend?.costs.dreaming ?? 0 },
        today: memory.spendSince(localMidnight()) },
      notices,
      actions: { enabled, retryForkAvailable: false },
    };
    // 102: a compaction's carrier, framed (Trace Memory's compaction) or bare (the supplement), is attributed by its compaction's recorded delivery (97).
    const recorded = store.db.prepare(`SELECT 1 FROM knowledge_deliveries WHERE owner = ? AND follows IS NOT NULL
      AND commits = ? AND states = ? AND knowledge_tokens = ? LIMIT 1`);
    const context = ccContextEvidence(binding, config.dbPath, current, header => recorded.get(coreHostOf(binding),
      JSON.stringify(header.commits), JSON.stringify(header.states.map(knowledgeStateKey)), header.knowledgeTokens ?? 0) !== undefined);
    return { menu: data, settings, context, runs };
  } finally { memory.store.close(); }
}
