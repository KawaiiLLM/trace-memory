import { afterEach, expect, test, vi } from "vitest";
import { Text, visibleWidth } from "@earendil-works/pi-tui";
import { ExtensionSelectorComponent, initTheme } from "@earendil-works/pi-coding-agent";
import { contextMap, pendingBar, statusBody } from "../../../src/hosts/pi/session-status.ts";
import { host } from "./test-host.ts";
import { Store } from "../../../src/core/store/index.ts";
import * as rendering from "../../../src/core/render/index.ts";

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
  expect([...grid].filter(c => c === "▪")).toHaveLength(Math.floor(Math.min(ratio, 1) * 100));
  expect([...grid].filter(c => c === "◦")).toHaveLength(ratio === 0.001 ? 1 : 0);
  const bar = pendingBar("Noting", { tokens: ratio * 10000, trigger: 10000, state: "known" });
  expect(bar.match(/\[([^\]]+)\]/)![1]).toHaveLength(10);
  expect(bar).toContain(`${(ratio * 100).toFixed(1)}%`);
});

test("exact zero/equal/over/unknown output", () => {
  expect([0, 5000, 6000].map(tokens => pendingBar("Dreaming", { tokens, trigger: 5000, state: "known" }))).toEqual([
    "Dreaming: [..........] 0 / 5,000 (0.0%)",
    "Dreaming: [##########] 5,000 / 5,000 (100.0%)",
    "Dreaming: [##########] 6,000 / 5,000 (120.0%)",
  ]);
  expect(pendingBar("Noting", { tokens: null, trigger: 10000, state: "unavailable" }))
    .toBe("Noting: [??????????] Unknown / 10,000 (unavailable)");
  expect(contextMap(undefined, "Model: Unknown", 40).slice(0, 5)).toEqual(Array(5).fill("?".repeat(20)));
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
  expect(title).toContain("Session: None"); expect(title).toContain("(no session)"); expect(title).toContain("Unknown / Unknown tokens");
  await h.turn();
  const before = changes(h), entries = structuredClone(h.entries), footer = h.statuses.get("trace-memory");
  title = await open(h);
  expect(title).toContain("Consolidation: [..........] 0 /");
  expect(h.dialogs.at(-1)!.options).toEqual(["Off", "Runs", "Project", "Mark"]);
  expect(changes(h)).toBe(before); expect(h.entries).toEqual(entries); expect(h.statuses.get("trace-memory")).toBe(footer);
  await h.commands.get("trace").handler("off", h.ctx);
  expect(await open(h)).toContain("Off; stored evidence only");
  vi.spyOn(Store.prototype, "pendingEntryIds").mockImplementation(() => { throw Error("unreadable"); });
  expect(await open(h)).toContain("Noting: [??????????] Unknown / 10,000 (unavailable)");
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
  expect(cold).toContain("/ 1,234"); expect(cold).toContain("/ 4,321");
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
    expect(title.startsWith("\u001b[22;39m")).toBe(true);
  } finally { selector.dispose(); }
});

test.each([100, 40])("exact capacity and trigger output at %i columns", width => {
  const lines = ["Current session", ...contextMap({ tokens: 44500, contextWindow: 1000000, percent: 4.45 }, "fake/test", width),
    "Session: S1", "Enrollment: Enabled (default)", "Project: example (mark)", "Pending: / trigger — estimated tokens",
    pendingBar("Noting", { tokens: 12000, trigger: 10000, state: "known" }),
    pendingBar("Consolidation", { tokens: 0, trigger: 5000, state: "known" }),
    pendingBar("Dreaming", { tokens: 500, trigger: 5000, state: "known" }),
    "Dreaming: eligibility only; no worker. Not task completion.", "Cost: $0.0000",
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
  expect(h.dialogs.at(-1)!.title).toContain("Forks or clones carrying this memory identity share this switch.");
  expect(h.dialogs.at(-1)!.title).not.toContain("Last noting:");
  expect(h.dialogs.at(-1)!.title).toContain("eligibility only; no worker");
});
