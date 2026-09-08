import { expect, test } from "vitest";
import { compactText } from "../../../src/core/render/material.ts";

// Seen on the 2026-09-08 live compaction check: with no active knowledge the custom summary began with
// two blank lines. Empty knowledge renders no block, so nothing precedes the episodic block either.
test("compact text with no knowledge starts at the episodic block, not at a separator", () => {
  const text = compactText({ knowledge: [], facts: [], entries: [{ id: 1, view: "[S1/T1] view" }], receipts: [] });
  expect(text.startsWith("<episodic>")).toBe(true);
  const withKnowledge = compactText({ knowledge: [{ category: "constraint", text: "[K1@1] rule" }], facts: [], entries: [], receipts: [] });
  expect(withKnowledge.startsWith("<knowledge>")).toBe(true);
  expect(withKnowledge).toContain("</knowledge>\n\n<episodic>");
});
