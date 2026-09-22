import { afterEach, expect, test, vi } from "vitest";
import { TraceMemory, type DreamingAgentInput, type RunAgentResult } from "../../../src/core/api/index.ts";
import { tokens } from "../../../src/core/render/index.ts";

const memories: ReturnType<typeof TraceMemory>[] = [];
afterEach(() => { for (const memory of memories.splice(0)) memory.close(); });

function fixture(agent: (task: DreamingAgentInput) => Promise<RunAgentResult>) {
  const memory = TraceMemory(":memory:", raw => agent(raw as DreamingAgentInput));
  memories.push(memory);
  const store = memory.store;
  const project = store.createProject({ name: "P", declaredBy: "mark" });
  const session = store.createSession({ host: "test", enrollmentChoice: true, projectId: project.id, startedAt: "now", firstReplyAt: "now" });
  const turn = store.appendTurn({ sessionId: session.id, kind: "turn", userPrompt: "rule", startedAt: "now" });
  const entry = memory.appendEntry({ sessionId: session.id, turnId: turn.id, nativeLineage: "test", nativeId: "root", role: "user", text: "rule", raw: "{}", calls: [] });
  memory.selectEntries(session.id, "main", [entry.id]);
  const noted = store.commitNotingRun({ run: { kind: "manual", sessionId: session.id, createdAt: "now" },
    facts: [{ turnId: turn.id, entryIds: [entry.id], category: "decision", actor: "user", text: "rule", source: [`T${turn.id}#E1`], createdAt: "now" }] });
  if (!noted.ok) throw new Error(noted.problems.join("; "));
  const target = { sessionId: session.id, branch: "main", headTurnId: turn.id, triggerEntryId: entry.id };
  const create = (scope: "global" | "project" | "session", text: string) => {
    const result = store.commitConsolidationRun({ run: { kind: "manual", sessionId: session.id, createdAt: "now" }, operations: [{
      op: "create", handle: `$${Math.random()}`, author: "test", text, category: "constraint", scope,
      supports: [noted.facts[0]!.id], topics: [], reason: "fixture", createdAt: "now",
    }] });
    if (!result.ok) throw new Error(result.problems.join("; "));
    return result.committed[0]!;
  };
  return { memory, store, project, session, target, create };
}

const ok = { outcome: "success", output: "done", request: { exact: "request" } } as const;

test("67: admission, freeze, final check and consumption have bounded independent projections", async () => {
  let admissionGraphs = -1;
  const f = fixture(async task => { admissionGraphs = graph.mock.calls.length; task.acknowledgeRequest(); return ok; });
  f.create("project", "due rule");
  f.create("project", "second rule");
  f.create("global", "below threshold");
  f.store.setKnowledgeBudget("project", f.store.pendingPoolWeight(`project:${f.project.id}`, f.target) * 2);
  const graph = vi.spyOn(f.store, "commitGraphInput");
  try {
    expect((await f.memory.dream(f.target)).outcome).toBe("success");
    // Discovery, claim admission and freeze each project once, not once per pool or consumer.
    expect(admissionGraphs).toBe(3);
    // Final read-only check and terminal writes are separate operations, each seeing fresh state.
    expect(graph).toHaveBeenCalledTimes(5);
  } finally { graph.mockRestore(); }
});

test("64c facade freezes one due pool and terminal success processes its exact current versions", async () => {
  let seen!: DreamingAgentInput;
  const f = fixture(async task => { seen = task; task.acknowledgeRequest(); return ok; });
  const item = f.create("project", "project rule");
  const pool = `project:${f.project.id}`;
  f.store.setKnowledgeBudget("project", f.store.pendingPoolWeight(pool, f.target) * 2);

  expect(f.memory.taskEligibility("dreaming", f.target)).toEqual({ due: true });
  const result = await f.memory.dream(f.target);
  expect(result.outcome).toBe("success");
  expect(seen.material.changed).toContain(`K${item.knowledgeId}@${item.commit}`);
  expect(f.store.db.prepare("SELECT pool, revision_id FROM knowledge_processed").all()).toEqual([{ pool, revision_id: item.commit }]);
  expect(f.memory.taskEligibility("dreaming", f.target)).toEqual({ due: false });
  expect(f.memory.progress(f.session.id, "main", f.target.headTurnId)).toMatchObject({ knowledge: 1, changedKnowledge: 0 });
  expect(f.memory.progress(f.session.id, "main", f.target.headTurnId)).not.toHaveProperty("processedKnowledge");
  expect(f.memory.progress(f.session.id, "main", f.target.headTurnId)).not.toHaveProperty("unprocessedKnowledge");
});

