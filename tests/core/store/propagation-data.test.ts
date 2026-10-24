import { afterEach, expect, test } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { sourceSeededMemory as TraceMemory } from "../../source-fixture.ts";
import { Store, type KnowledgeOperationInput, type KnowledgeFiles } from "../../../src/core/store/index.ts";
import { entry, facts, knowledgeBatch, legacyFact, legacyKnowledge, session } from "../../support/seed.ts";
import { renderFact } from "../../../src/core/render/index.ts";
import { plan } from "../../../src/core/workspace/plan.ts";

const at = "2026-10-24T00:00:00.000Z";
const stores: Store[] = [], dirs: string[] = [];
afterEach(() => { for (const store of stores.splice(0)) store.close(); for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });

function fixture(file = ":memory:") {
  const memory = TraceMemory(file, async () => { throw new Error("no model work"); });
  const store = memory.store; stores.push(store);
  const project = store.createProject({ name: "propagation", declaredBy: "mark" });
  const owner = session(store, project.id, "pi:propagation");
  const turn = store.appendTurn({ sessionId: owner.id, kind: "turn", startedAt: at });
  const source = entry(store, owner.id, turn.id, "root", "user", "Store and SQLite keep records");
  store.selectSourcePath(owner.id, "main", [source.id]);
  const path = { sessionId: owner.id, branch: "main", headTurnId: turn.id };
  const authored = facts(memory, path, [
    { title: "Store writes", sources: [{ entry: source, text: "Store keeps SQLite records" }], objects: ["Store", "SQLite", "store"] },
    { title: "Store reads", sources: [{ entry: source, text: "Store reads records" }], objects: ["STORE"] },
    { title: "File evidence", sources: [{ entry: source, text: "Files are pinned" }], objects: ["Files"] },
  ]);
  const common = { title: "Store rule", text: "Store keeps records", category: "constraint" as const, scope: "project" as const,
    supports: [authored[0]!.id], topics: [], reason: "record grounds", createdAt: at };
  const run = { kind: "manual" as const, sessionId: owner.id, branch: "main", createdAt: at };
  const write = (operations: KnowledgeOperationInput[]) => {
    const result = store.commitConsolidationRun({ run, path, operations });
    if (!result.ok) throw new Error(result.problems.join("; "));
    return result.committed;
  };
  const create = (files: KnowledgeFiles, text = common.text) => write([{ ...common, op: "create", handle: "$1", author: "test", text, files }])[0]!;
  return { memory, store, owner, turn, source, path, authored, common, run, write, create };
}

test("objects round-trip with first spelling and exact case-insensitive indexed lookup; legacy facts stay untouched", () => {
  const f = fixture();
  const old = legacyFact(f.store, f.path, [{ entry: f.source, address: `T${f.turn.id}#E1` }], "Store legacy record");
  expect(old).not.toHaveProperty("objects");
  expect(f.store.getFact(f.authored[0]!.id)!.objects).toEqual(["Store", "SQLite"]);
  expect(f.store.factsMentioningObject("store").map(fact => fact.id)).toEqual(f.authored.slice(0, 2).map(fact => fact.id));
  expect(f.store.factsMentioningObject("Stor")).toEqual([]);
  const query = f.store.db.prepare("EXPLAIN QUERY PLAN SELECT fact_id FROM fact_objects WHERE object_key=?").all("store");
  expect(query.map(row => row.detail).join(" ")).toContain("idx_fact_objects_key");
});

