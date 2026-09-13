// 19c: one Noting task, committed through the only runner there is — a real Pi child `AgentSession`
// built by hosts/pi/native.ts, with the provider stubbed at the wire (test-host.ts). Nothing here
// touches a network or a credential.
import assert from "node:assert/strict";
import { existsSync, mkdirSync } from "node:fs";
import { createRequire } from "node:module";
import { join, resolve } from "node:path";
import { host, notingFact, reply } from "./test-host.ts";
import { TuiAltScreen, getKeybindings, stripTerminalSequences } from "@earendil-works/pi-tui";

// Package smoke supplies the installed entry. Node refuses native type stripping under node_modules;
// use Pi's installed TS loader instead, as Pi does for packaged extensions. No bundled loader dependency.
const piRequire = createRequire(import.meta.resolve("@earendil-works/pi-coding-agent"));
const { createJiti } = piRequire("jiti");
// Pi's extension loader supplies this documented module even in an isolated package consumer.
// Match that alias in this factory seam; production discovery is checked separately by package-smoke.
const extension = process.argv[2] ? (await createJiti(import.meta.url, {
  alias: { "@earendil-works/pi-tui": piRequire.resolve("@earendil-works/pi-tui") },
}).import(resolve(process.argv[2]))).default : undefined;
const h = host({ "noting.triggerTokens": 30 }, { extension });
try {
  // The default data directory must never be interpreted as a project marker file.
  mkdirSync(join(h.dir, ".trace-memory"));
  assert.deepEqual([...h.tools.keys()], ["trace", "search", "note", "memory"]);
  h.provider(async conversation => notingFact(conversation));
  await h.emit("session_start");
  await h.turn();
  const runs = h.memory.store.listRuns(1);
  assert.equal(runs.length, 1);
  assert.equal(runs[0]!.kind, "noting");
  assert.equal(runs[0]!.outcome, "success");
  assert.deepEqual(JSON.parse(runs[0]!.request!), h.requests.at(-1));
  const response = JSON.parse(runs[0]!.response!);
  // 24c: the default worker log is a direct child of `<agent dir>/sessions/trace-memory`.
  assert.equal(response.nativeLog && join(response.nativeLog, ".."), join(process.env.PI_CODING_AGENT_DIR!, "sessions", "trace-memory"), "the run links the native child log under Pi's sessions tree");
  assert.ok(existsSync(response.nativeLog), "the child wrote its own session file");
  const facts = h.memory.store.listSessionFacts(1);
  assert.equal(facts.length, 1);
  assert.equal(facts[0]!.text, "用 pnpm，不要 npm");
  assert.ok(h.memory.store.sourcePath(1, "main", 1).every(e => h.memory.store.entryNoted(e.id)));
  // 24b: the shipped command surface, through the same entry (the package smoke runs the installed one).
  const trace = (args: string) => h.commands.get("trace").handler(args, h.ctx);
  const requestsBeforePanel = h.requests.length;
  h.setContextUsage({ tokens: 1, contextWindow: 200000, percent: 0 });
  await trace("");
  assert.ok(h.notices.at(-1)!.includes("~1 / 200k tokens (<0.1%)"));
  assert.ok(h.notices.at(-1)!.includes("grid colors project"));
  assert.ok(h.notices.at(-1)!.includes("proportions to SDK occupancy."));
  assert.ok(h.notices.at(-1)!.includes("Free ~200k (<100% window)"));
  assert.ok(!h.notices.at(-1)!.includes("Difference"));
  assert.ok(h.notices.at(-1)!.includes("Estimated usage by category"));
  assert.ok(!h.notices.at(-1)!.includes("?".repeat(20)));
  assert.ok(!h.notices.at(-1)!.includes("Pi rebuilt text estimate"));
  h.setContextUsage({ tokens: 44500, contextWindow: 200000, percent: 22.25 });
  const terminal = { columns: 40, rows: 24, write() {}, hideCursor() {}, showCursor() {} };
  const tui = new TuiAltScreen(terminal as never, false);
  tui.requestRender = () => {};
  h.ctx.ui.custom = async (factory, options) => {
    assert.equal(options?.overlay, true, "installed panel must escape the editor dock");
    const theme = { fg: (_color: string, text: string) => text, getFgAnsi: () => "", getColorMode: () => "truecolor" };
    let cancelled = false;
    const component = await factory(tui, theme as never, getKeybindings() as never, value => {
      assert.equal(value, undefined); cancelled = true;
    });
    const handle = tui.showOverlay(component, typeof options.overlayOptions === "function" ? options.overlayOptions() : options.overlayOptions);
    try {
      const seen: string[] = [];
      for (let page = 0; page < 10; page++) {
        // Real Pi compositor: no tests of merely unbounded component.render().
        const screen = (tui as any).compositeOverlays(Array(24).fill("background"), terminal.columns, terminal.rows);
        assert.equal(screen.length, terminal.rows);
        const plain = screen.map(stripTerminalSequences);
        assert.ok(!plain.some((line: string) => line.includes("background")), "open overlay must cover every viewport row");
        for (const action of ["Off", "Runs", "Project", "Mark"])
          assert.ok(plain.some((line: string) => line.trim().replace(/^→ /, "") === action));
        seen.push(...plain); component.handleInput?.("\x1b[6~");
      }
      assert.ok(seen.join(" ").includes("Pending / trigger (~tokens)") && seen.join(" ").includes("Dreaming      ░░░░░░░░░░"));
      assert.ok(seen.join(" ").includes("⛶") && !seen.join(" ").includes("not task completion or worker"));
      assert.ok(!seen.join(" ").includes("Memory ~0"));
      assert.ok(!seen.join(" ").includes("Pi rebuilt text estimate"));
      assert.ok(seen.join(" ").includes("Estimated usage by category"));
      assert.ok(seen.join(" ").includes("Tools ~"));
      component.handleInput?.("\x1b"); assert.ok(cancelled);
    } finally { handle.hide(); component.dispose?.(); }
    return undefined as never;
  };
  h.ctx.mode = "tui"; h.ctx.hasUI = true; h.answers.push("Current session"); await trace(""); h.ctx.hasUI = false;
  assert.equal(h.requests.length, requestsBeforePanel, "opening/cancelling Current session calls no model");
  await trace("off");
  assert.ok(h.memory.status(1).includes("Disabled (explicit choice)"), "/trace off disables this session at once");
  assert.equal(h.statuses.get("trace-memory"), "🧠 <dim>○ off</dim>", "the off footer is the compact line (the fake host's theme marks the role)");
  await trace("on");
  assert.ok(h.memory.status(1).includes("Enabled (explicit choice)"), "/trace on re-enables it without a reload");
  await trace("stop");                       // one retained form, headless
  assert.ok(h.notices.at(-1)!.startsWith("Trace Memory:"), "/trace stop is answered");
  await trace("project smoke-project");      // and a second one, with its argument
  assert.ok(h.notices.at(-1)!.includes("project: smoke-project (mark)"), "/trace project declares the project");
  await trace("enable");                     // retired: the usage, and no change
  assert.ok(h.notices.at(-1)!.includes("is not a command form") && h.notices.at(-1)!.includes("/trace on"), "a retired subcommand prints the usage");
  assert.ok(h.memory.status(1).includes("Enabled (explicit choice)"), "and changes nothing");
  console.log(`Pi smoke passed on Node ${process.versions.node}: one native noting run, one fact committed, /trace on|off and the retained forms.`);
} finally {
  await h.dispose();
}

