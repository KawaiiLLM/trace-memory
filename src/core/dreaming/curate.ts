import { words, renderKnowledge, knowledgeStaleLabel } from "../render/index.ts";
import { parseBlocks, plan, list, traceProblem, type WorkspaceFile } from "../workspace/index.ts";
import type { CurateItem, KnowledgePath, Store, KnowledgeOperationInput } from "../store/index.ts";
import { allowedRoots, repositoryEvidenceProblem } from "./roots.ts";
import { codeAddress, resolveCodeLink } from "./code-links.ts";
import type { Cluster } from "./clustering.ts";
export type { CurateItem } from "../store/index.ts";

export function groupText(store: Store, items: readonly CurateItem[], clusters?: readonly Cluster[], references: readonly { id: number; title: string }[] = []): string {
  const ids = new Set(items.map(item => item.value.knowledge.id));
  const titles = new Map(references.map(item => [item.id, item.title]));
  const contents = clusters ? clusters.map(cluster => `## Cluster ${cluster.label}\n\n` +
    cluster.items.filter(id => ids.has(id)).map(id => {
      const item = items.find(item => item.value.knowledge.id === id)!, mark = cluster.marks?.[id];
      return `- ${item.address}: ${item.value.revision.title ?? "(no title)"}${mark ? ` ! ${mark.kind}: ${mark.reason}` : ""}`;
    }).join("\n")).join("\n\n") : items.map(item => `- ${item.address}: ${item.value.revision.title ?? "(no title)"}`).join("\n");
  const referenceText = clusters?.map(cluster => {
    const others = cluster.items.filter(id => !ids.has(id) && titles.has(id));
    return others.length ? `## Cluster ${cluster.label}\n\n${others.map(id => `- K${id}: ${titles.get(id)}`).join("\n")}` : "";
  }).filter(Boolean).join("\n\n");
  const bodies = items.map(item => {
    const current = item.value.revision;
    const history = store.listKnowledgeRevisions(current.knowledgeId);
    return `# ${item.address}${knowledgeStaleLabel({ staleReasons: store.knowledgeStaleReasons(current.id) })}\n\n` + history.map(r => {
      const facts = r.supports.map(id => { const fact = store.getFact(id)!; return `- F${id}: ${fact.title ?? "(untitled)"}\n${fact.text}`; }).join("\n");
      const files = r.files === undefined ? "(not mapped)" : r.files === null ? "None" : r.files.join(", ");
      return `${renderKnowledge({ knowledge: item.value.knowledge, revision: r, staleReasons: store.knowledgeStaleReasons(r.id) }, `K${r.knowledgeId}@v${store.versionOrdinal(r.knowledgeId, r.id)}`)}\nfiles: ${files}\nverification: ${JSON.stringify(store.knowledgeFileVerifications(r.id))}\nflags: ${JSON.stringify(store.knowledgeStaleReasons(r.id))}\nreason: ${r.reason}\n\nFacts:\n${facts || "None"}`;
    }).join("\n\n");
  });
  return `# Contents\n\n${contents}\n\n${bodies.join("\n\n")}\n${referenceText ? `\n# Reference only — not candidates\n\n${referenceText}\n` : ""}`;
}
export const decisionsTemplate = (items: readonly CurateItem[]) => items.map(item => `## item ${item.address}\ntitle: ${item.value.revision.title ?? ""}\naccuracy: \ngrounds: \nnorms: \nevidence: \nfiles: \ndecision: \nreason: \n`).join("\n");
export interface Decision { item: CurateItem; title: string; files: string[] | null; decision: string; reason: string; missingGrounds: boolean }
export interface Curated { problems: string[]; decisions: Decision[]; operations: KnowledgeOperationInput[]; lengths: string[] }
/** The caller supplies membership: incremental selection and full-check clustering use this same boundary. */
export function checkCurate(store: Store, path: KnowledgePath, items: readonly CurateItem[], decisionsFile: WorkspaceFile, changesFile: WorkspaceFile, wholeFileLimit = 5): Curated {
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
      const resolved = resolveCodeLink(file, roots);
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
        const resolved = resolveCodeLink(file, roots);
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
  problems.push(...wholeFileCapProblems(store, path, wholeFileLimit, operations, decisions.map(decision => decision.files)));
  return { problems, decisions, operations, lengths: checked.lengths.map(length => `${length.block}: ${length.field} ${length.count}/${length.target} (limit ${length.limit})`) };
}

/** Counts project-wide projected survivors (other groups, absorbed parents, split children), but reports only the whole-file addresses this
 * group's own items end with: an over-cap address elsewhere is not this group's to fix and must not fail it (159 review). `project` false
 * counts the pool as it stands, for the recheck after publication. */
export function wholeFileCapProblems(store: Store, path: KnowledgePath, limit: number, operations: readonly KnowledgeOperationInput[],
  groupFiles: readonly (readonly string[] | null | undefined)[], project = true): string[] {
  const current = new Map(store.curateItems(path).filter(item => item.value.revision.scope !== "session")
    .map(item => [item.value.knowledge.id, item.value.revision.files]));
  const additions: (readonly string[] | null | undefined)[] = [];
  for (const op of project ? operations : []) {
    if (op.op !== "create") current.delete(op.op === "merge" ? op.intoKnowledgeId : op.knowledgeId);
    if (op.op === "merge") for (const parent of op.absorb) current.delete(parent.knowledgeId);
    if (op.op === "archive") continue;
    if (op.scope !== "session") additions.push(op.files);
    if (op.op === "split") for (const child of op.children) if ((child.scope ?? op.scope) !== "session") additions.push(child.files);
  }
  const counts = new Map<string, number>(), roots = allowedRoots(store, path.sessionId);
  const wholeFiles = (files: readonly string[] | null | undefined) => new Set((files ?? []).filter(file => codeAddress(file).symbol === undefined)
    .map(file => { const resolved = resolveCodeLink(file, roots); return "reason" in resolved ? file : resolved.path; }));
  for (const files of [...current.values(), ...additions]) for (const address of wholeFiles(files)) counts.set(address, (counts.get(address) ?? 0) + 1);
  const own = new Set([...groupFiles, ...operations.flatMap(op => op.op === "archive" || op.op === "create" ? [] : [op.files, ...(op.op === "split" ? op.children.map(child => child.files) : [])])]
    .flatMap(files => [...wholeFiles(files)]));
  return [...counts].filter(([address, count]) => count > limit && own.has(address)).map(([address, count]) =>
    `files: ${address} has ${count} current items (whole-file limit ${limit}); use path#symbol function anchors; never drop a real link to pass the check`);
}