test("object validation uses the body, not title, and a failed batch publishes no facts or object rows", () => {
  const f = fixture();
  const before = f.store.listSessionFacts(f.owner.id);
  const row = { turnId: f.turn.id, text: "Store records", category: "observation" as const, actor: "user" as const,
    source: [`T${f.turn.id}#E1`], entryIds: [f.source.id], createdAt: at };
  const result = f.store.commitNotingRun({ run: f.run, facts: [{ ...row, objects: ["Store"] }, { ...row, objects: ["missing"] }] });
  expect(result.ok).toBe(false);
  if (!result.ok) expect(result.problems.join(" ")).toContain("does not appear in the fact body");
  expect(f.store.listSessionFacts(f.owner.id)).toEqual(before);
  expect(f.store.factsMentioningObject("Store").map(fact => fact.id)).toEqual(f.authored.slice(0, 2).map(fact => fact.id));
  expect(f.store.db.prepare("SELECT rowid FROM facts_fts WHERE facts_fts MATCH 'records' ORDER BY rowid").all().map(row => row.rowid)).toEqual([f.authored[0]!.id, f.authored[1]!.id]);
  const note = f.memory.tools({ kind: "manual", sessionId: f.owner.id, branch: "main", currentTurnId: f.turn.id }).find(tool => tool.name === "note")!;
  expect(note.execute({ title: "Only in title", sources: `[T${f.turn.id}#E1] Store records`, objects: ["Only"] })).toContain("does not appear in the fact body");
});

test("caused_by accepts existing facts, stays visible alongside support, and refuses more than two atomically", () => {
  const f = fixture(), targets = f.authored.map(fact => ({ target: `F${fact.id}`, strength: "strong" as const }));
  const row = { turnId: f.turn.id, text: "Store consequence", category: "observation" as const, actor: "user" as const,
    source: [`T${f.turn.id}#E1`], entryIds: [f.source.id], createdAt: at };
  const result = f.store.commitNotingRun({ run: f.run, facts: [{ ...row, support: [targets[0]!], caused_by: targets.slice(0, 2) }] });
  if (!result.ok) throw new Error(result.problems.join("; "));
  const saved = result.facts[0]!, relations = f.store.listFactRelations(saved.id);
  expect(relations.filter(relation => relation.kind === "caused_by").map(relation => relation.toFact)).toEqual(f.authored.slice(0, 2).map(fact => fact.id));
  expect(renderFact(saved, relations)).toContain(`caused_by F${f.authored[0]!.id} strong`);
  expect(renderFact(saved, relations)).toContain(`support F${f.authored[0]!.id} strong`);
  const before = f.store.listSessionFacts(f.owner.id);
  expect(f.store.commitNotingRun({ run: f.run, facts: [{ ...row, caused_by: targets }] }).ok).toBe(false);
  expect(f.store.listSessionFacts(f.owner.id)).toEqual(before);
  const self = f.store.commitNotingRun({ run: f.run, facts: [{ ...row, caused_by: [{ target: `F${saved.id + 1}`, strength: "strong" }] }] });
  expect(self.ok).toBe(false);
  if (!self.ok) expect(self.problems.join(" ")).toContain("must name an existing fact");
  expect(f.store.listSessionFacts(f.owner.id)).toEqual(before);
});

test("new versions require explicit files, preserve opaque paths, and distinguish None from legacy unmapped", () => {
  const f = fixture(), files = ["src/store.ts#not-an-anchor", "src/Other.ts"];
  const mapped = f.create(files), none = f.create(null);
  const legacy = legacyKnowledge(f.store, f.path, { ...f.common });
  expect(f.store.knowledgeRevision(mapped.commit)!.files).toEqual(files);
  expect(f.store.knowledgeRevision(none.commit)!.files).toBeNull();
  expect(f.store.knowledgeRevision(legacy.commit)).not.toHaveProperty("files");
  const explicit = { ...f.common, text: "Rollback unique evidence", op: "create" as const, handle: "$new", author: "test", files: null };
  const { files: _files, ...omitted } = explicit;
  const before = f.store.listKnowledgeRevisions();
  const refused = f.store.commitConsolidationRun({ run: f.run, path: f.path, operations: [explicit, omitted as unknown as KnowledgeOperationInput] });
  expect(refused.ok).toBe(false);
  if (!refused.ok) expect(refused.problems.join(" ")).toContain("files: required");
  expect(f.store.listKnowledgeRevisions()).toEqual(before);
  expect(f.store.searchKnowledge(["Rollback unique evidence"])).toEqual([]);
  const copied = f.write([{ ...f.common, op: "update", knowledgeId: legacy.knowledgeId, baseCommit: legacy.commit, files: undefined }])[0]!;
  expect(f.store.knowledgeRevision(copied.commit)).not.toHaveProperty("files");
  expect(f.store.commitConsolidationRun({ run: f.run, path: f.path, operations: [{ ...explicit, files: undefined }] }).ok).toBe(false);
});