test("64c facade leaves an external mid-run revision pending while recording the frozen range", async () => {
  let release!: () => void;
  const wait = new Promise<void>(resolve => { release = resolve; });
  const f = fixture(async task => { task.acknowledgeRequest(); await wait; return ok; });
  const first = f.create("project", "first rule ".repeat(20));
  const pool = `project:${f.project.id}`;
  f.store.setKnowledgeBudget("project", Math.floor(f.store.pendingPoolWeight(pool, f.target) * 1.5));
  const running = f.memory.dream(f.target);
  await new Promise(resolve => setTimeout(resolve, 0));
  const late = f.create("project", "late rule ".repeat(10));
  release();
  expect((await running).outcome).toBe("success");
  expect(f.store.pendingVersions(pool, f.target).map(value => value.revisionId)).toEqual([late.commit]);
  expect(f.store.pendingPoolWeight(pool, f.target) * 2).toBeLessThan(f.store.knowledgeBudgets().project);
  expect(f.store.duePools(f.target).map(value => value.pool)).toContain(pool); // mid-run arrival is not swallowed by the residual baseline
  expect(f.store.db.prepare("SELECT revision_id FROM knowledge_processed WHERE pool = ?",).all(pool).map(row => Number(row.revision_id))).toEqual([first.commit]);
});

test("64c facade cancellation before a commit closes the range without processing", async () => {
  const controller = new AbortController();
  const f = fixture(async task => await new Promise<RunAgentResult>(resolve => {
    task.acknowledgeRequest(); task.signal!.addEventListener("abort", () => resolve({ outcome: "cancelled", output: "cancelled", request: { exact: "request" } }), { once: true });
  }));
  f.create("project", "cancelled rule");
  const pool = `project:${f.project.id}`;
  f.store.setKnowledgeBudget("project", f.store.pendingPoolWeight(pool, f.target) * 2);
  const running = f.memory.dream({ ...f.target, signal: controller.signal });
  await new Promise(resolve => setTimeout(resolve, 0)); controller.abort();
  expect((await running).outcome).toBe("cancelled");
  expect(f.store.db.prepare("SELECT * FROM knowledge_processed").all()).toEqual([]);
  expect(f.store.db.prepare("SELECT * FROM knowledge_pool_state").all()).toEqual([]);
  expect(f.store.openDreamingRange(f.session.id, "main")).toBeNull();
  expect(f.store.duePools(f.target).map(value => value.pool)).toContain(pool);
});

test("64c cancelled run after a scope-changing commit processes the frozen source and resulting owner", async () => {
  const controller = new AbortController();
  let output = 0;
  const f = fixture(async task => {
    task.acknowledgeRequest();
    const memory = task.tools.find(tool => tool.name === "memory")!;
    const committed = JSON.parse(memory.execute({ operations: [{ op: "update", id: task.material.changed.match(/K\d+@\d+/)![0],
      text: "moved global rule", category: "constraint", scope: "global", supports: [], topics: [], reason: "scope change" }], skipped: [] })).committed;
    output = committed[0].commit;
    return await new Promise<RunAgentResult>(resolve => task.signal!.addEventListener("abort",
      () => resolve({ outcome: "cancelled", output: "cancelled", request: { exact: "request" } }), { once: true }));
  });
  const input = f.create("project", "project source");
  const projectPool = `project:${f.project.id}`;
  f.store.setKnowledgeBudget("project", f.store.pendingPoolWeight(projectPool, f.target) * 2);
  const running = f.memory.dream({ ...f.target, signal: controller.signal });
  while (!output) await new Promise(resolve => setTimeout(resolve, 0));
  controller.abort();
  expect((await running).outcome).toBe("cancelled");
  expect(f.store.db.prepare("SELECT pool, revision_id FROM knowledge_processed ORDER BY revision_id").all()).toEqual([
    { pool: projectPool, revision_id: input.commit }, { pool: "global", revision_id: output },
  ]);
});

