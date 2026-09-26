import { describe, expect, test } from "vitest";
import { sourceSeededMemory, type NotingAgentInput, type DreamingAgentInput } from "../../source-fixture.ts";

// Exercise both explicit N tools and real terminal publication.
async function checkMemoryBatch(output: unknown | ((tag: (id: number) => string) => unknown)) {
  const memory = sourceSeededMemory(":memory:", async raw => { const input = raw as NotingAgentInput; input.reportRequest({ fake: true }); input.tools.find(t => t.name === "note")!.execute({ facts: [] }); input.tools.find(t => t.name === "memory")!.execute(typeof output === "function" ? output((id: number) => `K${id}#${memory.store.versionTag(id, id)}`) : output); return { outcome: "success", output: "done", request: { fake: true } }; });
  try {
    const p = memory.store.createProject({ name: "validation", declaredBy: "mark" });
    const s = memory.store.createSession({ enrollmentChoice: true, host: "fake", projectId: p.id, startedAt: "now", firstReplyAt: "now" });
    const t = memory.store.appendTurn({ sessionId: s.id, kind: "turn", assistantText: "evidence", startedAt: "now" });
    const noted = memory.store.commitNotingRun({ run: { kind: "manual", sessionId: s.id, branch: "main", createdAt: "now" },
      facts: Array.from({ length: 6 }, (_, i) => ({ turnId: t.id, category: "observation" as const, actor: "agent" as const, text: `Evidence ${i}`, source: [`T${t.id}#assistant`], createdAt: "now" })),
      entryIds: [] });
    if (!noted.ok) throw new Error(noted.problems.join("; "));
    const seeded = memory.store.commitConsolidationRun({ run: { kind: "manual", sessionId: s.id, branch: "main", createdAt: "now" },
      operations: Array.from({ length: 10 }, (_, i) => ({ op: "create", topics: [], reason: "Initial admission of this conclusion." as const, handle: `$e${i + 1}`, author: "fake", category: "understanding" as const, scope: "project" as const, text: `Seed ${i}`, supports: [1], createdAt: "now" })) });
    if (!seeded.ok) throw new Error(seeded.problems.join("; "));
    const result = await memory.noting({ sessionId: s.id, branch: "main", headTurnId: t.id });
    const run = memory.store.listRuns(s.id).at(-1)!;
    const audit = JSON.parse(run.response!);
    return { problems: "problems" in result ? result.problems : [], value: result.outcome === "success" ? audit.toolCalls.at(-1).input : null };
  } finally { memory.close(); }
}

