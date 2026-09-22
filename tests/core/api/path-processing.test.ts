import { afterEach, expect, test } from "vitest";
import { TraceMemory } from "../../../src/core/api/index.ts";
import { AdmittedDreamerScenarios, createDreamerTrigger } from "../../admitted-dreamer-scenario.ts";
import { skipRest } from "../../dreaming-skips.ts";

const memories: ReturnType<typeof TraceMemory>[] = [];
afterEach(() => { for (const memory of memories.splice(0)) memory.close(); });
const at = "2026-09-12T00:00:00.000Z";
const success = { outcome: "success", output: "reviewed", request: { exact: "offline" } } as const;
type Branch = "root" | "left" | "right";
type Operation = "archive" | "split" | "merge-into" | "merge-absorb";

function pathFixture(seedOlderSurvivor = false) {
  const scenarios = new AdmittedDreamerScenarios(async () => success);
  const memory = TraceMemory(":memory:", scenarios.agent); memories.push(memory);
  const store = memory.store;
  const project = store.createProject({ name: "shared", declaredBy: "mark" });
  const session = store.createSession({ host: "test", projectId: project.id, enrollmentChoice: true, startedAt: at, firstReplyAt: at });
  const turn = store.appendTurn({ sessionId: session.id, kind: "turn", userPrompt: "root", startedAt: at });
  const append = (nativeId: string) => memory.appendEntry({ sessionId: session.id, turnId: turn.id,
    nativeLineage: "native", nativeId, role: "user", text: nativeId, raw: nativeId, calls: [] });
  const root = append("root"), left = append("left"), right = append("right");
  memory.selectEntries(session.id, "root", [root.id]);
  memory.selectEntries(session.id, "left", [root.id, left.id]);
  memory.selectEntries(session.id, "right", [root.id, right.id]);
  const noted = store.commitNotingRun({ run: { kind: "manual", sessionId: session.id, branch: "root", createdAt: at }, facts: [{
    turnId: turn.id, entryIds: [root.id], category: "decision", actor: "user", text: "shared evidence",
    source: [`T${turn.id}#E${root.entryOrdinal}`], createdAt: at,
  }] });
  if (!noted.ok) throw new Error(noted.problems.join("; "));
  const fact = noted.facts[0]!.id;
  const branchFacts = { root: fact } as Record<Branch, number>;
  for (const branch of ["left", "right"] as const) {
    const entry = { left, right }[branch];
    const result = store.commitNotingRun({ run: { kind: "manual", sessionId: session.id, branch, createdAt: at }, facts: [{
      turnId: turn.id, entryIds: [entry.id], category: "decision", actor: "user", text: `${branch} evidence`,
      source: [`T${turn.id}#E${entry.entryOrdinal}`], createdAt: at,
    }] });
    if (!result.ok) throw new Error(result.problems.join("; "));
    branchFacts[branch] = result.facts[0]!.id;
  }
  const manual = memory.tools({ kind: "manual", sessionId: session.id, branch: "root", currentTurnId: turn.id, triggerEntryId: root.id });
  const create = (text: string) => JSON.parse(manual.find(tool => tool.name === "memory")!.execute({ operations: [{ op: "create", text,
    category: "constraint", scope: "project", supports: [`F${fact}`], topics: [], reason: `Create ${text}.` }], skipped: [] })).committed[0] as { knowledgeId: number; commit: number };
  const older = seedOlderSurvivor ? create("older survivor") : undefined;
  const base = create("base");
  const entries = { root, left, right };
  const path = (branch: Branch) => ({ sessionId: session.id, branch, headTurnId: turn.id, triggerEntryId: entries[branch].id });
  return { memory, scenarios, store, project, session, turn, entries, fact, branchFacts, older, base, path, create };
}

