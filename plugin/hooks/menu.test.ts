// Native function-hooks acceptance fixture. Run only under the pinned, network-fenced
// `claude plugin test` in an isolated CLAUDE_CONFIG_DIR; never from the ordinary suite.
import { test, expect, mock } from "claude-code/testing";

const menu = {
  menu: {
    header: { session: "S1", project: "example", enabled: true },
    context: { model: "Claude Code" },
    pending: { noting: { tokens: 0, trigger: 10000 }, consolidation: { tokens: 0, trigger: 5000 },
      dreaming: { global: { tokens: 0, trigger: 4000 }, project: { tokens: 0, trigger: 5000 }, session: { tokens: 0, trigger: 1000 } } },
    spend: { session: 0, noting: { runs: 0, cost: 0 }, consolidation: { runs: 0, cost: 0 }, dreaming: { runs: 0, cost: 0 }, today: 0 },
    notices: [], actions: { enabled: true, retryForkAvailable: false },
  },
  settings: { database: "/tmp/test-trace.db", budgets: { global: 4000, project: 15000, session: 1000, sharedAllowanceTokens: 10000 },
    workers: [{ phase: "Noter", model: "sonnet", thinking: "high" }, { phase: "Consolidator", model: "opus", thinking: "high" }, { phase: "Dreamer", model: "opus", thinking: "high" }],
    closedSessionScope: "project" },
  context: { presence: "unavailable" }, runs: [{ id: 1, phase: "noting", status: "completed", cost: 0.1, at: "2026-01-01" }],
};
const pane = { title: "Trace Memory", isFocused: true, bodyColumns: 65, placement: "inline", scroll: { offset: 0, bodyRows: 45 }, view: {} } as const;

function mockHost(on: any, seen: string[], version = "2.1.280") {
  mock.env(on, { CLAUDE_PLUGIN_ROOT: "/tmp/fake-plugin" });
  on("process.run", ($: any, e: any) => {
    seen.push(e.argv.join(" "));
    const argv = e.argv as string[];
    if (argv.includes("--version")) return { exitCode: 0, stdout: `${version} (Claude Code)\n`, stderr: "" };
    if (argv.includes("menu")) return { exitCode: 0, stdout: JSON.stringify(menu), stderr: "" };
    if (argv.includes("runs")) return { exitCode: 0, stdout: JSON.stringify({ runs: menu.runs }), stderr: "" };
    if (argv.includes("setting")) return { exitCode: 0, stdout: JSON.stringify({ saved: true, applied: false, diagnostic: "executor unavailable" }), stderr: "" };
    return { exitCode: 0, stdout: JSON.stringify({ command: argv.at(-1) }), stderr: "" };
  });
  on("session.usage", () => ({ context: { breakdown: undefined } }));
}

test("local command renders headless text and a mountable narrow pane, then dispatches live actions", async ($, on) => {
  const seen: string[] = [];
  mockHost(on, seen);
  await $.session.start({ cwd: "/tmp", surface: "terminal", isInteractive: true });
  const result = await $.command.run({ command: "trace" });
  expect(result.text).toContain("Trace Memory · S1");
  const ui = await $.ui.mount({ plugin: "trace-memory", surface: "terminal", component: "Pane", requestId: "trace-memory-menu", props: pane });
  expect(await ui.find({ type: "Text", text: "Pending / trigger" })).toBeDefined();
  await ui.select({ key: "actions", value: "settings" });
  expect(await ui.find({ type: "Text", text: "Knowledge budgets" })).toBeDefined();
  await ui.select({ key: "setting-rows", value: "budget.global" });
  await ui.input({ key: "edit-budget.global", text: "5000" });
  expect(await ui.find({ type: "Text", text: "saved; not applied" })).toBeDefined();
  expect(seen.some(args => args.includes("setting budget.global 5000"))).toBe(true);
  await ui.select({ key: "setting-rows", value: "back" });
  await ui.select({ key: "actions", value: "project" });
  await ui.input({ key: "project-name", text: "new-project" });
  expect(seen.some(args => args.includes("project new-project"))).toBe(true);
  await ui.select({ key: "actions", value: "runs" });
  expect(await ui.find({ type: "Text", text: "R1 noting completed" })).toBeDefined();
  await ui.select({ key: "runs-back", value: "back" });
  await ui.select({ key: "actions", value: "catch-up" });
  await ui.select({ key: "actions", value: "stop" });
  expect(seen.some(args => args.endsWith(" catchup"))).toBe(true);
  expect(seen.some(args => args.endsWith(" stop"))).toBe(true);
  await ui.select({ key: "actions", value: "turn-off" });
  expect(await ui.find({ type: "Text", text: "Turn Trace Memory off" })).toBeDefined();
  await ui.select({ key: "confirm", value: "no" });
  expect(seen.some(args => args.endsWith(" off"))).toBe(false);
  await ui.select({ key: "actions", value: "turn-off" });
  await ui.select({ key: "confirm", value: "yes" });
  expect(seen.some(args => args.endsWith(" off"))).toBe(true);
  await ui.unmount();
});

test("a later command resolves the new native identity after clear", async ($, on) => {
  const seen: string[] = [];
  mockHost(on, seen);
  let currentId = "before-clear";
  on("session.id", () => currentId);
  await $.session.start({ cwd: "/tmp", surface: null, isInteractive: false });
  await $.command.run({ command: "trace" });
  currentId = "after-clear";
  await $.command.run({ command: "trace" });
  expect(seen.filter(args => args.includes(" menu --json")).some(args => args.includes("--session before-clear"))).toBe(true);
  expect(seen.filter(args => args.includes(" menu --json")).some(args => args.includes("--session after-clear"))).toBe(true);
});

test("version mismatch visibly disables the local command", async ($, on) => {
  mockHost(on, [], "2.1.277");
  await $.session.start({ cwd: "/tmp", surface: "terminal", isInteractive: true });
  const result = await $.command.run({ command: "trace" });
  expect(result.text).not.toContain("Trace Memory · S1");
});
