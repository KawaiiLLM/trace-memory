import { once } from "node:events";
import { spawn } from "node:child_process";
import { afterEach, expect, test } from "vitest";
import { readFileSync, writeFileSync, mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { host, reply, notingFact } from "./test-host.ts";
import { TraceMemory, DEFAULT_CONFIG } from "../../../src/core/api/index.ts";
import { compacted } from "../../source-fixture.ts";
const hosts: ReturnType<typeof host>[] = [];
const setup = (config: Record<string, unknown> = {}) => { const h = host(config); hosts.push(h); return h; };
afterEach(async () => { for (const h of hosts.splice(0)) await h.dispose(); });
const command = (h: ReturnType<typeof host>, args: string) => h.commands.get("trace").handler(args, h.ctx);
const state = (h: ReturnType<typeof host>) => h.entries.filter(e => e.customType === "trace-memory").at(-1).data;

test.each(["before", "after", "equal", "missing", "malformed"])("18a 2026-09-08: native header default (%s), never first-seen time", async kind => {
  const h = setup();
  await h.emit("session_start");
  const path = join(h.dir, "agent", "trace-memory-baseline.json");
  const baseline = JSON.parse(readFileSync(path, "utf8"));
  h.entries.length = 0; h.allEntries.length = 0;
  rmSync(join(h.dir, "agent", "trace-memory-enrollment"), { recursive: true, force: true });
  h.setHeaderTimestamp(kind === "before" ? "2000-01-01T00:00:00Z" : kind === "after" ? "2099-01-01T00:00:00Z" : kind === "equal" ? baseline : kind === "missing" ? undefined : "bad timestamp");
  await h.emit("session_start");
  await command(h, "status");
  expect(h.notices.at(-1)).toContain(`Enrollment: ${kind === "after" ? "Enabled" : "Disabled"} (default)`);
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
  await command(h, ""); expect(h.notices.at(-1)).toContain("/trace enable");
  h.ctx.hasUI = true;
  h.answers.push("Current session", "Enable", false);
  await command(h, ""); expect(state(h).enrollment.choice).toBeNull();
  h.answers.push("Current session", "Enable", true);
  await command(h, "");
  expect(h.memory.store.getSession(1)).toBeNull();
  await h.emit("session_start");
  await command(h, "status"); expect(h.notices.at(-1)).toContain("Enabled (explicit choice)");
  await h.turn();
  expect(h.memory.store.listTurns(1)).toHaveLength(1);
  expect(h.memory.store.getSession(2)).toBeNull();
  expect(h.memory.status(1)).toContain("Enabled (explicit choice)");
  h.answers.push("Current session", "Disable", true); await command(h, "");
  expect(h.memory.status(1)).toContain("Disabled (explicit choice)");
  expect(h.statuses.get("trace-memory")).toContain("trace-memory Disabled");
  await command(h, "enable"); expect(h.memory.status(1)).toContain("Enabled (explicit choice)");
});

test("18a 2026-09-08: historical import and pause resume use native identities without a model call", async () => {
  const h = setup({ "noting.triggerTokens": 1, "noting.forkModeDefault": false });
  h.setHeaderTimestamp("2000-01-01T00:00:00Z");
  for (let i = 0; i < 3; i++) { h.persist({ role: "user", content: "same", timestamp: i }); h.persist(reply("same answer")); }
  await h.emit("session_start"); expect(h.memory.store.getSession(1)).toBeNull();
  await command(h, "enable");
  const imported = h.memory.pendingEntries(1, "main", state(h).head);
  expect(imported).toHaveLength(6); expect(h.memory.store.listTurns(1)).toHaveLength(3);
  expect(h.requests).toEqual([]);
  await command(h, "enable"); expect(h.memory.pendingEntries(1, "main", state(h).head)).toEqual(imported);
  await command(h, "disable");
  expect(await h.prompt("paused source")).toBeUndefined(); await h.answer("paused answer"); await h.emit("agent_settled");
  expect(h.memory.store.listTurns(1)).toHaveLength(3); expect(h.requests).toEqual([]);
  expect(await h.emit("session_before_tree")).toBeUndefined();
  expect(await h.emit("session_before_compact", { preparation: { tokensBefore: 42 } })).toBeUndefined();
  expect(compacted(h.memory.compact(1))).toBe(""); expect(h.memory.branchSummary(1, "main", 3)).toBe("");
  for (const name of ["note", "memory"]) await expect(h.tools.get(name).execute("id", {}, undefined, undefined, h.ctx)).rejects.toThrow("/trace enable");
  expect((await h.tools.get("trace").execute("id", { address: "T1" }, undefined, undefined, h.ctx)).content[0].text).toContain("same");
  expect((await h.tools.get("search").execute("id", { query: "same", layer: "raw" }, undefined, undefined, h.ctx)).content[0].text).toContain("T1");
  await command(h, "enable"); expect(h.memory.store.listTurns(1)).toHaveLength(4);
  expect(h.memory.pendingEntries(1, "main", state(h).head)).toHaveLength(8); expect(h.requests).toEqual([]);
  await h.answer("eligible completion"); await h.drain();
  expect(h.requests).toHaveLength(1); expect(h.memory.pendingEntries(1, "main", state(h).head)).toEqual([]);
});

test("18a 2026-09-08: historical tree and newer clone never overwrite the current shared switch", async () => {
  const h = setup(); await h.turn();
  const old = [...h.entries];
  await command(h, "disable");
  h.entries.splice(0, h.entries.length, ...old);
  h.ctx.sessionManager.getSessionId = () => "newer-clone";
  h.setHeaderTimestamp("2099-12-31T00:00:00Z");
  await h.emit("session_tree");
  expect(h.memory.status(1)).toContain("Disabled (explicit choice)");
  expect(await h.prompt("clone remains paused")).toBeUndefined();
  h.ctx.hasUI = true; h.answers.push("Current session", undefined); await command(h, "");
  expect(h.dialogs.at(-1)?.title).toContain("Shared identity");
  await command(h, "enable");
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
    expect(binding.find(t => t.name === "note")!.execute({ facts: [] })).toContain("/trace enable");
    expect(binding.find(t => t.name === "memory")!.execute({ operations: [], skipped: [] })).toContain("/trace enable");
    expect(await h.memory.noting({ sessionId: 1, branch: "main", headTurnId: 1 })).toEqual({ outcome: "dropped" });
    expect(await h.memory.consolidate({ sessionId: 1, branch: "main", headTurnId: 1 })).toEqual({ outcome: "dropped" });
    expect(() => h.memory.appendEntry({ ...h.memory.pendingEntries(1, "main", 1)[0]!, nativeId: "blocked" })).toThrow("/trace enable");
    const run = { kind: "noting" as const, sessionId: 1, branch: "main", createdAt: "now" };
    const entries = h.memory.pendingEntries(1, "main", 1);
    expect(h.memory.store.commitNotingRun({ run, facts: [], entryIds: entries.map(e => e.id) }).ok).toBe(false);
    expect(h.memory.store.commitConsolidationRun({ run: { ...run, kind: "consolidation" }, operations: [], consolidated: [] }).ok).toBe(false);
    expect(h.memory.pendingEntries(1, "main", 1)).toEqual(entries);
    expect(h.memory.inject(1)).toBe("");
    other.store.setEnrollment(1, true);
  } finally { other.close(); }
});

