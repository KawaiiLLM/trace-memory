import { afterEach, expect, test } from "vitest";
import { AdmittedDreamerScenarios, createDreamerTrigger } from "../../admitted-dreamer-scenario.ts";
import { skipRest } from "../../dreaming-skips.ts";
import { sourceSeededMemory } from "../../source-fixture.ts";
import { renderKnowledge, tokens } from "../../../src/core/render/index.ts";
import { drainTrace } from "../../trace-pages.ts";

const at = "2026-09-20T12:00:00Z";

function fixture(baseText = "divergent base") {
  const scenarios = new AdmittedDreamerScenarios(async () => ({ outcome: "success", output: "unused", request: {} }));
  const memory = sourceSeededMemory(":memory:", scenarios.agent);
  const project = memory.store.createProject({ name: "64b-material-locality", declaredBy: "mark" });
  const session = memory.store.createSession({ host: "test", projectId: project.id, enrollmentChoice: true, startedAt: at, firstReplyAt: at });
  const turn = memory.store.appendTurn({ sessionId: session.id, kind: "turn", userPrompt: "root", startedAt: at });
  const root = memory.store.listSourceEntries(session.id)[0]!;
  const append = (nativeId: string) => memory.appendEntry({ sessionId: session.id, turnId: turn.id, nativeLineage: "64b-locality", nativeId,
    role: "user", text: nativeId, raw: nativeId, calls: [] });
  const left = append("left"), right = append("right"), joined = append("joined");
  memory.selectEntries(session.id, "root", [root.id]);
  memory.selectEntries(session.id, "left", [root.id, left.id]);
  memory.selectEntries(session.id, "right", [root.id, right.id]);
  memory.selectEntries(session.id, "joined", [root.id, left.id, right.id, joined.id]);
  const noted = memory.store.commitNotingRun({ run: { kind: "noting", sessionId: session.id, branch: "root", createdAt: at }, entryIds: [root.id],
    facts: [{ turnId: turn.id, category: "decision", actor: "user", text: "root rule", source: [`T${turn.id}#E${root.entryOrdinal}`],
      entryIds: [root.id], createdAt: at }] });
  if (!noted.ok) throw new Error(noted.problems.join("; "));
  const fact = noted.facts[0]!.id;
  const branchFacts: Record<"left" | "right", number> = { left: 0, right: 0 };
  for (const branch of ["left", "right"] as const) {
    const entry = { left, right }[branch];
    const result = memory.store.commitNotingRun({ run: { kind: "manual", sessionId: session.id, branch, createdAt: at }, facts: [{
      turnId: turn.id, category: "decision", actor: "user", text: `${branch} evidence`, source: [`T${turn.id}#E${entry.entryOrdinal}`],
      entryIds: [entry.id], createdAt: at,
    }] });
    if (!result.ok) throw new Error(result.problems.join("; "));
    branchFacts[branch] = result.facts[0]!.id;
  }
  const created = memory.store.commitConsolidationRun({ path: { sessionId: session.id, branch: "root", headTurnId: turn.id },
    run: { kind: "manual", sessionId: session.id, branch: "root", createdAt: at }, operations: [{ op: "create", handle: "$base", author: "test",
      text: baseText, category: "constraint", scope: "project", supports: [fact], topics: [], reason: "Initial rule.", createdAt: at }] });
  if (!created.ok) throw new Error(created.problems.join("; "));
  return { memory, scenarios, session, turn, fact, branchFacts, left, right, joined, base: created.committed[0]! };
}

type Fixture = ReturnType<typeof fixture>;

function create(f: Fixture, branch: string, text: string) {
  const receipt = JSON.parse(f.memory.tools({ kind: "manual", sessionId: f.session.id, branch, currentTurnId: f.turn.id })
    .find(tool => tool.name === "memory")!.execute({ operations: [{ op: "create", text, category: "reference", scope: "project",
      supports: [`F${f.fact}`], topics: ["test-fixture"], reason: "Deterministic Dreamer input." }], skipped: [] }));
  if (!receipt.committed?.[0]) throw new Error(JSON.stringify(receipt));
  return receipt.committed[0] as { knowledgeId: number; commit: number };
}

