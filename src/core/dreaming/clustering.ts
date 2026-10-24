import { knowledgeTitle } from "../render/index.ts";
import type { CurateItem, KnowledgePath, Store } from "../store/index.ts";
import { projectItems } from "./candidates.ts";

export interface Cluster { label: string; items: number[] }
export interface ClusteredGroup { items: number[]; clusters: Cluster[]; run?: number }
export const clusteringInput = (store: Store, items: readonly CurateItem[]) => items.map(item =>
  `${item.address} [${item.value.revision.category}] ${knowledgeTitle(item.value.revision, store.writing.titleWords).replace(/\s+/g, " ")}`).join("\n") + "\n";
export const groupsTemplate = (count: number, size: number) => Array.from({ length: Math.ceil(count / size) }, (_, i) =>
  `# Group ${i + 1}\n\n## Cluster <label>\nitems: \n`).join("\n");

export function checkGroups(text: string, items: readonly CurateItem[], size = 50): { groups: ClusteredGroup[]; problems: string[] } {
  const groups: ClusteredGroup[] = [], problems: string[] = [], seen = new Set<number>();
  const wanted = new Map(items.map(item => [item.address, item.value.knowledge.id]));
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
    } else if (line.startsWith("items:") && group && cluster) {
      const addresses = line.slice(6).split(",").map(address => address.trim()).filter(Boolean);
      if (!addresses.length) problems.push(`${where}: fill items`);
      for (const address of addresses) {
        const id = wanted.get(address);
        if (id === undefined) { problems.push(`${where}: unknown item ${address}`); continue; }
        if (seen.has(id)) problems.push(`${where}: duplicate item ${address}`);
        seen.add(id); group.items.push(id); cluster.items.push(id);
      }
    } else problems.push(`${where}: expected a group, cluster label or items line`);
  }
  for (const [address, id] of wanted) if (!seen.has(id)) problems.push(`groups.md: missing ${address}`);
  for (const [at, value] of groups.entries()) {
    if (!value.items.length || value.items.length > size) problems.push(`groups.md: group ${at + 1} must contain 1–${size} items`);
    if (value.clusters.some(part => !part.items.length)) problems.push(`groups.md: group ${at + 1} has an empty cluster`);
  }
  if (groups.length !== Math.ceil(items.length / size)) problems.push(`groups.md: use ${Math.ceil(items.length / size)} groups, as few as possible`);
  return { groups, problems };
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
