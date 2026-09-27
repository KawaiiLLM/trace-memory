// 97: foreground Knowledge delivery is recorded per node and folded along the node's path.
import { afterEach, expect, test } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Store } from "../../../src/core/store/index.ts";
import { entry, knowledgeBatch, legacyFacts, session } from "../../support/seed.ts";

const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });
const at = "2026-09-28T00:00:00.000Z";

/** One session with a tree of Turns (T1 → T2, T1 → T3) and three global knowledge versions. */
function fixture() {
  const dir = mkdtempSync(join(tmpdir(), "tm97-deliveries-")); dirs.push(dir);
  const path = join(dir, "trace.db"), store = new Store(path);
  const project = store.createProject({ name: "p", declaredBy: "mark" });
  const owner = "cc:native";
  const s = session(store, project.id, owner);
  const turn = (parentTurnId: number | null, text: string) => store.appendTurn({ sessionId: s.id, parentTurnId, kind: "turn", userPrompt: text, startedAt: at });
  const t1 = turn(null, "one"), t2 = turn(t1.id, "two"), t3 = turn(t1.id, "three");
  const source = entry(store, s.id, t1.id, "u1", "user", "rule");
  const fact = legacyFacts(store, { kind: "manual", sessionId: s.id, createdAt: at },
    [{ sources: [{ entry: source, address: `T${t1.id}#E${source.entryOrdinal}` }], text: "rule", category: "decision", actor: "user", createdAt: at }]).facts[0]!;
  const versions = knowledgeBatch(store, { sessionId: s.id, headTurnId: t1.id }, ["K one", "K two", "K three"].map(text =>
    ({ scope: "global" as const, category: "constraint" as const, supports: [fact.id], text })), { kind: "manual", createdAt: at })
    .committed.map(item => item.commit);
  const part = (commits: number[], tokens: number, states: string[] = []) => ({ knowledgeCommitIds: commits, knowledgeStates: states, knowledgeTokens: tokens });
  const at_ = (headTurnId: number | null, pending: { key: string | null; compaction?: boolean }[] = []) =>
    store.deliveredKnowledge({ owner, sessionId: s.id, headTurnId, pending });
  const compaction = (parentTurnId: number) => store.appendTurn({ sessionId: s.id, parentTurnId, kind: "compaction", startedAt: at, endedAt: at });
  return { dir, path, store, owner, sessionId: s.id, t1, t2, t3, versions, part, at: at_, turn, compaction };
}

test("97 a node's delivered state is its lineage's records; a sibling's are not inherited", () => {
  const f = fixture();
  try {
    const [a, b, c] = f.versions as [number, number, number];
    f.store.recordKnowledgeDelivery({ owner: f.owner }, [f.part([a], 5)]); // the root, before any Turn
    f.store.recordKnowledgeDelivery({ owner: f.owner, turnId: f.t2.id }, [f.part([b], 7)]);
    f.store.recordKnowledgeDelivery({ owner: f.owner, turnId: f.t3.id }, [f.part([c], 11)]);
    expect(f.at(f.t2.id)).toEqual({ knowledgeCommitIds: new Set([a, b]), knowledgeStates: new Set(), knowledgeTokens: 12 });
    expect(f.at(f.t3.id)).toEqual({ knowledgeCommitIds: new Set([a, c]), knowledgeStates: new Set(), knowledgeTokens: 16 });
    expect(f.at(f.t1.id).knowledgeCommitIds).toEqual(new Set([a]));
    // Another context's records are never this one's.
    expect(f.store.deliveredKnowledge({ owner: "cc:other", sessionId: null, headTurnId: null }).knowledgeTokens).toBe(0);
  } finally { f.store.close(); }
});

test("97 a prompt's delivery belongs to the Turn that prompt creates, or to the pending path before its import", () => {
  const f = fixture();
  try {
    const [a] = f.versions as [number];
    f.store.recordKnowledgeDelivery({ owner: f.owner, nodeKey: "p2" }, [f.part([a], 3)]);
    expect(f.at(f.t1.id).knowledgeCommitIds.size).toBe(0); // not yet on any path
    expect(f.at(f.t1.id, [{ key: "p2" }]).knowledgeCommitIds).toEqual(new Set([a])); // the prompt the transcript tail shows
    f.store.bindDeliveryNode("p2", f.sessionId, f.t2.id);
    expect(f.at(f.t2.id).knowledgeCommitIds).toEqual(new Set([a]));
    expect(f.at(f.t3.id).knowledgeCommitIds.size).toBe(0); // a re-edit of that prompt is a sibling
    f.store.bindDeliveryNode("p2", f.sessionId, f.t3.id); // the first binding stands
    expect(f.at(f.t3.id).knowledgeCommitIds.size).toBe(0);
    expect(() => f.store.bindDeliveryNode("p9", f.sessionId + 1, f.t2.id)).toThrow("is not in session");
  } finally { f.store.close(); }
});

