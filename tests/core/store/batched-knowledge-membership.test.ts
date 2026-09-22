import { afterEach, expect, test } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Store, type KnowledgePath } from "../../../src/core/store/index.ts";
import type { KnowledgeRevision } from "../../../src/core/model/index.ts";

const at = "2026-09-21T00:00:00.000Z";
const directories: string[] = [];
afterEach(() => { for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true }); });

function database() {
  const directory = mkdtempSync(join(tmpdir(), "tm-batched-membership-"));
  directories.push(directory);
  return join(directory, "trace.db");
}
function session(store: Store, projectId: number, host: string) {
  return store.createSession({ enrollmentChoice: true, host, startedAt: at, firstReplyAt: at, projectId });
}
function append(store: Store, sessionId: number, parentTurnId: number | null, nativeId: string, role: "user" | "assistant" = "user") {
  const turn = store.appendTurn({ sessionId, parentTurnId, kind: "turn", userPrompt: nativeId, startedAt: at });
  const entry = store.appendSourceEntry({ sessionId, nativeLineage: `lineage-${sessionId}`, nativeId, turnId: turn.id,
    role, text: nativeId, raw: JSON.stringify({ role, content: nativeId }), calls: [] });
  return { turn, entry };
}
function siblingEntry(store: Store, sessionId: number, turnId: number, nativeId: string, role: "user" | "assistant" = "assistant") {
  return store.appendSourceEntry({ sessionId, nativeLineage: `lineage-${sessionId}`, nativeId, turnId,
    role, text: nativeId, raw: JSON.stringify({ role, content: nativeId }), calls: [] });
}
function fact(store: Store, sessionId: number, branch: string, turnId: number, source: string, entryId?: number) {
  const result = store.commitNotingRun({ run: { kind: "manual", sessionId, branch, createdAt: at }, facts: [{
    turnId, category: "observation", actor: "user", text: `evidence ${source}`, source: [source],
    ...(entryId === undefined ? {} : { entryIds: [entryId] }), createdAt: at,
  }] });
  if (!result.ok) throw new Error(result.problems.join("; "));
  return result.facts[0]!;
}
function knowledge(store: Store, path: KnowledgePath, factId: number, label: string) {
  const result = store.commitConsolidationRun({ path, run: { kind: "manual", sessionId: path.sessionId, branch: path.branch, createdAt: at },
    operations: [{ op: "create", handle: `$${label}`, author: "test", text: label, category: "mechanism", scope: "global",
      supports: [factId], topics: [], reason: "membership fixture", createdAt: at }] });
  if (!result.ok) throw new Error(result.problems.join("; "));
  return result.committed[0]!;
}

/** Independent preserved route: one ordinary pathSnapshot/factOnPath evaluation per direct support. */
function legacyApplies(store: Store, revision: KnowledgeRevision): boolean {
  return revision.supports.every(id => {
    const stored = store.getFact(id)!;
    const owner = store.getTurn(stored.turnId)!.sessionId;
    const cursors = store.db.prepare("SELECT branch, head_turn_id FROM session_lineage_cursors WHERE session_id = ? ORDER BY lineage")
      .all(owner) as { branch: string; head_turn_id: number }[];
    if (!cursors.length) return true;
    return cursors.some(cursor => store.factOnPath(stored,
      { sessionId: owner, branch: cursor.branch, headTurnId: Number(cursor.head_turn_id) }));
  });
}
function expectEquivalent(store: Store, reader: KnowledgePath) {
  const graph = store.commitGraph(reader);
  const expected = store.listKnowledgeRevisions().filter(revision => legacyApplies(store, revision)).map(revision => revision.id);
  expect([...graph.applicable]).toEqual(expected);
}