// 32f: the distributable must reach native Dreamer through actual bounded compaction recovery.
const dreamer = host({ "noting.triggerTokens": 1_000_000, "consolidation.triggerTokens": 1_000_000,
  "dreaming.triggerTokens": 5000, "compaction.overflowTokens": 50 }, { extension });
try {
  dreamer.memory.setKnowledgeBudget("global", 0);
  dreamer.memory.setKnowledgeBudget("project", 0);
  dreamer.memory.setKnowledgeBudget("session", 0);
  await dreamer.emit("session_start"); await dreamer.turn();
  const store = dreamer.memory.store;
  const facts = store.commitNotingRun({ run: { kind: "manual", sessionId: 1, createdAt: "smoke" }, facts: [{ turnId: 1, category: "decision", actor: "user", text: "Remember the choice", source: ["T1#user"], createdAt: "smoke" }] });
  assert.ok(facts.ok);
  const created = store.commitConsolidationRun({ run: { kind: "manual", sessionId: 1, createdAt: "smoke" }, operations: [{ op: "create", handle: "$1", author: "smoke", text: "Remember the choice ".repeat(2000), category: "constraint", scope: "project", supports: [facts.facts[0]!.id], topics: [], reason: "initial", createdAt: "smoke" }] });
  assert.ok(created.ok);
  const item = created.committed[0]!;
  dreamer.provider(async conversation => {
    assert.ok(conversation.systemPrompt?.startsWith("# Dreamer"));
    assert.ok(!conversation.tools?.some(t => t.name === "note"));
    return { ...reply(""), stopReason: "toolUse", content: [{ type: "toolCall", id: "archive", name: "memory", arguments: { operations: [{ op: "archive", id: `K${item.knowledgeId}@${item.commit}`, supports: [], reason: "Deliberate active-memory retirement; history preserved" }], skipped: [] } }] };
  });
  const compacted = await dreamer.emit("session_before_compact", { preparation: { tokensBefore: 100000 } });
  assert.ok(compacted?.compaction?.details?.traceMemory, "recovery returns the exact custom carrier");
  const composition = compacted.compaction.details.traceMemory.composition;
  assert.equal(composition.bodyHash.length, 64);
  assert.ok(composition.raw > 0, "installed compaction carries assembly-time Raw estimates");
  const runs = store.listRuns(1).filter(run => run.kind === "dreaming");
  assert.equal(runs.length, 1);
  assert.equal(runs[0]!.outcome, "success");
  assert.equal(runs[0]!.mode, "subagent");
  const archive = store.listCommitsByRun(runs[0]!.id)[0]!;
  assert.equal(archive.actorRole, "dreaming");
  assert.deepEqual(archive.supports, []);
  assert.ok(store.isKnowledgeProcessed(archive.id));
  assert.ok(dreamer.memory.trace(`K${item.knowledgeId}`).includes("maintenance judgment"));
  assert.ok(dreamer.notices.some(n => n.includes("compaction preparing")));
  assert.ok(!dreamer.notices.some(n => n.includes("compaction used")), "before returning a carrier is not persisted success");
  const entry = dreamer.compaction(compacted.compaction.summary, { details: compacted.compaction.details });
  await dreamer.emit("session_compact", { compactionEntry: entry, fromExtension: true, reason: "manual", willRetry: false });
  assert.ok(dreamer.notices.at(-1)!.includes("compaction used bounded entry views (after recovery: Dreamer)"));
  const requestsAfterRecovery = dreamer.requests.length;
  await dreamer.commands.get("trace").handler("", dreamer.ctx);
  assert.ok(dreamer.notices.at(-1)!.includes("Compaction: bounded entry views (after recovery: Dreamer)"));
  assert.equal(dreamer.requests.length, requestsAfterRecovery, "reading the persisted recovery warning starts no worker");
  console.log("Dreamer recovery smoke passed: native fresh child, immediate trusted archive, final certification, persisted custom carrier and read-only success status.");
} finally { await dreamer.dispose(); }

