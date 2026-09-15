import { resolveFactSource, type SourceResolution } from "../model/source.ts";
import { bindMemory, type MemoryReview } from "../consolidation/memory.ts";
import { ACTORS, FACT_CATEGORIES, EVENT_STATUSES, KNOWLEDGE_CATEGORIES, KNOWLEDGE_SCOPES, validateNotingFact, type Fact } from "../model/index.ts";
import type { Store, RunInput, FactCommitInput, KnowledgeWithRevision, KnowledgePath } from "../store/index.ts";
import { DEFAULT_READ_TOKENS, MAX_PUBLIC_READ_TOKENS, READ_FIELDS, READ_VERSIONS, READ_WHERE, SEARCH_PREVIEW_TOKENS, validateBudgets, type ListingOptions, type SearchScope, type TraceRead } from "./read.ts";
import { captureNotingNear, notingNearAudit, notingNearFeedback, unansweredNotingNear, type NotingDiagnostic, type NotingNearSnapshot } from "../noting/review.ts";

export interface ToolDefinition {
  name: "trace" | "search" | "note" | "memory" | "check";
  description: string;
  parameters: Record<string, unknown>;
  execute(input: unknown): string;
}
export type ToolContext = { kind: "manual"; sessionId: number; branch: string; currentTurnId: number; triggerEntryId?: number; readKnowledgeCommits?: { knowledgeId: number; commit: number }[] }
  | { kind: "noting" | "consolidation" | "dreaming"; sessionId: number; branch: string; headTurnId?: number | null; triggerEntryId?: number; entryIds?: number[]; range: { from: string; to: string };
      readKnowledgeCommits: { knowledgeId: number; commit: number }[] };
type Reads = { traceRead(address: string, options?: ListingOptions): TraceRead;
  search(query: string, layer?: SearchScope, options?: ListingOptions & { sessionId?: number }): string };
const object = (properties: Record<string, unknown>, required: string[] = []) => ({ type: "object", properties, required, additionalProperties: false });
const string = { type: "string" };
const relation = { type: "array", items: { type: "array", prefixItems: [{ type: "string", pattern: "^(F[1-9][0-9]*|\\$[1-9][0-9]*)$" }, { enum: ["strong", "weak"] }], minItems: 2, maxItems: 2 } };
const factSchema = { ...object({ category: { enum: FACT_CATEGORIES }, actor: { enum: ACTORS }, text: { type: "string", minLength: 1 }, quote: string,
  source: { type: "array", minItems: 1, items: { type: "string", minLength: 1 } },
  support: relation, negate: relation, status: { enum: EVENT_STATUSES } }, ["category", "actor", "text", "source"]),
  allOf: [{ if: { properties: { category: { const: "event" } } }, then: { required: ["status"] }, else: { not: { required: ["status"] } } }] };
const pagination = { cursor: string, cap: { type: "integer", minimum: 1 } };
const contentBudget = { anyOf: [{ type: "integer", minimum: 1, maximum: Number.MAX_SAFE_INTEGER }, { type: "null" }] };
const fields = { type: "array", uniqueItems: true, items: { enum: READ_FIELDS } };
const budgets = { itemBudget: { ...contentBudget, default: 2000 }, toolCallBudget: { ...contentBudget, default: 100 }, toolResultBudget: { ...contentBudget, default: 100 }, pageBudget: { type: "integer", minimum: 1, maximum: MAX_PUBLIC_READ_TOKENS, default: DEFAULT_READ_TOKENS } };
const readFilters = { where: { enum: READ_WHERE, default: "project", description: "Session selection: project sessions, this session, or all sessions. Unbound core reads default to all." },
  versions: { enum: READ_VERSIONS, default: "current", description: "Knowledge versions: path-current, applicable history, or all branches." },
  category: { enum: KNOWLEDGE_CATEGORIES, description: "Knowledge category. Implies layer=knowledge when layer is omitted." },
  scope: { enum: KNOWLEDGE_SCOPES, description: "Knowledge scope. Implies layer=knowledge when layer is omitted." } };