describe("checkMemoryBatch", async () => {
  test("64a/92: N creates knowledge backed by preceding facts", async () => {
    const { problems, value } = await checkMemoryBatch({ operations: [
      { op: "create", topics: [], reason: "Initial admission of this conclusion.", text: "Use pnpm, not npm.", scope: "project", category: "constraint", supports: ["F1"] },
    ], skipped: [] });
    expect(problems).toEqual([]);
    expect(value!.operations).toHaveLength(1);
    expect(value!.operations[0]!.op).toBe("create");
  });

  test("76/92: accepts N archive of a current tagged version", async () => {
    const { problems, value } = await checkMemoryBatch((tag: (id: number) => string) => ({ operations: [
      { op: "archive", reason: "Retire stale knowledge.", id: tag(9), supports: ["F5"] },
    ], skipped: [] }));
    expect(problems).toEqual([]);
    expect(value!.operations[0]).toMatchObject({ op: "archive" });
  });

  test("76/92: rejects N archive of a nonexistent version", async () => {
    const { problems } = await checkMemoryBatch({ operations: [
      { op: "archive", reason: "Retire stale knowledge.", id: "K99#abcd", supports: ["F5"] },
    ], skipped: [] });
    expect((problems ?? []).join(" ")).toContain("knowledge version does not exist");
  });

  test("76/92: rejects N merge and split with Dreamer guidance", async () => {
    const { problems: mergeProblems } = await checkMemoryBatch({ operations: [
      { op: "merge", reason: "Merge duplicates.", id: "K1#abcd", absorb: ["K2#abcd"], text: "merged", category: "understanding", scope: "project", topics: [], supports: ["F5"] },
    ], skipped: [] });
    expect((mergeProblems ?? []).join(" ")).toContain("Dreamer");
    const { problems: splitProblems } = await checkMemoryBatch({ operations: [
      { op: "split", reason: "Split apart.", id: "K1#abcd", supports: ["F5"] },
    ], skipped: [] });
    expect((splitProblems ?? []).join(" ")).toContain("Dreamer");
  });

  test("accepts an empty operations and skipped batch", async () => {
    const { problems, value } = await checkMemoryBatch({ operations: [], skipped: [] });
    expect(problems).toEqual([]);
    expect(value).toEqual({ operations: [], skipped: [] }); // The facade audit preserves the exact submitted object.
  });

  test("rejects a non-object top level", async () => {
    const { problems = [], value } = await checkMemoryBatch([]);
    expect(value).toBeNull();
    expect(problems.length).toBeGreaterThan(0);
  });

  test("rejects a model-supplied knowledge handle", async () => {
    const { problems = [] } = await checkMemoryBatch({ operations: [{ op: "create", topics: [], reason: "Initial admission of this conclusion.", handle: "e1", text: "x", scope: "project", category: "understanding", supports: ["F1"] }], skipped: [] });
    expect(problems.some((p) => p.includes("handle"))).toBe(true);
  });

  test("rejects an unknown scope", async () => {
    const { problems = [] } = await checkMemoryBatch({ operations: [{ op: "create", topics: [], reason: "Initial admission of this conclusion.", text: "x", scope: "team", category: "understanding", supports: ["F1"] }], skipped: [] });
    expect(problems.some((p) => p.includes("scope"))).toBe(true);
  });

  test("rejects an unknown category", async () => {
    const { problems = [] } = await checkMemoryBatch({ operations: [{ op: "create", topics: [], reason: "Initial admission of this conclusion.", text: "x", scope: "project", category: "noting", supports: ["F1"] }], skipped: [] });
    expect(problems.some((p) => p.includes("category"))).toBe(true);
  });

  test("rejects a supports knowledge that is not a fact id", async () => {
    const { problems = [] } = await checkMemoryBatch({ operations: [{ op: "create", topics: [], reason: "Initial admission of this conclusion.", text: "x", scope: "project", category: "understanding", supports: ["K1"] }], skipped: [] });
    expect(problems.some((p) => p.includes("K1"))).toBe(true);
  });

  test("rejects a knowledge item id embedded in knowledge text", async () => {
    const { problems = [] } = await checkMemoryBatch({ operations: [{ op: "create", topics: [], reason: "Initial admission of this conclusion.", text: "Supersedes K3.", scope: "project", category: "understanding", supports: ["F1"] }], skipped: [] });
    expect(problems.some((p) => p.includes("text"))).toBe(true);
  });

  test("rejects a malformed update id", async () => {
    const { problems = [] } = await checkMemoryBatch({ operations: [{ op: "update", topics: [], reason: "Substantive correction of the recorded conclusion.", id: "5", text: "x", scope: "project", category: "understanding", supports: ["F1"] }], skipped: [] });
    expect(problems.some((p) => p.includes("supply an exact K#tag version"))).toBe(true);
  });

  test("rejects a merge whose absorb list holds a non-knowledge-id", async () => {
    let reached = false;
    const memory = sourceSeededMemory(":memory:", async raw => {
      const input = raw as DreamingAgentInput;
      expect(input.kind).toBe("dreaming");
      expect(memory.store.getClaim(1, "dreaming")).not.toBeNull();
      expect(memory.store.openDreamingRange(1, "main")).not.toBeNull();
      const tag = `K1#${memory.store.versionTag(1, 1)}`;
      expect(input.tools.find(tool => tool.name === "trace")!.execute({ address: "K1", itemBudget: null })).toContain(tag);
      const before = memory.store.listKnowledgeRevisions();
      const receipt = input.tools.find(tool => tool.name === "memory")!.execute({ operations: [{ op: "merge", id: tag,
        absorb: ["not-an-id"], text: "Merged rule", scope: "project", category: "understanding", topics: [], supports: ["F1"], reason: "Merge duplicate." }], skipped: [] });
      expect(JSON.parse(receipt).results).toEqual(["rejected: not-an-id: supply an exact K#tag version; not-an-id: knowledge version does not exist"]);
      expect(memory.store.listKnowledgeRevisions()).toEqual(before);
      reached = true;
      input.reportRequest({});
      return { outcome: "success", output: "refused", request: {} };
    }, { dreaming: { triggerTokens: 1 } });
    try {
      const project = memory.store.createProject({ name: "merge-shape", declaredBy: "mark" });
      const session = memory.store.createSession({ projectId: project.id, host: "pi:test", enrollmentChoice: true, startedAt: "now", firstReplyAt: "now" });
      const turn = memory.store.appendTurn({ sessionId: session.id, kind: "turn", userPrompt: "Rule", startedAt: "now" });
      const tools = memory.tools({ kind: "manual", sessionId: session.id, branch: "main", currentTurnId: turn.id });
      expect(tools[2]!.execute({ facts: [{ text: "Rule", source: [`T${turn.id}#E1`] }] })).toContain("F1");
      expect(JSON.parse(tools[3]!.execute({ operations: [{ op: "create", text: "Rule", scope: "project", category: "understanding", topics: [], supports: ["F1"], reason: "Seed" }], skipped: [] })).committed).toHaveLength(1);
      const result = await memory.dream({ sessionId: session.id, branch: "main", headTurnId: turn.id });
      expect(result.outcome, JSON.stringify(result)).toBe("failure");
      if (result.outcome !== "failure") throw new Error("expected refused D batch");
      expect(result.problems).toEqual(["rejected: not-an-id: supply an exact K#tag version; not-an-id: knowledge version does not exist"]);
      expect(reached).toBe(true);
      expect(memory.store.listKnowledgeRevisions()).toHaveLength(1);
    } finally { memory.close(); }
  });

  test("N rejects retired fact-processing skips", async () => {
    const { problems = [] } = await checkMemoryBatch({ operations: [], skipped: [{ fact: "F1", because: "different conditions" }] });
    expect(problems.join(" ")).toContain("skipped");
  });

  test("rejects an unknown batch field", async () => {
    const { problems = [] } = await checkMemoryBatch({ operations: [], skipped: [], extra: [] });
    expect(problems.some((p) => p.includes("memory expects"))).toBe(true);
  });
});
