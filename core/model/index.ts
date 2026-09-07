// core/model — row types and write-time shape validation for recording and integration output.
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


export const KNOWLEDGE_OPS = ["create", "update", "merge", "archive"] as const;
export type KnowledgeOp = (typeof KNOWLEDGE_OPS)[number];

export const RUN_KINDS = ["recording", "integration", "manual"] as const;
export type RunKind = (typeof RUN_KINDS)[number];

export const RUN_OUTCOMES = ["success", "failure", "cancelled", "bounced"] as const;
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
  id: number;
  knowledgeId: number;
  parentId: number | null;
  text: string;
  category: KnowledgeCategory;
  scope: KnowledgeScope;
  supports: number[];
  op: KnowledgeOp;
  because: number[] | null;
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
  outcome: RunOutcome;
  createdAt: string;
}

export interface KnowledgeMark {
  knowledgeId: number;
  commitId: number;
  kind: KnowledgeMarkKind;
  createdAt: string;
}

export interface PendingDelivery {
  runId: number;
  sessionId: number;
  branch: string | null;
  deliveredAt: string | null;
}

// ---- Shared validation plumbing ----

export interface ValidationResult<T> {
  problems: string[];
  value: T | null;
}

const LOCAL_FACT_HANDLE_RE = /^\$\d+$/; // $n, recording.md
const FACT_ID_RE = /^F\d+$/;
// A bare fact or knowledge id embedded in prose text; ids belong only in relation/supports fields.
const EMBEDDED_ID_RE = /\b[FK]\d+\b/;

function isNonEmptyString(v: unknown): v is string {
  return typeof v === "string" && v.length > 0;
}

function isStringArray(v: unknown): v is string[] {
  return Array.isArray(v) && v.every((x) => typeof x === "string");
}

// ---- Recording output (core/prompts/recording.md) ----

export interface RecordingRelationInput {
  target: string; // "F<id>" or "$n"
  strength: RelationStrength;
}

export interface RecordingFactInput {
  category: FactCategory;
  actor: Actor;
  text: string;
  quote?: string;
  status?: EventStatus;
  source: string[]; // raw addresses, e.g. "T812#user", "T812#t3"
  support?: RecordingRelationInput[];
  negate?: RecordingRelationInput[];
}

function validateRelationList(
  path: string,
  value: unknown,
  problems: string[],
): RecordingRelationInput[] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value)) {
    problems.push(`${path}: expected an array`);
    return [];
  }
  const out: RecordingRelationInput[] = [];
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

export function validateRecordingFact(path: string, raw: unknown, problems: string[]): RecordingFactInput | null {
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
  op: "create" | "update" | "merge" | "archive";
  id?: string;
  absorb?: string[];
  text?: string;
  category?: KnowledgeCategory;
  scope?: KnowledgeScope;
  supports?: string[];
  because: string[];
}
export interface MemoryBatch {
  operations: MemoryOperation[];
  skipped: { fact: string; because: string }[];
}
