import { expect, test } from "vitest";
import { DEFAULT_CONFIG, validateConfig } from "../../../src/core/api/index.ts";

// 165 supersedes 144's one-pool default.
test("body and pointer pools each default to 10,000 and can be configured independently", () => {
  expect(DEFAULT_CONFIG.compaction.temporaryTokens).toBe(10_000);
  expect(DEFAULT_CONFIG.compaction.pointerTokens).toBe(10_000);
  expect(validateConfig({ compaction: { temporaryTokens: 42, pointerTokens: 73 } }).compaction)
    .toMatchObject({ temporaryTokens: 42, pointerTokens: 73 });
});

test("the Knowledge-only shared allowance is a removed setting that names its replacement", () => {
  expect(() => validateConfig({ compaction: { sharedAllowanceTokens: 10_000 } } as never)).toThrow(/Removed setting compaction\.sharedAllowanceTokens/);
});

test("the temporary allowance rejects an unsafe value", () => {
  expect(() => validateConfig({ compaction: { temporaryTokens: -1 } })).toThrow(/compaction\.temporaryTokens/);
  expect(() => validateConfig({ compaction: { temporaryTokens: 1.5 } })).toThrow(/compaction\.temporaryTokens/);
  expect(() => validateConfig({ compaction: { pointerTokens: -1 } })).toThrow(/compaction\.pointerTokens/);
  expect(() => validateConfig({ compaction: { pointerTokens: 1.5 } })).toThrow(/compaction\.pointerTokens/);
});
