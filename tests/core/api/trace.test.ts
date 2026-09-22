import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { sourceSeededMemory } from "../../source-fixture.ts";
import fixture from "../../fixtures/trace.json";
import { AdmittedDreamerScenarios, createDreamerTrigger } from "../../admitted-dreamer-scenario.ts";

let memory: ReturnType<typeof sourceSeededMemory>, scenarios: AdmittedDreamerScenarios;
let sessionId: number, headTurnId: number, triggerEntryId: number;
const time = "2026-09-07T00:00:00Z", dreamTime = "2026-09-07T00:00:00.000Z";

function fullRead(tool: { execute(input: unknown): string }, address: string) {
  let page = tool.execute({ address, full: true, itemBudget: null });
  for (let cursor = /cursor=(\S+)/.exec(page)?.[1]; cursor; cursor = /cursor=(\S+)/.exec(page)?.[1])
    page = tool.execute({ address: `cursor=${cursor}`, itemBudget: null });
}
// The reasons the shared helpers below write, so the rendered commit history can be asserted literally.
const admit = "Initial admission of this conclusion.", update = "Substantive correction of the recorded conclusion.";
const archived = "Retired: the cited evidence withdraws this conclusion.";
type Operation = Parameters<ReturnType<typeof sourceSeededMemory>["store"]["commitConsolidationRun"]>[0]["operations"][number];
async function consolidation(...operations: Operation[]) {
  if (operations.every(op => op.op === "create")) {
    const result = memory.store.commitConsolidationRun({ run: { kind: "consolidation", sessionId, createdAt: time }, operations });
    if (!result.ok) throw new Error(result.problems.join(", "));
    return result.committed;
  }
  const path = { sessionId, branch: "main", headTurnId, triggerEntryId };
  const triggerFact = 1; // The fixture's user-authored adoption evidence; operation supports remain unchanged.
  const firstBase = operations.find(operation => operation.op !== "create")!;
  const baseCommit = firstBase.op === "merge" ? firstBase.intoBaseCommit : firstBase.baseCommit;
  const poolScope = memory.store.knowledgeRevision(baseCommit)!.scope;
  const trigger = createDreamerTrigger(memory, path, triggerFact, memory.store.listKnowledgeRevisions().length + 1, poolScope);
  let committed: { knowledgeId: number; commit: number }[] = [];
  const dreamed = await scenarios.run(memory, path, input => {
    const request = { fixture: "trace maintenance" }; input.reportRequest(request);
    const trace = input.tools.find(tool => tool.name === "trace")!, write = input.tools.find(tool => tool.name === "memory")!;
    const addressed = new Set<string>();
    const converted = operations.map(operation => {
      if (operation.op === "update") {
        const id = `K${operation.knowledgeId}@${operation.baseCommit}`; addressed.add(id); fullRead(trace, id);
        return { op: "update", id, text: operation.text, category: operation.category, scope: operation.scope, topics: operation.topics,
          supports: operation.supports.map(value => `F${value}`), reason: operation.reason };
      }
      if (operation.op === "archive") {
        const id = `K${operation.knowledgeId}@${operation.baseCommit}`; addressed.add(id); fullRead(trace, id);
        return { op: "archive", id, supports: operation.supports.map(value => `F${value}`), reason: operation.reason };
      }
      if (operation.op === "merge") {
        const id = `K${operation.intoKnowledgeId}@${operation.intoBaseCommit}`, absorb = operation.absorb.map(parent => `K${parent.knowledgeId}@${parent.baseCommit}`);
        for (const address of [id, ...absorb]) { addressed.add(address); fullRead(trace, address); }
        return { op: "merge", id, absorb, text: operation.text, category: operation.category, scope: operation.scope, topics: operation.topics,
          supports: operation.supports.map(value => `F${value}`), reason: operation.reason };
      }
      return operation;
    });
    const triggerAddress = `K${trigger.knowledgeId}@${trigger.commit}`;
    const supplied = new Set(input.material.changed.match(/K\d+@\d+/g) ?? []); supplied.delete(triggerAddress); for (const address of addressed) supplied.delete(address);
    const receipt = JSON.parse(write.execute({ operations: [...converted, { op: "archive", id: triggerAddress, supports: [`F${triggerFact}`], reason: "Retire the explicit trace trigger." }],
      skipped: [...supplied].map(knowledge => ({ knowledge, because: "No maintenance is needed for this supplied item." })) }));
    committed = (receipt.committed ?? []).filter((item: { knowledgeId: number }) => item.knowledgeId !== trigger.knowledgeId);
    expect(input.tools.find(tool => tool.name === "check")!.execute({})).toContain("Blockers: none");
    return { outcome: "success", output: "trace maintenance complete", request };
  });
  if (dreamed.outcome !== "success") throw new Error(JSON.stringify(dreamed));
  return committed;
}
async function create(text = "use red tiles now") {
  return (await consolidation({ op: "create", topics: [], reason: "Initial admission of this conclusion.", handle: "$e1", author: "test", text, category: "reference", scope: "project", supports: [1], createdAt: time }))[0]!.knowledgeId;
}
async function edit(knowledgeId: number, baseCommit: number, text: string, extra: Partial<Extract<Operation, { op: "update" }>> = {}) {
  return (await consolidation({ op: "update", topics: [], reason: "Substantive correction of the recorded conclusion.", knowledgeId, baseCommit, text, category: "reference", scope: "project", supports: [1], createdAt: time, ...extra }))[0]!;
}
beforeEach(() => {
  vi.useFakeTimers(); vi.setSystemTime(new Date(time));
  scenarios = new AdmittedDreamerScenarios(async () => { throw new Error("trace must not call the model"); });
  memory = sourceSeededMemory(":memory:", scenarios.agent);
  const project = memory.store.createProject({ name: "trace", declaredBy: "mark" });
  sessionId = memory.store.createSession({ enrollmentChoice: true, host: "test", projectId: project.id, startedAt: time, firstReplyAt: time }).id;
  const turn = memory.store.appendTurn({ sessionId, kind: "turn", userPrompt: "trace fixture trigger", startedAt: time });
  headTurnId = turn.id;
  triggerEntryId = memory.store.listSourceEntries(sessionId, turn.id).at(-1)!.id;
  memory.selectEntries(sessionId, "main", [triggerEntryId]);
  const facts = memory.store.commitNotingRun({ run: { kind: "noting", sessionId, createdAt: time }, facts: [
    { text: "original claim" },
    { text: "first correction", negate: [{ target: "$1", strength: "strong" as const }] },
    { text: "second correction", negate: [{ target: "$1", strength: "strong" as const }] },
    { text: "shared correction", negate: [{ target: "$2", strength: "strong" as const }, { target: "$3", strength: "strong" as const }] },
    { text: "weak objection", negate: [{ target: "$1", strength: "weak" as const }] },
    { text: "adoption", support: [{ target: "$1", strength: "strong" as const }] },
  ].map((f) => ({ ...f, turnId: turn.id, category: "observation", actor: "user", source: ["T1#user"], createdAt: time })) });
  expect(facts.ok).toBe(true);
});
afterEach(() => { memory.close(); vi.useRealTimers(); });

