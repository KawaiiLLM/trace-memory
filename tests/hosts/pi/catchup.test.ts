import { spawn } from "node:child_process";
import { once } from "node:events";
import { expect, test, vi } from "vitest";
import { TraceMemory, type NotingAgentInput } from "../../../src/core/api/index.ts";
import { createDreamerTrigger } from "../../admitted-dreamer-scenario.ts";
import { host, reply, notingFact, type Reply } from "./test-host.ts";

type Memory = ReturnType<typeof TraceMemory>;
const at = "2026-09-08T00:00:00.000Z";
function target(memory: Memory, options: { closed?: boolean; enabled?: boolean; facts?: number; noted?: boolean; branch?: string; project?: string } = {}) {
  const project = options.project ? memory.store.findProjectByName(options.project) ?? memory.store.createProject({ name: options.project, declaredBy: "mark" })
    : memory.store.getProject(memory.store.getSession(1)!.projectId)!;
  const session = memory.store.createSession({ host: "target-host", projectId: project.id, startedAt: at, firstReplyAt: at, enrollmentChoice: true });
  const turn = memory.store.appendTurn({ sessionId: session.id, kind: "turn", userPrompt: "Target evidence", startedAt: at });
  const entry = memory.appendEntry({ sessionId: session.id, turnId: turn.id, nativeId: `u${session.id}`, nativeLineage: "target", role: "user", text: "Target evidence", raw: "Target evidence", calls: [] });
  const path = { sessionId: session.id, branch: options.branch ?? "main", headTurnId: turn.id };
  memory.selectEntries(session.id, path.branch, [entry.id]);
  if (options.facts) {
    const result = memory.tools({ kind: "manual", sessionId: session.id, branch: path.branch, currentTurnId: turn.id })[2]!
      .execute({ facts: Array.from({ length: options.facts }, (_, i) => ({ title: `Target claim ${i}`, sources: [{ address: `T${turn.id}#E1`, text: `Target claim ${i}` }] })) });
    expect(result).not.toContain("rejected:");
  }
  if (options.noted) expect(memory.store.commitNotingRun({ run: { kind: "noting", sessionId: session.id, branch: path.branch, createdAt: at }, facts: [], entryIds: [entry.id] }).ok).toBe(true);
  if (options.closed !== false) memory.store.closeSession(session.id);
  if (options.enabled === false) memory.store.setEnrollment(session.id, false);
  return { ...path, projectId: project.id, entryId: entry.id };
}
const tick = async (h: ReturnType<typeof host>) => { await h.prompt("next main turn"); await h.answer("eligible completion"); await h.drain(); };
function hold(h: ReturnType<typeof host>) {
  const releases: ((reply: Reply) => void)[] = [];
  h.provider(async () => new Promise(resolve => releases.push(resolve)));
  return releases;
}

test("own pending N precedes closed tails; busy N does not fan out or chain on completion", async () => {
  const h = host({ "noting.triggerTokens": 1_000, "noting.forkModeDefault": false });
  try {
    await h.turn();
    const tails = Array.from({ length: 4 }, () => target(h.memory));
    const release = hold(h);
    await h.prompt("word ".repeat(15_000)); await h.answer(); await h.drain();
    expect(h.requests).toHaveLength(1);
    expect(h.memory.store.getClaim(1, "noting")?.borrowed).toBe(false);
    for (const tail of tails) expect(h.memory.store.getClaim(tail.sessionId, "noting")).toBeNull();
    await tick(h); await tick(h);
    expect(h.requests).toHaveLength(1);
    release[0]!(reply("No durable material.")); await h.drain();
    expect(h.memory.store.listRuns(1).filter(r => r.kind !== "manual")).toHaveLength(1);
    expect(h.requests).toHaveLength(1);
  } finally { await h.dispose(); }
});

