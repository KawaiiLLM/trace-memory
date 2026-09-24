import { afterEach, expect, test, vi } from "vitest";
import { Text, visibleWidth } from "@earendil-works/pi-tui";
import * as tui from "@earendil-works/pi-tui";
import { ExtensionSelectorComponent, initTheme } from "@earendil-works/pi-coding-agent";
import { compositionMap, contextMap, pendingBar, statusBody } from "../../../src/hosts/pi/session-status.ts";
import type { ContextComposition } from "../../../src/hosts/pi/context-composition.ts";
import { host } from "./test-host.ts";
import { Store } from "../../../src/core/store/index.ts";
import * as rendering from "../../../src/core/render/index.ts";
import * as api from "../../../src/core/api/index.ts";
import * as composition from "../../../src/hosts/pi/context-composition.ts";
import { nativeAncestry } from "../../perf/fixture.ts";

vi.mock("@earendil-works/pi-tui", async importOriginal => {
  const actual = await importOriginal<typeof import("@earendil-works/pi-tui")>();
  return { ...actual, visibleWidth: vi.fn(actual.visibleWidth) };
});

const hosts: ReturnType<typeof host>[] = [];
const setup = (config: Record<string, unknown> = {}) => { const h = host(config); h.ctx.ui.theme.fg = (_color, text) => text; hosts.push(h); return h; };
afterEach(async () => { vi.restoreAllMocks(); for (const h of hosts.splice(0)) await h.dispose(); });
const open = async (h: ReturnType<typeof host>) => { h.ctx.hasUI = true; h.answers.push(undefined); await h.commands.get("trace").handler("", h.ctx); return h.dialogs.at(-1)!.title; };
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

test("composition uses ASCII alternatives when preferred glyph width is unsafe", () => {
  const value: ContextComposition = { amounts: { System: 10, Tools: 0, Skills: 0, Memory: 0, Conversation: 0, Other: 0 },
    memory: { Knowledge: 0, Facts: 0, Raw: 0, Unclassified: 0 }, total: 10, sdkTokens: 10, sdkDifference: 0, window: 100, complete: true };
  vi.mocked(tui.visibleWidth).mockReturnValueOnce(2);
  const lines = compositionMap(value, "test", 40);
  expect(lines.slice(0, 10).join("")).toBe("#".repeat(20) + ".".repeat(180));
  expect(lines.join("\n")).not.toMatch(/[⛁⛀⛶]/);
});

test("Memory splits into flat top-level Knowledge/Facts/Raw/Memory-unclassified rows, no parent row or indentation", () => {
  const value: ContextComposition = {
    amounts: { System: 100, Tools: 100, Skills: 50, Memory: 400, Conversation: 100, Other: 0 },
    memory: { Knowledge: 150, Facts: 120, Raw: 100, Unclassified: 30 },
    total: 750, sdkTokens: 750, sdkDifference: 0, window: 1000, complete: true,
  };
  const lines = compositionMap(value, "test", 60);
  expect(lines.some(line => line.includes("Memory ~") || / Memory /.test(line))).toBe(false);
  const skills = lines.findIndex(line => line.includes("Skill catalog"));
  const conversation = lines.findIndex(line => line.includes("Conversation"));
  for (const [name, amount, share] of [["Knowledge", "~150", "20.0%"], ["Facts", "~120", "16.0%"],
    ["Raw", "~100", "13.3%"], ["Memory, unclassified", "~30", "4.0%"]] as const) {
    const line = lines.find(candidate => candidate.includes(name))!;
    expect(line, `missing ${name} row`).toBeDefined();
    expect(line).toBe(line.trimStart()); // top-level: no leading indentation, unlike the old nested sub-list
    expect(line).toContain(`${name} ${amount} (${share} local)`); // same shape as System/Tools: glyph, name, amount, share
    const index = lines.indexOf(line);
    expect(index).toBeGreaterThan(skills); // placed where the Memory parent row used to sit
    expect(index).toBeLessThan(conversation);
  }
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
  expect(title).toContain("Trace Memory · S1 · pi:pi-test · On");
  expect(title).toContain("Spend   session $0.00");
  expect(title).not.toContain("Shared identity");
  await h.commands.get("trace").handler("off", h.ctx);
  expect(await open(h)).toContain("Trace Memory · S1 · pi:pi-test · Off (explicit)");
  await h.commands.get("trace").handler("on", h.ctx);
  await h.commands.get("trace").handler("project example", h.ctx);
  title = await open(h);
  expect(title).toContain("Trace Memory · S1 · example · On (explicit)");
});

