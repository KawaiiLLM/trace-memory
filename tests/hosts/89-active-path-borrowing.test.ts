import { expect, test, vi } from "vitest";
import { TraceMemory, type TaskTarget } from "../../src/core/api/index.ts";
import { CcTaskScheduler } from "../../src/hosts/cc/scheduler.ts";
import { resolveCcHostConfig } from "../../src/hosts/cc/config.ts";
import { host, reply, type Reply } from "./pi/test-host.ts";

const at = "2026-09-24T00:00:00.000Z";
function closedTarget(memory: ReturnType<typeof TraceMemory>, projectId: number, invalid = false) {
  const store = memory.store;
  const session = store.createSession({ host: "closed", projectId, startedAt: at, firstReplyAt: at, enrollmentChoice: true });
  const turn = store.appendTurn({ sessionId: session.id, kind: "turn", userPrompt: "Closed evidence", startedAt: at });
  const entry = memory.appendEntry({ sessionId: session.id, turnId: turn.id, nativeLineage: "closed", nativeId: "entry",
    role: "user", text: "Closed evidence", raw: "Closed evidence", calls: [] });
  store.publishSourcePath(session.id, "active", [entry.id], turn.id, "closed");
  const noted = store.commitNotingRun({ run: { kind: "manual", sessionId: session.id, branch: "active", createdAt: at },
    facts: [{ turnId: turn.id, category: "decision", actor: "user", text: "Closed rule", source: [`T${turn.id}#user`], createdAt: at }] });
  if (!noted.ok) throw new Error(noted.problems.join("; "));
  store.closeSession(session.id);
  if (invalid) store.db.prepare("UPDATE session_lineage_cursors SET branch = 'missing' WHERE session_id = ?").run(session.id);
  return { sessionId: session.id, branch: "active", headTurnId: turn.id };
}

test("89: Pi borrows only the retained cursor path and leaves its abandoned sibling pending", async () => {
  const h = host({ "noting.triggerTokens": 1_000_000, "consolidation.triggerTokens": 1_000_000 });
  try {
    await h.turn();
    const store = h.memory.store;
    const target = closedTarget(h.memory, store.getSession(1)!.projectId);
    const sibling = store.appendTurn({ sessionId: target.sessionId, parentTurnId: target.headTurnId,
      kind: "turn", userPrompt: "ABANDONED_SIBLING", startedAt: at });
    const entry = h.memory.appendEntry({ sessionId: target.sessionId, turnId: sibling.id, nativeLineage: "closed", nativeId: "sibling",
      role: "user", text: "ABANDONED_SIBLING", raw: "ABANDONED_SIBLING", calls: [] });
    const rootEntries = store.sourcePath(target.sessionId, target.branch, target.headTurnId).map(value => value.id);
    store.publishSourcePath(target.sessionId, "abandoned", [...rootEntries, entry.id], sibling.id, "closed");
    const noted = store.commitNotingRun({ run: { kind: "manual", sessionId: target.sessionId, branch: "abandoned", createdAt: at },
      facts: [{ turnId: sibling.id, category: "decision", actor: "user", text: "ABANDONED_SIBLING", source: [`T${sibling.id}#user`], createdAt: at }] });
    if (!noted.ok) throw new Error(noted.problems.join("; "));
    store.setCurrentPath(target.sessionId, target.branch, target.headTurnId, "closed");
    await h.prompt("executor opportunity"); await h.answer(); await h.drain();
    const runs = store.listRuns(target.sessionId).filter(run => run.kind !== "manual");
    expect(runs).toHaveLength(2);
    expect(new Set(runs.map(run => run.kind))).toEqual(new Set(["noting", "consolidation"]));
    expect(runs.every(run => run.branch === target.branch && run.outcome === "success")).toBe(true);
    expect(store.pendingEntries(target.sessionId, "abandoned", sibling.id).map(value => value.id)).toEqual([entry.id]);
    expect(store.consolidationBatch(target.sessionId, "abandoned", sibling.id).map(value => value.id)).toEqual([noted.facts[0]!.id]);
    expect(JSON.stringify(h.conversations)).not.toContain("ABANDONED_SIBLING");
  } finally { await h.dispose(); }
});

