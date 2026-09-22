import { expect, test, vi } from "vitest";
import { host, reply, notingFact, consolidationReply, type Reply } from "./test-host.ts";
import { Store } from "../../../src/core/store/index.ts";

const command = (h: ReturnType<typeof host>, args: string) => h.commands.get("trace").handler(args, h.ctx);
const phase = (c: { systemPrompt?: string }) => c.systemPrompt?.startsWith("# Dreamer") ? "D"
  : c.systemPrompt?.includes("You are the Consolidator:") ? "C" : "N";
const settle = async (h: ReturnType<typeof host>) => { for (let i = 0; i < 30; i++) await h.drain(); };
const call = (name: string, args: object): Reply => ({ ...reply(""), stopReason: "toolUse", content: [
  { type: "toolCall", id: `${name}-1`, name, arguments: args as Record<string, unknown> },
] });
function backlog(h: ReturnType<typeof host>) {
  for (let i = 0; i < 12; i++) {
    h.persist({ role: "user", content: `turn ${i}`, timestamp: 1 });
    h.persist(reply(`history ${i} ` + "word ".repeat(3000)));
  }
}

for (const stop of [false, true]) test(`68: N and C overlap; successful checkpoints ${stop ? "are fenced by stop" : "drain every due D pool"}; busy opportunities are discarded`, async () => {
  const h = host({ "noting.triggerTokens": 1e9, "consolidation.triggerTokens": 1, "dreaming.triggerTokens": 1 });
  let release!: () => void;
  const held = new Promise<void>(resolve => { release = resolve; });
  try {
    backlog(h); await h.emit("session_start");
    h.memory.setKnowledgeBudget("session", 1000);
    let cCalls = 0, dCalls = 0;
    h.provider(async (c, signal) => {
      if (phase(c) === "N") return notingFact(c);
      if (phase(c) === "C") {
        cCalls++;
        await Promise.race([held, new Promise<void>(resolve => signal!.addEventListener("abort", () => resolve(), { once: true }))]);
        if (signal?.aborted) return { ...reply(""), stopReason: "aborted" };
        return call("memory", { operations: [{ op: "create", topics: [], reason: "Admit supported conclusion", text: "constraint ".repeat(250),
          category: "constraint", scope: "session", supports: ["F1"] }], skipped: [] });
      }
      dCalls++;
      const r = h.memory.store.listKnowledgeRevisions().at(-1)!;
      return call("memory", { operations: [], skipped: [{ knowledge: `K${r.knowledgeId}@${r.id}`, because: "Reviewed; retain" }] });
    });
    await command(h, "catchup");
    await vi.waitFor(() => expect(cCalls).toBe(1));
    await settle(h);
    const runs = h.memory.store.listRuns(1);
    expect(runs.filter(r => r.kind === "noting" && r.outcome === "success").length).toBeGreaterThan(1);
    expect(h.memory.pendingEntries(1, "main", h.memory.store.listTurns(1).at(-1)!.id)).toEqual([]);
    expect(h.memory.store.getClaim(1, "consolidation")).not.toBeNull();
    expect(dCalls).toBe(0);
    if (stop) await command(h, "stop");
    release(); await settle(h);
    if (stop) expect(dCalls).toBe(0); else expect(dCalls).toBeGreaterThan(0);
    expect(cCalls).toBe(stop ? 1 : 2); // Success creates a fresh checkpoint; busy checks themselves are not queued.
    if (!stop) {
      expect(h.memory.store.listRuns(1).some(r => r.kind === "dreaming")).toBe(true);
      expect(h.memory.store.consolidationBatch(1, "main", h.memory.store.listTurns(1).at(-1)!.id)).toEqual([]);
      const settledDreams = dCalls;
      await settle(h); expect(cCalls).toBe(2); expect(dCalls).toBe(settledDreams);
    }
  } finally { release(); await h.dispose(); }
}, 30000);

