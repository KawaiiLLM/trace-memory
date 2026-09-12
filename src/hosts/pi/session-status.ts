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
  const order = shares.map((value, i) => ({ i, remainder: value - counts[i]! })).sort((a, b) => b.remainder - a.remainder);
  for (let i = 0, left = cells - counts.reduce((sum, count) => sum + count, 0); i < left; i++) counts[order[i]!.i]!++;
  return counts;
}
const estimate = (n: number) => n >= 1_000_000 ? `${(n / 1_000_000).toFixed(1).replace(/\.0$/, "")}M` : n >= 1000 ? `${(n / 1000).toFixed(1).replace(/\.0$/, "")}k` : compactNumber(n);
const share = (value: number, total: number) => total ? (value < total / 100 && percent(value / total) === "1.0%" ? "<1%" : percent(value / total)) : "0.0%";
const colors: Record<string, Parameters<Paint>[0]> = { System: "syntaxKeyword", Tools: "syntaxFunction", Skills: "syntaxString",
  Memory: "accent", Conversation: "syntaxNumber", Other: "syntaxType",
  Knowledge: "syntaxKeyword", Facts: "syntaxString", Raw: "syntaxNumber", Unclassified: "muted" };

export function compositionMap(value: ContextComposition, model: string, width: number, paint: Paint = plain): string[] {
  const window = value.window, sdkTokens = value.sdkTokens;
  const capacityKnown = window !== undefined && sdkTokens !== undefined;
  const preferred = ["⛁", "⛶", "⛀"] as const;
  const [usedGlyph, freeGlyph, partialGlyph] = preferred.every(glyph => visibleWidth(glyph) === 1)
    ? preferred : ["#", ".", "+"] as const;
  let lines: string[];
  if (capacityKnown) {
    const ratio = sdkTokens / window;
    const usedCells = Math.min(100, ratio * 100);
    const fullCells = Math.floor(usedCells);
    const cells = Array.from({ length: 100 }, (_, index) => index < fullCells
      ? paint("accent", usedGlyph) : index < usedCells ? paint("accent", partialGlyph) : paint("dim", freeGlyph));
    const grid = Array.from({ length: 5 }, (_, row) => cells.slice(row * 20, row * 20 + 20).join(width >= 80 ? " " : ""));
    const remaining = Math.max(0, window - sdkTokens);
    const legend = [model,
      `SDK occupancy estimate ~${estimate(sdkTokens)} / ${estimate(window)} (${percent(ratio)})`,
      `${paint("accent", usedGlyph)} Occupied estimate ~${estimate(sdkTokens)} (${percent(ratio)})`,
      `${paint("dim", freeGlyph)} Estimated remaining ~${estimate(remaining)} (${percent(Math.max(0, 1 - ratio))})`];
    const gridWidth = visibleWidth(grid[0]!);
    const right = legend.flatMap(line => wrapTextWithAnsi(line, Math.max(1, width - gridWidth - 3)));
    lines = width >= 80 ? Array.from({ length: Math.max(5, right.length) }, (_, i) =>
      `${grid[i] ?? " ".repeat(gridWidth)}${right[i] ? `   ${right[i]}` : ""}`) : [...grid, ...legend];
  } else {
    lines = [model, `Capacity estimate unavailable: ${sdkTokens === undefined ? "SDK usage" : "context window"} unavailable.`];
    if (sdkTokens !== undefined) lines.push(`SDK occupancy estimate ~${estimate(sdkTokens)}; remaining unavailable.`);
  }

  const local = Object.entries(value.amounts);
  lines.push("", `Local rebuilt text ~${estimate(value.total)}${window !== undefined ? ` / ${estimate(window)} (${share(value.total, window)})` : ""}`,
    ...local.filter(([, amount]) => amount > 0).map(([name, amount]) =>
      `${paint(colors[name]!, usedGlyph)} ${name === "Skills" ? "Skill catalog" : name} ~${estimate(amount)}${window !== undefined ? ` (${share(amount, window)})` : ""}`));
  if (sdkTokens !== undefined) {
    const difference = value.sdkDifference!;
    if (difference === 0) lines.push("SDK and local rebuilt text estimates match numerically.");
    else if (difference > 0) lines.push(`SDK estimate is ~${estimate(difference)} above local rebuilt text estimate; unclassified numerical gap.`);
    else lines.push(`SDK estimate is ~${estimate(-difference)} below local rebuilt text estimate; local categories are not reduced.`);
  }
  if (!value.complete) lines.push("Local census incomplete: some text or non-text content is unmeasured; the SDK/text difference does not identify or measure it.");

  lines.push("", `Memory ~${estimate(value.amounts.Memory)}`);
  const parts = Object.entries(value.memory), bar = allocateCells(parts.map(([, n]) => n), Math.max(1, Math.min(60, width)));
  const solid = visibleWidth("█") === 1 ? "█" : "#";
  lines.push(value.amounts.Memory ? parts.map(([name], i) => paint(colors[name]!, solid.repeat(bar[i]!))).join("") : paint("dim", "No retained memory"));
  if (value.amounts.Memory) lines.push(parts.filter(([, n]) => n > 0).map(([name, n]) => `${paint(colors[name]!, usedGlyph)} ${name} ${estimate(n)}${n < value.amounts.Memory / 100 ? ` (${share(n, value.amounts.Memory)})` : ""}`).join("  "));
  lines.push("", "Pi rebuilt text estimate (not provider wire)",
    "SDK occupancy and remaining are estimates; remaining is not guaranteed free space.", "");
  return lines;
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
