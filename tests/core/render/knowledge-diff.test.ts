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

test("knowledge diff with a context width keeps only the changes and that much unchanged text beside them", () => {
  const body = (middle: string) => `${"前文".repeat(30)}${middle}${"后文".repeat(30)}`;
  const before = { ...baseline, text: body("旧版") }, after = { ...baseline, id: 2, parentId: 1, op: "update" as const, text: body("新规") };
  const whole = renderKnowledgeDiff(before, after, [], Infinity, new Set(["text"]));
  const compact = renderKnowledgeDiff(before, after, [], Infinity, new Set(["text"]), undefined, "K1#abcd", 4);
  expect(whole).toContain("前文前文前文前文前文前文前文前文前文前文前文前文前文前文前文前文前文前文前文前文");
  expect(compact).toContain("[K1#abcd]\n  text: [...]前文前文[-旧版-]{+新规+}后文后文[...]");
  expect(compact).not.toContain("Commits:");
});
