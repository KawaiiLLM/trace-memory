import { knowledgeTitle } from "../render/index.ts";
import type { CurateItem, KnowledgePath, Store } from "../store/index.ts";
import { projectItems } from "./candidates.ts";

export interface Suspicion { kind: "duplicate" | "contradiction"; reason: string }
export interface Cluster { label: string; items: number[]; marks?: Record<string, Suspicion> }
export interface ClusteredGroup { items: number[]; clusters: Cluster[]; run?: number }
export const clusteringInput = (store: Store, items: readonly CurateItem[]) => items.map(item =>
  `${item.address} [${item.value.revision.category}] ${knowledgeTitle(item.value.revision, store.writing.titleWords).replace(/\s+/g, " ")}`).join("\n") + "\n";
/** Ten complete bodies per file keeps the model's reads finite without truncating an item. */
export function clusteringBatches(items: readonly CurateItem[]): Record<string, string> {
  const files: Record<string, string> = {};
  for (let at = 0; at < items.length; at += 10) files[`batch-${at / 10 + 1}.md`] = items.slice(at, at + 10)
    .map(item => `# ${item.address}\n\n${item.value.revision.text}`).join("\n\n") + "\n";
  return files;
}
export const groupsTemplate = (count: number, size: number) => Array.from({ length: Math.ceil(count / size) }, (_, i) =>
  `# Group ${i + 1}\n\n## Cluster <label>\n- K<id>\n`).join("\n");

export function checkGroups(text: string, items: readonly CurateItem[], size = 50): { groups: ClusteredGroup[]; problems: string[] } {
  const groups: ClusteredGroup[] = [], problems: string[] = [], seen = new Set<number>();
  const wanted = new Map(items.map(item => [`K${item.value.knowledge.id}`, item.value.knowledge.id]));
  let group: ClusteredGroup | undefined, cluster: Cluster | undefined;
  for (const [at, raw] of text.split(/\r?\n/).entries()) {
    const line = raw.trim(), where = `groups.md:${at + 1}`;
    if (!line) continue;
    if (/^# Group [1-9]\d*$/.test(line)) {
      if (line !== `# Group ${groups.length + 1}`) problems.push(`${where}: number groups consecutively`);
      group = { items: [], clusters: [] }; groups.push(group); cluster = undefined;
    } else if (line.startsWith("## Cluster ") && group) {
      const label = line.slice("## Cluster ".length).trim();
      if (!label || label === "<label>") problems.push(`${where}: fill the cluster label`);
      cluster = { label, items: [] }; group.clusters.push(cluster);
    } else if (line.startsWith("- ") && group && cluster) {
      const match = /^- (K[1-9]\d*)(?: ! (duplicate|contradiction): (\S.*))?$/.exec(line);
      if (!match) { problems.push(`${where}: expected - K<id> with optional ! duplicate|contradiction: <reason>`); continue; }
      const address = match[1]!, id = wanted.get(address);
      if (id === undefined) { problems.push(`${where}: unknown item ${address}`); continue; }
      if (seen.has(id)) problems.push(`${where}: duplicate item ${address}`);
      seen.add(id); group.items.push(id); cluster.items.push(id);
      if (match[2]) (cluster.marks ??= {})[id] = { kind: match[2] as Suspicion["kind"], reason: match[3]! };
    } else problems.push(`${where}: expected a group, cluster label or item line`);
  }
  for (const [address, id] of wanted) if (!seen.has(id)) problems.push(`groups.md: missing ${address}`);
  for (const [at, value] of groups.entries()) {
    if (!value.items.length || value.items.length > size) problems.push(`groups.md: group ${at + 1} must contain 1–${size} items`);
    if (value.clusters.some(part => !part.items.length)) problems.push(`groups.md: group ${at + 1} has an empty cluster`);
    if (value.clusters.some(part => part.items.length > 10)) problems.push(`groups.md: group ${at + 1} clusters must contain at most 10 items`);
  }
  if (groups.length !== Math.ceil(items.length / size)) problems.push(`groups.md: use ${Math.ceil(items.length / size)} groups, as few as possible`);
  return { groups, problems };
}

/** 2026-10-24: every marked item joins the candidates (「有可疑标记的全部加入作为补充候选」). At most `size` → one group; more → a part per
 * clustering group (each holds at most `size` items), parts merged in clustering order while they fit. */
export function candidateGroups(clustering: readonly ClusteredGroup[], candidates: ReadonlySet<number>, size = 50): ClusteredGroup[] {
  const all = new Set([...candidates, ...clustering.flatMap(group => group.clusters.flatMap(cluster => cluster.items.filter(id => cluster.marks?.[id])))]);
  const groups: number[][] = [];
  if (all.size <= size) groups.push(clustering.flatMap(group => group.items.filter(id => all.has(id))));
  else for (const group of clustering) {
    const part = group.items.filter(id => all.has(id)), current = groups.at(-1);
    if (!part.length) continue;
    if (current && current.length + part.length <= size) current.push(...part);
    else groups.push(part);
  }
  // No candidates and no marks give no group.
  return groups.filter(ids => ids.length).map(ids => {
    const members = new Set(ids);
    const clusters = clustering.flatMap(group => group.clusters).filter(cluster => cluster.items.some(id => members.has(id)));
    return { items: clusters.flatMap(cluster => cluster.items.filter(id => members.has(id))), clusters };
  });
}

/** Model-free preview; a saved hand-off supplies groups and committed decisions after clustering. */
export function fullCheckDryRun(store: Store, path: KnowledgePath) {
  const project = store.getProject(store.getSession(path.sessionId)!.projectId)!;
  const items = projectItems(store, path);
  const saved = store.db.prepare(`SELECT h.detail FROM task_handoffs h JOIN sessions s ON s.id=h.session_id
    WHERE h.phase='dreaming' AND s.project_id=? AND json_extract(h.detail,'$.fullCheck')=1 ORDER BY h.created_at DESC LIMIT 1`).get(project.id);
  const completed = store.db.prepare(`SELECT r.id,b.response FROM runs r JOIN run_bodies b ON b.run_id=r.id JOIN sessions s ON s.id=r.session_id
    WHERE r.kind='dreaming' AND s.project_id=? AND json_extract(b.response,'$.fullCheck')=1 ORDER BY r.id DESC LIMIT 1`).get(project.id);
  const detail = saved ? JSON.parse(String(saved.detail)) : completed ? JSON.parse(String(completed.response)) : undefined;
  const groups: ClusteredGroup[] | undefined = detail?.groupsFile === undefined ? undefined : detail.groups;
  if (!saved && completed && groups && detail.group) groups[detail.group - 1]!.run = Number(completed.id);
  return { project: { id: project.id, name: project.name }, items: clusteringInput(store, items).trimEnd().split("\n").filter(Boolean), count: items.length,
    estimateUsd: { clustering: items.length * 0.43 / 418, curate: items.length * 0.17, total: items.length * (0.43 / 418 + 0.17), basis: "$0.43 per 418 items clustering; $0.17 per item curate; excludes unmeasured notes/scoring" },
    groups: groups ?? null, decisions: groups?.flatMap(group => {
      if (!group.run) return [];
      const run = store.getRun(group.run);
      return run?.response ? [{ runId: group.run, decisions: JSON.parse(run.response).decisions }] : [];
    }) ?? [], modelCalls: 0 };
}
