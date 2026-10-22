import { describe, expect, test } from "vitest";
import { hydrate, sourceSeededMemory, type NotingAgentInput } from "../../source-fixture.ts";
import { legacyFacts } from "../../support/seed.ts";
import { applyWorkspace, checkWorkspace } from "../../../src/core/workspace/index.ts";
import { block, workspaceBatch } from "../../support/workspace.ts";
import { scriptedNoter, type ToolOperation } from "../../support/noter.ts";

// Exercise the Noter's knowledge file and its real terminal publication.
async function checkMemoryBatch(operation: ToolOperation) {
  const memory = sourceSeededMemory(":memory:", scriptedNoter(() => memory, [{ noteInput: [], memoryInput: operation }]).agent);
  try {
    const p = memory.store.createProject({ name: "validation", declaredBy: "mark" });
    const s = memory.store.createSession({ enrollmentChoice: true, host: "fake", projectId: p.id, startedAt: "now", firstReplyAt: "now" });
    const t = memory.store.appendTurn({ sessionId: s.id, kind: "turn", assistantText: "evidence", startedAt: "now" });
    const assistant = hydrate(memory.store.listSourceEntries(s.id, t.id), memory.store).find(entry => entry.role === "assistant")!;
    legacyFacts(memory.store, { kind: "manual", sessionId: s.id, branch: "main", createdAt: "now" },
      Array.from({ length: 6 }, (_, i) => ({ sources: [{ entry: assistant, address: `T${t.id}#assistant` }],
        category: "observation" as const, actor: "agent" as const, text: `Evidence ${i}`, createdAt: "now" })));
    const seeded = memory.store.commitConsolidationRun({ run: { kind: "manual", sessionId: s.id, branch: "main", createdAt: "now" },
      operations: Array.from({ length: 10 }, (_, i) => ({ op: "create", title: "Fixture title", topics: [], reason: "Initial admission of this conclusion." as const, handle: `$e${i + 1}`, author: "fake", category: "understanding" as const, scope: "project" as const, text: `Seed ${i}`, supports: [1], createdAt: "now" })) });
    if (!seeded.ok) throw new Error(seeded.problems.join("; "));
    const result = await memory.noting({ sessionId: s.id, branch: "main", headTurnId: t.id });
    const run = memory.store.listRuns(s.id).at(-1)!;
    const audit = JSON.parse(run.response!);
    return { problems: "problems" in result ? result.problems : [], value: result.outcome === "success" ? audit.knowledgeOperations[0].requested : null };
  } finally { memory.close(); }
}

describe("checkMemoryBatch", async () => {
  test("64a/92: N creates knowledge backed by preceding facts", async () => {
    const { problems, value } = await checkMemoryBatch({ op: "create", title: "Fixture title", topics: [], reason: "Initial admission of this conclusion.", text: "Use pnpm, not npm.", scope: "project", category: "constraint", supports: ["F1"] });
    expect(problems).toEqual([]);
    expect(value!.op).toBe("create");
  });

  test("rejects an unknown scope", async () => {
    const { problems = [] } = await checkMemoryBatch({ op: "create", title: "Fixture title", topics: [], reason: "Initial admission of this conclusion.", text: "x", scope: "team", category: "understanding", supports: ["F1"] });
    expect(problems.some((p) => p.includes("scope"))).toBe(true);
  });

  test("rejects an unknown category", async () => {
    const { problems = [] } = await checkMemoryBatch({ op: "create", title: "Fixture title", topics: [], reason: "Initial admission of this conclusion.", text: "x", scope: "project", category: "noting", supports: ["F1"] });
    expect(problems.some((p) => p.includes("category"))).toBe(true);
  });

  test("rejects a supports knowledge that is not a fact id", async () => {
    const { problems = [] } = await checkMemoryBatch({ op: "create", title: "Fixture title", topics: [], reason: "Initial admission of this conclusion.", text: "x", scope: "project", category: "understanding", supports: ["K1"] });
    expect(problems.some((p) => p.includes("K1"))).toBe(true);
  });

  test("rejects a merge whose absorb list holds a non-knowledge-id", () => {
    const b = workspaceBatch();
    try {
      const primary = b.item("Rule");
      const before = b.store.listKnowledgeRevisions();
      const text = block(`merge ${primary.ref}`, { absorb: "not-an-id", reason: "Merge duplicate." }, "Merged rule");
      const checked = checkWorkspace(b.store, { kind: "curate", pair: "merge-split", sessionId: b.session.id, file: { name: "curate.md", text } });
      expect(checked.problems.join("\n")).toContain("not-an-id");
      expect(applyWorkspace(b.store, { kind: "curate", pair: "merge-split", sessionId: b.session.id, path: b.path, file: { name: "curate.md", text } })).toMatchObject({ ok: false });
      expect(b.store.listKnowledgeRevisions()).toEqual(before);
    } finally { b.memory.close(); }
  });


});
