import type { bindTools } from "../api/tools.ts";
import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { type Fact, type MemoryBatch } from "../model/index.ts";
import { type IntegrationDiagnostic } from "./commit.ts";
import type { CommittedKnowledgeOp, Store, RunInput } from "../store/index.ts";
import type { RunAgent, RunAgentResult, TraceMemoryConfig } from "../api/index.ts";
import { finish, renderKnowledge, renderFact, budgetKnowledge, budgetFacts } from "../render/index.ts";

const prompt = readFileSync(new URL("../prompts/integration.md", import.meta.url), "utf8");
const promptHash = createHash("sha256").update(prompt).digest("hex");
const sectionStart = prompt.indexOf("### Second-round user message\n") + "### Second-round user message\n".length;
const checklist = prompt.slice(sectionStart, prompt.indexOf("\n### ", sectionStart));

export type { IntegrationDiagnostic } from "./commit.ts";

export interface IntegrateInput { sessionId: number; branch: string; headTurnId?: number; model?: string; mode?: "branch" | "subagent" }
export interface IntegrationRange { from: string; to: string; facts: Fact[] }
export interface NearPair { candidate: string; knowledge: string; score: number }
export interface IntegrationAgentInput {
  kind: "integration";
  sessionId: number;
  branch: string;
  range: IntegrationRange;
  readKnowledgeCommits: { knowledgeId: number; commit: number }[];
  model: string;
  mode: "branch" | "subagent";
  prompt: string;
  promptHash: string;
  input: string;
  tools: import("../api/tools.ts").ToolDefinition[];
  reportRequest(request: unknown): void;
}
export type IntegrateResult =
  | { outcome: "dropped" | "empty" }
  | { outcome: "failure" | "cancelled" | "bounced"; runId: number; problems: string[] }
  | { outcome: "success"; runId: number; output: MemoryBatch; problems?: string[];
      committed: CommittedKnowledgeOp[]; diagnostics: IntegrationDiagnostic[];
      range: IntegrationRange; readKnowledgeCommits: { knowledgeId: number; commit: number }[]; unansweredNear: NearPair[] };

