import { expect, test } from "vitest";
import type { Theme } from "@earendil-works/pi-coding-agent";
import { stripTerminalSequences, visibleWidth } from "@earendil-works/pi-tui";
import type { ContextComposition } from "../../../src/hosts/pi/context-composition.ts";
import { compositionMap, projectComposition, statusBody } from "../../../src/hosts/pi/session-status.ts";
import { createSessionPaint } from "../../../src/hosts/pi/session-panel.ts";

const emptyMemory = { Knowledge: 0, Facts: 0, Raw: 0, Unclassified: 0 };
const composition = (
  amounts: ContextComposition["amounts"], sdkTokens: number | undefined, window: number | undefined,
  memory: ContextComposition["memory"] = emptyMemory, complete = true,
): ContextComposition => ({
  amounts, memory, total: Object.values(amounts).reduce((sum, amount) => sum + amount, 0),
  sdkTokens, sdkDifference: sdkTokens === undefined ? undefined : sdkTokens - Object.values(amounts).reduce((sum, amount) => sum + amount, 0),
  window, complete,
});
const blank = () => ({ System: 0, Tools: 0, Skills: 0, Memory: 0, Conversation: 0, Other: 0 });
const gridText = (value: ContextComposition, width: number) => {
  const projected = projectComposition(value)!;
  const lines = compositionMap(value, "test/model", width);
  return lines.slice(0, projected.rows).map(line => stripTerminalSequences(line).split("   ")[0]!.replaceAll(" ", "")).join("");
};

test("approved screenshot projects local shares onto SDK occupancy and lets remainder glyphs grow the grid", () => {
  const value = composition({ System: 1800, Tools: 3900, Skills: 1200, Memory: 40200, Conversation: 223700, Other: 19100 }, 284700, 512000,
    { Knowledge: 17200, Facts: 11000, Raw: 12000, Unclassified: 0 });
  const projected = projectComposition(value)!;
  expect(projected).not.toHaveProperty("occupiedUnits");
  expect(projected.segments.every(segment => !("projectedTokens" in segment) && !("units" in segment))).toBe(true);
  expect(projected.segments.reduce((sum, segment) => sum + segment.fullCells, 0)).toBe(107);
  expect(projected.segments.filter(segment => segment.partial).length).toBe(8);
  expect(projected.freeGlyphs).toBe(89);
  expect(projected.glyphs).toBe(204);
  expect(projected.rows).toBe(11);
  const grid = gridText(value, 40);
  expect(grid.match(/⛁/g)).toHaveLength(107);
  expect(grid.match(/⛀/g)).toHaveLength(8);
  expect(grid.match(/⛶/g)).toHaveLength(89);
  const text = compositionMap(value, "test/model", 40).join("\n");
  expect(text.replace(/\s+/g, " ")).toContain("Local estimates total ~289.9k; grid colors project proportions to SDK occupancy.");
  expect(text).not.toContain("Difference");
  expect(text.replace(/\s+/g, " ")).toContain("107 full + 8 partial occupied; 89 free glyphs");
  expect(text.replace(/\s+/g, " ")).toContain("Nominal full cell ~2.6k tokens (window / 200)");
});

test.each([
  { name: "local above SDK", local: [90, 10], sdk: 40, expected: [72, 8] },
  { name: "local below SDK", local: [30, 10], sdk: 80, expected: [120, 40] },
])("$name stays multicolor and normalizes shares without Difference", ({ local, sdk, expected }) => {
  const amounts = blank(); amounts.System = local[0]!; amounts.Tools = local[1]!;
  const value = composition(amounts, sdk, 100);
  const projected = projectComposition(value)!;
  expect(projected.segments.map(segment => segment.fullCells)).toEqual(expected);
  const text = compositionMap(value, "test/model", 40).join("\n");
  expect(text).not.toContain("Difference");
  expect(gridText(value, 40)).toBe("⛁".repeat(expected.reduce((sum, count) => sum + count, 0)) + "⛶".repeat(200 - sdk * 2));
});

test("Memory leaf categories and tiny Skills get separate remainder glyphs without double-counting Memory", () => {
  const amounts = blank();
  Object.assign(amounts, { System: 10, Tools: 20, Skills: 0.001, Memory: 60, Conversation: 9.999, Other: 0 });
  const value = composition(amounts, 50, 100, { Knowledge: 10, Facts: 20, Raw: 29, Unclassified: 1 });
  const paint = (color: string, text: string) => `<${color}>${text}</${color}>`;
  const rendered = compositionMap(value, "test/model", 100, paint as never).join("\n");
  expect(projectComposition(value)!.segments.find(segment => segment.name === "Skills")!.partial).toBe(true);
  expect(rendered).toContain("<skills>⛀</skills>");
  expect(rendered).toContain("<knowledge>");
  expect(rendered).toContain("<facts>");
  expect(rendered).toContain("<raw>");
  // No Memory parent row and no indentation: Knowledge/Facts/Raw and the "Memory, unclassified"
  // remainder are top-level rows, in the same shape as System/Tools (maintainer 2026-09-24). Colour
  // ruling (2026-09-24): unclassified paints with the muted memory family, not the neutral "other".
  // ("unclassified" is a longer tag than "other" was, so the wrap point moved; normalize whitespace
  // rather than pin an exact line break.)
  expect(rendered.replace(/\s+/g, " ")).toMatch(/<unclassified>[⛁⛀] Memory, unclassified ~1 \(1\.0% local\)<\/unclassified>/);
  expect(rendered).not.toMatch(/Memory ~60\b/);
  expect(rendered).not.toContain("<memory>");
});

