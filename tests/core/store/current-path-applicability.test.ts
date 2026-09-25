import { afterEach, expect, test } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { TraceMemory } from "../../../src/core/api/index.ts";
import { Store, type KnowledgePath } from "../../../src/core/store/index.ts";
import { AdmittedDreamerScenarios, createDreamerTrigger } from "../../admitted-dreamer-scenario.ts";

const at = "2026-09-21T00:00:00.000Z";
const directories: string[] = [];
afterEach(() => { for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true }); });

function database() {
  const directory = mkdtempSync(join(tmpdir(), "tm-current-path-"));
  directories.push(directory);
  return join(directory, "trace.db");
}

function session(store: Store, projectId: number, host: string) {
  return store.createSession({ enrollmentChoice: true, host, startedAt: at, firstReplyAt: at, projectId });
}

function append(store: Store, sessionId: number, parentTurnId: number | null, nativeId: string) {
  const turn = store.appendTurn({ sessionId, parentTurnId, kind: "turn", userPrompt: nativeId, startedAt: at });
  const entry = store.appendSourceEntry({ sessionId, nativeLineage: `lineage-${sessionId}`, nativeId, turnId: turn.id,
    role: "user", text: nativeId, raw: JSON.stringify({ role: "user", content: nativeId }), calls: [] });
  return { turn, entry };
}

function writeFact(store: Store, sessionId: number, branch: string, turnId: number, entryId: number, text = "foreground-only evidence") {
  const result = store.commitNotingRun({ run: { kind: "manual", sessionId, branch, createdAt: at }, facts: [{
    turnId, category: "observation", actor: "user", text, source: [`T${turnId}#user`],
    entryIds: [entryId], createdAt: at,
  }] });
  if (!result.ok) throw new Error(result.problems.join("; "));
  return result.facts[0]!;
}

function create(store: Store, path: KnowledgePath, factId: number, scope: "global" | "project" | "session", text: string) {
  const result = store.commitConsolidationRun({ path, run: { kind: "manual", sessionId: path.sessionId, branch: path.branch, createdAt: at },
    operations: [{ op: "create", handle: `$${scope}`, author: "test", text, category: "constraint", scope,
      topics: [], supports: [factId], reason: "represent current-path applicability", createdAt: at }] });
  if (!result.ok) throw new Error(result.problems.join("; "));
  return result.committed[0]!;
}

test("64b pilot: one persisted owner path controls shared global and project reads across Store instances", () => {
  const dbPath = database(), writer = new Store(dbPath);
  const p = writer.createProject({ name: "P", declaredBy: "mark" });
  const q = writer.createProject({ name: "Q", declaredBy: "mark" });
  const a = session(writer, p.id, "A"), b = session(writer, p.id, "B"), outsider = session(writer, q.id, "Q-reader");
  const a0 = append(writer, a.id, null, "a0"), a1 = append(writer, a.id, a0.turn.id, "a1");
  const b0 = append(writer, b.id, null, "b0"), q0 = append(writer, outsider.id, null, "q0");
  writer.selectSourcePath(a.id, "main", [a0.entry.id, a1.entry.id]);
  writer.selectSourcePath(a.id, "rewind", [a0.entry.id]);
  writer.selectSourcePath(b.id, "main", [b0.entry.id]);
  writer.selectSourcePath(outsider.id, "main", [q0.entry.id]);
  writer.setCurrentPath(a.id, "main", a1.turn.id, "test-lineage");
  writer.setCurrentPath(b.id, "main", b0.turn.id, "test-lineage");
  writer.setCurrentPath(outsider.id, "main", q0.turn.id, "test-lineage");
  const fact = writeFact(writer, a.id, "main", a1.turn.id, a1.entry.id);
  const aPath = { sessionId: a.id, branch: "main", headTurnId: a1.turn.id };
  const global = create(writer, aPath, fact.id, "global", "shared globally");
  const project = create(writer, aPath, fact.id, "project", "shared in P");
  const reader = new Store(dbPath);
  try {
    const bPath = { sessionId: b.id, branch: "main", headTurnId: b0.turn.id };
    const qPath = { sessionId: outsider.id, branch: "main", headTurnId: q0.turn.id };
    expect(reader.currentKnowledge(bPath).map(value => value.revision.id)).toEqual([global.commit, project.commit]);
    expect(reader.currentKnowledge(qPath).map(value => value.revision.id)).toEqual([global.commit]);
    expect(reader.currentKnowledge(null, { projectId: p.id }).map(value => value.revision.id)).toEqual([global.commit, project.commit]);

    writer.setEnrollment(a.id, false);
    expect(reader.currentKnowledge(bPath).map(value => value.revision.id)).toEqual([global.commit, project.commit]);

    writer.setCurrentPath(a.id, "rewind", a0.turn.id, "test-lineage");
    expect(reader.currentKnowledge(bPath)).toEqual([]);
    expect(reader.currentKnowledge(null, { projectId: p.id })).toEqual([]);

    writer.setCurrentPath(a.id, "main", a1.turn.id, "test-lineage");
    expect(reader.currentKnowledge(bPath).map(value => value.revision.id)).toEqual([global.commit, project.commit]);
  } finally {
    reader.close(); writer.close();
  }
});

