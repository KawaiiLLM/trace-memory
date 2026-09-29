import { expect, test, vi } from "vitest";
import type { JsonObject } from "@earendil-works/pi-ai";
import { host, reply, notingFact, type Reply } from "./test-host.ts";
import { Store } from "../../../src/core/store/index.ts";
import { readHandle } from "../../read-handle-fixture.ts";

const command = (h: ReturnType<typeof host>, args: string) => h.commands.get("trace").handler(args, h.ctx);
const dreaming = (c: { systemPrompt?: string }) => c.systemPrompt?.startsWith("# Dreamer");
const settle = async (h: ReturnType<typeof host>) => { for (let i = 0; i < 30; i++) await h.drain(); };
const call = (name: string, args: object): Reply => ({ ...reply(""), stopReason: "toolUse", content: [
  { type: "toolCall", id: `${name}-1`, name, arguments: args as JsonObject },
] });
function backlog(h: ReturnType<typeof host>) {
  for (let i = 0; i < 12; i++) {
    h.persist({ role: "user", content: `turn ${i}`, timestamp: 1 });
    h.persist(reply(`history ${i} ` + "word ".repeat(3000)));
  }
}
/** Real N still stages both tools. The knowledge cites this run's held fact, not fixture writes. */
function extract(c: Parameters<typeof notingFact>[0], scope: "global" | "session" = "session") {
  const results = c.messages.filter(m => m.role === "toolResult");
  expect(results.length, JSON.stringify(c.messages)).toBeLessThanOrEqual(2);
  expect(JSON.stringify(results)).not.toContain("rejected:");
  const result = notingFact(c);
  for (const part of result.content) if (part.type === "toolCall" && part.name === "memory") {
    part.arguments = { operations: [{ op: "create", text: "Rule " + "word ".repeat(120),
      category: "constraint", scope, topics: [], supports: ["$1"], reason: "Supported conclusion" }], skipped: [] };
  }
  return result;
}
function retain(c: Parameters<typeof notingFact>[0]): Reply {
  const results = c.messages.filter(m => m.role === "toolResult");
  if (results.length) {
    expect(results.length, JSON.stringify(c.messages)).toBe(1);
    expect(JSON.stringify(results)).not.toContain("rejected:");
    return reply("Done");
  }
  const material = String(c.messages[0]!.content);
  const handles = [...material.matchAll(/^New (K\d+@v\d+):/gm)].map(match => match[1]!);
  expect(handles.length).toBeGreaterThan(0);
  return call("memory", { operations: [], skipped: handles.map(knowledge => ({ knowledge, because: "Reviewed unchanged" })) });
}
function seed(h: ReturnType<typeof host>) {
  const tools = h.memory.tools({ kind: "manual", sessionId: 1, branch: "main", currentTurnId: 1 });
  expect(tools.find(t => t.name === "note")!.execute({ facts: [{ title: "Keep conclusion", sources: [{ address: "T1#E1", text: "Keep this conclusion." }] }] })).toContain("ok: F1");
  expect(tools.find(t => t.name === "memory")!.execute({ operations: [{ op: "create", topics: [],
    reason: "Seed pending revision", text: "Rule " + "word ".repeat(120), category: "constraint", scope: "session", supports: ["F1"] }], skipped: [] })).not.toContain("rejected:");
  return h.memory.store.listKnowledgeRevisions().at(-1)!;
}

