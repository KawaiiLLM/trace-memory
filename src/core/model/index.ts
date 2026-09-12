// core/model — row types and write-time shape validation for noting and consolidation output.
// Terms: CONTEXT.md. Contract: .scratch/v1/spec.md (Modules, Schema).
// Validation never throws on model output; it returns a list of problems instead.

// ---- Enums (mirrored in core/store's CHECK constraints) ----

export const FACT_CATEGORIES = [
  "question",
  "proposal",
  "decision",
  "observation",
  "interpretation",
  "event",
] as const;
export type FactCategory = (typeof FACT_CATEGORIES)[number];

export const KNOWLEDGE_CATEGORIES = [
  "constraint",
  "open",
  "dispute",
  "goal",
  "mechanism",
  "term",
  "reference",
] as const;
export type KnowledgeCategory = (typeof KNOWLEDGE_CATEGORIES)[number];

export const ACTORS = ["user", "agent"] as const;
export type Actor = (typeof ACTORS)[number];

export const RELATION_KINDS = ["support", "negate"] as const;
export type RelationKind = (typeof RELATION_KINDS)[number];

export const RELATION_STRENGTHS = ["strong", "weak"] as const;
export type RelationStrength = (typeof RELATION_STRENGTHS)[number];

export const KNOWLEDGE_SCOPES = ["session", "project", "global"] as const;
export type KnowledgeScope = (typeof KNOWLEDGE_SCOPES)[number];


export const KNOWLEDGE_OPS = ["create", "update", "merge", "split", "archive"] as const;
export type KnowledgeOp = (typeof KNOWLEDGE_OPS)[number];
export type SupportSemantics = "complete_result" | "change";

export const RUN_KINDS = ["noting", "consolidation", "dreaming", "manual"] as const;
export type RunKind = (typeof RUN_KINDS)[number];

export const RUN_OUTCOMES = ["success", "failure", "cancelled", "bounced", "conflict"] as const;
export type RunOutcome = (typeof RUN_OUTCOMES)[number];

export const KNOWLEDGE_MARK_KINDS = ["verified", "flagged"] as const;
export type KnowledgeMarkKind = (typeof KNOWLEDGE_MARK_KINDS)[number];

export const EVENT_STATUSES = ["completed", "reported", "dispatched", "attempted"] as const;
export type EventStatus = (typeof EVENT_STATUSES)[number];

export const EVENT_PREFIXES = ["completed:", "reported:", "dispatched:", "attempted:"] as const;

// ---- Row types (mirror the schema in spec.md) ----

export interface Project {
  id: number;
  name: string;
  declaredBy: "marker" | "mark";
  mergedInto: number | null;
}

export interface Session {
  id: number;
  host: string;
  startedAt: string;
  firstReplyAt: string;
  closedAt: string | null;
  projectId: number;
  parentSessionId: number | null;
}

export interface Turn {
  id: number;
  sessionId: number;
  ordinal: number;
  parentTurnId: number | null;
  kind: "turn" | "compaction";
  userPrompt: string | null;
  assistantText: string | null;
  startedAt: string;
  endedAt: string | null;
}

export interface ToolCall {
  id: number;
  turnId: number;
  ordinal: number;
  name: string;
  input: string | null;
  result: string | null;
  status: string;
}

export interface Fact {
  id: number;
  turnId: number;
  category: FactCategory;
  actor: Actor;
  text: string;
  quote: string | null;
  status?: EventStatus | null;
  source: string[];
  createdAt: string;
}

export interface FactRelation {
  fromFact: number;
  toFact: number;
  kind: RelationKind;
  strength: RelationStrength;
}

export interface Knowledge {
  id: number;
  projectId: number | null; // stable identity attribution; each commit carries its scope
  originSessionId: number;
  author: string;
}

export interface KnowledgeRevision {
  /** Immutable submitting role. Absence denotes a legacy revision whose role was not recorded. */
  actorRole?: "consolidation" | "dreaming" | "manual" | null;
  id: number;
  knowledgeId: number;
  parentId: number | null;
  text: string;
  category: KnowledgeCategory;
  scope: KnowledgeScope;
  supports: number[];
  /** Legacy lists ground the complete result; new lists contain only this revision's change grounds. */
  supportSemantics: SupportSemantics;
  op: KnowledgeOp;
  /** The commit message: why this change was made. Never evidence, scope or applicability (ticket 21a). */
  reason: string;
  /** Subject labels of this revision: classification only, never scope, lifecycle or citation rights (21b). */
  topics: string[];
  runId: number | null;
  createdAt: string;
}

export interface KnowledgeLink {
  fromKnowledge: number;
  fromCommit: number;
  kind: "merged_into" | "split_from";
  toKnowledge: number;
  toCommit: number;
}

export interface TriggerOrigin { readonly sessionId: number; readonly entryIds: readonly number[] }
export type TriggerOriginRelation = "same" | "ancestor" | "descendant" | "divergent" | "independent" | "unknown";
/** Pure 34a handoff contract. Ticket 34b decides what, if anything, each relation refuses. */
export function compareTriggerOrigins(left: TriggerOrigin | null, right: TriggerOrigin | null): TriggerOriginRelation {
  if (!left || !right) return "unknown";
  if (left.sessionId !== right.sessionId) return "independent";
  const common = Math.min(left.entryIds.length, right.entryIds.length);
  for (let i = 0; i < common; i++) if (left.entryIds[i] !== right.entryIds[i]) return "divergent";
  return left.entryIds.length === right.entryIds.length ? "same" : left.entryIds.length < right.entryIds.length ? "ancestor" : "descendant";
}

