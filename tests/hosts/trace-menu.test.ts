// Ticket 82: the host-neutral `/trace` menu model. One fixture (`TRACE_MENU_FIXTURE` /
// `TRACE_SETTINGS_FIXTURE`), covering the sections both renderers must reproduce identically:
// header, context categories, Pending/trigger, spend, notices, actions and the settings rows.
import { expect, test } from "vitest";
import {
  buildTraceMenu, buildTraceSettings, formatCompactTokens, formatPercent,
  TRACE_MENU_FIXTURE, TRACE_MENU_FIXTURE_WITH_NOTICE, TRACE_SETTINGS_FIXTURE, TRACE_SETTINGS_FIXTURE_CC,
} from "../../src/hosts/trace-menu.ts";

test("header: session, project, On, no explicit suffix by default", () => {
  expect(buildTraceMenu(TRACE_MENU_FIXTURE).header).toBe("Trace Memory · S3 · trace-memory · On");
});

test("header: Off and explicit enrollment", () => {
  const model = buildTraceMenu({ ...TRACE_MENU_FIXTURE, header: { session: "S3", project: "trace-memory", enabled: false, explicit: true } });
  expect(model.header).toBe("Trace Memory · S3 · trace-memory · Off (explicit)");
});

test("context: categories in canonical order, Knowledge/Facts/Raw top-level (no Memory parent)", () => {
  const { context } = buildTraceMenu(TRACE_MENU_FIXTURE);
  expect(context.categories.map(c => c.label)).toEqual([
    "System", "Tools", "Skill catalog", "Knowledge", "Facts", "Raw", "Memory, unclassified", "Conversation", "Other",
  ]);
});

test("context: a zero-amount category is omitted", () => {
  const { context } = buildTraceMenu({
    ...TRACE_MENU_FIXTURE,
    context: { ...TRACE_MENU_FIXTURE.context, categories: TRACE_MENU_FIXTURE.context.categories!.filter(c => c.name !== "Unclassified") },
  });
  expect(context.categories.some(c => c.label === "Memory, unclassified")).toBe(false);
});

test("context: rows sum to the local total, and occupied plus free equal the window", () => {
  const { context } = buildTraceMenu(TRACE_MENU_FIXTURE);
  const rowSum = context.categories.reduce((sum, c) => sum + c.tokens, 0);
  expect(rowSum).toBe(context.localTotal);
  expect(TRACE_MENU_FIXTURE.context.sdk!.tokens + context.free!.tokens).toBe(TRACE_MENU_FIXTURE.context.sdk!.window);
});

test("context: SDK and local are two independently labeled measures", () => {
  const { context } = buildTraceMenu(TRACE_MENU_FIXTURE);
  expect(context.sdkLine).toBe(`${formatCompactTokens(142_200)} / ${formatCompactTokens(400_000)} tokens (${formatPercent(142_200 / 400_000)}, SDK)`);
  expect(context.localHeading).toBe("Estimated usage by category (local)");
});

test("context: missing categories render one unavailable marker, no paragraph", () => {
  const { context } = buildTraceMenu({ ...TRACE_MENU_FIXTURE, context: { model: "m", sdk: undefined, categories: undefined } });
  expect(context.categoriesUnavailable).toBe("unavailable");
  expect(context.sdkUnavailable).toBe("unavailable");
  expect(context.sdkLine).toBeUndefined();
});

test("context: a partial estimate marks the heading, not a footnote paragraph", () => {
  const { context } = buildTraceMenu({ ...TRACE_MENU_FIXTURE, context: { ...TRACE_MENU_FIXTURE.context, complete: false } });
  expect(context.localHeading).toBe("Estimated usage by category (partial) (local)");
});

test("pending: Noting/Dreaming rows with compact ratios and whole-number percentages", () => {
  const { pending } = buildTraceMenu(TRACE_MENU_FIXTURE);
  expect(pending.noting).toEqual({ label: "Noting", tokens: 3_200, trigger: 10_000, ratio: 0.32, percent: "32%", amount: "3.2k / 10k" });
  expect(pending).not.toHaveProperty("consolidation");
  // 104: the session's summed pending weight against the trigger, and its knowledge total against
  // the injection base plus the shared allowance.
  expect(pending.dreaming).toEqual([
    { label: "pending", tokens: 1_819, trigger: 5_000, ratio: 0.3638, percent: "36%", amount: "1.8k / 5k" },
    { label: "knowledge", tokens: 17_300, trigger: 30_000, ratio: 17_300 / 30_000, percent: "58%", amount: "17.3k / 30k" },
  ]);
});

