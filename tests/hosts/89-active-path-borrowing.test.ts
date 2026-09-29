import { expect, test, vi } from "vitest";
import { TraceMemory, type TaskTarget, type NotingAgentInput } from "../../src/core/api/index.ts";
import { CcTaskScheduler } from "../../src/hosts/cc/scheduler.ts";
import { resolveCcHostConfig } from "../../src/hosts/cc/config.ts";
import { host, reply, type Reply } from "./pi/test-host.ts";
import { knowledge, legacyFacts } from "../support/seed.ts";

const at = "2026-09-24T00:00:00.000Z";
function closedTarget(memory: ReturnType<typeof TraceMemory>, projectId: number, invalid = false) {
  const store = memory.store;
  const session = store.createSession({ host: "closed", projectId, startedAt: at, firstReplyAt: at, enrollmentChoice: true });
  const turn = store.appendTurn({ sessionId: session.id, kind: "turn", userPrompt: "Closed evidence", startedAt: at });
  const entry = memory.appendEntry({ sessionId: session.id, turnId: turn.id, nativeLineage: "closed", nativeId: "entry",
    role: "user", text: "Closed evidence", raw: "Closed evidence", calls: [] });
  store.publishSourcePath(session.id, "active", [entry.id], turn.id, "closed");
  legacyFacts(store, { kind: "manual", sessionId: session.id, branch: "active", createdAt: at },
    [{ sources: [{ entry, address: `T${turn.id}#E${entry.entryOrdinal}` }], text: "Closed rule",
      category: "decision", actor: "user", createdAt: at }]);
  store.closeSession(session.id);
  if (invalid) store.db.prepare("UPDATE session_lineage_cursors SET branch = 'missing' WHERE session_id = ?").run(session.id);
  return { sessionId: session.id, branch: "active", headTurnId: turn.id };
}

function abandonedSibling(memory: ReturnType<typeof TraceMemory>, target: TaskTarget) {
  const store = memory.store;
  const turn = store.appendTurn({ sessionId: target.sessionId, parentTurnId: target.headTurnId,
    kind: "turn", userPrompt: "ABANDONED_SIBLING", startedAt: at });
  const entry = memory.appendEntry({ sessionId: target.sessionId, turnId: turn.id, nativeLineage: "closed", nativeId: "sibling",
    role: "user", text: "ABANDONED_SIBLING", raw: "ABANDONED_SIBLING", calls: [] });
  const rootEntries = store.sourcePath(target.sessionId, target.branch, target.headTurnId).map(value => value.id);
  store.publishSourcePath(target.sessionId, "abandoned", [...rootEntries, entry.id], turn.id, "closed");
  const evidence = legacyFacts(store, { kind: "manual", sessionId: target.sessionId, branch: "abandoned", createdAt: at },
    [{ sources: [{ entry, address: `T${turn.id}#E${entry.entryOrdinal}` }], text: "ABANDONED_SIBLING",
      category: "decision", actor: "user", createdAt: at }]).facts[0]!;
  store.setCurrentPath(target.sessionId, target.branch, target.headTurnId, "closed");
  return { turn, entry, fact: evidence };
}

function expectConsumedOnlySibling(memory: ReturnType<typeof TraceMemory>, sessionId: number, sibling: ReturnType<typeof abandonedSibling>) {
  const store = memory.store;
  const runs = store.listRuns(sessionId).filter(run => run.kind !== "manual" && run.branch === "abandoned");
  expect(runs).toHaveLength(1);
  expect(runs[0]).toMatchObject({ kind: "noting", outcome: "success" });
  expect(store.db.prepare("SELECT entry_id FROM noted_entries WHERE run_id = ?").all(runs[0]!.id).map(row => Number(row.entry_id))).toEqual([sibling.entry.id]);
  expect(store.pendingEntries(sessionId, "abandoned", sibling.turn.id)).toEqual([]);
  // C retirement does not clear or replay historical unprocessed facts.
  expect(store.consolidationBatch(sessionId, "abandoned", sibling.turn.id).map(fact => fact.id))
    .toEqual(store.listSessionFacts(sessionId).map(fact => fact.id).sort((a, b) => a - b));
}

