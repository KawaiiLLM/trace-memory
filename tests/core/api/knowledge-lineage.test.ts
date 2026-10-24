import { afterEach, expect, test } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { TraceMemory, memoryFiles, type DreamingAgentInput } from "../../../src/core/api/index.ts";
import { Store, type KnowledgeOperationInput, type KnowledgePath, type SourceInput } from "../../../src/core/store/index.ts";
import { renderRun } from "../../../src/core/render/index.ts";
import { applyWorkspace } from "../../../src/core/workspace/index.ts";
import { curateNow, curateWrite } from "../../support/dreamer.ts";
import { block } from "../../support/workspace.ts";
import { legacyFacts, receiptCommit } from "../../support/seed.ts";
import { ALL_POOLS } from "../../../src/core/store/processing.ts";

const stores: Store[] = [], dirs: string[] = [];
afterEach(() => {
  for (const store of stores.splice(0)) if (!store.closed) store.close();
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

const time = "2026-09-12T00:00:00.000Z";
const tagged = (store: Store, id: number, commit: number) => `K${id}#${store.versionTag(id, commit)}`;
const history = (store: Store, id: number, commit: number) => `K${id}@v${store.versionOrdinal(id, commit)}`;

function fixture() {
  const memory = TraceMemory(":memory:", async () => { throw new Error("unexpected fixture phase"); }); const store = memory.store; stores.push(store);
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
  const write = async (path: KnowledgePath, operations: KnowledgeOperationInput[]) => {
    if (operations.every(operation => operation.op === "create")) {
      const result = store.commitConsolidationRun({ path, run: { kind: "manual", sessionId: session.id, branch: path.branch, createdAt: time }, operations });
      if (!result.ok) throw new Error(result.problems.join("; "));
      return result.committed;
    }
    return curateWrite(memory, path, operations); // the Dreamer's pass: one curate file, every block applied
  };
  const content = (text: string, supports: number[], scope = "project" as const) => ({ text, category: "constraint" as const,
    scope, supports, topics: [], reason: `change to ${text}`, createdAt: time });
  const rootPath = { sessionId: session.id, branch: "root", headTurnId: rootTurn.id };
  const initial = store.commitConsolidationRun({ path: rootPath, run: { kind: "manual", sessionId: session.id, branch: "root", createdAt: time },
    operations: [{ files: null, op: "create", title: "Fixture title", handle: "$root", author: "test", ...content("root conclusion", [rootFact]) }] });
  if (!initial.ok) throw new Error(initial.problems.join("; "));
  const created = initial.committed[0]!;
  return { memory, store, project, session, rootTurn, rootEntry, rootFact, rootPath, append, note, write, content, created };
}

test("64b: change revisions use only direct facts and do not inherit historical grounding", async () => {
  const f = fixture();
  const childTurn = f.store.appendTurn({ sessionId: f.session.id, parentTurnId: f.rootTurn.id, kind: "turn", userPrompt: "child", startedAt: time });
  const childEntry = f.store.appendSourceEntry(f.append(childTurn.id, "child", "child"));
  f.store.selectSourcePath(f.session.id, "child", [f.rootEntry.id, childEntry.id]);
  const childFact = f.note(childTurn.id, childEntry.id, "child-only evidence");
  const childPath = { sessionId: f.session.id, branch: "child", headTurnId: childTurn.id };
  const first = (await f.write(childPath, [{ files: null, op: "update", knowledgeId: f.created.knowledgeId, baseCommit: f.created.commit,
    ...f.content("complete child conclusion", [childFact]) }]))[0]!;
  const second = (await f.write(childPath, [{ files: null, op: "update", knowledgeId: f.created.knowledgeId, baseCommit: first.commit,
    ...f.content("complete later conclusion", [f.rootFact]) }]))[0]!;

  expect(f.store.knowledgeRevision(second.commit)).toMatchObject({ text: "complete later conclusion", supports: [f.rootFact],
    supportSemantics: "change", parentId: first.commit });
  f.store.setCurrentPath(f.session.id, "root", f.rootTurn.id, "test-lineage");
  expect(f.store.currentCommit(f.created.knowledgeId, f.rootPath).map(r => r.id)).toEqual([second.commit]);
  expect(f.store.currentCommit(f.created.knowledgeId, childPath).map(r => r.id)).toEqual([second.commit]);
  expect([...f.store.revisionGrounds(f.store.knowledgeRevision(second.commit)!)]).toEqual([f.rootFact]);
  f.store.setCurrentPath(f.session.id, "child", childTurn.id, "test-lineage");
  expect(f.store.currentCommit(f.created.knowledgeId, f.rootPath).map(r => r.id)).toEqual([second.commit]);
  expect(f.store.currentCommit(f.created.knowledgeId, childPath).map(r => r.id)).toEqual([second.commit]);

  const split = await f.write(childPath, [{ files: null, op: "split", knowledgeId: f.created.knowledgeId, text: "Primary part.", category: "constraint", scope: "project", topics: [],
    baseCommit: second.commit, supports: [f.rootFact], reason: "separate the complete result", createdAt: time,
    children: [{ files: null, title: "Fixture child", text: "first complete result", category: "constraint", topics: [] }, { files: null, title: "Fixture child", text: "second complete result", category: "goal", topics: [] }] }]);
  f.store.setCurrentPath(f.session.id, "root", f.rootTurn.id, "test-lineage");
  expect(f.store.currentKnowledge(f.rootPath).map(v => v.revision.id)).toEqual(split.map(v => v.commit));
  f.store.setCurrentPath(f.session.id, "child", childTurn.id, "test-lineage");
  expect(f.store.currentKnowledge(childPath).map(v => v.revision.id)).toEqual(split.map(v => v.commit));
  for (const child of split) expect([...f.store.revisionGrounds(f.store.knowledgeRevision(child.commit)!)]).toEqual([f.rootFact]);
});

test("34a: a caller-supplied Dreamer role cannot forge trusted revision provenance", () => {
  const f = fixture();
  const result = f.store.commitConsolidationRun({ path: f.rootPath, run: { kind: "dreaming", sessionId: f.session.id, branch: "root", createdAt: time }, operations: [{
    files: null, op: "update", knowledgeId: f.created.knowledgeId, baseCommit: f.created.commit, ...f.content("spoofed ordinary update", [f.rootFact]),
  }] });
  expect(result.ok).toBe(false);
  if (!result.ok) expect(result.problems.join(" ")).toContain("no knowledge commit authority");
  expect(f.store.currentCommit(f.created.knowledgeId, f.rootPath).map(revision => revision.id)).toEqual([f.created.commit]);
});

test("64b: a merge keeps exactly two historical parents but applicability uses only its direct facts", async () => {
  const f = fixture();
  const childTurn = f.store.appendTurn({ sessionId: f.session.id, parentTurnId: f.rootTurn.id, kind: "turn", userPrompt: "child", startedAt: time });
  const childEntry = f.store.appendSourceEntry(f.append(childTurn.id, "child", "child"));
  f.store.selectSourcePath(f.session.id, "child", [f.rootEntry.id, childEntry.id]);
  const childFact = f.note(childTurn.id, childEntry.id, "child-only evidence");
  const childPath = { sessionId: f.session.id, branch: "child", headTurnId: childTurn.id };
  const childOnly = (await f.write(childPath, [{ files: null, op: "create", title: "Fixture title", handle: "$child", author: "test", ...f.content("child-only conclusion", [childFact]) }]))[0]!;
  const merged = (await f.write(childPath, [{ files: null, op: "merge", intoKnowledgeId: f.created.knowledgeId, intoBaseCommit: f.created.commit,
    absorb: [{ knowledgeId: childOnly.knowledgeId, baseCommit: childOnly.commit }], ...f.content("complete merged conclusion", [f.rootFact]) }]))[0]!;

  expect(f.store.commitParents(f.store.knowledgeRevision(merged.commit)!).map(r => r.id)).toEqual([f.created.commit, childOnly.commit]);
  f.store.setCurrentPath(f.session.id, "root", f.rootTurn.id, "test-lineage");
  expect(f.store.currentKnowledge(f.rootPath).map(v => [v.knowledge.id, v.revision.id])).toEqual([[f.created.knowledgeId, merged.commit]]);
  expect(f.store.currentKnowledge(childPath).map(v => [v.knowledge.id, v.revision.id])).toEqual([[f.created.knowledgeId, merged.commit]]);
  expect([...f.store.revisionGrounds(f.store.knowledgeRevision(merged.commit)!)]).toEqual([f.rootFact]);
  f.store.setCurrentPath(f.session.id, "child", childTurn.id, "test-lineage");
  expect(f.store.currentKnowledge(childPath).map(v => v.revision.id)).toEqual([merged.commit]);
  // Many-way merges are legal (2026-10-22); this one is refused because an absorbed base is the primary's own superseded version.
  const before = f.store.listKnowledgeRevisions().length;
  const malformed = applyWorkspace(f.store, { kind: "curate", sessionId: f.session.id, path: childPath, file: { name: "curate.md", text: block(`merge ${history(f.store, f.created.knowledgeId, merged.commit)}`,
    { absorb: `${history(f.store, childOnly.knowledgeId, childOnly.commit)}, ${history(f.store, f.created.knowledgeId, f.created.commit)}`,
      supports: `F${f.rootFact}`, reason: "invalid fixture" }, "illegal three-parent merge") } });
  expect(malformed.ok ? malformed.blocks.map(entry => entry.reason).join("\n") : malformed.problems.join("\n")).toMatch(/not the latest effective applicable revision|cannot absorb itself/);
  expect(f.store.listKnowledgeRevisions()).toHaveLength(before);
});

test("64b/34a: trusted Dreamer split is atomic and keeps the item as its primary part beside its children", () => {
  const memory = TraceMemory(":memory:", async () => { throw new Error("unexpected phase"); });
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
  const path = { sessionId: session.id, branch: "main", headTurnId: turn.id, triggerEntryId: entry.id };
  const created = fstore.commitConsolidationRun({ path, run: { kind: "manual", sessionId: session.id, branch: "main", createdAt: time }, operations: [{ files: null, op: "create", title: "Fixture title", handle: "$parent", author: "test",
      text: "first rule and second rule", category: "constraint", scope: "project", supports: [facts.facts[0]!.id], topics: ["compound"], reason: "initial", createdAt: time }] });
  if (!created.ok) throw new Error(created.problems.join());
  const parent = created.committed[0]!, ref = `K${parent.knowledgeId}@v1`;
  const revisions = () => fstore.listKnowledgeRevisions().length;
  const child = (title: string, category: string, text: string) => `\n### child\ntitle: ${title}\ncategory: ${category}\nscope: project\ntopics: first\nsupports: F${facts.facts[0]!.id}\nreason: separate independent rules\n\n${text}\n`;
  // One child with no body: the file is refused whole and nothing is written.
  const before = revisions();
  const invalid = applyWorkspace(fstore, { kind: "curate", sessionId: session.id, path, file: { name: "curate.md", text: block(`split ${ref}`, { reason: "separate independent rules" }, "Primary part.")
    + child("Fixture child", "constraint", "first rule") + `\n### child\ntitle: Fixture child\ncategory: goal\nscope: project\ntopics:\nsupports: F${facts.facts[0]!.id}\nreason: x\n\n` } });
  expect(invalid.ok).toBe(false);
  expect(revisions()).toBe(before);

  const [primary, first, second] = curateWrite(memory, path, [{ files: null, op: "split", knowledgeId: parent.knowledgeId, baseCommit: parent.commit, text: "Primary part.", category: "constraint", scope: "project",
    topics: [], supports: [facts.facts[0]!.id], reason: "separate independent rules", createdAt: time,
    children: [{ files: null, title: "Fixture child", text: "first rule", category: "constraint", topics: ["first"] }, { files: null, title: "Fixture child", text: "second rule", category: "goal", topics: ["second"] }] }]);
  expect(primary!.knowledgeId).toBe(parent.knowledgeId);
  const [update] = curateWrite(memory, path, [{ files: null, op: "update", knowledgeId: first!.knowledgeId, baseCommit: first!.commit, text: "first rule, clarified", category: "constraint", scope: "project",
    topics: ["first"], supports: [], reason: "clarify structure", createdAt: time }]);
  curateWrite(memory, path, [{ files: null, op: "update", knowledgeId: second!.knowledgeId, baseCommit: second!.commit, text: "second rule", category: "goal", scope: "project",
    topics: ["second"], supports: [], reason: "Keep the second independent ruling", createdAt: time }]);
  expect(update!.knowledgeId).toBe(first!.knowledgeId);

  const all = fstore.listKnowledgeRevisions();
  const children = all.filter(r => r.op === "split" && r.knowledgeId !== parent.knowledgeId);
  expect(all.filter(r => r.op === "split" && r.knowledgeId === parent.knowledgeId)).toHaveLength(1); // the primary part
  expect(children).toHaveLength(2);
  expect(new Set(children.map(r => r.knowledgeId)).size).toBe(2);
  expect(children.every(r => r.parentId === parent.commit && r.scope === "project" && r.supports.length === 1 && r.actorRole === "dreaming")).toBe(true);
  expect(children.every(r => r.supports[0] === facts.facts[0]!.id)).toBe(true);
  expect(fstore.listKnowledgeLinks(parent.knowledgeId).filter(link => link.kind === "split_from")).toHaveLength(2);
  expect(all.some(r => r.op === "archive")).toBe(false);
  const current = fstore.currentKnowledge(path).map(v => v.revision);
  expect(current).toHaveLength(3);
  expect(current.map(r => r.text).sort()).toEqual(["Primary part.", "first rule, clarified", "second rule"]);
});

test("34a migration labels legacy supports without changing ids, links or processing history", () => {
  const dir = mkdtempSync(join(tmpdir(), "tm-34a-upgrade-")); dirs.push(dir);
  const db = join(dir, "memory.sqlite"), store = new Store(db);
  const project = store.createProject({ name: "upgrade", declaredBy: "mark" });
  const session = store.createSession({ host: "test", enrollmentChoice: true, projectId: project.id, startedAt: time, firstReplyAt: time });
  const turn = store.appendTurn({ sessionId: session.id, kind: "turn", userPrompt: "legacy", startedAt: time });
  const entry = store.appendSourceEntry({ sessionId: session.id, turnId: turn.id, nativeLineage: "fixture", nativeId: "legacy-user",
    role: "user", text: "legacy", raw: "legacy", calls: [] });
  const fact = legacyFacts(store, { kind: "manual", sessionId: session.id, createdAt: time }, [{
    sources: [{ entry, address: `T${turn.id}#user` }], category: "decision", actor: "user", text: "legacy", createdAt: time,
  }]);
  const create = (handle: string) => store.commitConsolidationRun({ run: { kind: "manual", sessionId: session.id, createdAt: time }, operations: [{ files: null,
    op: "create", title: "Fixture title", handle, author: "legacy", text: handle, category: "constraint", scope: "project", supports: [fact.facts[0]!.id], topics: [], reason: "legacy", createdAt: time }] });
  const first = create("$first"), second = create("$second");
  if (!first.ok || !second.ok) throw new Error("fixture failed");
  store.db.prepare("INSERT INTO knowledge_links VALUES (?,?,'merged_into',?,?)").run(first.committed[0]!.knowledgeId, first.committed[0]!.commit, second.committed[0]!.knowledgeId, second.committed[0]!.commit);
  const run = store.recordRun({ kind: "dreaming", sessionId: session.id, createdAt: time, outcome: "success" });
  const before = { revisions: store.listKnowledgeRevisions().map(r => ({ id: r.id, knowledgeId: r.knowledgeId, supports: r.supports })),
    links: store.listKnowledgeLinks(first.committed[0]!.knowledgeId) };
  store.close();
  const raw = new DatabaseSync(db);
  raw.exec(`ALTER TABLE knowledge_revisions DROP COLUMN support_semantics;
    CREATE TABLE dreaming_completions(run_id INTEGER PRIMARY KEY REFERENCES runs(id), event_ids TEXT NOT NULL, result_ids TEXT NOT NULL);
    CREATE TABLE processed_knowledge_versions(commit_id INTEGER PRIMARY KEY REFERENCES knowledge_revisions(id), run_id INTEGER NOT NULL REFERENCES dreaming_completions(run_id));`);
  raw.prepare("INSERT INTO dreaming_completions VALUES (?,?,?)").run(run.id, "[]", JSON.stringify([second.committed[0]!.commit]));
  raw.prepare("INSERT INTO processed_knowledge_versions VALUES (?,?)").run(second.committed[0]!.commit, run.id);
  raw.close();
  const reopened = new Store(db); stores.push(reopened);
  expect(reopened.listKnowledgeRevisions().map(r => ({ id: r.id, knowledgeId: r.knowledgeId, supports: r.supports }))).toEqual(before.revisions);
  expect(reopened.listKnowledgeRevisions().every(r => r.supportSemantics === "complete_result")).toBe(true);
  expect(reopened.listKnowledgeLinks(first.committed[0]!.knowledgeId)).toEqual(before.links);
  expect(reopened.db.prepare("SELECT run_id FROM knowledge_processed WHERE pool=? AND revision_id=?")
    .get(`project:${project.id}`, second.committed[0]!.commit)).toEqual({ run_id: run.id });
  expect(reopened.getRun(run.id)!.origin).toBeNull();
  reopened.close();
  const stable = new Store(db); stores.push(stable);
  expect(stable.listKnowledgeRevisions().map(r => r.id)).toEqual(before.revisions.map(r => r.id));
  expect(stable.db.prepare("SELECT run_id FROM knowledge_processed WHERE pool=? AND revision_id=?")
    .get(`project:${project.id}`, second.committed[0]!.commit)).toEqual({ run_id: run.id });
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
  const result = tools.find(t => t.name === "memory")!.execute({ files: null, op: "create", title: "Fixture title", text: "origin-backed", category: "constraint", scope: "project",
    topics: [], supports: [`F${facts.facts[0]!.id}`], reason: "initial" });
  expect(result).not.toContain("rejected:");
  const frozen = store.listRuns(session.id).at(-1)!.origin;
  expect(frozen).toEqual({ sessionId: session.id, entryIds: [trigger.id] });
  expect(store.triggerOrigin({ sessionId: session.id, branch: "main", headTurnId: turn.id })).toEqual({
    sessionId: session.id, entryIds: [later.id],
  });
  const run = store.listRuns(session.id).at(-1)!;
  const legacy = JSON.stringify([first.id, trigger.id]);
  store.db.prepare("UPDATE run_bodies SET origin_entry_ids = ? WHERE run_id = ?").run(legacy, run.id);
  const restored = store.getRun(run.id)!;
  expect(restored.origin).toEqual({ sessionId: session.id, entryIds: [first.id, trigger.id] });
  expect(renderRun(restored, [], [])).toContain(`trigger origin: S${session.id}/E${trigger.id}`);
  expect(store.db.prepare("SELECT origin_entry_ids FROM run_bodies WHERE run_id = ?").get(run.id)!.origin_entry_ids).toBe(legacy);

  // Direct SQL corruption bypasses the versioned write protocol. A transaction's fresh read
  // still rejects it; a cached read detects it once the path version changes.
  store.db.exec("PRAGMA foreign_keys = OFF");
  try {
    store.db.prepare("UPDATE source_path_entries SET entry_id = 999 WHERE path_id = (SELECT id FROM source_paths WHERE session_id = ? AND branch = 'main') AND position = 0").run(session.id);
  } finally { store.db.exec("PRAGMA foreign_keys = ON"); }
  expect(() => store.transaction(() => store.selectedSourceEntryIds(session.id, "main"))).toThrow(/source path/i);
  store.db.prepare("UPDATE source_paths SET version = version + 1 WHERE session_id = ? AND branch = 'main'").run(session.id);
  expect(() => memory.tools({ kind: "manual", sessionId: session.id, branch: "main", currentTurnId: turn.id })).toThrow(/source path|trigger origin/i);
});