for (const stop of [false, true]) test(`92: N and D overlap; ${stop ? "stop fences the held D" : "successful checkpoints drain due knowledge"}; no C seat`, async () => {
  const h = host({ "noting.triggerTokens": 1e9, "dreaming.triggerTokens": 1 });
  let release = () => {};
  const held = new Promise<void>(resolve => { release = resolve; });
  let dreams = 0;
  try {
    backlog(h); await h.emit("session_start");
    h.provider(async c => {
      if (!dreaming(c)) {
        const completed = h.memory.store.listRuns(1).filter(run => run.kind === "noting" && run.outcome === "success").length;
        return extract(c, completed === 0 ? "global" : "session");
      }
      dreams++; await held; return retain(c);
    });
    await command(h, "catchup");
    await vi.waitFor(() => expect(dreams).toBe(1));
    await settle(h);
    expect(h.memory.store.listRuns(1).filter(r => r.kind === "noting" && r.outcome === "success").length).toBeGreaterThan(1);
    expect(h.memory.pendingEntries(1, "main", h.memory.store.listTurns(1).at(-1)!.id)).toEqual([]);
    expect(h.memory.store.getClaim(1, "dreaming")).not.toBeNull();
    expect(h.memory.store.listRuns(1).some(r => r.kind === "consolidation")).toBe(false);
    if (stop) await command(h, "stop");
    release(); await settle(h);
    if (stop) {
      expect(dreams).toBe(1);
      await command(h, ""); expect(h.notices.at(-1)).toContain("Catchup: stopped");
    } else {
      const completed = h.memory.store.listRuns(1).filter(r => r.kind === "dreaming" && r.outcome === "success");
      expect(new Set(completed.map(run => run.rangeFrom?.split("#")[0])).size).toBe(2);
      await command(h, ""); expect(h.notices.at(-1)).toContain("Catchup: completed");
      const count = dreams; await settle(h); expect(dreams).toBe(count);
    }
  } finally { release(); await h.dispose(); }
}, 30000);

test("92: catchup waits for ordinary N; its successful joint publication checkpoints D", async () => {
  const h = host({ "noting.forkModeDefault": false, "noting.triggerTokens": 1000, "dreaming.triggerTokens": 1 });
  let release = () => {};
  const held = new Promise<void>(resolve => { release = resolve; });
  try {
    await h.turn();
    h.provider(async c => { if (dreaming(c)) return retain(c); await held; return extract(c); });
    await h.prompt("another main turn"); await h.answer("word ".repeat(3000)); await h.drain();
    expect(h.memory.store.getClaim(1, "noting")).not.toBeNull();
    await command(h, "catchup"); expect(h.notices.at(-1)).toContain("waiting for noting");
    release(); await settle(h);
    expect(h.memory.store.listRuns(1).filter(r => r.kind === "noting" && r.outcome === "success")).toHaveLength(1);
    expect(h.memory.store.listRuns(1).filter(r => r.kind === "dreaming" && r.outcome === "success")).toHaveLength(1);
    await command(h, ""); expect(h.notices.at(-1)).toContain("Catchup: completed");
  } finally { release(); await h.dispose(); }
});

for (const success of [true, false]) test(`92: ordinary D ${success ? "success settles" : "failure does not resume"} a zero-Raw catchup wait`, async () => {
  const h = host({ "noting.triggerTokens": 1e9, "dreaming.triggerTokens": 1 });
  let release = () => {};
  const held = new Promise<void>(resolve => { release = resolve; });
  let dreams = 0;
  try {
    await h.turn(); seed(h);
    h.provider(async c => {
      if (!dreaming(c)) return notingFact(c);
      dreams++; await held;
      return success ? retain(c) : { ...reply(""), stopReason: "error", errorMessage: "ordinary D terminal failure" };
    });
    await h.turn(); await h.drain();
    expect(h.memory.store.getClaim(1, "dreaming")).not.toBeNull();
    const head = h.memory.store.listTurns(1).at(-1)!.id;
    const cleared = h.memory.store.commitNotingRun({ run: { kind: "manual", sessionId: 1, createdAt: "fixture" }, facts: [],
      entryIds: h.memory.pendingEntries(1, "main", head).map(e => e.id) });
    if (!cleared.ok) throw new Error(cleared.problems.join("; "));
    await command(h, "catchup"); expect(h.notices.at(-1)).toContain("waiting for dreaming");
    release(); await settle(h);
    expect(dreams).toBe(1);
    expect(h.memory.store.listRuns(1).filter(r => r.kind === "dreaming").map(r => r.outcome)).toEqual([success ? "success" : "failure"]);
    await command(h, ""); expect(h.notices.at(-1)).toContain(success ? "Catchup: completed" : "waiting for dreaming");
  } finally { release(); await h.dispose(); }
});