test.each([true, false])("18a 2026-09-08: disable during Noting provider call rejects late %s submission and retains pending batch", async submit => {
  const h = setup({ "noting.triggerTokens": 1, "noting.forkModeDefault": false, "noting.maxToolRounds": 1 });
  let release!: (value: ReturnType<typeof reply>) => void;
  h.provider(async () => new Promise(resolve => { release = resolve; }));
  await h.turn();
  await command(h, "disable");
  release(submit ? notingFact(h.conversations[0]!) : reply("No facts"));
  await h.drain();
  expect(h.memory.store.listSessionFacts(1)).toEqual([]);
  expect(h.memory.pendingEntries(1, "main", 1)).toHaveLength(2);
  expect(h.memory.store.listRuns(1).every(r => r.outcome !== "success")).toBe(true);
});

test.each([[true, true], [true, false], [false, true], [false, false]])("18a 2026-09-08: enabled delivery ignores worker modes (%s, %s) and disable preserves unseen deliveries", async (noting, consolidation) => {
  const h = setup({ "noting.forkModeDefault": noting, "consolidation.subagentModeDefault": consolidation });
  await h.turn();
  h.provider(async c => c.systemPrompt!.includes("### Second-round user message") ? { ...reply(""), stopReason: "toolUse", content: [{ type: "toolCall", id: "memory", name: "memory", arguments: {
    operations: [{ op: "create", topics: [], reason: "Initial admission of this conclusion.", text: "Retained shared knowledge", category: "constraint", scope: "global", supports: ["F1"] }], skipped: [] } }] } : h.memory.store.listSessionFacts(1).length ? reply("No new facts") : notingFact(c));
  // The public facade shares this host's durable queues; normal completions drive both workers.
  writeFileSync(join(h.dir, "agent", "settings.json"), JSON.stringify({ "trace-memory": { "noting.triggerTokens": 1, "consolidation.triggerTokens": 1 } }));
  await h.emit("session_start");
  await h.answer("tick"); await h.drain();
  const delivered = await h.prompt("deliver facts"); expect(delivered.message.content).toContain("<noted>");
  await h.answer(); await h.emit("agent_settled"); await h.answer("consolidation opportunity"); await h.drain();
  expect(h.memory.store.listVisibleKnowledge(1, 1)).toHaveLength(1);
  const pending = h.memory.store.listPendingDeliveries(1, "main");
  expect(pending.length).toBeGreaterThan(0);
  await command(h, "disable");
  expect(await h.prompt("unseen")).toBeUndefined(); await h.answer(); await h.emit("agent_settled");
  h.memory.confirmDelivery(pending.map(p => p.runId));
  expect(h.memory.store.listPendingDeliveries(1, "main")).toEqual(pending);
  expect(h.memory.store.listVisibleKnowledge(0, 1).some(k => k.revision.text === "Retained shared knowledge")).toBe(true);
  await command(h, "enable");
  expect((await h.prompt("resume delivery")).message.content).toContain("<consolidated>");
});

