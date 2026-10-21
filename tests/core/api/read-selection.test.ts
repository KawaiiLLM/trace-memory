import { afterEach, beforeEach, expect, test } from "vitest";
import { sourceSeededMemory, memoryFiles } from "../../source-fixture.ts";
import { readHandle } from "../../read-handle-fixture.ts";
import { fact, receiptCommit } from "../../support/seed.ts";
import { dreamerWrite, suppliedHandles } from "../../dreaming-skips.ts";
import { toolDefinitions, type SearchOptions } from "../../../src/core/api/index.ts";
import type { KnowledgeCategory, KnowledgeScope } from "../../../src/core/model/index.ts";
import { AdmittedDreamerScenarios, createDreamerTrigger } from "../../admitted-dreamer-scenario.ts";

const time = "2026-09-15T00:00:00Z";

function history(version: { knowledgeId: number; commit: number }) {
  return `K${version.knowledgeId}@v${memory.store.versionOrdinal(version.knowledgeId, version.commit)}`;
}
function committedVersion(item: { knowledgeId: number; version: string }) {
  return { knowledgeId: item.knowledgeId, commit: receiptCommit(memory.store, item) };
}
let memory: ReturnType<typeof sourceSeededMemory>, scenarios: AdmittedDreamerScenarios;
beforeEach(() => {
  scenarios = new AdmittedDreamerScenarios(async () => { throw new Error("no model calls"); });
  memory = sourceSeededMemory(":memory:", scenarios.agent);
});
afterEach(() => memory.close());
const body = (text: string) => text.split("\n\nReceipts:")[0]!;
/** Each hit's citation label, with a Raw hit reduced to its Turn, in print order. */
const identities = (text: unknown) => [...String(text).matchAll(/^\[(K\d+@v\d+|F\d+|S\d+\/T\d+)(?:#E\d+@\w+)?\]/gm)].map(m => m[1]!);
function owner(name: string, projectId = memory.store.createProject({ name, declaredBy: "mark" }).id) {
  const session = memory.store.createSession({ host: "fixture", projectId, startedAt: time, firstReplyAt: time, enrollmentChoice: true });
  const turn = memory.store.appendTurn({ sessionId: session.id, kind: "turn", userPrompt: `needle ${name} Raw`, startedAt: time });
  const entry = memory.store.getSourceEntry(memory.store.listSourceEntries(session.id, turn.id).at(-1)!.id)!;
  memory.selectEntries(session.id, "main", [entry.id]);
  const path = { sessionId: session.id, headTurnId: turn.id, branch: "main", triggerEntryId: entry.id };
  const run = { kind: "manual" as const, sessionId: session.id, branch: "main", createdAt: time };
  const supports = [fact(memory, path, `Needle ${name}`, [{ entry, text: `needle ${name} fact` }]).id];
  const put = async (text: string, scope: KnowledgeScope = "project", topics: string[] = [], base?: { knowledgeId: number; commit: number }, category: KnowledgeCategory = "reference") => {
    if (!base) {
      const result = memory.store.commitConsolidationRun({ path, run, operations: [{ op: "create", title: "Fixture title", handle: "new", author: "fixture", text, scope, category, topics, supports, reason: `Reason ${text}`, createdAt: time }] });
      if (!result.ok) throw new Error(result.problems.join("; "));
      return result.committed[0]!;
    }
    const poolScope = memory.store.knowledgeRevision(base.commit)!.scope;
    const trigger = createDreamerTrigger(memory, path, supports[0]!, memory.store.listKnowledgeRevisions().length + 1, poolScope);
    let changed!: { knowledgeId: number; commit: number };
    const dreamed = await scenarios.run(memory, path, input => {
      const request = { fixture: "read selection revision" }; input.reportRequest(request);
      const files = memoryFiles(memory, input.reader!);
      const baseAddress = readHandle(address => files.read(address).content, history(base)), triggerAddress = readHandle(address => files.read(address).content, history(trigger));
      const supplied = new Set(suppliedHandles(input.material.changed)); supplied.delete(history(base)); supplied.delete(history(trigger));
      const receipt = JSON.parse(dreamerWrite(input.tools.find(tool => tool.name === "memory")!, { operations: [
        { op: "update", id: baseAddress, text, scope, category, topics, supports: supports.map(id => `F${id}`), reason: `Reason ${text}` },
        { op: "archive", kind: "budget", id: triggerAddress, supports: supports.map(id => `F${id}`), reason: "Retire the explicit selection trigger." },
      ], skipped: [...supplied].map(knowledge => ({ knowledge, because: "No maintenance is needed for this supplied fixture item." })) }));
      changed = committedVersion(receipt.committed.find((item: { knowledgeId: number }) => item.knowledgeId === base.knowledgeId)!);
      expect(input.tools.find(tool => tool.name === "check")!.execute({})).toContain("Blockers: none");
      return { outcome: "success", output: "selection revision complete", request };
    });
    if (dreamed.outcome !== "success") throw new Error(JSON.stringify(dreamed));
    return changed;
  };
  return { ...path, projectId, turn, run, supports, factId: supports[0]!, put };
}
async function scopeCorpus() {
  const own = owner("own"), peer = owner("peer", own.projectId), foreign = owner("foreign");
  const knowledge = (await Promise.all([own, peer, foreign].flatMap(who => (["global", "project", "session"] as const).map(async scope => ({
    ...await who.put(`needle ${who.sessionId} ${scope}`, scope), owner: who, scope,
  })))));
  return { own, peer, foreign, knowledge };
}

for (const scope of [undefined, "session", "project", "global"] as const) {
  for (const layer of ["facts", "knowledge", "raw", "all"] as const) test(`41 scope table: ${scope ?? "omitted"} / ${layer}`, async () => {
    const { own, peer, foreign, knowledge } = await scopeCorpus();
    const selectedOwners = scope === "global" ? [own, peer, foreign] : scope === "session" ? [own] : [own, peer];
    // 136 ruling 1 (2026-10-10, supersedes the strict `project` row of 41): `project` is the default, so it selects what
    // omitting scope selects: everything this project can see.
    const selectedKnowledge = knowledge.filter(k => (!scope || scope === "project" || k.scope === scope) && (k.scope === "global"
      || k.scope === "project" && k.owner.projectId === own.projectId || k.scope === "session" && k.owner.sessionId === own.sessionId));
    const expected = [...(layer === "knowledge" || layer === "all" ? selectedKnowledge.map(k => `K${k.knowledgeId}@v1`) : []),
      ...(layer === "facts" || layer === "all" ? selectedOwners.map(who => `F${who.factId}`) : []),
      ...(layer === "raw" || layer === "all" ? selectedOwners.map(who => `S${who.sessionId}/T${who.turn.id}`) : [])];
    // Which hits a scope selects is the ruling; their order is not (each layer lists newest first).
    const result = memory.search("needle", layer, { ...own, scope, topk: 100 });
    expect(identities(result).sort()).toEqual(expected.sort());
    if (layer === "all") expect(identities(memory.search("needle", undefined, { ...own, scope, topk: 100 })).sort()).toEqual(expected.sort());
    if (scope === "project") expect(result).toEqual(memory.search("needle", layer, { ...own, topk: 100 }));
  });
}

test("41 unbound discovery, missing contexts and obsolete input are explicit", async () => {
  const { own, knowledge } = await scopeCorpus();
  expect(identities(memory.search("needle", "knowledge", { topk: 100 }))).toHaveLength(knowledge.length);
  expect(identities(memory.search("needle", "knowledge", { scope: "global" }))).toHaveLength(3);
  for (const layer of ["facts", "raw", "knowledge", "all"] as const) {
    expect(() => memory.search("needle", layer, { scope: "session" })).toThrow("scope:session requires");
    // 136 ruling 1: `project` is the default, so unbound it discovers every owner, as omitting it does.
    expect(memory.search("needle", layer, { scope: "project", topk: 100 })).toEqual(memory.search("needle", layer, { topk: 100 }));
  }
  for (const definition of toolDefinitions.filter(tool => tool.name === "search"))
    expect(definition.parameters.properties).not.toHaveProperty("where");
  const tools = memory.tools({ kind: "manual", sessionId: own.sessionId, currentTurnId: own.turn.id, branch: "main" });
  const search = tools.find(tool => tool.name === "search")!;
  expect(search.execute({ query: "needle", scope: "global", where: "all" })).toContain("rejected: unexpected parameter");
});

test("exact fact and knowledge history reads remain unrestricted across discovery scopes", async () => {
  const { foreign, knowledge } = await scopeCorpus();
  const files = memoryFiles(memory, foreign);
  expect(files.read(`trace://F${foreign.factId}`).content).toContain(`Needle foreign`);
  expect(files.read(`trace://${history(knowledge.at(-1)!)}`).content).toContain("needle");
});

test("41 revision scope filters every version, and a global filter sees only global revisions", async () => {
  const who = owner("filters");
  const old = await who.put("needle", "global", [], undefined, "open");
  const current = await who.put("needle more words", "project", [], old, "reference");
  const read = (options: SearchOptions) => identities(memory.search("needle", "knowledge", { ...who, ...options }));
  // Both versions are candidates; the scope filter judges each revision by its own scope.
  expect(read({}).sort()).toEqual([`K${old.knowledgeId}@v1`, `K${current.knowledgeId}@v2`].sort());
  // 136 ruling 1 (supersedes 41's strict project filter): `project` is the default, every applicable scope.
  expect(read({ scope: "project" }).sort()).toEqual(read({}).sort());
  expect(read({ scope: "session" })).toEqual([]);
  expect(read({ scope: "global" })).toEqual([`K${old.knowledgeId}@v1`]);
});

test("64b global current ignores parent scope while every version remains filterable", async () => {
  const own = owner("parent"), foreign = owner("elsewhere");
  const old = await own.put("needle private parent", "project");
  const widened = await own.put("needle global child", "global", [], old);
  const all = memory.search("needle", "knowledge", { ...foreign, scope: "global" });
  expect(identities(all)).toEqual([`K${widened.knowledgeId}@v2`]);
  expect(all).not.toContain(`[K${old.knowledgeId}@v1]`);
  const files = memoryFiles(memory, foreign);
  expect(files.read(`trace://${history(old)}`).content).toContain("needle private parent");
  expect(files.read(`trace://${history(widened)}`).content).toContain("needle global child");
  // 136 ruling 1: `project` is what omitting scope gives, so the global version shows and the other project's does not.
  expect(identities(memory.search("needle", "knowledge", { ...foreign, scope: "project" }))).toEqual([`K${widened.knowledgeId}@v2`]);
});

test("41 archives and merged-away identities have no current body but remain candidates, marked", async () => {
  const who = owner("lifecycle");
  // Ticket 44: the survivor is created first so its older address remains live.
  const survivor = await who.put("needle survivor"), absorbed = await who.put("needle absorbed");
  const trigger = createDreamerTrigger(memory, who, who.factId, 1);
  let result!: { knowledgeId: number; commit: number };
  const dreamed = await scenarios.run(memory, who, input => {
    input.reportRequest({ fixture: "lifecycle merge and archive" });
    const write = input.tools.find(tool => tool.name === "memory")!;
    const files = memoryFiles(memory, input.reader!);
    const survivorTag = readHandle(path => files.read(path).content, history(survivor)), absorbedTag = readHandle(path => files.read(path).content, history(absorbed));
    const merged = JSON.parse(dreamerWrite(write, { operations: [{ op: "merge", id: survivorTag,
      absorb: [absorbedTag], text: "needle combined", scope: "project", category: "reference",
      topics: [], supports: who.supports.map(id => `F${id}`), reason: "Merge" }], skipped: [] }));
    result = committedVersion(merged.committed[0]);
    const current = (memory.search("needle", "knowledge", who) as string).split("\n").filter(line => !/^\[K\d+@v\d+\] \((superseded|archived)\)/.test(line));
    expect(identities(current.join("\n"))).toEqual([`K${result.knowledgeId}@v${memory.store.versionOrdinal(result.knowledgeId, result.commit)}`]);
    expect(memory.search("absorbed", "knowledge", who)).toMatch(new RegExp(`\\[K${absorbed.knowledgeId}@v1\\] \\((superseded|archived)\\)`));
    const resultTag = readHandle(path => files.read(path).content, history(result));
    dreamerWrite(write, { operations: [{ op: "archive", kind: "budget", id: resultTag, supports: who.supports.map(id => `F${id}`), reason: "Archive" },
      { op: "archive", kind: "budget", id: readHandle(path => files.read(path).content, history(trigger)), supports: who.supports.map(id => `F${id}`), reason: "Retire the explicit lifecycle trigger." }], skipped: [] });
    expect(input.tools.find(tool => tool.name === "check")!.execute({})).toContain("Blockers: none");
    return { outcome: "success", output: "lifecycle complete", request: { fixture: "lifecycle merge and archive" } };
  });
  expect(dreamed.outcome, JSON.stringify(dreamed)).toBe("success");
  // No version is current any more: every hit is marked, and the archives are labelled as such.
  const historyText = memory.search("", "knowledge", { ...who, topk: 100 }) as string;
  expect(historyText.split("\n").every(line => /^\[K\d+@v\d+\] \((superseded|archived)\)/.test(line))).toBe(true);
  expect(historyText).toContain(`[K${trigger.knowledgeId}@`);
  expect(historyText).toContain("(archived)");
  expect(memoryFiles(memory, who).read("trace://knowledge-all").content).toContain(`trace://K${survivor.knowledgeId}@v`);
});

test("exact knowledge reads are whole rather than Core item-budgeted", async () => {
  const who = owner("budget");
  const item = await who.put("needle " + "body ".repeat(500));
  const file = memoryFiles(memory, who).read(`trace://K${item.knowledgeId}`);
  expect(file.content).toContain("body ".repeat(500));
  expect(file.content).not.toContain("characters truncated");
});

test("135/92: complete collections expose tags, metadata and history references do not; stale tags remain unwritable", async () => {
  const who = owner("authority");
  const old = await who.put("old body"), current = await who.put("new body", "project", [], old);
  const tools = memory.tools({ kind: "manual", sessionId: who.sessionId, currentTurnId: who.turn.id, branch: who.branch });
  const currentTag = `K1#${memory.store.versionTag(1, current.commit)}`;
  const oldTag = `K1#${memory.store.versionTag(1, old.commit)}`;
  const files = memoryFiles(memory, who);
  expect(files.read("trace://K1").content).toContain("new body");
  expect(files.read("trace://K1").content).toContain(currentTag);
  const historyText = files.read("trace://K1.history").content;
  expect(historyText).toContain("K1@v1");
  expect(historyText).toContain("reason: Reason old body");
  const write = tools.find(tool => tool.name === "memory")!;
  const archive = (id: string) => write.execute({ op: "archive", kind: "budget", id,
    supports: [`F${who.factId}`], reason: "Retire" });
  expect(archive(oldTag)).toContain("base is not the latest effective applicable revision");
  expect(JSON.parse(archive(currentTag)).committed).toHaveLength(1);
});
