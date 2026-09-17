import { expect, test } from "vitest";
import { sourceSeededMemory, visibleView, type ConsolidationAgentInput } from "../../source-fixture.ts";
import { freezeConsolidation } from "../../../src/core/consolidation/index.ts";
import { setKnowledgeInjection } from "../../knowledge-budget-fixture.ts";

function fixture(agent: (input: ConsolidationAgentInput) => void = () => {}) {
  const memory = sourceSeededMemory(":memory:", async raw => { agent(raw as ConsolidationAgentInput); return { outcome: "success", output: "done" }; });
  const p = memory.store.createProject({ name: "A", declaredBy: "mark" });
  const s = memory.store.createSession({ host: "test", enrollmentChoice: true, projectId: p.id, startedAt: "now", firstReplyAt: "now" });
  const turn = memory.store.appendTurn({ sessionId: s.id, kind: "turn", userPrompt: "Use this rule", startedAt: "now" });
  const tools = memory.tools({ kind: "manual", sessionId: s.id, branch: "main", currentTurnId: turn.id });
  tools[2]!.execute({ facts: [{ category: "decision", actor: "user", text: "rule", source: ["T1#user"] }] });
  const content = { text: "word ".repeat(5_200), category: "constraint", scope: "project", supports: ["F1"], topics: [], reason: "test" };
  expect(tools[3]!.execute({ operations: [{ op: "create", ...content }], skipped: [] })).toContain("committed");
  // Ticket 45 retired the tiny per-Consolidator test cap. Zero owner pools derive the minimum
  // 5,000-token worker capacity; this deliberately oversized body still exercises omission.
  setKnowledgeInjection(memory, 5_000);
  const target = { sessionId: s.id, branch: "main", headTurnId: turn.id };
  const freeze = (extra = {}) => freezeConsolidation(memory.store, { ...target, ...extra }, memory.config);
  return { memory, tools, content, target, freeze };
}

function completeRead(tool: ConsolidationAgentInput["tools"][number], address: string): string {
  let page = tool.execute({ address, itemBudget: null }), text = page;
  for (let cursor = /cursor=(\S+)/.exec(page)?.[1]; cursor; cursor = /cursor=(\S+)/.exec(page)?.[1]) {
    page = tool.execute({ address, cursor, itemBudget: null });
    text += page;
  }
  return text;
}

test("32: omitted candidate grants no handle; explicit full trace grants only the read exact version", async () => {
  const f = fixture(input => {
    expect(input.readKnowledgeCommits).toEqual([]);
    expect(input.text).not.toContain("word ".repeat(400));
    const batch = { operations: [{ op: "update", id: "K1@1", ...f.content }], skipped: [] };
    expect(input.tools[3]!.execute(batch)).toContain("not read as visible and active");
    expect(completeRead(input.tools[0]!, "K1@1")).toContain("[K1@1]");
    expect(input.tools[3]!.execute(batch)).toContain("feedback");
    input.reportRequest({ delivered: true });
    expect(input.tools[3]!.execute(batch)).toContain("committed");
  });
  try {
    expect(f.freeze().knowledge).toHaveLength(1);
    expect(f.freeze().prepared?.readKnowledgeCommits).toEqual([]);
    const result = await f.memory.consolidate(f.target);
    expect(result).toMatchObject({ outcome: "success" });
  } finally { f.memory.close(); }
});