test.each([
  { committed: false, stopping: false, disabled: false }, { committed: true, stopping: false, disabled: false },
  { committed: false, stopping: true, disabled: false }, { committed: true, stopping: true, disabled: false },
  { committed: false, stopping: false, disabled: true }, { committed: true, stopping: false, disabled: true },
])("64c executor cancellation fences tools but completes pool accounting ($committed/$stopping/$disabled)", async ({ committed, stopping, disabled }) => {
  let task!: DreamingAgentInput, output = 0, release!: () => void, entered!: () => void;
  const ready = new Promise<void>(resolve => { entered = resolve; });
  const held = new Promise<void>(resolve => { release = resolve; });
  const f = fixture(async input => {
    task = input; task.acknowledgeRequest();
    if (committed) {
      const receipt = JSON.parse(task.tools.find(tool => tool.name === "memory")!.execute({ operations: [{
        op: "update", id: task.material.changed.match(/K\d+@\d+/)![0], text: "maintained rule",
        category: "constraint", scope: "project", supports: [], topics: [], reason: "maintain",
      }], skipped: [] }));
      output = receipt.committed[0].commit;
    }
    entered(); await held;
    return { outcome: "cancelled", output: "stopped", request: { exact: "request" } };
  });
  const item = f.create("project", "project rule");
  const pool = `project:${f.project.id}`;
  f.store.setKnowledgeBudget("project", f.store.pendingPoolWeight(pool, f.target) * 2);
  const running = f.memory.dream({ ...f.target, executorSessionId: f.session.id });
  try {
    await ready;
    const claim = f.store.getClaim(f.session.id, "dreaming")!;
    if (disabled) f.store.setEnrollment(f.session.id, false);
    expect(f.memory.cancelTasks(stopping)).toEqual([expect.objectContaining({ sessionId: f.session.id, phase: "dreaming" })]);
    expect(task.signal!.aborted).toBe(true);
    expect(f.store.getClaim(f.session.id, "dreaming")).toEqual(claim);
    expect(f.store.acquireClaim(f.target, "dreaming", "other-executor")).toBeNull();
    const before = f.store.db.prepare("SELECT COUNT(*) AS count FROM knowledge_revisions").get();
    const late = task.tools.find(tool => tool.name === "memory")!.execute({ operations: [{
      op: "archive", id: `K${item.knowledgeId}@${output || item.commit}`, supports: [], reason: "late forbidden write",
    }], skipped: [] });
    expect(late).toBe("rejected: run has finished");
    expect(f.store.db.prepare("SELECT COUNT(*) AS count FROM knowledge_revisions").get()).toEqual(before);
    release();
    const result = await running;
    expect(result.outcome).toBe("cancelled");
    expect(f.store.getClaim(f.session.id, "dreaming")).toBeNull();
    expect(f.store.openDreamingRange(f.session.id, "main")).toBeNull();
    expect(f.store.db.prepare("SELECT revision_id FROM knowledge_processed WHERE pool = ? ORDER BY revision_id").all(pool)
      .map(row => Number(row.revision_id))).toEqual(committed ? [item.commit, output] : []);
    expect(f.store.duePools(f.target).some(value => value.pool === pool)).toBe(!committed);
    expect(f.memory.taskEligibility("dreaming", f.target).due).toBe(!committed && !stopping && !disabled);
    expect(f.store.enabled(f.session.id)).toBe(!disabled);
    expect(f.store.taskFailures(f.session.id).every(failure => failure.count === 0)).toBe(true);
  } finally { release(); await running; }
});

