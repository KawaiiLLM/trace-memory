import { truncateToWidth, visibleWidth, wrapTextWithAnsi } from "@earendil-works/pi-tui";
import type { ContextUsage } from "@earendil-works/pi-coding-agent";
import type { TraceMemory } from "../../core/api/index.ts";
import type { ContextComposition } from "./context-composition.ts";
import { MEMORY_COLOR_HEX } from "../trace-menu.ts";

// The four memory colours come from the shared yellow-green cluster; every other role stays Pi's own.
export const CONTEXT_PALETTE = {
  system: "#ee80af", tools: "#70c4a5", skills: "#b3a4f4",
  knowledge: MEMORY_COLOR_HEX.knowledge, facts: MEMORY_COLOR_HEX.facts, raw: MEMORY_COLOR_HEX.raw,
  unclassified: MEMORY_COLOR_HEX.unclassified,
  conversation: "#79ade8", other: "#a7adb6", free: "#63707b",
} as const;
export type PaletteColor = keyof typeof CONTEXT_PALETTE;
export type PaintColor = "dim" | "accent" | "syntaxKeyword" | "syntaxFunction" | "syntaxString" | "syntaxNumber" | "syntaxType" | "muted" | PaletteColor;
export type Paint = (color: PaintColor, text: string) => string;
const plain: Paint = (_color, text) => text;
const number = (value: number) => value.toLocaleString("en-US");
const valid = (value: unknown): value is number => typeof value === "number" && Number.isFinite(value) && value >= 0;
export const percent = (ratio: number, compact = true) => {
  const rounded = ratio > 0 && ratio < 0.001 ? "<0.1%" : `${(ratio * 100).toFixed(1)}%`;
  // Preserve threshold direction in compact views; headless keeps its original format.
  return compact && ratio !== 1 && rounded === "100.0%" ? (ratio < 1 ? "<100%" : ">100%") : rounded;
};

/** Compact only when exact: never round pending evidence onto or across its trigger. */
const compactNumber = (value: number) => value >= 1_000_000 && value % 100_000 === 0 ? `${value / 1_000_000}M`
  : value >= 1000 && value % 100 === 0 ? `${value / 1000}k` : number(value);

/** A capacity map, not task completion. A partial cell never pretends to be one full percent. */
export function contextMap(usage: ContextUsage | undefined, model: string, width: number, paint: Paint = plain, compact = true): string[] {
  const known = valid(usage?.tokens) && valid(usage?.contextWindow) && usage.contextWindow > 0;
  const ratio = known ? usage.tokens! / usage.contextWindow : undefined;
  const cells = 100, used = ratio === undefined ? 0 : Math.min(cells, ratio * cells);
  const preferred = compact ? ["⛁", "⛶", "⛀"] : ["▪", "▫", "◦"];
  const glyphs = preferred.every(g => visibleWidth(g) === 1) ? preferred : ["#", ".", "+"];
  const [full, free, part] = glyphs as [string, string, string];
  const summary = compact ? [model, known ? `~${compactNumber(usage.tokens!)} / ${compactNumber(usage.contextWindow)} (${percent(ratio!)})`
    : `Unknown / ${valid(usage?.contextWindow) && usage.contextWindow > 0 ? compactNumber(usage.contextWindow) : "Unknown"}`,
    known ? `${paint("accent", full)}${paint("dim", ` Used ${compactNumber(usage.tokens!)} (${percent(ratio!)})`)}` : "? Unknown (usage unavailable)",
    ...(known ? [paint("dim", `${free} Free ${compactNumber(Math.max(0, usage.contextWindow - usage.tokens!))} (${percent(Math.max(0, 1 - ratio!))})`)] : [])]
    : [`Context: ${model}`, known ? `${number(usage.tokens!)} / ${number(usage.contextWindow)} tokens (${percent(ratio!, false)})`
    : `Unknown / ${valid(usage?.contextWindow) && usage.contextWindow > 0 ? number(usage.contextWindow) : "Unknown"} tokens`,
    "Pi estimate (reported + trailing)", known ? `${full} Used  ${free} Free  ${part} Partial` : "? Unknown (usage unavailable)", "100 cells; 1% each"];
  const spaced = width >= 80;
  const grid = Array.from({ length: 5 }, (_, row) => Array.from({ length: 20 }, (_, col) => {
    const i = row * 20 + col;
    return ratio === undefined ? paint("dim", "?") : i < Math.floor(used) ? paint("accent", full)
      : i < used ? paint("accent", part) : paint("dim", free);
  }).join(spaced ? " " : ""));
  const gridWidth = visibleWidth(grid[0]!);
  if (spaced) {
    const right = summary.flatMap(line => wrapTextWithAnsi(line, width - gridWidth - 3));
    return Array.from({ length: Math.max(grid.length, right.length) }, (_, i) =>
      right[i] ? `${grid[i] ?? " ".repeat(gridWidth)}   ${paint("dim", right[i]!)}` : (grid[i] ?? ""));
  }
  return [...grid, ...summary.map(line => paint("dim", line))];
}