test("borrowed N follows the oldest retained branch; a busy slot never takes another tail", async () => {
  const h = host({ "noting.triggerTokens": 1_000 });
  try {
    await h.turn();
    const first = target(h.memory, { branch: "z" });
    h.memory.selectEntries(first.sessionId, "a", [first.entryId]);
    const second = target(h.memory);
    const release = hold(h);
    await tick(h);
    expect(h.requests).toHaveLength(1);
    expect(h.memory.store.getClaim(first.sessionId, "noting")?.borrowed).toBe(true);
    expect(h.memory.store.getClaim(second.sessionId, "noting")).toBeNull();
    h.persist(reply("word ".repeat(15_000))); await h.emit("agent_end"); await h.drain();
    expect(h.requests).toHaveLength(1);
    release[0]!({ ...reply(""), stopReason: "error", errorMessage: "borrowed provider failure" }); await h.drain();
    expect(h.memory.store.listRuns(first.sessionId).filter(r => r.kind === "noting").map(r => [r.branch, r.outcome])).toEqual([["a", "failure"]]);
    expect(h.requests).toHaveLength(1); // failure cannot chain into another borrowed target
    expect(h.memory.pendingEntries(second.sessionId, second.branch, second.headTurnId)).toHaveLength(1);
    expect(h.signals[0]!.aborted).toBe(false); // arriving own work did not preempt borrowed N
    h.provider(async c => notingFact(c));
    await tick(h);
    expect(h.memory.store.listRuns(1).filter(r => r.kind === "noting").map(r => r.outcome)).toEqual(["success"]);
    expect(h.memory.pendingEntries(second.sessionId, second.branch, second.headTurnId)).toHaveLength(1);
  } finally { await h.dispose(); }
});

test("closed tiny pending Raw is borrowed below own trigger; noted-only, live and disabled tails remain untouched", async () => {
  const h = host();
  try {
    await h.turn();
    const live = target(h.memory, { closed: false });
    const disabled = target(h.memory, { enabled: false });
    const noted = target(h.memory, { noted: true, facts: 1 });
    const pending = target(h.memory);
    await tick(h);
    expect(h.requests).toHaveLength(3); // explicit note, memory, normal terminal reply
    expect(h.memory.store.listRuns(pending.sessionId).filter(r => r.kind === "noting")).toHaveLength(1);
    expect(h.memory.pendingEntries(pending.sessionId, pending.branch, pending.headTurnId)).toEqual([]);
    expect(h.memory.store.listRuns(live.sessionId)).toHaveLength(0);
    expect(h.memory.store.listRuns(disabled.sessionId)).toHaveLength(0);
    expect(h.memory.store.listRuns(noted.sessionId).filter(r => r.kind !== "manual")).toHaveLength(1); // explicit legacy seed only
    expect(h.memory.store.listSessionFacts(noted.sessionId)).toHaveLength(1); // retirement never clears historical facts
  } finally { await h.dispose(); }
});

test("two executors share exclusive N target claims and the loser does not steal a running tail", async () => {
  const a = host(); const b = host({ dbPath: a.dbPath });
  b.ctx.sessionManager.getSessionId = () => "pi-second";
  try {
    await a.turn(); await b.turn();
    a.memory.declareProject(1, "Shared executor project", "mark", a.memory.store.knowledgePath(1, "main"));
    a.memory.declareProject(2, "Shared executor project", "mark", a.memory.store.knowledgePath(2, "main"));
    const first = target(a.memory), second = target(a.memory);
    const ar = hold(a), br = hold(b);
    await Promise.all([tick(a), tick(b)]);
    expect(a.requests).toHaveLength(1); expect(b.requests).toHaveLength(1);
    const x = a.memory.store.getClaim(first.sessionId, "noting")!, y = a.memory.store.getClaim(second.sessionId, "noting")!;
    expect(x.executorId).not.toBe(y.executorId);
    const reader = TraceMemory(a.dbPath, async () => { throw new Error("claim bypass"); });
    try {
      expect((await reader.noting(first)).outcome).toBe("dropped");
      expect((await reader.noting({ ...first, branch: "sibling" })).outcome).toBe("dropped");
    } finally { reader.close(); }
    ar.concat(br).forEach(resolve => resolve(reply("Done"))); await a.drain(); await b.drain();
    for (const tail of [first, second]) expect(a.memory.store.listRuns(tail.sessionId).filter(r => r.kind === "noting")).toHaveLength(1);
  } finally { await b.dispose(); await a.dispose(); }
});