test("pending: a Noting backlog counted up to its trigger shows at-least with the exact entry count (maintainer, 2026-09-25)", () => {
  const input = (entries: number) => ({ ...TRACE_MENU_FIXTURE, pending: { ...TRACE_MENU_FIXTURE.pending,
    noting: { tokens: 10_000, trigger: 10_000, atLeast: true, entries } } });
  expect(buildTraceMenu(input(21_281)).pending.noting).toMatchObject({ ratio: 1, percent: "100%", amount: "≥10k / 10k (21,281 entries)" });
  expect(buildTraceMenu(input(1)).pending.noting.amount).toBe("≥10k / 10k (1 entry)");
});

test("pending: an unknown value never renders 0", () => {
  const { pending } = buildTraceMenu({ ...TRACE_MENU_FIXTURE, pending: { ...TRACE_MENU_FIXTURE.pending, noting: { tokens: null, trigger: null } } });
  expect(pending.noting).toEqual({ label: "Noting", tokens: null, trigger: null, ratio: null, percent: "?", amount: "?" });
});

test("spend: session total, per-phase split (with the singular 'run') and today's figure", () => {
  const { spend } = buildTraceMenu(TRACE_MENU_FIXTURE);
  expect(spend.sessionLine).toBe("Spend   session $1.23");
  expect(spend.phaseLine).toBe("Noting 12 runs $0.40 · Consolidation 3 runs $0.50 · Dreaming 1 run $0.33");
  expect(spend.todayLine).toBe("        today   $5.31");
});

test("notices: empty by default, one line when automatic off fires", () => {
  expect(buildTraceMenu(TRACE_MENU_FIXTURE).notices).toEqual([]);
  expect(buildTraceMenu(TRACE_MENU_FIXTURE_WITH_NOTICE).notices).toHaveLength(1);
});

test("actions: Turn off/on flips with enrollment, Retry fork only when offered", () => {
  expect(buildTraceMenu(TRACE_MENU_FIXTURE).actions).toEqual(["Turn off", "Catch up", "Stop", "Project…", "Runs…", "Settings…"]);
  const off = buildTraceMenu({ ...TRACE_MENU_FIXTURE, actions: { enabled: false, retryForkAvailable: false } });
  expect(off.actions[0]).toBe("Turn on");
  const withRetry = buildTraceMenu({ ...TRACE_MENU_FIXTURE, actions: { enabled: true, retryForkAvailable: true } });
  expect(withRetry.actions.at(-1)).toBe("Retry fork");
});

test("settings: budgets derive the knowledge window and max input from the code defaults", () => {
  const { budgets } = buildTraceSettings(TRACE_SETTINGS_FIXTURE);
  expect(budgets.rows).toEqual([
    { label: "Global", value: "4,000" },
    { label: "Project", value: "15,000", qualifier: "per project" },
    { label: "Session", value: "1,000", qualifier: "per session" },
  ]);
  expect(budgets.derivedLine).toBe("→ knowledge window 20,000 + shared allowance 10,000 = 30,000 max input");
});

test("settings: the Noter mode column appears on both hosts; Dreamer remains subagent-only", () => {
  expect(buildTraceSettings(TRACE_SETTINGS_FIXTURE).workers.showModeColumn).toBe(true);
  expect(buildTraceSettings(TRACE_SETTINGS_FIXTURE_CC).workers.showModeColumn).toBe(true);
  expect(buildTraceSettings(TRACE_SETTINGS_FIXTURE_CC).workers.rows[0]).toMatchObject({ mode: "subagent" });
  expect(buildTraceSettings(TRACE_SETTINGS_FIXTURE_CC).workers.rows[1]!.mode).toBeUndefined();
});

test("settings: closed-session scope line lists all three choices", () => {
  expect(buildTraceSettings(TRACE_SETTINGS_FIXTURE).closedSessionsLine).toBe("Closed sessions   project   (off · project · global)");
});