test("97 a compaction node starts from its own supplement: versions, notices and cost restart together", () => {
  const f = fixture();
  try {
    const [a, b, c] = f.versions as [number, number, number];
    f.store.recordKnowledgeDelivery({ owner: f.owner, turnId: f.t2.id }, [f.part([a], 5, [`${a}>${b}`])]);
    const compacted = f.compaction(f.t2.id), after = f.turn(compacted.id, "after");
    f.store.recordKnowledgeDelivery({ owner: f.owner, turnId: compacted.id }, [f.part([b], 20), f.part([c], 30)]);
    f.store.recordKnowledgeDelivery({ owner: f.owner, turnId: after.id }, [f.part([], 4, [`${b}>${c}`])]);
    expect(f.at(after.id)).toEqual({ knowledgeCommitIds: new Set([b, c]), knowledgeStates: new Set([`${b}>${c}`]), knowledgeTokens: 54 });
    // The node before the compaction keeps its own state; a compaction with no supplement starts empty.
    expect(f.at(f.t2.id)).toEqual({ knowledgeCommitIds: new Set([a]), knowledgeStates: new Set([`${a}>${b}`]), knowledgeTokens: 5 });
    expect(f.at(f.compaction(after.id).id)).toEqual({ knowledgeCommitIds: new Set(), knowledgeStates: new Set(), knowledgeTokens: 0 });
  } finally { f.store.close(); }
});

test("97 a compaction's supplement waits under its key until the import binds it; only the path past the boundary sees it", () => {
  const f = fixture();
  try {
    const [a, b] = f.versions as [number, number];
    f.store.recordKnowledgeDelivery({ owner: f.owner, turnId: f.t2.id }, [f.part([a], 5)]);
    f.store.recordKnowledgeDelivery({ owner: f.owner, nodeKey: "k-old", follows: "leaf-2" }, [f.part([a], 1)]);
    f.store.bindDeliveryNode("k-old", f.sessionId, f.compaction(f.t3.id).id); // an earlier compaction elsewhere
    f.store.recordKnowledgeDelivery({ owner: f.owner, nodeKey: "k1", follows: "leaf-2" }, [f.part([b], 9)]);
    f.store.recordKnowledgeDelivery({ owner: f.owner, nodeKey: "k2", follows: "leaf-2" }, [f.part([a], 2)]);
    expect(f.store.compactionDeliveryKey(f.owner, "leaf-2")).toBe("k1"); // the oldest unbound
    expect(f.store.compactionDeliveryKey("cc:other", "leaf-2")).toBeNull();
    expect(f.at(f.t2.id)).toEqual({ knowledgeCommitIds: new Set([a]), knowledgeStates: new Set(), knowledgeTokens: 5 });
    expect(f.at(f.t2.id, [{ key: "k1", compaction: true }])).toEqual({ knowledgeCommitIds: new Set([b]), knowledgeStates: new Set(), knowledgeTokens: 9 });
    expect(f.at(f.t2.id, [{ key: null, compaction: true }]).knowledgeTokens).toBe(0);
    const compacted = f.compaction(f.t2.id);
    f.store.bindDeliveryNode("k1", f.sessionId, compacted.id);
    expect(f.at(compacted.id)).toEqual({ knowledgeCommitIds: new Set([b]), knowledgeStates: new Set(), knowledgeTokens: 9 });
    expect(f.at(f.t2.id).knowledgeTokens).toBe(5);
    expect(f.store.compactionDeliveryKey(f.owner, "leaf-2")).toBe("k2");
    expect(() => f.store.recordKnowledgeDelivery({ owner: f.owner, follows: "leaf-2" }, [f.part([a], 1)])).toThrow("needs its key");
  } finally { f.store.close(); }
});

test("97 notices are a set; cost is summed per delivery, never deduplicated by version", () => {
  const f = fixture();
  try {
    const [a, b] = f.versions as [number, number];
    f.store.recordKnowledgeDelivery({ owner: f.owner, turnId: f.t1.id }, [f.part([a], 9, [`${a}>${b}`])]);
    f.store.recordKnowledgeDelivery({ owner: f.owner, turnId: f.t2.id }, [f.part([a], 9, [`${a}>${b}`])]);
    expect(f.at(f.t2.id)).toEqual({ knowledgeCommitIds: new Set([a]), knowledgeStates: new Set([`${a}>${b}`]), knowledgeTokens: 18 });
    // Empty parts are not rows.
    expect(f.store.recordKnowledgeDelivery({ owner: f.owner, turnId: f.t2.id }, [f.part([], 0)])).toEqual([]);
  } finally { f.store.close(); }
});

