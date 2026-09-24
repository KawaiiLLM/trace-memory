// Ticket 82: per-host `/trace` menu renderer tests.
//
// Requirement 5 (maintainer correction, 2026-09-24): Claude Code copies its own built-in `/context`
// drawing instead of Pi's `projectComposition` grid, so the cross-host guarantee is no longer "same
// grid pixels" — it is "the shared model's rows (labels, amounts, order) are identical on both
// hosts; the grids are each host's own." Concretely: the Knowledge/Facts/Raw/unclassified-memory
// amounts both hosts show come from the exact same `TraceMenuInput.context.categories` array (ruling
// B), so Pi's `buildContextSection` and Claude Code's `buildCcContextSection` must report the same
// label, token amount and relative order for those categories given the same fixture.
import { expect, test } from "vitest";
import { buildContextSection, MEMORY_COLOR_HEX, TRACE_MENU_FIXTURE } from "../../src/hosts/trace-menu.ts";
import {
  buildCcContextSection, renderTraceMenu, splitMessagesGridCounts,
  type CcContextBreakdown, type CcGridCell, type CcMemorySplit,
} from "../../src/hosts/cc/trace-menu-render.ts";
import { renderTraceMenu as renderPiTraceMenu } from "../../src/hosts/pi/trace-menu-view.ts";
import { CONTEXT_PALETTE } from "../../src/hosts/pi/session-status.ts";

const MEMORY_LABELS = ["Knowledge", "Facts", "Raw", "Memory, unclassified"];

// A breakdown shaped like the live capture in the ticket 82 delegation report (`/tmp/cc82-samples/
// cc-context-reference.ans`): System prompt/System tools/Skills/Messages/Free space, in the SDK's own
// order and wording — never Pi's `CONTEXT_CATEGORY_ORDER` labels.
const CC_BREAKDOWN: CcContextBreakdown = {
  model: "claude-opus-5-5[1m]",
  totalTokens: 142_200,
  maxTokens: 400_000,
  percentage: 36,
  gridRows: [],
  categories: [
    { name: "System prompt", tokens: 1_900, color: "promptBorder", kind: "used" },
    { name: "System tools", tokens: 5_000, color: "inactive", kind: "used" },
    { name: "Skills", tokens: 1_200, color: "warning", kind: "used" },
    // Messages here stands for everything the shared fixture's Knowledge/Facts/Raw/Unclassified/
    // Conversation/Other rows would sum to (17,300 + 9,900 + 10,000 + 200 + 96,600 + 200 = 134,200),
    // matching how Claude Code counts injected memory inside one Messages bucket (ticket, ruling B).
    { name: "Messages", tokens: 134_200, color: "purple_FOR_SUBAGENTS_ONLY", kind: "used" },
    { name: "Free space", tokens: 257_800, color: "promptBorder", kind: "free" },
  ],
};
const CC_MEMORY: CcMemorySplit = { knowledge: 17_300, facts: 9_900, raw: 10_000, unclassified: 200 };

test("cross-host: Knowledge/Facts/Raw/unclassified amounts and order match between Pi and Claude Code", () => {
  const piRows = buildContextSection(TRACE_MENU_FIXTURE.context).categories
    .filter(c => MEMORY_LABELS.includes(c.label))
    .map(c => ({ label: c.label, tokens: c.tokens }));

  const ccSection = buildCcContextSection(CC_BREAKDOWN, CC_MEMORY)!;
  const ccRows = ccSection.legend
    .filter(r => MEMORY_LABELS.includes(r.label))
    .map(r => ({ label: r.label, tokens: r.tokens }));

  expect(ccRows).toEqual(piRows);
});

test("Claude Code context: Messages is reduced by exactly the Knowledge+Facts+Raw+unclassified sum", () => {
  const section = buildCcContextSection(CC_BREAKDOWN, CC_MEMORY)!;
  const messages = section.legend.find(r => r.label === "Messages");
  expect(messages?.tokens).toBe(134_200 - (17_300 + 9_900 + 10_000 + 200));
});

test("Claude Code context: category wording and order is Claude Code's own, not Pi's CONTEXT_CATEGORY_ORDER labels", () => {
  const section = buildCcContextSection(CC_BREAKDOWN, CC_MEMORY)!;
  expect(section.legend.map(r => r.label)).toEqual([
    "System prompt", "System tools", "Skills", "Knowledge", "Facts", "Raw", "Memory, unclassified", "Messages", "Free space",
  ]);
});

