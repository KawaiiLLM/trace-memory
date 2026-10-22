import { afterEach, expect, test } from "vitest";
import { hydrate, type TraceMemory } from "../../source-fixture.ts";
import { fact as seedFact, knowledge as seedKnowledge } from "../../support/seed.ts";
import { dreamerFixture } from "../../support/dreamer.ts";
import { block } from "../../support/workspace.ts";

const memories: TraceMemory[] = [];
afterEach(() => { for (const memory of memories.splice(0)) memory.close(); });

test("92: refusals name version addresses, never internal commit ids; a base outside the session's pools is refused and the audit keeps the refused item's exact commit and the applied commit id", async () => {
  const f = dreamerFixture(memories);
  const a = f.item("Rule 1"), b = f.item("Rule 2");
  // Another project's item: the session's three pools are writable, another project's is not (126).
  const otherProject = f.store.createProject({ name: "dream-tags-other", declaredBy: "mark" });
  const otherSession = f.store.createSession({ projectId: otherProject.id, host: "pi:other", startedAt: "now", firstReplyAt: "now", enrollmentChoice: true });
  const otherTurn = f.store.appendTurn({ sessionId: otherSession.id, kind: "turn", userPrompt: "Other evidence", startedAt: "now" });
  const otherTarget = { sessionId: otherSession.id, branch: "main", headTurnId: otherTurn.id };
  const otherUser = hydrate(f.store.listSourceEntries(otherSession.id, otherTurn.id), f.store).find(entry => entry.role === "user")!;
  const otherFact = seedFact(f.memory, otherTarget, "Other evidence", [{ entry: otherUser, text: "User gave other evidence" }]).id;
  const out = seedKnowledge(f.store, otherTarget, "project", "constraint", [otherFact], "Other pool");
  f.dreamer.script.curate!.constraint = [
    block(`update K${out.knowledgeId}@v1`, { reason: "wrong pool" }, "Other pool, edited"),
    block(`update K${b.knowledgeId}@v1`, { reason: "tidy" }, "Rule 2, tidied"),
  ].join("\n");
  const final = await f.dream();
  expect(final.outcome, JSON.stringify(final)).toBe("success");
  if (!("runId" in final)) throw new Error("missing run");
  // The refused block says what is wrong in version addresses; the other block still applies.
  // The refusal happens at verify's apply (stage 5: nothing is applied before verify passes), so the audit is verify's per-change results.
  const run = f.store.listRuns(f.session.id).find(value => value.kind === "dreaming" && JSON.parse(value.response ?? "{}").verdicts)!;
  const results = (JSON.parse(run.response!).verdicts as { result: { ok: boolean; reason?: string } }[]).map(entry => entry.result);
  expect(results.map(result => result.ok)).toEqual([false, true]);
  expect(results[0]!.reason).toContain(`K${out.knowledgeId}@v1`);
  expect(results[0]!.reason).toMatch(/outside the writer's scope/);
  expect(results[0]!.reason).not.toMatch(/K\d+@\d/); // never `K<id>@<commit>`
  // The audit keeps the internal diagnostics beside the refusal in version addresses: the refused item's own exact commit, and the applied block's.
  expect(run.response!).toContain(`K${out.knowledgeId}@${out.commit}`);
  expect((JSON.parse(run.response!).verdicts[0].result as { diagnostic: string }).diagnostic).toContain(`K${out.knowledgeId}@${out.commit}`);
  expect(run.response!).toContain(`"commit":${f.store.currentCommit(b.knowledgeId, f.path)[0]!.id}`);
  expect(f.dreamer.messages.join("\n")).not.toContain(`K${out.knowledgeId}@${out.commit}`); // the model never sees the commit id
  expect(f.store.currentCommit(out.knowledgeId, otherTarget)[0]!.id).toBe(out.commit);
  expect(f.store.currentCommit(b.knowledgeId, f.path)[0]!.text).toBe("Rule 2, tidied");
  expect(a.knowledgeId).not.toBe(b.knowledgeId);
});