test.each(["absorbed", "survivor", "explicit"] as const)("64c merge shorthand copies the later exact body, not the newer identity (%s)", async mode => {
  let older!: { knowledgeId: number; commit: number }, newer!: typeof older, merged = 0;
  const latest = "  最新主张\n条件与例外原样保留。  ";
  const explicit = "Deliberately rewritten merge";
  const f = fixture(async task => {
    task.acknowledgeRequest();
    const write = task.tools.find(tool => tool.name === "memory")!;
    const trace = task.tools.find(tool => tool.name === "trace")!;
    if (mode === "survivor") {
      const updated = JSON.parse(write.execute({ operations: [{ op: "update", id: `K${older.knowledgeId}@${older.commit}`,
        text: latest, category: "constraint", scope: "project", supports: [], topics: [], reason: "newer commit of older identity" }], skipped: [] }));
      older = updated.committed[0];
      trace.execute({ address: `K${older.knowledgeId}@${older.commit}`, itemBudget: null });
    }
    const receipt = JSON.parse(write.execute({ operations: [{ op: "merge", id: `K${older.knowledgeId}@${older.commit}`,
      absorb: [`K${newer.knowledgeId}@${newer.commit}`], ...(mode === "explicit" ? { text: explicit } : {}),
      category: "constraint", scope: "project", supports: [], topics: ["merged"], reason: "same conclusion" }], skipped: [] }));
    merged = receipt.committed[0].commit;
    return ok;
  });
  older = f.create("project", "original earlier conclusion");
  newer = f.create("project", latest);
  const pool = `project:${f.project.id}`;
  f.store.setKnowledgeBudget("project", f.store.pendingPoolWeight(pool, f.target) * 2);
  expect((await f.memory.dream(f.target)).outcome).toBe("success");
  const result = f.store.knowledgeRevision(merged)!;
  expect(result.knowledgeId).toBe(older.knowledgeId);
  expect(result.text).toBe(mode === "explicit" ? explicit : latest);
  expect(result.topics).toEqual(["merged"]);
  expect(f.store.commitParents(result).map(parent => parent.id).sort((a, b) => a - b))
    .toEqual([older.commit, newer.commit].sort((a, b) => a - b));
  expect(f.store.currentCommit(newer.knowledgeId, f.target)).toEqual([]);
});

test("64c a shared global threshold can be serviced from another session while project pools remain independent", async () => {
  const f = fixture(async task => { task.acknowledgeRequest(); return ok; });
  const global = f.create("global", "shared global");
  f.create("project", "private project");
  const otherProject = f.store.createProject({ name: "Other", declaredBy: "mark" });
  const otherSession = f.store.createSession({ host: "test", enrollmentChoice: true, projectId: otherProject.id, startedAt: "now", firstReplyAt: "now" });
  const otherTurn = f.store.appendTurn({ sessionId: otherSession.id, kind: "turn", userPrompt: "other", startedAt: "now" });
  const otherEntry = f.memory.appendEntry({ sessionId: otherSession.id, turnId: otherTurn.id, nativeLineage: "other", nativeId: "root", role: "user", text: "other", raw: "{}", calls: [] });
  f.memory.selectEntries(otherSession.id, "main", [otherEntry.id]);
  const other = { sessionId: otherSession.id, branch: "main", headTurnId: otherTurn.id, triggerEntryId: otherEntry.id };
  f.store.setKnowledgeBudget("global", f.store.pendingPoolWeight("global", other) * 2);
  expect(f.store.duePools(other).map(value => value.pool)).toContain("global");
  expect(f.store.duePools(other).map(value => value.pool)).not.toContain(`project:${f.project.id}`);
  expect((await f.memory.dream(other)).outcome).toBe("success");
  expect(f.store.db.prepare("SELECT pool, revision_id FROM knowledge_processed").all()).toEqual([{ pool: "global", revision_id: global.commit }]);
});

