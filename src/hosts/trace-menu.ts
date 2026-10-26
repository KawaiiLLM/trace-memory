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
/** 108: a total that leaves out runs of unknown cost is a lower bound and says so, never a bare figure. */
export const formatMoneyBound = (n: number, unknown = 0): string => unknown ? `${formatMoney(n)}+ (${unknown} unknown)` : formatMoney(n);
/** Pending/trigger rows round to a whole percent ("32%"), unlike the context section's one-decimal
 * shares — the ticket's mockup shows no decimal on any Pending row ("32%", "8%", "0%", "31%"). */
export const formatWholePercent = (ratio: number): string => `${Math.round(ratio * 100)}%`;

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
export type ContextColor = "system" | "tools" | "skills" | "knowledge" | "facts" | "raw" | "unclassified" | "conversation" | "other" | "free";
const CATEGORY_COLOR: Record<ContextCategoryName, ContextColor> = {
  System: "system", Tools: "tools", Skills: "skills", Knowledge: "knowledge", Facts: "facts", Raw: "raw",
  Conversation: "conversation", Other: "other", Unclassified: "unclassified",
};

/** Approved yellow-green cluster shared by both hosts; distinct xterm 256-colour matches are
 * 191, 155, 83 and 107 respectively. */
export const MEMORY_COLOR_HEX: Record<"knowledge" | "facts" | "raw" | "unclassified", string> = {
  knowledge: "#DDEE49",
  facts: "#A1EE49",
  raw: "#65EE49",
  unclassified: "#8EA970",
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

/** `atLeast`: counting stopped at the trigger; `entries` is then the exact pending entry count. `tokens` is the figure in the row's
 * unit: compact tokens, or Noter-changed knowledge items for the Dreaming row (`unit: "items"`, 181). */
export interface PendingInput { tokens: number | null; trigger: number | null; atLeast?: boolean; entries?: number; unit?: "items" }
export interface PendingRow { label: string; tokens: number | null; trigger: number | null; ratio: number | null; percent: string; amount: string }
const pendingRow = (label: string, value: PendingInput): PendingRow => {
  if (value.tokens === null || value.trigger === null) return { label, tokens: null, trigger: null, ratio: null, percent: "?", amount: "?" };
  const ratio = value.trigger === 0 ? (value.tokens === 0 ? 0 : 1) : Math.min(1, value.tokens / value.trigger);
  const items = value.unit === "items";
  const trigger = items ? String(value.trigger) : formatCompactTokens(value.trigger);
  const amount = items ? `${value.atLeast ? "≥" : ""}${value.tokens} / ${trigger} items`
    : value.atLeast ? `≥${trigger} / ${trigger} (${(value.entries ?? 0).toLocaleString("en-US")} ${value.entries === 1 ? "entry" : "entries"})`
    : `${formatCompactTokens(value.tokens)} / ${trigger}`;
  return { label, tokens: value.tokens, trigger: value.trigger, ratio, percent: formatWholePercent(ratio), amount };
};

/** Dreaming's pending row input from `TraceMemory.dreamingPending` (181); `trigger` fills the row when the count is unavailable. */
export const dreamingPendingInput = (pending: { items: number; trigger: number; atLeast?: boolean } | null, trigger: number | null): PendingInput =>
  pending ? { tokens: pending.items, trigger: pending.trigger, unit: "items", ...(pending.atLeast ? { atLeast: true } : {}) }
    : { tokens: null, trigger, unit: "items" };

/** Noter-changed knowledge items not yet covered by a Dreamer run, against the trigger. */
export interface PendingSectionInput {
  noting: PendingInput;
  dreaming: { pending: PendingInput };
}
export interface PendingSection {
  heading: string;
  noting: PendingRow;
  dreamingHeading: string;
  dreaming: PendingRow[];
}
export function buildPendingSection(input: PendingSectionInput): PendingSection {
  return {
    heading: "Pending / trigger",
    noting: pendingRow("Noting", input.noting),
    dreamingHeading: "Dreaming",
    dreaming: [pendingRow("pending", input.dreaming.pending)],
  };
}

// ---- Spend ---------------------------------------------------------------------------------------

export interface SpendPhase { runs: number; cost: number }
export interface SpendSectionInput { session: number; noting: SpendPhase; consolidation: SpendPhase; dreaming: SpendPhase; today: number;
  /** 108: runs whose cost is unknown, counted in neither figure. */
  sessionUnknown?: number; todayUnknown?: number }
export interface SpendSection { sessionLine: string; phaseLine: string; todayLine: string }
export function buildSpendSection(input: SpendSectionInput): SpendSection {
  const phase = (label: string, p: SpendPhase) => `${label} ${p.runs} ${p.runs === 1 ? "run" : "runs"} ${formatMoney(p.cost)}`;
  return {
    sessionLine: `Spend   session ${formatMoneyBound(input.session, input.sessionUnknown)}`,
    phaseLine: `${phase("Noting", input.noting)} · ${phase("Consolidation", input.consolidation)} · ${phase("Dreaming", input.dreaming)}`,
    todayLine: `        today   ${formatMoneyBound(input.today, input.todayUnknown)}`,
  };
}

// ---- Header, notices, actions --------------------------------------------------------------------

export interface HeaderInput { session: string; project: string; enabled: boolean; explicit?: boolean }
export function buildHeader(input: HeaderInput): string {
  const state = input.enabled ? "On" : "Off";
  const suffix = input.explicit ? ` (explicit)` : "";
  return `Trace Memory · ${input.session} · ${input.project} · ${state}${suffix}`;
}

/** The Dreamer's latest failure for the notice area (stage 4 §3.3): task, class, retries used or the wait for the next threshold, and when. Three failures in a row switch memory off (the Noter's rule), so the notice of the failure that did is not gated on that. */
export function dreamerFailureNotice(failure: { runId: number; at: string; reason: string } | null): string[] {
  return failure ? [`Dreamer failed: ${failure.reason || "unknown reason"} (R${failure.runId}, ${failure.at.slice(0, 16).replace("T", " ")} UTC)`] : [];
}

export interface MenuActionsInput { enabled: boolean }
export type MenuAction = "Turn on" | "Turn off" | "Catch up" | "Dream" | "Full check" | "Stop" | "Project…" | "Runs…" | "Settings…";
export function buildActions(input: MenuActionsInput): MenuAction[] {
  const toggle: MenuAction = input.enabled ? "Turn off" : "Turn on";
  return [toggle, "Catch up", "Dream", "Full check", "Stop", "Project…", "Runs…", "Settings…"];
}
export const toggleConfirmation = (turnOn: boolean, shared: boolean) => ({
  title: `Turn Trace Memory ${turnOn ? "on" : "off"} for this session?`,
  message: (shared ? " Shared identity: this switch also affects forks or clones carrying this memory identity." : " Forks or clones carrying this memory identity share this switch.") + (turnOn
    ? " Available history, including the paused interval, will be queued without a model call."
    : " Processing and future injection stop; stored memory and already-injected text remain."),
});
export function parseRunsCount(input: string): number {
  if (!/^[1-9]\d*$/.test(input) || !Number.isSafeInteger(Number(input)))
    throw new Error("Runs count must be a positive safe integer in decimal notation");
  return Number(input);
}
export const MENU_INPUTS = {
  runs: "Runs: number to show",
  project: "Project name (every session declaring this name in this database shares its knowledge; without a name, a new session joins the project its repository directory already has when that is exactly one project — home and temporary directories excluded)",
} as const;

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

export interface SettingsBudgetsInput { base: number; temporaryTokens: number; pointerTokens: number }
export interface SettingsBudgetRow { label: string; value: string }
export interface SettingsBudgets { rows: SettingsBudgetRow[]; derivedLine: string }
export function buildSettingsBudgets(input: SettingsBudgetsInput): SettingsBudgets {
  return {
    rows: [{ label: "Knowledge base", value: formatTokens(input.base) }],
    derivedLine: `→ knowledge base ${formatTokens(input.base)} + body pool ${formatTokens(input.temporaryTokens)} + pointer pool ${formatTokens(input.pointerTokens)} = ${formatTokens(input.base + input.temporaryTokens + input.pointerTokens)} max input`,
  };
}

export interface WorkerRowInput { phase: "Noter" | "Dreamer"; model: string; thinking: string; source?: string; sources?: { model?: string; thinking?: string } }
export interface WorkerRow { phase: string; model: string; thinking: string; source?: string; sources?: WorkerRowInput["sources"] }
export interface SettingsWorkers { rows: WorkerRow[] }
export function buildSettingsWorkers(input: WorkerRowInput[]): SettingsWorkers {
  return { rows: input.map(w => ({ ...w })) };
}

export type SettingsRowId = "knowledgeBase" | "noting.model" | "noting.thinking" | "dreaming.model" | "dreaming.thinking" | "closedSessionScope";
export interface SettingsChoice { id: SettingsRowId; label: string }
/** Stable row identifiers and labels: adapters implement edits, not menu copy or ordering. */
export function buildSettingsChoices(input: SettingsInput): SettingsChoice[] {
  const base = buildSettingsBudgets(input.budgets).rows[0]!;
  const budgets: SettingsChoice[] = [{ id: "knowledgeBase", label: `${base.label}: ${base.value}` }];
  const workers: SettingsChoice[] = input.workers.flatMap(w => {
    const phase = ({ Noter: "noting", Dreamer: "dreaming" } as const)[w.phase];
    return ([{ id: `${phase}.model` as SettingsRowId, label: `${w.phase} model: ${w.model}`, source: w.sources?.model ?? w.source },
      { id: `${phase}.thinking` as SettingsRowId, label: `${w.phase} thinking: ${w.thinking}`, source: w.sources?.thinking }]).map(row => ({ id: row.id, label: `${row.label}${row.source ? ` (${row.source})` : ""}` }));
  });
  return [...budgets, ...workers, { id: "closedSessionScope", label: `Closed sessions: ${input.closedSessionScope}${input.closedSessionSource ? ` (${input.closedSessionSource})` : ""}` }];
}
export interface SettingsInput {
  database: string;
  budgets: SettingsBudgetsInput;
  workers: WorkerRowInput[];
  closedSessionScope: "off" | "project" | "global";
  closedSessionSource?: string;
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
    closedSessionsLine: `Closed sessions   ${input.closedSessionScope}   (${SCOPE_CHOICES.join(" · ")})${input.closedSessionSource ? `  ${input.closedSessionSource}` : ""}`,
  };
}

