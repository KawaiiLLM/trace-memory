// src/hosts/trace-menu.ts
var compact = (n) => {
  if (n >= 1e6) return `${trimZero((n / 1e6).toFixed(1))}M`;
  if (n >= 1e3) return `${trimZero((n / 1e3).toFixed(1))}k`;
  return String(n);
};
var trimZero = (s) => s.endsWith(".0") ? s.slice(0, -2) : s;
var formatTokens = (n) => n.toLocaleString("en-US");
var formatCompactTokens = compact;
var formatPercent = (ratio) => {
  if (ratio > 0 && ratio < 1e-3) return "<0.1%";
  return `${(ratio * 100).toFixed(1)}%`;
};
var formatShare = (value, total) => total > 0 ? formatPercent(value / total) : "0.0%";
var formatMoney = (n) => `$${n.toFixed(2)}`;
var formatMoneyBound = (n, unknown = 0) => unknown ? `${formatMoney(n)}+ (${unknown} unknown)` : formatMoney(n);
var formatWholePercent = (ratio) => `${Math.round(ratio * 100)}%`;
var CONTEXT_CATEGORY_ORDER = [
  "System",
  "Tools",
  "Skills",
  "Knowledge",
  "Facts",
  "Raw",
  "Unclassified",
  "Conversation",
  "Other"
];
var CATEGORY_LABEL = {
  System: "System",
  Tools: "Tools",
  Skills: "Skill catalog",
  Knowledge: "Knowledge",
  Facts: "Facts",
  Raw: "Raw",
  Conversation: "Conversation",
  Other: "Other",
  Unclassified: "Memory, unclassified"
};
var CATEGORY_COLOR = {
  System: "system",
  Tools: "tools",
  Skills: "skills",
  Knowledge: "knowledge",
  Facts: "facts",
  Raw: "raw",
  Conversation: "conversation",
  Other: "other",
  Unclassified: "unclassified"
};
var MEMORY_COLOR_HEX = {
  knowledge: "#DDEE49",
  facts: "#A1EE49",
  raw: "#65EE49",
  unclassified: "#8EA970"
};
function buildContextSection(input) {
  const localTotal = (input.categories ?? []).reduce((sum, c) => sum + c.tokens, 0);
  const categories = (input.categories ?? []).filter((c) => c.tokens > 0).sort((a, b) => CONTEXT_CATEGORY_ORDER.indexOf(a.name) - CONTEXT_CATEGORY_ORDER.indexOf(b.name)).map((c) => ({ label: CATEGORY_LABEL[c.name], color: CATEGORY_COLOR[c.name], tokens: c.tokens, share: formatShare(c.tokens, localTotal) }));
  const partial = input.complete === false ? " (partial)" : "";
  return {
    model: input.model,
    sdkLine: input.sdk ? `${formatCompactTokens(input.sdk.tokens)} / ${formatCompactTokens(input.sdk.window)} tokens (${formatPercent(input.sdk.tokens / input.sdk.window)}, SDK)` : void 0,
    sdkUnavailable: input.sdk ? void 0 : "unavailable",
    localHeading: `Estimated usage by category${partial} (local)`,
    categories,
    localTotal,
    free: input.sdk ? { tokens: Math.max(0, input.sdk.window - input.sdk.tokens), share: formatShare(Math.max(0, input.sdk.window - input.sdk.tokens), input.sdk.window) } : void 0,
    categoriesUnavailable: input.categories ? void 0 : "unavailable"
  };
}
var pendingRow = (label, value) => {
  if (value.tokens === null || value.trigger === null) return { label, tokens: null, trigger: null, ratio: null, percent: "?", amount: "?" };
  const ratio = value.trigger === 0 ? value.tokens === 0 ? 0 : 1 : Math.min(1, value.tokens / value.trigger);
  const trigger = formatCompactTokens(value.trigger);
  const amount = value.atLeast ? `\u2265${trigger} / ${trigger} (${(value.entries ?? 0).toLocaleString("en-US")} ${value.entries === 1 ? "entry" : "entries"})` : `${formatCompactTokens(value.tokens)} / ${trigger}`;
  return { label, tokens: value.tokens, trigger: value.trigger, ratio, percent: formatWholePercent(ratio), amount };
};
function buildPendingSection(input) {
  return {
    heading: "Pending / trigger",
    noting: pendingRow("Noting", input.noting),
    dreamingHeading: "Dreaming",
    dreaming: [pendingRow("pending", input.dreaming.pending), pendingRow("knowledge", input.dreaming.knowledge)]
  };
}
function buildSpendSection(input) {
  const phase = (label, p) => `${label} ${p.runs} ${p.runs === 1 ? "run" : "runs"} ${formatMoney(p.cost)}`;
  return {
    sessionLine: `Spend   session ${formatMoneyBound(input.session, input.sessionUnknown)}`,
    phaseLine: `${phase("Noting", input.noting)} \xB7 ${phase("Consolidation", input.consolidation)} \xB7 ${phase("Dreaming", input.dreaming)}`,
    todayLine: `        today   ${formatMoneyBound(input.today, input.todayUnknown)}`
  };
}
function buildHeader(input) {
  const state = input.enabled ? "On" : "Off";
  const suffix = input.explicit ? ` (explicit)` : "";
  return `Trace Memory \xB7 ${input.session} \xB7 ${input.project} \xB7 ${state}${suffix}`;
}
function buildActions(input) {
  const toggle = input.enabled ? "Turn off" : "Turn on";
  return [toggle, "Catch up", "Stop", "Project\u2026", "Runs\u2026", "Settings\u2026"];
}
var toggleConfirmation = (turnOn, shared) => ({
  title: `Turn Trace Memory ${turnOn ? "on" : "off"} for this session?`,
  message: (shared ? " Shared identity: this switch also affects forks or clones carrying this memory identity." : " Forks or clones carrying this memory identity share this switch.") + (turnOn ? " Available history, including the paused interval, will be queued without a model call." : " Processing and future injection stop; stored memory and already-injected text remain.")
});
function parseRunsCount(input) {
  if (!/^[1-9]\d*$/.test(input) || !Number.isSafeInteger(Number(input)))
    throw new Error("Runs count must be a positive safe integer in decimal notation");
  return Number(input);
}
var MENU_INPUTS = {
  runs: "Runs: number to show",
  project: "Project name (every session declaring this name in this database shares its knowledge; without a name, a new session joins the project its repository directory already has when that is exactly one project \u2014 home and temporary directories excluded)"
};
function buildTraceMenu(input) {
  return {
    header: buildHeader(input.header),
    context: buildContextSection(input.context),
    pending: buildPendingSection(input.pending),
    spend: buildSpendSection(input.spend),
    notices: input.notices,
    actions: buildActions(input.actions)
  };
}
function buildSettingsBudgets(input) {
  const window = input.global + input.project + input.session;
  return {
    rows: [
      { label: "Global", value: formatTokens(input.global) },
      { label: "Project", value: formatTokens(input.project), qualifier: "per project" },
      { label: "Session", value: formatTokens(input.session), qualifier: "per session" }
    ],
    derivedLine: `\u2192 knowledge window ${formatTokens(window)} + shared allowance ${formatTokens(input.sharedAllowanceTokens)} = ${formatTokens(window + input.sharedAllowanceTokens)} max input`
  };
}
function buildSettingsWorkers(input) {
  return { showModeColumn: input.some((w) => w.mode !== void 0), rows: input.map((w) => ({ ...w })) };
}
function buildSettingsChoices(input) {
  const budgetRows = buildSettingsBudgets(input.budgets).rows;
  const budgets = ["global", "project", "session"].map((scope, i) => ({
    id: `budget.${scope}`,
    label: `${budgetRows[i].label} Knowledge budget: ${budgetRows[i].value}`
  }));
  const workers = input.workers.flatMap((w) => {
    const phase = w.phase === "Noter" ? "noting" : "dreaming";
    return [
      ...w.mode !== void 0 ? [{ id: `${phase}.mode`, label: `${w.phase} mode: ${w.mode}`, source: w.sources?.mode }] : [],
      { id: `${phase}.model`, label: `${w.phase} model: ${w.model}`, source: w.sources?.model ?? w.source },
      { id: `${phase}.thinking`, label: `${w.phase} thinking: ${w.thinking}`, source: w.sources?.thinking }
    ].map((row) => ({ id: row.id, label: `${row.label}${row.source ? ` (${row.source})` : ""}` }));
  });
  return [...budgets, ...workers, { id: "closedSessionScope", label: `Closed sessions: ${input.closedSessionScope}${input.closedSessionSource ? ` (${input.closedSessionSource})` : ""}` }];
}
var SCOPE_CHOICES = ["off", "project", "global"];
function buildTraceSettings(input) {
  return {
    header: `Trace Memory \xB7 Settings                 database ${input.database}`,
    budgets: buildSettingsBudgets(input.budgets),
    workers: buildSettingsWorkers(input.workers),
    closedSessionsLine: `Closed sessions   ${input.closedSessionScope}   (${SCOPE_CHOICES.join(" \xB7 ")})${input.closedSessionSource ? `  ${input.closedSessionSource}` : ""}`
  };
}
var TRACE_MENU_FIXTURE = {
  header: { session: "S3", project: "trace-memory", enabled: true },
  context: {
    model: "openai-codex/gpt-6-astra",
    sdk: { tokens: 142200, window: 4e5 },
    categories: [
      { name: "System", tokens: 1900 },
      { name: "Tools", tokens: 5e3 },
      { name: "Skills", tokens: 1200 },
      { name: "Knowledge", tokens: 17300 },
      { name: "Facts", tokens: 9900 },
      { name: "Raw", tokens: 1e4 },
      { name: "Unclassified", tokens: 200 },
      { name: "Conversation", tokens: 96600 },
      { name: "Other", tokens: 200 }
    ],
    complete: true
  },
  pending: {
    noting: { tokens: 3200, trigger: 1e4 },
    dreaming: {
      pending: { tokens: 1819, trigger: 5e3 },
      knowledge: { tokens: 17300, trigger: 3e4 }
    }
  },
  spend: {
    session: 1.23,
    noting: { runs: 12, cost: 0.4 },
    consolidation: { runs: 3, cost: 0.5 },
    dreaming: { runs: 1, cost: 0.33 },
    today: 5.31
  },
  notices: [],
  actions: { enabled: true }
};
var TRACE_MENU_FIXTURE_WITH_NOTICE = {
  ...TRACE_MENU_FIXTURE,
  notices: ["Automatic off: noting failed 3 times at T4412 (R881: model request timed out after 3 attempts). Turn on to resume."]
};
var TRACE_SETTINGS_FIXTURE = {
  database: "~/.trace-memory/trace.db",
  budgets: { global: 4e3, project: 15e3, session: 1e3, sharedAllowanceTokens: 1e4 },
  workers: [
    { phase: "Noter", mode: "subagent", model: "follow foreground", thinking: "inherit" },
    { phase: "Dreamer", model: "claude-sonnet-5", thinking: "medium" }
  ],
  closedSessionScope: "project"
};
var TRACE_SETTINGS_FIXTURE_CC = {
  ...TRACE_SETTINGS_FIXTURE,
  workers: [
    { phase: "Noter", mode: "subagent", model: "claude-sonnet-5", thinking: "medium" },
    { phase: "Dreamer", model: "claude-sonnet-5", thinking: "medium" }
  ]
};

