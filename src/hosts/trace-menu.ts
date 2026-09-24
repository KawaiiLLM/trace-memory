/**
 * Ticket 82: the `/trace` menu's host-neutral content. This module does no I/O, opens nothing, and
 * knows nothing about a theme, a terminal or a Claude Code pane — it is 75's "one model, two
 * renderers" pattern (`status-line.ts`) applied to the whole menu. Each host's renderer paints the
 * returned structure with its own components; wording, order, number formats and confirmation texts
 * live here so the two hosts cannot drift (ticket "How it is built").
 *
 * Grid glyphs are NOT computed here. Pi projects its own local estimates onto the SDK's occupied
 * share (`projectComposition` in `hosts/pi/session-status.ts`) because Pi's SDK gives no per-category
 * breakdown; Claude Code's SDK already returns one (`$.session.usage` `context.breakdown`, step 0
 * check 5). The two hosts therefore source the same category numbers from different places and grid
 * them differently — only the row content (label, amount, share, order) is shared.
 */

// ---- Formatting (shared so both hosts print the same digits) ---------------------------------

const compact = (n: number): string => {
  if (n >= 1_000_000) return `${trimZero((n / 1_000_000).toFixed(1))}M`;
  if (n >= 1_000) return `${trimZero((n / 1_000).toFixed(1))}k`;
  return String(n);
};
const trimZero = (s: string) => s.endsWith(".0") ? s.slice(0, -2) : s;
export const formatTokens = (n: number): string => n.toLocaleString("en-US");
export const formatCompactTokens = compact;
export const formatPercent = (ratio: number): string => {
  if (ratio > 0 && ratio < 0.001) return "<0.1%";
  return `${(ratio * 100).toFixed(1)}%`;
};
export const formatShare = (value: number, total: number): string => total > 0 ? formatPercent(value / total) : "0.0%";
export const formatMoney = (n: number): string => `$${n.toFixed(2)}`;

// ---- Context section ---------------------------------------------------------------------------

/** One category row's canonical name, order and label. Knowledge/Facts/Raw are top-level, beside
 * System/Tools/Skills/Conversation/Other, per the maintainer's ruling B: no Memory parent, no
 * indentation. "Unclassified" is its own row, "Memory, unclassified", shown only when non-zero. */
export const CONTEXT_CATEGORY_ORDER = [
  "System", "Tools", "Skills", "Knowledge", "Facts", "Raw", "Unclassified", "Conversation", "Other",
] as const;
export type ContextCategoryName = typeof CONTEXT_CATEGORY_ORDER[number];
const CATEGORY_LABEL: Record<ContextCategoryName, string> = {
  System: "System", Tools: "Tools", Skills: "Skill catalog", Knowledge: "Knowledge", Facts: "Facts",
  Raw: "Raw", Conversation: "Conversation", Other: "Other", Unclassified: "Memory, unclassified",
};
/** The palette role each category paints with; hosts map this onto their own color system. */
export type ContextColor = "system" | "tools" | "skills" | "knowledge" | "facts" | "raw" | "conversation" | "other" | "free";
const CATEGORY_COLOR: Record<ContextCategoryName, ContextColor> = {
  System: "system", Tools: "tools", Skills: "skills", Knowledge: "knowledge", Facts: "facts", Raw: "raw",
  Conversation: "conversation", Other: "other", Unclassified: "other",
};

export interface ContextCategoryInput { name: ContextCategoryName; tokens: number }
export interface ContextSectionInput {
  model: string;
  /** The SDK's occupied-total measure: undefined when this host has no source for it (`unavailable`). */
  sdk?: { tokens: number; window: number };
  /** The local per-category estimate; zero-amount categories are omitted. Undefined means this host
   * (Claude Code, before step 0's source is wired) has no per-category source at all. */
  categories?: ContextCategoryInput[];
  /** False when any category is only a partial estimate (ticket: one short `(partial)` marker). */
  complete?: boolean;
}
export interface ContextCategoryRow { label: string; color: ContextColor; tokens: number; share: string }
export interface ContextSection {
  model: string;
  /** "142.2k / 400k tokens (35.6%, SDK)", or undefined if `sdk` was not supplied. */
  sdkLine?: string;
  sdkUnavailable?: string;
  localHeading: string;
  categories: ContextCategoryRow[];
  localTotal: number;
  free?: { tokens: number; share: string };
  categoriesUnavailable?: string;
}

