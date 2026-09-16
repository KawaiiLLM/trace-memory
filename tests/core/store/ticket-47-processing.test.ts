import { afterEach, expect, test } from "vitest";
import { Store, type KnowledgeOperationInput } from "../../../src/core/store/index.ts";
import { processedBlock, processedProjection } from "../../../src/core/store/processing.ts";
import { tokens } from "../../../src/core/render/index.ts";

const stores: Store[] = [];
afterEach(() => { for (const store of stores.splice(0)) store.close(); });

function fixture() {
  const store = new Store(":memory:"); stores.push(store);
  const project = store.createProject({ name: "path-pools", declaredBy: "mark" });
  const session = store.createSession({ host: "test", enrollmentChoice: true, projectId: project.id, startedAt: "now", firstReplyAt: "now" });
  const rootTurn = store.appendTurn({ sessionId: session.id, kind: "turn", userPrompt: "root", startedAt: "now" });
  const rootFact = store.commitNotingRun({ run: { kind: "manual", sessionId: session.id, createdAt: "now" }, facts: [{
    turnId: rootTurn.id, category: "decision", actor: "user", text: "shared rule", source: [`T${rootTurn.id}#user`], createdAt: "now",
  }] });
  if (!rootFact.ok) throw new Error(rootFact.problems.join("; "));
  const root = { sessionId: session.id, branch: "main", headTurnId: rootTurn.id };
  const content = { category: "constraint" as const, scope: "project" as const, supports: [rootFact.facts[0]!.id], topics: [], reason: "test", createdAt: "now" };
  const write = (path: typeof root, operation: KnowledgeOperationInput) => {
    const result = store.commitConsolidationRun({ path, run: { kind: "manual", sessionId: session.id, branch: path.branch, createdAt: "now" }, operations: [operation] });
    if (!result.ok) throw new Error(result.problems.join("; "));
    return result.committed[0]!;
  };
  const complete = (commit: number, path = root) => {
    const range = store.retainDreamingRange(path, [commit]);
    const run = store.recordRun({ kind: "dreaming", sessionId: session.id, branch: path.branch, dreamingRangeId: range.id, outcome: "success", createdAt: "now" });
    store.completeDreaming(run.id, [commit], [commit]);
  };
  const base = write(root, { op: "create", handle: "$base", author: "test", text: "small root rule", ...content });
  complete(base.commit);
  const siblingTurn = store.appendTurn({ sessionId: session.id, parentTurnId: rootTurn.id, kind: "turn", userPrompt: "sibling", startedAt: "later" });
  const siblingFact = store.commitNotingRun({ run: { kind: "manual", sessionId: session.id, branch: "sibling", createdAt: "later" }, facts: [{
    turnId: siblingTurn.id, category: "decision", actor: "user", text: "sibling change", source: [`T${siblingTurn.id}#user`], createdAt: "later",
  }] });
  if (!siblingFact.ok) throw new Error(siblingFact.problems.join("; "));
  const sibling = { sessionId: session.id, branch: "sibling", headTurnId: siblingTurn.id };
  const successor = write(sibling, { op: "update", knowledgeId: base.knowledgeId, baseCommit: base.commit,
    text: "large sibling rule ".repeat(600), ...content, supports: [siblingFact.facts[0]!.id] });
  complete(successor.commit, sibling);
  return { store, project, session, root, sibling, content, write, complete, base, successor, siblingFact: siblingFact.facts[0]! };
}

function ownerTotal(store: Store, path: { sessionId: number; branch: string; headTurnId: number }, owner: string) {
  return store.checkProcessedScopes([], path).totals.find(total => total.scope === owner)!;
}