// src/hosts/cc/trace-menu-render.ts
var MEMORY_COLOR = MEMORY_COLOR_HEX;
var memorySplitSum = (m) => m.knowledge + m.facts + m.raw + m.unclassified;
function scaleMemoryToMessages(memory, messagesTokens, contextTokens) {
  const sum = memorySplitSum(memory);
  if (sum === 0) return memory;
  if (messagesTokens === void 0 || !contextTokens || sum > contextTokens || messagesTokens < 0) return void 0;
  const factor = messagesTokens / contextTokens;
  const keys = ["knowledge", "facts", "raw", "unclassified"];
  const parts = keys.map((key, index) => ({ key, index, exact: memory[key] * factor, amount: Math.floor(memory[key] * factor) }));
  let remainder = Math.round(sum * factor) - parts.reduce((total, part) => total + part.amount, 0);
  for (const part of [...parts].sort((a, b) => b.exact - b.amount - (a.exact - a.amount) || a.index - b.index)) {
    if (remainder-- <= 0) break;
    part.amount++;
  }
  return { knowledge: parts[0].amount, facts: parts[1].amount, raw: parts[2].amount, unclassified: parts[3].amount };
}
var ccCompact = (n) => {
  if (n >= 1e6) {
    const s = (n / 1e6).toFixed(1);
    return `${s.endsWith(".0") ? s.slice(0, -2) : s}m`;
  }
  if (n >= 1e3) {
    const s = (n / 1e3).toFixed(1);
    return `${s.endsWith(".0") ? s.slice(0, -2) : s}k`;
  }
  return String(n);
};
var FULL_GLYPH = "\u26C1";
var PARTIAL_GLYPH = "\u26C0";
var FREE_GLYPH = "\u26F6";
function buildDisplayCategories(breakdown2, memory) {
  if (!memory) return breakdown2.categories.map((c) => ({ name: c.name, tokens: c.tokens, color: c.color, kind: c.kind }));
  const memorySum = memorySplitSum(memory);
  const memoryRows = [
    { name: "Knowledge", tokens: memory.knowledge, color: MEMORY_COLOR.knowledge, kind: "used" },
    { name: "Facts", tokens: memory.facts, color: MEMORY_COLOR.facts, kind: "used" },
    { name: "Raw", tokens: memory.raw, color: MEMORY_COLOR.raw, kind: "used" },
    ...memory.unclassified > 0 ? [{ name: "Memory, unclassified", tokens: memory.unclassified, color: MEMORY_COLOR.unclassified, kind: "used" }] : []
  ];
  const out = [];
  let spliced = false;
  for (const cat of breakdown2.categories) {
    if (cat.name === "Messages") {
      spliced = true;
      out.push(...memoryRows);
      const remainder = Math.max(0, cat.tokens - memorySum);
      if (remainder > 0) out.push({ name: cat.name, tokens: remainder, color: cat.color, kind: cat.kind });
      continue;
    }
    if (!spliced && cat.kind === "free") {
      out.push(...memoryRows);
      spliced = true;
    }
    out.push({ name: cat.name, tokens: cat.tokens, color: cat.color, kind: cat.kind });
  }
  if (!spliced) out.push(...memoryRows);
  return out;
}
var CC_NARROW_COLUMNS = 80;
function computeCcGrid(categories, window, terminalWidth, minRows = 0) {
  const narrow = terminalWidth !== void 0 && terminalWidth < CC_NARROW_COLUMNS;
  const bigWindow = window >= 1e6;
  const columns = narrow ? 5 : bigWindow ? 20 : 10;
  const rows = bigWindow ? 10 : narrow ? 5 : 10;
  const totalCells = columns * rows;
  const squaresFor = (cat) => {
    const raw = window > 0 ? cat.tokens / window * totalCells : 0;
    const count = Math.max(1, Math.round(raw));
    const whole = Math.floor(raw), remainder = raw - whole;
    return Array.from({ length: count }, (_, i) => {
      const fullness = i === whole && remainder > 0 ? remainder : 1;
      return { glyph: fullness >= 1 ? FULL_GLYPH : PARTIAL_GLYPH, color: cat.color };
    });
  };
  const used = categories.filter((c) => c.kind === "used" && c.tokens > 0);
  const buffer = categories.find((c) => c.kind === "buffer" && c.tokens > 0);
  const free = categories.find((c) => c.kind === "free");
  const freeColor = free?.color ?? "promptBorder";
  const cells = [];
  for (const cat of used) for (const cell of squaresFor(cat)) if (cells.length < totalCells) cells.push(cell);
  const bufferCells = buffer ? squaresFor(buffer) : [];
  const freeBudget = Math.max(0, totalCells - cells.length - bufferCells.length);
  for (let i = 0; i < freeBudget; i++) cells.push({ glyph: FREE_GLYPH, color: freeColor });
  for (const cell of bufferCells) if (cells.length < totalCells) cells.push(cell);
  while (cells.length < totalCells) cells.push({ glyph: FREE_GLYPH, color: freeColor });
  const gridRows = [];
  for (let r = 0; r < rows; r++) gridRows.push(cells.slice(r * columns, r * columns + columns));
  const blankRow = () => Array.from({ length: columns }, () => ({ glyph: FREE_GLYPH, color: freeColor }));
  while (gridRows.length < minRows) gridRows.push(blankRow());
  return gridRows;
}
function buildCcContextSection(breakdown2, memory, contextTokens) {
  if (!breakdown2) return void 0;
  const messagesCategory = breakdown2.categories.find((c) => c.name === "Messages");
  const scaledMemory = memory ? scaleMemoryToMessages(memory, messagesCategory?.tokens, contextTokens) : void 0;
  const overflow = scaledMemory !== void 0 && messagesCategory !== void 0 && memorySplitSum(scaledMemory) > messagesCategory.tokens;
  const inconsistent = memory !== void 0 && (scaledMemory === void 0 || overflow || !messagesCategory && memorySplitSum(scaledMemory) > 0);
  const effectiveMemory = inconsistent ? void 0 : scaledMemory;
  const displayCategories = buildDisplayCategories(breakdown2, effectiveMemory);
  const row = (cat) => {
    const isFree = cat.kind === "free";
    return {
      label: cat.name,
      color: cat.color,
      glyph: isFree ? FREE_GLYPH : FULL_GLYPH,
      tokens: cat.tokens,
      tokensLabel: ccCompact(cat.tokens),
      percent: formatPercent(breakdown2.maxTokens > 0 ? cat.tokens / breakdown2.maxTokens : 0),
      suffix: isFree ? "" : " tokens"
    };
  };
  const legend = displayCategories.map(row);
  const totalLine = `${ccCompact(breakdown2.totalTokens)}/${ccCompact(breakdown2.maxTokens)} tokens (${breakdown2.percentage}%, estimated)`;
  const headerLines = breakdown2.displayName ? [breakdown2.displayName, breakdown2.model, totalLine] : [breakdown2.model, totalLine];
  const legendHeading = "Estimated usage by category";
  const memoryUnavailable = effectiveMemory ? void 0 : inconsistent || messagesCategory ? "Knowledge, Facts, Raw: unavailable" : void 0;
  const sideBySide = breakdown2.terminalWidth === void 0 || breakdown2.terminalWidth >= CC_NARROW_COLUMNS;
  const legendLineCount = headerLines.length + 1 + 1 + legend.length + (memoryUnavailable ? 1 : 0);
  const gridRows = computeCcGrid(displayCategories, breakdown2.maxTokens, breakdown2.terminalWidth, sideBySide ? legendLineCount : 0);
  return { headerLines, sideBySide, gridRows, legendHeading, legend, memoryUnavailable };
}
function renderTraceMenuText(rendered) {
  const context = rendered.context;
  return [
    rendered.header,
    "",
    ...context ? [
      ...context.headerLines,
      context.legendHeading,
      ...context.legend.map((row) => `${row.glyph} ${row.label}: ${row.tokensLabel}${row.suffix} (${row.percent})`),
      ...context.memoryUnavailable ? [context.memoryUnavailable] : []
    ] : [rendered.contextUnavailable ?? "unavailable \u2014 see the built-in /context"],
    "",
    rendered.pendingHeading,
    ...rendered.pendingLines,
    "",
    ...rendered.spendLines,
    ...rendered.notices.map((notice2) => `! ${notice2}`),
    "",
    rendered.actions.map((action) => action.label).join("   ")
  ].join("\n");
}
var bar = (ratio) => {
  const filled = Math.min(10, Math.floor(ratio * 10));
  return "\u2588".repeat(filled) + "\u2591".repeat(10 - filled);
};
var pendingLine = (label, row, indent = "  ") => row.tokens === null ? `${indent}${label}: Unknown / ${row.trigger ?? "Unknown"}` : `${indent}${label.padEnd(13)} ${bar(row.ratio ?? 0)} ${row.percent.padStart(4)}   ${row.amount}`;
function renderTraceMenu(input, cc) {
  const model = buildTraceMenu(input);
  const context = buildCcContextSection(cc.breakdown, cc.memory, cc.contextTokens);
  return {
    header: model.header,
    context,
    contextUnavailable: context ? void 0 : "unavailable \u2014 see the built-in /context",
    pendingHeading: model.pending.heading,
    pendingLines: [
      pendingLine("Noting", model.pending.noting),
      `  ${model.pending.dreamingHeading}`,
      ...model.pending.dreaming.map((row) => pendingLine(row.label, row, "    "))
    ],
    spendLines: [model.spend.sessionLine, `        ${model.spend.phaseLine}`, model.spend.todayLine],
    notices: model.notices,
    actions: model.actions.map((a) => ({ value: a.toLowerCase().replace(/[^a-z]+/g, "-").replace(/-$/, ""), label: a }))
  };
}
function renderTraceSettings(input) {
  const model = buildTraceSettings(input);
  return {
    header: model.header,
    budgetLines: model.budgets.rows.map((row) => `${row.label.padEnd(9)} ${row.value.padStart(6)}${row.qualifier ? `  ${row.qualifier}` : ""}`),
    derivedLine: model.budgets.derivedLine,
    // Ticket: the mode column exists on Pi only, because Claude Code workers have no fork mode.
    workerHeader: "Workers        model                thinking",
    workerLines: model.workers.rows.map((w) => `${w.phase.padEnd(14)} ${w.model.padEnd(20)} ${w.thinking}${w.source ? ` (${w.source})` : ""}`),
    closedSessionsLine: model.closedSessionsLine
  };
}

