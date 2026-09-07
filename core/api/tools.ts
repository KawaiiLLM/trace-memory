import { sourceAddresses } from "../render/index.ts";
import { bindMemory, type MemoryReview } from "../integration/memory.ts";
import { ACTORS, FACT_CATEGORIES, EVENT_STATUSES, KNOWLEDGE_CATEGORIES, KNOWLEDGE_SCOPES, validateRecordingFact, type Fact } from "../model/index.ts";
import type { Store, RunInput, FactCommitInput } from "../store/index.ts";
import type { ListingOptions, SearchScope } from "./read.ts";

export interface ToolDefinition {
  name: "trace" | "search" | "note" | "memory";
  description: string;
  parameters: Record<string, unknown>;
  execute(input: unknown): string;
}
export type ToolContext = { kind: "manual"; sessionId: number; branch: string; currentTurnId: number }
  | { kind: "recording" | "integration"; sessionId: number; branch: string; headTurnId?: number | null; entryIds?: number[]; range: { from: string; to: string };
      readKnowledgeCommits: { knowledgeId: number; commit: number }[] };
type Reads = { trace(address: string, options?: ListingOptions): string;
  search(query: string, layer?: SearchScope, options?: ListingOptions & { sessionId?: number }): string };
const object = (properties: Record<string, unknown>, required: string[] = []) => ({ type: "object", properties, required, additionalProperties: false });
const string = { type: "string" };
const relation = { type: "array", items: { type: "array", prefixItems: [{ type: "string", pattern: "^(F[1-9][0-9]*|\\$[1-9][0-9]*)$" }, { enum: ["strong", "weak"] }], minItems: 2, maxItems: 2 } };
const factSchema = { ...object({ category: { enum: FACT_CATEGORIES }, actor: { enum: ACTORS }, text: { type: "string", minLength: 1 }, quote: string,
  source: { type: "array", minItems: 1, items: { type: "string", pattern: "^T[1-9][0-9]*#(user|assistant|t[1-9][0-9]*)$" } },
  support: relation, negate: relation, status: { enum: EVENT_STATUSES } }, ["category", "actor", "text", "source"]),
  allOf: [{ if: { properties: { category: { const: "event" } } }, then: { required: ["status"] }, else: { not: { required: ["status"] } } }] };
const pagination = { cursor: string, cap: { type: "integer", minimum: 1 } };

const factId = { type: "string", pattern: "^F[1-9][0-9]*$" };
const knowledgeId = { type: "string", pattern: "^K[1-9][0-9]*(@[1-9][0-9]*)?$" };
const memoryOperationSchema = { ...object({ op: { enum: ["create", "update", "merge", "archive"] }, id: knowledgeId,
  absorb: { type: "array", items: knowledgeId, minItems: 1, uniqueItems: true }, text: { type: "string", minLength: 1 },
  category: { enum: KNOWLEDGE_CATEGORIES }, scope: { enum: KNOWLEDGE_SCOPES }, supports: { type: "array", items: factId, minItems: 1 },
  because: { type: "array", items: factId } }, ["op", "because"]), allOf: [
  { if: { properties: { op: { const: "create" } } }, then: { not: { required: ["id"] } }, else: { required: ["id"] } },
  { if: { properties: { op: { const: "merge" } } }, then: { required: ["absorb"] }, else: { not: { required: ["absorb"] } } },
  { if: { properties: { op: { const: "archive" } } }, then: { not: { anyOf: ["text", "category", "scope", "supports"].map(key => ({ required: [key] })) } }, else: { required: ["text", "category", "scope", "supports"] } },
] };

