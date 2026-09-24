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
import {
  TRACE_MENU_FIXTURE, TRACE_MENU_FIXTURE_WITH_NOTICE, TRACE_SETTINGS_FIXTURE_CC,
} from "../src/hosts/trace-menu.ts";
import { renderTraceMenu, renderTraceSettings, type RenderedMenu } from "../src/hosts/cc/trace-menu-render.ts";

const PINNED_VERSION = "2.1.280";
let traceScreen: "main" | "settings" = "main";

export const register = (on: any) => {
  on("session.start", async ($: any, e: any, next: any) => {
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

  on("command.run", { command: "trace" }, async ($: any, e: any, next: any) => {
    traceScreen = "main";
    const res = await $.ui.open({ id: "trace-main", title: "Trace Memory", focus: true, closeOnEscape: true, rows: 50 });
    return { text: `trace pane open: ${JSON.stringify(res)}` };
  });
  on("command.run", { command: "tracenotice" }, async ($: any, e: any, next: any) => {
    const res = await $.ui.open({ id: "trace-notice", title: "Trace Memory", focus: true, closeOnEscape: true, rows: 50 });
    return { text: `trace notice pane open: ${JSON.stringify(res)}` };
  });

  on("ui.render", { component: "Pane" }, ($: any, e: any, next: any) => {
    const { Box, Text, Select } = $.ui.resolve(e);
    const menuBody = (rendered: RenderedMenu) => (
      <Box flexDirection="column">
        <Text>{rendered.header}</Text>
        <Text> </Text>
        <Box flexDirection="row">
          <Box flexDirection="column">
            {rendered.grid.map((row, i) => (
              <Box flexDirection="row" key={`gridrow${i}`}>
                {row.map((cell, j) => <Text key={`cell${i}-${j}`}>{cell.filled ? "⛁ " : "⛶ "}</Text>)}
              </Box>
            ))}
          </Box>
          <Box flexDirection="column" marginLeft={2}>
            <Text>{rendered.model}</Text>
            <Text>{rendered.sdkLine}</Text>
            <Text> </Text>
            <Text>{rendered.localHeading}</Text>
            {rendered.categoryLines.map((line, i) => <Text key={`cat${i}`}>{line}</Text>)}
            {rendered.freeLine ? <Text>{rendered.freeLine}</Text> : null}
          </Box>
        </Box>
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

    if (e.requestId === "trace-notice") return menuBody(renderTraceMenu(TRACE_MENU_FIXTURE_WITH_NOTICE));

    if (e.requestId === "trace-main" && traceScreen === "main") {
      const rendered = renderTraceMenu(TRACE_MENU_FIXTURE);
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