test("batched owner membership matches preserved snapshots for bound/unbound siblings and a head prefix", () => {
  const store = new Store(":memory:");
  try {
    const project = store.createProject({ name: "equivalence", declaredBy: "mark" });
    const owner = session(store, project.id, "owner"), reader = session(store, project.id, "reader");
    const root = append(store, owner.id, null, "root"), child = append(store, owner.id, root.turn.id, "child");
    const sibling = siblingEntry(store, owner.id, child.turn.id, "child-sibling");
    const readNode = append(store, reader.id, null, "read");
    store.selectSourcePath(owner.id, "main", [root.entry.id, child.entry.id]);
    store.selectSourcePath(owner.id, "sibling", [root.entry.id, sibling.id]);
    store.selectSourcePath(owner.id, "short", [root.entry.id]);
    store.selectSourcePath(owner.id, "empty", []);
    store.selectSourcePath(reader.id, "main", [readNode.entry.id]);
    const bound = fact(store, owner.id, "main", child.turn.id, `T${child.turn.id}#user`, child.entry.id);
    const unbound = fact(store, owner.id, "sibling", child.turn.id, `T${child.turn.id}#assistant`);
    const rootFact = fact(store, owner.id, "main", root.turn.id, `T${root.turn.id}#user`, root.entry.id);
    const writePath = { sessionId: owner.id, branch: "main", headTurnId: child.turn.id };
    const siblingPath = { sessionId: owner.id, branch: "sibling", headTurnId: child.turn.id };
    const boundKnowledge = knowledge(store, writePath, bound.id, "bound"), unboundKnowledge = knowledge(store, siblingPath, unbound.id, "unbound");
    const rootKnowledge = knowledge(store, writePath, rootFact.id, "root");
    const readerPath = { sessionId: reader.id, branch: "main", headTurnId: readNode.turn.id };
    store.setCurrentPath(reader.id, "main", readNode.turn.id, "test-lineage");

    store.setCurrentPath(owner.id, "main", child.turn.id, "test-lineage");
    expectEquivalent(store, readerPath);
    expect(store.currentKnowledge(readerPath).map(value => value.revision.id)).toEqual([boundKnowledge.commit, rootKnowledge.commit]);

    store.setCurrentPath(owner.id, "sibling", child.turn.id, "test-lineage");
    expectEquivalent(store, readerPath);
    expect(store.currentKnowledge(readerPath).map(value => value.revision.id)).toEqual([unboundKnowledge.commit, rootKnowledge.commit]);

    // The native branch extends past the rewound head. Entry membership is still the head's Turn prefix.
    store.setCurrentPath(owner.id, "main", root.turn.id, "test-lineage");
    expectEquivalent(store, readerPath);
    expect(store.currentKnowledge(readerPath).map(value => value.revision.id)).toEqual([rootKnowledge.commit]);

    // The foreground head may also extend beyond the persisted branch tail.
    store.setCurrentPath(owner.id, "short", child.turn.id, "test-lineage");
    expectEquivalent(store, readerPath);
    expect(store.currentKnowledge(readerPath).map(value => value.revision.id)).toEqual([rootKnowledge.commit]);

    store.setCurrentPath(owner.id, "empty", child.turn.id, "test-lineage");
    expectEquivalent(store, readerPath);
    expect(store.currentKnowledge(readerPath)).toEqual([]);
  } finally { store.close(); }
});