test("32: complete reminder and validated inherited carrier share the builder's exact read list", () => {
  const f = fixture();
  try {
    f.tools[2]!.execute({ facts: [{ category: "decision", actor: "user", text: "withdraw", source: ["T1#user"], negate: [["F1", "strong"]] }] });
    const reminder = f.freeze();
    expect(reminder.prepared?.supplied.knowledgeCommitIds).toEqual([]);
    expect(reminder.prepared?.material.reminders.join()).toContain(f.content.text);
    expect(reminder.prepared?.readKnowledgeCommits).toEqual([{ knowledgeId: 1, commit: 1 }]);
    // The carrier takes its identities from the actual untruncated injection, not a candidate scan.
    setKnowledgeInjection(f.memory, 20_000);
    const injection = f.memory.injection(f.target);
    expect(injection.text).toContain(f.content.text);
    const binding = { db: "fixture-db", session: 1, pi: "fixture-pi" };
    const entry = { id: "injection", type: "custom_message", customType: "trace-memory", details: { traceMemory: {
      ...binding, supplied: { entries: [], factIds: [], knowledgeCommitIds: injection.knowledgeCommitIds },
    } } };
    const visible = visibleView([entry], binding);
    const inherited = f.freeze({ mode: "fork", visible });
    expect(inherited.prepared?.supplied.knowledgeCommitIds).toEqual([]);
    expect(inherited.prepared?.readKnowledgeCommits).toEqual([{ knowledgeId: 1, commit: 1 }]);
    expect(visibleView([entry], { ...binding, db: "another-db" }).knowledgeCommitIds.size).toBe(0);
  } finally { f.memory.close(); }
});

test("payload-free acknowledgement promotes pending NEAR full-body authority only for the later generation", async () => {
  const f = fixture(input => {
    input.acknowledgeRequest();
    const candidate = { operations: [{ op: "create", ...f.content }], skipped: [] };
    expect(input.readKnowledgeCommits).toEqual([]);
    const feedback = input.tools[3]!.execute(candidate);
    expect(feedback).toContain("K1@1");
    const update = { operations: [{ op: "update", id: "K1@1", ...f.content }], skipped: [] };
    expect(input.tools[3]!.execute(update)).toContain("feedback has not been read yet");
    input.acknowledgeRequest();
    expect(input.tools[3]!.execute(update)).toContain("committed");
  });
  try { expect((await f.memory.consolidate(f.target)).outcome).toBe("success"); }
  finally { f.memory.close(); }
});

test("32: NEAR full-body read is granted only after the existing requestSeen delivery gate", async () => {
  const f = fixture(input => {
    const candidate = { operations: [{ op: "create", ...f.content }], skipped: [] };
    expect(input.readKnowledgeCommits).toEqual([]);
    const feedback = input.tools[3]!.execute(candidate);
    expect(feedback).toContain("K1@1");
    const update = { operations: [{ op: "update", id: "K1@1", ...f.content }], skipped: [] };
    expect(input.tools[3]!.execute(update)).toContain("feedback has not been read yet");
    input.reportRequest({ feedbackDelivered: true });
    expect(input.tools[3]!.execute(update)).toContain("committed");
  });
  try { expect((await f.memory.consolidate(f.target)).outcome).toBe("success"); }
  finally { f.memory.close(); }
});


test("34b: a concurrent successor is not granted by review feedback and must be read before correction", async () => {
  const f = fixture(input => {
    expect(input.readKnowledgeCommits).toEqual([]);
    const feedback = input.tools[3]!.execute({ operations: [{ op: "create", ...f.content }], skipped: [] });
    expect(feedback).toContain("K1@1");
    expect(feedback).toContain(f.content.text);
    completeRead(f.tools[0]!, "K1@1");
    expect(f.tools[3]!.execute({ operations: [{ op: "update", id: "K1@1", ...f.content, text: "UNREAD CONCURRENT VERSION" }], skipped: [] })).toContain("committed");
    const update = (id: string) => input.tools[3]!.execute({ operations: [{ op: "update", id, ...f.content }], skipped: [] });
    expect(update("K1@1")).toContain("feedback has not been read yet");
    input.reportRequest({ feedbackDelivered: true });
    // Legacy-shaped fixture origins are explicitly unknown; feedback still grants only the old body.
    expect(update("K1@1")).toContain("trigger ancestry is unknown");
    expect(update("K1@2")).toContain("knowledge was not read");
    input.reportRequest({ anotherRequest: true });
    expect(update("K1@2")).toContain("knowledge was not read");
    completeRead(input.tools[0]!, "K1@2");
    expect(update("K1@2")).toContain("committed");
  });
  try {
    const result = await f.memory.consolidate(f.target);
    expect(result).toMatchObject({ outcome: "success" });
  } finally { f.memory.close(); }
});
