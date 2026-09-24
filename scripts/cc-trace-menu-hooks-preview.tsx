// Ticket 82: Claude Code preview of the redesigned `/trace` menu, for the maintainer's layout
// checkpoint. Real source, importing the real shared model and CC renderer (`../src/hosts/trace-menu.ts`,
// `../src/hosts/cc/trace-menu-render.ts`) — not wired to live data, the CLI `menu --json` verb, actions
// or settings writes (that comes after the maintainer confirms the layout). `build-cc-trace-menu-preview.mjs`
// bundles this file (imports resolved, JSX left untouched) into a self-contained module, because the
// CC engine's isolated hooks environment resolves no local imports (step 0: "no Node and no file system").
//
// Every JSX tag here is Box/Text/Select, resolved per render from `$.ui.resolve(e)` (step 0's proven
// pattern) — no locally defined component tags, since whether the engine's JSX runtime supports those
// is unverified.
//
// Maintainer correction (2026-09-24): the context section copies Claude Code's own built-in `/context`
// instead of drawing Pi's grid. `$.session.usage({ breakdown: "full", columns })` is the live source
// (step 0 check 5); it is fetched once per pane open (`command.run`, async) and cached for the
// synchronous `ui.render` hook to paint, verbatim, cell by cell — this module never computes a cell
// count or a colour. Cell and category `color` fields are semantic tokens Claude Code's own `<Text
// color>` resolves (verified live in the ticket 82 delegation report against a real `/context`
// capture and a `probecolor` probe pane: "promptBorder", "inactive", "warning",
// "purple_FOR_SUBAGENTS_ONLY" all matched the real command's ANSI codes; an unknown token falls back
// to the default text colour rather than throwing).
//
// The only change from the real command (ruling B): Knowledge/Facts/Raw/unclassified-memory amounts
// are spliced out of the SDK's "Messages" row. Since this preview has no live trace-memory database to
// read them from, it uses the same fixture figures `TRACE_MENU_FIXTURE.context` carries for them — the
// delegation report says so explicitly: those three (four) numbers are the only non-live figures on
// this screen; everything else (model, grid, category tokens, Pending/trigger, Spend) is either the
// live `$.session.usage` reading of the fenced sandbox session or the shared model's own fixture.
import {
  TRACE_MENU_FIXTURE, TRACE_MENU_FIXTURE_WITH_NOTICE, TRACE_SETTINGS_FIXTURE_CC,
} from "../src/hosts/trace-menu.ts";
import { renderTraceMenu, renderTraceSettings, type CcContextBreakdown, type CcMemorySplit, type RenderedMenu } from "../src/hosts/cc/trace-menu-render.ts";

const PINNED_VERSION = "2.1.280";
let traceScreen: "main" | "settings" = "main";
// Ruling B: the delegation report's fixture figures for the three (four) rows this preview has no
// live database to read (see module doc).
const MEMORY: CcMemorySplit = { knowledge: 17_300, facts: 9_900, raw: 10_000, unclassified: 200 };
// Cached once per pane focus, since `ui.render` cannot itself await `$.session.usage`.
let breakdown: CcContextBreakdown | undefined;
// The real terminal width isn't exposed to this preview (no confirmed `$` accessor for it, see the
// delegation report); `TRACE_MENU_PREVIEW_COLUMNS` (read via `$.env.get`, the same accessor probe1
// already used for its own override) lets each sample capture set the width it was actually taken
// at, so the grid the SDK returns and the side-by-side/stacked choice both match that capture.
let PANE_COLUMNS = 100;