test("a stale Noter update cannot manufacture omitted file information while converting to a create", () => {
  const f = fixture(), base = f.create(null);
  const update = { ...f.common, op: "update" as const, knowledgeId: base.knowledgeId, baseCommit: base.commit, files: null };
  f.write([update]);
  const { files: _files, ...missingFiles } = update;
  const before = f.store.listKnowledgeRevisions();
  for (const operation of [missingFiles as unknown as KnowledgeOperationInput, { ...update, files: undefined }]) {
    const result = f.store.commitNotingRun({ run: { ...f.run, kind: "noting" }, facts: [],
      held: { path: f.path, slots: [], validate() {}, knowledge: () => [operation] } });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.problems.join(" ")).toContain("files: required");
    expect(f.store.listKnowledgeRevisions()).toEqual(before);
  }
  const legacy = legacyKnowledge(f.store, f.path, f.common);
  const copyingLegacy = { ...f.common, op: "update" as const, knowledgeId: legacy.knowledgeId, baseCommit: legacy.commit, files: undefined };
  f.write([copyingLegacy]);
  const converted = f.store.commitNotingRun({ run: { ...f.run, kind: "noting" }, facts: [],
    held: { path: f.path, slots: [], validate() {}, knowledge: () => [copyingLegacy] } });
  if (!converted.ok) throw new Error(converted.problems.join("; "));
  const revision = f.store.listCommitsByRun(converted.runId)[0]!;
  expect(revision.knowledgeId).not.toBe(legacy.knowledgeId);
  expect(revision.files).toBeNull();
  expect(f.store.knowledgeRevision(legacy.commit)).not.toHaveProperty("files");
});

test("verification and stale reasons are independent version status, survive reopen, and never alter rewind or applicability", () => {
  const dir = mkdtempSync(join(tmpdir(), "tm-propagation-")); dirs.push(dir);
  const f = fixture(join(dir, "memory.db")), base = f.create(["src/store.ts"]);
  const childTurn = f.store.appendTurn({ sessionId: f.owner.id, parentTurnId: f.turn.id, kind: "turn", startedAt: at });
  const child = entry(f.store, f.owner.id, childTurn.id, "child", "user", "child grounds");
  f.store.selectSourcePath(f.owner.id, "main", [f.source.id, child.id]);
  const childPath = { ...f.path, headTurnId: childTurn.id };
  f.store.setCurrentPath(f.owner.id, "main", childTurn.id, "foreground");
  f.store.selectSourcePath(f.owner.id, "rewind", [f.source.id]);
  const ground = facts(f.memory, childPath, [{ title: "Child grounds", sources: [{ entry: child, text: "Store changed" }] }])[0]!;
  const updated = f.store.commitConsolidationRun({ run: f.run, path: childPath, operations: [{ ...f.common, op: "update",
    knowledgeId: base.knowledgeId, baseCommit: base.commit, supports: [ground.id], files: ["src/store.ts"] }] });
  if (!updated.ok) throw new Error(updated.problems.join("; "));
  const commit = updated.committed[0]!.commit;
  const versions = f.store.listKnowledgeRevisions();
  const current = f.store.currentKnowledge(childPath);
  f.store.setCurrentPath(f.owner.id, "rewind", f.turn.id, "foreground");
  const rewound = f.store.currentKnowledge(f.path);
  f.store.setCurrentPath(f.owner.id, "main", childTurn.id, "foreground");
  const verification = { file: "src/store.ts", verifiedCommit: "abc123", verifiedAt: at };
  f.store.setKnowledgeFileVerification(commit, verification);
  f.store.setKnowledgeStale(commit, { reason: "file_changed", detail: "src/store.ts" });
  f.store.setKnowledgeStale(commit, { reason: "missing_grounds", detail: "implementation needs evidence" });
  expect(f.store.knowledgeFileVerifications(commit)).toEqual([verification]);
  expect(f.store.knowledgeStaleReasons(commit)).toEqual([
    { reason: "file_changed", detail: "src/store.ts" }, { reason: "missing_grounds", detail: "implementation needs evidence" },
  ]);
  expect(f.store.knowledgeFileVerifications(base.commit)).toEqual([]);
  expect(() => f.store.setKnowledgeFileVerification(commit, { ...verification, file: "unlinked.ts" })).toThrow("not linked");
  expect(f.store.currentKnowledge(childPath)).toEqual(current);
  f.store.setCurrentPath(f.owner.id, "rewind", f.turn.id, "foreground");
  expect(f.store.currentKnowledge(f.path)).toEqual(rewound);
  expect(current.map(item => item.revision.id)).toEqual([commit]);
  expect(rewound.map(item => item.revision.id)).toEqual([base.commit]);
  const reopened = new Store(join(dir, "memory.db")); stores.push(reopened);
  expect(reopened.knowledgeFileVerifications(commit)).toEqual([verification]);
  expect(reopened.knowledgeStaleReasons(commit)).toHaveLength(2);
  reopened.clearKnowledgeFileVerification(commit, verification.file);
  reopened.clearKnowledgeStale(commit, { reason: "file_changed", detail: "src/store.ts" });
  expect(reopened.knowledgeStaleReasons(commit)).toEqual([{ reason: "missing_grounds", detail: "implementation needs evidence" }]);
  reopened.clearKnowledgeStale(commit);
  expect(reopened.knowledgeStaleReasons(commit)).toEqual([]);
  expect(reopened.knowledgeFileVerifications(commit)).toEqual([]);
  expect(reopened.listKnowledgeRevisions()).toEqual(versions);
  expect(reopened.currentKnowledge(f.path)).toEqual(rewound);
});

