import { words, renderKnowledge, knowledgeStaleLabel } from "../render/index.ts";
import { parseBlocks, plan, list, traceProblem, type WorkspaceFile } from "../workspace/index.ts";
import type { CurateItem, KnowledgePath, Store, KnowledgeOperationInput } from "../store/index.ts";
import { allowedRoots, resolveRepositoryPath, repositoryEvidenceProblem } from "./roots.ts";
export type { CurateItem } from "../store/index.ts";

export function formGroups(items: readonly CurateItem[], size = 50): CurateItem[][] {
  const groups: CurateItem[][] = [];
  for (let at = 0; at < items.length; at += size) groups.push(items.slice(at, at + size));
  return groups;
}
export function groupText(store: Store, items: readonly CurateItem[], clusters?: readonly { label: string; items: number[] }[]): string {
  const labels = new Map(clusters?.flatMap(cluster => cluster.items.length ? [[cluster.items[0]!, cluster.label] as const] : []));
  const contents = items.map(item => `${labels.has(item.value.knowledge.id) ? `\n## Cluster ${labels.get(item.value.knowledge.id)}\n\n` : ""}- ${item.address}: ${item.value.revision.title ?? "(no title)"}${knowledgeStaleLabel({ staleReasons: store.knowledgeStaleReasons(item.value.revision.id) })}`).join("\n");
  const bodies = items.map(item => {
    const current = item.value.revision;
    const history = store.listKnowledgeRevisions(current.knowledgeId);
    return `# ${item.address}${knowledgeStaleLabel({ staleReasons: store.knowledgeStaleReasons(current.id) })}\n\n` + history.map(r => {
      const facts = r.supports.map(id => { const fact = store.getFact(id)!; return `- F${id}: ${fact.title ?? "(untitled)"}\n${fact.text}`; }).join("\n");
      const files = r.files === undefined ? "(not mapped)" : r.files === null ? "None" : r.files.join(", ");
      return `${renderKnowledge({ knowledge: item.value.knowledge, revision: r, staleReasons: store.knowledgeStaleReasons(r.id) }, `K${r.knowledgeId}@v${store.versionOrdinal(r.knowledgeId, r.id)}`)}\nfiles: ${files}\nverification: ${JSON.stringify(store.knowledgeFileVerifications(r.id))}\nflags: ${JSON.stringify(store.knowledgeStaleReasons(r.id))}\nreason: ${r.reason}\n\nFacts:\n${facts || "None"}`;
    }).join("\n\n");
  });
  return `# Contents\n\n${contents}\n\n${bodies.join("\n\n")}\n`;
}
export const decisionsTemplate = (items: readonly CurateItem[]) => items.map(item => `## item ${item.address}\ntitle: ${item.value.revision.title ?? ""}\naccuracy: \ngrounds: \nnorms: \nevidence: \nfiles: \ndecision: \nreason: \n`).join("\n");
export interface Decision { item: CurateItem; title: string; files: string[] | null; decision: string; reason: string; missingGrounds: boolean }
export interface Curated { problems: string[]; decisions: Decision[]; operations: KnowledgeOperationInput[]; lengths: string[] }
/** The caller supplies membership: incremental selection and full-check clustering use this same boundary. */
export function checkCurate(store: Store, path: KnowledgePath, items: readonly CurateItem[], decisionsFile: WorkspaceFile, changesFile: WorkspaceFile): Curated {
  const parsed = parseBlocks(decisionsFile), checked = plan(store, { kind: "curate", sessionId: path.sessionId, path, file: changesFile });
  const problems = [...parsed.problems, ...checked.problems], roots = allowedRoots(store, path.sessionId);
  const wanted = new Map(items.map(item => [item.address, item])), seen = new Set<string>();
  const decisions: Decision[] = [];
  for (const block of parsed.blocks) {
    const item = wanted.get(block.target), label = `decisions.md:${block.line}`;
    if (block.op !== "item" || !item) { problems.push(`${label}: expected an item of this group`); continue; }
    if (seen.has(block.target)) problems.push(`${label}: duplicate item ${block.target}`);
    seen.add(block.target);
    const fields = block.fields;
    const keys = ["title", "accuracy", "grounds", "norms", "evidence", "files", "decision", "reason"];
    for (const key of keys) if (!fields.get(key)?.value.trim()) problems.push(`${label}: fill ${key}`);
    for (const key of fields.keys()) if (!keys.includes(key)) problems.push(`${label}: unknown key ${key}`);
    if (block.body || block.children.length) problems.push(`${label}: item takes only its checklist keys`);
    const value = (key: string) => fields.get(key)?.value ?? "";
    if (!/^(?:ok|unverified|outdated:\s*\S.*|wrong:\s*\S.*)$/.test(value("accuracy"))) problems.push(`${label}: accuracy must be ok, unverified, outdated: <why> or wrong: <why>`);
    if (words(value("title")) > Math.ceil(store.writing.titleWords * 1.1)) problems.push(`${label}: title exceeds target ${store.writing.titleWords}`);
    const files: string[] | null = value("files") === "None" ? null : list(value("files")).flatMap(file => {
      const resolved = resolveRepositoryPath(file, roots);
      if ("reason" in resolved) { problems.push(`${label}: files: ${resolved.reason}`); return []; }
      return [resolved.path];
    });
    if (files && new Set(files).size !== files.length) problems.push(`${label}: duplicate linked file`);
    const decision = value("decision");
    if (!/^(?:keep|update|archive|merge|split|merged into K[1-9]\d*)$/.test(decision)) problems.push(`${label}: unknown decision ${decision}`);
    for (const evidence of list(value("evidence"))) {
      if (evidence === "None") continue;
      const problem = evidence.startsWith("trace://") ? traceProblem(store, evidence) : repositoryEvidenceProblem(evidence, roots);
      if (problem) problems.push(`${label}: evidence ${evidence}: ${problem}`);
    }
    decisions.push({ item, title: value("title"), files, decision, reason: value("reason"), missingGrounds: /^(?:None|missing|unverified)(?:\b|$)/i.test(value("grounds")) });
  }
  for (const address of wanted.keys()) if (!seen.has(address)) problems.push(`decisions.md: missing ${address}`);
  const byId = new Map(decisions.map(decision => [decision.item.value.knowledge.id, decision]));
  const operations: KnowledgeOperationInput[] = [];
  const consumed = new Map<number, string>();
  const mark = (id: number, operation: string) => {
    if (consumed.has(id)) problems.push(`changes.md: K${id} has more than one operation`);
    consumed.set(id, operation);
  };
  for (const entry of checked.knowledge) {
    const op = entry.make().operation;
    if (!op || op.op === "create") continue;
    const id = op.op === "merge" ? op.intoKnowledgeId : op.knowledgeId, decision = byId.get(id);
    if (!decision) { problems.push(`changes.md: ${entry.block.target} is outside this group`); continue; }
    mark(id, op.op);
    if (decision.decision !== op.op) problems.push(`changes.md: K${id} disagrees with decision ${decision.decision}`);
    if (op.op !== "archive" && (op.title ?? decision.item.value.revision.title) !== decision.title) problems.push(`changes.md: K${id} title disagrees with decisions.md`);
    op.files = decision.files;
    if (op.op === "merge") for (const absorbed of op.absorb) {
      mark(absorbed.knowledgeId, `merged into K${id}`);
      if (!byId.has(absorbed.knowledgeId)) problems.push(`changes.md: merge cannot absorb K${absorbed.knowledgeId} outside this group`);
    }
    // 「拆分时必须填每个分支分到的事实」: the primary part names its facts too, or it would inherit every parent fact.
    if (op.op === "split" && !entry.block.fields.has("supports")) problems.push(`changes.md: K${id} split requires explicit supports for its primary part`);
    if (op.op === "split") entry.block.children.forEach((child, index) => {
      const raw = child.fields.get("files")?.value;
      if (!raw) { problems.push(`changes.md: K${id} child ${index + 1} requires files`); return; }
      op.children[index]!.files = raw === "None" ? null : list(raw).flatMap(file => {
        const resolved = resolveRepositoryPath(file, roots);
        if ("reason" in resolved) { problems.push(`changes.md: child files: ${resolved.reason}`); return []; }
        return [resolved.path];
      });
      if (!child.fields.has("supports")) problems.push(`changes.md: K${id} child ${index + 1} requires explicit supports`);
    });
    operations.push(op);
  }
  for (const decision of decisions) {
    const r = decision.item.value.revision, id = r.knowledgeId;
    if (decision.decision !== "keep") {
      if (consumed.get(id) !== decision.decision) problems.push(`decisions.md: K${id} has no matching ${decision.decision} change`);
      continue;
    }
    if (consumed.has(id)) problems.push(`decisions.md: kept K${id} also has a change`);
    if (decision.title !== r.title || JSON.stringify(decision.files) !== JSON.stringify(r.files)) operations.push({ op: "update", knowledgeId: id, baseCommit: r.id,
      title: decision.title, text: r.text, category: r.category, scope: r.scope, topics: r.topics, supports: r.supports,
      files: decision.files, reason: decision.reason, createdAt: new Date().toISOString() });
  }
  return { problems, decisions, operations, lengths: checked.lengths.map(length => `${length.block}: ${length.field} ${length.count}/${length.target} (limit ${length.limit})`) };
}
