import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { validateRecordingOutput, type Fact, type Turn } from "../model/index.ts";
import type { Store, FactCommitInput, RunInput } from "../store/index.ts";
import type { RunAgent, RunAgentResult, TraceMemoryConfig } from "../api/index.ts";
import { finish, renderFact, renderTurn, budgetKnowledge, budgetFacts } from "../render/index.ts";

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
  readKnowledgeRevisions: { knowledgeId: number; rev: number }[];
  model: string;
  mode: "branch" | "subagent";
  prompt: string;
  promptHash: string;
  input: string;
  /** Frozen full context for a host fallback after branch verification fails. */
  subagentInput: string;
  trace: (address: string) => string;
}
export type RecordResult =
  | { outcome: "dropped" | "empty" }
  | { outcome: "success"; runId: number; facts: Fact[] }
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
  const watermark = store.getWatermark(session.id, input.branch)?.lastRecordedTurn;
  const index = watermark == null ? -1 : ancestry.findIndex((t) => t.id === watermark);
  if (watermark != null && index < 0) throw new Error("branch watermark is not an ancestor of its head; use a new branch identity");
  const turns = ancestry.slice(index + 1).map((turn) => ({ turn, calls: store.listToolCalls(turn.id) }));
  const knowledge = store.listVisibleKnowledge(session.id, session.projectId);
  const facts = store.listSessionFacts(session.id);
  return { sessionId: session.id, branch: input.branch, turns, knowledge, facts,
    model: input.model ?? "session", mode: input.mode ?? (config.recording.branchModeDefault ? "branch" : "subagent") };
}

export async function runRecording(
  store: Store, frozen: ReturnType<typeof freezeRecording>, runAgent: RunAgent,
  config: TraceMemoryConfig, trace: (address: string) => string,
): Promise<RecordResult> {
  const { sessionId, branch, turns, knowledge, facts, model, mode } = frozen;
  if (!turns.length) return { outcome: "empty" };
  const address = (id: number) => `S${sessionId}/T${id}`;
  const range = { from: address(turns[0]!.turn.id), to: address(turns.at(-1)!.turn.id) };
  const readKnowledgeRevisions = knowledge.map(({ knowledge, revision }) => ({ knowledgeId: knowledge.id, rev: revision.rev }));
  const raw = turns.map(({ turn, calls }) => renderTurn(turn, calls, config.render));
  const rawText = raw.map((r) => r.content).join("\n\n");
  const receipts = raw.flatMap((r) => r.receipts);
  const episodic = budgetFacts(rawText, facts, (f) => renderFact(f, store.listFactRelations(f.id)), config.render.episodicBlockTokens);
  const active = budgetKnowledge(knowledge, config.render.knowledgeBlockTokens);
  const recent = episodic.recent, knowledgeLines = active.groups.map((g) => g.text);
  receipts.push(...episodic.receipts, ...active.receipts);
  // Branch mode appends one message to the live conversation and carries only the range (ruling
  // 08:53: fork mode has only the last of the four inputs); the prompt says where the rest is.
  // Subagent mode must carry everything.
  const subagentInput = finish({ content: [`Range: ${range.from}..${range.to}`, "Active knowledge:", knowledgeLines.filter(Boolean).join("\n"),
    "Recent facts (newest first):", recent.join("\n"), "Raw:", rawText].join("\n\n"), receipts });
  const input = mode === "branch" ? `Range: ${range.from}..${range.to}` : subagentInput;
  const fetched: { address: string; content: string }[] = [];
  let fetching = true;
  const agentInput: RecordingAgentInput = { kind: "recording", sessionId, branch, range, readKnowledgeRevisions: structuredClone(readKnowledgeRevisions), model, mode,
    prompt, promptHash, subagentInput, input, trace: (address) => {
      if (!fetching) throw new Error("recording run has finished");
      const content = trace(address); fetched.push({ address, content }); return content;
    } };
  const run: RunInput = { kind: "recording", sessionId, branch, rangeFrom: range.from, rangeTo: range.to,
    promptHash, model, mode, createdAt: new Date().toISOString() };
  let result: RunAgentResult;
  try { result = await runAgent(agentInput); }
  catch (error) {
    result = { outcome: error instanceof Error && error.name === "AbortError" ? "cancelled" : "failure",
      output: error instanceof Error ? error.message : String(error) };
  } finally { fetching = false; }
  run.mode = result.mode ?? mode;
  run.request = result.request === undefined ? null : JSON.stringify(result.request);
  const record = (problems: string[]) => {
    run.response = JSON.stringify({ output: result.output, usage: result.usage ?? null, readKnowledgeRevisions, fetched, problems,
      ...(result.verification !== undefined ? { verification: result.verification } : {}),
      ...(result.fallbackReason !== undefined ? { fallbackReason: result.fallbackReason } : {}) });
  };
  const fail = (outcome: "failure" | "cancelled" | "bounced", problems: string[]): RecordResult => {
    record(problems);
    return { outcome, problems, runId: store.recordRun({ ...run, outcome: outcome === "bounced" ? "failure" : outcome }).id };
  };
  if (result.outcome !== "success") return fail(result.outcome, [String(result.output ?? result.outcome)]);
  if (result.request === undefined || result.request === null) return fail("failure", ["runAgent must return the exact provider request"]);
  let parsed: unknown;
  try { parsed = typeof result.output === "string" ? JSON.parse(result.output) : result.output; }
  catch (error) { return fail("bounced", [`invalid JSON: ${String(error)}`]); }
  const validated = validateRecordingOutput(parsed);
  if (validated.problems.length || !validated.value) return fail("bounced", validated.problems);
  const problems: string[] = [], commits: FactCommitInput[] = [];
  let prior = -1;
  for (const batch of validated.value) {
    const index = turns.findIndex(({ turn }) => address(turn.id) === batch.turn);
    if (index < 0 || index <= prior) { problems.push(`${batch.turn}: turn must occur once, in frozen range order`); continue; }
    prior = index;
    const { turn } = turns[index]!;
    if (turn.kind === "compaction" && batch.facts.length) problems.push(`${batch.turn}: compaction turns cannot have facts`);
    for (const fact of batch.facts) {
      for (const relation of [...(fact.support ?? []), ...(fact.negate ?? [])]) {
        const n = Number(relation.target.slice(1));
        if (relation.target.startsWith("$") ? n < 1 || n > commits.length : !facts.some((f) => f.id === n)) {
          problems.push(`${batch.turn}: invalid relation target ${relation.target}; expected an existing fact or earlier local handle`);
        }
      }
      commits.push({ ...fact, turnId: turn.id, createdAt: fact.timestamp });
    }
  }
  if (problems.length) return fail("bounced", problems);
  record([]);
  const committed = store.commitRecordingRun({ run, facts: commits,
    watermark: { sessionId, branch, lastRecordedTurn: turns.at(-1)!.turn.id }, pendingDelivery: { sessionId, branch } });
  return committed.ok ? { outcome: "success", runId: committed.runId, facts: committed.facts }
    : { outcome: "bounced", runId: committed.runId, problems: committed.problems };
}
