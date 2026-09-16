import { expect, test, vi } from "vitest";
import { host, reply, type Reply } from "./test-host.ts";

const compact = (h: ReturnType<typeof host>, signal?: AbortSignal) =>
  h.emit("session_before_compact", { preparation: { tokensBefore: 100000 }, signal }) as Promise<any>;
const failure = (): Reply => ({ ...reply(""), stopReason: "error", errorMessage: "ordinary retained Dreamer failure" });

async function seeded() {
  const h = host({ "noting.triggerTokens": 1e9, "consolidation.triggerTokens": 1e9,
    "dreaming.triggerTokens": 5000,
    "compaction.factsTokens": 10000, "compaction.rawTokens": 10000, "compaction.overflowTokens": 50 });
  try {
    h.memory.setKnowledgeBudget("global", 0);
    h.memory.setKnowledgeBudget("project", 0);
    h.memory.setKnowledgeBudget("session", 0);
    await h.turn();
    const s = h.memory.store;
    const f = s.commitNotingRun({ run: { kind: "manual", sessionId: 1, createdAt: "seed" }, facts: [{ turnId: 1, source: ["T1#user"], actor: "user", category: "decision", text: "Keep this rule", createdAt: "seed" }] });
    if (!f.ok) throw Error(f.problems.join());
    const c = s.commitConsolidationRun({ run: { kind: "manual", sessionId: 1, createdAt: "seed" }, operations: [{ op: "create", handle: "$1", author: "test", text: "rule ".repeat(6000), category: "constraint", scope: "project", supports: [f.facts[0]!.id], topics: [], reason: "evidence", createdAt: "seed" }] });
    if (!c.ok) throw Error(c.problems.join());
    return { h, s, item: c.committed[0]! };
  } catch (error) { await h.dispose(); throw error; }
}

// Ordinary D freezes at T2. Compact starts at T3 (or later), but would admit that same retained
// range, not today's leaf or newly arrived Raw. The native provider gate proves actual reuse.
test.each(["failure", "success", "partial"] as const)("32f review: ordinary D T2→T3 retained reuse (%s)", async outcome => {
  const { h, s, item } = await seeded();
  let release!: () => void;
  const held = new Promise<void>(resolve => { release = resolve; });
  try {
    let calls = 0;
    h.provider(async () => {
      calls++;
      await held;
      if (outcome === "failure" || (outcome === "partial" && calls > 1)) return failure();
      if (calls > 1) return reply("Done.");
      return { ...reply(""), stopReason: "toolUse", content: [{ type: "toolCall", id: "archive", name: "memory", arguments: { operations: [{ op: "archive", id: `K${item.knowledgeId}@${item.commit}`, supports: [], reason: "Deliberate retirement for budget" }], skipped: [] } }] };
    }, { autoStop: false });
    await h.turn();
    await vi.waitFor(() => expect(h.requests).toHaveLength(1));
    const range = s.retryDreamingRange({ sessionId: 1, branch: "main", headTurnId: 2 });
    expect(range).toMatchObject({ headTurnId: 2 });
    await h.turn();
    if (outcome === "failure") { await h.turn(); await h.turn(); } // repeated head/Raw advances keep range T2
    const controller = new AbortController();
    const cancelled = compact(h, controller.signal), waiter = compact(h);
    await vi.waitFor(() => expect(h.notices.filter(n => n.includes("compaction is waiting") && n.includes("Dreamer"))).toHaveLength(2));
    controller.abort();
    expect(await cancelled).toEqual({ cancel: true });
    expect(s.getClaim(1, "dreaming")).not.toBeNull();
    release();
    const result = await waiter;
    await h.drain();
    expect(calls).toBe(outcome === "failure" ? 1 : 2);
    expect(h.requests).toHaveLength(calls);
    expect(s.listRuns(1).filter(r => r.kind === "dreaming")).toMatchObject([{ outcome: outcome === "success" ? "success" : "failure" }]);
    expect(s.listRuns(1).filter(r => r.kind === "dreaming")).toHaveLength(1);
    expect(s.db.prepare("SELECT * FROM task_executions WHERE phase = 'dreaming'").all()).toHaveLength(1);
    expect(s.taskFailures(1)).toMatchObject([{ count: outcome === "success" ? 0 : 1 }]);
    expect(h.notices.some(n => n.includes("compaction is running Dreamer"))).toBe(false);
    expect(h.notices.at(-1)).toContain("after recovery: Dreamer");
    if (outcome === "failure") expect(result).toBeUndefined();
    else expect(result.compaction.summary).toBeTruthy();
    if (outcome === "partial") expect(result.compaction.summary).toContain("maintenance not completed");
    if (outcome !== "success") expect(h.notices.join("\n")).toContain("ordinary retained Dreamer failure");
  } finally { release(); await h.dispose(); }
});