test("compact default Off stays distinct from an explicit choice", async () => {
  const h = setup(); h.setHeaderTimestamp("2000-01-01T00:00:00Z");
  await h.emit("session_start");
  expect(await open(h)).toContain("Trace Memory · No session · Unassigned · Off");
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
  expect(title).toContain("Trace Memory · No session");
  expect(title).toContain("SDK usage unavailable"); // Model capacity and local categories remain available without SDK usage.
  await h.turn();
  const before = changes(h), entries = structuredClone(h.entries), footer = h.statuses.get("trace-memory");
  title = await open(h);
  expect(title).toContain("Consolidation ░░░░░░░░░░   0%   0 / 5k");
  expect(h.dialogs.at(-1)!.options).toEqual(["Turn off", "Catch up", "Stop", "Project…", "Runs…", "Settings…"]);
  expect(changes(h)).toBe(before); expect(h.entries).toEqual(entries); expect(h.statuses.get("trace-memory")).toBe(footer);
  await h.commands.get("trace").handler("off", h.ctx);
  expect(await open(h)).toContain("Trace Memory · S1 · pi:pi-test · Off (explicit)");
  vi.spyOn(Store.prototype, "pendingEntryState").mockImplementation(() => { throw Error("unreadable"); });
  expect(await open(h)).toContain("Noting        Unknown / Unknown");
  expect(h.requests).toEqual([]);
});

test("reopening replaces unavailable SDK capacity with the current valid estimate", async () => {
  const h = setup(); await h.turn();
  h.setContextUsage(undefined);
  const unavailable = await open(h);
  expect(unavailable).toContain("SDK usage unavailable");
  expect(unavailable).not.toContain("?".repeat(20));
  h.setContextUsage({ tokens: 60237, contextWindow: 512000, percent: 0 });
  const available = await open(h);
  expect(available).toContain("60.2k / 512k tokens (11.8%, SDK)");
  expect(available).toContain("Free"); expect(available).toContain("451.8k");
  expect(available).toContain("Estimated usage by category");
  expect(h.requests).toEqual([]);
});

test("repeated Dreaming pool reads show identical pending data without DB writes or grants", async () => {
  const h = setup({ "noting.triggerTokens": 999999, "consolidation.triggerTokens": 4321 });
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
  h.memory.setKnowledgeBudget("project", 2468);
  const before = changes(h), entries = structuredClone(h.entries);
  const first = await open(h);
  expect(first).toContain("/ 2.5k"); expect(first).toContain("/ 4.3k");
  expect(changes(h)).toBe(before); expect(h.entries).toEqual(entries);
  expect(await open(h)).toBe(first);
  expect(changes(h)).toBe(before); expect(h.entries).toEqual(entries);
  expect(h.memory.store.getClaim(1, "dreaming")).toBeNull();
  expect(h.requests).toEqual([]);
});

test("shared identity stays concise in overview and complete in On/Off confirmation", async () => {
  const h = setup(); await h.turn();
  h.ctx.sessionManager.getSessionId = () => "cloned-session";
  await h.emit("session_start");
  expect(await open(h)).toContain("Shared identity");
  h.answers.push("Turn off", false);
  await h.commands.get("trace").handler("", h.ctx);
  expect(h.dialogs.at(-1)!.title).toContain("this switch also affects forks or clones carrying this memory identity.");
  expect(h.memory.store.enabled(1)).toBe(true);
  await h.commands.get("trace").handler("off", h.ctx);
  h.answers.push("Turn on", false);
  await h.commands.get("trace").handler("", h.ctx);
  expect(h.dialogs.at(-1)!.title).toContain("this switch also affects forks or clones carrying this memory identity.");
  expect(h.memory.store.enabled(1)).toBe(false);
});

