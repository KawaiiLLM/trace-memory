import { afterEach, expect, test, vi } from "vitest";
import { Text, visibleWidth } from "@earendil-works/pi-tui";
import * as tui from "@earendil-works/pi-tui";
import { ExtensionSelectorComponent, initTheme } from "@earendil-works/pi-coding-agent";
import { contextMap, pendingBar, statusBody } from "../../../src/hosts/pi/session-status.ts";
import { host } from "./test-host.ts";
import { Store } from "../../../src/core/store/index.ts";
import * as rendering from "../../../src/core/render/index.ts";

vi.mock("@earendil-works/pi-tui", async importOriginal => {
  const actual = await importOriginal<typeof import("@earendil-works/pi-tui")>();
  return { ...actual, visibleWidth: vi.fn(actual.visibleWidth) };
});

const hosts: ReturnType<typeof host>[] = [];
const setup = (config: Record<string, unknown> = {}) => { const h = host(config); h.ctx.ui.theme.fg = (_color, text) => text; hosts.push(h); return h; };
afterEach(async () => { vi.restoreAllMocks(); for (const h of hosts.splice(0)) await h.dispose(); });
const open = async (h: ReturnType<typeof host>) => { h.ctx.hasUI = true; h.answers.push("Current session", undefined); await h.commands.get("trace").handler("", h.ctx); return h.dialogs.at(-1)!.title; };
const changes = (h: ReturnType<typeof host>) => JSON.stringify(h.memory.store.db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name").all()
  .map(row => [row.name, h.memory.store.db.prepare(`SELECT * FROM "${String(row.name).replaceAll('"', '""')}"`).all()]));

test.each([0, 0.001, 0.25, 1, 1.25])("capacity map and pending bars preserve %s ratio", ratio => {
  const usage = { tokens: ratio * 100000, contextWindow: 100000, percent: 99 }; // SDK percent isn't a second denominator
  const lines = contextMap(usage, "fake/test", 100);
  expect(lines).toHaveLength(5);
  expect(lines.join("\n")).toContain(`${(ratio * 100).toFixed(1)}%`);
  const grid = lines.map(line => line.split("   ")[0]).join("");
  expect([...grid].filter(c => c === "⛁")).toHaveLength(Math.floor(Math.min(ratio, 1) * 100));
  expect([...grid].filter(c => c === "⛀")).toHaveLength(ratio === 0.001 ? 1 : 0);
  const bar = pendingBar("Noting", { tokens: ratio * 10000, trigger: 10000, state: "known" });
  expect(bar.match(/[█░]+/)![0]).toHaveLength(10);
  expect(bar.match(/█/g) ?? []).toHaveLength(Math.min(10, Math.floor(ratio * 10)));
  expect(bar).toContain(`${(ratio * 100).toFixed(1)}%`);
});

test("exact zero/equal/over/unknown output", () => {
  expect([0, 5000, 6000].map(tokens => pendingBar("Dreaming", { tokens, trigger: 5000, state: "known" }))).toEqual([
    "Dreaming      ░░░░░░░░░░   0.0% 0/5k",
    "Dreaming      ██████████ 100.0% 5k/5k",
    "Dreaming      ██████████ 120.0% 6k/5k",
  ]);
  expect(pendingBar("Noting", { tokens: null, trigger: 10000, state: "unavailable" }))
    .toBe("Noting        ?????????? Unknown/10k (unavailable)");
  expect(contextMap(undefined, "Model: Unknown", 40).slice(0, 5)).toEqual(Array(5).fill("?".repeat(20)));
});

test("preferred glyphs are one Pi cell; width anomaly alone selects ASCII fallback", () => {
  expect(["⛁", "⛀", "⛶"].map(visibleWidth)).toEqual([1, 1, 1]);
  vi.mocked(tui.visibleWidth).mockReturnValueOnce(1).mockReturnValueOnce(2);
  const lines = contextMap({ tokens: 1500, contextWindow: 100000, percent: 1.5 }, "test", 40);
  expect(lines[0]).toBe("#+" + ".".repeat(18));
  expect(lines.join("\n")).not.toMatch(/[⛁⛀⛶]/);
});

