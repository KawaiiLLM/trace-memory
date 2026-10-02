import { afterEach, expect, test } from "vitest";
import { TraceMemory, memoryFiles } from "../../../src/core/api/index.ts";
import { legacyFacts } from "../../support/seed.ts";

const memories: ReturnType<typeof TraceMemory>[] = [];
afterEach(() => { for (const memory of memories.splice(0)) memory.close(); });

function fixture() {
  const memory = TraceMemory(":memory:", async () => ({ outcome: "success", output: "done", request: { offline: true } }));
  memories.push(memory);
  const store = memory.store;
  const project = store.createProject({ name: "relations", declaredBy: "mark" });
  const session = store.createSession({ host: "test", enrollmentChoice: true, projectId: project.id, startedAt: "now", firstReplyAt: "now" });
  const turn = store.appendTurn({ sessionId: session.id, kind: "turn", userPrompt: "branches", startedAt: "now" });
  const append = (nativeId: string) => memory.appendEntry({ sessionId: session.id, turnId: turn.id, nativeLineage: "fixture", nativeId,
    role: "user", text: nativeId, raw: JSON.stringify({ role: "user", content: nativeId }), calls: [] });
  const rootEntry = append("root"), siblingEntry = append("sibling"), thirdEntry = append("third"), fourthEntry = append("fourth");
  memory.selectEntries(session.id, "root", [rootEntry.id]);
  memory.selectEntries(session.id, "sibling", [rootEntry.id, siblingEntry.id, thirdEntry.id, fourthEntry.id]);
  const root = legacyFacts(store, { kind: "manual", sessionId: session.id, branch: "root", createdAt: "now" }, [{
    sources: [{ entry: rootEntry, address: `T${turn.id}#E1` }], category: "observation", actor: "user",
    text: "common fact ".repeat(200), createdAt: "now",
  }]);
  const sibling = legacyFacts(store, { kind: "manual", sessionId: session.id, branch: "sibling", createdAt: "now" }, [{
    sources: [{ entry: siblingEntry, address: `T${turn.id}#E2` }], category: "observation", actor: "user",
    text: "sibling correction", createdAt: "now", negate: [{ target: `F${root.facts[0]!.id}`, strength: "strong" }],
  }]);
  const third = legacyFacts(store, { kind: "manual", sessionId: session.id, branch: "sibling", createdAt: "now" }, [{
    sources: [{ entry: thirdEntry, address: `T${turn.id}#E3` }], category: "observation", actor: "user",
    text: "third sibling fact", createdAt: "now", negate: [{ target: `F${sibling.facts[0]!.id}`, strength: "weak" }],
  }, {
    sources: [{ entry: fourthEntry, address: `T${turn.id}#E4` }], category: "observation", actor: "user",
    text: "fourth sibling fact", createdAt: "now",
  }]);
  return { memory, store, session, turn, root: root.facts[0]!, sibling: sibling.facts[0]!, third: third.facts[0]!, fourth: third.facts[1]!,
    rootPath: { sessionId: session.id, branch: "root", headTurnId: turn.id },
    siblingPath: { sessionId: session.id, branch: "sibling", headTurnId: turn.id } };
}

test("47: path-bound relations require both endpoints while an exact Fact read remains unrestricted", () => {
  const f = fixture();
  expect(f.store.listFactRelations(f.root.id)).toHaveLength(1);
  expect(f.store.listFactRelationsOnPath(f.root.id, f.rootPath)).toEqual([]);
  expect(f.store.listFactRelationsOnPath(f.root.id, f.siblingPath)).toHaveLength(1);

  // Named node views prefer this session's selected branch under ruling 8.
  f.store.setCurrentPath(f.session.id, "root", f.turn.id, "test-lineage");
  const rootFiles = memoryFiles(f.memory, f.rootPath);
  const collection = rootFiles.read(`/tm/facts/S${f.session.id}/T${f.turn.id}`).content;
  expect(collection).toContain(`[F${f.root.id}]`);
  expect(collection).not.toContain(`[F${f.sibling.id}]`);
  expect(collection).not.toContain(`inbound negate F${f.sibling.id}`);
  const targetApplicable = rootFiles.read(`/tm/F${f.root.id}`).content;
  expect(targetApplicable).toContain(`inbound negate F${f.sibling.id} strong`);
  expect(targetApplicable).toContain(`other endpoints not applicable on this path: F${f.sibling.id}`);

  const targetInapplicable = rootFiles.read(`/tm/F${f.sibling.id}`).content;
  expect(targetInapplicable).toContain(`negate F${f.root.id} strong`);
  expect(targetInapplicable).toContain(`inbound negate F${f.third.id} weak`);
  expect(targetInapplicable).toContain(`other endpoints not applicable on this path: F${f.third.id}`);
  expect(targetInapplicable).not.toContain(`other endpoints not applicable on this path: F${f.root.id}`);

  f.store.setCurrentPath(f.session.id, "sibling", f.turn.id, "test-lineage");
  const siblingFiles = memoryFiles(f.memory, f.siblingPath);
  expect(siblingFiles.read(`/tm/facts/S${f.session.id}/T${f.turn.id}`).content).toContain(`inbound negate F${f.sibling.id} strong`);
  const bothApplicable = siblingFiles.read(`/tm/F${f.sibling.id}`).content;
  expect(bothApplicable).not.toContain("other endpoints not applicable on this path");
});

test("47: exact Fact reads reflect current endpoint applicability", () => {
  const f = fixture();
  const path = `/tm/F${f.root.id}`;
  const read = () => memoryFiles(f.memory, f.rootPath).read(path).content;
  expect(read()).not.toContain(`support F${f.fourth.id}`);
  f.store.db.prepare("INSERT INTO fact_relations(from_fact,to_fact,kind,strength) VALUES (?,?,?,?)")
    .run(f.fourth.id, f.root.id, "support", "weak");
  expect(read()).toContain(`F${f.fourth.id}`);
});

test("47: compact rendering does not leak a sibling relation into the rewind path", () => {
  const f = fixture();
  const root = f.memory.compact(f.session.id, "root", f.turn.id);
  if ("native" in root) throw new Error(root.reason);
  expect(root.text).toContain("common fact");
  expect(root.text).not.toContain(`inbound negate F${f.sibling.id}`);
  const sibling = f.memory.compact(f.session.id, "sibling", f.turn.id);
  if ("native" in sibling) throw new Error(sibling.reason);
  expect(sibling.text).toContain(`inbound negate F${f.sibling.id} strong`);
});