test("Claude Code context: the free-space row has no ' tokens' suffix, every other row does", () => {
  const section = buildCcContextSection(CC_BREAKDOWN, CC_MEMORY)!;
  expect(section.legend.find(r => r.label === "Free space")?.suffix).toBe("");
  expect(section.legend.find(r => r.label === "System prompt")?.suffix).toBe(" tokens");
});

test("Claude Code context: no memory split means one unavailable marker, Messages left untouched", () => {
  const section = buildCcContextSection(CC_BREAKDOWN, undefined)!;
  expect(section.legend.some(r => MEMORY_LABELS.includes(r.label))).toBe(false);
  expect(section.legend.find(r => r.label === "Messages")?.tokens).toBe(134_200);
  expect(section.memoryUnavailable).toBe("Knowledge, Facts, Raw: unavailable");
});

test("Claude Code context: no breakdown at all renders one unavailable marker", () => {
  const rendered = renderTraceMenu(TRACE_MENU_FIXTURE, {});
  expect(rendered.context).toBeUndefined();
  expect(rendered.contextUnavailable).toContain("unavailable");
});

test("Claude Code Pending: compact figures and whole-number percentages, same as Pi", () => {
  const rendered = renderTraceMenu(TRACE_MENU_FIXTURE, { breakdown: CC_BREAKDOWN, memory: CC_MEMORY });
  expect(rendered.pendingLines[0]).toContain("32%");
  expect(rendered.pendingLines[0]).toContain("3.2k / 10k");
});

