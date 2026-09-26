import { expect, test } from "vitest";
import { sourceSeededMemory, type DreamingAgentInput } from "../../source-fixture.ts";

test("92/03: D skips tagless diffs by history address; mutation diagnostics separate model versions from human commits", async () => {
  let scenario!: (task: DreamingAgentInput) => void;
  const memory = sourceSeededMemory(":memory:", async raw => {
    const task = raw as DreamingAgentInput;
    task.reportRequest({ fixture: "92 version protocol" }); scenario(task);
    return { outcome: "success", output: "done", request: { fixture: "92 version protocol" } };
  }, { dreaming: { triggerTokens: 1 } });
  const store = memory.store;
  try {
    const project = store.createProject({ name: "dream-tags", declaredBy: "mark" });
    const session = store.createSession({ projectId: project.id, host: "pi:dream", startedAt: "now", firstReplyAt: "now", enrollmentChoice: true });
    const turn = store.appendTurn({ sessionId: session.id, kind: "turn", userPrompt: "Evidence", startedAt: "now" });
    const target = { sessionId: session.id, branch: "main", headTurnId: turn.id };
    const tools = memory.tools({ kind: "manual", ...target, currentTurnId: turn.id });
    const fact = JSON.parse(tools.find(t => t.name === "note")!.execute({ facts: [{ text: "User gave evidence", source: [`T${turn.id}#E1`] }] })).factIds[0];
    const legacy = store.commitNotingRun({ run: { kind: "manual", sessionId: session.id, createdAt: "now" }, facts: [{
      turnId: turn.id, category: "observation", actor: "agent", text: "Legacy mixed episode", source: [`T${turn.id}#user`], createdAt: "now",
    }] });
    if (!legacy.ok) throw new Error(legacy.problems.join("; "));
    const content = { category: "constraint" as const, scope: "project" as const, topics: [], supports: [fact, legacy.facts[0]!.id], reason: "fixture", createdAt: "now" };
    const created = store.commitConsolidationRun({ path: target, run: { kind: "manual", sessionId: session.id, createdAt: "now" }, operations: [1, 2, 3].map(n => ({ op: "create", handle: `$${n}`, author: "test", ...content, text: `Rule ${n}` })) });
    if (!created.ok) throw new Error(created.problems.join("; "));
    const [a, b, c] = created.committed;
    const address = (id: number, commit: number) => `K${id}#${store.versionTag(id, commit)}`;
    scenario = task => {
      expect(task.material.facts).toContain("Legacy mixed episode");
      expect(task.material.facts).toContain("[observation/agent]");
      expect(task.material.facts).toContain("session harness: Pi agent (context, not claim attribution)");
      const receipt = task.tools.find(t => t.name === "memory")!.execute({ operations: [], skipped: created.committed.map(item => ({ knowledge: `K${item.knowledgeId}@v1`, because: "Reviewed unchanged" })) });
      expect(receipt).not.toContain("rejected:");
    };
    expect((await memory.dream(target)).outcome).toBe("success");
    const changed = store.commitConsolidationRun({ path: target, run: { kind: "consolidation", sessionId: session.id, createdAt: "now" }, operations: [
      { op: "update", knowledgeId: a!.knowledgeId, baseCommit: a!.commit, ...content, text: "Rule 1 changed" },
      { op: "archive", knowledgeId: c!.knowledgeId, baseCommit: c!.commit, supports: [fact], reason: "obsolete", createdAt: "now" },
    ] });
    if (!changed.ok) throw new Error(changed.problems.join("; "));
    let outsideCommit = "";
    scenario = task => {
      expect(task.material.changed).toContain(`Changed K${a!.knowledgeId}@v2`);
      expect(task.material.changed).toContain(`Archived K${c!.knowledgeId}@v2`);
      for (const item of changed.committed) expect(task.material.changed).not.toContain(address(item.knowledgeId, item.commit));
      expect(task.text).not.toMatch(/K\d+@\d+/);
      const write = task.tools.find(t => t.name === "memory")!;
      const skip = (knowledge: string) => write.execute({ operations: [], skipped: [{ knowledge, because: "Deliberated unchanged" }] });
      expect(skip(`K${b!.knowledgeId}@v1`)).toContain("exact frozen version");
      expect(skip(`K${a!.knowledgeId}@v999`)).toContain("rejected:");
      expect(write.execute({ operations: [{ op: "archive", id: `K${a!.knowledgeId}@v2`, supports: [], reason: "not a write tag" }], skipped: [] })).toContain("exact K#tag");
      const stale = write.execute({ operations: [{ op: "archive", id: address(a!.knowledgeId, a!.commit), supports: [], reason: "stale" }], skipped: [] });
      expect(stale).toContain(`K${a!.knowledgeId}@v2`);
      expect(stale).not.toMatch(/K\d+@\d+/);
      expect(stale).not.toContain(address(a!.knowledgeId, changed.committed[0]!.commit));
      const reversedMerge = write.execute({ operations: [{ op: "merge", id: address(b!.knowledgeId, b!.commit), absorb: [address(a!.knowledgeId, changed.committed[0]!.commit)], supports: [], reason: "reverse order", category: "constraint", scope: "project", topics: [] }], skipped: [] });
      expect(reversedMerge).toContain("swap them");
      expect(reversedMerge).not.toMatch(/K\d+@\d+/);
      const external = store.commitConsolidationRun({ path: target, run: { kind: "manual", sessionId: session.id, createdAt: "now" }, operations: [{ op: "create", handle: "$outside", author: "test", ...content, scope: "global", text: "Other pool" }] });
      if (!external.ok) throw new Error(external.problems.join("; "));
      const out = external.committed[0]!;
      const poolError = write.execute({ operations: [{ op: "archive", id: address(out.knowledgeId, out.commit), supports: [], reason: "wrong pool" }], skipped: [] });
      expect(poolError).toContain("outside Dreamer pool");
      expect(poolError).not.toMatch(/K\d+@\d+/);
      expect(skip(`K${a!.knowledgeId}@v2`)).not.toContain("rejected:");
      expect(skip(`K${c!.knowledgeId}@v2`)).not.toContain("rejected:");
      expect(skip(`K${a!.knowledgeId}@v2`)).toContain("already consumed");
      expect(write.execute({ operations: [], skipped: [] })).not.toContain("rejected:");
      expect(task.tools.find(t => t.name === "check")!.execute({})).not.toMatch(/K\d+@\d+/);
      outsideCommit = `K${out.knowledgeId}@${out.commit}`;
    };
    const final = await memory.dream(target);
    expect(final.outcome, JSON.stringify(final)).toBe("success");
    // Actual store failures retain exact commits in the existing tool-call audit.
    if ("runId" in final) expect(store.getRun(final.runId)!.response).toContain(outsideCommit);
    const processed = store.db.prepare("SELECT revision_id FROM knowledge_processed WHERE pool=? ORDER BY revision_id").all(`project:${project.id}`).map(row => Number(row.revision_id));
    for (const item of changed.committed) expect(processed).toContain(item.commit);
  } finally { memory.close(); }
});