test("89: Pi borrows only active paths and consumes reactivated backlog at the next ordinary opportunity", async () => {
  const h = host({ "noting.triggerTokens": 1_000_000 });
  try {
    await h.turn();
    const store = h.memory.store;
    const target = closedTarget(h.memory, store.getSession(1)!.projectId);
    const sibling = abandonedSibling(h.memory, target);
    await h.prompt("executor opportunity"); await h.answer(); await h.drain();
    const runs = store.listRuns(target.sessionId).filter(run => run.kind !== "manual");
    expect(runs).toHaveLength(1);
    expect(runs[0]!.kind).toBe("noting");
    expect(runs.every(run => run.branch === target.branch && run.outcome === "success")).toBe(true);
    expect(store.pendingEntries(target.sessionId, "abandoned", sibling.turn.id).map(value => value.id)).toEqual([sibling.entry.id]);
    expect(store.consolidationBatch(target.sessionId, "abandoned", sibling.turn.id).map(value => value.id))
      .toEqual(store.listSessionFacts(target.sessionId).map(fact => fact.id).sort((a, b) => a - b));
    expect(JSON.stringify(h.conversations)).not.toContain("ABANDONED_SIBLING");
    const requestCount = h.requests.length;
    store.setCurrentPath(target.sessionId, "abandoned", sibling.turn.id, "closed");
    await h.drain();
    expect(h.requests).toHaveLength(requestCount);
    await h.prompt("next ordinary opportunity"); await h.answer(); await h.drain();
    expectConsumedOnlySibling(h.memory, target.sessionId, sibling);
  } finally { await h.dispose(); }
});

const worker = resolveCcHostConfig({ dbPath: "/tmp/unused-89.db", stateDir: "/tmp/unused-89",
  notingModel: "synthetic", notingThinking: "medium",
  "dreaming.model": "synthetic", "dreaming.thinking": "medium",
  worker: { cwd: "/tmp", claudeExecutable: "/missing/claude", contextWindows: { synthetic: 200_000 } } }).worker;

test("89: CC borrows only active paths and consumes reactivated backlog at the next ordinary opportunity", async () => {
  const inputs: NotingAgentInput[] = [];
  const memory = TraceMemory(":memory:", async raw => {
    const input = raw as NotingAgentInput;
    expect(input.kind).toBe("noting");
    inputs.push(input);
    input.reportRequest({ offline: true });
    if (input.kind === "noting") {
      input.tools.find(tool => tool.name === "note")!.execute({ facts: [] });
      input.tools.find(tool => tool.name === "memory")!.execute({ operations: [], skipped: [] });
    }
    return { outcome: "success", output: "No new knowledge.", request: { offline: true } };
  }, { noting: { triggerTokens: 1_000_000 } });
  try {
    const store = memory.store;
    const project = store.createProject({ name: "89-active", declaredBy: "mark" });
    const own = store.createSession({ host: "cc", projectId: project.id, startedAt: at, firstReplyAt: at, enrollmentChoice: true });
    const turn = store.appendTurn({ sessionId: own.id, kind: "turn", userPrompt: "own", startedAt: at });
    const ownEntries: number[] = [];
    const append = () => {
      const entry = memory.appendEntry({ sessionId: own.id, turnId: turn.id, nativeLineage: "cc", nativeId: `own-${ownEntries.length}`,
        role: "assistant", text: "own boundary", raw: "own boundary", calls: [] });
      ownEntries.push(entry.id);
      store.publishSourcePath(own.id, "main", ownEntries, turn.id, "cc");
      return entry.id;
    };
    const first = append();
    const target = closedTarget(memory, own.projectId);
    const sibling = abandonedSibling(memory, target);
    const diagnostics: string[] = [];
    const scheduler = new CcTaskScheduler(memory, worker, message => diagnostics.push(message));
    const opportunity = (appended: number[], ended = false) => {
      const projection = { state: "ready" as const, coreSessionId: own.id, branch: "main", headTurnId: turn.id,
        selectedEntryIds: [...ownEntries], selectedCount: ownEntries.length, selectedTailId: ownEntries.at(-1)!,
        selectedAppendedEntryIds: appended, appendedEntryIds: appended, problems: [], snapshot: {} as never };
      scheduler.reconcile(projection);
      if (ended) scheduler.turnEnd(projection, scheduler.catchupTicket());
    };
    opportunity([first], true); await scheduler.settle();
    expect(inputs).toHaveLength(1);
    expect(inputs[0]!.kind).toBe("noting");
    expect(inputs.every(input => input.sessionId === target.sessionId && input.branch === "active")).toBe(true);
    expect(inputs.every(input => !input.text.includes("ABANDONED_SIBLING"))).toBe(true);
    expect(store.pendingEntries(target.sessionId, "abandoned", sibling.turn.id).map(entry => entry.id)).toEqual([sibling.entry.id]);
    expect(store.consolidationBatch(target.sessionId, "abandoned", sibling.turn.id).map(fact => fact.id))
      .toEqual(store.listSessionFacts(target.sessionId).map(fact => fact.id).sort((a, b) => a - b));
    store.setCurrentPath(target.sessionId, "abandoned", sibling.turn.id, "closed");
    opportunity([]); await scheduler.settle();
    expect(inputs).toHaveLength(1);
    opportunity([append()], true); await scheduler.settle();
    expect(inputs).toHaveLength(2);
    expect(inputs.slice(1).every(input => input.sessionId === target.sessionId && input.branch === "abandoned")).toBe(true);
    expectConsumedOnlySibling(memory, target.sessionId, sibling);
    expect(diagnostics).toEqual([]);
  } finally { memory.close(); }
});

