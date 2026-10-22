import { afterEach, describe, expect, test } from "vitest";
import { commitNoterKnowledge } from "../../noting-knowledge-fixture.ts";
import type { KnowledgeOperationInput } from "../../../src/core/store/index.ts";
import { readHandle } from "../../read-handle-fixture.ts";
import { loadPrompt } from "../../../src/core/prompts/load.ts";
import { renderKnowledgeChange } from "../../../src/core/render/index.ts";
import { canonicalFlatConfig, REMOVED_SETTINGS, sourceSeededMemory, memoryFiles, validateConfig, type NotingAgentInput } from "../../source-fixture.ts";
import { curateNow } from "../../support/dreamer.ts";
import { block } from "../../support/workspace.ts";
import { submit, submitEmpty, verifyUnchanged } from "../../support/noter.ts";

// Ticket 92 transfers ticket 76's create/update/archive authority from C to N.
// N publishes held operations terminally; D still reviews the diff against its processed baseline.
// Store-only graph/accounting fixtures use the shared N terminal helper; worker tests use real admission.

const time = "2026-09-23T00:00:00Z";
const created = (fact: number, text: string, reason = "New durable conclusion.") => ({
  op: "create", title: "Fixture title", text, category: "reference", scope: "project", topics: ["release"], supports: [`F${fact}`], reason,
});

