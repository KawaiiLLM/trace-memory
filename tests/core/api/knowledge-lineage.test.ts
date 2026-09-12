import { afterEach, expect, test } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { TraceMemory, type DreamingAgentInput } from "../../../src/core/api/index.ts";
import { compareTriggerOrigins } from "../../../src/core/model/index.ts";
import { Store, type KnowledgeOperationInput, type KnowledgePath, type SourceInput } from "../../../src/core/store/index.ts";

const stores: Store[] = [], dirs: string[] = [];
afterEach(() => {
  for (const store of stores.splice(0)) if (!store.closed) store.close();
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

const time = "2026-09-12T00:00:00.000Z";
function fixture() {
  const store = new Store(":memory:"); stores.push(store);
  const project = store.createProject({ name: "lineage", declaredBy: "mark" });
  const session = store.createSession({ host: "test", enrollmentChoice: true, projectId: project.id, startedAt: time, firstReplyAt: time });
  const append = (turnId: number, nativeId: string, text: string): SourceInput => ({ sessionId: session.id, turnId, nativeId,
    nativeLineage: "native-session", role: "user", text, raw: JSON.stringify({ role: "user", content: text }), calls: [] });
  const rootTurn = store.appendTurn({ sessionId: session.id, kind: "turn", userPrompt: "root", startedAt: time });
  const rootEntry = store.appendSourceEntry(append(rootTurn.id, "root", "root"));
  store.selectSourcePath(session.id, "root", [rootEntry.id]);
  const note = (turnId: number, entryId: number, text: string) => {
    const result = store.commitNotingRun({ run: { kind: "manual", sessionId: session.id, branch: "root", createdAt: time }, facts: [{
      turnId, entryIds: [entryId], category: "decision", actor: "user", text, source: [`T${turnId}#E1`], createdAt: time,
    }] });
    if (!result.ok) throw new Error(result.problems.join("; "));
    return result.facts[0]!.id;
  };
  const rootFact = note(rootTurn.id, rootEntry.id, "root evidence");
  const write = (path: KnowledgePath, operations: KnowledgeOperationInput[]) => {
    const result = store.commitConsolidationRun({ path, run: { kind: "manual", sessionId: session.id, branch: path.branch, createdAt: time }, operations });
    if (!result.ok) throw new Error(result.problems.join("; "));
    return result.committed;
  };
  const content = (text: string, supports: number[], scope = "project" as const) => ({ text, category: "constraint" as const,
    scope, supports, topics: [], reason: `change to ${text}`, createdAt: time });
  const rootPath = { sessionId: session.id, branch: "root", headTurnId: rootTurn.id };
  const created = write(rootPath, [{ op: "create", handle: "$root", author: "test", ...content("root conclusion", [rootFact]) }])[0]!;
  return { store, project, session, rootTurn, rootEntry, rootFact, rootPath, append, note, write, content, created };
}

test("34a: change-only revisions recurse through exact historical parents and preserve inherited grounding", () => {
  const f = fixture();
  const childTurn = f.store.appendTurn({ sessionId: f.session.id, parentTurnId: f.rootTurn.id, kind: "turn", userPrompt: "child", startedAt: time });
  const childEntry = f.store.appendSourceEntry(f.append(childTurn.id, "child", "child"));
  f.store.selectSourcePath(f.session.id, "child", [f.rootEntry.id, childEntry.id]);
  const childFact = f.note(childTurn.id, childEntry.id, "child-only evidence");
  const childPath = { sessionId: f.session.id, branch: "child", headTurnId: childTurn.id };
  const first = f.write(childPath, [{ op: "update", knowledgeId: f.created.knowledgeId, baseCommit: f.created.commit,
    ...f.content("complete child conclusion", [childFact]) }])[0]!;
  const second = f.write(childPath, [{ op: "update", knowledgeId: f.created.knowledgeId, baseCommit: first.commit,
    ...f.content("complete later conclusion", [f.rootFact]) }])[0]!;

  expect(f.store.knowledgeRevision(second.commit)).toMatchObject({ text: "complete later conclusion", supports: [f.rootFact],
    supportSemantics: "change", parentId: first.commit });
  expect(f.store.currentCommit(f.created.knowledgeId, f.rootPath).map(r => r.id)).toEqual([f.created.commit]);
  expect(f.store.currentCommit(f.created.knowledgeId, childPath).map(r => r.id)).toEqual([second.commit]);
  expect([...f.store.revisionGrounds(f.store.knowledgeRevision(second.commit)!)]).toEqual([f.rootFact, childFact]);

  const range = f.store.retainDreamingRange(childPath, [second.commit]);
  const claim = f.store.acquireClaim(childPath, "dreaming", "split-test")!;
  const executionId = f.store.beginExecution({ sessionId: f.session.id, phase: "dreaming", head: range.anchor, origin: range.origin });
  const run = f.store.bindDreamingRun(f.store.bindRunOrigin({ kind: "dreaming", sessionId: f.session.id, branch: "child", dreamingRangeId: range.id,
    claim, executionId, createdAt: time }, range.origin));
  const split = f.store.commitConsolidationRun({ path: childPath, run, operations: [{ op: "split", knowledgeId: f.created.knowledgeId,
    baseCommit: second.commit, supports: [f.rootFact], reason: "separate the complete result", createdAt: time,
    children: [{ text: "first complete result", category: "constraint", topics: [] }, { text: "second complete result", category: "goal", topics: [] }] }] });
  expect(split.ok).toBe(true);
  if (!split.ok) return;
  expect(f.store.currentCommit(f.created.knowledgeId, f.rootPath).map(r => r.id)).toEqual([f.created.commit]);
  expect(f.store.listCurrentKnowledge(childPath).map(v => v.revision.id)).toEqual(split.committed.map(v => v.commit));
  for (const child of split.committed) expect([...f.store.revisionGrounds(f.store.knowledgeRevision(child.commit)!)]).toEqual([f.rootFact, childFact]);
});

test("34a: a caller-supplied Dreamer role cannot forge trusted revision provenance", () => {
  const f = fixture();
  const result = f.store.commitConsolidationRun({ path: f.rootPath, run: { kind: "dreaming", sessionId: f.session.id, branch: "root", createdAt: time }, operations: [{
    op: "update", knowledgeId: f.created.knowledgeId, baseCommit: f.created.commit, ...f.content("spoofed ordinary update", [f.rootFact]),
  }] });
  expect(result.ok).toBe(true);
  if (!result.ok) return;
  expect(f.store.knowledgeRevision(result.committed[0]!.commit)!.actorRole).toBe("manual");
  const split = f.store.commitConsolidationRun({ path: f.rootPath, run: { kind: "dreaming", sessionId: f.session.id, branch: "root", createdAt: time }, operations: [{
    op: "split", knowledgeId: f.created.knowledgeId, baseCommit: result.committed[0]!.commit, supports: [], reason: "spoof",
    children: [{ text: "a", category: "constraint", topics: [] }, { text: "b", category: "goal", topics: [] }], createdAt: time,
  }] });
  expect(split.ok).toBe(false);
});

test("34a: a merge has exactly two parents and cannot apply where either historical parent is inapplicable", () => {
  const f = fixture();
  const childTurn = f.store.appendTurn({ sessionId: f.session.id, parentTurnId: f.rootTurn.id, kind: "turn", userPrompt: "child", startedAt: time });
  const childEntry = f.store.appendSourceEntry(f.append(childTurn.id, "child", "child"));
  f.store.selectSourcePath(f.session.id, "child", [f.rootEntry.id, childEntry.id]);
  const childFact = f.note(childTurn.id, childEntry.id, "child-only evidence");
  const childPath = { sessionId: f.session.id, branch: "child", headTurnId: childTurn.id };
  const childOnly = f.write(childPath, [{ op: "create", handle: "$child", author: "test", ...f.content("child-only conclusion", [childFact]) }])[0]!;
  const range = f.store.retainDreamingRange(childPath, [f.created.commit, childOnly.commit]);
  const claim = f.store.acquireClaim(childPath, "dreaming", "test")!;
  const executionId = f.store.beginExecution({ sessionId: f.session.id, phase: "dreaming", head: range.anchor, origin: range.origin });
  const run = f.store.bindDreamingRun(f.store.bindRunOrigin({ kind: "dreaming", sessionId: f.session.id, branch: "child", dreamingRangeId: range.id,
    claim, executionId, createdAt: time }, range.origin));
  const result = f.store.commitConsolidationRun({ path: childPath, run, operations: [{ op: "merge", intoKnowledgeId: f.created.knowledgeId, intoBaseCommit: f.created.commit,
    absorb: [{ knowledgeId: childOnly.knowledgeId, baseCommit: childOnly.commit }], ...f.content("complete merged conclusion", [f.rootFact]) }] });
  if (!result.ok) throw new Error(result.problems.join("; "));
  const merged = result.committed[0]!;

  expect(f.store.commitParents(f.store.knowledgeRevision(merged.commit)!).map(r => r.id)).toEqual([f.created.commit, childOnly.commit]);
  expect(f.store.listCurrentKnowledge(f.rootPath).map(v => [v.knowledge.id, v.revision.id])).toEqual([[f.created.knowledgeId, f.created.commit]]);
  expect(f.store.listCurrentKnowledge(childPath).map(v => v.revision.id)).toEqual([merged.commit]);
  const malformed = f.store.commitConsolidationRun({ path: childPath, run, operations: [{
    op: "merge", intoKnowledgeId: f.created.knowledgeId, intoBaseCommit: merged.commit,
    absorb: [{ knowledgeId: childOnly.knowledgeId, baseCommit: childOnly.commit }, { knowledgeId: f.created.knowledgeId, baseCommit: f.created.commit }],
    ...f.content("illegal three-parent merge", [f.rootFact]),
  }] });
  expect(malformed.ok).toBe(false);
  if (!malformed.ok) expect(malformed.problems.join()).toContain("exactly two distinct parents");
});

test("34a: trusted Dreamer split is atomic, reaches both child families and certifies only their current descendants", async () => {
  const dir = mkdtempSync(join(tmpdir(), "tm-34a-split-")); dirs.push(dir);
  let parent = { knowledgeId: 0, commit: 0 };
  let attempted = false;
  const memory = TraceMemory(join(dir, "memory.sqlite"), async raw => {
    const input = raw as DreamingAgentInput;
    if (input.kind !== "dreaming") throw new Error("unexpected phase");
    input.reportRequest({ offline: true });
    const tool = input.tools.find(t => t.name === "memory")!;
    const illegalCreate = tool.execute({ operations: [{ op: "create", text: "not a split", category: "constraint", scope: "project", topics: [], supports: ["F1"], reason: "illegal" }], skipped: [] });
    expect(illegalCreate).toContain("rejected:");
    const invalid = tool.execute({ operations: [{ op: "split", id: `K${parent.knowledgeId}@${parent.commit}`, supports: [], reason: "separate independent rules",
      children: [{ text: "first rule", category: "constraint", topics: [] }, { text: "", category: "goal", topics: [] }] }], skipped: [] });
    expect(invalid).toContain("rejected:");
    expect(memory.store.listKnowledgeRevisions()).toHaveLength(1);
    const split = JSON.parse(tool.execute({ operations: [{ op: "split", id: `K${parent.knowledgeId}@${parent.commit}`, supports: [], reason: "separate independent rules",
      children: [{ text: "first rule", category: "constraint", topics: ["first"] }, { text: "second rule", category: "goal", topics: ["second"] }] }], skipped: [] }));
    expect(split.committed).toHaveLength(2);
    const [first, second] = split.committed as { knowledgeId: number; commit: number }[];
    const trace = input.tools.find(t => t.name === "trace")!;
    expect(trace.execute({ address: `K${first!.knowledgeId}@${first!.commit}`, itemBudget: null })).not.toContain("rejected:");
    const update = JSON.parse(tool.execute({ operations: [{ op: "update", id: `K${first!.knowledgeId}@${first!.commit}`,
      text: "first rule, clarified", category: "constraint", scope: "project", topics: ["first"], supports: [], reason: "clarify structure" }], skipped: [] }));
    expect(update.committed).toHaveLength(1);
    expect(input.tools.find(t => t.name === "check")!.execute({})).not.toContain('"failures":["');
    attempted = true;
    return { outcome: "success", output: "done", request: { offline: true } };
  }, { dreaming: { triggerTokens: 1 } });
  stores.push(memory.store);
  const fstore = memory.store;
  const project = fstore.createProject({ name: "split", declaredBy: "mark" });
  const session = fstore.createSession({ host: "test", enrollmentChoice: true, projectId: project.id, startedAt: time, firstReplyAt: time });
  const turn = fstore.appendTurn({ sessionId: session.id, kind: "turn", userPrompt: "compound", startedAt: time });
  const entry = fstore.appendSourceEntry({ sessionId: session.id, turnId: turn.id, nativeId: "trigger", nativeLineage: "pi-session", role: "user", text: "compound", raw: "{}", calls: [] });
  fstore.selectSourcePath(session.id, "main", [entry.id]);
  const facts = fstore.commitNotingRun({ run: { kind: "manual", sessionId: session.id, branch: "main", createdAt: time }, facts: [{ turnId: turn.id,
    entryIds: [entry.id], category: "decision", actor: "user", text: "compound", source: [`T${turn.id}#E1`], createdAt: time }] });
  if (!facts.ok) throw new Error(facts.problems.join());
  const created = fstore.commitConsolidationRun({ path: { sessionId: session.id, branch: "main", headTurnId: turn.id },
    run: { kind: "manual", sessionId: session.id, branch: "main", createdAt: time }, operations: [{ op: "create", handle: "$parent", author: "test",
      text: "first rule and second rule", category: "constraint", scope: "project", supports: [facts.facts[0]!.id], topics: ["compound"], reason: "initial", createdAt: time }] });
  if (!created.ok) throw new Error(created.problems.join());
  parent = created.committed[0]!;

  const result = await memory.dream({ sessionId: session.id, branch: "main", headTurnId: turn.id });
  expect(result.outcome).toBe("success");
  expect(attempted).toBe(true);
  const revisions = fstore.listKnowledgeRevisions();
  const children = revisions.filter(r => r.op === "split");
  expect(children).toHaveLength(2);
  expect(new Set(children.map(r => r.knowledgeId)).size).toBe(2);
  expect(children.every(r => r.parentId === parent.commit && r.scope === "project" && !r.supports.length && r.actorRole === "dreaming")).toBe(true);
  expect(fstore.listKnowledgeLinks(parent.knowledgeId).filter(link => link.kind === "split_from")).toHaveLength(2);
  expect(revisions.some(r => r.op === "archive")).toBe(false);
  const current = fstore.listCurrentKnowledge({ sessionId: session.id, branch: "main", headTurnId: turn.id }).map(v => v.revision);
  expect(current).toHaveLength(2);
  expect(current.map(r => r.text).sort()).toEqual(["first rule, clarified", "second rule"]);
  expect(current.every(r => fstore.isKnowledgeProcessed(r.id))).toBe(true);
  expect(children.find(r => r.text === "first rule") && fstore.isKnowledgeProcessed(children.find(r => r.text === "first rule")!.id)).toBe(false);
  const retained = fstore.dreamingRange(1, true)!;
  expect(retained.knowledgeIds).toEqual(expect.arrayContaining(children.map(r => r.knowledgeId)));
  expect(retained.origin).toEqual({ sessionId: session.id, entryIds: [entry.id] });
  if (!("runId" in result)) throw new Error("missing Dreamer run");
  expect(fstore.getRun(result.runId)!.origin).toEqual(retained.origin);
  expect(current.every(revision => revision.runId === result.runId)).toBe(true);
  const execution = fstore.db.prepare("SELECT e.* FROM task_executions e JOIN execution_runs x ON x.execution_id = e.id WHERE x.run_id = ?").get(result.runId)!;
  expect({ sessionId: execution.origin_session_id, entryIds: JSON.parse(String(execution.origin_entry_ids)) }).toEqual(retained.origin);
  memory.close();
  const reopened = new Store(join(dir, "memory.sqlite")); stores.push(reopened);
  expect(reopened.dreamingRange(retained.id, true)!.origin).toEqual(retained.origin);
  expect(reopened.getRun(result.runId)!.origin).toEqual(retained.origin);
});

test("34a migration labels legacy supports without changing ids, links, marks or certifications", () => {
  const dir = mkdtempSync(join(tmpdir(), "tm-34a-upgrade-")); dirs.push(dir);
  const db = join(dir, "memory.sqlite"), store = new Store(db);
  const project = store.createProject({ name: "upgrade", declaredBy: "mark" });
  const session = store.createSession({ host: "test", enrollmentChoice: true, projectId: project.id, startedAt: time, firstReplyAt: time });
  const turn = store.appendTurn({ sessionId: session.id, kind: "turn", userPrompt: "legacy", startedAt: time });
  const fact = store.commitNotingRun({ run: { kind: "manual", sessionId: session.id, createdAt: time }, facts: [{ turnId: turn.id,
    category: "decision", actor: "user", text: "legacy", source: [`T${turn.id}#user`], createdAt: time }] });
  if (!fact.ok) throw new Error(fact.problems.join());
  const create = (handle: string) => store.commitConsolidationRun({ run: { kind: "manual", sessionId: session.id, createdAt: time }, operations: [{
    op: "create", handle, author: "legacy", text: handle, category: "constraint", scope: "project", supports: [fact.facts[0]!.id], topics: [], reason: "legacy", createdAt: time }] });
  const first = create("$first"), second = create("$second");
  if (!first.ok || !second.ok) throw new Error("fixture failed");
  store.db.prepare("INSERT INTO knowledge_links VALUES (?,?,'merged_into',?,?)").run(first.committed[0]!.knowledgeId, first.committed[0]!.commit, second.committed[0]!.knowledgeId, second.committed[0]!.commit);
  store.mark(first.committed[0]!.commit, "verified", time);
  const run = store.recordRun({ kind: "dreaming", sessionId: session.id, createdAt: time, outcome: "success" });
  store.db.prepare("INSERT INTO dreaming_completions VALUES (?,?,?)").run(run.id, "[]", JSON.stringify([second.committed[0]!.commit]));
  store.db.prepare("INSERT INTO processed_knowledge_versions VALUES (?,?)").run(second.committed[0]!.commit, run.id);
  const before = { revisions: store.listKnowledgeRevisions().map(r => ({ id: r.id, knowledgeId: r.knowledgeId, supports: r.supports })),
    links: store.listKnowledgeLinks(first.committed[0]!.knowledgeId), marks: store.listKnowledgeMarks(first.committed[0]!.knowledgeId) };
  store.close();
  const raw = new DatabaseSync(db);
  raw.exec("ALTER TABLE knowledge_revisions DROP COLUMN support_semantics"); raw.close();
  const reopened = new Store(db); stores.push(reopened);
  expect(reopened.listKnowledgeRevisions().map(r => ({ id: r.id, knowledgeId: r.knowledgeId, supports: r.supports }))).toEqual(before.revisions);
  expect(reopened.listKnowledgeRevisions().every(r => r.supportSemantics === "complete_result")).toBe(true);
  expect(reopened.listKnowledgeLinks(first.committed[0]!.knowledgeId)).toEqual(before.links);
  expect(reopened.listKnowledgeMarks(first.committed[0]!.knowledgeId)).toEqual(before.marks);
  expect(reopened.isKnowledgeProcessed(second.committed[0]!.commit)).toBe(true);
  expect(reopened.getRun(run.id)!.origin).toBeNull();
  reopened.close();
  const stable = new Store(db); stores.push(stable);
  expect(stable.listKnowledgeRevisions().map(r => r.id)).toEqual(before.revisions.map(r => r.id));
  expect(stable.isKnowledgeProcessed(second.committed[0]!.commit)).toBe(true);
});

test("34a: bound origin freezes the ordered native path through the exact same-Turn trigger", () => {
  const memory = TraceMemory(":memory:", async () => { throw new Error("offline"); }); stores.push(memory.store);
  const store = memory.store;
  const project = store.createProject({ name: "origin", declaredBy: "mark" });
  const session = store.createSession({ host: "test", enrollmentChoice: true, projectId: project.id, startedAt: time, firstReplyAt: time });
  const turn = store.appendTurn({ sessionId: session.id, kind: "turn", userPrompt: "one turn", startedAt: time });
  const entry = (nativeId: string) => store.appendSourceEntry({ sessionId: session.id, turnId: turn.id, nativeId, nativeLineage: "pi-session", role: "assistant", text: nativeId, raw: "{}", calls: [] });
  const first = entry("first"), trigger = entry("trigger"), later = entry("later");
  store.selectSourcePath(session.id, "main", [first.id, trigger.id, later.id]);
  const facts = store.commitNotingRun({ run: { kind: "manual", sessionId: session.id, branch: "main", createdAt: time }, facts: [{ turnId: turn.id,
    entryIds: [trigger.id], category: "decision", actor: "user", text: "evidence", source: [`T${turn.id}#E2`], createdAt: time }] });
  if (!facts.ok) throw new Error(facts.problems.join());
  const tools = memory.tools({ kind: "manual", sessionId: session.id, branch: "main", currentTurnId: turn.id, triggerEntryId: trigger.id });
  const result = tools.find(t => t.name === "memory")!.execute({ operations: [{ op: "create", text: "origin-backed", category: "constraint", scope: "project",
    topics: [], supports: [`F${facts.facts[0]!.id}`], reason: "initial" }], skipped: [] });
  expect(result).not.toContain("rejected:");
  const frozen = store.listRuns(session.id).at(-1)!.origin;
  expect(frozen).toEqual({ sessionId: session.id, entryIds: [first.id, trigger.id] });
  expect(compareTriggerOrigins(frozen, { sessionId: session.id, entryIds: [first.id, trigger.id, later.id] })).toBe("ancestor");
  expect(compareTriggerOrigins(frozen, { sessionId: session.id, entryIds: [first.id, later.id] })).toBe("divergent");
  expect(compareTriggerOrigins(frozen, { sessionId: session.id + 1, entryIds: [first.id, trigger.id] })).toBe("independent");
  expect(compareTriggerOrigins(frozen, null)).toBe("unknown");

  store.db.prepare("UPDATE source_paths SET entry_ids = '[999]' WHERE session_id = ? AND branch = 'main'").run(session.id);
  expect(() => memory.tools({ kind: "manual", sessionId: session.id, branch: "main", currentTurnId: turn.id })).toThrow(/trigger origin/i);
});
