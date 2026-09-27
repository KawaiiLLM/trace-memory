import { afterEach, expect, test } from "vitest";
import { TraceMemory } from "../../../src/core/api/index.ts";
import { hydrate, sourceSeededMemory } from "../../source-fixture.ts";
import { Store, type TaskTarget } from "../../../src/core/store/index.ts";
import { entry as seedEntry, legacyFacts } from "../../support/seed.ts";

const memories: ReturnType<typeof TraceMemory>[] = [];
afterEach(() => { for (const memory of memories.splice(0)) memory.close(); });

function base(seeded = false, config: Parameters<typeof TraceMemory>[2] = {}) {
  const memory = (seeded ? sourceSeededMemory : TraceMemory)(":memory:", async () => { throw new Error("no model"); }, config);
  memories.push(memory);
  const store = memory.store, own = store.createProject({ name: `implicit-${memories.length}`, declaredBy: "mark" });
  const session = store.createSession({ host: `host-${memories.length}`, projectId: own.id, projectDeclaration: "undeclared",
    enrollmentChoice: true, startedAt: "now", firstReplyAt: "now" });
  const turn = store.appendTurn({ sessionId: session.id, kind: "turn", userPrompt: seeded ? "pending raw ".repeat(30) : "evidence", startedAt: "now" });
  const source = seeded ? hydrate(store.listSourceEntries(session.id, turn.id), store).find(entry => entry.role === "user")!
    : seedEntry(store, session.id, turn.id, `user-${turn.id}`, "user", "evidence");
  const path = { sessionId: session.id, branch: "main", headTurnId: turn.id };
  return { memory, store, own, session, turn, source, path };
}

function fact(f: ReturnType<typeof base>) {
  return legacyFacts(f.store, { kind: "manual", sessionId: f.session.id, createdAt: "now" }, [{
    sources: [{ entry: f.source, address: `T${f.turn.id}#user` }], category: "decision", actor: "user",
    text: "pending fact ".repeat(30), createdAt: "now",
  }]).facts[0]!;
}

function knowledge(f: ReturnType<typeof base>, scope: "project" | "global" | "session" = "project") {
  const evidence = fact(f);
  const result = f.store.commitConsolidationRun({ path: f.path, run: { kind: "manual", sessionId: f.session.id, createdAt: "now" }, operations: [
    { op: "create", handle: "$1", author: "test", text: "pending knowledge ".repeat(30), category: "constraint", scope,
      supports: [evidence.id], topics: [], reason: "test", createdAt: "now" },
  ] });
  if (!result.ok) throw new Error(result.problems.join("; "));
  return result.committed[0]!;
}

