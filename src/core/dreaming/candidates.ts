import { execFileSync } from "node:child_process";
import { dirname, relative } from "node:path";
import type { Store, KnowledgePath, CurateItem } from "../store/index.ts";
import type { KnowledgeRevision } from "../model/index.ts";
import type { DreamerBoundary } from "../store/executions.ts";
import { sentenceDiff } from "../render/index.ts";
import { allowedRoots, resolveRepositoryPath } from "./roots.ts";

export interface Seed { kind: "fact" | "knowledge" | "file"; title: string; objects: string[]; knowledgeId?: number; text: string }
export interface CandidateSelection { seeds: Seed[]; candidates: CurateItem[]; boundary: DreamerBoundary }
export interface RepositoryHead { root: string; commit: string }
export const projectItems = (store: Store, path: KnowledgePath): CurateItem[] => store.curateItems(path).filter(item => item.value.revision.scope !== "session");
export function boundaryOf(store: Store, items: readonly CurateItem[]): DreamerBoundary {
  return { fact: Number(store.db.prepare("SELECT COALESCE(MAX(id),0) AS id FROM facts").get()!.id),
    revision: Number(store.db.prepare("SELECT COALESCE(MAX(id),0) AS id FROM knowledge_revisions").get()!.id),
    versions: Object.fromEntries(items.map(item => [item.value.knowledge.id, item.value.revision.id])) };
}
export function lastBoundary(store: Store, path: KnowledgePath): DreamerBoundary {
  const projectId = store.getSession(path.sessionId)!.projectId;
  const row = store.db.prepare(`SELECT r.id,r.created_at,b.response FROM runs r JOIN run_bodies b ON b.run_id=r.id
    JOIN sessions s ON s.id=r.session_id WHERE r.kind='dreaming' AND r.outcome='success' AND s.project_id=?
    AND (json_extract(b.response,'$.finished') IS NOT NULL OR EXISTS (
      SELECT 1 FROM execution_runs x JOIN task_executions e ON e.id=x.execution_id WHERE x.run_id=r.id AND e.outcome='success'))
    ORDER BY r.id DESC LIMIT 1`).get(projectId);
  if (!row) return { fact: 0, revision: 0, versions: {} };
  const saved = JSON.parse(String(row.response ?? "{}"))?.finished?.boundary;
  if (saved) return saved;
  // Existing completed runs predate explicit seed watermarks. Their first task's creation time
  // bounds inputs; exact covered versions also exclude that run's own maintenance output.
  const first = store.db.prepare(`SELECT MIN(r.created_at) AS at FROM execution_runs x JOIN runs r ON r.id=x.run_id
    WHERE x.execution_id=(SELECT execution_id FROM execution_runs WHERE run_id=?)`).get(Number(row.id));
  const at = String(first?.at ?? row.created_at);
  const fact = Number(store.db.prepare("SELECT COALESCE(MAX(f.id),0) AS id FROM facts f JOIN runs r ON r.id=f.run_id WHERE r.created_at<?").get(at)!.id);
  const revision = Number(store.db.prepare("SELECT COALESCE(MAX(k.id),0) AS id FROM knowledge_revisions k JOIN runs r ON r.id=k.run_id WHERE r.created_at<?").get(at)!.id);
  const versions = store.db.prepare(`SELECT k.knowledge_id,MAX(k.id) AS id FROM knowledge_processed p JOIN knowledge_revisions k ON k.id=p.revision_id
    WHERE p.run_id<=? AND p.pool IN ('global',?) GROUP BY k.knowledge_id`).all(Number(row.id), `project:${projectId}`);
  return { fact, revision, versions: Object.fromEntries(versions.map(value => [String(value.knowledge_id), Number(value.id)])) };
}
export function repositoryHead(file: string): RepositoryHead | undefined {
  try {
    const root = execFileSync("git", ["-C", dirname(file), "rev-parse", "--show-toplevel"], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
    const commit = execFileSync("git", ["-C", root, "rev-parse", "HEAD"], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
    return { root, commit };
  } catch { return undefined; }
}
/** Content comparison includes working-tree changes; no hashes are invented for non-git files. */
export function scanChangedFiles(store: Store, path: KnowledgePath, items = projectItems(store, path)): Seed[] {
  const roots = allowedRoots(store, path.sessionId), seeds: Seed[] = [];
  const diffs = new Map<string, string>();
  for (const item of items) {
    const r = item.value.revision;
    if (!r.files) continue; // Neither not-mapped nor explicit None is a file seed.
    const verified = new Map(store.knowledgeFileVerifications(r.id).map(value => [value.file, value]));
    for (const file of r.files) {
      const record = verified.get(file);
      if (!record) continue; // The Noter flags unverified links at publication.
      const resolved = resolveRepositoryPath(file, roots);
      let diff = "";
      if ("reason" in resolved) diff = `Missing or unreadable linked file: ${file}: ${resolved.reason}`;
      else {
        const repo = repositoryHead(resolved.path);
        if (!repo) continue;
        const key = `${repo.root}\0${record.verifiedCommit}\0${resolved.path}`;
        if (diffs.has(key)) diff = diffs.get(key)!;
        else {
          try { diff = execFileSync("git", ["-C", repo.root, "diff", record.verifiedCommit, "--", relative(repo.root, resolved.path)], { encoding: "utf8", maxBuffer: 32 * 1024 * 1024, stdio: ["ignore", "pipe", "ignore"] }); }
          catch { diff = `Cannot compare ${file} against verified commit ${record.verifiedCommit}`; }
          diffs.set(key, diff);
        }
      }
      if (!diff) continue;
      store.setKnowledgeStale(r.id, { reason: "file_changed", detail: `${file} since ${record.verifiedCommit}` });
      item.value.staleReasons = store.knowledgeStaleReasons(r.id);
      seeds.push({ kind: "file", title: r.title ?? file, objects: store.knowledgeObjects(r.id).map(value => value.object), knowledgeId: r.knowledgeId,
        text: `${file}@${record.verifiedCommit}\n${diff}` });
    }
  }
  return seeds;
}
const seedVersion = (revision: KnowledgeRevision) => `${revision.title ?? ""}\n${revision.text}\ncategory: ${revision.category}\nscope: ${revision.scope}\nsupports: ${revision.supports.map(id => `F${id}`).join(", ")}\nfiles: ${revision.files?.join(", ") ?? "None"}`;
export function incrementalCandidates(store: Store, path: KnowledgePath, cap: number, since = lastBoundary(store, path)): CandidateSelection {
  const items = projectItems(store, path), live = new Map(items.map(item => [item.value.knowledge.id, item]));
  const project = store.getSession(path.sessionId)!.projectId;
  const seeds: Seed[] = [];
  const facts = store.db.prepare(`SELECT f.id FROM facts f JOIN turns t ON t.id=f.turn_id JOIN sessions s ON s.id=t.session_id
    JOIN runs r ON r.id=f.run_id WHERE f.id>? AND s.project_id=? AND r.kind='noting' ORDER BY f.id`).all(since.fact, project);
  for (const row of facts) {
    const fact = store.getFact(Number(row.id))!;
    if (!store.factOnPath(fact, path)) continue;
    seeds.push({ kind: "fact", title: fact.title ?? "", objects: fact.objects ?? [], text: `F${fact.id}: ${fact.title ?? "(untitled)"}` });
  }
  for (const r of store.commitGraph(path).current.filter(revision => revision.scope !== "session")) {
    if (r.id === since.versions[r.knowledgeId] || r.op === "archive" && since.versions[r.knowledgeId] === undefined && r.id <= since.revision) continue;
    const oldId = since.versions[r.knowledgeId], old = oldId ? store.getKnowledgeRevision(r.knowledgeId, oldId) : null;
    seeds.push({ kind: "knowledge", title: r.title ?? "", objects: store.knowledgeObjects(r.id).map(value => value.object), knowledgeId: r.knowledgeId,
      text: `K${r.knowledgeId}: ${old ? sentenceDiff(seedVersion(old), seedVersion(r)).text : seedVersion(r)}` });
  }
  seeds.push(...scanChangedFiles(store, path, items));
  const objects = new Map<string, { item: CurateItem; weight: number }[]>();
  for (const item of items) for (const object of store.knowledgeObjects(item.value.revision.id)) {
    const key = object.object.toLowerCase(), entries = objects.get(key) ?? [];
    entries.push({ item, weight: object.facts }); objects.set(key, entries);
  }
  const queryCounts = new Map<string, number>(), repeatedQueries = new Map<string, number[]>();
  for (const seed of seeds) for (const text of [seed.title, ...seed.objects]) queryCounts.set(text, (queryCounts.get(text) ?? 0) + 1);
  const revisions = items.map(item => item.value.revision.id);
  const candidates = new Map<number, CurateItem>();
  const add = (item: CurateItem | undefined) => { if (item && !candidates.has(item.value.knowledge.id)) candidates.set(item.value.knowledge.id, item); };
  for (const seed of seeds) {
    add(seed.knowledgeId === undefined ? undefined : live.get(seed.knowledgeId));
    const wanted = new Set(seed.objects.map(object => object.toLowerCase()));
    const ranked = new Map<CurateItem, number>();
    for (const object of wanted) for (const entry of objects.get(object) ?? []) ranked.set(entry.item, (ranked.get(entry.item) ?? 0) + entry.weight);
    [...ranked].sort((a, b) => b[1] - a[1] || a[0].value.knowledge.id - b[0].value.knowledge.id).slice(0, cap).forEach(([item]) => add(item));
    const hits = new Map<number, number>();
    for (const text of [seed.title, ...seed.objects]) {
      const terms = text.match(/[\p{L}\p{N}_./-]+/gu) ?? [];
      if (!terms.length) continue;
      const matches = repeatedQueries.get(text) ?? store.searchKnowledge(terms, revisions);
      if (queryCounts.get(text)! > 1) repeatedQueries.set(text, matches);
      for (const id of matches) hits.set(id, (hits.get(id) ?? 0) + 1);
    }
    [...hits].sort((a, b) => b[1] - a[1] || a[0] - b[0]).slice(0, cap).forEach(([id]) => add(live.get(id)));
  }
  for (const item of items) if (item.value.staleReasons?.length) add(item);
  return { seeds, candidates: [...candidates.values()], boundary: boundaryOf(store, items) };
}
export const seedText = (seeds: readonly Seed[]) => seeds.map(seed => `## ${seed.kind}: ${seed.title}\nobjects: ${seed.objects.join(", ")}\n\n${seed.text}`).join("\n\n") || "No new seeds.";