const factId = { type: "string", pattern: "^F[1-9][0-9]*$" };
const knowledgeId = { type: "string", pattern: "^K[1-9][0-9]*@[1-9][0-9]*$" };
const memoryOperationSchema = { ...object({ op: { enum: ["create", "update", "merge", "archive"] }, id: knowledgeId,
  absorb: { type: "array", items: knowledgeId, minItems: 1, maxItems: 1, uniqueItems: true }, text: { type: "string", minLength: 1 },
  category: { enum: KNOWLEDGE_CATEGORIES }, scope: { enum: KNOWLEDGE_SCOPES }, supports: { type: "array", items: factId, minItems: 1 },
  reason: { type: "string", minLength: 1 }, topics: { type: "array", items: { type: "string", minLength: 1 } } }, ["op", "supports", "reason"]), allOf: [
  { if: { properties: { op: { const: "create" } } }, then: { not: { required: ["id"] } }, else: { required: ["id"] } },
  { if: { properties: { op: { const: "merge" } } }, then: { required: ["absorb"] }, else: { not: { required: ["absorb"] } } },
  { if: { properties: { op: { const: "archive" } } }, then: { not: { anyOf: ["text", "category", "scope", "topics"].map(key => ({ required: [key] })) } }, else: { required: ["text", "category", "scope", "topics"] } },
] };

export const toolDefinitions: Omit<ToolDefinition, "execute">[] = [
  { name: "trace", description: "Read evidence by address. For a complete knowledge version include text (the default) and use trace({address:'K12@57',itemBudget:null}); pageBudget still applies. Follow every cursor before an exact write handle is granted. Complete K versions already supplied internally need no reread. T792 is a Turn; T792#E2 is its stable native entry; T792#E2@text, @thinking or @toolCallId select stored blocks. T792@user/@assistant/@toolResult selects complete role messages; @text collects text (including result text), never arguments or thinking. T792@F* selects Turn-owned facts. T792#E2..E7 is inclusive (gaps allowed); T792#E2,E7 keeps written order and repeats, with a trailing @selector applying to the whole selection. A new complete T/F/K target starts another component. Tool IDs containing delimiters or reserved selector names use a JSON-quoted selector. No other globbing or chained @. Legacy #user/#assistant/#tN remain readable; new citations use exact E addresses. itemBudget caps EACH child of the selected container (Turn: entries; one entry: blocks), default 2000; toolCallBudget and toolResultBudget default 100 as additional ceilings. null disables each content ceiling independently; to remove all compression set ALL THREE to null. pageBudget independently defaults to 2000 and is capped at 8000 for every public trace read. fields defaults to text, supports, topics, status, links and marks for current/exact reads; history/all and K.. additionally default to reason, which appears only on history commit lines. Knowledge identity or global integer commit: K1, K1@57, K1@57..K1@61, K1.. (all branches). Bare K defaults to current versions in the reader's project; versions=history adds applicable history and versions=all adds other branches. Exact K@commit, commit diffs, F and T addresses ignore data filters and remain unrestricted. F<n>.. navigates later strong negations, never a current conclusion. One address may list several, comma separated, in the order asked and repeats kept: F81,F90,F95, kinds mixable. F81-F90 is the inclusive fact-id interval (ascending endpoints), combinable as F81-F90,F95; it reads the facts that exist in the range and is empty when none do. Each page is at most 2000 estimated tokens by default, including receipts; cap counts output lines (default 100). full removes content compression, not pagination. Oversized lines continue in lossless fragments (see receipts). cursor continues that same frozen read alone, retaining its token budget.", parameters: object({ address: string, ...readFilters, fields, ...budgets, tool: { type: "integer", minimum: 1 }, full: { type: "boolean" }, ...pagination }, ["address"]) },
  { name: "search", description: `Use literal substring search over facts, raw and knowledge commits. where defaults to this project's sessions and versions defaults to current knowledge; unbound core reads default to all sessions. category or scope implies layer=knowledge when layer is omitted and conflicts with every other layer. Fact and knowledge hits are one-line previews: fields defaults to text for current searches and to text plus status for knowledge history/all; explicit fields is authoritative. itemBudget defaults to ${SEARCH_PREVIEW_TOKENS}; fact quote/source/relations require trace. Raw keeps its entry profile. Exact addresses remain unrestricted through trace. Every receipt states filters and omitted preview fields; no hit does not mean absent. maxTokens defaults to ${DEFAULT_READ_TOKENS} and is capped at ${MAX_PUBLIC_READ_TOKENS} estimated tokens for one response; cap still limits output lines (default 100). Continue with cursor and an empty query; omit frozen options or repeat their original values (changes are rejected). Search previews never count as complete knowledge reads.`, parameters: object({ maxTokens: { type: "integer", minimum: 1, maximum: MAX_PUBLIC_READ_TOKENS, default: DEFAULT_READ_TOKENS }, itemBudget: { ...contentBudget, default: SEARCH_PREVIEW_TOKENS }, fields, query: string, layer: { enum: ["facts", "knowledge", "raw", "all"] }, ...readFilters, ...pagination }, ["query"]) },
  { name: "note", description: "Write one atomic facts batch. Noting runs are the normal writers; main agents may write but have no memory duty. Rejections write nothing; correct and resubmit the whole batch. A valid first Noting batch with lexical neighbours returns NEAR without committing; read it and resubmit the complete batch to commit. With no neighbours, and for manual calls, the first valid batch commits. Lexical nearness is not relation evidence. Thinking is readable, not evidence for new facts: @thinking and thinking-only entries are invalid sources; whole mixed entries cite only text/call/result blocks. No timestamps; event status is required. $n references an earlier item in this batch.", parameters: object({ facts: { type: "array", items: factSchema } }, ["facts"]) },
  { name: "memory", description: "Write one atomic ordinary knowledge batch. Consolidation runs are the normal writers and may create, update or archive; main agents may also make a fact-backed binary merge but have no memory duty. Operations carry non-empty change supports and a reason (the commit message, never evidence). Create/update submit the complete resulting text/category/scope and topics (subject labels; the complete replacement set, empty when unclassified); archive records archival state while inheriting its parent's category, scope and topics. Automatic merge/split maintenance belongs to Dreamer; split is unavailable to manual callers. First valid Consolidation batch returns review guidance; resubmit the whole batch to commit. Manual calls commit immediately. Base-commit rejection is atomic; re-read and resubmit. Update/archive and every manual merge parent require an explicit complete-body K1@57 read. Bare K1 and search previews grant no write handle.", parameters: object({ operations: { type: "array", items: memoryOperationSchema }, skipped: { type: "array", items: object({ fact: factId, because: { type: "string", minLength: 1 } }, ["fact", "because"]) } }, ["operations", "skipped"]) },
];

