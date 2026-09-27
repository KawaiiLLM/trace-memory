import { afterEach, beforeEach, expect, test } from "vitest";
import { sourceSeededMemory } from "../../source-fixture.ts";
import { readHandle } from "../../read-handle-fixture.ts";
import { fact } from "../../support/seed.ts";
import { suppliedHandles } from "../../dreaming-skips.ts";
import { wholeTrace } from "../../trace-pages.ts";
import { toolDefinitions, tokens, type ListingOptions } from "../../../src/core/api/index.ts";
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
      const baseAddress = readHandle(input.tools, history(base)), triggerAddress = readHandle(input.tools, history(trigger));
      const supplied = new Set(suppliedHandles(input.material.changed)); supplied.delete(history(base)); supplied.delete(history(trigger));
      const receipt = JSON.parse(input.tools.find(tool => tool.name === "memory")!.execute({ operations: [
        { op: "update", id: baseAddress, text, scope, category, topics, supports: supports.map(id => `F${id}`), reason: `Reason ${text}` },
        { op: "archive", id: triggerAddress, supports: supports.map(id => `F${id}`), reason: "Retire the explicit selection trigger." },
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
  for (const definition of toolDefinitions.filter(tool => tool.name === "trace" || tool.name === "search"))
    expect(definition.parameters.properties).not.toHaveProperty("where");
  const tools = memory.tools({ kind: "manual", sessionId: own.sessionId, currentTurnId: own.turn.id, branch: "main" });
  const first = tools[1]!.execute({ query: "needle", scope: "global", cap: 1 });
  const cursor = /cursor=(\S+)/.exec(first)![1];
  expect(tools[1]!.execute({ query: "", cursor, where: "all" })).toContain("rejected: unexpected parameter");
  expect(() => memory.search("", undefined, { ...own, cursor, where: "all" } as ListingOptions)).toThrow("where is removed");
  expect(tools[1]!.execute({ query: "", cursor, scope: "project" })).toContain("cursor scope is frozen");
  expect(tools[1]!.execute({ query: "", cursor, scope: "global" })).not.toContain("rejected:");
  const trace = tools[0]!.execute({ address: "K1@v1", cap: 1 });
  const traceCursor = /cursor=(\S+)/.exec(trace)![1];
  expect(tools[0]!.execute({ address: `cursor=${traceCursor}`, where: "all" })).toContain("rejected: unexpected parameter");
  expect(() => memory.trace(`cursor=${traceCursor}`, { ...own, where: "all" } as ListingOptions)).toThrow("where is removed");
  expect(tools[0]!.execute({ address: `cursor=${traceCursor}` })).not.toContain("rejected:");
  expect(tools[1]!.execute({ query: "needle", category: "reference", layer: "facts" })).toContain("category filter requires layer knowledge");
  expect(identities(tools[1]!.execute({ query: "needle", category: "reference" })).every(id => id.startsWith("K"))).toBe(true);
});

test("41 named collections intersect scope and never widen explicit addresses", async () => {
  const { own, peer, foreign, knowledge } = await scopeCorpus();
  for (const scope of [undefined, "session", "project", "global"] as const) {
    const options = { ...foreign, scope };
    const text = wholeTrace(memory, `S${own.sessionId}`, options);
    expect(text).toContain(`needle own Raw`);
    expect(text).not.toContain(`needle peer Raw`);
    expect(text).not.toContain(`needle foreign Raw`);
    expect(text).not.toContain(`[F`); expect(text).not.toContain(`[K`);
    expect(memory.trace(`S${own.sessionId}`, options)).toContain(`selected: S${own.sessionId} Raw only`);
  }
  for (const scope of [undefined, "project", "global"] as const) {
    const text = wholeTrace(memory, "own", { ...foreign, scope });
    for (const who of [own, peer]) expect(text).toContain(`[F${who.factId}]`);
    expect(text).not.toContain(`[F${foreign.factId}]`);
    for (const k of knowledge) {
      const selected = (!scope || k.scope === scope) && (k.scope === "global" || k.scope === "project" && k.owner.projectId === own.projectId);
      expect(text.includes(`[K${k.knowledgeId}@${k.commit}]`)).toBe(selected);
    }
  }
  const alias = memory.store.createProject({ name: "old-name", declaredBy: "mark" });
  memory.store.mergeProject(alias.id, own.projectId);
  expect(wholeTrace(memory, "old-name", { ...foreign, scope: "project" })).toBe(wholeTrace(memory, "own", { ...foreign, scope: "project" }));
  for (const options of [{ scope: "session" as const }, { ...own, scope: "session" as const }])
    expect(() => memory.trace("own", options)).toThrow("scope:session requires a session context");
  // Exact evidence ignores scope even when that scope cannot resolve an implicit owner context.
  for (const address of [`F${foreign.factId}`, `T${foreign.turn.id}`, history(knowledge.at(-1)!)])
    expect(body(memory.trace(address, { scope: "session", category: "open" }))).toBe(body(memory.trace(address)));
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
  for (const versions of ["current", "history", "all"] as const) {
    const text = wholeTrace(memory, "paging", { ...who, versions, cap: 1 });
    expect([...text.matchAll(/^\[K1@\d+\]/gm)]).toHaveLength(1);
    expect(text).not.toContain("Applicable history"); expect(text).not.toContain("Reason needle");
  }
  const history = wholeTrace(memory, `K${old.knowledgeId}`, { ...who, versions: "history", cap: 1 });
  expect(history.match(/^  K1@\d+ /gm)).toHaveLength(25);
  expect(history).toContain("reason: Reason needle");
  expect(() => memory.trace(`K${old.knowledgeId}..`, who)).toThrow(/invalid public trace address/);
  const explicit = wholeTrace(memory, Array.from({ length: 25 }, (_, index) => `K${old.knowledgeId}@v${index + 1}`).join(","), { ...who, cap: 1 });
  expect(explicit.match(/^\[K1@\d+\]/gm)).toHaveLength(25);
  const repeated = wholeTrace(memory, `K1,K1`, { ...who, versions: "history", cap: 1 });
  expect(repeated.match(/^  K1@\d+ /gm)).toHaveLength(50);
});

test("64b global current ignores parent scope while explicit history remains filterable", async () => {
  const own = owner("parent"), foreign = owner("elsewhere");
  const old = await own.put("needle private parent", "project");
  const widened = await own.put("needle global child", "global", [], old);
  expect(identities(memory.search("needle", "knowledge", { ...foreign, scope: "global" }))).toEqual([`K${widened.knowledgeId}@${widened.commit}`]);
  const all = memory.search("needle", "knowledge", { ...foreign, scope: "global", versions: "all" });
  expect(identities(all)).toEqual([`K${widened.knowledgeId}@${widened.commit}`]);
  expect(all).not.toContain(`[K${old.knowledgeId}@${old.commit}]`);
  const exact = wholeTrace(memory, `${history(old)},${history(widened)}`, { ...foreign, scope: "global" });
  expect(exact).toContain("needle private parent");
  expect(exact).toContain("needle global child");
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
    const survivorTag = readHandle(input.tools, history(survivor)), absorbedTag = readHandle(input.tools, history(absorbed));
    const merged = JSON.parse(write.execute({ operations: [{ op: "merge", id: survivorTag,
      absorb: [absorbedTag], text: "needle combined", scope: "project", category: "reference",
      topics: [], supports: who.supports.map(id => `F${id}`), reason: "Merge" }], skipped: [] }));
    result = committedVersion(merged.committed[0]);
    expect(identities(memory.search("needle", "knowledge", who))).toEqual([`K${result.knowledgeId}@${result.commit}`]);
    expect(memory.search("absorbed", "knowledge", { ...who, versions: "history" })).toContain(`superseded on this path by K${result.knowledgeId}@${result.commit}`);
    const resultTag = readHandle(input.tools, history(result));
    write.execute({ operations: [{ op: "archive", id: resultTag, supports: who.supports.map(id => `F${id}`), reason: "Archive" },
      { op: "archive", id: readHandle(input.tools, history(trigger)), supports: who.supports.map(id => `F${id}`), reason: "Retire the explicit lifecycle trigger." }], skipped: [] });
    expect(input.tools.find(tool => tool.name === "check")!.execute({})).toContain("Blockers: none");
    return { outcome: "success", output: "lifecycle complete", request: { fixture: "lifecycle merge and archive" } };
  });
  expect(dreamed.outcome, JSON.stringify(dreamed)).toBe("success");
  expect(identities(memory.search("", "knowledge", who))).toEqual([]);
  const historyText = memory.search("", "knowledge", { ...who, versions: "history" });
  expect(identities(historyText)).toHaveLength(3);
  expect(historyText).toContain(`[K${trigger.knowledgeId}@`);
  expect(historyText).toContain("archived on this path");
  expect(wholeTrace(memory, "lifecycle", { ...who, versions: "all" }).match(/^\[K\d+@\d+\]/gm)).toHaveLength(3);
  expect(wholeTrace(memory, `R${memory.store.listRuns(who.sessionId).at(-1)!.id}`, who)).toContain("Archive");
});

