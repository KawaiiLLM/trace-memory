// Ticket 71: the reads behind injection, the footer and the daily spend touch only what their
// answer depends on. These cases pin the row shape each mechanism reads, not just its output —
// the same output for the wrong reason (a full Raw-row scan that happens to answer correctly) is
// exactly what a covering index or a batched lookup must not regress back into.
import { afterEach, expect, test } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Store, type KnowledgePath } from "../../../src/core/store/index.ts";

const at = "2026-09-23T00:00:00.000Z";
const directories: string[] = [];
afterEach(() => { for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true }); });
function database() {
  const directory = mkdtempSync(join(tmpdir(), "tm-71-shape-"));
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
function fact(store: Store, sessionId: number, branch: string, turnId: number, source: string, entryId?: number) {
  const result = store.commitNotingRun({ run: { kind: "manual", sessionId, branch, createdAt: at }, facts: [{
    turnId, category: "observation", actor: "user", text: `evidence ${source}`, source: [source],
    ...(entryId === undefined ? {} : { entryIds: [entryId] }), createdAt: at,
  }] });
  if (!result.ok) throw new Error(result.problems.join("; "));
  return result.facts[0]!;
}
/** Capture the SQL text of every prepared statement issued during `run`, restoring `db.prepare` after. */
function captureSql<T>(store: Store, run: () => T): { result: T; statements: string[] } {
  const original = store.db.prepare.bind(store.db);
  const statements: string[] = [];
  (store.db as unknown as { prepare: typeof store.db.prepare }).prepare = ((sql: string) => { statements.push(sql); return original(sql); }) as typeof store.db.prepare;
  try { return { result: run(), statements }; }
  finally { (store.db as unknown as { prepare: typeof store.db.prepare }).prepare = original; }
}

test("71: current membership and a path snapshot read source_entries only through the covering index, never content or blocks", () => {
  const dbPath = database(), store = new Store(dbPath);
  try {
    const project = store.createProject({ name: "shape", declaredBy: "mark" });
    const owner = session(store, project.id, "owner"), reader = session(store, project.id, "reader");
    const root = append(store, owner.id, null, "root"), child = append(store, owner.id, root.turn.id, "child");
    const readNode = append(store, reader.id, null, "read");
    store.selectSourcePath(owner.id, "main", [root.entry.id, child.entry.id]);
    store.selectSourcePath(reader.id, "main", [readNode.entry.id]);
    store.setCurrentPath(owner.id, "main", child.turn.id, "L");
    store.setCurrentPath(reader.id, "main", readNode.turn.id, "L");
    const boundFact = fact(store, owner.id, "main", child.turn.id, `T${child.turn.id}#user`, child.entry.id);
    const legacyFact = fact(store, owner.id, "main", root.turn.id, `T${root.turn.id}#user`);
    const path: KnowledgePath = { sessionId: owner.id, branch: "main", headTurnId: child.turn.id };
    const consolidation = store.commitConsolidationRun({ path, run: { kind: "consolidation", sessionId: owner.id, branch: "main", createdAt: at },
      operations: [{ op: "create", handle: "$k", author: "test", text: "k", category: "mechanism", scope: "global",
        supports: [boundFact.id, legacyFact.id], topics: [], reason: "shape fixture", createdAt: at }] });
    if (!consolidation.ok) throw new Error(consolidation.problems.join("; "));
    const readerPath: KnowledgePath = { sessionId: reader.id, branch: "main", headTurnId: readNode.turn.id };

    const { result: input, statements } = captureSql(store, () => store.commitGraphInput());
    expect(input.metadata.currentSnapshots!.size).toBeGreaterThan(0); // membership was actually built
    const { statements: snapshotStatements } = captureSql(store, () => store.pathSnapshot(readerPath));
    // The footer's live `entries` count reaches the path's entry list on every refresh, cached or not.
    const { statements: pendingStatements } = captureSql(store, () => store.pendingEntryIds(reader.id, "main", readNode.turn.id));
    const sourceStatements = [...statements, ...snapshotStatements, ...pendingStatements].filter(sql => sql.includes("source_entries"));
    expect(sourceStatements.length).toBeGreaterThan(0);
    for (const sql of sourceStatements) {
      expect(sql).not.toMatch(/\bcontent\b/); // 8.1 KB Raw payload column, never selected for membership
      expect(sql).not.toMatch(/\bblocks\b/); // 4.2 KB derived-block column, never selected for membership
    }
    // Every source_entries statement here is answerable from the covering index alone.
    for (const sql of sourceStatements) {
      const plan = store.db.prepare(`EXPLAIN QUERY PLAN ${sql}`).all(JSON.stringify([child.entry.id, root.entry.id]))
        .map(row => String((row as { detail: string }).detail)).join("\n");
      expect(plan).toMatch(/COVERING INDEX idx_source_membership/);
    }
  } finally { store.close(); }
});

test("71: a footer miss issues no per-fact turns lookup", () => {
  const dbPath = database(), store = new Store(dbPath);
  try {
    const project = store.createProject({ name: "turns-batch", declaredBy: "mark" });
    const owner = session(store, project.id, "owner");
    let parent: number | null = null;
    const nodes: ReturnType<typeof append>[] = [];
    for (let i = 0; i < 6; i++) { const node = append(store, owner.id, parent, `n${i}`); parent = node.turn.id; nodes.push(node); }
    store.selectSourcePath(owner.id, "main", nodes.map(n => n.entry.id));
    for (const node of nodes) fact(store, owner.id, "main", node.turn.id, `T${node.turn.id}#user`, node.entry.id);
    const path: KnowledgePath = { sessionId: owner.id, branch: "main", headTurnId: nodes.at(-1)!.turn.id };

    const { result: facts, statements } = captureSql(store, () => store.listBranchFacts(owner.id, "main", path.headTurnId));
    expect(facts).toHaveLength(nodes.length);
    const perRowTurnLookups = statements.filter(sql => sql === "SELECT * FROM turns WHERE id = ?");
    expect(perRowTurnLookups).toHaveLength(0); // was one per candidate fact before 71
  } finally { store.close(); }
});

test("71: two lineages of one session keep independent membership, not a concatenated union", () => {
  const dbPath = database(), store = new Store(dbPath);
  try {
    const project = store.createProject({ name: "two-lineages", declaredBy: "mark" });
    const owner = session(store, project.id, "owner"), reader = session(store, project.id, "reader");
    // Two divergent branches from the same root: L1's tip is not on L2's ancestry, and vice versa.
    const root = append(store, owner.id, null, "root");
    const leftChild = append(store, owner.id, root.turn.id, "left");
    const rightChild = append(store, owner.id, root.turn.id, "right");
    const readNode = append(store, reader.id, null, "read");
    store.selectSourcePath(owner.id, "left", [root.entry.id, leftChild.entry.id]);
    store.selectSourcePath(owner.id, "right", [root.entry.id, rightChild.entry.id]);
    store.selectSourcePath(reader.id, "main", [readNode.entry.id]);
    store.setCurrentPath(owner.id, "left", leftChild.turn.id, "L1");
    store.setCurrentPath(owner.id, "right", rightChild.turn.id, "L2");
    store.setCurrentPath(reader.id, "main", readNode.turn.id, "L1");

    // Membership is built only for sessions a citing knowledge revision actually owns, so create the
    // facts and the citing commits first, then inspect the per-lineage snapshots they caused to build.
    const leftFact = fact(store, owner.id, "left", leftChild.turn.id, `T${leftChild.turn.id}#user`, leftChild.entry.id);
    const rightFact = fact(store, owner.id, "right", rightChild.turn.id, `T${rightChild.turn.id}#user`, rightChild.entry.id);
    const path: KnowledgePath = { sessionId: owner.id, branch: "left", headTurnId: leftChild.turn.id };
    const leftKnowledge = store.commitConsolidationRun({ path, run: { kind: "consolidation", sessionId: owner.id, branch: "left", createdAt: at },
      operations: [{ op: "create", handle: "$left", author: "test", text: "left", category: "mechanism", scope: "global",
        supports: [leftFact.id], topics: [], reason: "two-lineage fixture", createdAt: at }] });
    if (!leftKnowledge.ok) throw new Error(leftKnowledge.problems.join("; "));
    const rightPath: KnowledgePath = { sessionId: owner.id, branch: "right", headTurnId: rightChild.turn.id };
    const rightKnowledge = store.commitConsolidationRun({ path: rightPath, run: { kind: "consolidation", sessionId: owner.id, branch: "right", createdAt: at },
      operations: [{ op: "create", handle: "$right", author: "test", text: "right", category: "mechanism", scope: "global",
        supports: [rightFact.id], topics: [], reason: "two-lineage fixture", createdAt: at }] });
    if (!rightKnowledge.ok) throw new Error(rightKnowledge.problems.join("; "));

    const input = store.commitGraphInput();
    const leftSnapshot = input.metadata.currentSnapshots!.get(`${owner.id}:L1`)!;
    const rightSnapshot = input.metadata.currentSnapshots!.get(`${owner.id}:L2`)!;
    expect(leftSnapshot).toBeDefined();
    expect(rightSnapshot).toBeDefined();
    expect(leftSnapshot.turns.has(leftChild.turn.id)).toBe(true);
    expect(leftSnapshot.turns.has(rightChild.turn.id)).toBe(false); // L1's snapshot never sees L2's tip
    expect(rightSnapshot.turns.has(rightChild.turn.id)).toBe(true);
    expect(rightSnapshot.turns.has(leftChild.turn.id)).toBe(false); // L2's snapshot never sees L1's tip

    // Behaviourally: a fact only reachable through L1 is visible to a global reader (owner has L1),
    // and a fact only reachable through L2 is visible too (owner has L2) — but each only through
    // its own lineage's snapshot, never because the two were unioned into one membership.
    const readerPath: KnowledgePath = { sessionId: reader.id, branch: "main", headTurnId: readNode.turn.id };
    const ids = store.currentKnowledge(readerPath).map(v => v.revision.id).sort();
    expect(ids).toEqual([leftKnowledge.committed[0]!.commit, rightKnowledge.committed[0]!.commit].sort());
  } finally { store.close(); }
});
