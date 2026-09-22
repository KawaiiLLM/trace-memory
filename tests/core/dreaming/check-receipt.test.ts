import { expect, test } from "vitest";
import { renderDreamingCheckReceipt, type DreamingCheckResult } from "../../../src/core/dreaming/check-receipt.ts";
import { tokens } from "../../../src/core/render/index.ts";

function check(overrides: Partial<DreamingCheckResult> = {}): DreamingCheckResult {
  return {
    pool: "project:7",
    frozenRevisionIds: [11, 12],
    ownRevisionIds: [21, 22],
    pendingRevisionIds: [30],
    totals: [
      { pool: "global", tokens: 4_001, budget: 4_000 },
      { pool: "project:7", tokens: 12_000, budget: 15_000 },
      { pool: "session:9", tokens: 1_002, budget: 1_000 },
    ],
    operationFailures: ["memory batch 2 rejected"],
    problems: ["memory batch 2 rejected"],
    ...overrides,
  };
}

test("64c receipt reports the frozen pool, exact processing sets, pool budgets and blockers without mutating audit", () => {
  const full = check(), before = structuredClone(full);
  const receipt = renderDreamingCheckReceipt(full);

  expect(full).toEqual(before);
  expect(receipt).toContain("Dreamer pool check:");
  expect(receipt).toContain("- frozen pool: project:7");
  expect(receipt).toContain("- frozen current revisions: 2 (11, 12)");
  expect(receipt).toContain("- own resulting revisions: 2 (21, 22)");
  expect(receipt).toContain("- newly pending revisions: 1 (30)");
  expect(receipt).toContain("- global: 4001/4000 tokens");
  expect(receipt).toContain("- project:7: 12000/15000 tokens");
  expect(receipt).toContain("- session:9: 1002/1000 tokens");
  expect(receipt).toContain("- operation failures: memory batch 2 rejected");
  expect(receipt).toContain("Blockers: memory batch 2 rejected");
  expect(receipt).not.toMatch(/certif|successor-free|repair available|intensity/i);
});

test("64c passing receipt explicitly has no blockers and handles empty exact sets", () => {
  const receipt = renderDreamingCheckReceipt(check({
    pool: "global", frozenRevisionIds: [], ownRevisionIds: [], pendingRevisionIds: [],
    totals: [{ pool: "global", tokens: 0, budget: 4_000 }], operationFailures: [], problems: [],
  }));
  expect(receipt).toContain("- frozen pool: global");
  expect(receipt).toContain("- frozen current revisions: 0 (none)");
  expect(receipt).toContain("- own resulting revisions: 0 (none)");
  expect(receipt).toContain("- newly pending revisions: 0 (none)");
  expect(receipt).toContain("- operation failures: none");
  expect(receipt).toContain("Blockers: none");
});

test("64c receipt remains bounded by counts rather than serializing version bodies", () => {
  const ids = Array.from({ length: 400 }, (_, index) => index + 1);
  const receipt = renderDreamingCheckReceipt(check({
    frozenRevisionIds: ids, ownRevisionIds: ids.slice(0, 100), pendingRevisionIds: ids.slice(100),
    operationFailures: [], problems: [],
  }));
  expect(receipt).toContain("frozen current revisions: 400");
  expect(receipt).not.toContain("knowledgeId");
  expect(tokens(receipt)).toBeLessThan(tokens(JSON.stringify(ids)) * 3);
});
