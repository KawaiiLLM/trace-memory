import { truncateToWidth, visibleWidth, wrapTextWithAnsi } from "@earendil-works/pi-tui";
import type { ContextUsage } from "@earendil-works/pi-coding-agent";
import type { TraceMemory } from "../../core/api/index.ts";
import type { ContextComposition } from "./context-composition.ts";

export type Paint = (color: "dim" | "accent" | "syntaxKeyword" | "syntaxFunction" | "syntaxString" | "syntaxNumber" | "syntaxType" | "muted", text: string) => string;
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

/** Largest remainders, one shared rounding; a nonzero category has no guaranteed cell. */
export function allocateCells(values: readonly number[], cells: number): number[] {
  const total = values.reduce((sum, value) => sum + value, 0);
  if (!total) return values.map(() => 0);
  const shares = values.map(value => value / total * cells), counts = shares.map(Math.floor);
  const order = shares.map((value, i) => ({ i, remainder: value - counts[i]! }))
    .sort((a, b) => b.remainder - a.remainder || a.i - b.i);
  for (let i = 0, left = cells - counts.reduce((sum, count) => sum + count, 0); i < left; i++) counts[order[i]!.i]!++;
  return counts;
}
const estimate = (n: number) => n > 0 && n < 0.001 ? "<0.001"
  : n >= 1_000_000 ? `${(n / 1_000_000).toFixed(1).replace(/\.0$/, "")}M`
  : n >= 1000 ? `${(n / 1000).toFixed(1).replace(/\.0$/, "")}k` : compactNumber(n);
const approximate = (n: number) => {
  const amount = estimate(n);
  return amount.startsWith("<") ? amount : `~${amount}`;
};
const share = (value: number, total: number) => total ? (value < total / 100 && percent(value / total) === "1.0%" ? "<1%" : percent(value / total)) : "0.0%";
const categoryOrder = ["System", "Tools", "Skills", "Memory", "Conversation", "Other"] as const;
const colors: Record<(typeof categoryOrder)[number] | "Difference", Parameters<Paint>[0]> = {
  System: "syntaxKeyword", Tools: "syntaxFunction", Skills: "syntaxString", Memory: "accent",
  Conversation: "syntaxNumber", Other: "syntaxType", Difference: "muted",
};
const memoryOrder = ["Knowledge", "Facts", "Raw", "Unclassified"] as const;

export function compositionMap(value: ContextComposition, model: string, width: number, paint: Paint = plain): string[] {
  const window = valid(value.window) && value.window > 0 ? value.window : undefined;
  const sdkTokens = valid(value.sdkTokens) ? value.sdkTokens : undefined;
  const capacityKnown = window !== undefined && sdkTokens !== undefined;
  const preferred = ["⛁", "⛶", "⛀"] as const;
  const [usedGlyph, freeGlyph, partialGlyph] = preferred.every(glyph => visibleWidth(glyph) === 1)
    ? preferred : ["#", ".", "+"] as const;
  const local = categoryOrder.map(name => value.amounts[name]);
  const localTotal = local.reduce((sum, amount) => sum + amount, 0);
  const coherent = capacityKnown && localTotal <= sdkTokens && sdkTokens <= window;
  const overWindow = capacityKnown && sdkTokens > window;
  let cells: string[] = [];

  if (coherent) {
    const difference = sdkTokens - localTotal;
    const free = window - sdkTokens;
    const segments = [...local, difference, free];
    const counts = allocateCells(segments, 200);
    const segmentColors = [...categoryOrder.map(name => colors[name]), colors.Difference, "dim"] as const;
    cells = counts.flatMap((count, index) => Array(count).fill(
      paint(segmentColors[index]!, index === counts.length - 1 ? freeGlyph : usedGlyph),
    ));
  } else if (capacityKnown) {
    if (overWindow) cells = Array(200).fill(paint("accent", usedGlyph));
    else {
      const occupied = sdkTokens / window * 200;
      const full = Math.floor(occupied);
      cells = Array.from({ length: 200 }, (_, index) => index < full
        ? paint("accent", usedGlyph) : index < occupied ? paint("accent", partialGlyph) : paint("dim", freeGlyph));
    }
  }

  const headline = capacityKnown ? `${approximate(sdkTokens)} / ${estimate(window)} tokens (${percent(sdkTokens / window)})`
    : sdkTokens !== undefined ? `${approximate(sdkTokens)} tokens`
    : window !== undefined ? `Context window ${approximate(window)} tokens` : undefined;
  const state = !capacityKnown
    ? sdkTokens === undefined && window === undefined ? "SDK usage and context window unavailable."
      : sdkTokens === undefined ? "SDK usage unavailable." : "Context window unavailable."
    : overWindow ? `Context exceeds window by ${approximate(sdkTokens - window)} tokens; grid capped.`
    : localTotal > sdkTokens ? "Local text exceeds SDK total; grid uses SDK." : undefined;

  const legend: string[] = [model, ...(headline ? [headline] : []), ...(state ? [state] : []), "",
    `Estimated usage by category${value.complete ? "" : " (partial)"}`];
  for (const name of categoryOrder) {
    const amount = value.amounts[name];
    if (amount <= 0) continue;
    const label = name === "Skills" ? "Skill catalog" : name;
    const amountText = `${approximate(amount)}${window !== undefined ? ` (${share(amount, window)})` : ""}`;
    const details = name === "Memory" ? memoryOrder.filter(part => value.memory[part] > 0)
      .map(part => `${part} ${estimate(value.memory[part])}`).join(", ") : "";
    legend.push(paint(colors[name], `${usedGlyph} ${label} ${amountText}`) + (details ? ` — ${details}` : ""));
  }
  if (coherent && sdkTokens > localTotal)
    legend.push(paint(colors.Difference, `${usedGlyph} Difference ${approximate(sdkTokens - localTotal)} (${share(sdkTokens - localTotal, window)})`));
  if (capacityKnown) {
    const free = Math.max(0, window - sdkTokens);
    legend.push(paint("dim", `${freeGlyph} Free ${approximate(free)} (${share(free, window)})`));
  }

  const legendWidth = width >= 80 && cells.length ? width - 42 : width;
  const wrappedLegend = legend.flatMap(line => line ? wrapTextWithAnsi(line, Math.max(1, legendWidth)) : [""]);
  // Twenty columns is the complete-layout floor. Below it, retain safe text reflow
  // without manufacturing a one-cell-per-row composition.
  if (width < 20 || cells.length === 0) return wrappedLegend;
  const spaced = width >= 80;
  const grid = Array.from({ length: 10 }, (_, row) => cells.slice(row * 20, row * 20 + 20).join(spaced ? " " : ""));
  if (!spaced) return [...grid, ...wrappedLegend];
  const gridWidth = 39;
  return Array.from({ length: Math.max(grid.length, wrappedLegend.length) }, (_, index) => {
    const right = wrappedLegend[index];
    if (!right) return grid[index] ?? "";
    return `${grid[index] ?? " ".repeat(gridWidth)}   ${right}`;
  });
}

export function pendingBar(label: string, value: ReturnType<TraceMemory["pendingTokens"]>, compact = true, paint: Paint = plain): string {
  const number = compact ? compactNumber : (n: number) => n.toLocaleString("en-US");
  if (value.tokens === null) return compact ? `${label.padEnd(13)} ?????????? Unknown/${number(value.trigger)} (${value.state})`
    : `${label}: [??????????] Unknown / ${number(value.trigger)} (${value.state})`;
  const ratio = value.tokens / value.trigger;
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
