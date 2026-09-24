import { TraceMemory } from "../../core/api/index.ts";
import { Store } from "../../core/store/index.ts";
import type { SettingsInput, TraceMenuInput } from "../trace-menu.ts";

import type { ResolvedCcHostConfig } from "./config.ts";
import type { CcCatchupStatus } from "./scheduler.ts";
import { assertOperatorBinding, readBinding, sessionEnabled, validateNativeSessionId } from "./binding.ts";
const localMidnight = () => { const now = new Date(); return new Date(now.getFullYear(), now.getMonth(), now.getDate()).toISOString(); };
import { readCompleteTranscript } from "./transcript.ts";
import { ccContextEvidence, type CcContextSnapshot } from "./menu-context.ts";
import { ccLastCompactionNotice } from "./menu-notices.ts";

export interface CcMenuRun { id: number; phase: string; status: string; cost: number; at: string }
/** Match Pi's one-line catchup progress, from the executor's existing in-memory drain. */
export function ccCatchupNotice(status: CcCatchupStatus | null): string | null {
  if (!status) return null;
  const entries = `${status.entriesDone}/${status.entriesTotal} entries`;
  const facts = `${status.factsDone}/${status.factsTotal} facts`;
  if (status.state === "completed")
    return `Catchup: completed (${status.entriesDone} entries noted, ${status.factsDone} facts integrated; below-threshold work may remain pending)`;
  if (status.state === "stopped")
    return `Catchup: stopped (${entries}, ${facts} processed; unprocessed work stays pending; /trace catchup resumes it)`;
  if (status.state === "failed")
    return `Catchup: failed — ${status.diagnostic ?? "executor reported failure"} (${entries}, ${facts} processed)`;
  if (status.state === "waiting") return `Catchup: waiting for ${status.phase ?? "a task"} (${entries}, ${facts})`;
  return `Catchup: running${status.phase ? ` ${status.phase}` : ""} (${entries}, ${facts})`;
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
  if (!binding || binding.clearedInto) throw new Error("current Claude Code session has no active binding");
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
  if (binding.clearedInto) throw new Error(`Claude Code session ${id} was cleared into ${binding.clearedInto.nativeSessionId}; use the current native session id`);
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
    const pending = (phase: "noting" | "consolidation") => {
      const result = memory.pendingTokens(phase, target);
      return { tokens: result.tokens, trigger: result.trigger };
    };
    const pools = memory.dreamingPending(target);
    const pool = (scope: "global" | "project" | "session") => {
      const row = pools.pools?.find(value => value.scope === scope);
      return row ? { tokens: row.tokens, trigger: row.trigger } : { tokens: null, trigger: null };
    };
    const spend = session ? memory.spend(session.id) : null;
    const budgets = memory.knowledgeBudgets();
    const active = effective ?? config;
    const workers: SettingsInput["workers"] = (["noting", "consolidation", "dreaming"] as const).map((phase, index) => {
      const name = (["Noter", "Consolidator", "Dreamer"] as const)[index]!;
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
    const snapshot = readCompleteTranscript(binding.transcriptPath);
    const notices: string[] = [];
    if (!snapshot.problem && !snapshot.incompleteBytes) {
      const truncation = ccLastCompactionNotice(snapshot, binding);
      if (truncation) notices.push(truncation);
    }
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
      pending: { noting: pending("noting"), consolidation: pending("consolidation"), dreaming: {
        global: pool("global"), project: pool("project"), session: pool("session") } },
      spend: { session: spend?.cost ?? 0,
        noting: { runs: spend?.runs.noting ?? 0, cost: spend?.costs.noting ?? 0 },
        consolidation: { runs: spend?.runs.consolidation ?? 0, cost: spend?.costs.consolidation ?? 0 },
        dreaming: { runs: spend?.runs.dreaming ?? 0, cost: spend?.costs.dreaming ?? 0 },
        today: memory.spendSince(localMidnight()) },
      notices,
      actions: { enabled, retryForkAvailable: false },
    };
    const context = snapshot.problem || snapshot.incompleteBytes ? { presence: "unavailable" as const,
      reason: snapshot.problem ?? "incomplete native transcript" } : ccContextEvidence(snapshot.records, binding, config.dbPath, current);
    return { menu: data, settings, context, runs };
  } finally { memory.store.close(); }
}