const worker = resolveCcHostConfig({ dbPath: "/tmp/unused-89.db", stateDir: "/tmp/unused-89",
  notingModel: "synthetic", notingThinking: "medium", consolidationModel: "synthetic", consolidationThinking: "medium",
  "dreaming.model": "synthetic", "dreaming.thinking": "medium",
  worker: { cwd: "/tmp", claudeExecutable: "/missing/claude", claudeVersion: "2.1.280", contextWindows: { synthetic: 200_000 } } }).worker;

test("89: CC reports a real invalid cursor, discards the whole borrowed scan, and admits its own N/C/D", async () => {
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
    // Exercise the real closed scan; isolate its failure from the three own workers' execution.
    const starts: { phase: string; target: Pick<TaskTarget, "sessionId" | "branch"> }[] = [];
    const record = (phase: string) => async (target: Pick<TaskTarget, "sessionId" | "branch">) => { starts.push({ phase, target }); return { outcome: "dropped" as const }; };
    vi.spyOn(memory, "taskEligibility").mockReturnValue({ due: true });
    vi.spyOn(memory, "noting").mockImplementation(record("noting"));
    vi.spyOn(memory, "consolidate").mockImplementation(record("consolidation"));
    vi.spyOn(memory, "dream").mockImplementation(record("dreaming"));
    const scheduler = new CcTaskScheduler(memory, worker, value => diagnostics.push(value));
    scheduler.reconcile({ state: "ready", coreSessionId: own.id, branch: "main", headTurnId: turn.id,
      selectedEntryIds: [entry.id], selectedCount: 1, selectedTailId: entry.id,
      selectedAppendedEntryIds: [entry.id], appendedEntryIds: [entry.id], problems: [], snapshot: {} as never });
    await scheduler.settle();
    expect(diagnostics.filter(value => value.includes("closed-session scan failed"))).toHaveLength(2);
    expect(starts.map(value => value.phase)).toEqual(["noting", "consolidation", "dreaming"]);
    expect(starts.every(value => value.target.sessionId === own.id)).toBe(true);
    for (const target of [good, bad]) expect(store.listRuns(target.sessionId).filter(run => run.kind !== "manual")).toEqual([]);
  } finally { memory.close(); vi.restoreAllMocks(); }
});

test("89: Pi reports a real invalid cursor while its own due N/C/D all reach their workers", async () => {
  const h = host({ "noting.forkModeDefault": false, "noting.triggerTokens": 1,
    "consolidation.triggerTokens": 1, "dreaming.triggerTokens": 1 });
  try {
    await h.turn();
    const store = h.memory.store;
    const own = store.getSession(1)!;
    const noted = store.commitNotingRun({ run: { kind: "manual", sessionId: own.id, branch: "main", createdAt: at },
      facts: [{ turnId: 1, category: "decision", actor: "user", text: "Own rule", source: ["T1#user"], createdAt: at }] });
    if (!noted.ok) throw new Error(noted.problems.join("; "));
    const knowledge = store.commitConsolidationRun({ run: { kind: "manual", sessionId: own.id, branch: "main", createdAt: at },
      operations: [{ op: "create", handle: "$own", author: "test", text: "Own knowledge", category: "constraint", scope: "session",
        supports: [noted.facts[0]!.id], topics: [], reason: "seed own due pool", createdAt: at }] });
    if (!knowledge.ok) throw new Error(knowledge.problems.join("; "));
    const good = closedTarget(h.memory, own.projectId);
    const bad = closedTarget(h.memory, own.projectId, true);
    await h.emit("session_tree");
    const before = h.conversations.length;
    h.provider(async () => new Promise<Reply>(() => {}));
    h.persist(reply("one ordinary scheduling opportunity"));
    await h.emit("agent_end");
    await vi.waitFor(() => expect(h.conversations.length - before).toBe(3));
    expect(h.notices.some(value => value.includes("noting closed-session scan failed"))).toBe(true);
    expect(h.notices.some(value => value.includes("consolidation closed-session scan failed"))).toBe(true);
    for (const phase of ["noting", "consolidation", "dreaming"] as const) {
      expect(store.getClaim(own.id, phase)?.borrowed).toBe(false);
      expect(store.getClaim(good.sessionId, phase)).toBeNull();
      expect(store.getClaim(bad.sessionId, phase)).toBeNull();
    }
  } finally { await h.dispose(); }
});