test("current knowledge and historical snapshot include evidence and revision metadata", async () => {
  const id = await create();
  const changed = await edit(id, 1, "use blue tiles now", { category: "constraint", scope: "global", supports: [2, 3] });
  expect(memory.trace(`K${id}`)).toContain(`[K1@${changed.commit}] [constraint/global] use blue tiles now`);
  expect(memory.trace(`K${id}@1`)).toContain(`children: K1@${changed.commit}`);
});

test("diff preserves unchanged spans and lists all transitions even if endpoints revert", async () => {
  const fields = ["text", "supports", "topics", "status", "reason", "links"] as const;
  const id = await create();
  const blue = await edit(id, 1, "use blue tiles now", { supports: [2], category: "constraint", scope: "global" });
  const green = await edit(id, blue.commit, "use green tiles now", { supports: [2, 3], category: "constraint", scope: "global", reason: "Third reading after the shared correction" });
  const greenDiff = memory.trace(`K${id}@1..K${id}@${green.commit}`, { fields });
  expect(greenDiff).toContain("text: use [-red-]{+green+} tiles now");
  expect(greenDiff).toContain(`K1@${blue.commit} update ${dreamTime} change supports: F2 reason: ${update}`);
  expect(greenDiff).toContain(`K1@${green.commit} update ${dreamTime} change supports: F2, F3 reason: Third reading after the shared correction`);
  const red = await edit(id, green.commit, "use red tiles now");
  expect(memory.trace(`K${id}@1..K${id}@${red.commit}`, { fields })).toContain("text: use red tiles now\n  change supports added: none\n  change supports removed: none");
  expect(memory.trace(`K${id}@1..K${id}@${red.commit}`, { fields })).toContain(`K1@${green.commit} update ${dreamTime} change supports: F2, F3 reason: Third reading after the shared correction`);
  expect(memory.trace(`K${id}@${blue.commit}..K${id}@${blue.commit}`, { fields })).toContain("Commits: none");
});

