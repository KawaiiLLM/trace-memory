/**
 * Ticket 82: Claude Code's renderer for the shared `/trace` menu model (`../trace-menu.ts`). This
 * module does no JSX and no `$` calls — it turns the shared model into plain row/grid data a hooks
 * module's `ui.render` hook can hand to `Box`/`Text`/`Select` (and, once probed, `Raster`) directly.
 * Kept separate from the JSX glue so it type-checks and unit-tests like any other module: the CC
 * engine's isolated hooks environment has no Node and no module resolution for local imports (step 0),
 * so the actual sandboxed preview inlines this file's compiled output rather than importing it.
 *
 * The grid here is CC's own simple proportional fill for the fixture only. In the real
 * implementation Claude Code does not recompute Pi's proportional projection at all: its SDK already
 * returns a ready-made grid (`$.session.usage` `context.breakdown.gridRows`, step 0 check 5), so the
 * two hosts' grids are visually independent by design — only the row content is shared.
 */
import { buildTraceMenu, buildTraceSettings, type TraceMenuInput, type SettingsInput, type ContextColor } from "../trace-menu.ts";

export const GRID_COLUMNS = 20;
export const GRID_TOTAL_CELLS = 200;

export interface GridCell { filled: boolean; color: ContextColor | "free" }

/** A simple float-proportional fill: `occupied` cells split across categories by local share, the
 * remainder to the last nonzero category, and the rest free. Not bit-exact with Pi's bigint
 * projection (`projectComposition`); CC does not need to be, since its production grid comes from a
 * different source entirely (see module doc). */
export function buildContextGrid(localCategories: { color: ContextColor; tokens: number }[], localTotal: number, sdk: { tokens: number; window: number } | undefined): GridCell[][] {
  if (!sdk || localTotal <= 0) return [];
  const occupied = Math.min(GRID_TOTAL_CELLS, Math.round((sdk.tokens / sdk.window) * GRID_TOTAL_CELLS));
  const cells: GridCell[] = [];
  let used = 0;
  for (const c of localCategories) {
    const count = Math.min(occupied - used, Math.round((c.tokens / localTotal) * occupied));
    for (let i = 0; i < count; i++) cells.push({ filled: true, color: c.color });
    used += count;
  }
  const last = localCategories.at(-1);
  while (used < occupied && last) { cells.push({ filled: true, color: last.color }); used++; }
  while (cells.length < GRID_TOTAL_CELLS) cells.push({ filled: false, color: "free" });
  const rows: GridCell[][] = [];
  for (let r = 0; r < cells.length / GRID_COLUMNS; r++) rows.push(cells.slice(r * GRID_COLUMNS, r * GRID_COLUMNS + GRID_COLUMNS));
  return rows;
}

export interface RenderedRow { text: string }
export interface RenderedMenu {
  header: string;
  model: string;
  sdkLine: string;
  grid: GridCell[][];
  localHeading: string;
  categoryLines: string[];
  freeLine?: string;
  pendingHeading: string;
  pendingLines: string[];
  spendLines: string[];
  notices: string[];
  actions: { value: string; label: string }[];
}

const pendingLine = (label: string, row: { tokens: number | null; trigger: number | null; percent: string }, indent = "  ") =>
  row.tokens === null ? `${indent}${label}: Unknown / ${row.trigger ?? "Unknown"}`
    : `${indent}${label.padEnd(13)} ${row.percent.padStart(5)}   ${row.tokens.toLocaleString("en-US")} / ${row.trigger!.toLocaleString("en-US")}`;

export function renderTraceMenu(input: TraceMenuInput): RenderedMenu {
  const model = buildTraceMenu(input);
  const grid = buildContextGrid(model.context.categories, model.context.localTotal, input.context.sdk);
  return {
    header: model.header,
    model: model.context.model,
    sdkLine: model.context.sdkLine ?? `SDK usage ${model.context.sdkUnavailable}`,
    grid,
    localHeading: model.context.localHeading,
    categoryLines: model.context.categoriesUnavailable ? [model.context.categoriesUnavailable]
      : model.context.categories.map(c => `${c.label.padEnd(21)} ${c.tokens.toLocaleString("en-US").padStart(7)}  (${c.share})`),
    freeLine: model.context.free ? `Free${" ".repeat(18)} ${model.context.free.tokens.toLocaleString("en-US").padStart(7)}  (${model.context.free.share} of window)` : undefined,
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
