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
 *
 * Colour ruling (2026-09-24): the four memory rows share one warm family instead of four unrelated
 * hues, defined once in the shared model (`MEMORY_COLOR_HEX`). `<Text color>` accepts a literal hex
 * string directly (verified live: a throwaway probe pane rendered `color="#f08b48"` as the exact RGB
 * under `COLORTERM=truecolor`, and as the nearest 256-color approximation without it — see the ticket
 * 82 delegation report), so this reuses Pi's own hex values rather than a theme token.
 *
 * The ruling extends to the grid, not only the legend (maintainer, 2026-09-24): the SDK's own grid
 * cells for "Messages" are undifferentiated — they cover the memory tokens too, since the SDK counts
 * injected memory inside Messages. `splitMessagesGridCounts` recolours a proportional prefix of those
 * cells (grid order, Knowledge/Facts/Raw/Unclassified) to the memory family; the rest keep the
 * Messages colour. Cell positions, glyphs and every non-Messages cell are the SDK's, untouched.
 */
import { buildTraceMenu, formatPercent, formatCompactTokens, buildTraceSettings, MEMORY_COLOR_HEX, type TraceMenuInput, type SettingsInput } from "../trace-menu.ts";

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

// The shared model's hex values (ticket 82 colour ruling): the SDK has no colour of its own for
// categories it doesn't know about, so these four rows paint with the same warm family Pi uses,
// instead of Claude Code's unrelated "_FOR_SUBAGENTS_ONLY" theme tokens.
const MEMORY_COLOR = MEMORY_COLOR_HEX;

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

/** How many of the Messages cells (in the grid's own order) become each memory colour: each category's
 * share is `round(tokens / messagesTokens * messagesCellCount)`, taken in the order Knowledge, Facts,
 * Raw, Unclassified and capped by the cells still unassigned — so the four counts never sum past
 * `messagesCellCount`, even when every one of them rounds up. A category whose own rounded share would
 * overflow what's left is truncated to what's left; it never steals from an earlier category. */
export function splitMessagesGridCounts(messagesCellCount: number, messagesTokens: number, memory: CcMemorySplit): CcMemorySplit {
  let remaining = messagesCellCount;
  const take = (tokens: number): number => {
    if (messagesTokens <= 0 || remaining <= 0 || tokens <= 0) return 0;
    const count = Math.min(remaining, Math.round((tokens / messagesTokens) * messagesCellCount));
    remaining -= count;
    return count;
  };
  return { knowledge: take(memory.knowledge), facts: take(memory.facts), raw: take(memory.raw), unclassified: take(memory.unclassified) };
}

