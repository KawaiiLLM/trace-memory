import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { sourceSeededMemory, memoryFiles } from "../../source-fixture.ts";
import { dreamerWrite, suppliedHandles } from "../../dreaming-skips.ts";
import { legacyFacts } from "../../support/seed.ts";
import fixture from "../../fixtures/trace.json";
import { AdmittedDreamerScenarios, createDreamerTrigger } from "../../admitted-dreamer-scenario.ts";

let memory: ReturnType<typeof sourceSeededMemory>, scenarios: AdmittedDreamerScenarios;
let sessionId: number, headTurnId: number, triggerEntryId: number;
const time = "2026-09-07T00:00:00Z";
const reader = () => ({ sessionId, branch: "main", headTurnId });
const read = (address: string) => memoryFiles(memory, reader()).read(`trace://${address}`).content;
type Operation = Parameters<ReturnType<typeof sourceSeededMemory>["store"]["commitConsolidationRun"]>[0]["operations"][number];
async function consolidation(...operations: Operation[]) {
  if (operations.every(op => op.op === "create")) {
    const result = memory.store.commitConsolidationRun({ run: { kind: "manual", sessionId, createdAt: time }, operations });
    if (!result.ok) throw new Error(result.problems.join(", "));
    return result.committed;
  }
  const path = { sessionId, branch: "main", headTurnId, triggerEntryId };
  const first = operations.find(op => op.op !== "create")!;
  const base = first.op === "merge" ? first.intoBaseCommit : first.baseCommit;
  const trigger = createDreamerTrigger(memory, path, 1, memory.store.listKnowledgeRevisions().length + 1, memory.store.knowledgeRevision(base)!.scope);
  let committed: { knowledgeId: number; commit: number }[] = [];
  const dreamed = await scenarios.run(memory, path, input => {
    const request = { fixture: "knowledge maintenance" }; input.reportRequest(request);
    const write = input.tools.find(tool => tool.name === "memory")!;
    const addressed = new Set<string>();
    const exact = (id: number, commit: number) => {
      const address = `K${id}#${memory.store.versionTag(id, commit)}`;
      addressed.add(`K${id}@v${memory.store.versionOrdinal(id, commit)}`);
      expect(memoryFiles(memory, input.reader!).read(`trace://${address}`).content).toContain(address);
      return address;
    };
    const converted = operations.map(operation => {
      if (operation.op === "update") return { op: "update", id: exact(operation.knowledgeId, operation.baseCommit), text: operation.text,
        category: operation.category, scope: operation.scope, topics: operation.topics, supports: operation.supports.map(id => `F${id}`), reason: operation.reason };
      if (operation.op === "archive") return { op: "archive", kind: "budget", id: exact(operation.knowledgeId, operation.baseCommit),
        supports: operation.supports.map(id => `F${id}`), reason: operation.reason };
      if (operation.op === "merge") return { op: "merge", id: exact(operation.intoKnowledgeId, operation.intoBaseCommit),
        absorb: operation.absorb.map(parent => exact(parent.knowledgeId, parent.baseCommit)), text: operation.text,
        category: operation.category, scope: operation.scope, topics: operation.topics, supports: operation.supports.map(id => `F${id}`), reason: operation.reason };
      return operation;
    });
    const triggerAddress = exact(trigger.knowledgeId, trigger.commit);
    const supplied = new Set(suppliedHandles(input.material.changed));
    for (const address of addressed) supplied.delete(address);
    const receipt = JSON.parse(dreamerWrite(write, { operations: [...converted, { op: "archive", kind: "budget", id: triggerAddress,
      supports: ["F1"], reason: "Retire fixture trigger" }], skipped: [...supplied].map(knowledge => ({ knowledge, because: "No maintenance is needed for this supplied fixture item." })) }));
    committed = (receipt.committed ?? []).filter((item: { knowledgeId: number }) => item.knowledgeId !== trigger.knowledgeId)
      .map((item: { knowledgeId: number; version: string }) => ({ knowledgeId: item.knowledgeId,
        commit: memory.store.resolveVersionOrdinal(item.knowledgeId, Number(/@v(\d+)$/.exec(item.version)![1])) }));
    expect(input.tools.find(tool => tool.name === "check")!.execute({})).toContain("Blockers: none");
    return { outcome: "success", output: "maintenance complete", request };
  });
  if (dreamed.outcome !== "success") throw new Error(JSON.stringify(dreamed));
  return committed;
}
async function create(text = "use red tiles now") {
  return (await consolidation({ op: "create", topics: [], reason: "Initial admission", handle: "$e1", author: "test", text,
    category: "reference", scope: "project", supports: [1], createdAt: time }))[0]!.knowledgeId;
}
async function update(id: number, base: number, text: string) {
  return (await consolidation({ op: "update", topics: [], reason: "Correction", knowledgeId: id, baseCommit: base, text,
    category: "reference", scope: "project", supports: [1], createdAt: time }))[0]!;
}
beforeEach(() => {
  vi.useFakeTimers(); vi.setSystemTime(new Date(time));
  scenarios = new AdmittedDreamerScenarios(async () => { throw new Error("memory read must not call model"); });
  memory = sourceSeededMemory(":memory:", scenarios.agent);
  const project = memory.store.createProject({ name: "trace", declaredBy: "mark" });
  sessionId = memory.store.createSession({ enrollmentChoice: true, host: "test", projectId: project.id, startedAt: time, firstReplyAt: time }).id;
  const turn = memory.store.appendTurn({ sessionId, kind: "turn", userPrompt: "fixture trigger", startedAt: time });
  headTurnId = turn.id;
  triggerEntryId = memory.store.listSourceEntries(sessionId, turn.id).at(-1)!.id;
  memory.selectEntries(sessionId, "main", [triggerEntryId]);
  const source = memory.store.listSourceEntries(sessionId, turn.id)[0]!;
  const facts = legacyFacts(memory.store, { kind: "noting", sessionId, branch: "main", createdAt: time }, [
    { text: "original claim" },
    { text: "first correction", negate: [{ target: "$1", strength: "strong" as const }] },
    { text: "second correction", negate: [{ target: "$1", strength: "strong" as const }] },
    { text: "shared correction", negate: [{ target: "$2", strength: "strong" as const }, { target: "$3", strength: "strong" as const }] },
    { text: "weak objection", negate: [{ target: "$1", strength: "weak" as const }] },
    { text: "adoption", support: [{ target: "$1", strength: "strong" as const }] },
  ].map(f => ({ ...f, sources: [{ entry: source, address: `T${turn.id}#E${source.entryOrdinal}` }],
    category: "observation" as const, actor: "user" as const, createdAt: time })));
  expect(facts.facts).toHaveLength(6);
});
afterEach(() => { memory.close(); vi.useRealTimers(); });

