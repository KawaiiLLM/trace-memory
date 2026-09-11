import { expect, test, vi } from "vitest";
import { DatabaseSync } from "node:sqlite";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { ExtensionSelectorComponent, initTheme } from "@earendil-works/pi-coding-agent";
import { Container, Text, TuiAltScreen, TuiMainScreen, stripTerminalSequences, visibleWidth, wrapTextWithAnsi } from "@earendil-works/pi-tui";
import { SessionPanel, showSessionPanel } from "../../../src/hosts/pi/session-panel.ts";
import { host, reply } from "./test-host.ts";
import { contextMap, statusBody } from "../../../src/hosts/pi/session-status.ts";

// These are installed Pi internals only in tests: reproduce the actual fullscreen dock,
// not selector.render() or an invented terminal-height approximation.
const sdk = new URL("./", import.meta.resolve("@earendil-works/pi-coding-agent"));
const tui = new URL("./", import.meta.resolve("@earendil-works/pi-tui"));
const { KeybindingsManager } = await import(fileURLToPath(new URL("core/keybindings.js", sdk)));
const { createChatViewport } = await import(fileURLToPath(new URL("modes/interactive/chat-viewport.js", sdk)));
const { renderLayoutFrame } = await import(fileURLToPath(new URL("layout.js", tui)));
export const recovery = [
  "Automatic off: noting, backlog head 1, 3 failures; last R3: incomplete submission. Use /trace on to resume.",
  "Fork: suppressed since 2026-09-11 (cache miss); Retry fork in the /trace menu",
  "Compaction: cancelled; original context retained.",
  "Catch up: stopped; pending evidence retained.",
];
export const actions = ["On", "Runs", "Project", "Mark", "Retry fork"];
const body = (width: number) => statusBody(["Current session", ...contextMap({ tokens: 44500, contextWindow: 1000000, percent: 4.45 }, "fake/test", width),
  "Session: S1", "Enrollment: Disabled (default)", "Project: example (mark)", "Pending: / trigger — estimated tokens",
  "Noting: [##########] 12,000 / 10,000 (120.0%)", "Consolidation: [..........] 0 / 5,000 (0.0%)",
  "Dreaming: [#.........] 500 / 5,000 (10.0%)", "Pending / trigger is not task completion or worker readiness.",
  "Cost: $0.0000", ...recovery], width);
export function dockFrame(editor: any, width: number, height: number, crowded = false) {
  const empty = new Container(), editorContainer = new Container(); editorContainer.addChild(editor);
  const { root } = createChatViewport({ document: new Text("transcript\n".repeat(40), 0, 0), pendingMessages: empty,
    status: empty, widgetsAbove: crowded ? new Text("existing widget\n".repeat(100), 0, 0) : empty,
    editor: editorContainer, widgetsBelow: empty, footer: new Text("original footer", 0, 0) });
  return renderLayoutFrame(root, width, height, () => {});
}

test.each([40, 80, 100])("legacy native title reproduces fullscreen clipping at %i columns", width => {
  initTheme("dark", false);
  const selector = new ExtensionSelectorComponent(body(width - 2), actions, () => {}, () => {});
  try {
    const frame = dockFrame(selector, width, 24);
    console.log(`${width}x24 native selector\n${frame.lines.join("\n")}`);
    expect(frame.lines.map(stripTerminalSequences).some((s: string) => s.trim() === "Mark")).toBe(false);
  } finally { selector.dispose(); }
});