export const register = (on: any) => {
  on("session.start", async ($: any, e: any, next: any) => {
    try {
      const override = await $.env.get("TRACE_MENU_PREVIEW_COLUMNS");
      if (override && Number.isFinite(Number(override))) PANE_COLUMNS = Number(override);
    } catch { /* keep the default */ }
    let versionOk = true;
    try {
      const r = await $.process.run(["/opt/homebrew/bin/claude", "--version"]);
      const seen = ((r && r.stdout) || "").trim().split(" ")[0] || "(unknown)";
      versionOk = seen === PINNED_VERSION;
      if (!versionOk) await $.ui.status(`trace-menu-preview: version mismatch, pinned ${PINNED_VERSION}, running ${seen} — /trace disabled`);
    } catch { versionOk = false; }
    const specs = versionOk ? [
      { name: "trace", description: "ticket 82 preview: redesigned /trace menu (main + settings)" },
      { name: "tracenotice", description: "ticket 82 preview: /trace menu with the automatic-off notice" },
    ] : [];
    for (const spec of specs) { try { await $.command.register(spec); } catch { /* ignore duplicate/refused names */ } }
    return next(e);
  });

  // `$` is only ever used inline as `$.noun.event(...)` at the call site (`claude plugin validate`'s
  // static check refuses passing it into a locally declared helper function), so the two handlers
  // below repeat this fetch-then-open sequence rather than sharing it through a function taking `$`.
  on("command.run", { command: "trace" }, async ($: any, e: any, next: any) => {
    traceScreen = "main";
    try {
      const usage = await $.session.usage({ breakdown: "full", columns: PANE_COLUMNS });
      const b = usage?.context?.breakdown;
      breakdown = b ? {
        model: b.model, totalTokens: b.totalTokens, maxTokens: b.maxTokens, percentage: b.percentage,
        gridRows: b.gridRows, categories: b.categories,
      } : undefined;
    } catch { breakdown = undefined; }
    const res = await $.ui.open({ id: "trace-main", title: "Trace Memory", focus: true, closeOnEscape: true, rows: 50, columns: PANE_COLUMNS });
    return { text: `trace-main pane open: ${JSON.stringify(res)}` };
  });
  on("command.run", { command: "tracenotice" }, async ($: any, e: any, next: any) => {
    try {
      const usage = await $.session.usage({ breakdown: "full", columns: PANE_COLUMNS });
      const b = usage?.context?.breakdown;
      breakdown = b ? {
        model: b.model, totalTokens: b.totalTokens, maxTokens: b.maxTokens, percentage: b.percentage,
        gridRows: b.gridRows, categories: b.categories,
      } : undefined;
    } catch { breakdown = undefined; }
    const res = await $.ui.open({ id: "trace-notice", title: "Trace Memory", focus: true, closeOnEscape: true, rows: 50, columns: PANE_COLUMNS });
    return { text: `trace-notice pane open: ${JSON.stringify(res)}` };
  });

  on("ui.render", { component: "Pane" }, ($: any, e: any, next: any) => {
    const { Box, Text, Select } = $.ui.resolve(e);
    const menuBody = (rendered: RenderedMenu) => (
      <Box flexDirection="column">
        <Text>{rendered.header}</Text>
        <Text> </Text>
        {rendered.context ? (
          <Box flexDirection={PANE_COLUMNS < 80 ? "column" : "row"}>
            <Box flexDirection="column">
              {rendered.context.gridRows.map((row, i) => (
                <Box flexDirection="row" key={`gridrow${i}`}>
                  {row.map((cell, j) => <Text key={`cell${i}-${j}`} color={cell.color}>{`${cell.glyph} `}</Text>)}
                </Box>
              ))}
            </Box>
            <Box flexDirection="column" marginLeft={PANE_COLUMNS < 80 ? 0 : 2}>
              {rendered.context.headerLines.map((line, i) => <Text key={`hdr${i}`}>{line}</Text>)}
              <Text> </Text>
              <Text>{rendered.context.legendHeading}</Text>
              {rendered.context.legend.map((row, i) => (
                <Text key={`cat${i}`}>
                  <Text color={row.color}>{row.glyph}</Text>{` ${row.label}: ${row.tokensLabel}${row.suffix} (${row.percent})`}
                </Text>
              ))}
              {rendered.context.memoryUnavailable ? <Text>{rendered.context.memoryUnavailable}</Text> : null}
            </Box>
          </Box>
        ) : <Text>{rendered.contextUnavailable}</Text>}
        <Text> </Text>
        <Text>{rendered.pendingHeading}</Text>
        {rendered.pendingLines.map((line, i) => <Text key={`pend${i}`}>{line}</Text>)}
        <Text> </Text>
        {rendered.spendLines.map((line, i) => <Text key={`spend${i}`}>{line}</Text>)}
        {rendered.notices.map((n, i) => (
          <Box flexDirection="column" key={`noticebox${i}`}>
            <Text> </Text>
            <Text>{`! ${n}`}</Text>
          </Box>
        ))}
      </Box>
    );

    if (e.requestId === "trace-notice") return menuBody(renderTraceMenu(TRACE_MENU_FIXTURE_WITH_NOTICE, { breakdown, memory: MEMORY }));

    if (e.requestId === "trace-main" && traceScreen === "main") {
      const rendered = renderTraceMenu(TRACE_MENU_FIXTURE, { breakdown, memory: MEMORY });
      return (
        <Box flexDirection="column">
          {menuBody(rendered)}
          <Text> </Text>
          <Select
            key="trace-actions"
            label="Action"
            options={rendered.actions}
            autoFocus
            onSelect={(value: string) => {
              if (value === "settings") { traceScreen = "settings"; $.ui.invalidate("ui.render"); return; }
              $.ui.toast(`trace: ${value} (preview only, not wired)`);
            }}
          />
        </Box>
      );
    }

    if (e.requestId === "trace-main" && traceScreen === "settings") {
      const s = renderTraceSettings(TRACE_SETTINGS_FIXTURE_CC);
      return (
        <Box flexDirection="column">
          <Text>{s.header}</Text>
          <Text> </Text>
          <Text>Knowledge budgets</Text>
          {s.budgetLines.map((line, i) => <Text key={`budget${i}`}>{`  ${line}`}</Text>)}
          <Text>{`  ${s.derivedLine}`}</Text>
          <Text> </Text>
          <Text>{s.workerHeader}</Text>
          {s.workerLines.map((line, i) => <Text key={`worker${i}`}>{`  ${line}`}</Text>)}
          <Text> </Text>
          <Text>{s.closedSessionsLine}</Text>
          <Text> </Text>
          <Select
            key="trace-settings-back"
            label="Action"
            options={[{ value: "back", label: "Back" }]}
            autoFocus
            onSelect={() => { traceScreen = "main"; $.ui.invalidate("ui.render"); }}
          />
        </Box>
      );
    }

    return next(e);
  });
};
