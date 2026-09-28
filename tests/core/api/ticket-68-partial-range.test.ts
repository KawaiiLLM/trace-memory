import { afterEach, expect, test, vi } from "vitest";
import { readHandle } from "../../read-handle-fixture.ts";
import { suppliedHandles } from "../../dreaming-skips.ts";
import { TraceMemory, type DreamingAgentInput, type RunAgentResult } from "../../../src/core/api/index.ts";

const opened: ReturnType<typeof TraceMemory>[] = [];
afterEach(() => { vi.useRealTimers(); for (const memory of opened.splice(0)) memory.close(); });
const exact = { request: { fixture: "partial-range" } };
function setup(agent: (task: DreamingAgentInput) => Promise<RunAgentResult>, triggerTokens = 1) {
  const memory = TraceMemory(":memory:", task => agent(task as DreamingAgentInput), { dreaming: { triggerTokens, timeoutMs: 1000 } });
  opened.push(memory);
  const store = memory.store;
  const project = store.createProject({ name: "partial-range", declaredBy: "mark" });
  const session = store.createSession({ host: "test", enrollmentChoice: true, projectId: project.id, startedAt: "now", firstReplyAt: "now" });
  const turn = store.appendTurn({ sessionId: session.id, kind: "turn", userPrompt: "rule", startedAt: "now" });
  const entry = memory.appendEntry({ sessionId: session.id, turnId: turn.id, nativeLineage: "test", nativeId: "root", role: "user", text: "rule", raw: "{}", calls: [] });
  memory.selectEntries(session.id, "main", [entry.id]);
  const noted = store.commitNotingRun({ run: { kind: "manual", sessionId: session.id, createdAt: "now" }, facts: [{ turnId: turn.id, entryIds: [entry.id], category: "decision", actor: "user", text: "rule", source: [`T${turn.id}#E1`], createdAt: "now" }] });
  if (!noted.ok) throw new Error(noted.problems.join("; "));
  const create = (text: string, scope: "global" | "project" | "session" = "project") => {
    const made = store.commitConsolidationRun({ run: { kind: "manual", sessionId: session.id, createdAt: "now" }, operations: [{ op: "create", handle: "$1", author: "test", text, category: "constraint", scope, supports: [noted.facts[0]!.id], topics: [], reason: "fixture", createdAt: "now" }] });
    if (!made.ok) throw new Error(made.problems.join("; "));
    return made.committed[0]!;
  };
  return { memory, store, create, session, pool: `project:${project.id}`, target: { sessionId: session.id, branch: "main", headTurnId: turn.id, triggerEntryId: entry.id } };
}
const handles = (task: DreamingAgentInput) => suppliedHandles(task.material.changed);

test("92: the frozen range is the pending prefix within the 10k slice, not the pool budget; only skipped items are processed", async () => {
  let seen: string[] = [];
  const f = setup(async task => {
    seen = handles(task);
    const write = task.tools.find(tool => tool.name === "memory")!;
    expect(write.execute({ operations: [], skipped: [{ knowledge: seen[0], because: "Reviewed unchanged" }] })).toContain("committed");
    return { outcome: "success", output: "reviewed oldest", ...exact };
  });
  const first = f.create("oldest"), second = f.create("later");
  f.memory.setKnowledgeBudget("project", 1);
  const result = await f.memory.dream(f.target);
  // 104: the pool stays over budget and the later item undeliberated, so the run is not a success.
  expect(result.outcome, JSON.stringify(result)).toBe("failure");
  expect(seen).toEqual([`K${first.knowledgeId}@v1`, `K${second.knowledgeId}@v1`]);
  expect(f.store.db.prepare("SELECT revision_id FROM knowledge_processed WHERE pool = ?").all(f.pool))
    .toEqual([{ revision_id: first.commit }]);
  expect(f.store.pendingVersions(f.pool, f.target).map(value => value.revisionId)).toEqual([second.commit]);
});