// 22b: the long-history regression, on the same entry the case above used — the installed one under
// the package smoke. Enabling memory on an existing conversation imports it once, every tool result
// finds its own Turn's call although every call id repeats, and the ordinary boundary after it costs
// what it added. The rescan this replaced grew with the square of the history, so the gate is the
// scaling of two sizes rather than one wall-clock sample: two and a half times the history may not
// cost three times the time.
const payload = "word ".repeat(1_600);
const importOf = async (turns: number) => {
  const long = host({ "noting.triggerTokens": 1_000_000_000 }, { extension });
  long.setHeaderTimestamp("2000-01-01T00:00:00Z"); // disabled by default: enabling is the explicit import
  await long.emit("session_start");
  for (let t = 1; t <= turns; t++) {
    long.persist({ role: "user", content: `question ${t}`, timestamp: t });
    long.persist({ role: "assistant", content: [{ type: "text", text: `answer ${t}` }, { type: "toolCall", id: "shared-call", name: "bash", arguments: { command: `run ${t}` } }], timestamp: t });
    long.persist({ role: "toolResult", toolCallId: "shared-call", toolName: "bash", content: [{ type: "text", text: `result ${t} ${payload}` }], isError: false, timestamp: t });
  }
  const started = performance.now();
  await long.commands.get("trace").handler("on", long.ctx);
  return { long, turns, ms: performance.now() - started };
};
const small = await importOf(200), large = await importOf(500);
try {
  const store = large.long.memory.store;
  const calls = store.listTurns(1).flatMap(turn => store.listToolCalls(turn.id));
  assert.equal(store.listSourceEntries(1).length, large.turns * 3);
  assert.equal(calls.length, large.turns);
  assert.ok(calls.every((call, i) => call.status === "success" && JSON.parse(call.result!).content[0].text.startsWith(`result ${i + 1} `)),
    "every tool result completed its own Turn's call");
  assert.deepEqual(large.long.notices.filter(notice => notice.includes("missing native history")), []);
  assert.deepEqual(large.long.requests, []);
  assert.ok(large.ms < 3 * small.ms + 250, `the import grew faster than the history: ${small.turns * 3} entries in ${small.ms.toFixed(0)} ms, ${large.turns * 3} in ${large.ms.toFixed(0)} ms`);
  assert.ok(large.ms < 5_000, `the one-time import of ${large.turns * 3} entries took ${large.ms.toFixed(0)} ms`);
  // Warm-up: the imported history is taken, so the boundary below is the ordinary case. No model.
  const head = large.long.entries.filter(e => e.customType === "trace-memory").at(-1)!.data.head;
  const committed = store.commitNotingRun({ run: { kind: "noting", sessionId: 1, branch: "main", rangeFrom: "S1/T1", rangeTo: `S1/T${head}`, createdAt: "warm-up" },
    facts: [], entryIds: large.long.memory.pendingEntries(1, "main", head).map(e => e.id) });
  assert.ok(committed.ok, "the warm-up commit must succeed");
  large.long.persist({ role: "user", content: "one short follow-up", timestamp: large.turns + 1 });
  large.long.persist({ role: "assistant", content: [{ type: "text", text: "a short answer" }], timestamp: large.turns + 1 });
  const startedBoundary = performance.now();
  await large.long.emit("agent_end");
  const boundaryMs = performance.now() - startedBoundary;
  assert.equal(store.listSourceEntries(1).length, large.turns * 3 + 2);
  assert.ok(boundaryMs < 1_000, `an ordinary boundary after ${large.turns * 3} entries took ${boundaryMs.toFixed(0)} ms`);
  assert.deepEqual(large.long.requests, []);
  console.log(`Long-history regression passed: ${small.turns * 3} entries imported in ${small.ms.toFixed(0)} ms, ${large.turns * 3} in ${large.ms.toFixed(0)} ms, ordinary boundary ${boundaryMs.toFixed(0)} ms.`);
} finally {
  await small.long.dispose();
  await large.long.dispose();
}
