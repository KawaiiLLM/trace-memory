import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { validateSettleOutput, type Fact, type SettleOutput } from "../model/index";
import { commitFinal, type SettleDiagnostic } from "./commit";
import type { CommittedEntryOp, RejectedEntryOp, Store, RunInput } from "../store/index";
import type { RunAgent, RunAgentResult, TraceMemoryConfig } from "../api/index";
import { finish, renderEntry, renderFact, budgetEntries, budgetFacts } from "../render/index";

const prompt = readFileSync(new URL("../prompts/settle.md", import.meta.url), "utf8");
const promptHash = createHash("sha256").update(prompt).digest("hex");
const sectionStart = prompt.indexOf("### Second-round user message\n") + "### Second-round user message\n".length;
const checklist = prompt.slice(sectionStart, prompt.indexOf("\n### ", sectionStart));

export type { SettleDiagnostic } from "./commit";

export interface SettleInput { sessionId: number; branch: string; model?: string; mode?: "branch" | "subagent" }
export interface SettleRange { from: string; to: string; facts: Fact[] }
export interface NearPair { candidate: string; entry: string; score: number }
export interface SettleAgentInput {
  kind: "settle";
  round: "candidate" | "final";
  sessionId: number;
  branch: string;
  range: SettleRange;
  readEntryRevisions: { entryId: number; rev: number }[];
  model: string;
  mode: "branch" | "subagent";
  prompt: string;
  promptHash: string;
  input: string;
  continuation?: { request: unknown; response: RunAgentResult; message: { role: "user"; content: string } };
}
export type SettleResult =
  | { outcome: "dropped" | "empty" }
  | { outcome: "failure" | "cancelled" | "bounced"; runId: number; problems: string[] }
  | { outcome: "success"; runId: number; candidateRunId: number; output: SettleOutput;
      committed: CommittedEntryOp[]; rejected: RejectedEntryOp[]; diagnostics: SettleDiagnostic[];
      range: SettleRange; readEntryRevisions: { entryId: number; rev: number }[]; unansweredNear: NearPair[] };