test("68: catchup does not adopt an already-running ordinary N's downstream completion", async () => {
  const h = host({ "noting.forkModeDefault": false, "noting.triggerTokens": 1000, "consolidation.triggerTokens": 1 });
  let release!: () => void;
  const held = new Promise<void>(resolve => { release = resolve; });
  try {
    await h.turn();
    h.provider(async c => { await held; return phase(c) === "N" ? notingFact(c) : consolidationReply(c); });
    h.persist(reply("word ".repeat(3000))); await h.emit("agent_end"); await h.drain();
    expect(h.memory.store.getClaim(1, "noting")).not.toBeNull();
    await command(h, "catchup");
    expect(h.notices.at(-1)).toContain("waiting for noting");
    release(); await settle(h);
    const runs = h.memory.store.listRuns(1);
    expect(runs.filter(r => r.kind === "noting" && r.outcome === "success")).toHaveLength(1);
    expect(runs.filter(r => r.kind === "consolidation")).toEqual([]);
    expect(h.memory.store.consolidationBatch(1, "main", 1)).toHaveLength(1); // Above the host's configured 1-token trigger.
    await command(h, ""); expect(h.notices.at(-1)).toContain("Catchup: waiting for consolidation");
  } finally { release(); await h.dispose(); }
});

test("68: ordinary C completion settles a zero-Raw wait when it clears all due work, without replay", async () => {
  const h = host({ "noting.triggerTokens": 1e9, "consolidation.triggerTokens": 1, "dreaming.triggerTokens": 1e9 });
  let release!: () => void;
  const held = new Promise<void>(resolve => { release = resolve; });
  try {
    await h.turn();
    const store = h.memory.store, pending = h.memory.pendingEntries(1, "main", 1);
    const noted = store.commitNotingRun({ run: { kind: "manual", sessionId: 1, branch: "main", createdAt: "seed" },
      facts: [{ turnId: 1, category: "decision", actor: "user", text: "ordinary C clears this due work",
        source: ["T1#user"], createdAt: "seed" }], entryIds: pending.map(entry => entry.id) });
    if (!noted.ok) throw new Error(noted.problems.join("; "));
    h.provider(async c => { if (phase(c) === "C") await held; return consolidationReply(c); });
    await h.turn(); await h.drain();
    expect(store.getClaim(1, "consolidation")).not.toBeNull();
    const head = store.listTurns(1).at(-1)!.id, later = h.memory.pendingEntries(1, "main", head);
    const cleared = store.commitNotingRun({ run: { kind: "manual", sessionId: 1, branch: "main", createdAt: "clear" },
      facts: [], entryIds: later.map(entry => entry.id) });
    if (!cleared.ok) throw new Error(cleared.problems.join("; "));
    await command(h, "catchup");
    expect(h.notices.at(-1)).toContain("waiting for consolidation");
    release(); await settle(h);
    expect(store.listRuns(1).filter(run => run.kind === "consolidation" && run.outcome === "success")).toHaveLength(1);
    await command(h, ""); expect(h.notices.at(-1)).toContain("Catchup: completed");
  } finally { release(); await h.dispose(); }
});

test("67: C first launches at a later N completion when committed facts cross its ordinary trigger", async () => {
  const h = host({ "noting.triggerTokens": 1e9, "consolidation.triggerTokens": 500 });
  try {
    backlog(h); await h.emit("session_start");
    let firstCCompletedN = 0;
    h.provider(async c => {
      if (phase(c) !== "N") {
        firstCCompletedN ||= h.memory.store.listRuns(1).filter(r => r.kind === "noting" && r.outcome === "success").length;
        return consolidationReply(c);
      }
      const value = notingFact(c);
      for (const part of value.content) if (part.type === "toolCall" && part.name === "note") {
        const args = part.arguments as { facts: { text: string }[] };
        args.facts[0]!.text = "supported fact ".repeat(100);
      }
      return value;
    });
    await command(h, "catchup"); await settle(h);
    expect(firstCCompletedN).toBeGreaterThan(1);
    expect(h.memory.store.listRuns(1).some(r => r.kind === "consolidation" && r.outcome === "success")).toBe(true);
    expect(h.memory.store.listRuns(1).some(r => r.kind === "dreaming")).toBe(false);
  } finally { await h.dispose(); }
});

