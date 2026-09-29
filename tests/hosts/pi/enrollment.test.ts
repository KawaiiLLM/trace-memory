import { once } from "node:events";
import { spawn } from "node:child_process";
import { afterEach, expect, test } from "vitest";
import { readFileSync, writeFileSync, mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { host, reply, notingFact } from "./test-host.ts";
import { TraceMemory, DEFAULT_CONFIG } from "../../../src/core/api/index.ts";
import { compacted , hydrate } from "../../source-fixture.ts";
import { fact } from "../../support/seed.ts";
const hosts: ReturnType<typeof host>[] = [];
const setup = (config: Record<string, unknown> = {}) => { const h = host(config); hosts.push(h); return h; };
afterEach(async () => { for (const h of hosts.splice(0)) await h.dispose(); });
const command = (h: ReturnType<typeof host>, args: string) => h.commands.get("trace").handler(args, h.ctx);
const state = (h: ReturnType<typeof host>) => h.entries.filter(e => e.customType === "trace-memory").at(-1).data;
const seedFact = (h: ReturnType<typeof host>, text: string) => {
  const store = h.memory.store;
  const user = store.sourcePath(1, "main", 1).find(entry => store.getSourceEntry(entry.id)?.role === "user")!;
  return fact(h.memory, store.knowledgePath(1, "main", 1), text,
    [{ entry: store.getSourceEntry(user.id)!, text }]);
};

test.each(["before", "after", "equal", "missing", "malformed"])("18a 2026-09-08: native header default (%s), never first-seen time", async kind => {
  const h = setup();
  await h.emit("session_start");
  const path = join(h.dir, "agent", "trace-memory-baseline.json");
  const baseline = JSON.parse(readFileSync(path, "utf8"));
  h.entries.length = 0; h.allEntries.length = 0;
  rmSync(join(h.dir, "agent", "trace-memory-enrollment"), { recursive: true, force: true });
  h.setHeaderTimestamp(kind === "before" ? "2000-01-01T00:00:00Z" : kind === "after" ? "2099-01-01T00:00:00Z" : kind === "equal" ? baseline : kind === "missing" ? undefined : "bad timestamp");
  await h.emit("session_start");
  await command(h, "");
  expect(h.notices.at(-1)).toContain(`· ${kind === "after" ? "On" : "Off"}`);
  expect(h.memory.store.getSession(1)).toBeNull();
  await h.turn();
  expect(!!h.memory.store.getSession(1)).toBe(kind === "after");
  await h.emit("session_start");
  expect(readFileSync(path, "utf8")).toBe(JSON.stringify(baseline));
  expect(h.requests).toEqual([]);
});

test("18a 2026-09-08: provisional toggle, cancel, menu parity and headless status create no artificial Turn", async () => {
  const h = setup(); h.setHeaderTimestamp("2000-01-01T00:00:00Z");
  await h.emit("session_start");
  await command(h, ""); expect(h.notices.at(-1)).toContain("/trace on");
  h.ctx.hasUI = true;
  h.answers.push("Turn on", false);
  await command(h, ""); expect(state(h).enrollment.choice).toBeNull();
  h.answers.push("Turn on", true);
  await command(h, "");
  expect(h.memory.store.getSession(1)).toBeNull();
  await h.emit("session_start");
  h.ctx.hasUI = false; // 24b: `status` is retired; headless bare /trace is where it is printed
  await command(h, ""); expect(h.notices.at(-1)).toContain("On (explicit)");
  h.ctx.hasUI = true;
  await h.turn();
  expect(h.memory.store.listTurns(1)).toHaveLength(1);
  expect(h.memory.store.getSession(2)).toBeNull();
  expect(h.memory.status(1)).toContain("Enabled (explicit choice)");
  h.answers.push("Turn off", true); await command(h, "");
  expect(h.memory.status(1)).toContain("Disabled (explicit choice)");
  expect(h.statuses.get("trace-memory")).toBe("🧠 <dim>○ off</dim>"); // 24a: the off footer is the compact form
  await command(h, "on"); expect(h.memory.status(1)).toContain("Enabled (explicit choice)");
});

test("18a 2026-09-08: historical import and pause resume use native identities without a model call", async () => {
  const h = setup({ "noting.triggerTokens": 1, "noting.forkModeDefault": false });
  h.setHeaderTimestamp("2000-01-01T00:00:00Z");
  for (let i = 0; i < 3; i++) { h.persist({ role: "user", content: "same", timestamp: i }); h.persist(reply("same answer")); }
  await h.emit("session_start"); expect(h.memory.store.getSession(1)).toBeNull();
  await command(h, "on");
  const imported = h.memory.pendingEntries(1, "main", state(h).head);
  expect(imported).toHaveLength(6); expect(h.memory.store.listTurns(1)).toHaveLength(3);
  expect(h.requests).toEqual([]);
  await command(h, "on"); expect(h.memory.pendingEntries(1, "main", state(h).head)).toEqual(imported);
  await command(h, "off");
  expect(await h.prompt("paused source")).toBeUndefined(); await h.answer("paused answer"); await h.emit("agent_settled");
  expect(h.memory.store.listTurns(1)).toHaveLength(3); expect(h.requests).toEqual([]);
  expect(await h.emit("session_before_tree")).toBeUndefined();
  expect(await h.emit("session_before_compact", { preparation: { tokensBefore: 42 } })).toBeUndefined();
  expect(compacted(h.memory.compact(1))).toBe(""); expect(h.memory.branchSummary(1, "main", 3)).toBe("");
  for (const name of ["note", "memory"]) await expect(h.tools.get(name).execute("id", {}, undefined, undefined, h.ctx)).rejects.toThrow("/trace on");
  expect((await h.tools.get("trace").execute("id", { address: "T1" }, undefined, undefined, h.ctx)).content[0].text).toContain("same");
  expect((await h.tools.get("search").execute("id", { query: "same", layer: "raw" }, undefined, undefined, h.ctx)).content[0].text).toContain("T1");
  await command(h, "on"); expect(h.memory.store.listTurns(1)).toHaveLength(4);
  expect(h.memory.pendingEntries(1, "main", state(h).head)).toHaveLength(8); expect(h.requests).toEqual([]);
  await h.answer("eligible completion"); await h.drain();
  // Joint N explicitly examines facts and knowledge, then terminates normally.
  expect(h.requests).toHaveLength(3); expect(h.memory.pendingEntries(1, "main", state(h).head)).toEqual([]);
});

test("18a 2026-09-08: historical tree and newer clone never overwrite the current shared switch", async () => {
  const h = setup(); await h.turn();
  const old = [...h.entries];
  await command(h, "off");
  h.entries.splice(0, h.entries.length, ...old);
  h.ctx.sessionManager.getSessionId = () => "newer-clone";
  h.setHeaderTimestamp("2099-12-31T00:00:00Z");
  await h.emit("session_tree");
  expect(h.memory.status(1)).toContain("Disabled (explicit choice)");
  expect(await h.prompt("clone remains paused")).toBeUndefined();
  h.ctx.hasUI = true; h.answers.push(undefined); await command(h, "");
  expect(h.dialogs.at(-1)?.title).toContain("Shared identity");
  await command(h, "on");
  h.entries.splice(0, h.entries.length, ...old); await h.emit("session_tree");
  expect(h.memory.status(1)).toContain("Enabled (explicit choice)");
  expect(h.memory.store.getSession(2)).toBeNull();
});

test("18a 2026-09-08: core gates admissions and late commits through another facade; queues and deliveries survive", async () => {
  const h = setup(); await h.turn();
  const other = TraceMemory(join(h.dir, "trace.db"), async () => { throw new Error("No model expected"); });
  try {
    const binding = h.memory.tools({ kind: "manual", sessionId: 1, branch: "main", currentTurnId: 1 });
    other.store.setEnrollment(1, false);
    expect(binding.find(t => t.name === "note")!.execute({ facts: [] })).toContain("/trace on");
    expect(binding.find(t => t.name === "memory")!.execute({ operations: [], skipped: [] })).toContain("/trace on");
    expect(await h.memory.noting({ sessionId: 1, branch: "main", headTurnId: 1 })).toEqual({ outcome: "dropped" });
    expect(await h.memory.dream({ sessionId: 1, branch: "main", headTurnId: 1 })).toEqual({ outcome: "dropped" });
    expect(() => h.memory.appendEntry({ ...hydrate(h.memory.pendingEntries(1, "main", 1), h.memory.store)[0]!, nativeId: "blocked" })).toThrow("/trace on");
    const run = { kind: "noting" as const, sessionId: 1, branch: "main", createdAt: "now" };
    const entries = hydrate(h.memory.pendingEntries(1, "main", 1), h.memory.store);
    expect(h.memory.store.commitNotingRun({ run, facts: [], entryIds: entries.map(e => e.id) }).ok).toBe(false);
    expect(h.memory.store.commitConsolidationRun({ run: { ...run, kind: "manual" }, operations: [] }).ok).toBe(false);
    expect(hydrate(h.memory.pendingEntries(1, "main", 1), h.memory.store)).toEqual(entries);
    expect(h.memory.inject(1)).toBe("");
    other.store.setEnrollment(1, true);
  } finally { other.close(); }
});

test.each([true, false])("18a 2026-09-08: disable during Noting provider call rejects late %s submission and retains pending batch", async submit => {
  const h = setup({ "noting.triggerTokens": 1, "noting.forkModeDefault": false, "noting.maxToolRounds": 1 });
  let release!: (value: ReturnType<typeof reply>) => void;
  h.provider(async () => new Promise(resolve => { release = resolve; }));
  await h.turn();
  await command(h, "off");
  release(submit ? notingFact(h.conversations[0]!) : reply("No facts"));
  await h.drain();
  expect(h.memory.store.listSessionFacts(1)).toEqual([]);
  expect(hydrate(h.memory.pendingEntries(1, "main", 1), h.memory.store)).toHaveLength(2);
  expect(h.memory.store.listRuns(1).every(r => r.outcome !== "success")).toBe(true);
});

// Across both Noter modes, disabling stops automatic material without losing committed work.
// Re-enabling uses the same evidence-aware predicate as every ordinary prompt.
test.each([true, false])("34c: automatic material ignores the Noter mode (%s); disable preserves work and on rechecks evidence coverage", async (noting) => {
  const h = setup({ "noting.forkModeDefault": noting });
  await h.turn();
  // This enrollment/delivery case uses the real immediate manual bindings for committed setup.
  // Live N publication is exercised separately by the host atomic and scheduler tests.
  const tools = h.memory.tools({ kind: "manual", sessionId: 1, branch: "main", currentTurnId: 1 });
  expect(seedFact(h, "Shared rule").text).toBe("Shared rule");
  expect(tools.find(t => t.name === "memory")!.execute({ operations: [{ op: "create", topics: [], reason: "Initial admission",
    text: "Retained shared knowledge", category: "constraint", scope: "global", supports: ["F1"] }], skipped: [] })).not.toContain("rejected:");
  expect((await h.prompt("no receipts"))?.message?.content ?? "").not.toContain("<noted>");
  await h.answer(); await h.emit("agent_settled"); await h.answer("consolidation opportunity"); await h.drain();
  expect(h.memory.store.listVisibleKnowledge(1, 1)).toHaveLength(1);
  expect(h.memory.store.db.prepare("SELECT name FROM sqlite_master WHERE name = 'pending_deliveries'").all()).toEqual([]);
  await command(h, "off");
  expect(await h.prompt("unseen")).toBeUndefined(); await h.answer(); await h.emit("agent_settled");
  expect(h.memory.store.listVisibleKnowledge(0, 1).some(k => k.revision.text === "Retained shared knowledge")).toBe(true);
  await command(h, "on");
  // The complete same-conversation source evidence is still visible after off/on, so 34c suppresses
  // the redundant Knowledge body on both prompts rather than treating `on` as a delivery trigger.
  expect(await h.prompt("resume")).toBeUndefined();
  expect(await h.prompt("again")).toBeUndefined();
});

test("92: Settings shows N/D preferences with effective sources and masked layers; displaying them writes nothing", async () => {
  // N exposes mode/model/thinking; D exposes model/thinking only. Advanced settings remain file-owned.
  const h = setup({ "noting.triggerTokens": 33 });
  const globalPath = join(h.dir, "agent", "settings.json"), projectPath = join(h.dir, ".pi", "settings.json");
  mkdirSync(join(h.dir, ".pi"));
  writeFileSync(globalPath, JSON.stringify({ "trace-memory": { "noting.forkModeDefault": false, "dreaming.model": "fake/test", "render.entryTokens": 222 } }));
  writeFileSync(projectPath, JSON.stringify({ "trace-memory": { "noting.forkModeDefault": true, "render.entryTokens": 333 } }));
  const before = [readFileSync(globalPath), readFileSync(projectPath)];
  await h.emit("session_start"); h.ctx.hasUI = true;
  h.answers.push("Settings…", undefined); await command(h, ""); // opened, then cancelled: inert
  const shown = h.dialogs.at(-1)!.options!;
  expect(shown).toEqual([
    "Global Knowledge budget: 4,000", "Project Knowledge budget: 15,000", "Session Knowledge budget: 1,000",
    "Noter mode: fork (Project setting — this edit will not take effect)",
    "Noter model: follow foreground", "Noter thinking: inherit",
    "Dreamer model: fake/test", "Dreamer thinking: inherit", "Closed sessions: project",
  ]);
  expect(h.dialogs.at(-1)!.title).toContain(join(h.dir, "trace.db"));
  expect(h.dialogs.at(-1)!.title).toContain("knowledge window 20,000 + shared allowance 10,000 = 30,000 max input");
  expect([readFileSync(globalPath), readFileSync(projectPath)]).toEqual(before);
  expect(h.requests).toEqual([]);
  // The advanced keys the menu no longer displays are still loaded and still validated by name.
  writeFileSync(projectPath, JSON.stringify({ "trace-memory": { "render.entryTokens": "not a number" } }));
  await expect(h.emit("session_start")).rejects.toThrow("Invalid render.entryTokens");
  // The obsolete inverse C key is still an explicit load error, never mapped onto N.
  for (const saved of [true, false]) {
    writeFileSync(projectPath, JSON.stringify({ "trace-memory": { "consolidation.subagentModeDefault": saved } }));
    await expect(h.emit("session_start")).rejects
      .toThrow("Removed setting consolidation.subagentModeDefault: Consolidation is retired; remove this key");
    expect(JSON.parse(readFileSync(projectPath, "utf8"))["trace-memory"]).toEqual({ "consolidation.subagentModeDefault": saved }); // refused, never rewritten
  }
  writeFileSync(projectPath, JSON.stringify({ "trace-memory": { "render.entryTokens": DEFAULT_CONFIG.render.entryTokens } }));
  await h.emit("session_start");
});

test("18a 2026-09-08: selecting pre-allocation history keeps the allocated identity and current choice", async () => {
  const h = setup(); await h.emit("session_start");
  const provisional = [...h.entries];
  await h.turn(); await command(h, "off");
  h.entries.splice(0, h.entries.length, ...provisional);
  await h.emit("session_tree");
  expect(state(h).sessionId).toBe(1);
  expect(await h.prompt("still disabled")).toBeUndefined(); await h.answer();
  expect(h.memory.status(1)).toContain("Disabled (explicit choice)");
  expect(h.memory.store.getSession(2)).toBeNull();
  await command(h, "on"); await h.answer("now enabled");
  expect(h.memory.store.getSession(2)).toBeNull();
});

test("18a 2026-09-08: disabled reads retain tool validation before and after allocation", async () => {
  const h = setup(); await h.emit("session_start"); await command(h, "off");
  for (const allocate of [false, true]) {
    if (allocate) { await command(h, "on"); await h.turn(); await command(h, "off"); }
    await expect(h.tools.get("trace").execute("id", { address: "T1", full: "yes" }, undefined, undefined, h.ctx)).rejects.toThrow("full must be boolean");
    await expect(h.tools.get("search").execute("id", { query: "a", unexpected: 1 }, undefined, undefined, h.ctx)).rejects.toThrow("unexpected parameter");
  }
});

test.each(["2099-02-30T00:00:00Z", "2099", "2099-01-01", 4070908800000])("18a 2026-09-08: malformed native creation metadata stays disabled (%s)", async value => {
  const h = setup(); h.setHeaderTimestamp(value); await h.emit("session_start");
  await command(h, ""); expect(h.notices.at(-1)).toContain("· Off");
});

test("18a 2026-09-08: all count/token keys and masked layers validate by key", async () => {
  const h = setup();
  for (const section of ["render", "noting", "dreaming"] as const) for (const [key, value] of Object.entries(DEFAULT_CONFIG[section])) {
    if (typeof value !== "number" || key === "nearThreshold" || key === "maxToolRounds") continue;
    for (const invalid of [0, -1, 1.5, Number.MAX_SAFE_INTEGER + 1, Infinity]) {
      expect(() => TraceMemory(":memory:", async () => reply("") as never, { [section]: { [key]: invalid } })).toThrow(`${section}.${key}`);
    }
  }
  for (const [key, invalid] of [["noting.forkModeDefault", "fork"], ["noting.branchModeDefault", "fork"], ["noting.maxToolRounds", -1], ["noting.nearThreshold", 2], ["noting.triggerAnsweredTurns", 1], ["deliverFacts", true]]) {
    writeFileSync(join(h.dir, "agent", "settings.json"), JSON.stringify({ "trace-memory": { [key as string]: invalid } }));
    await expect(h.emit("session_start")).rejects.toThrow(key as string);
  }
  // An invalid Global value cannot disappear behind a valid environment override.
  const masked = setup({ "noting.triggerTokens": 5 });
  writeFileSync(join(masked.dir, "agent", "settings.json"), JSON.stringify({ "trace-memory": { "noting.triggerTokens": 0 } }));
  await expect(masked.emit("session_start")).rejects.toThrow("noting.triggerTokens");
  writeFileSync(join(masked.dir, "agent", "settings.json"), "{}");
  writeFileSync(join(h.dir, "agent", "settings.json"), "{}");
});

test("18a 2026-09-08: concurrent first initialization and restart keep one atomic baseline", async () => {
  const h = setup();
  const source = `
    import extension from ${JSON.stringify(new URL("../../../src/hosts/pi/index.ts", import.meta.url).href)};
    import { readFileSync } from 'node:fs';
    const hooks = new Map(), entries = [];
    extension({ on: (n, f) => hooks.set(n, f), events: { on() { return () => {}; }, emit() {} }, registerCommand() {}, registerTool() {}, getAllTools: () => [], appendEntry: (customType, data) => entries.push({ type: 'custom', customType, data, id: String(entries.length) }) });
    const ctx = { cwd: process.cwd(), ui: { notify() {}, setStatus() {} }, sessionManager: { getSessionId: () => 'old-native', getHeader: () => ({ timestamp: '2000-01-01T00:00:00Z' }), getBranch: () => entries, getEntries: () => entries, getLeafId: () => null } };
    await hooks.get('session_start')({}, ctx);
    process.stdout.write(readFileSync(process.env.PI_CODING_AGENT_DIR + '/trace-memory-baseline.json', 'utf8'));
    await hooks.get('session_shutdown')({}, ctx);
  `;
  const initialize = async () => {
    const child = spawn(process.execPath, ["--input-type=module", "-e", source], { cwd: h.dir, env: { ...process.env, PI_CODING_AGENT_DIR: join(h.dir, "agent"), TRACE_MEMORY_CONFIG: JSON.stringify({ dbPath: join(h.dir, "trace.db") }) }, stdio: ["ignore", "pipe", "pipe"] });
    let output = "", error = "";
    child.stdout.on("data", data => { output += data; }); child.stderr.on("data", data => { error += data; });
    expect((await once(child, "exit"))[0], error).toBe(0);
    return output;
  };
  const [a, b] = await Promise.all([initialize(), initialize()]);
  expect(a).toBe(b); expect(await initialize()).toBe(a);
  await h.emit("session_start");
  expect(readFileSync(join(h.dir, "agent", "trace-memory-baseline.json"), "utf8")).toBe(a);
});

test("18a 2026-09-08: another process disables before the transaction; prior success survives", async () => {
  const h = setup(); await h.turn();
  const tools = h.memory.tools({ kind: "manual", sessionId: 1, branch: "main", currentTurnId: 1 });
  expect(seedFact(h, "Already committed").id).toBe(1);
  const before = h.memory.store.listRuns(1);
  const child = spawn(process.execPath, ["--input-type=module", "-e", `
    import { TraceMemory } from ${JSON.stringify(new URL("../../../src/core/api/index.ts", import.meta.url).href)};
    const memory = TraceMemory(${JSON.stringify(join(h.dir, "trace.db"))}, async () => { throw Error('unused'); });
    memory.store.setEnrollment(1, false); memory.close();
  `], { stdio: ["ignore", "ignore", "inherit"] });
  expect((await once(child, "exit"))[0]).toBe(0);
  const run = { kind: "noting" as const, sessionId: 1, branch: "main", createdAt: "now" };
  expect(h.memory.store.commitNotingRun({ run, facts: [], entryIds: hydrate(h.memory.pendingEntries(1, "main", 1), h.memory.store).map(e => e.id) }).ok).toBe(false);
  expect(h.memory.store.commitConsolidationRun({ run: { ...run, kind: "manual" }, operations: [] }).ok).toBe(false);
  expect(h.memory.store.consolidationBatch(1, "main", 1).map(f => f.id)).toEqual([1]);
  expect(h.memory.store.listRuns(1).slice(0, before.length)).toEqual(before);
  expect(h.memory.trace("F1")).toContain("Already committed");
  expect(() => h.memory.store.updateTurn(1, { assistantText: "blocked" })).toThrow("/trace on");
  expect(() => h.memory.store.appendToolCall({ turnId: 1, name: "blocked", status: "attempted" })).toThrow("/trace on");
  expect(() => h.memory.selectEntries(1, "main", [])).toThrow("/trace on");
});

test.each([true, false])("92: disable during D rejects late %s mutation and preserves the pending revision", async submit => {
  const h = setup({ "dreaming.triggerTokens": 1 }); await h.turn();
  const tools = h.memory.tools({ kind: "manual", sessionId: 1, branch: "main", currentTurnId: 1 });
  expect(seedFact(h, "Pending knowledge").id).toBe(1);
  expect(tools.find(t => t.name === "memory")!.execute({ operations: [{ op: "create", text: "Retain rule", category: "constraint",
    scope: "session", topics: [], supports: ["F1"], reason: "Seed pending D revision" }], skipped: [] })).not.toContain("rejected:");
  const original = h.memory.store.listKnowledgeRevisions()[0]!;
  let release!: (value: ReturnType<typeof reply>) => void;
  h.provider(async () => new Promise(resolve => { release = resolve; }));
  await h.prompt("next main turn"); await h.answer("D opportunity"); await h.drain(); expect(h.requests).toHaveLength(1);
  await command(h, "off"); h.provider(async () => reply("Stopped"));
  release(submit ? { ...reply(""), stopReason: "toolUse", content: [{ type: "toolCall", id: "memory", name: "memory", arguments: {
    operations: [{ op: "archive", kind: "budget", id: `K${original.knowledgeId}#${h.memory.store.versionTag(original.knowledgeId, original.id)}`, supports: [], reason: "Late mutation" }], skipped: [],
  } }] } : reply("No mutation"));
  await h.drain();
  expect(h.memory.store.listKnowledgeRevisions()).toEqual([original]);
  expect(h.memory.store.listRuns(1).filter(r => r.kind === "dreaming").map(r => r.outcome)).toEqual(["cancelled"]);
  expect(h.memory.store.consolidationBatch(1, "main", 1)).toHaveLength(1); // historical backlog untouched
});


test("18a 2026-09-08: pre-reply choice survives loss of Pi unflushed custom entries", async () => {
  const h = setup(); await h.emit("session_start"); await command(h, "off");
  h.entries.length = 0; h.allEntries.length = 0;
  h.setHeaderTimestamp("2099-12-31T00:00:00Z");
  await h.emit("session_start"); await command(h, "");
  expect(h.notices.at(-1)).toContain("Off (explicit)");
  expect(h.memory.store.getSession(1)).toBeNull();
  await command(h, "on");
  h.entries.length = 0; h.allEntries.length = 0;
  await h.emit("session_start"); await h.turn();
  expect(h.memory.status(1)).toContain("Enabled (explicit choice)");
  expect(h.memory.store.listTurns(1)).toHaveLength(1);
  expect(h.memory.store.getSession(2)).toBeNull();
});

test("19c 2026-09-08: the legacy execution-mode key still selects the mode, and the menu shows the canonical key with its source", async () => {
  // Environment layer, old spelling: it must still turn inherited-context Noting off.
  const h = setup({ "noting.triggerTokens": 1, "noting.branchModeDefault": false });
  await h.emit("session_start");
  await h.turn();
  expect(h.memory.store.listRuns(1).map(r => r.mode)).toEqual(["subagent"]); // the alias selected fresh context
  h.ctx.hasUI = true;
  h.answers.push("Settings…", undefined); await command(h, "");
  expect(h.dialogs.at(-1)!.options).toContain("Noter mode: subagent (Environment setting — this edit will not take effect)"); // canonical key, honest source
  expect(h.dialogs.at(-1)!.options!.join("\n")).not.toContain("branchModeDefault"); // and only the canonical key
});

test("19c 2026-09-08: a legacy key in one layer is masked by the canonical key in a later layer, as any other setting is", async () => {
  const h = setup({ "noting.triggerTokens": 33 });
  const globalPath = join(h.dir, "agent", "settings.json"), projectPath = join(h.dir, ".pi", "settings.json");
  mkdirSync(join(h.dir, ".pi"), { recursive: true });
  writeFileSync(globalPath, JSON.stringify({ "trace-memory": { "noting.branchModeDefault": false } }));
  writeFileSync(projectPath, JSON.stringify({ "trace-memory": { "noting.forkModeDefault": true } }));
  await h.emit("session_start"); h.ctx.hasUI = true;
  h.answers.push("Settings…", undefined); await command(h, "");
  // 18a precedence decides; supplying the two spellings in two layers is migration, not a conflict.
  expect(h.dialogs.at(-1)!.options).toContain("Noter mode: fork (Project setting — this edit will not take effect)");
  writeFileSync(globalPath, "{}"); writeFileSync(projectPath, "{}");
});

test("19c 2026-09-08: one layer supplying both execution-mode spellings with different values fails the load naming both", async () => {
  const h = setup();
  const globalPath = join(h.dir, "agent", "settings.json");
  writeFileSync(globalPath, JSON.stringify({ "trace-memory": { "noting.branchModeDefault": false, "noting.forkModeDefault": true } }));
  await expect(h.emit("session_start")).rejects.toThrow("noting.branchModeDefault");
  await expect(h.emit("session_start")).rejects.toThrow("noting.forkModeDefault");
  // Agreeing values are not a conflict: the canonical key wins and the load succeeds.
  writeFileSync(globalPath, JSON.stringify({ "trace-memory": { "noting.branchModeDefault": false, "noting.forkModeDefault": false } }));
  await h.emit("session_start"); h.ctx.hasUI = true;
  h.answers.push("Settings…", undefined); await command(h, "");
  expect(h.dialogs.at(-1)!.options).toContain("Noter mode: subagent");
  writeFileSync(globalPath, "{}");
});