test("86: ordinary D partial write survives terminal failure without a completion check", async () => {
  const h = host({ "noting.triggerTokens": 1e9, "dreaming.triggerTokens": 1 });
  let release = () => {};
  const held = new Promise<void>(resolve => { release = resolve; });
  let submitted = false, waiting = false;
  try {
    await h.turn(); const initial = seed(h), store = h.memory.store;
    const initialHandle = readHandle(h.memory.tools({ kind: "manual", sessionId: 1, branch: "main", currentTurnId: 1 }), `K${initial.knowledgeId}`);
    const eligible = vi.spyOn(h.memory, "taskEligibility");
    h.provider(async c => {
      if (!dreaming(c)) return notingFact(c);
      if (!submitted) {
        submitted = true;
        return call("memory", { operations: [{ op: "update", id: initialHandle,
          text: "Maintained rule " + "word ".repeat(120), category: "constraint", scope: "session", supports: [], topics: [], reason: "Update before failure" }], skipped: [] });
      }
      waiting = true; await held;
      return { ...reply(""), stopReason: "error", errorMessage: "terminal D failure after commit" };
    }, { autoStop: false });
    await h.turn(); await vi.waitFor(() => expect(waiting).toBe(true));
    expect(store.listKnowledgeRevisions()).toHaveLength(2);
    const revised = store.listKnowledgeRevisions().at(-1)!;
    expect(revised.parentId).toBe(initial.id);
    const before = eligible.mock.calls.length;
    release(); await settle(h);
    expect(store.listKnowledgeRevisions()).toHaveLength(2);
    expect(store.listKnowledgeRevisions().at(-1)!.id).toBe(revised.id);
    expect(store.listRuns(1).filter(r => r.kind === "dreaming").map(r => r.outcome)).toEqual(["failure"]);
    expect(eligible.mock.calls.length).toBe(before);
    eligible.mockRestore();
  } finally { release(); await h.dispose(); }
}, 30000);

test("92: repeated catchup while N is running reports without launching a duplicate", async () => {
  const h = host({ "noting.triggerTokens": 1e9 });
  let release = () => {};
  const held = new Promise<void>(resolve => { release = resolve; });
  try {
    backlog(h); await h.emit("session_start");
    h.provider(async c => { await held; return notingFact(c); });
    await command(h, "catchup"); await vi.waitFor(() => expect(h.requests).toHaveLength(1));
    await command(h, "catchup"); expect(h.requests).toHaveLength(1);
    expect(h.notices.at(-1)).toContain("running noting");
    release(); await settle(h);
    await command(h, ""); expect(h.notices.at(-1)).toContain("Catchup: completed");
  } finally { release(); await h.dispose(); }
});

test("92: successful N checks but does not run D below its ordinary threshold", async () => {
  const h = host({ "noting.triggerTokens": 1e9, "dreaming.triggerTokens": 1e9 });
  try {
    await h.turn(); h.provider(async c => extract(c));
    const eligibility = vi.spyOn(Store.prototype, "duePools");
    await command(h, "catchup"); await settle(h);
    expect(h.memory.store.listRuns(1).filter(r => r.kind === "noting" && r.outcome === "success")).toHaveLength(1);
    expect(h.memory.store.currentKnowledge()).toHaveLength(1);
    expect(eligibility).toHaveBeenCalled();
    expect(h.memory.store.listRuns(1).filter(r => r.kind === "dreaming")).toEqual([]);
    eligibility.mockRestore();
  } finally { await h.dispose(); }
});

