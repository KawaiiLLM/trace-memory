import { knowledgeTitle } from "../render/index.ts";
import type { CurateItem, KnowledgePath, Store } from "../store/index.ts";
import { projectItems } from "./candidates.ts";

export const SUSPICION_LEVELS = ["high", "medium", "low"] as const;
/** `partners`: the items this one duplicates or contradicts (181). */
export interface Suspicion { kind: "duplicate" | "contradiction"; level: typeof SUSPICION_LEVELS[number]; partners: number[]; reason: string }
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
      const match = /^- (K[1-9]\d*)(?: ! (duplicate|contradiction) (high|medium|low) (K[1-9]\d*(?:,K[1-9]\d*)*): (\S.*))?$/.exec(line);
      if (!match) { problems.push(`${where}: expected - K<id> with optional ! duplicate|contradiction high|medium|low K<partner>[,K<partner>...]: <reason>`); continue; }
      const address = match[1]!, id = wanted.get(address);
      if (id === undefined) { problems.push(`${where}: unknown item ${address}`); continue; }
      if (seen.has(id)) problems.push(`${where}: duplicate item ${address}`);
      seen.add(id); group.items.push(id); cluster.items.push(id);
      if (!match[2]) continue;
      const partners = match[4]!.split(",").flatMap(partner => { const found = wanted.get(partner); if (found === undefined) problems.push(`${where}: unknown partner ${partner}`); return found ?? []; });
      (cluster.marks ??= {})[id] = { kind: match[2] as Suspicion["kind"], level: match[3] as Suspicion["level"], partners, reason: match[5]! };
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

/** 181: groups come from the candidates alone (at most `size` per group; more are split by clustering group, parts merged in order
 * while they fit); marks never create or split a group. Each group's spare capacity is then filled with marked non-candidates,
 * level high to low, and within a level the same small cluster as one of the group's candidates, then the same clustering group,
 * then elsewhere (ties keep clustering order). A marked item joins with its partners that are in no group yet, as one unit; a unit
 * that does not fit is skipped, a later smaller one may still fill. Items that fit nowhere are dropped for this run. */
export function candidateGroups(clustering: readonly ClusteredGroup[], candidates: ReadonlySet<number>, size = 50): ClusteredGroup[] {
  const groups: Set<number>[] = [], placed = new Set<number>();
  for (const group of clustering) {
    const part = group.items.filter(id => candidates.has(id)), current = groups.at(-1);
    if (!part.length) continue;
    if (current && current.size + part.length <= size) part.forEach(id => current.add(id));
    else groups.push(new Set(part));
  }
  for (const group of groups) for (const id of group) placed.add(id);
  const clusters = clustering.flatMap(group => group.clusters), order = new Map<number, number>(), clusterOf = new Map<number, Cluster>(), bigOf = new Map<number, ClusteredGroup>();
  for (const big of clustering) for (const cluster of big.clusters) for (const id of cluster.items) { order.set(id, order.size); clusterOf.set(id, cluster); bigOf.set(id, big); }
  const marked = clusters.flatMap(cluster => cluster.items.filter(id => cluster.marks?.[id] && !candidates.has(id)).map(id => ({ id, mark: cluster.marks![id]! })));
  for (const members of groups) {
    const near = new Set([...members].map(id => clusterOf.get(id))), wide = new Set([...members].map(id => bigOf.get(id)));
    const locality = (id: number) => near.has(clusterOf.get(id)) ? 0 : wide.has(bigOf.get(id)) ? 1 : 2;
    const ranked = [...marked].sort((a, b) => SUSPICION_LEVELS.indexOf(a.mark.level) - SUSPICION_LEVELS.indexOf(b.mark.level)
      || locality(a.id) - locality(b.id) || order.get(a.id)! - order.get(b.id)!);
    for (const { id, mark } of ranked) {
      if (placed.has(id)) continue;
      const unit = new Set([id, ...mark.partners.filter(partner => !placed.has(partner))]);
      if (members.size + unit.size > size) continue;
      for (const joined of unit) { members.add(joined); placed.add(joined); }
    }
  }
  return groups.map(ids => {
    const used = clusters.filter(cluster => cluster.items.some(id => ids.has(id)));
    return { items: used.flatMap(cluster => cluster.items.filter(id => ids.has(id))), clusters: used };
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
