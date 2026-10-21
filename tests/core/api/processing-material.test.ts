import { expect, test } from "vitest";
import { sourceSeededMemory, memoryFiles, type NotingAgentInput } from "../../source-fixture.ts";
import { freezeNoting } from "../../../src/core/noting/index.ts";
import { setKnowledgeCapacity } from "../../knowledge-budget-fixture.ts";
import { tokens } from "../../../src/core/render/index.ts";

function fixture(agent: (input: NotingAgentInput) => void = () => {}) {
  const memory = sourceSeededMemory(":memory:", async raw => {
    const input = raw as NotingAgentInput;
    input.tools.find(tool => tool.name === "note")!.execute({});
    agent(input);
    return { outcome: "success", output: "done", request: {} };
  }, { writing: { bodyTokens: 1_000_000 } }); // the oversized body below stands for an item written before the caps (ticket 144)
  const p = memory.store.createProject({ name: "A", declaredBy: "mark" });
  const s = memory.store.createSession({ host: "test", enrollmentChoice: true, projectId: p.id, startedAt: "now", firstReplyAt: "now" });
  const turn = memory.store.appendTurn({ sessionId: s.id, kind: "turn", userPrompt: "Use this rule", startedAt: "now" });
  const tools = memory.tools({ kind: "manual", sessionId: s.id, branch: "main", currentTurnId: turn.id });
  tools.find(tool => tool.name === "note")!.execute({ title: "Rule", sources: `[T${turn.id}#E1] rule` });
  const content = { text: "word ".repeat(5_200), category: "constraint", scope: "project", supports: ["F1"], topics: [], reason: "test" };
  expect(tools.find(tool => tool.name === "memory")!.execute({ op: "create", title: "Fixture title", ...content })).toContain("committed");
  // Derive an exact 5,000-token Knowledge window from the real pool policy.
  // The oversized body then exercises omission without a retired fixed allowance.
  setKnowledgeCapacity(memory, 5_000);
  const target = { sessionId: s.id, branch: "main", headTurnId: turn.id };
  const freeze = (extra = {}) => freezeNoting(memory.store, { ...target, ...extra }, memory.config);
  return { memory, tools, content, target, freeze };
}

test("92: omitted knowledge has no printed tag; an exact tag works without read registration", async () => {
  const f = fixture(input => {
    expect(input).not.toHaveProperty("readKnowledgeCommits");
    expect(input.text).not.toContain("word ".repeat(400));
    const operation = { op: "update", id: "K1@1", ...f.content, text: "Updated concise rule using its exact version" };
    expect(input.tools.find(tool => tool.name === "memory")!.execute(operation)).toContain("supply an exact K#tag");
    operation.id = `K1#${f.memory.store.versionTag(1, 1)}`;
    expect(input.tools.find(tool => tool.name === "memory")!.execute({ ...operation, slot: "M1" })).toContain("held: M1");
    expect(f.memory.store.currentKnowledge(f.memory.store.knowledgePath(1))[0]!.revision.text).toBe(f.content.text);
  });
  try {
    expect(f.memory.store.currentKnowledge(f.memory.store.knowledgePath(1))).toHaveLength(1);
    expect(f.freeze().prepared?.text).not.toContain(`K1#${f.memory.store.versionTag(1, 1)}`);
    const result = await f.memory.noting(f.target);
    expect(result.outcome).toBe("success");
    expect(f.memory.store.currentKnowledge(f.memory.store.knowledgePath(1))[0]!.revision.text).toBe("Updated concise rule using its exact version");
  } finally { f.memory.close(); }
});

test("32/92: material without status cues supplies no duplicate body and grants no reads", () => {
  const f = fixture();
  try {
    f.tools.find(tool => tool.name === "note")!.execute({ title: "Withdrawal", sources: "[T1#E1] withdraw", negate: [["F1", "strong"]] });
    const withoutCues = f.freeze();
    expect(withoutCues.prepared?.supplied.knowledgeCommitIds).toEqual([]);
    expect(withoutCues.prepared?.text).not.toContain(f.content.text);
    expect(withoutCues.prepared).not.toHaveProperty("readKnowledgeCommits");
  } finally { f.memory.close(); }
});

test("92: omitted knowledge stays fully readable while N holds a distinct create until termination", async () => {
  const f = fixture(input => {
    expect(input).not.toHaveProperty("readKnowledgeCommits");
    const read = memoryFiles(f.memory, f.target).read("trace://K1@v1").content;
    expect(read).toContain(`K1#${f.memory.store.versionTag(1, 1)}`);
    expect(read).toContain(f.content.text);
    // A read produces frozen output only; it never mutates the dispatch snapshot.
    expect(input).not.toHaveProperty("readKnowledgeCommits");

    expect(input.tools.find(tool => tool.name === "memory")!.execute({ op: "create", title: "Fixture title", ...f.content, text: "A distinct durable rule" })).toContain("held: M1");
    expect(f.memory.store.currentKnowledge(f.memory.store.knowledgePath(1))).toHaveLength(1);
    input.reportRequest({ fixture: "held processing material" });
  });
  try {
    const result = await f.memory.noting(f.target);
    expect(result.outcome, JSON.stringify(result)).toBe("success");
    expect(f.memory.store.currentKnowledge(f.memory.store.knowledgePath(1)).map(value => value.revision.text)).toEqual([
      f.content.text, "A distinct durable rule",
    ]);
  } finally { f.memory.close(); }
});

test("N material shows each knowledge body's cap-check token count; injection does not", () => {
  const f = fixture();
  try {
    const body = "Short rule. ".repeat(40);
    expect(f.tools.find(tool => tool.name === "memory")!.execute({ op: "create", title: "Fixture title", ...f.content, text: body })).toContain("committed");
    setKnowledgeCapacity(f.memory, 20_000);
    const material = f.freeze().prepared!.text;
    expect(material).toContain(`[constraint/project] (${tokens(body)}/${f.memory.config.writing.bodyTokens} tokens) Fixture title\n${body}`);
    expect(material).not.toMatch(/\(\d+ tokens\)/); // 134: the Dreamer's pool-cost form never joins it for the same item
    expect(f.memory.injection(f.target).text).not.toContain("tokens) ");
  } finally { f.memory.close(); }
});