test("64b P1: an unrecorded branched session contributes all facts until first publication, then retains the strict path", () => {
  const dbPath = database();
  let writer = new Store(dbPath);
  const p = writer.createProject({ name: "P", declaredBy: "mark" }), q = writer.createProject({ name: "Q", declaredBy: "mark" });
  const a = session(writer, p.id, "legacy-A"), b = session(writer, p.id, "reader-P"), outsider = session(writer, q.id, "reader-Q");
  const root = append(writer, a.id, null, "root"), left = append(writer, a.id, root.turn.id, "left"),
    right = append(writer, a.id, root.turn.id, "right");
  const b0 = append(writer, b.id, null, "b"), q0 = append(writer, outsider.id, null, "q");
  writer.selectSourcePath(a.id, "left", [root.entry.id, left.entry.id]);
  writer.selectSourcePath(a.id, "right", [root.entry.id, right.entry.id]);
  writer.selectSourcePath(b.id, "main", [b0.entry.id]);
  writer.selectSourcePath(outsider.id, "main", [q0.entry.id]);
  const leftFact = writeFact(writer, a.id, "left", left.turn.id, left.entry.id, "left branch fact");
  const rightFact = writeFact(writer, a.id, "right", right.turn.id, right.entry.id, "right branch fact");
  const leftPath = { sessionId: a.id, branch: "left", headTurnId: left.turn.id };
  const rightPath = { sessionId: a.id, branch: "right", headTurnId: right.turn.id };
  const leftGlobal = create(writer, leftPath, leftFact.id, "global", "left global");
  const rightGlobal = create(writer, rightPath, rightFact.id, "global", "right global");
  const leftProject = create(writer, leftPath, leftFact.id, "project", "left project");
  const leftSession = create(writer, leftPath, leftFact.id, "session", "left session");
  expect(writer.db.prepare("SELECT * FROM session_lineage_cursors WHERE session_id = ?").all(a.id)).toEqual([]);

  const reader = new Store(dbPath);
  const bPath = { sessionId: b.id, branch: "main", headTurnId: b0.turn.id };
  const qPath = { sessionId: outsider.id, branch: "main", headTurnId: q0.turn.id };
  try {
    expect(reader.currentKnowledge(bPath).map(value => value.revision.id))
      .toEqual([leftGlobal.commit, rightGlobal.commit, leftProject.commit]);
    expect(reader.currentKnowledge(qPath).map(value => value.revision.id)).toEqual([leftGlobal.commit, rightGlobal.commit]);
    expect(reader.currentKnowledge(leftPath).map(value => value.revision.id))
      .toEqual([leftGlobal.commit, rightGlobal.commit, leftProject.commit, leftSession.commit]);
    expect(reader.currentKnowledge(null, { projectId: p.id }).map(value => value.revision.id))
      .toEqual([leftGlobal.commit, rightGlobal.commit, leftProject.commit]);

    writer.setCurrentPath(a.id, "left", left.turn.id, "test-lineage");
    for (const read of [reader.currentKnowledge(bPath), reader.currentKnowledge(null, { projectId: p.id })])
      expect(read.map(value => value.revision.id)).toEqual([leftGlobal.commit, leftProject.commit]);
    expect(reader.currentKnowledge(qPath).map(value => value.revision.id)).toEqual([leftGlobal.commit]);

    writer.setEnrollment(a.id, false);
    writer.closeSession(a.id);
    expect(reader.currentKnowledge(bPath).map(value => value.revision.id)).toEqual([leftGlobal.commit, leftProject.commit]);
    expect(writer.db.prepare("SELECT lineage, branch, head_turn_id FROM session_lineage_cursors WHERE session_id = ?").all(a.id))
      .toEqual([{ lineage: "test-lineage", branch: "left", head_turn_id: left.turn.id }]);
    expect(writer.getSession(a.id)).toMatchObject({ closedAt: expect.any(String) });
    writer.close();

    writer = new Store(dbPath);
    writer.reopenSession(a.id, "restored-executor");
    expect(writer.db.prepare("SELECT lineage, branch, head_turn_id FROM session_lineage_cursors WHERE session_id = ?").all(a.id))
      .toEqual([{ lineage: "test-lineage", branch: "left", head_turn_id: left.turn.id }]);
    expect(writer.getSession(a.id)).toMatchObject({ closedAt: null });
    expect(reader.currentKnowledge(bPath).map(value => value.revision.id)).toEqual([leftGlobal.commit, leftProject.commit]);
  } finally {
    reader.close(); writer.close();
  }
});

