import { afterEach, expect, test } from "vitest";
import { curateNow, versionRef } from "../../support/dreamer.ts";
import { block } from "../../support/workspace.ts";
import { sourceSeededMemory } from "../../source-fixture.ts";
import { memoryFiles } from "../../../src/core/api/index.ts";

const at = "2026-09-20T12:00:00Z";

function fixture() {
  const memory = sourceSeededMemory(":memory:", async () => ({ outcome: "success", output: "unused", request: { unused: true } }));
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
    run: { kind: "manual", sessionId: session.id, branch: "root", createdAt: at }, operations: [{ op: "create", title: "Fixture title", handle: "$root", author: "test",
      text: "root knowledge", category: "constraint", scope: "project", supports: [fact], topics: [], reason: "Initial rule.", createdAt: at }] });
  if (!created.ok) throw new Error(created.problems.join("; "));
  return { memory, session, turn, root, left, right, joined, fact, base: created.committed[0]! };
}

let open: ReturnType<typeof fixture>["memory"] | undefined;
afterEach(() => open?.close());

function branchFact(f: ReturnType<typeof fixture>, branch: "left" | "right", entryId: number, entryOrdinal: number) {
  const noted = f.memory.store.commitNotingRun({ run: { kind: "manual", sessionId: f.session.id, branch, createdAt: at }, facts: [{
    turnId: f.turn.id, category: "decision", actor: "user", text: `${branch} evidence`, source: [`T${f.turn.id}#E${entryOrdinal}`],
    entryIds: [entryId], createdAt: at,
  }] });
  if (!noted.ok) throw new Error(noted.problems.join("; "));
  return noted.facts[0]!.id;
}

/** One maintenance update of the base on a branch: a curate block applied on that branch's path. */
function maintain(f: ReturnType<typeof fixture>, branch: "left" | "right", triggerEntryId: number, text: string, evidence?: number) {
  const path = { sessionId: f.session.id, branch, headTurnId: f.turn.id, triggerEntryId };
  f.memory.store.setCurrentPath(f.session.id, branch, f.turn.id, "test-lineage");
  const base = f.memory.store.currentCommit(f.base.knowledgeId, path)[0]!;
  const result = curateNow(f.memory, path, block(`update ${versionRef(f.memory.store, f.base.knowledgeId, base.id)}`,
    { ...(evidence === undefined ? {} : { supports: `F${evidence}` }), reason: `${branch} maintenance.` }, text));
  expect(result.blocks.map(entry => entry.status)).toEqual(["applied"]);
  return { result };
}

test("64b: admitted maintenance writes inherit parents without creating a system fact", () => {
  const f = fixture(); open = f.memory;
  const factsBefore = f.memory.store.listSessionFacts(f.session.id).map(fact => fact.id);
  const { result } = maintain(f, "left", f.left.id, "left knowledge");
  expect(f.memory.store.listFactsByRun(result.runId)).toEqual([]);
  expect(f.memory.store.listSessionFacts(f.session.id).map(fact => fact.id)).toEqual(factsBefore);
  const revisions = f.memory.store.listCommitsByRun(result.runId);
  expect(revisions).toHaveLength(1);
  expect(revisions.every(revision => revision.supports.length === 1 && revision.supports[0] === f.fact)).toBe(true);
});

test("64b: global current selects one direct-fact branch and rejects the historical sibling as a write base", () => {
  const f = fixture(); open = f.memory;
  const leftEvidence = branchFact(f, "left", f.left.id, f.left.entryOrdinal);
  maintain(f, "left", f.left.id, "left knowledge", leftEvidence);
  const leftPath = { sessionId: f.session.id, branch: "left", headTurnId: f.turn.id };
  const leftTip = f.memory.store.currentCommit(f.base.knowledgeId, leftPath)[0]!;
  const rightEvidence = branchFact(f, "right", f.right.id, f.right.entryOrdinal);
  maintain(f, "right", f.right.id, "right knowledge", rightEvidence);
  const rightPath = { sessionId: f.session.id, branch: "right", headTurnId: f.turn.id, triggerEntryId: f.right.id };
  const rightTip = f.memory.store.currentCommit(f.base.knowledgeId, rightPath)[0]!;
  expect(rightTip.id).toBeGreaterThan(leftTip.id);
  expect(rightTip.text).toBe("right knowledge");
  expect(f.memory.store.currentCommit(f.base.knowledgeId, leftPath).map(revision => revision.id)).toEqual([rightTip.id]);

  const before = f.memory.store.listKnowledgeRevisions().length;
  const refused = curateNow(f.memory, rightPath, block(`update ${versionRef(f.memory.store, f.base.knowledgeId, leftTip.id)}`,
    { reason: "Probe the historical sibling write fence." }, "stale sibling edit")).blocks[0]!;
  // 76: baseProblem names the current version when the identity has a visible one on this branch.
  expect(refused).toMatchObject({ status: "refused", stale: true });
  expect(refused.reason).toContain(`K${f.base.knowledgeId}@v2 is not current on this branch; current is K${f.base.knowledgeId}@v3`);
  expect(f.memory.store.listKnowledgeRevisions()).toHaveLength(before);
  const history = memoryFiles(f.memory, { sessionId: f.session.id, branch: "right", headTurnId: f.turn.id })
    .read(`trace://K${f.base.knowledgeId}.history`).content;
  expect(history).toContain("left knowledge");
  expect(history).toContain("right knowledge");
});
