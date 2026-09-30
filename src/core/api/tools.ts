import { resolveFactSource, sourceAddressScope, type SourceResolution } from "../model/source.ts";
import { bindMemory } from "../knowledge-write/bind.ts";
import { KNOWLEDGE_CATEGORIES, KNOWLEDGE_SCOPES, validateNotingFact, type Fact } from "../model/index.ts";
import type { Store, RunInput, FactCommitInput, KnowledgePath, SourceEntry } from "../store/index.ts";
import { DEFAULT_READ_TOKENS, MAX_PUBLIC_READ_TOKENS, READ_FIELDS, READ_VERSIONS, SEARCH_PREVIEW_TOKENS, validateBudgets, type ListingOptions, type SearchScope, type TraceRead } from "./read.ts";
import type { NotingDiagnostic } from "../noting/review.ts";
import { holdNoting } from "../noting/held.ts";
import { tokens } from "../render/index.ts";
import { canonicalToolNames, renderToolNames, validateToolNames, type ToolNames } from "../prompts/tool-names.ts";

export interface ToolDefinition {
  name: "trace" | "search" | "note" | "memory" | "check";
  description: string;
  parameters: Record<string, unknown>;
  execute(input: unknown): string;
}
export type ToolContext = { kind: "manual"; sessionId: number; branch: string; currentTurnId: number; triggerEntryId?: number; entryIds?: number[]; maxReadChars?: number; toolNames?: ToolNames }
  | { kind: "noting" | "dreaming"; sessionId: number; branch: string; headTurnId?: number | null; triggerEntryId?: number; entryIds?: number[]; range: { from: string; to: string }; maxReadChars?: number; toolNames?: ToolNames };
type Reads = { traceRead(address: string, options?: ListingOptions): TraceRead;
  search(query: string | readonly string[], layer?: SearchScope, options?: ListingOptions & { sessionId?: number }): string };
const object = (properties: Record<string, unknown>, required: string[] = []) => ({ type: "object", properties, required, additionalProperties: false });
const string = { type: "string" };
const relation = { type: "array", items: { type: "array", prefixItems: [{ type: "string", pattern: "^(F[1-9][0-9]*|\\$[1-9][0-9]*)$" }, { enum: ["strong", "weak"] }], minItems: 2, maxItems: 2 } };
const factSchema = object({ slot: { type: "string", pattern: "^\\$[1-9][0-9]*$", description: "N only: completely replace this held fact slot." },
  title: { type: "string", minLength: 1, pattern: "^[^\\r\\n\\u2028\\u2029]+$" },
  sources: { type: "array", minItems: 1, items: object({ address: { type: "string", pattern: "^T[1-9][0-9]*#E[1-9][0-9]*(?:@(user|assistant|observation))?$" }, text: { type: "string", minLength: 1 } }, ["address", "text"]) },
  support: relation, negate: relation }, ["title", "sources"]);
const pagination = { cursor: string, cap: { type: "integer", minimum: 1 } };
const contentBudget = { anyOf: [{ type: "integer", minimum: 1, maximum: Number.MAX_SAFE_INTEGER }, { type: "null" }] };
const fields = { type: "array", uniqueItems: true, items: { enum: READ_FIELDS } };
const budgets = { itemBudget: { ...contentBudget, default: 2000 }, toolCallBudget: { ...contentBudget, default: 100 }, toolResultBudget: { ...contentBudget, default: 100 }, pageBudget: { type: "integer", minimum: 1, maximum: MAX_PUBLIC_READ_TOKENS, default: DEFAULT_READ_TOKENS } };
const readFilters = { versions: { enum: READ_VERSIONS, default: "current", description: "Candidates within each K: current = active current tips applicable on this path; history = additionally applicable superseded and archived revisions; all = additionally other branches' revisions within the selected scope, including their history and archives. Collections show one representative per K. Inapplicable revisions are never write bases here; reading never bypasses write validation." },
  category: { enum: KNOWLEDGE_CATEGORIES, description: "Knowledge category. Implies layer=knowledge when layer is omitted." },
  scope: { enum: KNOWLEDGE_SCOPES, description: "Material selection: session facts/Raw and session knowledge; project facts/Raw and project knowledge; global facts/Raw from all sessions and global knowledge. Omitted: project facts/Raw plus applicable global/project/session knowledge. Named trace collections never widen. Does not imply a layer." } };

