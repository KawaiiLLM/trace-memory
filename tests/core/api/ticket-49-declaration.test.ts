import { afterEach, expect, test } from "vitest";
import { TraceMemory } from "../../../src/core/api/index.ts";
import { sourceSeededMemory } from "../../source-fixture.ts";
import { Store, type TaskTarget } from "../../../src/core/store/index.ts";

const memories: ReturnType<typeof TraceMemory>[] = [];
afterEach(() => { for (const memory of memories.splice(0)) memory.close(); });

function base(seeded = false, config: Parameters<typeof TraceMemory>[2] = {}) {
  const memory = (seeded ? sourceSeededMemory : TraceMemory)(":memory:", async () => { throw new Error("no model"); }, config);
  memories.push(memory);
  const store = memory.store, own = store.createProject({ name: `implicit-${memories.length}`, declaredBy: "mark" });
  const session = store.createSession({ host: `host-${memories.length}`, projectId: own.id, projectDeclaration: "undeclared",
    enrollmentChoice: true, startedAt: "now", firstReplyAt: "now" });
  const turn = store.appendTurn({ sessionId: session.id, kind: "turn", userPrompt: seeded ? "pending raw ".repeat(30) : "evidence", startedAt: "now" });
  const path = { sessionId: session.id, branch: "main", headTurnId: turn.id };
  return { memory, store, own, session, turn, path };
}

function fact(f: ReturnType<typeof base>) {
  const result = f.store.commitNotingRun({ run: { kind: "manual", sessionId: f.session.id, createdAt: "now" }, facts: [
    { turnId: f.turn.id, category: "decision", actor: "user", text: "pending fact ".repeat(30), source: [`T${f.turn.id}#user`], createdAt: "now" },
  ] });
  if (!result.ok) throw new Error(result.problems.join("; "));
  return result.facts[0]!;
}

function knowledge(f: ReturnType<typeof base>, scope: "project" | "global" | "session" = "project") {
  const evidence = fact(f);
  const result = f.store.commitConsolidationRun({ path: f.path, run: { kind: "manual", sessionId: f.session.id, createdAt: "now" }, operations: [
    { op: "create", handle: "$1", author: "test", text: "pending knowledge ".repeat(30), category: "constraint", scope,
      supports: [evidence.id], topics: [], reason: "test", createdAt: "now" },
  ], consolidated: [evidence.id] });
  if (!result.ok) throw new Error(result.problems.join("; "));
  return result.committed[0]!;
}

for (const phase of ["noting", "consolidation"] as const) {
  test(`64c/49: declaration still rejects ${phase} at its configured threshold without flushing`, () => {
    const f = base(phase === "noting");
    if (phase === "consolidation") fact(f);
    const measured = f.memory.pendingTokens(phase, f.path).tokens!;
    expect(measured).toBeGreaterThan(0);
    f.memory.config[phase].triggerTokens = measured;
    if (phase !== "noting") f.memory.config.noting.triggerTokens = Number.MAX_SAFE_INTEGER;
    if (phase !== "consolidation") f.memory.config.consolidation.triggerTokens = Number.MAX_SAFE_INTEGER;
    expect(() => f.memory.declareProject(f.session.id, `blocked-${phase}`, "mark", f.path))
      .toThrow(new RegExp(`${phase} is due`));
    f.memory.config[phase].triggerTokens = measured - 1;
    expect(() => f.memory.declareProject(f.session.id, `above-${phase}`, "mark", f.path))
      .toThrow(new RegExp(`${phase} is due`));
    expect(f.store.findProjectByName(`blocked-${phase}`)).toBeNull();
    expect(f.store.findProjectByName(`above-${phase}`)).toBeNull();
    expect(f.memory.pendingTokens(phase, f.path).tokens).toBe(measured);
  });
}

