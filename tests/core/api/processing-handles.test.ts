import { afterEach, expect, test } from "vitest";
import { TraceMemory } from "../../../src/core/api/index.ts";
import { seedSourceEntry } from "../../source-fixture.ts";
import { AdmittedDreamerScenarios, createDreamerTrigger } from "../../admitted-dreamer-scenario.ts";

const all: ReturnType<typeof TraceMemory>[] = [];
afterEach(() => { for (const m of all.splice(0)) m.close(); });
function setup(second = false) {
  const scenarios = new AdmittedDreamerScenarios(async () => ({ outcome: "success", output: "unused", request: {} }));
  const m = TraceMemory(":memory:", scenarios.agent); all.push(m);
  const p = m.store.createProject({ name: "A", declaredBy: "mark" });
  const s = m.store.createSession({ host: "pi:handles", projectId: p.id, enrollmentChoice: true, startedAt: "now", firstReplyAt: "now" });
  const t = m.store.appendTurn({ sessionId: s.id, kind: "turn", userPrompt: "facts", startedAt: "now" });
  seedSourceEntry(m, t.id, "user", "facts");
  const rootEntry = m.store.listSourceEntries(s.id, t.id).at(-1)!;
  m.selectEntries(s.id, "main", [rootEntry.id]);
  const context = { kind: "manual" as const, sessionId: s.id, currentTurnId: t.id, branch: "main", triggerEntryId: rootEntry.id };
  const tools = m.tools(context);
  expect(tools[2]!.execute({ facts: [{ text: "facts", source: [`T${t.id}#E1`] }] })).not.toContain("rejected:");
  const content = { text: "body A", category: "constraint", scope: "project", topics: [], supports: ["F1"], reason: "test" };
  const write = (operations: unknown[], binding = tools) => binding[3]!.execute({ operations, skipped: [] });
  expect(write([{ op: "create", ...content }])).not.toContain("rejected:");
  if (second) expect(write([{ op: "create", ...content, text: "second" }])).not.toContain("rejected:");
  const tag = (id: number, ordinal = 1) => `K${id}#${m.store.versionTag(id, m.store.resolveVersionOrdinal(id, ordinal))}`;
  return { m, context, scenarios, path: { sessionId: s.id, branch: "main", headTurnId: t.id, triggerEntryId: rootEntry.id }, content, tools, write, t, rootEntry, tag };
}

test("92 supersedes 32: mutations require exact tags, not bare identities or human commit addresses", async () => {
  const a = setup(), trigger = createDreamerTrigger(a.m, a.path, 1, 1);
  const result = await a.scenarios.run(a.m, a.path, input => {
    const request = { fixture: "exact maintenance address" }; input.reportRequest(request);
    const write = input.tools.find(t => t.name === "memory")!;
    for (const op of ["update", "archive"]) for (const id of ["K1", "K1@1", "K1@v1"]) {
      const value = op === "archive" ? { supports: ["F1"], reason: "retire" } : a.content;
      expect(write.execute({ operations: [{ op, id, ...value }], skipped: [] })).toContain("supply an exact K#tag version");
    }
    const updated = JSON.parse(write.execute({ operations: [{ op: "update", id: a.tag(1), ...a.content },
      { op: "archive", id: a.tag(trigger.knowledgeId), supports: ["F1"], reason: "Retire fixture trigger" }], skipped: [] }));
    expect(updated.committed).toHaveLength(2);
    expect(updated.committed[0].version).toBe("K1@v2");
    return { outcome: "success", output: "corrected", request };
  });
  expect(result.outcome, JSON.stringify(result)).toBe("success");
});

test("92: previews carry no tag; a valid tag works across bindings without a read ledger", () => {
  const a = setup(true);
  const preview = a.tools[1]!.execute({ query: "body", layer: "knowledge" });
  expect(preview).toContain("K1@v1");
  expect(preview).not.toContain(a.tag(1));
  const archive = (id: string) => a.write([{ op: "archive", id, supports: ["F1"], reason: "Retire tagged item" }], a.m.tools(a.context));
  expect(archive("K1")).toContain("supply an exact K#tag");
  expect(archive("K1#unknown")).toContain("knowledge version does not exist");
  expect(a.m.store.currentCommit(1)[0]!.op).toBe("create");
  // No trace call: possessing the correct version metadata is enough, subject to authority.
  expect(archive(a.tag(1))).toContain("committed");
  expect(archive(a.tag(2))).toContain("committed");
});