for (const recover of [false, true]) test(`92: foreign global D claim discards admission; ${recover ? "repeated idle catchup" : "new entry"} retries, release alone does not`, async () => {
  const h = host({ "noting.triggerTokens": 1e9, "dreaming.triggerTokens": 1 });
  let dreams = 0;
  try {
    await h.turn(); seed(h); const store = h.memory.store;
    const foreign = store.createSession({ host: "foreign", projectId: store.getSession(1)!.projectId,
      enrollmentChoice: true, startedAt: "now", firstReplyAt: "now" });
    const turn = store.appendTurn({ sessionId: foreign.id, kind: "turn", userPrompt: "foreign", startedAt: "now" });
    const entry = store.appendSourceEntry({ sessionId: foreign.id, turnId: turn.id, nativeLineage: "foreign", nativeId: "user",
      role: "user", text: "foreign", raw: JSON.stringify({ role: "user", content: "foreign" }), calls: [] });
    store.selectSourcePath(foreign.id, "main", [entry.id]);
    const tools = h.memory.tools({ kind: "manual", sessionId: foreign.id, branch: "main", currentTurnId: turn.id });
    expect(tools.find(t => t.name === "note")!.execute({ facts: [{ title: "Foreign rule", sources: [{ address: `T${turn.id}#E1`, text: "Foreign rule" }] }] })).toContain("ok:");
    const fact = store.listSessionFacts(foreign.id)[0]!;
    expect(tools.find(t => t.name === "memory")!.execute({ operations: [{ op: "create", text: "Foreign rule", category: "constraint",
      scope: "session", supports: [`F${fact.id}`], topics: [], reason: "Foreign pending pool" }], skipped: [] })).not.toContain("rejected:");
    const claim = store.acquireClaim({ sessionId: foreign.id, branch: "main", headTurnId: turn.id }, "dreaming", "foreign-executor")!;
    expect(claim).not.toBeNull();
    h.provider(async c => { if (!dreaming(c)) return notingFact(c); dreams++; return retain(c); });
    await command(h, "catchup"); await settle(h);
    await command(h, ""); expect(h.notices.at(-1)).toContain("waiting for dreaming");
    await command(h, "catchup"); await settle(h); expect(dreams).toBe(0);
    expect(store.releaseClaim(claim)).toBe(true);
    await settle(h); expect(dreams).toBe(0);
    if (recover) await command(h, "catchup"); else await h.turn();
    await settle(h); expect(dreams).toBe(1);
    await command(h, ""); expect(h.notices.at(-1)).toContain("Catchup: completed");
  } finally { await h.dispose(); }
});

for (const correct of [false, true]) test(`86: bounced N ${correct ? "retries the frozen entry successfully" : "turns memory off after three failures"} without an intervening D check`, async () => {
  const h = host({ "noting.triggerTokens": 1e9, "dreaming.triggerTokens": 1e9 });
  try {
    await h.turn(); const eligibility = vi.spyOn(Store.prototype, "duePools");
    let attempts = 0; const checks: number[] = [];
    h.provider(async c => {
      if (dreaming(c)) throw new Error("Unexpected D admission");
      const results = c.messages.filter(m => m.role === "toolResult");
      if (results.length > 2) throw new Error("Unexpected Noter continuation after explicit note and memory");
      if (results.length === 0) {
        attempts++; checks.push(eligibility.mock.calls.length);
        if (attempts > (correct ? 2 : 3)) throw new Error("Noter retried beyond its scripted terminal outcome");
        return call("note", { facts: correct && attempts > 1 ? [] : [{ title: "Rejected source", sources: [{ address: "T99999#E1", text: "Rejected source" }] }] });
      }
      if (!c.messages.some(m => m.role === "toolResult" && m.toolName === "memory")) return call("memory", { operations: [], skipped: [] });
      return reply("Done");
    }, { autoStop: false });
    await command(h, "catchup"); await settle(h);
    expect(h.memory.store.listRuns(1).filter(r => r.kind === "noting").map(r => r.outcome))
      .toEqual(correct ? ["bounced", "success"] : ["bounced", "bounced", "bounced"]);
    expect(checks[0]).toBeGreaterThan(0);
    expect(new Set(checks).size).toBe(1);
    expect(attempts).toBe(correct ? 2 : 3);
    if (correct) expect(eligibility.mock.calls.length).toBeGreaterThan(checks[1]!);
    else expect(h.notices.some(notice => notice.includes("off after three failures"))).toBe(true);
    expect(h.memory.store.enabled(1)).toBe(correct);
    expect(h.memory.store.listSessionFacts(1)).toEqual([]);
    await command(h, ""); expect(h.notices.at(-1)).toContain(correct ? "Catchup: completed" : "Catchup: stopped");
    eligibility.mockRestore();
  } finally { await h.dispose(); }
}, 30000);

