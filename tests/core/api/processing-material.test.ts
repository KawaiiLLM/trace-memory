import { expect, test } from "vitest";
import { sourceSeededMemory, type ConsolidationAgentInput } from "../../source-fixture.ts";
import { visibleView } from "../../../src/hosts/pi/visible.ts";
import { freezeConsolidation } from "../../../src/core/consolidation/index.ts";
import { setKnowledgeCapacity } from "../../knowledge-budget-fixture.ts";
import { drainTrace } from "../../trace-pages.ts";

function fixture(agent: (input: ConsolidationAgentInput) => void = () => {}) {
  const memory = sourceSeededMemory(":memory:", async raw => { agent(raw as ConsolidationAgentInput); return { outcome: "success", output: "done", request: {} }; });
  const p = memory.store.createProject({ name: "A", declaredBy: "mark" });
  const s = memory.store.createSession({ host: "test", enrollmentChoice: true, projectId: p.id, startedAt: "now", firstReplyAt: "now" });
  const turn = memory.store.appendTurn({ sessionId: s.id, kind: "turn", userPrompt: "Use this rule", startedAt: "now" });
  const tools = memory.tools({ kind: "manual", sessionId: s.id, branch: "main", currentTurnId: turn.id });
  tools[2]!.execute({ facts: [{ text: "rule", source: ["T1#E1"] }] });
  const content = { text: "word ".repeat(5_200), category: "constraint", scope: "project", supports: ["F1"], topics: [], reason: "test" };
  expect(tools[3]!.execute({ operations: [{ op: "create", ...content }], skipped: [] })).toContain("committed");
  // Derive an exact 5,000-token worker capacity from the real pool and N/C trigger authorities.
  // The oversized body then exercises omission without a retired fixed allowance.
  setKnowledgeCapacity(memory, 5_000);
  const target = { sessionId: s.id, branch: "main", headTurnId: turn.id };
  const freeze = (extra = {}) => freezeConsolidation(memory.store, { ...target, ...extra }, memory.config);
  return { memory, tools, content, target, freeze };
}

function completeRead(tool: ConsolidationAgentInput["tools"][number], address: string): string {
  return drainTrace({ trace: (next, options) => tool.execute({ address: next, ...options }) },
    tool.execute({ address, full: true, itemBudget: null })).joined;
}

test("92: omitted knowledge has no printed tag; an exact tag works without read registration", async () => {
  const f = fixture(input => {
    expect(input).not.toHaveProperty("readKnowledgeCommits");
    expect(input.text).not.toContain("word ".repeat(400));
    const batch = { operations: [{ op: "update", id: "K1@1", ...f.content, text: "Updated concise rule using its exact version" }], skipped: [] };
    expect(input.tools[3]!.execute(batch)).toContain("supply an exact K#tag");
    batch.operations[0]!.id = `K1#${f.memory.store.versionTag(1, 1)}`;
    expect(input.tools[3]!.execute(batch)).toContain('"committed"');
  });
  try {
    expect(f.freeze().knowledge).toHaveLength(1);
    expect(f.freeze().prepared?.text).not.toContain(`K1#${f.memory.store.versionTag(1, 1)}`);
    const result = await f.memory.consolidate(f.target);
    expect(result.outcome).toBe("success");
  } finally { f.memory.close(); }
});

test("32/92: actual inherited carriers suppress duplicate bodies without granting reads", () => {
  const f = fixture();
  try {
    f.tools[2]!.execute({ facts: [{ text: "withdraw", source: ["T1#E1"], negate: [["F1", "strong"]] }] });
    const withoutCues = f.freeze();
    expect(withoutCues.prepared?.supplied.knowledgeCommitIds).toEqual([]);
    expect(withoutCues.prepared?.text).not.toContain(f.content.text);
    expect(withoutCues.prepared).not.toHaveProperty("readKnowledgeCommits");
    // The carrier takes its identities from the actual untruncated injection, not a candidate scan.
    setKnowledgeCapacity(f.memory, 20_000);
    const injection = f.memory.injection(f.target);
    expect(injection.text).toContain(f.content.text);
    const binding = { db: "fixture-db", session: 1, pi: "fixture-pi" };
    const entry = { id: "injection", type: "custom_message", customType: "trace-memory", details: { traceMemory: {
      ...binding, supplied: { entries: [], factIds: [], knowledgeCommitIds: injection.knowledgeCommitIds },
    } } };
    const visible = visibleView([entry], binding);
    const inherited = f.freeze({ mode: "fork", visible });
    expect(inherited.prepared?.supplied.knowledgeCommitIds).toEqual([]);
    expect(inherited.prepared).not.toHaveProperty("readKnowledgeCommits");
    expect(inherited.prepared?.text).not.toContain(f.content.text);
    expect(visibleView([entry], { ...binding, db: "another-db" }).knowledgeCommitIds.size).toBe(0);
  } finally { f.memory.close(); }
});

test("64a: current knowledge stays fully readable, but the Consolidator writes only a new create", async () => {
  const f = fixture(input => {
    expect(input).not.toHaveProperty("readKnowledgeCommits");
    const read = completeRead(input.tools[0]!, "K1@v1");
    expect(read).toContain(`K1#${f.memory.store.versionTag(1, 1)}`);
    // The shared paginator helper rejoins split lines without their receipt framing.
    expect(read).toContain(f.content.text);
    // A read produces frozen output only; it never mutates the dispatch snapshot.
    expect(input).not.toHaveProperty("readKnowledgeCommits");

    const create = { operations: [{ op: "create", ...f.content, text: "A distinct durable rule" }], skipped: [] };
    expect(input.tools[3]!.execute(create)).toContain("committed");
    input.reportRequest({ fixture: "create-only processing material" });
  });
  try {
    const result = await f.memory.consolidate(f.target);
    expect(result.outcome, JSON.stringify(result)).toBe("success");
  } finally { f.memory.close(); }
});
