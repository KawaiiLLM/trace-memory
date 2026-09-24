import { afterEach, expect, test } from "vitest";
import { tokens } from "../../../src/core/render/index.ts";
import { Store, type KnowledgeOperationInput } from "../../../src/core/store/index.ts";

const stores: Store[] = [];
afterEach(() => { for (const store of stores.splice(0)) store.close(); });

function fixture() {
  const store = new Store(":memory:"); stores.push(store);
  const project = store.createProject({ name: "size", declaredBy: "mark" });
  const session = store.createSession({ host: "test", projectId: project.id, enrollmentChoice: true, startedAt: "now", firstReplyAt: "now" });
  const turn = store.appendTurn({ sessionId: session.id, kind: "turn", userPrompt: "evidence", startedAt: "now" });
  const path = { sessionId: session.id, branch: "main", headTurnId: turn.id };
  const fact = (text: string, kind: "manual" | "noting" = "manual") => store.commitNotingRun({ run: { kind, sessionId: session.id, createdAt: "now" }, facts: [
    { turnId: turn.id, text, category: "decision", actor: "user", source: [`T${turn.id}#user`], createdAt: "now" },
  ] });
  const evidence = fact("An accepted direct observation");
  if (!evidence.ok) throw Error(evidence.problems.join("; "));
  const write = (operations: KnowledgeOperationInput[], kind: "manual" | "consolidation" = "consolidation") =>
    store.commitConsolidationRun({ path, run: { kind, sessionId: session.id, createdAt: "now" }, operations });
  const create = (text: string): KnowledgeOperationInput => ({ op: "create", handle: "$1", author: "test", text,
    category: "constraint", scope: "project", supports: [evidence.facts[0]!.id], topics: [], reason: "direct evidence", createdAt: "now" });
  return { store, project, session, path, fact, evidence: evidence.facts[0]!, write, create };
}

function sized(size: number) {
  // An estimator-accurate boundary, including its trailing space and no hidden framing.
  let text = "word ".repeat(size);
  while (tokens(text) > size) text = text.slice(0, -1);
  while (tokens(text) < size) text += "x";
  expect(tokens(text)).toBe(size);
  return text;
}

test("86: N fact write accepts 1000, rejects 1001 and rolls back the entire batch; manual note is unchanged", () => {
  const f = fixture(), exact = sized(1000), over = sized(1001);
  expect(f.fact(exact, "noting").ok).toBe(true);
  const before = f.store.listTurnFacts(f.path.headTurnId).length;
  const refused = f.store.commitNotingRun({ run: { kind: "noting", sessionId: f.session.id, createdAt: "now" }, facts: [
    { turnId: f.path.headTurnId, text: "accepted before rejection", category: "decision", actor: "user", source: [`T${f.path.headTurnId}#user`], createdAt: "now" },
    { turnId: f.path.headTurnId, text: over, category: "decision", actor: "user", source: [`T${f.path.headTurnId}#user`], createdAt: "now" },
  ] });
  expect(refused.ok).toBe(false);
  if (!refused.ok) expect(refused.problems.join(" ")).toMatch(/Fact.*1000-token limit: 1001 tokens/);
  expect(f.store.listTurnFacts(f.path.headTurnId)).toHaveLength(before);
  expect(f.fact(over, "manual").ok).toBe(true);
});

test("86: C create/update check each resulting text, without limiting manual memory", () => {
  const f = fixture(), exact = sized(1000), over = sized(1001);
  expect(f.write([f.create(exact)]).ok).toBe(true);
  const base = f.write([f.create("initial")]);
  if (!base.ok) throw Error(base.problems.join("; "));
  const item = base.committed[0]!;
  const change = (text: string): KnowledgeOperationInput => ({ op: "update", knowledgeId: item.knowledgeId,
    baseCommit: item.commit, text, category: "constraint", scope: "project", topics: [], supports: [f.evidence.id], reason: "new evidence", createdAt: "now" });
  const before = f.store.listKnowledgeRevisions().length;
  for (const op of [f.create(over), change(over)]) {
    const result = f.write([f.create("would roll back"), op]);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.problems.join(" ")).toMatch(/Knowledge item.*1000-token limit: 1001 tokens/);
    expect(f.store.listKnowledgeRevisions()).toHaveLength(before);
  }
  expect(f.write([change(exact)]).ok).toBe(true);
  expect(f.write([f.create(over)], "manual").ok).toBe(true);
});
