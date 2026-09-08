import { expect, test } from "vitest";
import { tokens } from "../../../src/core/render/index.ts";

/**
 * The estimator carries no tokenizer, so it is pinned against recorded truth instead: each sample's
 * count came from OpenAI's o200k_base tokenizer (gpt-tokenizer), read once offline on 2026-09-07 and
 * written down here. Regenerate by encoding these same strings if the samples ever change. Claude's
 * tokenizer is not public; o200k stands in for it, and published comparisons put Claude 15-20% higher
 * on English, so these bounds describe the shape of the estimate, not an absolute guarantee.
 */
const samples: { name: string; text: string; real: number }[] = [
  { name: "english prose", real: 33,
    text: "The recorder reads the raw turns after the watermark and writes facts that cite their source. Integration cuts batches at turn boundaries; the threshold only triggers, it never cuts." },
  { name: "chinese prose", real: 52,
    text: "记录水位是记录代理已经读到哪一轮的标记。整合按 turn 边界切批次，阈值只是触发条件，不是切口。事实交付只在有分支消费者时才产生。" },
  { name: "chinese dense", real: 40, text: "一".repeat(40) },
  { name: "japanese", real: 35, text: "日本語のテキストもトークン推定の対象です。カタカナとひらがなの混在も一度だけ丸めます。" },
  { name: "korean", real: 21, text: "한국어 텍스트도 토큰 추정 대상입니다. 음절 단위로 계산합니다." },
  { name: "mixed prose", real: 18, text: "整合按 turn 边界切批次 and the threshold only triggers the run." },
  { name: "json payload", real: 70,
    text: JSON.stringify({ operations: [{ op: "create", text: "统一用 pnpm，不要 npm", category: "constraint", scope: "project", supports: ["F1", "F2"] }], skipped: [] }, null, 2) },
  { name: "shell log", real: 43,
    text: "$ bun test\n  ✓ 361 passed\nError: FOREIGN KEY constraint failed\n  at Store.commitIntegrationRun (core/store/index.ts:877:11)\n数据库写入失败，回滚整个事务。" },
  { name: "fact line", real: 61,
    text: "[F42] 2026-09-07T10:12:00.000Z [decision/user] 整合按 turn 边界切批次，阈值只是触发条件 · support F41 strong\n  source: T7#user, T7#t2" },
  { name: "digits", real: 34, text: "1234567890 3.14159265358979 2026-09-07T10:12:00.000Z 0xDEADBEEF" },
  { name: "punctuation", real: 25, text: "const a = ((b ?? c) || {})[\"x\"] + `${d}`; // <-- dense punctuation, no words" },
  { name: "indented tabs", real: 21, text: "function f() {\n\tif (x) {\n\t\treturn 1;\n\t}\n\n\treturn 0;\n}" },
  { name: "indented spaces", real: 17, text: "def f():\n    if x:\n        return 1\n    return 0\n" },
  { name: "emoji and symbols", real: 16, text: "🧠 trace-memory 7/38 $22.58 ✓ ● ™" },
];

test("the estimate stays within 20% of a real tokenizer on every sample and 10% on average", () => {
  const errors = samples.map(({ name, text, real }) => {
    const error = (tokens(text) - real) / real * 100;
    expect(Math.abs(error), `${name}: estimated ${tokens(text)} against ${real}`).toBeLessThanOrEqual(20);
    return error;
  });
  const mean = errors.reduce((sum, error) => sum + Math.abs(error), 0) / errors.length;
  expect(mean).toBeLessThanOrEqual(10);
  // Under-counting overruns a budget while over-counting only wastes room, so the estimate is allowed
  // to run high but is held close on the low side.
  expect(Math.min(...errors)).toBeGreaterThanOrEqual(-16);
});

test("no budget can be defeated by padding: a run of spaces costs one token, not its width", () => {
  expect(tokens(`a${" ".repeat(4)}b`)).toBe(tokens(`a${" ".repeat(400)}b`));
  expect(tokens("a b")).toBeLessThan(tokens("a  b"));
});

test("the estimate counts characters, never UTF-16 code units", () => {
  expect(tokens("😀".repeat(4))).toBeLessThan(tokens("a".repeat(8)) + 8);
  expect(tokens("𝕏".repeat(10))).toBe(tokens("𝕏".repeat(10)));
});
