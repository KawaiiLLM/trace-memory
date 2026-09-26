import { expect, test } from "vitest";
import { join } from "node:path";
import { sourceSeededMemory, type NotingAgentInput } from "../../source-fixture.ts";
import { fixture, call, say, broken } from "./native-fixture.ts";
import { runWorker } from "../../../src/hosts/pi/worker.ts";
import { toolDefinitions } from "../../../src/core/api/tools.ts";

for (const ending of ["success", "error"] as const) test(`04: actual Pi worker holds both tools until ${ending} terminal`, async () => {
  const f = await fixture();
  const memory = sourceSeededMemory(join(f.h.dir, "atomic.sqlite"), raw => {
    const task = raw as NotingAgentInput;
    return runWorker(task, { model: f.model as never, checkCapacity: () => {}, tools: task.tools,
      runsDir: f.runsDir, cwd: f.h.dir, agentDir: f.agentDir, maxToolRounds: 0,
      onCache: () => {}, onRetry: () => {}, onRetryEnd: () => {} });
  });
  try {
    const project = memory.store.createProject({ name: "atomic-pi", declaredBy: "mark" });
    const session = memory.store.createSession({ projectId: project.id, host: "pi:atomic", enrollmentChoice: true, startedAt: "now", firstReplyAt: "now" });
    const turn = memory.store.appendTurn({ sessionId: session.id, kind: "turn", userPrompt: "A durable rule", assistantText: "Acknowledged", startedAt: "now" });
    const path = { sessionId: session.id, branch: "main", headTurnId: turn.id };
    let round = 0;
    f.script(() => {
      round++;
      expect(memory.store.listSessionFacts(session.id)).toEqual([]);
      expect(memory.store.currentKnowledge(path)).toEqual([]);
      if (round === 1) return call("note-held", "note", { facts: [{ text: "User set a durable rule", source: ["T1#E1"] }] });
      if (round === 2) return call("memory-held", "memory", { operations: [{ op: "create", text: "Follow the durable rule", category: "constraint",
        scope: "session", topics: [], supports: ["$1"], reason: "User requirement" }], skipped: [] });
      return ending === "success" ? say("Done") : broken();
    });
    const result = await memory.noting({ ...path, mode: "subagent" });
    expect(result.outcome).toBe(ending === "success" ? "success" : "failure");
    expect(round).toBeGreaterThanOrEqual(3);
    expect(memory.store.listSessionFacts(session.id)).toHaveLength(ending === "success" ? 1 : 0);
    expect(memory.store.currentKnowledge(path)).toHaveLength(ending === "success" ? 1 : 0);
    if (!("runId" in result)) throw new Error("missing audit");
    const audit = JSON.parse(memory.store.getRun(result.runId!)!.response!);
    expect(audit.toolCalls.map((value: any) => value.name)).toEqual(["note", "memory"]);
    expect(audit.toolCalls[0].result).toContain("held: $1");
    expect(audit.toolCalls[1].result).toContain("held: M1");
    expect(audit.usage).not.toBeNull();
  } finally { memory.close(); await f.dispose(); }
});

