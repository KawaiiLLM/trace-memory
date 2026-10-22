import { expect, test } from "vitest";
import { DEFAULT_CONFIG, validateConfig } from "../../../src/core/api/index.ts";

// 144 stage 4 (2026-10-22): one temporary allowance per context replaces the Knowledge-only shared allowance
// (73) and ticket 133's separate temporary allowance. It is a fixed configuration value read from no trigger.

test("the temporary allowance defaults to 10,000 and is a plain configuration value", () => {
  expect(DEFAULT_CONFIG.compaction.temporaryTokens).toBe(10_000);
  expect(validateConfig({}).compaction.temporaryTokens).toBe(10_000);
  expect(validateConfig({ compaction: { temporaryTokens: 42 } }).compaction.temporaryTokens).toBe(42);
  expect(validateConfig({ noting: { triggerTokens: 999_999 }, dreaming: { triggerTokens: 999_999 } }).compaction.temporaryTokens).toBe(10_000);
});

test("the Knowledge-only shared allowance is a removed setting that names its replacement", () => {
  expect(() => validateConfig({ compaction: { sharedAllowanceTokens: 10_000 } } as never)).toThrow(/Removed setting compaction\.sharedAllowanceTokens: one temporary allowance, compaction\.temporaryTokens/);
});

test("the temporary allowance rejects an unsafe value", () => {
  expect(() => validateConfig({ compaction: { temporaryTokens: -1 } })).toThrow(/compaction\.temporaryTokens/);
  expect(() => validateConfig({ compaction: { temporaryTokens: 1.5 } })).toThrow(/compaction\.temporaryTokens/);
});