test("only a metadata-only version copies verification; a changed body, changed files and new identities are unverified", () => {
  const f = fixture(), base = f.create(["a.ts"]), verification = { file: "a.ts", verifiedCommit: "abc", verifiedAt: at };
  f.store.setKnowledgeFileVerification(base.commit, verification);
  const maintenance = f.store.commitWorkspaceRun({ run: { ...f.run, kind: "dreaming" }, path: f.path, operations: [{
    ...f.common, op: "update", knowledgeId: base.knowledgeId, baseCommit: base.commit, title: "Refined index title", supports: [], files: ["a.ts"],
  }] }).results[0]!;
  if (!maintenance.ok) throw new Error(maintenance.reason);
  const copied = maintenance.committed[0]!;
  expect(f.store.knowledgeRevision(copied.commit)).toMatchObject({ title: "Refined index title", text: f.common.text, supports: f.common.supports });
  expect(f.store.knowledgeFileVerifications(copied.commit)).toEqual([verification]);
  const rewritten = f.write([{ ...f.common, op: "update", knowledgeId: base.knowledgeId, baseCommit: copied.commit, text: `${f.common.text} Rewritten.`, files: ["a.ts"] }])[0]!;
  expect(f.store.knowledgeFileVerifications(rewritten.commit)).toEqual([]); // a changed claim was not checked against its files
  const changed = f.write([{ ...f.common, op: "update", knowledgeId: base.knowledgeId, baseCommit: rewritten.commit, files: null }])[0]!;
  expect(f.store.knowledgeFileVerifications(changed.commit)).toEqual([]);
  expect(f.store.knowledgeFileVerifications(f.create(["a.ts"]).commit)).toEqual([]);
  expect(f.store.knowledgeFileVerifications(base.commit)).toEqual([verification]);
});