async function runOperation(f: ReturnType<typeof pathFixture>, branch: Branch, sequence: number,
  operation: Operation | "update", text: string) {
  const path = f.path(branch);
  f.store.setCurrentPath(f.session.id, branch, f.turn.id, "test-lineage");
  const mergeOther = operation === "merge-into" ? f.create("merge peer") : f.older;
  const trigger = createDreamerTrigger(f.memory, path, f.fact, sequence);
  const currentTriggers = f.store.currentKnowledge(path).filter(item => item.revision.text.startsWith("Fixture trigger"));
  const result = await f.scenarios.run(f.memory, path, async input => {
    const request = { operation, branch, trigger }; input.reportRequest(request);
    const trace = input.tools.find(tool => tool.name === "trace")!;
    const write = input.tools.find(tool => tool.name === "memory")!;
    trace.execute({ address: `K${f.base.knowledgeId}@${f.base.commit}`, itemBudget: null });
    for (const item of currentTriggers) trace.execute({ address: `K${item.knowledge.id}@${item.revision.id}`, itemBudget: null, pageBudget: 8_000 });
    const common = { text, category: "constraint", scope: "project", supports: [`F${f.branchFacts[branch]}`], topics: [], reason: `${operation} on ${branch}.` };
    let operationInput: Record<string, unknown>;
    if (operation === "archive") operationInput = { op: "archive", id: `K${f.base.knowledgeId}@${f.base.commit}`, supports: common.supports, reason: common.reason };
    else if (operation === "split") operationInput = { op: "split", id: `K${f.base.knowledgeId}@${f.base.commit}`, supports: common.supports, reason: common.reason,
      children: [{ text: `${text} one`, category: "constraint", topics: [] }, { text: `${text} two`, category: "constraint", topics: [] }] };
    else if (operation === "merge-into") {
      const other = mergeOther ?? (() => { throw new Error("missing merge identity"); })();
      trace.execute({ address: `K${other.knowledgeId}@${other.commit}`, itemBudget: null });
      operationInput = { op: "merge", id: `K${f.base.knowledgeId}@${f.base.commit}`, absorb: [`K${other.knowledgeId}@${other.commit}`], ...common };
    } else if (operation === "merge-absorb") {
      const survivor = f.older ?? (() => { throw new Error("missing older survivor"); })();
      trace.execute({ address: `K${survivor.knowledgeId}@${survivor.commit}`, itemBudget: null });
      operationInput = { op: "merge", id: `K${survivor.knowledgeId}@${survivor.commit}`, absorb: [`K${f.base.knowledgeId}@${f.base.commit}`], ...common };
    } else operationInput = { op: "update", id: `K${f.base.knowledgeId}@${f.base.commit}`, ...common };
    const receipt = write.execute({ operations: [operationInput, ...currentTriggers.map(item => ({ op: "archive",
      id: `K${item.knowledge.id}@${item.revision.id}`, supports: [], reason: "Retire explicit trigger." }))], skipped: [] });
    expect(receipt).toContain('"committed"');
    const consumed = [`K${f.base.knowledgeId}@${f.base.commit}`,
      ...currentTriggers.map(item => `K${item.knowledge.id}@${item.revision.id}`)];
    if (operation === "merge-into" && mergeOther) consumed.push(`K${mergeOther.knowledgeId}@${mergeOther.commit}`);
    if (operation === "merge-absorb" && f.older) consumed.push(`K${f.older.knowledgeId}@${f.older.commit}`);
    skipRest(input, consumed);
    return { ...success, request };
  });
  if (result.outcome !== "success") throw new Error(JSON.stringify(result));
  return result;
}

// The old update-origin test is retired: ticket-64b.test.ts proves divergent updates and their multi-parent join.
test.each(["archive", "split", "merge-into", "merge-absorb"] as const)(
  "64b: %s uses the owner foreground for current-base and divergent behavior", async operation => {
    const f = pathFixture(operation === "merge-absorb");
    await runOperation(f, "left", 1, operation, `${operation} result`);
    const leftPath = f.path("left");
    const stale = f.memory.tools({ kind: "manual", sessionId: f.session.id, branch: "left", currentTurnId: f.turn.id, triggerEntryId: f.entries.left.id });
    stale.find(tool => tool.name === "trace")!.execute({ address: `K${f.base.knowledgeId}@${f.base.commit}`, itemBudget: null });
    expect(stale.find(tool => tool.name === "memory")!.execute({ operations: [{ op: "archive", id: `K${f.base.knowledgeId}@${f.base.commit}`,
      supports: [`F${f.fact}`], reason: "Probe the stale base." }], skipped: [] })).toContain("base is not the latest effective applicable revision");
    await runOperation(f, "right", 2, "update", `${operation} divergent result`);
    expect(f.store.currentCommit(f.base.knowledgeId, f.path("right"))[0]!.text).toBe(`${operation} divergent result`);
  },
);

