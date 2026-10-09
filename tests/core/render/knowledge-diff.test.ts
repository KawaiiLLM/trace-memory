import { expect, test } from "vitest";
import type { KnowledgeRevision } from "../../../src/core/model/index.ts";
import { renderKnowledgeDiff, sentenceDiff } from "../../../src/core/render/index.ts";

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

test("134: full sentence diff shows unchanged text once and adjacent word-marked edit lines", () => {
  const before = { ...baseline, text: "保持这条裁定。" + "Maintain the confirmed scope and all important conditions before using red tiles。\n最后的执行边界。" };
  const after = { ...before, id: 2, parentId: 1, op: "update" as const,
    text: before.text.replace("red", "blue") };
  const result = renderKnowledgeDiff(before, after, [], Infinity, new Set(["text"]));
  expect(result.match(/^  保持这条裁定。$/gm)).toHaveLength(1);
  expect(result).toMatch(/^- Maintain .*using \[-red-\] tiles。$/m);
  expect(result).toMatch(/^\+ Maintain .*using \{\+blue\+\} tiles。$/m);
  const lines = result.split("\n"), removed = lines.findIndex(line => line.startsWith("- Maintain"));
  expect(lines[removed + 1]).toMatch(/^\+ Maintain .*using \{\+blue\+\} tiles。$/);
  expect(result).toContain("最后的执行边界。");
  expect(result).not.toContain("[...]");
});

test("134: a rewrite sharing only separators stays whole without inner word marks", () => {
  const result = sentenceDiff("alpha beta gamma delta。", "oak pine birch cedar。");
  expect(result.text.split("\n")).toEqual(["- alpha beta gamma delta。", "+ oak pine birch cedar。"]);
  expect(result.text).not.toMatch(/\[-|\{\+/);
});

test("134: inserted and deleted sentences stay at their positions beside unchanged sentences", () => {
  const result = sentenceDiff("开头。应当移除！保留结尾。", "新插入？开头。保留结尾。");
  expect(result.text.split("\n")).toEqual(["+ 新插入？", "  开头。", "- 应当移除！", "  保留结尾。"]);
});

test("134: pairing takes the first half-overlap candidate, not a later better match", () => {
  const result = sentenceDiff("alpha beta gamma delta。", "alpha beta oak pine。alpha beta gamma fox。");
  const lines = result.text.split("\n");
  expect(lines[0]).toMatch(/^- alpha beta /);
  expect(lines[1]).toContain("{+oak+}");
  expect(lines[1]).toContain("{+pine+}");
  expect(lines[2]).toBe("+ alpha beta gamma fox。");
});

test("134: pairing never reuses an addition before the preceding pair", () => {
  const result = sentenceDiff("alpha beta gamma delta。green yellow purple orange。",
    "green yellow purple coal。alpha beta gamma silver。");
  expect(result.text.split("\n")).toContain("- green yellow purple orange。");
  expect(result.text.split("\n")).toContain("+ green yellow purple coal。");
});

function reconstructed(text: string, side: "old" | "new") {
  const starts = [...text.matchAll(/^(  |- |\+ )/gm)];
  return starts.map((match, index) => {
    const prefix = match[0];
    if (prefix === (side === "old" ? "+ " : "- ")) return "";
    const body = text.slice(match.index! + 2, index + 1 < starts.length ? starts[index + 1]!.index! - 1 : text.length);
    return body.replace(/\[-([\s\S]*?)-\]/g, side === "old" ? "$1" : "")
      .replace(/\{\+([\s\S]*?)\+\}/g, side === "new" ? "$1" : "");
  }).join("");
}

test.each([
  ["固定。旧条件；末尾！", "固定。新条件；末尾！"],
  ["  保留缩进。\n\n最后。", "  保留缩进。\n插入一行。\n最后。"],
  ["a red tile。\r\nlast line\n", "a blue tile。last line\n"],
  ["use red tiles and keep every condition\n", "use blue tiles and keep every condition。"],
  ["重复。重复。旧句？", "重复。新句？重复。"],
  ["", "新增；\n"],
  ["移除。\n", ""],
  ["。；！？\n", "；！？\n。"],
])("134: unified diff losslessly reconstructs both bodies (%s → %s)", (before, after) => {
  const result = sentenceDiff(before, after);
  expect(reconstructed(result.text, "old")).toBe(before);
  expect(reconstructed(result.text, "new")).toBe(after);
});
