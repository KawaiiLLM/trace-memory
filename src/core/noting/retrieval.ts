import type { Fact } from "../model/index.ts";
import type { Store } from "../store/index.ts";
import type { NotingScope } from "../workspace/index.ts";
import { parseBlocks, type WorkspaceFile } from "../workspace/parse.ts";
import { list } from "../workspace/plan.ts";
import { knowledgeStaleLabel } from "../render/index.ts";

function seeds(file: WorkspaceFile) {
  const blocks = parseBlocks(file).blocks.filter(block => block.op !== "none" && !block.fields.get("verdict")?.value.startsWith("reverted — "));
  return { objects: [...new Set(blocks.flatMap(block => list(block.fields.get("objects")?.value)))],
    titles: blocks.map(block => block.fields.get("title")?.value ?? "").filter(Boolean) };
}

export function relatedFacts(store: Store, scope: NotingScope, file: WorkspaceFile, cap: number): string {
  const { objects, titles } = seeds(file), found = new Map<number, Fact>();
  const path = { sessionId: scope.sessionId, branch: scope.branch, headTurnId: Number(scope.range.to.split("/T")[1]) };
  const snapshot = store.pathSnapshot(path);
  const add = (fact: Fact) => { if (store.factOnPath(fact, path, snapshot)) found.set(fact.id, fact); };
  for (const object of objects) for (const fact of store.factsMentioningObject(object)) add(fact);
  for (const text of [...titles, ...objects]) {
    const terms = text.match(/[\p{L}\p{N}_./-]+/gu) ?? [];
    if (!terms.length) continue;
    for (const address of store.searchAddresses(terms, "facts")) { const fact = store.getFact(Number(address.slice(1))); if (fact) add(fact); }
    for (const address of store.searchAddresses(terms, "raw"))
      for (const fact of store.listTurnFacts(Number(address.slice(1)))) add(fact);
  }
  return "# Related facts\n\n" + ([...found.values()].slice(0, cap).map(fact =>
    `## F${fact.id}\ntitle: ${fact.title ?? "(untitled)"}\nobjects: ${(fact.objects ?? []).join(", ")}\n\n${fact.text}`).join("\n\n") || "None") + "\n";
}

/** Ruling 2026-10-23 「N的两次核实，都在开始注入新事实/知识检索到的事实/知识」: the knowledge check retrieves old knowledge from the new and
 * changed knowledge only (its titles, bodies and the objects of the facts it cites), never from the new facts directly. */
export function relatedKnowledge(store: Store, scope: NotingScope, files: { facts: WorkspaceFile; knowledge: WorkspaceFile }, cap: number): string {
  const facts = new Map(parseBlocks(files.facts).blocks.filter(block => block.op === "fact").map(block => [block.target, list(block.fields.get("objects")?.value)]));
  const blocks = parseBlocks(files.knowledge).blocks.filter(block => (block.op === "create" || block.op === "update") && !block.fields.get("verdict")?.value.startsWith("reverted — "));
  const path = { sessionId: scope.sessionId, branch: scope.branch, headTurnId: Number(scope.range.to.split("/T")[1]) };
  const visible = store.currentKnowledge(path), byRevision = new Map(visible.map(item => [item.revision.id, item]));
  const targets = new Set(blocks.flatMap(block => block.op === "update" ? [Number(block.target.match(/^K(\d+)/)?.[1])] : []));
  const ranked: number[][] = blocks.map(block => {
    const objects = new Set(list(block.fields.get("supports")?.value).flatMap(ref => /^F\d+$/.test(ref) ? store.getFact(Number(ref.slice(1)))?.objects ?? [] : facts.get(ref) ?? [])
      .map(object => object.toLowerCase()));
    const byObjects = objects.size ? visible.map(item => ({ id: item.knowledge.id, shared: store.knowledgeObjects(item.revision.id).filter(entry => objects.has(entry.object.toLowerCase())).length }))
      .filter(hit => hit.shared).sort((a, b) => b.shared - a.shared).map(hit => hit.id) : [];
    // The whole body: on 150 historical merges, title plus first sentence found the survivor in the top 20 for 68%, the whole body for 85%.
    const query = `${block.fields.get("title")?.value ?? ""} ${block.body}`;
    const byText = store.similarKnowledge(query, [...byRevision.keys()], cap).map(id => byRevision.get(id)!.knowledge.id);
    return [...byObjects, ...byText];
  });
  // Round-robin over the blocks so one block cannot take the whole cap; the items being updated are already in view.
  const found = new Set<number>();
  for (let rank = 0; found.size < cap && ranked.some(hits => rank < hits.length); rank++)
    for (const hits of ranked) { const id = hits[rank]; if (id !== undefined && !targets.has(id) && found.size < cap) found.add(id); }
  return "# Related knowledge\n\n" + ([...found].map(id => visible.find(item => item.knowledge.id === id)).filter(item => item !== undefined).map(({ revision }) =>
    `## K${revision.knowledgeId}@v${store.versionOrdinal(revision.knowledgeId, revision.id)}${knowledgeStaleLabel({ staleReasons: store.knowledgeStaleReasons(revision.id) })}\ntitle: ${revision.title ?? "(untitled)"}\ncategory: ${revision.category}\nscope: ${revision.scope}\nfiles: ${revision.files === undefined ? "(not mapped)" : revision.files === null ? "None" : revision.files.join(", ")}\n\n${revision.text}`).join("\n\n") || "None") + "\n";
}