test("89: CC reports a real invalid cursor, discards the whole borrowed scan, and admits its own N/D", async () => {
  const memory = TraceMemory(":memory:", async () => { throw new Error("scheduler fixture must not call a model"); });
  try {
    const store = memory.store;
    const project = store.createProject({ name: "89", declaredBy: "mark" });
    const own = store.createSession({ host: "cc", projectId: project.id, startedAt: at, firstReplyAt: at, enrollmentChoice: true });
    const turn = store.appendTurn({ sessionId: own.id, kind: "turn", userPrompt: "own", startedAt: at });
    const entry = memory.appendEntry({ sessionId: own.id, turnId: turn.id, nativeLineage: "cc", nativeId: "own", role: "user", text: "own", raw: "own", calls: [] });
    store.publishSourcePath(own.id, "main", [entry.id], turn.id, "cc");
    const good = closedTarget(memory, own.projectId);
    const bad = closedTarget(memory, own.projectId, true);
    const diagnostics: string[] = [];
    // Exercise the real closed scan; isolate its failure from the two own workers' execution.
    const starts: { phase: string; target: Pick<TaskTarget, "sessionId" | "branch"> }[] = [];
    const record = (phase: string) => async (target: Pick<TaskTarget, "sessionId" | "branch">) => { starts.push({ phase, target }); return { outcome: "dropped" as const }; };
    vi.spyOn(memory, "taskEligibility").mockReturnValue({ due: true });
    vi.spyOn(memory, "noting").mockImplementation(record("noting"));
    vi.spyOn(memory, "dream").mockImplementation(record("dreaming"));
    const scheduler = new CcTaskScheduler(memory, worker, value => diagnostics.push(value));
    const projection = { state: "ready" as const, coreSessionId: own.id, branch: "main", headTurnId: turn.id,
      selectedEntryIds: [entry.id], selectedCount: 1, selectedTailId: entry.id,
      selectedAppendedEntryIds: [entry.id], appendedEntryIds: [entry.id], problems: [], snapshot: {} as never };
    scheduler.reconcile(projection);
    scheduler.turnEnd(projection, scheduler.catchupTicket());
    await scheduler.settle();
    expect(diagnostics.filter(value => value.includes("closed-session scan failed"))).toHaveLength(1);
    expect(starts.map(value => value.phase)).toEqual(["noting", "dreaming"]);
    expect(starts.every(value => value.target.sessionId === own.id)).toBe(true);
    for (const target of [good, bad]) expect(store.listRuns(target.sessionId).filter(run => run.kind !== "manual")).toEqual([]);
  } finally { memory.close(); vi.restoreAllMocks(); }
});

test("89: Pi reports a real invalid cursor while its own due N/D both reach their workers", async () => {
  const h = host({ "noting.forkModeDefault": false, "noting.triggerTokens": 1,
    "dreaming.triggerTokens": 1 });
  try {
    await h.turn();
    const store = h.memory.store;
    const own = store.getSession(1)!;
    const user = store.sourcePath(own.id, "main", 1).find(value => store.getSourceEntry(value.id)?.role === "user")!;
    const evidence = legacyFacts(store, { kind: "manual", sessionId: own.id, branch: "main", createdAt: at },
      [{ sources: [{ entry: user, address: `T1#E${user.entryOrdinal}` }], text: "Own rule",
        category: "decision", actor: "user", createdAt: at }]).facts[0]!;
    knowledge(store, store.knowledgePath(own.id, "main", 1), "session", "constraint", [evidence.id],
      "Own knowledge", { run: { kind: "manual", createdAt: at } });
    const good = closedTarget(h.memory, own.projectId);
    const bad = closedTarget(h.memory, own.projectId, true);
    await h.emit("session_tree");
    const before = h.conversations.length;
    h.provider(async () => new Promise<Reply>(() => {}));
    await h.prompt("next main turn");
    await h.answer("one ordinary scheduling opportunity");
    await vi.waitFor(() => expect(h.conversations.length - before).toBe(2));
    expect(h.notices.some(value => value.includes("noting closed-session scan failed"))).toBe(true);
    expect(h.notices.some(value => value.includes("consolidation closed-session scan failed"))).toBe(false);
    for (const phase of ["noting", "dreaming"] as const) {
      expect(store.getClaim(own.id, phase)?.borrowed).toBe(false);
      expect(store.getClaim(good.sessionId, phase)).toBeNull();
      expect(store.getClaim(bad.sessionId, phase)).toBeNull();
    }
  } finally { await h.dispose(); }
});
