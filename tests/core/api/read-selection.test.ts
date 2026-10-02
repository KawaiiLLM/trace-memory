import { afterEach, beforeEach, expect, test } from "vitest";
import { sourceSeededMemory, memoryFiles } from "../../source-fixture.ts";
import { readHandle } from "../../read-handle-fixture.ts";
import { fact } from "../../support/seed.ts";
import { suppliedHandles } from "../../dreaming-skips.ts";
import { toolDefinitions, type ListingOptions } from "../../../src/core/api/index.ts";
import type { KnowledgeCategory, KnowledgeScope } from "../../../src/core/model/index.ts";
import { AdmittedDreamerScenarios, createDreamerTrigger } from "../../admitted-dreamer-scenario.ts";

const time = "2026-09-15T00:00:00Z";

function history(version: { knowledgeId: number; commit: number }) {
  return `K${version.knowledgeId}@v${memory.store.versionOrdinal(version.knowledgeId, version.commit)}`;
}
function committedVersion(item: { knowledgeId: number; version: string }) {
  const ordinal = Number(/@v(\d+)$/.exec(item.version)![1]);
  return { knowledgeId: item.knowledgeId, commit: memory.store.resolveVersionOrdinal(item.knowledgeId, ordinal) };
}
let memory: ReturnType<typeof sourceSeededMemory>, scenarios: AdmittedDreamerScenarios;
beforeEach(() => {
  scenarios = new AdmittedDreamerScenarios(async () => { throw new Error("no model calls"); });
  memory = sourceSeededMemory(":memory:", scenarios.agent);
});
afterEach(() => memory.close());
const body = (text: string) => text.split("\n\nReceipts:")[0]!;
const identities = (text: string) => [...body(text).matchAll(/^\[(K\d+@\d+|F\d+|S\d+\/T\d+)\]/gm)].map(m => m[1]!);
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
      const result = memory.store.commitConsolidationRun({ path, run, operations: [{ op: "create", handle: "new", author: "fixture", text, scope, category, topics, supports, reason: `Reason ${text}`, createdAt: time }] });
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
      const receipt = JSON.parse(input.tools.find(tool => tool.name === "memory")!.execute({ operations: [
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
    const selectedKnowledge = knowledge.filter(k => (!scope || k.scope === scope) && (k.scope === "global"
      || k.scope === "project" && k.owner.projectId === own.projectId || k.scope === "session" && k.owner.sessionId === own.sessionId));
    const expected = [...(layer === "facts" || layer === "all" ? selectedOwners.map(who => `F${who.factId}`) : []),
      ...(layer === "knowledge" || layer === "all" ? selectedKnowledge.map(k => `K${k.knowledgeId}@${k.commit}`) : []),
      ...(layer === "raw" || layer === "all" ? selectedOwners.map(who => `S${who.sessionId}/T${who.turn.id}`) : [])];
    const result = memory.search("needle", layer, { ...own, scope, maxTokens: 8000 });
    expect(identities(result)).toEqual(expected);
    if (layer === "all") expect(identities(memory.search("needle", undefined, { ...own, scope, maxTokens: 8000 }))).toEqual(expected);
    if (scope === "global") expect(result).toContain("all sessions; global knowledge");
  });
}

test("41 unbound discovery, missing contexts and obsolete input are explicit", async () => {
  const { own, knowledge } = await scopeCorpus();
  expect(identities(memory.search("needle", "knowledge", { maxTokens: 8000 }))).toHaveLength(knowledge.length);
  expect(identities(memory.search("needle", "knowledge", { scope: "global" }))).toHaveLength(3);
  for (const scope of ["session", "project"] as const) for (const layer of ["facts", "raw", "knowledge", "all"] as const)
    expect(() => memory.search("needle", layer, { scope })).toThrow(`scope:${scope} requires`);
  for (const definition of toolDefinitions.filter(tool => tool.name === "search"))
    expect(definition.parameters.properties).not.toHaveProperty("where");
  const tools = memory.tools({ kind: "manual", sessionId: own.sessionId, currentTurnId: own.turn.id, branch: "main" });
  const search = tools.find(tool => tool.name === "search")!;
  const first = search.execute({ query: "needle", scope: "global", cap: 1 });
  const cursor = /cursor=(\S+)/.exec(first)![1];
  expect(search.execute({ query: "", cursor, where: "all" })).toContain("rejected: unexpected parameter");
  expect(() => memory.search("", undefined, { ...own, cursor, where: "all" } as ListingOptions)).toThrow("where is removed");
  expect(search.execute({ query: "", cursor, scope: "project" })).toContain("cursor scope is frozen");
  expect(search.execute({ query: "", cursor, scope: "global" })).not.toContain("rejected:");
  expect(search.execute({ query: "needle", category: "reference", layer: "facts" })).toContain("category filter requires layer knowledge");
  expect(identities(search.execute({ query: "needle", category: "reference" })).every(id => id.startsWith("K"))).toBe(true);
});

test("exact fact and knowledge history reads remain unrestricted across discovery scopes", async () => {
  const { foreign, knowledge } = await scopeCorpus();
  const files = memoryFiles(memory, foreign);
  expect(files.read(`/tm/F${foreign.factId}`).content).toContain(`Needle foreign`);
  expect(files.read(`/tm/${history(knowledge.at(-1)!)}`).content).toContain("needle");
});

test("41 representatives use only admitted revisions; lexical score never ranks different K identities", async () => {
  const who = owner("selection");
  const old = await who.put("needle");
  const current = await who.put("needle plus irrelevant material", "project", [], old);
  const second = await who.put("needle");
  const near = await who.put("needl");
  const read = (query: string, options: ListingOptions = {}) => memory.search(query, "knowledge", { ...who, versions: "all", ...options });
  expect(identities(read("needle"))).toEqual([`K${old.knowledgeId}@${old.commit}`, `K${second.knowledgeId}@${second.commit}`]);
  expect(read("needle")).not.toContain(`[K${near.knowledgeId}@`);
  expect(identities(read("needle", { versions: "current" }))).toEqual([`K${current.knowledgeId}@${current.commit}`, `K${second.knowledgeId}@${second.commit}`]);
  expect(identities(read(""))[0]).toBe(`K${current.knowledgeId}@${current.commit}`);
  expect(identities(read("n"))[0]).toBe(`K${current.knowledgeId}@${current.commit}`); // zero bigrams => current/newer tie
  const topic = await who.put("otherwise unrelated", "project", ["needle"], current);
  expect(identities(read("needle"))[0]).toBe(`K${topic.knowledgeId}@${topic.commit}`); // topic and old text tie; current wins
  const noMatch = await who.put("otherwise unrelated", "project", [], topic);
  expect(identities(read("needle"))[0]).toBe(`K${topic.knowledgeId}@${topic.commit}`); // nonmatching current cannot enter
  expect(identities(read("needle", { versions: "current" }))).toEqual([`K${second.knowledgeId}@${second.commit}`]);
  expect(read("needle")).not.toContain(`[K${noMatch.knowledgeId}@${noMatch.commit}]`);
});

test("41 category and revision scope filter before choosing a representative", async () => {
  const who = owner("filters");
  const old = await who.put("needle", "global", [], undefined, "open");
  const current = await who.put("needle more words", "project", [], old, "reference");
  const read = (options: ListingOptions) => identities(memory.search("needle", "knowledge", { ...who, versions: "all", ...options }));
  expect(read({})).toEqual([`K${old.knowledgeId}@${old.commit}`]);
  expect(read({ category: "reference" })).toEqual([`K${current.knowledgeId}@${current.commit}`]);
  expect(read({ scope: "project" })).toEqual([`K${current.knowledgeId}@${current.commit}`]);
  expect(read({ scope: "global" })).toEqual([`K${old.knowledgeId}@${old.commit}`]);
  expect(read({ scope: "global", category: "reference" })).toEqual([]);
});

test("41 long histories select before paging and freeze bodies, status and owner membership", async () => {
  const who = owner("paging");
  const old = await who.put("needle", "project", ["needle"]);
  const next = await who.put("needle", "project", []);
  let tip = old;
  for (let i = 0; i < 24; i++) tip = await who.put(`needle revision ${i}`, "project", [], tip);
  const options = { ...who, versions: "all" as const, fields: ["text", "status"] as const };
  const expected = body(memory.search("needle", "knowledge", options));
  expect(identities(expected)).toEqual([`K${old.knowledgeId}@${old.commit}`, `K${next.knowledgeId}@${next.commit}`]);
  const first = memory.search("needle", "knowledge", { ...options, cap: 1 });
  const cursor = /cursor=(\S+)/.exec(first)![1];
  const changed = await who.put("needle", "project", [], next);
  await who.put("needle later identity");
  expect(() => memory.search("", "knowledge", { ...who, cursor, category: "open" })).toThrow("cursor category is frozen");
  expect(() => memory.search("", "knowledge", { ...who, cursor, scope: "project" })).toThrow("cursor scope is frozen");
  const last = memory.search("", "knowledge", { ...who, cursor, branch: "moved", headTurnId: null, fields: options.fields });
  expect(body(first) + "\n" + body(last)).toBe(expected);
  expect(last).not.toContain(`[K${changed.knowledgeId}@${changed.commit}]`);
  expect(last).not.toContain("cursor=");
  const files = memoryFiles(memory, who);
  expect(files.read(`/tm/K${old.knowledgeId}.history`).content.match(/^  K1@v\d+ /gm)).toHaveLength(25);
  expect(files.read(`/tm/K${old.knowledgeId}.history`).content).toContain("reason: Reason needle");
  expect(() => files.read(`/tm/K${old.knowledgeId}..`)).toThrow();
});

test("64b global current ignores parent scope while explicit history remains filterable", async () => {
  const own = owner("parent"), foreign = owner("elsewhere");
  const old = await own.put("needle private parent", "project");
  const widened = await own.put("needle global child", "global", [], old);
  expect(identities(memory.search("needle", "knowledge", { ...foreign, scope: "global" }))).toEqual([`K${widened.knowledgeId}@${widened.commit}`]);
  const all = memory.search("needle", "knowledge", { ...foreign, scope: "global", versions: "all" });
  expect(identities(all)).toEqual([`K${widened.knowledgeId}@${widened.commit}`]);
  expect(all).not.toContain(`[K${old.knowledgeId}@${old.commit}]`);
  const files = memoryFiles(memory, foreign);
  expect(files.read(`/tm/${history(old)}`).content).toContain("needle private parent");
  expect(files.read(`/tm/${history(widened)}`).content).toContain("needle global child");
  expect(identities(memory.search("needle", "knowledge", { ...foreign, versions: "all", scope: "project" }))).toEqual([]);
});

test("41 archives and merged-away identities have no current body but remain historical candidates", async () => {
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
    const merged = JSON.parse(write.execute({ operations: [{ op: "merge", id: survivorTag,
      absorb: [absorbedTag], text: "needle combined", scope: "project", category: "reference",
      topics: [], supports: who.supports.map(id => `F${id}`), reason: "Merge" }], skipped: [] }));
    result = committedVersion(merged.committed[0]);
    expect(identities(memory.search("needle", "knowledge", who))).toEqual([`K${result.knowledgeId}@${result.commit}`]);
    expect(memory.search("absorbed", "knowledge", { ...who, versions: "history" })).toContain(`superseded on this path by K${result.knowledgeId}@${result.commit}`);
    const resultTag = readHandle(path => files.read(path).content, history(result));
    write.execute({ operations: [{ op: "archive", kind: "budget", id: resultTag, supports: who.supports.map(id => `F${id}`), reason: "Archive" },
      { op: "archive", kind: "budget", id: readHandle(path => files.read(path).content, history(trigger)), supports: who.supports.map(id => `F${id}`), reason: "Retire the explicit lifecycle trigger." }], skipped: [] });
    expect(input.tools.find(tool => tool.name === "check")!.execute({})).toContain("Blockers: none");
    return { outcome: "success", output: "lifecycle complete", request: { fixture: "lifecycle merge and archive" } };
  });
  expect(dreamed.outcome, JSON.stringify(dreamed)).toBe("success");
  expect(identities(memory.search("", "knowledge", who))).toEqual([]);
  const historyText = memory.search("", "knowledge", { ...who, versions: "history" });
  expect(identities(historyText)).toHaveLength(3);
  expect(historyText).toContain(`[K${trigger.knowledgeId}@`);
  expect(historyText).toContain("archived on this path");
  expect(memoryFiles(memory, who).read("/tm/knowledge-all").content).toContain(`/tm/K${survivor.knowledgeId}@v`);
});