test.each([
  ["a b a", "a a", "a [-b -]a"],
  ["", "hello", "{+hello+}"],
  ["hello", "x", "[-hello-]{+x+}"],
  ["a  b!", "a b?", "a[-  -]{+ +}b[-!-]{+?+}"],
])("token LCS handles %j to %j", async (before, after, expected) => {
  const id = await create(before); const changed = await edit(id, 1, after);
  expect(memory.trace(`K${id}@1..K${id}@${changed.commit}`)).toContain(`  text: ${expected}\n`);
});

test("Chinese token edits preserve surrounding characters from the simulation fixture", async () => {
  const chars = Array.from(fixture.facts[0]!.text);
  const before = chars.join("");
  const removed = chars[5]!;
  const added = Array.from(fixture.facts[1]!.text).find((c) => /\p{Script=Han}/u.test(c) && !before.includes(c))!;
  chars[5] = added;
  const id = await create(before); const changed = await edit(id, 1, chars.join(""));
  expect(memory.trace(`K${id}@1..K${id}@${changed.commit}`)).toContain(`  text: ${before.slice(0, 5)}[-${removed}-]{+${added}+}${before.slice(6)}\n`);
});

test("merged knowledge retain their snapshot and frozen survivor revision; archives show the archive revision", async () => {
  const survivor = await create("survivor"), absorbed = await create("absorbed");
  const merged = (await consolidation({ op: "merge", topics: [], reason: "Merged duplicate knowledge into the survivor.", intoKnowledgeId: survivor, intoBaseCommit: 1, absorb: [{ knowledgeId: absorbed, baseCommit: 2 }], text: "combined", category: "reference", scope: "project", supports: [1, 2], createdAt: time }))[0]!;
  const later = await edit(survivor, merged.commit, "later survivor");
  expect(memory.trace(`K${absorbed}`)).toContain(`merged_into: K1@${merged.commit} (from K2@2)`);
  expect(memory.trace(`K${absorbed}@2`)).toContain(`children: K1@${merged.commit}`);
  expect(memory.trace(`K${absorbed}@2`)).not.toContain("later survivor");
  const archivedRevision = (await consolidation({ op: "archive", reason: "Retired: the cited evidence withdraws this conclusion.", knowledgeId: survivor, baseCommit: later.commit, supports: [4], createdAt: time }))[0]!;
  expect(memory.trace(`K${survivor}`)).not.toContain(`[K1@${archivedRevision.commit}]`);
  expect(memory.trace(`K${survivor}`, { versions: "history" })).toContain(`[K1@${archivedRevision.commit}] [reference/project] \n  change supports: F4`);
  expect(memory.trace(`K${survivor}@${archivedRevision.commit}`, { fields: ["text", "supports", "status", "reason"] })).toContain(`status: archive ${dreamTime}`);
  expect(memory.trace(`K${survivor}`, { versions: "history", fields: ["reason"] })).toContain(`K1@${archivedRevision.commit} reason: ${archived}`);
});

