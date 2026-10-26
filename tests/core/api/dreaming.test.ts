import { afterEach, expect, test } from "vitest";
import type { TraceMemory } from "../../source-fixture.ts";
import { dreamerFixture, scriptedDreamer } from "../../support/dreamer.ts";
import { block } from "../../support/workspace.ts";
import { REQUEST } from "../../support/noter.ts";

const memories: TraceMemory[] = [];
afterEach(() => { for (const memory of memories.splice(0)) memory.close(); });

test("a rejected atomic group publication rolls back operations scores coverage and flags", async () => {
  const f = dreamerFixture(memories), item = f.item("Original rule");
  f.store.setKnowledgeStale(item.commit, { reason: "unresolved_check", detail: "needs Dreamer" });
  f.dreamer.script.curate!.group1 = block(`update ${item.ref}`, { reason: "clarify" }, "Updated rule");
  f.store.db.exec("CREATE TRIGGER fail_group BEFORE INSERT ON knowledge_processed BEGIN SELECT RAISE(ABORT,'coverage fault'); END");
  expect(await f.dream()).toMatchObject({ outcome: "failure" });
  expect(f.store.currentCommit(item.knowledgeId, f.path)[0]!.id).toBe(item.commit);
  expect(f.store.getKnowledge(item.knowledgeId)?.score).toBeNull();
  expect(f.store.knowledgeStaleReasons(item.commit)).toEqual([{ reason: "unresolved_check", detail: "needs Dreamer" }]);
  expect(f.store.db.prepare("SELECT COUNT(*) AS n FROM knowledge_processed").get()!.n).toBe(0);
  f.store.db.exec("DROP TRIGGER fail_group");
  expect(await f.dream()).toMatchObject({ outcome: "success" });
});

test("each completed group retains the exact provider request and measured usage", async () => {
  const f = dreamerFixture(memories, { curateResult: { request: { exact: "provider" }, usage: { input: 7, output: 3, cacheRead: 0, cacheWrite: 0, cost: { total: 0.1 } } } });
  f.item("A supported rule");
  expect(await f.dream()).toMatchObject({ outcome: "success" });
  const run = f.store.listRuns(f.session.id).find(run => JSON.parse(run.response ?? "{}").task === "group")!;
  expect(JSON.parse(run.request!)).toEqual({ exact: "provider" });
  expect(JSON.parse(run.response!).usage).toMatchObject({ input: 7, output: 3 });
});

test("provider failure records the attempt and covers no item", async () => {
  const f = dreamerFixture(memories); f.item("A supported rule");
  f.dreamer.script.instead = { curate: async input => { input.reportRequest(REQUEST); return { outcome: "failure", request: REQUEST, output: "provider unavailable" }; } };
  expect(await f.dream()).toMatchObject({ outcome: "failure" });
  expect(f.store.noterChangedItems(f.path)).toBe(1);
  expect(f.store.handoff(f.session.id, "dreaming")!.detail!.groups![0]!.run).toBeUndefined();
});

test("soft budgets report native responses without preventing a passing over-budget group", async () => {
  const f = dreamerFixture(memories); f.item("A supported rule");
  f.memory.config.dreaming.curateSteps = 1; f.memory.config.dreaming.curateContextTokens = 1;
  const scripted = scriptedDreamer(), reports: string[] = [];
  f.dreamer.script.instead = { curate: async input => {
    input.reportResponse!("first", 100); input.reportResponse!("second", 300);
    reports.push(String(await input.tools.find(tool => tool.name === "check")!.execute({})));
    return scripted.agent(input);
  } };
  expect(await f.dream()).toMatchObject({ outcome: "success" });
  expect(reports[0]).toContain("steps 2 of 1; context +200 of +1");
});