test("18a 2026-09-08: read-only settings show precedence, effective defaults and masked values", async () => {
  const h = setup({ "noting.triggerTokens": 33 });
  const globalPath = join(h.dir, "agent", "settings.json"), projectPath = join(h.dir, ".pi", "settings.json");
  mkdirSync(join(h.dir, ".pi"));
  writeFileSync(globalPath, JSON.stringify({ "trace-memory": { "noting.triggerTokens": 11, "render.entryTokens": 222, "consolidation.triggerTokens": 7 } }));
  writeFileSync(projectPath, JSON.stringify({ "trace-memory": { "noting.triggerTokens": 22, "render.entryTokens": 333 } }));
  const before = [readFileSync(globalPath), readFileSync(projectPath)];
  await h.emit("session_start"); h.ctx.hasUI = true;
  h.answers.push("Settings (Global, read-only)"); await command(h, "");
  const shown = h.notices.at(-1)!;
  expect(shown).toContain("noting.triggerTokens: 33 (Environment); Global=11 masked; Project=22 masked");
  expect(shown).toContain("render.entryTokens: 333 (Project)");
  expect(shown).toContain("consolidation.triggerTokens: 7 (Global)");
  expect(shown).toContain(`noting.batchTokens: ${DEFAULT_CONFIG.noting.batchTokens} (Default)`);
  expect([readFileSync(globalPath), readFileSync(projectPath)]).toEqual(before);
});