const factId = { type: "string", pattern: "^F[1-9][0-9]*$" };
const knowledgeId = { type: "string", pattern: "^K[1-9][0-9]*#[a-z]{4,}$" };
const memoryOperationSchema = { ...object({ op: { enum: ["create", "update", "archive"] }, id: knowledgeId,
  slot: { type: "string", pattern: "^M[1-9][0-9]*$", description: "N only: completely replace this held operation." },
  absorb: { type: "array", items: knowledgeId, minItems: 1, maxItems: 1, uniqueItems: true }, kind: { enum: ["budget", "invalid"] }, text: { type: "string", minLength: 1 },
  category: { enum: KNOWLEDGE_CATEGORIES }, scope: { enum: KNOWLEDGE_SCOPES }, supports: { type: "array", items: { type: "string", pattern: "^(F[1-9][0-9]*|\\$[1-9][0-9]*)$", description: "Existing F fact, or N-only accepted local $ fact." }, minItems: 1 },
  reason: { type: "string", minLength: 1 }, topics: { type: "array", items: { type: "string", minLength: 1 } } }, ["op", "supports", "reason"]), allOf: [
  { if: { properties: { op: { const: "create" } } }, then: { not: { required: ["id"] } }, else: { required: ["id"] } },
  { if: { properties: { op: { const: "merge" } } }, then: { required: ["absorb"] }, else: { not: { required: ["absorb"] } } },
  { if: { properties: { op: { const: "archive" } } }, then: { required: ["kind"],
    allOf: [{ not: { anyOf: ["category", "scope", "topics"].map(key => ({ required: [key] })) } },
      { if: { properties: { kind: { const: "invalid" } } }, then: { required: ["text"] }, else: { not: { required: ["text"] } } }] },
    else: { required: ["text", "category", "scope", "topics"], not: { required: ["kind"] } } },
] };