test("bars align columns, only glyphs carry color, and width anomalies fall back", () => {
  const paint = (color: string, text: string) => `<${color}>${text}</${color}>`;
  const bars = ["Noting", "Consolidation", "Dreaming"].map(label => pendingBar(label, { tokens: 5800, trigger: 10000, state: "known" }));
  for (const bar of bars) {
    expect(bar.indexOf("█")).toBe(14);
    expect(bar.indexOf("58.0%")).toBe(26);
    expect(bar).toContain("5.8k/10k");
  }
  expect(pendingBar("Noting", { tokens: 5800, trigger: 10000, state: "known" }, true, paint)).toContain("<accent>█████</accent><dim>░░░░░</dim>");
  vi.mocked(tui.visibleWidth).mockReturnValueOnce(2);
  expect(pendingBar("Noting", { tokens: 5800, trigger: 10000, state: "known" })).toContain("#####.....");
});

test("context legend labels only known capacity, not invented content categories", () => {
  const paint = (color: string, text: string) => `<${color}>${text}</${color}>`;
  const map = contextMap({ tokens: 44500, contextWindow: 1000000, percent: 4.45 }, "test", 40, paint).join("\n");
  expect(map).toContain("<accent>⛁</accent><dim> Used 44.5k (4.5%)</dim>");
  expect(map).toContain("<dim>⛶ Free 955.5k (95.5%)</dim>");
  expect(map).not.toMatch(/System|Tools|Skills|Memory|Partial/);
});

test.each([9999, 10000, 10001])("pending %i never rounds onto its trigger", tokens => {
  const bar = pendingBar("Noting", { tokens, trigger: 10000, state: "known" });
  expect(bar).toContain(`${tokens === 10000 ? "10k" : tokens.toLocaleString("en-US")}/10k`);
  expect(bar).toContain(tokens === 10000 ? "100.0%" : tokens < 10000 ? "<100%" : ">100%");
});

test.each([
  [0, "0.0%", "100.0%"], [0.001, "<0.1%", "<100%"],
  [9999, "<100%", "<0.1%"], [10000, "100.0%", "0.0%"],
  [10001, ">100%", "0.0%"], [12500, "125.0%", "0.0%"],
] as const)("context %s preserves total, Used and safe Free percentages", (tokens, used, free) => {
  const lines = contextMap({ tokens, contextWindow: 10000, percent: 100 }, "fake/test", 40);
  expect.soft(lines[6]).toContain(`(${used})`);
  expect.soft(lines[7]).toContain(`Used ${tokens === 10000 ? "10k" : tokens === 12500 ? "12.5k" : tokens.toLocaleString("en-US")} (${used})`);
  expect(lines[8]).toContain(`(${free})`);
  expect(lines[8]).not.toContain("-");
  expect(lines.slice(0, 5).join("").match(/⛁/g) ?? []).toHaveLength(Math.min(100, Math.floor(tokens / 100)));
});

test("compact identity distinguishes provider, enrollment source and project declaration", async () => {
  const h = setup(); await h.turn();
  let title = await open(h);
  expect(title).toContain("fake/test");
  expect(title).toContain("S1 | On(default) | $0.0000");
  expect(title).toContain("Project: pi:pi-test (undeclared)");
  expect(title).not.toContain("Shared identity");
  await h.commands.get("trace").handler("off", h.ctx);
  expect(await open(h)).toContain("S1 | Off(explicit) | $0.0000");
  await h.commands.get("trace").handler("on", h.ctx);
  await h.commands.get("trace").handler("project example", h.ctx);
  title = await open(h);
  expect(title).toContain("S1 | On(explicit) | $0.0000");
  expect(title).toContain("Project: example (mark)");
});