test("47: processed owner pools contain only current processed versions on the measured path", () => {
  const f = fixture();
  const owner = `project:${f.project.id}`;
  const baseValue = { knowledge: f.store.getKnowledge(f.base.knowledgeId)!, revision: f.store.knowledgeRevision(f.base.commit)! };
  const successorValue = { knowledge: f.store.getKnowledge(f.successor.knowledgeId)!, revision: f.store.knowledgeRevision(f.successor.commit)! };
  expect(ownerTotal(f.store, f.root, owner).tokens).toBe(tokens(processedBlock([baseValue])));
  expect(ownerTotal(f.store, f.sibling, owner).tokens).toBe(tokens(processedBlock([successorValue])));

  const rootProjection = processedProjection(f.store, [], undefined, undefined, f.root).paths[0]!;
  expect([...rootProjection.pools.get(owner)!.keys()]).toEqual([f.base.commit]);
  expect(rootProjection.values.map(value => value.revision.id)).toEqual([f.base.commit]);
  expect([...rootProjection.pools.values()].flatMap(pool => [...pool.keys()])).toEqual([f.base.commit]);
  expect(ownerTotal(f.store, f.root, owner).tokens).not.toBe(ownerTotal(f.store, f.sibling, owner).tokens);
});

test("47: Settings still checks every stored path independently and a rewind can exceed the live path", () => {
  const f = fixture();
  const owner = `project:${f.project.id}`;
  const rootUsed = ownerTotal(f.store, f.root, owner).tokens;
  const siblingUsed = ownerTotal(f.store, f.sibling, owner).tokens;
  expect(siblingUsed).toBeGreaterThan(rootUsed);
  expect(() => f.store.setKnowledgeBudget("project", rootUsed)).toThrow(new RegExp(`${owner}: used .*overage .*path S${f.session.id}//T${f.sibling.headTurnId}`));

  const archived = f.write(f.sibling, { op: "archive", knowledgeId: f.successor.knowledgeId, baseCommit: f.successor.commit,
    supports: [f.siblingFact.id], reason: "retire only on sibling", createdAt: "later" });
  f.complete(archived.commit, f.sibling);
  expect(ownerTotal(f.store, f.sibling, owner).tokens).toBe(0);
  expect(ownerTotal(f.store, f.root, owner).tokens).toBe(rootUsed);
});

test("47: each owner and the applicable union use their own complete rendering", () => {
  const f = fixture();
  const global = f.write(f.root, { op: "create", handle: "$global", author: "test", text: "global item", ...f.content, scope: "global" });
  const session = f.write(f.root, { op: "create", handle: "$session", author: "test", text: "session item", ...f.content, scope: "session" });
  f.complete(global.commit, f.root); f.complete(session.commit, f.root);
  const projection = processedProjection(f.store, [], undefined, undefined, f.root).paths[0]!;
  const itemIds = new Set(projection.values.map(value => value.revision.id));
  const pooledIds = new Set([...projection.pools.values()].flatMap(pool => [...pool.keys()]));
  expect(pooledIds).toEqual(itemIds);
  const check = f.store.checkProcessedScopes([], f.root);
  const ownerSum = check.totals.filter(total => !total.scope.startsWith("applicable:")).reduce((sum, total) => sum + total.tokens, 0);
  const applicable = check.totals.find(total => total.scope.startsWith("applicable:"))!.tokens;
  expect(applicable).not.toBe(ownerSum);
});

