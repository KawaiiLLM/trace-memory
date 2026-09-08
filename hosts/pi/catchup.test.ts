import { spawn } from "node:child_process";
import { once } from "node:events";
import { expect, test, vi } from "vitest";
import { TraceMemory, type NotingAgentInput, type ConsolidationAgentInput } from "../../core/api/index.ts";
import { host, reply, notingFact, type Reply } from "./test-host.ts";

type Memory = ReturnType<typeof TraceMemory>;
const at = "2026-09-08T00:00:00.000Z";
function target(memory: Memory, options: { closed?: boolean; enabled?: boolean; facts?: number; noted?: boolean; branch?: string; project?: string } = {}) {
  const project = memory.store.createProject({ name: options.project ?? "target", declaredBy: "mark" });
  const session = memory.store.createSession({ host: "target-host", projectId: project.id, startedAt: at, firstReplyAt: at, enrollmentChoice: true });
  const turn = memory.store.appendTurn({ sessionId: session.id, kind: "turn", userPrompt: "Target evidence", startedAt: at });
  const entry = memory.appendEntry({ sessionId: session.id, turnId: turn.id, nativeId: `u${session.id}`, nativeLineage: "target", role: "user", text: "Target evidence", raw: "Target evidence", calls: [] });
  const path = { sessionId: session.id, branch: options.branch ?? "main", headTurnId: turn.id };
  memory.selectEntries(session.id, path.branch, [entry.id]);
  if (options.facts) memory.tools({ kind: "manual", sessionId: session.id, branch: path.branch, currentTurnId: turn.id })[2]!.execute({ facts:
    Array.from({ length: options.facts }, (_, i) => ({ category: "observation", actor: "user", text: `Target claim ${i}`, source: [`T${turn.id}#user`] })) });
  if (options.noted) expect(memory.store.commitNotingRun({ run: { kind: "noting", sessionId: session.id, branch: path.branch, createdAt: at }, facts: [], entryIds: [entry.id] }).ok).toBe(true);
  if (options.closed !== false) memory.store.closeSession(session.id);
  if (options.enabled === false) memory.store.setEnrollment(session.id, false);
  return { ...path, projectId: project.id, entryId: entry.id };
}
const tick = async (h: ReturnType<typeof host>) => { h.persist(reply("eligible completion")); await h.emit("agent_end"); await h.drain(); };
const phaseOf = (conversation: { systemPrompt?: string }) => conversation.systemPrompt?.includes("### Second-round user message") ? "consolidation" : "noting";
function hold(h: ReturnType<typeof host>) {
  const releases: ((reply: Reply) => void)[] = [];
  h.provider(async () => new Promise(resolve => releases.push(resolve)));
  return releases;
}

test("17c 2026-09-08: two executor slots prefer own work over several closed tails and never fan out", async () => {
  const h = host({ "noting.branchModeDefault": false });
  try {
    await h.turn();
    const tails = Array.from({ length: 4 }, () => target(h.memory, { facts: 1 }));
    h.memory.tools({ kind: "manual", sessionId: 1, branch: "main", currentTurnId: 1 })[2]!.execute({ facts:
      Array.from({ length: 50 }, (_, i) => ({ category: "observation", actor: "user", text: `Own claim ${i}`, source: ["T1#user"] })) });
    const release = hold(h);
    h.persist(reply("word ".repeat(15000))); await h.emit("agent_end"); await h.drain();
    expect(h.requests).toHaveLength(2);
    for (const phase of ["noting", "consolidation"] as const) {
      expect(h.memory.store.getClaim(1, phase)?.borrowed).toBe(false);
      for (const tail of tails) expect(h.memory.store.getClaim(tail.sessionId, phase)).toBeNull();
    }
    await tick(h); await tick(h);
    expect(h.requests).toHaveLength(2);
    release.forEach(resolve => resolve(reply("No durable material."))); await h.drain();
    expect(h.memory.store.listRuns(1).filter(r => r.kind !== "manual")).toHaveLength(2);
    expect(h.requests).toHaveLength(2);
  } finally { await h.dispose(); }
});

