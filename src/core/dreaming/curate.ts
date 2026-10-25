import { words, renderKnowledge, renderKnowledgeDiff, knowledgeStaleLabel } from "../render/index.ts";
import { parseBlocks, plan, list, traceProblem, type WorkspaceFile } from "../workspace/index.ts";
import type { CurateItem, KnowledgePath, Store, KnowledgeOperationInput } from "../store/index.ts";
import { allowedRoots, repositoryEvidenceProblem } from "./roots.ts";
import { codeAddress, resolveCodeLink } from "./code-links.ts";
import type { Cluster } from "./clustering.ts";
import type { DreamerBoundary } from "../store/executions.ts";
export type { CurateItem } from "../store/index.ts";

export function groupText(store: Store, items: readonly CurateItem[], baselineVersions: Readonly<DreamerBoundary["versions"]>,
  clusters?: readonly Cluster[], references: readonly { id: number; title: string }[] = []): string {
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
  const factTitles = store.factTitles(items.flatMap(item => item.value.revision.supports));
  const bodies = items.map(item => {
    const current = item.value.revision;
    const flags = store.knowledgeStaleReasons(current.id);
    const facts = current.supports.map(id => `- F${id} ${factTitles.get(id) ?? "(untitled)"}`).join("\n");
    const files = current.files === undefined ? "(not mapped)" : current.files === null ? "None" : current.files.join(", ");
    const baselineId = baselineVersions[current.knowledgeId];
    let change = baselineId === undefined ? "New since the last successful Dreamer run." : "Unchanged since the last successful Dreamer run.";
    if (baselineId !== undefined && baselineId !== current.id) {
      const baseline = store.knowledgeRevision(baselineId)!;
      // Match trace's diff history: only commits on one endpoint's ancestry, never unrelated branches.
      const ancestors = (tip: typeof current) => {
        const ids = new Set<number>(), pending = [tip];
        while (pending.length) {
          const revision = pending.pop()!;
          if (ids.has(revision.id)) continue;
          ids.add(revision.id); pending.push(...store.commitParents(revision));
        }
        return ids;
      };
      const before = ancestors(baseline), after = ancestors(current);
      const history = store.listKnowledgeRevisions(current.knowledgeId).filter(r => before.has(r.id) !== after.has(r.id));
      change = renderKnowledgeDiff(baseline, current, history, Infinity, undefined,
        r => `K${r.knowledgeId}@v${store.versionOrdinal(r.knowledgeId, r.id)}`);
    }
    return `# ${item.address}${knowledgeStaleLabel({ staleReasons: flags })}\n\n` +
      `${renderKnowledge({ ...item.value, staleReasons: flags }, item.address)}\nfiles: ${files}\nverification: ${JSON.stringify(store.knowledgeFileVerifications(current.id))}\nflags: ${JSON.stringify(flags)}\nreason: ${current.reason}\n\nFacts:\n${facts || "None"}\n\nChange since the last successful Dreamer run:\n${change}`;
  });
  return `# Contents\n\n${contents}\n\n${bodies.join("\n\n")}\n${referenceText ? `\n# Reference only — not candidates\n\n${referenceText}\n` : ""}`;
}
export const decisionsTemplate = (items: readonly CurateItem[], hasRepository: boolean) => items.map(item => `## item ${item.address}\ntitle: ${item.value.revision.title ?? ""}\naccuracy: \ngrounds: \nnorms: \nevidence: \n${hasRepository ? "files: \n" : ""}decision: \nreason: \n`).join("\n");
export interface Decision { item: CurateItem; title: string; accuracy: string; files: string[] | null | undefined; preserveFiles: boolean; decision: string; reason: string; missingGrounds: boolean }
export interface Curated { problems: string[]; decisions: Decision[]; operations: KnowledgeOperationInput[]; lengths: string[]; filesToCheck: (string[] | null | undefined)[] }
/** The caller supplies membership: incremental selection and full-check clustering use this same boundary. */
/** `roots` is the run's frozen authorization snapshot: a directory appearing mid-run cannot make a rootless run accept files.
 * `heads` is shared by all run groups, retains start-of-curate commits and captures newly encountered nested repositories once. */