test("decimal exact boundaries do not gain partials while genuinely tiny positive categories survive", () => {
  const exact = blank(); exact.System = 0.1; exact.Tools = 0.2;
  const exactProjection = projectComposition(composition(exact, 3, 200))!;
  expect(exactProjection.segments.map(segment => [segment.fullCells, segment.partial])).toEqual([[1, false], [2, false]]);

  const tiny = blank(); tiny.Skills = Number.MIN_VALUE; tiny.Conversation = 1;
  const tinyValue = composition(tiny, 100, 200);
  const tinyProjection = projectComposition(tinyValue)!;
  expect(tinyProjection.segments.find(segment => segment.name === "Skills")).toMatchObject({
    estimate: Number.MIN_VALUE, fullCells: 0, partial: true,
  });
  expect(gridText(tinyValue, 40).startsWith("⛀")).toBe(true);
});

test("smallest positive windows and largest finite inputs keep display semantics honest", () => {
  const smallest = blank(); smallest.Skills = Number.MIN_VALUE;
  const smallestText = compositionMap(composition(smallest, Number.MIN_VALUE, Number.MIN_VALUE), "test/model", 40).join("\n");
  expect(smallestText).toContain("Nominal full cell <0.001 tokens");
  expect(smallestText).not.toMatch(/NaN|Infinity|Nominal full cell ~0 tokens/);

  const largestLocal = 1.7976931348623155e308;
  const largest = blank(); largest.System = largestLocal;
  const largestValue = composition(largest, Number.MAX_VALUE, Number.MAX_VALUE);
  const largestProjection = projectComposition(largestValue)!;
  expect(largestProjection.segments[0]).toMatchObject({ estimate: largestLocal, fullCells: 200, partial: false });
  expect(largestProjection.glyphs).toBe(200);
  expect(compositionMap(largestValue, "test/model", 40).join("\n")).not.toMatch(/NaN|Infinity/);
});

test("many independent remainders near full capacity exceed 200 glyphs without clipping", () => {
  const amounts = { System: 0.1, Tools: 0.1, Skills: 0.1, Memory: 0.4, Conversation: 0.1, Other: 198.2 };
  const value = composition(amounts, 199, 200, { Knowledge: 0.1, Facts: 0.1, Raw: 0.1, Unclassified: 0.1 });
  const projected = projectComposition(value)!;
  expect(projected.segments).toHaveLength(9);
  expect(projected.segments.every(segment => segment.partial)).toBe(true);
  expect(projected.glyphs).toBe(208);
  expect(projected.rows).toBe(11);
  expect(gridText(value, 40)).toHaveLength(208);
});

test("zero, unknown, and overflow states keep SDK capacity truthful", () => {
  const local = blank(); local.System = 3; local.Tools = 1;
  const zero = compositionMap(composition(local, 0, 100), "test/model", 40).join("\n");
  expect(stripTerminalSequences(zero).match(/⛶/g)).toHaveLength(201); // 200 grid + Free legend key
  expect(zero.split("\n").slice(0, 10).join("")).toBe("⛶".repeat(200));
  expect(zero.split("\n").slice(0, 10).join("")).not.toContain("⛀");

  const unknown = compositionMap(composition(local, undefined, 100), "test/model", 40).join("\n");
  expect(unknown).toContain("SDK usage unavailable.");
  expect(unknown.replace(/\s+/g, " ")).toContain("Grid unavailable; no quota was inferred from local estimates.");
  expect(unknown.split("\n")[0]).toBe("test/model");

  const overflow = composition(local, 1e30, 100);
  const projected = projectComposition(overflow)!;
  expect(projected.displayedUsed).toBe(100);
  expect(projected.freeTokens).toBe(0);
  expect(projected.segments.map(segment => segment.fullCells)).toEqual([150, 50]);
  expect(projected.glyphs).toBe(200);
  const overflowText = compositionMap(overflow, "test/model", 40).join("\n");
  expect(overflowText.replace(/\s+/g, " ")).toContain("Context exceeds window by ~1e+30 tokens; grid caps occupied footprint at the window.");
  expect(overflowText).toContain("Free ~0 (0.0% window)");
});