const estimate = (n: number) => n > 0 && n < 0.001 ? "<0.001"
  : n >= 1e15 ? n.toExponential(1).replace(/\.0e/, "e")
  : n >= 1_000_000 ? `${(n / 1_000_000).toFixed(1).replace(/\.0$/, "")}M`
  : n >= 1000 ? `${(n / 1000).toFixed(1).replace(/\.0$/, "")}k` : compactNumber(n);
const approximate = (n: number) => {
  const amount = estimate(n);
  return amount.startsWith("<") ? amount : `~${amount}`;
};
const share = (value: number, total: number) => total ? (value < total / 100 && percent(value / total) === "1.0%" ? "<1%" : percent(value / total)) : "0.0%";
const categoryOrder = ["System", "Tools", "Skills", "Memory", "Conversation", "Other"] as const;
const memoryOrder = ["Knowledge", "Facts", "Raw", "Unclassified"] as const;
const topColors = { System: "system", Tools: "tools", Skills: "skills", Conversation: "conversation", Other: "other" } as const;
const memoryColors = { Knowledge: "knowledge", Facts: "facts", Raw: "raw", Unclassified: "unclassified" } as const;
const GRID_COLUMNS = 20;
const NOMINAL_CELLS = 200;

type Rational = { numerator: bigint; denominator: bigint };
const gcd = (a: bigint, b: bigint): bigint => {
  while (b) [a, b] = [b, a % b];
  return a;
};
const rational = (numerator: bigint, denominator = 1n): Rational => {
  if (numerator === 0n) return { numerator: 0n, denominator: 1n };
  const divisor = gcd(numerator < 0n ? -numerator : numerator, denominator);
  return { numerator: numerator / divisor, denominator: denominator / divisor };
};
/** Exact decimal rational for the finite Number value as exposed by its stable JS spelling. */
const numberRational = (value: number): Rational => {
  const [coefficient, exponentText] = value.toString().toLowerCase().split("e");
  const exponent = Number(exponentText ?? 0);
  const [whole, fraction = ""] = coefficient!.split(".");
  const digits = `${whole}${fraction}`;
  const scale = fraction.length - exponent;
  return scale >= 0 ? rational(BigInt(digits), 10n ** BigInt(scale))
    : rational(BigInt(digits) * 10n ** BigInt(-scale));
};
const addRational = (a: Rational, b: Rational) => rational(
  a.numerator * b.denominator + b.numerator * a.denominator,
  a.denominator * b.denominator,
);
const subtractRational = (a: Rational, b: Rational) => rational(
  a.numerator * b.denominator - b.numerator * a.denominator,
  a.denominator * b.denominator,
);
const multiplyRational = (a: Rational, b: Rational) => rational(a.numerator * b.numerator, a.denominator * b.denominator);
const divideRational = (a: Rational, b: Rational) => rational(a.numerator * b.denominator, a.denominator * b.numerator);
const sumRational = (values: readonly number[]) => values.reduce((sum, value) => addRational(sum, numberRational(value)), rational(0n));
const splitUnits = (units: Rational) => ({
  fullCells: Number(units.numerator / units.denominator),
  partial: units.numerator % units.denominator > 0n,
});
const ceilUnits = (units: Rational) => Number((units.numerator + units.denominator - 1n) / units.denominator);