test("67: successful C checks but does not run D below its normal threshold", async () => {
  const h = host({ "noting.triggerTokens": 1e9, "consolidation.triggerTokens": 1 });
  try {
    await h.turn();
    h.provider(async c => phase(c) === "N" ? notingFact(c) : consolidationReply(c));
    const eligibility = vi.spyOn(Store.prototype, "duePools");
    await command(h, "catchup"); await settle(h);
    expect(h.memory.store.listRuns(1).filter(r => r.kind === "consolidation" && r.outcome === "success")).toHaveLength(1);
    expect(eligibility).toHaveBeenCalled();
    expect(h.memory.store.listRuns(1).filter(r => r.kind === "dreaming")).toEqual([]);
    eligibility.mockRestore();
  } finally { await h.dispose(); }
});

test("67: a global Dreamer seat conflict discards C's opportunity; release alone never replays it", async () => {
  const h = host({ "noting.triggerTokens": 1e9, "consolidation.triggerTokens": 1, "dreaming.triggerTokens": 1 });
  try {
    await h.turn(); h.memory.setKnowledgeBudget("session", 1000);
    const store = h.memory.store;
    const foreignSession = store.createSession({ host: "foreign", projectId: store.getSession(1)!.projectId,
      enrollmentChoice: true, startedAt: "now", firstReplyAt: "now" });
    const turn = store.appendTurn({ sessionId: foreignSession.id, kind: "turn", userPrompt: "foreign", startedAt: "now" });
    const entry = store.appendSourceEntry({ sessionId: foreignSession.id, turnId: turn.id, nativeLineage: "foreign", nativeId: "user",
      role: "user", text: "foreign", raw: JSON.stringify({ role: "user", content: "foreign" }), calls: [] });
    store.selectSourcePath(foreignSession.id, "main", [entry.id]);
    const noted = store.commitNotingRun({ run: { kind: "manual", sessionId: foreignSession.id, createdAt: "now" }, facts: [
      { turnId: turn.id, source: [`T${turn.id}#user`], entryIds: [entry.id], actor: "user", category: "decision", text: "foreign evidence", createdAt: "now" },
    ] });
    if (!noted.ok) throw new Error(noted.problems.join("; "));
    const seeded = store.commitConsolidationRun({ run: { kind: "manual", sessionId: foreignSession.id, createdAt: "now" }, operations: [
      { op: "create", handle: "$foreign", author: "test", text: "foreign rule", category: "constraint", scope: "session",
        supports: [noted.facts[0]!.id], topics: [], reason: "seat fixture", createdAt: "now" },
    ] });
    if (!seeded.ok) throw new Error(seeded.problems.join("; "));
    const claim = store.acquireClaim({ sessionId: foreignSession.id, branch: "main", headTurnId: turn.id }, "dreaming", "foreign-executor")!;
    expect(claim).not.toBeNull();
    let dreams = 0;
    h.provider(async c => {
      if (phase(c) === "N") return notingFact(c);
      if (phase(c) === "C") return call("memory", { operations: [{ op: "create", topics: [], reason: "Admit supported conclusion",
        text: "constraint ".repeat(250), category: "constraint", scope: "session", supports: [`F${store.listSessionFacts(1)[0]!.id}`] }], skipped: [] });
      dreams++;
      const r = store.listKnowledgeRevisions().at(-1)!;
      return call("memory", { operations: [], skipped: [{ knowledge: `K${r.knowledgeId}@${r.id}`, because: "Reviewed; retain" }] });
    });
    await command(h, "catchup"); await settle(h);
    expect(store.listRuns(1).filter(r => r.kind === "consolidation" && r.outcome === "success")).toHaveLength(1);
    expect(dreams).toBe(0); expect(store.getClaim(foreignSession.id, "dreaming")).toEqual(claim);
    expect(store.releaseClaim(claim)).toBe(true);
    await settle(h); expect(dreams).toBe(0);
    await h.turn(); await settle(h); expect(dreams).toBe(1); // A new ordinary opportunity checks again.
  } finally { await h.dispose(); }
});