test("86: D retries the same pending revision and three business failures turn memory off", async () => {
  const h = host({ "noting.triggerTokens": 1e9, "dreaming.triggerTokens": 1 });
  let dreams = 0;
  try {
    await h.turn(); seed(h);
    h.provider(async c => {
      if (!dreaming(c)) return notingFact(c);
      if (++dreams > 3) throw new Error("Dreamer retried beyond automatic off");
      return { ...reply(""), stopReason: "error", errorMessage: "fixture D failure" };
    });
    await command(h, "catchup"); await settle(h);
    const executions = h.memory.store.db.prepare("SELECT head, outcome FROM task_executions WHERE phase = 'dreaming' ORDER BY rowid").all();
    expect(dreams).toBe(3);
    expect(new Set(executions.map(r => r.head)).size).toBe(1);
    expect(executions.map(r => r.outcome)).toEqual(["failure", "failure", "failure"]);
    expect(h.memory.store.db.prepare("SELECT head, count FROM task_failures WHERE phase = 'dreaming'").all()).toEqual([{ head: executions[0]!.head, count: 3 }]);
    expect(h.memory.store.enabled(1)).toBe(false);
    await command(h, ""); expect(h.notices.at(-1)).toContain("Catchup: stopped");
  } finally { await command(h, "stop"); await h.dispose(); }
}, 30000);

test.each(["stop", "path", "off", "shutdown"] as const)("86: Pi %s fences catchup retry despite a late D error reply", async action => {
  const h = host({ "noting.triggerTokens": 1e9, "dreaming.triggerTokens": 1 });
  let release = () => {};
  const held = new Promise<void>(resolve => { release = resolve; });
  let dreams = 0, replied = false;
  try {
    await h.turn(); seed(h);
    h.provider(async c => {
      if (!dreaming(c)) return notingFact(c);
      dreams++; await held; replied = true;
      return { ...reply(""), stopReason: "error", errorMessage: "late D failure" };
    }, { ignoreAbort: true });
    await command(h, "catchup"); await vi.waitFor(() => expect(dreams).toBe(1));
    if (action === "path") {
      h.entries.length = 0; h.allEntries.length = 0; h.ctx.sessionManager.getSessionId = () => "forked-session";
      await h.emit("session_tree");
    } else if (action === "shutdown") {
      const closed = h.emit("session_shutdown", { reason: "quit" }); release(); await closed;
    } else await command(h, action);
    release(); await settle(h);
    expect(replied).toBe(true); expect(dreams).toBe(1);
    expect(h.memory.store.listRuns(1).filter(r => r.kind === "dreaming").map(r => r.outcome)).toEqual(["cancelled"]);
  } finally { release(); await h.dispose(); }
}, 30000);