for (const obsolete of [false, true]) test(`04: real Pi fork shared schemas preserve prefix; obsolete=${obsolete}`, async () => {
  const f = await fixture({ "noting.triggerTokens": 1e9 });
  f.script(() => say("Parent reply"));
  const captured = await f.turn();
  if (obsolete) delete (captured.tools as any[]).find(tool => tool.function.name === "note").function.parameters.properties.drop;
  const memory = sourceSeededMemory(join(f.h.dir, "fork-atomic.sqlite"), raw => {
    const task = raw as NotingAgentInput;
    for (const name of ["note", "memory"]) {
      const bound = task.tools.find(tool => tool.name === name)!;
      const shared = toolDefinitions.find(tool => tool.name === name)!;
      expect({ name: bound.name, description: bound.description, parameters: bound.parameters }).toEqual(shared);
    }
    return runWorker(task, { model: f.model as never, checkCapacity: () => {}, tools: task.tools,
      runsDir: f.runsDir, cwd: f.h.dir, agentDir: f.agentDir, maxToolRounds: 0,
      fork: { parentFile: f.manager().getSessionFile()!, parentSessionId: f.manager().getSessionId(), checkpoint: f.manager().getLeafId()!, captured },
      onCache: () => {}, onRetry: () => {}, onRetryEnd: () => {} });
  });
  try {
    const project = memory.store.createProject({ name: "fork-atomic", declaredBy: "mark" });
    const session = memory.store.createSession({ projectId: project.id, host: "pi:fork", enrollmentChoice: true, startedAt: "now", firstReplyAt: "now" });
    const turn = memory.store.appendTurn({ sessionId: session.id, kind: "turn", userPrompt: "用 pnpm，不要 npm", assistantText: "Parent reply", startedAt: "now" });
    const path = { sessionId: session.id, branch: "main", headTurnId: turn.id };
    const fact = (text: string) => ({ text, source: ["T1#E1"] });
    const knowledge = (text: string, supports: string[]) => ({ op: "create", text, category: "constraint", scope: "session", topics: [], supports, reason: "user rule" });
    let round = 0;
    f.script(() => {
      round++;
      expect(memory.store.listSessionFacts(session.id)).toEqual([]);
      if (round === 1) return call("facts", "note", { facts: [fact("original"), fact("drop"), fact("third")] });
      if (round === 2) return call("edit", "note", { facts: [{ slot: "$1", ...fact("corrected") }], drop: ["$2"] });
      if (round === 3) return call("knowledge", "memory", { operations: [knowledge("Initial rule", ["$1", "$3"])], skipped: [] });
      if (round === 4) return call("knowledge-edit", "memory", { operations: [{ slot: "M1", ...knowledge("Final rule", ["$3"]) }, knowledge("drop this", ["$1"])], skipped: [] });
      if (round === 5) return call("knowledge-drop", "memory", { operations: [], skipped: [], drop: ["M2"] });
      if (round === 6) return call("append", "note", { facts: [{ ...fact("fourth"), support: [["$3", "strong"]] }] });
      return say("Done");
    });
    const result = await memory.noting({ ...path, mode: "fork" });
    if (obsolete) {
      expect(result).toMatchObject({ outcome: "dropped", refused: { reason: expect.stringContaining("incompatible with the current Noter protocol") } });
      expect(round).toBe(0); expect(memory.store.listSessionFacts(session.id)).toEqual([]);
    } else {
      expect(result.outcome, JSON.stringify(result)).toBe("success");
      expect(round).toBe(7);
      expect(memory.store.listSessionFacts(session.id)).toHaveLength(3);
      expect(memory.store.currentKnowledge(path)[0]!.revision).toMatchObject({ text: "Final rule", supports: [2] });
      expect(memory.store.listFactRelations(3)[0]).toMatchObject({ toFact: 2 });
      if (!("runId" in result)) throw new Error("missing run");
      const audit = JSON.parse(memory.store.getRun(result.runId!)!.response!);
      expect(audit.verification).toMatchObject({ passed: true, differingPath: null });
      expect(audit.held.factMapping).toEqual({ "$1": "F1", "$3": "F2", "$4": "F3" });
    }
  } finally { memory.close(); await f.dispose(); }
});

for (const [kind, corrected] of [["note", false], ["note", true], ["trace", false]] as const) test(`04: native Pi ${kind} schema rejection; corrected=${corrected}`, async () => {
  const f = await fixture();
  const memory = sourceSeededMemory(join(f.h.dir, "schema.sqlite"), raw => {
    const task = raw as NotingAgentInput;
    const report = task.reportToolRejection;
    return runWorker({ ...task, reportToolRejection: (...args) => { report(...args); report(...args); } },
      { model: f.model as never, checkCapacity: () => {}, tools: task.tools, runsDir: f.runsDir, cwd: f.h.dir,
        agentDir: f.agentDir, maxToolRounds: 0, onCache: () => {}, onRetry: () => {}, onRetryEnd: () => {} });
  });
  try {
    const project = memory.store.createProject({ name: "schema-pi", declaredBy: "mark" });
    const session = memory.store.createSession({ projectId: project.id, host: "pi:schema", enrollmentChoice: true, startedAt: "now", firstReplyAt: "now" });
    const turn = memory.store.appendTurn({ sessionId: session.id, kind: "turn", userPrompt: "Rule", assistantText: "Explanation", startedAt: "now" });
    let round = 0;
    f.script(() => {
      round++;
      if (round === 1) return call("valid", "note", { facts: [{ text: "original", source: ["T1#E1"] }, { text: "sibling", source: ["T1#E2"] }] });
      if (round === 2) return call("invalid", kind, kind === "note" ? { facts: [{ slot: "$1", source: ["T1#E1"] }] } : {});
      if (round === 3) return call("memory-empty", "memory", { operations: [], skipped: [] });
      if (round === 4 && corrected) return call("corrected", "note", { facts: [{ slot: "$1", text: "corrected", source: ["T1#E1"] }] });
      return say("Done");
    });
    const result = await memory.noting({ sessionId: session.id, branch: "main", headTurnId: turn.id, mode: "subagent" });
    expect(result.outcome).toBe(corrected || kind === "trace" ? "success" : "bounced");
    const facts = memory.store.listSessionFacts(session.id);
    expect(facts.map(fact => fact.text).sort()).toEqual(corrected ? ["corrected", "sibling"] : kind === "trace" ? ["original", "sibling"] : []);
    if (!("runId" in result)) throw new Error("missing run");
    const audit = JSON.parse(memory.store.getRun(result.runId!)!.response!);
    expect(audit.toolCalls.filter((item: any) => item.input?.facts?.[0]?.slot === "$1" && !item.input.facts[0].text)).toHaveLength(kind === "note" ? 1 : 0);
  } finally { memory.close(); await f.dispose(); }
});
