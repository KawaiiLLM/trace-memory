import { afterEach, expect, test } from "vitest";
import { TraceMemory } from "../../../src/core/api/index.ts";
import { drainTrace, wholeTrace } from "../../trace-pages.ts";
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

  const rootTools = f.memory.tools({ kind: "manual", sessionId: f.session.id, branch: "root", currentTurnId: f.turn.id });
  const trace = rootTools.find(tool => tool.name === "trace")!;
  // 93 makes a bare Turn the fact view; 47's endpoint applicability rule still holds.
  const collection = trace.execute({ address: `T${f.turn.id}`, itemBudget: null });
  expect(collection).toContain(`[F${f.root.id}]`);
  expect(collection).not.toContain(`[F${f.sibling.id}]`);
  expect(collection).not.toContain(`inbound negate F${f.sibling.id}`);
  const targetApplicable = trace.execute({ address: `F${f.root.id}`, itemBudget: null });
  expect(targetApplicable).toContain(`inbound negate F${f.sibling.id} strong`);
  expect(targetApplicable).toContain(`other endpoints not applicable on this path: F${f.sibling.id}`);

  const targetInapplicable = trace.execute({ address: `F${f.sibling.id}`, itemBudget: null });
  expect(targetInapplicable).toContain(`negate F${f.root.id} strong`);
  expect(targetInapplicable).toContain(`inbound negate F${f.third.id} weak`);
  expect(targetInapplicable).toContain(`other endpoints not applicable on this path: F${f.third.id}`);
  expect(targetInapplicable).not.toContain(`other endpoints not applicable on this path: F${f.root.id}`);

  const siblingTools = f.memory.tools({ kind: "manual", sessionId: f.session.id, branch: "sibling", currentTurnId: f.turn.id });
  expect(siblingTools.find(tool => tool.name === "trace")!.execute({ address: `T${f.turn.id}`, itemBudget: null }))
    .toContain(`inbound negate F${f.sibling.id} strong`);
  const bothApplicable = siblingTools.find(tool => tool.name === "trace")!.execute({ address: `F${f.sibling.id}`, itemBudget: null });
  expect(bothApplicable).not.toContain("other endpoints not applicable on this path");
});

test("47: exact Fact pagination freezes endpoint applicability until cursor completion", () => {
  const f = fixture();
  const options = { ...f.rootPath, itemBudget: null, maxTokens: 100 };
  const expected = wholeTrace(f.memory, `F${f.root.id}`, { ...options, maxTokens: 8_000 });
  const first = f.memory.trace(`F${f.root.id}`, options);
  let inserted = false;
  const drained = drainTrace(f.memory, first, options, () => {
    if (inserted) return;
    inserted = true;
    f.store.db.prepare("INSERT INTO fact_relations(from_fact,to_fact,kind,strength) VALUES (?,?,?,?)")
      .run(f.fourth.id, f.root.id, "support", "weak");
  });
  expect(drained.pages).toBeGreaterThan(1);
  expect(drained.joined).toBe(expected);
  expect(drained.joined).not.toContain(`F${f.fourth.id}`);
  expect(wholeTrace(f.memory, `F${f.root.id}`, { ...options, maxTokens: 8_000 })).toContain(`F${f.fourth.id}`);
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
