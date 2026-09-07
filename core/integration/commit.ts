import { KNOWLEDGE_CATEGORIES, KNOWLEDGE_SCOPES, type MemoryBatch } from "../model/index.ts";
import type { KnowledgeOperationInput, RunInput, Store } from "../store/index.ts";
import { tokens } from "../render/index.ts";
import type { freezeIntegration, NearPair } from "./index.ts";

export type IntegrationDiagnostic =
  | { kind: "unsupported_numbers"; knowledge: string; numbers: string[] }
  | { kind: "over_200_tokens"; knowledge: string; tokens: number }
  | { kind: "unanswered_near"; pairs: NearPair[] }
  | { kind: "uncited_facts" | "lost_citations"; facts: string[] };
const numbers = (text: string) => text.match(/\d+(?:,\d{3})*(?:\.\d+)?/g) ?? [];

/** Validate the complete batch before writes, including every merge participant. */
export function prepareMemory(store: Store, sessionId: number, raw: unknown, run: RunInput,
  frozen?: ReturnType<typeof freezeIntegration>) {
  const results: string[] = [], operations: KnowledgeOperationInput[] = [];
  const batch = raw as MemoryBatch;
  const projectId = store.getSession(sessionId)!.projectId;
  const knowledge = frozen?.knowledge ?? store.listVisibleKnowledge(sessionId, projectId);
  const evidence = new Map((frozen?.facts ?? store.listProjectFacts(projectId)).map(f => [f.id, f]));
  const touched = new Set<number>();
  if (!batch || typeof batch !== "object" || Array.isArray(batch) || !Array.isArray(batch.operations) || !Array.isArray(batch.skipped) || Object.keys(batch).some(k => !["operations", "skipped"].includes(k))) {
    return { results: ["rejected: memory expects {operations: [...], skipped: [...]} only"], operations, batch, diagnostics: [] as IntegrationDiagnostic[] };
  }
  const facts = (raw: unknown, errors: string[], nonempty = false): number[] => {
    if (!Array.isArray(raw) || (nonempty && !raw.length)) { errors.push("expected fact array" + (nonempty ? "; supports must not be empty" : "")); return []; }
    return raw.map(address => {
      const id = typeof address === "string" && /^F[1-9]\d*$/.test(address) ? Number(address.slice(1)) : NaN;
      if (!Number.isSafeInteger(id) || !evidence.has(id)) errors.push(`${address}: not an available fact of this project (range or earlier)`);
      return id;
    });
  };
  batch.operations.forEach((raw, index) => {
    const errors: string[] = [];
    const value = raw && typeof raw === "object" && !Array.isArray(raw) ? raw : {} as MemoryBatch["operations"][number];
    const op = value.op;
    if (!["create", "update", "merge", "archive"].includes(op)) errors.push("invalid op");
    const keys = ["op", "because", ...(op !== "create" ? ["id"] : []), ...(op === "merge" ? ["absorb"] : []), ...(op !== "archive" ? ["text", "category", "scope", "supports"] : [])];
    for (const key of Object.keys(value)) if (!keys.includes(key)) errors.push(`${key}: inapplicable field`);
    const because = facts(value.because, errors);
    const target = (address: unknown) => {
      const id = typeof address === "string" && /^K[1-9]\d*$/.test(address) ? Number(address.slice(1)) : NaN;
      const read = knowledge.find(k => k.knowledge.id === id), current = Number.isSafeInteger(id) ? store.getKnowledge(id) : null;
      if (!Number.isSafeInteger(id) || !read) errors.push(`${address}: knowledge was not read as visible and active`);
      else if (!current || current.status !== "active" || current.currentRevision !== read.revision.rev) errors.push(`${address}: expected revision ${read.revision.rev}, current revision is ${current?.currentRevision}; target moved on or is inactive`);
      if (touched.has(id)) errors.push(`${address}: duplicate operation target`);
      touched.add(id);
      return { knowledgeId: id, expectedRevision: read?.revision.rev ?? 0 };
    };
    const dest = op !== "create" ? target(value.id) : undefined;
    const absorb = op === "merge" ? (Array.isArray(value.absorb) && value.absorb.length ? value.absorb.map(target) : (errors.push("merge must absorb at least one knowledge item"), [])) : [];
    if (op !== "archive") {
      if (typeof value.text !== "string" || !value.text.length || /\b[FK]\d+\b/.test(value.text)) errors.push("text: expected non-empty text without fact or knowledge ids");
      if (!KNOWLEDGE_CATEGORIES.includes(value.category!)) errors.push("invalid category");
      if (!KNOWLEDGE_SCOPES.includes(value.scope!)) errors.push("invalid scope");
    }
    const content = { text: value.text!, category: value.category!, scope: value.scope!, supports: op === "archive" ? [] : facts(value.supports, errors, true), because, createdAt: run.createdAt };
    if (!errors.length) operations.push(op === "create" ? { op: "create", handle: `$e${index + 1}`, author: run.model ?? "manual", ...content }
      : op === "merge" ? { op: "merge", intoKnowledgeId: dest!.knowledgeId, intoExpectedRevision: dest!.expectedRevision, absorb, ...content }
      : op === "archive" ? { op: "archive", ...dest!, because, createdAt: run.createdAt } : { op: "update", ...dest!, ...content });
    results.push(errors.length ? `rejected: ${errors.join("; ")}` : "ok");
  });
  const declined = new Set<number>();
  for (const skipped of batch.skipped) {
    const errors: string[] = [];
    if (!skipped || typeof skipped !== "object" || Array.isArray(skipped)) errors.push("invalid skipped item");
    else {
      const ids = facts([skipped.fact], errors);
      if (Object.keys(skipped).some(k => !["fact", "because"].includes(k)) || typeof skipped.because !== "string" || !skipped.because.trim()) errors.push("skipped requires fact and non-empty because only");
      if (!frozen?.rangeFacts.some(f => f.id === ids[0])) errors.push("skipped fact must belong to this run's range");
      if (declined.has(ids[0]!)) errors.push("duplicate skipped fact");
      declined.add(ids[0]!);
    }
    results.push(errors.length ? `rejected: ${errors.join("; ")}` : "ok");
  }
  const diagnostics: IntegrationDiagnostic[] = [];
  for (const op of operations) {
    if (op.op === "archive") continue;
    const label = op.op === "create" ? op.handle : `K${op.op === "merge" ? op.intoKnowledgeId : op.knowledgeId}`;
    const cited = new Set(op.supports.flatMap(id => numbers(`${evidence.get(id)!.text}\n${evidence.get(id)!.quote ?? ""}`)));
    const unsupported = [...new Set(numbers(op.text))].filter(n => !cited.has(n));
    if (unsupported.length) diagnostics.push({ kind: "unsupported_numbers", knowledge: label, numbers: unsupported });
    if (tokens(op.text) > 200) diagnostics.push({ kind: "over_200_tokens", knowledge: label, tokens: tokens(op.text) });
  }
  return { results, operations, batch, diagnostics };
}

/** Called after application inside the same immediate transaction. */
export function accounting(store: Store, sessionId: number, batch: MemoryBatch, range: { id: number; actor: string; category: string }[]): IntegrationDiagnostic[] {
  const projectId = store.getSession(sessionId)!.projectId;
  const cited = new Set(store.listVisibleKnowledge(sessionId, projectId).flatMap(k => k.revision.supports));
  const skipped = new Set(batch.skipped.map(s => s.fact));
  const uncited = range.filter(f => (f.actor === "user" || f.category === "question") && !cited.has(f.id) && !skipped.has(`F${f.id}`));
  return uncited.length ? [{ kind: "uncited_facts", facts: uncited.map(f => `F${f.id}`) }] : [];
}