test("47: head archives and merges reserve nothing there while a stored rewind keeps larger exact versions", () => {
  const store = new Store(":memory:"); stores.push(store);
  const project = store.createProject({ name: "head-rewind", declaredBy: "mark" });
  const session = store.createSession({ host: "test", enrollmentChoice: true, projectId: project.id, startedAt: "now", firstReplyAt: "now" });
  const turn = store.appendTurn({ sessionId: session.id, kind: "turn", userPrompt: "paths", startedAt: "now" });
  const entry = (nativeId: string) => store.appendSourceEntry({ sessionId: session.id, turnId: turn.id, nativeLineage: "paths", nativeId,
    role: "user", text: nativeId, raw: "{}", calls: [] });
  const rootEntry = entry("root"), headEntry = entry("head"), siblingEntry = entry("sibling");
  store.selectSourcePath(session.id, "root", [rootEntry.id]);
  store.selectSourcePath(session.id, "head", [rootEntry.id, headEntry.id]);
  store.selectSourcePath(session.id, "rewind", [rootEntry.id]);
  store.selectSourcePath(session.id, "sibling", [rootEntry.id, siblingEntry.id]);
  const noted = store.commitNotingRun({ run: { kind: "manual", sessionId: session.id, branch: "head", createdAt: "now" }, facts: [{
    turnId: turn.id, entryIds: [rootEntry.id], category: "decision", actor: "user", text: "root evidence", source: [`T${turn.id}#E1`], createdAt: "now",
  }, {
    turnId: turn.id, entryIds: [headEntry.id], category: "decision", actor: "user", text: "head evidence", source: [`T${turn.id}#E2`], createdAt: "now",
  }] });
  if (!noted.ok) throw new Error(noted.problems.join("; "));
  const [rootFact, headFact] = noted.facts;
  const root = { sessionId: session.id, branch: "root", headTurnId: turn.id };
  const head = { sessionId: session.id, branch: "head", headTurnId: turn.id };
  const sibling = { sessionId: session.id, branch: "sibling", headTurnId: turn.id };
  const rewind = { sessionId: session.id, branch: "rewind", headTurnId: turn.id };
  const write = (path: typeof root, operation: KnowledgeOperationInput) => {
    const result = store.commitConsolidationRun({ path, run: { kind: "manual", sessionId: session.id, branch: path.branch, createdAt: "now" }, operations: [operation] });
    if (!result.ok) throw new Error(result.problems.join("; "));
    return result.committed[0]!;
  };
  const complete = (path: typeof root, eventIds: number[], resultIds: number[]) => {
    const range = store.retainDreamingRange(path, eventIds);
    const run = store.recordRun({ kind: "dreaming", sessionId: session.id, branch: path.branch, dreamingRangeId: range.id, outcome: "success", createdAt: "now" });
    store.completeDreaming(run.id, eventIds, resultIds);
  };
  const base = { category: "constraint" as const, scope: "project" as const, supports: [rootFact!.id], topics: [], reason: "root", createdAt: "now" };
  const survivor = write(root, { op: "create", handle: "$survivor", author: "test", text: "survivor", ...base });
  const victim = write(root, { op: "create", handle: "$victim", author: "test", text: "victim ".repeat(100), ...base });
  const retired = write(root, { op: "create", handle: "$retired", author: "test", text: "retired ".repeat(100), ...base });
  for (const item of [survivor, victim, retired]) complete(root, [item.commit], [item.commit]);
  const archived = write(head, { op: "archive", knowledgeId: retired.knowledgeId, baseCommit: retired.commit,
    supports: [headFact!.id], reason: "head-only archive", createdAt: "now" });
  const merge = store.commitConsolidationRun({ path: head, run: { kind: "manual", sessionId: session.id, branch: head.branch, createdAt: "now" }, operations: [{
    op: "merge", intoKnowledgeId: survivor.knowledgeId, intoBaseCommit: survivor.commit,
    absorb: [{ knowledgeId: victim.knowledgeId, baseCommit: victim.commit }], text: "head survivor", category: "constraint", scope: "project",
    supports: [headFact!.id], topics: [], reason: "head-only merge", createdAt: "now",
  }] });
  if (!merge.ok) throw new Error(merge.problems.join("; "));
  complete(head, [archived.commit, merge.committed[0]!.commit], [archived.commit, merge.committed[0]!.commit]);

  const ids = (path: typeof root) => processedProjection(store, [], undefined, undefined, path).paths[0]!.values.map(value => value.revision.id);
  expect(ids(head)).toEqual([merge.committed[0]!.commit]);
  expect(ids(sibling)).toEqual([survivor.commit, victim.commit, retired.commit]);
  expect(ids(rewind)).toEqual([survivor.commit, victim.commit, retired.commit]);
  const liveUsed = ownerTotal(store, head, `project:${project.id}`).tokens;
  const rewindUsed = ownerTotal(store, rewind, `project:${project.id}`).tokens;
  expect(rewindUsed).toBeGreaterThan(liveUsed);
  expect(() => store.setKnowledgeBudget("project", liveUsed)).toThrow(new RegExp(`project:${project.id}: used ${rewindUsed}.*path S${session.id}/rewind/T${turn.id}`));
});