// ---- Fixture: one canonical normalized input, shared by the unit tests and the rendered samples ----
// Numbers per ticket 82 requirement 3: knowledge pool budgets 4,000 / 15,000 / 1,000 (database policy
// default, `DEFAULT_KNOWLEDGE_BUDGETS` in core/store/processing.ts), Dreaming trigger 5,000 on the
// summed pending weight and 30,000 on the knowledge total (104: the 20,000 base plus the shared
// allowance), Noting trigger 10,000 and Consolidation trigger 5,000 (`DEFAULT_CONFIG` in core/api/index.ts),
// temporary allowance 10,000 (`compaction.temporaryTokens`). The derived knowledge window is the
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
    dreaming: { pending: { tokens: 12, trigger: 30, unit: "items" } },
  },
  spend: {
    session: 1.23,
    noting: { runs: 12, cost: 0.40 },
    consolidation: { runs: 3, cost: 0.50 },
    dreaming: { runs: 1, cost: 0.33 },
    today: 5.31,
  },
  notices: [],
  actions: { enabled: true },
};

export const TRACE_MENU_FIXTURE_WITH_NOTICE: TraceMenuInput = {
  ...TRACE_MENU_FIXTURE,
  notices: ["Automatic off: noting failed 3 times at T4412 (R881: model request timed out after 3 attempts). Turn on to resume."],
};

export const TRACE_SETTINGS_FIXTURE: SettingsInput = {
  database: "~/.trace-memory/trace.db",
  budgets: { base: 20_000, temporaryTokens: 10_000, pointerTokens: 10_000 },
  workers: [
    { phase: "Noter", model: "follow foreground", thinking: "inherit" },
    { phase: "Dreamer", model: "claude-sonnet-5", thinking: "medium" },
  ],
  closedSessionScope: "project",
};

/** Claude Code retains its explicit fresh-worker model and thinking requirements. */
export const TRACE_SETTINGS_FIXTURE_CC: SettingsInput = {
  ...TRACE_SETTINGS_FIXTURE,
  workers: [
    { phase: "Noter", model: "claude-sonnet-5", thinking: "medium" },
    { phase: "Dreamer", model: "claude-sonnet-5", thinking: "medium" },
  ],
};
