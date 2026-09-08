import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { type Fact, type Turn } from "../model/index.ts";
import type { Store, RunInput } from "../store/index.ts";
import type { bindTools } from "../api/tools.ts";
import { toolDefinitions, type ToolDefinition, type ToolContext } from "../api/tools.ts";
import type { RunAgent, RunAgentResult, TraceMemoryConfig, TaskOptions, AgentControl } from "../api/index.ts";
import { renderFact, renderTurn, renderSources, renderEntry, ENTRY_VIEW_VERSION, budgetKnowledge, budgetFacts, tokens } from "../render/index.ts";

const prompt = readFileSync(new URL("../prompts/noting.md", import.meta.url), "utf8");
const promptHash = createHash("sha256").update(prompt).digest("hex");

export interface NotingInput extends TaskOptions {
  sessionId: number;
  branch: string;
  headTurnId: number;
  /** Host model capacity after reserving output; prefix includes native tools and context. */
  capacity?: { inputTokens: number; prefixTokens: number };
  model?: string;
  mode?: "branch" | "subagent";
}
/** The frozen task material of one Noting run (ticket 19b). Core renders and budgets these parts;
 * the adapter decides which of them an execution mode needs and which model message carries them.
 * No field is a composed system or user message. */
export interface NotingMaterial {
  /** The selected pending entries, oldest first, each with its compressed view. */
  entries: { id: number; view: string }[];
  /** The head turn's final assistant reply, rendered; null when the head turn has none. */
  head: string | null;
  /** One source-index line per turn of the frozen range, in range order. */
  sources: string[];
  /** Active knowledge lines within the knowledge budget, one string per category group. */
  knowledge: string[];
  /** Facts written earlier in this session, newest first, within the episodic budget. */
  facts: string[];
  /** Budget receipts for everything the views and the two budgets left out. */
  receipts: string[];
}
export interface NotingAgentInput extends AgentControl {
  kind: "noting";
  entryIds: number[];
  sessionId: number;
  branch: string;
  range: { from: string; to: string };
  readKnowledgeCommits: { knowledgeId: number; commit: number }[];
  model: string;
  mode: "branch" | "subagent";
  /** The domain instructions; core owns the prompt file and its hash. */
  prompt: string;
  promptHash: string;
  material: NotingMaterial;
  /** The view versions, budgets and omissions core records for this batch. */
  entryAudit: EntryAudit;
  tools: ToolDefinition[];
  reportRequest: (request: unknown) => void;
}
export interface EntryAudit {
  entries: { id: number; nativeLineage: string; nativeId: string; turnId: number; omissions: string[] }[];
  branch: string;
  viewVersion: string;
  viewBudgets: { toolCallTokens: number; entryTokens: number };
}
export type NotingResult =
  | { outcome: "dropped" | "empty" }
  | { outcome: "success"; runId: number; facts: Fact[]; problems?: string[] }
  | { outcome: "failure" | "cancelled" | "bounced"; runId: number; problems: string[] };