test("17c 2026-09-08: busy borrowed slots are not preempted or chained; later entries take oldest tails with stable branch order", async () => {
  const h = host({ "noting.branchModeDefault": false });
  try {
    await h.turn();
    const first = target(h.memory, { facts: 1, branch: "z" });
    h.memory.selectEntries(first.sessionId, "a", [first.entryId]);
    const second = target(h.memory, { facts: 1 });
    const release = hold(h);
    await tick(h);
    expect(h.requests).toHaveLength(2);
    for (const phase of ["noting", "consolidation"] as const) expect(h.memory.store.getClaim(first.sessionId, phase)?.borrowed).toBe(true);
    expect(h.conversations[0]!.messages[0]!.content).toContain(`S${first.sessionId}/T${first.headTurnId}`);
    h.persist(reply("word ".repeat(15000))); await h.emit("agent_end"); await h.drain();
    expect(h.requests).toHaveLength(2); expect(h.signals.every(s => !s.aborted)).toBe(true);
    release.forEach(resolve => resolve(reply("No durable material."))); await h.drain();
    expect(h.requests).toHaveLength(2);
    expect(h.memory.store.listRuns(first.sessionId).filter(r => r.kind !== "manual").map(r => r.branch)).toEqual(["a", "a"]);
    expect(h.memory.pendingEntries(second.sessionId, second.branch, second.headTurnId)).toHaveLength(1);
    h.provider(async () => reply("No durable material."));
    await tick(h);
    expect(h.memory.store.listRuns(1).some(r => r.kind === "noting")).toBe(true); // own priority on the next opportunity
    expect(h.memory.store.listConsolidatedFacts(h.memory.store.listRuns(second.sessionId).at(-1)!.id)).toHaveLength(1);
  } finally { await h.dispose(); }
});

test("17c 2026-09-08: tiny closed tails bypass thresholds; empty Noting does not hide Consolidation; live and disabled targets never launch", async () => {
  const h = host();
  try {
    await h.turn();
    const live = target(h.memory, { facts: 1, closed: false });
    const disabled = target(h.memory, { facts: 1, enabled: false });
    const factsOnly = target(h.memory, { facts: 1, noted: true });
    const entryOnly = target(h.memory);
    await tick(h);
    expect(h.requests).toHaveLength(2);
    expect(h.memory.store.listRuns(live.sessionId)).toHaveLength(1);
    expect(h.memory.store.listRuns(disabled.sessionId)).toHaveLength(1);
    expect(h.memory.store.consolidationBatch(factsOnly.sessionId, factsOnly.branch, factsOnly.headTurnId)).toEqual([]);
    expect(h.memory.pendingEntries(entryOnly.sessionId, entryOnly.branch, entryOnly.headTurnId)).toEqual([]);
    expect(h.memory.pendingEntries(1, "main", 1).length).toBeGreaterThan(0);
    expect(h.memory.store.listRuns(1)).toEqual([]);
    expect(h.memory.store.listRuns(entryOnly.sessionId)[0]!.mode).toBe("subagent");
  } finally { await h.dispose(); }
});

test("17c 2026-09-08: two active executors share target claims and the loser selects another target", async () => {
  const a = host(); const b = host({ dbPath: a.dbPath });
  b.ctx.sessionManager.getSessionId = () => "pi-second";
  try {
    await a.turn(); await b.turn();
    const first = target(a.memory, { facts: 1 }), second = target(a.memory, { facts: 1 });
    const ar = hold(a), br = hold(b);
    await Promise.all([tick(a), tick(b)]);
    expect(a.requests).toHaveLength(2); expect(b.requests).toHaveLength(2);
    for (const phase of ["noting", "consolidation"] as const) {
      const x = a.memory.store.getClaim(first.sessionId, phase)!, y = a.memory.store.getClaim(second.sessionId, phase)!;
      expect(x.executorId).not.toBe(y.executorId);
      const reader = TraceMemory(a.dbPath, async () => { throw new Error("claim bypass"); });
      try {
        expect((await (phase === "noting" ? reader.noting(first) : reader.consolidate(first))).outcome).toBe("dropped");
        expect((await (phase === "noting" ? reader.noting({ ...first, branch: "sibling" }) : reader.consolidate(first))).outcome).toBe("dropped");
      } finally { reader.close(); }
    }
    ar.concat(br).forEach(resolve => resolve(reply("Done"))); await a.drain(); await b.drain();
    for (const t of [first, second]) expect(a.memory.store.listRuns(t.sessionId).filter(r => r.kind !== "manual")).toHaveLength(2);
  } finally { await b.dispose(); await a.dispose(); }
});

