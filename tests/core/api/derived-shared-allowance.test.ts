import { expect, test } from "vitest";
import { deriveSharedMaterialAllowance } from "../../../src/core/api/index.ts";

test("64c shared allowance sums the current N/C triggers and each current Dreamer trigger", () => {
  expect(deriveSharedMaterialAllowance(
    { global: 4_000, project: 15_000, session: 1_000 },
    { noting: 10_000, consolidation: 5_000 },
  )).toBe(25_000);
  expect(deriveSharedMaterialAllowance(
    { global: 3, project: 5, session: 7 },
    { noting: 11, consolidation: 13 },
  )).toBe(2 + 3 + 4 + 11 + 13);
});

test("64c shared allowance rejects unsafe authorities and an unsafe derived sum", () => {
  expect(() => deriveSharedMaterialAllowance(
    { global: 0, project: 0, session: 0 }, { noting: -1, consolidation: 1 },
  )).toThrow(/noting trigger or budget must be a nonnegative safe integer/);
  expect(() => deriveSharedMaterialAllowance(
    { global: Number.MAX_SAFE_INTEGER, project: 0, session: 0 },
    { noting: Number.MAX_SAFE_INTEGER, consolidation: 1 },
  )).toThrow(/derived shared material allowance must be a safe integer/);
});