export function freezeNoting(store: Store, input: NotingInput, config: TraceMemoryConfig) {
  const session = store.getSession(input.sessionId);
  if (!session) throw new Error(`session S${input.sessionId} does not exist`);
  if (typeof input.branch !== "string" || !input.branch) throw new Error("noting requires a non-empty branch");
  const ancestry: Turn[] = [];
  const seen = new Set<number>();
  let id: number | null = input.headTurnId;
  while (id !== null) {
    if (seen.has(id)) throw new Error("cyclic turn ancestry");
    seen.add(id);
    const turn = store.getTurn(id);
    if (!turn || turn.sessionId !== session.id) throw new Error(`turn T${id} does not belong to S${session.id}`);
    ancestry.unshift(turn);
    id = turn.parentTurnId;
  }
  if (input.capacity && (!Number.isSafeInteger(input.capacity.inputTokens) || input.capacity.inputTokens < 0 ||
    !Number.isSafeInteger(input.capacity.prefixTokens) || input.capacity.prefixTokens < 0)) throw new Error("Invalid Noting capacity: expected nonnegative safe integers");
  const pendingAll = store.pendingEntries(session.id, input.branch, input.headTurnId);
  // A manual catchup (18b) freezes an entry-id boundary so later arrivals never join this target.
  const pending = input.boundary?.maxEntryId === undefined ? pendingAll : pendingAll.filter(e => e.id <= input.boundary!.maxEntryId!);
  const entries: typeof pending = [];
  const views: string[] = [];
  for (const entry of pending) {
    const view = renderEntry(entry, config.render).content;
    if (tokens([...views, view].join("\n\n")) > config.noting.batchTokens) break;
    entries.push(entry); views.push(view);
  }
  if (pending.length && !entries.length) throw new Error("Noting capacity: oldest entry exceeds noting.batchTokens; left pending");
  const knowledge = store.listCurrentKnowledge(store.knowledgePath(session.id, input.branch, input.headTurnId)); // entry-aware (review 2026-09-08)
  const facts = store.listSessionFacts(session.id);
  const mode = input.mode ?? (config.noting.branchModeDefault ? "branch" : "subagent");
  while (entries.length) {
    const ids = new Set(entries.map(e => e.turnId));
    const turns = ancestry.filter(t => ids.has(t.id)).map(turn => {
      const selected = entries.filter(e => e.turnId === turn.id);
      const ordinals = new Set(selected.flatMap(e => e.calls.map(c => c.ordinal)));
      return { turn: { ...turn, userPrompt: selected.find(e => e.role === "user")?.text ?? null,
        assistantText: selected.filter(e => e.role === "assistant" && e.text).map(e => e.text).join("\n") || null },
        calls: store.listToolCalls(turn.id).filter(c => ordinals.has(c.ordinal)) };
    });
    const frozen = { sessionId: session.id, branch: input.branch, entries: [...entries], turns, knowledge, facts,
      model: input.model ?? "session", mode };
    const prepared = notingMaterial(store, frozen, config);
    const capacity = input.capacity;
    // Gate 4 (ruling 2026-09-08): the adapter reports its available material budget before selection;
    // core prices the material it froze, part by part, and never a message it composed.
    const material = prepared.material;
    const cost = (parts: (string | null)[]) => parts.reduce<number>((total, part) => total + (part ? tokens(part) : 0), 0);
    const subagentTokens = tokens(prompt) + tokens(JSON.stringify(toolDefinitions))
      + cost([...material.knowledge, ...material.facts, ...material.entries.map(e => e.view), ...material.receipts]);
    const branchTokens = (capacity?.prefixTokens ?? 0) + tokens(prompt) + cost([material.head, ...material.sources]);
    if (!capacity || Math.max(subagentTokens, mode === "branch" ? branchTokens : 0) <= capacity.inputTokens) return frozen;
    entries.pop();
  }
  if (pending.length) throw new Error("Noting capacity: oldest entry cannot fit model context with instructions, knowledge, tools and output reserved; left pending");
  return { sessionId: session.id, branch: input.branch, entries, turns: [], knowledge, facts, model: input.model ?? "session", mode };

}

function notingMaterial(store: Store, frozen: { sessionId: number; entries: ReturnType<Store["pendingEntries"]>; turns: { turn: Turn; calls: ReturnType<Store["listToolCalls"]> }[]; knowledge: ReturnType<Store["listCurrentKnowledge"]>; facts: Fact[] }, config: TraceMemoryConfig) {
  const { sessionId, entries, turns, knowledge, facts } = frozen;
  const address = (id: number) => `S${sessionId}/T${id}`;
  const range = { from: address(turns[0]!.turn.id), to: address(turns.at(-1)!.turn.id) };
  const readKnowledgeCommits = knowledge.map(({ knowledge, revision }) => ({ knowledgeId: knowledge.id, commit: revision.id }));
  const raw = entries.map(entry => renderEntry(entry, config.render));
  const rawText = raw.map((r) => r.content).join("\n\n");
  const receipts = raw.flatMap((r) => r.receipts);
  const episodic = budgetFacts(rawText, facts, (f) => renderFact(f, store.listFactRelations(f.id)), config.render.episodicBlockTokens);
  const active = budgetKnowledge(knowledge, config.render.knowledgeBlockTokens);
  receipts.push(...episodic.receipts, ...active.receipts);
  const head = turns.at(-1)!.turn;
  // Every part of the run's material, rendered and budgeted once. An inherited-context run does not
  // need the raw, the delivered facts or the knowledge again, but which parts a mode uses, and in
  // which message, is the adapter's decision (ticket 19 "Adapters own conversations").
  const material: NotingMaterial = {
    entries: entries.map((entry, i) => ({ id: entry.id, view: raw[i]!.content })),
    // The captured request precedes the head's final reply; that missing raw and the source index
    // are what an inherited-context run still needs.
    head: head.assistantText ? renderTurn(head, [], config.render, { part: "assistant" }).content : null,
    sources: turns.map(({ turn, calls }) => renderSources(turn, calls)),
    knowledge: active.groups.map((g) => g.text).filter(Boolean),
    facts: episodic.recent,
    receipts,
  };
  return { range, readKnowledgeCommits, raw, material };
}