test("17c 2026-09-08: borrowed requests freeze target project and branch; costs, commits and deliveries stay with target", async () => {
  const h = host({ "consolidation.subagentModeDefault": false });
  try {
    await h.turn();
    const t = target(h.memory, { facts: 1, project: "Borrowed project", branch: "target-branch" });
    const f = h.memory.store.listSessionFacts(t.sessionId)[0]!;
    const operations = [{ op: "create", text: "Target knowledge", category: "term", scope: "project", supports: [`F${f.id}`], because: [`F${f.id}`] }];
    h.provider(async c => phaseOf(c) === "noting" ? notingFact(c) : ({ ...reply(""), stopReason: "toolUse", content: [{ type: "toolCall", id: "memory", name: "memory", arguments: { operations, skipped: [] } }] }));
    await tick(h);
    const runs = h.memory.store.listRuns(t.sessionId).filter(r => r.kind !== "manual");
    expect(runs).toHaveLength(2); expect(runs.every(r => r.branch === t.branch && r.mode === "subagent" && r.outcome === "success")).toBe(true);
    expect(h.memory.store.listVisibleKnowledge(t.sessionId, t.projectId).map(k => k.knowledge.originSessionId)).toEqual([t.sessionId]);
    expect(h.memory.spend(t.sessionId).input).toBeGreaterThan(0); expect(h.memory.spend(1).input).toBe(0);
    expect(h.memory.deliver(1, "main").runIds).toEqual([]);
    expect(h.memory.deliver(t.sessionId, t.branch).text).toContain("<noted>");
    expect(h.memory.deliver(t.sessionId, t.branch).text).toContain("<consolidated>");
  } finally { await h.dispose(); }
});

test.each(["noting", "consolidation"] as const)("17c 2026-09-08: %s commit transaction rejects a replaced token without progress", async phase => {
  const h = host();
  let input!: NotingAgentInput | ConsolidationAgentInput, finish!: () => void;
  const worker = TraceMemory(h.dbPath, async raw => { input = raw as typeof input; input.reportRequest({ request: phase }); await new Promise<void>(r => { finish = r; }); return { outcome: "success", output: "", request: { request: phase } }; });
  try {
    const t = target(h.memory, { facts: 1 });
    const pending = phase === "noting" ? worker.noting({ ...t, borrowed: true }) : worker.consolidate({ ...t, borrowed: true });
    const old = h.memory.store.getClaim(t.sessionId, phase)!;
    h.memory.store.invalidateExecutor(old.executorId); // Do not close tools: exercise the transaction fence itself.
    const replacement = h.memory.store.acquireClaim(t, phase, old.executorId, true)!;
    expect(replacement.token).not.toBe(old.token);
    if (phase === "noting") input.tools[2]!.execute({ facts: [{ category: "observation", actor: "user", text: "Late", source: [`T${t.headTurnId}#user`] }] });
    else {
      input.tools[3]!.execute({ operations: [], skipped: [] }); input.reportRequest({ round: 2 });
      input.tools[3]!.execute({ operations: [], skipped: [] });
    }
    finish(); expect((await pending).outcome).not.toBe("success");
    expect(h.memory.store.getClaim(t.sessionId, phase)!.token).toBe(replacement.token);
    expect(h.memory.pendingEntries(t.sessionId, t.branch, t.headTurnId)).toHaveLength(1);
    expect(h.memory.store.consolidationBatch(t.sessionId, t.branch, t.headTurnId)).toHaveLength(1);
    expect(h.memory.store.listSessionFacts(t.sessionId)).toHaveLength(1);
  } finally { worker.close(); await h.dispose(); }
});

test("17c 2026-09-08: reopen blocks selection and immediately replaces borrowed tokens; stale completion cannot clear the new owner", async () => {
  const h = host();
  let finish!: () => void;
  const old = TraceMemory(h.dbPath, async () => { await new Promise<void>(r => { finish = r; }); return { outcome: "success", output: "", request: {} }; });
  const own = TraceMemory(h.dbPath, async () => ({ outcome: "success", output: "", request: {} }));
  try {
    const t = target(h.memory);
    const pending = old.noting({ ...t, borrowed: true });
    const before = h.memory.store.getClaim(t.sessionId, "noting")!;
    own.store.reopenSession(t.sessionId, own.executorId);
    const replaced = own.store.getClaim(t.sessionId, "noting")!;
    expect(replaced.token).not.toBe(before.token); expect(replaced.executorId).toBe(own.executorId);
    expect(own.store.getSession(t.sessionId)!.closedAt).toBeNull();
    expect(own.store.acquireClaim(t, "noting", "late-borrower", true)).toBeNull();
    finish(); expect((await pending).outcome).toBe("failure");
    expect(own.store.getClaim(t.sessionId, "noting")!.token).toBe(replaced.token);
    expect(own.pendingEntries(t.sessionId, t.branch, t.headTurnId)).toHaveLength(1);
    expect((await own.noting(t)).outcome).toBe("success");
  } finally { old.close(); own.close(); await h.dispose(); }
});

