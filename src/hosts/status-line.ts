import { MEMORY_PHASES, type MemoryPhase } from "./phase-settings.ts";

/**
 * Ticket 75: the memory status line's text and indicator, factored out of Pi's `showSpend` (ticket
 * 24a/51) so Claude Code's status command can render the identical line without a second
 * implementation to drift from. This module is host-neutral: it does no I/O, opens nothing, and knows
 * nothing about a theme or an ANSI code — each host paints the returned abstract colour roles itself.
 *
 * The indicator is one role per running phase — Noting `accent`, Dreaming
 * `customMessageLabel` — in that precedence when phases overlap; idle is `dim`. Off collapses the
 * whole line to one `dim` segment, `○ off`, matching Pi's compact form exactly (not two segments
 * joined by a space, which would insert an extra paint boundary a host's `paint` wrapper does not
 * produce for a single call).
 */
export type StatusColorRole = "accent" | "success" | "customMessageLabel" | "dim";

/** One run of text a host paints with a single role, in display order. */
export interface StatusSegment {
  role: StatusColorRole;
  text: string;
}

export interface MemoryStatusCounts {
  entries?: number;
  facts?: number;
  changedKnowledge?: number;
  knowledge?: number;
}

export interface MemoryStatusInput {
  enabled: boolean;
  /** Which phases are running right now, keyed by `MemoryPhase`. An absent phase counts as idle. */
  running: Partial<Record<MemoryPhase, boolean>>;
  /** Undefined counts render as `?`, never as `0` (Pi review: an unknown value must never look like a fabricated zero). */
  counts?: MemoryStatusCounts;
  /** Undefined cost renders as `$?`. */
  cost?: number;
  /** 108: runs whose cost is unknown are left out of `cost`; a lower bound renders as `$1.23+`. */
  costUnknown?: number;
}

const INDICATOR_ROLE: Record<MemoryPhase, StatusColorRole> = { noting: "accent", dreaming: "customMessageLabel" };

/** The segments of the `🧠 ...` line, without the leading emoji (a host constant, not a colour role). */
export function memoryStatusLine(input: MemoryStatusInput): StatusSegment[] {
  if (!input.enabled) return [{ role: "dim", text: "○ off" }];
  const runningPhase = MEMORY_PHASES.find(phase => input.running[phase]);
  const role: StatusColorRole = runningPhase ? INDICATOR_ROLE[runningPhase] : "dim";
  const glyph = runningPhase ? "●" : "○";
  const value = (count?: number) => count === undefined ? "?" : String(count);
  const c = input.counts ?? {};
  const text = `notes: ${value(c.entries)}->${value(c.facts)}` +
    ` memory: ${value(c.changedKnowledge)}/${value(c.knowledge)}` +
    ` cost: ${input.cost === undefined ? "$?" : `$${input.cost.toFixed(2)}${input.costUnknown ? "+" : ""}`}`;
  return [{ role, text: glyph }, { role: "dim", text }];
}