test("92: three downstream D failures disable memory and fence the in-flight N batch", async () => {
  const h = host({ "noting.triggerTokens": 1e9, "dreaming.triggerTokens": 1 });
  let release!: () => void, releaseThirdDream!: () => void, noterHeld = false, dreams = 0;
  const held = new Promise<void>(resolve => { release = resolve; });
  const thirdDreamHeld = new Promise<void>(resolve => { releaseThirdDream = resolve; });
  try {
    backlog(h); await h.emit("session_start"); seed(h);
    const store = h.memory.store, head = store.listTurns(1).at(-1)!.id;
    const pending = h.memory.pendingEntries(1, "main", head).map(entry => entry.id);
    const facts = store.listSessionFacts(1);
    h.provider(async c => {
      if (!dreaming(c)) { noterHeld = true; await held; return notingFact(c); }
      if (++dreams > 3) throw new Error("D retried beyond automatic off");
      if (dreams === 3) await thirdDreamHeld;
      return { ...reply(""), stopReason: "error", errorMessage: "downstream failure while N is held" };
    }, { ignoreAbort: true });
    await command(h, "catchup");
    await vi.waitFor(() => { expect(noterHeld).toBe(true); expect(dreams).toBe(3); });
    const dreamOutcomes = () => store.db.prepare(
      "SELECT outcome FROM task_executions WHERE session_id = 1 AND phase = 'dreaming' ORDER BY rowid",
    ).all().map(row => row.outcome);
    // Admission creates a provisional failure run. It is not a terminal business failure:
    // releasing N on the third such row used to race D's automatic-off settlement.
    expect(store.listRuns(1).filter(run => run.kind === "dreaming" && run.outcome === "failure")).toHaveLength(3);
    expect(dreamOutcomes()).toEqual(["failure", "failure", null]);
    expect(store.enabled(1)).toBe(true);
    expect(store.listSessionFacts(1)).toEqual(facts);
    releaseThirdDream();
    await vi.waitFor(() => expect(dreamOutcomes()).toEqual(["failure", "failure", "failure"]));
    expect(store.enabled(1)).toBe(false);
    expect(store.listSessionFacts(1)).toEqual(facts);
    release(); await settle(h);
    expect(dreams).toBe(3);
    expect(store.enabled(1)).toBe(false);
    expect(store.listSessionFacts(1)).toEqual(facts);
    expect(h.memory.pendingEntries(1, "main", head).map(entry => entry.id)).toEqual(pending);
    expect(store.listRuns(1).filter(run => run.kind === "noting").map(run => run.outcome)).toEqual(["cancelled"]);
    expect(h.notices.some(notice => notice.includes("off after three failures"))).toBe(true);
    await command(h, ""); expect(h.notices.at(-1)).toContain("Catchup: stopped");
    const requests = h.requests.length;
    await settle(h); await h.emit("session_tree"); await settle(h);
    expect(h.requests).toHaveLength(requests);
  } finally { releaseThirdDream(); release(); await h.dispose(); }
}, 30000);

test("67: entries persisted after catchup freezes do not extend Noting's boundary", async () => {
  const h = host({ "noting.triggerTokens": 1e9 });
  let release = () => {};
  const held = new Promise<void>(resolve => { release = resolve; });
  try {
    backlog(h); await h.emit("session_start");
    const frozen = h.memory.pendingEntries(1, "main", h.memory.store.listTurns(1).at(-1)!.id).map(e => e.id);
    let calls = 0; h.provider(async c => { if (++calls === 1) await held; return notingFact(c); });
    await command(h, "catchup"); await h.drain(); await h.turn(); release(); await settle(h);
    const remaining = h.memory.pendingEntries(1, "main", h.memory.store.listTurns(1).at(-1)!.id).map(e => e.id);
    expect(remaining.length).toBeGreaterThan(0);
    expect(remaining.some(id => frozen.includes(id))).toBe(false);
    expect(h.memory.store.listRuns(1).filter(r => r.kind === "consolidation")).toEqual([]);
  } finally { release(); await h.dispose(); }
}, 30000);