export function buildContextSection(input: ContextSectionInput): ContextSection {
  const localTotal = (input.categories ?? []).reduce((sum, c) => sum + c.tokens, 0);
  const categories: ContextCategoryRow[] = (input.categories ?? [])
    .filter(c => c.tokens > 0)
    .sort((a, b) => CONTEXT_CATEGORY_ORDER.indexOf(a.name) - CONTEXT_CATEGORY_ORDER.indexOf(b.name))
    .map(c => ({ label: CATEGORY_LABEL[c.name], color: CATEGORY_COLOR[c.name], tokens: c.tokens, share: formatShare(c.tokens, localTotal) }));
  const partial = input.complete === false ? " (partial)" : "";
  return {
    model: input.model,
    sdkLine: input.sdk ? `${formatCompactTokens(input.sdk.tokens)} / ${formatCompactTokens(input.sdk.window)} tokens (${formatPercent(input.sdk.tokens / input.sdk.window)}, SDK)` : undefined,
    sdkUnavailable: input.sdk ? undefined : "unavailable",
    localHeading: `Estimated usage by category${partial} (local)`,
    categories,
    localTotal,
    free: input.sdk ? { tokens: Math.max(0, input.sdk.window - input.sdk.tokens), share: formatShare(Math.max(0, input.sdk.window - input.sdk.tokens), input.sdk.window) } : undefined,
    categoriesUnavailable: input.categories ? undefined : "unavailable",
  };
}

// ---- Pending / trigger --------------------------------------------------------------------------

export interface PendingInput { tokens: number | null; trigger: number | null }
export interface PendingRow { label: string; tokens: number | null; trigger: number | null; ratio: number | null; percent: string }
const pendingRow = (label: string, value: PendingInput): PendingRow => {
  if (value.tokens === null || value.trigger === null) return { label, tokens: null, trigger: null, ratio: null, percent: "?" };
  const ratio = value.trigger === 0 ? (value.tokens === 0 ? 0 : 1) : Math.min(1, value.tokens / value.trigger);
  return { label, tokens: value.tokens, trigger: value.trigger, ratio, percent: formatPercent(value.trigger === 0 ? (value.tokens === 0 ? 0 : 1) : value.tokens / value.trigger) };
};

export interface PendingSectionInput {
  noting: PendingInput;
  consolidation: PendingInput;
  dreaming: { global: PendingInput; project: PendingInput; session: PendingInput };
}
export interface PendingSection {
  heading: string;
  noting: PendingRow;
  consolidation: PendingRow;
  dreamingHeading: string;
  dreaming: { global: PendingRow; project: PendingRow; session: PendingRow };
}
export function buildPendingSection(input: PendingSectionInput): PendingSection {
  return {
    heading: "Pending / trigger",
    noting: pendingRow("Noting", input.noting),
    consolidation: pendingRow("Consolidation", input.consolidation),
    dreamingHeading: "Dreaming",
    dreaming: {
      global: pendingRow("global", input.dreaming.global),
      project: pendingRow("project", input.dreaming.project),
      session: pendingRow("session", input.dreaming.session),
    },
  };
}

// ---- Spend ---------------------------------------------------------------------------------------

export interface SpendPhase { runs: number; cost: number }
export interface SpendSectionInput { session: number; noting: SpendPhase; consolidation: SpendPhase; dreaming: SpendPhase; today: number }
export interface SpendSection { sessionLine: string; phaseLine: string; todayLine: string }
export function buildSpendSection(input: SpendSectionInput): SpendSection {
  const phase = (label: string, p: SpendPhase) => `${label} ${p.runs} runs ${formatMoney(p.cost)}`;
  return {
    sessionLine: `Spend   session ${formatMoney(input.session)}`,
    phaseLine: `${phase("Noting", input.noting)} · ${phase("Consolidation", input.consolidation)} · ${phase("Dreaming", input.dreaming)}`,
    todayLine: `        today   ${formatMoney(input.today)}`,
  };
}

