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

export const KNOWLEDGE_STATUSES = ["active", "merged", "archived"] as const;
export type KnowledgeStatus = (typeof KNOWLEDGE_STATUSES)[number];

export const KNOWLEDGE_OPS = ["new", "edit", "merge", "archive"] as const;
export type KnowledgeOp = (typeof KNOWLEDGE_OPS)[number];

export const RUN_KINDS = ["recording", "integration"] as const;
export type RunKind = (typeof RUN_KINDS)[number];

export const RUN_OUTCOMES = ["success", "failure", "cancelled"] as const;
export type RunOutcome = (typeof RUN_OUTCOMES)[number];

export const KNOWLEDGE_MARK_KINDS = ["verified", "flagged"] as const;
export type KnowledgeMarkKind = (typeof KNOWLEDGE_MARK_KINDS)[number];

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
  projectId: number | null; // null only for scope=global
  status: KnowledgeStatus;
  author: string;
  currentRevision: number;
}

export interface KnowledgeRevision {
  id: number;
  knowledgeId: number;
  rev: number;
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
  fromRev: number;
  kind: "merged_into" | "split_from";
  toKnowledge: number;
  toRev: number;
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
  rev: number;
  kind: KnowledgeMarkKind;
  createdAt: string;
}

export interface PendingDelivery {
  runId: number;
  sessionId: number;
  branch: string | null;
  deliveredAt: string | null;
}

export interface Watermark {
  sessionId: number;
  branch: string;
  lastRecordedTurn: number | null;
  lastIntegratedFact: number | null;
}

// ---- Shared validation plumbing ----

export interface ValidationResult<T> {
  problems: string[];
  value: T | null;
}

const LOCAL_FACT_HANDLE_RE = /^\$\d+$/; // $n, recording.md
const LOCAL_KNOWLEDGE_HANDLE_RE = /^\$e\d+$/; // $e<n>, integration.md
const FACT_ID_RE = /^F\d+$/;
const KNOWLEDGE_ID_RE = /^K\d+$/;
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
  timestamp: string;
  source: string[]; // raw addresses, e.g. "T812#user", "T812#t3"
  support?: RecordingRelationInput[];
  negate?: RecordingRelationInput[];
}

export interface RecordingTurnBatch {
  turn: string; // "S<session>/T<turn>"
  title: string;
  topic: string;
  facts: RecordingFactInput[];
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

function validateRecordingFact(path: string, raw: unknown, problems: string[]): RecordingFactInput | null {
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
    if (f.category === "event" && !EVENT_PREFIXES.some((p) => (f.text as string).startsWith(p))) {
      problems.push(`${path}.text: an event fact must start with one of ${EVENT_PREFIXES.join("|")}`);
    }
  }
  if (!isNonEmptyString(f.timestamp)) {
    problems.push(`${path}.timestamp: expected a non-empty string`);
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
    timestamp: f.timestamp as string,
    source: (f.source as string[]) ?? [],
    support,
    negate,
  };
}

/** Validate one recording run's full JSON output: an array of per-turn fact batches. */
export function validateRecordingOutput(raw: unknown): ValidationResult<RecordingTurnBatch[]> {
  const problems: string[] = [];
  if (!Array.isArray(raw)) {
    return { problems: ["recording output must be a JSON array"], value: null };
  }
  const batches: RecordingTurnBatch[] = [];
  raw.forEach((item, i) => {
    const path = `[${i}]`;
    if (typeof item !== "object" || item === null) {
      problems.push(`${path}: expected an object`);
      return;
    }
    const obj = item as Record<string, unknown>;
    if (typeof obj.turn !== "string" || !/^S\d+\/T\d+$/.test(obj.turn)) {
      problems.push(`${path}.turn: expected "S<session>/T<turn>", got ${JSON.stringify(obj.turn)}`);
    }
    if (!isNonEmptyString(obj.title)) {
      problems.push(`${path}.title: expected a non-empty string`);
    }
    if (!isNonEmptyString(obj.topic)) {
      problems.push(`${path}.topic: expected a non-empty string`);
    }
    if (!Array.isArray(obj.facts)) {
      problems.push(`${path}.facts: expected an array`);
      return;
    }
    const facts: RecordingFactInput[] = [];
    obj.facts.forEach((f, j) => {
      const fact = validateRecordingFact(`${path}.facts[${j}]`, f, problems);
      if (fact) facts.push(fact);
    });
    batches.push({
      turn: (obj.turn as string) ?? "",
      title: (obj.title as string) ?? "",
      topic: (obj.topic as string) ?? "",
      facts,
    });
  });
  return { problems, value: batches };
}