test("17c 2026-09-08: shared five-second shutdown deadline fences own and borrowed workers even when providers never resolve", async () => {
  const h = host({ "noting.branchModeDefault": false });
  try {
    await h.turn();
    const t = target(h.memory, { facts: 1, noted: true });
    // Intentionally ignores cancellation forever: a wedged connection the child cannot end.
    h.provider(async () => new Promise<Reply>(() => {}), { ignoreAbort: true });
    h.persist(reply("word ".repeat(15000))); await h.emit("agent_end"); await h.drain();
    expect(h.requests).toHaveLength(2);
    const ownClaim = h.memory.store.getClaim(1, "noting")!, borrowed = h.memory.store.getClaim(t.sessionId, "consolidation")!;
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    let done = false;
    const shutdown = h.emit("session_shutdown").then(() => { done = true; });
    await h.drain();
    expect(h.signals.every(signal => signal.aborted)).toBe(true);
    expect(h.memory.store.getClaim(1, "noting")!.expiresAt).toBe(0);
    expect(h.memory.store.getClaim(t.sessionId, "consolidation")!.expiresAt).toBe(0);
    await vi.advanceTimersByTimeAsync(4999); expect(done).toBe(false);
    await vi.advanceTimersByTimeAsync(1); expect(done).toBe(true);
    await shutdown;
    expect(h.memory.store.getClaim(ownClaim.sessionId, "noting")).toBeNull();
    expect(h.memory.store.getClaim(borrowed.sessionId, "consolidation")).toBeNull();
    expect(h.memory.store.getSession(1)!.closedAt).not.toBeNull();
    expect(h.memory.store.getSession(t.sessionId)!.closedAt).not.toBeNull();
    expect(h.memory.pendingEntries(1, "main", 1).length).toBeGreaterThan(0);
    expect(h.memory.store.consolidationBatch(t.sessionId, t.branch, t.headTurnId)).toHaveLength(1);
    for (const sessionId of [1, t.sessionId]) {
      const run = h.memory.store.listRuns(sessionId).at(-1)!;
      expect(run.outcome).toBe("cancelled"); expect(JSON.parse(run.response!).usage).toBeNull();
      expect(run.response).toContain("unknown");
      expect(h.memory.trace(`R${run.id}`)).toContain("cost unknown");
    }
    await expect(tick(h)).rejects.toThrow("closed"); expect(h.requests).toHaveLength(2);
  } finally { vi.useRealTimers(); await h.dispose(); }
});

test("17c 2026-09-08: shutdown cancels retry waits, retains available usage, and never restarts a committed batch", async () => {
  const h = host({ "noting.branchModeDefault": false, "noting.triggerTokens": 60, retry: { baseDelayMs: 60_000 } });
  try {
    h.provider(async c => c.messages.some(m => m.role === "toolResult") ? { ...reply(""), stopReason: "error", errorMessage: "503 overloaded" } : notingFact(c), { autoStop: false });
    await h.turn();
    expect(h.memory.store.listSessionFacts(1)).toHaveLength(1);
    expect(h.requests).toHaveLength(2);
    const started = performance.now(); await h.emit("session_shutdown");
    expect(performance.now() - started).toBeLessThan(1000);
    const run = h.memory.store.listRuns(1)[0]!;
    expect(run.outcome).toBe("success"); expect(run.response).toContain("cancelled");
    // Available usage is retained: the attempt that reached the provider reported 1 input token, and
    // the attempt that died in transport reported none (19c: usage now comes from the child's own
    // responses, and a connection error produces no usage at all).
    expect(JSON.parse(run.response!).usage.input).toBe(1); expect(JSON.parse(run.response!).retries).toHaveLength(1);
    expect(h.requests).toHaveLength(2); expect(h.memory.pendingEntries(1, "main", 1)).toEqual([]);
  } finally { await h.dispose(); }
});