export function freezeIntegration(store: Store, input: IntegrateInput, config: TraceMemoryConfig) {
  const session = store.getSession(input.sessionId);
  if (!session) throw new Error(`session S${input.sessionId} does not exist`);
  if (typeof input.branch !== "string" || !input.branch) throw new Error("integration requires a non-empty branch");
  const after = store.getWatermark(session.id, input.branch)?.lastIntegratedFact ?? 0;
  const facts = store.listProjectFacts(session.projectId);
  const rangeFacts = store.integrationBatch(session.id, input.branch, config.integration.triggerUnintegratedFacts);
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
  return { path, projectId: session.projectId, sessionId: session.id, branch: input.branch, rangeFacts, facts, context: store.listIntegratedProjectFacts(session.projectId).filter((f) => !rangeFacts.some((r) => r.id === f.id)),
    knowledge, lines, reminders, model: input.model ?? "session",
    mode: input.mode ?? (config.integration.subagentModeDefault ? "subagent" : "branch"), threshold: config.integration.nearThreshold };
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

export async function runIntegration(store: Store, frozen: ReturnType<typeof freezeIntegration>, runAgent: RunAgent,
  config: TraceMemoryConfig, bind: (context: Parameters<typeof bindTools>[2], run: RunInput, review: import("./memory.ts").MemoryReview) => ReturnType<typeof bindTools>): Promise<IntegrateResult> {
  const { sessionId, branch, rangeFacts, context, knowledge, lines, reminders, model, mode, threshold } = frozen;
  if (!rangeFacts.length) return { outcome: "empty" };
  const range = { from: `F${rangeFacts[0]!.id}`, to: `F${rangeFacts.at(-1)!.id}`, facts: rangeFacts };
  const readKnowledgeCommits = knowledge.map(({ knowledge, revision }) => ({ knowledgeId: knowledge.id, commit: revision.id }));
  const rangeText = rangeFacts.map((f) => lines.get(f.id)!).join("\n");
  const episodic = budgetFacts(rangeText, context, (f) => lines.get(f.id)!, config.render.episodicBlockTokens, "range");
  const active = budgetKnowledge(knowledge, config.render.knowledgeBlockTokens);
  const recent = episodic.recent, knowledgeLines = active.groups.map((g) => g.text);
  const receipts = [...episodic.receipts, ...active.receipts];
  const initial = finish({ content: [`Range: ${range.from}..${range.to}`, "Active knowledge:", knowledgeLines.filter(Boolean).join("\n"),
    "Already-integrated facts (newest first):", recent.join("\n"), "Range facts:", rangeText,
    "Negated-evidence reminder (review cues only; no status derived):", reminders.join("\n\n") || "none"].join("\n\n"), receipts });
  const base = { kind: "integration" as const, sessionId, branch, range, readKnowledgeCommits, model, mode, prompt, promptHash };
  const run: RunInput = { kind: "integration", sessionId, branch, rangeFrom: range.from, rangeTo: range.to, promptHash, model, mode, createdAt: new Date().toISOString() };
  const label = (item: typeof knowledge[number]) => `K${item.knowledge.id}` +
    (knowledge.filter(k => k.knowledge.id === item.knowledge.id).length > 1 ? `@${item.revision.id}` : "");
  const binding = bind({ kind: "integration", sessionId, branch, headTurnId: frozen.path.headTurnId, range, readKnowledgeCommits }, run, { frozen, feedback: (batch) => {
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
  try { result = await runAgent({ ...structuredClone(base), input: initial, tools: binding.tools, reportRequest: binding.reportRequest }); }
  catch (error) { result = { outcome: error instanceof Error && error.name === "AbortError" ? "cancelled" : "failure", output: error instanceof Error ? error.message : String(error) }; }
  binding.close();
  run.mode = result.mode ?? mode;
  if (result.request != null) run.request = JSON.stringify(result.request);
  const committed = binding.memory.committed;
  const problems = result.outcome !== "success" ? [String(result.output ?? result.outcome)] : result.request == null ? ["runAgent must return the exact provider request"] : binding.memory.problems;
  run.response = JSON.stringify({ output: result.output, usage: result.usage ?? null, readKnowledgeCommits, toolCalls: binding.sequence, fetched: binding.fetched,
    candidate: binding.memory.candidate, problems, ...(committed ? { committed: committed.committed, diagnostics: committed.diagnostics } : {}),
    ...(result.verification !== undefined ? { verification: result.verification } : {}), ...(result.fallbackReason !== undefined ? { fallbackReason: result.fallbackReason } : {}) });
  if (committed) {
    const after = [...problems];
    try { store.updateRun(committed.runId, { ...run, outcome: "success" }); }
    catch (error) { after.push(`audit update failed after commit: ${String(error)}`); }
    return { outcome: "success", ...committed, range, readKnowledgeCommits, ...(after.length ? { problems: after } : {}) };
  }
  const outcome = result.outcome !== "success" ? result.outcome : result.request == null || binding.memory.failure ? "failure" : problems.length ? "bounced" : "success";
  if (outcome !== "success") {
    const runId = binding.memory.failure?.runId ?? store.recordRun({ ...run, outcome }).id;
    if (binding.memory.failure) store.updateRun(runId, { ...run, outcome });
    return { outcome, runId, problems };
  }
  const empty = store.commitIntegrationRun({ run, operations: [], watermark: { sessionId, branch, lastIntegratedFact: rangeFacts.at(-1)!.id } });
  return empty.ok ? { outcome: "success", ...empty, output: { operations: [], skipped: [] }, diagnostics: [], unansweredNear: [], range, readKnowledgeCommits }
    : { outcome: "failure", runId: empty.runId, problems: empty.problems };
}