for (const phase of ["noting"] as const) {
  test(`64c/49: declaration still rejects ${phase} at its configured threshold without flushing`, () => {
    const f = base(true);
    const measured = f.memory.pendingTokens(phase, f.path).tokens!;
    expect(measured).toBeGreaterThan(0);
    f.memory.config[phase].triggerTokens = measured;
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

test("49: material below N/D thresholds moves without an automatic flush", () => {
  const f = base(true);
  knowledge(f);
  const pendingFact = fact(f);
  for (const phase of ["noting"] as const) {
    const measured = f.memory.pendingTokens(phase, f.path).tokens!;
    expect(measured).toBeGreaterThan(0);
    f.memory.config[phase].triggerTokens = measured + 1;
  }
  // The fixture's knowledge is project-scoped; only the project pool carries pending material.
  const projectPending = () => f.memory.dreamingPending(f.path).pools!.find(pool => pool.scope === "project")!.tokens;
  const dreaming = projectPending();
  expect(dreaming).toBeGreaterThan(0);
  f.memory.setKnowledgeBudget("project", dreaming * 2 + 2);
  expect(f.memory.declareProject(f.session.id, "below-target", "mark", f.path)).toContain("below-target");
  expect(f.store.consolidationBatch(f.session.id, f.path.branch, f.path.headTurnId).map(value => value.id)).toContain(pendingFact.id);
  expect(f.memory.pendingTokens("noting", f.path).tokens).toBeGreaterThan(0);
  expect(projectPending()).toBeGreaterThan(0);
});

test("49: declaration uses the host-selected rewind path and accepts material below every threshold", () => {
  const f = base(true);
  const later = f.store.appendTurn({ sessionId: f.session.id, parentTurnId: f.turn.id, kind: "turn", userPrompt: "later pending ".repeat(200), startedAt: "later" });
  const laterPath = { ...f.path, headTurnId: later.id };
  const selectedTokens = f.memory.pendingTokens("noting", f.path).tokens!;
  const laterTokens = f.memory.pendingTokens("noting", laterPath).tokens!;
  expect(laterTokens).toBeGreaterThan(selectedTokens);
  f.memory.config.noting.triggerTokens = selectedTokens + 1;
  expect(f.memory.declareProject(f.session.id, "rewind-target", "mark", f.path)).toContain("rewind-target");
  expect(f.memory.pendingTokens("noting", laterPath).tokens).toBe(laterTokens);
});

test("64c/49: disabled enrollment does not mask the Noting declaration guard or clear historical facts", () => {
  const f = base(true), pending = fact(f);
  const measured = f.memory.pendingTokens("noting", f.path).tokens!;
  f.memory.config.noting.triggerTokens = measured;
  f.store.setEnrollment(f.session.id, false);
  expect(f.memory.taskEligibility("noting", f.path).due).toBe(false);
  expect(() => f.memory.declareProject(f.session.id, "disabled-target", "mark", f.path)).toThrow(/noting is due/);
  expect(f.memory.pendingTokens("noting", f.path).tokens).toBe(measured);
  expect(f.store.consolidationBatch(f.session.id, "main", f.turn.id).map(value => value.id)).toContain(pending.id);
});

test.each(["project", "global"] as const)("86: declaring session's Dreamer blocks its move while processing %s", scope => {
  const f = base(false), item = knowledge(f, scope);
  const pool = scope === "global" ? "global" : `project:${f.own.id}`;
  f.memory.config.dreaming.triggerTokens = 1;
  f.store.setKnowledgeBudget(scope, f.store.pendingPoolWeight(pool, f.path) * 2);
  expect(f.memory.taskEligibility("dreaming", f.path).due).toBe(true);
  const claim = f.store.acquireClaim(f.path, "dreaming", "worker")!;
  expect(claim).not.toBeNull();
  const range = f.store.retainKnowledgePoolRange(f.path, pool, claim);
  const before = { session: f.store.getSession(f.session.id), revisions: f.store.listKnowledgeRevisions() };
  expect(() => f.memory.declareProject(f.session.id, "move-target", "mark", f.path)).toThrow(/dreaming has a live claim/);
  expect(f.store.findProjectByName("move-target")).toBeNull();
  expect(f.store.getSession(f.session.id)).toEqual(before.session);
  expect(f.store.listKnowledgeRevisions()).toEqual(before.revisions);
  f.store.releaseClaim(claim);
  f.memory.config.dreaming.triggerTokens = Number.MAX_SAFE_INTEGER;
  expect(f.memory.declareProject(f.session.id, "move-target", "mark", f.path)).toContain("move-target");
  expect(f.store.dreamingRange(range.id)).not.toBeNull(); // an inactive old range is not a declaration gate
  const target = f.store.findProjectByName("move-target")!;
  expect(f.store.pendingVersions(scope === "global" ? "global" : `project:${target.id}`, f.path).map(v => v.revisionId)).toContain(item.commit);
  expect(f.store.db.prepare("SELECT * FROM knowledge_processed").all()).toEqual([]);
});

test.each(["global", "project", "session"] as const)("86: declaring session's %s Dreamer backlog blocks declaration", scope => {
  const f = base(false), item = knowledge(f, scope);
  f.memory.config.noting.triggerTokens = Number.MAX_SAFE_INTEGER;
  f.memory.config.dreaming.triggerTokens = 1;
  const pool = scope === "global" ? "global" : scope === "project" ? `project:${f.own.id}` : `session:${f.session.id}`;
  expect(f.store.pendingVersions(pool, f.path).map(value => value.revisionId)).toContain(item.commit);
  expect(() => f.memory.declareProject(f.session.id, `dreaming-${scope}`, "mark", f.path)).toThrow(/dreaming is due/);
  expect(f.store.findProjectByName(`dreaming-${scope}`)).toBeNull();
});

test("86: marking the same project is a metadata no-op even with a claim or backlog", () => {
  const f = base(true);
  f.memory.config.noting.triggerTokens = 1;
  const held = f.store.acquireClaim(f.path, "noting", "busy")!;
  expect(held).not.toBeNull();
  expect(f.memory.declareProject(f.session.id, f.own.name, "mark")).toContain(f.own.name);
  expect(f.store.getSession(f.session.id)!.projectId).toBe(f.own.id);
  expect(f.store.getClaim(f.session.id, "noting")).toEqual(held);
});

test("86: explicit redeclaration checks backlog even after the session was previously marked", () => {
  const f = base(false);
  f.memory.config.noting.triggerTokens = Number.MAX_SAFE_INTEGER;
  expect(f.memory.declareProject(f.session.id, "first", "mark", f.path)).toContain("first");
  knowledge(f);
  f.memory.config.dreaming.triggerTokens = 1;
  expect(() => f.memory.declareProject(f.session.id, "second", "mark", f.path)).toThrow(/dreaming is due/);
  expect(f.store.findProjectByName("second")).toBeNull();
});

test.each(["noting", "dreaming"] as const)("86: %s live claim blocks declaration", phase => {
  const f = base(true); fact(f);
  if (phase === "dreaming") knowledge(f);
  const held = f.store.acquireClaim(f.path, phase, "worker");
  expect(held).not.toBeNull();
  expect(() => f.store.declareProject(f.session.id, `claim-${phase}`, "mark", { path: f.path, atTrigger: () => false }))
    .toThrow(new RegExp(`${phase} has a live claim`));
});

test.each(["source", "target", "unrelated"] as const)("86: a %s project peer's live Dreamer does not block the declaring session", relation => {
  const f = base(false); knowledge(f);
  const destination = f.store.createProject({ name: `destination-${relation}`, declaredBy: "mark" });
  const peerProject = relation === "source" ? f.own : relation === "target" ? destination
    : f.store.createProject({ name: "unrelated", declaredBy: "mark" });
  const peerSession = f.store.createSession({ host: "peer", projectId: peerProject.id, projectDeclaration: "mark",
    enrollmentChoice: true, startedAt: "now", firstReplyAt: "now" });
  const peerTurn = f.store.appendTurn({ sessionId: peerSession.id, kind: "turn", userPrompt: "peer evidence", startedAt: "now" });
  const peerSource = seedEntry(f.store, peerSession.id, peerTurn.id, `peer-${peerTurn.id}`, "user", "peer evidence");
  const peerPath = { sessionId: peerSession.id, branch: "main", headTurnId: peerTurn.id };
  const peerItem = knowledge({ ...f, own: peerProject, session: peerSession, turn: peerTurn, source: peerSource, path: peerPath });
  const held = f.store.acquireClaim(peerPath, "dreaming", "peer-executor")!;
  expect(held).not.toBeNull();
  const range = f.store.retainKnowledgePoolRange(peerPath, `project:${peerProject.id}`, held);
  const run = f.store.bindDreamingRun({ kind: "dreaming", sessionId: peerSession.id, branch: "main", projectId: peerProject.id,
    claim: held, dreamingRangeId: range.id, executionId: f.store.beginExecution({ sessionId: peerSession.id, phase: "dreaming", head: range.anchor, origin: range.origin }), createdAt: "now" });
  const move = () => f.memory.declareProject(f.session.id, destination.name, "mark", f.path);
  expect(move()).toContain(destination.name);
  expect(f.store.getSession(f.session.id)!.projectId).toBe(destination.id);
  expect(f.store.getClaim(peerSession.id, "dreaming")).toEqual(held);
  expect(f.store.dreamingRange(range.id)!.pool).toBe(`project:${peerProject.id}`);
  expect(f.store.db.prepare("SELECT * FROM knowledge_processed").all()).toEqual([]);
  const before = f.store.listKnowledgeRevisions().length;
  const commit = f.store.commitConsolidationRun({ path: peerPath, run, operations: [{ op: "update", knowledgeId: peerItem.knowledgeId,
    baseCommit: peerItem.commit, text: "Peer maintenance after another session moved", category: "constraint", scope: "project",
    topics: [], supports: [], reason: "Peer's exact running task", createdAt: "now" }] });
  if (relation === "source") {
    expect(commit.ok).toBe(false); // Its frozen project no longer matches; the peer sees its own failure.
    if (!commit.ok) expect(commit.problems.join(" ")).toMatch(/target project changed after admission/);
  } else expect(commit.ok).toBe(true); // Destination/unrelated project runs remain valid.
  expect(f.store.listKnowledgeRevisions()).toHaveLength(before + Number(commit.ok));
});

function claimFixture() {
  const store = new Store(":memory:");
  const make = (name: string, projectId?: number): TaskTarget => {
    const project = projectId === undefined ? store.createProject({ name, declaredBy: "mark" }) : store.getProject(projectId)!;
    const session = store.createSession({ host: name, projectId: project.id, projectDeclaration: "mark", enrollmentChoice: true, startedAt: "now", firstReplyAt: "now" });
    const turn = store.appendTurn({ sessionId: session.id, kind: "turn", userPrompt: "evidence", startedAt: "now" });
    const source = seedEntry(store, session.id, turn.id, `${name}-evidence`, "user", "evidence");
    const noted = legacyFacts(store, { kind: "manual", sessionId: session.id, createdAt: "now" }, [{
      sources: [{ entry: source, address: `T${turn.id}#user` }], category: "decision", actor: "user", text: "evidence", createdAt: "now",
    }]);
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

test("49: reserved Dreamer takeover keeps its token and blocks peers; Noting remains independent", () => {
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
  expect(f.store.getClaim(f.a.sessionId, "dreaming")).toEqual(takeover);
});

const storesForClaims: Store[] = [];
afterEach(() => { for (const store of storesForClaims.splice(0)) store.close(); });