test("17c 2026-09-08: late rejection after deadline is consumed, normal restore clears closure, and late results never touch the closed store", async () => {
  const h = host({ "noting.branchModeDefault": false, "noting.triggerTokens": 60 });
  let reject!: (error: Error) => void;
  try {
    h.provider(async () => new Promise<Reply>((_, r) => { reject = r; }));
    await h.turn();
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const shutdown = h.emit("session_shutdown"); await vi.advanceTimersByTimeAsync(5000); await shutdown;
    const runs = h.memory.store.listRuns(1);
    reject(new Error("late provider failure")); await h.drain();
    expect(h.memory.store.listRuns(1)).toEqual(runs);
    vi.useRealTimers();
    const reopened = host({ dbPath: h.dbPath });
    try {
      reopened.entries.push(...h.entries); reopened.allEntries.push(...h.allEntries);
      await reopened.emit("session_start");
      expect(reopened.memory.store.getSession(1)!.closedAt).toBeNull();
      expect(reopened.requests).toEqual([]);
    } finally { await reopened.dispose(); }
  } finally { vi.useRealTimers(); await h.dispose(); }
});


test.each(["noting", "consolidation"] as const)("17c 2026-09-08: %s cleanup or audit failure preserves committed success", async phase => {
  const h = host();
  const worker = TraceMemory(h.dbPath, async raw => {
    const input = raw as NotingAgentInput | ConsolidationAgentInput;
    input.reportRequest({ phase });
    if (phase === "noting") input.tools[2]!.execute({ facts: [] });
    else { input.tools[3]!.execute({ operations: [], skipped: [] }); input.reportRequest({ phase, round: 2 }); input.tools[3]!.execute({ operations: [], skipped: [] }); }
    return { outcome: "success", output: "", request: { phase } };
  });
  try {
    const t = target(h.memory, { facts: 1 });
    const release = vi.spyOn(worker.store, "releaseClaim").mockImplementation(() => { throw new Error("release unavailable"); });
    const audit = vi.spyOn(worker.store, "updateRun").mockImplementation(() => { throw new Error("audit unavailable"); });
    const result = await (phase === "noting" ? worker.noting(t) : worker.consolidate(t));
    expect(result.outcome).toBe("success");
    if (result.outcome !== "success") throw new Error("expected committed success");
    expect(result.problems!.join(" ")).toContain("release unavailable");
    expect(result.problems!.join(" ")).toContain("audit unavailable");
    expect(h.memory.store.getRun(result.runId)!.outcome).toBe("success");
    if (phase === "noting") expect(h.memory.pendingEntries(t.sessionId, t.branch, t.headTurnId)).toEqual([]);
    else expect(h.memory.store.consolidationBatch(t.sessionId, t.branch, t.headTurnId)).toEqual([]);
    release.mockRestore(); audit.mockRestore();
  } finally { vi.restoreAllMocks(); worker.close(); await h.dispose(); }
});

test("17c 2026-09-08: resume takes crashed claims immediately without inventing closure; tree navigation keeps its worker", async () => {
  const h = host();
  try {
    await h.turn();
    const path = { sessionId: 1, branch: "main", headTurnId: 1 };
    const old = h.memory.store.acquireClaim(path, "noting", "dead-executor")!;
    expect(h.memory.store.getSession(1)!.closedAt).toBeNull();
    await h.emit("session_start");
    const claim = h.memory.store.getClaim(1, "noting")!;
    expect(claim.token).not.toBe(old.token); expect(claim.reserved).toBe(true);
    expect(h.memory.store.getSession(1)!.closedAt).toBeNull();
    const release = hold(h);
    h.persist(reply("word ".repeat(15000))); await h.emit("agent_end"); await h.drain();
    expect(h.requests).toHaveLength(1); expect(h.memory.store.getClaim(1, "noting")!.reserved).toBe(false);
    const running = h.memory.store.getClaim(1, "noting")!;
    await h.emit("session_tree");
    expect(h.memory.store.getClaim(1, "noting")!.token).toBe(running.token);
    release[0]!(reply("Done")); await h.drain();
  } finally { await h.dispose(); }
});

