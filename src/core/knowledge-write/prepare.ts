import { isKnowledgeCategory, substantiveArchiveStatement, KNOWLEDGE_SCOPES, type MemoryBatch } from "../model/index.ts";
import { type KnowledgeOperationInput, type RunInput, type Store, type KnowledgePath } from "../store/index.ts";
import { tokens } from "../render/index.ts";
import { canonicalToolNames, type ToolNames } from "../prompts/tool-names.ts";

export type ConsolidationDiagnostic = { kind: "unsupported_numbers"; knowledge: string; numbers: string[] };

/** A field over its cap, as the refusal states it: the field, its count and the limit (ticket 144). */
export const overLimit = (field: string, count: number, limit: number): string =>
  `${field}: ${count} tokens, over the ${limit}-token limit`;
const numbers = (text: string) => text.match(/\d+(?:,\d{3})*(?:\.\d+)?/g) ?? [];

/** Validate the complete batch before writes, including every merge participant. */
export function prepareMemory(store: Store, sessionId: number, raw: unknown, run: RunInput,
  path: KnowledgePath = store.knowledgePath(sessionId),
  eligibleSupport?: (factId: number) => boolean, skippable?: (commit: number) => string | undefined,
  localFacts?: ReadonlyMap<number, { text: string; quote?: string | null }>, names: ToolNames = canonicalToolNames,
  /** A workspace update may leave supports empty: the Store then inherits the parents' (ticket 144). */
  emptySupports = false) {
  const results: string[] = [], operations: KnowledgeOperationInput[] = [];
  const batch = raw as MemoryBatch;
  const projectId = store.getSession(sessionId)!.projectId;
  const touched = new Set<number>();
  const dreaming = store.isDreamingRun(run);
  const limits = store.writing;
  if (run.kind !== "noting" && batch && typeof batch === "object" && "drop" in batch)
    return { results: ["rejected: drop is N-only; this role uses immediate memory writes"], operations, batch,
      diagnostics: [] as ConsolidationDiagnostic[], declinedCommits: new Map<MemoryBatch["skipped"][number], number>() };
  if (!batch || typeof batch !== "object" || Array.isArray(batch) || !Array.isArray(batch.operations) || !Array.isArray(batch.skipped) || Object.keys(batch).some(k => !["operations", "skipped"].includes(k))) {
    return { results: [`rejected: ${names.memory} expects {operations: [...], skipped: [...]} only`], operations, batch,
      diagnostics: [] as ConsolidationDiagnostic[], declinedCommits: new Map<MemoryBatch["skipped"][number], number>() };
  }
  const facts = (raw: unknown, errors: string[], nonempty = false): number[] => {
    if (!Array.isArray(raw) || (nonempty && !raw.length)) { errors.push("expected fact array" + (nonempty ? "; supports must not be empty" : "")); return []; }
    return raw.map(address => {
      const id = typeof address === "string" && /^F[1-9]\d*$/.test(address) ? Number(address.slice(1))
        : localFacts && typeof address === "string" && /^\$[1-9]\d*$/.test(address) ? -Number(address.slice(1)) : NaN;
      if (!localFacts && typeof address === "string" && address.startsWith("$")) errors.push(`${address}: local knowledge supports are N-only; cite an existing F fact`);
      if (!Number.isSafeInteger(id) || !(id < 0 ? localFacts?.has(-id) : store.getFact(id))) errors.push(`${address}: not an available fact`);
      else if (id > 0 && eligibleSupport && !eligibleSupport(id)) errors.push(`${address}: fact evidence is after the exact triggering source prefix`);
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
      : ["create", "update", "archive"];
    if (!allowed.includes(op)) errors.push(
      ["update", "merge", "split", "archive"].includes(op)
        ? `${op} belongs to the Dreamer and is not available to ${run.kind === "noting" ? "the Noter" : "manual memory"}`
        : "invalid op");
    const keys = ["op", "reason", "supports", ...(op !== "create" ? ["id"] : []), ...(op === "merge" ? ["absorb"] : []), ...(op === "split" ? ["children"] : []),
      ...(op === "archive" ? ["kind", ...(value.kind === "invalid" ? ["text"] : [])]
        : ["title", "text", ...(op === "update" || op === "split" ? ["edits"] : []), "category", "scope", "topics"])];
    // 21a: the commit-level `because` array is gone. Name it rather than report an unknown field, so a
    // model still writing the old shape is told which two fields replace it.
    for (const key of Object.keys(value)) if (key === "because") errors.push('because: removed field; supply "reason" (a string) and "supports" (the commit\'s evidence)');
      else if (key === "slot") errors.push("slot is N-only; this role uses immediate memory writes");
      else if (!keys.includes(key)) errors.push(`${key}: inapplicable field`);
    if (typeof value.reason !== "string" || !value.reason.trim()) errors.push("reason: expected a non-empty commit message");
    // A title is one nonempty line within its cap. `prefix` names a split child.
    const checkTitle = (title: unknown, prefix = "") => {
      const field = prefix ? `${prefix}: title` : "title";
      if (typeof title !== "string" || !title.trim() || /[\r\n\u2028\u2029]/.test(title)) errors.push(`${field}: expected a nonempty single-line string`);
      else if (tokens(title) > limits.titleTokens) errors.push(overLimit(field, tokens(title), limits.titleTokens));
    };
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
    const absorb = op === "merge" ? (Array.isArray(value.absorb) && value.absorb.length ? value.absorb.map(target)
      : (errors.push("merge requires id as the primary and absorb as one or more distinct other parents"), [])) : [];
    const children = op === "split" && Array.isArray(value.children) && value.children.length ? value.children.map((raw, childIndex) => {
      const child = raw && typeof raw === "object" && !Array.isArray(raw) ? raw : {} as NonNullable<typeof value.children>[number];
      const name = `child ${childIndex + 1}`;
      if (Object.keys(child).some(key => !["title", "text", "category", "topics"].includes(key))) errors.push(`${name}: inapplicable field`);
      if (typeof child.text !== "string" || !child.text.length) errors.push(`${name}: expected non-empty text`);
      else if (tokens(child.text) > limits.bodyTokens) errors.push(`${name}: ${overLimit("text", tokens(child.text), limits.bodyTokens)}`);
      checkTitle(child.title, name);
      if (!isKnowledgeCategory(child.category)) errors.push(`${name}: invalid category`);
      return { title: child.title!, text: child.text!, category: child.category!, topics: labels(child.topics, errors) };
    }) : op === "split" ? (errors.push("split requires its primary part and one or more complete children"), []) : [];
    if (op === "archive") {
      if (value.kind !== "budget" && value.kind !== "invalid") errors.push("archive kind must be budget or invalid");
      if (value.kind === "invalid" && !substantiveArchiveStatement(value.text))
        errors.push("invalid archive requires a substantive statement of grounds and evidence");
    }
    const editing = (op === "update" || op === "split") && "edits" in value;
    const base = editing && dest ? store.getKnowledgeRevision(dest.knowledgeId, dest.baseCommit) : null;
    let text = value.text;
    if ((op === "update" || op === "split") && ("text" in value) === editing) errors.push(`${op} requires exactly one of text or edits`);
    if (editing) {
      if (!Array.isArray(value.edits) || !value.edits.length) errors.push("edits: expected a non-empty array of {old, new}");
      else {
        if (base) text = base.text;
        for (const [editIndex, edit] of value.edits.entries()) {
          const position = `edit ${editIndex + 1}`;
          if (!edit || typeof edit !== "object" || Array.isArray(edit) ||
              Object.keys(edit).some(key => key !== "old" && key !== "new") ||
              typeof edit.old !== "string" || !edit.old.length || typeof edit.new !== "string") {
            errors.push(`${position}: expected {old, new} strings with non-empty old`); break;
          }
          if (!base || "text" in value) continue;
          const first = text!.indexOf(edit.old);
          if (first === -1) { errors.push(`${position}: old matched nothing (0 occurrences)`); break; }
          if (text!.indexOf(edit.old, first + 1) !== -1) { errors.push(`${position}: old matched several places (multiple occurrences)`); break; }
          text = text!.slice(0, first) + edit.new + text!.slice(first + edit.old.length);
        }
      }
    }
    const inheritedCategory = editing && !("category" in value) && base !== null;
    const category = inheritedCategory ? base.category : value.category;
    const contentScope = editing && !("scope" in value) ? base?.scope : value.scope;
    const topics = op === "archive" ? []
      : editing && !("topics" in value) && base ? base.topics : labels(value.topics, errors);
    if (op !== "archive") {
      if (!(op === "merge" && text === undefined)
          && (typeof text !== "string" || !text.length))
        errors.push("text: expected non-empty text");
      if (!inheritedCategory && !isKnowledgeCategory(category)) errors.push("invalid category");
      if (!KNOWLEDGE_SCOPES.includes(contentScope!)) errors.push("invalid scope");
    }
    // Ticket 144: a new live version ends with a title, given or inherited from its base; a legacy base
    // has none to give. A merge or a split continues the named item, whose title it inherits. Split children carry their own, checked above.
    let title = value.title;
    if (op === "create" || op === "update" || op === "merge" || op === "split") {
      const baseTitle = op === "create" || !dest ? undefined : store.getKnowledgeRevision(dest.knowledgeId, dest.baseCommit)?.title;
      if (title === undefined && baseTitle === null) errors.push("title: the base version has no title; supply one");
      title ??= baseTitle ?? undefined;
      if (title !== undefined || op === "create") checkTitle(title);
    }
    // Caps apply to the body as written: an edited update's result, and a merge that omits text, which copies the later parent's.
    const body = op === "merge" && text === undefined && dest && absorb.length
      ? store.knowledgeRevision(Math.max(dest.baseCommit, ...absorb.map(parent => parent.baseCommit)))?.text
      : op === "archive" ? (value.kind === "invalid" ? value.text : undefined) : text;
    if (typeof body === "string" && tokens(body) > limits.bodyTokens) errors.push(overLimit("text", tokens(body), limits.bodyTokens));
    const content = { title: title!, text: text!, category: category!, scope: contentScope!, supports: facts(value.supports, errors, !dreaming && !emptySupports), reason: value.reason!,
      topics, createdAt: run.createdAt };
    const scope = op === "archive" ? store.getKnowledgeRevision(dest!.knowledgeId, dest!.baseCommit)?.scope : contentScope;
    if (scope && content.supports.every(Number.isSafeInteger)) {
      const bad = store.citationProblem(content.supports.filter(id => id > 0), scope, path);
      if (bad) errors.push(bad);
    }
    if (!errors.length) operations.push(op === "create" ? { op: "create", handle: `$e${index + 1}`, author: run.model ?? "manual", ...content }
      : op === "merge" ? { op: "merge", intoKnowledgeId: dest!.knowledgeId, intoBaseCommit: dest!.baseCommit, absorb, ...content }
      : op === "split" ? { op: "split", ...dest!, ...content, children }
      : op === "archive" ? { op: "archive", ...dest!, kind: value.kind!, ...(value.kind === "invalid" ? { text: value.text } : {}), supports: content.supports, reason: content.reason, createdAt: run.createdAt }
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
      if (Object.keys(skipped).some(k => !["knowledge", "because"].includes(k)) || typeof skipped.because !== "string" || !skipped.because.trim()) errors.push("skip requires a non-empty because and no other field");
      const problem = !match || store.knowledgeRevision(commit)?.knowledgeId !== Number(match[1]) ? "not a supplied handle of this run"
        : touched.has(commit) ? "already consumed by an operation of this batch" : skippable ? skippable(commit) : "not a supplied handle of this run";
      if (problem) errors.push(`${handle}: ${problem}`);
      else if (declined.has(commit)) errors.push("duplicate skipped knowledge");
      declined.add(commit);
      declinedCommits.set(skipped, commit);
    } else {
      errors.push("skipped must be empty outside Dreamer maintenance");
    }
    results.push(errors.length ? `rejected: ${errors.join("; ")}` : "ok");
  }
  const diagnostics: ConsolidationDiagnostic[] = [];
  for (const op of operations) {
    if (op.op === "archive" && op.kind === "budget") continue;
    const label = op.op === "create" ? op.handle : `K${op.op === "merge" ? op.intoKnowledgeId : op.knowledgeId}`;
    const grounding = new Set(op.supports);
    const cited = new Set([...grounding].flatMap(id => {
      const fact = id < 0 ? localFacts!.get(-id)! : store.getFact(id)!;
      return numbers(`${fact.text}\n${fact.quote ?? ""}`);
    }));
    // A shorthand merge copies an existing body in the transaction; it submits no new text to audit.
    const bodies = op.op === "split" ? [{ label, text: op.text }, ...op.children.map((child, index) => ({ label: `${label}/child${index + 1}`, text: child.text }))]
      : op.text === undefined ? [] : [{ label, text: op.text }];
    for (const body of bodies) {
      const unsupported = [...new Set(numbers(body.text))].filter(n => !cited.has(n));
      if (unsupported.length) diagnostics.push({ kind: "unsupported_numbers", knowledge: body.label, numbers: unsupported });
    }
  }
  return { results, operations, batch, diagnostics, declinedCommits };
}
