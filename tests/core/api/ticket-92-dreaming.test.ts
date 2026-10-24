import { afterEach, expect, test } from "vitest";
import { hydrate, type TraceMemory } from "../../source-fixture.ts";
import { fact as seedFact, knowledge as seedKnowledge } from "../../support/seed.ts";
import { dreamerFixture } from "../../support/dreamer.ts";
import { block } from "../../support/workspace.ts";

const memories: TraceMemory[] = [];
afterEach(() => { for (const memory of memories.splice(0)) memory.close(); });

test("156 supersedes 92's cross-group partial apply: an outside-group proposal rejects the whole group before publication", async () => {
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
  expect(final.outcome, JSON.stringify(final)).toBe("failure");
  if (final.outcome !== "failure") throw new Error("missing failure");
  expect(final.problems.join("\\n")).toContain(`K${out.knowledgeId}@v1`);
  expect(f.store.db.prepare("SELECT revision_id FROM knowledge_processed").all()).toEqual([]);
  expect(f.store.currentCommit(out.knowledgeId, otherTarget)[0]!.id).toBe(out.commit);
  expect(f.store.currentCommit(b.knowledgeId, f.path)[0]!.text).toBe("Rule 2");
  expect(a.knowledgeId).not.toBe(b.knowledgeId);
});