test("64b pilot: corrupted recorded foreground fails Knowledge reads explicitly", () => {
  const dbPath = database(), store = new Store(dbPath);
  try {
    const project = store.createProject({ name: "corruption", declaredBy: "mark" });
    const owner = session(store, project.id, "owner"), other = session(store, project.id, "other");
    const root = append(store, owner.id, null, "root"), foreign = append(store, other.id, null, "foreign");
    store.selectSourcePath(owner.id, "main", [root.entry.id]);
    const fact = writeFact(store, owner.id, "main", root.turn.id, root.entry.id);
    create(store, { sessionId: owner.id, branch: "main", headTurnId: root.turn.id }, fact.id, "global", "corruption probe");
    const read = () => store.currentKnowledge({ sessionId: owner.id, branch: "main", headTurnId: root.turn.id });

    store.setCurrentPath(owner.id, "main", root.turn.id, "native-owner");
    for (const [branch, head] of [["missing", root.turn.id], ["main", foreign.turn.id]] as const) {
      store.db.prepare("UPDATE session_lineage_cursors SET branch = ?, head_turn_id = ? WHERE session_id = ? AND lineage = ?")
        .run(branch, head, owner.id, "native-owner");
      expect(read).toThrow(`session S${owner.id} has a corrupted recorded foreground`);
    }
  } finally { store.close(); }
});

// This is deliberately a real admitted Dreamer run: the child cites only B's fact, while its parent
// cites A's. Rewinding A removes only the directly grounded parent; lineage is provenance, not grounds.
test("64b pilot: an admitted Dreamer child uses only its direct foreground support", async () => {
  const dbPath = database();
  const scenarios = new AdmittedDreamerScenarios(async () => { throw new Error("unexpected non-Dreamer phase"); });
  const memory = TraceMemory(dbPath, scenarios.agent), store = memory.store;
  try {
    const project = store.createProject({ name: "lineage", declaredBy: "mark" });
    const a = session(store, project.id, "lineage-A"), b = session(store, project.id, "lineage-B");
    const a0 = append(store, a.id, null, "a-root"), a1 = append(store, a.id, a0.turn.id, "a-supported");
    const b0 = append(store, b.id, null, "b-supported");
    store.selectSourcePath(a.id, "supported", [a0.entry.id, a1.entry.id]);
    store.selectSourcePath(a.id, "rewind", [a0.entry.id]);
    store.selectSourcePath(b.id, "main", [b0.entry.id]);
    store.setCurrentPath(a.id, "supported", a1.turn.id, "test-lineage");
    store.setCurrentPath(b.id, "main", b0.turn.id, "test-lineage");
    const parentFact = writeFact(store, a.id, "supported", a1.turn.id, a1.entry.id, "parent support");
    const childFact = writeFact(store, b.id, "main", b0.turn.id, b0.entry.id, "child support");
    const parent = create(store, { sessionId: a.id, branch: "supported", headTurnId: a1.turn.id }, parentFact.id, "global", "parent claim");
    const parentForDirectA = create(store, { sessionId: a.id, branch: "supported", headTurnId: a1.turn.id }, parentFact.id, "global", "second parent claim");
    const target = { sessionId: b.id, branch: "main", headTurnId: b0.turn.id, triggerEntryId: b0.entry.id };
    const trigger = createDreamerTrigger(memory, target, childFact.id, 1, "global");
    let child!: { knowledgeId: number; commit: number }, childCitingA!: { knowledgeId: number; commit: number };
    const dreamed = await scenarios.run(memory, target, input => {
      const request = { fixture: "64b recursive foreground applicability" }; input.reportRequest(request);
      const trace = input.tools.find(tool => tool.name === "trace")!, write = input.tools.find(tool => tool.name === "memory")!;
      expect(trace.execute({ address: `K${parent.knowledgeId}@${parent.commit}`, itemBudget: null })).toContain("parent claim");
      expect(trace.execute({ address: `K${parentForDirectA.knowledgeId}@${parentForDirectA.commit}`, itemBudget: null })).toContain("second parent claim");
      expect(trace.execute({ address: `K${trigger.knowledgeId}@${trigger.commit}`, itemBudget: null })).toContain("Fixture trigger 1");
      const receipt = JSON.parse(write.execute({ operations: [{ op: "update", id: `K${parent.knowledgeId}@${parent.commit}`,
        text: "child claim", category: "constraint", scope: "global", supports: [`F${childFact.id}`], topics: [], reason: "Child revision." },
      { op: "update", id: `K${parentForDirectA.knowledgeId}@${parentForDirectA.commit}`,
        text: "child explicitly citing A", category: "constraint", scope: "global", supports: [`F${parentFact.id}`], topics: [], reason: "Direct A support." },
      { op: "archive", id: `K${trigger.knowledgeId}@${trigger.commit}`, supports: [`F${childFact.id}`], reason: "Retire explicit trigger." }], skipped: [] }));
      child = receipt.committed.find((value: { knowledgeId: number }) => value.knowledgeId === parent.knowledgeId)!;
      childCitingA = receipt.committed.find((value: { knowledgeId: number }) => value.knowledgeId === parentForDirectA.knowledgeId)!;
      expect(input.tools.find(tool => tool.name === "check")!.execute({})).toContain("Blockers: none");
      return { outcome: "success", output: "lineage updated", request };
    });
    expect(dreamed.outcome).toBe("success");
    const bPath = { sessionId: b.id, branch: "main", headTurnId: b0.turn.id };
    expect(store.currentKnowledge(bPath).find(value => value.knowledge.id === parent.knowledgeId)?.revision.id).toBe(child.commit);

    store.setCurrentPath(a.id, "rewind", a0.turn.id, "test-lineage");
    expect(store.currentKnowledge(bPath).find(value => value.knowledge.id === parent.knowledgeId)?.revision.id).toBe(child.commit);
    expect(store.commitGraph(bPath).applicable.has(parent.commit)).toBe(false);
    expect(store.commitGraph(bPath).applicable.has(child.commit)).toBe(true);
    expect(store.commitGraph(bPath).applicable.has(childCitingA.commit)).toBe(false);
  } finally { memory.close(); }
});

