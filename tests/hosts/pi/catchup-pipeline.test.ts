import { expect, test, vi } from "vitest";
import type { JsonObject } from "@earendil-works/pi-ai";
import { host, reply, notingFact, noterReply, dreamerFiles, type Reply } from "./test-host.ts";
import { Store } from "../../../src/core/store/index.ts";
import { knowledge } from "../../support/seed.ts";
import { block } from "../../support/workspace.ts";

const command = (h: ReturnType<typeof host>, args: string) => h.commands.get("trace").handler(args, h.ctx);
const dreaming = (c: { systemPrompt?: string }) => c.systemPrompt?.startsWith("# Dreamer") || c.systemPrompt?.startsWith("# Classifying");
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
/** Real N writes its two files; the knowledge cites this run's fact, not fixture writes. */
function extract(c: Parameters<typeof notingFact>[0], scope: "global" | "session" = "session") {
  const results = c.messages.filter(m => m.role === "toolResult");
  expect(JSON.stringify(results)).not.toContain("rejected:");
  return notingFact(c, `## create\ntitle: Fixture title\ncategory: constraint\nscope: ${scope}\ntopics: \nsupports: f1\nreason: Supported conclusion\n\nRule ${"word ".repeat(120)}\n`);
}
/** The Dreamer's side of a run: check, write the file it names (nothing to change), stop. */
const retain = (c: Parameters<typeof dreamerFiles>[0]): Reply => dreamerFiles(c) ?? reply("Done");
/** A Noter-written constraint over F1: only Noter changes make a Dreamer due (2026-10-22). */
function seed(h: ReturnType<typeof host>) {
  const tools = h.memory.tools({ kind: "manual", sessionId: 1, branch: "main", currentTurnId: 1 });
  expect(tools.find(t => t.name === "note")!.execute({ title: "Keep conclusion", sources: "[T1#E1] Keep this conclusion." })).toContain("ok: F1");
  knowledge(h.memory.store, { sessionId: 1, branch: "main", headTurnId: 1 }, "session", "constraint", [1], "Rule " + "word ".repeat(120), { operation: { title: "Fixture title" } });
  return h.memory.store.listKnowledgeRevisions().at(-1)!;
}
const dreamExecutions = (h: ReturnType<typeof host>) => h.memory.store.db.prepare(
  "SELECT outcome FROM task_executions WHERE session_id = 1 AND phase = 'dreaming' ORDER BY rowid").all().map(row => row.outcome);

for (const stop of [false, true]) test(`92: N and D overlap; ${stop ? "stop fences the held D" : "successful checkpoints drain due knowledge"}; no C seat`, async () => {
  const h = host({ "noting.triggerTokens": 1e9, "dreaming.triggerOperations": 1 });
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
      expect(dreamExecutions(h).length).toBeGreaterThan(0);
      expect(dreamExecutions(h).every(outcome => outcome === "success")).toBe(true);
      // The checkpoints leave no Noter change uncovered: a Dreamer is not due.
      expect(h.memory.taskEligibility("dreaming", { sessionId: 1, branch: "main", headTurnId: h.memory.store.listTurns(1).at(-1)!.id }).due).toBe(false);
      await command(h, ""); expect(h.notices.at(-1)).toContain("Catchup: completed");
      const count = dreams; await settle(h); expect(dreams).toBe(count);
    }
  } finally { release(); await h.dispose(); }
}, 30000);

test("92: catchup waits for ordinary N; its successful joint publication checkpoints D", async () => {
  const h = host({ "noting.triggerTokens": 1000, "dreaming.triggerOperations": 1 });
  let release = () => {};
  const held = new Promise<void>(resolve => { release = resolve; });
  try {
    await h.turn();
    h.provider(async c => { if (dreaming(c)) return retain(c); await held; return extract(c); });
    await h.prompt("another main turn"); await h.answer("word ".repeat(3000)); await h.drain();
    expect(h.memory.store.getClaim(1, "noting")).not.toBeNull();
    await command(h, "catchup"); expect(h.notices.at(-1)).toContain("waiting for noting");
    release(); await settle(h);
    expect(h.memory.store.listRuns(1).filter(r => r.kind === "noting" && r.outcome === "success")).toHaveLength(2); // one batch: write and verify
    expect(dreamExecutions(h)).toEqual(["success"]);
    await command(h, ""); expect(h.notices.at(-1)).toContain("Catchup: completed");
  } finally { release(); await h.dispose(); }
});