// Exercise Pi's real overlay compositor AFTER renderLayoutFrame, and its real input routing.
// A fake terminal supplies dimensions only; no stdout, user's settings, or actual terminal is used.
function screenHarness(width: number, height: number, mode: "fullscreen" | "regular" = "fullscreen", crowded = false) {
  const terminal = { columns: width, rows: height, write() {}, hideCursor() {}, showCursor() {} };
  const tui: any = mode === "fullscreen" ? new TuiAltScreen(terminal as any, false) : new TuiMainScreen(terminal as any, false);
  tui.requestRender = () => {}; tui.requestImmediateRender = () => {};
  const theme = { fg: (color: string, text: string) => `\u001b[${color === "accent" ? 36 : 90}m${text}\u001b[39m` };
  const kb = new KeybindingsManager();
  const ctx: any = { ui: { custom: async (factory: any, options: any) => new Promise(resolve => {
    const component = factory(tui, theme, kb, (value: any) => { handle.hide(); resolve(value); });
    const handle = tui.showOverlay(component, options.overlayOptions);
  }) } };
  const frame = () => {
    const base = mode === "fullscreen" ? dockFrame(new Text("editor", 0, 0), terminal.columns, terminal.rows, crowded).lines
      : Array(60).fill("regular transcript").concat("editor", "original footer");
    const lines: string[] = tui.compositeOverlays(base, terminal.columns, terminal.rows).slice(-terminal.rows);
    expect(lines).toHaveLength(terminal.rows);
    expect(lines.every(line => visibleWidth(line) <= terminal.columns)).toBe(true);
    return lines.map(stripTerminalSequences);
  };
  return { ctx, terminal, kb, frame, key: (key: string) => tui.handleTerminalInput(key) };
}

const overview = (width: number, paint?: any) => statusBody([...recovery, ...contextMap({ tokens: 44500, contextWindow: 1000000, percent: 4.45 }, "fake/test", width, paint),
  "Pending: / trigger — estimated tokens", "Noting: 12,000 / 10,000 (120.0%)", "Consolidation: 0 / 5,000", "Dreaming: 500 / 5,000", "Final detail: shared identity"], width, paint);

test.each([40, 80, 100])("real overlay at %i x 24 keeps every action executable and all recovery scrollable", async width => {
  for (const mode of ["fullscreen", "regular"] as const) for (let action = 0; action < actions.length; action++) {
    const s = screenHarness(width, 24, mode);
    const result = showSessionPanel(s.ctx, overview, actions);
    let lines = s.frame();
    expect(lines.some(line => line.includes("Automatic off:"))).toBe(true);
    for (const label of actions) expect(lines.some(line => line.trim().replace(/^→ /, "") === label)).toBe(true);
    if (action === 0 && mode === "fullscreen") console.log(`${width}x24 fixed overlay\n${lines.join("\n")}`);
    const viewed = [...lines];
    for (let i = 0; i < 20; i++) { s.key("\x1b[6~"); viewed.push(...s.frame()); }
    for (const phrase of ["Use /trace on to resume.", "Fork:", "Compaction:", "Catch up:", "fake/test", "Pending:", "Final detail:"])
      expect(viewed.join(" ").replace(/\s+/g, " ")).toContain(phrase);
    for (let i = 0; i < action; i++) s.key("\x1b[B");
    lines = s.frame(); expect(lines.some(line => line.trim() === `→ ${actions[action]}`)).toBe(true);
    s.key("\r"); expect(await result).toBe(actions[action]);
    expect(s.frame().join("\n")).toContain("original footer");
  }
});

test.each([40, 80, 100])("overlay remains independent of the real minimum editor-dock allocation at %i x 24", async width => {
  initTheme("dark", false);
  const selector = new ExtensionSelectorComponent(body(width - 2), actions, () => {}, () => {});
  try {
    const legacy = dockFrame(selector, width, 24, true).lines.map(stripTerminalSequences);
    expect(legacy.some((line: string) => line.trim() === "Mark")).toBe(false);
    const s = screenHarness(width, 24, "fullscreen", true);
    const result = showSessionPanel(s.ctx, overview, actions);
    expect(s.frame().some(line => line.trim() === "Mark")).toBe(true);
    expect(s.frame().join(" ")).toContain("Automatic off:");
    s.key("\x1b"); expect(await result).toBeUndefined();
  } finally { selector.dispose(); }
});