test("same-length entry replacement is operation-local across Stores, rollback and reopen", () => {
  const dbPath = database(), writer = new Store(dbPath);
  let reader = new Store(dbPath);
  try {
    const project = writer.createProject({ name: "freshness", declaredBy: "mark" });
    const owner = session(writer, project.id, "owner"), consumer = session(writer, project.id, "consumer");
    const root = append(writer, owner.id, null, "root"), node = append(writer, owner.id, root.turn.id, "node");
    const left = siblingEntry(writer, owner.id, node.turn.id, "left", "user");
    const right = siblingEntry(writer, owner.id, node.turn.id, "right", "assistant");
    const readNode = append(writer, consumer.id, null, "read");
    writer.selectSourcePath(owner.id, "main", [root.entry.id, left.id]);
    writer.selectSourcePath(owner.id, "right", [root.entry.id, right.id]);
    writer.selectSourcePath(consumer.id, "main", [readNode.entry.id]);
    writer.setCurrentPath(owner.id, "main", node.turn.id, "test-lineage");
    writer.setCurrentPath(consumer.id, "main", readNode.turn.id, "test-lineage");
    const leftFact = fact(writer, owner.id, "main", node.turn.id, `T${node.turn.id}#user`, left.id);
    const rightFact = fact(writer, owner.id, "main", node.turn.id, `T${node.turn.id}#assistant`, right.id);
    const path = { sessionId: owner.id, branch: "main", headTurnId: node.turn.id };
    const rightPath = { sessionId: owner.id, branch: "right", headTurnId: node.turn.id };
    const leftKnowledge = knowledge(writer, path, leftFact.id, "left"), rightKnowledge = knowledge(writer, rightPath, rightFact.id, "right");
    const readPath = { sessionId: consumer.id, branch: "main", headTurnId: readNode.turn.id };
    expect(reader.currentKnowledge(readPath).map(value => value.revision.id)).toEqual([leftKnowledge.commit]);

    // Same branch, head and path length; only exact selected entry identity changes.
    writer.selectSourcePath(owner.id, "main", [root.entry.id, right.id]);
    expect(reader.currentKnowledge(readPath).map(value => value.revision.id)).toEqual([rightKnowledge.commit]);
    expectEquivalent(reader, readPath);

    expect(() => writer.transaction(() => {
      writer.selectSourcePath(owner.id, "main", [root.entry.id, left.id]);
      throw new Error("rollback");
    })).toThrow("rollback");
    expect(reader.currentKnowledge(readPath).map(value => value.revision.id)).toEqual([rightKnowledge.commit]);

    reader.close(); reader = new Store(dbPath);
    expect(reader.currentKnowledge(readPath).map(value => value.revision.id)).toEqual([rightKnowledge.commit]);
  } finally { reader.close(); writer.close(); }
});

test("no-cursor owners remain globally applicable and recorded corruption fails explicitly", () => {
  const store = new Store(":memory:");
  try {
    const project = store.createProject({ name: "compatibility", declaredBy: "mark" });
    const owner = session(store, project.id, "legacy"), reader = session(store, project.id, "reader");
    const node = append(store, owner.id, null, "owner"), readNode = append(store, reader.id, null, "reader");
    store.selectSourcePath(owner.id, "main", [node.entry.id]);
    store.selectSourcePath(reader.id, "main", [readNode.entry.id]);
    store.setCurrentPath(reader.id, "main", readNode.turn.id, "test-lineage");
    const evidence = fact(store, owner.id, "main", node.turn.id, `T${node.turn.id}#user`, node.entry.id);
    const item = knowledge(store, { sessionId: owner.id, branch: "main", headTurnId: node.turn.id }, evidence.id, "legacy");
    const readPath = { sessionId: reader.id, branch: "main", headTurnId: readNode.turn.id };
    expect(store.currentKnowledge(readPath).map(value => value.revision.id)).toEqual([item.commit]);

    store.setCurrentPath(owner.id, "main", node.turn.id, "test-lineage");
    for (const raw of ["{", JSON.stringify([999_999])]) {
      store.db.prepare("UPDATE source_paths SET entry_ids = ? WHERE session_id = ? AND branch = 'main'").run(raw, owner.id);
      expect(() => store.currentKnowledge(readPath)).toThrow(`session S${owner.id} has a corrupted recorded foreground`);
    }
    store.db.prepare("UPDATE source_paths SET entry_ids = ? WHERE session_id = ? AND branch = 'main'").run(JSON.stringify([node.entry.id]), owner.id);
    store.db.prepare("UPDATE turns SET parent_turn_id = id WHERE id = ?").run(node.turn.id);
    expect(() => store.currentKnowledge(readPath)).toThrow(`session S${owner.id} has a corrupted recorded foreground`);
  } finally { store.close(); }
});