test("64b validity pilot: later applicable commit wins independent of restore order and direct facts control fallback", async () => {
  const dbPath = database();
  const scenarios = new AdmittedDreamerScenarios(async () => { throw new Error("unexpected non-Dreamer phase"); });
  let memory = TraceMemory(dbPath, scenarios.agent), store = memory.store;
  const project = store.createProject({ name: "validity", declaredBy: "mark" });
  const a = session(store, project.id, "validity-A"), b = session(store, project.id, "validity-B");
  const a0 = append(store, a.id, null, "a-root"), a1 = append(store, a.id, a0.turn.id, "a-child");
  const bPre = append(store, b.id, null, "b-pre"), bFactNode = append(store, b.id, bPre.turn.id, "b-fact"),
    bMid = append(store, b.id, bFactNode.turn.id, "b-mid"), bWrite = append(store, b.id, bMid.turn.id, "b-write");
  store.selectSourcePath(a.id, "main", [a0.entry.id, a1.entry.id]);
  store.selectSourcePath(a.id, "rewind", [a0.entry.id]);
  store.selectSourcePath(b.id, "main", [bPre.entry.id, bFactNode.entry.id, bMid.entry.id, bWrite.entry.id]);
  store.selectSourcePath(b.id, "mid", [bPre.entry.id, bFactNode.entry.id, bMid.entry.id]);
  store.selectSourcePath(b.id, "pre", [bPre.entry.id]);
  store.setCurrentPath(a.id, "main", a1.turn.id, "test-lineage");
  store.setCurrentPath(b.id, "main", bWrite.turn.id, "test-lineage");
  const rootFact = writeFact(store, a.id, "main", a0.turn.id, a0.entry.id, "root support");
  const archiveFact = writeFact(store, a.id, "main", a1.turn.id, a1.entry.id, "archive support");
  const bFact = writeFact(store, b.id, "main", bFactNode.turn.id, bFactNode.entry.id, "B replacement support");
  const aMain = { sessionId: a.id, branch: "main", headTurnId: a1.turn.id };
  const aRewind = { sessionId: a.id, branch: "rewind", headTurnId: a0.turn.id };
  const bPath = { sessionId: b.id, branch: "main", headTurnId: bWrite.turn.id, triggerEntryId: bWrite.entry.id };
  const base = create(store, aMain, rootFact.id, "global", "base body");
  const archived = store.commitConsolidationRun({ path: aMain,
    run: { kind: "manual", sessionId: a.id, branch: "main", createdAt: at },
    operations: [{ op: "archive", knowledgeId: base.knowledgeId, baseCommit: base.commit,
      supports: [archiveFact.id], reason: "Archive on A child.", createdAt: at }] });
  if (!archived.ok) throw new Error(archived.problems.join("; "));
  const archiveCommit = archived.committed[0]!.commit;
  expect(store.commitGraph(aMain).effective.has(archiveCommit)).toBe(true);
  expect(store.currentKnowledge(aMain).some(item => item.knowledge.id === base.knowledgeId)).toBe(false);

  store.setCurrentPath(a.id, "rewind", a0.turn.id, "test-lineage");
  expect(store.currentCommit(base.knowledgeId, bPath).map(revision => revision.id)).toEqual([base.commit]);
  store.setCurrentPath(a.id, "main", a1.turn.id, "test-lineage");
  expect(store.commitGraph(bPath).effective.has(archiveCommit)).toBe(true);
  expect(store.currentKnowledge(bPath).some(item => item.knowledge.id === base.knowledgeId)).toBe(false);
  store.setCurrentPath(a.id, "rewind", a0.turn.id, "test-lineage");

  const trigger = createDreamerTrigger(memory, bPath, bFact.id, 1, "global");
  let replacement!: { knowledgeId: number; commit: number };
  const dreamed = await scenarios.run(memory, bPath, input => {
    const request = { fixture: "64b validity replacement" }; input.reportRequest(request);
    const trace = input.tools.find(tool => tool.name === "trace")!, write = input.tools.find(tool => tool.name === "memory")!;
    expect(trace.execute({ address: `K${base.knowledgeId}@${base.commit}`, itemBudget: null })).toContain("base body");
    trace.execute({ address: `K${trigger.knowledgeId}@${trigger.commit}`, itemBudget: null, pageBudget: 8000 });
    const receipt = JSON.parse(write.execute({ operations: [{ op: "update", id: `K${base.knowledgeId}@${base.commit}`,
      text: "B replacement", category: "constraint", scope: "global", supports: [`F${bFact.id}`], topics: [], reason: "Replace rewound base." },
    { op: "archive", id: `K${trigger.knowledgeId}@${trigger.commit}`, supports: [`F${bFact.id}`], reason: "Retire trigger." }], skipped: [] }));
    replacement = receipt.committed.find((value: { knowledgeId: number }) => value.knowledgeId === base.knowledgeId)!;
    expect(input.tools.find(tool => tool.name === "check")!.execute({})).toContain("Blockers: none");
    return { outcome: "success", output: "replaced", request };
  });
  expect(dreamed.outcome).toBe("success");

  // Restoring A first cannot override the later applicable branch.
  store.setCurrentPath(a.id, "main", a1.turn.id, "test-lineage");
  let graph = store.commitGraph(bPath);
  expect(graph.applicable.has(archiveCommit)).toBe(true);
  expect(graph.effective.has(archiveCommit)).toBe(false);
  expect(graph.effective.has(replacement.commit)).toBe(true);
  expect(store.currentKnowledge(bPath).find(item => item.knowledge.id === base.knowledgeId)?.revision.id).toBe(replacement.commit);

  // Rewind past the write trigger but not its directly cited fact: applicability and priority remain.
  store.setCurrentPath(b.id, "mid", bMid.turn.id, "test-lineage");
  graph = store.commitGraph(bPath);
  expect(graph.applicable.has(replacement.commit)).toBe(true);
  expect(graph.effective.has(replacement.commit)).toBe(true);

  // Rewind past the direct fact: the later branch stops applying and the earlier archive returns.
  store.setCurrentPath(b.id, "pre", bPre.turn.id, "test-lineage");
  graph = store.commitGraph(bPath);
  expect(graph.applicable.has(replacement.commit)).toBe(false);
  expect(graph.effective.has(archiveCommit)).toBe(true);
  expect(store.currentCommit(base.knowledgeId, bPath).map(revision => revision.id)).toEqual([archiveCommit]);
  expect(store.currentKnowledge(bPath).some(item => item.knowledge.id === base.knowledgeId)).toBe(false);

  // Restoring B makes the later branch applicable again; commit order, not restoration order, wins.
  store.setCurrentPath(b.id, "main", bWrite.turn.id, "test-lineage");
  expect(store.currentKnowledge(bPath).find(item => item.knowledge.id === base.knowledgeId)?.revision.id).toBe(replacement.commit);
  store.setCurrentPath(a.id, "rewind", a0.turn.id, "test-lineage");
  store.setCurrentPath(a.id, "main", a1.turn.id, "test-lineage");
  expect(store.currentKnowledge(bPath).find(item => item.knowledge.id === base.knowledgeId)?.revision.id).toBe(replacement.commit);

  memory.close();
  memory = TraceMemory(dbPath, scenarios.agent); store = memory.store;
  graph = store.commitGraph(bPath);
  expect(graph.effective.has(archiveCommit)).toBe(false);
  expect(store.currentKnowledge(bPath).find(item => item.knowledge.id === base.knowledgeId)?.revision.id).toBe(replacement.commit);
  memory.close();
});