test("exact knowledge reads are whole rather than Core item-budgeted", async () => {
  const who = owner("budget");
  const item = await who.put("needle " + "body ".repeat(500));
  const file = memoryFiles(memory, who).read(`/tm/K${item.knowledgeId}`);
  expect(file.content).toContain("body ".repeat(500));
  expect(file.content).not.toContain("characters truncated");
});

test("92 complete collections expose tags, metadata and history references do not; tags never override writer authority", async () => {
  const who = owner("authority");
  const old = await who.put("old body"), current = await who.put("new body", "project", [], old);
  const tools = memory.tools({ kind: "manual", sessionId: who.sessionId, currentTurnId: who.turn.id, branch: who.branch });
  const currentTag = `K1#${memory.store.versionTag(1, current.commit)}`;
  const oldTag = `K1#${memory.store.versionTag(1, old.commit)}`;
  const files = memoryFiles(memory, who);
  expect(files.read("/tm/K1").content).toContain("new body");
  expect(files.read("/tm/K1").content).toContain(currentTag);
  const historyText = files.read("/tm/K1.history").content;
  expect(historyText).toContain("K1@v1");
  expect(historyText).toContain("reason: Reason old body");
  const write = tools.find(tool => tool.name === "memory")!;
  const update = write.execute({ op: "update", id: currentTag,
    text: "edited", category: "reference", scope: "project", supports: [`F${who.factId}`], topics: [], reason: "Edit" });
  expect(update).toContain("update belongs to the Dreamer");
  const archive = (id: string) => write.execute({ op: "archive", kind: "budget", id,
    supports: [`F${who.factId}`], reason: "Retire" });
  expect(archive(oldTag)).toContain("base is not the latest effective applicable revision");
  expect(JSON.parse(archive(currentTag)).committed).toHaveLength(1);
});
