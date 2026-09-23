import { expect, test } from "vitest";
import { DEFAULT_CONFIG, validateConfig } from "../../../src/core/api/index.ts";

// 73 supersedes 64c ruling 6 (the shared allowance derived as the sum of every trigger) and 68 R5
// ("the shared allowance stays derived, and is not a configuration key"): it is now a fixed
// configuration value, default 10,000, read nothing from the Noting/Consolidation/Dreaming triggers.

test("73: shared allowance defaults to 10,000 and is a plain configuration value", () => {
  expect(DEFAULT_CONFIG.compaction.sharedAllowanceTokens).toBe(10_000);
  expect(validateConfig({}).compaction.sharedAllowanceTokens).toBe(10_000);
});

test("73: shared allowance is configurable and unaffected by trigger changes", () => {
  const configured = validateConfig({ compaction: { sharedAllowanceTokens: 42 } });
  expect(configured.compaction.sharedAllowanceTokens).toBe(42);
  const triggersChanged = validateConfig({ noting: { triggerTokens: 999_999 },
    consolidation: { triggerTokens: 999_999 }, dreaming: { triggerTokens: 999_999 } });
  expect(triggersChanged.compaction.sharedAllowanceTokens).toBe(10_000);
});

test("73: shared allowance rejects a non-positive or unsafe value", () => {
  expect(() => validateConfig({ compaction: { sharedAllowanceTokens: 0 } })).toThrow(/compaction\.sharedAllowanceTokens/);
  expect(() => validateConfig({ compaction: { sharedAllowanceTokens: -1 } })).toThrow(/compaction\.sharedAllowanceTokens/);
  expect(() => validateConfig({ compaction: { sharedAllowanceTokens: 1.5 } })).toThrow(/compaction\.sharedAllowanceTokens/);
});