/** Builds Claude Code's own context section: the grid verbatim (cell positions and counts are the
 * SDK's, never recomputed here), the legend in `/context`'s own wording, with Knowledge/Facts/Raw
 * spliced in ahead of a reduced "Messages" row (ruling B). Returns `undefined` when Claude Code has no
 * breakdown at all (ticket: shows `unavailable`, points at the built-in `/context`).
 *
 * Requirement 2 ("rows never vanish"): Knowledge, Facts and Raw are always in the legend once `memory`
 * is supplied at all — zero when nothing was injected — and "Memory, unclassified" only when non-zero.
 * `memory` need not line up with a "Messages" category: a fresh session with no message sent has none
 * (the bug this fixes), so the three rows are inserted where "Messages" would sit — just before the
 * first free-kind category, or at the end if there is none — rather than only when "Messages" exists.
 * When the supplied amounts are inconsistent with what Claude Code reports (their sum exceeds a present
 * "Messages" category, or "Messages" is absent while the sum is positive), that is not presence: the
 * three rows and the Messages adjustment fall back to `unavailable`, Messages keeps Claude Code's own
 * figure, and the grid keeps Claude Code's own colours — same as `memory` being `undefined` (presence
 * could not be established at all). */
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

  const messagesCategory = breakdown.categories.find(c => c.name === "Messages");
  const memorySum = memory ? memory.knowledge + memory.facts + memory.raw + memory.unclassified : 0;
  const inconsistent = memory !== undefined && (messagesCategory ? memorySum > messagesCategory.tokens : memorySum > 0);
  const effectiveMemory = inconsistent ? undefined : memory;

  // Grid half of ruling B (maintainer, 2026-09-24): recolour a proportional prefix of the Messages
  // cells to the memory family, in grid order. `.flat()` shares object references with `gridRows`, so
  // painting the flat view mutates the same cells the 2-D array returns — no geometry is rebuilt.
  if (effectiveMemory && messagesCategory) {
    const messagesCellIndexes = breakdown.gridRows.flat()
      .flatMap((cell, i) => cell.categoryName === "Messages" ? [i] : []);
    const counts = splitMessagesGridCounts(messagesCellIndexes.length, messagesCategory.tokens, effectiveMemory);
    const flatView = gridRows.flat();
    let cursor = 0;
    const paint = (count: number, color: string) => { for (let k = 0; k < count; k++, cursor++) flatView[messagesCellIndexes[cursor]!]!.color = color; };
    paint(counts.knowledge, MEMORY_COLOR.knowledge);
    paint(counts.facts, MEMORY_COLOR.facts);
    paint(counts.raw, MEMORY_COLOR.raw);
    paint(counts.unclassified, MEMORY_COLOR.unclassified);
  }

  const row = (label: string, color: string, tokens: number, suffix: string, isFree: boolean): CcContextLegendRow => ({
    label, color: isFree ? FREE_GLYPH_COLOR : color, glyph: isFree ? FREE_GLYPH : FULL_GLYPH, tokens,
    tokensLabel: ccCompact(tokens), percent: formatPercent(breakdown.maxTokens > 0 ? tokens / breakdown.maxTokens : 0), suffix,
  });

  const rows: CcContextLegendRow[] = [];
  // Where the (up to) four memory rows land: right where "Messages" was, or — a fresh, empty session
  // has no "Messages" category at all — just ahead of the first free-kind row, so the rows still show
  // rather than silently vanishing because there was nothing to splice them into.
  let memoryInsertAt = -1;
  for (const cat of breakdown.categories) {
    const isFree = cat.kind === "free";
    if (isFree && memoryInsertAt === -1 && effectiveMemory) memoryInsertAt = rows.length;
    if (cat.name === "Messages") {
      memoryInsertAt = effectiveMemory ? rows.length : memoryInsertAt;
      const remainder = effectiveMemory ? Math.max(0, cat.tokens - memorySum) : cat.tokens;
      if (remainder > 0) rows.push(row(cat.name, cat.color, remainder, " tokens", false));
      continue;
    }
    rows.push(row(cat.name, cat.color, cat.tokens, isFree ? "" : " tokens", isFree));
  }
  if (effectiveMemory) {
    const memoryRows: CcContextLegendRow[] = [
      row("Knowledge", MEMORY_COLOR.knowledge, effectiveMemory.knowledge, " tokens", false),
      row("Facts", MEMORY_COLOR.facts, effectiveMemory.facts, " tokens", false),
      row("Raw", MEMORY_COLOR.raw, effectiveMemory.raw, " tokens", false),
    ];
    if (effectiveMemory.unclassified > 0) memoryRows.push(row("Memory, unclassified", MEMORY_COLOR.unclassified, effectiveMemory.unclassified, " tokens", false));
    rows.splice(memoryInsertAt === -1 ? rows.length : memoryInsertAt, 0, ...memoryRows);
  }

  return {
    headerLines,
    gridRows,
    legendHeading: "Estimated usage by category",
    legend: rows,
    memoryUnavailable: effectiveMemory
      ? undefined
      : (inconsistent || messagesCategory ? "Knowledge, Facts, Raw: unavailable" : undefined),
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
