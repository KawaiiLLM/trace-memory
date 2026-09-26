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

export const KNOWLEDGE_CATEGORIES = ["constraint", "understanding", "goal", "open", "reference"] as const;
export type KnowledgeCategory = (typeof KNOWLEDGE_CATEGORIES)[number] | "mechanism" | "term" | "dispute";
export const isKnowledgeCategory = (category: unknown): category is (typeof KNOWLEDGE_CATEGORIES)[number] =>
  typeof category === "string" && (KNOWLEDGE_CATEGORIES as readonly string[]).includes(category);
export const knowledgeCategoryGroup = (category: KnowledgeCategory): (typeof KNOWLEDGE_CATEGORIES)[number] =>
  category === "mechanism" || category === "term" ? "understanding" : category === "dispute" ? "open" : category;

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
  directory: string | null; // 62: the repository root or cwd the session started in; NULL when excluded or pre-62
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
  category: FactCategory | null;
  actor: Actor | null;
  text: string;
  quote: string | null;
  /** One derived attribution per cited entry, in source order. Legacy rows omit this. */
  roles?: { role: "user" | "assistant" | "observation"; harness?: "Pi agent" | "Claude Code" }[];
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
  actorRole?: "noting" | "consolidation" | "dreaming" | "manual" | null;
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

// New origins have one id; stored historical arrays remain intact for retry and audit.
export interface TriggerOrigin { readonly sessionId: number; readonly entryIds: readonly number[] }

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
  /** Frozen native triggering entry. Historical origin arrays remain intact; their last id is the trigger. */
  origin: TriggerOrigin | null;
  outcome: RunOutcome;
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
  text: string;
  source: string[]; // each address names one whole entry, e.g. "T812#E2"
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

  if (!isNonEmptyString(f.text)) {
    problems.push(`${path}.text: expected a non-empty string`);
  } else {
    // Essential verbatim snippets moved from the retired quote field into 「…」.
    // Their literal identifiers are evidence text, never structured references.
    if (EMBEDDED_ID_RE.test(f.text.replace(/「[^」]*」/gu, ""))) {
      problems.push(`${path}.text: must not embed a fact or knowledge id; ids live in structured relation/support fields`);
    }
  }
  for (const key of Object.keys(f)) {
    if (!["text", "source", "support", "negate"].includes(key)) problems.push(`${path}.${key}: unexpected field`);
  }
  if (!isStringArray(f.source) || f.source.length === 0) {
    problems.push(`${path}.source: expected a non-empty array of address strings`);
  }
  const support = validateRelationList(`${path}.support`, f.support, problems);
  const negate = validateRelationList(`${path}.negate`, f.negate, problems);

  return {
    text: f.text as string,
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
  /** The Consolidator skips a range fact; the Dreamer skips a supplied knowledge handle (59). */
  skipped: (({ fact: string } | { knowledge: string }) & { because: string })[];
}