test("headless shares compact composition while retaining operational explanations and command forms", async () => {
  const h = setup(); await h.turn();
  await h.commands.get("trace").handler("", h.ctx);
  const status = h.notices.at(-1)!;
  expect(status).toContain("fake/test");
  expect(status).toContain("Estimated usage by category");
  expect(status).not.toContain("Pi rebuilt text estimate (not provider wire)");
  expect(status).not.toContain("Memory ~0");
  expect(status).toContain("/trace project");
  expect(status).toContain("Trace Memory · S1 · pi:pi-test · On");
  expect(status).toContain("Pending / trigger");
  expect(status).not.toContain("worker readiness");
});

test.each([false, true])("enrollment notices share only lightweight session wording (allocated=%s)", async allocated => {
  const coreStatus = vi.fn(() => { throw new Error("Pi must use its own status wording"); });
  const measurements = vi.fn();
  const create = api.TraceMemory;
  vi.spyOn(api, "TraceMemory").mockImplementation((...args) => {
    const memory = create(...args), pending = memory.pendingTokens, dreaming = memory.dreamingPending;
    memory.status = coreStatus;
    memory.pendingTokens = (...params) => { measurements(...params); return pending(...params); };
    // Dreaming's own per-pool projection is a separate call; tag it the same way so the shared
    // "measurements" trace still shows it fires exactly once, lazily, alongside noting/consolidation.
    memory.dreamingPending = (...params) => { measurements("dreaming", ...params); return dreaming(...params); };
    return memory;
  });
  const h = setup();
  if (allocated) {
    await h.turn();
    h.memory.store.suppressFork(1, "2026-09-11T00:00:00Z");
  } else await h.emit("session_start");
  const census = vi.spyOn(composition, "contextComposition");
  const command = (args: string) => h.commands.get("trace").handler(args, h.ctx);
  for (const value of ["off", "on"]) {
    measurements.mockClear(); census.mockClear();
    await command(value);
    const notice = h.notices.at(-1)!;
    expect(measurements).not.toHaveBeenCalled(); expect(census).not.toHaveBeenCalled();
    expect(notice).not.toMatch(/Pending.*trigger|Pi rebuilt text estimate|Memory ~/);
    await command("");
    const body = h.notices.at(-1)!.split("\n/trace (menu;")[0]!;
    expect(measurements.mock.calls.map(([phase]) => phase)).toEqual(["noting", "consolidation", "dreaming"]);
    expect(census).toHaveBeenCalledTimes(1);
    // Toggle notices keep their lightweight legacy wording; the new panel uses the shared model.
    expect(body).toContain("Pending / trigger");
    expect(notice).toContain(value === "on"
      ? "Available history, including the paused interval, is queued; ordinary completions check thresholds."
      : "Processing and future injection are paused. Stored memory and already-injected text remain.");
    expect(notice).toContain(`Enrollment: ${value === "on" ? "Enabled" : "Disabled"} (explicit choice)`);
    expect(notice).toContain(allocated ? "Session: S1" : "Session: None (no assistant reply)");
    if (allocated) expect(notice).toContain("Fork: suppressed since 2026-09-11");
    else expect(notice).toContain("Cost: N/A (no session)");
  }
  expect(coreStatus).not.toHaveBeenCalled();
  expect(h.memory.store.listTurns(1)).toHaveLength(allocated ? 1 : 0);
  expect(h.memory.store.getSession(allocated ? 2 : 1)).toBeNull();
  expect(h.requests).toEqual([]);
});