describe("76/92 Noter updates and archives; Dreamer reviews", () => {
  let memory: ReturnType<typeof sourceSeededMemory>;
  afterEach(() => memory?.close());

  function fixture(agent: (input: NotingAgentInput) => Promise<void> | void) {
    memory = sourceSeededMemory(":memory:", async raw => {
      const input = raw as NotingAgentInput;
      if (input.task === "verify") return verifyUnchanged(input, { request: { one: "request" } });
      await agent(input);
      return { outcome: "success", output: "done", request: { one: "request" } };
    });
    const project = memory.store.createProject({ name: "p", declaredBy: "mark" });
    const session = memory.store.createSession({ host: "test", projectId: project.id, enrollmentChoice: true, startedAt: time, firstReplyAt: time });
    const turn = memory.store.appendTurn({ sessionId: session.id, kind: "turn", userPrompt: "beta.5 is current", startedAt: time });
    const facts = memory.store.commitNotingRun({ run: { kind: "manual", sessionId: session.id, branch: "main", createdAt: time },
      facts: [
        { turnId: turn.id, entryIds: memory.store.listSourceEntries(session.id, turn.id).map(entry => entry.id), text: "beta.5 is current", source: [`T${turn.id}#E1`], createdAt: time },
        { turnId: turn.id, entryIds: memory.store.listSourceEntries(session.id, turn.id).map(entry => entry.id), text: "a second independent fact", source: [`T${turn.id}#E1`], createdAt: time },
        { turnId: turn.id, entryIds: memory.store.listSourceEntries(session.id, turn.id).map(entry => entry.id), text: "a third independent fact", source: [`T${turn.id}#E1`], createdAt: time },
      ] });
    if (!facts.ok) throw new Error(facts.problems.join("; "));
    return { session, turn, fact: facts.facts[0]!.id, fact2: facts.facts[1]!.id, fact3: facts.facts[2]!.id };
  }

  const history = (item: { knowledgeId: number; commit: number }) =>
    `K${item.knowledgeId}@v${memory.store.versionOrdinal(item.knowledgeId, item.commit)}`;

  /** N terminal Store publication for graph/accounting cases, without manufacturing Raw progress. */
  function publishN(sessionId: number, operations: KnowledgeOperationInput[]) {
    return commitNoterKnowledge(memory.store, { run: { sessionId, branch: "main", createdAt: time }, operations });
  }

  test("N publishes the final content of its file at terminal success", async () => {
    let calls = 0;
    const f = fixture(async input => {
      calls++;
      input.reportRequest({ one: "request" });
      await submit(input, memory, { noteInput: [], memoryInput: created(f.fact, "corrected") });
      expect(memory.store.currentKnowledge()).toEqual([]);
    });
    const result = await memory.noting({ sessionId: f.session.id, branch: "main", headTurnId: f.turn.id });
    expect(result.outcome).toBe("success");
    expect(memory.store.currentCommit(1)[0]!.text).toBe("corrected");
    expect(calls).toBe(1); // the host's stop hook supplies any second pass; Core invokes the write task once
    const run = memory.store.getRun((result as { runId: number }).runId)!;
    expect(JSON.parse(run.request!)).toEqual({ one: "request" });
    expect(JSON.parse(run.response!).files.knowledge).toContain("corrected");
  });

  test("N terminal Store authority permits create/update/archive and rejects merge/split", () => {
    const f = fixture(() => {});
    const base = publishN(f.session.id, [{ op: "create", title: "Fixture title", handle: "$base", author: "noting", text: "beta.4 is current",
      category: "reference", scope: "project", topics: [], supports: [f.fact], reason: "Initial.", createdAt: time }]);
    if (!base.ok) throw new Error(base.problems.join("; "));
    const baseCommit = base.committed[0]!;
    const updated = publishN(f.session.id, [{ op: "update", knowledgeId: baseCommit.knowledgeId, baseCommit: baseCommit.commit,
      text: "beta.5 is current", category: "reference", scope: "project", topics: [], supports: [f.fact], reason: "Version bumped.", createdAt: time }]);
    expect(updated.ok).toBe(true);
    if (!updated.ok) return;
    const archived = publishN(f.session.id, [{ op: "archive", kind: "invalid", text: "Retired; no longer holds and nothing replaces it.", knowledgeId: baseCommit.knowledgeId, baseCommit: updated.committed[0]!.commit,
      supports: [f.fact2], reason: "Retired.", createdAt: time }]);
    expect(archived.ok).toBe(true);

    for (const forbidden of [
      { op: "merge", intoKnowledgeId: baseCommit.knowledgeId, intoBaseCommit: baseCommit.commit, absorb: [{ knowledgeId: 99, baseCommit: 99 }],
        text: "merged", category: "reference", scope: "project", topics: [], supports: [f.fact], reason: "x", createdAt: time },
      { op: "split", knowledgeId: baseCommit.knowledgeId, baseCommit: baseCommit.commit, text: "Primary part.", category: "reference", scope: "project", topics: [], children: [
        { title: "Fixture child", text: "a", category: "reference", topics: [] }, { title: "Fixture child", text: "b", category: "reference", topics: [] }], supports: [f.fact], reason: "x", createdAt: time },
    ] satisfies KnowledgeOperationInput[]) {
      const rejected = publishN(f.session.id, [forbidden]);
      expect(rejected.ok).toBe(false);
      if (!rejected.ok) expect(rejected.problems.join(" ")).toBe("Noter permits create, update and archive only");
    }
  });

  test("N converts a legitimately advanced base to a new identity, while current-base updates stay on the original identity", () => {
    const f = fixture(() => {});
    const base = publishN(f.session.id, [{ op: "create", title: "Fixture title", handle: "$base", author: "noting", text: "v1",
      category: "reference", scope: "project", topics: [], supports: [f.fact], reason: "Initial.", createdAt: time }]);
    if (!base.ok) throw new Error(base.problems.join("; "));
    const first = base.committed[0]!;
    // Someone else moves the identity forward first (K@1 -> K@2).
    const moved = publishN(f.session.id, [{ op: "update", knowledgeId: first.knowledgeId, baseCommit: first.commit,
      text: "v2", category: "reference", scope: "project", topics: [], supports: [f.fact2], reason: "Moved.", createdAt: time }]);
    if (!moved.ok) throw new Error(moved.problems.join("; "));
    const second = moved.committed[0]!;

    // The N-only conversion creates a separately pending identity, never an effective fork.
    const stale = publishN(f.session.id, [{ op: "update", knowledgeId: first.knowledgeId, baseCommit: first.commit,
      text: "v1-stale-edit", category: "reference", scope: "project", topics: [], supports: [f.fact3], reason: "Stale.", createdAt: time }]);
    expect(stale.ok).toBe(true);
    if (!stale.ok) throw new Error(stale.problems.join("; "));
    const converted = stale.committed[0]!;
    expect(converted.knowledgeId).not.toBe(first.knowledgeId);
    expect(converted.op).toBe("create");
    expect(memory.store.knowledgeRevision(converted.commit)!.text).toContain(`K${first.knowledgeId}#${memory.store.versionTag(first.knowledgeId, first.commit)}`);
    expect(memory.store.knowledgeRevision(converted.commit)!.supports).toEqual([f.fact3]);
    expect(memory.store.listKnowledgeRevisions(first.knowledgeId)).toHaveLength(2);

    // A later N publication against the current version extends the original identity.
    const resubmitted = publishN(f.session.id, [{ op: "update", knowledgeId: first.knowledgeId, baseCommit: second.commit,
      text: "v3", category: "reference", scope: "project", topics: [], supports: [f.fact3], reason: "Correct base.", createdAt: time }]);
    expect(resubmitted.ok).toBe(true);
    if (!resubmitted.ok) return;
    const third = resubmitted.committed[0]!;

    // A subsequent publication with a newly stale base converts independently.
    const late = publishN(f.session.id, [{ op: "update", knowledgeId: first.knowledgeId, baseCommit: second.commit,
      text: "v4", category: "reference", scope: "project", topics: [], supports: [f.fact], reason: "Late.", createdAt: time }]);
    expect(late.ok).toBe(true);
    if (!late.ok) throw new Error(late.problems.join("; "));
    expect(late.committed[0]!.op).toBe("create");
    expect(late.committed[0]!.knowledgeId).not.toBe(first.knowledgeId);
    expect(memory.store.currentCommit(first.knowledgeId)[0]!.id).toBe(third.commit);
  });

  test("D stale writes still refuse after N advances the base; N's new version stays current", () => {
    const f = fixture(() => {});
    const base = publishN(f.session.id, [{ op: "create", title: "Fixture title", handle: "$base", author: "noting", text: "frozen base",
      category: "reference", scope: "project", topics: [], supports: [f.fact], reason: "Initial.", createdAt: time }]);
    if (!base.ok) throw new Error(base.problems.join("; "));
    const k5 = base.committed[0]!;
    const path = { sessionId: f.session.id, branch: "main", headTurnId: f.turn.id };
    // N advances the base after D has read it; D's operation on the old base is refused and nothing else happens to it -
    // no fallback conversion, no automatic retry against the new base.
    const moved = commitNoterKnowledge(memory.store, { run: { sessionId: f.session.id, branch: "main", createdAt: time },
      operations: [{ op: "update", knowledgeId: k5.knowledgeId, baseCommit: k5.commit, text: "C moved it", category: "reference",
        scope: "project", topics: [], supports: [f.fact], reason: "C moved it.", createdAt: time }] });
    if (!moved.ok) throw new Error(moved.problems.join("; "));
    const cMoved = moved.committed[0]!;
    const refused = curateNow(memory, path, block(`update ${history(k5)}`, { supports: `F${f.fact}`, reason: "D edit." }, "D's edit")).blocks[0]!;
    expect(refused).toMatchObject({ status: "refused", stale: true });
    expect(refused.reason).toContain(history(cMoved));
    expect(memory.store.currentCommit(k5.knowledgeId, path).map(v => v.id)).toEqual([cMoved.commit]);
    expect(memory.store.currentCommit(k5.knowledgeId, path)[0]!.text).toBe("C moved it");
  });

  test("scope and applicability: a project-scope N update is visible across the project's sessions and follows its own facts, not its parent's", () => {
    const f = fixture(() => {});
    const rootTurn = f.turn;
    const childTurn = memory.store.appendTurn({ sessionId: f.session.id, parentTurnId: rootTurn.id, kind: "turn", userPrompt: "child", startedAt: time });
    memory.selectEntries(f.session.id, "main", memory.store.listSourceEntries(f.session.id).map(entry => entry.id));
    const childFacts = memory.store.commitNotingRun({ run: { kind: "noting", sessionId: f.session.id, branch: "main", createdAt: time },
      entryIds: memory.store.sourcePath(f.session.id, "main", childTurn.id).map(entry => entry.id),
      facts: [{ turnId: childTurn.id, entryIds: memory.store.listSourceEntries(f.session.id, childTurn.id).map(entry => entry.id), text: "child-only evidence", source: [`T${childTurn.id}#E1`], createdAt: time }] });
    if (!childFacts.ok) throw new Error(childFacts.problems.join("; "));
    const childFact = childFacts.facts[0]!.id;
    const created0 = publishN(f.session.id, [{ op: "create", title: "Fixture title", handle: "$p", author: "noting", text: "v1", category: "reference",
      scope: "project", topics: [], supports: [f.fact], reason: "Initial.", createdAt: time }]);
    if (!created0.ok) throw new Error(created0.problems.join("; "));
    const first = created0.committed[0]!;
    const childPath = { sessionId: f.session.id, branch: "main", headTurnId: childTurn.id };
    const updated = commitNoterKnowledge(memory.store, { path: childPath, run: { sessionId: f.session.id, branch: "main", createdAt: time },
      operations: [{ op: "update", knowledgeId: first.knowledgeId, baseCommit: first.commit, text: "v2", category: "reference",
        scope: "project", topics: [], supports: [childFact], reason: "Its own update.", createdAt: time }] });
    if (!updated.ok) throw new Error(updated.problems.join("; "));
    const second = updated.committed[0]!;

    // Another session of the same project sees the update.
    const other = memory.store.createSession({ host: "test", projectId: f.session.projectId, enrollmentChoice: true, startedAt: time, firstReplyAt: time });
    const otherTurn = memory.store.appendTurn({ sessionId: other.id, kind: "turn", userPrompt: "reader", startedAt: time });
    const otherPath = { sessionId: other.id, branch: "main", headTurnId: otherTurn.id };
    expect(memory.store.currentCommit(first.knowledgeId, otherPath).map(r => r.id)).toEqual([second.commit]);

    // Roll S1 back past the update's own fact (sourced from the child Turn): the earlier version applies again.
    memory.store.setCurrentPath(f.session.id, "main", rootTurn.id, "test-76-lineage");
    expect(memory.store.currentCommit(first.knowledgeId, { sessionId: f.session.id, branch: "main", headTurnId: rootTurn.id }).map(r => r.id)).toEqual([first.commit]);
    expect(memory.store.currentCommit(first.knowledgeId, otherPath).map(r => r.id)).toEqual([first.commit]);

    // Advance again: the update's own fact returns and the update is visible; the parent's own facts
    // leaving the path never revokes an update that cites only its own, still-applicable facts.
    memory.store.setCurrentPath(f.session.id, "main", childTurn.id, "test-76-lineage");
    expect(memory.store.currentCommit(first.knowledgeId, otherPath).map(r => r.id)).toEqual([second.commit]);
  });

  test("scope and applicability: a global-scope N update is visible from every session", () => {
    const f = fixture(() => {});
    const created0 = publishN(f.session.id, [{ op: "create", title: "Fixture title", handle: "$g", author: "noting", text: "global v1", category: "reference",
      scope: "global", topics: [], supports: [f.fact], reason: "Initial.", createdAt: time }]);
    if (!created0.ok) throw new Error(created0.problems.join("; "));
    const first = created0.committed[0]!;
    const updated = publishN(f.session.id, [{ op: "update", knowledgeId: first.knowledgeId, baseCommit: first.commit, text: "global v2",
      category: "reference", scope: "global", topics: [], supports: [f.fact2], reason: "Updated.", createdAt: time }]);
    if (!updated.ok) throw new Error(updated.problems.join("; "));
    const other = memory.store.createSession({ host: "test", projectId: memory.store.createProject({ name: "elsewhere", declaredBy: "mark" }).id,
      enrollmentChoice: true, startedAt: time, firstReplyAt: time });
    const otherTurn = memory.store.appendTurn({ sessionId: other.id, kind: "turn", userPrompt: "reader", startedAt: time });
    expect(memory.store.currentCommit(first.knowledgeId, { sessionId: other.id, branch: "main", headTurnId: otherTurn.id }).map(r => r.id))
      .toEqual([updated.committed[0]!.commit]);
  });

  test("92 version bases need no read ledger; stale refusal names history without a body or tag, and a current version commits", () => {
    memory = sourceSeededMemory(":memory:", async () => ({ outcome: "success" as const, output: "unused", request: { unused: true } }));
    const project = memory.store.createProject({ name: "reads", declaredBy: "mark" });
    const session = memory.store.createSession({ host: "test", projectId: project.id, enrollmentChoice: true, startedAt: time, firstReplyAt: time });
    const turn = memory.store.appendTurn({ sessionId: session.id, kind: "turn", userPrompt: "rule", startedAt: time });
    const selectedEntries = memory.store.listSourceEntries(session.id);
    memory.selectEntries(session.id, "main", selectedEntries.map(entry => entry.id));
    const triggerEntryId = selectedEntries.at(-1)!.id;
    const noted = memory.store.commitNotingRun({ run: { kind: "noting", sessionId: session.id, branch: "main", createdAt: time },
      entryIds: memory.store.sourcePath(session.id, "main", turn.id).map(entry => entry.id), facts: [{ turnId: turn.id,
        entryIds: selectedEntries.map(entry => entry.id), text: "rule", source: [`T${turn.id}#E1`], createdAt: time }] });
    if (!noted.ok) throw new Error(noted.problems.join("; "));
    const fact = noted.facts[0]!.id;
    const createdRun = commitNoterKnowledge(memory.store, { run: { sessionId: session.id, branch: "main", createdAt: time }, operations: [{
      op: "create", title: "Fixture title", handle: "$base", author: "consolidation", text: "base rule", category: "constraint", scope: "project",
      supports: [fact], topics: [], reason: "Initial rule.", createdAt: time,
    }] });
    if (!createdRun.ok) throw new Error(createdRun.problems.join("; "));
    const base = createdRun.committed[0]!;
    const moved = commitNoterKnowledge(memory.store, { run: { sessionId: session.id, branch: "main", createdAt: time }, operations: [{
      op: "update", knowledgeId: base.knowledgeId, baseCommit: base.commit, text: "moved rule", category: "constraint", scope: "project",
      supports: [fact], topics: [], reason: "Moved.", createdAt: time,
    }] });
    if (!moved.ok) throw new Error(moved.problems.join("; "));
    const current = moved.committed[0]!;
    const path = { sessionId: session.id, branch: "main", headTurnId: turn.id, triggerEntryId };

    // Naming an exact version without having read it: authority depends on the current base, not read history.
    const blind = curateNow(memory, path, block(`update ${history(base)}`, { supports: `F${fact}`, reason: "Blind." }, "blind edit")).blocks[0]!;
    expect(blind).toMatchObject({ status: "refused", stale: true });
    expect(blind.reason).toContain("base is not the latest effective applicable revision");
    expect(blind.reason).toContain(history(current));
    expect(blind.reason).not.toContain(`K${current.knowledgeId}#${memory.store.versionTag(current.knowledgeId, current.commit)}`);
    expect(blind.reason).not.toContain("base rule");
    expect(blind.reason).not.toContain("moved rule");
    const corrected = curateNow(memory, path, block(`update ${history(current)}`, { supports: `F${fact}`, reason: "Correct." }, "corrected rule")).blocks[0]!;
    expect(corrected).toMatchObject({ status: "applied" });
    expect(memory.store.currentCommit(base.knowledgeId, path)[0]?.text).toBe("corrected rule");
  });

  test("N converts only visible concurrent advancement and refuses an invisible successor without leaking it", () => {
    const f = fixture(() => {});

    // Visible same-project advancement is the only conflict that N may convert.
    const visBase = publishN(f.session.id, [{ op: "create", title: "Fixture title", handle: "$v", author: "consolidation", text: "visible v1",
      category: "reference", scope: "project", topics: [], supports: [f.fact], reason: "Initial.", createdAt: time }]);
    if (!visBase.ok) throw new Error(visBase.problems.join("; "));
    const visFirst = visBase.committed[0]!;
    const visMoved = publishN(f.session.id, [{ op: "update", knowledgeId: visFirst.knowledgeId, baseCommit: visFirst.commit,
      text: "visible v2", category: "reference", scope: "project", topics: [], supports: [f.fact2], reason: "Moved.", createdAt: time }]);
    if (!visMoved.ok) throw new Error(visMoved.problems.join("; "));
    const visSecond = visMoved.committed[0]!;
    const visStale = publishN(f.session.id, [{ op: "update", knowledgeId: visFirst.knowledgeId, baseCommit: visFirst.commit,
      text: "stale edit", category: "reference", scope: "project", topics: [], supports: [f.fact3], reason: "Stale.", createdAt: time }]);
    expect(visStale.ok).toBe(true);
    if (!visStale.ok) throw new Error(visStale.problems.join("; "));
    expect(visStale.committed[0]!.op).toBe("create");
    expect(memory.store.currentCommit(visFirst.knowledgeId)[0]!.id).toBe(visSecond.commit);

    // Invisible case: another project's N scopes the global item down; that successor cannot authorize conversion.
    const global0 = publishN(f.session.id, [{ op: "create", title: "Fixture title", handle: "$g", author: "consolidation", text: "public claim",
      category: "reference", scope: "global", topics: [], supports: [f.fact], reason: "Initial.", createdAt: time }]);
    if (!global0.ok) throw new Error(global0.problems.join("; "));
    const g1 = global0.committed[0]!;
    const otherProject = memory.store.createProject({ name: "elsewhere", declaredBy: "mark" });
    const otherSession = memory.store.createSession({ host: "test", projectId: otherProject.id, enrollmentChoice: true, startedAt: time, firstReplyAt: time });
    const otherTurn = memory.store.appendTurn({ sessionId: otherSession.id, kind: "turn", userPrompt: "elsewhere", startedAt: time });
    const otherFacts = memory.store.commitNotingRun({ run: { kind: "noting", sessionId: otherSession.id, branch: "main", createdAt: time },
      entryIds: memory.store.sourcePath(otherSession.id, "main", otherTurn.id).map(entry => entry.id),
      facts: [{ turnId: otherTurn.id, entryIds: memory.store.listSourceEntries(otherSession.id, otherTurn.id).map(entry => entry.id), text: "elsewhere evidence", source: [`T${otherTurn.id}#E1`], createdAt: time }] });
    if (!otherFacts.ok) throw new Error(otherFacts.problems.join("; "));
    const otherFact = otherFacts.facts[0]!.id;
    const scoped = publishN(otherSession.id, [{ op: "update", knowledgeId: g1.knowledgeId, baseCommit: g1.commit, text: "private replacement",
      category: "reference", scope: "project", topics: [], supports: [otherFact], reason: "Scoped elsewhere.", createdAt: time }]);
    if (!scoped.ok) throw new Error(scoped.problems.join("; "));
    const g2 = scoped.committed[0]!;
    const path = { sessionId: f.session.id, branch: "main", headTurnId: f.turn.id };
    // The original writer can no longer see anything about this identity: K@2 is scoped elsewhere,
    // and K@1 is no longer the current effective revision.
    expect(memory.store.currentCommit(g1.knowledgeId, path)).toEqual([]);

    const staleGlobal = publishN(f.session.id, [{ op: "update", knowledgeId: g1.knowledgeId, baseCommit: g1.commit, text: "stale global update",
      category: "reference", scope: "global", topics: [], supports: [f.fact2], reason: "Stale.", createdAt: time }]);
    expect(staleGlobal.ok).toBe(false);
    if (!staleGlobal.ok) {
      const message = staleGlobal.problems.join(" ");
      expect(message).toBe(`K${g1.knowledgeId}@${g1.commit}: base is not the latest effective applicable revision; no current version is visible on this branch`);
      expect(message).not.toContain(`@${g2.commit}`);
      expect(message).not.toContain("private replacement");
    }
  });

  describe("archives", () => {
    test("an N archive removes the item from the live set", () => {
      const f = fixture(() => {});
      const created0 = publishN(f.session.id, [{ op: "create", title: "Fixture title", handle: "$a", author: "noting", text: "removable body",
        category: "reference", scope: "project", topics: [], supports: [f.fact], reason: "Initial.", createdAt: time }]);
      if (!created0.ok) throw new Error(created0.problems.join("; "));
      const first = created0.committed[0]!;
      const path = { sessionId: f.session.id, branch: "main", headTurnId: f.turn.id };
      expect(memory.store.curateItems(path).map(item => item.value.knowledge.id)).toEqual([first.knowledgeId]);
      const archived = publishN(f.session.id, [{ op: "archive", kind: "invalid", text: "No longer holds; nothing replaces it.", knowledgeId: first.knowledgeId, baseCommit: first.commit,
        supports: [f.fact2], reason: "No longer holds.", createdAt: time }]);
      if (!archived.ok) throw new Error(archived.problems.join("; "));
      // Pool size (the injected material) excludes the archive entirely.
      expect(memory.store.curateItems(path)).toEqual([]);
      expect(memory.store.currentKnowledge(path)).toHaveLength(0);
    });
  });

  describe("diff rendering", () => {
    test("the version address never counts: two revisions differing only in K@commit find no change", () => {
      memory = sourceSeededMemory(":memory:", async () => ({ outcome: "success", output: "unused", request: {} }));
      const project = memory.store.createProject({ name: "addr", declaredBy: "mark" });
      const session = memory.store.createSession({ host: "test", projectId: project.id, enrollmentChoice: true, startedAt: time, firstReplyAt: time });
      const turn = memory.store.appendTurn({ sessionId: session.id, kind: "turn", userPrompt: "seed", startedAt: time });
      const noted = memory.store.commitNotingRun({ run: { kind: "noting", sessionId: session.id, branch: "main", createdAt: time },
        entryIds: memory.store.sourcePath(session.id, "main", turn.id).map(e => e.id),
        facts: [{ turnId: turn.id, entryIds: memory.store.listSourceEntries(session.id, turn.id).map(entry => entry.id), text: "seed", source: [`T${turn.id}#E1`], createdAt: time }] });
      if (!noted.ok) throw new Error(noted.problems.join("; "));
      const fact = noted.facts[0]!.id;
      const c1 = commitNoterKnowledge(memory.store, { run: { sessionId: session.id, branch: "main", createdAt: time },
        operations: [{ op: "create", title: "Fixture title", handle: "$k", author: "consolidation", text: "identical text", category: "reference", scope: "project",
          topics: [], supports: [fact], reason: "Initial.", createdAt: time }] });
      if (!c1.ok) throw new Error(c1.problems.join("; "));
      const v1 = memory.store.knowledgeRevision(c1.committed[0]!.commit)!;
      const c2 = commitNoterKnowledge(memory.store, { run: { sessionId: session.id, branch: "main", createdAt: time },
        operations: [{ op: "update", knowledgeId: c1.committed[0]!.knowledgeId, baseCommit: c1.committed[0]!.commit, text: "identical text",
          category: "reference", scope: "project", topics: [], supports: [fact], reason: "No real change.", createdAt: time }] });
      if (!c2.ok) throw new Error(c2.problems.join("; "));
      const v2 = memory.store.knowledgeRevision(c2.committed[0]!.commit)!;
      expect(v1.id).not.toBe(v2.id); // the K@commit address differs
      const change = renderKnowledgeChange(c1.committed[0]!.knowledgeId, v1, v2);
      expect(change.addedTokens).toBe(0);
      expect(change.removedTokens).toBe(0);
    });
  });

  test("manual memory shares the N schema and commits create, update and archive immediately", () => {
    const f = fixture(() => {});
    const tools = memory.tools({ kind: "manual", sessionId: f.session.id, branch: "main", currentTurnId: f.turn.id });
    const memoryTool = tools.find(tool => tool.name === "memory")!;
    expect((memoryTool.parameters.properties as any).op.enum).toEqual(["create", "update", "archive"]);
    expect(memoryTool.execute(created(f.fact, "manual item"))).toContain('"committed"');
    const tag = readHandle(address => memoryFiles(memory, { sessionId: f.session.id, branch: "main", headTurnId: f.turn.id }).read(address).content, "K1");
    const updated = JSON.parse(memoryTool.execute({ ...created(f.fact, "changed"), op: "update", id: tag }));
    expect(updated.committed).toHaveLength(1);
    expect(memoryTool.execute({ op: "archive", kind: "invalid", text: "Retired; no longer holds and nothing replaces it.", id: updated.committed[0].version, supports: [`F${f.fact}`], reason: "Retired." })).toContain('"committed"');
  });

  test("prompt and material contain no second-round cues", async () => {
    const f = fixture(input => {
      expect(input.prompt).not.toContain("Second-round user message");
      expect(input.prompt).not.toContain("NEAR");
      expect(input.prompt).not.toContain("CLOSER");
      expect(input.prompt).toContain("Merge, split and archive belong to curate");
      expect(input.text).not.toContain("Negated-evidence reminder");
      expect("reminders" in input.material).toBe(false);
      submitEmpty(input);
    });
    expect(loadPrompt("noting.md")).not.toContain("Second-round user message");
    expect(loadPrompt("noting.md")).toContain("Merge, split and archive belong to curate");
    expect((await memory.noting({ sessionId: f.session.id, branch: "main", headTurnId: f.turn.id })).outcome).toBe("success");
  });

  test("removed consolidation nearThreshold fails explicitly in flat and nested configuration", () => {
    const explanation = "remove it; Consolidation review cues and lexical NEAR selection no longer exist";
    expect(REMOVED_SETTINGS["consolidation.nearThreshold"]).toBe(explanation);
    expect(() => canonicalFlatConfig({ "consolidation.nearThreshold": 0.4 })).toThrow(
      `Removed setting consolidation.nearThreshold: ${explanation}`,
    );
    expect(() => validateConfig({ consolidation: { nearThreshold: 0.4 } } as never)).toThrow(
      `Removed setting consolidation.nearThreshold: ${explanation}`,
    );
  });
});