export function dreamingToolDefinitions(): Omit<ToolDefinition, "execute">[] {
  const tools = structuredClone(toolDefinitions.filter(t => t.name !== "note"));
  const memory = tools.find(t => t.name === "memory")!;
  memory.description = "Apply one atomic batch immediately within the frozen Dreamer family. No candidate/review resubmission. Allowed operations are update, an exactly-two-parent merge, an atomic one-parent/two-child split, and archive; create is forbidden. Every result body is complete, while supports describe only this change and may be [] for a trusted maintenance judgment. Split children each supply complete text/category/topics and inherit the parent's scope and shared supports. Every parent requires an exact complete-body K@commit read. Reads outside the retained family remain read-only. Earlier valid batches survive failure; only a passing host check certifies current descendants.";
  const operation = (memory.parameters.properties as any).operations.items;
  operation.properties.op.enum = ["update", "merge", "split", "archive"];
  operation.properties.supports.minItems = 0;
  operation.properties.children = { type: "array", minItems: 2, maxItems: 2, items: object({
    text: { type: "string", minLength: 1 }, category: { enum: KNOWLEDGE_CATEGORIES },
    topics: { type: "array", items: { type: "string", minLength: 1 } },
  }, ["text", "category", "topics"]) };
  operation.allOf[2] = { if: { properties: { op: { enum: ["archive", "split"] } } },
    then: { not: { anyOf: ["text", "category", "scope", "topics"].map(key => ({ required: [key] })) } },
    else: { required: ["text", "category", "scope", "topics"] } };
  operation.allOf.push({ if: { properties: { op: { const: "split" } } }, then: { required: ["children"] }, else: { not: { required: ["children"] } } });
  tools.push({ name: "check", description: "Read-only completion check. Returns relevant owner budgets, the maximum applicable projection, canonical completion counts, remaining rounds, repair availability and every blocker. Detailed exact sets and normal projection rows stay in the run audit. This receipt never grants a complete-body handle, commits or certifies knowledge.", parameters: object({}) });
  return tools;
}