// ---- Header, notices, actions --------------------------------------------------------------------

export interface HeaderInput { session: string; project: string; enabled: boolean; explicit?: boolean }
export function buildHeader(input: HeaderInput): string {
  const state = input.enabled ? "On" : "Off";
  const suffix = input.explicit ? ` (explicit)` : "";
  return `Trace Memory · ${input.session} · ${input.project} · ${state}${suffix}`;
}

export interface MenuActionsInput { enabled: boolean; retryForkAvailable: boolean }
export function buildActions(input: MenuActionsInput): string[] {
  const toggle = input.enabled ? "Turn off" : "Turn on";
  return [toggle, "Catch up", "Stop", "Project…", "Runs…", "Settings…", ...(input.retryForkAvailable ? ["Retry fork"] : [])];
}

// ---- Whole-menu model ------------------------------------------------------------------------------

export interface TraceMenuInput {
  header: HeaderInput;
  context: ContextSectionInput;
  pending: PendingSectionInput;
  spend: SpendSectionInput;
  notices: string[];
  actions: MenuActionsInput;
}
export interface TraceMenuModel {
  header: string;
  context: ContextSection;
  pending: PendingSection;
  spend: SpendSection;
  notices: string[];
  actions: string[];
}
export function buildTraceMenu(input: TraceMenuInput): TraceMenuModel {
  return {
    header: buildHeader(input.header),
    context: buildContextSection(input.context),
    pending: buildPendingSection(input.pending),
    spend: buildSpendSection(input.spend),
    notices: input.notices,
    actions: buildActions(input.actions),
  };
}

// ---- Settings screen -------------------------------------------------------------------------------

export interface SettingsBudgetsInput { global: number; project: number; session: number; sharedAllowanceTokens: number }
export interface SettingsBudgetRow { label: string; value: string; qualifier?: string }
export interface SettingsBudgets { rows: SettingsBudgetRow[]; derivedLine: string }
export function buildSettingsBudgets(input: SettingsBudgetsInput): SettingsBudgets {
  const window = input.global + input.project + input.session;
  return {
    rows: [
      { label: "Global", value: formatTokens(input.global) },
      { label: "Project", value: formatTokens(input.project), qualifier: "per project" },
      { label: "Session", value: formatTokens(input.session), qualifier: "per session" },
    ],
    derivedLine: `→ knowledge window ${formatTokens(window)} + shared allowance ${formatTokens(input.sharedAllowanceTokens)} = ${formatTokens(window + input.sharedAllowanceTokens)} max input`,
  };
}

export interface WorkerRowInput { phase: "Noter" | "Consolidator" | "Dreamer"; mode?: string; model: string; thinking: string; source?: string }
export interface WorkerRow { phase: string; mode?: string; model: string; thinking: string; source?: string }
export interface SettingsWorkers { showModeColumn: boolean; rows: WorkerRow[] }
export function buildSettingsWorkers(input: WorkerRowInput[]): SettingsWorkers {
  return { showModeColumn: input.some(w => w.mode !== undefined), rows: input.map(w => ({ ...w })) };
}

export interface SettingsInput {
  database: string;
  budgets: SettingsBudgetsInput;
  workers: WorkerRowInput[];
  closedSessionScope: "off" | "project" | "global";
}
export interface SettingsModel {
  header: string;
  budgets: SettingsBudgets;
  workers: SettingsWorkers;
  closedSessionsLine: string;
}
const SCOPE_CHOICES = ["off", "project", "global"] as const;
export function buildTraceSettings(input: SettingsInput): SettingsModel {
  return {
    header: `Trace Memory · Settings                 database ${input.database}`,
    budgets: buildSettingsBudgets(input.budgets),
    workers: buildSettingsWorkers(input.workers),
    closedSessionsLine: `Closed sessions   ${input.closedSessionScope}   (${SCOPE_CHOICES.join(" · ")})`,
  };
}

