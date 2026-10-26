import { expect, test } from "vitest";
import { DEFAULT_CONFIG, validateConfig } from "../../../src/core/api/index.ts";

// 182 supersedes 165's body and pointer pools: one shared temporary pool.
test("the one shared temporary pool defaults to 10,000 and can be configured", () => {
  expect(DEFAULT_CONFIG.compaction.temporaryTokens).toBe(10_000);
  expect(DEFAULT_CONFIG.compaction).not.toHaveProperty("pointerTokens");
  expect(validateConfig({ compaction: { temporaryTokens: 42 } }).compaction)
    .toMatchObject({ temporaryTokens: 42 });
});

test("the Knowledge-only shared allowance is a removed setting that names its replacement", () => {
  expect(() => validateConfig({ compaction: { sharedAllowanceTokens: 10_000 } } as never)).toThrow(/Removed setting compaction\.sharedAllowanceTokens/);
});

test("the pointer pool is a removed setting that names the shared pool", () => {
  expect(() => validateConfig({ compaction: { pointerTokens: 10_000 } } as never))
    .toThrow(/Removed setting compaction\.pointerTokens: .*compaction\.temporaryTokens/);
});

test("the temporary allowance rejects an unsafe value", () => {
  expect(() => validateConfig({ compaction: { temporaryTokens: -1 } })).toThrow(/compaction\.temporaryTokens/);
  expect(() => validateConfig({ compaction: { temporaryTokens: 1.5 } })).toThrow(/compaction\.temporaryTokens/);
});