export interface ProjectedContextSegment {
  name: "System" | "Tools" | "Skills" | "Knowledge" | "Facts" | "Raw" | "Unclassified" | "Conversation" | "Other" | "Unclassified occupied";
  estimate: number;
  color: PaletteColor;
  fullCells: number;
  partial: boolean;
}
export interface ContextProjection {
  displayedUsed: number;
  segments: ProjectedContextSegment[];
  freeTokens: number;
  freeGlyphs: number;
  glyphs: number;
  rows: number;
  overWindow: boolean;
  unclassifiedOccupied: boolean;
}

/** SDK/window owns capacity; exact decimal ratios only decide full versus remainder glyphs. */
export function projectComposition(value: ContextComposition): ContextProjection | undefined {
  const window = valid(value.window) && value.window > 0 ? value.window : undefined;
  const sdkTokens = valid(value.sdkTokens) ? value.sdkTokens : undefined;
  if (window === undefined || sdkTokens === undefined) return;
  const overWindow = sdkTokens > window;
  const displayedUsed = overWindow ? window : sdkTokens;
  const windowExact = numberRational(window);
  const usedExact = numberRational(displayedUsed);
  const occupiedExact = divideRational(multiplyRational(usedExact, rational(BigInt(NOMINAL_CELLS))), windowExact);

  const leafInputs = ([
    { name: "System", estimate: value.amounts.System, color: "system" },
    { name: "Tools", estimate: value.amounts.Tools, color: "tools" },
    { name: "Skills", estimate: value.amounts.Skills, color: "skills" },
    ...memoryOrder.map((name): { name: ProjectedContextSegment["name"]; estimate: number; color: PaletteColor } =>
      ({ name, estimate: value.memory[name], color: memoryColors[name] })),
    { name: "Conversation", estimate: value.amounts.Conversation, color: "conversation" },
    { name: "Other", estimate: value.amounts.Other, color: "other" },
  ] as { name: ProjectedContextSegment["name"]; estimate: number; color: PaletteColor }[])
    .filter(segment => segment.estimate > 0);
  const localExact = sumRational(leafInputs.map(segment => segment.estimate));
  const unclassifiedOccupied = localExact.numerator === 0n && displayedUsed > 0;
  if (unclassifiedOccupied) leafInputs.push({ name: "Unclassified occupied", estimate: displayedUsed, color: "other" });
  const projectionTotal = unclassifiedOccupied ? numberRational(displayedUsed) : localExact;

  const exactUnits = leafInputs.map(segment => projectionTotal.numerator === 0n ? rational(0n)
    : multiplyRational(divideRational(numberRational(segment.estimate), projectionTotal), occupiedExact));
  const segments = leafInputs.map((segment, index): ProjectedContextSegment => ({
    ...segment, ...splitUnits(exactUnits[index]!),
  }));
  const freeTokens = overWindow ? 0 : Math.max(0, window - sdkTokens);
  const freeExact = overWindow ? rational(0n) : divideRational(
    multiplyRational(subtractRational(windowExact, numberRational(sdkTokens)), rational(BigInt(NOMINAL_CELLS))), windowExact,
  );
  const freeGlyphs = ceilUnits(freeExact);
  const glyphs = segments.reduce((sum, segment) => sum + segment.fullCells + Number(segment.partial), 0) + freeGlyphs;
  return { displayedUsed, segments, freeTokens, freeGlyphs, glyphs,
    rows: Math.ceil(glyphs / GRID_COLUMNS), overWindow, unclassifiedOccupied };
}

