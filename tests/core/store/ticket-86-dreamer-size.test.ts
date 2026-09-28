import { afterEach, expect, test } from "vitest";
import { Store, type KnowledgeOperationInput } from "../../../src/core/store/index.ts";
import { tokens } from "../../../src/core/render/index.ts";

const stores: Store[] = [];
afterEach(() => { for (const store of stores.splice(0)) store.close(); });

for (const operation of ["update", "merge", "split"] as const) test(`86: D ${operation} checks each resulting item's 1000-token boundary atomically`, () => {
  const store = new Store(":memory:"); stores.push(store);
  const project = store.createProject({ name: operation, declaredBy: "mark" });
  const session = store.createSession({ host: "test", projectId: project.id, enrollmentChoice: true, startedAt: "now", firstReplyAt: "now" });
  const turn = store.appendTurn({ sessionId: session.id, kind: "turn", userPrompt: "evidence", startedAt: "now" });
  const entry = store.appendSourceEntry({ sessionId: session.id, turnId: turn.id, nativeLineage: "test", nativeId: "evidence", role: "user", text: "evidence", raw: "evidence", calls: [] });
  store.selectSourcePath(session.id, "main", [entry.id]);
  const path = { sessionId: session.id, branch: "main", headTurnId: turn.id, triggerEntryId: entry.id };
  const fact = store.commitNotingRun({ run: { kind: "manual", sessionId: session.id, createdAt: "now" }, facts: [
    { turnId: turn.id, text: "evidence", actor: "user", category: "decision", source: [`T${turn.id}#user`], entryIds: [entry.id], createdAt: "now" },
  ] });
  if (!fact.ok) throw Error(fact.problems.join("; "));
  const create = (text: string) => ({ op: "create" as const, handle: "$1", author: "test", text, category: "constraint" as const,
    scope: "project" as const, topics: [], supports: [fact.facts[0]!.id], reason: "evidence", createdAt: "now" });
  const seeds = store.commitConsolidationRun({ path, run: { kind: "manual", sessionId: session.id, createdAt: "now" }, operations: [create("first"), create("second")] });
  if (!seeds.ok) throw Error(seeds.problems.join("; "));
  const [first, second] = seeds.committed;
  const oversizedManual = operation === "merge" ? store.commitConsolidationRun({ path,
    run: { kind: "manual", sessionId: session.id, createdAt: "now" }, operations: [create("x ".repeat(1001))] }) : null;
  if (oversizedManual && !oversizedManual.ok) throw Error(oversizedManual.problems.join("; "));
  const claim = store.acquireClaim(path, "dreaming", "executor")!;
  const range = store.retainKnowledgePoolRange(path, `project:${project.id}`, claim);
  const run = store.bindDreamingRun({ kind: "dreaming", sessionId: session.id, branch: "main", projectId: project.id, claim,
    dreamingRangeId: range.id, executionId: store.beginExecution({ sessionId: session.id, phase: "dreaming", pool: range.pool!, origin: range.origin }), createdAt: "now" });
  const text = "x ".repeat(1001);
  expect(tokens(text)).toBe(1001);
  const base = { supports: [], reason: "evidence", createdAt: "now" };
  const op: KnowledgeOperationInput = operation === "split"
    ? { op: "split", knowledgeId: first!.knowledgeId, baseCommit: first!.commit, children: [
      { text: "valid child", category: "constraint", topics: [] }, { text, category: "constraint", topics: [] }], ...base }
    : operation === "merge"
      ? { op: "merge", intoKnowledgeId: first!.knowledgeId, intoBaseCommit: first!.commit,
        absorb: [{ knowledgeId: second!.knowledgeId, baseCommit: second!.commit }], text,
        category: "constraint", scope: "project", topics: [], ...base }
      : { op: "update", knowledgeId: first!.knowledgeId, baseCommit: first!.commit, text,
        category: "constraint", scope: "project", topics: [], ...base };
  const before = store.listKnowledgeRevisions().length;
  const rejected = store.commitConsolidationRun({ path, run, operations: [op] });
  expect(rejected.ok).toBe(false);
  if (!rejected.ok) expect(rejected.problems.join(" ")).toMatch(/Knowledge item.*1000-token limit: \d+ tokens/);
  expect(store.listKnowledgeRevisions()).toHaveLength(before);
  if (operation === "merge" && oversizedManual?.ok) {
    const inherited = oversizedManual.committed[0]!;
    const omitted = store.commitConsolidationRun({ path, run, operations: [{ op: "merge", intoKnowledgeId: first!.knowledgeId,
      intoBaseCommit: first!.commit, absorb: [{ knowledgeId: inherited.knowledgeId, baseCommit: inherited.commit }],
      category: "constraint", scope: "project", topics: [], ...base }] });
    expect(omitted.ok).toBe(false);
    if (!omitted.ok) expect(omitted.problems.join(" ")).toContain("1000-token limit: 1001 tokens");
    expect(store.listKnowledgeRevisions()).toHaveLength(before);
  }
  const exact = "x ".repeat(1000);
  expect(tokens(exact)).toBe(1000);
  const accepted: KnowledgeOperationInput = op.op === "split"
    ? { ...op, children: [op.children[0]!, { ...op.children[1]!, text: exact }] }
    : { ...op, text: exact };
  expect(store.commitConsolidationRun({ path, run, operations: [accepted] }).ok).toBe(true);
});
