import { expect, test } from "vitest";
import { join } from "node:path";
import { sourceSeededMemory, type NotingAgentInput } from "../../source-fixture.ts";
import { fixture, broken, noterTurn, usage, type Body } from "./native-fixture.ts";
import { runWorker } from "../../../src/hosts/pi/worker.ts";
import { memoryReadTool } from "../../../src/hosts/pi/memory-files.ts";
import { workspaceFileTools } from "../../../src/hosts/pi/workspace-files.ts";
import { memoryFiles } from "../../../src/core/api/index.ts";

/** How many `write` calls the conversation so far holds: the Noter writes one file per step. */
const writes = (body: Body) => (body.messages ?? []).flatMap((m: Body) => m.tool_calls ?? []).filter((c: Body) => c.function?.name === "write").length;

function frozenRead(memory: ReturnType<typeof sourceSeededMemory>, task: NotingAgentInput, cwd: string, files: string[]) {
  if (!task.reader) throw new Error("Pi worker fixture requires the Core-frozen reader");
  const reader = memoryFiles(memory, task.reader);
  return memoryReadTool(cwd, path => reader.read(path), { memoryOnly: true, readableFiles: () => files });
}

// Tickets 113, 116 and 117 (held slots, receipts, the closing review round) are superseded for the Noter on 2026-10-22: it writes
// two files, and a request is a task's check, its writes and its stop. What this file keeps is the atomic publication seen on a
// real Pi child.
for (const ending of ["success", "error"] as const) test(`04: actual Pi worker leaves its two files private until the ${ending} terminal`, async () => {
  const f = await fixture();
  const memory = sourceSeededMemory(join(f.h.dir, "atomic.sqlite"), raw => {
    const task = raw as NotingAgentInput;
    const files = workspaceFileTools(f.h.dir, task.workspace);
    return runWorker(task, { model: f.model as never, checkCapacity: () => {}, tools: task.tools, fileTools: files.definitions as never,
      read: frozenRead(memory, task, f.h.dir, files.paths),
      runsDir: f.runsDir, cwd: f.h.dir, agentDir: f.agentDir, maxToolRounds: 0,
      onRetry: () => {}, onRetryEnd: () => {} });
  });
  try {
    const project = memory.store.createProject({ name: "atomic-pi", declaredBy: "mark" });
    const session = memory.store.createSession({ projectId: project.id, host: "pi:atomic", enrollmentChoice: true, startedAt: "now", firstReplyAt: "now" });
    const turn = memory.store.appendTurn({ sessionId: session.id, kind: "turn", userPrompt: "A durable rule", assistantText: "Acknowledged", startedAt: "now" });
    const path = { sessionId: session.id, branch: "main", headTurnId: turn.id };
    let rounds = 0;
    f.script(body => {
      rounds++;
      expect(memory.store.listSessionFacts(session.id)).toEqual([]);
      expect(memory.store.currentKnowledge(path)).toEqual([]);
      if (ending === "error" && writes(body) >= 2) return broken(); // the write task's two files exist (one per step); its last reply fails
      return noterTurn(body, { title: "Durable rule", sources: "[T1#E1] User set a durable rule" }, usage(),
        "## create\ntitle: Fixture title\ncategory: constraint\nscope: session\ntopics: \nsupports: f1\nreason: User requirement\n\nFollow the durable rule\n");
    });
    const result = await memory.noting({ ...path });
    expect(result.outcome).toBe(ending === "success" ? "success" : "failure");
    expect(rounds).toBeGreaterThanOrEqual(ending === "success" ? 5 : 3);
    expect(memory.store.listSessionFacts(session.id)).toHaveLength(ending === "success" ? 1 : 0);
    expect(memory.store.currentKnowledge(path)).toHaveLength(ending === "success" ? 1 : 0);
    if (!("runId" in result)) throw new Error("missing audit");
    const audit = JSON.parse(memory.store.getRun(result.runId!)!.response!);
    expect(audit.task).toBe(ending === "success" ? "verify" : "write");
    expect(audit.toolCalls.map((value: any) => value.name)).toEqual(["check"]);
    expect(audit.files.knowledge).toContain("Follow the durable rule");
    expect(audit.usage).not.toBeNull();
  } finally { memory.close(); await f.dispose(); }
});
