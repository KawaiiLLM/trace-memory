/**
 * Ticket 82: Claude Code's renderer for the shared `/trace` menu model (`../trace-menu.ts`). This
 * module does no JSX and no `$` calls — it turns the shared model plus Claude Code's own context data
 * into plain row/grid data a hooks module's `ui.render` hook can hand to `Box`/`Text` directly.
 *
 * Maintainer correction (2026-09-24): the context section is NOT drawn through the shared
 * `buildContextSection`/`projectComposition` pipeline the way Pi's is. It copies Claude Code's own
 * built-in `/context` command verbatim — same grid, same legend wording, same colours — because
 * reinventing that drawing (this module's earlier hand-rolled grid function) looked nothing like it. The
 * grid comes from `$.session.usage({ breakdown: "full", columns }).context.breakdown.gridRows`,
 * rendered cell by cell exactly as returned: this module never computes cell counts or positions.
 * Each cell and each category carries its own `color`, a semantic token (e.g. "promptBorder",
 * "inactive", "purple_FOR_SUBAGENTS_ONLY") that Claude Code's own `<Text color>` resolves — the same
 * component the built-in UI paints with (`$.ui.resolve(e)`), verified against a live capture of
 * `/context` in the fenced sandbox (see the ticket 82 delegation report for the captured ANSI codes).
 *
 * The only change from the native command (maintainer's ruling B): Knowledge, Facts and Raw are
 * pulled out of the SDK's "Messages" category and shown as their own rows, with Messages reduced by
 * exactly their sum. Everything else — model line, grid, category wording, the "Free space" row's
 * missing " tokens" suffix, one-decimal category percentages, whole-number total percentage — is
 * copied from the real command, not redesigned.
 */
import { buildTraceMenu, formatPercent, formatCompactTokens, buildTraceSettings, type TraceMenuInput, type SettingsInput } from "../trace-menu.ts";

// ---- Claude Code's own context breakdown (from `$.session.usage`, step 0 check 5) ----------------

/** One cell of the SDK's own pre-rendered grid (`context.breakdown.gridRows`), verified live
 * (ticket 82 report): `color` is a semantic token, not a hex/ANSI value. */
export interface CcGridCell { color: string; isFilled: boolean; categoryName: string; tokens: number; percentage: number; squareFullness: number }
/** One row of the SDK's own category list (`context.breakdown.categories`), in its own order and
 * wording — never Pi's `CONTEXT_CATEGORY_ORDER` labels. */
export interface CcSdkCategory { name: string; tokens: number; color: string; kind: "used" | "free" | "buffer" | "deferred" }
export interface CcContextBreakdown {
  model: string;
  totalTokens: number;
  maxTokens: number;
  /** The SDK's own whole-number percentage for the total line (`"31.6k/1m tokens (3%)"`) — used as
   * given, never recomputed or rounded differently. */
  percentage: number;
  gridRows: CcGridCell[][];
  categories: CcSdkCategory[];
}

/** Ruling B's split: the Knowledge/Facts/Raw/unclassified-memory amounts this host injected, pulled
 * out of the SDK's "Messages" category. `undefined` means presence could not be established exactly
 * for this session — the ticket's rule then is one `unavailable` marker, Messages left untouched. */
export interface CcMemorySplit { knowledge: number; facts: number; raw: number; unclassified: number }

// The reserved "_FOR_SUBAGENTS_ONLY" colour tokens are Claude Code's own extra categorization palette
// (seen live coloring "MCP tools" cyan and "Messages" purple); reused here for the three split rows
// since the SDK has no colour of its own for categories it doesn't know about. A judgment call — the
// ticket does not name a colour for these rows — flagged in the delegation report.
const MEMORY_COLOR = {
  knowledge: "yellow_FOR_SUBAGENTS_ONLY",
  facts: "green_FOR_SUBAGENTS_ONLY",
  raw: "blue_FOR_SUBAGENTS_ONLY",
  unclassified: "red_FOR_SUBAGENTS_ONLY",
} as const;

