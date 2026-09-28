import { expect, test, vi } from "vitest";
import { TraceMemory, type DreamingAgentInput } from "../../../src/core/api/index.ts";
import { runNative } from "../../../src/hosts/pi/native.ts";
import { fixture, say } from "./native-fixture.ts";

test("68: shared deadline fences a real Pi worker, releases its claim and permits the next run", async () => {
  const f = await fixture({ "noting.triggerTokens": 1e9 });
  let release!: () => void, entered!: () => void;
  const ready = new Promise<void>(resolve => { entered = resolve; });
  const gate = new Promise<void>(resolve => { release = resolve; });
  let first = true;
  f.script(async () => { if (first) { first = false; entered(); await gate; } return say("Finished."); });
  const nativeWork: Promise<unknown>[] = [];
  let task!: DreamingAgentInput;
  const memory = TraceMemory(":memory:", async input => {
    task = input as DreamingAgentInput;
    task.acknowledgeRequest();
    const work = runNative({ mode: "subagent", runsDir: f.runsDir, cwd: f.h.dir, agentDir: f.agentDir,
      model: f.model as never, systemPrompt: task.prompt, task: task.text,
      tools: task.tools, maxToolRounds: 0, signal: task.signal,
      onRequest: () => {}, onProgress: () => {},
      passEnd: task.passEnd, reportRounds: task.reportRounds });
    nativeWork.push(work);
    const result = await work;
    return { ...result, request: { fixture: "real Pi runtime, mocked provider" } };
  }, { dreaming: { triggerTokens: 1, timeoutMs: 1000 } });
  try {
    const store = memory.store;
    const project = store.createProject({ name: "deadline", declaredBy: "mark" });
    const session = store.createSession({ host: "deadline", enrollmentChoice: true, projectId: project.id, startedAt: "now", firstReplyAt: "now" });
    const turn = store.appendTurn({ sessionId: session.id, kind: "turn", userPrompt: "evidence", startedAt: "now" });
    const entry = memory.appendEntry({ sessionId: session.id, turnId: turn.id, nativeLineage: "deadline", nativeId: "root", role: "user", text: "evidence", raw: "{}", calls: [] });
    memory.selectEntries(session.id, "main", [entry.id]);
    const facts = store.commitNotingRun({ run: { kind: "manual", sessionId: session.id, createdAt: "now" }, facts: [{ turnId: turn.id, entryIds: [entry.id], category: "decision", actor: "user", text: "A rule", source: [`T${turn.id}#E1`], createdAt: "now" }] });
    if (!facts.ok) throw new Error(facts.problems.join("; "));
    const made = store.commitConsolidationRun({ run: { kind: "manual", sessionId: session.id, createdAt: "now" }, operations: [{ op: "create", handle: "$1", author: "test", text: "A durable rule", category: "constraint", scope: "project", supports: [facts.facts[0]!.id], topics: [], reason: "fixture", createdAt: "now" }] });
    if (!made.ok) throw new Error(made.problems.join("; "));
    const item = made.committed[0]!;
    const target = { sessionId: session.id, branch: "main", headTurnId: turn.id, triggerEntryId: entry.id };
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const running = memory.dream(target);
    await ready;
    await vi.advanceTimersByTimeAsync(1000);
    const result = await running;
    expect(result.outcome).toBe("failure");
    expect("problems" in result && result.problems?.join(" ")).toContain("1000 ms");
    expect(task.signal?.aborted).toBe(true);
    expect(store.getClaim(session.id, "dreaming")).toBeNull();
    expect(store.openDreamingRange(session.id, "main")).toBeNull();
    const lateWrite = task.tools.find(tool => tool.name === "memory")!.execute({ operations: [{ op: "archive", kind: "budget", id: `K${item.knowledgeId}@${item.commit}`, supports: [], reason: "too late" }], skipped: [] });
    expect(lateWrite).toBe("rejected: run has finished");
    expect(store.pendingVersions(`project:${project.id}`, target)).toHaveLength(1);
    vi.useRealTimers();
    release();
    await Promise.all(nativeWork);
    expect((await memory.dream(target)).outcome).toBe("success");
    expect(store.getClaim(session.id, "dreaming")).toBeNull();
    expect(store.enabled(session.id)).toBe(true);
  } finally {
    vi.useRealTimers(); release(); await Promise.allSettled(nativeWork); memory.close(); await f.dispose();
  }
});