test("97 a record names only this context's Turns, existing versions and canonical notices", () => {
  const f = fixture();
  try {
    const [a] = f.versions as [number];
    expect(() => f.store.recordKnowledgeDelivery({ owner: "cc:other", turnId: f.t1.id }, [f.part([a], 1)])).toThrow("does not belong");
    expect(() => f.store.recordKnowledgeDelivery({ owner: f.owner, turnId: f.t1.id }, [f.part([999], 1)])).toThrow("unknown knowledge version");
    expect(() => f.store.recordKnowledgeDelivery({ owner: f.owner }, [f.part([a], 1, ["garbled"])])).toThrow("invalid delivery part");
    expect(() => f.store.recordKnowledgeDelivery({ owner: f.owner, turnId: f.t1.id, nodeKey: "p" }, [f.part([a], 1)])).toThrow("not both");
    expect(() => f.at(f.t1.id) && f.store.deliveredKnowledge({ owner: "cc:other", sessionId: f.sessionId, headTurnId: f.t1.id })).toThrow("does not own");
    expect(f.store.db.prepare("SELECT COUNT(*) AS n FROM knowledge_deliveries").get()).toEqual({ n: 0 });
  } finally { f.store.close(); }
});

test("97 another connection's records and bindings reach a warm reader's cached nodes; a restart reads the same state", () => {
  const f = fixture();
  const other = new Store(f.path);
  try {
    const [a, b, c] = f.versions as [number, number, number];
    const compacted = f.compaction(f.t2.id), after = f.turn(compacted.id, "after");
    f.store.recordKnowledgeDelivery({ owner: f.owner, turnId: f.t1.id }, [f.part([a], 2)]);
    expect(f.at(f.t2.id).knowledgeCommitIds).toEqual(new Set([a])); // caches T1 and T2
    expect(f.at(after.id).knowledgeTokens).toBe(0); // and the compaction and the Turn after it
    other.recordKnowledgeDelivery({ owner: f.owner, nodeKey: "p2" }, [f.part([b], 3)]);
    expect(f.at(f.t2.id).knowledgeCommitIds).toEqual(new Set([a]));
    other.bindDeliveryNode("p2", f.sessionId, f.t2.id);
    expect(f.at(f.t2.id)).toEqual({ knowledgeCommitIds: new Set([a, b]), knowledgeStates: new Set(), knowledgeTokens: 5 });
    // A row at an ancestor reaches its cached descendants, but not past a compaction.
    other.recordKnowledgeDelivery({ owner: f.owner, turnId: f.t1.id }, [f.part([c], 7)]);
    expect(f.at(f.t2.id).knowledgeTokens).toBe(12);
    expect(f.at(after.id).knowledgeTokens).toBe(0);
    other.recordKnowledgeDelivery({ owner: f.owner, turnId: compacted.id }, [f.part([c], 1)]);
    expect(f.at(after.id)).toEqual({ knowledgeCommitIds: new Set([c]), knowledgeStates: new Set(), knowledgeTokens: 1 });
    f.store.close();
    const restarted = new Store(f.path);
    try { expect(restarted.deliveredKnowledge({ owner: f.owner, sessionId: f.sessionId, headTurnId: f.t2.id }).knowledgeTokens).toBe(12); }
    finally { restarted.close(); }
  } finally { other.close(); if (!f.store.closed) f.store.close(); }
});

test("97 migration adds the delivery tables to an existing database without touching its rows", () => {
  const f = fixture();
  const turns = f.store.db.prepare("SELECT COUNT(*) AS n FROM turns").get();
  f.store.db.exec("DROP TABLE knowledge_deliveries; DROP TABLE delivery_nodes");
  f.store.close();
  const reopened = new Store(f.path);
  try {
    expect(reopened.db.prepare("SELECT COUNT(*) AS n FROM turns").get()).toEqual(turns);
    expect(reopened.db.prepare("SELECT COUNT(*) AS n FROM knowledge_deliveries").get()).toEqual({ n: 0 });
    expect(reopened.deliveredKnowledge({ owner: f.owner, sessionId: f.sessionId, headTurnId: f.t2.id }).knowledgeTokens).toBe(0);
  } finally { reopened.close(); }
});