export function compositionMap(value: ContextComposition, model: string, width: number, paint: Paint = plain): string[] {
  const window = valid(value.window) && value.window > 0 ? value.window : undefined;
  const sdkTokens = valid(value.sdkTokens) ? value.sdkTokens : undefined;
  const capacityKnown = window !== undefined && sdkTokens !== undefined;
  const preferred = ["⛁", "⛶", "⛀"] as const;
  const [usedGlyph, freeGlyph, partialGlyph] = preferred.every(glyph => visibleWidth(glyph) === 1)
    ? preferred : ["#", ".", "+"] as const;
  const projection = projectComposition(value);
  const localTotal = categoryOrder.reduce((sum, name) => sum + value.amounts[name], 0);
  const segment = (name: ProjectedContextSegment["name"]) => projection?.segments.find(part => part.name === name);
  const key = (part: ProjectedContextSegment | undefined) => !projection ? usedGlyph
    : part?.fullCells ? usedGlyph : part?.partial ? partialGlyph : " ";
  const cells = projection ? [
    ...projection.segments.flatMap(part => [
      ...Array(part.fullCells).fill(paint(part.color, usedGlyph)),
      ...(part.partial ? [paint(part.color, partialGlyph)] : []),
    ]),
    ...Array(projection.freeGlyphs).fill(paint("free", freeGlyph)),
  ] : [];

  const headline = capacityKnown ? `${approximate(sdkTokens)} / ${estimate(window)} tokens (${percent(sdkTokens / window)})`
    : sdkTokens !== undefined ? `${approximate(sdkTokens)} tokens`
    : window !== undefined ? `Context window ${approximate(window)} tokens` : undefined;
  const missing = !capacityKnown ? sdkTokens === undefined && window === undefined ? "SDK usage and context window unavailable."
    : sdkTokens === undefined ? "SDK usage unavailable." : "Context window unavailable." : undefined;
  const state = projection?.overWindow ? `Context exceeds window by ${approximate(sdkTokens! - window!)} tokens; grid caps occupied footprint at the window.`
    : projection?.unclassifiedOccupied ? "Local category total is zero; occupied capacity is unclassified." : missing;
  const projectionNote = projection
    ? `Local estimates${value.complete ? "" : " (partial)"} total ${approximate(localTotal)}; grid colors project proportions to SDK occupancy.`
    : `Local estimates${value.complete ? "" : " (partial)"} total ${approximate(localTotal)}. Grid unavailable; no quota was inferred from local estimates.`;
  const legend: string[] = [model, ...(headline ? [headline] : []), ...(state ? [state] : []), projectionNote, "",
    `Estimated usage by category${value.complete ? "" : " (partial)"}`];

  const topRow = (name: "System" | "Tools" | "Skills" | "Conversation" | "Other") => {
    const amount = value.amounts[name];
    if (amount <= 0) return;
    const label = name === "Skills" ? "Skill catalog" : name;
    legend.push(paint(topColors[name], `${key(segment(name))} ${label} ${approximate(amount)} (${share(amount, localTotal)} local)`));
  };
  topRow("System"); topRow("Tools"); topRow("Skills");
  // Maintainer ruling 2026-09-24: no Memory parent row and no indentation — Knowledge, Facts and
  // Raw are top-level rows like System/Tools, in the same spot Memory used to occupy. The remainder
  // becomes its own top-level "Memory, unclassified" row, shown only when non-zero.
  for (const name of memoryOrder) {
    const amount = value.memory[name];
    if (amount <= 0) continue;
    const label = name === "Unclassified" ? "Memory, unclassified" : name;
    legend.push(paint(memoryColors[name], `${key(segment(name))} ${label} ${approximate(amount)} (${share(amount, localTotal)} local)`));
  }
  topRow("Conversation"); topRow("Other");
  if (projection?.unclassifiedOccupied)
    legend.push(paint("other", `${key(segment("Unclassified occupied"))} Unclassified occupied (SDK, not a local estimate) ${approximate(projection.displayedUsed)}`));
  if (projection) {
    legend.push(paint("free", `${freeGlyph} Free ${approximate(projection.freeTokens)} (${share(projection.freeTokens, window!)} window)`));
    const full = projection.segments.reduce((sum, part) => sum + part.fullCells, 0);
    const partial = projection.segments.filter(part => part.partial).length;
    legend.push(`${full} full + ${partial} partial occupied; ${projection.freeGlyphs} free glyphs`);
    const nominalCell = window! < NOMINAL_CELLS / 1000 ? "<0.001" : approximate(window! / NOMINAL_CELLS);
    legend.push(`Nominal full cell ${nominalCell} tokens (window / 200); partial is any positive remainder <1 cell; free glyphs round up.`);
  }

  const legendWidth = width >= 80 && cells.length ? width - 42 : width;
  const wrappedLegend = legend.flatMap(line => line ? wrapTextWithAnsi(line, Math.max(1, legendWidth)) : [""]);
  // Twenty columns is the complete-layout floor. Below it, retain safe text reflow
  // without manufacturing a one-cell-per-row composition.
  if (width < 20 || cells.length === 0) return wrappedLegend;
  const spaced = width >= 80;
  const grid = Array.from({ length: projection!.rows }, (_, row) => cells.slice(row * GRID_COLUMNS, row * GRID_COLUMNS + GRID_COLUMNS).join(spaced ? " " : ""));
  if (!spaced) return [...grid, ...wrappedLegend];
  const gridWidth = 39;
  return Array.from({ length: Math.max(grid.length, wrappedLegend.length) }, (_, index) => {
    const row = grid[index] ?? "";
    const left = row + " ".repeat(Math.max(0, gridWidth - visibleWidth(row)));
    const right = wrappedLegend[index];
    return right ? `${left}   ${right}` : left;
  });
}