test("64b scope visibility: global current hides older visible revisions, rejects their base, then widening reveals the new current", async () => {
  const scenarios = new AdmittedDreamerScenarios(async () => { throw new Error("unexpected non-Dreamer phase"); });
  const memory = TraceMemory(":memory:", scenarios.agent), store = memory.store;
  try {
    const project = store.createProject({ name: "scope-current", declaredBy: "mark" });
    const owner = session(store, project.id, "scope-owner"), peer = session(store, project.id, "scope-peer");
    const ownerNode = append(store, owner.id, null, "owner"), peerNode = append(store, peer.id, null, "peer");
    store.selectSourcePath(owner.id, "main", [ownerNode.entry.id]);
    store.selectSourcePath(peer.id, "main", [peerNode.entry.id]);
    store.setCurrentPath(owner.id, "main", ownerNode.turn.id, "test-lineage");
    store.setCurrentPath(peer.id, "main", peerNode.turn.id, "test-lineage");
    const ownerPath = { sessionId: owner.id, branch: "main", headTurnId: ownerNode.turn.id, triggerEntryId: ownerNode.entry.id };
    const peerPath = { sessionId: peer.id, branch: "main", headTurnId: peerNode.turn.id, triggerEntryId: peerNode.entry.id };
    const ownerFact = writeFact(store, owner.id, "main", ownerNode.turn.id, ownerNode.entry.id, "owner scope evidence");
    const peerFact = writeFact(store, peer.id, "main", peerNode.turn.id, peerNode.entry.id, "peer scope evidence");
    const base = create(store, ownerPath, ownerFact.id, "project", "project body");
    let sequence = 0;
    const update = async (prior: { knowledgeId: number; commit: number }, scope: "session" | "project", text: string) => {
      const trigger = createDreamerTrigger(memory, ownerPath, ownerFact.id, ++sequence, prior === base ? "project" : "session");
      let changed!: { knowledgeId: number; commit: number };
      const dreamed = await scenarios.run(memory, ownerPath, input => {
        const request = { fixture: `64b scope ${scope}` }; input.reportRequest(request);
        const trace = input.tools.find(tool => tool.name === "trace")!, write = input.tools.find(tool => tool.name === "memory")!;
        trace.execute({ address: `K${prior.knowledgeId}@${prior.commit}`, itemBudget: null, pageBudget: 8000 });
        trace.execute({ address: `K${trigger.knowledgeId}@${trigger.commit}`, itemBudget: null, pageBudget: 8000 });
        const receipt = JSON.parse(write.execute({ operations: [
          { op: "update", id: `K${prior.knowledgeId}@${prior.commit}`, text, category: "constraint", scope,
            supports: [`F${ownerFact.id}`], reason: "Change current visibility.", topics: [] },
          { op: "archive", id: `K${trigger.knowledgeId}@${trigger.commit}`, supports: [`F${ownerFact.id}`], reason: "Retire trigger." },
        ], skipped: [] }));
        changed = receipt.committed.find((item: { knowledgeId: number }) => item.knowledgeId === prior.knowledgeId);
        expect(input.tools.find(tool => tool.name === "check")!.execute({})).toContain("Blockers: none");
        return { outcome: "success", output: text, request };
      });
      expect(dreamed.outcome).toBe("success");
      return changed;
    };

    const narrowed = await update(base, "session", "owner-only body");
    const ownerGraph = store.commitGraph(ownerPath), peerGraph = store.commitGraph(peerPath);
    expect(ownerGraph.resolved.find(item => item.knowledgeId === base.knowledgeId)?.id).toBe(narrowed.commit);
    expect(peerGraph.resolved.find(item => item.knowledgeId === base.knowledgeId)?.id).toBe(narrowed.commit);
    expect(store.currentCommit(base.knowledgeId, ownerPath).map(item => item.id)).toEqual([narrowed.commit]);
    expect(store.currentCommit(base.knowledgeId, peerPath)).toEqual([]);
    const peerHistory = memory.search("project body", "knowledge", { ...peerPath, versions: "history", fields: ["text", "status"] });
    expect(peerHistory).toContain(`superseded on this path by K${base.knowledgeId}@${narrowed.commit}`);
    expect(peerHistory).not.toContain("owner-only body");
    const retained = { raw: new Map<string, "source" | "view">(), factIds: new Set<number>(),
      knowledgeCommitIds: new Set([base.commit]), injection: true, suppliedGeneration: 0 };
    const stateNotice = memory.injection(peerPath, retained).text;
    expect(stateNotice).toContain(`K${base.knowledgeId}@${base.commit} is superseded by K${base.knowledgeId}@${narrowed.commit}`);
    expect(stateNotice).not.toContain("owner-only body");

    const staleTrigger = createDreamerTrigger(memory, peerPath, peerFact.id, ++sequence, "project");
    const staleRun = await scenarios.run(memory, peerPath, input => {
      const request = { fixture: "64b hidden stale base" }; input.reportRequest(request);
      const trace = input.tools.find(tool => tool.name === "trace")!, write = input.tools.find(tool => tool.name === "memory")!;
      trace.execute({ address: `K${base.knowledgeId}@${base.commit}`, itemBudget: null, pageBudget: 8000 });
      trace.execute({ address: `K${staleTrigger.knowledgeId}@${staleTrigger.commit}`, itemBudget: null, pageBudget: 8000 });
      expect(write.execute({ operations: [{ op: "update", id: `K${base.knowledgeId}@${base.commit}`, text: "stale peer edit",
        category: "constraint", scope: "project", supports: [`F${peerFact.id}`], reason: "Must remain stale.", topics: [] }], skipped: [] }))
        .toContain("base is not the latest effective applicable revision");
      write.execute({ operations: [{ op: "archive", id: `K${staleTrigger.knowledgeId}@${staleTrigger.commit}`,
        supports: [`F${peerFact.id}`], reason: "Retire stale probe trigger." }], skipped: [] });
      expect(input.tools.find(tool => tool.name === "check")!.execute({})).toContain("Blockers: none");
      return { outcome: "success", output: "stale hidden base refused", request };
    });
    expect(staleRun.outcome).toBe("success");

    const widened = await update(narrowed, "project", "project body restored at the new revision");
    expect(store.currentCommit(base.knowledgeId, peerPath).map(item => item.id)).toEqual([widened.commit]);

    const privateParent = create(store, ownerPath, ownerFact.id, "session", "private merge parent");
    const mergeTrigger = createDreamerTrigger(memory, ownerPath, ownerFact.id, ++sequence, "project");
    const mergeRun = await scenarios.run(memory, ownerPath, input => {
      const request = { fixture: "64b cross-scope merge" }; input.reportRequest(request);
      const trace = input.tools.find(tool => tool.name === "trace")!, write = input.tools.find(tool => tool.name === "memory")!;
      for (const item of [widened, privateParent, mergeTrigger])
        trace.execute({ address: `K${item.knowledgeId}@${item.commit}`, itemBudget: null, pageBudget: 8000 });
      const before = store.listKnowledgeRevisions().length;
      expect(write.execute({ operations: [{ op: "merge", id: `K${widened.knowledgeId}@${widened.commit}`,
        absorb: [`K${privateParent.knowledgeId}@${privateParent.commit}`], text: "illegal cross-scope merge",
        category: "constraint", scope: "project", supports: [`F${ownerFact.id}`], reason: "Must be refused.", topics: [] }], skipped: [] }))
        .toContain(`base belongs to session:${owner.id}, outside Dreamer pool project:${project.id}`);
      expect(store.listKnowledgeRevisions()).toHaveLength(before);
      expect(store.currentCommit(widened.knowledgeId, ownerPath).map(item => item.id)).toEqual([widened.commit]);
      expect(store.currentCommit(privateParent.knowledgeId, ownerPath).map(item => item.id)).toEqual([privateParent.commit]);
      expect(write.execute({ operations: [{ op: "archive", id: `K${mergeTrigger.knowledgeId}@${mergeTrigger.commit}`,
        supports: [], reason: "Retire cross-scope probe trigger." }], skipped: [] })).toContain("committed");
      return { outcome: "success", output: "cross-scope merge refused", request };
    });
    expect(mergeRun.outcome, JSON.stringify(mergeRun)).toBe("success");

    const projectParent = create(store, ownerPath, ownerFact.id, "project", "same-pool merge parent");
    const resultScopeTrigger = createDreamerTrigger(memory, ownerPath, ownerFact.id, ++sequence, "project");
    const resultScopeRun = await scenarios.run(memory, ownerPath, input => {
      const request = { fixture: "64b merge result scope" }; input.reportRequest(request);
      const trace = input.tools.find(tool => tool.name === "trace")!, write = input.tools.find(tool => tool.name === "memory")!;
      for (const item of [widened, projectParent, resultScopeTrigger])
        trace.execute({ address: `K${item.knowledgeId}@${item.commit}`, itemBudget: null, pageBudget: 8000 });
      expect(write.execute({ operations: [{ op: "merge", id: `K${widened.knowledgeId}@${widened.commit}`,
        absorb: [`K${projectParent.knowledgeId}@${projectParent.commit}`], text: "illegal result scope",
        category: "constraint", scope: "session", supports: [`F${ownerFact.id}`], reason: "Must be refused.", topics: [] }], skipped: [] }))
        .toContain("merge parents and result must share one scope");
      expect(write.execute({ operations: [{ op: "archive", id: `K${resultScopeTrigger.knowledgeId}@${resultScopeTrigger.commit}`,
        supports: [], reason: "Retire result-scope probe trigger." }], skipped: [] })).toContain("committed");
      return { outcome: "success", output: "result scope refused", request };
    });
    expect(resultScopeRun.outcome, JSON.stringify(resultScopeRun)).toBe("success");
  } finally { memory.close(); }
});