test("92: ABA keeps different tags and archive invalidates old bases without substitution", async () => {
  const a = setup(), trigger = createDreamerTrigger(a.m, a.path, 1, 1);
  const result = await a.scenarios.run(a.m, a.path, input => {
    const request = { fixture: "ABA tags" }; input.reportRequest(request);
    const write = input.tools.find(t => t.name === "memory")!;
    const original = a.tag(1);
    expect(write.execute({ operations: [{ op: "update", id: original, ...a.content, text: "body B" }], skipped: [] })).toContain("committed");
    const middle = a.tag(1, 2);
    expect(write.execute({ operations: [{ op: "update", id: middle, ...a.content }], skipped: [] })).toContain("committed");
    const restored = a.tag(1, 3);
    expect(new Set([original, middle, restored]).size).toBe(3);
    expect(write.execute({ operations: [{ op: "update", id: original, ...a.content }], skipped: [] })).toContain("current: K1@v3");
    expect(write.execute({ operations: [{ op: "archive", id: restored, supports: ["F1"], reason: "retired" }], skipped: [] })).toContain("committed");
    expect(write.execute({ operations: [{ op: "update", id: restored, ...a.content }], skipped: [] })).toContain("current: K1@v4");
    expect(write.execute({ operations: [{ op: "archive", id: a.tag(trigger.knowledgeId), supports: ["F1"], reason: "Retire fixture trigger" }], skipped: [] })).toContain("committed");
    return { outcome: "success", output: "ABA checked", request };
  });
  expect(result.outcome, JSON.stringify(result)).toBe("success");
});

test("92: every merge participant is tagged and current; one bad base rolls back the entire batch", async () => {
  const a = setup(true), trigger = createDreamerTrigger(a.m, a.path, 1, 1);
  const result = await a.scenarios.run(a.m, a.path, input => {
    const request = { fixture: "merge tagged participants" }; input.reportRequest(request);
    const write = input.tools.find(t => t.name === "memory")!;
    expect(write.execute({ operations: [{ op: "update", id: a.tag(2), ...a.content, text: "later merge parent" }], skipped: [] })).toContain("committed");
    const merge = { op: "merge", id: a.tag(1), absorb: [a.tag(2, 2)], ...a.content };
    const archive = { op: "archive", id: a.tag(trigger.knowledgeId), supports: ["F1"], reason: "Retire fixture trigger" };
    expect(write.execute({ operations: [archive, { ...merge, absorb: [a.tag(2)] }], skipped: [] })).toContain("current: K2@v2");
    expect(a.m.store.currentCommit(trigger.knowledgeId)[0]!.op).toBe("create");
    expect(a.m.store.currentCommit(1)[0]!.op).toBe("create");
    expect(write.execute({ operations: [{ ...merge, absorb: ["K2"] }], skipped: [] })).toContain("supply an exact K#tag");
    expect(JSON.parse(write.execute({ operations: [merge, archive], skipped: [] })).committed).toHaveLength(2);
    return { outcome: "success", output: "merged", request };
  });
  expect(result.outcome, JSON.stringify(result)).toBe("success");
});

test("manual writers freeze fact sources and knowledge supports at the exact trigger prefix", () => {
  const a = setup();
  seedSourceEntry(a.m, a.t.id, "assistant", "carrier");
  const carrier = a.m.store.listSourceEntries(1, a.t.id).at(-1)!;
  seedSourceEntry(a.m, a.t.id, "assistant", "later evidence");
  const later = a.m.store.listSourceEntries(1, a.t.id).at(-1)!;
  a.m.selectEntries(1, "main", [a.rootEntry.id, carrier.id, later.id]);
  const lateTools = a.m.tools({ ...a.context, triggerEntryId: later.id, entryIds: [a.rootEntry.id, carrier.id, later.id] });
  expect(lateTools[2]!.execute({ facts: [{ text: "later", source: [`T${a.t.id}#E${later.entryOrdinal}`] }] })).not.toContain("rejected:");
  const earlyTools = a.m.tools({ ...a.context, triggerEntryId: carrier.id, entryIds: [a.rootEntry.id, carrier.id] });
  expect(earlyTools[2]!.execute({ facts: [{ text: "too late", source: [`T${a.t.id}#E${later.entryOrdinal}`] }] })).toContain("invalid source");
  expect(earlyTools[3]!.execute({ operations: [{ op: "create", ...a.content, supports: ["F2"] }], skipped: [] })).toContain("after the exact triggering source prefix");
});

test("92 supersedes named-read grants: copied Raw tags do not prove reading, but still identify the exact version", () => {
  const a = setup();
  const tagged = a.tools[0]!.execute({ address: "K1@v1", itemBudget: null });
  expect(tagged).toContain(a.tag(1));
  a.m.store.updateTurn(a.t.id, { assistantText: tagged });
  seedSourceEntry(a.m, a.t.id, "assistant", tagged);
  a.m.selectEntries(1, "main", a.m.store.listSourceEntries(1, a.t.id).map(entry => entry.id));
  const fresh = a.m.tools(a.context);
  expect(fresh[0]!.execute({ address: `T${a.t.id}` })).toContain(a.tag(1));
  const archive = (id: string) => a.write([{ op: "archive", id, supports: ["F1"], reason: "Retire exact tagged version" }], fresh);
  expect(archive("K1#unknown")).toContain("knowledge version does not exist");
  expect(a.m.store.currentCommit(1)[0]!.op).toBe("create");
  expect(archive(a.tag(1))).toContain("committed");
});
