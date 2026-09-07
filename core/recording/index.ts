import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { type Fact, type Turn } from "../model/index.ts";
import type { Store, RunInput } from "../store/index.ts";
import type { bindTools } from "../api/tools.ts";
import type { ToolDefinition, ToolContext } from "../api/tools.ts";
import type { RunAgent, RunAgentResult, TraceMemoryConfig } from "../api/index.ts";
import { finish, renderFact, renderTurn, renderSources, renderEntry, ENTRY_VIEW_VERSION, budgetKnowledge, budgetFacts } from "../render/index.ts";

const prompt = readFileSync(new URL("../prompts/recording.md", import.meta.url), "utf8");
const promptHash = createHash("sha256").update(prompt).digest("hex");

export interface RecordInput {
  sessionId: number;
  branch: string;
  headTurnId: number;
  model?: string;
  mode?: "branch" | "subagent";
}
export interface RecordingAgentInput {
  kind: "recording";
  sessionId: number;
  branch: string;
  range: { from: string; to: string };
  readKnowledgeCommits: { knowledgeId: number; commit: number }[];
  model: string;
  mode: "branch" | "subagent";
  prompt: string;
  promptHash: string;
  input: string;
  /** Frozen full context for a host fallback after branch verification fails. */
  subagentInput: string;
  tools: ToolDefinition[];
  reportRequest: (request: unknown) => void;
}
export type RecordResult =
  | { outcome: "dropped" | "empty" }
  | { outcome: "success"; runId: number; facts: Fact[]; problems?: string[] }
  | { outcome: "failure" | "cancelled" | "bounced"; runId: number; problems: string[] };

export function freezeRecording(store: Store, input: RecordInput, config: TraceMemoryConfig) {
  const session = store.getSession(input.sessionId);
  if (!session) throw new Error(`session S${input.sessionId} does not exist`);
  if (typeof input.branch !== "string" || !input.branch) throw new Error("recording requires a non-empty branch");
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
  const entries = store.pendingEntries(session.id, input.branch, input.headTurnId);
  const ids = new Set(entries.map(e => e.turnId));
  const turns = ancestry.filter(t => ids.has(t.id)).map(turn => {
    const selected = entries.filter(e => e.turnId === turn.id);
    const ordinals = new Set(selected.flatMap(e => e.calls.map(c => c.ordinal)));
    return { turn: { ...turn, userPrompt: selected.find(e => e.role === "user")?.text ?? null,
      assistantText: selected.filter(e => e.role === "assistant" && e.text).map(e => e.text).join("\n") || null },
      calls: store.listToolCalls(turn.id).filter(c => ordinals.has(c.ordinal)) };
  });
  const knowledge = store.listCurrentKnowledge({ sessionId: session.id, headTurnId: input.headTurnId });
  const facts = store.listSessionFacts(session.id);
  return { sessionId: session.id, branch: input.branch, entries, turns, knowledge, facts,
    model: input.model ?? "session", mode: input.mode ?? (config.recording.branchModeDefault ? "branch" : "subagent") };
}

export async function runRecording(
  store: Store, frozen: ReturnType<typeof freezeRecording>, runAgent: RunAgent,
  config: TraceMemoryConfig, tools: (context: ToolContext, run: RunInput) => ReturnType<typeof bindTools>,
): Promise<RecordResult> {
  const { sessionId, branch, entries, turns, knowledge, facts, model, mode } = frozen;
  if (!turns.length) return { outcome: "empty" };
  const address = (id: number) => `S${sessionId}/T${id}`;
  const range = { from: address(turns[0]!.turn.id), to: address(turns.at(-1)!.turn.id) };
  const readKnowledgeCommits = knowledge.map(({ knowledge, revision }) => ({ knowledgeId: knowledge.id, commit: revision.id }));
  const raw = entries.map(entry => renderEntry(entry, config.render));
  const rawText = raw.map((r) => r.content).join("\n\n");
  const receipts = raw.flatMap((r) => r.receipts);
  const episodic = budgetFacts(rawText, facts, (f) => renderFact(f, store.listFactRelations(f.id)), config.render.episodicBlockTokens);
  const active = budgetKnowledge(knowledge, config.render.knowledgeBlockTokens);
  const recent = episodic.recent, knowledgeLines = active.groups.map((g) => g.text);
  receipts.push(...episodic.receipts, ...active.receipts);
  // The captured request precedes the head's final reply; append that missing raw and its source index.
  const subagentInput = finish({ content: [`Range: ${range.from}..${range.to}`, "Active knowledge:", knowledgeLines.filter(Boolean).join("\n"),
    "Recent facts (newest first):", recent.join("\n"), "Raw:", rawText].join("\n\n"), receipts });
  const head = turns.at(-1)!.turn;
  const input = mode === "branch" ? [`Range: ${range.from}..${range.to}`,
    ...(head.assistantText ? [renderTurn(head, [], config.render, { part: "assistant" }).content] : []),
    `Sources:\n${turns.map(({ turn, calls }) => renderSources(turn, calls)).join("\n")}`].join("\n\n") : subagentInput;
  const entryAudit = { entries: entries.map((e, i) => ({ id: e.id, nativeLineage: e.nativeLineage, nativeId: e.nativeId, turnId: e.turnId, omissions: raw[i]!.content.match(/\[omitted [^\]]+\]/g) ?? [] })),
    branch, viewVersion: ENTRY_VIEW_VERSION, viewBudgets: { toolCallTokens: config.render.toolCallTokens, entryTokens: config.render.entryTokens } };
  const run: RunInput = { kind: "recording", sessionId, branch, rangeFrom: range.from, rangeTo: range.to,
    promptHash, model, mode, entryAudit, createdAt: new Date().toISOString() };
  const binding = tools({ kind: "recording", sessionId, branch, range, entryIds: entries.map(e => e.id), readKnowledgeCommits }, run);
  const agentInput: RecordingAgentInput = { kind: "recording", sessionId, branch, range,
    readKnowledgeCommits: structuredClone(readKnowledgeCommits), model, mode, prompt, promptHash,
    subagentInput, input, tools: binding.tools, reportRequest: binding.reportRequest };
  let result: RunAgentResult;
  try { result = await runAgent(agentInput); }
  catch (error) {
    result = { outcome: error instanceof Error && error.name === "AbortError" ? "cancelled" : "failure",
      output: error instanceof Error ? error.message : String(error) };
  } finally { binding.close(); }
  run.mode = result.mode ?? mode;
  if (result.request !== undefined) run.request = JSON.stringify(result.request);
  const problems = binding.committed
    ? (result.outcome === "success" ? (result.request == null ? ["runAgent must return the exact provider request after commit"] : []) : [`provider ${result.outcome === "cancelled" ? "cancelled" : "failed"} after commit: ${String(result.output)}`])
    : result.outcome !== "success" ? [String(result.output ?? result.outcome)]
    : result.request === undefined || result.request === null ? ["runAgent must return the exact provider request"] : binding.problems;
  run.response = JSON.stringify({ output: result.output, usage: result.usage ?? null, readKnowledgeCommits,
    toolCalls: binding.sequence, fetched: binding.fetched, problems,
    ...(result.verification !== undefined ? { verification: result.verification } : {}),
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
      : result.request === undefined || result.request === null ? "failure" : "bounced";
    return { outcome, problems, runId: store.recordRun({ ...run, outcome }).id };
  }
  const committed = store.commitRecordingRun({ run, facts: [],
    entryIds: entries.map(e => e.id) });
  return committed.ok ? { outcome: "success", runId: committed.runId, facts: [] }
    : { outcome: "failure", runId: committed.runId, problems: committed.problems };
}