export const toolDefinitions: Omit<ToolDefinition, "execute">[] = [
  { name: "trace", description: "Read evidence by address. For a complete knowledge version include text (the default) and use {{tool.trace}}({address:'K12@v3',itemBudget:null}); pageBudget still applies. A complete body carries its exact K#tag version for writes; a preview, notice or incomplete page does not. T792 is a Turn; T792#E2 is its stable native entry; T792 shows contributing facts, unprocessed Raw, and addresses of processed uncited entries. T792#E2 and T792#E2..E7 show Raw (gaps allowed); @user/@assistant/@observation filter entries by role, including exact-entry role checks. Thinking, tool calls, results and IDs remain within their whole assistant/observation entry, never selectable blocks. Commas separate complete independent addresses; no shorthand or trailing shared selector. itemBudget caps EACH child of the selected container (Turn: entries; one entry: blocks), default 2000; toolCallBudget and toolResultBudget default 100 as additional ceilings. null disables each content ceiling independently; to remove all compression set ALL THREE to null. pageBudget independently defaults to 2000 and is capped at 8000 for every public {{tool.trace}} read. fields defaults to text, supports, topics, status and links for current/exact reads; explicit K history/all additionally default to reason, which appears only on history commit lines. Knowledge identity, exact tagged version, and per-identity history: K1, K1#qfzt, K1@v3, K1@v2..v5. Bare K defaults to one current representative in the reader's context; explicitly named K with versions=history adds applicable superseded and archived revisions, while versions=all additionally adds other branches' revisions, including their history and archives; revisions not applicable here are never write bases. Search and project collections always show one representative per K, selected before paging. Named S reads only that session's Raw. Named projects read that project's facts plus global/project knowledge; scope narrows knowledge and never widens facts. A named project rejects scope=session. Scope never filters knowledge by its author's project when the revision is global. Exact K#tag, history diffs, F and T addresses ignore data filters and remain unrestricted. One address may list several, comma separated, in the order asked and repeats kept: F81,F90,F95, kinds mixable. Fact intervals, negation walks and all-branch K.. are not public addresses. Each page is at most 2000 estimated tokens by default, including receipts; cap counts output lines (default 100). full removes content compression, not pagination. Oversized lines continue in lossless fragments (see receipts). cursor continues that same frozen read alone, retaining its token budget.", parameters: object({ address: string, ...readFilters, fields, ...budgets, full: { type: "boolean" }, ...pagination }, ["address"]) },
  { name: "search", description: `Use literal substring search over facts, raw and knowledge commits. scope controls facts, Raw and knowledge: session selects this session's facts/Raw and session-scoped knowledge; project selects project facts/Raw and project-scoped knowledge; global selects all sessions' facts/Raw and global-scoped knowledge regardless of author. Omitted scope selects project facts/Raw and applicable global/project/session knowledge; unbound omission discovers all owners. Explicit project/session requires context. versions defaults to current applicable tips; history additionally includes applicable superseded and archived revisions; all additionally includes other branches' revisions in scope, including their history and archives. Revisions not applicable here are never write bases, and reading never bypasses write validation. Each K contributes one best matching revision: highest lexical text/topic similarity, then current, then newer commit. Admission stays literal. The batched form selects each query's capped knowledge hits by similarity so cap keeps the closest match; model-visible knowledge results then display oldest first, retaining category labels. Inspect a K's history through {{tool.trace}}. Only category implies layer=knowledge and conflicts with every other layer; scope does not imply a layer. Fact and knowledge hits are one-line previews: fields defaults to text for current searches and to text plus status for knowledge history/all; explicit fields is authoritative. itemBudget defaults to ${SEARCH_PREVIEW_TOKENS}; fact quote/source/relations require {{tool.trace}}. Raw keeps its entry profile. Exact addresses remain unrestricted through {{tool.trace}}. Every receipt states filters and omitted preview fields; no hit does not mean absent. maxTokens defaults to ${DEFAULT_READ_TOKENS} and is capped at ${MAX_PUBLIC_READ_TOKENS} estimated tokens for one response; cap still limits output lines (default 100). Continue with cursor and an empty query; omit frozen options or repeat their original values (changes are rejected). Search previews never count as complete knowledge reads.`, parameters: { ...object({ maxTokens: { type: "integer", minimum: 1, maximum: MAX_PUBLIC_READ_TOKENS, default: DEFAULT_READ_TOKENS }, itemBudget: { ...contentBudget, default: SEARCH_PREVIEW_TOKENS }, fields, query: string, queries: { type: "array", items: string, minItems: 1, description: "Batched form, exclusive with query: one response, each query's own hits under the shared options, at most cap per query (default 1), the query echoed on each hit line, queries with no hit listed as `no hit: \"q\"` lines after the hits and paged like them; a cursor may repeat the original cap." }, layer: { enum: ["facts", "knowledge", "raw", "all"] }, ...readFilters, ...pagination }) } },
  { name: "note", description: "Write each topic's episodic slice with a nonempty single-line title and nonempty sources [{address,text}]. Give each contributing whole native entry (T12#E3, optionally @user/@assistant/@observation) its own segment; Core orders segments by path and joins their texts as the body. End a slice at a topic pivot, batch end or body cap; preserve the reasoning arc and name the actual harness in agent segments. Do not put later interpretations in an earlier source or tool-result segment. Block selectors and fact-level text are not allowed. No model-supplied category, status, quote or actor. Thinking alone is not evidence. Relations are optional; manual $ references name earlier facts in this call, N $ references name accepted earlier stable slots. Manual calls commit immediately and reject slot/drop. N calls hold privately until normal terminal publication: omit slot to append, slot:$n completely replaces including a rejected item, drop:[$n] removes only unreferenced slots. Failed replacement invalidates the prior value; numbers never recycle; accepted siblings survive. Empty facts confirms use, never clears drafts or rejected slots. Receipts list held/rejected handles, including after a native schema refusal; an empty call inspects them. A valid call clears top-level call errors only. Both {{tool.note}} and {{tool.memory}} are required in N.", parameters: object({ facts: { type: "array", items: factSchema }, drop: { type: "array", items: { type: "string", pattern: "^\\$[1-9][0-9]*$" }, description: "N only: drop unreferenced held fact slots." } }, ["facts"]) },
  { name: "memory", description: "Role-bound knowledge writing. Manual writers may create/archive only and commit a valid batch immediately; rejected batches write nothing and require whole-batch correction. N holds create/update/archive privately until normal termination with both {{tool.note}} and {{tool.memory}} used and every refusal resolved. Merge/split remain D-only. N-only fields: operation slot:Mn fully replaces a held operation; omit it to append; drop:[Mn] removes without recycling numbers; supports may cite accepted local $ fact slots. Manual writers reject slot/drop/local knowledge supports with a reason and have no drafts. N always supplies skipped:[]; empty operations confirms use without clearing drafts or rejected slots. A legitimately advanced tagged base converts N update to annotated create or archive to an audited no-op; other errors do not convert. Update/archive requires exact K#tag. Every operation has nonempty fact supports and reason (commit message, not evidence). Create/update supplies complete text/category/scope/topics; archive requires kind budget (retains exact parent body) or invalid (requires substantive text explaining grounds, evidence and replacement if any). Archive inherits category/scope/topics. Tagged bases still require valid scope, path and evidence. N receipts list held/rejected handles; after native schema refusal an empty call inspects them.", parameters: object({ operations: { type: "array", items: memoryOperationSchema }, skipped: { type: "array", items: object({ fact: factId, because: { type: "string", minLength: 1 } }, ["fact", "because"]) }, drop: { type: "array", items: { type: "string", pattern: "^M[1-9][0-9]*$" }, description: "N only: drop held knowledge-operation slots." } }, ["operations", "skipped"]) },
];