test("derived objects count distinct facts across exact merged ancestry and reset for every split part", () => {
  const f = fixture(), base = f.create(null);
  const update = f.write([{ ...f.common, op: "update", knowledgeId: base.knowledgeId, baseCommit: base.commit, supports: [f.authored[1]!.id], files: null }])[0]!;
  const repeated = f.write([{ ...f.common, op: "update", knowledgeId: base.knowledgeId, baseCommit: update.commit, supports: [f.authored[1]!.id], files: null }])[0]!;
  expect(f.store.knowledgeObjects(repeated.commit)).toEqual([{ object: "STORE", facts: 2 }, { object: "SQLite", facts: 1 }]);
  const other = knowledgeBatch(f.store, f.path, [{ ...f.common, supports: [f.authored[2]!.id] }]).committed[0]!;
  const merge = f.store.commitWorkspaceRun({ run: { ...f.run, kind: "dreaming" }, path: f.path, operations: [{ ...f.common, op: "merge",
    intoKnowledgeId: base.knowledgeId, intoBaseCommit: repeated.commit, absorb: [{ knowledgeId: other.knowledgeId, baseCommit: other.commit }], files: null }] }).results[0]!;
  if (!merge.ok) throw new Error(merge.reason);
  expect(f.store.knowledgeObjects(merge.committed[0]!.commit)).toEqual([
    { object: "STORE", facts: 2 }, { object: "Files", facts: 1 }, { object: "SQLite", facts: 1 },
  ]);
  const split = f.store.commitWorkspaceRun({ run: { ...f.run, kind: "dreaming" }, path: f.path, operations: [{ ...f.common, op: "split",
    knowledgeId: base.knowledgeId, baseCommit: merge.committed[0]!.commit, supports: [f.authored[1]!.id], files: ["primary.ts"],
    children: [{ ...f.common, supports: [f.authored[2]!.id], files: null }] }] }).results[0]!;
  if (!split.ok) throw new Error(split.reason);
  expect(split.committed.map(item => f.store.knowledgeObjects(item.commit))).toEqual([
    [{ object: "STORE", facts: 1 }], [{ object: "Files", facts: 1 }],
  ]);
  expect(split.committed.map(item => f.store.knowledgeRevision(item.commit)!.files)).toEqual([["primary.ts"], null]);
});

test("knowledge trigram retrieval ANDs terms within one version, searches every version, and handles short and literal terms", () => {
  const f = fixture();
  const initial = f.write([{ ...f.common, title: "Alpha title", text: 'Beta path%_ and "quoted" 知识', files: null, op: "create", author: "test", handle: "$1" }])[0]!;
  f.write([{ ...f.common, title: "Replacement", text: "Gamma only", files: null, op: "update", knowledgeId: initial.knowledgeId, baseCommit: initial.commit }]);
  f.create(null, "Alpha without the other term");
  expect(f.store.searchKnowledge(["alpha", "beta"])).toEqual([initial.knowledgeId]);
  expect(f.store.searchKnowledge(["Alpha", "Gamma"])).toEqual([]);
  for (const term of ["知识", "path%_", '"quoted"', "Gamma"])
    expect(f.store.searchKnowledge([term]), term).toEqual([initial.knowledgeId]);
  expect(f.store.searchKnowledge(["not present"])).toEqual([]);
  expect(f.store.searchKnowledge([])).toEqual([]);
  expect(f.store.db.prepare("SELECT count(*) AS n FROM knowledge_fts").get()!.n).toBe(f.store.listKnowledgeRevisions().length);
});