test("borrowed N publishes both layers to its target without a special executor delivery", async () => {
  const h = host();
  try {
    await h.turn();
    h.memory.declareProject(1, "Borrowed project", "mark", h.memory.store.knowledgePath(1, "main"));
    const t = target(h.memory, { project: "Borrowed project", branch: "target-branch" });
    const beforeDelivery = h.entries.filter(e => e.type === "custom_message").length;
    h.provider(async c => {
      const noteResult = c.messages.some(m => m.role === "toolResult" && m.toolName === "note");
      const memoryResult = c.messages.some(m => m.role === "toolResult" && m.toolName === "memory");
      if (memoryResult) return reply("Done");
      if (noteResult) return { ...reply(""), stopReason: "toolUse", content: [{ type: "toolCall", id: "borrowed-memory", name: "memory",
        arguments: { operations: [{ op: "create", text: "Target knowledge", category: "understanding", scope: "project",
          topics: [], reason: "Retain the target's finding.", supports: ["$1"] }], skipped: [] } }] };
      const note = notingFact(c);
      return { ...note, content: [note.content[0]!] };
    });
    await tick(h);
    const runs = h.memory.store.listRuns(t.sessionId).filter(r => r.kind === "noting");
    expect(runs).toHaveLength(1);
    expect(runs[0]).toMatchObject({ branch: t.branch, mode: "subagent", outcome: "success" });
    const fact = h.memory.store.listSessionFacts(t.sessionId)[0]!;
    expect(fact).toBeDefined();
    const visible = h.memory.store.listVisibleKnowledge(t.sessionId, t.projectId);
    expect(visible).toHaveLength(1);
    expect(visible[0]!.knowledge).toMatchObject({ originSessionId: t.sessionId, projectId: t.projectId });
    expect(visible[0]!.revision.scope).toBe("project");
    expect(visible[0]!.revision.supports).toEqual([fact.id]);
    expect(h.memory.store.listVisibleKnowledge(1, t.projectId)[0]!.knowledge.originSessionId).toBe(t.sessionId);
    expect(h.memory.spend(t.sessionId).input).toBeGreaterThan(0);
    expect(h.memory.spend(1).input).toBe(0);
    expect(h.entries.filter(e => e.type === "custom_message")).toHaveLength(beforeDelivery);
    // Later ordinary same-project delivery remains eligible; worker completion itself injected nothing.
    expect((await h.prompt("after borrowed work"))?.message?.content ?? "").not.toContain("<noted>");
  } finally { await h.dispose(); }
});