test("64c unchanged low-threshold residual stays quiet but an old lower-id version becoming visible rearms it", async () => {
  const f = fixture(async task => { task.acknowledgeRequest(); return ok; });
  const q = f.store.createProject({ name: "Q", declaredBy: "mark" });
  const qs = f.store.createSession({ host: "q", enrollmentChoice: true, projectId: q.id, projectDeclaration: "mark", startedAt: "now", firstReplyAt: "now" });
  const qt = f.store.appendTurn({ sessionId: qs.id, kind: "turn", userPrompt: "q", startedAt: "now" });
  const qe = f.memory.appendEntry({ sessionId: qs.id, turnId: qt.id, nativeLineage: "q", nativeId: "q", role: "user", text: "q", raw: "{}", calls: [] });
  f.memory.selectEntries(qs.id, "main", [qe.id]);
  const qn = f.store.commitNotingRun({ run: { kind: "manual", sessionId: qs.id, createdAt: "now" }, facts: [{ turnId: qt.id,
    entryIds: [qe.id], category: "decision", actor: "user", text: "q", source: [`T${qt.id}#E1`], createdAt: "now" }] });
  if (!qn.ok) throw new Error(qn.problems.join("; "));
  const old = f.store.commitConsolidationRun({ run: { kind: "manual", sessionId: qs.id, createdAt: "now" }, operations: [{ op: "create",
    handle: "$old", author: "test", text: "old q item", category: "constraint", scope: "project", supports: [qn.facts[0]!.id], topics: [], reason: "old", createdAt: "now" }] });
  if (!old.ok) throw new Error(old.problems.join("; "));

  f.create("project", "words ".repeat(250));
  f.create("project", "words ".repeat(250));
  f.create("project", "words ".repeat(250));
  const pool = `project:${f.project.id}`, weights = f.store.pendingVersions(pool, f.target).map(value => value.tokens);
  f.store.setKnowledgeBudget("project", Math.floor(Math.max(...weights) * 2.5));
  expect((await f.memory.dream(f.target)).outcome).toBe("success");
  const remaining = f.store.pendingPoolWeight(pool, f.target);
  expect(remaining).toBeGreaterThan(0);
  expect(remaining * 2).toBeLessThan(f.store.knowledgeBudgets().project);
  expect(f.store.duePools(f.target).map(value => value.pool)).not.toContain(pool);

  f.store.mergeProject(q.id, f.project.id);
  expect(old.committed[0]!.commit).toBeLessThan(Math.min(...f.store.pendingVersions(pool, f.target).filter(v => v.revisionId !== old.committed[0]!.commit).map(v => v.revisionId)));
  expect(f.store.duePools(f.target).map(value => value.pool)).toContain(pool);
});

test("64c an unchanged residual above half budget remains due independently of the over-budget baseline", async () => {
  const f = fixture(async task => { task.acknowledgeRequest(); return ok; });
  f.create("project", "large ".repeat(400));
  f.create("project", "small ".repeat(250));
  f.create("project", "small ".repeat(250));
  const pool = `project:${f.project.id}`, pending = f.store.pendingVersions(pool, f.target);
  const one = tokens(["Pending current knowledge:", pending[0]!.material].join("\n"));
  expect(tokens(["Pending current knowledge:", pending[0]!.material, pending[1]!.material].join("\n"))).toBeGreaterThan(one);
  f.store.setKnowledgeBudget("project", one);
  expect((await f.memory.dream(f.target)).outcome).toBe("success");
  const residual = f.store.pendingPoolWeight(pool, f.target);
  expect(residual * 2).toBeGreaterThanOrEqual(one);
  expect(f.store.duePools(f.target).find(value => value.pool === pool)?.reason).toBe("pending");
});

test("64c successful terminal transaction persists the full provider audit", async () => {
  const f = fixture(async task => { task.acknowledgeRequest(); return { ...ok, usage: { input: 7, output: 3, cacheRead: 0, cacheWrite: 0, cost: 0.1 }, nativeLog: "/tmp/dream.jsonl" }; });
  f.create("project", "audited rule");
  const pool = `project:${f.project.id}`;
  f.store.setKnowledgeBudget("project", f.store.pendingPoolWeight(pool, f.target) * 2);
  const result = await f.memory.dream(f.target);
  if (!("runId" in result)) throw new Error("missing run");
  const run = f.store.getRun(result.runId)!;
  expect(run.outcome).toBe("success");
  expect(JSON.parse(run.response!)).toMatchObject({ check: { pool }, nativeLog: "/tmp/dream.jsonl", usage: { input: 7, output: 3 } });
  expect(JSON.parse(run.request!)).toEqual({ exact: "request" });
});