test("Pi grid: every legend line lands in the same column, including rows past the grid's last row", () => {
  const lines = renderPiTraceMenu(TRACE_MENU_FIXTURE, 120).map(l => l.replace(/\x1b\[[0-9;]*m/g, ""));
  // "Memory, unclassified", "Conversation", "Other" and "Free" sit beside rows that ran out of real
  // grid data before this fix (ticket 82 requirement 4) — every one of these anchors must land in the
  // same column as an early row like "System", which always had a full grid row beside it.
  const anchors = ["System", "Knowledge", "Memory, unclassified", "Conversation", "Other", "Free"];
  const columns = anchors.map(label => lines.find(l => l.includes(label))!.indexOf(label));
  expect(columns.every(c => c > 0)).toBe(true);
  expect(new Set(columns).size).toBe(1);
});

test("Pi layout: side by side when the pane fits the grid, gap and legend; stacked otherwise", () => {
  const wide = renderPiTraceMenu(TRACE_MENU_FIXTURE, 120);
  expect(wide[2]).toMatch(/^[⛁⛀⛶#.+]/); // the model name line sits beside the grid's first row
  const narrow = renderPiTraceMenu(TRACE_MENU_FIXTURE, 60);
  // Stacked: the grid's own rows come first, then the legend text starts at column 0.
  expect(narrow.some(line => line.startsWith("openai-codex/gpt-6-astra"))).toBe(true);
});

test("cross-host: both hosts take the four memory colours from the shared model's MEMORY_COLOR_HEX", () => {
  // Pi: CONTEXT_PALETTE's memory-family entries must literally be the shared hex values, not a
  // Pi-local copy that could drift from Claude Code's.
  expect(CONTEXT_PALETTE.knowledge).toBe(MEMORY_COLOR_HEX.knowledge);
  expect(CONTEXT_PALETTE.facts).toBe(MEMORY_COLOR_HEX.facts);
  expect(CONTEXT_PALETTE.raw).toBe(MEMORY_COLOR_HEX.raw);
  expect(CONTEXT_PALETTE.unclassified).toBe(MEMORY_COLOR_HEX.unclassified);

  // Claude Code: the rendered legend rows for the four memory categories carry the same hex, not a
  // "_FOR_SUBAGENTS_ONLY" theme token.
  const ccSection = buildCcContextSection(CC_BREAKDOWN, CC_MEMORY)!;
  const colorOf = (label: string) => ccSection.legend.find(r => r.label === label)?.color;
  expect(colorOf("Knowledge")).toBe(MEMORY_COLOR_HEX.knowledge);
  expect(colorOf("Facts")).toBe(MEMORY_COLOR_HEX.facts);
  expect(colorOf("Raw")).toBe(MEMORY_COLOR_HEX.raw);
  expect(colorOf("Memory, unclassified")).toBe(MEMORY_COLOR_HEX.unclassified);
});

// ---- Grid half of ruling B: the Messages cells the SDK's own grid draws are recoloured too ---------

test("splitMessagesGridCounts: proportional shares that already sum to the cell count, no cap needed", () => {
  const counts = splitMessagesGridCounts(20, 2_000, { knowledge: 1_000, facts: 600, raw: 300, unclassified: 100 });
  expect(counts).toEqual({ knowledge: 10, facts: 6, raw: 3, unclassified: 1 });
  expect(counts.knowledge + counts.facts + counts.raw + counts.unclassified).toBe(20);
});

test("splitMessagesGridCounts: rounding that would overflow the cell count is capped, order Knowledge/Facts/Raw/Unclassified", () => {
  // round(500/1000*10)=5, round(300/1000*10)=3, round(150/1000*10)=2, round(60/1000*10)=1 -> sums to
  // 11 over a 10-cell budget: Knowledge and Facts get their full rounded share (5, 3), Raw is capped to
  // what's left (2, no cap needed yet), Unclassified is capped to 0 — the last category in the order
  // absorbs the overflow, never an earlier one.
  const counts = splitMessagesGridCounts(10, 1_000, { knowledge: 500, facts: 300, raw: 150, unclassified: 60 });
  expect(counts).toEqual({ knowledge: 5, facts: 3, raw: 2, unclassified: 0 });
  expect(counts.knowledge + counts.facts + counts.raw + counts.unclassified).toBeLessThanOrEqual(10);
});

test("splitMessagesGridCounts: zero messages tokens or zero cells yields zero for every category", () => {
  expect(splitMessagesGridCounts(10, 0, { knowledge: 100, facts: 100, raw: 100, unclassified: 100 }))
    .toEqual({ knowledge: 0, facts: 0, raw: 0, unclassified: 0 });
  expect(splitMessagesGridCounts(0, 1_000, { knowledge: 100, facts: 100, raw: 100, unclassified: 100 }))
    .toEqual({ knowledge: 0, facts: 0, raw: 0, unclassified: 0 });
});

test("Claude Code grid: a proportional prefix of the Messages cells recolours to the memory family, in grid order; non-Messages cells are untouched", () => {
  const cell = (categoryName: string, color: string): CcGridCell => ({ categoryName, color, isFilled: true, tokens: 0, percentage: 0, squareFullness: 1 });
  // 10 cells: 2 System prompt, 6 Messages, 2 Free space — Messages tokens 1,000, split 500/300/150/60
  // (same numbers as the capped `splitMessagesGridCounts` case above, scaled to 6 cells): expect
  // Knowledge=3, Facts=2, Raw=1, Unclassified=0 to land on the first 6 Messages cells in that order.
  const breakdown: CcContextBreakdown = {
    model: "m", totalTokens: 1_200, maxTokens: 10_000, percentage: 12,
    gridRows: [[
      cell("System prompt", "promptBorder"), cell("System prompt", "promptBorder"),
      cell("Messages", "purple_FOR_SUBAGENTS_ONLY"), cell("Messages", "purple_FOR_SUBAGENTS_ONLY"),
      cell("Messages", "purple_FOR_SUBAGENTS_ONLY"), cell("Messages", "purple_FOR_SUBAGENTS_ONLY"),
      cell("Messages", "purple_FOR_SUBAGENTS_ONLY"), cell("Messages", "purple_FOR_SUBAGENTS_ONLY"),
      cell("Free space", "promptBorder"), cell("Free space", "promptBorder"),
    ]],
    categories: [
      { name: "System prompt", tokens: 200, color: "promptBorder", kind: "used" },
      { name: "Messages", tokens: 1_000, color: "purple_FOR_SUBAGENTS_ONLY", kind: "used" },
      { name: "Free space", tokens: 8_800, color: "promptBorder", kind: "free" },
    ],
  };
  const memory: CcMemorySplit = { knowledge: 500, facts: 300, raw: 150, unclassified: 60 };
  const section = buildCcContextSection(breakdown, memory)!;
  const colors = section.gridRows[0]!.map(c => c.color);
  expect(colors.slice(0, 2)).toEqual(["promptBorder", "promptBorder"]); // System prompt, untouched
  expect(colors.slice(2, 8)).toEqual([
    MEMORY_COLOR_HEX.knowledge, MEMORY_COLOR_HEX.knowledge, MEMORY_COLOR_HEX.knowledge,
    MEMORY_COLOR_HEX.facts, MEMORY_COLOR_HEX.facts,
    MEMORY_COLOR_HEX.raw,
  ]);
  expect(colors.slice(8)).toEqual(["inactive", "inactive"]); // Free space cells always paint "inactive"
});