test("47: completion refuses to reconstruct a frozen path from a mutable branch head", () => {
  const f = fixture();
  const pending = f.write(f.root, { op: "create", handle: "$pending", author: "test", text: "pending direct completion", ...f.content });
  const run = f.store.recordRun({ kind: "dreaming", sessionId: f.session.id, branch: f.root.branch, outcome: "success", createdAt: "now" });
  f.store.appendTurn({ sessionId: f.session.id, parentTurnId: f.root.headTurnId, kind: "turn", userPrompt: "later head", startedAt: "later" });
  expect(() => f.store.completeDreaming(run.id, [pending.commit], [pending.commit])).toThrow("admitted retained range with a frozen path");
  expect(f.store.isKnowledgeProcessed(pending.commit)).toBe(false);
});

test("47: mixed projects share Global only, same-project sessions pool Project, and placement moves path membership", () => {
  const store = new Store(":memory:"); stores.push(store);
  const projectA = store.createProject({ name: "A", declaredBy: "mark" }), projectB = store.createProject({ name: "B", declaredBy: "mark" });
  const makeSession = (projectId: number, name: string) => {
    const session = store.createSession({ host: "test", enrollmentChoice: true, projectId, startedAt: "now", firstReplyAt: "now" });
    const turn = store.appendTurn({ sessionId: session.id, kind: "turn", userPrompt: name, startedAt: "now" });
    const fact = store.commitNotingRun({ run: { kind: "manual", sessionId: session.id, createdAt: "now" }, facts: [{
      turnId: turn.id, category: "decision", actor: "user", text: `${name} evidence`, source: [`T${turn.id}#user`], createdAt: "now",
    }] });
    if (!fact.ok) throw new Error(fact.problems.join("; "));
    return { session, turn, fact: fact.facts[0]!, path: { sessionId: session.id, branch: "main", headTurnId: turn.id } };
  };
  const author = makeSession(projectA.id, "author"), peerA = makeSession(projectA.id, "peer-a"), peerB = makeSession(projectB.id, "peer-b");
  const create = (owner: typeof author, scope: "global" | "project" | "session", text: string) => {
    const result = store.commitConsolidationRun({ path: owner.path, run: { kind: "manual", sessionId: owner.session.id, branch: "main", createdAt: "now" }, operations: [{
      op: "create", handle: `$${text}`, author: "test", text, category: "constraint", scope, supports: [owner.fact.id], topics: [], reason: "scope fixture", createdAt: "now",
    }] });
    if (!result.ok) throw new Error(result.problems.join("; "));
    const item = result.committed[0]!;
    const range = store.retainDreamingRange(owner.path, [item.commit]);
    const run = store.recordRun({ kind: "dreaming", sessionId: owner.session.id, branch: "main", dreamingRangeId: range.id, outcome: "success", createdAt: "now" });
    store.completeDreaming(run.id, [item.commit], [item.commit]);
    return item;
  };
  const global = create(author, "global", "global-shared"), project = create(author, "project", "project-shared");
  const sessionOnly = create(author, "session", "session-only"), peerProject = create(peerA, "project", "peer-project");
  const projected = (path: typeof author.path) => processedProjection(store, [], undefined, undefined, path).paths[0]!;
  const ids = (path: typeof author.path) => projected(path).values.map(value => value.revision.id);
  expect(ids(peerA.path)).toEqual([global.commit, project.commit, peerProject.commit]);
  expect(ids(peerB.path)).toEqual([global.commit]);
  expect(projected(peerA.path).pools.get(`project:${projectA.id}`)!.size).toBe(2);
  expect(ids(author.path)).toEqual([global.commit, project.commit, sessionOnly.commit, peerProject.commit]);

  store.declareProject(author.session.id, projectB.name, "mark");
  expect(ids(peerA.path)).toEqual([global.commit, peerProject.commit]);
  expect(ids(peerB.path)).toEqual([global.commit, project.commit]);
  expect(ids(author.path)).toEqual([global.commit, project.commit, sessionOnly.commit]);
  expect(projected(author.path).pools.get(`project:${projectB.id}`)!.has(project.commit)).toBe(true);
  expect(projected(author.path).pools.get(`session:${author.session.id}`)!.has(sessionOnly.commit)).toBe(true);
});
