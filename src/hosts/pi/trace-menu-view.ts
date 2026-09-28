/**
 * Ticket 82: Pi's renderer for the shared `/trace` menu model (`../trace-menu.ts`). Text, order and
 * numbers come from the shared model; only the ANSI painting and the context grid's glyph layout are
 * Pi's own. The context grid reuses Pi's existing proportional-projection math (`projectComposition`
 * in `session-status.ts`, the maintainer's "not redesigned" ruling) rather than reimplementing it —
 * only the legend beside it is new, per the ticket's redesign (short "SDK"/"local" labels, no
 * footnote paragraphs, one `(partial)`/`unavailable` marker instead).
 */
import { truncateToWidth, visibleWidth, wrapTextWithAnsi } from "@earendil-works/pi-tui";
import { projectComposition, type Paint } from "./session-status.ts";
import type { ContextComposition } from "./context-composition.ts";
import { buildTraceMenu, buildTraceSettings, formatCompactTokens, type TraceMenuInput, type SettingsInput } from "../trace-menu.ts";

export type { Paint } from "./session-status.ts";

const GRID_COLUMNS = 20;
const glyphs = (["⛁", "⛶", "⛀"] as const).every(g => visibleWidth(g) === 1) ? (["⛁", "⛶", "⛀"] as const) : (["#", ".", "+"] as const);
const [FULL, FREE, PARTIAL] = glyphs;

/** Only System/Tools/Skills/Conversation/Other/Knowledge/Facts/Raw/Unclassified feed the grid; the
 * shared model's category labels map back onto `ContextComposition`'s field names one-for-one. */
const LABEL_TO_FIELD: Record<string, { bucket: "amounts" | "memory"; key: string }> = {
  System: { bucket: "amounts", key: "System" }, Tools: { bucket: "amounts", key: "Tools" },
  "Skill catalog": { bucket: "amounts", key: "Skills" }, Conversation: { bucket: "amounts", key: "Conversation" },
  Other: { bucket: "amounts", key: "Other" }, Knowledge: { bucket: "memory", key: "Knowledge" },
  Facts: { bucket: "memory", key: "Facts" }, Raw: { bucket: "memory", key: "Raw" },
  "Memory, unclassified": { bucket: "memory", key: "Unclassified" },
};

function toContextComposition(input: TraceMenuInput["context"]): ContextComposition {
  const amounts: Record<string, number> = { System: 0, Tools: 0, Skills: 0, Memory: 0, Conversation: 0, Other: 0 };
  const memory: Record<string, number> = { Knowledge: 0, Facts: 0, Raw: 0, Unclassified: 0 };
  const add = (record: Record<string, number>, key: string, amount: number) => { record[key] = (record[key] ?? 0) + amount; };
  for (const c of input.categories ?? []) {
    const label = c.name === "Skills" ? "Skill catalog" : c.name === "Unclassified" ? "Memory, unclassified" : c.name;
    const field = LABEL_TO_FIELD[label];
    if (!field) continue;
    if (field.bucket === "amounts") add(amounts, field.key, c.tokens);
    else { add(memory, field.key, c.tokens); add(amounts, "Memory", c.tokens); }
  }
  return {
    amounts: amounts as ContextComposition["amounts"], memory: memory as ContextComposition["memory"],
    complete: input.complete ?? true, sdkTokens: input.sdk?.tokens, sdkDifference: undefined,
    window: input.sdk?.window, total: Object.values(amounts).reduce((s, n) => s + n, 0),
  };
}

// The complete-layout floor, unchanged from Pi's existing grid module (`context-composition.ts`):
// below 20 columns the grid is dropped entirely, never squeezed into a broken one-cell-per-row reflow.
const GRID_WIDTH_FLOOR = 20;
// A full spaced grid row (20 glyphs, single-space separated) vs. a compact one (no separator).
const GRID_SPACED_WIDTH = GRID_COLUMNS * 2 - 1;
const GRID_COMPACT_WIDTH = GRID_COLUMNS;
// Gap between the grid column and the legend column in the side-by-side layout.
const LEGEND_GAP = "   ";

/**
 * `minRows` pads every row — including rows past `projectComposition`'s own last row — out to
 * `GRID_COLUMNS` FREE glyphs, instead of leaving them short or empty. Ticket 82 requirement 4: a
 * short row padded with plain ASCII spaces measures the same *character count* as a full glyph row
 * under `visibleWidth` (which reports 1 column per glyph), but many terminals actually draw these
 * dice/box-drawing glyphs wider than a plain space; mixing the two within what must be one aligned
 * column then visibly shifts every legend line beside a short or grid-less row to the left. Padding
 * with the same FREE glyph the real cells use keeps every row's rendered width consistent with a
 * full row, regardless of how wide the terminal actually draws that glyph.
 */
function renderContextGrid(input: TraceMenuInput["context"], paint: Paint, spaced: boolean, minRows: number): string[] {
  if (!input.sdk || !input.categories) return [];
  const composition = toContextComposition(input);
  const projection = projectComposition(composition);
  if (!projection) return [];
  const cells: string[] = [];
  for (const segment of projection.segments) {
    for (let i = 0; i < segment.fullCells; i++) cells.push(paint(segment.color, FULL));
    if (segment.partial) cells.push(paint(segment.color, PARTIAL));
  }
  for (let i = 0; i < projection.freeGlyphs; i++) cells.push(paint("free", FREE));
  const separator = spaced ? " " : "";
  const rows = Math.max(projection.rows, minRows);
  return Array.from({ length: rows }, (_, row) => {
    const rowCells = cells.slice(row * GRID_COLUMNS, row * GRID_COLUMNS + GRID_COLUMNS);
    while (rowCells.length < GRID_COLUMNS) rowCells.push(paint("free", FREE));
    return rowCells.join(separator);
  });
}