test("current and exact knowledge retain evidence and version links", async () => {
  const id = await create();
  const changed = await update(id, 1, "use blue tiles now");
  expect(read(`K${id}`)).toContain("use blue tiles now");
  expect(read(`K${id}@v1`)).toContain(`children: K${id}@v${memory.store.versionOrdinal(id, changed.commit)}`);
  expect(read(`K${id}.history`)).toContain("Correction");
});

test("merge and archive keep exact historical bodies while current archive has no body", async () => {
  const survivor = await create("survivor"), absorbed = await create("absorbed");
  const merged = (await consolidation({ op: "merge", topics: [], reason: "Merge", intoKnowledgeId: survivor, intoBaseCommit: 1,
    absorb: [{ knowledgeId: absorbed, baseCommit: 2 }], text: "combined", category: "reference", scope: "project", supports: [1, 2], createdAt: time }))[0]!;
  const later = await update(survivor, merged.commit, "later survivor");
  expect(read(`K${absorbed}`)).toContain(`merged_into: K${survivor}@v${memory.store.versionOrdinal(survivor, merged.commit)} (from K${absorbed}@v${memory.store.versionOrdinal(absorbed, 2)})`);
  expect(read(`K${absorbed}@v1`)).toContain(`children: K${survivor}@v${memory.store.versionOrdinal(survivor, merged.commit)}`);
  expect(read(`K${absorbed}@v1`)).not.toContain("later survivor");
  const archived = (await consolidation({ op: "archive", kind: "budget", reason: "Retired", knowledgeId: survivor,
    baseCommit: later.commit, supports: [4], createdAt: time }))[0]!;
  expect(read(`K${survivor}`)).not.toContain(`[K${survivor}@v${memory.store.versionOrdinal(survivor, archived.commit)}]`);
  expect(read(`K${survivor}`)).not.toContain("later survivor");
  expect(read(`K${survivor}.history`)).toContain("Retired");
  expect(read(`K${survivor}@v${memory.store.versionOrdinal(survivor, archived.commit)}`)).toContain("later survivor");
});

test("exact facts retain strong and weak relations; removed intervals are refused", () => {
  expect(() => read("F1..")).toThrow();
  expect(read("F1")).toContain("inbound negate F2 strong");
  expect(read("F1")).toContain("inbound negate F3 strong");
  expect(read("F1")).toContain("inbound negate F5 weak");
  expect(read("F4")).toContain("negate F2 strong");
  expect(read("F4")).toContain("negate F3 strong");
});

test("Chinese source and knowledge text survive whole exact reads", async () => {
  const id = await create(fixture.facts[0]!.text);
  const changed = await update(id, 1, fixture.facts[1]!.text);
  expect(read(`K${id}@v1`)).toContain(fixture.facts[0]!.text);
  expect(read(`K${id}`)).toContain(fixture.facts[1]!.text);
  expect(read(`K${id}.history`)).toContain(`K${id}@v${memory.store.versionOrdinal(id, changed.commit)}`);
});
