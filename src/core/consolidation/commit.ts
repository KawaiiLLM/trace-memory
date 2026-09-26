import { isKnowledgeCategory, KNOWLEDGE_SCOPES, type MemoryBatch } from "../model/index.ts";
import type { KnowledgeOperationInput, RunInput, Store, KnowledgePath } from "../store/index.ts";
import { tokens } from "../render/index.ts";
import type { freezeConsolidation } from "./index.ts";

export type ConsolidationDiagnostic =
  | { kind: "unsupported_numbers"; knowledge: string; numbers: string[] }
  | { kind: "over_200_tokens"; knowledge: string; tokens: number };
const numbers = (text: string) => text.match(/\d+(?:,\d{3})*(?:\.\d+)?/g) ?? [];

/** Validate the complete batch before writes, including every merge participant. */
export function prepareMemory(store: Store, sessionId: number, raw: unknown, run: RunInput,
  frozen?: ReturnType<typeof freezeConsolidation>, path: KnowledgePath = store.knowledgePath(sessionId),
  eligibleSupport?: (factId: number) => boolean, skippable?: (commit: number) => string | undefined) {
  const results: string[] = [], operations: KnowledgeOperationInput[] = [];
  const batch = raw as MemoryBatch;
  const projectId = store.getSession(sessionId)!.projectId;
  const touched = new Set<number>();
  const dreaming = store.isDreamingRun(run);
  if (!batch || typeof batch !== "object" || Array.isArray(batch) || !Array.isArray(batch.operations) || !Array.isArray(batch.skipped) || Object.keys(batch).some(k => !["operations", "skipped"].includes(k))) {
    return { results: ["rejected: memory expects {operations: [...], skipped: [...]} only"], operations, batch,
      diagnostics: [] as ConsolidationDiagnostic[], declinedCommits: new Map<MemoryBatch["skipped"][number], number>() };
  }
  const facts = (raw: unknown, errors: string[], nonempty = false): number[] => {
    if (!Array.isArray(raw) || (nonempty && !raw.length)) { errors.push("expected fact array" + (nonempty ? "; supports must not be empty" : "")); return []; }
    return raw.map(address => {
      const id = typeof address === "string" && /^F[1-9]\d*$/.test(address) ? Number(address.slice(1)) : NaN;
      if (!Number.isSafeInteger(id) || !store.getFact(id)) errors.push(`${address}: not an available fact`);
      else if (eligibleSupport && !eligibleSupport(id)) errors.push(`${address}: fact evidence is after the exact triggering source prefix`);
      return id;
    });
  };
  // 21b: labels are strings, trimmed, non-empty, exact duplicates removed, ordered by code point. Case,
  // language and spelling are kept as written: no folding, translation, synonym merge, hierarchy read out
  // of punctuation, or primary-topic meaning attached to the submitted order.
  const labels = (raw: unknown, errors: string[]): string[] => {
    if (!Array.isArray(raw)) { errors.push("topics: expected an array of subject labels"); return []; }
    const out: string[] = [];
    for (const label of raw) {
      if (typeof label !== "string") { errors.push("topics: expected string labels"); continue; }
      if (!label.trim()) { errors.push("topics: a label must not be empty"); continue; }
      out.push(label.trim());
    }
    return [...new Set(out)].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
  };
  batch.operations.forEach((raw, index) => {
    const errors: string[] = [];
    const value = raw && typeof raw === "object" && !Array.isArray(raw) ? raw : {} as MemoryBatch["operations"][number];
    const op = value.op;
    const allowed = dreaming ? ["update", "merge", "split", "archive"]
      : run.kind === "consolidation" ? ["create", "update", "archive"] : ["create", "archive"];
    if (!allowed.includes(op)) errors.push(
      ["update", "merge", "split", "archive"].includes(op)
        ? `${op} belongs to the Dreamer and is not available to ${run.kind === "consolidation" ? "the Consolidator" : "manual memory"}`
        : "invalid op");
    const structural = op === "split";
    const keys = ["op", "reason", "supports", ...(op !== "create" ? ["id"] : []), ...(op === "merge" ? ["absorb"] : []),
      ...(structural ? ["children"] : op !== "archive" ? ["text", "category", "scope", "topics"] : [])];
    // 21a: the commit-level `because` array is gone. Name it rather than report an unknown field, so a
    // model still writing the old shape is told which two fields replace it.
    for (const key of Object.keys(value)) if (key === "because") errors.push('because: removed field; supply "reason" (a string) and "supports" (the commit\'s evidence)');
      else if (!keys.includes(key)) errors.push(key === "absorb" && run.kind === "consolidation"
        ? "absorb belongs to the Dreamer and is not available to the Consolidator" : `${key}: inapplicable field`);
    if (typeof value.reason !== "string" || !value.reason.trim()) errors.push("reason: expected a non-empty commit message");
    const target = (address: unknown) => {
      const match = typeof address === "string" ? /^K([1-9]\d*)#([a-z]{4,})$/.exec(address) : null;
      const id = Number(match?.[1]);
      let base = 0;
      if (!match || !Number.isSafeInteger(id)) errors.push(`${address}: supply an exact K#tag version`);
      else try { base = store.resolveVersionTag(id, match[2]!); }
      catch (error) { errors.push((error as Error).message); }
      // A valid historical tag is not write authority: Store checks effective applicability and
      // the writer's scope again inside the commit transaction.
      const revision = base ? store.getKnowledgeRevision(id, base) : null;
      if (!revision) errors.push(`${address}: knowledge version does not exist`);
      if (touched.has(base)) errors.push(`${address}: duplicate operation target`);
      touched.add(base);
      return { knowledgeId: id, baseCommit: base };
    };
    const dest = op !== "create" ? target(value.id) : undefined;
    const absorb = op === "merge" ? (Array.isArray(value.absorb) && value.absorb.length === 1 ? value.absorb.map(target)
      : (errors.push("merge requires id as the survivor and absorb as exactly one distinct other parent"), [])) : [];
    const children = op === "split" && Array.isArray(value.children) && value.children.length === 2 ? value.children.map((raw, childIndex) => {
      const child = raw && typeof raw === "object" && !Array.isArray(raw) ? raw : {} as NonNullable<typeof value.children>[number];
      if (Object.keys(child).some(key => !["text", "category", "topics"].includes(key))) errors.push(`child ${childIndex + 1}: inapplicable field`);
      if (typeof child.text !== "string" || !child.text.length || /\b[FK]\d+\b/.test(child.text)) errors.push(`child ${childIndex + 1}: expected non-empty text without fact or knowledge ids`);
      if (!isKnowledgeCategory(child.category)) errors.push(`child ${childIndex + 1}: invalid category`);
      return { text: child.text!, category: child.category!, topics: labels(child.topics, errors) };
    }) : op === "split" ? (errors.push("split requires exactly two complete children"), []) : [];
    if (op !== "archive" && op !== "split") {
      if (!(op === "merge" && value.text === undefined)
          && (typeof value.text !== "string" || !value.text.length || /\b[FK]\d+\b/.test(value.text)))
        errors.push("text: expected non-empty text without fact or knowledge ids");
      if (!isKnowledgeCategory(value.category)) errors.push("invalid category");
      if (!KNOWLEDGE_SCOPES.includes(value.scope!)) errors.push("invalid scope");
    }
    const content = { text: value.text!, category: value.category!, scope: value.scope!, supports: facts(value.supports, errors, !dreaming), reason: value.reason!,
      topics: op === "archive" || op === "split" ? [] : labels(value.topics, errors), createdAt: run.createdAt };
    const scope = op === "archive" || op === "split" ? store.getKnowledgeRevision(dest!.knowledgeId, dest!.baseCommit)?.scope : value.scope;
    if (scope && content.supports.every(Number.isSafeInteger)) {
      const bad = store.citationProblem(content.supports, scope, path);
      if (bad) errors.push(bad);
    }
    if (!errors.length) operations.push(op === "create" ? { op: "create", handle: `$e${index + 1}`, author: run.model ?? "manual", ...content }
      : op === "merge" ? { op: "merge", intoKnowledgeId: dest!.knowledgeId, intoBaseCommit: dest!.baseCommit, absorb, ...content }
      : op === "split" ? { op: "split", ...dest!, children, supports: content.supports, reason: content.reason, createdAt: run.createdAt }
      : op === "archive" ? { op: "archive", ...dest!, supports: content.supports, reason: content.reason, createdAt: run.createdAt }
      : { op: "update", ...dest!, ...content });
    results.push(errors.length ? `rejected: ${errors.join("; ")}` : "ok");
  });
  const declined = new Set<number>();
  // Carries each dreaming skip's already-resolved numeric revision to bindMemory, so a later consumer
  // (runDreaming) never has to re-derive it by re-parsing the rendered `K<id>@<commit>` handle.
  const declinedCommits = new Map<MemoryBatch["skipped"][number], number>();
  for (const skipped of batch.skipped) {
    const errors: string[] = [];
    if (!skipped || typeof skipped !== "object" || Array.isArray(skipped)) errors.push("invalid skipped item");
    else if (dreaming) {
      // 59: a Dreamer skip accounts for one supplied handle (a frozen-block version or an own result)
      // without processing it; an unknown or consumed handle is an illegal write like any other.
      const handle = "knowledge" in skipped ? skipped.knowledge : undefined;
      const match = typeof handle === "string" ? /^K([1-9]\d*)@v([1-9]\d*)$/.exec(handle) : null;
      let commit = NaN;
      if (match) try { commit = store.resolveVersionOrdinal(Number(match[1]), Number(match[2])); } catch { /* reported as an unknown supplied handle */ }
      if (Object.keys(skipped).some(k => !["knowledge", "because"].includes(k)) || typeof skipped.because !== "string" || !skipped.because.trim()) errors.push("skipped requires knowledge and non-empty because only");
      const problem = !match || store.knowledgeRevision(commit)?.knowledgeId !== Number(match[1]) ? "not a supplied handle of this run"
        : touched.has(commit) ? "already consumed by an operation of this batch" : skippable ? skippable(commit) : "not a supplied handle of this run";
      if (problem) errors.push(`${handle}: ${problem}`);
      else if (declined.has(commit)) errors.push("duplicate skipped knowledge");
      declined.add(commit);
      declinedCommits.set(skipped, commit);
    } else {
      const ids = facts(["fact" in skipped ? skipped.fact : undefined], errors);
      if (Object.keys(skipped).some(k => !["fact", "because"].includes(k)) || typeof skipped.because !== "string" || !skipped.because.trim()) errors.push("skipped requires fact and non-empty because only");
      if (!frozen?.rangeFacts.some(f => f.id === ids[0])) errors.push("skipped fact must belong to this run's range");
      if (declined.has(ids[0]!)) errors.push("duplicate skipped fact");
      declined.add(ids[0]!);
    }
    results.push(errors.length ? `rejected: ${errors.join("; ")}` : "ok");
  }
  const diagnostics: ConsolidationDiagnostic[] = [];
  for (const op of operations) {
    if (op.op === "archive") continue;
    const label = op.op === "create" ? op.handle : `K${op.op === "merge" ? op.intoKnowledgeId : op.knowledgeId}`;
    const grounding = new Set(op.supports);
    const cited = new Set([...grounding].flatMap(id => numbers(`${store.getFact(id)!.text}\n${store.getFact(id)!.quote ?? ""}`)));
    // A shorthand merge copies an existing body in the transaction; it submits no new text to audit.
    const bodies = op.op === "split" ? op.children.map((child, index) => ({ label: `${label}/child${index + 1}`, text: child.text }))
      : op.text === undefined ? [] : [{ label, text: op.text }];
    for (const body of bodies) {
      const unsupported = [...new Set(numbers(body.text))].filter(n => !cited.has(n));
      if (unsupported.length) diagnostics.push({ kind: "unsupported_numbers", knowledge: body.label, numbers: unsupported });
      if (tokens(body.text) > 200) diagnostics.push({ kind: "over_200_tokens", knowledge: body.label, tokens: tokens(body.text) });
    }
  }
  return { results, operations, batch, diagnostics, declinedCommits };
}