test("negation walk branches, repeats shared descendants, excludes weak and support edges, and ends every branch", () => {
  const result = memory.trace("F1..");
  const fact = (id: number, depth: number) => memory.trace(`F${id}`).split("\n").map((l) => "  ".repeat(depth) + l).join("\n");
  expect(result).toBe([fact(1, 0), fact(2, 1), fact(4, 2), "      no later strong negation recorded", fact(3, 1), fact(4, 2), "      no later strong negation recorded"].join("\n"));
  expect(memory.trace("F4..")).toBe(memory.trace("F4") + "\n  no later strong negation recorded");
});

test.each(["", "K0", "K01", "K1@0", "K1@1..", "K1@3...1", "K1 full", "F1.. full", "F0..", "F01..", "K9007199254740992", "K1@9007199254740992", "F9007199254740992..", "garbage"])("rejects invalid address %j", async (address) => {
  await create(); expect(() => memory.trace(address)).toThrow(/invalid trace address/);
});
test.each(["K99", "K99@1", "K1@99", "K1@1..K1@99", "F99.."])("reports missing target %s", async (address) => {
  await create(); expect(() => memory.trace(address)).toThrow(/does not exist|has no revision/);
});

test("simulation knowledge and strong negation goldens preserve Chinese memory content", async () => {
  // Remap fixture fact and raw-source IDs into this database; preserve the original fixture on disk.
  const ids = new Map(fixture.facts.map((f, i) => [f.id, i + 7]));
  const turn = memory.store.appendTurn({ sessionId, parentTurnId: headTurnId, kind: "turn", assistantText: fixture.facts.map(f => f.text).join("\n"), startedAt: time });
  headTurnId = turn.id;
  const selectedEntryIds = [
    ...memory.store.selectedSourceEntryIds(sessionId, "main")!,
    ...memory.store.listSourceEntries(sessionId, turn.id).map(entry => entry.id),
  ];
  memory.selectEntries(sessionId, "main", selectedEntryIds);
  triggerEntryId = selectedEntryIds.at(-1)!;
  const committed = memory.store.commitNotingRun({ run: { kind: "noting", sessionId, createdAt: time }, facts: fixture.facts.map((f) => ({
    turnId: turn.id, category: f.category as "observation", actor: f.actor as "agent", text: f.text, quote: f.quote,
    source: [`T${turn.id}#assistant`], createdAt: f.timestamp,
    negate: f.negate?.map(([id]) => ({ target: `F${ids.get(Number(id))}`, strength: "strong" as const })),
  })) });
  expect(committed.ok).toBe(true);
  let tip = 0;
  for (const [i, r] of fixture.knowledge.log.entries()) {
    const fields = { text: r.text, category: "reference" as const, scope: "project" as const, supports: r.supports.map((id) => ids.get(id)!), createdAt: r.at, reason: r.reason, topics: r.topics };
    const result = !i ? await consolidation({ ...fields, op: "create", handle: "$e1", author: "consolidation" })
      : await consolidation({ ...fields, op: "update", knowledgeId: 1, baseCommit: tip, reason: r.reason });
    tip = result[0]!.commit;
  }
  expect(memory.trace("K1")).toMatchSnapshot();
  expect(memory.trace("K1@1")).toMatchSnapshot();
  expect(memory.trace(`K1@1..K1@${tip}`, { fields: ["text", "supports", "status"] })).toMatchSnapshot();
  expect(memory.trace(`F${ids.get(8)}..`)).toMatchSnapshot();
});
