import { execFileSync } from "node:child_process";
import { relative } from "node:path";
import type { Store, KnowledgePath, CurateItem } from "../store/index.ts";
import type { DreamerBoundary } from "../store/executions.ts";
import { allowedRoots, resolveRepositoryPath } from "./roots.ts";
import { codeAddress, committedText, repositoryHead, symbolText } from "./code-links.ts";

export interface CandidateSelection { background: string; candidates: CurateItem[]; boundary: DreamerBoundary }
export const projectItems = (store: Store, path: KnowledgePath): CurateItem[] => store.curateItems(path).filter(item => item.value.revision.scope !== "session");
export function boundaryOf(store: Store, items: readonly CurateItem[]): DreamerBoundary {
  return { fact: Number(store.db.prepare("SELECT COALESCE(MAX(id),0) AS id FROM facts").get()!.id),
    revision: Number(store.db.prepare("SELECT COALESCE(MAX(id),0) AS id FROM knowledge_revisions").get()!.id),
    versions: Object.fromEntries(items.map(item => [item.value.knowledge.id, item.value.revision.id])) };
}
/** `beforeRunId` recovers the boundary an earlier admission saw (a hand-off written before 175 kept no baseline). */
export function lastBoundary(store: Store, path: KnowledgePath, beforeRunId?: number): DreamerBoundary {
  const projectId = store.getSession(path.sessionId)!.projectId;
  const row = store.db.prepare(`SELECT r.id,r.created_at,b.response FROM runs r JOIN run_bodies b ON b.run_id=r.id
    JOIN sessions s ON s.id=r.session_id WHERE r.kind='dreaming' AND r.outcome='success' AND s.project_id=?
    AND (json_extract(b.response,'$.finished') IS NOT NULL OR EXISTS (
      SELECT 1 FROM execution_runs x JOIN task_executions e ON e.id=x.execution_id WHERE x.run_id=r.id AND e.outcome='success'))
    AND r.id < ? ORDER BY r.id DESC LIMIT 1`).get(projectId, beforeRunId ?? Number.MAX_SAFE_INTEGER);
  if (!row) return { fact: 0, revision: 0, versions: {} };
  const saved = JSON.parse(String(row.response ?? "{}"))?.finished?.boundary;
  if (saved) return saved;
  // Existing completed runs predate explicit watermarks. Their first task's creation time
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
/** The captured file baseline is retained even if the symbol was absent there: that absence counts as changed. */
export function trackedAt(root: string, commit: string, file: string): boolean {
  const link = codeAddress(file);
  try { execFileSync("git", ["-C", root, "cat-file", "-e", `${commit}:${relative(root, link.path)}`], { stdio: "ignore" }); return true; } catch { return false; }
}
/** Symbols compare committed text at HEAD; whole-file links retain working-tree diff detection. */
export function scanChangedFiles(store: Store, path: KnowledgePath, items = projectItems(store, path)): string[] {
  const roots = allowedRoots(store, path.sessionId), background: string[] = [];
  const diffs = new Map<string, string>();
  for (const item of items) {
    const r = item.value.revision;
    if (!r.files) continue;
    const verified = new Map(store.knowledgeFileVerifications(r.id).map(value => [value.file, value]));
    for (const file of r.files) {
      const record = verified.get(file);
      if (!record) continue; // The Noter flags unverified links at publication.
      const link = codeAddress(file), resolved = resolveRepositoryPath(link.path, roots);
      let diff = "";
      if ("reason" in resolved) diff = `${link.symbol === undefined ? "Missing or unreadable linked file" : "symbol missing"}: ${file}: ${resolved.reason}`;
      else {
        const repo = repositoryHead(resolved.path);
        if (!repo) continue;
        const key = `${repo.root}\0${record.verifiedCommit}\0${file}`;
        if (diffs.has(key)) diff = diffs.get(key)!;
        else {
          if (link.symbol !== undefined) {
            const before = symbolText(committedText(repo.root, record.verifiedCommit, resolved.path), link.symbol);
            const after = symbolText(committedText(repo.root, repo.commit, resolved.path), link.symbol);
            diff = after === undefined ? `symbol missing: ${file} at HEAD`
              : before === undefined ? `Symbol absent at verified commit: ${file}\n${after}`
              : before !== after ? `--- ${file}@${record.verifiedCommit}\n${before}\n+++ ${file}@${repo.commit}\n${after}` : "";
          } else {
            try { diff = execFileSync("git", ["-C", repo.root, "diff", record.verifiedCommit, "--", resolved.path], { encoding: "utf8", maxBuffer: 32 * 1024 * 1024, stdio: ["ignore", "pipe", "ignore"] }); }
            catch { diff = `Cannot compare ${file} against verified commit ${record.verifiedCommit}`; }
          }
          diffs.set(key, diff);
        }
      }
      if (!diff) continue;
      store.setKnowledgeStale(r.id, { reason: "file_changed", detail: `${file} since ${record.verifiedCommit}${diff.includes("symbol missing:") ? ": symbol missing" : ""}` });
      item.value.staleReasons = store.knowledgeStaleReasons(r.id);
      background.push(`${file}@${record.verifiedCommit}\n${diff}`);
    }
  }
  return [...new Set(background)];
}
export function incrementalCandidates(store: Store, path: KnowledgePath, since = lastBoundary(store, path)): CandidateSelection {
  const items = projectItems(store, path);
  const project = store.getSession(path.sessionId)!.projectId;
  const background: string[] = [];
  const facts = store.db.prepare(`SELECT f.id FROM facts f JOIN turns t ON t.id=f.turn_id JOIN sessions s ON s.id=t.session_id
    JOIN runs r ON r.id=f.run_id WHERE f.id>? AND s.project_id=? AND r.kind='noting' ORDER BY f.id`).all(since.fact, project);
  for (const row of facts) {
    const fact = store.getFact(Number(row.id))!;
    if (!store.factOnPath(fact, path)) continue;
    background.push(`F${fact.id} ${fact.title ?? "(untitled)"} — ${(fact.objects ?? []).join(", ")}`);
  }
  background.push(...scanChangedFiles(store, path, items));
  // 181: unscored items are candidates too (covered or not), so one run scores them all and the unscored-size trigger clears.
  const candidates = items.filter(item => item.value.revision.id !== since.versions[item.value.knowledge.id] || item.value.staleReasons?.length || item.score === null);
  return { background: background.join("\n\n") || "No new background material.", candidates, boundary: boundaryOf(store, items) };
}