test("compact default Off stays distinct from an explicit choice", async () => {
  const h = setup(); h.setHeaderTimestamp("2000-01-01T00:00:00Z");
  await h.emit("session_start");
  expect(await open(h)).toContain("Off(default)");
});

test.each([9999, 10001])("headless threshold formatting remains unchanged at %i", tokens => {
  expect(contextMap({ tokens, contextWindow: 10000, percent: 100 }, "fake/test", 40, undefined, false).join("\n")).toContain("(100.0%)");
  expect(pendingBar("Noting", { tokens, trigger: 10000, state: "known" }, false)).toContain("(100.0%)");
});

test("wide and narrow native Text layouts stay within Pi visible width", () => {
  for (const width of [1, 20, 40, 80, 100]) {
    const lines = contextMap({ tokens: 44500, contextWindow: 1000000, percent: 4.45 }, "fake/模型-with-a-long-name", width);
    const body = statusBody(lines, width);
    expect(new Text(body, 0, 0).render(width).every(line => visibleWidth(line) <= width)).toBe(true);
  }
  expect(contextMap({ tokens: 1, contextWindow: 1000000, percent: 0 }, "fake/test", 100).join("\n")).toContain("<0.1%");
});

test("no session, Off, zero and unavailable remain distinct; original actions and cancellation survive", async () => {
  const h = setup(); await h.emit("session_start");
  h.setContextUsage(undefined);
  let title = await open(h);
  expect(title).toContain("Session: No session"); expect(title).toContain("(no session)"); expect(title).toContain("/ 200k"); // Model capacity and rebuilt text remain available without SDK usage.
  await h.turn();
  const before = changes(h), entries = structuredClone(h.entries), footer = h.statuses.get("trace-memory");
  title = await open(h);
  expect(title).toContain("Consolidation ░░░░░░░░░░   0.0% 0/5k");
  expect(h.dialogs.at(-1)!.options).toEqual(["Off", "Runs", "Project", "Mark"]);
  expect(changes(h)).toBe(before); expect(h.entries).toEqual(entries); expect(h.statuses.get("trace-memory")).toBe(footer);
  await h.commands.get("trace").handler("off", h.ctx);
  expect(await open(h)).toContain("Off; stored evidence only");
  vi.spyOn(Store.prototype, "pendingEntryIds").mockImplementation(() => { throw Error("unreadable"); });
  expect(await open(h)).toContain("Noting        ?????????? Unknown/10k (unavailable)");
  expect(h.requests).toEqual([]);
});

test("cold and warm Dreaming weights show identical data without any DB writes or grants", async () => {
  const h = setup({ "noting.triggerTokens": 999999, "consolidation.triggerTokens": 4321, "dreaming.triggerTokens": 1234 });
  await h.turn();
  const store = h.memory.store;
  const turn = store.listTurns(1)[0]!;
  const fact = store.commitNotingRun({ run: { kind: "manual", sessionId: 1, createdAt: "now" }, facts: [
    { turnId: turn.id, category: "decision", actor: "user", text: "rule", source: [`T${turn.id}#user`], createdAt: "now" },
  ] });
  if (!fact.ok) throw Error(fact.problems.join());
  const committed = store.commitConsolidationRun({ run: { kind: "manual", sessionId: 1, createdAt: "now" }, operations: [
    { op: "create", handle: "$1", author: "test", text: "knowledge", category: "constraint", scope: "project", supports: [fact.facts[0]!.id], topics: [], reason: "test", createdAt: "now" },
  ] });
  if (!committed.ok) throw Error(committed.problems.join());
  store.db.exec("DELETE FROM knowledge_weights");
  const coldBefore = changes(h), entries = structuredClone(h.entries);
  const toolBinding = h.memory.tools({ kind: "manual", sessionId: 1, branch: "main", currentTurnId: turn.id });
  const cold = await open(h);
  expect(cold).toContain("/1,234"); expect(cold).toContain("/4,321");
  expect(store.db.prepare("SELECT * FROM knowledge_weights").all()).toEqual([]);
  expect(changes(h)).toBe(coldBefore); expect(h.entries).toEqual(entries);
  const update = () => toolBinding[3]!.execute({ operations: [{ op: "update", id: `K1@${committed.committed[0]!.commit}`, text: "new", category: "constraint", scope: "project", supports: ["F1"], topics: [], reason: "test" }], skipped: [] });
  expect(update()).toContain("not read");
  store.pendingKnowledgeEvents({ sessionId: 1, branch: "main", headTurnId: turn.id });
  const warmBefore = changes(h);
  expect(await open(h)).toBe(cold);
  expect(changes(h)).toBe(warmBefore);
  expect(update()).toContain("not read");
  expect(h.requests).toEqual([]);
});

