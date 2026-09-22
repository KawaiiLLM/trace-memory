import { expect, test } from "vitest";
import { deriveSharedMaterialAllowance } from "../../../src/core/api/index.ts";

test("68: shared allowance sums one configured trigger per phase and ignores pool budgets", () => {
  expect(deriveSharedMaterialAllowance({ noting: 10_000, consolidation: 5_000, dreaming: 5_000 })).toBe(20_000);
  expect(deriveSharedMaterialAllowance({ noting: 11, consolidation: 13, dreaming: 17 })).toBe(41);
});

test("68: shared allowance rejects unsafe triggers and an unsafe derived sum", () => {
  expect(() => deriveSharedMaterialAllowance({ noting: -1, consolidation: 1, dreaming: 1 }))
    .toThrow(/noting trigger must be a nonnegative safe integer/);
  expect(() => deriveSharedMaterialAllowance({
    noting: Number.MAX_SAFE_INTEGER, consolidation: 1, dreaming: 1,
  })).toThrow(/derived shared material allowance must be a safe integer/);
});