export function renderToolDefinitions(definitions: readonly Omit<ToolDefinition, "execute">[], names: ToolNames) {
  const exposed = validateToolNames(names);
  return definitions.map(definition => ({ ...definition, description: renderToolNames(definition.description, exposed) }));
}

/** Price the descriptions and actual exposed names that the host advertises. */
export function pricedToolDefinitions(definitions: readonly Omit<ToolDefinition, "execute">[], names: ToolNames) {
  return renderToolDefinitions(definitions, names).map(definition => ({ ...definition, name: names[definition.name] }));
}

export function dreamingToolDefinitions(): Omit<ToolDefinition, "execute">[] {
  const tools = structuredClone(toolDefinitions.filter(t => t.name !== "note"));
  const memory = tools.find(t => t.name === "memory")!;
  memory.description = "Apply one atomic Dreamer maintenance batch immediately. Allowed operations are update, an exactly-two-parent merge, an atomic one-parent/two-child split, and archive; create is forbidden. Every result body is complete. Merge may omit text to copy the later exact parent's body verbatim. Non-empty supports are the exact evidence for the change; empty supports request Store-side inheritance from every exact parent. Every parent requires an exact K#tag base and must belong to this run's frozen owner pool. A base that is not the latest effective applicable revision on the writer path is rejected naming the current revision. skipped uses an exact untagged K@vN history address for a frozen version that was deliberated and intentionally left unchanged; it requires no full-body read and grants no mutation authority; it marks that version processed without changing it. Never skip an untouched reference or an item you did not deliberate. Archive requires kind budget (keeps parent's complete body) or invalid (substantive statement of grounds, evidence and replacement if any); category/scope/topics carry over. Earlier valid batches survive later failure.";
  const operation = (memory.parameters.properties as any).operations.items;
  operation.properties.op.enum = ["update", "merge", "split", "archive"];
  operation.properties.supports.minItems = 0;
  operation.properties.supports.items = factId;
  delete operation.properties.slot;
  delete (memory.parameters.properties as any).drop;
  (memory.parameters.properties as any).skipped.items = object({ knowledge: { type: "string", pattern: "^K[1-9][0-9]*@v[1-9][0-9]*$" }, because: { type: "string", minLength: 1 } }, ["knowledge", "because"]);
  operation.properties.children = { type: "array", minItems: 2, maxItems: 2, items: object({
    text: { type: "string", minLength: 1 }, category: { enum: KNOWLEDGE_CATEGORIES },
    topics: { type: "array", items: { type: "string", minLength: 1 } },
  }, ["text", "category", "topics"]) };
  operation.allOf[2] = { if: { properties: { op: { const: "archive" } } },
    then: { required: ["kind"], allOf: [
      { not: { anyOf: ["category", "scope", "topics", "children"].map(key => ({ required: [key] })) } },
      { if: { properties: { kind: { const: "invalid" } } }, then: { required: ["text"] }, else: { not: { required: ["text"] } } }] },
    else: { not: { required: ["kind"] }, if: { properties: { op: { const: "split" } } },
      then: { not: { anyOf: ["text", "category", "scope", "topics"].map(key => ({ required: [key] })) } },
      else: { required: ["category", "scope", "topics"], if: { properties: { op: { const: "merge" } } }, then: {}, else: { required: ["text"] } } } };
  operation.allOf.push({ if: { properties: { op: { const: "split" } } }, then: { required: ["children"] }, else: { not: { required: ["children"] } } });
  tools.push({ name: "check", description: "Read-only pool check. Returns the frozen pool, frozen and own revision counts, newly pending revisions, current pool sizes and blockers: rejected memory operations, the frozen pool over its budget, and frozen versions neither operated on nor skipped. The run succeeds only with no blocker. This receipt never grants a complete-body handle or commits knowledge.", parameters: object({}) });
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
    if (input.full !== undefined && typeof input.full !== "boolean") throw new Error("full must be boolean");
  } else {
    if (input.query !== undefined && input.queries !== undefined) throw new Error("query and queries are exclusive");
    if (input.queries !== undefined) {
      if (!Array.isArray(input.queries) || !input.queries.length || input.queries.some(q => typeof q !== "string")) throw new Error("queries must be a non-empty array of strings");
    } else if (typeof input.query !== "string") throw new Error("query must be a string");
    validateBudgets(input as ListingOptions);
    if (input.category !== undefined && input.layer !== undefined && input.layer !== "knowledge")
      throw new Error("category filter requires layer knowledge");
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

export function bindTools(store: Store, read: Reads, supplied: ToolContext, metadata?: RunInput,
  dreaming?: { path: KnowledgePath; check(): string; /** 59: why a commit may not be skipped, or undefined when it is a supplied untouched handle. */ skippable(commit: number): string | undefined },
  exposedNames: ToolNames = canonicalToolNames) {
  const names = validateToolNames(supplied.toolNames ?? exposedNames);
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
  // The branch rides on the path so applicability is judged per source entry (review 2026-09-08 P1).
  const path = context.kind === "manual" ? { sessionId: session.id, headTurnId: context.currentTurnId, branch: context.branch }
    : context.kind === "noting" ? { sessionId: session.id, headTurnId: Number(context.range.to.split("/T")[1]), branch: context.branch }
    : dreaming!.path;
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
  const manualPath = context.kind === "manual" && context.entryIds ? store.sourcePath(session.id, context.branch, path.headTurnId!) : [];
  const manualTrigger = context.kind === "manual" && context.entryIds && context.triggerEntryId !== undefined
    ? manualPath.findIndex(entry => entry.id === context.triggerEntryId) : manualPath.length - 1;
  if (context.kind === "manual" && context.entryIds && context.triggerEntryId !== undefined && manualTrigger < 0)
    throw new Error("manual source prefix does not contain the exact triggering entry");
  const manualEntries = context.kind === "manual" && context.entryIds ? manualPath.slice(0, manualTrigger + 1) : [];
  if (context.kind === "manual" && context.entryIds && (context.entryIds.length !== manualEntries.length ||
      context.entryIds.some((id, index) => id !== manualEntries[index]!.id)))
    throw new Error("manual source prefix does not match the exact triggering ancestry");
  const manualEntryIds = context.kind === "manual" && context.entryIds ? new Set(context.entryIds) : null;
  const frozenEntries = context.kind === "noting" ? (context.entryIds ?? initialPath.filter(e => allowed.has(e.turnId)).map(e => e.id)) : [];
  const frozenIds = new Set(frozenEntries);
  const memory = bindMemory(store, session.id, run, path, manualEntryIds
    ? factId => {
      const fact = store.getFact(factId);
      if (!fact) return false;
      const entries = store.factEntries(factId);
      return entries.length ? entries.every(entryId => manualEntryIds.has(entryId)) : fact.turnId !== path.headTurnId;
    } : undefined, dreaming?.skippable, names);
  const sequence = memory.sequence;
  const fetched: { address: string; input: unknown; content: string }[] = [];
  let closed = false, committed: { runId: number; facts: Fact[]; diagnostics: NotingDiagnostic[] } | undefined;
  let problems: string[] = [];
  // Reads resolve any existing address (user ruling 2026-09-07: no visibility limits on reads);
  // injection and Consolidation keep their scope rules elsewhere. Writes still bind sources to the run.
  const existingFact = (id: number) => !!store.getFact(id);
  // One synchronous call/pass only: corrections and terminal validation must reread sources.
  const resolvedSources = new Map<string, SourceResolution[]>();
  const hydratedSources = new Map<number, SourceEntry>();
  const validateFact = (raw: unknown, index: number, earlier: (slot: number) => boolean,
    sourcePath: ReturnType<Store["sourcePath"]> = initialPath): FactCommitInput => {
    const errors: string[] = [];
    const fact = validateNotingFact(`facts[${index}]`, raw, errors);
    const candidates = context.kind === "noting" ? sourcePath.filter(entry => frozenIds.has(entry.id)) : sourcePath;
    const cited = new Map<number, { hit: SourceResolution; address: string; text: string }>();
    if (fact) {
      for (const source of fact.sources) {
        const scope = sourceAddressScope(source.address);
        const entries = scope ? candidates.filter(entry => entry.turnId === scope.turn && entry.entryOrdinal === scope.ordinal) : [];
        let matches = resolvedSources.get(source.address);
        if (!matches) {
          const missing = entries.filter(entry => !hydratedSources.has(entry.id));
          if (missing.length) for (const entry of store.hydrateSourceEntries(missing.map(entry => entry.id))) hydratedSources.set(entry.id, entry);
          matches = resolveFactSource(entries.map(entry => hydratedSources.get(entry.id)!), source.address);
          resolvedSources.set(source.address, matches);
        }
        const turn = matches.length === 1 ? store.getTurn(matches[0]!.entry.turnId) : null;
        if (!turn || turn.sessionId !== session.id || !sourceTurns.has(turn.id) || turn.kind === "compaction")
          errors.push(`invalid source ${source.address}; expected admissible Raw in the eligible entry set`);
        else if (cited.has(matches[0]!.entry.id)) errors.push(`duplicate source entry ${source.address}`);
        else cited.set(matches[0]!.entry.id, { hit: matches[0]!, address: source.address, text: source.text });
      }
      for (const kind of ["support", "negate"] as const) {
        const seen = new Set<string>();
        for (const rel of fact[kind] ?? []) {
          const n = Number(rel.target.slice(1));
          if (rel.target.startsWith("$") ? !earlier(n) : !existingFact(n)) errors.push(`invalid relation target ${rel.target}; expected existing fact or accepted earlier local handle`);
          if (seen.has(rel.target)) errors.push(`duplicate ${kind} target ${rel.target}`);
          seen.add(rel.target);
        }
      }
    }
    const ordered = candidates.flatMap(entry => cited.has(entry.id) ? [cited.get(entry.id)!] : []);
    const text = ordered.map(segment => segment.text).join("\n");
    if (fact && context.kind === "noting" && tokens(text) > 1000) errors.push(`Fact exceeds 1000-token limit: ${tokens(text)} tokens`);
    if (errors.length || !fact || !ordered.length) throw new Error(errors.join("; ") || "invalid fact");
    const first = ordered[0]!.hit.entry.turnId;
    return { ...fact, text, source: ordered.map(segment => segment.address), segments: ordered.map(segment => segment.text),
      turnId: first, createdAt: store.getTurn(first)!.startedAt,
      entryIds: ordered.map(segment => segment.hit.entry.id) };
  };
  const held = context.kind === "noting" ? holdNoting(store, run, path, validateFact, names) : undefined;
  const rejectedNativeCalls = new Set<string>();
  const note = (input: Record<string, unknown>): string => {
    resolvedSources.clear(); hydratedSources.clear();
    if (held) return held.note(input);
    if (context.kind === "dreaming") return `rejected: ${names.note} is not available to this knowledge worker`;
    if ("drop" in input || (Array.isArray(input.facts) && input.facts.some(fact => fact && typeof fact === "object" && "slot" in fact))) {
      problems = ["slot/drop are N-only held-batch fields; manual note commits immediately and has no draft slots"];
      return `rejected: ${problems[0]}`;
    }
    if (!Array.isArray(input.facts) || Object.keys(input).some((k) => k !== "facts")) {
      problems = [`${names.note} expects {facts: [...]} only`]; return `rejected: ${problems[0]}`;
    }
    // Manual validation shares one current path within this synchronous submission only.
    // A later call reads it again; Noting's callback instead retains its frozen initial path.
    const sourcePath = input.facts.length ? manualEntryIds ? manualEntries
      : store.sourcePath(session.id, context.branch, path.headTurnId!) : [];
    const commits: FactCommitInput[] = [];
    const results = input.facts.map((raw, index) => {
      try { commits.push(validateFact(raw, index + 1, slot => slot >= 1 && slot <= index, sourcePath)); return "ok"; }
      catch (error) { return `rejected: ${error instanceof Error ? error.message : String(error)}`; }
    });
    problems = results.filter((r) => r.startsWith("rejected:"));
    if (problems.length) return JSON.stringify({ results });
    // 26a: an explicit `note({facts: []})` is how a Noter completes a genuinely empty batch, so its
    // receipt says the batch committed instead of returning two empty arrays and nothing else.
    const receipt = (ids: number[]) => JSON.stringify(ids.length ? { results: ids.map((id) => `ok: F${id}`), factIds: ids }
      : { results: [], factIds: [], committed: "zero facts; this batch is complete" });
    const committedRun = store.commitNotingRun({ run: { ...run, request: JSON.stringify(input),
      response: JSON.stringify({ toolCalls: [...sequence, { name: "note", input, result: "ok" }] }) },
      facts: commits, responseForFacts: receipt });
    // 26a: an empty submission has no per-item slot to carry a refused commit, so it is refused as a
    // plain `rejected:` receipt — the same refusal the reader and `toolRejected` already classify.
    if (!committedRun.ok) { problems = committedRun.problems;
      return results.length ? JSON.stringify({ results: results.map(() => `rejected: ${problems.join("; ")}`) }) : `rejected: ${problems.join("; ")}`; }
    return receipt(committedRun.facts.map((f) => f.id));
  };
  // Exceptions outside memory's batch validator must also block Dreamer completion until
  // that tool is used legally; tool text is diagnostic, never a conflict classification.
  const toolProblems = new Map<string, string>();
  const definitions = renderToolDefinitions(dreaming ? dreamingToolDefinitions() : toolDefinitions, names);
  const definition = (name: ToolDefinition["name"], execute: (input: Record<string, unknown>) => string): ToolDefinition => ({ ...definitions.find(t => t.name === name)!,
    execute: (raw) => {
      if (closed) return "rejected: run has finished";
      let result: string;
      try {
        if ((name === "note" || name === "memory") && !store.enabled(session.id)) throw new Error("Trace Memory is Disabled; use /trace on to enable memory.");
        if (name === "note" && committed) result = "rejected: already committed";
        else if (name === "memory") result = execute(raw && typeof raw === "object" ? raw as Record<string, unknown> : {});
        else {
          if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new Error("expected an object");
          if (name === "trace" || name === "search") validateReadInput(name, raw);
          result = execute(raw as Record<string, unknown>);
        }
        toolProblems.delete(name);
      } catch (error) { result = held && (name === "note" || name === "memory")
          ? held.reject(name, raw, error instanceof Error ? error.message : String(error))
          : `rejected: ${error instanceof Error ? error.message : String(error)}`;
        if (dreaming || (held && (name === "note" || name === "memory"))) toolProblems.set(name, result);
        if (name === "note" && !committed) problems = [result]; }
      if (held && (name === "note" || name === "memory")) {
        const status = held.status(toolProblems);
        // Preserve the existing structured receipt and plain rejection forms. Evaluate after
        // the wrapper has cleared or recorded its per-tool error, not inside the held call.
        result = result.startsWith("{") ? JSON.stringify({ ...JSON.parse(result), status }) : `${result}\nStatus: ${status}`;
      }
      sequence.push({ name, input: structuredClone(raw), result,
        ...(name === "memory" && memory.failure ? { problems: memory.failure.problems } : {}) });
      if (context.kind === "manual" && (name === "note" || name === "memory") && result.includes("rejected:")) store.recordRun({ ...run, request: JSON.stringify(raw), response: result, outcome: "bounced" });
      return result;
    } });
  const tools = [
    definition("trace", (input) => {
      const { text: content } = read.traceRead(input.address as string, { ...input as ListingOptions, modelFacing: true, toolNames: names, sessionId: session.id, headTurnId: path.headTurnId, branch: context.branch,
        ...(context.maxReadChars === undefined ? {} : { maxChars: context.maxReadChars }) });
      fetched.push({ address: input.address as string, input: structuredClone(input), content }); return content;
    }),
    definition("search", (input) => {
      const query = input.queries ?? input.query;
      if (typeof query !== "string" && !Array.isArray(query)) throw new Error("query must be a string");
      return read.search(query as string | string[], input.layer as SearchScope | undefined, { ...input as ListingOptions, modelFacing: true, toolNames: names, sessionId: session.id, headTurnId: path.headTurnId, branch: context.branch,
        ...(context.maxReadChars === undefined ? {} : { maxChars: context.maxReadChars }) });
    }),
    ...(dreaming ? [definition("check", input => { if (Object.keys(input).length) throw new Error(`${names.check} expects {} only`); return dreaming.check(); })] : [definition("note", note)]),
    definition("memory", input => held ? held.memory(input) : memory.execute(input)),
  ];
  const acknowledgeRequest = () => {
    if (closed) throw new Error("noting run has finished");
  };
  return { tools, sequence, fetched, memory, get toolProblems() { return [...toolProblems.values()]; }, get committed() { return committed; }, get problems() { return held ? [...held.problems(), ...toolProblems.values()] : problems; },
    get incomplete() { return held?.incomplete() ?? false; },
    get cancelled() { return closed; },
    reportToolRejection: (id: string, name: "note" | "memory", input: unknown, reason: string) => {
      if (closed || !held || rejectedNativeCalls.has(id)) return;
      rejectedNativeCalls.add(id);
      const receipt = held.reject(name, input, reason);
      sequence.push({ name, input: structuredClone(input), result: `rejected: ${reason}`, problems: [receipt] });
    },
    finalize: () => {
      if (!held) throw new Error("only a Noter has a held publication");
      const result = store.commitNotingRun({ run, facts: held.facts, entryIds: frozenEntries,
        held: { path, slots: held.slots(), knowledge: held.knowledge, validate: () => {
          if (closed) throw new Error("Noter binding closed before publication");
          if (toolProblems.size) throw new Error([...toolProblems.values()].join("; "));
          if (store.getSession(session.id)!.projectId !== session.projectId) throw new Error("target project changed after binding");
          const snapshot = store.pathSnapshot(path);
          const pending = new Set(store.pendingEntries(session.id, context.branch, path.headTurnId!, snapshot).map(entry => entry.id));
          if (frozenEntries.some(id => !pending.has(id))) throw new Error("frozen Noter entries are no longer pending on target path");
          resolvedSources.clear(); hydratedSources.clear();
          held.validate();
        } },
        responseForFacts: ids => JSON.stringify({ ...JSON.parse(run.response ?? "{}"),
          held: held.audit(new Map(held.slots().map((slot, i) => [slot, ids[i]!]))), problems: [] }) });
      if (result.ok) committed = { ...result, diagnostics: [] };
      return result;
    }, close: () => { closed = true; }, acknowledgeRequest,
    reportRequest: (request: unknown) => { acknowledgeRequest(); run.request = JSON.stringify(request); } };
}