export interface Run {
  id: number;
  kind: RunKind;
  sessionId: number | null;
  branch: string | null;
  rangeFrom: string | null;
  rangeTo: string | null;
  promptHash: string | null;
  model: string | null;
  mode: string | null;
  request: string | null;
  response: string | null;
  /** Frozen native trigger ancestry. Null is preserved for historical/headless runs with no native proof. */
  origin: TriggerOrigin | null;
  outcome: RunOutcome;
  createdAt: string;
}

export interface KnowledgeMark {
  knowledgeId: number;
  commitId: number;
  kind: KnowledgeMarkKind;
  createdAt: string;
}

// ---- Shared validation plumbing ----

const LOCAL_FACT_HANDLE_RE = /^\$\d+$/; // $n, noting.md
const FACT_ID_RE = /^F\d+$/;
// A bare fact or knowledge id embedded in prose text; ids belong only in relation/supports fields.
const EMBEDDED_ID_RE = /\b[FK]\d+\b/;

function isNonEmptyString(v: unknown): v is string {
  return typeof v === "string" && v.length > 0;
}

function isStringArray(v: unknown): v is string[] {
  return Array.isArray(v) && v.every((x) => typeof x === "string");
}

// ---- Noting output (core/prompts/noting.md) ----

export interface NotingRelationInput {
  target: string; // "F<id>" or "$n"
  strength: RelationStrength;
}

export interface NotingFactInput {
  category: FactCategory;
  actor: Actor;
  text: string;
  quote?: string;
  status?: EventStatus;
  source: string[]; // raw addresses, e.g. "T812#user", "T812#t3"
  support?: NotingRelationInput[];
  negate?: NotingRelationInput[];
}

function validateRelationList(
  path: string,
  value: unknown,
  problems: string[],
): NotingRelationInput[] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value)) {
    problems.push(`${path}: expected an array`);
    return [];
  }
  const out: NotingRelationInput[] = [];
  value.forEach((pair, k) => {
    const p = `${path}[${k}]`;
    if (!Array.isArray(pair) || pair.length !== 2) {
      problems.push(`${p}: expected [target, strength]`);
      return;
    }
    const [target, strength] = pair as [unknown, unknown];
    if (typeof target !== "string" || !(FACT_ID_RE.test(target) || LOCAL_FACT_HANDLE_RE.test(target))) {
      problems.push(`${p}: target must be "F<id>" or a local handle "$n", got ${JSON.stringify(target)}`);
    }
    if (!RELATION_STRENGTHS.includes(strength as RelationStrength)) {
      problems.push(`${p}: strength must be "strong" or "weak", got ${JSON.stringify(strength)}`);
    }
    out.push({ target: target as string, strength: strength as RelationStrength });
  });
  return out;
}

export function validateNotingFact(path: string, raw: unknown, problems: string[]): NotingFactInput | null {
  if (typeof raw !== "object" || raw === null) {
    problems.push(`${path}: expected an object`);
    return null;
  }
  const f = raw as Record<string, unknown>;

  if (!FACT_CATEGORIES.includes(f.category as FactCategory)) {
    problems.push(`${path}.category: expected one of ${FACT_CATEGORIES.join("|")}, got ${JSON.stringify(f.category)}`);
  }
  if (!ACTORS.includes(f.actor as Actor)) {
    problems.push(`${path}.actor: expected "user" or "agent", got ${JSON.stringify(f.actor)}`);
  }
  if (!isNonEmptyString(f.text)) {
    problems.push(`${path}.text: expected a non-empty string`);
  } else {
    if (EMBEDDED_ID_RE.test(f.text)) {
      problems.push(`${path}.text: must not embed a fact or knowledge id; ids live only in relation fields`);
    }
    if (EVENT_PREFIXES.some((p) => (f.text as string).startsWith(p))) {
      problems.push(`${path}.text: completion prefix belongs in status`);
    }
  }
  for (const key of Object.keys(f)) {
    if (!["category", "actor", "text", "quote", "source", "support", "negate", "status"].includes(key)) problems.push(`${path}.${key}: unexpected field`);
  }
  if (f.category === "event" ? !EVENT_STATUSES.includes(f.status as EventStatus) : f.status !== undefined) {
    problems.push(`${path}.status: required for event, forbidden otherwise; expected ${EVENT_STATUSES.join("|")}`);
  }
  if (!isStringArray(f.source) || f.source.length === 0) {
    problems.push(`${path}.source: expected a non-empty array of address strings`);
  }
  if (f.quote !== undefined && typeof f.quote !== "string") {
    problems.push(`${path}.quote: expected a string when present`);
  }
  const support = validateRelationList(`${path}.support`, f.support, problems);
  const negate = validateRelationList(`${path}.negate`, f.negate, problems);

  return {
    category: f.category as FactCategory,
    actor: f.actor as Actor,
    text: f.text as string,
    quote: f.quote as string | undefined,
    status: f.status as EventStatus | undefined,
    source: (f.source as string[]) ?? [],
    support,
    negate,
  };
}

// ---- Memory tool input ----
export interface MemoryOperation {
  op: "create" | "update" | "merge" | "split" | "archive";
  id?: string;
  absorb?: string[];
  children?: { text: string; category: KnowledgeCategory; topics: string[] }[];
  text?: string;
  category?: KnowledgeCategory;
  scope?: KnowledgeScope;
  supports?: string[];
  reason?: string;
  topics?: string[];
}
export interface MemoryBatch {
  operations: MemoryOperation[];
  skipped: { fact: string; because: string }[];
}