test("shared identity stays concise in overview and complete in On/Off confirmation", async () => {
  const h = setup(); await h.turn();
  h.ctx.sessionManager.getSessionId = () => "cloned-session";
  await h.emit("session_start");
  expect(await open(h)).toContain("Shared identity");
  h.answers.push("Current session", "Off", false);
  await h.commands.get("trace").handler("", h.ctx);
  expect(h.dialogs.at(-1)!.title).toContain("this switch also affects forks or clones carrying this memory identity.");
  expect(h.memory.store.enabled(1)).toBe(true);
  await h.commands.get("trace").handler("off", h.ctx);
  h.answers.push("Current session", "On", false);
  await h.commands.get("trace").handler("", h.ctx);
  expect(h.dialogs.at(-1)!.title).toContain("this switch also affects forks or clones carrying this memory identity.");
  expect(h.memory.store.enabled(1)).toBe(false);
});

test("headless shares composition while retaining verbose explanations and command forms", async () => {
  const h = setup(); await h.turn();
  await h.commands.get("trace").handler("", h.ctx);
  const status = h.notices.at(-1)!;
  expect(status).toContain("fake/test");
  expect(status).toContain("Pi rebuilt text estimate (not provider wire)");
  expect(status).toContain("Memory ~");
  expect(status).toContain("/trace project");
  expect(status).toContain("Enrollment: Enabled (default)");
  expect(status).toContain("Pending / trigger is not task completion or worker readiness.");
});

test("headless and UI read the same composition once per opening without writes or grants", async () => {
  const h = setup(); await h.turn();
  h.ctx.getSystemPrompt = () => "x".repeat(408);
  h.setContextUsage({ tokens: 1, contextWindow: 1000, percent: 0.1 });
  h.memory.store.suppressFork(1, "2026-09-11T00:00:00Z");
  const before = changes(h), entries = structuredClone(h.entries), footer = h.statuses.get("trace-memory");
  const usage = vi.spyOn(h.ctx, "getContextUsage");
  const census = vi.spyOn(h.ctx.sessionManager, "buildContextEntries");
  await h.commands.get("trace").handler("", h.ctx);
  const headless = h.notices.at(-1)!;
  expect(usage).toHaveBeenCalledTimes(1); expect(census).toHaveBeenCalledTimes(1);
  const title = await open(h);
  expect(usage).toHaveBeenCalledTimes(2); expect(census).toHaveBeenCalledTimes(2);
  const composition = (text: string) => text.slice(text.indexOf("fake/test"), text.indexOf("Pi rebuilt text estimate") + "Pi rebuilt text estimate (not provider wire)".length);
  expect(composition(headless)).toBe(composition(title));
  for (const text of [headless, title]) {
    expect(text).toContain("SDK mismatch: 1");
    expect(text).toContain("free unknown");
    expect(text).not.toContain("Free ~");
    expect(text).toContain("Fork: suppressed");
  }
  expect(changes(h)).toBe(before); expect(h.entries).toEqual(entries);
  expect(h.statuses.get("trace-memory")).toBe(footer); expect(h.requests).toEqual([]);
});