test("49: material below all three thresholds moves without an automatic flush", () => {
  const f = base(true);
  knowledge(f);
  const pendingFact = fact(f);
  for (const phase of ["noting", "consolidation"] as const) {
    const measured = f.memory.pendingTokens(phase, f.path).tokens!;
    expect(measured).toBeGreaterThan(0);
    f.memory.config[phase].triggerTokens = measured + 1;
  }
  const dreaming = f.memory.pendingTokens("dreaming", f.path).tokens!;
  expect(dreaming).toBeGreaterThan(0);
  f.memory.setKnowledgeBudget("project", dreaming * 2 + 2);
  expect(f.memory.declareProject(f.session.id, "below-target", "mark", f.path)).toContain("below-target");
  expect(f.store.consolidationBatch(f.session.id, f.path.branch, f.path.headTurnId).map(value => value.id)).toContain(pendingFact.id);
  expect(f.memory.pendingTokens("noting", f.path).tokens).toBeGreaterThan(0);
  expect(f.memory.pendingTokens("dreaming", f.path).tokens).toBeGreaterThan(0);
});

test("49: declaration uses the host-selected rewind path and accepts material below every threshold", () => {
  const f = base(true);
  const later = f.store.appendTurn({ sessionId: f.session.id, parentTurnId: f.turn.id, kind: "turn", userPrompt: "later pending ".repeat(200), startedAt: "later" });
  const laterPath = { ...f.path, headTurnId: later.id };
  const selectedTokens = f.memory.pendingTokens("noting", f.path).tokens!;
  const laterTokens = f.memory.pendingTokens("noting", laterPath).tokens!;
  expect(laterTokens).toBeGreaterThan(selectedTokens);
  f.memory.config.noting.triggerTokens = selectedTokens + 1;
  f.memory.config.consolidation.triggerTokens = Number.MAX_SAFE_INTEGER;
  expect(f.memory.declareProject(f.session.id, "rewind-target", "mark", f.path)).toContain("rewind-target");
  expect(f.memory.pendingTokens("noting", laterPath).tokens).toBe(laterTokens);
});

test("64c/49: disabled enrollment does not mask the preserved Consolidation declaration guard", () => {
  const f = base(false), pending = fact(f);
  f.memory.config.noting.triggerTokens = Number.MAX_SAFE_INTEGER;
  f.memory.config.consolidation.triggerTokens = f.memory.pendingTokens("consolidation", f.path).tokens!;
  f.store.setEnrollment(f.session.id, false);
  expect(f.memory.taskEligibility("consolidation", f.path).due).toBe(false);
  expect(() => f.memory.declareProject(f.session.id, "disabled-target", "mark", f.path)).toThrow(/consolidation is due/);
  expect(f.store.consolidationBatch(f.session.id, "main", f.turn.id).map(value => value.id)).toContain(pending.id);
});

test.each(["project", "global"] as const)("64c: active affected-project Dreamer blocks a move even while processing %s", scope => {
  const f = base(false), item = knowledge(f, scope);
  const pool = scope === "global" ? "global" : `project:${f.own.id}`;
  f.store.setKnowledgeBudget(scope, f.store.pendingPoolWeight(pool, f.path) * 2);
  expect(f.memory.taskEligibility("dreaming", f.path).due).toBe(true);
  const claim = f.store.acquireClaim(f.path, "dreaming", "worker")!;
  expect(claim).not.toBeNull();
  const range = f.store.retainKnowledgePoolRange(f.path, pool, claim);
  const before = { session: f.store.getSession(f.session.id), revisions: f.store.listKnowledgeRevisions() };
  expect(() => f.memory.declareProject(f.session.id, "move-target", "mark", f.path)).toThrow(/active Dreamer.*affected project/);
  expect(f.store.findProjectByName("move-target")).toBeNull();
  expect(f.store.getSession(f.session.id)).toEqual(before.session);
  expect(f.store.listKnowledgeRevisions()).toEqual(before.revisions);
  f.store.releaseClaim(claim);
  expect(f.memory.declareProject(f.session.id, "move-target", "mark", f.path)).toContain("move-target");
  expect(f.store.dreamingRange(range.id)).not.toBeNull(); // an inactive old range is not a declaration gate
  const target = f.store.findProjectByName("move-target")!;
  expect(f.store.pendingVersions(scope === "global" ? "global" : `project:${target.id}`, f.path).map(v => v.revisionId)).toContain(item.commit);
  expect(f.store.db.prepare("SELECT * FROM knowledge_processed").all()).toEqual([]);
});