export const toolDefinitions: Omit<ToolDefinition, "execute">[] = [
  { name: "trace", description: "Read evidence by address: any fact, raw turn or tool call, knowledge identity or global integer commit: K1, K1@57, K1@57..K1@61, K1.. (all branches). Reads are unrestricted. F<n>.. navigates later strong negations, never a current conclusion.", parameters: object({ address: string, tool: { type: "integer", minimum: 1 }, full: { type: "boolean" }, ...pagination }, ["address"]) },
  { name: "search", description: "Use unrestricted literal substring search over facts, raw and knowledge commits. layer selects facts, knowledge, raw or all; no hit does not mean absent.", parameters: object({ query: string, layer: { enum: ["facts", "knowledge", "raw", "all"] }, ...pagination }, ["query"]) },
  { name: "note", description: "Write one atomic facts batch. Recording runs are the normal writers; main agents may write but have no memory duty. Rejections write nothing; correct and resubmit the whole batch. No timestamps; event status is required. $n references an earlier item in this batch.", parameters: object({ facts: { type: "array", items: factSchema } }, ["facts"]) },
  { name: "memory", description: "Write one atomic knowledge batch. Integration runs are the normal writers; main agents may write but have no memory duty. Submit complete resulting text/category/scope/supports and triggering facts in because. First valid Integration batch returns review guidance; resubmit the whole batch to commit. Manual calls commit immediately. Base-commit rejection: update, merge and archive reject the whole batch if the read base has an applicable successor on this path; re-read and resubmit. Bare K1 is rejected with several tips; use explicit K1@57 bases.", parameters: object({ operations: { type: "array", items: memoryOperationSchema }, skipped: { type: "array", items: object({ fact: factId, because: { type: "string", minLength: 1 } }, ["fact", "because"]) } }, ["operations", "skipped"]) },
];

export function validateReadInput(name: "trace" | "search", raw: unknown): Record<string, unknown> {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new Error("expected an object");
  const input = raw as Record<string, unknown>;
  const properties = toolDefinitions.find(t => t.name === name)!.parameters.properties as object;
  if (Object.keys(input).some(k => !(k in properties))) throw new Error("unexpected parameter");
  if (name === "trace") {
    if (typeof input.address !== "string") throw new Error("address must be a string");
    if (input.tool !== undefined && (!Number.isSafeInteger(input.tool) || Number(input.tool) < 1)) throw new Error("tool must be a positive ordinal");
    if (input.full !== undefined && typeof input.full !== "boolean") throw new Error("full must be boolean");
  } else if (typeof input.query !== "string") throw new Error("query must be a string");
  return input;
}

