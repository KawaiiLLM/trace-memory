import { describe, expect, test } from "vitest";
import { TraceMemory } from "./index.ts";

// These former model-unit cases now drive the host's actual Integration seam.
async function validateIntegrationOutput(output: unknown) {
  const memory = TraceMemory(":memory:", async () => ({ outcome: "success", output: JSON.stringify(output), request: { fake: true } }), { integration: { nearThreshold: 1 } });
  try {
    const p = memory.store.createProject({ name: "validation", declaredBy: "mark" });
    const s = memory.store.createSession({ host: "fake", projectId: p.id, startedAt: "now", firstReplyAt: "now" });
    const t = memory.store.appendTurn({ sessionId: s.id, kind: "turn", assistantText: "evidence", startedAt: "now" });
    memory.store.commitRecordingRun({ run: { kind: "recording", sessionId: s.id, branch: "main", createdAt: "now" },
      facts: Array.from({ length: 6 }, (_, i) => ({ turnId: t.id, category: "observation" as const, actor: "agent" as const, text: `Evidence ${i}`, source: [`T${t.id}#assistant`], createdAt: "now" })),
      watermark: { sessionId: s.id, branch: "main", lastRecordedTurn: t.id } });
    memory.store.commitIntegrationRun({ run: { kind: "integration", sessionId: s.id, branch: "main", createdAt: "now" },
      operations: Array.from({ length: 10 }, (_, i) => ({ op: "new" as const, handle: `$e${i + 1}`, author: "fake", category: "term" as const, scope: "project" as const, text: `Seed ${i}`, supports: [1], createdAt: "now" })) });
    const result = await memory.integrate({ sessionId: s.id, branch: "main" });
    const run = memory.store.listRuns(s.id).at(-1)!;
    const audit = JSON.parse(run.response!);
    return { problems: "problems" in result ? result.problems : [], value: result.outcome === "success" ? JSON.parse(audit.output) : null };
  } finally { memory.close(); }
}

describe("validateIntegrationOutput", async () => {
  test("accepts a well-formed round with all sections", async () => {
    const { problems, value } = await validateIntegrationOutput({
      new: [{ handle: "$e1", text: "Use pnpm, not npm.", scope: "project", category: "constraint", supports: ["F1"] }],
      edit: [{ id: "K5", text: "Updated wording.", scope: "project", category: "constraint", supports: ["F2"], because: ["F3"] }],
      merge: [{ into: "K4", absorb: ["K6"], text: "Merged text.", scope: "project", category: "constraint", supports: ["F2", "F3"], because: ["F4"] }],
      delete: [{ id: "K9", because: ["F5"] }],
      not_admitted: [{ id: "F6", because: "duplicate of F2" }],
      near_ack: [{ candidate: "$e1", knowledge: "K10", because: "different object" }],
      over_budget: false,
    });
    expect(problems).toEqual([]);
    expect(value!.new).toHaveLength(1);
    expect(value!.merge[0]!.absorb).toEqual(["K6"]);
  });

  test("accepts a round with sections omitted", async () => {
    const { problems, value } = await validateIntegrationOutput({});
    expect(problems).toEqual([]);
    expect(value).toEqual({}); // The facade audit preserves the exact submitted object.
  });

  test("rejects a non-object top level", async () => {
    const { problems, value } = await validateIntegrationOutput([]);
    expect(value).toBeNull();
    expect(problems.length).toBeGreaterThan(0);
  });

  test("rejects a malformed new-knowledge handle", async () => {
    const { problems } = await validateIntegrationOutput({ new: [{ handle: "e1", text: "x", scope: "project", category: "term", supports: ["F1"] }] });
    expect(problems.some((p) => p.includes("handle"))).toBe(true);
  });

  test("rejects an unknown scope", async () => {
    const { problems } = await validateIntegrationOutput({ new: [{ handle: "$e1", text: "x", scope: "team", category: "term", supports: ["F1"] }] });
    expect(problems.some((p) => p.includes("scope"))).toBe(true);
  });

  test("rejects an unknown category", async () => {
    const { problems } = await validateIntegrationOutput({ new: [{ handle: "$e1", text: "x", scope: "project", category: "recording", supports: ["F1"] }] });
    expect(problems.some((p) => p.includes("category"))).toBe(true);
  });

  test("rejects a supports knowledge that is not a fact id", async () => {
    const { problems } = await validateIntegrationOutput({ new: [{ handle: "$e1", text: "x", scope: "project", category: "term", supports: ["K1"] }] });
    expect(problems.some((p) => p.includes("supports"))).toBe(true);
  });

  test("rejects a knowledge item id embedded in knowledge text", async () => {
    const { problems } = await validateIntegrationOutput({ new: [{ handle: "$e1", text: "Supersedes K3.", scope: "project", category: "term", supports: ["F1"] }] });
    expect(problems.some((p) => p.includes("embed"))).toBe(true);
  });

  test("rejects a malformed edit id", async () => {
    const { problems } = await validateIntegrationOutput({ edit: [{ id: "5", text: "x", scope: "project", category: "term", supports: ["F1"], because: ["F1"] }] });
    expect(problems.some((p) => p.includes("id"))).toBe(true);
  });

  test("rejects a merge whose absorb list holds a non-knowledge-id", async () => {
    const { problems } = await validateIntegrationOutput({
      merge: [{ into: "K1", absorb: ["not-an-id"], text: "x", scope: "project", category: "term", supports: ["F1"], because: ["F1"] }],
    });
    expect(problems.some((p) => p.includes("absorb"))).toBe(true);
  });

  test("accepts a near_ack naming a candidate handle and a knowledge item", async () => {
    const { problems } = await validateIntegrationOutput({ near_ack: [{ candidate: "$e2", knowledge: "K4", because: "different conditions" }] });
    expect(problems).toEqual([]);
  });

  test("rejects a near_ack with a malformed candidate", async () => {
    const { problems } = await validateIntegrationOutput({ near_ack: [{ candidate: "e2", knowledge: "K4", because: "x" }] });
    expect(problems.some((p) => p.includes("candidate"))).toBe(true);
  });
});
