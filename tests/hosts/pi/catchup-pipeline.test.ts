import { expect, test, vi } from "vitest";
import type { JsonObject } from "@earendil-works/pi-ai";
import { host, reply, notingFact, consolidationReply, type Reply } from "./test-host.ts";
import { Store } from "../../../src/core/store/index.ts";

const command = (h: ReturnType<typeof host>, args: string) => h.commands.get("trace").handler(args, h.ctx);
const phase = (c: { systemPrompt?: string }) => c.systemPrompt?.startsWith("# Dreamer") ? "D"
  : c.systemPrompt?.includes("You are the Consolidator:") ? "C" : "N";
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
          category: "constraint", scope: cCalls === 1 ? "global" : "session", supports: ["F1"] }], skipped: [] });
      }
      dCalls++;
      const changed = JSON.stringify(c.messages.at(-1));
      const handle = changed.match(/New (K\d+@\d+)/)?.[1];
      if (!handle) throw new Error(`fixture could not identify changed Dreamer handle: ${changed}`);
      return call("memory", { operations: [], skipped: [{ knowledge: handle, because: "Reviewed; retain" }] });
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
      expect(h.memory.store.listRuns(1).filter(r => r.kind === "dreaming" && r.outcome === "success").length).toBeGreaterThan(1);
      expect(h.memory.store.consolidationBatch(1, "main", h.memory.store.listTurns(1).at(-1)!.id)).toEqual([]);
      const settledDreams = dCalls;
      await settle(h); expect(cCalls).toBe(2); expect(dCalls).toBe(settledDreams);
    }
  } finally { release(); await h.dispose(); }
}, 30000);

