import { resolveFactSource, sourceAddressScope, type SourceResolution } from "../model/source.ts";
import { bindMemory } from "../knowledge-write/bind.ts";
import { KNOWLEDGE_CATEGORIES, KNOWLEDGE_SCOPES, validateNotingFact } from "../model/index.ts";
import type { Store, RunInput, FactCommitInput, KnowledgePath, SourceEntry } from "../store/index.ts";
import { searchToolDefinition, validateSearchInput, type SearchLayer, type SearchOptions } from "./search.ts";
import { words, wordLimit } from "../render/index.ts";
import { overLimit } from "../knowledge-write/prepare.ts";
import { canonicalToolNames, renderToolNames, validateToolNames, type ToolNames } from "../prompts/tool-names.ts";

interface ToolOf<Name extends string, Answer> { name: Name; description: string; parameters: Record<string, unknown>; execute(input: unknown): Answer }
/** Only a `search` with `code` answers asynchronously (its script runs in a sandbox); every other call is
 * synchronous. Narrowing by name (`tools.find(t => t.name === "note")`) selects the right answer type. */
export type ToolDefinition = ToolOf<"note", string> | ToolOf<"memory", string> | ToolOf<"check", string> | ToolOf<"search", string | Promise<string>>;
export type ToolContext = { kind: "manual"; sessionId: number; branch: string; currentTurnId: number; triggerEntryId?: number; entryIds?: number[]; maxReadChars?: number; toolNames?: ToolNames; spill?: (text: string) => string }
  | { kind: "noting" | "dreaming"; sessionId: number; branch: string; headTurnId?: number | null; triggerEntryId?: number; entryIds?: number[]; range: { from: string; to: string }; maxReadChars?: number; toolNames?: ToolNames; spill?: (text: string) => string };
type Reads = { search(query: string | undefined, layer?: SearchLayer, options?: SearchOptions): string | Promise<string> };
const object = (properties: Record<string, unknown>, required: string[] = []) => ({ type: "object", properties, required, additionalProperties: false });
const string = { type: "string" };
const relation = { type: "array", items: { type: "array", prefixItems: [{ type: "string", pattern: "^F[1-9][0-9]*$" }, { enum: ["strong", "weak"] }], minItems: 2, maxItems: 2 } };
/** One nonempty line; its length is checked against `writing.titleWords` when the call is made. */
const titleSchema = { type: "string", minLength: 1, pattern: "^[^\\r\\n\\u2028\\u2029]+$" };
const factSchema = object({ title: titleSchema,
  sources: { type: "string", minLength: 1, description: "Source segments as lines beginning [T12#E3@user] followed by a space and authored text. Each segment continues across lines up to the next marker; no text before the first marker." },
  support: relation, negate: relation, caused_by: { ...relation, maxItems: 2 },
  objects: { type: "array", items: { type: "string", minLength: 1 } } }, ["title", "sources"]);

const factId = { type: "string", pattern: "^F[1-9][0-9]*$" };
const knowledgeId = { type: "string", pattern: "^K[1-9][0-9]*#[a-z]{4,}$" };
const updateBodySchema = { oneOf: [
  { required: ["text", "category", "scope", "topics"], not: { required: ["edits"] } },
  { required: ["edits"], not: { required: ["text"] } },
] };
/** An archive states its grounds as the new version's body. */
const explainedKind = { enum: ["invalid", "inadmissible"] };
const memoryOperationSchema = { ...object({ op: { enum: ["create", "update", "archive"] }, id: knowledgeId, title: titleSchema,
  files: { type: ["array", "null"], items: { type: "string", minLength: 1 }, description: "Code-file paths backing this version, or null for no code files." },
  absorb: { type: "array", items: knowledgeId, minItems: 1, uniqueItems: true }, kind: { enum: ["invalid", "inadmissible"] }, text: { type: "string", minLength: 1 },
  edits: { type: "array", minItems: 1, items: object({ old: { type: "string", minLength: 1 }, new: { type: "string" } }, ["old", "new"]) },
  category: { enum: KNOWLEDGE_CATEGORIES }, scope: { enum: KNOWLEDGE_SCOPES }, supports: { type: "array", items: { ...factId, description: "An existing F fact." }, minItems: 1 },
  reason: { type: "string", minLength: 1 }, topics: { type: "array", items: { type: "string", minLength: 1 } } }, ["op", "supports", "reason", "files"]), allOf: [
  { if: { properties: { op: { const: "create" } } }, then: { required: ["title"], not: { required: ["id"] } }, else: { required: ["id"] } },
  { if: { properties: { op: { const: "merge" } } }, then: { required: ["absorb"] }, else: { not: { required: ["absorb"] } } },
  { if: { properties: { op: { const: "archive" } } }, then: { required: ["kind"],
    allOf: [{ not: { anyOf: ["title", "category", "scope", "topics"].map(key => ({ required: [key] })) } },
      { if: { properties: { kind: explainedKind } }, then: { required: ["text"] }, else: { not: { required: ["text"] } } }] },
    else: { not: { required: ["kind"] }, if: { properties: { op: { const: "update" } } }, then: updateBodySchema,
      else: { required: ["text", "category", "scope", "topics"] } } },
  { if: { properties: { op: { const: "update" } } }, then: {}, else: { not: { required: ["edits"] } } },
] };

