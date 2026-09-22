import { afterEach, expect, test } from "vitest";
import { AdmittedDreamerScenarios, createDreamerTrigger } from "../../admitted-dreamer-scenario.ts";
import { skipRest } from "../../dreaming-skips.ts";
import { sourceSeededMemory } from "../../source-fixture.ts";
import { tokens } from "../../../src/core/render/index.ts";

const at = "2026-09-20T12:00:00Z";

function fixture() {
  const scenarios = new AdmittedDreamerScenarios(async () => ({ outcome: "success", output: "unused", request: { unused: true } }));
  const memory = sourceSeededMemory(":memory:", scenarios.agent);
  const project = memory.store.createProject({ name: "64b", declaredBy: "mark" });
  const session = memory.store.createSession({ host: "test", projectId: project.id, enrollmentChoice: true, startedAt: at, firstReplyAt: at });
  const turn = memory.store.appendTurn({ sessionId: session.id, kind: "turn", userPrompt: "root", startedAt: at });
  const root = memory.store.listSourceEntries(session.id)[0]!;
  const append = (nativeId: string) => memory.appendEntry({ sessionId: session.id, turnId: turn.id, nativeLineage: "64b", nativeId,
    role: "user", text: nativeId, raw: nativeId, calls: [] });
  const left = append("left"), right = append("right"), joined = append("joined");
  memory.selectEntries(session.id, "root", [root.id]);
  memory.selectEntries(session.id, "left", [root.id, left.id]);
  memory.selectEntries(session.id, "right", [root.id, right.id]);
  memory.selectEntries(session.id, "joined", [root.id, left.id, right.id, joined.id]);
  const noted = memory.store.commitNotingRun({ run: { kind: "noting", sessionId: session.id, branch: "root", createdAt: at }, entryIds: [root.id],
    facts: [{ turnId: turn.id, category: "decision", actor: "user", text: "root rule", source: [`T${turn.id}#E${root.entryOrdinal}`], entryIds: [root.id], createdAt: at }] });
  if (!noted.ok) throw new Error(noted.problems.join("; "));
  const fact = noted.facts[0]!.id;
  const created = memory.store.commitConsolidationRun({ path: { sessionId: session.id, branch: "root", headTurnId: turn.id },
    run: { kind: "manual", sessionId: session.id, branch: "root", createdAt: at }, operations: [{ op: "create", handle: "$root", author: "test",
      text: "root knowledge", category: "constraint", scope: "project", supports: [fact], topics: [], reason: "Initial rule.", createdAt: at }] });
  if (!created.ok) throw new Error(created.problems.join("; "));
  return { memory, scenarios, session, turn, root, left, right, joined, fact, base: created.committed[0]! };
}

let open: ReturnType<typeof fixture>["memory"] | undefined;
afterEach(() => open?.close());

function createTrigger(f: ReturnType<typeof fixture>, branch: "left" | "right" | "joined", sequence: number) {
  return createDreamerTrigger(f.memory, { sessionId: f.session.id, branch, headTurnId: f.turn.id }, f.fact, sequence, "project");
}

function branchFact(f: ReturnType<typeof fixture>, branch: "left" | "right", entryId: number, entryOrdinal: number) {
  const noted = f.memory.store.commitNotingRun({ run: { kind: "manual", sessionId: f.session.id, branch, createdAt: at }, facts: [{
    turnId: f.turn.id, category: "decision", actor: "user", text: `${branch} evidence`, source: [`T${f.turn.id}#E${entryOrdinal}`],
    entryIds: [entryId], createdAt: at,
  }] });
  if (!noted.ok) throw new Error(noted.problems.join("; "));
  return noted.facts[0]!.id;
}

async function maintain(f: ReturnType<typeof fixture>, branch: "left" | "right", triggerEntryId: number, text: string, sequence: number,
  evidence?: number) {
  const path = { sessionId: f.session.id, branch, headTurnId: f.turn.id, triggerEntryId };
  f.memory.store.setCurrentPath(f.session.id, branch, f.turn.id, "test-lineage");
  const trigger = createTrigger(f, branch, sequence);
  const olderTriggers = f.memory.store.currentKnowledge(path).filter(item => item.knowledge.id !== f.base.knowledgeId &&
    item.knowledge.id !== trigger.knowledgeId && item.revision.text.startsWith("Fixture trigger"));
  const result = await f.scenarios.run(f.memory, path, input => {
    const request = { branch, sequence }; input.reportRequest(request);
    const trace = input.tools.find(tool => tool.name === "trace")!;
    const write = input.tools.find(tool => tool.name === "memory")!;
    trace.execute({ address: `K${f.base.knowledgeId}@${f.base.commit}`, itemBudget: null });
    trace.execute({ address: `K${trigger.knowledgeId}@${trigger.commit}`, itemBudget: null, pageBudget: 8000 });
    for (const item of olderTriggers) trace.execute({ address: `K${item.knowledge.id}@${item.revision.id}`, itemBudget: null, pageBudget: 8000 });
    const receipt = write.execute({ operations: [
      { op: "update", id: `K${f.base.knowledgeId}@${f.base.commit}`, text, category: "constraint", scope: "project",
        supports: evidence === undefined ? [] : [`F${evidence}`], topics: [], reason: `${branch} maintenance.` },
      ...olderTriggers.map(item => ({ op: "archive", id: `K${item.knowledge.id}@${item.revision.id}`, supports: [], reason: "Retire earlier explicit trigger." })),
      { op: "archive", id: `K${trigger.knowledgeId}@${trigger.commit}`, supports: [], reason: "Retire explicit trigger." },
    ], skipped: [] });
    expect(receipt).toContain('"committed"');
    return { outcome: "success", output: "maintained", request };
  });
  if (result.outcome !== "success") throw new Error(JSON.stringify(result));
  return { result, trigger };
}