test("68: catchup does not adopt an already-running ordinary N, but its success is a checkpoint that launches C", async () => {
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
    // The ordinary N's promise itself is never adopted — but under R4 its success is a full checkpoint,
    // so consolidation (now due from N's own facts) is launched by the drain, not stalled.
    release(); await settle(h);
    const runs = h.memory.store.listRuns(1);
    expect(runs.filter(r => r.kind === "noting" && r.outcome === "success")).toHaveLength(1);
    expect(runs.filter(r => r.kind === "consolidation" && r.outcome === "success")).toHaveLength(1);
    expect(h.memory.store.consolidationBatch(1, "main", h.memory.store.listTurns(1).at(-1)!.id)).toEqual([]);
    await command(h, ""); expect(h.notices.at(-1)).toContain("Catchup: completed");
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

test("68: a non-success ordinary C completion does not launch the drain", async () => {
  const h = host({ "noting.triggerTokens": 1e9, "consolidation.triggerTokens": 1 });
  let release!: () => void;
  const held = new Promise<void>(resolve => { release = resolve; });
  try {
    await h.turn();
    const store = h.memory.store, pending = h.memory.pendingEntries(1, "main", 1);
    const noted = store.commitNotingRun({ run: { kind: "manual", sessionId: 1, branch: "main", createdAt: "seed" },
      facts: [{ turnId: 1, category: "decision", actor: "user", text: "ordinary C target",
        source: ["T1#user"], createdAt: "seed" }], entryIds: pending.map(entry => entry.id) });
    if (!noted.ok) throw new Error(noted.problems.join("; "));
    h.provider(async c => {
      if (phase(c) !== "C") return notingFact(c);
      await held;
      // The deterministic worker terminates unsuccessfully (non-retryable): core returns
      // outcome:failure rather than a thrown admission error or cancellation.
      return { ...reply(""), stopReason: "error", errorMessage: "fixture terminal worker failure" };
    });
    await h.turn(); await h.drain();
    expect(store.getClaim(1, "consolidation")).not.toBeNull(); // ordinary C is busy
    const head = store.listTurns(1).at(-1)!.id, later = h.memory.pendingEntries(1, "main", head);
    const cleared = store.commitNotingRun({ run: { kind: "manual", sessionId: 1, branch: "main", createdAt: "clear" },
      facts: [], entryIds: later.map(entry => entry.id) }); // no Raw left for the drain's own N phase
    if (!cleared.ok) throw new Error(cleared.problems.join("; "));
    await command(h, "catchup");
    expect(h.notices.at(-1)).toContain("waiting for consolidation");
    release(); await settle(h);
    const runs = store.listRuns(1).filter(r => r.kind === "consolidation");
    expect(runs).toHaveLength(1); // the drain never adopted or replayed it: only the ordinary attempt ran
    expect(runs[0]!.outcome).toBe("failure");
    await command(h, ""); expect(h.notices.at(-1)).toContain("waiting for consolidation");
  } finally { release(); await h.dispose(); }
});

test("86: ordinary D partial commit survives terminal failure without a C/D completion check", async () => {
  const h = host({ "noting.triggerTokens": 1e9, "consolidation.triggerTokens": 1e9, "dreaming.triggerTokens": 1 });
  let release!: () => void;
  const held = new Promise<void>(resolve => { release = resolve; });
  let writeSubmitted = false, failureWaiting = false;
  try {
    await h.turn(); h.memory.setKnowledgeBudget("session", 1000);
    const tools = h.memory.tools({ kind: "manual", sessionId: 1, branch: "main", currentTurnId: 1 });
    expect(tools.find(t => t.name === "note")!.execute({ facts: [{ category: "decision", actor: "user",
      text: "Maintain this conclusion.", source: ["T1#user"] }] })).toContain("ok: F1");
    expect(tools.find(t => t.name === "memory")!.execute({ operations: [{ op: "create", topics: [],
      reason: "Seed version.", text: "Initial rule " + "word ".repeat(230), category: "constraint",
      scope: "session", supports: ["F1"] }], skipped: [] })).not.toContain("rejected:");
    const store = h.memory.store;
    const initial = store.listKnowledgeRevisions().at(-1)!;
    const eligible = vi.spyOn(h.memory, "taskEligibility");
    h.provider(async c => {
      if (phase(c) !== "D") return phase(c) === "N" ? notingFact(c) : consolidationReply(c);
      if (!writeSubmitted) {
        writeSubmitted = true;
        return call("memory", { operations: [{ op: "update", id: `K${initial.knowledgeId}@${initial.id}`,
          text: "Maintained rule " + "word ".repeat(230), category: "constraint", scope: "session",
          supports: [], topics: [], reason: "Update before worker failure" }], skipped: [] });
      }
      failureWaiting = true;
      await held;
      return { ...reply(""), stopReason: "error", errorMessage: "terminal D failure after commit" };
    }, { autoStop: false });
    await h.turn();
    await vi.waitFor(() => expect(failureWaiting).toBe(true));
    expect(store.listKnowledgeRevisions()).toHaveLength(2);
    const revised = store.listKnowledgeRevisions().at(-1)!;
    expect(revised.id).toBeGreaterThan(initial.id);
    const before = eligible.mock.calls.length;
    release(); await settle(h);
    expect(store.listKnowledgeRevisions()).toHaveLength(2); // the committed write was not rolled back or replayed
    expect(store.listKnowledgeRevisions().at(-1)!.id).toBe(revised.id);
    expect(store.listRuns(1).filter(run => run.kind === "dreaming").map(run => run.outcome)).toEqual(["failure"]);
    expect(eligible.mock.calls.length).toBe(before); // progress changed, but failure is not a checkpoint
    eligible.mockRestore();
  } finally { release(); await h.dispose(); }
}, 30000);

test("68: a repeated catchup command on a running drain does not start a second run", async () => {
  const h = host({ "noting.triggerTokens": 1e9, "consolidation.triggerTokens": 1 });
  let release!: () => void;
  const held = new Promise<void>(resolve => { release = resolve; });
  let cCalls = 0;
  try {
    backlog(h); await h.emit("session_start");
    h.provider(async c => {
      if (phase(c) === "N") return notingFact(c);
      cCalls++; await held; return consolidationReply(c);
    });
    await command(h, "catchup");
    await vi.waitFor(() => expect(cCalls).toBe(1));
    await command(h, ""); expect(h.notices.at(-1)).toContain("running consolidation");
    const requests = h.requests.length;
    // Repeating the command while the drain is running only reports the live run; it never starts a
    // second one alongside it.
    await command(h, "catchup");
    expect(cCalls).toBe(1);
    expect(h.requests.length).toBe(requests);
    expect(h.notices.at(-1)).toContain("running consolidation");
    // Releasing lets the drain's own fixpoint continue (more facts remain due, over several C batches);
    // that convergence is unrelated to the repeated command, which never added a run of its own.
    release(); await settle(h);
    expect(cCalls).toBeGreaterThanOrEqual(1);
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

test("68: a repeated catchup command re-checks a waiting idle drain and recovers a D admission dropped by a foreign claim", async () => {
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
    expect(dreams).toBe(0);
    await command(h, ""); expect(h.notices.at(-1)).toContain("waiting for dreaming");
    // The claim still holds: a repeated command re-checks and finds D still blocked. No new dream.
    await command(h, "catchup"); await settle(h);
    expect(dreams).toBe(0);
    await command(h, ""); expect(h.notices.at(-1)).toContain("waiting for dreaming");
    expect(store.releaseClaim(claim)).toBe(true);
    await settle(h); expect(dreams).toBe(0); // no in-process completion left to wake the drain (R4's gap)
    // The repeated command is the recovery: it re-checks and launches the now-unblocked D.
    await command(h, "catchup"); await settle(h);
    expect(dreams).toBe(1);
    await command(h, ""); expect(h.notices.at(-1)).toContain("Catchup: completed");
  } finally { await h.dispose(); }
});

test("86: a bounced N retries the frozen entry before checking C/D after correction", async () => {
  const h = host({ "noting.triggerTokens": 1e9, "consolidation.triggerTokens": 1e9, "dreaming.triggerTokens": 1e9 });
  try {
    await h.turn();
    const eligibility = vi.spyOn(Store.prototype, "duePools");
    let attempts = 0;
    const checksAtAdmission: number[] = [];
    h.provider(async c => {
      if (phase(c) !== "N") throw new Error("No other phase should run in this fixture");
      if (c.messages.some(m => m.role === "toolResult")) return reply("Done.");
      attempts++;
      checksAtAdmission.push(eligibility.mock.calls.length);
      if (attempts === 1) return call("note", { facts: [{ category: "observation", actor: "user",
        text: "Rejected source.", source: ["T99999#user"] }] });
      if (attempts === 2) return call("note", { facts: [] });
      throw new Error("N retried beyond correction");
    });
    await command(h, "catchup"); await settle(h);
    expect(h.memory.store.listRuns(1).filter(run => run.kind === "noting").map(run => run.outcome))
      .toEqual(["bounced", "success"]);
    expect(checksAtAdmission[0]).toBeGreaterThan(0); // Initial catchup checkpoint did inspect D.
    expect(checksAtAdmission).toEqual([checksAtAdmission[0], checksAtAdmission[0]]);
    expect(eligibility.mock.calls.length).toBeGreaterThan(checksAtAdmission[1]!);
    expect(h.memory.store.enabled(1)).toBe(true);
    await command(h, ""); expect(h.notices.at(-1)).toContain("Catchup: completed");
    eligibility.mockRestore();
  } finally { await h.dispose(); }
}, 30000);

test("86: rejected uncorrected N submissions bounce and retry without a C/D checkpoint until three failures turn memory off", async () => {
  const h = host({ "noting.triggerTokens": 1e9, "consolidation.triggerTokens": 1, "dreaming.triggerTokens": 1 });
  try {
    await h.turn();
    const eligibility = vi.spyOn(Store.prototype, "duePools");
    let attempts = 0;
    const checksAtAdmission: number[] = [];
    h.provider(async c => {
      if (phase(c) !== "N") throw new Error("A bounced N must not check or admit C/D");
      if (c.messages.some(m => m.role === "toolResult")) return reply("I will not correct the rejected submission.");
      attempts++;
      checksAtAdmission.push(eligibility.mock.calls.length);
      if (attempts > 3) throw new Error("N retried beyond automatic off");
      return call("note", { facts: [{ category: "observation", actor: "user",
        text: "Rejected source.", source: ["T99999#user"] }] });
    });
    await command(h, "catchup"); await settle(h);
    const runs = h.memory.store.listRuns(1).filter(run => run.kind === "noting");
    expect(runs.map(run => run.outcome)).toEqual(["bounced", "bounced", "bounced"]);
    expect(checksAtAdmission[0]).toBeGreaterThan(0); // Initial checkpoint; no checks on any bounce.
    expect(checksAtAdmission).toEqual([checksAtAdmission[0], checksAtAdmission[0], checksAtAdmission[0]]);
    expect(attempts).toBe(3);
    expect(h.memory.store.listSessionFacts(1)).toEqual([]);
    expect(h.memory.store.enabled(1)).toBe(false);
    expect(h.notices.some(notice => notice.includes("off after three failures"))).toBe(true);
    await command(h, ""); expect(h.notices.at(-1)).toContain("Catchup: stopped");
    eligibility.mockRestore();
  } finally { await h.dispose(); }
}, 30000);

test("86: downstream C business failure retries its logical task and three failures turn memory off", async () => {
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
      if (phase(c) === "C") {
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
    const kind = "consolidation";
    await vi.waitFor(() => expect(h.memory.store.listRuns(1).filter(r => r.kind === kind && r.outcome === "failure")).toHaveLength(3));
    releaseNextNoter(); await settle(h);
    const runs = h.memory.store.listRuns(1);
    expect(failingCalls).toBe(3);
    expect(runs.filter(r => r.kind === kind && r.outcome === "failure")).toHaveLength(3);
    expect(runs.some(r => r.kind === "dreaming")).toBe(false);
    expect(h.notices.some(n => n.includes("off after three failures"))).toBe(true);
    await command(h, ""); expect(h.notices.at(-1)).toContain("Catchup: stopped");
    const requests = h.requests.length;
    await settle(h); await h.emit("session_tree"); await settle(h);
    expect(h.requests).toHaveLength(requests);
  } finally { release(); releaseNextNoter(); await h.dispose(); }
}, 30000);

test("86: D retries the same pending revision and three business failures turn memory off", async () => {
  const h = host({ "noting.triggerTokens": 1e9, "consolidation.triggerTokens": 1e9, "dreaming.triggerTokens": 1 });
  let dreams = 0;
  try {
    await h.turn(); h.memory.setKnowledgeBudget("session", 1000);
    const tools = h.memory.tools({ kind: "manual", sessionId: 1, branch: "main", currentTurnId: 1 });
    expect(tools.find(t => t.name === "note")!.execute({ facts: [{ category: "decision", actor: "user",
      text: "Keep this conclusion.", source: ["T1#user"] }] })).toContain("ok: F1");
    expect(tools.find(t => t.name === "memory")!.execute({ operations: [{ op: "create", topics: [],
      reason: "Seed one unchanged revision.", text: "constraint ".repeat(250), category: "constraint",
      scope: "session", supports: ["F1"] }], skipped: [] })).not.toContain("rejected:");
    h.provider(async c => {
      if (phase(c) === "N") return notingFact(c);
      if (phase(c) !== "D") throw new Error("Unexpected consolidation admission");
      if (++dreams > 4) throw new Error("D attempted an unbounded retry");
      return { ...reply(""), stopReason: "error", errorMessage: "fixture D failure" };
    });
    await command(h, "catchup"); await settle(h);
    const executions = h.memory.store.db.prepare("SELECT head, outcome, terminal_run FROM task_executions WHERE phase = 'dreaming' ORDER BY rowid").all();
    const failures = h.memory.store.db.prepare("SELECT head, count FROM task_failures WHERE phase = 'dreaming'").all();
    expect(dreams).toBe(3);
    expect(new Set(executions.map(row => row.head)).size).toBe(1);
    expect(executions.map(row => row.outcome)).toEqual(["failure", "failure", "failure"]);
    expect(failures).toEqual([{ head: executions[0]!.head, count: 3 }]);
    await command(h, ""); expect(h.notices.at(-1)).toContain("Catchup: stopped");
  } finally { await command(h, "stop"); await h.dispose(); }
}, 30000);

test.each(["stop", "path"] as const)("86: Pi %s fences catchup retry despite a late D error reply", async action => {
  const h = host({ "noting.triggerTokens": 1e9, "consolidation.triggerTokens": 1e9, "dreaming.triggerTokens": 1 });
  let release!: () => void;
  const held = new Promise<void>(resolve => { release = resolve; });
  let dreams = 0, replied = false;
  try {
    await h.turn(); h.memory.setKnowledgeBudget("session", 1000);
    const tools = h.memory.tools({ kind: "manual", sessionId: 1, branch: "main", currentTurnId: 1 });
    expect(tools.find(t => t.name === "note")!.execute({ facts: [{ category: "decision", actor: "user",
      text: "Retain this rule.", source: ["T1#user"] }] })).toContain("ok: F1");
    expect(tools.find(t => t.name === "memory")!.execute({ operations: [{ op: "create", topics: [],
      reason: "Seed revision.", text: "constraint ".repeat(230), category: "constraint", scope: "session",
      supports: ["F1"] }], skipped: [] })).not.toContain("rejected:");
    h.provider(async c => {
      if (phase(c) !== "D") return phase(c) === "N" ? notingFact(c) : consolidationReply(c);
      dreams++;
      await held;
      replied = true;
      return { ...reply(""), stopReason: "error", errorMessage: "terminal D failure after cancellation" };
    }, { ignoreAbort: true });
    await command(h, "catchup");
    await vi.waitFor(() => expect(dreams).toBe(1));
    if (action === "stop") await command(h, "stop");
    else {
      h.entries.length = 0; h.allEntries.length = 0;
      h.ctx.sessionManager.getSessionId = () => "forked-session";
      await h.emit("session_tree");
    }
    release(); await settle(h);
    expect(replied).toBe(true);
    expect(dreams).toBe(1);
    await command(h, ""); expect(h.notices.at(-1)).toContain("Catchup: stopped");
  } finally { release(); await h.dispose(); }
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