test("an owned D pool uses a real pending version and keeps its global seat separate from borrowed N", async () => {
  const h = host({ "noting.triggerTokens": 1_000_000_000 });
  try {
    await h.turn();
    const receipt = h.memory.tools({ kind: "manual", sessionId: 1, branch: "main", currentTurnId: 1 })[2]!
      .execute({ facts: [{ title: "Package choice", sources: [{ address: "T1#E1", text: "User chose pnpm" }] }] });
    expect(receipt).not.toContain("rejected:");
    const path = { sessionId: 1, branch: "main", headTurnId: 1 };
    const due = createDreamerTrigger(h.memory, path, 1, 1);
    expect(h.memory.taskEligibility("dreaming", path)).toEqual({ due: true });
    const borrowed = target(h.memory);
    const pending: { conversation: { systemPrompt?: string; messages: { content: unknown }[] }; resolve: (value: Reply) => void }[] = [];
    h.provider(async c => {
      if (c.systemPrompt?.startsWith("# Dreamer") && c.messages.some(m => m.role === "toolResult")) return reply("Done");
      return new Promise<Reply>(resolve => pending.push({ conversation: c, resolve }));
    });
    await tick(h);
    await vi.waitFor(() => expect(h.requests).toHaveLength(2));
    expect(h.memory.store.getClaim(1, "dreaming")).not.toBeNull();
    expect(h.memory.store.getClaim(borrowed.sessionId, "noting")?.borrowed).toBe(true);
    expect(h.memory.store.getClaim(borrowed.sessionId, "dreaming")).toBeNull();
    for (const item of pending) {
      if (!item.conversation.systemPrompt?.startsWith("# Dreamer")) { item.resolve(reply("Done")); continue; }
      const material = String(item.conversation.messages[0]!.content);
      const version = material.match(/New (K\d+@v\d+)/)?.[1];
      if (version !== `K${due.knowledgeId}@v1`) throw new Error(`unexpected D frozen range: ${material.slice(0, 400)}`);
      item.resolve({ ...reply(""), stopReason: "toolUse", content: [{ type: "toolCall", id: "memory-1", name: "memory",
        arguments: { operations: [], skipped: [{ knowledge: version, because: "Reviewed; retain" }] } }] });
    }
    await h.drain();
    expect(h.memory.store.listRuns(1).filter(r => r.kind === "dreaming").map(r => r.outcome)).toEqual(["success"]);
    expect(h.memory.store.getKnowledge(due.knowledgeId)).not.toBeNull();
  } finally { await h.dispose(); }
});

test("N commit rejects a replaced borrowed claim token without publishing progress", async () => {
  const h = host();
  let input!: NotingAgentInput, finish!: () => void;
  const worker = TraceMemory(h.dbPath, async raw => { input = raw as NotingAgentInput; input.reportRequest({ phase: "noting" }); await new Promise<void>(r => { finish = r; }); return { outcome: "success", output: "", request: {} }; });
  try {
    await h.turn();
    const t = target(h.memory, { facts: 1 });
    const pending = worker.noting({ ...t, borrowed: true, executorSessionId: 1 });
    const old = h.memory.store.getClaim(t.sessionId, "noting")!;
    h.memory.store.invalidateExecutor(old.executorId);
    const replacement = h.memory.store.acquireClaim(t, "noting", old.executorId, true)!;
    expect(replacement.token).not.toBe(old.token);
    input.tools[2]!.execute({ facts: [{ title: "Late", sources: [{ address: `T${t.headTurnId}#E1`, text: "Late" }] }] });
    input.tools[3]!.execute({ operations: [], skipped: [] });
    finish(); expect((await pending).outcome).not.toBe("success");
    expect(h.memory.store.getClaim(t.sessionId, "noting")!.token).toBe(replacement.token);
    expect(h.memory.pendingEntries(t.sessionId, t.branch, t.headTurnId)).toHaveLength(1);
    expect(h.memory.store.listSessionFacts(t.sessionId)).toHaveLength(1);
  } finally { worker.close(); await h.dispose(); }
});