test("long-history toggles retain reconciliation but never add a full status scan or worker admission", async () => {
  const h = setup(); h.setHeaderTimestamp("2000-01-01T00:00:00Z");
  await h.emit("session_start");
  const ancestry = nativeAncestry({ entries: 2000 });
  h.entries.push(...ancestry); h.allEntries.push(...ancestry);
  const census = vi.spyOn(composition, "contextComposition");
  const views = vi.spyOn(rendering, "renderEntry");
  const reads = vi.spyOn(Store.prototype, "getSourceEntry");
  const identities = vi.spyOn(Store.prototype, "findKnownSourceEntry");
  const grants = vi.spyOn(h.ctx.modelRegistry, "getApiKeyAndHeaders");
  const claims = vi.spyOn(Store.prototype, "acquireClaim");
  const command = (args: string) => h.commands.get("trace").handler(args, h.ctx);
  await command("on");
  for (const value of ["on", "off", "off", "on"]) {
    reads.mockClear(); identities.mockClear();
    await command(value);
    // 74: re-enabling still reconciles every native identity (findKnownSourceEntry, once per
    // ancestry entry) but the notice adds no Raw reads at all, known entry or not.
    expect(identities).toHaveBeenCalledTimes(value === "on" ? ancestry.length : 0);
    expect(reads).not.toHaveBeenCalled();
    expect(h.memory.store.enabled(1)).toBe(value === "on");
  }
  expect(census).not.toHaveBeenCalled(); expect(views).not.toHaveBeenCalled();
  expect(grants).not.toHaveBeenCalled(); expect(claims).not.toHaveBeenCalled();
  expect(h.requests).toEqual([]); expect(h.memory.store.listRuns(1)).toEqual([]);
  expect(h.memory.store.listSourceEntries(1)).toHaveLength(ancestry.length);
}, 15_000);

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
  const composition = (text: string) => {
    const start = text.indexOf("fake/test");
    const end = text.indexOf("\nPending / trigger", start);
    return text.slice(start, end);
  };
  expect(composition(headless)).toBe(composition(title));
  for (const text of [headless, title]) {
    expect(text).toContain("1 / 1k tokens (0.1%, SDK)");
    expect(text).toContain("Free"); expect(text).toContain("999");
    expect(text).not.toContain("Difference");
    expect(text).not.toContain("?".repeat(20));
    expect(text).toContain("Fork suppressed");
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
      expect(lines.join("\n")).toContain("Runs"); expect(lines.join("\n")).toContain("Project");
    }
    expect(title.startsWith("Trace Memory · S1")).toBe(true);
  } finally { selector.dispose(); }
});

test.each([100, 40])("exact capacity and trigger output at %i columns", width => {
  const lines = ["Current session", ...contextMap({ tokens: 44500, contextWindow: 1000000, percent: 4.45 }, "fake/test", width),
    "Session: S1 | Enabled | Cost: $0.0000", "Project: example", "Pending / trigger (~tokens)",
    pendingBar("Noting", { tokens: 12000, trigger: 10000, state: "known" }),
    pendingBar("Consolidation", { tokens: 0, trigger: 5000, state: "known" }),
    pendingBar("Dreaming", { tokens: 500, trigger: 5000, state: "known" }),
    "Off | Runs | Project"];
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
  expect(title.replace(/\s+/g, " ")).toContain("Turn on to resume."); expect(title).toContain("Fork suppressed since 2026-09-11");
  expect(h.dialogs.at(-1)!.options).toEqual(["Turn on", "Catch up", "Stop", "Project…", "Runs…", "Settings…", "Retry fork"]);
  expect(changes(h)).toBe(before);
  h.answers.push("Retry fork"); await h.commands.get("trace").handler("", h.ctx);
  expect(s.forkSuppression(1)).toBeNull(); expect(s.enabled(1)).toBe(false); expect(h.requests).toEqual([]);
});

test("panel queries occur only on open; failure and shared-identity recovery remain visible", async () => {
  const h = setup(); await h.turn();
  const pending = vi.spyOn(rendering, "renderEntry");
  await h.emit("message_update", { message: { role: "user" } }); await h.emit("agent_end", {});
  expect(pending).not.toHaveBeenCalled();
  const start = performance.now(); await open(h);
  // Ticket 80 item 1: `h.turn()` above already rendered and cached these same pending entries through
  // its own `taskEligibility`/injection flow, before this spy attached — the panel's own pending-weight
  // read now reuses that cache instead of re-rendering, exactly the S134 status-panel win the ticket
  // measures. "Queries occur only on open" still holds: the background events above called it zero
  // times, and opening triggers the read (a cache hit still counts as the read happening).
  expect(pending).not.toHaveBeenCalled();
  expect(performance.now() - start).toBeLessThan(1000);
  expect(h.dialogs.at(-1)!.title).not.toContain("Shared identity");
  expect(h.dialogs.at(-1)!.title).not.toContain("Last noting:");
  expect(h.dialogs.at(-1)!.title).toContain("Pending / trigger");
  expect(h.dialogs.at(-1)!.title).not.toContain("worker readiness");
});
