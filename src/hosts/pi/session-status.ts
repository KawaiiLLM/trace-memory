import { truncateToWidth, visibleWidth, wrapTextWithAnsi } from "@earendil-works/pi-tui";
import type { ContextUsage } from "@earendil-works/pi-coding-agent";
import type { TraceMemory } from "../../core/api/index.ts";

export type Paint = (color: "dim" | "accent", text: string) => string;
const plain: Paint = (_color, text) => text;
const number = (value: number) => value.toLocaleString("en-US");
const valid = (value: unknown): value is number => typeof value === "number" && Number.isFinite(value) && value >= 0;
export const percent = (ratio: number) => ratio > 0 && ratio < 0.001 ? "<0.1%" : `${(ratio * 100).toFixed(1)}%`;

/** A capacity map, not task completion. A partial cell never pretends to be one full percent. */
export function contextMap(usage: ContextUsage | undefined, model: string, width: number, paint: Paint = plain): string[] {
  const known = valid(usage?.tokens) && valid(usage?.contextWindow) && usage.contextWindow > 0;
  const ratio = known ? usage.tokens! / usage.contextWindow : undefined;
  const cells = 100, used = ratio === undefined ? 0 : Math.min(cells, ratio * cells);
  const glyphs = ["▪", "▫", "◦"].every(g => visibleWidth(g) === 1) ? ["▪", "▫", "◦"] : ["#", ".", "+"];
  const [full, free, part] = glyphs as [string, string, string];
  const summary = [`Context: ${model}`, known ? `${number(usage.tokens!)} / ${number(usage.contextWindow)} tokens (${percent(ratio!)})`
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
      `${grid[i] ?? " ".repeat(gridWidth)}   ${paint("dim", right[i] ?? "")}`);
  }
  return [...grid, ...summary.map(line => paint("dim", line))];
}

export function pendingBar(label: string, value: ReturnType<TraceMemory["pendingTokens"]>): string {
  if (value.tokens === null) return `${label}: [??????????] Unknown / ${number(value.trigger)} (${value.state})`;
  const ratio = value.tokens / value.trigger;
  const filled = Math.min(10, Math.floor(ratio * 10));
  const partial = filled < 10 && ratio * 10 > filled;
  return `${label}: [${"#".repeat(filled)}${partial ? "+" : ""}${".".repeat(10 - filled - Number(partial))}] ${number(value.tokens)} / ${number(value.trigger)} (${percent(ratio)})`;
}

/** Native select's Text handles resize; pre-wrap makes the initial narrow layout deterministic. */
export function statusBody(lines: string[], width: number, paint: Paint = plain): string {
  return lines.flatMap(line => wrapTextWithAnsi(line, Math.max(1, width))).map(line => paint("dim", truncateToWidth(line, Math.max(1, width), ""))).join("\n");
}
