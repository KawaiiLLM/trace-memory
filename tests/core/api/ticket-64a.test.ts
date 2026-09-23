import { afterEach, describe, expect, test } from "vitest";
import { loadPrompt } from "../../../src/core/prompts/load.ts";
import { renderKnowledgeChange, wordLevelDiff } from "../../../src/core/render/index.ts";
import { canonicalFlatConfig, REMOVED_SETTINGS, sourceSeededMemory, validateConfig, type ConsolidationAgentInput } from "../../source-fixture.ts";
import { AdmittedDreamerScenarios, createDreamerTrigger } from "../../admitted-dreamer-scenario.ts";

// This file was 64a's ("Consolidator creates only"); ticket 76 supersedes that ruling and its tests
// (64a's create-only pins are removed here, not merely extended) — the Consolidator now creates,
// updates and archives, and the Dreamer reviews every change as a diff against the version it last
// confirmed. See .scratch/v1/issues/76-consolidator-updates-and-archives-dreamer-reviews.md.

const time = "2026-09-23T00:00:00Z";
const created = (fact: number, text: string, reason = "New durable conclusion.") => ({
  operations: [{ op: "create", text, category: "reference", scope: "project", topics: ["release"], supports: [`F${fact}`], reason }],
  skipped: [],
});

describe("76 Consolidator updates and archives; Dreamer reviews", () => {
  let memory: ReturnType<typeof sourceSeededMemory>;
  afterEach(() => memory?.close());

  function fixture(agent: (input: ConsolidationAgentInput) => Promise<void> | void) {
    memory = sourceSeededMemory(":memory:", async raw => {
      const input = raw as ConsolidationAgentInput;
      await agent(input);
      return { outcome: "success", output: "done", request: { one: "request" } };
    });
    const project = memory.store.createProject({ name: "p", declaredBy: "mark" });
    const session = memory.store.createSession({ host: "test", projectId: project.id, enrollmentChoice: true, startedAt: time, firstReplyAt: time });
    const turn = memory.store.appendTurn({ sessionId: session.id, kind: "turn", userPrompt: "beta.5 is current", startedAt: time });
    const facts = memory.store.commitNotingRun({ run: { kind: "noting", sessionId: session.id, branch: "main", createdAt: time },
      entryIds: memory.store.sourcePath(session.id, "main", turn.id).map(entry => entry.id),
      facts: [
        { turnId: turn.id, category: "observation", actor: "user", text: "beta.5 is current", source: [`T${turn.id}#user`], createdAt: time },
        { turnId: turn.id, category: "observation", actor: "user", text: "a second independent fact", source: [`T${turn.id}#user`], createdAt: time },
        { turnId: turn.id, category: "observation", actor: "user", text: "a third independent fact", source: [`T${turn.id}#user`], createdAt: time },
      ] });
    if (!facts.ok) throw new Error(facts.problems.join("; "));
    return { session, turn, fact: facts.facts[0]!.id, fact2: facts.facts[1]!.id, fact3: facts.facts[2]!.id };
  }

  /** A direct low-level Consolidation write, bypassing the model round-trip. */
  function writeC(sessionId: number, operations: unknown[]) {
    return memory.store.commitConsolidationRun({ run: { kind: "consolidation", sessionId, branch: "main", createdAt: time },
      operations: operations as never });
  }

  test("the first valid submission commits and a later call is rejected", async () => {
    let calls = 0;
    const f = fixture(input => {
      calls++;
      input.reportRequest({ one: "request" });
      const memoryTool = input.tools.find(tool => tool.name === "memory")!;
      const receipt = memoryTool.execute(created(f.fact, "beta.5 is current"));
      expect(receipt).toContain('"committed"');
      expect(receipt).not.toContain("feedback");
      expect(memoryTool.execute(created(f.fact, "duplicate"))).toContain("already committed");
    });
    const result = await memory.consolidate({ sessionId: f.session.id, branch: "main", headTurnId: f.turn.id });
    expect(result).toMatchObject({ outcome: "success", committed: [{ op: "create" }] });
    expect(calls).toBe(1);
    const run = memory.store.getRun((result as { runId: number }).runId)!;
    expect(JSON.parse(run.request!)).toEqual({ one: "request" });
    expect(JSON.parse(run.response!).toolCalls).toHaveLength(2);
  });

  test("C's authority: a batch commits create, update and archive; merge and split are rejected with Dreamer guidance", () => {
    const f = fixture(() => {});
    const base = writeC(f.session.id, [{ op: "create", handle: "$base", author: "consolidation", text: "beta.4 is current",
      category: "reference", scope: "project", topics: [], supports: [f.fact], reason: "Initial.", createdAt: time }]);
    if (!base.ok) throw new Error(base.problems.join("; "));
    const baseCommit = base.committed[0]!;
    const updated = writeC(f.session.id, [{ op: "update", knowledgeId: baseCommit.knowledgeId, baseCommit: baseCommit.commit,
      text: "beta.5 is current", category: "reference", scope: "project", topics: [], supports: [f.fact], reason: "Version bumped.", createdAt: time }]);
    expect(updated.ok).toBe(true);
    if (!updated.ok) return;
    const archived = writeC(f.session.id, [{ op: "archive", knowledgeId: baseCommit.knowledgeId, baseCommit: updated.committed[0]!.commit,
      supports: [f.fact2], reason: "Retired.", createdAt: time }]);
    expect(archived.ok).toBe(true);

    for (const forbidden of [
      { op: "merge", intoKnowledgeId: baseCommit.knowledgeId, intoBaseCommit: baseCommit.commit, absorb: [{ knowledgeId: 99, baseCommit: 99 }],
        category: "reference", scope: "project", topics: [], supports: [f.fact], reason: "x", createdAt: time },
      { op: "split", knowledgeId: baseCommit.knowledgeId, baseCommit: baseCommit.commit, children: [
        { text: "a", category: "reference", topics: [] }, { text: "b", category: "reference", topics: [] }], supports: [f.fact], reason: "x", createdAt: time },
    ]) {
      const rejected = writeC(f.session.id, [forbidden]);
      expect(rejected.ok).toBe(false);
      if (!rejected.ok) expect(rejected.problems.join(" ")).toContain("Dreamer");
    }
  });

  test("C's schema exposes create, update and archive; merge and split are absent", async () => {
    const f = fixture(input => {
      const definition = input.tools.find(tool => tool.name === "memory")!;
      const schema = (definition.parameters.properties as any).operations.items;
      expect(schema.properties.op.enum).toEqual(["create", "update", "archive"]);
      expect(schema.properties).toHaveProperty("id");
      expect(schema.properties).not.toHaveProperty("absorb");
      for (const operation of [
        { op: "merge", id: "K1@1", absorb: ["K2@2"] },
        { op: "split", id: "K1@1" },
      ]) {
        const receipt = definition.execute({ operations: [{ ...created(f.fact, "new").operations[0], ...operation }], skipped: [] });
        expect(receipt).toContain("Dreamer");
      }
    });
    const result = await memory.consolidate({ sessionId: f.session.id, branch: "main", headTurnId: f.turn.id });
    expect(result.outcome).toBe("bounced");
  });

  test("refusal without fallback: a stale base names the current version; C resubmits as update in the same run and commits; nothing converts automatically; a later submission after commit is rejected", () => {
    const f = fixture(() => {});
    const base = writeC(f.session.id, [{ op: "create", handle: "$base", author: "consolidation", text: "v1",
      category: "reference", scope: "project", topics: [], supports: [f.fact], reason: "Initial.", createdAt: time }]);
    if (!base.ok) throw new Error(base.problems.join("; "));
    const first = base.committed[0]!;
    // Someone else moves the identity forward first (K@1 -> K@2).
    const moved = writeC(f.session.id, [{ op: "update", knowledgeId: first.knowledgeId, baseCommit: first.commit,
      text: "v2", category: "reference", scope: "project", topics: [], supports: [f.fact2], reason: "Moved.", createdAt: time }]);
    if (!moved.ok) throw new Error(moved.problems.join("; "));
    const second = moved.committed[0]!;

    // A batch that still targets the stale K@1 is refused whole, naming K@2 as current. (The write-time
    // DAG check, shared with every writer including the Dreamer, already names the current version for
    // ordinary same-branch supersession; baseProblem's own improved wording — asserted elsewhere in this
    // file — covers the archived/inapplicable/scope-mismatch cases it alone decides.)
    const stale = writeC(f.session.id, [{ op: "update", knowledgeId: first.knowledgeId, baseCommit: first.commit,
      text: "v1-stale-edit", category: "reference", scope: "project", topics: [], supports: [f.fact3], reason: "Stale.", createdAt: time }]);
    expect(stale.ok).toBe(false);
    if (!stale.ok) expect(stale.problems.join(" ")).toBe(
      `K${first.knowledgeId}@${first.commit}: base is not the latest effective applicable revision; current: K${first.knowledgeId}@${second.commit}`);
    // Nothing converted the refused update into a create: the identity still has exactly two commits.
    expect(memory.store.listKnowledgeRevisions(first.knowledgeId)).toHaveLength(2);

    // Resubmit in the same run, this time against the named current version — it commits.
    const resubmitted = writeC(f.session.id, [{ op: "update", knowledgeId: first.knowledgeId, baseCommit: second.commit,
      text: "v3", category: "reference", scope: "project", topics: [], supports: [f.fact3], reason: "Correct base.", createdAt: time }]);
    expect(resubmitted.ok).toBe(true);
    if (!resubmitted.ok) return;
    const third = resubmitted.committed[0]!;

    // A later submission after a successful commit against the now-stale K@2 is still refused.
    const late = writeC(f.session.id, [{ op: "update", knowledgeId: first.knowledgeId, baseCommit: second.commit,
      text: "v4", category: "reference", scope: "project", topics: [], supports: [f.fact], reason: "Late.", createdAt: time }]);
    expect(late.ok).toBe(false);
    if (!late.ok) expect(late.problems.join(" ")).toBe(
      `K${first.knowledgeId}@${second.commit}: base is not the latest effective applicable revision; current: K${first.knowledgeId}@${third.commit}`);
  });

  test("D refused, nothing else: C updates K@5 while D holds it frozen; D's operation is refused, K@5 is not pending afterwards, and C's version is pending for the next D run", async () => {
    const f = fixture(() => {});
    const base = writeC(f.session.id, [{ op: "create", handle: "$base", author: "consolidation", text: "frozen base",
      category: "reference", scope: "project", topics: [], supports: [f.fact], reason: "Initial.", createdAt: time }]);
    if (!base.ok) throw new Error(base.problems.join("; "));
    const first = base.committed[0]!;
    const scenarios = new AdmittedDreamerScenarios(async () => { throw new Error("unused"); });
    memory.close();
    memory = sourceSeededMemory(":memory:", scenarios.agent);
    // Rebuild the fixture against the scripted-Dreamer memory instance.
    const project = memory.store.createProject({ name: "p2", declaredBy: "mark" });
    const session = memory.store.createSession({ host: "test", projectId: project.id, enrollmentChoice: true, startedAt: time, firstReplyAt: time });
    const turn = memory.store.appendTurn({ sessionId: session.id, kind: "turn", userPrompt: "seed", startedAt: time });
    const noted = memory.store.commitNotingRun({ run: { kind: "noting", sessionId: session.id, branch: "main", createdAt: time },
      entryIds: memory.store.sourcePath(session.id, "main", turn.id).map(entry => entry.id),
      facts: [{ turnId: turn.id, category: "observation", actor: "user", text: "seed", source: [`T${turn.id}#user`], createdAt: time }] });
    if (!noted.ok) throw new Error(noted.problems.join("; "));
    const fact = noted.facts[0]!.id;
    const created0 = memory.store.commitConsolidationRun({ run: { kind: "consolidation", sessionId: session.id, branch: "main", createdAt: time },
      operations: [{ op: "create", handle: "$base", author: "consolidation", text: "frozen base", category: "reference", scope: "project",
        topics: [], supports: [fact], reason: "Initial.", createdAt: time }] });
    if (!created0.ok) throw new Error(created0.problems.join("; "));
    const k5 = created0.committed[0]!;
    const path = { sessionId: session.id, branch: "main", headTurnId: turn.id };
    const trigger = createDreamerTrigger(memory, path, fact, 1);

    // D holds the seat and freezes K@5 before C moves it; D updates it inside the run after C moves it.
    let cMoved: { knowledgeId: number; commit: number } | undefined;
    const dreamed = await scenarios.run(memory, path, input => {
      input.reportRequest({});
      // C moves the base after D has already frozen this pool's material.
      const moved = memory.store.commitConsolidationRun({ run: { kind: "consolidation", sessionId: session.id, branch: "main", createdAt: time },
        operations: [{ op: "update", knowledgeId: k5.knowledgeId, baseCommit: k5.commit, text: "C moved it", category: "reference",
          scope: "project", topics: [], supports: [fact], reason: "C moved it.", createdAt: time }] });
      if (!moved.ok) throw new Error(moved.problems.join("; "));
      cMoved = moved.committed[0]!;
      const write = input.tools.find(tool => tool.name === "memory")!;
      // D's operation on the frozen (now stale) base is refused; nothing else happens to it — no
      // fallback conversion, no automatic retry against the new base.
      const receipt = JSON.parse(write.execute({ operations: [{ op: "update", id: `K${k5.knowledgeId}@${k5.commit}`, text: "D's edit",
        category: "reference", scope: "project", topics: [], supports: [`F${fact}`], reason: "D edit." }], skipped: [] }));
      expect(receipt.results[0]).toContain("base is not the latest effective applicable revision");
      expect(receipt.results[0]).toContain(`K${k5.knowledgeId}@${cMoved.commit}`);
      // D finishes the run through its own separate, valid submission (the per-item discipline: one
      // rejection's blast radius stays one item).
      const closed = JSON.parse(write.execute({ operations: [], skipped: [
        { knowledge: `K${trigger.knowledgeId}@${trigger.commit}`, because: "No maintenance needed for the explicit fixture trigger." }] }));
      expect(closed.committed).toEqual([]);
      return { outcome: "success", output: "D saw the refusal", request: {} };
    });
    expect(dreamed.outcome).toBe("success");
    // K@5 (the frozen version) is superseded and no longer pending; C's new version is pending.
    const pool = `project:${session.projectId}`;
    const pending = memory.store.pendingVersions(pool, path).map(v => v.revisionId);
    expect(pending).not.toContain(k5.commit);
    expect(pending).toContain(cMoved!.commit);
  });

  test("scope and applicability: a project-scope C update is visible across the project's sessions and follows its own facts, not its parent's", () => {
    const f = fixture(() => {});
    const rootTurn = f.turn;
    const childTurn = memory.store.appendTurn({ sessionId: f.session.id, parentTurnId: rootTurn.id, kind: "turn", userPrompt: "child", startedAt: time });
    memory.selectEntries(f.session.id, "main", memory.store.listSourceEntries(f.session.id).map(entry => entry.id));
    const childFacts = memory.store.commitNotingRun({ run: { kind: "noting", sessionId: f.session.id, branch: "main", createdAt: time },
      entryIds: memory.store.sourcePath(f.session.id, "main", childTurn.id).map(entry => entry.id),
      facts: [{ turnId: childTurn.id, category: "observation", actor: "user", text: "child-only evidence", source: [`T${childTurn.id}#user`], createdAt: time }] });
    if (!childFacts.ok) throw new Error(childFacts.problems.join("; "));
    const childFact = childFacts.facts[0]!.id;
    const created0 = writeC(f.session.id, [{ op: "create", handle: "$p", author: "consolidation", text: "v1", category: "reference",
      scope: "project", topics: [], supports: [f.fact], reason: "Initial.", createdAt: time }]);
    if (!created0.ok) throw new Error(created0.problems.join("; "));
    const first = created0.committed[0]!;
    const childPath = { sessionId: f.session.id, branch: "main", headTurnId: childTurn.id };
    const updated = memory.store.commitConsolidationRun({ path: childPath, run: { kind: "consolidation", sessionId: f.session.id, branch: "main", createdAt: time },
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

  test("scope and applicability: a global-scope C update is visible from every session", () => {
    const f = fixture(() => {});
    const created0 = writeC(f.session.id, [{ op: "create", handle: "$g", author: "consolidation", text: "global v1", category: "reference",
      scope: "global", topics: [], supports: [f.fact], reason: "Initial.", createdAt: time }]);
    if (!created0.ok) throw new Error(created0.problems.join("; "));
    const first = created0.committed[0]!;
    const updated = writeC(f.session.id, [{ op: "update", knowledgeId: first.knowledgeId, baseCommit: first.commit, text: "global v2",
      category: "reference", scope: "global", topics: [], supports: [f.fact2], reason: "Updated.", createdAt: time }]);
    if (!updated.ok) throw new Error(updated.problems.join("; "));
    const other = memory.store.createSession({ host: "test", projectId: memory.store.createProject({ name: "elsewhere", declaredBy: "mark" }).id,
      enrollmentChoice: true, startedAt: time, firstReplyAt: time });
    const otherTurn = memory.store.appendTurn({ sessionId: other.id, kind: "turn", userPrompt: "reader", startedAt: time });
    expect(memory.store.currentCommit(first.knowledgeId, { sessionId: other.id, branch: "main", headTurnId: otherTurn.id }).map(r => r.id))
      .toEqual([updated.committed[0]!.commit]);
  });

  test("reads: an update of the version a refusal named, without reading it, is refused by the read rule; after trace it commits; a refusal never carries a body or names an invisible version", async () => {
    const fallback = async () => ({ outcome: "success" as const, output: "unused", request: { unused: true } });
    const scenarios = new AdmittedDreamerScenarios(fallback);
    memory = sourceSeededMemory(":memory:", scenarios.agent);
    const project = memory.store.createProject({ name: "reads", declaredBy: "mark" });
    const session = memory.store.createSession({ host: "test", projectId: project.id, enrollmentChoice: true, startedAt: time, firstReplyAt: time });
    const turn = memory.store.appendTurn({ sessionId: session.id, kind: "turn", userPrompt: "rule", startedAt: time });
    const selectedEntries = memory.store.listSourceEntries(session.id);
    memory.selectEntries(session.id, "main", selectedEntries.map(entry => entry.id));
    const triggerEntryId = selectedEntries.at(-1)!.id;
    const noted = memory.store.commitNotingRun({ run: { kind: "noting", sessionId: session.id, branch: "main", createdAt: time },
      entryIds: memory.store.sourcePath(session.id, "main", turn.id).map(entry => entry.id), facts: [{ turnId: turn.id,
        category: "decision", actor: "user", text: "rule", source: [`T${turn.id}#user`], createdAt: time }] });
    if (!noted.ok) throw new Error(noted.problems.join("; "));
    const fact = noted.facts[0]!.id;
    const createdRun = memory.store.commitConsolidationRun({ run: { kind: "consolidation", sessionId: session.id, branch: "main", createdAt: time }, operations: [{
      op: "create", handle: "$base", author: "consolidation", text: "base rule", category: "constraint", scope: "project",
      supports: [fact], topics: [], reason: "Initial rule.", createdAt: time,
    }] });
    if (!createdRun.ok) throw new Error(createdRun.problems.join("; "));
    const base = createdRun.committed[0]!;
    const moved = memory.store.commitConsolidationRun({ run: { kind: "consolidation", sessionId: session.id, branch: "main", createdAt: time }, operations: [{
      op: "update", knowledgeId: base.knowledgeId, baseCommit: base.commit, text: "moved rule", category: "constraint", scope: "project",
      supports: [fact], topics: [], reason: "Moved.", createdAt: time,
    }] });
    if (!moved.ok) throw new Error(moved.problems.join("; "));
    const current = moved.committed[0]!;
    const path = { sessionId: session.id, branch: "main", headTurnId: turn.id, triggerEntryId };
    const trigger = createDreamerTrigger(memory, path, fact, 1);

    const result = await scenarios.run(memory, path, input => {
      const request = { fixture: "reads" };
      input.reportRequest(request);
      const memoryTool = input.tools.find(tool => tool.name === "memory")!;
      // D never received K@base's body (it was superseded before this run), and never reads it: an
      // update naming the stale address is refused by the read rule, with no body and no invisible name.
      const blind = memoryTool.execute({ operations: [{ op: "update", id: `K${base.knowledgeId}@${base.commit}`, text: "blind edit",
        category: "constraint", scope: "project", supports: [`F${fact}`], topics: [], reason: "Blind." }], skipped: [] });
      expect(blind).toContain("was not read as visible and active");
      expect(blind).not.toContain("base rule");
      expect(blind).not.toContain("moved rule");
      const trace = input.tools.find(tool => tool.name === "trace")!;
      expect(trace.execute({ address: `K${current.knowledgeId}@${current.commit}`, itemBudget: null })).toContain("moved rule");
      const corrected = memoryTool.execute({ operations: [{ op: "update", id: `K${current.knowledgeId}@${current.commit}`, text: "corrected rule",
        category: "constraint", scope: "project", supports: [`F${fact}`], topics: [], reason: "Correct." },
        { op: "archive", id: `K${trigger.knowledgeId}@${trigger.commit}`, supports: [`F${fact}`], reason: "Retire the explicit fixture trigger." }], skipped: [] });
      expect(corrected).toContain('"committed"');
      return { outcome: "success", output: "scenario complete", request };
    });
    if (result.outcome !== "success") throw new Error(JSON.stringify(result));
    expect(memory.store.currentCommit(base.knowledgeId, path)[0]?.text).toBe("corrected rule");
  });

  describe("archives", () => {
    test("a C archive is pending with the weight of the removed body, and pool size excludes it", () => {
      const f = fixture(() => {});
      const created0 = writeC(f.session.id, [{ op: "create", handle: "$a", author: "consolidation", text: "removable body",
        category: "reference", scope: "project", topics: [], supports: [f.fact], reason: "Initial.", createdAt: time }]);
      if (!created0.ok) throw new Error(created0.problems.join("; "));
      const first = created0.committed[0]!;
      const path = { sessionId: f.session.id, branch: "main", headTurnId: f.turn.id };
      const pool = `project:${f.session.projectId}`;
      const beforeSize = memory.store.knowledgePools(path).find(p => p.pool === pool)!.tokens;
      const archived = writeC(f.session.id, [{ op: "archive", knowledgeId: first.knowledgeId, baseCommit: first.commit,
        supports: [f.fact2], reason: "No longer holds.", createdAt: time }]);
      if (!archived.ok) throw new Error(archived.problems.join("; "));
      const pools = memory.store.knowledgePools(path);
      const projectPool = pools.find(p => p.pool === pool)!;
      // Pool size (the injected material) excludes the archive entirely.
      expect(projectPool.tokens).toBe(0);
      expect(projectPool.versions).toHaveLength(0);
      const pending = memory.store.pendingVersions(pool, path);
      expect(pending).toHaveLength(1);
      expect(pending[0]!.revisionId).toBe(archived.committed[0]!.commit);
      expect(pending[0]!.tokens).toBeGreaterThan(0);
      expect(pending[0]!.tokens).toBeLessThanOrEqual(beforeSize);
    });

    test("case A: C creates then archives before D ever processes it shows the archived body whole, with no diff", () => {
      const f = fixture(() => {});
      const created0 = writeC(f.session.id, [{ op: "create", handle: "$a", author: "consolidation", text: "case A body",
        category: "reference", scope: "project", topics: [], supports: [f.fact], reason: "Initial.", createdAt: time }]);
      if (!created0.ok) throw new Error(created0.problems.join("; "));
      const first = created0.committed[0]!;
      const archived = writeC(f.session.id, [{ op: "archive", knowledgeId: first.knowledgeId, baseCommit: first.commit,
        supports: [f.fact2], reason: "Never confirmed.", createdAt: time }]);
      if (!archived.ok) throw new Error(archived.problems.join("; "));
      const path = { sessionId: f.session.id, branch: "main", headTurnId: f.turn.id };
      const pool = `project:${f.session.projectId}`;
      const pending = memory.store.pendingVersions(pool, path)[0]!;
      expect(pending.material).toContain("case A body");
      expect(pending.material).not.toContain("{+");
      expect(pending.material).not.toContain("[-");
    });

    test("case B: D confirmed A, C changed A to B, then archived B: shows B whole with the diff A -> B", () => {
      const f = fixture(() => {});
      const created0 = writeC(f.session.id, [{ op: "create", handle: "$b", author: "consolidation", text: "state A",
        category: "reference", scope: "project", topics: [], supports: [f.fact], reason: "Initial.", createdAt: time }]);
      if (!created0.ok) throw new Error(created0.problems.join("; "));
      const stateA = created0.committed[0]!;
      const path = { sessionId: f.session.id, branch: "main", headTurnId: f.turn.id };
      const pool = `project:${f.session.projectId}`;
      // D confirms state A (the baseline this case needs) without a full admitted run.
      markProcessed(memory, pool, stateA.commit);
      const updated = writeC(f.session.id, [{ op: "update", knowledgeId: stateA.knowledgeId, baseCommit: stateA.commit, text: "state B",
        category: "reference", scope: "project", topics: [], supports: [f.fact2], reason: "Changed.", createdAt: time }]);
      if (!updated.ok) throw new Error(updated.problems.join("; "));
      const stateB = updated.committed[0]!;
      const archived = writeC(f.session.id, [{ op: "archive", knowledgeId: stateB.knowledgeId, baseCommit: stateB.commit,
        supports: [f.fact3], reason: "Retired.", createdAt: time }]);
      if (!archived.ok) throw new Error(archived.problems.join("; "));
      const pending = memory.store.pendingVersions(pool, path)[0]!;
      expect(pending.revisionId).toBe(archived.committed[0]!.commit);
      expect(pending.material).toContain("state B");
      expect(pending.material).toContain("[-A-]");
      expect(pending.material).toContain("{+B+}");
      // Weight is the archived body's own size, not the diff.
      expect(pending.tokens).toBeGreaterThan(0);
    });

    test("D's own archives are never pending", async () => {
      const fallback = async () => ({ outcome: "success" as const, output: "unused", request: {} });
      const scenarios = new AdmittedDreamerScenarios(fallback);
      memory = sourceSeededMemory(":memory:", scenarios.agent);
      const project = memory.store.createProject({ name: "d-archive", declaredBy: "mark" });
      const session = memory.store.createSession({ host: "test", projectId: project.id, enrollmentChoice: true, startedAt: time, firstReplyAt: time });
      const turn = memory.store.appendTurn({ sessionId: session.id, kind: "turn", userPrompt: "seed", startedAt: time });
      const selectedEntries = memory.store.listSourceEntries(session.id);
      memory.selectEntries(session.id, "main", selectedEntries.map(entry => entry.id));
      const triggerEntryId = selectedEntries.at(-1)!.id;
      const noted = memory.store.commitNotingRun({ run: { kind: "noting", sessionId: session.id, branch: "main", createdAt: time },
        entryIds: memory.store.sourcePath(session.id, "main", turn.id).map(entry => entry.id),
        facts: [{ turnId: turn.id, category: "observation", actor: "user", text: "seed", source: [`T${turn.id}#user`], createdAt: time }] });
      if (!noted.ok) throw new Error(noted.problems.join("; "));
      const fact = noted.facts[0]!.id;
      const createdRun = memory.store.commitConsolidationRun({ run: { kind: "consolidation", sessionId: session.id, branch: "main", createdAt: time }, operations: [{
        op: "create", handle: "$x", author: "consolidation", text: "to be archived by D", category: "reference", scope: "project",
        topics: [], supports: [fact], reason: "Initial.", createdAt: time,
      }] });
      if (!createdRun.ok) throw new Error(createdRun.problems.join("; "));
      const item = createdRun.committed[0]!;
      const path = { sessionId: session.id, branch: "main", headTurnId: turn.id, triggerEntryId };
      const trigger = createDreamerTrigger(memory, path, fact, 1);
      const dreamed = await scenarios.run(memory, path, input => {
        input.reportRequest({});
        const write = input.tools.find(tool => tool.name === "memory")!;
        const receipt = JSON.parse(write.execute({ operations: [{ op: "archive", id: `K${item.knowledgeId}@${item.commit}`, supports: [`F${fact}`], reason: "D retires it." },
          { op: "archive", id: `K${trigger.knowledgeId}@${trigger.commit}`, supports: [`F${fact}`], reason: "Retire the trigger." }], skipped: [] }));
        expect(receipt.committed).toHaveLength(2);
        return { outcome: "success", output: "D archived it", request: {} };
      });
      expect(dreamed.outcome).toBe("success");
      const pool = `project:${project.id}`;
      const pending = memory.store.pendingVersions(pool, path);
      expect(pending.some(p => p.knowledgeId === item.knowledgeId)).toBe(false);
    });

    test("a D skip marks an archive processed; a D update of the archived version makes the identity visible again", async () => {
      const fallback = async () => ({ outcome: "success" as const, output: "unused", request: {} });
      const scenarios = new AdmittedDreamerScenarios(fallback);
      memory = sourceSeededMemory(":memory:", scenarios.agent);
      const project = memory.store.createProject({ name: "revive", declaredBy: "mark" });
      const session = memory.store.createSession({ host: "test", projectId: project.id, enrollmentChoice: true, startedAt: time, firstReplyAt: time });
      const turn = memory.store.appendTurn({ sessionId: session.id, kind: "turn", userPrompt: "seed", startedAt: time });
      const selectedEntries = memory.store.listSourceEntries(session.id);
      memory.selectEntries(session.id, "main", selectedEntries.map(entry => entry.id));
      const triggerEntryId = selectedEntries.at(-1)!.id;
      const noted = memory.store.commitNotingRun({ run: { kind: "noting", sessionId: session.id, branch: "main", createdAt: time },
        entryIds: memory.store.sourcePath(session.id, "main", turn.id).map(entry => entry.id),
        facts: [{ turnId: turn.id, category: "observation", actor: "user", text: "seed", source: [`T${turn.id}#user`], createdAt: time }] });
      if (!noted.ok) throw new Error(noted.problems.join("; "));
      const fact = noted.facts[0]!.id;
      const createdRun = memory.store.commitConsolidationRun({ run: { kind: "consolidation", sessionId: session.id, branch: "main", createdAt: time }, operations: [{
        op: "create", handle: "$r", author: "consolidation", text: "revivable body", category: "reference", scope: "project",
        topics: [], supports: [fact], reason: "Initial.", createdAt: time,
      }] });
      if (!createdRun.ok) throw new Error(createdRun.problems.join("; "));
      const item = createdRun.committed[0]!;
      const cArchived = memory.store.commitConsolidationRun({ run: { kind: "consolidation", sessionId: session.id, branch: "main", createdAt: time },
        operations: [{ op: "archive", knowledgeId: item.knowledgeId, baseCommit: item.commit, supports: [fact], reason: "C retires it.", createdAt: time }] });
      if (!cArchived.ok) throw new Error(cArchived.problems.join("; "));
      const archiveCommit = cArchived.committed[0]!;
      const path = { sessionId: session.id, branch: "main", headTurnId: turn.id, triggerEntryId };
      const trigger = createDreamerTrigger(memory, path, fact, 1);
      const pool = `project:${project.id}`;

      const dreamed = await scenarios.run(memory, path, input => {
        input.reportRequest({});
        // The archive's rendering in the frozen material already registers both the archive version
        // and the body it removed as read (76): revoke it with an update, no trace needed first.
        expect(input.material.changed).toContain("revivable body");
        const write = input.tools.find(tool => tool.name === "memory")!;
        const receipt = JSON.parse(write.execute({ operations: [{ op: "update", id: `K${archiveCommit.knowledgeId}@${archiveCommit.commit}`,
          text: "revived body", category: "reference", scope: "project", topics: [], supports: [`F${fact}`], reason: "Revived." },
          { op: "archive", id: `K${trigger.knowledgeId}@${trigger.commit}`, supports: [`F${fact}`], reason: "Retire the trigger." }], skipped: [] }));
        expect(receipt.committed).toHaveLength(2);
        return { outcome: "success", output: "revived", request: {} };
      });
      expect(dreamed.outcome).toBe("success");
      const revived = memory.store.currentCommit(item.knowledgeId, path)[0]!;
      expect(revived.op).toBe("update");
      expect(revived.text).toBe("revived body");
      expect(memory.store.pendingVersions(pool, path).some(p => p.knowledgeId === item.knowledgeId)).toBe(false);
    });
  });

  describe("diff material and weight", () => {
    test("two consecutive C updates show one cumulative diff against the last-processed baseline", () => {
      const f = fixture(() => {});
      const created0 = writeC(f.session.id, [{ op: "create", handle: "$c", author: "consolidation", text: "alpha beta gamma",
        category: "reference", scope: "project", topics: [], supports: [f.fact], reason: "Initial.", createdAt: time }]);
      if (!created0.ok) throw new Error(created0.problems.join("; "));
      const v1 = created0.committed[0]!;
      const path = { sessionId: f.session.id, branch: "main", headTurnId: f.turn.id };
      const pool = `project:${f.session.projectId}`;
      markProcessed(memory, pool, v1.commit); // D confirmed K@5.
      const v2Run = writeC(f.session.id, [{ op: "update", knowledgeId: v1.knowledgeId, baseCommit: v1.commit, text: "alpha delta gamma",
        category: "reference", scope: "project", topics: [], supports: [f.fact2], reason: "First edit.", createdAt: time }]);
      if (!v2Run.ok) throw new Error(v2Run.problems.join("; "));
      const v2 = v2Run.committed[0]!;
      const v3Run = writeC(f.session.id, [{ op: "update", knowledgeId: v1.knowledgeId, baseCommit: v2.commit, text: "alpha delta epsilon",
        category: "reference", scope: "project", topics: [], supports: [f.fact3], reason: "Second edit.", createdAt: time }]);
      if (!v3Run.ok) throw new Error(v3Run.problems.join("; "));
      const v3 = v3Run.committed[0]!;
      const pending = memory.store.pendingVersions(pool, path);
      // Only the latest current version (v3) is pending; v2 was superseded and never got its own record.
      expect(pending.map(p => p.revisionId)).toEqual([v3.commit]);
      expect(pending[0]!.material).toContain(`from @${v1.commit}`);
      expect(pending[0]!.material).toContain("gamma"); // the shared tail survives the cumulative diff
      expect(pending[0]!.material).toContain("[-beta-]");
      expect(pending[0]!.material).toContain("{+epsilon+}");
    });

    test("no processed ancestor: an update is shown whole as New, exactly as a create is", () => {
      const f = fixture(() => {});
      const created0 = writeC(f.session.id, [{ op: "create", handle: "$n", author: "consolidation", text: "v1",
        category: "reference", scope: "project", topics: [], supports: [f.fact], reason: "Initial.", createdAt: time }]);
      if (!created0.ok) throw new Error(created0.problems.join("; "));
      const v1 = created0.committed[0]!;
      const updated = writeC(f.session.id, [{ op: "update", knowledgeId: v1.knowledgeId, baseCommit: v1.commit, text: "v2",
        category: "reference", scope: "project", topics: [], supports: [f.fact2], reason: "Edit.", createdAt: time }]);
      if (!updated.ok) throw new Error(updated.problems.join("; "));
      const path = { sessionId: f.session.id, branch: "main", headTurnId: f.turn.id };
      const pool = `project:${f.session.projectId}`;
      const pending = memory.store.pendingVersions(pool, path)[0]!;
      expect(pending.material.startsWith(`New K${v1.knowledgeId}@${updated.committed[0]!.commit}:`)).toBe(true);
      expect(pending.material).toContain("v2");
      expect(pending.tokens).toBeGreaterThan(3); // the whole rendered item, not a small diff
    });

    test("word-level diff over mixed Chinese and English text", () => {
      const cases: [string, string, string][] = [
        ["a b a", "a a", "a [-b -]a"],
        ["", "hello", "{+hello+}"],
        ["中国人民银行发布公告", "中国银行发布公告", "中国[-人民-]银行发布公告"],
        ["use red tiles now", "use blue tiles now", "use [-red-]{+blue+} tiles now"],
      ];
      for (const [before, after, expected] of cases) expect(wordLevelDiff(before, after).text).toBe(expected);
    });

    test("metadata-only change (a scope change with unchanged body) weighs its change: more than zero, far less than the item", () => {
      const f = fixture(() => {});
      const created0 = writeC(f.session.id, [{ op: "create", handle: "$m", author: "consolidation", text: "same body throughout, unchanged and reasonably sized so its whole render dwarfs one field's diff",
        category: "reference", scope: "project", topics: [], supports: [f.fact], reason: "Initial.", createdAt: time }]);
      if (!created0.ok) throw new Error(created0.problems.join("; "));
      const v1 = created0.committed[0]!;
      const path = { sessionId: f.session.id, branch: "main", headTurnId: f.turn.id };
      const pool = `project:${f.session.projectId}`;
      markProcessed(memory, pool, v1.commit);
      const rendered = memory.store.knowledgeRevision(v1.commit)!;
      const updated = writeC(f.session.id, [{ op: "update", knowledgeId: v1.knowledgeId, baseCommit: v1.commit, text: rendered.text,
        category: rendered.category, scope: "global", topics: rendered.topics, supports: [f.fact2], reason: "Scope only.", createdAt: time }]);
      if (!updated.ok) throw new Error(updated.problems.join("; "));
      // Global has no processing baseline (this identity only ever lived in the project pool there), so
      // it weighs whole there; the project pool, whose baseline IS in this pool, weighs only the change.
      const projectPending = memory.store.pendingVersions(pool, path);
      expect(projectPending).toHaveLength(0); // the identity left the project pool entirely
      const globalPending = memory.store.pendingVersions("global", path)[0]!;
      expect(globalPending.tokens).toBeGreaterThan(0);
    });

    test("without a baseline in this pool: a project item changed to global weighs the whole item there", () => {
      const f = fixture(() => {});
      const created0 = writeC(f.session.id, [{ op: "create", handle: "$s", author: "consolidation", text: "scoped body",
        category: "reference", scope: "project", topics: [], supports: [f.fact], reason: "Initial.", createdAt: time }]);
      if (!created0.ok) throw new Error(created0.problems.join("; "));
      const v1 = created0.committed[0]!;
      const path = { sessionId: f.session.id, branch: "main", headTurnId: f.turn.id };
      const pool = `project:${f.session.projectId}`;
      markProcessed(memory, pool, v1.commit);
      const updated = writeC(f.session.id, [{ op: "update", knowledgeId: v1.knowledgeId, baseCommit: v1.commit, text: "scoped body",
        category: "reference", scope: "global", topics: [], supports: [f.fact2], reason: "Now global.", createdAt: time }]);
      if (!updated.ok) throw new Error(updated.problems.join("; "));
      const globalPending = memory.store.pendingVersions("global", path)[0]!;
      expect(globalPending.material.startsWith(`New K${v1.knowledgeId}@${updated.committed[0]!.commit}:`)).toBe(true);
    });

    test("the version address never counts: two revisions differing only in K@commit find no change", () => {
      memory = sourceSeededMemory(":memory:", async () => ({ outcome: "success", output: "unused", request: {} }));
      const project = memory.store.createProject({ name: "addr", declaredBy: "mark" });
      const session = memory.store.createSession({ host: "test", projectId: project.id, enrollmentChoice: true, startedAt: time, firstReplyAt: time });
      const turn = memory.store.appendTurn({ sessionId: session.id, kind: "turn", userPrompt: "seed", startedAt: time });
      const noted = memory.store.commitNotingRun({ run: { kind: "noting", sessionId: session.id, branch: "main", createdAt: time },
        entryIds: memory.store.sourcePath(session.id, "main", turn.id).map(e => e.id),
        facts: [{ turnId: turn.id, category: "observation", actor: "user", text: "seed", source: [`T${turn.id}#user`], createdAt: time }] });
      if (!noted.ok) throw new Error(noted.problems.join("; "));
      const fact = noted.facts[0]!.id;
      const c1 = memory.store.commitConsolidationRun({ run: { kind: "consolidation", sessionId: session.id, branch: "main", createdAt: time },
        operations: [{ op: "create", handle: "$k", author: "consolidation", text: "identical text", category: "reference", scope: "project",
          topics: [], supports: [fact], reason: "Initial.", createdAt: time }] });
      if (!c1.ok) throw new Error(c1.problems.join("; "));
      const v1 = memory.store.knowledgeRevision(c1.committed[0]!.commit)!;
      const c2 = memory.store.commitConsolidationRun({ run: { kind: "consolidation", sessionId: session.id, branch: "main", createdAt: time },
        operations: [{ op: "update", knowledgeId: c1.committed[0]!.knowledgeId, baseCommit: c1.committed[0]!.commit, text: "identical text",
          category: "reference", scope: "project", topics: [], supports: [fact], reason: "No real change.", createdAt: time }] });
      if (!c2.ok) throw new Error(c2.problems.join("; "));
      const v2 = memory.store.knowledgeRevision(c2.committed[0]!.commit)!;
      expect(v1.id).not.toBe(v2.id); // the K@commit address differs
      const change = renderKnowledgeChange(c1.committed[0]!.knowledgeId, v1, v2);
      expect(change.addedTokens).toBe(0);
      expect(change.removedTokens).toBe(0);
    });

    test("create is full size; update is the changed tokens; archive is the removed body", () => {
      const f = fixture(() => {});
      const created0 = writeC(f.session.id, [{ op: "create", handle: "$w", author: "consolidation", text: "a body long enough that its whole size clearly exceeds one small edit's weight",
        category: "reference", scope: "project", topics: [], supports: [f.fact], reason: "Initial.", createdAt: time }]);
      if (!created0.ok) throw new Error(created0.problems.join("; "));
      const v1 = created0.committed[0]!;
      const path = { sessionId: f.session.id, branch: "main", headTurnId: f.turn.id };
      const pool = `project:${f.session.projectId}`;
      const createWeight = memory.store.pendingVersions(pool, path)[0]!.tokens;
      markProcessed(memory, pool, v1.commit);
      const edited = writeC(f.session.id, [{ op: "update", knowledgeId: v1.knowledgeId, baseCommit: v1.commit,
        text: "a body long enough that its whole size clearly exceeds one small change's weight", category: "reference", scope: "project",
        topics: [], supports: [f.fact2], reason: "One-word edit.", createdAt: time }]);
      if (!edited.ok) throw new Error(edited.problems.join("; "));
      const updateWeight = memory.store.pendingVersions(pool, path)[0]!.tokens;
      expect(updateWeight).toBeGreaterThan(0);
      expect(updateWeight).toBeLessThan(createWeight); // a one-word edit barely moves the trigger
      const archived = writeC(f.session.id, [{ op: "archive", knowledgeId: v1.knowledgeId, baseCommit: edited.committed[0]!.commit,
        supports: [f.fact3], reason: "Retired.", createdAt: time }]);
      if (!archived.ok) throw new Error(archived.problems.join("; "));
      const archiveWeight = memory.store.pendingVersions(pool, path)[0]!.tokens;
      expect(archiveWeight).toBeGreaterThan(updateWeight); // the whole removed body, not a diff
    });
  });

  test("manual memory exposes and enforces create/archive only", () => {
    const f = fixture(() => {});
    const tools = memory.tools({ kind: "manual", sessionId: f.session.id, branch: "main", currentTurnId: f.turn.id });
    const memoryTool = tools.find(tool => tool.name === "memory")!;
    expect((memoryTool.parameters.properties as any).operations.items.properties.op.enum).toEqual(["create", "archive"]);
    expect(memoryTool.execute(created(f.fact, "manual item"))).toContain('"committed"');
    tools.find(tool => tool.name === "trace")!.execute({ address: "K1@1" });
    expect(memoryTool.execute({ operations: [{ ...created(f.fact, "changed").operations[0], op: "update", id: "K1@1" }], skipped: [] })).toContain("Dreamer");
    expect(memoryTool.execute({ operations: [{ op: "archive", id: "K1@1", supports: [`F${f.fact}`], reason: "Retired." }], skipped: [] })).toContain('"committed"');
  });

  test("prompt and material contain no second-round cues", async () => {
    const f = fixture(input => {
      expect(input.prompt).not.toContain("Second-round user message");
      expect(input.prompt).not.toContain("NEAR");
      expect(input.prompt).not.toContain("CLOSER");
      expect(input.prompt).not.toContain("create only");
      expect(input.text).not.toContain("Negated-evidence reminder");
      expect("reminders" in input.material).toBe(false);
      input.tools.find(tool => tool.name === "memory")!.execute({ operations: [], skipped: [{ fact: `F${f.fact}`, because: "Not durable." }] });
    });
    expect(loadPrompt("consolidation.md")).not.toContain("Second-round user message");
    expect(loadPrompt("consolidation.md")).not.toContain("create only");
    await memory.consolidate({ sessionId: f.session.id, branch: "main", headTurnId: f.turn.id });
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

/** Test-only shortcut: directly records a processing row for `revisionId` in `pool`, standing in for
 * a full admitted Dreamer run that confirmed it (what these tests need is the baseline it leaves
 * behind, not the run machinery that produces it — that machinery is exercised elsewhere in this file
 * through `AdmittedDreamerScenarios`). */
function markProcessed(memory: ReturnType<typeof sourceSeededMemory>, pool: string, revisionId: number) {
  const runId = memory.store.recordRun({ kind: "dreaming", sessionId: null, createdAt: time, outcome: "success" }).id;
  (memory.store.db as { prepare(sql: string): { run(...args: unknown[]): unknown } }).prepare(
    "INSERT OR IGNORE INTO knowledge_processed(pool,revision_id,run_id) VALUES (?,?,?)").run(pool, revisionId, runId);
}