// ---- Fixture: one canonical normalized input, shared by the unit tests and the rendered samples ----
// Numbers per ticket 82 requirement 3: knowledge pool budgets 4,000 / 15,000 / 1,000 (database policy
// default, `DEFAULT_KNOWLEDGE_BUDGETS` in core/store/processing.ts), Dreaming triggers
// min(dreaming.triggerTokens, budget) = 4,000 / 5,000 / 1,000 (`DEFAULT_DREAMING_TRIGGER_TOKENS` is
// 5,000), Noting trigger 10,000 and Consolidation trigger 5,000 (`DEFAULT_CONFIG` in core/api/index.ts),
// shared allowance 10,000 (`compaction.sharedAllowanceTokens`). The derived knowledge window is the
// budgets' sum, 20,000 (`deriveKnowledgeBudgets`) — the ticket's mockup shows "10,000" and shows
// "Project 5,000"; both disagree with the code default and are corrected here (see the delegation
// report for the full list of mockup/code disagreements).
export const TRACE_MENU_FIXTURE: TraceMenuInput = {
  header: { session: "S3", project: "trace-memory", enabled: true },
  context: {
    model: "openai-codex/gpt-6-astra",
    sdk: { tokens: 142_200, window: 400_000 },
    categories: [
      { name: "System", tokens: 1_900 },
      { name: "Tools", tokens: 5_000 },
      { name: "Skills", tokens: 1_200 },
      { name: "Knowledge", tokens: 17_300 },
      { name: "Facts", tokens: 9_900 },
      { name: "Raw", tokens: 10_000 },
      { name: "Unclassified", tokens: 200 },
      { name: "Conversation", tokens: 96_600 },
      { name: "Other", tokens: 200 },
    ],
    complete: true,
  },
  pending: {
    noting: { tokens: 3_200, trigger: 10_000 },
    consolidation: { tokens: 400, trigger: 5_000 },
    dreaming: {
      global: { tokens: 0, trigger: 4_000 },
      project: { tokens: 1_500, trigger: 5_000 },
      session: { tokens: 319, trigger: 1_000 },
    },
  },
  spend: {
    session: 1.23,
    noting: { runs: 12, cost: 0.40 },
    consolidation: { runs: 3, cost: 0.50 },
    dreaming: { runs: 1, cost: 0.33 },
    today: 5.31,
  },
  notices: [],
  actions: { enabled: true, retryForkAvailable: false },
};

export const TRACE_MENU_FIXTURE_WITH_NOTICE: TraceMenuInput = {
  ...TRACE_MENU_FIXTURE,
  notices: ["Automatic off: noting failed 3 times at T4412 (R881: model request timed out after 3 attempts). Turn on to resume."],
};

export const TRACE_SETTINGS_FIXTURE: SettingsInput = {
  database: "~/.trace-memory/trace.db",
  budgets: { global: 4_000, project: 15_000, session: 1_000, sharedAllowanceTokens: 10_000 },
  workers: [
    { phase: "Noter", mode: "subagent", model: "follow foreground", thinking: "inherit" },
    { phase: "Consolidator", mode: "subagent", model: "claude-sonnet-5", thinking: "medium" },
    { phase: "Dreamer", model: "claude-sonnet-5", thinking: "medium" },
  ],
  closedSessionScope: "project",
};

/** Claude Code has no fork mode (ticket: "the mode column exists on Pi only"), and CC validation
 * accepts neither "follow foreground" as a model nor "inherit" as a thinking level (ticket, Claude
 * Code settings section) — so the Noter row cannot show Pi's fork-tied defaults. This fixture is
 * otherwise identical to `TRACE_SETTINGS_FIXTURE`; see the report for the maintainer question this
 * raises (what CC's own Noter default should be). */
export const TRACE_SETTINGS_FIXTURE_CC: SettingsInput = {
  ...TRACE_SETTINGS_FIXTURE,
  workers: [
    { phase: "Noter", model: "claude-sonnet-5", thinking: "medium" },
    { phase: "Consolidator", model: "claude-sonnet-5", thinking: "medium" },
    { phase: "Dreamer", model: "claude-sonnet-5", thinking: "medium" },
  ],
};
