import { expect, test } from "vitest";
import { renderDreamingCheckReceipt, type DreamingCheckResult } from "../../../src/core/dreaming/check-receipt.ts";
import { tokens } from "../../../src/core/render/index.ts";

function check(overrides: Partial<DreamingCheckResult> = {}): DreamingCheckResult {
  return {
    family: [4, 7],
    suppliedEventIds: [11, 12],
    eventIds: [11],
    retainedEventIds: [11, 12],
    candidateIds: [21, 22, 23],
    resultIds: [22, 23],
    consumedInputIds: [21],
    pendingEventIds: [11, 12, 13, 14],
    versions: [
      { knowledgeId: 4, commit: 21, processed: false, successorCommits: [22] },
      { knowledgeId: 4, commit: 22, processed: false, successorCommits: [] },
      { knowledgeId: 7, commit: 23, processed: true, successorCommits: [] },
    ],
    verifiedConsumedBases: [],
    totals: [
      { scope: "session:9", tokens: 1_002, cap: 1_000 },
      { scope: "applicable:S9/side/T45", tokens: 12_000, cap: 15_000 },
      { scope: "global", tokens: 4_001, cap: 4_000 },
      { scope: "project:7", tokens: 10_001, cap: 10_000 },
      { scope: "applicable:S9/main/T44", tokens: 12_000, cap: 15_000 },
    ],
    externalSuccessors: [],
    operationFailures: ["memory batch 2 rejected"],
    failures: ["memory batch 2 rejected", "global is over", "project:7 is over", "session:9 is over"],
    problems: ["memory batch 2 rejected", "global is over", "project:7 is over", "project:7 is over", "session:9 is over"],
    remainingRounds: 48,
    repairAvailable: true,
    ...overrides,
  };
}

test("35b: receipt reports actionable owner budgets, a stable equal maximum, canonical counts, and every blocker", () => {
  const full = check();
  const before = structuredClone(full);
  const receipt = renderDreamingCheckReceipt(full);

  expect(full).toEqual(before);
  expect(receipt).toContain("- global: used 4001 / limit 4000 / headroom -1");
  expect(receipt).toContain("- project:7: used 10001 / limit 10000 / headroom -1");
  expect(receipt).toContain("- session:9: used 1002 / limit 1000 / headroom -2");
  expect(receipt).toContain("Maximum applicable projection (2 checked):\n- applicable:S9/main/T44: used 12000 / limit 15000 / headroom +3000");
  expect(receipt).not.toContain("applicable:S9/side/T45");
  expect(receipt).toContain("- frozen family: 2");
  expect(receipt).toContain("- supplied formal events: 2");
  expect(receipt).toContain("- accounted formal events: 1");
  expect(receipt).toContain("- pending work: 4");
  expect(receipt).toContain("- host-derived candidates: 3");
  expect(receipt).toContain("- successor-free results: 2");
  expect(receipt).toContain("- consumed inputs: 1");
  expect(receipt).toContain("- external successors: 0");
  expect(receipt).toContain("- operation failures: 1");
  expect(receipt).toContain("- remaining tool rounds: 48");
  expect(receipt).toContain("- repair available: yes");
  expect(receipt).toContain("- memory batch 2 rejected");
  expect(receipt).toContain("- global is over");
  expect(receipt).toContain("- project:7 is over (2 occurrences)");
  expect(receipt).toContain("- session:9 is over");
});

test("35b: a passing receipt explicitly has no blockers and handles an empty applicable projection", () => {
  const receipt = renderDreamingCheckReceipt(check({
    suppliedEventIds: [], eventIds: [], retainedEventIds: [], candidateIds: [], resultIds: [], consumedInputIds: [],
    pendingEventIds: [], versions: [], totals: [{ scope: "global", tokens: 0, cap: 4_000 }], operationFailures: [], failures: [],
    problems: [], remainingRounds: 0, repairAvailable: false,
  }));

  expect(receipt).toContain("Maximum applicable projection (0 checked): none");
  expect(receipt).toContain("Blockers: none");
  expect(receipt).toContain("- repair available: no");
});

test("35b: hundreds of normal paths and version rows are omitted, while every distinct failure remains visible", () => {
  const manyPaths = Array.from({ length: 300 }, (_, index) => ({
    scope: `applicable:S${index + 1}/main/T${index + 100}`,
    tokens: 1_000 + index,
    cap: 15_000,
  }));
  const versions = Array.from({ length: 400 }, (_, index) => ({
    knowledgeId: index + 1,
    commit: index + 10,
    processed: true,
    successorCommits: [],
  }));
  const normal = check({
    candidateIds: versions.map(version => version.commit), resultIds: versions.map(version => version.commit), versions,
    totals: [
      { scope: "global", tokens: 3_000, cap: 4_000 },
      { scope: "project:7", tokens: 8_000, cap: 10_000 },
      { scope: "session:9", tokens: 500, cap: 1_000 },
      ...manyPaths,
    ],
    operationFailures: [], failures: [], problems: [],
  });
  const normalReceipt = renderDreamingCheckReceipt(normal);
  const distinct = Array.from({ length: 120 }, (_, index) => `K${index + 1}@${index + 500}: distinct cause ${index + 1}`);
  const errors = check({
    totals: normal.totals, operationFailures: distinct, failures: distinct, problems: [...distinct, distinct[0]!],
  });
  const errorReceipt = renderDreamingCheckReceipt(errors);

  expect(normalReceipt).toContain("Maximum applicable projection (300 checked):");
  expect(normalReceipt).toContain("applicable:S300/main/T399");
  expect(normalReceipt).not.toContain("applicable:S299/main/T398");
  expect(normalReceipt).not.toContain('"knowledgeId"');
  expect(normalReceipt).not.toContain('"successorCommits"');
  expect(tokens(normalReceipt)).toBeLessThan(tokens(JSON.stringify(normal)) / 10);
  for (const problem of distinct) expect(errorReceipt).toContain(problem);
  expect(errorReceipt).toContain(`${distinct[0]} (2 occurrences)`);

  console.log(JSON.stringify({
    checkReceiptTokens: {
      small: tokens(renderDreamingCheckReceipt(check({
        totals: normal.totals.slice(0, 4), operationFailures: [], failures: [], problems: [],
      }))),
      manyPaths: tokens(normalReceipt),
      manyErrors: tokens(errorReceipt),
    },
  }));
});
