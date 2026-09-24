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

function mockHost(on: any, seen: string[], version = "2.1.280", sessionId = () => "initial-id") {
  mock.env(on, { CLAUDE_PLUGIN_ROOT: "/tmp/fake-plugin" });
  on("process.run", ($: any, e: any) => {
    seen.push(e.argv.join(" "));
    const argv = e.argv as string[];
    if (argv.includes("--version")) return { value: { exitCode: 0, stdout: `${version} (Claude Code)\n`, stderr: "" } };
    if (argv.includes("menu")) {
      expect(argv).toContain("--snapshot");
      expect(JSON.parse(e.stdin).session).toBe(sessionId());
      return { value: { exitCode: 0, stdout: JSON.stringify(menu), stderr: "" } };
    }
    if (argv.includes("runs")) {
      const count = Number(argv.at(-1));
      return { value: { exitCode: 0, stdout: JSON.stringify({ runs: Array.from({ length: count }, (_, i) => ({ ...menu.runs[0], id: i + 1 })) }), stderr: "" } };
    }
    if (argv.includes("setting")) return { value: { exitCode: 0, stdout: JSON.stringify({ saved: true, applied: false, diagnostic: "executor unavailable" }), stderr: "" } };
    return { value: { exitCode: 0, stdout: JSON.stringify({ command: argv.at(-1) }), stderr: "" } };
  });
  on("session.start", ($: any, e: any) => ({ cwd: e.cwd }));
  on("command.register", ($: any, e: any) => ({ value: { command: e.name } }));
  on("command.run", () => ({ text: "command unavailable" }));
  on("session.messages", () => ({ value: [{ role: "user", content: [{ type: "text", text: "hi" }] }] }));
  on("session.usage", ($: any, e: any) => {
    expect(e.breakdown).toBe("summary");
    return { value: { startedAt: 0, context: { window: 10000 }, rateLimits: [] } };
  });
  on("ui.status", () => ({ value: undefined }));
  on("ui.open", () => ({ value: { isPlaced: true } }));
  on("session.id", () => ({ value: sessionId() }));
}

test("local command renders headless text and a mountable narrow pane, then dispatches live actions", async ($, on) => {
  const seen: string[] = [];
  mockHost(on, seen);
  await $.session.start({ cwd: "/tmp", surface: "terminal", isInteractive: true });
  const result = await $.command.run({ command: "trace" });
  expect(result.text).toContain("Trace Memory · S1");
  const ui = await $.ui.mount({ plugin: "trace-memory", surface: "terminal", component: "Pane", requestId: "trace-memory-menu", props: pane });
  expect(await ui.find({ type: "Text", text: "Pending / trigger" }), `main mount: ${JSON.stringify(await ui.drawn())}`).toBeDefined();
  await ui.select({ key: "actions", value: "settings" });
  expect(await ui.find({ type: "Text", text: "Knowledge budgets" }), `settings mount: ${JSON.stringify(await ui.drawn())}`).toBeDefined();
  await ui.select({ key: "setting-rows", value: "budget.global" });
  await ui.input({ key: "edit-budget.global", text: "5000" });
  expect(await ui.find({ type: "Text", text: "saved; not applied" }), `saved-not-applied mount: ${JSON.stringify(await ui.drawn())}`).toBeDefined();
  expect(seen.some(args => args.includes("setting budget.global 5000"))).toBe(true);
  for (const row of ["budget.project", "budget.session", "noting.model", "noting.thinking", "consolidation.model", "consolidation.thinking", "dreaming.model", "dreaming.thinking", "closedSessionScope"]) {
    await ui.select({ key: "setting-rows", value: row });
    expect(await ui.find({ key: row === "closedSessionScope" ? "scope-choice" : `edit-${row}` }), `setting row ${row}: ${JSON.stringify(await ui.drawn())}`).toBeDefined();
    await ui.select({ key: row === "closedSessionScope" ? "scope-back" : "edit-back", value: "back" });
  }
  await ui.select({ key: "setting-rows", value: "closedSessionScope" });
  await ui.select({ key: "scope-choice", value: "global" });
  expect(seen.some(args => args.includes("setting closedSessionScope global"))).toBe(true);
  await ui.select({ key: "setting-rows", value: "back" });
  await ui.select({ key: "actions", value: "project" });
  const writesBeforeCancel = seen.length;
  await ui.input({ key: "project-name", text: "" });
  expect(seen.length).toBe(writesBeforeCancel);
  await ui.select({ key: "actions", value: "project" });
  await ui.input({ key: "project-name", text: "new-project" });
  expect(seen.some(args => args.includes("project new-project"))).toBe(true);
  await ui.select({ key: "actions", value: "runs" });
  expect(await ui.find({ type: "Text", text: "R1 noting completed" }), `runs mount: ${JSON.stringify(await ui.drawn())}`).toBeDefined();
  expect(seen.some(args => args.includes("runs --json 10"))).toBe(true);
  const runsReads = seen.filter(args => args.includes(" runs --json ")).length;
  await ui.input({ key: "run-count", text: "" }); // Empty input does not dispatch another read.
  expect(seen.filter(args => args.includes(" runs --json ")).length).toBe(runsReads);
  await ui.input({ key: "run-count", text: "25" });
  expect(seen.some(args => args.includes("runs --json 25"))).toBe(true);
  expect(await ui.find({ type: "Text", text: "R25 noting completed" }), `requested runs mount: ${JSON.stringify(await ui.drawn())}`).toBeDefined();
  await ui.select({ key: "runs-back", value: "back" });
  await ui.select({ key: "actions", value: "catch-up" });
  await ui.select({ key: "actions", value: "stop" });
  expect(seen.some(args => args.endsWith(" catchup"))).toBe(true);
  expect(seen.some(args => args.endsWith(" stop"))).toBe(true);
  await ui.select({ key: "actions", value: "turn-off" });
  expect(await ui.find({ type: "Text", text: "Turn Trace Memory off" }), `confirmation mount: ${JSON.stringify(await ui.drawn())}`).toBeDefined();
  await ui.select({ key: "confirm", value: "no" });
  expect(seen.some(args => args.endsWith(" off"))).toBe(false);
  await ui.select({ key: "actions", value: "turn-off" });
  await ui.select({ key: "confirm", value: "yes" });
  expect(seen.some(args => args.endsWith(" off"))).toBe(true);
  await ui.unmount();
});

test("a later command resolves the new native identity after clear", async ($, on) => {
  const seen: string[] = [];
  let currentId = "before-clear";
  mockHost(on, seen, "2.1.280", () => currentId);
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
