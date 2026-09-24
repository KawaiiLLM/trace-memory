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
  if (value.tokens === null || value.trigger === null) return { label, tokens: null, trigger: null, ratio: null, percent: "?" };
  const ratio = value.trigger === 0 ? value.tokens === 0 ? 0 : 1 : Math.min(1, value.tokens / value.trigger);
  return { label, tokens: value.tokens, trigger: value.trigger, ratio, percent: formatWholePercent(ratio) };
};
function buildPendingSection(input) {
  return {
    heading: "Pending / trigger",
    noting: pendingRow("Noting", input.noting),
    consolidation: pendingRow("Consolidation", input.consolidation),
    dreamingHeading: "Dreaming",
    dreaming: {
      global: pendingRow("global", input.dreaming.global),
      project: pendingRow("project", input.dreaming.project),
      session: pendingRow("session", input.dreaming.session)
    }
  };
}
function buildSpendSection(input) {
  const phase = (label, p) => `${label} ${p.runs} ${p.runs === 1 ? "run" : "runs"} ${formatMoney(p.cost)}`;
  return {
    sessionLine: `Spend   session ${formatMoney(input.session)}`,
    phaseLine: `${phase("Noting", input.noting)} \xB7 ${phase("Consolidation", input.consolidation)} \xB7 ${phase("Dreaming", input.dreaming)}`,
    todayLine: `        today   ${formatMoney(input.today)}`
  };
}
function buildHeader(input) {
  const state = input.enabled ? "On" : "Off";
  const suffix = input.explicit ? ` (explicit)` : "";
  return `Trace Memory \xB7 ${input.session} \xB7 ${input.project} \xB7 ${state}${suffix}`;
}
function buildActions(input) {
  const toggle = input.enabled ? "Turn off" : "Turn on";
  return [toggle, "Catch up", "Stop", "Project\u2026", "Runs\u2026", "Settings\u2026", ...input.retryForkAvailable ? ["Retry fork"] : []];
}
var toggleConfirmation = (turnOn, shared) => ({
  title: `Turn Trace Memory ${turnOn ? "on" : "off"} for this session?`,
  message: (shared ? " Shared identity: this switch also affects forks or clones carrying this memory identity." : " Forks or clones carrying this memory identity share this switch.") + (turnOn ? " Available history, including the paused interval, will be queued without a model call." : " Processing and future injection stop; stored memory and already-injected text remain.")
});
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
  const budgets = ["global", "project", "session"].map((scope, i) => ({
    id: `budget.${scope}`,
    label: `${buildSettingsBudgets(input.budgets).rows[i].label} Knowledge budget: ${buildSettingsBudgets(input.budgets).rows[i].value}`
  }));
  const workers = input.workers.flatMap((w) => {
    const phase = w.phase.toLowerCase() === "noter" ? "noting" : w.phase.toLowerCase() === "consolidator" ? "consolidation" : "dreaming";
    return [
      ...w.mode !== void 0 ? [{ id: `${phase}.mode`, label: `${w.phase} mode: ${w.mode}`, source: w.sources?.mode }] : [],
      { id: `${phase}.model`, label: `${w.phase} model: ${w.model}`, source: w.sources?.model ?? w.source },
      { id: `${phase}.thinking`, label: `${w.phase} thinking: ${w.thinking}`, source: w.sources?.thinking }
    ].map((row) => ({ id: row.id, label: `${row.label}${row.source ? ` (${row.source})` : ""}` }));
  });
  return [...budgets, ...workers, { id: "closedSessionScope", label: `Closed sessions: ${input.closedSessionScope}` }];
}
var SCOPE_CHOICES = ["off", "project", "global"];
function buildTraceSettings(input) {
  return {
    header: `Trace Memory \xB7 Settings                 database ${input.database}`,
    budgets: buildSettingsBudgets(input.budgets),
    workers: buildSettingsWorkers(input.workers),
    closedSessionsLine: `Closed sessions   ${input.closedSessionScope}   (${SCOPE_CHOICES.join(" \xB7 ")})`
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
    consolidation: { tokens: 400, trigger: 5e3 },
    dreaming: {
      global: { tokens: 0, trigger: 4e3 },
      project: { tokens: 1500, trigger: 5e3 },
      session: { tokens: 319, trigger: 1e3 }
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
  actions: { enabled: true, retryForkAvailable: false }
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
    { phase: "Consolidator", mode: "subagent", model: "claude-sonnet-5", thinking: "medium" },
    { phase: "Dreamer", model: "claude-sonnet-5", thinking: "medium" }
  ],
  closedSessionScope: "project"
};
var TRACE_SETTINGS_FIXTURE_CC = {
  ...TRACE_SETTINGS_FIXTURE,
  workers: [
    { phase: "Noter", model: "claude-sonnet-5", thinking: "medium" },
    { phase: "Consolidator", model: "claude-sonnet-5", thinking: "medium" },
    { phase: "Dreamer", model: "claude-sonnet-5", thinking: "medium" }
  ]
};

// src/hosts/cc/trace-menu-render.ts
var MEMORY_COLOR = MEMORY_COLOR_HEX;
var memorySplitSum = (m) => m.knowledge + m.facts + m.raw + m.unclassified;
function scaleMemoryToMessages(memory, messagesTokens, contextTokens) {
  if (memorySplitSum(memory) === 0) return memory;
  if (messagesTokens === void 0 || !contextTokens) return void 0;
  const factor = messagesTokens / contextTokens;
  const scale = (n) => Math.round(n * factor);
  return { knowledge: scale(memory.knowledge), facts: scale(memory.facts), raw: scale(memory.raw), unclassified: scale(memory.unclassified) };
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
function computeCcGrid(categories, window, terminalWidth, minRows = 0) {
  const narrow = terminalWidth !== void 0 && terminalWidth < 80;
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
  const totalLine = `${ccCompact(breakdown2.totalTokens)}/${ccCompact(breakdown2.maxTokens)} tokens (${breakdown2.percentage}%)`;
  const headerLines = breakdown2.displayName ? [breakdown2.displayName, breakdown2.model, totalLine] : [breakdown2.model, totalLine];
  const legendHeading = "Estimated usage by category";
  const memoryUnavailable = effectiveMemory ? void 0 : inconsistent || messagesCategory ? "Knowledge, Facts, Raw: unavailable" : void 0;
  const legendLineCount = headerLines.length + 1 + 1 + legend.length + (memoryUnavailable ? 1 : 0);
  const gridRows = computeCcGrid(displayCategories, breakdown2.maxTokens, breakdown2.terminalWidth, legendLineCount);
  return { headerLines, gridRows, legendHeading, legend, memoryUnavailable };
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
var pendingLine = (label, row, indent = "  ") => row.tokens === null ? `${indent}${label}: Unknown / ${row.trigger ?? "Unknown"}` : `${indent}${label.padEnd(13)} ${bar(row.ratio ?? 0)} ${row.percent.padStart(4)}   ${formatCompactTokens(row.tokens)} / ${formatCompactTokens(row.trigger)}`;
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
      pendingLine("Consolidation", model.pending.consolidation),
      "  Dreaming",
      pendingLine("global", model.pending.dreaming.global, "    "),
      pendingLine("project", model.pending.dreaming.project, "    "),
      pendingLine("session", model.pending.dreaming.session, "    ")
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

// plugin/hooks/index.tsx
var PINNED_VERSION = "2.1.280";
var screen = "main";
var reply;
var breakdown;
var notice = "";
var versionError = "";
var pluginRoot = "";
var selectedAction = "";
var selectedSetting;
var paneWidth = 70;
var runsLimit = 20;
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
export const register = (on) => {
  on("session.start", async ($, e, next) => {
    try {
      pluginRoot = await $.env.get("CLAUDE_PLUGIN_ROOT");
      if (!pluginRoot) throw new Error("CLAUDE_PLUGIN_ROOT is unavailable");
      const output = await $.process.run(["claude", "--version"]);
      const seen = decode(output, "Claude Code version").split(/\s+/)[0];
      if (seen !== PINNED_VERSION) throw new Error(`version mismatch, pinned ${PINNED_VERSION}, running ${seen}`);
    } catch (error) {
      versionError = `Trace Memory: ${String(error)} \u2014 /trace disabled`;
      await $.ui.status(versionError);
    }
    if (!versionError) {
      try {
        await $.command.register({ name: "trace", description: "Open the local Trace Memory menu" });
      } catch (error) {
        await $.ui.status(`Trace Memory: /trace registration failed: ${String(error)}`);
      }
    }
    return next(e);
  });
  on("command.run", { command: "trace" }, async ($, e, next) => {
    if (versionError) return { text: versionError };
    try {
      screen = "main";
      notice = "";
      const session = await $.session.id();
      const result = await $.process.run(["node", `${pluginRoot}/dist/cc.cjs`, "cli", "--config", `${pluginRoot}/cc.config.json`, "--session", session, "menu", "--json"]);
      reply = JSON.parse(decode(result, "Trace Memory menu"));
      try {
        const usage = await $.session.usage({ breakdown: "full", columns: paneWidth });
        const b = usage?.context?.breakdown;
        breakdown = b ? {
          model: b.model,
          totalTokens: b.totalTokens,
          maxTokens: b.maxTokens,
          percentage: b.percentage,
          categories: b.categories,
          displayName: b.displayName,
          terminalWidth: paneWidth
        } : void 0;
      } catch {
        breakdown = void 0;
      }
      const text = renderTraceMenuText(renderCurrent());
      await $.ui.open({ id, title: "Trace Memory", focus: true, closeOnEscape: true, rows: 45 });
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
      const session = await $.session.id();
      const result = await $.process.run(["node", `${pluginRoot}/dist/cc.cjs`, "cli", "--config", `${pluginRoot}/cc.config.json`, "--session", session, "menu", "--json"]);
      reply = JSON.parse(decode(result, "Trace Memory menu"));
      $.ui.invalidate("ui.render");
    };
    const run = async (verb, args = []) => {
      const session = await $.session.id();
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
            const rows = JSON.parse(await run("runs", ["--json"]));
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
      const narrow = paneWidth < 80;
      return <Box flexDirection="column">
        <Text>{menu.header}</Text><Text> </Text>
        {ctx ? <Box flexDirection={narrow ? "column" : "row"}>
          <Box flexDirection="column">{ctx.gridRows.map((row2, i) => <Box flexDirection="row" key={`grid-${i}`}>{row2.map((cell, j) => <Text key={`cell-${i}-${j}`} color={cell.color}>{`${cell.glyph} `}</Text>)}</Box>)}</Box>
          <Box flexDirection="column" marginLeft={narrow ? 0 : 2}>
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
      {reply.runs.slice(0, runsLimit).map((run2, i) => <Text key={`run-${i}`}>{`R${run2.id} ${run2.phase} ${run2.status} $${run2.cost.toFixed(2)} ${run2.at}`}</Text>)}
      <Input key="run-count" label={MENU_INPUTS.runs} onSubmit={(value) => {
      if (!/^[1-9]\d*$/.test(value)) {
        notice = "Run count must be a positive integer";
        $.ui.invalidate("ui.render");
        return;
      }
      runsLimit = Math.min(Number(value), 20);
      notice = `Showing ${Math.min(runsLimit, reply.runs.length)} recent runs`;
      $.ui.invalidate("ui.render");
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
