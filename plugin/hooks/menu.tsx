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
  const operations = value.unit === "operations";
  const trigger = operations ? String(value.trigger) : formatCompactTokens(value.trigger);
  const amount = operations ? `${value.atLeast ? "\u2265" : ""}${value.tokens} / ${trigger} Noter ops` : value.atLeast ? `\u2265${trigger} / ${trigger} (${(value.entries ?? 0).toLocaleString("en-US")} ${value.entries === 1 ? "entry" : "entries"})` : `${formatCompactTokens(value.tokens)} / ${trigger}`;
  return { label, tokens: value.tokens, trigger: value.trigger, ratio, percent: formatWholePercent(ratio), amount };
};
function buildPendingSection(input) {
  return {
    heading: "Pending / trigger",
    noting: pendingRow("Noting", input.noting),
    dreamingHeading: "Dreaming",
    dreaming: [pendingRow("pending", input.dreaming.pending)]
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
  return [toggle, "Catch up", "Dream", "Full check", "Stop", "Project\u2026", "Runs\u2026", "Settings\u2026"];
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
  return {
    rows: [{ label: "Knowledge base", value: formatTokens(input.base) }],
    derivedLine: `\u2192 knowledge base ${formatTokens(input.base)} + body pool ${formatTokens(input.temporaryTokens)} + pointer pool ${formatTokens(input.pointerTokens)} = ${formatTokens(input.base + input.temporaryTokens + input.pointerTokens)} max input`
  };
}
function buildSettingsWorkers(input) {
  return { rows: input.map((w) => ({ ...w })) };
}
function buildSettingsChoices(input) {
  const base = buildSettingsBudgets(input.budgets).rows[0];
  const budgets = [{ id: "knowledgeBase", label: `${base.label}: ${base.value}` }];
  const workers = input.workers.flatMap((w) => {
    const phase = { Noter: "noting", Dreamer: "dreaming" }[w.phase];
    return [
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
    dreaming: { pending: { tokens: 12, trigger: 30, unit: "operations" } }
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
  budgets: { base: 2e4, temporaryTokens: 1e4, pointerTokens: 1e4 },
  workers: [
    { phase: "Noter", model: "follow foreground", thinking: "inherit" },
    { phase: "Dreamer", model: "claude-sonnet-5", thinking: "medium" }
  ],
  closedSessionScope: "project"
};
var TRACE_SETTINGS_FIXTURE_CC = {
  ...TRACE_SETTINGS_FIXTURE,
  workers: [
    { phase: "Noter", model: "claude-sonnet-5", thinking: "medium" },
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
    budgetLines: model.budgets.rows.map((row) => `${row.label.padEnd(14)} ${row.value.padStart(6)}`),
    derivedLine: model.budgets.derivedLine,
    workerHeader: "Workers        model                thinking",
    workerLines: model.workers.rows.map((w) => `${w.phase.padEnd(14)} ${w.model.padEnd(20)} ${w.thinking}${w.source ? ` (${w.source})` : ""}`),
    closedSessionsLine: model.closedSessionsLine
  };
}

// src/core/model/address.ts
var MEMORY_ROOT = "trace://";
var MEMORY_READ_ONLY = `${MEMORY_ROOT} is read-only.`;
function memoryPath(value) {
  if (typeof value !== "string" || !value.startsWith(MEMORY_ROOT)) return null;
  return MEMORY_ROOT + value.slice(MEMORY_ROOT.length).split("/").filter(Boolean).join("/");
}

// src/core/prompts/tool-names.ts
var TOOL_ROLES = ["search", "note", "memory", "check"];
var canonicalToolNames = { search: "search", note: "note", memory: "memory", check: "check", read: "read", write: "write", edit: "edit", grep: "grep" };
var NAME_ROLES = [...TOOL_ROLES, "read", "write", "edit"];
function validateToolNames(names) {
  const roles = names?.grep === void 0 ? NAME_ROLES : [...NAME_ROLES, "grep"];
  if (!names || roles.some((role) => typeof names[role] !== "string" || !/^[a-zA-Z][\w-]*$/.test(names[role])))
    throw new Error("Missing or invalid exposed tool name for worker launch");
  if (new Set(roles.map((role) => names[role])).size !== roles.length)
    throw new Error("Worker exposed tool names must be distinct");
  return Object.freeze({ ...names });
}
function renderToolNames(text, names) {
  return text.replace(/\{\{tool\.(search|note|memory|check|read|write|edit|grep)\}\}/g, (_, role) => {
    const name = names[role];
    if (name === void 0) throw new Error(`Missing exposed tool name: ${role}`);
    return name;
  });
}

// src/core/render/retrieval-policy.ts
var RETRIEVAL_POLICY = `When to look up memory: only when the answer would change your next step. Do not open every listed address.
- Before asking the user something that may already be recorded.
- When the user refers to earlier work, or something seems familiar, that is not in view.
- When a knowledge item or fact title bears on a decision but is too compressed to act on: read its supporting facts, then the raw entries they cite.
- When you need exact wording, values, paths, commands, errors or commits behind a remembered claim, or the user asks why you believe it.
- Before stating what the user decided: follow the supports down to the user's own words.
Find topics and exact strings with {{tool.search}}; pass code to filter its hits.
Memory is a past record: open items may be stale, and current files, tool output and the user's latest message win when they conflict.`;
function retrievalPolicy(names) {
  return renderToolNames(RETRIEVAL_POLICY, validateToolNames(names));
}

// src/hosts/cc/tool-names.ts
var CC_WORKER_SERVER_NAME = "trace_memory";
var CC_PLUGIN_NAME = "trace-memory";
var CC_MCP_SERVER_NAME = "traceMemory";
var exposed = (prefix) => ({ ...Object.fromEntries(
  TOOL_ROLES.map((role) => [role, `${prefix}${canonicalToolNames[role]}`])
), read: "Read", write: "Write", edit: "Edit" });
var ccWorkerToolNames = exposed(`mcp__${CC_WORKER_SERVER_NAME}__`);
var ccPluginToolNames = exposed(`mcp__plugin_${CC_PLUGIN_NAME}_${CC_MCP_SERVER_NAME}__`);

// src/hosts/cc/session-enabled.ts
function sessionEnabled(binding, store) {
  return binding.coreSessionId === null ? binding.enrollment.choice ?? binding.enrollment.defaultEnabled : store.enabled(binding.coreSessionId);
}

// src/hosts/cc/write-gate.ts
var DEFAULT_WRITE_RESPONSE_TIMEOUT_MS = 8e3;
function writeResponseTimeout(value = DEFAULT_WRITE_RESPONSE_TIMEOUT_MS) {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 1 || value > 9e3)
    throw new Error("Invalid CC writeResponseTimeoutMs: expected an integer from 1 to 9000");
  return value;
}
var isCcForegroundWrite = (tool) => /^mcp__(?:traceMemory|plugin_trace-memory_traceMemory)__(note|memory)$/.test(tool);
var WriteResponseStep = class {
  calls = /* @__PURE__ */ new Set();
  completion = Promise.withResolvers();
  ready = this.completion.promise;
  result;
  abort = () => this.finish(false);
  session;
  turn;
  signal;
  constructor(session, turn, signal) {
    this.session = session;
    this.turn = turn;
    this.signal = signal;
    signal?.addEventListener("abort", this.abort, { once: true });
    if (signal?.aborted) this.finish(false);
  }
  finish(complete) {
    if (this.result !== void 0) return;
    this.result = complete;
    this.signal?.removeEventListener("abort", this.abort);
    this.completion.resolve(complete);
  }
};
var CcWriteGate = class {
  steps = /* @__PURE__ */ new Set();
  begin(session, turn, signal) {
    const step = new WriteResponseStep(session, turn, signal);
    this.steps.add(step);
    return step;
  }
  find(session, call) {
    for (const step of this.steps) if (step.session === session && step.calls.has(call)) return step;
    return void 0;
  }
  cancel(session, turn) {
    for (const step of this.steps) if ((session === void 0 || step.session === session) && (turn === void 0 || step.turn === turn)) {
      step.finish(false);
      this.steps.delete(step);
    }
  }
};
async function waitForWriteResponse(step, signal, sleep) {
  if (signal?.aborted) return false;
  if (step.result !== void 0) return step.result;
  const timer = new AbortController();
  const cancelled = Promise.withResolvers();
  const abort = () => cancelled.resolve(false);
  signal?.addEventListener("abort", abort, { once: true });
  try {
    return await Promise.race([step.ready, cancelled.promise, sleep(timer.signal).then(() => true)]);
  } finally {
    signal?.removeEventListener("abort", abort);
    timer.abort();
  }
}

// plugin/hooks/index.tsx
var writeGate = new CcWriteGate();
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
async function memoryOn($) {
  try {
    const { stateDir } = JSON.parse(await $.fs.read(`${$.plugin.root}/cc.config.json`));
    const session = await $.session.id();
    const binding = JSON.parse(await $.fs.read(`${stateDir}/bindings/${session}.json`));
    const status = binding.coreSessionId === null ? null : JSON.parse(await $.fs.read(`${stateDir}/status/${session}.json`));
    return sessionEnabled(binding, { enabled: () => status?.enabled === true });
  } catch {
    return false;
  }
}
var failure = (error) => ({ deny: error instanceof Error ? error.message : String(error) });
export const register = (on) => {
  on("tool.call", { tool: "Read" }, async ($, e, next) => {
    const path = memoryPath(e.file_path);
    if (path === null || !/^trace:\/\/(?:(?:knowledge|compact)\/S[1-9]\d*(?:\/T[1-9]\d*)?|raw\/S[1-9]\d*\/T[1-9]\d*#E[1-9]\d*(?:@(user|assistant|observation))?)$/.test(path)) return next(e);
    try {
      const file = await memoryFiles($, ["read", path]);
      if (!file.unbounded) throw new Error(`not a whole memory view: ${path}`);
      const lines = file.content.split("\n");
      return { result: { type: "text", file: {
        filePath: e.file_path,
        content: file.content,
        numLines: lines.length,
        startLine: 1,
        totalLines: lines.length
      } } };
    } catch (error) {
      return failure(error);
    }
  });
  on("tool.call", { tool: "Edit" }, ($, e, next) => memoryPath(e.file_path) === null ? next(e) : { deny: MEMORY_READ_ONLY });
  on("tool.call", { tool: "Write" }, ($, e, next) => memoryPath(e.file_path) === null ? next(e) : { deny: MEMORY_READ_ONLY });
  on("tool.call", { tool: "NotebookEdit" }, ($, e, next) => memoryPath(e.notebook_path) === null ? next(e) : { deny: MEMORY_READ_ONLY });
  on("prompt.compose", async ($, e, next) => {
    const composed = await next(e);
    try {
      if (unavailable || !await memoryOn($)) return composed;
      return { ...composed, sections: [
        ...composed.sections,
        { id: "trace-memory-retrieval", text: retrievalPolicy(ccPluginToolNames), scope: "session" }
      ] };
    } catch {
      return composed;
    }
  });
  on("session.compact", async ($, e, next) => {
    if (e.trigger === "precompute" || e.trigger === "plugin" || e.agentId) return next(e);
    let session;
    try {
      session = await $.session.id();
    } catch (error) {
      console.error(`Trace Memory compact identity: ${String(error)}`);
      return next(e);
    }
    if (typeof e.instructions === "string" && e.instructions.trim()) return nativeCompaction($, e, next, session);
    try {
      const agents = await $.agent.list();
      const runningTasks = [];
      if (Array.isArray(agents)) for (const agent of agents) {
        if (agent === null || typeof agent !== "object" || Array.isArray(agent)) continue;
        const record = agent;
        if (typeof record.id !== "string" || !record.id || typeof record.type !== "string" || typeof record.description !== "string" || record.status !== "running" && record.status !== "waiting") continue;
        runningTasks.push({ id: record.id, kind: record.type, description: record.description, status: record.status });
      }
      const built = JSON.parse(decode(await $.process.run(
        ["node", `${$.plugin.root}/dist/cc.cjs`, "hook-compact", "--config", `${$.plugin.root}/cc.config.json`],
        // The newest message's handle is its transcript row's uuid: the trigger the build waits for.
        // `auto` (requirement 14, ruled) tells the build whether to end the block with Claude Code's
        // own native continue sentence, after its framing; a manual `/compact` gets none.
        { stdin: JSON.stringify({ session_id: session, trigger: e.messages.at(-1)?.handle, auto: e.trigger === "auto", runningTasks }) }
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
    writeGate.cancel();
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
    const response = writeGate.begin(session, e.turnId, next.signal);
    const stream = next(e);
    let complete = false;
    let stopReason;
    try {
      for (; ; ) {
        const item = await stream.next();
        if (item.done) {
          complete = typeof stopReason === "string" && stopReason.length > 0 && item.value?.stopReason === stopReason;
          return item.value;
        }
        if (item.value.kind === "stop") stopReason = item.value.stopReason;
        if (item.value.kind === "tool" && isCcForegroundWrite(item.value.name)) response.calls.add(item.value.id);
        yield item.value;
      }
    } finally {
      response.finish(complete && !next.signal?.aborted);
      await stream.return?.();
    }
  });
  on("tool.call", async ($, e, next) => {
    if (!isCcForegroundWrite(e.tool) || unavailable) return next(e);
    if (e.agentId) return { deny: "Trace Memory: note and memory are not available to subagents" };
    const session = await $.session.id();
    const response = writeGate.find(session, e.tool_use_id);
    if (response) {
      const config = JSON.parse(await $.fs.read(`${$.plugin.root}/cc.config.json`));
      const timeout = writeResponseTimeout(config && typeof config === "object" && "writeResponseTimeoutMs" in config ? config.writeResponseTimeoutMs : void 0);
      const complete = await waitForWriteResponse(response, next.signal, (signal) => $.clock.sleep(timeout, { signal }));
      if (!complete) return { deny: "Trace Memory: foreground write cancelled before its response finished" };
    }
    if (next.signal?.aborted || session !== await $.session.id())
      return { deny: "Trace Memory: foreground write cancelled or native session changed" };
    return next(e);
  });
  on("turn.complete", async ($, e, next) => {
    if (!e.agentId && !unavailable) {
      writeGate.cancel(await $.session.id(), e.turnId);
      try {
        const session = await $.session.id();
        const result = await $.process.run(
          ["node", `${$.plugin.root}/dist/cc.cjs`, "hook-turn", "--config", `${$.plugin.root}/cc.config.json`],
          { stdin: JSON.stringify({ session_id: session, turnId: e.turnId, reason: e.reason }) }
        );
        decode(result, "Trace Memory turn-end check");
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
      else if (value === "dream") void act("dream");
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
        <Text>Knowledge base</Text>{settings.budgetLines.map((line, i) => <Text key={`budget-${i}`}>{line}</Text>)}
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
    const saveSetting = async (parts) => {
      try {
        const result = JSON.parse(await run("setting", [row, ...parts]));
        notice = `Setting ${result.saved ? "saved" : "not saved"}; ${result.applied ? "applied" : "not applied"}${result.diagnostic ? `: ${result.diagnostic}` : ""}`;
        if (result.saved && result.applied) await reload();
        else $.ui.invalidate("ui.render");
      } catch (error) {
        notice = String(error);
        $.ui.invalidate("ui.render");
      }
      screen = "settings";
      $.ui.invalidate("ui.render");
    };
    if (row === "closedSessionScope") return <Box flexDirection="column"><Text>{label}</Text>
      <Select
      key="scope-choice"
      label="Closed sessions"
      autoFocus
      options={["off", "project", "global"].map((value) => ({ value, label: value }))}
      onSelect={(value) => {
        void saveSetting([value]);
      }}
    />
      <Select key="scope-back" label="Action" options={[back]} onSelect={() => {
      screen = "settings";
      $.ui.invalidate("ui.render");
    }} />
    </Box>;
    if (row.endsWith(".model") && screen !== "model-other") return <Box flexDirection="column"><Text>{label}</Text>
      <Select
      key="model-choice"
      label="Model"
      autoFocus
      options={[...reply.models.map((value) => ({ value, label: value })), { value: "", label: "Other\u2026" }]}
      onSelect={(value) => {
        if (value) void saveSetting([value]);
        else {
          screen = "model-other";
          $.ui.invalidate("ui.render");
        }
      }}
    />{message}
      <Select key="model-back" label="Action" options={[back]} onSelect={() => {
      screen = "settings";
      $.ui.invalidate("ui.render");
    }} />
    </Box>;
    return <Box flexDirection="column"><Text>{label}</Text>
      <Input
      key={`edit-${row}`}
      label={row.endsWith(".model") ? "<model id> <context window>, e.g. claude-opus-5-5 1000000" : "New value"}
      autoFocus
      onSubmit={(value) => {
        const parts = row.endsWith(".model") ? value.trim().split(/\s+/) : [value.trim()];
        if (!parts[0]) {
          screen = "settings";
          $.ui.invalidate("ui.render");
          return;
        }
        void saveSetting(parts);
      }}
    />{message}<Select key="edit-back" label="Action" options={[back]} onSelect={() => {
      screen = "settings";
      $.ui.invalidate("ui.render");
    }} />
    </Box>;
  });
};