test("resize reflows wide/narrow and very short views without rescanning; cancel is inert", async () => {
  const s = screenHarness(100, 24);
  const result = showSessionPanel(s.ctx, overview, actions);
  for (const [width, height] of [[100, 24], [40, 24], [80, 12], [40, 6], [40, 3], [40, 1], [100, 24]]) {
    s.terminal.columns = width!; s.terminal.rows = height!;
    const first = s.frame();
    if (height! < 3) { expect(first.join(" ")).toContain("Resize"); s.key("\r"); }
    else {
      expect(first.some(line => line.trim() === "→ On")).toBe(true);
      const viewed = [...first];
      for (let i = 0; i < 80; i++) { s.key("\x1b[6~"); viewed.push(...s.frame()); }
      expect(viewed.join(" ")).toContain("Final detail:");
      for (let i = 0; i < 80; i++) { s.key("\x1b[5~"); s.frame(); }
    }
  }
  s.key("\x1b"); expect(await result).toBeUndefined();
});

test("injected remapped keys and legacy j/k navigation are honored", () => {
  const selected: unknown[] = [];
  const kb = new KeybindingsManager({ "tui.select.down": "ctrl+n", "tui.select.confirm": "ctrl+y", "tui.select.cancel": "ctrl+x" });
  const panel = new SessionPanel(overview, actions, () => 24, { fg: (_color, text) => text }, kb, value => selected.push(value), () => {});
  panel.render(40); panel.handleInput("\x0e"); panel.handleInput("j"); panel.handleInput("k"); panel.handleInput("\x19");
  expect(selected).toEqual(["Runs"]); panel.handleInput("\x18"); expect(selected).toEqual(["Runs", undefined]);
});

// Legacy Ctrl+J is the same byte as LF; CSI u also represents Ctrl+J unambiguously.
const oldConfirmKeys = ["\r", "\n", "\x1b[106;5u"];

test.each([{ binding: "ctrl+y" }, { binding: [] }])("confirm override $binding rejects old keys for Off and Retry fork", ({ binding }) => {
  const kb = new KeybindingsManager({ "tui.select.confirm": binding });
  for (const action of ["Off", "Retry fork"]) {
    const done = vi.fn();
    const panel = new SessionPanel(overview, [action], () => 24, { fg: (_color, text) => text }, kb, done, () => {});
    const help = panel.render(80).join("\n");
    expect(help).toContain(binding === "ctrl+y" ? "ctrl+y Open" : "disabled Open");
    expect(help).not.toContain("enter Open");
    for (const key of oldConfirmKeys) {
      expect(kb.matches(key, "tui.select.confirm")).toBe(false);
      panel.handleInput(key);
      expect(done).not.toHaveBeenCalled();
    }
    panel.handleInput("\x19");
    expect(done.mock.calls).toEqual(binding === "ctrl+y" ? [[action]] : []);
    panel.handleInput("\x1b");
    expect(done.mock.calls.at(-1)).toEqual([undefined]);
  }
});

test("default confirmation follows Pi manager for legacy CR/LF and encoded Ctrl+J", () => {
  const kb = new KeybindingsManager();
  for (const [key, confirms] of [["\r", true], ["\n", true], ["\x1b[106;5u", false]] as const) {
    const done = vi.fn();
    let height = 3;
    const panel = new SessionPanel(overview, ["Off"], () => height, { fg: (_color, text) => text }, kb, done, () => {});
    panel.render(40);
    expect(kb.matches(key, "tui.select.confirm")).toBe(confirms);
    panel.handleInput(key);
    expect(done.mock.calls).toEqual(confirms ? [["Off"]] : []);
    done.mockClear(); height = 1; // Guard must apply before the next resize render.
    panel.handleInput(key); expect(done).not.toHaveBeenCalled();
    panel.handleInput("\x1b"); expect(done.mock.calls).toEqual([[undefined]]);
  }
});