test("64b validity pilot: competing same-base Store writes commit once and stale loser rolls back atomically", () => {
  const dbPath = database(), first = new Store(dbPath), second = new Store(dbPath);
  try {
    const project = first.createProject({ name: "competing", declaredBy: "mark" });
    const owner = session(first, project.id, "competing-owner");
    const root = append(first, owner.id, null, "root");
    first.selectSourcePath(owner.id, "main", [root.entry.id]);
    first.setCurrentPath(owner.id, "main", root.turn.id, "test-lineage");
    const fact = writeFact(first, owner.id, "main", root.turn.id, root.entry.id);
    const path = { sessionId: owner.id, branch: "main", headTurnId: root.turn.id };
    const base = create(first, path, fact.id, "session", "one base");
    const attempt = (store: Store, reason: string, includeCreate = false) => store.commitConsolidationRun({ path,
      run: { kind: "manual", sessionId: owner.id, branch: "main", createdAt: at }, operations: [
        ...(includeCreate ? [{ op: "create" as const, handle: "$partial", author: "test", text: "must roll back",
          category: "constraint" as const, scope: "session" as const, supports: [fact.id], topics: [], reason: "Atomic probe.", createdAt: at }] : []),
        { op: "archive" as const, knowledgeId: base.knowledgeId, baseCommit: base.commit, supports: [fact.id], reason, createdAt: at },
      ] });
    const winner = attempt(first, "Winner.");
    expect(winner.ok).toBe(true);
    const before = first.listKnowledgeRevisions().length;
    const loser = attempt(second, "Loser.", true);
    expect(loser.ok).toBe(false);
    if (!loser.ok) expect(loser.problems.join(" ")).toContain("base is not the latest effective applicable revision");
    expect(first.listKnowledgeRevisions()).toHaveLength(before);
    const graph = first.commitGraph(path);
    expect(graph.current.filter(revision => revision.knowledgeId === base.knowledgeId)).toHaveLength(1);
    expect(graph.current.find(revision => revision.knowledgeId === base.knowledgeId)?.id).toBe(winner.ok ? winner.committed[0]!.commit : -1);
  } finally { second.close(); first.close(); }
});

