import { resolveFactSource, sourceAddressScope, type SourceResolution } from "../model/source.ts";
import { bindMemory } from "../knowledge-write/bind.ts";
import { KNOWLEDGE_CATEGORIES, KNOWLEDGE_SCOPES, validateNotingFact, type Fact } from "../model/index.ts";
import type { Store, RunInput, FactCommitInput, KnowledgePath, SourceEntry } from "../store/index.ts";
import { DEFAULT_READ_TOKENS, MAX_PUBLIC_READ_TOKENS, READ_FIELDS, READ_VERSIONS, SEARCH_PREVIEW_TOKENS, validateBudgets, type ListingOptions, type SearchScope } from "./read.ts";
import type { NotingDiagnostic } from "../noting/review.ts";
import { holdNoting, Slots } from "../noting/held.ts";
import { tokens, WORKER_ITEM_TOKENS } from "../render/index.ts";
import { canonicalToolNames, renderToolNames, validateToolNames, type ToolNames } from "../prompts/tool-names.ts";

export interface ToolDefinition {
  name: "search" | "note" | "memory" | "check";
  description: string;
  parameters: Record<string, unknown>;
  execute(input: unknown): string;
}
export type ToolContext = { kind: "manual"; sessionId: number; branch: string; currentTurnId: number; triggerEntryId?: number; entryIds?: number[]; maxReadChars?: number; toolNames?: ToolNames }
  | { kind: "noting" | "dreaming"; sessionId: number; branch: string; headTurnId?: number | null; triggerEntryId?: number; entryIds?: number[]; range: { from: string; to: string }; maxReadChars?: number; toolNames?: ToolNames };
type Reads = { search(query: string | readonly string[], layer?: SearchScope, options?: ListingOptions & { sessionId?: number }): string };
const object = (properties: Record<string, unknown>, required: string[] = []) => ({ type: "object", properties, required, additionalProperties: false });
const string = { type: "string" };
const relation = { type: "array", items: { type: "array", prefixItems: [{ type: "string", pattern: "^(F[1-9][0-9]*|\\$[1-9][0-9]*)$" }, { enum: ["strong", "weak"] }], minItems: 2, maxItems: 2 } };
const factSchema = object({ title: { type: "string", minLength: 1, pattern: "^[^\\r\\n\\u2028\\u2029]+$" },
  sources: { type: "string", minLength: 1, description: "Source segments as lines beginning [T12#E3@user] followed by a space and authored text. Each segment continues across lines up to the next marker; no text before the first marker." },
  support: relation, negate: relation }, ["title", "sources"]);
const pagination = { cursor: string, cap: { type: "integer", minimum: 1 } };
const contentBudget = { anyOf: [{ type: "integer", minimum: 1, maximum: Number.MAX_SAFE_INTEGER }, { type: "null" }] };
const fields = { type: "array", uniqueItems: true, items: { enum: READ_FIELDS } };
const readFilters = { versions: { enum: READ_VERSIONS, default: "current", description: "Candidates within each K: current = active current tips applicable on this path; history = additionally applicable superseded and archived revisions; all = additionally other branches' revisions within the selected scope, including their history and archives. Collections show one representative per K. Inapplicable revisions are never write bases here; reading never bypasses write validation." },
  category: { enum: KNOWLEDGE_CATEGORIES, description: "Knowledge category. Implies layer=knowledge when layer is omitted." },
  scope: { enum: KNOWLEDGE_SCOPES, description: "Material selection: session facts/Raw and session knowledge; project facts/Raw and project knowledge; global facts/Raw from all sessions and global knowledge. Omitted: project facts/Raw plus applicable global/project/session knowledge. Does not imply a layer." } };

