import { expect, test } from "vitest";
import { knowledgeStateKey, noVisibility, type VisibleView } from "../../../src/core/api/index.ts";

test("53: the host-neutral empty view carries no visible material", () => {
  expect(noVisibility()).toEqual({ raw: new Map(), factIds: new Set(), knowledgeCommitIds: new Set(),
    injection: false, suppliedGeneration: 0 });
});

test("53: state notice identities are canonical host-neutral contract values", () => {
  expect(knowledgeStateKey({ fromCommit: 7, toCommits: [11, 13] })).toBe("7>11,13");
});

test("53: the visible contract distinguishes retained source bytes from a bounded supplied view", () => {
  const visible: VisibleView = { raw: new Map([["native-source", "source"], ["native-view", "view"]]),
    rawEntryIds: new Map([[4, "native-view"]]), factIds: new Set([2]), knowledgeCommitIds: new Set([9]),
    knowledgeStates: new Set(["7>11"]), injection: true, suppliedGeneration: 3 };
  expect([...visible.raw]).toEqual([["native-source", "source"], ["native-view", "view"]]);
  expect(visible.rawEntryIds?.get(4)).toBe("native-view");
});