export function freezeSettle(store: Store, input: SettleInput, config: TraceMemoryConfig) {
  const session = store.getSession(input.sessionId);
  if (!session) throw new Error(`session S${input.sessionId} does not exist`);
  if (typeof input.branch !== "string" || !input.branch) throw new Error("settle requires a non-empty branch");
  const after = store.getWatermark(session.id, input.branch)?.lastSettledFact ?? 0;
  const facts = store.listProjectFacts(session.projectId);
  const rangeFacts = store.listBranchFacts(session.id, input.branch).filter((f) => f.id > after).sort((a, b) => a.id - b.id);
  const entries = store.listVisibleEntries(session.id, session.projectId);
  const relations = new Map(facts.map((f) => [f.id, store.listFactRelations(f.id)]));
  const lines = new Map(facts.map((f) => [f.id, renderFact(f, relations.get(f.id)!)]));
  const reminders: string[] = [];
  for (const entry of entries) for (const fact of rangeFacts) {
    for (const edge of relations.get(fact.id)!) {
      if (edge.fromFact !== fact.id || edge.kind !== "negate" || !entry.revision.supports.includes(edge.toFact)) continue;
      if (!lines.has(edge.toFact)) {
        const cited = store.getFact(edge.toFact)!;
        lines.set(cited.id, renderFact(cited, store.listFactRelations(cited.id)));
      }
      reminders.push([renderEntry(entry), `Recorded negation strength: ${edge.strength}`,
        "Cited fact:", lines.get(edge.toFact)!, "Negating fact:", lines.get(fact.id)!].join("\n"));
    }
  }
  return { projectId: session.projectId, sessionId: session.id, branch: input.branch, rangeFacts, facts, context: store.listSettledProjectFacts(session.projectId).filter((f) => !rangeFacts.some((r) => r.id === f.id)),
    entries, lines, reminders, model: input.model ?? "session",
    mode: input.mode ?? (config.settle.subagentModeDefault ? "subagent" : "branch"), threshold: config.settle.nearThreshold };
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
const candidates = (output: SettleOutput) => [
  ...output.new.map((e) => ({ id: e.handle, text: e.text })),
  ...output.edit.map((e) => ({ id: e.id, text: e.text })),
  ...output.merge.map((e) => ({ id: e.into, text: e.text })),
];

export async function runSettle(store: Store, frozen: ReturnType<typeof freezeSettle>, runAgent: RunAgent,
  config: TraceMemoryConfig): Promise<SettleResult> {
  const { sessionId, branch, rangeFacts, context, entries, lines, reminders, model, mode, threshold } = frozen;
  if (!rangeFacts.length) return { outcome: "empty" };
  const range = { from: `F${rangeFacts[0]!.id}`, to: `F${rangeFacts.at(-1)!.id}`, facts: rangeFacts };
  const readEntryRevisions = entries.map(({ entry, revision }) => ({ entryId: entry.id, rev: revision.rev }));
  const rangeText = rangeFacts.map((f) => lines.get(f.id)!).join("\n");
  const episodic = budgetFacts(rangeText, context, (f) => lines.get(f.id)!, config.render.episodicBlockTokens, "range");
  const active = budgetEntries(entries, config.render.entriesBlockTokens);
  const recent = episodic.recent, entryLines = active.groups.map((g) => g.text);
  const receipts = [...episodic.receipts, ...active.receipts];
  const initial = finish({ content: [`Range: ${range.from}..${range.to}`, "Active entries:", entryLines.filter(Boolean).join("\n"),
    "Already-settled facts (newest first):", recent.join("\n"), "Range facts:", rangeText,
    "Negated-evidence reminder (review cues only; no status derived):", reminders.join("\n\n") || "none"].join("\n\n"), receipts });
  const base = { kind: "settle" as const, sessionId, branch, range, readEntryRevisions, model, mode, prompt, promptHash };
  async function attempt(round: "candidate" | "final", input: string, continuation?: SettleAgentInput["continuation"]) {
    const run: RunInput = { kind: "settle", sessionId, branch, rangeFrom: range.from, rangeTo: range.to,
      promptHash, model, mode, createdAt: new Date().toISOString() };
    let result: RunAgentResult;
    try { result = await runAgent(structuredClone({ ...base, round, input, ...(continuation ? { continuation } : {}) })); }
    catch (error) { result = { outcome: error instanceof Error && error.name === "AbortError" ? "cancelled" : "failure",
      output: error instanceof Error ? error.message : String(error) }; }
    run.request = result.request === undefined ? null : JSON.stringify(result.request);
    let outcome: "success" | "failure" | "cancelled" | "bounced" = result.outcome;
    let problems: string[] = [], output: SettleOutput | null = null;
    if (outcome !== "success") problems = [String(result.output ?? outcome)];
    else if (result.request == null) { outcome = "failure"; problems = ["runAgent must return the exact provider request"]; }
    else {
      try {
        const validated = validateSettleOutput(typeof result.output === "string" ? JSON.parse(result.output) : result.output);
        problems = validated.problems; output = validated.value;
      } catch (error) { problems = [`invalid JSON: ${String(error)}`]; }
      if (problems.length || !output) outcome = "bounced";
    }
    run.response = JSON.stringify({ output: result.output, usage: result.usage ?? null, readEntryRevisions, problems, round });
    const runId = round === "final" && outcome === "success" ? 0
      : store.recordRun({ ...run, outcome: outcome === "bounced" ? "failure" : outcome }).id;
    return { outcome, runId, problems, output, result, run };
  }
  const candidate = await attempt("candidate", initial);
  if (candidate.outcome !== "success") return { outcome: candidate.outcome, runId: candidate.runId, problems: candidate.problems };
  const near: NearPair[] = candidates(candidate.output!).flatMap((c) => entries
    .map(({ entry, revision }) => ({ candidate: c.id, entry: `E${entry.id}`, score: similarity(c.text, revision.text) }))
    .filter((p) => p.entry !== c.id && p.score >= threshold).sort((a, b) => b.score - a.score));
  const nearText = near.map((p) => `${p.candidate} -> ${p.entry} (Jaccard ${p.score})\n${renderEntry(entries.find((e) => `E${e.entry.id}` === p.entry)!)}`);
  const closer = entries.filter(({ revision }) => revision.category === "open" || revision.category === "goal").flatMap((entry) =>
    rangeFacts.map((fact) => ({ fact, score: similarity(entry.revision.text, fact.text) }))
      .filter((p) => p.score >= threshold).sort((a, b) => b.score - a.score)
      .map((p) => `${renderEntry(entry)}\nJaccard ${p.score}\n${lines.get(p.fact.id)!}`));
  const feedback = ["System-generated review guidance; not a human ruling or adoption evidence.",
    "NEAR:", nearText.join("\n\n") || "none", "CLOSER:", closer.join("\n\n") || "none"].join("\n\n") + "\n" + checklist;
  const final = await attempt("final", feedback, { request: candidate.result.request, response: candidate.result,
    message: { role: "user", content: feedback } });
  if (final.outcome !== "success") return { outcome: final.outcome, runId: final.runId, problems: final.problems };
  const output = final.output!;
  const surviving = new Set(candidates(output).map((c) => c.id));
  const unansweredNear = near.filter((p) => surviving.has(p.candidate) &&
    !output.edit.some((e) => e.id === p.entry) && !output.merge.some((e) => e.into === p.entry) &&
    !output.near_ack.some((ack) => ack.candidate === p.candidate && ack.entry === p.entry));
  const applied = commitFinal(store, frozen, output, final.run, unansweredNear);
  if (applied.outcome !== "success") return applied;
  return { ...applied, candidateRunId: candidate.runId, output, range, readEntryRevisions, unansweredNear };
}
