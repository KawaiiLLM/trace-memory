import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { ENTRY_CATEGORIES, validateNoteOutput, type Fact, type Turn } from "../model/index";
import type { Store, FactCommitInput, RunInput } from "../store/index";
import type { RunAgent, RunAgentResult, TraceMemoryConfig } from "../api/index";
import { finish, renderEntry, renderFact, renderTurn, tokens } from "../render/index";

const prompt = readFileSync(new URL("../prompts/note.md", import.meta.url), "utf8");
const promptHash = createHash("sha256").update(prompt).digest("hex");

export interface NoteInput {
  sessionId: number;
  branch: string;
  headTurnId: number;
  model?: string;
  mode?: "branch" | "subagent";
}
export interface NoteAgentInput {
  kind: "note";
  sessionId: number;
  branch: string;
  range: { from: string; to: string };
  readEntryRevisions: { entryId: number; rev: number }[];
  model: string;
  mode: "branch" | "subagent";
  prompt: string;
  promptHash: string;
  input: string;
  trace: (address: string) => string;
}
export type NoteResult =
  | { outcome: "dropped" | "empty" }
  | { outcome: "success"; runId: number; facts: Fact[] }
  | { outcome: "failure" | "cancelled" | "bounced"; runId: number; problems: string[] };

export function freezeNote(store: Store, input: NoteInput, config: TraceMemoryConfig) {
  const session = store.getSession(input.sessionId);
  if (!session) throw new Error(`session S${input.sessionId} does not exist`);
  if (typeof input.branch !== "string" || !input.branch) throw new Error("note requires a non-empty branch");
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
  const watermark = store.getWatermark(session.id, input.branch)?.lastNotedTurn;
  const index = watermark == null ? -1 : ancestry.findIndex((t) => t.id === watermark);
  if (watermark != null && index < 0) throw new Error("branch watermark is not an ancestor of its head; use a new branch identity");
  const turns = ancestry.slice(index + 1).map((turn) => ({ turn, calls: store.listToolCalls(turn.id) }));
  const entries = store.listVisibleEntries(session.id, session.projectId);
  const facts = store.listSessionFacts(session.id);
  return { sessionId: session.id, branch: input.branch, turns, entries, facts,
    model: input.model ?? "session", mode: input.mode ?? (config.note.branchModeDefault ? "branch" : "subagent") };
}

export async function runNote(
  store: Store, frozen: ReturnType<typeof freezeNote>, runAgent: RunAgent,
  config: TraceMemoryConfig, trace: (address: string) => string,
): Promise<NoteResult> {
  const { sessionId, branch, turns, entries, facts, model, mode } = frozen;
  if (!turns.length) return { outcome: "empty" };
  const address = (id: number) => `S${sessionId}/T${id}`;
  const range = { from: address(turns[0]!.turn.id), to: address(turns.at(-1)!.turn.id) };
  const readEntryRevisions = entries.map(({ entry, revision }) => ({ entryId: entry.id, rev: revision.rev }));
  const raw = turns.map(({ turn, calls }) => renderTurn(turn, calls, config.render));
  const rawText = raw.map((r) => r.content).join("\n\n");
  const receipts = raw.flatMap((r) => r.receipts);
  let used = tokens(rawText), dropped = 0;
  const recent: string[] = [];
  for (const fact of facts) {
    const line = renderFact(fact, store.listFactRelations(fact.id));
    if (dropped || used + tokens(line) > config.render.episodicBlockTokens) { dropped++; continue; }
    recent.push(line); used += tokens(line);
  }
  if (tokens(rawText) > config.render.episodicBlockTokens) receipts.push(`raw overage: ${tokens(rawText) - config.render.episodicBlockTokens} tokens; all unnoted raw kept`);
  if (dropped) receipts.push(`omitted ${dropped} older facts; expand: ${facts.slice(-dropped).map((f) => `F${f.id}`).join(", ")}`);
  const entryLines: string[] = [];
  let entryTokens = 0, omitCategories = false;
  for (const category of ENTRY_CATEGORIES) {
    const group = entries.filter(({ revision }) => revision.category === category);
    const text = group.map(renderEntry).join("\n");
    if (ENTRY_CATEGORIES.indexOf(category) >= 3 && (omitCategories || entryTokens + tokens(text) > config.render.entriesBlockTokens)) {
      omitCategories = true;
      if (group.length) receipts.push(`omitted ${group.length} ${category} entries; expand: ${group.map(({ entry }) => `E${entry.id}`).join(", ")}`);
    } else { entryLines.push(text); entryTokens += tokens(text); }
  }
  // Branch mode appends one message to the live conversation: the raw turns, the facts delivered
  // after earlier notes, and the injected entries are already in the model's context, so the
  // message carries only the range. Subagent mode must carry everything.
  const content = mode === "branch"
    ? [`Range: ${range.from}..${range.to}`,
       "The raw turns of this range, the facts delivered after earlier notes, and the active entries are already in this conversation."].join("\n\n")
    : [`Range: ${range.from}..${range.to}`, "Active entries:", entryLines.filter(Boolean).join("\n"),
       "Recent facts (newest first):", recent.join("\n"), "Raw:", rawText].join("\n\n");
  const fetched: { address: string; content: string }[] = [];
  let fetching = true;
  const agentInput: NoteAgentInput = { kind: "note", sessionId, branch, range, readEntryRevisions: structuredClone(readEntryRevisions), model, mode,
    prompt, promptHash, input: finish({ content, receipts: mode === "branch" ? [] : receipts }), trace: (address) => {
      if (!fetching) throw new Error("note run has finished");
      const content = trace(address); fetched.push({ address, content }); return content;
    } };
  const run: RunInput = { kind: "note", sessionId, branch, rangeFrom: range.from, rangeTo: range.to,
    promptHash, model, mode, createdAt: new Date().toISOString() };
  let result: RunAgentResult;
  try { result = await runAgent(agentInput); }
  catch (error) {
    result = { outcome: error instanceof Error && error.name === "AbortError" ? "cancelled" : "failure",
      output: error instanceof Error ? error.message : String(error) };
  } finally { fetching = false; }
  run.request = result.request === undefined ? null : JSON.stringify(result.request);
  const record = (problems: string[]) => {
    run.response = JSON.stringify({ output: result.output, usage: result.usage ?? null, readEntryRevisions, fetched, problems });
  };
  const fail = (outcome: "failure" | "cancelled" | "bounced", problems: string[]): NoteResult => {
    record(problems);
    return { outcome, problems, runId: store.recordRun({ ...run, outcome: outcome === "bounced" ? "failure" : outcome }).id };
  };
  if (result.outcome !== "success") return fail(result.outcome, [String(result.output ?? result.outcome)]);
  if (result.request === undefined || result.request === null) return fail("failure", ["runAgent must return the exact provider request"]);
  let parsed: unknown;
  try { parsed = typeof result.output === "string" ? JSON.parse(result.output) : result.output; }
  catch (error) { return fail("bounced", [`invalid JSON: ${String(error)}`]); }
  const validated = validateNoteOutput(parsed);
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
  const committed = store.commitNoteRun({ run, facts: commits,
    watermark: { sessionId, branch, lastNotedTurn: turns.at(-1)!.turn.id }, pendingDelivery: { sessionId, branch } });
  return committed.ok ? { outcome: "success", runId: committed.runId, facts: committed.facts }
    : { outcome: "bounced", runId: committed.runId, problems: committed.problems };
}
