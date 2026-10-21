import { commitNoterKnowledge } from "../../noting-knowledge-fixture.ts";
import { expect, test } from "vitest";
import { hydrate, sourceSeededMemory, type DreamingAgentInput } from "../../source-fixture.ts";
import { fact as seedFact, knowledge as seedKnowledge, legacyFacts } from "../../support/seed.ts";
import { dreamerWrite } from "../../dreaming-skips.ts";

test("135/134/92: D skips complete diffs by history address; mutation diagnostics separate model versions from human commits", async () => {
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
    const user = hydrate(store.listSourceEntries(session.id, turn.id), store).find(entry => entry.role === "user")!;
    const fact = seedFact(memory, target, "Evidence", [{ entry: user, text: "User gave evidence" }]).id;
    const legacy = legacyFacts(store, { kind: "manual", sessionId: session.id, createdAt: "now" }, [{
      sources: [{ entry: user, address: `T${turn.id}#user` }], category: "observation", actor: "agent", text: "Legacy mixed episode", createdAt: "now",
    }]);
    const content = { category: "constraint" as const, scope: "project" as const, topics: [], supports: [fact, legacy.facts[0]!.id], reason: "fixture", createdAt: "now" };
    const created = store.commitConsolidationRun({ path: target, run: { kind: "manual", sessionId: session.id, createdAt: "now" }, operations: [1, 2, 3].map(n => ({ op: "create", title: "Fixture title", handle: `$${n}`, author: "test", ...content, text: `Rule ${n}` })) });
    if (!created.ok) throw new Error(created.problems.join("; "));
    const [a, b, c] = created.committed;
    const address = (id: number, commit: number) => `K${id}#${store.versionTag(id, commit)}`;
    scenario = task => {
      expect(task.material.facts).toContain("Legacy mixed episode");
      expect(task.material.facts).toContain("[observation/agent]");
      expect(task.material.facts).toContain("session harness: Pi agent (context, not claim attribution)");
      const receipt = dreamerWrite(task.tools.find(t => t.name === "memory")!, { operations: [], skipped: created.committed.map(item => ({ knowledge: `K${item.knowledgeId}@v1`, because: "Reviewed unchanged" })) });
      expect(receipt).not.toContain("rejected:");
    };
    expect((await memory.dream(target)).outcome).toBe("success");
    const changed = commitNoterKnowledge(store, { path: target, run: { sessionId: session.id, createdAt: "now" }, operations: [
      { op: "update", knowledgeId: a!.knowledgeId, baseCommit: a!.commit, ...content, text: "Rule 1 changed" },
      { op: "archive", kind: "budget", knowledgeId: c!.knowledgeId, baseCommit: c!.commit, supports: [fact], reason: "obsolete", createdAt: "now" },
    ] });
    if (!changed.ok) throw new Error(changed.problems.join("; "));
    let outsideCommit = "";
    const otherProject = store.createProject({ name: "dream-tags-other", declaredBy: "mark" });
    const otherSession = store.createSession({ projectId: otherProject.id, host: "pi:other", startedAt: "now", firstReplyAt: "now", enrollmentChoice: true });
    const otherTurn = store.appendTurn({ sessionId: otherSession.id, kind: "turn", userPrompt: "Other evidence", startedAt: "now" });
    const otherTarget = { sessionId: otherSession.id, branch: "main", headTurnId: otherTurn.id };
    const otherUser = hydrate(store.listSourceEntries(otherSession.id, otherTurn.id), store).find(entry => entry.role === "user")!;
    const otherFact = seedFact(memory, otherTarget, "Other evidence", [{ entry: otherUser, text: "User gave other evidence" }]).id;
    const out = seedKnowledge(store, otherTarget, content.scope, content.category, [otherFact], "Other pool",
      { run: { kind: "manual", createdAt: "now" } });
    scenario = task => {
      expect(task.material.changed).toContain(`Changed K${a!.knowledgeId}@v2`);
      expect(task.material.changed).toContain(`Archived K${c!.knowledgeId}@v2`);
      expect(task.material.changed).not.toContain(address(c!.knowledgeId, changed.committed[1]!.commit));
      expect(task.text).not.toMatch(/K\d+@\d+/);
      const write = task.tools.find(t => t.name === "memory")!;
      const skip = (knowledge: string) => dreamerWrite(write, { operations: [], skipped: [{ knowledge, because: "Deliberated unchanged" }] });
      expect(skip(`K${b!.knowledgeId}@v1`)).toContain("exact frozen version");
      expect(skip(`K${a!.knowledgeId}@v999`)).toContain("rejected:");
      expect(dreamerWrite(write, { operations: [{ op: "archive", kind: "budget", id: `K${a!.knowledgeId}@v2`, supports: [], reason: "not a write tag" }], skipped: [] })).toContain("exact K#tag");
      const stale = dreamerWrite(write, { operations: [{ op: "archive", kind: "budget", id: address(a!.knowledgeId, a!.commit), supports: [], reason: "stale" }], skipped: [] });
      expect(stale).toContain(`K${a!.knowledgeId}@v2`);
      expect(stale).not.toMatch(/K\d+@\d+/);
      expect(stale).not.toContain(address(a!.knowledgeId, changed.committed[0]!.commit));
      // 126: the session's three pools are writable; another project's item is not.
      const poolError = dreamerWrite(write, { operations: [{ op: "archive", kind: "budget", id: address(out.knowledgeId, out.commit), supports: [], reason: "wrong pool" }], skipped: [] });
      expect(poolError).toContain("outside the Dreamer pools");
      expect(poolError).not.toMatch(/K\d+@\d+/);
      expect(skip(`K${a!.knowledgeId}@v2`)).not.toContain("rejected:");
      expect(skip(`K${c!.knowledgeId}@v2`)).not.toContain("rejected:");
      expect(skip(`K${a!.knowledgeId}@v2`)).toContain("already consumed");
      // 127: each refused call keeps its M number and blocks until withdrawn; no empty batch clears it.
      for (let n = 1; n <= 6; n++) expect(write.execute({ drop: `M${n}` })).toContain(`dropped: M${n}`);
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