export function validateReadInput(name: "trace" | "search", raw: unknown): Record<string, unknown> {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new Error("expected an object");
  const input = raw as Record<string, unknown>;
  const properties = toolDefinitions.find(t => t.name === name)!.parameters.properties as object;
  if (Object.keys(input).some(k => !(k in properties))) throw new Error("unexpected parameter");
  if (name === "trace") {
    if (typeof input.address !== "string") throw new Error("address must be a string");
    if (input.pageBudget === null) throw new Error("pageBudget must be a positive safe integer; null is internal-only");
    validateBudgets(input as ListingOptions);
    if (input.tool !== undefined && (!Number.isSafeInteger(input.tool) || Number(input.tool) < 1)) throw new Error("tool must be a positive ordinal");
    if (input.full !== undefined && typeof input.full !== "boolean") throw new Error("full must be boolean");
  } else {
    if (typeof input.query !== "string") throw new Error("query must be a string");
    validateBudgets(input as ListingOptions);
    if ((input.category !== undefined || input.scope !== undefined) && input.layer !== undefined && input.layer !== "knowledge")
      throw new Error("category and scope filters require layer knowledge");
  }
  return input;
}

/** The model-facing result format, read back. A tool result is a refusal when it is a `rejected:`
 * receipt, and a batch writer's JSON `results` array carries one per item — both spellings are
 * produced in this file. Every consumer that must classify a result rather than show it (either Pi
 * adapter deciding whether a call committed, the test host deciding whether a result is an error)
 * reads it here, so the format has one definition and one place to change. */
export function toolRejected(name: string, content: string): boolean {
  if (content.startsWith("rejected:")) return true;
  if (name !== "note" && name !== "memory") return false;
  try {
    const { results } = JSON.parse(content);
    return Array.isArray(results) && results.some((r: unknown) => typeof r === "string" && r.startsWith("rejected:"));
  } catch { return false; }
}

/** Core's reader for the existing user-role review receipt used by both writer protocols. */
export function reviewFeedback(toolResult: string): string | undefined {
  try { const value = JSON.parse(toolResult); return value?.feedback?.role === "user" ? String(value.feedback.content) : undefined; }
  catch { return undefined; }
}