test.each(["success", "failure", "cancelled", "timeout"] as const)("68: 86 frozen items retain exactly the untouched remainder after %s", async outcome => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
  let pass = 0;
  const outputs: number[] = [];
  const f = setup(async task => {
    task.acknowledgeRequest(); task.reportRequest(exact.request); task.reportProgress?.(exact);
    const ids = handles(task), write = task.tools.find(tool => tool.name === "memory")!;
    if (++pass === 2) {
      expect(ids).toHaveLength(51);
      for (const id of ids) expect(write.execute({ operations: [], skipped: [{ knowledge: id, because: "already correct" }] })).toContain("committed");
      return { outcome: "success", output: "remaining items reviewed", ...exact };
    }
    expect(ids).toHaveLength(86);
    for (const id of ids.slice(0, 34)) {
      const receipt = JSON.parse(write.execute({ operations: [{ op: "update", id: readHandle(task.tools, id), text: `Maintained rule ${outputs.length + 1}`, category: "constraint", scope: "project", supports: [], topics: [], reason: "maintain" }], skipped: [] }));
      expect(receipt.committed).toHaveLength(1);
      const version = /^K(\d+)@v(\d+)$/.exec(receipt.committed[0].version)!;
      outputs.push(f.store.resolveVersionOrdinal(Number(version[1]), Number(version[2])));
    }
    expect(write.execute({ operations: [], skipped: [{ knowledge: ids[34], because: "already correct" }] })).toContain("committed");
    if (outcome === "timeout") return new Promise<RunAgentResult>(() => {});
    return { outcome, output: "cut after partial deliberation", ...exact };
  });
  const originals = Array.from({ length: 86 }, (_, index) => f.create(`Rule ${index}`));
  const running = f.memory.dream(f.target);
  if (outcome === "timeout") await vi.advanceTimersByTimeAsync(1000);
  const result = await running;
  // 104: the untouched remainder turns a reported success into a failure, as the timeout is one.
  expect(result.outcome, JSON.stringify(result)).toBe(outcome === "timeout" || outcome === "success" ? "failure" : outcome);
  expect(f.store.pendingVersions(f.pool, f.target).map(value => value.revisionId), JSON.stringify(result)).toEqual(originals.slice(35).map(item => item.commit));
  expect(f.store.db.prepare("SELECT revision_id FROM knowledge_processed WHERE pool = ? ORDER BY revision_id").all(f.pool).map(row => Number(row.revision_id)))
    .toEqual([originals[34]!.commit, ...outputs].sort((a, b) => a - b));
  expect(f.store.getClaim(f.session.id, "dreaming")).toBeNull();
  if (!("runId" in result) || result.runId === undefined) throw new Error("missing run audit");
  const audit = JSON.parse(f.store.getRun(result.runId)!.response!);
  expect(audit).toMatchObject({ deliberated: 35, frozen: 86 });
  expect((await f.memory.dream(f.target)).outcome).toBe("success");
  expect(f.store.pendingVersions(f.pool, f.target)).toEqual([]);
  expect(f.memory.taskEligibility("dreaming", f.target)).toEqual({ due: false });
});

test("68: deliberated count measures frozen parents, not output revisions", async () => {
  const f = setup(async task => {
    task.acknowledgeRequest();
    const ids = handles(task), write = task.tools.find(tool => tool.name === "memory")!;
    const merged = JSON.parse(write.execute({ operations: [{ op: "merge", id: readHandle(task.tools, ids[0]!), absorb: [readHandle(task.tools, ids[1]!)], text: "One rule", category: "constraint", scope: "project", supports: [], topics: [], reason: "duplicate" }], skipped: [] }));
    expect(merged.committed).toHaveLength(1);
    const split = JSON.parse(write.execute({ operations: [{ op: "split", id: readHandle(task.tools, ids[2]!), supports: [], reason: "independent rules", children: [{ text: "First", category: "constraint", topics: [] }, { text: "Second", category: "constraint", topics: [] }] }], skipped: [] }));
    expect(split.committed).toHaveLength(2);
    return { outcome: "success", output: "done", ...exact };
  });
  for (const text of ["first", "duplicate", "mixed", "untouched"]) f.create(text);
  const result = await f.memory.dream(f.target);
  expect(result.outcome).toBe("failure"); // 104: the untouched item is not deliberated
  if (!("runId" in result) || result.runId === undefined) throw new Error("missing run audit");
  expect(JSON.parse(f.store.getRun(result.runId)!.response!)).toMatchObject({ deliberated: 3, frozen: 4 });
  expect(f.store.pendingVersions(f.pool, f.target)).toHaveLength(1);
});