const factId = { type: "string", pattern: "^F[1-9][0-9]*$" };
const knowledgeId = { type: "string", pattern: "^K[1-9][0-9]*#[a-z]{4,}$" };
const memoryOperationSchema = { ...object({ op: { enum: ["create", "update", "archive"] }, id: knowledgeId,
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
  { name: "search", description: `Use literal substring search over facts, raw and knowledge commits. scope controls facts, Raw and knowledge: session selects this session's facts/Raw and session-scoped knowledge; project selects project facts/Raw and project-scoped knowledge; global selects all sessions' facts/Raw and global-scoped knowledge regardless of author. Omitted scope selects project facts/Raw and applicable global/project/session knowledge; unbound omission discovers all owners. Explicit project/session requires context. versions defaults to current applicable tips; history additionally includes applicable superseded and archived revisions; all additionally includes other branches' revisions in scope, including their history and archives. Revisions not applicable here are never write bases, and reading never bypasses write validation. Each K contributes one best matching revision: highest lexical text/topic similarity, then current, then newer commit. Admission stays literal. The batched form selects each query's capped knowledge hits by similarity so cap keeps the closest match; model-visible knowledge results then display oldest first, retaining category labels. Inspect a K's history at trace://K<id>.history. Only category implies layer=knowledge and conflicts with every other layer; scope does not imply a layer. Fact and knowledge hits are one-line previews: fields defaults to text for current searches and to text plus status for knowledge history/all; explicit fields is authoritative. itemBudget defaults to ${SEARCH_PREVIEW_TOKENS}. Read fact quotes, sources and relations at trace://F<id>. Raw keeps its entry profile. Every receipt states filters and omitted preview fields; no hit does not mean absent. maxTokens defaults to ${DEFAULT_READ_TOKENS} and is capped at ${MAX_PUBLIC_READ_TOKENS} estimated tokens for one response; cap still limits output lines (default 100). Continue with cursor and an empty query; omit frozen options or repeat their original values (changes are rejected). Search previews never count as complete knowledge reads.`, parameters: { ...object({ maxTokens: { type: "integer", minimum: 1, maximum: MAX_PUBLIC_READ_TOKENS, default: DEFAULT_READ_TOKENS }, itemBudget: { ...contentBudget, default: SEARCH_PREVIEW_TOKENS }, fields, query: string, queries: { type: "array", items: string, minItems: 1, description: "Batched form, exclusive with query: one response, each query's own hits under the shared options, at most cap per query (default 1), the query echoed on each hit line, queries with no hit listed as `no hit: \"q\"` lines after the hits and paged like them; a cursor may repeat the original cap." }, layer: { enum: ["facts", "knowledge", "raw", "all"] }, ...readFilters, ...pagination }) } },
  { name: "note", description: "Write one topic's episodic slice with a nonempty single-line title and one top-level sources string: each segment starts on a line with [T12#E3@user] and a space (role suffix optional), followed by authored text until the next marker. No text may precede the first marker. Give each contributing whole native entry its own segment; Core orders segments by path and joins their texts as the body. End a slice at a topic pivot, batch end or body cap; preserve the reasoning arc and name the actual harness in agent segments. Do not put later interpretations in an earlier source or tool-result segment. Block selectors and fact-level text are not allowed. No model-supplied category, status, quote or actor. Thinking alone is not evidence. Relations are optional; manual calls cite existing F facts, N $ references name accepted earlier stable slots. Manual calls commit one fact immediately and reject slot/drop. N calls hold privately until normal terminal publication: omit slot to append, slot:$n completely replaces including a rejected item, drop:$n removes only an unreferenced slot in its own call. Failed replacement invalidates the prior value; numbers never recycle; accepted siblings survive. An empty call {} confirms use, never clears drafts or rejected slots. Receipts list held/rejected handles, including after a native schema refusal; an empty call inspects them. A valid call clears top-level call errors only. Both {{tool.note}} and {{tool.memory}} are required in N.", parameters: { ...object({ ...(factSchema.properties as Record<string, unknown>), slot: { type: "string", pattern: "^\\$[1-9][0-9]*$", description: "N only: replace one held fact." }, drop: { type: "string", pattern: "^\\$[1-9][0-9]*$", description: "N only: drop one unreferenced held fact in a separate call." } }),
    if: { required: ["drop"] }, then: { maxProperties: 1 },
    else: { if: { minProperties: 1 }, then: { required: factSchema.required } } } },
  { name: "memory", description: "Role-bound knowledge writing. Manual writers may create/archive only and commit one valid operation immediately; rejected calls write nothing. N holds create/update/archive privately until normal termination with both {{tool.note}} and {{tool.memory}} used and every refusal resolved. Merge/split remain D-only. N-only fields: operation slot:Mn fully replaces a held operation; omit it to append; drop:Mn removes one in a separate call without recycling numbers; supports may cite accepted local $ fact slots. Manual writers reject slot/drop/local knowledge supports with a reason and have no drafts. N does not send skipped; an empty call {} confirms use without clearing drafts or rejected slots. A legitimately advanced tagged base converts N update to annotated create or archive to an audited no-op; other errors do not convert. Update/archive requires exact K#tag. Every operation has nonempty fact supports and reason (commit message, not evidence). Create/update supplies complete text/category/scope/topics; archive requires kind budget (retains exact parent body) or invalid (requires substantive text explaining grounds, evidence and replacement if any). Archive inherits category/scope/topics. Tagged bases still require valid scope, path and evidence. N receipts list held/rejected handles; after native schema refusal an empty call inspects them.", parameters: { ...object({ ...(memoryOperationSchema.properties as Record<string, unknown>), slot: { type: "string", pattern: "^M[1-9][0-9]*$", description: "N only: replace one held operation." }, drop: { type: "string", pattern: "^M[1-9][0-9]*$", description: "N only: drop one held operation in a separate call." } }),
    if: { required: ["drop"] }, then: { maxProperties: 1 },
    else: { if: { minProperties: 1 }, then: { required: memoryOperationSchema.required, allOf: memoryOperationSchema.allOf } } } },
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
  memory.description = "One Dreamer item per call, committed at once when legal: one operation with its fields as top-level arguments, or one skip. Allowed operations are update, an exactly-two-parent merge, an atomic one-parent/two-child split, and archive; create is forbidden. Every result body is complete. Merge may omit text to copy the later exact parent's body verbatim. Non-empty supports are the exact evidence for the change; empty supports request Store-side inheritance from every exact parent. Every parent requires an exact K#tag base and must belong to one of this session's pools: global, its project's or its own. A base that is not the latest effective applicable revision on the writer path is rejected naming the current revision. skip with because names an exact untagged K@vN history address for a frozen version that was deliberated and intentionally left unchanged; it requires no full-body read and grants no mutation authority; it marks that version processed without changing it. Never skip an untouched reference or an item you did not deliberate. Archive requires kind budget (keeps parent's complete body) or invalid (substantive statement of grounds, evidence and replacement if any); category/scope/topics carry over. A refused item, including one missing required fields, is numbered Mn (numbers never recycle) and blocks success until slot:Mn resubmits it (a legal resubmission commits) or drop:Mn withdraws it in its own call; another call's commit never clears it. A call that is not structurally one item gets no number and is a top-level call error until a subsequent structurally valid call. Committed items survive later refusals.";
  const operation = structuredClone(memoryOperationSchema) as any;
  operation.properties.op.enum = ["update", "merge", "split", "archive"];
  operation.properties.supports.minItems = 0;
  operation.properties.supports.items = factId;

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
  // 127: one item per call, like the Noter's (116): an operation's fields, or {skip, because}; slot/drop address a refused item.
  // No root anyOf/oneOf/allOf: Claude Code skips an MCP tool whose input schema has one.
  memory.parameters = { ...object({ ...operation.properties,
    skip: { type: "string", pattern: "^K[1-9][0-9]*@v[1-9][0-9]*$", description: "A deliberated frozen version left unchanged; its own call with because." },
    because: { type: "string", minLength: 1 },
    slot: { type: "string", pattern: "^M[1-9][0-9]*$", description: "Resubmit one refused item under its number." },
    drop: { type: "string", pattern: "^M[1-9][0-9]*$", description: "Withdraw one refused item in a separate call." } }),
    if: { required: ["drop"] }, then: { maxProperties: 1 },
    else: { if: { required: ["skip"] },
      then: { required: ["skip", "because"], not: { anyOf: Object.keys(operation.properties).map(key => ({ required: [key] })) } },
      else: { required: operation.required, allOf: operation.allOf, not: { required: ["because"] } } } };
  tools.push({ name: "check", description: "Read-only pool check. Returns frozen and own revision counts, newly pending revisions, current pool sizes and blockers: refused memory items (Mn) not yet resubmitted with slot or withdrawn with drop, a pending memory call error, any pool over its budget, and frozen versions neither operated on nor skipped. The run succeeds only with no blocker. This receipt never grants a complete-body handle or commits knowledge.", parameters: object({}) });
  return tools;
}

export function validateReadInput(name: "search", raw: unknown): Record<string, unknown> {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new Error("expected an object");
  const input = raw as Record<string, unknown>;
  const properties = toolDefinitions.find(t => t.name === name)!.parameters.properties as object;
  if (Object.keys(input).some(k => !(k in properties))) throw new Error("unexpected parameter");
  if (input.query !== undefined && input.queries !== undefined) throw new Error("query and queries are exclusive");
  if (input.queries !== undefined) {
    if (!Array.isArray(input.queries) || !input.queries.length || input.queries.some(q => typeof q !== "string")) throw new Error("queries must be a non-empty array of strings");
  } else if (typeof input.query !== "string") throw new Error("query must be a string");
  validateBudgets(input as ListingOptions);
  if (input.category !== undefined && input.layer !== undefined && input.layer !== "knowledge")
    throw new Error("category filter requires layer knowledge");
  return input;
}

/** The model-facing result format, read back. A tool result is a refusal when it is a `rejected:`
 * receipt, and a writer's JSON `results` array carries one result per call — both
 * spellings are produced in this file. Every consumer that must classify a result rather than show it (either Pi
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
  // Historical run audits retain their read field; public trace calls no longer populate it.
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
    if (fact && context.kind === "noting" && tokens(text) > WORKER_ITEM_TOKENS) errors.push(`Fact exceeds ${WORKER_ITEM_TOKENS}-token limit: ${tokens(text)} tokens. When capacity runs short, first remove repetition and non-key detail; if it still does not fit, split along subtopics.`);
    if (errors.length || !fact || !ordered.length) throw new Error(errors.join("; ") || "invalid fact");
    const first = ordered[0]!.hit.entry.turnId;
    return { ...fact, text, source: ordered.map(segment => segment.address), segments: ordered.map(segment => segment.text),
      turnId: first, createdAt: store.getTurn(first)!.startedAt,
      entryIds: ordered.map(segment => segment.hit.entry.id) };
  };
  const held = context.kind === "noting" ? holdNoting(store, run, path, validateFact, {
    note: Object.keys(toolDefinitions.find(tool => tool.name === "note")!.parameters.properties as object),
    memory: Object.keys(toolDefinitions.find(tool => tool.name === "memory")!.parameters.properties as object),
  }, names) : undefined;
  const rejectedNativeCalls = new Set<string>();
  const note = (input: Record<string, unknown>): string => {
    resolvedSources.clear(); hydratedSources.clear();
    if (held) return held.note(input);
    if (context.kind === "dreaming") return `rejected: ${names.note} is not available to this knowledge worker`;
    if ("drop" in input || "slot" in input) {
      problems = ["slot/drop are N-only held-batch fields; manual note commits immediately and has no draft slots"];
      return `rejected: ${problems[0]}`;
    }
    const unexpected = Object.keys(input).filter(key => !(key in factSchema.properties));
    if (unexpected.length) {
      problems = [`${names.note} expects one fact or {} only; ${unexpected.map(key => `${key}: unexpected field`).join("; ")}`];
      return `rejected: ${problems[0]}`;
    }
    // Manual validation shares one current path within this synchronous submission only.
    // A later call reads it again; Noting's callback instead retains its frozen initial path.
    const empty = !Object.keys(input).length;
    const sourcePath = empty ? [] : manualEntryIds ? manualEntries
      : store.sourcePath(session.id, context.branch, path.headTurnId!);
    const commits: FactCommitInput[] = [];
    const results = empty ? [] : (() => {
      try { commits.push(validateFact(input, 1, () => false, sourcePath)); return ["ok"]; }
      catch (error) { return [`rejected: ${error instanceof Error ? error.message : String(error)}`]; }
    })();
    problems = results.filter((r) => r.startsWith("rejected:"));
    if (problems.length) return JSON.stringify({ results });
    // An explicit empty call confirms use without writing a fact; its receipt
    // says the call completed instead of returning empty arrays without context.
    const receipt = (ids: number[]) => JSON.stringify(ids.length ? { results: ids.map((id) => `ok: F${id}`), factIds: ids }
      : { results: [], factIds: [], committed: "zero facts; this batch is complete" });
    const committedRun = store.commitNotingRun({ run: { ...run, request: JSON.stringify(input),
      response: JSON.stringify({ toolCalls: [...sequence, { name: "note", input, result: "ok" }] }) },
      facts: commits, responseForFacts: receipt });
    // An empty submission has no per-item slot to carry a refused commit, so it is refused as a
    // plain `rejected:` receipt — the same refusal the reader and `toolRejected` already classify.
    if (!committedRun.ok) { problems = committedRun.problems;
      return results.length ? JSON.stringify({ results: results.map(() => `rejected: ${problems.join("; ")}`) }) : `rejected: ${problems.join("; ")}`; }
    return receipt(committedRun.facts.map((f) => f.id));
  };
  // Exceptions outside memory's batch validator must also block Dreamer completion until
  // that tool is used legally; tool text is diagnostic, never a conflict classification.
  const toolProblems = new Map<string, string>();
  const definitions = renderToolDefinitions(dreaming ? dreamingToolDefinitions() : toolDefinitions, names);
  // 127: D commits each legal item at once; a refused one keeps its M slot as the Noter's does (116).
  const dreamer = dreaming ? new Slots<object>("M", names,
    Object.keys(definitions.find(t => t.name === "memory")!.parameters.properties as object), true) : undefined;
  const dream = (raw: unknown) => {
    const content = raw as Record<string, unknown>, { skip, because, ...operation } = content;
    const skipping = "skip" in content || "because" in content;
    if (skipping && Object.keys(operation).length) throw new Error("a skip call carries only skip and because");
    if (skipping && typeof skip !== "string") throw new Error("skip: expected an exact K@vN version");
    const { results: [result], ...receipt } = memory.execute(skipping ? { operations: [], skipped: [{ knowledge: skip, because }] }
      : { operations: [content], skipped: [] }, content);
    if (result!.startsWith("rejected: ")) throw new Error(result!.slice("rejected: ".length));
    return receipt;
  };
  const definition = (name: ToolDefinition["name"], execute: (input: Record<string, unknown>) => string): ToolDefinition => ({ ...definitions.find(t => t.name === name)!,
    execute: (raw) => {
      if (closed) return "rejected: run has finished";
      const priorFailure = memory.failure;
      let result: string;
      try {
        if ((name === "note" || name === "memory") && !store.enabled(session.id)) throw new Error("Trace Memory is Disabled; use /trace on to enable memory.");
        if (name === "note" && committed) result = "rejected: already committed";
        else {
          if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new Error("expected an object");
          if (name === "search") validateReadInput(name, raw);
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
        ...(name === "memory" && memory.failure && memory.failure !== priorFailure ? { problems: memory.failure.problems } : {}) });
      if (context.kind === "manual" && (name === "note" || name === "memory") && result.includes("rejected:")) store.recordRun({ ...run, request: JSON.stringify(raw), response: result, outcome: "bounced" });
      return result;
    } });
  const tools = [
    definition("search", (input) => {
      const query = input.queries ?? input.query;
      if (typeof query !== "string" && !Array.isArray(query)) throw new Error("query must be a string");
      return read.search(query as string | string[], input.layer as SearchScope | undefined, { ...input as ListingOptions, modelFacing: true, toolNames: names, sessionId: session.id, headTurnId: path.headTurnId, branch: context.branch,
        ...(context.maxReadChars === undefined ? {} : { maxChars: context.maxReadChars }) });
    }),
    ...(dreaming ? [definition("check", input => { if (Object.keys(input).length) throw new Error(`${names.check} expects {} only`); return dreaming.check(); })] : [definition("note", note)]),
    definition("memory", input => held ? held.memory(input) : dreamer ? dreamer.call(input, dream, () => {})
      : Object.keys(input).length && ("slot" in input || "drop" in input || "operations" in input || "skipped" in input)
        ? `rejected: manual ${names.memory} expects one create/archive operation or {}`
        : JSON.stringify(memory.execute({ operations: Object.keys(input).length ? [input] : [], skipped: [] }, input))),
  ];
  const acknowledgeRequest = () => {
    if (closed) throw new Error("noting run has finished");
  };
  return { tools, sequence, fetched, memory, get toolProblems() { return [...toolProblems.values()]; }, get committed() { return committed; }, get problems() { return held ? [...held.problems(), ...toolProblems.values()] : dreamer ? [...toolProblems.values(), ...dreamer.problems()] : problems; },
    get incomplete() { return held?.incomplete() ?? false; },
    passEnd: () => { if (!held) throw new Error("only a Noter has a held end pass"); return held.passEnd(toolProblems); },
    get cancelled() { return closed; },
    reportToolRejection: (id: string, name: "note" | "memory", input: unknown, reason: string) => {
      if (closed || !(held || dreamer) || rejectedNativeCalls.has(id)) return;
      rejectedNativeCalls.add(id);
      // 127: a host-refused Dreamer call takes the Noter's path: a numbered slot, or a call error when shapeless.
      const receipt = held ? held.reject(name, input, reason) : dreamer!.call(input, dream, () => {}, reason);
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