export interface CcContextLegendRow { label: string; color: string; glyph: string; tokens: number; tokensLabel: string; percent: string; suffix: string }
export interface CcGridCellView { glyph: string; color: string }
export interface CcContextSection {
  headerLines: string[];
  gridRows: CcGridCellView[][];
  legendHeading: string;
  legend: CcContextLegendRow[];
  memoryUnavailable?: string;
}

// Real `/context` uses lowercase "k"/"m" ("31.6k/1m tokens"), unlike the shared model's "1.9k"/"M".
const ccCompact = (n: number): string => {
  if (n >= 1_000_000) { const s = (n / 1_000_000).toFixed(1); return `${s.endsWith(".0") ? s.slice(0, -2) : s}m`; }
  if (n >= 1_000) { const s = (n / 1_000).toFixed(1); return `${s.endsWith(".0") ? s.slice(0, -2) : s}k`; }
  return String(n);
};

// Verified live (ticket 82 report, `probectx`/`probecolor` probes against the fenced sandbox): every
// grid cell has `isFilled: true`, including the ones that make up "Free space" — `isFilled` marks a
// cell as assigned to some category, not as "not free". The real UI instead renders every cell whose
// category is the free-kind one with the empty glyph and the neutral "inactive" colour, regardless of
// that category's own reported `color` ("promptBorder": the captured free-space legend swatch and grid
// cells were colour 246 "inactive", not 244 "promptBorder"). Filled (non-free) cells use "⛁"/"⛀" by
// `squareFullness` and the cell's own colour, matching the capture exactly.
const FREE_GLYPH_COLOR = "inactive";
const FULL_GLYPH = "⛁", PARTIAL_GLYPH = "⛀", FREE_GLYPH = "⛶";

/** Builds Claude Code's own context section: the grid verbatim (cell positions and counts are the
 * SDK's, never recomputed here), the legend in `/context`'s own wording, with Knowledge/Facts/Raw
 * spliced in ahead of a reduced "Messages" row (ruling B). Returns `undefined` when Claude Code has no
 * breakdown at all (ticket: shows `unavailable`, points at the built-in `/context`). */
export function buildCcContextSection(breakdown: CcContextBreakdown | undefined, memory: CcMemorySplit | undefined): CcContextSection | undefined {
  if (!breakdown) return undefined;
  const headerLines = [
    breakdown.model,
    `${ccCompact(breakdown.totalTokens)}/${ccCompact(breakdown.maxTokens)} tokens (${breakdown.percentage}%)`,
  ];

  const freeNames = new Set(breakdown.categories.filter(c => c.kind === "free").map(c => c.name));
  const gridRows: CcGridCellView[][] = breakdown.gridRows.map(row => row.map(cell => freeNames.has(cell.categoryName)
    ? { glyph: FREE_GLYPH, color: FREE_GLYPH_COLOR }
    : { glyph: cell.squareFullness >= 1 ? FULL_GLYPH : PARTIAL_GLYPH, color: cell.color }));

  const row = (label: string, color: string, tokens: number, suffix: string, isFree: boolean): CcContextLegendRow => ({
    label, color: isFree ? FREE_GLYPH_COLOR : color, glyph: isFree ? FREE_GLYPH : FULL_GLYPH, tokens,
    tokensLabel: ccCompact(tokens), percent: formatPercent(breakdown.maxTokens > 0 ? tokens / breakdown.maxTokens : 0), suffix,
  });

  const rows: CcContextLegendRow[] = [];
  for (const cat of breakdown.categories) {
    const isFree = cat.kind === "free";
    if (cat.name === "Messages" && memory) {
      const split = memory.knowledge + memory.facts + memory.raw + memory.unclassified;
      const remainder = Math.max(0, cat.tokens - split);
      if (memory.knowledge > 0) rows.push(row("Knowledge", MEMORY_COLOR.knowledge, memory.knowledge, " tokens", false));
      if (memory.facts > 0) rows.push(row("Facts", MEMORY_COLOR.facts, memory.facts, " tokens", false));
      if (memory.raw > 0) rows.push(row("Raw", MEMORY_COLOR.raw, memory.raw, " tokens", false));
      if (memory.unclassified > 0) rows.push(row("Memory, unclassified", MEMORY_COLOR.unclassified, memory.unclassified, " tokens", false));
      if (remainder > 0) rows.push(row(cat.name, cat.color, remainder, " tokens", false));
      continue;
    }
    rows.push(row(cat.name, cat.color, cat.tokens, isFree ? "" : " tokens", isFree));
  }

  return {
    headerLines,
    gridRows,
    legendHeading: "Estimated usage by category",
    legend: rows,
    memoryUnavailable: memory ? undefined : (breakdown.categories.some(c => c.name === "Messages") ? "Knowledge, Facts, Raw: unavailable" : undefined),
  };
}