export function bindTools(store: Store, read: Reads, supplied: ToolContext, metadata?: RunInput, review?: MemoryReview,
  reads = new Map<number, KnowledgeWithRevision>(), dreaming?: { path: KnowledgePath; check(): string }, notingNearThreshold = 0.40) {
  const context = structuredClone(supplied);
  const session = store.getSession(context.sessionId);
  if (!session || !context.branch) throw new Error("tools require an existing session and a non-empty branch");
  const allowed = new Set<number>();
  if (context.kind === "manual") {
    if (store.getTurn(context.currentTurnId)?.sessionId !== session.id) throw new Error("current turn must belong to the calling session");
  } else if (context.kind === "noting") {
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
  if (context.kind === "consolidation" && !review) throw new Error("Consolidation tools require the frozen review context supplied by integrate()");
  // The branch rides on the path so applicability is judged per source entry (review 2026-09-08 P1).
  const path = context.kind === "manual" ? { sessionId: session.id, headTurnId: context.currentTurnId, branch: context.branch }
    : context.kind === "noting" ? { sessionId: session.id, headTurnId: Number(context.range.to.split("/T")[1]), branch: context.branch }
    : context.kind === "dreaming" ? dreaming!.path : review!.frozen.path;
  const plain: RunInput = { kind: context.kind, sessionId: session.id, branch: context.branch,
    rangeFrom: context.kind === "manual" ? `S${session.id}/T${context.currentTurnId}` : context.range.from,
    rangeTo: context.kind === "manual" ? `S${session.id}/T${context.currentTurnId}` : context.range.to, createdAt: new Date().toISOString() };
  const run = metadata ?? store.bindRunOrigin(plain, store.triggerOrigin(path, context.triggerEntryId));
  if (context.kind === "dreaming" && (!dreaming || !store.isDreamingRun(run))) throw new Error("Dreamer tools require an admitted trusted run binding");
  // Source resolution, range checks and candidate applicability share one binding-time database/path
  // membership. Later tree movement and same-Turn entry ingestion cannot change any half of the run.
  const initial = context.kind === "noting" ? store.transaction(() => ({
    path: store.sourcePath(session.id, context.branch, path.headTurnId!), snapshot: store.pathSnapshot(path),
  })) : undefined;
  const initialPath = initial?.path ?? [], initialPathSnapshot = initial?.snapshot;
  const sourceTurns = initialPathSnapshot?.turns ?? store.pathTurns(path);
  const frozenEntries = context.kind === "noting" ? (context.entryIds ?? initialPath.filter(e => allowed.has(e.turnId)).map(e => e.id)) : [];
  const frozenIds = new Set(frozenEntries);
  if (context.kind === "manual" || context.kind === "dreaming") for (const handle of context.readKnowledgeCommits ?? []) {
    const revision = store.getKnowledgeRevision(handle.knowledgeId, handle.commit);
    if (revision) reads.set(revision.id, { knowledge: store.getKnowledge(handle.knowledgeId)!, revision });
  }
  const memory = bindMemory(store, session.id, run, review, path, reads);
  const sequence = memory.sequence;
  const fetched: { address: string; input: unknown; content: string }[] = [];
  let closed = false, committed: { runId: number; facts: Fact[]; diagnostics: NotingDiagnostic[] } | undefined;
  let problems: string[] = [], requests = 0, reviewRequest = -1;
  let nearSnapshot: NotingNearSnapshot | undefined;
  const nearAudit = () => notingNearAudit(nearSnapshot);
  // Reads resolve any existing address (user ruling 2026-09-07: no visibility limits on reads);
  // injection and Consolidation keep their scope rules elsewhere. Writes still bind sources to the run.
  const existingFact = (id: number) => !!store.getFact(id);
  const note = (input: Record<string, unknown>): string => {
    if (context.kind === "consolidation" || context.kind === "dreaming") return "rejected: note is not available to this knowledge worker";
    if (context.kind === "noting" && nearSnapshot?.shown.length && requests === reviewRequest)
      return "rejected: the review feedback has not been read yet; resubmit after the feedback message";
    if (!Array.isArray(input.facts) || Object.keys(input).some((k) => k !== "facts")) {
      problems = ["note expects {facts: [...]} only"]; return `rejected: ${problems[0]}`;
    }
    // Manual writers resolve against the path at their call. An automatic run resolves only against
    // its binding snapshot, then narrows authority to the admitted range; no later matching legacy
    // occurrence can retroactively make a frozen source ambiguous.
    const sourcePath = context.kind === "noting" ? initialPath : store.sourcePath(session.id, context.branch, path.headTurnId!);
    const candidates = context.kind === "noting" ? sourcePath.filter(entry => frozenIds.has(entry.id)) : sourcePath;
    const positions = new Map(candidates.map((entry, index) => [entry.id, index]));
    const resolution = new Map<string, SourceResolution[]>();
    const resolve = (source: string) => {
      if (!resolution.has(source)) {
        const matches = resolveFactSource(sourcePath, source);
        resolution.set(source, context.kind === "noting" ? matches.filter(hit => frozenIds.has(hit.entry.id)) : matches);
      }
      return resolution.get(source)!;
    };
    const commits: FactCommitInput[] = [];
    const results = input.facts.map((raw, index) => {
      const errors: string[] = [];
      const fact = validateNotingFact(`facts[${index}]`, raw, errors);
      if (fact) {
        let first = 0;
        const cited: SourceResolution[] = [];
        if (Array.isArray(fact.source)) for (const source of fact.source) {
          const matches = resolve(source);
          const turn = matches.length ? store.getTurn(matches[0]!.entry.turnId) : null;
          if (!turn || turn.sessionId !== session.id || !sourceTurns.has(turn.id) || turn.kind === "compaction") errors.push(`invalid source ${source}; does not exist in the eligible entry set; expected a raw source on the current branch inside the frozen range or calling session; injected messages and thinking are not fact sources`);
          else {
            if (!first) first = turn.id;
            cited.push(...matches);
            // Membership and actual block existence above are authoritative, never aggregate Turn text.
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
        if (first) {
          const entryIds = candidates.filter(entry => cited.some(hit => hit.entry.id === entry.id)).map(entry => entry.id);
          // Call IDs may be reused within a Turn. Match the stored invocation ordinal too,
          // and compare admitted path positions, never E ordinals or citation order.
          const results = new Map<string, number>();
          for (const { entry, blocks } of cited) for (const block of blocks) if (block.kind === "result") {
            const key = `${entry.turnId}:${block.call.ordinal}:${block.call.callId}`;
            results.set(key, Math.max(results.get(key) ?? -1, positions.get(entry.id)!));
          }
          if (fact.status === "completed" && cited.some(({ entry, blocks }) => blocks.some(block => block.kind === "call"
            && (results.get(`${entry.turnId}:${block.call.ordinal}:${block.call.callId}`) ?? -1) <= positions.get(entry.id)!)))
            errors.push("completed requires result evidence for each cited dispatch; cite the corresponding toolResult on this path, or use an explicit text source for a text deliverable or reported/dispatched status");
          commits.push({ ...fact, turnId: first, createdAt: store.getTurn(first)!.startedAt, entryIds });
        }
      }
      return errors.length ? `rejected: ${errors.join("; ")}` : "ok";
    });
    problems = results.filter((r) => r.startsWith("rejected:"));
    if (problems.length) return JSON.stringify({ results });
    // The pool is first read only after the ordinary whole batch has validated. It is then held for
    // this binding, whether the review is empty or shown, so later facts cannot enlarge the attempt.
    if (context.kind === "noting" && !nearSnapshot) {
      nearSnapshot = captureNotingNear(store, session.id, path, initialPathSnapshot!, commits, input as { facts: unknown[] }, notingNearThreshold);
      if (nearSnapshot.shown.length) {
        reviewRequest = requests;
        problems = ["first batch requires a second submission"];
        return JSON.stringify({ results, feedback: { role: "user", content: notingNearFeedback(nearSnapshot) } });
      }
    }
    // 26a: an explicit `note({facts: []})` is how a Noter completes a genuinely empty batch, so its
    // receipt says the batch committed instead of returning two empty arrays and nothing else.
    const receipt = (ids: number[]) => JSON.stringify(ids.length ? { results: ids.map((id) => `ok: F${id}`), factIds: ids }
      : { results: [], factIds: [], committed: "zero facts; this batch is complete" });
    let diagnostics: NotingDiagnostic[] = [];
    const committedRun = store.commitNotingRun({ run: { ...run,
      ...(context.kind === "manual" ? { request: JSON.stringify(input) } : {}),
      response: JSON.stringify({ toolCalls: [...sequence, { name: "note", input, result: "ok" }], readKnowledgeCommits: context.kind === "noting" ? context.readKnowledgeCommits : [] }) }, facts: commits,
      responseForFacts: (ids) => {
        if (context.kind === "manual") return receipt(ids);
        diagnostics = unansweredNotingNear(nearSnapshot, commits, ids);
        return JSON.stringify({ toolCalls: [...sequence, { name: "note", input, result: receipt(ids) }], fetched, diagnostics, problems: [], readKnowledgeCommits: context.readKnowledgeCommits,
          ...(nearAudit() ? { notingNearReview: nearAudit() } : {}) });
      },
      ...(context.kind === "noting" ? { entryIds: frozenEntries } : {}) });
    // 26a: an empty submission has no per-item slot to carry a refused commit, so it is refused as a
    // plain `rejected:` receipt — the same refusal the reader and `toolRejected` already classify.
    if (!committedRun.ok) { problems = committedRun.problems;
      return results.length ? JSON.stringify({ results: results.map(() => `rejected: ${problems.join("; ")}`) }) : `rejected: ${problems.join("; ")}`; }
    const result = receipt(committedRun.facts.map((f) => f.id));
    if (context.kind === "noting") committed = { ...committedRun, diagnostics };
    return result;
  };
  // Exceptions outside memory's batch validator must also block Dreamer completion until
  // that tool is used legally; tool text is diagnostic, never a conflict classification.
  const toolProblems = new Map<string, string>();
  const definitions = dreaming ? dreamingToolDefinitions() : toolDefinitions;
  const definition = (name: ToolDefinition["name"], execute: (input: Record<string, unknown>) => string): ToolDefinition => ({ ...definitions.find(t => t.name === name)!,
    execute: (raw) => {
      if (closed) return "rejected: run has finished";
      if ((name === "note" || name === "memory") && !store.enabled(session.id)) return "rejected: Trace Memory is Disabled; use /trace on to enable memory.";
      let result: string;
      try {
        if (name === "note" && committed) result = "rejected: already committed";
        else if (name === "memory") result = execute(raw && typeof raw === "object" ? raw as Record<string, unknown> : {});
        else {
          if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new Error("expected an object");
          if (name === "trace" || name === "search") validateReadInput(name, raw);
          result = execute(raw as Record<string, unknown>);
        }
        toolProblems.delete(name);
      } catch (error) { result = `rejected: ${error instanceof Error ? error.message : String(error)}`;
        if (dreaming) toolProblems.set(name, result);
        if (name === "note" && !committed) problems = [result]; }
      sequence.push({ name, input: structuredClone(raw), result });
      if (context.kind === "manual" && (name === "note" || name === "memory") && result.includes("rejected:")) store.recordRun({ ...run, request: JSON.stringify(raw), response: result, outcome: "bounced" });
      if (committed) store.updateRun(committed.runId, { ...run, outcome: "success", response: JSON.stringify({ toolCalls: sequence, fetched, diagnostics: committed.diagnostics, problems: [], ...(context.kind === "noting" ? { readKnowledgeCommits: context.readKnowledgeCommits } : {}),
        ...(nearAudit() ? { notingNearReview: nearAudit() } : {}) }) });
      return result;
    } });
  const tools = [
    definition("trace", (input) => {
      const { text: content, completed } = read.traceRead(input.address as string, { ...input as ListingOptions, sessionId: session.id, headTurnId: path.headTurnId, branch: context.branch });
      memory.reread(completed);
      fetched.push({ address: input.address as string, input: structuredClone(input), content }); return content;
    }),
    definition("search", (input) => {
      if (typeof input.query !== "string") throw new Error("query must be a string");
      return read.search(input.query, input.layer as SearchScope | undefined, { ...input as ListingOptions, sessionId: session.id, headTurnId: path.headTurnId, branch: context.branch });
    }),
    ...(dreaming ? [definition("check", input => { if (Object.keys(input).length) throw new Error("check expects {} only"); return dreaming.check(); })] : [definition("note", note)]),
    definition("memory", input => context.kind === "noting" ? "rejected: memory is not the writer for a noting run" : memory.execute(input)),
  ];
  return { tools, sequence, fetched, memory, get toolProblems() { return [...toolProblems.values()]; }, get committed() { return committed; }, get problems() { return problems; },
    get notingNearAudit() { return nearAudit(); }, close: () => { closed = true; },
    reportRequest: (request: unknown) => { if (closed) throw new Error("noting run has finished"); requests++; memory.requestSeen(); run.request = JSON.stringify(request); } };
}
