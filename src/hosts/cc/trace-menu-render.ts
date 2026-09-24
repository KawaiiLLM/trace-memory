/**
 * Ticket 82: Claude Code's renderer for the shared `/trace` menu model (`../trace-menu.ts`). This
 * module does no JSX and no `$` calls — it turns the shared model plus Claude Code's own context data
 * into plain row/grid data a hooks module's `ui.render` hook can hand to `Box`/`Text` directly.
 *
 * The context section copies Claude Code's own built-in `/context` command: same legend wording, same
 * category colours (semantic tokens Claude Code's own `<Text color>` resolves, e.g. "promptBorder",
 * "inactive", "purple_FOR_SUBAGENTS_ONLY" — verified against a live capture of `/context` in the fenced
 * sandbox, `/tmp/cc82-samples/cc-context-reference.ans`, and the ticket 82 delegation report).
 *
 * Requirement 2 (2026-09-24 ruling): the grid is no longer taken from the SDK's own pre-rendered
 * `context.breakdown.gridRows` — it is computed HERE, from the category list, by Claude Code's own grid
 * rule (read from the pinned 2.1.280 binary: `name:"Memory files",tokens:` in
 * `/opt/homebrew/lib/node_modules/@anthropic-ai/claude-code/bin/claude.exe`, function `Szt`). That rule:
 *   - `columns = terminalWidth<80 ? 5 : (maxTokens>=1_000_000 ? 20 : 10)`,
 *     `rows = maxTokens>=1_000_000 ? 10 : (terminalWidth<80 ? 5 : 10)` — a narrow pane and a small window
 *     each shrink the grid independently; `cells = columns*rows`.
 *   - Every category except a `"deferred"` one gets `squares`: `Math.max(1, Math.round(tokens/window*cells))`
 *     for a `"used"`/`"buffer"` category, plain `Math.round(tokens/window*cells)` (no floor) for the
 *     `"free"` one — but a category's own `squares` count is NOT what fills the grid for the free-kind
 *     category: the real algorithm fills free-space cells with *whatever is left* after every other
 *     category has taken its squares (`Us = totalCells - bufferSquares`, filled with free glyphs until
 *     `go.length` reaches it), and only then appends the buffer category's own cells. Verified against
 *     the reference capture: System prompt (1,900/1,000,000 tokens) got a forced 1 partial cell, System
 *     tools (27,600) got 6 (5 full + 1 partial), Skills (2,000) got 1 partial, and the remaining 192 of
 *     200 cells were free — not 194, which is what `Math.round(968,400/1,000,000*200)` alone would give.
 *     This module follows the capture, not the literal `Math.round` wording, for the free category's own
 *     cell *count* (`computeCcGrid`'s doc comment repeats this).
 *   - A category's last square may be partial: `squareFullness` is the fractional part of its own raw
 *     `tokens/window*cells`, applied to the square at that fractional position (not necessarily the last
 *     one requested, when `squares` was floored up from a sub-1 raw value to the forced minimum of 1).
 *
 * The only content change from the real command (maintainer's ruling B): Knowledge, Facts and Raw are
 * pulled out of the SDK's "Messages" category and shown as their own rows, with Messages reduced by
 * exactly their sum, then scaled to Claude Code's own tokenizer (requirement 4, `scaleMemoryToMessages`).
 * Everything else — model line, grid rule, category wording, the "Free space" row's missing " tokens"
 * suffix, one-decimal category percentages, whole-number total percentage — is copied from the real
 * command, not redesigned.
 */
import { buildTraceMenu, formatPercent, buildTraceSettings, MEMORY_COLOR_HEX, type TraceMenuInput, type SettingsInput } from "../trace-menu.ts";

// ---- Claude Code's own context breakdown (from `$.session.usage`, step 0 check 5) ----------------

/** One row of the SDK's own category list (`context.breakdown.categories`), in its own order and
 * wording — never Pi's `CONTEXT_CATEGORY_ORDER` labels. `kind` is Claude Code's own classification
 * (`Fer` in the pinned binary: `"free"` for the row named "Free space", `"buffer"` for "Autocompact
 * buffer"/"Compact buffer", `"deferred"` for a row it marked `isDeferred`, `"used"` otherwise). */