for (const success of [true, false]) test(`92: ordinary D ${success ? "success settles" : "failure ends (146 Q18)"} a zero-Raw catchup wait`, async () => {
  const h = host({ "noting.triggerTokens": 1e9, "dreaming.triggerOperations": 1 });
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
    expect(dreamExecutions(h)).toEqual([success ? "success" : "failure"]);
    await command(h, ""); expect(h.notices.at(-1)).toContain(success ? "Catchup: completed" : "Catchup: failed");
  } finally { release(); await h.dispose(); }
});

test("86: a kept Dreamer batch survives a later terminal failure, with no extra eligibility check", async () => {
  const h = host({ "noting.triggerTokens": 1e9, "dreaming.triggerOperations": 1 });
  let release = () => {};
  const held = new Promise<void>(resolve => { release = resolve; });
  let waiting = false;
  try {
    await h.turn(); const initial = seed(h), store = h.memory.store;
    const eligible = vi.spyOn(h.memory, "taskEligibility");
    h.provider(async c => {
      if (!dreaming(c)) return notingFact(c);
      if (c.messages.length === 1 && c.systemPrompt?.startsWith("# Dreamer") && store.listRuns(1).some(r => JSON.parse(r.response ?? "{}").proposed?.length === 1)) { waiting = true; await held; // verify's first request
        return { ...reply(""), stopReason: "error", errorMessage: "terminal D failure after commit" }; }
      return dreamerFiles(c, { curate: block(`update K${initial.knowledgeId}@v1`, { reason: "Update before failure" }, "Maintained rule " + "word ".repeat(120)) }) ?? reply("Done");
    }, { autoStop: false });
    await h.turn(); await vi.waitFor(() => expect(waiting).toBe(true));
    expect(store.listKnowledgeRevisions()).toHaveLength(1); // curate's batch is a proposal: nothing is applied before verify passes
    const before = eligible.mock.calls.length;
    release(); await settle(h);
    expect(store.listKnowledgeRevisions()).toHaveLength(1);
    expect(store.listRuns(1).filter(r => r.kind === "dreaming").map(r => r.outcome)).toEqual(["success", "failure"]); // curate kept its proposal, verify failed
    expect(store.handoff(1, "dreaming")).toMatchObject({ nextTask: "verify", detail: { groups: [{ batches: [{ run: expect.any(Number) }] }] } }); // the kept batch survives
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
  const h = host({ "noting.triggerTokens": 1e9, "dreaming.triggerOperations": 1e9 });
  try {
    await h.turn(); h.provider(async c => extract(c));
    const eligibility = vi.spyOn(Store.prototype, "dreamingDue");
    await command(h, "catchup"); await settle(h);
    expect(h.memory.store.listRuns(1).filter(r => r.kind === "noting" && r.outcome === "success")).toHaveLength(2); // one batch: write and verify
    expect(h.memory.store.currentKnowledge()).toHaveLength(1);
    expect(eligibility).toHaveBeenCalled();
    expect(h.memory.store.listRuns(1).filter(r => r.kind === "dreaming")).toEqual([]);
    eligibility.mockRestore();
  } finally { await h.dispose(); }
});

for (const recover of [false, true]) test(`92: foreign global D claim discards admission; ${recover ? "repeated idle catchup" : "new entry"} retries, release alone does not`, async () => {
  const h = host({ "noting.triggerTokens": 1e9, "dreaming.triggerOperations": 1 });
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
    expect(tools.find(t => t.name === "note")!.execute({ title: "Foreign rule", sources: `[T${turn.id}#E1] Foreign rule` })).toContain("ok:");
    const fact = store.listSessionFacts(foreign.id)[0]!;
    knowledge(store, { sessionId: foreign.id, branch: "main", headTurnId: turn.id }, "session", "constraint", [fact.id], "Foreign rule", { operation: { title: "Fixture title" } });
    const claim = store.acquireClaim({ sessionId: foreign.id, branch: "main", headTurnId: turn.id }, "dreaming", "foreign-executor", false, () => true, 1)!;
    expect(claim).not.toBeNull();
    h.provider(async c => { if (!dreaming(c)) return notingFact(c); dreams++; return retain(c); });
    await command(h, "catchup"); await settle(h);
    await command(h, ""); expect(h.notices.at(-1)).toContain("waiting for dreaming");
    await command(h, "catchup"); await settle(h); expect(dreams).toBe(0);
    expect(store.releaseClaim(claim)).toBe(true);
    await settle(h); expect(dreams).toBe(0);
    if (recover) await command(h, "catchup"); else await h.turn();
    await settle(h); expect(dreams).toBeGreaterThan(0); expect(dreamExecutions(h)).toEqual(["success"]);
    await command(h, ""); expect(h.notices.at(-1)).toContain("Catchup: completed");
  } finally { await h.dispose(); }
});