/** The tools of a main-session writer; the Noter has none of them (it writes files and calls `check`). */
export const toolDefinitions: Omit<ToolDefinition, "execute">[] = [
  searchToolDefinition,
  { name: "note", description: "Write one topic's episodic slice with a nonempty single-line title and one top-level sources string: each segment starts on a line with [T12#E3@user] and a space (role suffix optional), followed by authored text until the next marker. No text may precede the first marker. Give each contributing whole native entry its own segment; Core orders segments by path and joins their texts as the body. End a slice at a topic pivot, batch end or the configured writing limits (title, and the segments summed as the body); preserve the reasoning arc and name the actual harness in agent segments. Do not put later interpretations in an earlier source or tool-result segment. Block selectors and fact-level text are not allowed. No model-supplied category, status, quote or actor. Thinking alone is not evidence. Relations are optional and cite existing F facts. Each call commits one fact immediately. An empty call {} writes nothing.", parameters: { ...object(factSchema.properties as Record<string, unknown>),
    if: { minProperties: 1 }, then: { required: factSchema.required } } },
  { name: "memory", description: "Role-bound knowledge writing. Manual writers may create/update/archive and commit one valid operation immediately; rejected calls write nothing. Merge/split remain D-only. Every operation has nonempty fact supports and reason (commit message, not evidence). Create supplies a title and complete text/category/scope/topics. Update inherits the base's title when none is given; a base without one requires it. Title and body must fit the configured writing limits (every writer, including manual); a refusal states the field, its count and the limit. Update supplies exactly one of complete text (with category/scope/topics) or nonempty edits:[{old,new}]. Edits apply in order to the exact base body; each nonempty old must match exactly once at that step, and empty new deletes. A failed edit refuses the whole operation naming its position and zero/multiple matches. Omitted category/scope/topics inherit from the base only with edits; supplied fields replace them. The complete update result passes the existing admission, supports, scope and length checks. Only the complete result is stored; immediate update receipts give its new K#tag and pool item tokens before/after without echoing the body. Archive requires kind invalid or inadmissible (each requires substantive text explaining grounds, evidence and replacement if any). Archive inherits category/scope/topics. Update/archive requires exact K#tag. Tagged bases still require valid scope, path and evidence. An empty call {} writes nothing.", parameters: { ...object(memoryOperationSchema.properties as Record<string, unknown>),
    if: { minProperties: 1 }, then: { required: memoryOperationSchema.required, allOf: memoryOperationSchema.allOf } } },
];

/** The Noter's `check` (identical in both of its tasks): the stop hook's check on the current step's file, on demand. */
const notingCheckDefinition: Omit<ToolDefinition, "execute"> = { name: "check", description: "Checks the file of your current step with the check that runs when you stop: block format, source addresses in this batch, one segment per entry per fact, roles, required fields, base versions, one record per knowledge item, allowed operations, and the title and body limits. Returns your task, step and file path, each problem with file and line, and the host-measured units of every title and body against its target; the first result of a step also carries that step's instructions. Writes and publishes nothing.", parameters: object({}) };
/** The Noter's own tools; its native read, write and edit are the host's. */
export const notingToolDefinitions: Omit<ToolDefinition, "execute">[] = [searchToolDefinition, notingCheckDefinition];