export function pendingBar(label: string, value: ReturnType<TraceMemory["pendingTokens"]>, compact = true, paint: Paint = plain): string {
  const number = compact ? compactNumber : (n: number) => n.toLocaleString("en-US");
  if (value.tokens === null) {
    const trigger = value.trigger === null ? "Unknown" : number(value.trigger);
    return compact ? `${label.padEnd(13)} ?????????? Unknown/${trigger} (${value.state})`
      : `${label}: [??????????] Unknown / ${trigger} (${value.state})`;
  }
  const ratio = value.trigger === 0 ? (value.tokens === 0 ? 0 : Infinity) : value.tokens / value.trigger;
  const filled = Math.min(10, Math.floor(ratio * 10));
  const partial = filled < 10 && ratio * 10 > filled;
  const percentage = percent(ratio, compact);
  if (compact) {
    const [used, free] = ["█", "░"].every(g => visibleWidth(g) === 1) ? ["█", "░"] : ["#", "."];
    // Floor visual capacity; the exact numeric amount still exposes sub-cell and over-trigger evidence.
    const bar = paint("accent", used!.repeat(filled)) + paint("dim", free!.repeat(10 - filled));
    return `${paint("dim", label.padEnd(13))} ${bar} ${paint("dim", `${percentage.padStart(6)} ${number(value.tokens)}/${number(value.trigger)}`)}`;
  }
  return `${label}: [${"#".repeat(filled)}${partial ? "+" : ""}${".".repeat(10 - filled - Number(partial))}] ${number(value.tokens)} / ${number(value.trigger)} (${percentage})`;
}

/** Wrap the current snapshot at the width allocated by Pi. */
export function statusBody(lines: string[], width: number, paint: Paint = plain): string {
  return lines.flatMap(line => wrapTextWithAnsi(line, Math.max(1, width))).map(line => paint("dim", truncateToWidth(line, Math.max(1, width), ""))).join("\n");
}