test.each(["noting", "consolidation"] as const)("64c/49: %s live claim still blocks declaration", phase => {
  const f = base(true); fact(f);
  const held = f.store.acquireClaim(f.path, phase, "worker");
  expect(held).not.toBeNull();
  expect(() => f.store.declareProject(f.session.id, `claim-${phase}`, "mark", { path: f.path, atTrigger: () => false }))
    .toThrow(new RegExp(`${phase} has a live claim`));
});

test.each(["source", "target", "unrelated"] as const)("64c: a %s project peer's live Dreamer is fenced by affected ownership, not the declaring session's claim", relation => {
  const f = base(false); knowledge(f);
  const destination = f.store.createProject({ name: `destination-${relation}`, declaredBy: "mark" });
  const peerProject = relation === "source" ? f.own : relation === "target" ? destination
    : f.store.createProject({ name: "unrelated", declaredBy: "mark" });
  const peerSession = f.store.createSession({ host: "peer", projectId: peerProject.id, projectDeclaration: "mark",
    enrollmentChoice: true, startedAt: "now", firstReplyAt: "now" });
  const peerTurn = f.store.appendTurn({ sessionId: peerSession.id, kind: "turn", userPrompt: "peer evidence", startedAt: "now" });
  const peerPath = { sessionId: peerSession.id, branch: "main", headTurnId: peerTurn.id };
  knowledge({ ...f, own: peerProject, session: peerSession, turn: peerTurn, path: peerPath });
  const held = f.store.acquireClaim(peerPath, "dreaming", "peer-executor")!;
  expect(held).not.toBeNull();
  const range = f.store.retainKnowledgePoolRange(peerPath, `project:${peerProject.id}`, held);
  const move = () => f.memory.declareProject(f.session.id, destination.name, "mark", f.path);
  if (relation === "unrelated") expect(move()).toContain(destination.name);
  else {
    expect(move).toThrow(/active Dreamer.*affected project/);
    expect(f.store.getSession(f.session.id)!.projectId).toBe(f.own.id);
  }
  expect(f.store.getClaim(peerSession.id, "dreaming")).toEqual(held);
  expect(f.store.dreamingRange(range.id)!.pool).toBe(`project:${peerProject.id}`);
  expect(f.store.db.prepare("SELECT * FROM knowledge_processed").all()).toEqual([]);
});

function claimFixture() {
  const store = new Store(":memory:");
  const make = (name: string, projectId?: number): TaskTarget => {
    const project = projectId === undefined ? store.createProject({ name, declaredBy: "mark" }) : store.getProject(projectId)!;
    const session = store.createSession({ host: name, projectId: project.id, projectDeclaration: "mark", enrollmentChoice: true, startedAt: "now", firstReplyAt: "now" });
    const turn = store.appendTurn({ sessionId: session.id, kind: "turn", userPrompt: "evidence", startedAt: "now" });
    const noted = store.commitNotingRun({ run: { kind: "manual", sessionId: session.id, createdAt: "now" }, facts: [
      { turnId: turn.id, category: "decision", actor: "user", text: "evidence", source: [`T${turn.id}#user`], createdAt: "now" },
    ] });
    if (!noted.ok) throw new Error(noted.problems.join("; "));
    const result = store.commitConsolidationRun({ run: { kind: "manual", sessionId: session.id, createdAt: "now" }, operations: [
      { op: "create", handle: "$1", author: "test", text: `pending ${name}`, category: "constraint", scope: "project", supports: [noted.facts[0]!.id], topics: [], reason: "test", createdAt: "now" },
    ] });
    if (!result.ok) throw new Error(result.problems.join("; "));
    return { sessionId: session.id, branch: "main", headTurnId: turn.id };
  };
  const a = make("A");
  return { store, a, same: make("A-peer", store.getSession(a.sessionId)!.projectId), b: make("B") };
}