export interface CcSdkCategory { name: string; tokens: number; color: string; kind: "used" | "free" | "buffer" | "deferred" }
export interface CcContextBreakdown {
  model: string;
  totalTokens: number;
  maxTokens: number;
  /** The SDK's own whole-number percentage for the total line (`"31.6k/1m tokens (3%)"`) — used as
   * given, never recomputed or rounded differently. */
  percentage: number;
  categories: CcSdkCategory[];
  /** Requirement 3: the real `/context` legend opens with the model's display name ("Opus 5.5 (1M
   * context)") ahead of its id. The pinned 2.1.280 SDK's `$.session.usage` breakdown carries no such
   * field — traced to its source (`Ylt`, the function that reshapes `contextData()`'s return value into
   * the public shape): `model` is the only model-identifying field it forwards. `displayName` is kept
   * optional so a future SDK version that adds one is picked up with no code change; on this version it
   * is always `undefined`, and the legend falls back to the id alone (reported in the ticket 82 report,
   * not guessed at). */
  displayName?: string;
  /** The pane width `$.session.usage({ columns })` was called with. Claude Code's own grid rule branches
   * on it (`terminalWidth < 80`) exactly as it branches on `maxTokens >= 1_000_000`; both together decide
   * the grid's cell count (see the module doc). `undefined` is treated as "not narrow". */
  terminalWidth?: number;
}

/** Ruling B's split: the Knowledge/Facts/Raw/unclassified-memory amounts this host injected, pulled out
 * of the SDK's "Messages" category, sized with this project's own `tokens()` estimator (requirement 4:
 * *before* scaling — see `scaleMemoryToMessages`). `undefined` means presence could not be established
 * exactly for this session — the ticket's rule then is one `unavailable` marker, Messages left untouched. */
export interface CcMemorySplit { knowledge: number; facts: number; raw: number; unclassified: number }

// The shared model's hex values (ticket 82 colour ruling): the SDK has no colour of its own for
// categories it doesn't know about, so these four rows paint with the same green family Pi uses, instead
// of Claude Code's unrelated "_FOR_SUBAGENTS_ONLY" theme tokens.
const MEMORY_COLOR = MEMORY_COLOR_HEX;
const memorySplitSum = (m: CcMemorySplit): number => m.knowledge + m.facts + m.raw + m.unclassified;

/**
 * Requirement 4 (maintainer, 2026-09-24: “把我们的估计按实际上下文比例缩放”): Claude Code's own tokenizer
 * counts more than this project's `tokens()` estimator. `factor = messagesTokens / contextTokens`, where
 * `contextTokens` is `tokens()` of every message in the current context, the injected carriers included
 * — the same content Claude Code's "Messages" total counts, measured with this project's estimator
 * instead of Claude Code's. Each carrier's row becomes `round(estimate * factor)`.
 *
 * An all-zero split needs no scaling. Allocate the rounded total using largest remainders rather
 * than rounding every category independently: that conserves the Messages row when several small
 * memory components would each round up. A missing or inconsistent denominator is unavailable. */
export function scaleMemoryToMessages(memory: CcMemorySplit, messagesTokens: number | undefined, contextTokens: number | undefined): CcMemorySplit | undefined {
  const sum = memorySplitSum(memory);
  if (sum === 0) return memory;
  if (messagesTokens === undefined || !contextTokens || sum > contextTokens || messagesTokens < 0) return undefined;
  const factor = messagesTokens / contextTokens;
  const keys = ["knowledge", "facts", "raw", "unclassified"] as const;
  const parts = keys.map((key, index) => ({ key, index, exact: memory[key] * factor, amount: Math.floor(memory[key] * factor) }));
  let remainder = Math.round(sum * factor) - parts.reduce((total, part) => total + part.amount, 0);
  for (const part of [...parts].sort((a, b) => (b.exact - b.amount) - (a.exact - a.amount) || a.index - b.index)) {
    if (remainder-- <= 0) break;
    part.amount++;
  }
  return { knowledge: parts[0]!.amount, facts: parts[1]!.amount, raw: parts[2]!.amount, unclassified: parts[3]!.amount };
}