/** The Dreamer's own tools (ticket 144 stage 4): `search`, and `check` on the task's workspace files. One list for every task of a run. */
const dreamingCheckDefinition: Omit<ToolDefinition, "execute"> = { name: "check", description: "Names your task and your workspace files, and checks them with the check that runs when you stop: block format, allowed operations, base versions, one record per knowledge item, and the title and body limits. Returns your task and file paths, each problem with file and line, and the host-measured units of every title and body against its target. Writes and publishes nothing.", parameters: object({}) };
export const dreamingWorkspaceToolDefinitions: Omit<ToolDefinition, "execute">[] = [searchToolDefinition, dreamingCheckDefinition];

export function renderToolDefinitions(definitions: readonly Omit<ToolDefinition, "execute">[], names: ToolNames) {
  const exposed = validateToolNames(names);
  return definitions.map(definition => ({ ...definition, description: renderToolNames(definition.description, exposed) }));
}

/** Price the descriptions and actual exposed names that the host advertises. */
export function pricedToolDefinitions(definitions: readonly Omit<ToolDefinition, "execute">[], names: ToolNames) {
  return renderToolDefinitions(definitions, names).map(definition => ({ ...definition, name: names[definition.name] }));
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

/** The Turns a Noting batch froze: the range's ancestry from its last Turn back to its first. */
export function frozenTurnIds(store: Store, sessionId: number, range: { from: string; to: string }): Set<number> {
  const parse = (address: string) => {
    const m = /^S([1-9]\d*)\/T([1-9]\d*)$/.exec(address);
    if (!m || Number(m[1]) !== sessionId) throw new Error("invalid frozen range");
    return Number(m[2]);
  };
  const allowed = new Set<number>();
  const from = parse(range.from); let id: number | null = parse(range.to);
  while (id !== null && !allowed.has(id)) {
    const turn = store.getTurn(id);
    if (!turn || turn.sessionId !== sessionId) throw new Error("invalid frozen range");
    allowed.add(id); if (id === from) break; id = turn.parentTurnId;
  }
  if (!allowed.has(from)) throw new Error("invalid frozen range ancestry");
  return allowed;
}

/** What a Noting batch may cite, read once at binding time: the source entries of its path, the path's Turns and the frozen entries. */
export function notingSources(store: Store, path: KnowledgePath, allowed: ReadonlySet<number>, entryIds?: readonly number[]) {
  const initial = store.transaction(() => ({ path: store.sourcePath(path.sessionId, path.branch!, path.headTurnId!), snapshot: store.pathSnapshot(path) }));
  const frozenEntries = entryIds ? [...entryIds] : initial.path.filter(e => allowed.has(e.turnId)).map(e => e.id);
  return { initialPath: initial.path, sourceTurns: initial.snapshot.turns, frozenEntries, frozenIds: new Set(frozenEntries) };
}

/** Fact validation for `note` and for the workspace facts file: sources are addresses of the writer's entry set
 * (the frozen batch for the Noter), one segment per entry, roles checked, and the one title/body cap (ticket 144).
 * A call or a file shares one source resolution; `reset` forgets it before the next. */
export function factValidator(store: Store, scope: { sessionId: number; noting: boolean; frozenIds: ReadonlySet<number>;
  sourceTurns: ReturnType<Store["pathTurns"]>; initialPath: ReturnType<Store["sourcePath"]> }) {
  // One synchronous call/pass only: corrections and terminal validation must reread sources.
  const resolvedSources = new Map<string, SourceResolution[]>();
  const hydratedSources = new Map<number, SourceEntry>();
  const existingFact = (id: number) => !!store.getFact(id);
  const validate = (raw: unknown, index: number, earlier: (slot: number) => boolean,
    sourcePath: ReturnType<Store["sourcePath"]> = scope.initialPath): FactCommitInput => {
    const errors: string[] = [];
    const fact = validateNotingFact(`facts[${index}]`, raw, errors);
    const candidates = scope.noting ? sourcePath.filter(entry => scope.frozenIds.has(entry.id)) : sourcePath;
    const cited = new Map<number, { hit: SourceResolution; address: string; text: string }>();
    if (fact) {
      for (const source of fact.sources) {
        const address = sourceAddressScope(source.address);
        const entries = address ? candidates.filter(entry => entry.turnId === address.turn && entry.entryOrdinal === address.ordinal) : [];
        let matches = resolvedSources.get(source.address);
        if (!matches) {
          const missing = entries.filter(entry => !hydratedSources.has(entry.id));
          if (missing.length) for (const entry of store.hydrateSourceEntries(missing.map(entry => entry.id))) hydratedSources.set(entry.id, entry);
          matches = resolveFactSource(entries.map(entry => hydratedSources.get(entry.id)!), source.address);
          resolvedSources.set(source.address, matches);
        }
        const turn = matches.length === 1 ? store.getTurn(matches[0]!.entry.turnId) : null;
        if (!turn || turn.sessionId !== scope.sessionId || !scope.sourceTurns.has(turn.id) || turn.kind === "compaction")
          errors.push(`invalid source ${source.address}; expected admissible Raw in the eligible entry set`);
        else if (cited.has(matches[0]!.entry.id)) errors.push(`duplicate source entry ${source.address}`);
        else cited.set(matches[0]!.entry.id, { hit: matches[0]!, address: source.address, text: source.text });
      }
      for (const kind of ["support", "negate", "caused_by"] as const) {
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
    // Tickets 144, 145: one cap for every writer, in units. The body is the sum of its segments, each counted on its own.
    if (fact && words(fact.title) > wordLimit(store.writing.titleWords)) errors.push(overLimit("title", words(fact.title), store.writing.titleWords));
    const bodyWords = ordered.reduce((sum, segment) => sum + words(segment.text), 0);
    if (fact && bodyWords > wordLimit(store.writing.bodyWords)) errors.push(`${overLimit("sources", bodyWords, store.writing.bodyWords)} (segments counted one by one)`);
    if (errors.length || !fact || !ordered.length) throw new Error(errors.join("; ") || "invalid fact");
    const first = ordered[0]!.hit.entry.turnId;
    return { ...fact, text, source: ordered.map(segment => segment.address), segments: ordered.map(segment => segment.text),
      turnId: first, createdAt: store.getTurn(first)!.startedAt,
      entryIds: ordered.map(segment => segment.hit.entry.id) };
  };
  return { validate, reset: () => { resolvedSources.clear(); hydratedSources.clear(); } };
}

export function bindTools(store: Store, read: Reads, supplied: ToolContext, metadata?: RunInput,
  exposedNames: ToolNames = canonicalToolNames,
  /** The Noter's and the Dreamer's workspace check (ticket 144): their only writer-side tool. */
  noting?: { check(): string }) {
  const names = validateToolNames(supplied.toolNames ?? exposedNames);
  const { spill, ...cloneable } = supplied; // a function cannot be cloned; the rest is frozen against later mutation
  const context = structuredClone(cloneable) as ToolContext;
  const session = store.getSession(context.sessionId);
  if (!session || !context.branch) throw new Error("tools require an existing session and a non-empty branch");
  if (context.kind === "manual") {
    if (store.getTurn(context.currentTurnId)?.sessionId !== session.id) throw new Error("current turn must belong to the calling session");
  } else if (context.kind === "noting" || context.kind === "dreaming") {
    if (!noting) throw new Error("Noter and Dreamer workspace tools require their workspace check");
    if (context.kind === "noting") frozenTurnIds(store, session.id, context.range); // a range that is not this session's ancestry is refused at binding
  }
  // The branch rides on the path so applicability is judged per source entry (review 2026-09-08 P1).
  const path = context.kind === "manual" ? { sessionId: session.id, headTurnId: context.currentTurnId, branch: context.branch }
    : context.kind === "noting" ? { sessionId: session.id, headTurnId: Number(context.range.to.split("/T")[1]), branch: context.branch }
    : { sessionId: session.id, headTurnId: context.headTurnId ?? null, branch: context.branch };
  const plain: RunInput = { kind: context.kind, sessionId: session.id, branch: context.branch,
    rangeFrom: context.kind === "manual" ? `S${session.id}/T${context.currentTurnId}` : context.range.from,
    rangeTo: context.kind === "manual" ? `S${session.id}/T${context.currentTurnId}` : context.range.to, createdAt: new Date().toISOString() };
  const run = metadata ?? store.bindRunOrigin(plain, store.triggerOrigin(path, context.triggerEntryId));
  // Source resolution, range checks and candidate applicability share one binding-time database/path
  // membership. Later tree movement and same-Turn entry ingestion cannot change any half of the run.
  const sourceTurns = store.pathTurns(path);
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
  const memory = bindMemory(store, session.id, run, path, manualEntryIds
    ? factId => {
      const fact = store.getFact(factId);
      if (!fact) return false;
      const entries = store.factEntries(factId);
      return entries.length ? entries.every(entryId => manualEntryIds.has(entryId)) : fact.turnId !== path.headTurnId;
    } : undefined, names);
  const sequence = memory.sequence;
  // Historical run audits retain their read field; public trace calls no longer populate it.
  const fetched: { address: string; input: unknown; content: string }[] = [];
  let closed = false;
  let problems: string[] = [];
  // Reads resolve any existing address (user ruling 2026-09-07: no visibility limits on reads);
  // injection and Consolidation keep their scope rules elsewhere. Writes still bind sources to the run.
  const facts = factValidator(store, { sessionId: session.id, noting: false, frozenIds: new Set<number>(), sourceTurns, initialPath: [] });
  const validateFact = facts.validate;
  const note = (input: Record<string, unknown>): string => {
    facts.reset();
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
    // A later call reads it again.
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
    const receipt = (ids: number[]) => JSON.stringify(ids.length ? { results: ids.map((id) => `ok: F${id}`), factIds: ids }
      : { results: [], factIds: [], committed: "zero facts; nothing was written" });
    const committedRun = store.commitNotingRun({ run: { ...run, request: JSON.stringify(input),
      response: JSON.stringify({ toolCalls: [...sequence, { name: "note", input, result: "ok" }] }) },
      facts: commits, responseForFacts: receipt });
    // An empty submission has no per-item slot to carry a refused commit, so it is refused as a
    // plain `rejected:` receipt — the same refusal the reader and `toolRejected` already classify.
    if (!committedRun.ok) { problems = committedRun.problems;
      return results.length ? JSON.stringify({ results: results.map(() => `rejected: ${problems.join("; ")}`) }) : `rejected: ${problems.join("; ")}`; }
    return receipt(committedRun.facts.map((f) => f.id));
  };
  const definitions = renderToolDefinitions(context.kind === "noting" ? notingToolDefinitions
    : context.kind === "dreaming" ? dreamingWorkspaceToolDefinitions : toolDefinitions, names);
  const definition = (name: ToolDefinition["name"], execute: (input: Record<string, unknown>) => string | Promise<string>): ToolDefinition => ({ ...definitions.find(t => t.name === name)!,
    execute: (raw) => {
      if (closed) return "rejected: run has finished";
      const priorFailure = memory.failure;
      let result: string | Promise<string>;
      try {
        if ((name === "note" || name === "memory") && !store.enabled(session.id)) throw new Error("Trace Memory is Disabled; use /trace on to enable memory.");
        if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new Error("expected an object");
        result = execute(raw as Record<string, unknown>);
      } catch (error) { result = `rejected: ${error instanceof Error ? error.message : String(error)}`;
        if (name === "note") problems = [result]; }
      if (typeof result !== "string") {
        const input = structuredClone(raw), settle = (text: string) => { sequence.push({ name, input, result: text }); return text; };
        return result.then(settle, error => settle(`rejected: ${error instanceof Error ? error.message : String(error)}`));
      }
      sequence.push({ name, input: structuredClone(raw), result,
        ...(name === "memory" && memory.failure && memory.failure !== priorFailure ? { problems: memory.failure.problems } : {}) });
      if (context.kind === "manual" && (name === "note" || name === "memory") && result.includes("rejected:")) store.recordRun({ ...run, request: JSON.stringify(raw), response: result, outcome: "bounced" });
      return result;
    } }) as ToolDefinition;
  const tools = [
    definition("search", input => {
      const { query, layer, options } = validateSearchInput(input);
      return read.search(query, layer, { ...options, sessionId: session.id, headTurnId: path.headTurnId, branch: context.branch,
        ...(spill ? { spill } : {}) });
    }),
    ...(noting ? [definition("check", input => { if (Object.keys(input).length) throw new Error(`${names.check} expects {} only`); return noting.check(); })] : [definition("note", note)]),
    ...(context.kind === "noting" || context.kind === "dreaming" ? [] : [definition("memory", input =>
      Object.keys(input).length && ("slot" in input || "drop" in input || "operations" in input || "skipped" in input)
        ? `rejected: manual ${names.memory} expects one create/update/archive operation or {}`
        : JSON.stringify(memory.execute({ operations: Object.keys(input).length ? [input] : [], skipped: [] }, input)))]),
  ];
  const acknowledgeRequest = () => {
    if (closed) throw new Error("noting run has finished");
  };
  return { tools, sequence, fetched, memory,
    get cancelled() { return closed; }, close: () => { closed = true; }, acknowledgeRequest,
    reportRequest: (request: unknown) => { acknowledgeRequest(); run.request = JSON.stringify(request); } };
}