for (const correct of [false, true]) test(`86: a refused N ${correct ? "retries the frozen entry successfully" : "turns memory off after three failures"} without an intervening D check`, async () => {
  const h = host({ "noting.triggerTokens": 1e9, "dreaming.triggerOperations": 1e9 });
  try {
    await h.turn(); const eligibility = vi.spyOn(Store.prototype, "dreamingDue");
    let attempts = 0; const checks: number[] = [];
    h.provider(async c => {
      if (dreaming(c)) throw new Error("Unexpected D admission");
      const report = c.messages.filter(m => m.role === "toolResult" && m.toolName === "check").at(-1);
      const written = c.messages.some(m => m.role === "toolResult" && m.toolName === "write");
      if (!report || written) return noterReply(c) ?? reply("Done"); // the check call; nothing to correct afterwards
      if (/^Task: verify/m.test((report.content as { text: string }[])[0]!.text)) return reply("Done");
      attempts++; checks.push(eligibility.mock.calls.length);
      if (attempts > (correct ? 2 : 3)) throw new Error("Noter retried beyond its scripted terminal outcome");
      return noterReply(c, correct && attempts > 1 ? {} : { facts: "## fact f1\ntitle: Rejected source\n\n[T99999#E1] Rejected source\n" })!;
    });
    await command(h, "catchup"); await settle(h);
    expect(h.memory.store.listRuns(1).filter(r => r.kind === "noting").map(r => r.outcome))
      .toEqual(correct ? ["failure", "success", "success"] : ["failure", "failure", "failure"]);
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

test.each(["stop", "path", "off", "shutdown"] as const)("86: Pi %s fences catchup retry despite a late D error reply", async action => {
  const h = host({ "noting.triggerTokens": 1e9, "dreaming.triggerOperations": 1 });
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

// ---- 146 Q18: a Dreaming failure while a drain is active ends the drain, whoever started the run; the retry is the next entry-end check ----

const fail = (message: string): Reply => ({ ...reply(""), stopReason: "error", errorMessage: message });

test("146 Q18: an ordinary D fails while the drain's N is still running: the drain ends, the late N success drives nothing, the next turn retries D once", async () => {
  const h = host({ "noting.triggerTokens": 1e9, "dreaming.triggerOperations": 1 });
  let releaseD = () => {}, releaseN = () => {};
  const heldD = new Promise<void>(resolve => { releaseD = resolve; }), heldN = new Promise<void>(resolve => { releaseN = resolve; });
  let dFails = true, nCalls = 0;
  try {
    await h.turn(); seed(h);
    h.provider(async c => {
      if (!dreaming(c)) { if (++nCalls === 1) await heldN; return notingFact(c); }
      if (dFails) { await heldD; return fail("ordinary D terminal failure"); }
      return retain(c);
    });
    await h.turn(); await h.drain(); // the ordinary D is admitted and held
    expect(h.memory.store.getClaim(1, "dreaming")).not.toBeNull();
    await command(h, "catchup"); await vi.waitFor(() => expect(nCalls).toBe(1)); // the drain's N runs; the busy D is skipped
    releaseD(); await vi.waitFor(() => expect(dreamExecutions(h)).toEqual(["failure"]));
    await command(h, ""); expect(h.notices.at(-1)).toContain("Catchup: failed");
    releaseN(); await settle(h);
    expect(dreamExecutions(h)).toEqual(["failure"]); // the late N success started no D
    dFails = false;
    await h.turn(); await settle(h);
    expect(dreamExecutions(h)).toEqual(["failure", "success"]); // the next entry-end check, once
  } finally { releaseD(); releaseN(); await h.dispose(); }
}, 30000);

test("146 Q18: the drain's own D fails: one run, the drain ends, and the next entry-end check retries once", async () => {
  const h = host({ "noting.triggerTokens": 1e9, "dreaming.triggerOperations": 1 });
  let dFails = true;
  try {
    await h.turn(); seed(h);
    h.provider(async c => dreaming(c) ? (dFails ? fail("drain D terminal failure") : retain(c)) : notingFact(c));
    await command(h, "catchup"); await settle(h);
    expect(dreamExecutions(h)).toEqual(["failure"]);
    await command(h, ""); expect(h.notices.at(-1)).toContain("Catchup: failed");
    dFails = false;
    await h.turn(); await settle(h);
    expect(dreamExecutions(h)).toEqual(["failure", "success"]);
  } finally { await h.dispose(); }
}, 30000);

test("146 Q18: a D failure that carries automaticOff stops the drain", async () => {
  const h = host({ "noting.triggerTokens": 1e9, "dreaming.triggerOperations": 1e9 });
  try {
    await h.turn(); seed(h);
    h.provider(async c => dreaming(c) ? fail("terminal") : notingFact(c));
    for (let i = 0; i < 2; i++) { await command(h, "dream"); await settle(h); }
    h.memory.config.dreaming.triggerOperations = 1; // the drain's own D is now due
    await command(h, "catchup"); await settle(h);
    expect(h.memory.store.enabled(1)).toBe(false); // the third failure switched memory off
    expect(h.notices.some(text => text.includes("dreaming off after three failures"))).toBe(true);
  } finally { await h.dispose(); }
}, 30000);

// 146 Q18 (d): an old-path D still running when the path switches is not cancelled by the switch (the new path is another core
// session), and it can fail after the new path's drain started. Its target differs from the drain's, so the failure must leave the drain.
test("146 Q18 (d): the old path's D fails late after a path switch: the new path's drain keeps running", async () => {
  const h = host({ "noting.triggerTokens": 1e9, "dreaming.triggerOperations": 1e9 });
  let releaseD = () => {}, releaseN = () => {};
  const heldD = new Promise<void>(resolve => { releaseD = resolve; }), heldN = new Promise<void>(resolve => { releaseN = resolve; });
  let dreams = 0, nCalls = 0;
  try {
    await h.turn(); seed(h);
    h.provider(async c => {
      if (dreaming(c)) { dreams++; await heldD; return fail("old-path D terminal failure"); }
      if (++nCalls === 1) await heldN;
      return notingFact(c);
    }, { ignoreAbort: true });
    await command(h, "dream"); await vi.waitFor(() => expect(dreams).toBe(1)); // the old path's D is held
    h.entries.length = 0; h.allEntries.length = 0; h.ctx.sessionManager.getSessionId = () => "forked-session";
    await h.emit("session_tree");
    await h.turn();
    await command(h, "catchup"); await vi.waitFor(() => expect(nCalls).toBe(1)); // the new path's drain runs its Noter
    await command(h, ""); expect(h.notices.at(-1)).toContain("Catchup: running noting");
    releaseD(); await vi.waitFor(() => expect(dreamExecutions(h)).toEqual(["failure"])); // session 1's D failed
    await command(h, ""); expect(h.notices.at(-1)).toContain("Catchup: running noting"); // the drain on session 2 is untouched
    releaseN(); await settle(h);
  } finally { releaseD(); releaseN(); await h.dispose(); }
}, 30000);