test.each([{ binding: "ctrl+y" }, { binding: [] }])("Retry fork has no side effect from old confirmation keys with override $binding", async ({ binding }) => {
  const h = host();
  try {
    await h.turn(); h.ctx.mode = "tui"; h.ctx.hasUI = true;
    h.memory.store.suppressFork(1, "2026-09-11T00:00:00Z");
    const before = h.memory.store.forkSuppression(1);
    const s = screenHarness(40, 24); h.ctx.ui.custom = s.ctx.ui.custom;
    s.kb.setUserBindings({ "tui.select.confirm": binding });
    h.answers.push("Current session"); const command = h.commands.get("trace").handler("", h.ctx);
    await new Promise(resolve => setImmediate(resolve));
    for (let i = 0; i < 4; i++) s.key("j");
    expect(s.frame().some(line => line.trim() === "→ Retry fork")).toBe(true);
    for (const key of oldConfirmKeys) {
      s.key(key); await new Promise(resolve => setImmediate(resolve));
      expect(h.memory.store.forkSuppression(1)).toEqual(before);
    }
    s.key("\x1b[6~"); s.frame(); s.key("\x1b[5~");
    expect(s.frame().some(line => line.trim() === "→ Retry fork")).toBe(true);
    s.key("\x19"); await new Promise(resolve => setImmediate(resolve));
    expect(h.memory.store.forkSuppression(1)).toEqual(binding === "ctrl+y" ? null : before);
    s.key("\x1b"); await command;
    expect(h.requests).toEqual([]);
  } finally { await h.dispose(); }
});

test("actual TUI command opens custom panel, reflow never scans, and Escape writes nothing", async () => {
  const h = host();
  try {
    await h.turn(); h.ctx.mode = "tui"; h.ctx.hasUI = true;
    const s = screenHarness(100, 24); h.ctx.ui.custom = s.ctx.ui.custom;
    const snapshot = () => JSON.stringify(h.memory.store.db.prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name").all()
      .map(row => [row.name, h.memory.store.db.prepare(`SELECT * FROM "${row.name}"`).all()]));
    const before = snapshot(), entries = structuredClone(h.entries), footer = h.statuses.get("trace-memory");
    h.answers.push("Current session"); const command = h.commands.get("trace").handler("", h.ctx);
    await new Promise(resolve => setImmediate(resolve));
    const prepare = vi.spyOn(DatabaseSync.prototype, "prepare");
    try {
      expect(s.frame().join("\n")).toContain("test");
      s.terminal.columns = 40; expect(s.frame().join("\n")).toContain("test");
      for (let i = 0; i < 10; i++) { s.key("\x1b[6~"); s.frame(); }
      s.key("\x1b"); await command;
      expect(prepare).not.toHaveBeenCalled();
    } finally { prepare.mockRestore(); }
    expect(snapshot()).toBe(before); expect(h.entries).toEqual(entries); expect(h.requests).toEqual([]);
    expect(h.statuses.get("trace-memory")).toBe(footer);
  } finally { await h.dispose(); }
});