export async function runNoting(
  store: Store, frozen: ReturnType<typeof freezeNoting>, runAgent: RunAgent,
  config: TraceMemoryConfig, tools: (context: ToolContext, run: RunInput) => ReturnType<typeof bindTools>,
): Promise<NotingResult> {
  const { sessionId, branch, entries, turns, model, mode } = frozen;
  if (!turns.length) return { outcome: "empty" };
  const { range, readKnowledgeCommits, raw, material } = notingMaterial(store, frozen, config);
  const entryAudit: EntryAudit = { entries: entries.map((e, i) => ({ id: e.id, nativeLineage: e.nativeLineage, nativeId: e.nativeId, turnId: e.turnId, omissions: raw[i]!.content.match(/\[omitted [^\]]+\]/g) ?? [] })),
    branch, viewVersion: ENTRY_VIEW_VERSION, viewBudgets: { toolCallTokens: config.render.toolCallTokens, entryTokens: config.render.entryTokens } };
  const run: RunInput = { kind: "noting", sessionId, branch, rangeFrom: range.from, rangeTo: range.to,
    promptHash, model, mode, entryAudit, createdAt: new Date().toISOString() };
  const binding = tools({ kind: "noting", sessionId, branch, range, entryIds: entries.map(e => e.id), readKnowledgeCommits }, run);
  const agentInput: NotingAgentInput = { kind: "noting", entryIds: entries.map(e => e.id), sessionId, branch, range,
    readKnowledgeCommits: structuredClone(readKnowledgeCommits), model, mode, prompt, promptHash,
    material, entryAudit: structuredClone(entryAudit), tools: binding.tools, reportRequest: binding.reportRequest };
  let result: RunAgentResult;
  try { result = await runAgent(agentInput); }
  catch (error) {
    result = { outcome: error instanceof Error && error.name === "AbortError" ? "cancelled" : "failure",
      output: error instanceof Error ? error.message : String(error) };
  } finally { binding.close(); }
  // A direct facade close may dispose before the provider settles; never access that store.
  if (store.closed) return binding.committed ? { outcome: "success", ...binding.committed } : { outcome: "dropped" };
  run.mode = result.mode ?? mode;
  if (result.request !== undefined) run.request = JSON.stringify(result.request);
  // A host that cannot expose a provider request says so; core records the limitation instead of the
  // missing-request problem. A host that is expected to capture one and returns none still gets it.
  const unavailable = result.audit?.available === false;
  const problems = binding.committed
    ? (result.outcome === "success" ? (result.request == null && !unavailable ? ["runAgent must return the exact provider request after commit"] : []) : [`provider ${result.outcome === "cancelled" ? "cancelled" : "failed"} after commit: ${String(result.output)}`])
    : result.outcome !== "success" ? [String(result.output ?? result.outcome)]
    : (result.request === undefined || result.request === null) && !unavailable ? ["runAgent must return the exact provider request"] : binding.problems;
  run.response = JSON.stringify({ output: result.output, usage: result.usage ?? null, ...(result.outcome === "cancelled" ? { usageStatus: result.usage == null ? "unknown" : "partial" } : {}), readKnowledgeCommits,
    toolCalls: binding.sequence, fetched: binding.fetched, problems, requestedMode: mode,
    ...(result.audit !== undefined ? { audit: result.audit } : {}),
    ...(result.verification !== undefined ? { verification: result.verification } : {}),
    ...(result.nativeLog !== undefined ? { nativeLog: result.nativeLog } : {}),
    ...(result.fallbackReason !== undefined ? { fallbackReason: result.fallbackReason } : {}),
    ...(result.retries?.length ? { retries: result.retries } : {}) });
  if (binding.committed) {
    // The batch is committed; a failure while completing the audit record is reported, not a business failure.
    const after = [...problems];
    try { store.updateRun(binding.committed.runId, { ...run, outcome: "success" }); }
    catch (error) { after.push(`audit update failed after commit: ${String(error)}`); }
    return { outcome: "success", ...binding.committed, ...(after.length ? { problems: after } : {}) };
  }
  if (problems.length) {
    const outcome = result.outcome !== "success" ? result.outcome
      : (result.request === undefined || result.request === null) && !unavailable ? "failure" : "bounced";
    return { outcome, problems, runId: store.recordRun({ ...run, outcome }).id };
  }
  const committed = store.commitNotingRun({ run, facts: [],
    entryIds: entries.map(e => e.id) });
  return committed.ok ? { outcome: "success", runId: committed.runId, facts: [] }
    : { outcome: "failure", runId: committed.runId, problems: committed.problems };
}