test("64b: admitted maintenance writes inherit parents without creating a system fact", async () => {
  const f = fixture(); open = f.memory;
  const factsBefore = f.memory.store.listSessionFacts(f.session.id).map(fact => fact.id);
  const { result } = await maintain(f, "left", f.left.id, "left knowledge", 1);
  expect(f.memory.store.listFactsByRun(result.runId)).toEqual([]);
  expect(f.memory.store.listSessionFacts(f.session.id).map(fact => fact.id)).toEqual(factsBefore);
  const revisions = f.memory.store.listCommitsByRun(result.runId);
  expect(revisions).toHaveLength(2);
  expect(revisions.every(revision => revision.supports.length === 1 && revision.supports[0] === f.fact)).toBe(true);
});

test("64b: global current selects one direct-fact branch and rejects the historical sibling as a write base", async () => {
  const f = fixture(); open = f.memory;
  const leftEvidence = branchFact(f, "left", f.left.id, f.left.entryOrdinal);
  await maintain(f, "left", f.left.id, "left knowledge", 1, leftEvidence);
  const leftPath = { sessionId: f.session.id, branch: "left", headTurnId: f.turn.id };
  const leftTip = f.memory.store.currentCommit(f.base.knowledgeId, leftPath)[0]!;
  const rightEvidence = branchFact(f, "right", f.right.id, f.right.entryOrdinal);
  await maintain(f, "right", f.right.id, "right knowledge", 2, rightEvidence);
  const rightPath = { sessionId: f.session.id, branch: "right", headTurnId: f.turn.id, triggerEntryId: f.right.id };
  const rightTip = f.memory.store.currentCommit(f.base.knowledgeId, rightPath)[0]!;
  expect(rightTip.id).toBeGreaterThan(leftTip.id);
  expect(rightTip.text).toBe("right knowledge");
  expect(f.memory.store.currentCommit(f.base.knowledgeId, leftPath).map(revision => revision.id)).toEqual([rightTip.id]);

  const trigger = createTrigger(f, "right", 3);
  let changed = "";
  const result = await f.scenarios.run(f.memory, rightPath, input => {
    changed = input.material.changed;
    const request = { branch: "right", purpose: "global-current stale refusal" }; input.reportRequest(request);
    const trace = input.tools.find(tool => tool.name === "trace")!;
    const write = input.tools.find(tool => tool.name === "memory")!;
    for (const revision of [leftTip, rightTip]) trace.execute({ address: `K${f.base.knowledgeId}@${revision.id}`, itemBudget: null });
    trace.execute({ address: `K${trigger.knowledgeId}@${trigger.commit}`, itemBudget: null, pageBudget: 8000 });
    const before = f.memory.store.listKnowledgeRevisions().length;
    const refused = write.execute({ operations: [
      { op: "update", id: `K${f.base.knowledgeId}@${leftTip.id}`, text: "stale sibling edit", category: "constraint",
        scope: "project", supports: [], topics: [], reason: "Probe the historical sibling write fence." },
      { op: "archive", id: `K${trigger.knowledgeId}@${trigger.commit}`, supports: [], reason: "Would otherwise be valid." },
    ], skipped: [] });
    expect(refused).toContain(`K${f.base.knowledgeId}@${leftTip.id}: base is missing, archived, inapplicable or outside the writer's scope`);
    expect(f.memory.store.listKnowledgeRevisions()).toHaveLength(before);
    expect(write.execute({ operations: [
      { op: "archive", id: `K${trigger.knowledgeId}@${trigger.commit}`, supports: [], reason: "Retire explicit trigger." },
    ], skipped: [] })).toContain('"committed"');
    skipRest(input, [`K${trigger.knowledgeId}@${trigger.commit}`]);
    return { outcome: "success", output: "global current checked", request };
  });
  if (result.outcome !== "success") throw new Error(JSON.stringify(result));
  expect(changed).toContain(`[K${trigger.knowledgeId}@${trigger.commit}]`);
  expect(changed).not.toContain(`[K${f.base.knowledgeId}@${rightTip.id}]`);
  expect(changed).not.toContain(`[K${f.base.knowledgeId}@${leftTip.id}]`);
  expect(tokens(changed)).toBeLessThanOrEqual(10000);
  const history = f.memory.trace(`K${f.base.knowledgeId}..`, { ...rightPath, versions: "all" });
  expect(history).toContain("left knowledge");
  expect(history).toContain("right knowledge");
});