// ---- Integration output (core/prompts/integration.md) ----

export interface IntegrationNewKnowledgeInput {
  handle: string; // "$e<n>"
  text: string;
  scope: KnowledgeScope;
  category: KnowledgeCategory;
  supports: string[]; // "F<id>"
}

export interface IntegrationEditKnowledgeInput {
  id: string; // "K<id>"
  text: string;
  scope: KnowledgeScope;
  category: KnowledgeCategory;
  supports: string[];
  because: string[];
}

export interface IntegrationMergeKnowledgeInput {
  into: string; // "K<id>"
  absorb: string[]; // "K<id>"[]
  text: string;
  scope: KnowledgeScope;
  category: KnowledgeCategory;
  supports: string[];
  because: string[];
}

export interface IntegrationDeleteKnowledgeInput {
  id: string; // "K<id>"
  because: string[];
}

export interface IntegrationNotAdmittedInput {
  id: string; // "F<id>"
  because: string;
}

export interface IntegrationNearAckInput {
  candidate: string; // "$e<n>" or "K<id>"
  knowledge: string; // "K<id>"
  because: string;
}

export interface IntegrationOutput {
  new: IntegrationNewKnowledgeInput[];
  edit: IntegrationEditKnowledgeInput[];
  merge: IntegrationMergeKnowledgeInput[];
  delete: IntegrationDeleteKnowledgeInput[];
  not_admitted: IntegrationNotAdmittedInput[];
  near_ack: IntegrationNearAckInput[];
  over_budget: boolean;
}

function asArray(path: string, value: unknown, problems: string[]): unknown[] {
  if (value === undefined) return [];
  if (!Array.isArray(value)) {
    problems.push(`${path}: expected an array`);
    return [];
  }
  return value;
}

function checkText(path: string, text: unknown, problems: string[]): void {
  if (!isNonEmptyString(text)) {
    problems.push(`${path}: expected a non-empty string`);
  } else if (EMBEDDED_ID_RE.test(text)) {
    problems.push(`${path}: must not embed a fact or knowledge id`);
  }
}

function checkScope(path: string, v: unknown, problems: string[]): void {
  if (!KNOWLEDGE_SCOPES.includes(v as KnowledgeScope)) {
    problems.push(`${path}: expected one of ${KNOWLEDGE_SCOPES.join("|")}, got ${JSON.stringify(v)}`);
  }
}

function checkCategory(path: string, v: unknown, problems: string[]): void {
  if (!KNOWLEDGE_CATEGORIES.includes(v as KnowledgeCategory)) {
    problems.push(`${path}: expected one of ${KNOWLEDGE_CATEGORIES.join("|")}, got ${JSON.stringify(v)}`);
  }
}

function checkFactIdArray(path: string, v: unknown, problems: string[], nonEmpty = false): string[] {
  if (!isStringArray(v) || !v.every((s) => FACT_ID_RE.test(s))) {
    problems.push(`${path}: expected an array of "F<id>"`);
    return [];
  }
  if (nonEmpty && v.length === 0) {
    problems.push(`${path}: must cite at least one fact`);
  }
  return v;
}

function checkKnowledgeId(path: string, v: unknown, problems: string[]): void {
  if (typeof v !== "string" || !KNOWLEDGE_ID_RE.test(v)) {
    problems.push(`${path}: expected "K<id>", got ${JSON.stringify(v)}`);
  }
}

