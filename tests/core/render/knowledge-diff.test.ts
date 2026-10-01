import { expect, test } from "vitest";
import type { KnowledgeRevision } from "../../../src/core/model/index.ts";
import { renderKnowledgeDiff } from "../../../src/core/render/index.ts";

const baseline: KnowledgeRevision = {
  id: 1, knowledgeId: 1, parentId: null, text: "A stable explanation.", category: "mechanism",
  scope: "project", supports: [], supportSemantics: "change", op: "create", reason: "Initial explanation",
  topics: [], runId: null, createdAt: "2026-10-01T00:00:00Z",
};

test.each([undefined, new Set(["status"]), new Set(["text", "status"])])(
  "knowledge diff shows raw category changes within the same display group (fields=%s)", fields => {
    const current: KnowledgeRevision = { ...baseline, id: 2, parentId: 1, category: "understanding", op: "update" };
    expect(renderKnowledgeDiff(baseline, current, [baseline, current], Infinity, fields))
      .toContain("category: mechanism -> understanding");
    expect(renderKnowledgeDiff(baseline, { ...current, category: "mechanism" }, [], Infinity, fields))
      .not.toContain("category:");
  },
);

test("knowledge diff still honors the status field selection", () => {
  const current: KnowledgeRevision = { ...baseline, id: 2, parentId: 1, category: "understanding", op: "update" };
  expect(renderKnowledgeDiff(baseline, current, [], Infinity, new Set(["text"]))).not.toContain("category:");
});
