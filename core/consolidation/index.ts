import type { bindTools } from "../api/tools.ts";
import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { type Fact, type MemoryBatch } from "../model/index.ts";
import { type ConsolidationDiagnostic } from "./commit.ts";
import type { CommittedKnowledgeOp, Store, RunInput } from "../store/index.ts";
import type { RunAgent, RunAgentResult, TraceMemoryConfig, TaskOptions, AgentControl } from "../api/index.ts";
import { renderKnowledge, renderFact, budgetKnowledge, budgetFacts } from "../render/index.ts";

const prompt = readFileSync(new URL("../prompts/consolidation.md", import.meta.url), "utf8");
const promptHash = createHash("sha256").update(prompt).digest("hex");
const sectionStart = prompt.indexOf("### Second-round user message\n") + "### Second-round user message\n".length;
const checklist = prompt.slice(sectionStart, prompt.indexOf("\n### ", sectionStart));

export type { ConsolidationDiagnostic } from "./commit.ts";

export interface ConsolidateInput extends TaskOptions { sessionId: number; branch: string; headTurnId?: number; model?: string; mode?: "branch" | "subagent" }
export interface ConsolidationRange { from: string; to: string; facts: Fact[] }
export interface NearPair { candidate: string; knowledge: string; score: number }
/** The frozen task material of one Consolidation run (ticket 19b). Core renders and budgets these
 * parts; the adapter decides which of them an execution mode needs and which model message carries
 * them. No field is a composed system or user message. */
export interface ConsolidationMaterial {
  /** The facts to integrate, as addresses: an inherited context already carries their lines. */
  factAddresses: string[];
  /** The same facts, rendered with their relations, in range order. */
  rangeFacts: string[];
  /** Active knowledge lines within the knowledge budget, one string per category group. */
  knowledge: string[];
  /** Already-consolidated project facts, newest first, within the episodic budget. */
  consolidated: string[];
  /** Visible knowledge whose supports a range fact negates, with both facts: review cues only. */
  reminders: string[];
  /** Budget receipts for everything the two budgets left out. */
  receipts: string[];
}
export interface ConsolidationAgentInput extends AgentControl {
  kind: "consolidation";
  sessionId: number;
  branch: string;
  range: ConsolidationRange;
  readKnowledgeCommits: { knowledgeId: number; commit: number }[];
  model: string;
  mode: "branch" | "subagent";
  /** The domain instructions; core owns the prompt file and its hash. */
  prompt: string;
  promptHash: string;
  material: ConsolidationMaterial;
  /** Core's own reader of a `memory` receipt: the review guidance the adapter must put in front of
   * the model as a user message before the second submission, or undefined. The two-submission
   * protocol stays in core; the adapter only chooses the message or steering mechanism. */
  reviewFeedback(toolResult: string): string | undefined;
  tools: import("../api/tools.ts").ToolDefinition[];
  reportRequest(request: unknown): void;
}
export type ConsolidateResult =
  | { outcome: "dropped" | "empty" }
  | { outcome: "failure" | "cancelled" | "bounced"; runId: number; problems: string[] }
  | { outcome: "success"; runId: number; output: MemoryBatch; problems?: string[];
      committed: CommittedKnowledgeOp[]; diagnostics: ConsolidationDiagnostic[];
      range: ConsolidationRange; readKnowledgeCommits: { knowledgeId: number; commit: number }[]; unansweredNear: NearPair[] };

export function freezeConsolidation(store: Store, input: ConsolidateInput, config: TraceMemoryConfig) {
  const session = store.getSession(input.sessionId);
  if (!session) throw new Error(`session S${input.sessionId} does not exist`);
  if (typeof input.branch !== "string" || !input.branch) throw new Error("consolidation requires a non-empty branch");
  const facts = store.listProjectFacts(session.projectId);
  const rangeFactsAll = store.consolidationBatch(session.id, input.branch, input.headTurnId);
  // A manual catchup (18b) freezes an explicit fact-id set: the pending facts at freeze time plus
  // whatever the frozen Noting batches went on to produce. Later unrelated facts stay outside it.
  const rangeFacts = input.boundary?.factIds === undefined ? rangeFactsAll : rangeFactsAll.filter(f => input.boundary!.factIds!.includes(f.id));
  const path = store.knowledgePath(session.id, input.branch, input.headTurnId);
  const knowledge = store.listCurrentKnowledge(path);
  const relations = new Map(facts.map((f) => [f.id, store.listFactRelations(f.id)]));
  const lines = new Map(facts.map((f) => [f.id, renderFact(f, relations.get(f.id)!)]));
  const reminders: string[] = [];
  for (const item of knowledge) for (const fact of rangeFacts) {
    for (const edge of relations.get(fact.id)!) {
      if (edge.fromFact !== fact.id || edge.kind !== "negate" || !item.revision.supports.includes(edge.toFact)) continue;
      if (!lines.has(edge.toFact)) {
        const cited = store.getFact(edge.toFact)!;
        lines.set(cited.id, renderFact(cited, store.listFactRelations(cited.id)));
      }
      reminders.push([renderKnowledge(item), `Recorded negation strength: ${edge.strength}`,
        "Cited fact:", lines.get(edge.toFact)!, "Negating fact:", lines.get(fact.id)!].join("\n"));
    }
  }
  return { path, projectId: session.projectId, sessionId: session.id, branch: input.branch, rangeFacts, facts, context: store.listConsolidatedProjectFacts(session.projectId).filter((f) => !rangeFacts.some((r) => r.id === f.id)),
    knowledge, lines, reminders, model: input.model ?? "session",
    mode: input.mode ?? (config.consolidation.subagentModeDefault ? "subagent" : "branch"), threshold: config.consolidation.nearThreshold };
}

