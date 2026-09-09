import { describe, expect, test } from "vitest";
import { sourceSeededMemory, type ConsolidationAgentInput } from "../../source-fixture.ts";

// These former model-unit cases now drive the host's actual Consolidation seam.
async function checkMemoryBatch(output: unknown) {
  const memory = sourceSeededMemory(":memory:", async raw => { const input = raw as ConsolidationAgentInput; input.reportRequest({ fake: true }); const tool = input.tools.find(t => t.name === "memory")!; tool.execute(output); input.reportRequest({ fake: true }); tool.execute(output); return { outcome: "success", output: "done", request: { fake: true } }; }, { consolidation: { nearThreshold: 1 } });
  try {
    const p = memory.store.createProject({ name: "validation", declaredBy: "mark" });
    const s = memory.store.createSession({ enrollmentChoice: true, host: "fake", projectId: p.id, startedAt: "now", firstReplyAt: "now" });
    const t = memory.store.appendTurn({ sessionId: s.id, kind: "turn", assistantText: "evidence", startedAt: "now" });
    memory.store.commitNotingRun({ run: { kind: "noting", sessionId: s.id, branch: "main", createdAt: "now" },
      facts: Array.from({ length: 6 }, (_, i) => ({ turnId: t.id, category: "observation" as const, actor: "agent" as const, text: `Evidence ${i}`, source: [`T${t.id}#assistant`], createdAt: "now" })),
      entryIds: memory.store.sourcePath(s.id, "main", t.id).map(e => e.id) });
    memory.store.commitConsolidationRun({ run: { kind: "consolidation", sessionId: s.id, branch: "main", createdAt: "now" },
      operations: Array.from({ length: 10 }, (_, i) => ({ op: "create", topics: [], reason: "Initial admission of this conclusion." as const, handle: `$e${i + 1}`, author: "fake", category: "term" as const, scope: "project" as const, text: `Seed ${i}`, supports: [1], createdAt: "now" })) });
    const result = await memory.consolidate({ sessionId: s.id, branch: "main" });
    const run = memory.store.listRuns(s.id).at(-1)!;
    const audit = JSON.parse(run.response!);
    return { problems: "problems" in result ? result.problems : [], value: result.outcome === "success" ? audit.toolCalls.at(-1).input : null };
  } finally { memory.close(); }
}

describe("checkMemoryBatch", async () => {
  test("accepts all four operations and skipped facts", async () => {
    const { problems, value } = await checkMemoryBatch({ operations: [
      { op: "create", topics: [], reason: "Initial admission of this conclusion.", text: "Use pnpm, not npm.", scope: "project", category: "constraint", supports: ["F1"] },
      { op: "update", topics: [], reason: "Substantive correction of the recorded conclusion.", id: "K5", text: "Updated wording.", scope: "project", category: "constraint", supports: ["F2"] },
      { op: "merge", topics: [], reason: "Merged duplicate knowledge into the survivor.", id: "K4", absorb: ["K6"], text: "Merged text.", scope: "project", category: "constraint", supports: ["F2", "F3"] },
      { op: "archive", reason: "Retired: the cited evidence withdraws this conclusion.", id: "K9", supports: ["F5"] },
    ], skipped: [{ fact: "F6", because: "duplicate of F2" }] });
    expect(problems).toEqual([]);
    expect(value!.operations.filter((op: any) => op.op === "create")).toHaveLength(1);
    expect(value!.operations.find((op: any) => op.op === "merge")!.absorb).toEqual(["K6"]);
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
    const { problems = [] } = await checkMemoryBatch({ operations: [{ op: "create", topics: [], reason: "Initial admission of this conclusion.", handle: "e1", text: "x", scope: "project", category: "term", supports: ["F1"] }], skipped: [] });
    expect(problems.some((p) => p.includes("handle"))).toBe(true);
  });

  test("rejects an unknown scope", async () => {
    const { problems = [] } = await checkMemoryBatch({ operations: [{ op: "create", topics: [], reason: "Initial admission of this conclusion.", text: "x", scope: "team", category: "term", supports: ["F1"] }], skipped: [] });
    expect(problems.some((p) => p.includes("scope"))).toBe(true);
  });

  test("rejects an unknown category", async () => {
    const { problems = [] } = await checkMemoryBatch({ operations: [{ op: "create", topics: [], reason: "Initial admission of this conclusion.", text: "x", scope: "project", category: "noting", supports: ["F1"] }], skipped: [] });
    expect(problems.some((p) => p.includes("category"))).toBe(true);
  });

  test("rejects a supports knowledge that is not a fact id", async () => {
    const { problems = [] } = await checkMemoryBatch({ operations: [{ op: "create", topics: [], reason: "Initial admission of this conclusion.", text: "x", scope: "project", category: "term", supports: ["K1"] }], skipped: [] });
    expect(problems.some((p) => p.includes("K1"))).toBe(true);
  });

  test("rejects a knowledge item id embedded in knowledge text", async () => {
    const { problems = [] } = await checkMemoryBatch({ operations: [{ op: "create", topics: [], reason: "Initial admission of this conclusion.", text: "Supersedes K3.", scope: "project", category: "term", supports: ["F1"] }], skipped: [] });
    expect(problems.some((p) => p.includes("text"))).toBe(true);
  });

  test("rejects a malformed update id", async () => {
    const { problems = [] } = await checkMemoryBatch({ operations: [{ op: "update", topics: [], reason: "Substantive correction of the recorded conclusion.", id: "5", text: "x", scope: "project", category: "term", supports: ["F1"] }], skipped: [] });
    expect(problems.some((p) => p.includes("visible"))).toBe(true);
  });

  test("rejects a merge whose absorb list holds a non-knowledge-id", async () => {
    const { problems = [] } = await checkMemoryBatch({ operations: [{ op: "merge", topics: [], reason: "Merged duplicate knowledge into the survivor.", id: "K1", absorb: ["not-an-id"], text: "x", scope: "project", category: "term", supports: ["F1"] }], skipped: [] });
    expect(problems.some((p) => p.includes("not-an-id"))).toBe(true);
  });

  test("accepts an explicit skipped fact with a reason", async () => {
    const { problems = [] } = await checkMemoryBatch({ operations: [], skipped: [{ fact: "F1", because: "different conditions" }] });
    expect(problems).toEqual([]);
  });

  test("rejects an unknown batch field", async () => {
    const { problems = [] } = await checkMemoryBatch({ operations: [], skipped: [], extra: [] });
    expect(problems.some((p) => p.includes("memory expects"))).toBe(true);
  });
});