/** Pi renderer for the main screen: header, context, Pending/trigger, spend, notices, actions. */
export function renderTraceMenu(input: TraceMenuInput, width: number, paint: Paint = (_c, t) => t): string[] {
  const model = buildTraceMenu(input);
  const lines: string[] = [model.header, ""];

  const legend: string[] = [
    model.context.model,
    model.context.sdkLine ?? `SDK usage ${model.context.sdkUnavailable}`,
    "",
    model.context.localHeading,
  ];
  if (model.context.categoriesUnavailable) legend.push(model.context.categoriesUnavailable);
  else for (const c of model.context.categories) legend.push(paint(c.color, `${FULL} ${c.label.padEnd(21)} ${formatCompactTokens(c.tokens).padStart(6)}  (${c.share})`));
  if (model.context.free) legend.push(paint("free", `${FREE} ${"Free".padEnd(21)} ${formatCompactTokens(model.context.free.tokens).padStart(6)}  (${model.context.free.share} of window)`));

  // Side by side when the pane is wide enough for a full grid row, the gap and the longest legend
  // line without wrapping; otherwise stacked (grid first, then legend, ticket 82 requirement 3). The
  // grid glyphs themselves are single-space separated whenever a full spaced row still fits `width`
  // on its own — that choice is independent of the side-by-side/stacked one, since a stacked grid
  // gets the whole line to itself.
  const spaced = width >= GRID_SPACED_WIDTH;
  const gridRowWidth = spaced ? GRID_SPACED_WIDTH : GRID_COMPACT_WIDTH;
  const legendWidth = legend.length ? Math.max(...legend.map(l => visibleWidth(l))) : 0;
  const sideBySide = width >= GRID_WIDTH_FLOOR && width >= gridRowWidth + LEGEND_GAP.length + legendWidth;
  const grid = width < GRID_WIDTH_FLOOR ? [] : renderContextGrid(input.context, paint, spaced, sideBySide ? legend.length : 0);

  if (sideBySide && grid.length) {
    const gridWidth = visibleWidth(grid[0]!);
    for (let i = 0; i < Math.max(grid.length, legend.length); i++) {
      const left = grid[i] ?? " ".repeat(gridWidth);
      lines.push(legend[i] ? `${left}${LEGEND_GAP}${legend[i]}` : left);
    }
  } else {
    lines.push(...grid, ...legend);
  }
  lines.push("");

  lines.push(model.pending.heading);
  const pendingLine = (row: (typeof model.pending)["noting"], indent = "  ") => {
    if (row.tokens === null) return `${indent}${row.label.padEnd(13)} Unknown / ${row.trigger ?? "Unknown"}`;
    const filled = Math.min(10, Math.floor((row.ratio ?? 0) * 10));
    const bar = paint("accent", "█".repeat(filled)) + paint("dim", "░".repeat(10 - filled));
    return `${indent}${row.label.padEnd(13)} ${bar} ${row.percent.padStart(4)}   ${row.amount}`;
  };
  lines.push(pendingLine(model.pending.noting));
  lines.push(`  ${model.pending.dreamingHeading}`);
  for (const row of model.pending.dreaming) lines.push(pendingLine(row, "    "));
  lines.push("");

  lines.push(model.spend.sessionLine);
  lines.push(`        ${model.spend.phaseLine}`);
  lines.push(model.spend.todayLine);

  for (const notice of model.notices) { lines.push(""); lines.push(paint("accent", `! ${notice}`)); }

  lines.push("");
  lines.push(`› ${model.actions.join("    ")}`);

  return lines.flatMap(line => wrapTextWithAnsi(line, Math.max(1, width))).map(line => truncateToWidth(line, Math.max(1, width), ""));
}

/** Pi renderer for the Settings screen: budgets, workers (with the Pi-only mode column), closed sessions. */
export function renderTraceSettings(input: SettingsInput, width: number, paint: Paint = (_c, t) => t): string[] {
  const model = buildTraceSettings(input);
  const lines: string[] = [model.header, "", "Knowledge budgets"];
  for (const row of model.budgets.rows) lines.push(`  ${row.label.padEnd(11)} ${row.value.padStart(6)}${row.qualifier ? `  ${row.qualifier}` : ""}`);
  lines.push(`  ${model.budgets.derivedLine}`, "", model.workers.showModeColumn ? "Workers        mode       model                thinking" : "Workers        model                thinking");
  for (const w of model.workers.rows) {
    const mode = model.workers.showModeColumn ? `${(w.mode ?? "—").padEnd(10)} ` : "";
    lines.push(`  ${w.phase.padEnd(12)} ${mode}${w.model.padEnd(20)} ${w.thinking}`);
    for (const field of ["mode", "model", "thinking"] as const) {
      const source = w.sources?.[field] ?? (field === "model" ? w.source : undefined);
      if (source) lines.push(`    ${w.phase} ${field}: ${source}`);
    }
  }
  lines.push("", model.closedSessionsLine);
  return lines.flatMap(line => wrapTextWithAnsi(line, Math.max(1, width))).map(line => truncateToWidth(line, Math.max(1, width), ""));
}
