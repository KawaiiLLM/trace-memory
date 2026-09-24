// Ticket 82: per-host `/trace` menu renderer tests.
//
// Requirement 5 (maintainer correction, 2026-09-24): Claude Code copies its own built-in `/context`
// drawing instead of Pi's `projectComposition` grid, so the cross-host guarantee is no longer "same
// grid pixels" — it is "the shared model's rows (labels, amounts, order) are identical on both
// hosts; the grids are each host's own." Concretely: the Knowledge/Facts/Raw/unclassified-memory
// amounts both hosts show come from the exact same `TraceMenuInput.context.categories` array (ruling
// B), so Pi's `buildContextSection` and Claude Code's `buildCcContextSection` must report the same
// label, token amount and relative order for those categories given the same fixture — with Claude
// Code's `contextTokens` chosen so the requirement 4 scaling factor is exactly 1 (see its own comment),
// since scaling is a Claude Code-only step Pi never applies.
import { expect, test } from "vitest";
import { buildContextSection, MEMORY_COLOR_HEX, TRACE_MENU_FIXTURE } from "../../src/hosts/trace-menu.ts";
import {
  buildCcContextSection, computeCcGrid, renderTraceMenu, scaleMemoryToMessages,
  type CcContextBreakdown, type CcMemorySplit,
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
// Requirement 4: factor = messagesTokens / contextTokens. Setting the denominator to Messages' own
// token count makes the factor exactly 1, so these tests can still assert CC_MEMORY's raw numbers
// unchanged — scaling itself has its own dedicated tests below (`scaleMemoryToMessages`).
const NO_SCALING = CC_BREAKDOWN.categories.find(c => c.name === "Messages")!.tokens;

test("cross-host: Knowledge/Facts/Raw/unclassified amounts and order match between Pi and Claude Code", () => {
  const piRows = buildContextSection(TRACE_MENU_FIXTURE.context).categories
    .filter(c => MEMORY_LABELS.includes(c.label))
    .map(c => ({ label: c.label, tokens: c.tokens }));

  const ccSection = buildCcContextSection(CC_BREAKDOWN, CC_MEMORY, NO_SCALING)!;
  const ccRows = ccSection.legend
    .filter(r => MEMORY_LABELS.includes(r.label))
    .map(r => ({ label: r.label, tokens: r.tokens }));

  expect(ccRows).toEqual(piRows);
});

test("Claude Code context: Messages is reduced by exactly the Knowledge+Facts+Raw+unclassified sum", () => {
  const section = buildCcContextSection(CC_BREAKDOWN, CC_MEMORY, NO_SCALING)!;
  const messages = section.legend.find(r => r.label === "Messages");
  expect(messages?.tokens).toBe(134_200 - (17_300 + 9_900 + 10_000 + 200));
});

test("Claude Code context: category wording and order is Claude Code's own, not Pi's CONTEXT_CATEGORY_ORDER labels", () => {
  const section = buildCcContextSection(CC_BREAKDOWN, CC_MEMORY, NO_SCALING)!;
  expect(section.legend.map(r => r.label)).toEqual([
    "System prompt", "System tools", "Skills", "Knowledge", "Facts", "Raw", "Memory, unclassified", "Messages", "Free space",
  ]);
});

test("Claude Code context: the free-space row has no ' tokens' suffix, every other row does", () => {
  const section = buildCcContextSection(CC_BREAKDOWN, CC_MEMORY, NO_SCALING)!;
  expect(section.legend.find(r => r.label === "Free space")?.suffix).toBe("");
  expect(section.legend.find(r => r.label === "System prompt")?.suffix).toBe(" tokens");
});

test("Claude Code context: no memory split means one unavailable marker, Messages left untouched", () => {
  const section = buildCcContextSection(CC_BREAKDOWN, undefined, NO_SCALING)!;
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
  const rendered = renderTraceMenu(TRACE_MENU_FIXTURE, { breakdown: CC_BREAKDOWN, memory: CC_MEMORY, contextTokens: NO_SCALING });
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
  const ccSection = buildCcContextSection(CC_BREAKDOWN, CC_MEMORY, NO_SCALING)!;
  const colorOf = (label: string) => ccSection.legend.find(r => r.label === label)?.color;
  expect(colorOf("Knowledge")).toBe(MEMORY_COLOR_HEX.knowledge);
  expect(colorOf("Facts")).toBe(MEMORY_COLOR_HEX.facts);
  expect(colorOf("Raw")).toBe(MEMORY_COLOR_HEX.raw);
  expect(colorOf("Memory, unclassified")).toBe(MEMORY_COLOR_HEX.unclassified);
});

// ---- Requirement 4: scaling to Claude Code's own tokenizer -----------------------------------------

test("scaleMemoryToMessages: a factor above 1 scales every row up", () => {
  const memory: CcMemorySplit = { knowledge: 1_000, facts: 500, raw: 200, unclassified: 0 };
  // factor = 3_200 / 2_000 = 1.6, matching the ticket's own "about 1.6×" measurement.
  const scaled = scaleMemoryToMessages(memory, 3_200, 2_000);
  expect(scaled).toEqual({ knowledge: 1_600, facts: 800, raw: 320, unclassified: 0 });
});

test("scaleMemoryToMessages: a factor below 1 scales every row down", () => {
  const memory: CcMemorySplit = { knowledge: 1_000, facts: 500, raw: 200, unclassified: 100 };
  // factor = 900 / 1_800 = 0.5.
  const scaled = scaleMemoryToMessages(memory, 900, 1_800);
  expect(scaled).toEqual({ knowledge: 500, facts: 250, raw: 100, unclassified: 50 });
});

test("scaleMemoryToMessages: an all-zero split needs no factor and always resolves", () => {
  const memory: CcMemorySplit = { knowledge: 0, facts: 0, raw: 0, unclassified: 0 };
  expect(scaleMemoryToMessages(memory, undefined, undefined)).toEqual(memory);
  expect(scaleMemoryToMessages(memory, 0, 0)).toEqual(memory);
});

test("scaleMemoryToMessages: an uncomputable factor (no Messages category, or a zero denominator) is undefined", () => {
  const memory: CcMemorySplit = { knowledge: 100, facts: 0, raw: 0, unclassified: 0 };
  expect(scaleMemoryToMessages(memory, undefined, 1_000)).toBeUndefined(); // no Messages category
  expect(scaleMemoryToMessages(memory, 1_000, 0)).toBeUndefined(); // zero denominator
  expect(scaleMemoryToMessages(memory, 1_000, undefined)).toBeUndefined(); // no denominator at all
});

// ---- Requirement 2: the grid is computed from the category list, Claude Code's own rule ------------

test("computeCcGrid: a 1M window gets 20x10 cells; a category with a sub-1 raw share is forced to one partial cell", () => {
  // Matches the reference capture (`/tmp/cc82-samples/cc-context-reference.ans`, this module's own
  // doc comment): System prompt 1,900/1,000,000 tokens -> raw 0.38 -> forced to 1 cell, partial.
  const categories = [
    { name: "System prompt", tokens: 1_900, color: "promptBorder", kind: "used" as const },
    { name: "System tools", tokens: 27_600, color: "inactive", kind: "used" as const },
    { name: "Skills", tokens: 2_000, color: "warning", kind: "used" as const },
    { name: "Free space", tokens: 968_500, color: "promptBorder", kind: "free" as const },
  ];
  const grid = computeCcGrid(categories, 1_000_000, 100);
  expect(grid).toHaveLength(10);
  expect(grid[0]).toHaveLength(20);
  const flat = grid.flat();
  // System prompt: 1 partial cell; System tools: 27,600/1,000,000*200=5.52 -> 5 full + 1 partial;
  // Skills: 2,000/1,000,000*200=0.4 -> forced to 1 partial cell.
  expect(flat.slice(0, 1)).toEqual([{ glyph: "⛀", color: "promptBorder" }]);
  expect(flat.slice(1, 7)).toEqual([
    { glyph: "⛁", color: "inactive" }, { glyph: "⛁", color: "inactive" }, { glyph: "⛁", color: "inactive" },
    { glyph: "⛁", color: "inactive" }, { glyph: "⛁", color: "inactive" }, { glyph: "⛀", color: "inactive" },
  ]);
  expect(flat[7]).toEqual({ glyph: "⛀", color: "warning" });
  // The rest of the 200 cells are free, coloured with Free space's own declared colour, whatever is
  // left over after the occupied categories — not Free's own independently rounded share (module doc).
  expect(flat.slice(8).every(c => c.glyph === "⛶" && c.color === "promptBorder")).toBe(true);
  expect(flat.slice(8)).toHaveLength(200 - 8);
});

test("computeCcGrid: a narrow pane (<80 cols) shrinks the grid to 5 columns; a small window shrinks it to 10x10", () => {
  const categories = [{ name: "Free space", tokens: 100, color: "promptBorder", kind: "free" as const }];
  expect(computeCcGrid(categories, 1_000_000, 60)).toHaveLength(10); // big window: always 10 rows
  expect(computeCcGrid(categories, 1_000_000, 60)[0]).toHaveLength(5); // narrow: 5 columns
  expect(computeCcGrid(categories, 400_000, 100)).toHaveLength(10); // non-narrow, non-1M: 10x10
  expect(computeCcGrid(categories, 400_000, 100)[0]).toHaveLength(10);
  expect(computeCcGrid(categories, 400_000, 60)).toHaveLength(5); // narrow AND small window: 5x5
  expect(computeCcGrid(categories, 400_000, 60)[0]).toHaveLength(5);
});

test("computeCcGrid: minRows pads with blank free-glyph rows past the natural row count, never fewer", () => {
  const categories = [{ name: "Free space", tokens: 100, color: "promptBorder", kind: "free" as const }];
  const grid = computeCcGrid(categories, 400_000, 100, 15); // natural: 10 rows (non-1M, non-narrow)
  expect(grid).toHaveLength(15);
  expect(grid.slice(10).every(row => row.every(c => c.glyph === "⛶" && c.color === "promptBorder"))).toBe(true);
  expect(computeCcGrid(categories, 400_000, 100, 3)).toHaveLength(10); // minRows below the natural count changes nothing
});

test("Claude Code context: Knowledge/Facts/Raw each occupy at least one grid cell once injected; a zero Memory-unclassified occupies none", () => {
  const section = buildCcContextSection(CC_BREAKDOWN, CC_MEMORY, NO_SCALING)!;
  const flat = section.gridRows.flat();
  expect(flat.some(c => c.color === MEMORY_COLOR_HEX.knowledge)).toBe(true);
  expect(flat.some(c => c.color === MEMORY_COLOR_HEX.facts)).toBe(true);
  expect(flat.some(c => c.color === MEMORY_COLOR_HEX.raw)).toBe(true);
  // CC_MEMORY.unclassified is 200 tokens (non-zero) — give it its own assertion with an explicit zero.
  const zeroUnclassified = buildCcContextSection(CC_BREAKDOWN, { ...CC_MEMORY, unclassified: 0 }, NO_SCALING)!;
  expect(zeroUnclassified.gridRows.flat().some(c => c.color === MEMORY_COLOR_HEX.unclassified)).toBe(false);
});

test("Claude Code context: the grid is padded so every legend line, however many there are, has a grid row beside it", () => {
  const section = buildCcContextSection(CC_BREAKDOWN, CC_MEMORY, NO_SCALING)!;
  const legendLineCount = section.headerLines.length + 1 + 1 + section.legend.length + (section.memoryUnavailable ? 1 : 0);
  expect(section.gridRows.length).toBeGreaterThanOrEqual(legendLineCount);
});

// ---- Requirement 2: rows never vanish ----------------------------------------------------------

// Shaped like a fresh session with no message sent (the reported bug): Claude Code reports no
// "Messages" category at all when there is no conversation yet.
const CC_BREAKDOWN_NO_MESSAGES: CcContextBreakdown = {
  model: "claude-opus-5-5[1m]",
  totalTokens: 25_735,
  maxTokens: 1_000_000,
  percentage: 3,
  categories: [
    { name: "System prompt", tokens: 1_876, color: "promptBorder", kind: "used" },
    { name: "System tools", tokens: 21_899, color: "inactive", kind: "used" },
    { name: "Skills", tokens: 1_960, color: "warning", kind: "used" },
    { name: "Free space", tokens: 974_265, color: "promptBorder", kind: "free" },
  ],
};

test("Claude Code context: nothing injected shows Knowledge/Facts/Raw as zero rows, no Messages row to touch, no Memory-unclassified row", () => {
  const section = buildCcContextSection(CC_BREAKDOWN_NO_MESSAGES, { knowledge: 0, facts: 0, raw: 0, unclassified: 0 }, undefined)!;
  const labels = section.legend.map(r => r.label);
  expect(labels).toEqual(["System prompt", "System tools", "Skills", "Knowledge", "Facts", "Raw", "Free space"]);
  expect(section.legend.find(r => r.label === "Knowledge")?.tokens).toBe(0);
  expect(section.legend.find(r => r.label === "Facts")?.tokens).toBe(0);
  expect(section.legend.find(r => r.label === "Raw")?.tokens).toBe(0);
  expect(section.memoryUnavailable).toBeUndefined();
});

test("Claude Code context: a normal split still reduces Messages and inserts the memory rows in its place", () => {
  const section = buildCcContextSection(CC_BREAKDOWN, CC_MEMORY, NO_SCALING)!;
  const labels = section.legend.map(r => r.label);
  expect(labels).toEqual([
    "System prompt", "System tools", "Skills", "Knowledge", "Facts", "Raw", "Memory, unclassified", "Messages", "Free space",
  ]);
  expect(section.legend.find(r => r.label === "Messages")?.tokens).toBe(134_200 - (17_300 + 9_900 + 10_000 + 200));
  expect(section.memoryUnavailable).toBeUndefined();
});

test("Claude Code context: a scaled sum exceeding Messages is inconsistent — unavailable, Messages and the grid untouched", () => {
  // A deliberately tiny denominator inflates the scaling factor (134,200 / 100 = 1,342x) enough that
  // even CC_MEMORY's modest raw sum (37,400) scales past Messages' own 134,200 tokens.
  const section = buildCcContextSection(CC_BREAKDOWN, CC_MEMORY, 100)!;
  expect(section.legend.some(r => MEMORY_LABELS.includes(r.label))).toBe(false);
  expect(section.legend.find(r => r.label === "Messages")?.tokens).toBe(134_200);
  expect(section.memoryUnavailable).toBe("Knowledge, Facts, Raw: unavailable");
});

test("Claude Code context: something injected while Messages is entirely absent is inconsistent — unavailable, not zero rows", () => {
  const section = buildCcContextSection(CC_BREAKDOWN_NO_MESSAGES, { knowledge: 500, facts: 0, raw: 0, unclassified: 0 }, 500)!;
  expect(section.legend.some(r => MEMORY_LABELS.includes(r.label))).toBe(false);
  expect(section.memoryUnavailable).toBe("Knowledge, Facts, Raw: unavailable");
});

test("buildCcContextSection: a narrow pane stacks the grid above the legend without padding; a wide one pads it beside the legend", () => {
  const narrow = buildCcContextSection({ ...CC_BREAKDOWN, terminalWidth: 45 }, CC_MEMORY, NO_SCALING)!;
  expect(narrow.sideBySide).toBe(false);
  expect(narrow.gridRows).toHaveLength(5); // Claude Code's own 5x5 grid for a narrow pane and a sub-1M window
  const wide = buildCcContextSection({ ...CC_BREAKDOWN, terminalWidth: 94 }, CC_MEMORY, NO_SCALING)!;
  expect(wide.sideBySide).toBe(true);
  const legendLines = wide.headerLines.length + 2 + wide.legend.length + (wide.memoryUnavailable ? 1 : 0);
  expect(wide.gridRows).toHaveLength(Math.max(10, legendLines));
});