export interface CcContextLegendRow { label: string; color: string; glyph: string; tokens: number; tokensLabel: string; percent: string; suffix: string }
export interface CcGridCellView { glyph: string; color: string }
export interface CcContextSection {
  headerLines: string[];
  /** The grid sits beside the legend; below `CC_NARROW_COLUMNS` it sits above it. */
  sideBySide: boolean;
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

const FULL_GLYPH = "⛁", PARTIAL_GLYPH = "⛀", FREE_GLYPH = "⛶";

// ---- One combined category list, used by both the legend and the grid -----------------------------

interface DisplayCategory { name: string; tokens: number; color: string; kind: CcSdkCategory["kind"] }

/** Splices Knowledge/Facts/Raw/Memory-unclassified into the SDK's own category list, in place of
 * "Messages" (ruling B), or — a fresh session with no message sent has no "Messages" category at all —
 * just ahead of the first free-kind row, so the rows still show rather than silently vanishing.
 * Requirement 2 ("rows never vanish"): Knowledge, Facts and Raw are always included once `memory` is
 * supplied at all, zero when nothing was injected; "Memory, unclassified" only when non-zero. */
function buildDisplayCategories(breakdown: CcContextBreakdown, memory: CcMemorySplit | undefined): DisplayCategory[] {
  if (!memory) return breakdown.categories.map(c => ({ name: c.name, tokens: c.tokens, color: c.color, kind: c.kind }));
  const memorySum = memorySplitSum(memory);
  const memoryRows: DisplayCategory[] = [
    { name: "Knowledge", tokens: memory.knowledge, color: MEMORY_COLOR.knowledge, kind: "used" },
    { name: "Facts", tokens: memory.facts, color: MEMORY_COLOR.facts, kind: "used" },
    { name: "Raw", tokens: memory.raw, color: MEMORY_COLOR.raw, kind: "used" },
    ...(memory.unclassified > 0 ? [{ name: "Memory, unclassified", tokens: memory.unclassified, color: MEMORY_COLOR.unclassified, kind: "used" as const }] : []),
  ];
  const out: DisplayCategory[] = [];
  let spliced = false;
  for (const cat of breakdown.categories) {
    if (cat.name === "Messages") {
      spliced = true;
      out.push(...memoryRows);
      const remainder = Math.max(0, cat.tokens - memorySum);
      if (remainder > 0) out.push({ name: cat.name, tokens: remainder, color: cat.color, kind: cat.kind });
      continue;
    }
    if (!spliced && cat.kind === "free") { out.push(...memoryRows); spliced = true; }
    out.push({ name: cat.name, tokens: cat.tokens, color: cat.color, kind: cat.kind });
  }
  if (!spliced) out.push(...memoryRows);
  return out;
}

/**
 * Claude Code's own grid rule (module doc), computed from `categories` — never from the SDK's own
 * `gridRows`. `minRows` (requirement 3) pads the grid out with blank free-glyph rows past the natural
 * row count, so every legend line — however many there are — has a row of the grid to sit beside; a
 * short legend leaves the extra grid rows genuinely empty of category data, same as Pi's own
 * `renderContextGrid` (`minRows`, `src/hosts/pi/trace-menu-view.ts`) pads for the identical reason. */
/** Claude Code's `/context` narrows its grid below this many columns; the legend then goes below it. */
export const CC_NARROW_COLUMNS = 80;

export function computeCcGrid(categories: DisplayCategory[], window: number, terminalWidth: number | undefined, minRows = 0): CcGridCellView[][] {
  const narrow = terminalWidth !== undefined && terminalWidth < CC_NARROW_COLUMNS;
  const bigWindow = window >= 1_000_000;
  const columns = narrow ? 5 : (bigWindow ? 20 : 10);
  const rows = bigWindow ? 10 : (narrow ? 5 : 10);
  const totalCells = columns * rows;

  // Every non-free, non-deferred category is forced to at least one square (`Math.max(1, ...)` in the
  // source) — free space alone is exempt, and doesn't even reach this function (see below).
  const squaresFor = (cat: DisplayCategory): CcGridCellView[] => {
    const raw = window > 0 ? (cat.tokens / window) * totalCells : 0;
    const count = Math.max(1, Math.round(raw));
    const whole = Math.floor(raw), remainder = raw - whole;
    return Array.from({ length: count }, (_, i) => {
      const fullness = i === whole && remainder > 0 ? remainder : 1;
      return { glyph: fullness >= 1 ? FULL_GLYPH : PARTIAL_GLYPH, color: cat.color };
    });
  };

  const used = categories.filter(c => c.kind === "used" && c.tokens > 0);
  const buffer = categories.find(c => c.kind === "buffer" && c.tokens > 0);
  const free = categories.find(c => c.kind === "free");
  const freeColor = free?.color ?? "promptBorder"; // Claude Code's own free-space category colour.

  const cells: CcGridCellView[] = [];
  for (const cat of used) for (const cell of squaresFor(cat)) if (cells.length < totalCells) cells.push(cell);
  const bufferCells = buffer ? squaresFor(buffer) : [];
  const freeBudget = Math.max(0, totalCells - cells.length - bufferCells.length);
  for (let i = 0; i < freeBudget; i++) cells.push({ glyph: FREE_GLYPH, color: freeColor });
  for (const cell of bufferCells) if (cells.length < totalCells) cells.push(cell);
  while (cells.length < totalCells) cells.push({ glyph: FREE_GLYPH, color: freeColor }); // defensive: always a full rectangle.

  const gridRows: CcGridCellView[][] = [];
  for (let r = 0; r < rows; r++) gridRows.push(cells.slice(r * columns, r * columns + columns));
  const blankRow = (): CcGridCellView[] => Array.from({ length: columns }, () => ({ glyph: FREE_GLYPH, color: freeColor }));
  while (gridRows.length < minRows) gridRows.push(blankRow());
  return gridRows;
}

/** Builds Claude Code's own context section: the legend in `/context`'s own wording, with
 * Knowledge/Facts/Raw/Memory-unclassified spliced in ahead of a reduced "Messages" row (ruling B), and
 * the grid computed by the same rule Claude Code itself uses (module doc). Returns `undefined` when
 * Claude Code has no breakdown at all (ticket: shows `unavailable`, points at the built-in `/context`).
 *
 * `contextTokens` is requirement 4's scaling denominator (`scaleMemoryToMessages`'s doc). When the
 * supplied amounts are inconsistent with what Claude Code reports (their scaled sum exceeds a present
 * "Messages" category, or "Messages" is absent while the sum is positive) or the scaling factor cannot
 * be computed at all for a non-zero split, that is not presence: the memory rows and the Messages
 * adjustment fall back to `unavailable`, Messages keeps Claude Code's own figure, and the grid keeps
 * Claude Code's own categories — same as `memory` being `undefined` (presence could not be established
 * at all). */
export function buildCcContextSection(breakdown: CcContextBreakdown | undefined, memory: CcMemorySplit | undefined, contextTokens: number | undefined): CcContextSection | undefined {
  if (!breakdown) return undefined;

  const messagesCategory = breakdown.categories.find(c => c.name === "Messages");
  const scaledMemory = memory ? scaleMemoryToMessages(memory, messagesCategory?.tokens, contextTokens) : undefined;
  const overflow = scaledMemory !== undefined && messagesCategory !== undefined && memorySplitSum(scaledMemory) > messagesCategory.tokens;
  const inconsistent = memory !== undefined && (scaledMemory === undefined || overflow || (!messagesCategory && memorySplitSum(scaledMemory!) > 0));
  const effectiveMemory = inconsistent ? undefined : scaledMemory;

  const displayCategories = buildDisplayCategories(breakdown, effectiveMemory);

  const row = (cat: DisplayCategory): CcContextLegendRow => {
    const isFree = cat.kind === "free";
    return {
      label: cat.name, color: cat.color, glyph: isFree ? FREE_GLYPH : FULL_GLYPH, tokens: cat.tokens,
      tokensLabel: ccCompact(cat.tokens), percent: formatPercent(breakdown.maxTokens > 0 ? cat.tokens / breakdown.maxTokens : 0),
      suffix: isFree ? "" : " tokens",
    };
  };
  const legend = displayCategories.map(row);

  // Requirement 3: the legend opens with the model's display name, then the id, then the token total —
  // `displayName` is `undefined` on the pinned SDK version (see `CcContextBreakdown`'s doc), so this
  // falls back to two lines, not three.
  const totalLine = `${ccCompact(breakdown.totalTokens)}/${ccCompact(breakdown.maxTokens)} tokens (${breakdown.percentage}%, estimated)`;
  const headerLines = breakdown.displayName ? [breakdown.displayName, breakdown.model, totalLine] : [breakdown.model, totalLine];

  const legendHeading = "Estimated usage by category";
  const memoryUnavailable = effectiveMemory ? undefined : (inconsistent || messagesCategory ? "Knowledge, Facts, Raw: unavailable" : undefined);

  // Requirement 3: beside the grid, legend lines past the grid's own row count stay in the legend
  // column — padding the grid to the legend's line count (mirrors Pi's `minRows`). Stacked above the
  // legend, the grid keeps its own rows.
  const sideBySide = breakdown.terminalWidth === undefined || breakdown.terminalWidth >= CC_NARROW_COLUMNS;
  const legendLineCount = headerLines.length + 1 /* blank */ + 1 /* heading */ + legend.length + (memoryUnavailable ? 1 : 0);
  const gridRows = computeCcGrid(displayCategories, breakdown.maxTokens, breakdown.terminalWidth, sideBySide ? legendLineCount : 0);

  return { headerLines, sideBySide, gridRows, legendHeading, legend, memoryUnavailable };
}

/** Text-only fallback returned by the local command when no interactive pane is available. */
export function renderTraceMenuText(rendered: RenderedMenu): string {
  const context = rendered.context;
  return [rendered.header, "",
    ...(context ? [
      ...context.headerLines,
      context.legendHeading,
      ...context.legend.map(row => `${row.glyph} ${row.label}: ${row.tokensLabel}${row.suffix} (${row.percent})`),
      ...(context.memoryUnavailable ? [context.memoryUnavailable] : []),
    ] : [rendered.contextUnavailable ?? "unavailable — see the built-in /context"]),
    "", rendered.pendingHeading, ...rendered.pendingLines, "", ...rendered.spendLines,
    ...rendered.notices.map(notice => `! ${notice}`), "", rendered.actions.map(action => action.label).join("   "),
  ].join("\n");
}

// ---- Pending / trigger (shared wording, CC's own plain-text bar) ----------------------------------

// Same bar as Pi's renderer (10 cells, floor(ratio*10) filled) — a decoration, not a number, but the
// two hosts should still match on it rather than one silently dropping it.
const bar = (ratio: number) => { const filled = Math.min(10, Math.floor(ratio * 10)); return "█".repeat(filled) + "░".repeat(10 - filled); };
const pendingLine = (label: string, row: { tokens: number | null; trigger: number | null; ratio: number | null; percent: string; amount: string }, indent = "  ") =>
  row.tokens === null ? `${indent}${label}: Unknown / ${row.trigger ?? "Unknown"}`
    : `${indent}${label.padEnd(13)} ${bar(row.ratio ?? 0)} ${row.percent.padStart(4)}   ${row.amount}`;

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

export function renderTraceMenu(input: TraceMenuInput, cc: { breakdown?: CcContextBreakdown; memory?: CcMemorySplit; contextTokens?: number }): RenderedMenu {
  const model = buildTraceMenu(input);
  const context = buildCcContextSection(cc.breakdown, cc.memory, cc.contextTokens);
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
