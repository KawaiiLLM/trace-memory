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

export function relatedKnowledge(store: Store, scope: NotingScope, files: { facts: WorkspaceFile; knowledge: WorkspaceFile }, cap: number): string {
  const { objects, titles } = seeds(files.facts), changes = seeds(files.knowledge);
  const path = { sessionId: scope.sessionId, branch: scope.branch, headTurnId: Number(scope.range.to.split("/T")[1]) };
  const visible = store.currentKnowledge(path), found = new Set<number>();
  const wanted = new Set(objects.map(object => object.toLowerCase()));
  for (const item of visible) if (store.knowledgeObjects(item.revision.id).some(entry => wanted.has(entry.object.toLowerCase()))) found.add(item.knowledge.id);
  for (const text of [...titles, ...objects, ...changes.titles]) {
    const terms = text.match(/[\p{L}\p{N}_./-]+/gu) ?? [];
    if (terms.length) for (const id of store.searchKnowledge(terms)) found.add(id);
  }
  return "# Related knowledge\n\n" + ([...found].map(id => visible.find(item => item.knowledge.id === id)).filter(item => item !== undefined).slice(0, cap).map(({ revision }) =>
    `## K${revision.knowledgeId}@v${store.versionOrdinal(revision.knowledgeId, revision.id)}${knowledgeStaleLabel({ staleReasons: store.knowledgeStaleReasons(revision.id) })}\ntitle: ${revision.title ?? "(untitled)"}\ncategory: ${revision.category}\nscope: ${revision.scope}\nfiles: ${revision.files === undefined ? "(not mapped)" : revision.files === null ? "None" : revision.files.join(", ")}\n\n${revision.text}`).join("\n\n") || "None") + "\n";
}