test("64b cursors: sibling lineages preserve whole-fact membership, visibility, persistence and freshness", () => {
  const dbPath = database(), store = new Store(dbPath);
  try {
    const project = store.createProject({ name: "cursor-P", declaredBy: "mark" });
    const owner = session(store, project.id, "cursor-owner");
    const root = append(store, owner.id, null, "root");
    const left = append(store, owner.id, root.turn.id, "left");
    const right = append(store, owner.id, root.turn.id, "right");
    store.selectSourcePath(owner.id, "left", [root.entry.id, left.entry.id]);
    store.selectSourcePath(owner.id, "right", [root.entry.id, right.entry.id]);
    const rootFact = writeFact(store, owner.id, "left", root.turn.id, root.entry.id, "shared prefix");
    const leftFact = writeFact(store, owner.id, "left", left.turn.id, left.entry.id, "left only");
    const rightFact = writeFact(store, owner.id, "right", right.turn.id, right.entry.id, "right only");
    const mixed = store.commitNotingRun({ run: { kind: "manual", sessionId: owner.id, branch: "left", createdAt: at }, facts: [{
      turnId: left.turn.id, category: "observation", actor: "user", text: "requires both siblings",
      source: [`T${right.turn.id}#user`], entryIds: [left.entry.id, right.entry.id], createdAt: at,
    }] });
    if (!mixed.ok) throw new Error(mixed.problems.join("; "));
    const commits = [rootFact, leftFact, rightFact].map((fact, index) =>
      create(store, { sessionId: owner.id, branch: index === 2 ? "right" : "left", headTurnId: index === 2 ? right.turn.id : left.turn.id }, fact.id, "global", `K${index}`));
    const sessionCommit = create(store, { sessionId: owner.id, branch: "left", headTurnId: left.turn.id }, leftFact.id, "session", "left session");
    // Historical/correctly scoped data may cite several same-session sources. Projection, not write setup,
    // proves that no synthetic union of sibling cursors can make one such Fact live.
    const run = store.recordRun({ kind: "manual", sessionId: owner.id, branch: "left", outcome: "success", createdAt: at });
    const knowledgeId = Number(store.db.prepare("INSERT INTO knowledge (origin_session_id, project_id, author) VALUES (?, ?, ?)")
      .run(owner.id, project.id, "test").lastInsertRowid);
    const mixedCommit = Number(store.db.prepare(`INSERT INTO knowledge_revisions
      (knowledge_id, parent_id, text, category, scope, supports, support_semantics, op, reason, topics, run_id, created_at, actor_role)
      VALUES (?, NULL, ?, 'constraint', 'global', ?, 'complete_result', 'create', ?, '[]', ?, ?, 'manual')`)
      .run(knowledgeId, "mixed sibling fact", JSON.stringify([mixed.facts[0]!.id]), "projection probe", run.id, at).lastInsertRowid);

    store.setCurrentPath(owner.id, "left", left.turn.id, "native-left");
    store.setCurrentPath(owner.id, "right", right.turn.id, "native-right");
    expect(store.currentKnowledge(null).map(value => value.revision.id)).toEqual([...commits.map(value => value.commit), sessionCommit.commit]);
    expect(store.commitGraph(null).applicable.has(mixedCommit)).toBe(false);
    expect(store.currentKnowledge({ sessionId: owner.id, branch: "left", headTurnId: left.turn.id }).map(value => value.revision.id))
      .toContain(sessionCommit.commit);
    expect(store.currentKnowledge({ sessionId: owner.id, branch: "right", headTurnId: right.turn.id }).map(value => value.revision.id))
      .not.toContain(sessionCommit.commit);

    const observer = new Store(dbPath);
    const check88 = () => {
      const path = { sessionId: owner.id, branch: "right", headTurnId: right.turn.id };
      const fresh = observer.commitGraph(path, undefined, undefined, observer.commitGraphInput());
      expect(observer.visibleKnowledgeVersions(path))
        .toEqual(new Set(fresh.current.filter(revision => revision.op !== "archive").map(revision => revision.id)));
      expect(observer.commitGraph(null, undefined, undefined, observer.commitGraphInput(undefined, owner.id)).applicable.has(mixedCommit))
        .toBe(false); // no union of left's Turn with right's bound entry across two complete cursors
    };
    check88();
    store.setCurrentPath(owner.id, "left", root.turn.id, "native-left");
    check88();
    expect(observer.currentKnowledge(null).map(value => value.revision.id)).toEqual([commits[0]!.commit, commits[2]!.commit]);
    store.closeSession(owner.id); store.close();
    const reopened = new Store(dbPath);
    try {
      expect(reopened.db.prepare("SELECT lineage, branch, head_turn_id FROM session_lineage_cursors WHERE session_id = ? ORDER BY lineage").all(owner.id))
        .toEqual([{ lineage: "native-left", branch: "left", head_turn_id: root.turn.id },
          { lineage: "native-right", branch: "right", head_turn_id: right.turn.id }]);
      reopened.reopenSession(owner.id, "cursor-reopen");
      reopened.setCurrentPath(owner.id, "right", root.turn.id, "native-right");
      check88();
      expect(observer.currentKnowledge(null).map(value => value.revision.id)).toEqual([commits[0]!.commit]);
    } finally { observer.close(); reopened.close(); }
    return;
  } finally { store.close(); }
});
