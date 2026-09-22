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
  const s = m.store.createSession({ host: "test", projectId: p.id, enrollmentChoice: true, startedAt: "now", firstReplyAt: "now" });
  const t = m.store.appendTurn({ sessionId: s.id, kind: "turn", userPrompt: "facts", startedAt: "now" });
  seedSourceEntry(m, t.id, "user", "facts");
  const rootEntry = m.store.listSourceEntries(s.id, t.id).at(-1)!;
  m.selectEntries(s.id, "main", [rootEntry.id]);
  const context = { kind: "manual" as const, sessionId: s.id, currentTurnId: t.id, branch: "main", triggerEntryId: rootEntry.id };
  const tools = m.tools(context);
  tools[2]!.execute({ facts: [{ category: "decision", actor: "user", text: "facts", source: [`T${t.id}#user`] }] });
  const content = { text: "body A", category: "constraint", scope: "project", topics: [], supports: ["F1"], reason: "test" };
  const write = (operations: unknown[], binding = tools) => binding[3]!.execute({ operations, skipped: [] });
  expect(write([{ op: "create", ...content }])).not.toContain("rejected:");
  if (second) expect(write([{ op: "create", ...content, text: "second" }])).not.toContain("rejected:");
  return { m, context, scenarios, path: { sessionId: s.id, branch: "main", headTurnId: t.id, triggerEntryId: rootEntry.id }, content, create: write, tools, write, t, rootEntry };
}

test("32: update and archive name an exact version — a bare K is refused", async () => {
  const a = setup();
  const trigger = createDreamerTrigger(a.m, a.path, 1, 1);
  const result = await a.scenarios.run(a.m, a.path, input => {
    const request = { fixture: "exact maintenance address", trigger }; input.reportRequest(request);
    const trace = input.tools[0]!, write = input.tools[3]!;
    expect(trace.execute({ address: "K1@1", itemBudget: null })).toContain("body A");
    for (const op of ["update", "archive"]) {
      const value = op === "archive" ? { supports: ["F1"], reason: "retire" } : a.content;
      expect(write.execute({ operations: [{ op, id: "K1", ...value }], skipped: [] })).toMatch(/exact read K@commit.*current tips: K1@1/);
    }
    const updated = JSON.parse(write.execute({ operations: [{ op: "update", id: "K1@1", ...a.content }],
      skipped: [{ knowledge: `K${trigger.knowledgeId}@${trigger.commit}`, because: "The explicit trigger is retired after the exact-address assertion." }] }));
    expect(updated.committed).toHaveLength(1);
    trace.execute({ address: `K${trigger.knowledgeId}@${trigger.commit}`, itemBudget: null });
    expect(write.execute({ operations: [{ op: "archive", id: `K${trigger.knowledgeId}@${trigger.commit}`, supports: ["F1"], reason: "Retire the explicit fixture trigger." }], skipped: [] })).toContain("committed");
    return { outcome: "success", output: "corrected", request };
  });
  expect(result.outcome).toBe("success");
});

test("32: candidate pool, receipt and search preview do not grant a read; complete trace persists across bindings", () => {
  const a = setup(true);
  const archive = (id: string, binding = a.tools) => binding[3]!.execute({ operations: [{ op: "archive", id,
    supports: ["F1"], reason: "Retire after the exact-read ledger assertion." }], skipped: [] });
  expect(archive("K1@1")).toContain("not read as visible and active");
  a.tools[1]!.execute({ query: "body", layer: "knowledge" });
  expect(archive("K1@1")).toContain("not read as visible and active");
  a.tools[0]!.execute({ address: "K1@1", cap: 1 });
  expect(archive("K1@1")).toContain("not read as visible and active");
  a.tools[0]!.execute({ address: "K1@1", itemBudget: null });
  expect(archive("K1@1", a.m.tools(a.context))).not.toContain("rejected:");
  expect(archive("K2@2")).toContain("not read as visible and active");
});

test("32: ABA and archive invalidate old handles; no substitution on stale refusal", async () => {
  const a = setup();
  const trigger = createDreamerTrigger(a.m, a.path, 1, 1);
  const result = await a.scenarios.run(a.m, a.path, input => {
    const request = { fixture: "ABA and archive handles", trigger }; input.reportRequest(request);
    const trace = input.tools[0]!, write = input.tools[3]!;
    trace.execute({ address: "K1@1", itemBudget: null });
    const first = JSON.parse(write.execute({ operations: [{ op: "update", id: "K1@1", ...a.content, text: "body B" }],
      skipped: [{ knowledge: `K${trigger.knowledgeId}@${trigger.commit}`, because: "The explicit trigger is retired after the ABA assertions." }] })).committed[0];
    trace.execute({ address: `K1@${first.commit}`, itemBudget: null });
    const second = JSON.parse(write.execute({ operations: [{ op: "update", id: `K1@${first.commit}`, ...a.content }],
      skipped: [{ knowledge: `K${trigger.knowledgeId}@${trigger.commit}`, because: "The explicit trigger is retired after the ABA assertions." }] })).committed[0];
    expect(write.execute({ operations: [{ op: "update", id: "K1@1", ...a.content }], skipped: [] })).toMatch(new RegExp(`base is not the latest effective applicable revision; current: K1@${second.commit}`));
    trace.execute({ address: `K1@${second.commit}`, itemBudget: null });
    const archived = JSON.parse(write.execute({ operations: [{ op: "archive", id: `K1@${second.commit}`, supports: ["F1"], reason: "retired" }],
      skipped: [{ knowledge: `K${trigger.knowledgeId}@${trigger.commit}`, because: "The explicit trigger is retired after the ABA assertions." }] })).committed[0];
    expect(write.execute({ operations: [{ op: "update", id: `K1@${second.commit}`, ...a.content }], skipped: [] })).toMatch(new RegExp(`base is not the latest effective applicable revision; current: K1@${archived.commit}`));
    trace.execute({ address: `K${trigger.knowledgeId}@${trigger.commit}`, itemBudget: null });
    write.execute({ operations: [{ op: "archive", id: `K${trigger.knowledgeId}@${trigger.commit}`, supports: ["F1"], reason: "Retire the explicit fixture trigger." }], skipped: [] });
    return { outcome: "success", output: "ABA checked", request };
  });
  if (result.outcome !== "success") throw new Error(JSON.stringify(result));
});