export function checkCurate(store: Store, path: KnowledgePath, items: readonly CurateItem[], decisionsFile: WorkspaceFile, changesFile: WorkspaceFile, wholeFileLimit = 5,
  roots: readonly string[] = allowedRoots(store, path.sessionId), heads?: Map<string, string>): Curated {
  const parsed = parseBlocks(decisionsFile), checked = plan(store, { kind: "curate", sessionId: path.sessionId, path, file: changesFile, heads });
  const problems = [...parsed.problems, ...checked.problems];
  const wanted = new Map(items.map(item => [item.address, item])), seen = new Set<string>();
  const decisions: Decision[] = [];
  const filesToCheck: (string[] | null | undefined)[] = [];
  for (const block of parsed.blocks) {
    const item = wanted.get(block.target), label = `decisions.md:${block.line}`;
    if (block.op !== "item" || !item) { problems.push(`${label}: expected an item of this group`); continue; }
    if (seen.has(block.target)) problems.push(`${label}: duplicate item ${block.target}`);
    seen.add(block.target);
    const fields = block.fields;
    const keys = ["title", "accuracy", "grounds", "norms", "evidence", ...(roots.length ? ["files"] : []), "decision", "reason"];
    for (const key of keys) if (!fields.get(key)?.value.trim()) problems.push(`${label}: fill ${key}`);
    for (const key of fields.keys()) if (!keys.includes(key)) problems.push(`${label}: ${key === "files" && !roots.length ? "omit files: no readable repository; the current record is preserved" : `unknown key ${key}`}`);
    if (block.body || block.children.length) problems.push(`${label}: item takes only its checklist keys`);
    const value = (key: string) => fields.get(key)?.value ?? "";
    if (!/^(?:ok|unverified|outdated:\s*\S.*|wrong:\s*\S.*)$/.test(value("accuracy"))) problems.push(`${label}: accuracy must be ok, unverified, outdated: <why> or wrong: <why>`);
    if (words(value("title")) > Math.ceil(store.writing.titleWords * 1.1)) problems.push(`${label}: title exceeds target ${store.writing.titleWords}`);
    const preserveFiles = !roots.length || value("files") === "unchanged";
    const files = preserveFiles ? item.value.revision.files : value("files") === "None" ? null : list(value("files")).flatMap(file => {
      const resolved = resolveCodeLink(file, roots, heads);
      if ("reason" in resolved) { problems.push(`${label}: files: ${resolved.reason}`); return []; }
      return [resolved.path];
    });
    if (!preserveFiles) filesToCheck.push(files);
    if (files && new Set(files).size !== files.length) problems.push(`${label}: duplicate linked file`);
    const decision = value("decision");
    if (!/^(?:keep|update|archive|merge|split|merged into K[1-9]\d*)$/.test(decision)) problems.push(`${label}: unknown decision ${decision}`);
    for (const evidence of list(value("evidence"))) {
      if (evidence === "None") continue;
      const problem = evidence.startsWith("trace://") ? traceProblem(store, evidence) : repositoryEvidenceProblem(evidence, roots);
      if (problem) problems.push(`${label}: evidence ${evidence}: ${problem}`);
    }
    decisions.push({ item, title: value("title"), accuracy: value("accuracy"), files, preserveFiles, decision, reason: value("reason"), missingGrounds: /^(?:None|missing|unverified)(?:\b|$)/i.test(value("grounds")) });
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
    if (!roots.length) for (const section of [entry.block, ...entry.block.children])
      if (section.fields.has("files")) problems.push(`changes.md:${section.line}: omit files: no readable repository; the parent's record is preserved`);
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
      if (decision.preserveFiles && !raw) op.children[index]!.files = decision.item.value.revision.files;
      else if (!raw) problems.push(`changes.md: K${id} child ${index + 1} requires files`);
      else op.children[index]!.files = raw === "None" ? null : list(raw).flatMap(file => {
        const resolved = resolveCodeLink(file, roots, heads);
        if ("reason" in resolved) { problems.push(`changes.md: child files: ${resolved.reason}`); return []; }
        return [resolved.path];
      });
      if (raw && roots.length) filesToCheck.push(op.children[index]!.files);
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
  problems.push(...wholeFileCapProblems(store, path, wholeFileLimit, operations, filesToCheck, true, roots));
  return { problems, decisions, operations, filesToCheck, lengths: checked.lengths.map(length => `${length.block}: ${length.field} ${length.count}/${length.target} (limit ${length.limit})`) };
}

/** Counts all projected survivors, but reports only explicitly checked mappings: unchanged records still count without forcing a repair.
 * `project` false counts the pool as it stands, for the recheck after publication. */
export function wholeFileCapProblems(store: Store, path: KnowledgePath, limit: number, operations: readonly KnowledgeOperationInput[],
  groupFiles: readonly (readonly string[] | null | undefined)[], project = true, roots: readonly string[] = allowedRoots(store, path.sessionId)): string[] {
  if (!roots.length) return [];
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
  const counts = new Map<string, number>();
  const wholeFiles = (files: readonly string[] | null | undefined) => new Set((files ?? []).filter(file => codeAddress(file).symbol === undefined)
    .map(file => { const resolved = resolveCodeLink(file, roots); return "reason" in resolved ? file : resolved.path; }));
  for (const files of [...current.values(), ...additions]) for (const address of wholeFiles(files)) counts.set(address, (counts.get(address) ?? 0) + 1);
  const own = new Set(groupFiles.flatMap(files => [...wholeFiles(files)]));
  return [...counts].filter(([address, count]) => count > limit && own.has(address)).map(([address, count]) =>
    `files: ${address} has ${count} current items (whole-file limit ${limit}); use path#symbol function anchors; never drop a real link to pass the check`);
}