test("49: one database Dreamer claim spans projects while release and expiry preserve normal takeover", () => {
  const f = claimFixture(); storesForClaims.push(f.store);
  const first = f.store.acquireClaim(f.a, "dreaming", "executor-a");
  expect(first).not.toBeNull();
  expect(f.store.acquireClaim(f.same, "dreaming", "same-project-executor")).toBeNull();
  expect(f.store.acquireClaim(f.b, "dreaming", "executor-b")).toBeNull();
  expect(f.store.releaseClaim(first!)).toBe(true);
  const peer = f.store.acquireClaim(f.b, "dreaming", "executor-b");
  expect(peer).not.toBeNull();
  f.store.db.prepare("UPDATE task_claims SET expires_at = 0 WHERE session_id = ? AND phase = 'dreaming'").run(f.b.sessionId);
  expect(f.store.acquireClaim(f.a, "dreaming", "executor-a")).not.toBeNull();
});

test("49: reopening an expired Dreamer target cannot reserve the seat owned by another session", () => {
  const f = claimFixture(); storesForClaims.push(f.store);
  const old = f.store.acquireClaim(f.a, "dreaming", "old-a")!;
  f.store.invalidateExecutor("old-a");
  const live = f.store.acquireClaim(f.same, "dreaming", "live-peer")!;

  f.store.reopenSession(f.a.sessionId, "reopened-a");

  const reopened = f.store.getClaim(f.a.sessionId, "dreaming")!;
  expect(reopened.token).not.toBe(old.token);
  expect(reopened.executorId).toBe("reopened-a");
  expect(reopened.expiresAt).toBeLessThanOrEqual(Date.now());
  expect(f.store.getClaim(f.same.sessionId, "dreaming")).toEqual(live);
  expect(f.store.db.prepare("SELECT count(*) AS count FROM task_claims WHERE phase = 'dreaming' AND expires_at > ?").get(Date.now())!.count).toBe(1);

  expect(f.store.releaseClaim(live)).toBe(true);
  expect(f.store.acquireClaim(f.b, "dreaming", "third-executor")).not.toBeNull();
});

test("49: reserved Dreamer takeover keeps its token and blocks peers; Noting and Consolidation remain independent", () => {
  const f = claimFixture(); storesForClaims.push(f.store);
  const old = f.store.acquireClaim(f.a, "dreaming", "old-executor")!;
  f.store.reopenSession(f.a.sessionId, "new-executor");
  const reserved = f.store.getClaim(f.a.sessionId, "dreaming")!;
  expect(reserved).toMatchObject({ executorId: "new-executor", reserved: true });
  expect(f.store.acquireClaim(f.b, "dreaming", "peer")).toBeNull();
  const takeover = f.store.acquireClaim(f.a, "dreaming", "new-executor")!;
  expect(takeover.token).toBe(reserved.token);
  expect(takeover.token).not.toBe(old.token);

  const pendingTurn = f.store.appendTurn({ sessionId: f.b.sessionId, parentTurnId: f.b.headTurnId, kind: "turn", userPrompt: "raw", startedAt: "later" });
  f.store.appendSourceEntry({ sessionId: f.b.sessionId, nativeLineage: "test", nativeId: "raw", turnId: pendingTurn.id,
    role: "user", text: "raw", raw: "{}", calls: [] });
  const notingTarget = { ...f.b, headTurnId: pendingTurn.id };
  expect(f.store.acquireClaim(notingTarget, "noting", "peer")).not.toBeNull();
  expect(f.store.acquireClaim(f.b, "consolidation", "peer")).not.toBeNull();
});

const storesForClaims: Store[] = [];
afterEach(() => { for (const store of storesForClaims.splice(0)) store.close(); });