test("positive SDK with zero local total uses explicit neutral unclassified occupancy", () => {
  const value = composition(blank(), 1, 100);
  const projected = projectComposition(value)!;
  expect(projected.unclassifiedOccupied).toBe(true);
  expect(projected.segments).toEqual([expect.objectContaining({ name: "Unclassified occupied", fullCells: 2, partial: false })]);
  const text = compositionMap(value, "test/model", 40).join("\n");
  expect(text.replace(/\s+/g, " ")).toContain("Local category total is zero; occupied capacity is unclassified.");
  expect(text.replace(/\s+/g, " ")).toContain("Unclassified occupied (SDK, not a local estimate) ~1");
});

test("Memory Unclassified remains a leaf with its exact proportional allocation, painted in the muted memory shade", () => {
  const amounts = blank(); amounts.Memory = 10; amounts.System = 5;
  const value = composition(amounts, 11, 100, { Knowledge: 1, Facts: 2, Raw: 3, Unclassified: 4 }, false);
  const projected = projectComposition(value)!;
  expect(projected.segments.map(segment => [segment.name, segment.fullCells, segment.partial])).toEqual([
    ["System", 7, true], ["Knowledge", 1, true], ["Facts", 2, true], ["Raw", 4, true], ["Unclassified", 5, true],
  ]);
  // Colour ruling (2026-09-24): Unclassified paints with the muted memory family ("unclassified"),
  // not the neutral "other" — same family as Knowledge/Facts/Raw, not the same role as "Other".
  expect(projected.segments.find(segment => segment.name === "Unclassified")).toMatchObject({ estimate: 4, color: "unclassified" });
  const text = compositionMap(value, "test/model", 40, ((color: string, rendered: string) => `<${color}>${rendered}</${color}>`) as never).join("\n");
  expect(text).toContain("<unclassified>");
  expect(text).toContain("Memory, unclassified ~4");
  expect(text).toContain("Local estimates (partial) total ~15");
});

test("approved RGB palette uses Pi native truecolor and 256-color fallback and restores dim body color", () => {
  const outerTheme = (mode: "truecolor" | "256color"): Pick<Theme, "fg" | "getFgAnsi" | "getColorMode"> => ({
    fg: (_color, text) => text,
    getFgAnsi: () => mode === "truecolor" ? "\x1b[38;2;144;144;144m" : "\x1b[38;5;245m",
    getColorMode: () => mode,
  });
  const truePaint = createSessionPaint(outerTheme("truecolor"));
  // The shared yellow-green cluster is approved for both hosts (ticket 82).
  const expected = {
    system: "238;128;175", tools: "112;196;165", skills: "179;164;244", knowledge: "221;238;73",
    facts: "161;238;73", raw: "101;238;73", unclassified: "142;169;112", conversation: "121;173;232", other: "167;173;182",
  } as const;
  for (const [color, rgb] of Object.entries(expected)) {
    const styled = truePaint(color as never, "x");
    expect(styled).toContain(`\x1b[38;2;${rgb}m`);
    expect(styled.endsWith("\x1b[38;2;144;144;144m")).toBe(true);
  }
  const fallback = createSessionPaint(outerTheme("256color"));
  expect(new Set(Object.keys(expected).map(color => fallback(color as never, "x").match(/38;5;(\d+)/)![1])).size).toBeGreaterThanOrEqual(7);
  expect(fallback("knowledge", "x")).not.toBe(fallback("system", "x"));
  expect(fallback("tools", "x")).not.toBe(fallback("conversation", "x"));
});

test.each([80, 79, 20, 19])("variable grid and complete legend remain width-safe at %i columns", width => {
  const value = composition({ System: 1800, Tools: 3900, Skills: 1200, Memory: 40200, Conversation: 223700, Other: 19100 }, 284700, 512000,
    { Knowledge: 17200, Facts: 11000, Raw: 12000, Unclassified: 0 });
  const projected = projectComposition(value)!;
  const lines = compositionMap(value, "provider/模型-with-a-long-name", width);
  const rendered = statusBody(lines, width).split("\n");
  expect(rendered.every(line => visibleWidth(line) <= width)).toBe(true);
  const text = stripTerminalSequences(rendered.join(" ")).replace(/\s+/g, " ");
  for (const phrase of ["Knowledge ~17.2k", "Facts ~11k", "Raw ~12k", "Conversation ~223.7k", "Other ~19.1k"])
    expect(text).toContain(phrase);
  if (width >= 20) {
    expect(gridText(value, width)).toHaveLength(projected.glyphs);
    if (width >= 80) {
      const finalRow = stripTerminalSequences(lines[projected.rows - 1]!);
      expect(finalRow.startsWith("⛶ ⛶ ⛶ ⛶".padEnd(39) + "   ")).toBe(true);
      const ansiPaint = (_color: string, glyph: string) => `\x1b[31m${glyph}\x1b[90m`;
      const ansiFinalRow = stripTerminalSequences(compositionMap(value, "test/model", width, ansiPaint as never)[projected.rows - 1]!);
      expect(ansiFinalRow.startsWith("⛶ ⛶ ⛶ ⛶".padEnd(39) + "   ")).toBe(true);
    }
  } else {
    expect(lines.join("").replaceAll(" ", "")).toContain("provider/模型-with-a-long-name");
    expect(lines.length).toBeLessThan(100);
  }
});