async function diverge(f: Fixture, branch: "left" | "right", triggerEntryId: number, text: string) {
  const path = { sessionId: f.session.id, branch, headTurnId: f.turn.id, triggerEntryId };
  f.memory.store.setCurrentPath(f.session.id, branch, f.turn.id, "test-lineage");
  const trigger = createDreamerTrigger(f.memory, path, f.fact, f.memory.store.listKnowledgeRevisions().length + 1, "project");
  const result = await f.scenarios.run(f.memory, path, input => {
    const request = { branch }; input.reportRequest(request);
    const trace = input.tools.find(tool => tool.name === "trace")!;
    const write = input.tools.find(tool => tool.name === "memory")!;
    drainTrace({ trace: (next, options) => trace.execute({ address: next, ...options }) },
      trace.execute({ address: `K${f.base.knowledgeId}@${f.base.commit}`, full: true, itemBudget: null }));
    trace.execute({ address: `K${trigger.knowledgeId}@${trigger.commit}`, itemBudget: null });
    const receipt = write.execute({ operations: [
      { op: "update", id: `K${f.base.knowledgeId}@${f.base.commit}`, text, category: "constraint", scope: "project",
        supports: [`F${f.branchFacts[branch]}`], topics: [], reason: `${branch} evidence-driven divergence.` },
      { op: "archive", id: `K${trigger.knowledgeId}@${trigger.commit}`, supports: [], reason: "Retire trigger." },
    ], skipped: [] });
    expect(receipt).toContain('"committed"');
    skipRest(input, [`K${f.base.knowledgeId}@${f.base.commit}`, `K${trigger.knowledgeId}@${trigger.commit}`]);
    return { outcome: "success", output: "maintained", request };
  });
  if (result.outcome !== "success") throw new Error(JSON.stringify(result));
  return f.memory.store.currentCommit(f.base.knowledgeId, path)[0]!;
}

let open: Fixture["memory"] | undefined;
afterEach(() => open?.close());

test("64b F1: oversized unrelated history does not pin a fitting pending identity", async () => {
  // One large manually stored historical parent is legal; each actual D update stays below 1k.
  const f = fixture(`large historical parent ${"word ".repeat(11_000)}`); open = f.memory;
  const left = await diverge(f, "left", f.left.id, `left ${"large ".repeat(900)}`);
  const right = await diverge(f, "right", f.right.id, `right ${"large ".repeat(900)}`);
  const identity = f.memory.store.getKnowledge(f.base.knowledgeId)!;
  const historical = f.memory.store.getKnowledgeRevision(f.base.knowledgeId, f.base.commit)!;
  expect(tokens([historical, left, right].map(revision => renderKnowledge({ knowledge: identity, revision })).join("\n")))
    .toBeGreaterThan(10000);

  f.memory.store.setCurrentPath(f.session.id, "joined", f.turn.id, "test-lineage");
  const pending = create(f, "joined", "small independent pending knowledge");
  createDreamerTrigger(f.memory, { sessionId: f.session.id, branch: "joined", headTurnId: f.turn.id }, f.fact,
    f.memory.store.listKnowledgeRevisions().length + 1, "project");
  const pool = `project:${f.session.projectId}`;
  const pendingVersions = f.memory.store.pendingVersions(pool, { sessionId: f.session.id, branch: "joined", headTurnId: f.turn.id });
  expect(pendingVersions.map(value => value.revisionId)).toContain(pending.commit);
  expect(tokens(["Pending current knowledge:", ...pendingVersions.map(value => value.material)].join("\n"))).toBeLessThan(15000);

  let changed = "";
  const result = await f.scenarios.run(f.memory,
    { sessionId: f.session.id, branch: "joined", headTurnId: f.turn.id, triggerEntryId: f.joined.id }, input => {
      changed = input.material.changed;
      skipRest(input);
      return { outcome: "success", output: "reviewed", request: {} };
    });
  expect(result.outcome).toBe("success");
  expect(changed).toContain(`[K${pending.knowledgeId}@${pending.commit}]`);
  expect(changed).not.toContain(`[K${f.base.knowledgeId}@${left.id}]`);
  expect(changed).not.toContain(`[K${f.base.knowledgeId}@${right.id}]`);
  expect(tokens(changed)).toBeLessThanOrEqual(15000);
});