test("32: every merge participant is read and current; one bad handle rolls back the whole batch", async () => {
  const a = setup(true);
  const trigger = createDreamerTrigger(a.m, a.path, 1, 1);
  const result = await a.scenarios.run(a.m, a.path, input => {
    const request = { fixture: "merge participant reads", trigger }; input.reportRequest(request);
    const trace = input.tools[0]!, write = input.tools[3]!;
    const later = JSON.parse(write.execute({ operations: [{ op: "update", id: "K2@2", ...a.content, text: "later unread merge parent" }],
      skipped: [{ knowledge: `K${trigger.knowledgeId}@${trigger.commit}`, because: "The explicit trigger is retired after the merge assertions." }] })).committed[0];
    const merge = { op: "merge", id: "K1@1", absorb: [`K2@${later.commit}`], ...a.content };
    const rollback = write.execute({ operations: [
      { op: "archive", id: `K${trigger.knowledgeId}@${trigger.commit}`, supports: ["F1"], reason: "Must roll back with the unread merge." }, merge,
    ], skipped: [] });
    expect(rollback).toContain("not read as visible and active");
    expect(a.m.store.currentCommit(trigger.knowledgeId)[0]?.op).toBe("create");
    trace.execute({ address: `K2@${later.commit}`, itemBudget: null });
    expect(write.execute({ operations: [{ ...merge, absorb: ["K2"] }], skipped: [] })).toContain("exact read K@commit");
    trace.execute({ address: `K${trigger.knowledgeId}@${trigger.commit}`, itemBudget: null });
    const committed = JSON.parse(write.execute({ operations: [merge,
      { op: "archive", id: `K${trigger.knowledgeId}@${trigger.commit}`, supports: ["F1"], reason: "Retire the explicit fixture trigger." },
    ], skipped: [] }));
    expect(committed.committed).toHaveLength(2);
    return { outcome: "success", output: "merged", request };
  });
  if (result.outcome !== "success") throw new Error(JSON.stringify(result));
});

test("manual writers freeze fact sources and knowledge supports at the exact trigger prefix", () => {
  const a = setup();
  seedSourceEntry(a.m, a.t.id, "assistant", "carrier");
  const carrier = a.m.store.listSourceEntries(1, a.t.id).at(-1)!;
  seedSourceEntry(a.m, a.t.id, "assistant", "later evidence");
  const later = a.m.store.listSourceEntries(1, a.t.id).at(-1)!;
  a.m.selectEntries(1, "main", [a.rootEntry.id, carrier.id, later.id]);
  const lateTools = a.m.tools({ ...a.context, triggerEntryId: later.id, entryIds: [a.rootEntry.id, carrier.id, later.id] });
  expect(lateTools[2]!.execute({ facts: [{ category: "observation", actor: "agent", text: "later",
    source: [`T${a.t.id}#E${later.entryOrdinal}`] }] })).not.toContain("rejected:");
  const earlyTools = a.m.tools({ ...a.context, triggerEntryId: carrier.id, entryIds: [a.rootEntry.id, carrier.id] });
  expect(earlyTools[2]!.execute({ facts: [{ category: "observation", actor: "agent", text: "too late",
    source: [`T${a.t.id}#E${later.entryOrdinal}`] }] })).toContain("invalid source");
  expect(earlyTools[3]!.execute({ operations: [{ op: "create", ...a.content, supports: ["F2"] }], skipped: [] }))
    .toContain("after the exact triggering source prefix");
});

test("32: full K body embedded in raw trace or search never masquerades as a named K read", () => {
  const a = setup();
  const forged = a.m.trace("K1@1");
  a.m.store.updateTurn(a.t.id, { assistantText: forged });
  seedSourceEntry(a.m, a.t.id, "assistant", forged);
  a.m.selectEntries(1, "main", a.m.store.listSourceEntries(1, a.t.id).map(entry => entry.id));
  const archive = () => a.write([{ op: "archive", id: "K1@1", supports: ["F1"], reason: "Retire after the named-K read." }]);
  expect(a.tools[0]!.execute({ address: `T${a.t.id}` })).toContain(forged);
  expect(archive()).toContain("knowledge was not read");
  let page = a.tools[1]!.execute({ query: "body A", layer: "raw", cap: 1, maxTokens: 256 });
  let count = 0;
  expect(page).toContain("[K1@1]");
  while (true) {
    expect(page).not.toContain("rejected:");
    expect(archive()).toContain("knowledge was not read");
    const cursor = /cursor=(\S+)/.exec(page)?.[1];
    if (!cursor) break;
    page = a.tools[0]!.execute({ address: "K1@1", cursor });
    expect(++count).toBeLessThan(100);
  }
  a.tools[0]!.execute({ address: "K1@1", itemBudget: null });
  expect(archive()).toContain("committed");
});
