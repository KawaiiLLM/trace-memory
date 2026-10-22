// verify's change file (ticket 144 stage 4 §5.1): one block per operation curate applied this cycle, rebuilt from the curate runs
// the hand-off lists, so it survives an executor restart. Each block's before is that operation's own base and its after that
// operation's result; a Noter or manual version never enters a diff. The builder also returns what bounds verify's authority (§5.3).

import type { KnowledgeRevision } from "../model/index.ts";
import { knowledgeTitle } from "../render/index.ts";
import type { KnowledgePath, Store } from "../store/index.ts";
import { plan, type VerifyAuthority, type WorkspaceFile } from "../workspace/index.ts";

export interface Changes {
  text: string; blocks: number; lines: number;
  /** Each item curate wrote: its latest curate result; and the version that operation was written from (absent for a create, a split child, an absorbed item). */
  results: Map<number, number>; bases: Map<number, number>;
}
interface Applied { op: string; run: number; category: string; base?: KnowledgeRevision; after: KnowledgeRevision; absorbed: KnowledgeRevision[]; children: KnowledgeRevision[] }

export function buildChanges(store: Store, curateRuns: readonly number[]): Changes {
  const version = (r: KnowledgeRevision) => `K${r.knowledgeId}@v${store.versionOrdinal(r.knowledgeId, r.id)}`;
  const titled = (r: KnowledgeRevision) => `${knowledgeTitle(r, store.writing.titleTokens)}\n${r.text}`;
  const applied: Applied[] = [];
  for (const run of curateRuns) {
    const response = JSON.parse(store.getRun(run)?.response ?? "{}") as { category?: string; blocks?: { result?: { ok?: boolean; committed?: { knowledgeId: number; commit: number }[] } }[] };
    for (const { result } of response.blocks ?? []) {
      if (!result?.ok || !result.committed?.length) continue;
      const [first, ...rest] = result.committed.map(item => store.getKnowledgeRevision(item.knowledgeId, item.commit)!);
      const parents = store.commitParents(first!);
      const base = parents.find(parent => parent.knowledgeId === first!.knowledgeId);
      applied.push({ op: first!.op, run, category: response.category ?? "", ...(base ? { base } : {}), after: first!,
        absorbed: first!.op === "merge" ? parents.filter(parent => parent.knowledgeId !== first!.knowledgeId) : [],
        children: first!.op === "split" ? rest : [] });
    }
  }
  // Later operations win: the latest result per item, and the base of that same operation.
  const results = new Map<number, number>(), bases = new Map<number, number>();
  for (const a of applied) for (const written of [a.after, ...a.children]) {
    results.set(written.knowledgeId, written.id);
    if (written === a.after && a.base) bases.set(written.knowledgeId, a.base.id); else bases.delete(written.knowledgeId);
  }
  const earlier = new Map<number, number>();
  const blocks = applied.map((a, i) => {
    const id = a.after.knowledgeId, latest = results.get(id) === a.after.id;
    const attribute = (name: string, from: string | undefined, to: string) => `${name}: ${from === undefined || from === to ? to : `${from} -> ${to}`}`;
    const b = a.base, r = a.after;
    const lines = [`## ${i + 1} · ${a.op} K${id} · curate batch ${a.category} · R${a.run}`,
      `base: ${b ? version(b) : "none"}`, `result: ${version(r)}${latest ? " (latest curate result)" : ""}`];
    if (b && earlier.has(id) && earlier.get(id) !== b.id) lines.push(`base follows ${version(b)} (${b.actorRole ?? "unrecorded"})`);
    earlier.set(id, r.id);
    if (a.op === "archive") lines.push(`archive: ${r.archiveKind ?? "unrecorded"}`, `reason: ${r.reason}`, "", "before:", ...(b ? [titled(b)] : ["none"]), "", "after:", r.text);
    else {
      lines.push(attribute("category", b?.category, r.category), attribute("scope", b?.scope, r.scope),
        attribute("topics", b && JSON.stringify(b.topics), JSON.stringify(r.topics)),
        attribute("supports", b?.supports.map(f => `F${f}`).join(", "), r.supports.map(f => `F${f}`).join(", ")), `reason: ${r.reason}`,
        "", "before:", ...(b ? [titled(b)] : ["none"]), ...a.absorbed.flatMap(parent => ["", `absorbed ${version(parent)}:`, titled(parent)]),
        "", "after:", titled(r),
        ...a.absorbed.map(parent => `K${parent.knowledgeId}: consumed by this merge (no version of its own; correct its content in the primary)`),
        ...a.children.flatMap(child => ["", `child ${version(child)}:`, titled(child)]));
    }
    return lines.join("\n");
  });
  const text = blocks.join("\n\n") + (blocks.length ? "\n" : "");
  return { text, blocks: blocks.length, lines: text ? text.split("\n").length - 1 : 0, results, bases };
}

/** The check of verify's file (§5.2): the Stage 2 plan under curate's authority (§5.3) and the evidence rules (§5.4). */
export function checkVerify(store: Store, path: KnowledgePath, file: WorkspaceFile, authority: VerifyAuthority) {
  const planned = plan(store, { kind: "verify", sessionId: path.sessionId, path, file, authority });
  return { ok: !planned.problems.length, problems: planned.problems, lengths: planned.lengths, planned: planned.knowledge };
}