// ---- Pending / trigger (shared wording, CC's own plain-text bar) ----------------------------------

// Same bar as Pi's renderer (10 cells, floor(ratio*10) filled) — a decoration, not a number, but the
// two hosts should still match on it rather than one silently dropping it.
const bar = (ratio: number) => { const filled = Math.min(10, Math.floor(ratio * 10)); return "█".repeat(filled) + "░".repeat(10 - filled); };
const pendingLine = (label: string, row: { tokens: number | null; trigger: number | null; ratio: number | null; percent: string }, indent = "  ") =>
  row.tokens === null ? `${indent}${label}: Unknown / ${row.trigger ?? "Unknown"}`
    : `${indent}${label.padEnd(13)} ${bar(row.ratio ?? 0)} ${row.percent.padStart(4)}   ${formatCompactTokens(row.tokens)} / ${formatCompactTokens(row.trigger!)}`;

// ---- Whole-menu model ------------------------------------------------------------------------------

export interface RenderedMenu {
  header: string;
  context?: CcContextSection;
  contextUnavailable?: string;
  pendingHeading: string;
  pendingLines: string[];
  spendLines: string[];
  notices: string[];
  actions: { value: string; label: string }[];
}

export function renderTraceMenu(input: TraceMenuInput, cc: { breakdown?: CcContextBreakdown; memory?: CcMemorySplit }): RenderedMenu {
  const model = buildTraceMenu(input);
  const context = buildCcContextSection(cc.breakdown, cc.memory);
  return {
    header: model.header,
    context,
    contextUnavailable: context ? undefined : "unavailable — see the built-in /context",
    pendingHeading: model.pending.heading,
    pendingLines: [
      pendingLine("Noting", model.pending.noting), pendingLine("Consolidation", model.pending.consolidation),
      "  Dreaming",
      pendingLine("global", model.pending.dreaming.global, "    "),
      pendingLine("project", model.pending.dreaming.project, "    "),
      pendingLine("session", model.pending.dreaming.session, "    "),
    ],
    spendLines: [model.spend.sessionLine, `        ${model.spend.phaseLine}`, model.spend.todayLine],
    notices: model.notices,
    actions: model.actions.map(a => ({ value: a.toLowerCase().replace(/[^a-z]+/g, "-").replace(/-$/, ""), label: a })),
  };
}

export interface RenderedSettings {
  header: string;
  budgetLines: string[];
  derivedLine: string;
  workerHeader: string;
  workerLines: string[];
  closedSessionsLine: string;
}

export function renderTraceSettings(input: SettingsInput): RenderedSettings {
  const model = buildTraceSettings(input);
  return {
    header: model.header,
    budgetLines: model.budgets.rows.map(row => `${row.label.padEnd(9)} ${row.value.padStart(6)}${row.qualifier ? `  ${row.qualifier}` : ""}`),
    derivedLine: model.budgets.derivedLine,
    // Ticket: the mode column exists on Pi only, because Claude Code workers have no fork mode.
    workerHeader: "Workers        model                thinking",
    workerLines: model.workers.rows.map(w => `${w.phase.padEnd(14)} ${w.model.padEnd(20)} ${w.thinking}${w.source ? ` (${w.source})` : ""}`),
    closedSessionsLine: model.closedSessionsLine,
  };
}