test("real Pi selector wraps the dim body and keeps every original action", async () => {
  const h = setup(); await h.turn();
  h.ctx.ui.theme.fg = (color, text) => `\u001b[${color === "accent" ? 36 : 90}m${text}\u001b[39m`;
  const title = await open(h);
  initTheme("dark", false);
  const selector = new ExtensionSelectorComponent(title, h.dialogs.at(-1)!.options!, () => {}, () => {});
  try {
    for (const width of [40, 80, 100]) {
      const lines = selector.render(width);
      expect(lines.every(line => visibleWidth(line) <= width)).toBe(true);
      expect(lines.join("\n")).toContain("Runs"); expect(lines.join("\n")).toContain("Mark");
    }
    expect(title.startsWith("Current session")).toBe(true);
  } finally { selector.dispose(); }
});

test.each([100, 40])("exact capacity and trigger output at %i columns", width => {
  const lines = ["Current session", ...contextMap({ tokens: 44500, contextWindow: 1000000, percent: 4.45 }, "fake/test", width),
    "Session: S1 | Enabled | Cost: $0.0000", "Project: example", "Pending / trigger (~tokens)",
    pendingBar("Noting", { tokens: 12000, trigger: 10000, state: "known" }),
    pendingBar("Consolidation", { tokens: 0, trigger: 5000, state: "known" }),
    pendingBar("Dreaming", { tokens: 500, trigger: 5000, state: "known" }),
    "Off | Runs | Project | Mark"];
  expect(statusBody(lines, width)).toMatchSnapshot();
});

test("automatic-off reason and fork reset remain actionable and opening is inert", async () => {
  const h = setup(); await h.turn();
  const s = h.memory.store;
  for (let i = 0; i < 3; i++) {
    const execution = s.beginExecution({ sessionId: 1, phase: "noting", head: 1 });
    const run = s.recordRun({ kind: "noting", sessionId: 1, executionId: execution, outcome: "failure", createdAt: "now" });
    s.settleExecution(execution, "failure", run.id, "incomplete submission");
  }
  s.suppressFork(1, "2026-09-11T00:00:00Z");
  const before = changes(h), title = await open(h);
  expect(title).toContain("Automatic off: noting"); expect(title).toContain("incomplete submission");
  expect(title.replace(/\s+/g, " ")).toContain("Use /trace on to resume."); expect(title).toContain("Fork: suppressed since 2026-09-11");
  expect(h.dialogs.at(-1)!.options).toEqual(["On", "Runs", "Project", "Mark", "Retry fork"]);
  expect(changes(h)).toBe(before);
  h.answers.push("Current session", "Retry fork"); await h.commands.get("trace").handler("", h.ctx);
  expect(s.forkSuppression(1)).toBeNull(); expect(s.enabled(1)).toBe(false); expect(h.requests).toEqual([]);
});

test("panel queries occur only on open; failure and shared-identity recovery remain visible", async () => {
  const h = setup(); await h.turn();
  const pending = vi.spyOn(rendering, "renderEntry");
  await h.emit("message_update", { message: { role: "user" } }); await h.emit("agent_end", {});
  expect(pending).not.toHaveBeenCalled();
  const start = performance.now(); await open(h);
  expect(pending).toHaveBeenCalledTimes(2);
  expect(performance.now() - start).toBeLessThan(1000);
  expect(h.dialogs.at(-1)!.title).not.toContain("Shared identity");
  expect(h.dialogs.at(-1)!.title).not.toContain("Last noting:");
  expect(h.dialogs.at(-1)!.title).toContain("Pending / trigger (~tokens)");
  expect(h.dialogs.at(-1)!.title).not.toContain("worker readiness");
});