test("reopening a closed target replaces borrowed N token and prevents stale publication", async () => {
  const h = host();
  let finish!: () => void;
  const old = TraceMemory(h.dbPath, async () => { await new Promise<void>(r => { finish = r; }); return { outcome: "success", output: "", request: {} }; });
  const own = TraceMemory(h.dbPath, async raw => {
    const input = raw as NotingAgentInput;
    input.tools.find(t => t.name === "note")!.execute({ facts: [] });
    input.tools.find(t => t.name === "memory")!.execute({ operations: [], skipped: [] });
    return { outcome: "success", output: "", request: {} }; });
  try {
    await h.turn();
    const t = target(h.memory);
    const pending = old.noting({ ...t, borrowed: true, executorSessionId: 1 });
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

test("one shutdown deadline fences borrowed N and owned D even when both providers hang", async () => {
  const h = host({ "noting.triggerTokens": 1_000 });
  try {
    await h.turn();
    const receipt = h.memory.tools({ kind: "manual", sessionId: 1, branch: "main", currentTurnId: 1 })[2]!
      .execute({ facts: [{ title: "Package choice", sources: [{ address: "T1#E1", text: "User chose pnpm" }] }] });
    expect(receipt).not.toContain("rejected:");
    const due = createDreamerTrigger(h.memory, { sessionId: 1, branch: "main", headTurnId: 1 }, 1, 1);
    const t = target(h.memory);
    h.provider(async () => new Promise<Reply>(() => {}), { ignoreAbort: true });
    await tick(h);
    await vi.waitFor(() => expect(h.requests).toHaveLength(2));
    const borrowed = h.memory.store.getClaim(t.sessionId, "noting")!;
    const owned = h.memory.store.getClaim(1, "dreaming")!;
    expect(borrowed.borrowed).toBe(true);
    expect(owned).not.toBeNull();
    expect(h.memory.store.getClaim(t.sessionId, "dreaming")).toBeNull();
    h.persist(reply("word ".repeat(15_000))); await h.emit("agent_end"); await h.drain();
    expect(h.requests).toHaveLength(2);
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    let done = false;
    const shutdown = h.emit("session_shutdown").then(() => { done = true; });
    await h.drain();
    expect(h.signals).toHaveLength(2);
    expect(h.signals.every(signal => signal.aborted)).toBe(true);
    expect(h.memory.store.getClaim(t.sessionId, "noting")!.expiresAt).toBe(0);
    await vi.advanceTimersByTimeAsync(4999); expect(done).toBe(false);
    await vi.advanceTimersByTimeAsync(1); expect(done).toBe(true);
    await shutdown;
    expect(h.memory.store.getClaim(borrowed.sessionId, "noting")).toBeNull();
    expect(h.memory.store.getClaim(owned.sessionId, "dreaming")).toBeNull();
    expect(h.memory.store.getSession(1)!.closedAt).not.toBeNull();
    expect(h.memory.store.getSession(t.sessionId)!.closedAt).not.toBeNull();
    expect(h.memory.pendingEntries(1, "main", 1).length).toBeGreaterThan(0);
    expect(h.memory.pendingEntries(t.sessionId, t.branch, t.headTurnId)).toHaveLength(1);
    expect(h.memory.store.getKnowledge(due.knowledgeId)).not.toBeNull();
    for (const sessionId of [1, t.sessionId]) {
      const run = h.memory.store.listRuns(sessionId).filter(r => r.kind === (sessionId === 1 ? "dreaming" : "noting")).at(-1)!;
      expect(run.outcome).toBe("cancelled"); expect(JSON.parse(run.response!).usage).toBeNull();
      expect(h.memory.trace(`R${run.id}`)).toContain("cost unknown");
    }
    await expect(tick(h)).rejects.toThrow("closed"); expect(h.requests).toHaveLength(2);
  } finally { vi.useRealTimers(); await h.dispose(); }
});

test("shutdown cancels retry waits, retains available usage, and discards held N", async () => {
  const h = host({ "noting.triggerTokens": 30, retry: { baseDelayMs: 60_000 } });
  try {
    h.provider(async c => c.messages.some(m => m.role === "toolResult") ? { ...reply(""), stopReason: "error", errorMessage: "503 overloaded" } : notingFact(c), { autoStop: false });
    await h.turn();
    expect(h.memory.store.listSessionFacts(1)).toHaveLength(0);
    expect(h.requests).toHaveLength(2);
    const started = performance.now(); await h.emit("session_shutdown");
    expect(performance.now() - started).toBeLessThan(1000);
    const run = h.memory.store.listRuns(1)[0]!;
    expect(run.outcome).toBe("cancelled");
    expect(JSON.parse(run.response!).output).toContain("503 overloaded");
    expect(JSON.parse(run.response!).usage.input).toBe(1);
    expect(JSON.parse(run.response!).retries).toHaveLength(1);
    expect(h.memory.pendingEntries(1, "main", 1)).toHaveLength(2);
  } finally { await h.dispose(); }
});

test("late rejection after shutdown never touches the closed store; a normal restore reopens", async () => {
  const h = host({ "noting.triggerTokens": 30 });
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

test("claim-release failure after terminal N publication does not roll back committed success", async () => {
  const h = host();
  const worker = TraceMemory(h.dbPath, async raw => {
    const input = raw as NotingAgentInput;
    input.reportRequest({ phase: "noting" });
    input.tools[2]!.execute({ facts: [] });
    input.tools[3]!.execute({ operations: [], skipped: [] });
    return { outcome: "success", output: "", request: {} };
  });
  try {
    await h.turn();
    const t = target(h.memory);
    const release = vi.spyOn(worker.store, "releaseClaim").mockImplementation(() => { throw new Error("release unavailable"); });
    const result = await worker.noting(t);
    expect(result.outcome).toBe("success");
    if (result.outcome !== "success") throw new Error("expected committed success");
    expect(result.problems!.join(" ")).toContain("release unavailable");
    expect(h.memory.store.getRun(result.runId)!.outcome).toBe("success");
    expect(h.memory.pendingEntries(t.sessionId, t.branch, t.headTurnId)).toEqual([]);
    release.mockRestore();
  } finally { vi.restoreAllMocks(); worker.close(); await h.dispose(); }
});

test("resume takes crashed claims immediately; tree navigation keeps owned N running", async () => {
  const h = host({ "noting.triggerTokens": 1_000 });
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
    await h.prompt("next main turn"); await h.answer("word ".repeat(15_000)); await h.drain();
    expect(h.requests).toHaveLength(1);
    const running = h.memory.store.getClaim(1, "noting")!;
    expect(running.reserved).toBe(false);
    await h.emit("session_tree");
    expect(h.memory.store.getClaim(1, "noting")!.token).toBe(running.token);
    release[0]!(reply("Done")); await h.drain();
  } finally { await h.dispose(); }
});

test("database contention cannot multiply shutdown deadline; cleanup errors are reported", async () => {
  const h = host({ "noting.triggerTokens": 30 });
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

test("disabled executors cannot acquire or commit borrowed N; project change fences frozen attribution", async () => {
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
      if (!moved && value && typeof value === "object" && "entries" in value) {
        moved = true; h.memory.declareProject(1, "Moved project", "mark", { sessionId: 1, branch: "main", headTurnId: 1 });
      }
      return value;
    });
    const projectChange = worker.noting({ ...t, borrowed: true, executorSessionId: 1 });
    seam.mockRestore(); expect(moved).toBe(true);
    finish(); expect((await projectChange).outcome).toBe("failure");
    expect(h.memory.pendingEntries(t.sessionId, t.branch, t.headTurnId)).toHaveLength(1);
  } finally { worker.close(); await h.dispose(); }
});

test("failed own capacity admission leaves its N slot free for a smaller closed tail", async () => {
  const h = host({ "noting.triggerTokens": 30 });
  try {
    h.ctx.model = { ...h.ctx.model!, contextWindow: 20000 };
    h.persist({ role: "user", content: "word ".repeat(15000), timestamp: 1 });
    h.persist(reply("seed")); await h.emit("session_start");
    const t = target(h.memory);
    await tick(h);
    expect(h.requests, h.notices.join("\n")).toHaveLength(3);
    expect(h.conversations[0]!.messages[0]!.content).toContain(`S${t.sessionId}/T${t.headTurnId}`);
    expect(h.notices.join(" ")).toContain("Noting capacity: selected evidence cannot fit the model context");
    expect(h.memory.store.getClaim(1, "noting")).toBeNull();
    expect(h.memory.pendingEntries(1, "main", 1).length).toBeGreaterThan(0);
    expect(h.memory.pendingEntries(t.sessionId, t.branch, t.headTurnId)).toEqual([]);
  } finally { await h.dispose(); }
});