/** Validate one integration round's full JSON output (either round; shape is identical). */
export function validateIntegrationOutput(raw: unknown): ValidationResult<IntegrationOutput> {
  const problems: string[] = [];
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    return { problems: ["integration output must be a JSON object"], value: null };
  }
  const obj = raw as Record<string, unknown>;

  const newKnowledge: IntegrationNewKnowledgeInput[] = asArray("new", obj.new, problems).map((item, i) => {
    const p = `new[${i}]`;
    const it = (typeof item === "object" && item !== null ? item : {}) as Record<string, unknown>;
    if (typeof it.handle !== "string" || !LOCAL_KNOWLEDGE_HANDLE_RE.test(it.handle)) {
      problems.push(`${p}.handle: expected "$e<n>", got ${JSON.stringify(it.handle)}`);
    }
    checkText(`${p}.text`, it.text, problems);
    checkScope(`${p}.scope`, it.scope, problems);
    checkCategory(`${p}.category`, it.category, problems);
    const supports = checkFactIdArray(`${p}.supports`, it.supports, problems, true);
    return { handle: it.handle as string, text: it.text as string, scope: it.scope as KnowledgeScope, category: it.category as KnowledgeCategory, supports };
  });

  const editKnowledge: IntegrationEditKnowledgeInput[] = asArray("edit", obj.edit, problems).map((item, i) => {
    const p = `edit[${i}]`;
    const it = (typeof item === "object" && item !== null ? item : {}) as Record<string, unknown>;
    checkKnowledgeId(`${p}.id`, it.id, problems);
    checkText(`${p}.text`, it.text, problems);
    checkScope(`${p}.scope`, it.scope, problems);
    checkCategory(`${p}.category`, it.category, problems);
    const supports = checkFactIdArray(`${p}.supports`, it.supports, problems, true);
    const because = checkFactIdArray(`${p}.because`, it.because, problems);
    return { id: it.id as string, text: it.text as string, scope: it.scope as KnowledgeScope, category: it.category as KnowledgeCategory, supports, because };
  });

  const mergeKnowledge: IntegrationMergeKnowledgeInput[] = asArray("merge", obj.merge, problems).map((item, i) => {
    const p = `merge[${i}]`;
    const it = (typeof item === "object" && item !== null ? item : {}) as Record<string, unknown>;
    checkKnowledgeId(`${p}.into`, it.into, problems);
    const absorb = asArray(`${p}.absorb`, it.absorb, problems) as unknown[];
    absorb.forEach((a, k) => checkKnowledgeId(`${p}.absorb[${k}]`, a, problems));
    checkText(`${p}.text`, it.text, problems);
    checkScope(`${p}.scope`, it.scope, problems);
    checkCategory(`${p}.category`, it.category, problems);
    const supports = checkFactIdArray(`${p}.supports`, it.supports, problems, true);
    const because = checkFactIdArray(`${p}.because`, it.because, problems);
    return { into: it.into as string, absorb: absorb as string[], text: it.text as string, scope: it.scope as KnowledgeScope, category: it.category as KnowledgeCategory, supports, because };
  });

  const deleteKnowledge: IntegrationDeleteKnowledgeInput[] = asArray("delete", obj.delete, problems).map((item, i) => {
    const p = `delete[${i}]`;
    const it = (typeof item === "object" && item !== null ? item : {}) as Record<string, unknown>;
    checkKnowledgeId(`${p}.id`, it.id, problems);
    const because = checkFactIdArray(`${p}.because`, it.because, problems);
    return { id: it.id as string, because };
  });

  const notAdmitted: IntegrationNotAdmittedInput[] = asArray("not_admitted", obj.not_admitted, problems).map((item, i) => {
    const p = `not_admitted[${i}]`;
    const it = (typeof item === "object" && item !== null ? item : {}) as Record<string, unknown>;
    if (typeof it.id !== "string" || !FACT_ID_RE.test(it.id)) {
      problems.push(`${p}.id: expected "F<id>", got ${JSON.stringify(it.id)}`);
    }
    if (!isNonEmptyString(it.because)) {
      problems.push(`${p}.because: expected a non-empty string`);
    }
    return { id: it.id as string, because: it.because as string };
  });

  const nearAck: IntegrationNearAckInput[] = asArray("near_ack", obj.near_ack, problems).map((item, i) => {
    const p = `near_ack[${i}]`;
    const it = (typeof item === "object" && item !== null ? item : {}) as Record<string, unknown>;
    if (typeof it.candidate !== "string" || !(LOCAL_KNOWLEDGE_HANDLE_RE.test(it.candidate) || KNOWLEDGE_ID_RE.test(it.candidate))) {
      problems.push(`${p}.candidate: expected "$e<n>" or "K<id>", got ${JSON.stringify(it.candidate)}`);
    }
    checkKnowledgeId(`${p}.knowledge`, it.knowledge, problems);
    if (!isNonEmptyString(it.because)) {
      problems.push(`${p}.because: expected a non-empty string`);
    }
    return { candidate: it.candidate as string, knowledge: it.knowledge as string, because: it.because as string };
  });

  if (obj.over_budget !== undefined && typeof obj.over_budget !== "boolean") {
    problems.push(`over_budget: expected a boolean when present`);
  }

  return {
    problems,
    value: {
      new: newKnowledge,
      edit: editKnowledge,
      merge: mergeKnowledge,
      delete: deleteKnowledge,
      not_admitted: notAdmitted,
      near_ack: nearAck,
      over_budget: obj.over_budget === true,
    },
  };
}
