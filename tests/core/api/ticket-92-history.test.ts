import { commitNoterKnowledge } from "../../noting-knowledge-fixture.ts";
import { expect, test } from "vitest";
import { sourceSeededMemory } from "../../source-fixture.ts";
import type { KnowledgePath, KnowledgeOperationInput } from "../../../src/core/store/index.ts";

test("92/03: branch history owns stable ordinals, membership/status follows the reader, and exact reads grant no write scope", () => {
  const memory = sourceSeededMemory(":memory:", async () => ({ outcome: "failure" as const, output: "unused" }));
  const store = memory.store;
  try {
    const project = store.createProject({ name: "history", declaredBy: "mark" });
    const session = store.createSession({ projectId: project.id, host: "pi:history", startedAt: "now", firstReplyAt: "now", enrollmentChoice: true });
    const root = store.appendTurn({ sessionId: session.id, parentTurnId: null, kind: "turn", userPrompt: "root", startedAt: "now" });
    const left = store.appendTurn({ sessionId: session.id, parentTurnId: root.id, kind: "turn", userPrompt: "left", startedAt: "now" });
    const right = store.appendTurn({ sessionId: session.id, parentTurnId: root.id, kind: "turn", userPrompt: "right", startedAt: "now" });
    const entries = store.listSourceEntries(session.id);
    const rootEntry = entries.find(e => e.turnId === root.id)!, leftEntry = entries.find(e => e.turnId === left.id)!, rightEntry = entries.find(e => e.turnId === right.id)!;
    type Path = KnowledgePath & { branch: string; headTurnId: number };
    const paths = [root, left, right].map((turn, index): Path => ({ sessionId: session.id, branch: ["root", "left", "right"][index]!, headTurnId: turn.id }));
    store.selectSourcePath(session.id, "root", [rootEntry.id]);
    store.selectSourcePath(session.id, "left", [rootEntry.id, leftEntry.id]);
    store.selectSourcePath(session.id, "right", [rootEntry.id, rightEntry.id]);
    const activate = (path: Path) => store.setCurrentPath(session.id, path.branch, path.headTurnId, "foreground");
    const facts = paths.map(path => {
      activate(path);
      const note = memory.tools({ kind: "manual", sessionId: session.id, branch: path.branch, currentTurnId: path.headTurnId! }).find(t => t.name === "note")!;
      const result = JSON.parse(note.execute({ facts: [{ text: `Evidence ${path.branch}`, source: [`T${path.headTurnId}#E1`] }] }));
      expect(result.factIds).toHaveLength(1);
      return result.factIds[0] as number;
    });
    const write = (path: Path, operations: KnowledgeOperationInput[]) => {
      activate(path);
      const result = commitNoterKnowledge(store, { path, run: { sessionId: session.id, branch: path.branch, createdAt: "now" }, operations });
      if (!result.ok) throw new Error(result.problems.join("; "));
      return result.committed[0]!;
    };
    const content = { category: "constraint" as const, scope: "session" as const, topics: [], reason: "history", createdAt: "now" };
    const initial = write(paths[0]!, [{ op: "create", handle: "$1", author: "test", ...content, text: "Initial body", supports: [facts[0]!] }]);
    const first = write(paths[1]!, [{ op: "update", knowledgeId: initial.knowledgeId, baseCommit: initial.commit, ...content, text: "Left body", supports: [facts[1]!] }]);
    const second = write(paths[2]!, [{ op: "update", knowledgeId: initial.knowledgeId, baseCommit: initial.commit, ...content, text: "Right body", supports: [facts[2]!] }]);
    const id = initial.knowledgeId;
    const read = (path: Path, address: string, versions = "current") => {
      activate(path);
      return memory.tools({ kind: "manual", sessionId: session.id, branch: path.branch, currentTurnId: path.headTurnId! })
        .find(t => t.name === "trace")!.execute({ address, versions, itemBudget: null, pageBudget: 8000 });
    };
    expect([initial, first, second].map(value => store.versionOrdinal(id, value.commit))).toEqual([1, 2, 3]);
    const current = read(paths[1]!, `K${id}`);
    expect(current).toContain(`[K${id}@v2]`);
    expect(current).toContain("Left body");
    expect(current).not.toContain("Right body");
    expect(current).not.toContain("Initial body");
    const history = read(paths[1]!, `K${id}`, "history");
    expect(history).toContain(`[K${id}@v1]`);
    expect(history).toContain(`[K${id}@v2]`);
    expect(history).not.toContain("Right body");
    expect(history).toContain("superseded");
    const all = read(paths[1]!, `K${id}..`);
    expect(all).toContain(`[K${id}@v3]`);
    expect(all).toContain("another branch");
    expect(all).not.toMatch(/K\d+@\d+/);
    expect(read(paths[2]!, `K${id}`)).toContain(`[K${id}@v3]`);
    expect(store.versionOrdinal(id, first.commit)).toBe(2);
    const archive = write(paths[2]!, [{ op: "archive", knowledgeId: id, baseCommit: second.commit, supports: [facts[2]!], reason: "retired", createdAt: "now" }]);
    expect(read(paths[2]!, `K${id}`, "history")).toContain("archived");
    expect(store.versionOrdinal(id, archive.commit)).toBe(4);

    const foreignProject = store.createProject({ name: "foreign", declaredBy: "mark" });
    const foreign = store.createSession({ projectId: foreignProject.id, host: "pi:foreign", startedAt: "now", firstReplyAt: "now", enrollmentChoice: true });
    const foreignTurn = store.appendTurn({ sessionId: foreign.id, kind: "turn", userPrompt: "outside", startedAt: "now" });
    const tools = memory.tools({ kind: "manual", sessionId: foreign.id, branch: "main", currentTurnId: foreignTurn.id });
    const fact = JSON.parse(tools.find(t => t.name === "note")!.execute({ facts: [{ text: "Outside evidence", source: [`T${foreignTurn.id}#E1`] }] })).factIds[0];
    expect(tools.find(t => t.name === "trace")!.execute({ address: `K${id}@v2` })).toContain("Left body");
    const rejected = tools.find(t => t.name === "memory")!.execute({ operations: [{ op: "archive", id: `K${id}#${store.versionTag(id, first.commit)}`, supports: [`F${fact}`], reason: "outside" }], skipped: [] });
    expect(rejected).toContain("rejected:");
    expect(rejected).not.toMatch(/K\d+@\d+/);
    expect(rejected).not.toContain(`K${id}@v4`);
  } finally { memory.close(); }
});