test("Current session is inert with eligible native Dreamer work; the next turn still executes it", async () => {
  const h = host({ "noting.triggerTokens": 1_000_000, "consolidation.triggerTokens": 1_000_000, "dreaming.triggerTokens": 1 });
  try {
    await h.turn();
    const store = h.memory.store;
    const noted = store.commitNotingRun({ run: { kind: "manual", sessionId: 1, createdAt: "test" }, facts: [
      { turnId: 1, category: "decision", actor: "user", text: "Remember the choice", source: ["T1#user"], createdAt: "test" },
    ] });
    if (!noted.ok) throw Error(noted.problems.join());
    const created = store.commitConsolidationRun({ run: { kind: "manual", sessionId: 1, createdAt: "test" }, operations: [
      { op: "create", handle: "$1", author: "test", text: "Remember the choice", category: "constraint", scope: "project", supports: [noted.facts[0]!.id], topics: [], reason: "initial", createdAt: "test" },
    ] });
    if (!created.ok) throw Error(created.problems.join());
    const item = created.committed[0]!;
    store.db.exec("DELETE FROM knowledge_weights");
    h.provider(async conversation => {
      expect(conversation.systemPrompt).toMatch(/^# Dreamer/);
      return { ...reply(""), stopReason: "toolUse", content: [{ type: "toolCall", id: "archive", name: "memory", arguments: {
        operations: [{ op: "archive", id: `K${item.knowledgeId}@${item.commit}`, supports: [], reason: "Retire active memory; preserve history" }], skipped: [],
      } }] };
    });
    h.ctx.mode = "tui"; h.ctx.hasUI = true;
    const s = screenHarness(40, 24); h.ctx.ui.custom = s.ctx.ui.custom;
    const snapshot = () => JSON.stringify(store.db.prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name").all()
      .map(row => [row.name, store.db.prepare(`SELECT * FROM "${row.name}"`).all()]));
    const before = snapshot(), entries = structuredClone(h.entries), requests = h.requests.length;
    const footer = h.statuses.get("trace-memory");
    h.answers.push("Current session"); const command = h.commands.get("trace").handler("", h.ctx);
    await new Promise(resolve => setImmediate(resolve));
    const viewed = [...s.frame()];
    for (let i = 0; i < 10; i++) { s.key("\x1b[6~"); viewed.push(...s.frame()); }
    expect(viewed.join(" ")).toMatch(/Dreaming\s+.*1.*\//);
    s.key("\x1b"); await command; await h.drain();
    expect(snapshot()).toBe(before); expect(h.entries).toEqual(entries);
    expect(h.requests).toHaveLength(requests); expect(h.statuses.get("trace-memory")).toBe(footer);
    expect(store.db.prepare("SELECT * FROM knowledge_weights").all()).toEqual([]);
    h.ctx.hasUI = false;
    await h.turn(); await h.drain();
    const runs = store.listRuns(1).filter(run => run.kind === "dreaming");
    expect(runs).toHaveLength(1); expect(runs[0]!.outcome).toBe("success"); expect(runs[0]!.mode).toBe("subagent");
    expect(h.requests.length).toBeGreaterThan(requests);
    const archive = store.listCommitsByRun(runs[0]!.id)[0]!;
    expect(archive.supports).toEqual([]); expect(store.isKnowledgeProcessed(archive.id)).toBe(true);
    expect(store.db.prepare("SELECT * FROM knowledge_weights").all().length).toBeGreaterThan(0);
  } finally { await h.dispose(); }
});

test("TUI keyboard actions retain confirmations, inputs and conditional Retry fork", async () => {
  const h = host();
  try {
    await h.turn(); h.ctx.mode = "tui"; h.ctx.hasUI = true;
    const s = screenHarness(40, 24); h.ctx.ui.custom = s.ctx.ui.custom;
    const choose = async (label: string, answers: (string | boolean | undefined)[] = []) => {
      h.answers.push("Current session", ...answers);
      const command = h.commands.get("trace").handler("", h.ctx);
      await new Promise(resolve => setImmediate(resolve));
      for (let i = 0; i < 5 && !s.frame().some(line => line.trim() === `→ ${label}`); i++) s.key("j");
      expect(s.frame().some(line => line.trim() === `→ ${label}`)).toBe(true);
      s.key("\r"); await command;
    };
    await choose("Off", [false]); expect(h.memory.store.enabled(1)).toBe(true);
    await choose("Off", [true]); expect(h.memory.store.enabled(1)).toBe(false);
    await choose("On", [true]); expect(h.memory.store.enabled(1)).toBe(true);
    await choose("Runs", ["3"]); expect(h.notices.at(-1)).toContain("no runs yet");
    await choose("Project", ["overlay-project"]); expect(h.notices.at(-1)).toContain("project: overlay-project (mark)");
    await choose("Mark", ["K1", "verified"]); expect(h.notices.at(-1)).toContain("address does not exist");
    h.memory.store.suppressFork(1, "2026-09-11T00:00:00Z");
    await choose("Retry fork"); expect(h.memory.store.forkSuppression(1)).toBeNull();
    expect(h.memory.store.enabled(1)).toBe(true); expect(h.requests).toEqual([]);
    h.answers.push("Current session"); const command = h.commands.get("trace").handler("", h.ctx);
    await new Promise(resolve => setImmediate(resolve));
    expect(s.frame().some(line => line.trim() === "Retry fork")).toBe(false);
    s.key("\x1b"); await command;
  } finally { await h.dispose(); }
});

test.each([40, 80, 100].flatMap(width => ["fullscreen", "regular"].map(mode => ({ width, mode: mode as "fullscreen" | "regular" }))))("actual Current session first viewport at $width x 24 $mode", async ({ width, mode }) => {
  const h = host({ "noting.triggerTokens": 50 });
  try {
    await h.turn(); h.setContextUsage({ tokens: 44500, contextWindow: 1000000, percent: 4.45 });
    h.ctx.mode = "tui"; h.ctx.hasUI = true;
    const s = screenHarness(width, 24, mode); h.ctx.ui.custom = s.ctx.ui.custom;
    h.answers.push("Current session"); const command = h.commands.get("trace").handler("", h.ctx);
    await new Promise(resolve => setImmediate(resolve));
    const first = s.frame().map(line => line.trimEnd()).join("\n");
    expect(first).toContain("~44.5k / 1M (4.5%)");
    expect(first).toContain("fake/test");
    expect(first).toContain("S1 | On(default) | $0.0000");
    expect(first).toContain("Project: pi:pi-test (undeclared)");
    expect(first).not.toMatch(/100 cells|Pi estimate|worker readiness|Forks or clones/);
    expect(first).toContain("Noting        █████░░░░░  52.0% 26/50");
    expect(first).toContain("Dreaming      ░░░░░░░░░░");
    expect(first).toContain("Consolidation ░░░░░░░░░░");
    expect(first).toContain("Free 955.5k (95.5%)");
    expect(first).not.toContain("Scroll");
    expect(first).toMatchSnapshot();
    s.key("\x1b[6~");
    expect(s.frame().map(line => line.trimEnd()).join("\n")).toMatchSnapshot();
    s.key("\x1b"); await command;
  } finally { await h.dispose(); }
});

test.each([40, 80, 100])("long project and actual recovery remain reachable at %i x 24", async width => {
  const h = host();
  try {
    await h.turn();
    const project = "long-project-".repeat(12) + "END";
    const provider = "long-provider-".repeat(8) + "PROVIDER-END";
    const model = "long-model-".repeat(8) + "MODEL-END";
    h.ctx.model = { ...h.ctx.model!, provider, id: model };
    await h.commands.get("trace").handler(`project ${project}`, h.ctx);
    const store = h.memory.store;
    for (let i = 0; i < 3; i++) {
      const execution = store.beginExecution({ sessionId: 1, phase: "noting", head: 1 });
      const run = store.recordRun({ kind: "noting", sessionId: 1, executionId: execution, outcome: "failure", createdAt: "now" });
      store.settleExecution(execution, "failure", run.id, "incomplete submission");
    }
    store.suppressFork(1, "2026-09-11T00:00:00Z");
    h.ctx.mode = "tui"; h.ctx.hasUI = true;
    const s = screenHarness(width, 24); h.ctx.ui.custom = s.ctx.ui.custom;
    h.answers.push("Current session"); const command = h.commands.get("trace").handler("", h.ctx);
    await new Promise(resolve => setImmediate(resolve));
    expect(s.frame().join(" ")).toContain("Automatic off:");
    const seen: string[] = [];
    for (let i = 0; i < 10; i++) {
      const frame = s.frame(); seen.push(...frame);
      for (const label of actions) expect(frame.some(line => line.trim().replace(/^→ /, "") === label)).toBe(true);
      s.key("\x1b[6~");
    }
    const text = seen.join(" ").replace(/\s+/g, " ");
    for (const phrase of ["Use /trace on to resume.", "Retry fork", "Off; stored evidence only", "Dreaming", "END"])
      expect(text).toContain(phrase);
    expect(seen.join("").replace(/\s+/g, "")).toContain(project);
    for (const chunk of wrapTextWithAnsi(`${provider}/${model}`, width >= 80 ? width - 42 : width))
      expect(seen.join("\n")).toContain(chunk);
    s.key("\x1b"); await command;
  } finally { await h.dispose(); }
});

test("every new Pi runtime import has a declared peer and matching lock metadata", () => {
  const manifest = JSON.parse(readFileSync(new URL("../../../package.json", import.meta.url), "utf8"));
  const lock = JSON.parse(readFileSync(new URL("../../../package-lock.json", import.meta.url), "utf8"));
  expect(manifest.peerDependencies["@earendil-works/pi-tui"]).toBe("*");
  expect(lock.packages[""].peerDependencies).toEqual(manifest.peerDependencies);
});