test("the additive migration preserves legacy rows and support relations, backfills every version and is idempotent", () => {
  const dir = mkdtempSync(join(tmpdir(), "tm-propagation-migration-")); dirs.push(dir);
  const file = join(dir, "memory.db"), f = fixture(file);
  const old = legacyKnowledge(f.store, f.path, { ...f.common, text: "Legacy migration body" });
  f.store.db.prepare("UPDATE knowledge_revisions SET title=? WHERE id=?").run("Historical title", old.commit);
  f.store.db.prepare("INSERT INTO fact_relations VALUES (?,?,'support','strong')").run(f.authored[1]!.id, f.authored[0]!.id);
  f.store.db.exec(`PRAGMA foreign_keys=OFF;
    DROP TABLE fact_objects; DROP TABLE knowledge_file_verifications; DROP TABLE knowledge_stale_reasons; DROP TABLE knowledge_fts;
    ALTER TABLE facts DROP COLUMN objects; ALTER TABLE knowledge_revisions DROP COLUMN files;
    CREATE TABLE fact_relations_old(from_fact INTEGER NOT NULL REFERENCES facts(id),to_fact INTEGER NOT NULL REFERENCES facts(id),
      kind TEXT NOT NULL CHECK(kind IN ('support','negate')),strength TEXT NOT NULL CHECK(strength IN ('strong','weak')),PRIMARY KEY(from_fact,to_fact,kind));
    INSERT INTO fact_relations_old SELECT * FROM fact_relations; DROP TABLE fact_relations; ALTER TABLE fact_relations_old RENAME TO fact_relations;`);
  const factsBefore = f.store.db.prepare("SELECT * FROM facts ORDER BY id").all();
  const knowledgeBefore = f.store.db.prepare("SELECT * FROM knowledge_revisions ORDER BY id").all();
  const relationsBefore = f.store.db.prepare("SELECT * FROM fact_relations").all();
  f.store.close(); stores.splice(stores.indexOf(f.store), 1);
  for (let open = 0; open < 2; open++) {
    const store = new Store(file); stores.push(store);
    expect(store.db.prepare("SELECT * FROM facts ORDER BY id").all().map(({ objects, ...row }) => { expect(objects).toBeNull(); return row; })).toEqual(factsBefore);
    expect(store.db.prepare("SELECT * FROM knowledge_revisions ORDER BY id").all().map(({ files, ...row }) => { expect(files).toBeNull(); return row; })).toEqual(knowledgeBefore);
    expect(store.db.prepare("SELECT * FROM fact_relations").all()).toEqual(relationsBefore);
    expect(store.searchKnowledge(["Historical", "migration"])).toEqual([old.knowledgeId]);
    expect(store.db.prepare("PRAGMA integrity_check").get()!.integrity_check).toBe("ok");
    expect(store.db.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
    expect(store.factsMentioningObject("Store")).toEqual([]);
  }
});

test("fact similarity migration preserves titled and legacy facts, backfills once, and indexes later writes", () => {
  const dir = mkdtempSync(join(tmpdir(), "tm-facts-fts-migration-")); dirs.push(dir);
  const file = join(dir, "memory.db"), f = fixture(file);
  const old = legacyFact(f.store, f.path, [{ entry: f.source, address: `T${f.turn.id}#E1` }], "历史事实的全文检索");
  const [titled] = facts(f.memory, f.path, [{ title: "整理分批由代理自己推进", sources: [{ entry: f.source, text: "Original body" }] }]);
  const before = f.store.db.prepare("SELECT * FROM facts ORDER BY id").all();
  f.store.db.exec("DROP TABLE facts_fts");
  f.store.close(); stores.splice(stores.indexOf(f.store), 1);
  for (let open = 0; open < 2; open++) {
    const store = new Store(file); stores.push(store);
    expect(store.db.prepare("SELECT * FROM facts ORDER BY id").all()).toEqual(before);
    const ids = before.map(row => Number(row.id));
    expect(store.db.prepare("SELECT rowid FROM facts_fts ORDER BY rowid").all().map(row => Number(row.rowid))).toEqual(ids);
    expect(store.similarFacts("整理分批的推进方式", ids, 1)).toEqual([titled!.id]);
    expect(store.similarFacts("历史事实的检索方案", ids, 1)).toEqual([old.id]);
    expect(store.db.prepare("PRAGMA integrity_check").get()!.integrity_check).toBe("ok");
    expect(store.db.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
    store.close(); stores.splice(stores.indexOf(store), 1);
  }
  const reopened = TraceMemory(file, async () => { throw new Error("no model work"); }); stores.push(reopened.store);
  const [later] = facts(reopened, f.path, [{ title: "会话独立核实事实", sources: [{ entry: f.source, text: "New indexed body" }] }]);
  expect(reopened.store.similarFacts("会话独立核实的新方案", [...before.map(row => Number(row.id)), later!.id], 1)).toEqual([later!.id]);
});