test("18a 2026-09-08: selecting pre-allocation history keeps the allocated identity and current choice", async () => {
  const h = setup(); await h.emit("session_start");
  const provisional = [...h.entries];
  await h.turn(); await command(h, "disable");
  h.entries.splice(0, h.entries.length, ...provisional);
  await h.emit("session_tree");
  expect(state(h).sessionId).toBe(1);
  expect(await h.prompt("still disabled")).toBeUndefined(); await h.answer();
  expect(h.memory.status(1)).toContain("Disabled (explicit choice)");
  expect(h.memory.store.getSession(2)).toBeNull();
  await command(h, "enable"); await h.answer("now enabled");
  expect(h.memory.store.getSession(2)).toBeNull();
});

test("18a 2026-09-08: disabled reads retain tool validation before and after allocation", async () => {
  const h = setup(); await h.emit("session_start"); await command(h, "disable");
  for (const allocate of [false, true]) {
    if (allocate) { await command(h, "enable"); await h.turn(); await command(h, "disable"); }
    await expect(h.tools.get("trace").execute("id", { address: "T1", full: "yes" }, undefined, undefined, h.ctx)).rejects.toThrow("full must be boolean");
    await expect(h.tools.get("search").execute("id", { query: "a", unexpected: 1 }, undefined, undefined, h.ctx)).rejects.toThrow("unexpected parameter");
  }
});

test.each(["2099-02-30T00:00:00Z", "2099", "2099-01-01", 4070908800000])("18a 2026-09-08: malformed native creation metadata stays disabled (%s)", async value => {
  const h = setup(); h.setHeaderTimestamp(value); await h.emit("session_start");
  await command(h, "status"); expect(h.notices.at(-1)).toContain("Disabled (default)");
});

