import { expect, test } from "vitest";
import type { KnowledgeRevision } from "../../../src/core/model/index.ts";
import { renderKnowledgeDiff, sentenceDiff } from "../../../src/core/render/index.ts";

const baseline: KnowledgeRevision = { files: null,
  id: 1, knowledgeId: 1, parentId: null, title: null, text: "A stable explanation.", category: "mechanism",
  scope: "project", supports: [], supportSemantics: "change", op: "create", reason: "Initial explanation",
  topics: [], runId: null, createdAt: "2026-10-01T00:00:00Z",
};

test.each([undefined, new Set(["status"]), new Set(["text", "status"])])(
  "knowledge diff shows raw category changes within the same display group (fields=%s)", fields => {
    const current: KnowledgeRevision = { files: null, ...baseline, id: 2, parentId: 1, category: "understanding", op: "update" };
    expect(renderKnowledgeDiff(baseline, current, [baseline, current], Infinity, fields))
      .toContain("category: mechanism -> understanding");
    expect(renderKnowledgeDiff(baseline, { ...current, category: "mechanism" }, [], Infinity, fields))
      .not.toContain("category:");
  },
);

test("knowledge diff still honors the status field selection", () => {
  const current: KnowledgeRevision = { files: null, ...baseline, id: 2, parentId: 1, category: "understanding", op: "update" };
  expect(renderKnowledgeDiff(baseline, current, [], Infinity, new Set(["text"]))).not.toContain("category:");
});

test("134: full sentence diff shows unchanged text once and adjacent word-marked edit lines", () => {
  const before = { ...baseline, text: "保持这条裁定。" + "Maintain the confirmed scope and all important conditions before using red tiles。\n最后的执行边界。" };
  const after = { files: null, ...before, id: 2, parentId: 1, op: "update" as const,
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

test("134: a pair needs at least half of the longer sentence's words, not a third", () => {
  // 3 of 7 words are shared: above a third, below a half.
  const result = sentenceDiff("aa bb cc dd ee ff gg。", "aa bb cc xx yy zz ww。");
  expect(result.text.split("\n")).toEqual(["- aa bb cc dd ee ff gg。", "+ aa bb cc xx yy zz ww。"]);
});

test("134: a hunk of several pairs prints each new sentence once and loses nothing", () => {
  const before = "aa bb cc dd。aa bb cc ee。";
  const after = "aa bb cc ff。";
  // Both old sentences resemble the one new sentence; only the first may take it.
  const result = sentenceDiff(before, after);
  expect(result.text.split("\n")).toEqual(["- aa bb cc [-dd-]。", "+ aa bb cc {+ff+}。", "- aa bb cc ee。"]);
  expect(reconstructed(result.text, "old")).toBe(before);
  expect(reconstructed(result.text, "new")).toBe(after);
});

test("134: a semicolon and a newline each end a sentence", () => {
  expect(sentenceDiff("甲乙；丙丁；", "甲乙；戊己；").text.split("\n")).toEqual(["  甲乙；", "- 丙丁；", "+ 戊己；"]);
  expect(sentenceDiff("第一行\n第二行\n", "第一行\n改了\n").text.split("\n"))
    .toEqual(["  第一行", "  ", "- 第二行", "+ 改了", "  "]);
});

test("134: every body newline is exactly one line, so a paragraph break adds no further blank lines", () => {
  const result = sentenceDiff("alpha beta。\n\ngamma delta。", "alpha beta。\n\nepsilon zeta。");
  expect(result.text.split("\n")).toEqual(["  alpha beta。", "  ", "  ", "- gamma delta。", "+ epsilon zeta。"]);
});

test("134: an insertion after a pair comes before the next removed sentence (K2953)", () => {
  const before = "一词答复（如「改」「登记」）一律不引，只转述带条件的规则。仓库 ADR 规范本就是默认转述、逐字引用仅作例外。未说是否扩及其他项目，按项目处理。";
  const after = "一词答复（如「改」「登记」）一律不引，只转述带条件的规则；作为派发许可依据的那句可保留。未说是否扩及其他项目。";
  expect(sentenceDiff(before, after).text.split("\n")).toEqual([
    "- 一词答复（如「改」「登记」）一律不引，只转述带条件的规则[-。-]",
    "+ 一词答复（如「改」「登记」）一律不引，只转述带条件的规则{+；+}",
    "+ 作为派发许可依据的那句可保留。",
    "- 仓库 ADR 规范本就是默认转述、逐字引用仅作例外。",
    "- 未说是否扩及其他项目[-，按项目处理-]。",
    "+ 未说是否扩及其他项目。",
  ]);
});

test("134: an empty change history prints History: none unless the caller omits it", () => {
  const current: KnowledgeRevision = { files: null, ...baseline, id: 2, parentId: 1, text: "A changed explanation.", op: "update" };
  const fields = new Set(["text"]);
  expect(renderKnowledgeDiff(baseline, current, [], Infinity, fields)).toContain("History: none");
  expect(renderKnowledgeDiff(baseline, current, [], Infinity, fields, undefined, undefined, false)).not.toContain("History");
});

test("134: pairing never reuses an addition before the preceding pair", () => {
  const result = sentenceDiff("alpha beta gamma delta。green yellow purple orange。",
    "green yellow purple coal。alpha beta gamma silver。");
  expect(result.text.split("\n")).toContain("- green yellow purple orange。");
  expect(result.text.split("\n")).toContain("+ green yellow purple coal。");
});

// One display line per row: a line shows its row, and an empty content is the row "\n".
function reconstructed(text: string, side: "old" | "new") {
  const keep = side === "old" ? ["  ", "- "] : ["  ", "+ "];
  return (text ? text.split("\n") : []).map(line => {
    if (!keep.includes(line.slice(0, 2))) return "";
    const body = line.slice(2).replace(/\[-([\s\S]*?)-\]/g, side === "old" ? "$1" : "")
      .replace(/\{\+([\s\S]*?)\+\}/g, side === "new" ? "$1" : "");
    return body || "\n";
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
  ["aa bb cc dd。aa bb cc ee。aa bb cc ff。", "aa bb cc xx。aa bb cc yy。aa bb cc zz。"],
  ["bar", "foo\n"],
  ["bar\n", "foo\n"],
  ["a\n\n\nb", "a\nb\n\n"],
])("134: unified diff losslessly reconstructs both bodies (%j → %j)", (before, after) => {
  const result = sentenceDiff(before, after);
  expect(reconstructed(result.text, "old")).toBe(before);
  expect(reconstructed(result.text, "new")).toBe(after);
});