test.each(["C", "D"] as const)("67: downstream %s business failure ends catchup honestly and never launches more work", async failedPhase => {
  const h = host({ "noting.triggerTokens": 1e9, "consolidation.triggerTokens": 1, "dreaming.triggerTokens": 1 });
  let release = () => {};
  const gate = new Promise<void>(resolve => { release = resolve; });
  let releaseNextNoter = () => {}, nextNoterHeld = false;
  const nextNoter = new Promise<void>(resolve => { releaseNextNoter = resolve; });
  let failingCalls = 0;
  try {
    backlog(h); await h.emit("session_start"); h.memory.setKnowledgeBudget("session", 1000);
    h.provider(async c => {
      if (phase(c) === "N") {
        if (h.memory.store.listRuns(1).some(r => r.kind === "noting" && r.outcome === "success")) {
          nextNoterHeld = true;
          await nextNoter;
        }
        return notingFact(c);
      }
      if (phase(c) === failedPhase) {
        failingCalls++;
        await gate;
        // The deterministic worker terminates unsuccessfully (non-retryable), so core
        // returns outcome:failure rather than a thrown admission error or cancellation.
        return { ...reply(""), stopReason: "error", errorMessage: "fixture terminal worker failure" };
      }
      return call("memory", { operations: [{ op: "create", topics: [], reason: "Supported conclusion",
        text: "constraint ".repeat(250), category: "constraint", scope: "session", supports: ["F1"] }], skipped: [] });
    });
    await command(h, "catchup");
    await vi.waitFor(() => { expect(failingCalls).toBeGreaterThan(0); expect(nextNoterHeld).toBe(true); });
    release();
    const kind = failedPhase === "C" ? "consolidation" : "dreaming";
    await vi.waitFor(() => expect(h.memory.store.listRuns(1).some(r => r.kind === kind && r.outcome === "failure")).toBe(true));
    // Existing work may commit, but failure must fence the next Noting batch, not
    // merely report failed after a drain that had already exhausted all its Raw.
    releaseNextNoter(); await settle(h);
    const runs = h.memory.store.listRuns(1);
    expect(runs.filter(r => r.kind === "noting" && r.outcome === "success")).toHaveLength(2);
    expect(h.memory.pendingEntries(1, "main", h.memory.store.listTurns(1).at(-1)!.id).length).toBeGreaterThan(0);
    expect(runs.filter(r => r.kind === kind && r.outcome === "failure")).toHaveLength(1);
    if (failedPhase === "C") expect(runs.some(r => r.kind === "dreaming")).toBe(false);
    else expect(h.memory.store.listKnowledgeRevisions().length).toBeGreaterThan(0);
    await command(h, ""); expect(h.notices.at(-1)).toContain("Catchup: failed");
    const requests = h.requests.length;
    await settle(h); await h.emit("session_tree"); await settle(h);
    expect(h.requests).toHaveLength(requests);
    expect(h.memory.store.listRuns(1)).toEqual(runs);
    await command(h, ""); expect(h.notices.at(-1)).toContain("Catchup: failed");
  } finally { release(); releaseNextNoter(); await h.dispose(); }
}, 30000);

test("67: entries persisted after catchup freezes do not extend Noting's boundary", async () => {
  const h = host({ "noting.triggerTokens": 1e9, "consolidation.triggerTokens": 1e9 });
  let release!: () => void;
  const held = new Promise<void>(resolve => { release = resolve; });
  try {
    backlog(h); await h.emit("session_start");
    const frozen = h.memory.pendingEntries(1, "main", h.memory.store.listTurns(1).at(-1)!.id).map(e => e.id);
    let calls = 0;
    h.provider(async c => { if (++calls === 1) await held; return notingFact(c); });
    await command(h, "catchup"); await h.drain();
    await h.turn();
    release(); await settle(h);
    const head = h.memory.store.listTurns(1).at(-1)!.id;
    const remaining = h.memory.pendingEntries(1, "main", head).map(e => e.id);
    expect(remaining.length).toBeGreaterThan(0);
    expect(remaining.some(id => frozen.includes(id))).toBe(false);
    expect(h.memory.store.listRuns(1).filter(r => r.kind === "consolidation")).toEqual([]);
  } finally { release(); await h.dispose(); }
}, 30000);