// Unicode character bigrams retain CJK text; punctuation and whitespace are ignored.
function bigrams(text: string): Set<string> {
  const chars = [...text.toLowerCase().replace(/[^\p{L}\p{N}]/gu, "")];
  return new Set(chars.slice(1).map((c, i) => chars[i]! + c));
}
function similarity(a: string, b: string): number {
  const left = bigrams(a), right = bigrams(b);
  const intersection = [...left].filter((gram) => right.has(gram)).length;
  const union = left.size + right.size - intersection;
  return union ? intersection / union : 0;
}
const candidates = (output: MemoryBatch) => output.operations.flatMap((op, i) => op.op === "archive" ? [] : [{ id: op.op === "create" ? `$e${i + 1}` : op.id!, text: op.text! }]);

export async function runConsolidation(store: Store, frozen: ReturnType<typeof freezeConsolidation>, runAgent: RunAgent,
  config: TraceMemoryConfig, bind: (context: Parameters<typeof bindTools>[2], run: RunInput, review: import("./memory.ts").MemoryReview) => ReturnType<typeof bindTools>): Promise<ConsolidateResult> {
  const { sessionId, branch, rangeFacts, context, knowledge, lines, reminders, model, mode, threshold } = frozen;
  if (!rangeFacts.length) return { outcome: "empty" };
  const range = { from: `F${rangeFacts[0]!.id}`, to: `F${rangeFacts.at(-1)!.id}`, facts: rangeFacts };
  const readKnowledgeCommits = knowledge.map(({ knowledge, revision }) => ({ knowledgeId: knowledge.id, commit: revision.id }));
  const rangeText = rangeFacts.map((f) => lines.get(f.id)!).join("\n");
  const episodic = budgetFacts(rangeText, context, (f) => lines.get(f.id)!, config.render.episodicBlockTokens, "range");
  const active = budgetKnowledge(knowledge, config.render.knowledgeBlockTokens);
  // Every part of the run's material, rendered and budgeted once. In an inherited context the fact
  // lines and the active knowledge are already in the conversation, delivered after the runs that
  // wrote them, and the exact membership excludes other paths and already-consolidated facts; which
  // parts a mode uses, and in which message, is the adapter's decision (ticket 19b).
  const material: ConsolidationMaterial = {
    factAddresses: rangeFacts.map((f) => `F${f.id}`),
    rangeFacts: rangeFacts.map((f) => lines.get(f.id)!),
    knowledge: active.groups.map((g) => g.text).filter(Boolean),
    consolidated: episodic.recent,
    reminders,
    receipts: [...episodic.receipts, ...active.receipts],
  };
  // A first valid `memory` batch commits nothing and returns the review guidance inside its receipt,
  // as a user-role message. Core owns that protocol and reads its own receipt; the adapter only
  // decides how to put the message in front of the model (native message, steering, appended turn).
  const reviewFeedback = (toolResult: string): string | undefined => {
    try { const value = JSON.parse(toolResult); return value?.feedback?.role === "user" ? String(value.feedback.content) : undefined; }
    catch { return undefined; }
  };
  const base = { kind: "consolidation" as const, sessionId, branch, range, readKnowledgeCommits, model, mode, prompt, promptHash };
  const run: RunInput = { kind: "consolidation", sessionId, branch, rangeFrom: range.from, rangeTo: range.to, promptHash, model, mode, createdAt: new Date().toISOString() };
  const label = (item: typeof knowledge[number]) => `K${item.knowledge.id}` +
    (knowledge.filter(k => k.knowledge.id === item.knowledge.id).length > 1 ? `@${item.revision.id}` : "");
  const binding = bind({ kind: "consolidation", sessionId, branch, headTurnId: frozen.path.headTurnId, range, readKnowledgeCommits }, run, { frozen, feedback: (batch) => {
  const near: NearPair[] = candidates(batch).flatMap((c) => knowledge
    .map(item => ({ candidate: c.id, knowledge: label(item), score: similarity(c.text, item.revision.text) }))
    .filter((p) => p.knowledge !== c.id && p.score >= threshold).sort((a, b) => b.score - a.score));
  const nearText = near.map((p) => `${p.candidate} -> ${p.knowledge} (Jaccard ${p.score})\n${renderKnowledge(knowledge.find((e) => label(e) === p.knowledge)!)}`);
  const closer = knowledge.filter(({ revision }) => revision.category === "open" || revision.category === "goal").flatMap((knowledge) =>
    rangeFacts.map((fact) => ({ fact, score: similarity(knowledge.revision.text, fact.text) }))
      .filter((p) => p.score >= threshold).sort((a, b) => b.score - a.score)
      .map((p) => `${renderKnowledge(knowledge)}\nJaccard ${p.score}\n${lines.get(p.fact.id)!}`));
  const feedback = ["System-generated review guidance; not a human ruling or adoption evidence.",
    "NEAR:", nearText.join("\n\n") || "none", "CLOSER:", closer.join("\n\n") || "none"].join("\n\n") + "\n" + checklist;
    return { text: feedback, near };
  } });
  let result: RunAgentResult;
  try { result = await runAgent({ ...structuredClone(base), material, reviewFeedback, tools: binding.tools, reportRequest: binding.reportRequest }); }
  catch (error) { result = { outcome: error instanceof Error && error.name === "AbortError" ? "cancelled" : "failure", output: error instanceof Error ? error.message : String(error) }; }
  binding.close();
  // A direct facade close may dispose before the provider settles; never access that store.
  if (store.closed) return binding.memory.committed ? { outcome: "success", ...binding.memory.committed, range, readKnowledgeCommits } : { outcome: "dropped" };
  run.mode = result.mode ?? mode;
  if (result.request != null) run.request = JSON.stringify(result.request);
  const committed = binding.memory.committed;
  // A host that cannot expose a provider request says so; core records the limitation instead of the
  // missing-request problem. A host expected to capture one and returning none still gets it.
  const unavailable = result.audit?.available === false;
  const problems = result.outcome !== "success" ? [String(result.output ?? result.outcome)] : result.request == null && !unavailable ? ["runAgent must return the exact provider request"] : binding.memory.problems;
  run.response = JSON.stringify({ output: result.output, usage: result.usage ?? null, ...(result.outcome === "cancelled" ? { usageStatus: result.usage == null ? "unknown" : "partial" } : {}), readKnowledgeCommits, toolCalls: binding.sequence, fetched: binding.fetched,
    candidate: binding.memory.candidate, problems, requestedMode: mode, ...(result.audit !== undefined ? { audit: result.audit } : {}),
    ...(committed ? { committed: committed.committed, diagnostics: committed.diagnostics } : {}),
    ...(result.verification !== undefined ? { verification: result.verification } : {}), ...(result.fallbackReason !== undefined ? { fallbackReason: result.fallbackReason } : {}),
    ...(result.nativeLog !== undefined ? { nativeLog: result.nativeLog } : {}),
    ...(result.retries?.length ? { retries: result.retries } : {}) });
  if (committed) {
    const after = [...problems];
    try { store.updateRun(committed.runId, { ...run, outcome: "success" }); }
    catch (error) { after.push(`audit update failed after commit: ${String(error)}`); }
    return { outcome: "success", ...committed, range, readKnowledgeCommits, ...(after.length ? { problems: after } : {}) };
  }
  const outcome = result.outcome !== "success" ? result.outcome : (result.request == null && !unavailable) || binding.memory.failure ? "failure" : problems.length ? "bounced" : "success";
  if (outcome !== "success") {
    const runId = binding.memory.failure?.runId ?? store.recordRun({ ...run, outcome }).id;
    if (binding.memory.failure) store.updateRun(runId, { ...run, outcome });
    return { outcome, runId, problems };
  }
  const empty = store.commitConsolidationRun({ run, operations: [], consolidated: rangeFacts.map((f) => f.id) });
  return empty.ok ? { outcome: "success", ...empty, output: { operations: [], skipped: [] }, diagnostics: [], unansweredNear: [], range, readKnowledgeCommits }
    : { outcome: "failure", runId: empty.runId, problems: empty.problems };
}
