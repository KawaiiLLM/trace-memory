import { afterEach, describe, expect, test } from "vitest";
import { loadPrompt } from "../../../src/core/prompts/load.ts";
import { canonicalFlatConfig, REMOVED_SETTINGS, sourceSeededMemory, validateConfig, type ConsolidationAgentInput } from "../../source-fixture.ts";
import { AdmittedDreamerScenarios, createDreamerTrigger } from "../../admitted-dreamer-scenario.ts";

const time = "2026-09-20T00:00:00Z";
const created = (fact: number, text: string, reason = "New durable conclusion.") => ({
  operations: [{ op: "create", text, category: "reference", scope: "project", topics: ["release"], supports: [`F${fact}`], reason }],
  skipped: [],
});

describe("64a Consolidator creates only", () => {
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
      facts: [{ turnId: turn.id, category: "observation", actor: "user", text: "beta.5 is current", source: [`T${turn.id}#user`], createdAt: time }] });
    if (!facts.ok) throw new Error(facts.problems.join("; "));
    return { session, turn, fact: facts.facts[0]!.id };
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

  test("Consolidator schema and commit authority reject every non-create operation with Dreamer guidance", async () => {
    const f = fixture(input => {
      const definition = input.tools.find(tool => tool.name === "memory")!;
      const schema = (definition.parameters.properties as any).operations.items;
      expect(schema.properties.op.enum).toEqual(["create"]);
      expect(schema.properties).not.toHaveProperty("id");
      expect(schema.properties).not.toHaveProperty("absorb");
      for (const operation of [
        { op: "update", id: "K1@1" },
        { op: "merge", id: "K1@1", absorb: ["K2@2"] },
        { op: "archive", id: "K1@1" },
        { op: "create", absorb: ["K1@1"] },
      ]) {
        const receipt = definition.execute({ operations: [{ ...created(f.fact, "new").operations[0], ...operation }], skipped: [] });
        expect(receipt).toContain("Dreamer");
      }
    });
    const result = await memory.consolidate({ sessionId: f.session.id, branch: "main", headTurnId: f.turn.id });
    expect(result.outcome).toBe("bounced");
    const lowLevel = memory.store.commitConsolidationRun({ run: { kind: "consolidation", sessionId: f.session.id, createdAt: time },
      operations: [{ op: "archive", knowledgeId: 1, baseCommit: 1, supports: [f.fact], reason: "not authorized", createdAt: time }] });
    expect(lowLevel.ok).toBe(false);
    if (!lowLevel.ok) expect(lowLevel.problems.join(" ")).toContain("Dreamer");
  });

  test("a state change is created beside the old item and may name it in reason", async () => {
    let oldId = 0;
    const f = fixture(input => {
      const receipt = input.tools.find(tool => tool.name === "memory")!.execute(created(f.fact, "beta.5 is current", `Supersedes K${oldId}.`));
      expect(receipt).toContain('"committed"');
    });
    const old = memory.store.commitConsolidationRun({ run: { kind: "manual", sessionId: f.session.id, createdAt: time }, operations: [{
      op: "create", handle: "$old", author: "test", text: "beta.4 is current", category: "reference", scope: "project", topics: ["release"], supports: [f.fact], reason: "Initial state.", createdAt: time,
    }] });
    if (!old.ok) throw new Error(old.problems.join("; "));
    oldId = old.committed[0]!.knowledgeId;
    const result = await memory.consolidate({ sessionId: f.session.id, branch: "main", headTurnId: f.turn.id });
    expect(result.outcome).toBe("success");
    expect(memory.store.currentKnowledge()).toHaveLength(2);
    expect(memory.store.getKnowledgeRevision(oldId + 1, oldId + 1)?.reason).toBe(`Supersedes K${oldId}.`);
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

  test("manual archive is rejected while another session holds the live Dreamer seat", () => {
    const f = fixture(() => {});
    const tools = memory.tools({ kind: "manual", sessionId: f.session.id, branch: "main", currentTurnId: f.turn.id });
    const memoryTool = tools.find(tool => tool.name === "memory")!;
    expect(memoryTool.execute(created(f.fact, "manual item"))).toContain('"committed"');
    tools.find(tool => tool.name === "trace")!.execute({ address: "K1@1" });

    const other = memory.store.createSession({ host: "test", projectId: memory.store.getSession(f.session.id)!.projectId,
      enrollmentChoice: true, startedAt: time, firstReplyAt: time });
    const otherTurn = memory.store.appendTurn({ sessionId: other.id, kind: "turn", userPrompt: "other evidence", startedAt: time });
    const otherFacts = memory.store.commitNotingRun({ run: { kind: "noting", sessionId: other.id, branch: "main", createdAt: time },
      entryIds: memory.store.sourcePath(other.id, "main", otherTurn.id).map(entry => entry.id), facts: [{ turnId: otherTurn.id,
        category: "observation", actor: "user", text: "other evidence", source: [`T${otherTurn.id}#user`], createdAt: time }] });
    if (!otherFacts.ok) throw new Error(otherFacts.problems.join("; "));
    const otherKnowledge = memory.store.commitConsolidationRun({ run: { kind: "consolidation", sessionId: other.id, branch: "main", createdAt: time }, operations: [{
      op: "create", handle: "$other", author: "test", text: "other knowledge", category: "reference", scope: "project", topics: [],
      supports: [otherFacts.facts[0]!.id], reason: "Initial state.", createdAt: time,
    }] });
    if (!otherKnowledge.ok) throw new Error(otherKnowledge.problems.join("; "));
    const selected = memory.store.knowledgePath(other.id, "main");
    const path = { sessionId: other.id, branch: "main", headTurnId: selected.headTurnId! };
    const claim = memory.store.acquireClaim(path, "dreaming", "other-executor");
    expect(claim).not.toBeNull();

    const blocked = memoryTool.execute({ operations: [{ op: "archive", id: "K1@1", supports: [`F${f.fact}`], reason: "Retired." }], skipped: [] });
    expect(blocked).toContain("Dreamer seat is held");
    expect(memory.store.currentCommit(1)[0]?.op).toBe("create");
    memory.store.releaseClaim(claim!);
    expect(memoryTool.execute({ operations: [{ op: "archive", id: "K1@1", supports: [`F${f.fact}`], reason: "Retired." }], skipped: [] })).toContain('"committed"');
  });

  test("Consolidator create remains legal during a live Dreamer and does not alter its frozen versions", () => {
    const f = fixture(() => {});
    const initial = memory.store.commitConsolidationRun({
      run: { kind: "consolidation", sessionId: f.session.id, branch: "main", createdAt: time },
      operations: [{ op: "create", handle: "$initial", author: "consolidation", text: "initial", category: "reference",
        scope: "project", topics: [], supports: [f.fact], reason: "initial", createdAt: time }],
    });
    if (!initial.ok) throw new Error(initial.problems.join("; "));
    const path = { sessionId: f.session.id, branch: "main", headTurnId: f.turn.id };
    const pool = `project:${f.session.projectId}`;
    const size = memory.store.pendingVersions(pool, path)[0]!.tokens;
    memory.setKnowledgeBudget("project", size * 2);
    const claim = memory.store.acquireClaim(path, "dreaming", "live-dreamer");
    expect(claim).not.toBeNull();
    const range = memory.store.retainKnowledgePoolRange(path, pool, claim!);
    const concurrent = memory.store.commitConsolidationRun({ path,
      run: { kind: "consolidation", sessionId: f.session.id, branch: "main", createdAt: time },
      operations: [{ op: "create", handle: "$concurrent", author: "consolidation", text: "concurrent", category: "reference",
        scope: "project", topics: [], supports: [f.fact], reason: "concurrent", createdAt: time }],
    });
    expect(concurrent.ok).toBe(true);
    if (!concurrent.ok) return;
    expect(memory.store.dreamingRange(range.id)!.eventIds).toEqual([initial.committed[0]!.commit]);
    expect(memory.store.pendingVersions(pool, path).map(value => value.revisionId)).toContain(concurrent.committed[0]!.commit);
    memory.store.releaseClaim(claim!);
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

  test("real facade Dreamer keeps rejection, exact read and correction in one admitted run", async () => {
    const fallback = async () => ({ outcome: "success" as const, output: "unused", request: { unused: true } });
    const scenarios = new AdmittedDreamerScenarios(fallback);
    memory = sourceSeededMemory(":memory:", scenarios.agent);
    const project = memory.store.createProject({ name: "scenario", declaredBy: "mark" });
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
    const created = memory.store.commitConsolidationRun({ run: { kind: "consolidation", sessionId: session.id, branch: "main", createdAt: time }, operations: [{
      op: "create", handle: "$base", author: "consolidation", text: "base rule", category: "constraint", scope: "project",
      supports: [fact], topics: [], reason: "Initial rule.", createdAt: time,
    }] });
    if (!created.ok) throw new Error(created.problems.join("; "));
    const base = created.committed[0]!;
    const path = { sessionId: session.id, branch: "main", headTurnId: turn.id, triggerEntryId };
    const trigger = createDreamerTrigger(memory, path, fact, 1);

    const result = await scenarios.run(memory, path, input => {
      const request = { fixture: "one admitted run" };
      input.reportRequest(request);
      const trace = input.tools.find(tool => tool.name === "trace")!;
      const memoryTool = input.tools.find(tool => tool.name === "memory")!;
      const update = { op: "update", id: `K${base.knowledgeId}@${base.commit}`, text: "corrected rule", category: "constraint",
        scope: "project", supports: [`F${fact}`], topics: [], reason: "Correct the rule." };
      expect(memoryTool.execute({ operations: [{ ...update, supports: ["F999999"] }], skipped: [] })).toContain("F999999: not an available fact");
      expect(trace.execute({ address: update.id, itemBudget: null })).toContain("base rule");
      expect(trace.execute({ address: `K${trigger.knowledgeId}@${trigger.commit}`, itemBudget: null })).toContain("Fixture trigger 1");
      const corrected = memoryTool.execute({ operations: [update, { op: "archive", id: `K${trigger.knowledgeId}@${trigger.commit}`,
        supports: [`F${fact}`], reason: "Retire the explicit fixture trigger." }], skipped: [] });
      expect(corrected).toContain('"committed"');
      return { outcome: "success", output: "scenario complete", request };
    });

    if (result.outcome !== "success") throw new Error(JSON.stringify(result));
    expect(memory.store.currentCommit(base.knowledgeId, path)[0]?.text).toBe("corrected rule");
    expect(memory.store.currentCommit(trigger.knowledgeId, path)[0]?.op).toBe("archive");
    expect(memory.store.listRuns(session.id).filter(run => run.kind === "dreaming")).toHaveLength(1);
  });

  test("prompt and material contain no second-round cues", async () => {
    const f = fixture(input => {
      expect(input.prompt).not.toContain("Second-round user message");
      expect(input.prompt).not.toContain("NEAR");
      expect(input.prompt).not.toContain("CLOSER");
      expect(input.text).not.toContain("Negated-evidence reminder");
      expect("reminders" in input.material).toBe(false);
      input.tools.find(tool => tool.name === "memory")!.execute({ operations: [], skipped: [{ fact: `F${f.fact}`, because: "Not durable." }] });
    });
    expect(loadPrompt("consolidation.md")).not.toContain("Second-round user message");
    await memory.consolidate({ sessionId: f.session.id, branch: "main", headTurnId: f.turn.id });
  });
});