export function bindTools(store: Store, read: Reads, supplied: ToolContext, metadata?: RunInput, review?: MemoryReview) {
  const context = structuredClone(supplied);
  const session = store.getSession(context.sessionId);
  if (!session || !context.branch) throw new Error("tools require an existing session and a non-empty branch");
  const allowed = new Set<number>();
  if (context.kind === "manual") {
    if (store.getTurn(context.currentTurnId)?.sessionId !== session.id) throw new Error("current turn must belong to the calling session");
  } else if (context.kind === "recording") {
    const parse = (address: string) => {
      const m = /^S([1-9]\d*)\/T([1-9]\d*)$/.exec(address);
      if (!m || Number(m[1]) !== session.id) throw new Error("invalid frozen range");
      return Number(m[2]);
    };
    const from = parse(context.range.from); let id: number | null = parse(context.range.to);
    while (id !== null && !allowed.has(id)) {
      const turn = store.getTurn(id);
      if (!turn || turn.sessionId !== session.id) throw new Error("invalid frozen range");
      allowed.add(id); if (id === from) break; id = turn.parentTurnId;
    }
    if (!allowed.has(from)) throw new Error("invalid frozen range ancestry");
  }
  const run: RunInput = metadata ?? { kind: context.kind, sessionId: session.id, branch: context.branch,
    rangeFrom: context.kind === "manual" ? `S${session.id}/T${context.currentTurnId}` : context.range.from,
    rangeTo: context.kind === "manual" ? `S${session.id}/T${context.currentTurnId}` : context.range.to, createdAt: new Date().toISOString() };
  if (context.kind === "integration" && !review) throw new Error("Integration tools require the frozen review context supplied by integrate()");
  // The branch rides on the path so applicability is judged per source entry (review 2026-09-08 P1).
  const path = context.kind === "manual" ? { sessionId: session.id, headTurnId: context.currentTurnId, branch: context.branch }
    : context.kind === "recording" ? { sessionId: session.id, headTurnId: Number(context.range.to.split("/T")[1]), branch: context.branch }
    : review!.frozen.path;
  const sourceTurns = store.pathTurns(path);
  const manualSourceEligible = (source: string) => store.sourcePath(session.id, context.branch, path.headTurnId!).some(e => sourceAddresses(e).includes(source));
  const frozenEntries = context.kind === "recording" ? (context.entryIds ?? store.sourcePath(session.id, context.branch, path.headTurnId!).filter(e => allowed.has(e.turnId)).map(e => e.id)) : [];
  const frozenSources = new Set(frozenEntries.flatMap(id => sourceAddresses(store.getSourceEntry(id)!)));
  const frozenPath = new Set(context.kind === "recording" ? store.sourcePath(session.id, context.branch, path.headTurnId!).map(e => e.id) : []);
  const sourceEligible = (source: string) => frozenSources.has(source) && !store.sourcePath(session.id, context.branch, path.headTurnId!)
    .some(e => !frozenPath.has(e.id) && sourceAddresses(e).includes(source));
  const memory = bindMemory(store, session.id, run, review, path);
  const sequence = memory.sequence;
  const fetched: { address: string; input: unknown; content: string }[] = [];
  let closed = false, committed: { runId: number; facts: Fact[] } | undefined;
  let problems: string[] = [];
  // Reads resolve any existing address (user ruling 2026-09-07: no visibility limits on reads);
  // injection and Integration keep their scope rules elsewhere. Writes still bind sources to the run.
  const existingFact = (id: number) => !!store.getFact(id);
  const note = (input: Record<string, unknown>): string => {
    if (context.kind === "integration") return "rejected: note is not the writer for an integration run";
    if (!Array.isArray(input.facts) || Object.keys(input).some((k) => k !== "facts")) {
      problems = ["note expects {facts: [...]} only"]; return `rejected: ${problems[0]}`;
    }
    const commits: FactCommitInput[] = [];
    const results = input.facts.map((raw, index) => {
      const errors: string[] = [];
      const fact = validateRecordingFact(`facts[${index}]`, raw, errors);
      if (fact) {
        let first = 0;
        if (Array.isArray(fact.source)) for (const source of fact.source) {
          const m = typeof source === "string" ? /^T([1-9]\d*)#(user|assistant|t([1-9]\d*))$/.exec(source) : null;
          const turn = m ? store.getTurn(Number(m[1])) : null;
          if (!turn || turn.sessionId !== session.id || !sourceTurns.has(turn.id) || (context.kind === "manual" && !manualSourceEligible(source)) || (context.kind === "recording" && !sourceEligible(source)) || turn.kind === "compaction") errors.push(`invalid source ${source}; does not exist in the eligible entry set; expected a raw source on the current branch inside the frozen range or calling session; injected messages are not sources`);
          else {
            if (!first) first = turn.id;
            if ((m![2] === "user" && turn.userPrompt === null) || (m![2] === "assistant" && turn.assistantText === null) || (m![3] && !store.listToolCalls(turn.id).some((c) => c.ordinal === Number(m![3])))) errors.push(`source ${source} does not exist`);
          }
        }
        for (const kind of ["support", "negate"] as const) {
          const seen = new Set<string>();
          for (const rel of fact[kind] ?? []) {
            const n = typeof rel.target === "string" ? Number(rel.target.slice(1)) : NaN;
            if (typeof rel.target !== "string" || (rel.target.startsWith("$") ? !Number.isSafeInteger(n) || n < 1 || n > index : !existingFact(n))) errors.push(`invalid relation target ${rel.target}; expected existing fact or earlier local handle`);
            if (seen.has(rel.target)) errors.push(`duplicate ${kind} target ${rel.target}`);
            seen.add(rel.target);
          }
        }
        if (first) commits.push({ ...fact, turnId: first, createdAt: store.getTurn(first)!.startedAt });
      }
      return errors.length ? `rejected: ${errors.join("; ")}` : "ok";
    });
    problems = results.filter((r) => r.startsWith("rejected:"));
    if (problems.length) return JSON.stringify({ results });
    const receipt = (ids: number[]) => JSON.stringify({ results: ids.map((id) => `ok: F${id}`), factIds: ids });
    const committedRun = store.commitRecordingRun({ run: { ...run,
      ...(context.kind === "manual" ? { request: JSON.stringify(input) } : {}),
      response: JSON.stringify({ toolCalls: [...sequence, { name: "note", input, result: "ok" }], readKnowledgeCommits: context.kind === "recording" ? context.readKnowledgeCommits : [] }) }, facts: commits,
      responseForFacts: (ids) => context.kind === "manual" ? receipt(ids) : JSON.stringify({ toolCalls: [...sequence, { name: "note", input, result: receipt(ids) }], fetched, problems: [], readKnowledgeCommits: context.readKnowledgeCommits }),
      ...(context.kind === "recording" ? { entryIds: frozenEntries,
        pendingDelivery: { sessionId: session.id, branch: context.branch } } : {}) });
    if (!committedRun.ok) { problems = committedRun.problems; return JSON.stringify({ results: results.map(() => `rejected: ${problems.join("; ")}`) }); }
    const result = receipt(committedRun.facts.map((f) => f.id));
    if (context.kind === "recording") committed = committedRun;
    return result;
  };
  const definition = (name: ToolDefinition["name"], execute: (input: Record<string, unknown>) => string): ToolDefinition => ({ ...toolDefinitions.find(t => t.name === name)!,
    execute: (raw) => {
      if (closed) return "rejected: run has finished";
      if ((name === "note" || name === "memory") && !store.enabled(session.id)) return "rejected: Trace Memory is Disabled; use /trace enable to enable memory.";
      let result: string;
      try {
        if (name === "note" && committed) result = "rejected: already committed";
        else if (name === "memory") result = execute(raw && typeof raw === "object" ? raw as Record<string, unknown> : {});
        else {
          if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new Error("expected an object");
          if (name === "trace" || name === "search") validateReadInput(name, raw);
          result = execute(raw as Record<string, unknown>);
        }
      } catch (error) { result = `rejected: ${error instanceof Error ? error.message : String(error)}`; if (name === "note" && !committed) problems = [result]; }
      sequence.push({ name, input: structuredClone(raw), result });
      if (context.kind === "manual" && (name === "note" || name === "memory") && result.includes("rejected:")) store.recordRun({ ...run, request: JSON.stringify(raw), response: result, outcome: "bounced" });
      if (committed) store.updateRun(committed.runId, { ...run, outcome: "success", response: JSON.stringify({ toolCalls: sequence, fetched, problems: [], ...(context.kind === "recording" ? { readKnowledgeCommits: context.readKnowledgeCommits } : {}) }) });
      return result;
    } });
  const tools = [
    definition("trace", (input) => {
      const content = read.trace(input.address as string, { ...input as ListingOptions, sessionId: session.id, headTurnId: path.headTurnId });
      memory.reread(input.address as string);
      fetched.push({ address: input.address as string, input: structuredClone(input), content }); return content;
    }),
    definition("search", (input) => {
      if (typeof input.query !== "string") throw new Error("query must be a string");
      return read.search(input.query, input.layer as SearchScope | undefined, { ...input as ListingOptions, sessionId: session.id, headTurnId: path.headTurnId });
    }),
    definition("note", note),
    definition("memory", input => context.kind === "recording" ? "rejected: memory is not the writer for a recording run" : memory.execute(input)),
  ];
  return { tools, sequence, fetched, memory, get committed() { return committed; }, get problems() { return problems; }, close: () => { closed = true; },
    reportRequest: (request: unknown) => { if (closed) throw new Error("recording run has finished"); memory.requestSeen(); run.request = JSON.stringify(request); } };
}