test("17c 2026-09-08: database contention cannot multiply shutdown deadline; cleanup errors are reported", async () => {
  const h = host({ "noting.branchModeDefault": false, "noting.triggerTokens": 60 });
  let holder: ReturnType<typeof spawn> | undefined;
  let exited: Promise<unknown> | undefined;
  try {
    h.provider(async (_c, signal) => new Promise<Reply>(resolve => signal!.addEventListener("abort", () => resolve({ ...reply(""), stopReason: "aborted" }), { once: true })));
    await h.turn();
    holder = spawn(process.execPath, ["--input-type=module", "-e", `
      import { DatabaseSync } from "node:sqlite";
      const store = new DatabaseSync(${JSON.stringify(h.dbPath)});
      store.exec("BEGIN IMMEDIATE");
      process.send("locked");
      process.on("message", () => { store.exec("ROLLBACK"); store.close(); process.exit(0); });
    `], { stdio: ["ignore", "pipe", "inherit", "ipc"] });
    exited = once(holder, "exit"); await once(holder, "message");
    const started = performance.now(); await h.emit("session_shutdown");
    expect(performance.now() - started).toBeLessThan(1000);
    expect(h.notices.join("\n")).toContain("locked");
    expect(h.signals.every(signal => signal.aborted)).toBe(true);
    holder.send("release"); await exited;
    expect(h.memory.store.listSessionFacts(1)).toEqual([]);
    expect(h.memory.pendingEntries(1, "main", 1)).toHaveLength(2);
  } finally {
    if (holder && holder.exitCode === null && holder.signalCode === null) holder.kill("SIGKILL");
    if (exited) await exited;
    await h.dispose();
  }
});


test("17c 2026-09-08: disabled executors cannot acquire or commit borrowed work; target project changes keep frozen work pending", async () => {
  const h = host();
  let finish!: () => void;
  const worker = TraceMemory(h.dbPath, async () => { await new Promise<void>(r => { finish = r; }); return { outcome: "success", request: {}, output: "" }; });
  try {
    await h.turn();
    const t = target(h.memory);
    h.memory.store.setEnrollment(1, false);
    expect((await worker.noting({ ...t, borrowed: true, executorSessionId: 1 })).outcome).toBe("dropped");
    h.memory.store.setEnrollment(1, true);
    const pending = worker.noting({ ...t, borrowed: true, executorSessionId: 1 });
    h.memory.store.setEnrollment(1, false);
    finish(); expect((await pending).outcome).toBe("failure");
    expect(h.memory.pendingEntries(t.sessionId, t.branch, t.headTurnId)).toHaveLength(1);
    h.memory.store.setEnrollment(1, true);
    const transaction = worker.store.transaction.bind(worker.store);
    let moved = false;
    const seam = vi.spyOn(worker.store, "transaction").mockImplementation(<T>(fn: () => T): T => {
      const value = transaction(fn);
      // A second connection changes attribution immediately after the freeze transaction ends.
      if (!moved && value && typeof value === "object" && "entries" in value) {
        moved = true; h.memory.declareProject(t.sessionId, "Moved project");
      }
      return value;
    });
    const projectChange = worker.noting({ ...t, borrowed: true, executorSessionId: 1 });
    seam.mockRestore(); expect(moved).toBe(true);
    finish(); expect((await projectChange).outcome).toBe("failure");
    expect(h.memory.pendingEntries(t.sessionId, t.branch, t.headTurnId)).toHaveLength(1);
  } finally { worker.close(); await h.dispose(); }
});


test("17c 2026-09-08: failed own capacity admission leaves the slot free for a smaller closed tail", async () => {
  const h = host({ "noting.branchModeDefault": false });
  try {
    h.ctx.model = { ...h.ctx.model!, contextWindow: 12000, maxTokens: 1000 };
    h.persist({ role: "user", content: "word ".repeat(15000), timestamp: 1 });
    h.persist(reply("seed")); await h.emit("session_start");
    const t = target(h.memory);
    await tick(h);
    expect(h.requests).toHaveLength(1);
    expect(h.conversations[0]!.messages[0]!.content).toContain(`S${t.sessionId}/T${t.headTurnId}`);
    expect(h.notices.join(" ")).toContain("oldest entry cannot fit");
    expect(h.memory.store.getClaim(1, "noting")).toBeNull();
    expect(h.memory.pendingEntries(1, "main", 1).length).toBeGreaterThan(0);
    expect(h.memory.pendingEntries(t.sessionId, t.branch, t.headTurnId)).toEqual([]);
  } finally { await h.dispose(); }
});