test("41 collection knowledge status spends the item ceiling and all receipts spend each page", async () => {
  const who = owner("budget");
  await who.put("needle " + "body ".repeat(500));
  const fields = ["text", "status"] as const;
  const text = wholeTrace(memory, "budget", { ...who, fields, itemBudget: 100, maxTokens: 180 });
  const knowledge = text.slice(0, text.indexOf("\n[T"));
  expect(knowledge).toContain("characters truncated");
  expect(knowledge).toContain("status: tip");
  expect(memory.trace("budget", { ...who, fields, itemBudget: 100, maxTokens: 180 })).toContain("One representative per K");
  expect(tokens(knowledge)).toBeLessThanOrEqual(100);
});

test("92 complete collections expose tags, metadata and history references do not; tags never override writer authority", async () => {
  const who = owner("authority");
  const old = await who.put("old body"), current = await who.put("new body", "project", [], old);
  const tools = memory.tools({ kind: "manual", sessionId: who.sessionId, currentTurnId: who.turn.id, branch: who.branch });
  const currentTag = `K1#${memory.store.versionTag(1, current.commit)}`;
  const oldTag = `K1#${memory.store.versionTag(1, old.commit)}`;
  const collection = tools[0]!.execute({ address: "authority", full: true });
  expect(collection).toContain("new body");
  expect(collection).toContain(currentTag);
  expect(tools[0]!.execute({ address: "K1", fields: ["supports"] })).not.toMatch(/K1#[a-z]+/);
  const historyText = tools[0]!.execute({ address: "K1", versions: "history", full: true });
  expect(historyText).toContain("[K1@v1]");
  expect(historyText).toContain(oldTag);
  const historyMetadata = tools[0]!.execute({ address: "K1", versions: "history", fields: ["status", "supports"] });
  expect(historyMetadata).toContain("K1@v1");
  expect(historyMetadata).not.toMatch(/K1#[a-z]+/);
  const update = JSON.parse(tools[3]!.execute({ operations: [{ op: "update", id: currentTag,
    text: "edited", category: "reference", scope: "project", supports: [`F${who.factId}`], topics: [], reason: "Edit" }], skipped: [] }));
  expect(update.results[0]).toContain("update belongs to the Dreamer");
  const archive = (id: string) => JSON.parse(tools[3]!.execute({ operations: [{ op: "archive", id,
    supports: [`F${who.factId}`], reason: "Retire" }], skipped: [] }));
  expect(archive(oldTag).results[0]).toContain("base is not the latest effective applicable revision");
  expect(archive(currentTag).committed).toHaveLength(1);
});