// src/core/model/address.ts
var MEMORY_ROOT = "/tm";
var MEMORY_READ_ONLY = `${MEMORY_ROOT}/ is Trace Memory and read-only: record facts with the note tool and knowledge with the memory tool.`;
function memoryPath(value) {
  if (typeof value !== "string" || !value.startsWith("/")) return null;
  const segments = [];
  for (const segment of value.split("/")) {
    if (segment === "" || segment === ".") continue;
    if (segment === "..") segments.pop();
    else segments.push(segment);
  }
  return segments[0] === "tm" ? `/${segments.join("/")}` : null;
}
function memoryGlob(pattern, path) {
  if (typeof pattern !== "string" || !pattern) return null;
  const full = pattern.startsWith("/") ? pattern : typeof path === "string" && path.startsWith("/") ? `${path.replace(/\/+$/, "")}/${pattern}` : null;
  if (!full) return null;
  const segments = full.split("/"), wild = segments.findIndex((segment) => /[*?[\]{}]/.test(segment));
  const literal = wild < 0 ? full : segments.slice(0, wild).join("/") || "/";
  const root = memoryPath(literal);
  return root === null ? null : wild < 0 ? root : [root, ...segments.slice(wild)].join("/");
}

// plugin/hooks/index.tsx
var screen = "main";
var reply;
var breakdown;
var notice = "";
var unavailable = "";
var registeredSession = "";
var pluginRoot = "";
var selectedAction = "";
var selectedSetting;
var DOCK_COLUMNS = 96;
var paneWidth = DOCK_COLUMNS;
var runsLimit = 10;
var activeSession = "";
var id = "trace-memory-menu";
function renderCurrent() {
  if (!reply) throw new Error("Trace Memory: menu has not loaded");
  return renderTraceMenu(reply.menu, {
    breakdown,
    memory: reply.context.presence === "confirmed" ? reply.context.memory : void 0,
    contextTokens: reply.context.presence === "confirmed" ? reply.context.estimatedMessagesTokens : void 0
  });
}
function decode(result, label) {
  if (result.exitCode !== 0) throw new Error(`${label}: ${result.stderr || `exit ${result.exitCode}`}`);
  if (!result.stdout) throw new Error(`${label}: empty CLI response${result.stderr ? ` (${result.stderr})` : ""}`);
  return result.stdout.trim();
}
async function load($) {
  const session = await $.session.id();
  let currentBreakdown;
  try {
    const usage = await $.session.usage({ breakdown: "summary", columns: paneWidth });
    const b = usage?.context?.breakdown;
    currentBreakdown = b ? {
      model: b.model,
      totalTokens: b.totalTokens,
      maxTokens: b.maxTokens,
      percentage: b.percentage,
      categories: b.categories,
      displayName: b.displayName,
      terminalWidth: paneWidth
    } : void 0;
  } catch {
    currentBreakdown = void 0;
  }
  let messages;
  try {
    messages = await $.session.messages({ as: "api" });
  } catch {
    messages = null;
  }
  const result = await $.process.run(
    ["node", `${pluginRoot}/dist/cc.cjs`, "cli", "--config", `${pluginRoot}/cc.config.json`, "--session", session, "menu", "--json", "--snapshot"],
    { stdin: JSON.stringify({ session, model: currentBreakdown?.model, messages }) }
  );
  if (await $.session.id() !== session) throw new Error("native session changed while loading menu");
  return { session, data: JSON.parse(decode(result, "Trace Memory menu")), breakdown: currentBreakdown };
}
async function nativeCompaction($, e, next, session) {
  const result = await next(e);
  if (result.skip || next.signal.aborted) return result;
  try {
    if (session !== await $.session.id()) throw new Error("native session changed during compact");
    const process = await $.process.run(
      ["node", `${$.plugin.root}/dist/cc.cjs`, "hook-delta", "--config", `${$.plugin.root}/cc.config.json`],
      // 97: the supplement is recorded as this compaction's baseline; the retained messages are not read.
      { stdin: JSON.stringify({ hook_event_name: "session.compact", session_id: session, messages: [] }) }
    );
    const slices = JSON.parse(decode(process, "Trace Memory compact delta")).slices;
    if (!Array.isArray(slices) || slices.length !== 24) throw new Error("compact delta returned invalid slices");
    const added = slices.filter(Boolean).map((slice) => slice.hookSpecificOutput?.additionalContext);
    if (added.some((text) => typeof text !== "string" || !text)) throw new Error("compact delta has invalid carrier");
    if (session !== await $.session.id() || next.signal.aborted) return result;
    return added.length ? { ...result, messages: [
      ...result.messages,
      ...added.map((text) => ({ role: "user", text, toolUses: [] }))
    ] } : result;
  } catch (error) {
    console.error(`Trace Memory compact delta: ${String(error)}`);
    return result;
  }
}
async function memoryFiles($, args) {
  const root = $.plugin.root, session = await $.session.id();
  const run = await $.process.run(["node", `${root}/dist/cc.cjs`, "fs", "--config", `${root}/cc.config.json`, "--session", session, ...args]);
  if (run.exitCode !== 0) throw new Error(String(run.stderr || `exit ${run.exitCode}`).replace(/^Trace Memory CC: /, "").trim());
  return JSON.parse(run.stdout);
}
var failure = (error) => ({ deny: error instanceof Error ? error.message : String(error) });
var listed = (listing) => listing.cut ? [...listing.lines, listing.cut] : listing.lines;
async function forkEvent($, session, verb, detail) {
  const result = await $.process.run(
    ["node", `${$.plugin.root}/dist/cc.cjs`, "hook-fork", "--config", `${$.plugin.root}/cc.config.json`],
    { stdin: JSON.stringify({ session_id: session, verb, ...detail }) }
  );
  return JSON.parse(decode(result, `Trace Memory ${verb}`)).allowed === true;
}
async function showForkWarnings($, session, agent) {
  try {
    const result = await $.process.run(
      ["node", `${$.plugin.root}/dist/cc.cjs`, "hook-fork", "--config", `${$.plugin.root}/cc.config.json`],
      { stdin: JSON.stringify({ session_id: session, verb: "fork-account", agentId: agent }) }
    );
    for (const warning of JSON.parse(decode(result, "Trace Memory fork-account")).warnings ?? []) $.ui.log(String(warning));
  } catch (error) {
    console.error(`Trace Memory fork accounting: ${String(error)}`);
  }
}
async function stopNativeFork($, session, agent) {
  if (await $.session.id() !== session) throw new Error("native session changed before fork stop");
  const live = (await $.agent.list()).find((item) => item.id === agent && item.type === "fork" && item.status === "running");
  if (!live) throw new Error(`exact native fork ${agent} is not proven live`);
  const stopped = await $.tool.call({ tool: "TaskStop", task_id: agent });
  if (stopped?.result?.task_id !== agent || !String(stopped.result.message).startsWith("Successfully stopped task:"))
    throw new Error(`TaskStop did not confirm exact native fork ${agent}: ${JSON.stringify(stopped)}`);
}
function watchNativeFork($, session, agent) {
  $.clock.after(0, async () => {
    try {
      const stream = $.process.spawn({ argv: [
        "node",
        `${$.plugin.root}/dist/cc.cjs`,
        "hook-fork-watch",
        "--config",
        `${$.plugin.root}/cc.config.json`,
        "--session",
        session,
        agent
      ] });
      let output = "", stderr = "", code;
      const iterator = stream[Symbol.asyncIterator]();
      while (true) {
        const step = await iterator.next();
        if (step.done) {
          code = step.value?.code;
          break;
        }
        if (step.value.stream === "stdout") output += step.value.text;
        if (step.value.stream === "stderr") stderr += step.value.text;
      }
      if (code !== 0) throw new Error(`fork stop helper exited ${code}: ${stderr}`);
      const instruction = JSON.parse(output.trim());
      if (instruction.agent !== agent || instruction.session !== session || !["done", "stop"].includes(instruction.kind))
        throw new Error("fork stop instruction has wrong native identity");
      if (instruction.kind === "stop") {
        await stopNativeFork($, session, agent);
        console.error(`Trace Memory native fork ${agent} physically stopped by TaskStop`);
      }
      await showForkWarnings($, session, agent);
    } catch (error) {
      try {
        await forkEvent($, session, "fork-disconnect", { agentId: agent });
      } catch (fenceError) {
        console.error(`Trace Memory fork write fence failed (${agent}): ${String(fenceError)}`);
      }
      try {
        await stopNativeFork($, session, agent);
      } catch (stopError) {
        console.error(`Trace Memory fork physical stop unknown (${agent}): ${String(error)}; ${String(stopError)}`);
      }
      console.error(`Trace Memory fork stop listener failed (${agent}): ${String(error)}`);
    }
  });
}
export const register = (on) => {
  on("tool.call", { tool: "Read" }, async ($, e, next) => {
    const path = memoryPath(e.file_path);
    if (path === null) return next(e);
    try {
      const page = await memoryFiles($, ["read", path, String(e.offset ?? 1), ...e.limit === void 0 ? [] : [String(e.limit)]]);
      const lines = listed(page);
      return { result: { type: "text", file: {
        filePath: e.file_path,
        content: lines.join("\n"),
        numLines: lines.length,
        startLine: page.startLine,
        totalLines: page.totalLines
      } } };
    } catch (error) {
      return failure(error);
    }
  });
  on("tool.call", { tool: "Grep" }, async ($, e, next) => {
    const path = memoryPath(e.path);
    if (path === null) return next(e);
    const mode = e.output_mode === "content" || e.output_mode === "count" ? e.output_mode : "files_with_matches";
    const context = e["-C"] ?? e.context;
    try {
      const listing = await memoryFiles($, [
        "grep",
        mode === "content" ? "-n" : mode === "count" ? "-c" : "-l",
        ...e["-i"] ? ["-i"] : [],
        ...context !== void 0 ? ["-C", String(context)] : [],
        ...e["-A"] !== void 0 ? ["-A", String(e["-A"])] : [],
        ...e["-B"] !== void 0 ? ["-B", String(e["-B"])] : [],
        ...e.glob ? ["--glob", e.glob] : [],
        ...e.offset ? ["--offset", String(e.offset)] : [],
        ...e.head_limit ? ["--limit", String(e.head_limit)] : [],
        "--",
        e.pattern,
        path
      ]);
      const lines = listed(listing);
      return { result: mode === "files_with_matches" ? { mode, numFiles: listing.lines.length, filenames: lines } : { mode, numFiles: 0, filenames: [], content: lines.join("\n"), numLines: lines.length } };
    } catch (error) {
      return failure(error);
    }
  });
  on("tool.call", { tool: "Glob" }, async ($, e, next) => {
    const pattern = memoryGlob(e.pattern, e.path);
    if (pattern === null) return next(e);
    try {
      const listing = await memoryFiles($, ["glob", pattern]);
      return { result: { durationMs: 0, numFiles: listing.lines.length, filenames: listed(listing), truncated: !!listing.cut } };
    } catch (error) {
      return failure(error);
    }
  });
  on("tool.call", { tool: "Edit" }, ($, e, next) => memoryPath(e.file_path) === null ? next(e) : { deny: MEMORY_READ_ONLY });
  on("tool.call", { tool: "Write" }, ($, e, next) => memoryPath(e.file_path) === null ? next(e) : { deny: MEMORY_READ_ONLY });
  on("tool.call", { tool: "NotebookEdit" }, ($, e, next) => memoryPath(e.notebook_path) === null ? next(e) : { deny: MEMORY_READ_ONLY });
  on("session.compact", async ($, e, next) => {
    if (e.trigger === "precompute" || e.trigger === "plugin" || e.agentId) return next(e);
    let session;
    try {
      session = await $.session.id();
    } catch (error) {
      console.error(`Trace Memory compact identity: ${String(error)}`);
      return next(e);
    }
    try {
      const built = JSON.parse(decode(await $.process.run(
        ["node", `${$.plugin.root}/dist/cc.cjs`, "hook-compact", "--config", `${$.plugin.root}/cc.config.json`],
        // The newest message's handle is its transcript row's uuid: the trigger the build waits for.
        // `auto` (requirement 14, ruled) tells the build whether to end the block with Claude Code's
        // own native continue sentence, after its framing; a manual `/compact` gets none.
        { stdin: JSON.stringify({ session_id: session, trigger: e.messages.at(-1)?.handle, auto: e.trigger === "auto" }) }
      ), "Trace Memory compaction"));
      if (!built.passThrough) {
        if (typeof built.text !== "string" || !built.text) throw new Error("compaction returned no block");
        if (session !== await $.session.id()) throw new Error("native session changed during compaction");
        if (typeof built.warning === "string") try {
          $.ui.log(built.warning);
        } catch (error) {
          console.error(`Trace Memory compaction warning: ${String(error)}`);
        }
        return { messages: [{ role: "user", text: built.text, toolUses: [] }] };
      }
    } catch (error) {
      console.error(`Trace Memory compaction: ${String(error)}`);
    }
    return nativeCompaction($, e, next, session);
  });
  on("session.start", async ($, e, next) => {
    registeredSession = "";
    try {
      pluginRoot = $.plugin.root;
      if (!pluginRoot) throw new Error("Claude Code plugin root is unavailable");
    } catch (error) {
      unavailable = `Trace Memory: ${String(error)} \u2014 /trace disabled`;
      await $.ui.status(unavailable);
    }
    if (!unavailable) {
      try {
        await $.command.register({ name: "trace", description: "Open the local Trace Memory menu" });
      } catch (error) {
        await $.ui.status(`Trace Memory: /trace registration failed: ${String(error)}`);
      }
    }
    return next(e);
  });
  on("turn.step", async function* ($, e, next) {
    if (e.agentId || unavailable) return yield* next(e);
    const session = await $.session.id();
    if (session !== registeredSession) {
      const root = $.plugin.root;
      if (!root) throw new Error("Trace Memory: Claude Code plugin root is unavailable");
      const result = await $.process.run(
        ["node", `${root}/dist/cc.cjs`, "hook-capable", "--config", `${root}/cc.config.json`],
        { stdin: JSON.stringify({ session_id: session }) }
      );
      if (result.exitCode !== 0) throw new Error(`Trace Memory function hook registration: ${String(result.stderr || `exit ${result.exitCode}`)}`);
      if (session !== await $.session.id()) throw new Error("Trace Memory: native session changed during function hook registration");
      registeredSession = session;
    }
    return yield* next(e);
  });
  on("tool.call", async ($, e, next) => {
    const name = String(e.tool).match(/^mcp__(?:traceMemory|plugin_trace-memory_traceMemory)__(note|memory)$/)?.[1];
    if (!name || !e.agentId || unavailable) return next(e);
    const allowed = await forkEvent($, await $.session.id(), "fork-call", { agentId: e.agentId, callId: e.tool_use_id, name });
    return allowed ? next(e) : { deny: "CC Noter fork identity is not registered for this call" };
  });
  on("tool.check", async ($, e, next) => {
    const name = String(e.tool).match(/^mcp__(?:traceMemory|plugin_trace-memory_traceMemory)__(note|memory)$/)?.[1];
    if (!name || unavailable) return next(e);
    const allowed = await forkEvent($, await $.session.id(), "fork-check", { callId: e.tool_use_id, name });
    return allowed ? { decision: "allow" } : next(e);
  });
  on("turn.complete", async ($, e, next) => {
    if (e.agentId && !unavailable) {
      try {
        await forkEvent($, await $.session.id(), "fork-terminal", { agentId: e.agentId, reason: e.reason, answer: e.answer ?? "", usage: e.usage ?? null });
      } catch (error) {
        console.error(`Trace Memory fork terminal: ${String(error)}`);
      }
    }
    if (!e.agentId && !unavailable) {
      try {
        const session = await $.session.id();
        let observation = { refused: "CC fork source coverage or native capacity is unavailable" };
        let sources;
        try {
          const view = await $.process.run(
            ["node", `${$.plugin.root}/dist/cc.cjs`, "hook-sources", "--config", `${$.plugin.root}/cc.config.json`],
            { stdin: JSON.stringify({ session_id: session, turnId: e.turnId }) }
          );
          if (view.exitCode !== 0) throw new Error(String(view.stderr || `exit ${view.exitCode}`));
          sources = JSON.parse(view.stdout);
        } catch (error) {
          observation = { failed: `CC fork source read failed: ${String(error)}` };
        }
        if (sources && !observation.failed) {
          observation = {};
          let usage;
          try {
            usage = await $.session.usage({ breakdown: "summary" });
          } catch (error) {
            observation = { refused: `CC native parent usage unavailable: ${String(error)}` };
          }
          if (!observation.refused) {
            if (session !== await $.session.id()) observation = { refused: "native session changed during fork source check" };
            else {
              try {
                const measure = usage?.context?.breakdown;
                if (typeof measure?.model !== "string" || !Number.isSafeInteger(measure.maxTokens) || !Number.isSafeInteger(measure.totalTokens) || measure.maxTokens <= 0 || measure.totalTokens < 0)
                  observation = { refused: "native parent model, window or prefix usage is unavailable" };
                else {
                  observation = {
                    checkpoint: {
                      sessionId: sources.sessionId,
                      branch: sources.branch,
                      headTurnId: sources.headTurnId,
                      tailId: sources.tailId
                    },
                    batch: sources.selected,
                    model: measure.model,
                    window: measure.maxTokens,
                    prefix: measure.totalTokens
                  };
                  if (new TextEncoder().encode(JSON.stringify(observation)).length > 12e3)
                    observation = { refused: "CC fork source identities exceed the control request bound" };
                }
              } catch (error) {
                observation = { failed: `CC fork observation failed: ${String(error)}` };
              }
            }
          }
        }
        if (observation.failed) $.ui.log(`Trace Memory: ${observation.failed}; Noting was not started`);
        const result = await $.process.run(
          ["node", `${$.plugin.root}/dist/cc.cjs`, "hook-turn", "--config", `${$.plugin.root}/cc.config.json`],
          { stdin: JSON.stringify({ session_id: session, turnId: e.turnId, reason: e.reason, observation }) }
        );
        const directive = JSON.parse(decode(result, "Trace Memory turn-end check"));
        if (directive && typeof directive.prompt === "string" && directive.turnId === e.turnId) {
          let spawnedId;
          try {
            const spawn = await $.agent.spawn({ subagentType: "fork", prompt: directive.prompt, description: "Trace Memory Noter" });
            if (typeof spawn?.agentId === "string" && spawn.agentId) {
              spawnedId = spawn.agentId;
              if (!await forkEvent($, session, "fork-register", { turnId: e.turnId, agentId: spawn.agentId }))
                throw new Error("CC fork registration was not acknowledged");
              watchNativeFork($, session, spawn.agentId);
            } else if (spawn?.deny) {
              await forkEvent($, session, "fork-no-start", { turnId: e.turnId, reason: String(spawn.deny), confirmed: true });
            } else throw new Error("CC fork spawn did not return a registered native agent identity");
          } catch (error) {
            const reason = String(error);
            const confirmed = reason.includes("Agent type 'fork' not found");
            if (spawnedId) {
              try {
                await stopNativeFork($, session, spawnedId);
              } catch (stopError) {
                console.error(`Trace Memory fork physical stop unknown: ${String(stopError)}`);
              }
            }
            try {
              if (spawnedId) await forkEvent($, session, "fork-terminal", { agentId: spawnedId, reason: "error", answer: reason });
              else await forkEvent($, session, "fork-no-start", { turnId: e.turnId, reason, confirmed });
            } catch (settlement) {
              console.error(`Trace Memory fork launch settlement failed: ${String(settlement)}`);
            }
            if (!confirmed) throw error;
          }
        }
      } catch (error) {
        const message = `Trace Memory: this turn memory check failed: ${String(error)}`;
        console.error(message);
        try {
          $.ui.log(message);
        } catch (logError) {
          console.error(`Trace Memory turn-end notification failed: ${String(logError)}`);
        }
      }
    }
    return next(e);
  });
  on("command.run", { command: "trace" }, async ($, e, next) => {
    if (unavailable) return { text: unavailable };
    try {
      screen = "main";
      notice = "";
      const loaded = await load($);
      reply = loaded.data;
      activeSession = loaded.session;
      breakdown = loaded.breakdown;
      const text = renderTraceMenuText(renderCurrent());
      await $.ui.open({ id, title: "Trace Memory", focus: true, closeOnEscape: true, rows: 45, columns: DOCK_COLUMNS });
      return { text };
    } catch (error) {
      return { text: `Trace Memory: ${String(error)}` };
    }
  });
  on("ui.render", { component: "Pane" }, ($, e, next) => {
    if (e.requestId !== id) return next(e);
    const { Box, Text, Select, Input } = $.ui.resolve(e);
    if (Number.isFinite(e.props?.bodyColumns) && e.props.bodyColumns > 0) {
      paneWidth = e.props.bodyColumns;
      if (breakdown) breakdown = { ...breakdown, terminalWidth: paneWidth };
    }
    if (!reply) return <Text>{notice || "Trace Memory: unavailable"}</Text>;
    const menu = renderCurrent();
    const reload = async () => {
      const loaded = await load($);
      reply = loaded.data;
      activeSession = loaded.session;
      breakdown = loaded.breakdown;
      $.ui.invalidate("ui.render");
    };
    const run = async (verb, args = []) => {
      const session = await $.session.id();
      if (session !== activeSession) throw new Error("native session changed; reopen /trace");
      const result = await $.process.run(["node", `${pluginRoot}/dist/cc.cjs`, "cli", "--config", `${pluginRoot}/cc.config.json`, "--session", session, verb, ...args]);
      return decode(result, `Trace Memory ${verb}`);
    };
    const act = async (verb, args = []) => {
      try {
        notice = await run(verb, args);
        await reload();
      } catch (error) {
        notice = String(error);
        $.ui.invalidate("ui.render");
      }
    };
    const actions = menu.actions;
    const back = { value: "back", label: "Back" };
    const chooseAction = (value) => {
      if (value === "settings" || value === "project") {
        screen = value;
        $.ui.invalidate("ui.render");
        return;
      }
      if (value === "runs") {
        void (async () => {
          try {
            const rows = JSON.parse(await run("runs", ["--json", String(runsLimit)]));
            reply.runs = rows.runs;
            screen = "runs";
            $.ui.invalidate("ui.render");
          } catch (error) {
            notice = String(error);
            $.ui.invalidate("ui.render");
          }
        })();
        return;
      }
      if (value === "turn-on" || value === "turn-off") {
        selectedAction = value;
        screen = "confirm";
        $.ui.invalidate("ui.render");
        return;
      }
      if (value === "catch-up") void act("catchup");
      else if (value === "stop") void act("stop");
    };
    const message = notice ? <Text>{notice}</Text> : null;
    if (screen === "main") {
      const ctx = menu.context;
      return <Box flexDirection="column">
        <Text>{menu.header}</Text><Text> </Text>
        {ctx ? <Box flexDirection={ctx.sideBySide ? "row" : "column"}>
          <Box flexDirection="column">{ctx.gridRows.map((row2, i) => <Box flexDirection="row" key={`grid-${i}`}>{row2.map((cell, j) => <Text key={`cell-${i}-${j}`} color={cell.color}>{`${cell.glyph} `}</Text>)}</Box>)}</Box>
          <Box flexDirection="column" marginLeft={ctx.sideBySide ? 2 : 0}>
            {ctx.headerLines.map((line, i) => <Text key={`heading-${i}`}>{line}</Text>)}
            <Text> </Text><Text>{ctx.legendHeading}</Text>
            {ctx.legend.map((row2, i) => <Text key={`legend-${i}`}><Text color={row2.color}>{row2.glyph}</Text>{" "}<Text bold>{`${row2.label}:`}</Text>{` ${row2.tokensLabel}${row2.suffix} (${row2.percent})`}</Text>)}
            {ctx.memoryUnavailable ? <Text>{ctx.memoryUnavailable}</Text> : null}
          </Box>
        </Box> : <Text>{menu.contextUnavailable}</Text>}
        <Text> </Text><Text>{menu.pendingHeading}</Text>
        {menu.pendingLines.map((line, i) => <Text key={`pending-${i}`}>{line}</Text>)}
        <Text> </Text>{menu.spendLines.map((line, i) => <Text key={`spend-${i}`}>{line}</Text>)}
        {menu.notices.map((line, i) => <Text key={`notice-${i}`}>{`! ${line}`}</Text>)}
        {message}<Select key="actions" label="Action" options={actions} autoFocus onSelect={chooseAction} />
      </Box>;
    }
    if (screen === "settings") {
      const settings = renderTraceSettings(reply.settings);
      return <Box flexDirection="column"><Text>{settings.header}</Text><Text> </Text>
        <Text>Knowledge budgets</Text>{settings.budgetLines.map((line, i) => <Text key={`budget-${i}`}>{line}</Text>)}
        <Text>{settings.derivedLine}</Text><Text> </Text><Text>{settings.workerHeader}</Text>
        {settings.workerLines.map((line, i) => <Text key={`worker-${i}`}>{line}</Text>)}
        <Text>{settings.closedSessionsLine}</Text>{message}
        <Select
        key="setting-rows"
        label="Edit"
        options={[...buildSettingsChoices(reply.settings).map((row2) => ({ value: row2.id, label: row2.label })), back]}
        autoFocus
        onSelect={(value) => {
          if (value === "back") screen = "main";
          else {
            selectedSetting = value;
            screen = "edit";
          }
          $.ui.invalidate("ui.render");
        }}
      />
      </Box>;
    }
    if (screen === "runs") return <Box flexDirection="column"><Text>Trace Memory · Runs</Text>
      {reply.runs.map((run2, i) => <Text key={`run-${i}`}>{`R${run2.id} ${run2.phase} ${run2.status} ${run2.cost === null ? "cost unknown" : `$${run2.cost.toFixed(2)}${run2.partial ? "+ (rest unknown)" : ""}`} ${run2.at}`}</Text>)}
      <Input key="run-count" label={MENU_INPUTS.runs} onSubmit={(value) => {
      try {
        runsLimit = parseRunsCount(value);
      } catch (error) {
        notice = String(error);
        $.ui.invalidate("ui.render");
        return;
      }
      void (async () => {
        try {
          const rows = JSON.parse(await run("runs", ["--json", String(runsLimit)]));
          reply.runs = rows.runs;
          notice = `Showing ${rows.runs.length} recent runs`;
        } catch (error) {
          notice = String(error);
        }
        $.ui.invalidate("ui.render");
      })();
    }} />{message}<Select key="runs-back" label="Action" options={[back]} onSelect={() => {
      screen = "main";
      $.ui.invalidate("ui.render");
    }} />
    </Box>;
    if (screen === "project") return <Box flexDirection="column"><Text>{MENU_INPUTS.project}</Text>
      <Input key="project-name" label="Project" autoFocus onSubmit={(name) => {
      if (!name.trim()) {
        screen = "main";
        $.ui.invalidate("ui.render");
        return;
      }
      screen = "main";
      void act("project", [name.trim()]);
    }} />{message}<Select key="project-back" label="Action" options={[back]} onSelect={() => {
      screen = "main";
      $.ui.invalidate("ui.render");
    }} />
    </Box>;
    if (screen === "confirm") {
      const confirmation = toggleConfirmation(selectedAction === "turn-on", !!reply.menu.notices.find((n) => n.includes("Shared identity")));
      return <Box flexDirection="column"><Text>{confirmation.title}</Text><Text>{confirmation.message}</Text>
        <Select
        key="confirm"
        label="Confirm"
        autoFocus
        options={[{ value: "yes", label: "Yes" }, { value: "no", label: "No" }]}
        onSelect={(value) => {
          screen = "main";
          if (value === "yes") void act(selectedAction === "turn-on" ? "on" : "off");
          else $.ui.invalidate("ui.render");
        }}
      />
      </Box>;
    }
    const row = selectedSetting;
    if (!row) throw new Error("Trace Memory: no setting selected");
    const label = buildSettingsChoices(reply.settings).find((choice) => choice.id === row)?.label ?? row;
    if (row === "noting.mode") return <Box flexDirection="column"><Text>{label}</Text>
      <Select
      key="noting-mode"
      label="Noter mode"
      autoFocus
      options={["subagent", "fork"].map((value) => ({ value, label: value }))}
      onSelect={(value) => {
        void (async () => {
          try {
            const result = JSON.parse(await run("setting", [row, value]));
            notice = `Setting ${result.saved ? "saved" : "not saved"}; ${result.applied ? "applied" : "not applied"}${result.diagnostic ? `: ${result.diagnostic}` : ""}`;
            if (result.saved && result.applied) await reload();
            else $.ui.invalidate("ui.render");
          } catch (error) {
            notice = String(error);
            $.ui.invalidate("ui.render");
          }
          screen = "settings";
          $.ui.invalidate("ui.render");
        })();
      }}
    />
      <Select key="mode-back" label="Action" options={[back]} onSelect={() => {
      screen = "settings";
      $.ui.invalidate("ui.render");
    }} />
    </Box>;
    if (row === "closedSessionScope") return <Box flexDirection="column"><Text>{label}</Text>
      <Select
      key="scope-choice"
      label="Closed sessions"
      autoFocus
      options={["off", "project", "global"].map((value) => ({ value, label: value }))}
      onSelect={(value) => {
        void (async () => {
          try {
            const output = await run("setting", [row, value]);
            const result = JSON.parse(output);
            notice = `Setting ${result.saved ? "saved" : "not saved"}; ${result.applied ? "applied" : "not applied"}${result.diagnostic ? `: ${result.diagnostic}` : ""}`;
            if (result.saved && result.applied) await reload();
            else $.ui.invalidate("ui.render");
          } catch (error) {
            notice = String(error);
            $.ui.invalidate("ui.render");
          }
          screen = "settings";
          $.ui.invalidate("ui.render");
        })();
      }}
    />
      <Select key="scope-back" label="Action" options={[back]} onSelect={() => {
      screen = "settings";
      $.ui.invalidate("ui.render");
    }} />
    </Box>;
    return <Box flexDirection="column"><Text>{label}</Text>
      <Input
      key={`edit-${row}`}
      label={row.endsWith(".model") ? "Model and optional capacity (model capacity)" : "New value"}
      autoFocus
      onSubmit={(value) => {
        const parts = row.endsWith(".model") ? value.trim().split(/\s+/) : [value.trim()];
        if (!parts[0]) {
          screen = "settings";
          $.ui.invalidate("ui.render");
          return;
        }
        void (async () => {
          try {
            const output = await run("setting", [row, ...parts]);
            const result = JSON.parse(output);
            notice = `Setting ${result.saved ? "saved" : "not saved"}; ${result.applied ? "applied" : "not applied"}${result.diagnostic ? `: ${result.diagnostic}` : ""}`;
            if (result.saved && result.applied) await reload();
            else $.ui.invalidate("ui.render");
          } catch (error) {
            notice = String(error);
            $.ui.invalidate("ui.render");
          }
          screen = "settings";
          $.ui.invalidate("ui.render");
        })();
      }}
    />{message}<Select key="edit-back" label="Action" options={[back]} onSelect={() => {
      screen = "settings";
      $.ui.invalidate("ui.render");
    }} />
    </Box>;
  });
};