test("67: projection loads only direct-support owner cursors and reuses reader membership", () => {
  const store = new Store(":memory:");
  try {
    const project = store.createProject({ name: "cursor-locality", declaredBy: "mark" });
    const owners: { sessionId: number; path: KnowledgePath; factId: number }[] = [];
    store.transaction(() => {
      for (let index = 0; index < 12; index++) {
        const owner = session(store, project.id, `owner-${index}`);
        const ids: number[] = []; let parent: number | null = null;
        for (let entry = 0; entry < 200; entry++) {
          const node = append(store, owner.id, parent, `${index}-${entry}`);
          parent = node.turn.id; ids.push(node.entry.id);
        }
        store.publishSourcePath(owner.id, "main", ids, parent!, "first");
        store.publishSourcePath(owner.id, "prefix", ids.slice(0, 100), store.getSourceEntry(ids[99]!)!.turnId, "second");
        owners.push({ sessionId: owner.id, path: { sessionId: owner.id, branch: "main", headTurnId: parent },
          factId: fact(store, owner.id, "main", parent!, `T${parent}#user`, ids.at(-1)).id });
      }
      for (const owner of owners.slice(0, 2)) knowledge(store, owner.path, owner.factId, `supported-${owner.sessionId}`);
    });
    const original = store.db.prepare.bind(store.db);
    let cursorRows = 0, membershipBatches = 0;
    store.db.prepare = ((sql: string) => {
      const statement = original(sql);
      if (sql.includes("FROM session_lineage_cursors c LEFT JOIN source_paths")) {
        const all = statement.all.bind(statement);
        statement.all = ((...args: Parameters<typeof statement.all>) => {
          const rows = all(...args); cursorRows += rows.length; return rows;
        }) as typeof statement.all;
      }
      if (sql.includes("seeds(key, owner, root)")) membershipBatches++;
      return statement;
    }) as typeof store.db.prepare;
    try {
      const input = store.commitGraphInput();
      expect([...input.metadata.currentPaths!.keys()]).toEqual(owners.slice(0, 2).map(owner => owner.sessionId));
      expect(input.metadata.currentSnapshots!.size).toBe(4);
      expect(cursorRows).toBe(4); // Not all 24 cursors / 3,600 persisted path entries.
      expect(membershipBatches).toBe(1);
      const read = store.commitGraph(owners[11]!.path, undefined, undefined, input);
      expect(read.current).toHaveLength(2); // Global resolution was not narrowed to the reader.
    } finally { store.db.prepare = original; }
  } finally { store.close(); }
});

test("bound facts batch owner work without loading selected-entry addresses", () => {
  const store = new Store(":memory:");
  try {
    const project = store.createProject({ name: "structural", declaredBy: "mark" });
    const owners: { sessionId: number; path: KnowledgePath; factId: number }[] = [];
    for (let index = 0; index < 24; index++) {
      const owner = session(store, project.id, `owner-${index}`), node = append(store, owner.id, null, `node-${index}`);
      store.selectSourcePath(owner.id, "main", [node.entry.id]);
      store.setCurrentPath(owner.id, "main", node.turn.id, "test-lineage");
      owners.push({ sessionId: owner.id, path: { sessionId: owner.id, branch: "main", headTurnId: node.turn.id },
        factId: fact(store, owner.id, "main", node.turn.id, `T${node.turn.id}#user`, node.entry.id).id });
    }
    for (const [index, owner] of owners.entries()) knowledge(store, owner.path, owner.factId, `item-${index}`);

    const original = store.db.prepare.bind(store.db), originalSnapshot = store.pathSnapshot.bind(store);
    let addressReads = 0, lineageBatches = 0, readerSnapshots = 0;
    store.pathSnapshot = path => { readerSnapshots++; return originalSnapshot(path); };
    (store.db as unknown as { prepare: typeof store.db.prepare }).prepare = ((sql: string) => {
      if (/SELECT id, session_id, turn_id, addresses FROM source_entries/.test(sql)) addressReads++;
      if (/seeds\(key, owner, root\)/.test(sql)) lineageBatches++;
      return original(sql);
    }) as typeof store.db.prepare;
    try {
      expect(store.currentKnowledge(owners[0]!.path)).toHaveLength(owners.length);
    } finally {
      (store.db as unknown as { prepare: typeof store.db.prepare }).prepare = original;
    }
    expect(lineageBatches).toBe(1);
    expect(addressReads).toBe(0);
    expect(readerSnapshots).toBe(0); // Global/project-only reads need no extra reader-branch snapshot.
  } finally { store.close(); }
});