test.each(["failure", "cancelled"] as const)("64c %s terminal transaction persists audit and closes exact processing state", async terminal => {
  const f = fixture(async task => { task.acknowledgeRequest(); return { outcome: terminal, output: `${terminal} output`, request: { terminal }, nativeLog: `/tmp/${terminal}.jsonl` }; });
  const item = f.create("project", `${terminal} rule`), pool = `project:${f.project.id}`;
  f.store.setKnowledgeBudget("project", f.store.pendingPoolWeight(pool, f.target) * 2);
  const result = await f.memory.dream(f.target);
  if (!("runId" in result)) throw new Error("missing run");
  const run = f.store.getRun(result.runId)!;
  expect(run.outcome).toBe(terminal);
  expect(JSON.parse(run.response!)).toMatchObject({ output: `${terminal} output`, check: { pool }, nativeLog: `/tmp/${terminal}.jsonl` });
  expect(JSON.parse(run.request!)).toEqual({ terminal });
  expect(f.store.openDreamingRange(f.session.id, "main")).toBeNull();
  expect(f.store.pendingVersions(pool, f.target).map(value => value.revisionId)).toEqual(terminal === "cancelled" ? [item.commit] : []);
});

test("64c rejected terminal transaction rolls back processing but preserves attempt evidence", async () => {
  let f!: ReturnType<typeof fixture>;
  f = fixture(async task => { task.acknowledgeRequest(); f.store.invalidateExecutor(f.memory.executorId); return ok; });
  const item = f.create("project", "fenced rule"), pool = `project:${f.project.id}`;
  f.store.setKnowledgeBudget("project", f.store.pendingPoolWeight(pool, f.target) * 2);
  const result = await f.memory.dream(f.target);
  if (!("runId" in result)) throw new Error("missing run");
  expect(result.outcome).toBe("failure");
  expect(f.store.db.prepare("SELECT * FROM knowledge_processed").all()).toEqual([]);
  expect(f.store.pendingVersions(pool, f.target).map(value => value.revisionId)).toEqual([item.commit]);
  expect(JSON.parse(f.store.getRun(result.runId)!.response!)).toMatchObject({ check: { pool }, output: "done" });
});

test("64c over-budget completion does not loop and rearms on growth or budget change", async () => {
  const f = fixture(async task => { task.acknowledgeRequest(); return ok; });
  f.create("project", "large ".repeat(100));
  const pool = `project:${f.project.id}`;
  f.store.setKnowledgeBudget("project", f.store.pendingPoolWeight(pool, f.target) * 2);
  expect((await f.memory.dream(f.target)).outcome).toBe("success");

  const firstSize = f.store.poolSizes(f.target).find(value => value.pool === pool)!.tokens;
  f.store.setKnowledgeBudget("project", firstSize - 1);
  const before = Number(f.store.db.prepare("SELECT COUNT(*) AS n FROM knowledge_revisions").get()!.n);
  expect((await f.memory.dream(f.target)).outcome).toBe("success"); // budget-only range
  expect(Number(f.store.db.prepare("SELECT COUNT(*) AS n FROM knowledge_revisions").get()!.n)).toBe(before);
  expect(f.store.duePools(f.target).some(value => value.pool === pool)).toBe(false);

  f.create("project", "growth");
  expect(f.store.duePools(f.target).some(value => value.pool === pool)).toBe(true);
  expect((await f.memory.dream(f.target)).outcome).toBe("success");
  expect(f.store.duePools(f.target).some(value => value.pool === pool)).toBe(false);
  f.store.setKnowledgeBudget("project", firstSize - 2);
  expect(f.store.duePools(f.target).some(value => value.pool === pool)).toBe(true);
});