test.each(["branch", "project", "lost claim", "replaced claim", "range completed", "range replaced"] as const)("32f review: ordinary D cannot be reused after %s changes", async change => {
  const { h, s, item } = await seeded();
  let release!: () => void;
  const held = new Promise<void>(resolve => { release = resolve; });
  try {
    const oldEnd = h.entries.length;
    h.provider(async () => { await held; return failure(); });
    await h.turn();
    await vi.waitFor(() => expect(h.requests).toHaveLength(1));
    const original = s.getClaim(1, "dreaming")!;
    if (change === "branch") {
      h.entries.length = oldEnd;
      await h.emit("session_tree", {});
    } else if (change === "project") {
      s.declareProject(1, "different-project", "mark");
      await h.emit("session_tree", {});
    } else if (change === "range completed" || change === "range replaced") {
      h.memory.setKnowledgeBudget("project", 6_100);
      const range = s.openDreamingRange(1, "main")!;
      const run = s.recordRun({ kind: "dreaming", sessionId: 1, branch: "main", dreamingRangeId: range.id,
        outcome: "success", createdAt: "external" });
      s.completeDreaming(run.id, [item.commit], [item.commit]);
      expect(s.retryDreamingRange({ sessionId: 1, branch: "main", headTurnId: 2 })).toBeNull();
      const next = s.commitConsolidationRun({ run: { kind: "manual", sessionId: 1, createdAt: "seed" }, operations: [{ op: "create", handle: "$2", author: "test", text: "new ".repeat(12_000), category: "constraint", scope: "project", supports: [1], topics: [], reason: "new independent work", createdAt: "seed" }] });
      expect(next.ok).toBe(true);
      if (change === "range replaced" && next.ok)
        s.retainDreamingRange({ sessionId: 1, branch: "main", headTurnId: 2 }, [next.committed[0]!.commit]);
    } else {
      s.releaseClaim(original);
      if (change === "replaced claim") s.acquireClaim({ sessionId: 1, branch: "main", headTurnId: 2 }, "dreaming", original.executorId);
    }
    const before = s.getClaim(1, "dreaming");
    const controller = new AbortController();
    const attempt = compact(h, controller.signal);
    await vi.waitFor(() => expect(h.notices.some(n => n.includes("waiting for the occupied Dreamer slot"))).toBe(true));
    expect(h.notices.some(n => n.includes("waiting for the running Dreamer"))).toBe(false);
    controller.abort();
    expect(await attempt).toEqual({ cancel: true });
    expect(s.getClaim(1, "dreaming")).toEqual(before);
    expect(h.requests).toHaveLength(1);
    release(); await h.drain();
    expect(s.listRuns(1).filter(r => r.kind === "dreaming" && r.createdAt !== "external")).toHaveLength(1);
  } finally { release(); await h.dispose(); }
});


test("32f review: borrowed D of another session is capacity, never this compact's execution", async () => {
  const { h, s, item } = await seeded();
  let release!: () => void;
  const held = new Promise<void>(resolve => { release = resolve; });
  try {
    h.memory.setKnowledgeBudget("project", 6_100);
    const selected = s.knowledgePath(1, "main");
    const range = s.retainDreamingRange({ sessionId: 1, branch: "main", headTurnId: selected.headTurnId! }, [item.commit]);
    const completed = s.recordRun({ kind: "dreaming", sessionId: 1, branch: "main", dreamingRangeId: range.id,
      outcome: "success", createdAt: "seed" });
    s.completeDreaming(completed.id, [item.commit], [item.commit]);
    const peer = s.createSession({ host: "closed-peer", projectId: s.getSession(1)!.projectId, enrollmentChoice: true, startedAt: "seed", firstReplyAt: "seed" });
    const turn = s.appendTurn({ sessionId: peer.id, kind: "turn", userPrompt: "peer evidence", startedAt: "seed" });
    const entry = h.memory.appendEntry({ sessionId: peer.id, turnId: turn.id, nativeId: "peer-source", nativeLineage: "peer", role: "user", text: "peer evidence", raw: "peer evidence", calls: [] });
    h.memory.selectEntries(peer.id, "main", [entry.id]);
    const f = s.commitNotingRun({ run: { kind: "manual", sessionId: peer.id, branch: "main", createdAt: "seed" }, facts: [{ turnId: turn.id, source: [`T${turn.id}#user`], actor: "user", category: "decision", text: "peer rule", createdAt: "seed" }], entryIds: [entry.id] });
    if (!f.ok) throw Error(f.problems.join());
    const peerRule = s.commitConsolidationRun({ consolidated: [f.facts[0]!.id], run: { kind: "consolidation", sessionId: peer.id, branch: "main", createdAt: "seed" }, operations: [{ op: "create", handle: "$peer", author: "test", text: "peer ".repeat(6000), category: "constraint", scope: "session", supports: [f.facts[0]!.id], topics: [], reason: "peer work", createdAt: "seed" }] });
    expect(peerRule.ok).toBe(true);
    s.closeSession(peer.id);
    h.provider(async () => { await held; return failure(); });
    await h.turn();
    await vi.waitFor(() => expect(h.requests).toHaveLength(1));
    const claim = s.getClaim(peer.id, "dreaming");
    expect(claim?.borrowed).toBe(true);
    const own = s.commitConsolidationRun({ run: { kind: "manual", sessionId: 1, createdAt: "seed" }, operations: [{ op: "create", handle: "$own", author: "test", text: "own ".repeat(12_000), category: "constraint", scope: "project", supports: [1], topics: [], reason: "own work", createdAt: "seed" }] });
    expect(own.ok).toBe(true);
    const controller = new AbortController();
    const attempt = compact(h, controller.signal);
    await vi.waitFor(() => expect(h.notices.some(n => n.includes("waiting for the occupied Dreamer slot"))).toBe(true));
    controller.abort();
    expect(await attempt).toEqual({ cancel: true });
    expect(s.getClaim(peer.id, "dreaming")).toEqual(claim);
    expect(s.getClaim(1, "dreaming")).toBeNull();
    release(); await h.drain();
    expect(h.requests).toHaveLength(1);
    expect(s.listRuns(peer.id).filter(r => r.kind === "dreaming")).toHaveLength(1);
    expect(s.taskFailures(peer.id)).toMatchObject([{ count: 1 }]);
    expect(s.taskFailures(1).every(f => f.count === 0)).toBe(true);
  } finally { release(); await h.dispose(); }
});