test("64b: publishing the owner foreground restores an off-path base for every reader", async () => {
  const f = pathFixture();
  await runOperation(f, "left", 1, "update", "left-only successor");
  expect(f.store.currentCommit(f.base.knowledgeId, f.path("left"))[0]!.text).toBe("left-only successor");

  f.store.setCurrentPath(f.session.id, "root", f.turn.id, "test-lineage");
  expect(f.store.currentCommit(f.base.knowledgeId, f.path("left")).map(revision => revision.id)).toEqual([f.base.commit]);
  expect(f.store.currentCommit(f.base.knowledgeId, f.path("right")).map(revision => revision.id)).toEqual([f.base.commit]);
  await runOperation(f, "root", 2, "update", "restored base correction");
  expect(f.store.currentCommit(f.base.knowledgeId, f.path("right"))[0]!.text).toBe("restored base correction");
});

test.each([false, true])("64b: stale Dreamer completion fails unless corrected (corrected=%s)", async (corrected) => {
  const f = pathFixture();
  const path = f.path("left");
  f.store.setCurrentPath(f.session.id, "left", f.turn.id, "test-lineage");
  const trigger = createDreamerTrigger(f.memory, path, f.fact, 1);
  const result = await f.scenarios.run(f.memory, path, input => {
    const trace = input.tools.find(tool => tool.name === "trace")!;
    const write = input.tools.find(tool => tool.name === "memory")!;
    trace.execute({ address: `K${f.base.knowledgeId}@${f.base.commit}`, itemBudget: null });
    trace.execute({ address: `K${trigger.knowledgeId}@${trigger.commit}`, itemBudget: null, pageBudget: 8_000 });
    const first = JSON.parse(write.execute({ operations: [
      { op: "update", id: `K${f.base.knowledgeId}@${f.base.commit}`, text: "first successor", category: "constraint",
        scope: "project", supports: [], topics: [], reason: "First maintenance." },
      { op: "archive", id: `K${trigger.knowledgeId}@${trigger.commit}`, supports: [], reason: "Retire explicit trigger." },
    ], skipped: [] })).committed[0] as { commit: number };
    const stale = write.execute({ operations: [{ op: "update", id: `K${f.base.knowledgeId}@${f.base.commit}`,
      text: "unresolved stale submission", category: "constraint", scope: "project", supports: [], topics: [], reason: "Must fail." }], skipped: [] });
    expect(stale).toContain(`base is not the latest effective applicable revision; current: K${f.base.knowledgeId}@${first.commit}`);
    expect(stale).not.toContain("skipped");
    if (!corrected) return success;
    trace.execute({ address: `K${f.base.knowledgeId}@${first.commit}`, itemBudget: null });
    expect(write.execute({ operations: [{ op: "update", id: `K${f.base.knowledgeId}@${first.commit}`,
      text: "corrected successor", category: "constraint", scope: "project", supports: [], topics: [], reason: "Reread and correct." }], skipped: [] }))
      .toContain('"committed"');
    return success;
  });
  expect(result.outcome).toBe(corrected ? "success" : "failure");
  if (!corrected) {
    if (result.outcome !== "failure") throw new Error("unresolved stale submission must fail completion");
    expect(result.problems.join("\n")).toContain("base is not the latest effective applicable revision");
  }
  expect(f.store.currentCommit(f.base.knowledgeId, path)[0]!.text).toBe(corrected ? "corrected successor" : "first successor");
});

// 64c removes settlement/certification and replaces it with one-time pool-event consumption.
test.skip("34b: a consumed supplied event succeeds with exact settlement and no adopted certificate", () => {});
// 64c removes retained peer components and oversized-group settlement.
test.skip("34b: shared-result peer propagation blocks the whole oversized group while an independent event completes", () => {});
// 64c removes exact-version pending obligations and the processed partition.
test.skip("34b/35b: a restored exact version is reported honestly as pending work by the bound check", () => {});
// 64c deletes certification-time successor classification.
test.skip.each([
  "divergent inapplicable",
  "divergent applicable",
  "descendant inapplicable",
])("47 certification: '%s' successor follows lineage-or-applicable", () => {});
// 64c deletes certification and its provenance failure mode.
test.skip("47 certification: unknown required same-session successor provenance fails explicitly", () => {});
