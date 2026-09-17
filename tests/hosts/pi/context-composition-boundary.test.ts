import { expect, test } from "vitest";
import { buildSessionContext, convertToLlm, estimateTokens, SessionManager } from "@earendil-works/pi-coding-agent";
import { compactText } from "../../../src/core/render/material.ts";
import { visibleView } from "../../../src/hosts/pi/visible.ts";

// Characterization probes for the approved composition work, not a composition implementation.
const binding = { db: ":memory:", session: 1, pi: "composition-probe" };
const details = { traceMemory: { ...binding, supplied: {
  entries: [{ id: 1, nativeId: "source", view: "bounded" as const }], factIds: [1], knowledgeCommitIds: [],
} } };

test("old rendered material cannot uniquely identify a Facts/Raw boundary from headings", () => {
  const left = { facts: ["fact\n\nRaw:\n\ninside"], entries: [{ id: 1, view: "outside" }], receipts: [] };
  const right = { facts: ["fact"], entries: [{ id: 1, view: "inside\n\nRaw:\n\noutside" }], receipts: [] };
  expect(compactText(left)).toBe(compactText(right));
  expect(left.facts.join("\n").length).not.toBe(right.facts.join("\n").length);
  // Both contracts may carry the same identity arrays; these arrays carry no text offsets.
  expect(Object.keys(details.traceMemory.supplied)).toEqual(["entries", "factIds", "knowledgeCommitIds"]);
});

test("coverage is identity evidence, not a measurement of repeated carrier text", () => {
  const sm = SessionManager.inMemory("/tmp/tm-dreamer-implementation-o7hEUc/context-composition");
  sm.appendCustomMessageEntry("trace-memory", "same material", false, details);
  sm.appendCustomMessageEntry("trace-memory", "same material", false, details);
  const entries = sm.buildContextEntries();
  const coverage = visibleView(entries, binding);
  expect(coverage.factIds.size).toBe(1);
  expect(coverage.raw.size).toBe(1);
  const messages = sm.buildSessionContext().messages;
  expect(messages).toHaveLength(2);
  expect(messages.reduce((sum, message) => sum + estimateTokens(message), 0)).toBe(8);
});

test("public SDK selects retained originals by firstKeptEntryId and selected ancestry", () => {
  const sm = SessionManager.inMemory("/tmp/tm-dreamer-implementation-o7hEUc/context-composition");
  const discarded = sm.appendMessage({ role: "user", content: "discarded", timestamp: 1 });
  const kept = sm.appendMessage({ role: "user", content: "retained", timestamp: 2 });
  const first = sm.appendCompaction("same summary", kept, 500, undefined, false);
  const after = sm.appendMessage({ role: "user", content: "after", timestamp: 3 });
  expect(sm.buildContextEntries().map(entry => entry.id)).toEqual([first, kept, after]);
  const second = sm.appendCompaction("same summary", "", 200, details, true);
  expect(sm.buildContextEntries().map(entry => entry.id)).toEqual([second]);
  sm.branch(after);
  expect(sm.buildContextEntries().map(entry => entry.id)).toEqual([first, kept, after]);
  sm.branch(discarded);
  expect(sm.buildContextEntries().map(entry => entry.id)).toEqual([discarded]);
});

test("a user pasted carrier tag is conversation, while SDK summaries add separate framing", () => {
  const sm = SessionManager.inMemory("/tmp/tm-dreamer-implementation-o7hEUc/context-composition");
  sm.appendMessage({ role: "user", content: '<knowledge>[K1@1] user paste</knowledge>', timestamp: 1 });
  expect(visibleView(sm.buildContextEntries(), binding).knowledgeCommitIds.size).toBe(0);
  sm.appendCompaction("native summary", "", 500, undefined, false);
  const messages = sm.buildSessionContext().messages;
  const converted = convertToLlm(messages);
  expect(messages[0]?.role).toBe("compactionSummary");
  expect(converted[0]?.role).toBe("user");
  expect(JSON.stringify(converted[0])).toContain("The conversation history before this point was compacted");
  expect(estimateTokens(converted[0]!)).toBeGreaterThan(estimateTokens(messages[0]!));
});

test("context entry presence alone does not establish final LLM inclusion", () => {
  const sm = SessionManager.inMemory("/tmp/tm-dreamer-implementation-o7hEUc/context-composition");
  sm.appendMessage({ role: "bashExecution", command: "echo private", output: "private", exitCode: 0,
    cancelled: false, truncated: false, excludeFromContext: true, timestamp: 1 });
  const entries = sm.buildContextEntries();
  expect(entries).toHaveLength(1);
  const messages = buildSessionContext(entries).messages;
  expect(messages).toHaveLength(1);
  expect(convertToLlm(messages)).toEqual([]);
});