test("18a 2026-09-08: all count/token keys and masked layers validate by key", async () => {
  const h = setup();
  for (const [section, values] of Object.entries(DEFAULT_CONFIG)) for (const [key, value] of Object.entries(values)) {
    if (typeof value !== "number" || key === "nearThreshold" || key === "maxToolRounds") continue;
    for (const invalid of [0, -1, 1.5, Number.MAX_SAFE_INTEGER + 1, Infinity]) {
      expect(() => TraceMemory(":memory:", async () => reply("") as never, { [section]: { [key]: invalid } })).toThrow(`${section}.${key}`);
    }
  }
  for (const [key, invalid] of [["noting.forkModeDefault", "fork"], ["noting.branchModeDefault", "fork"], ["noting.maxToolRounds", -1], ["consolidation.nearThreshold", 2], ["noting.triggerAnsweredTurns", 1], ["deliverFacts", true]]) {
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
    extension({ on: (n, f) => hooks.set(n, f), registerCommand() {}, registerTool() {}, appendEntry: (customType, data) => entries.push({ type: 'custom', customType, data, id: String(entries.length) }) });
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
  expect(tools.find(t => t.name === "note")!.execute({ facts: [{ category: "observation", actor: "user", text: "Already committed", source: ["T1#user"] }] })).toContain("ok: F1");
  const before = h.memory.store.listRuns(1);
  const child = spawn(process.execPath, ["--input-type=module", "-e", `
    import { TraceMemory } from ${JSON.stringify(new URL("../../../src/core/api/index.ts", import.meta.url).href)};
    const memory = TraceMemory(${JSON.stringify(join(h.dir, "trace.db"))}, async () => { throw Error('unused'); });
    memory.store.setEnrollment(1, false); memory.close();
  `], { stdio: ["ignore", "ignore", "inherit"] });
  expect((await once(child, "exit"))[0]).toBe(0);
  const run = { kind: "noting" as const, sessionId: 1, branch: "main", createdAt: "now" };
  expect(h.memory.store.commitNotingRun({ run, facts: [], entryIds: h.memory.pendingEntries(1, "main", 1).map(e => e.id) }).ok).toBe(false);
  expect(h.memory.store.commitConsolidationRun({ run: { ...run, kind: "consolidation" }, operations: [], consolidated: [1] }).ok).toBe(false);
  expect(h.memory.store.consolidationBatch(1, "main", 1).map(f => f.id)).toEqual([1]);
  expect(h.memory.store.listRuns(1).slice(0, before.length)).toEqual(before);
  expect(h.memory.trace("F1")).toContain("Already committed");
  expect(() => h.memory.store.updateTurn(1, { assistantText: "blocked" })).toThrow("/trace enable");
  expect(() => h.memory.store.appendToolCall({ turnId: 1, name: "blocked", status: "attempted" })).toThrow("/trace enable");
  expect(() => h.memory.selectEntries(1, "main", [])).toThrow("/trace enable");
});

test.each([true, false])("18a 2026-09-08: disable during Consolidation rejects late %s submission and leaves facts pending", async submit => {
  const h = setup({ "consolidation.triggerTokens": 1, "consolidation.maxToolRounds": 1 }); await h.turn();
  const note = h.memory.tools({ kind: "manual", sessionId: 1, branch: "main", currentTurnId: 1 }).find(t => t.name === "note")!;
  note.execute({ facts: [{ category: "observation", actor: "user", text: "Pending knowledge", source: ["T1#user"] }] });
  let release!: (value: ReturnType<typeof reply>) => void;
  h.provider(async () => new Promise(resolve => { release = resolve; }));
  await h.answer("consolidation opportunity"); await h.drain(); expect(h.requests).toHaveLength(1);
  await command(h, "disable");
  h.provider(async () => reply("Stopped"));
  release(submit ? { ...reply(""), stopReason: "toolUse", content: [{ type: "toolCall", id: "memory", name: "memory", arguments: { operations: [], skipped: [] } }] } : reply("No knowledge"));
  await h.drain();
  expect(h.memory.store.consolidationBatch(1, "main", 1)).toHaveLength(1);
  expect(h.memory.store.listVisibleKnowledge(1, 1)).toEqual([]);
  const runs = h.memory.store.listRuns(1).filter(r => r.kind === "consolidation");
  expect(runs).toHaveLength(1);
  expect(runs[0]!.outcome).not.toBe("success");
});


test("18a 2026-09-08: pre-reply choice survives loss of Pi unflushed custom entries", async () => {
  const h = setup(); await h.emit("session_start"); await command(h, "disable");
  h.entries.length = 0; h.allEntries.length = 0;
  h.setHeaderTimestamp("2099-12-31T00:00:00Z");
  await h.emit("session_start"); await command(h, "status");
  expect(h.notices.at(-1)).toContain("Disabled (explicit choice)");
  expect(h.memory.store.getSession(1)).toBeNull();
  await command(h, "enable");
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
  h.answers.push("Settings (Global, read-only)"); await command(h, "");
  expect(h.notices.at(-1)).toContain("noting.forkModeDefault: false (Environment)"); // canonical key, honest source
  expect(h.notices.at(-1)).not.toContain("branchModeDefault");                       // and only the canonical key
});

test("19c 2026-09-08: a legacy key in one layer is masked by the canonical key in a later layer, as any other setting is", async () => {
  const h = setup({ "noting.triggerTokens": 33 });
  const globalPath = join(h.dir, "agent", "settings.json"), projectPath = join(h.dir, ".pi", "settings.json");
  mkdirSync(join(h.dir, ".pi"), { recursive: true });
  writeFileSync(globalPath, JSON.stringify({ "trace-memory": { "noting.branchModeDefault": false } }));
  writeFileSync(projectPath, JSON.stringify({ "trace-memory": { "noting.forkModeDefault": true } }));
  await h.emit("session_start"); h.ctx.hasUI = true;
  h.answers.push("Settings (Global, read-only)"); await command(h, "");
  // 18a precedence decides; supplying the two spellings in two layers is migration, not a conflict.
  expect(h.notices.at(-1)).toContain("noting.forkModeDefault: true (Project); Global=false masked");
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
  h.answers.push("Settings (Global, read-only)"); await command(h, "");
  expect(h.notices.at(-1)).toContain("noting.forkModeDefault: false (Global)");
  writeFileSync(globalPath, "{}");
});
