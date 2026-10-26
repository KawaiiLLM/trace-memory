import { afterEach, expect, test } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { sourceSeededMemory, type TraceMemory } from "../../source-fixture.ts";
import { dreamerFixture as makeDreamerFixture } from "../../support/dreamer.ts";

const memories: TraceMemory[] = [], dirs: string[] = [];
afterEach(() => { for (const memory of memories.splice(0)) memory.close(); for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });
class Barrier { release!: () => void; readonly wait = new Promise<void>(resolve => { this.release = resolve; }); }

// The one-Dreamer-at-a-time seat (ticket 64c) outlives the frozen range: the database holds one Dreamer run at a time.
function fixture() {
  const dir = mkdtempSync(join(tmpdir(), "dreamer-seat-")); dirs.push(dir);
  const f = makeDreamerFixture(memories, {}, join(dir, "memory.sqlite"));
  const item = f.item("rule");
  const other = sourceSeededMemory(join(dir, "memory.sqlite"), async () => { throw new Error("occupied seat must prevent provider launch"); }, { dreaming: { triggerKnowledge: 1 } });
  memories.push(other);
  const otherSession = other.store.createSession({ host: "offline", projectId: f.project.id, enrollmentChoice: true, startedAt: "now", firstReplyAt: "now" });
  const otherTurn = other.store.appendTurn({ sessionId: otherSession.id, kind: "turn", userPrompt: "other", startedAt: "now" });
  const otherEntry = other.appendEntry({ sessionId: otherSession.id, turnId: otherTurn.id, nativeLineage: "fixture", nativeId: "other", role: "user", text: "other", raw: "other", calls: [] });
  other.selectEntries(otherSession.id, "main", [otherEntry.id]);
  const otherPath = { sessionId: otherSession.id, branch: "main", headTurnId: otherTurn.id, triggerEntryId: otherEntry.id };
  /** The scripted Dreamer, held at its start until released. */
  const hold = () => {
    const admitted = new Barrier(), release = new Barrier();
    f.next(async raw => { admitted.release(); await release.wait; return f.dreamer.agent(raw); });
    return { admitted, release };
  };
  return { ...f, other, otherPath, item, hold };
}

test("64c another target waits while the database-wide Dreamer seat is occupied", async () => {
  const f = fixture(), held = f.hold();
  const running = f.dream();
  await held.admitted.wait;
  expect((await f.other.dream(f.otherPath)).outcome).toBe("dropped");
  held.release.release();
  expect((await running).outcome).toBe("success");
});

test("64c external maintenance is atomically refused by the live seat and succeeds only after release", async () => {
  const f = fixture(), held = f.hold();
  const running = f.dream();
  await held.admitted.wait;
  const operation = { files: null, op: "archive" as const, kind: "invalid" as const, knowledgeId: f.item.knowledgeId, baseCommit: f.item.commit, text: "No longer holds, per the user's later correction which replaces it.",
    supports: f.item.supports, reason: "external archive", createdAt: "now" };
  const before = f.store.listKnowledgeRevisions().length;
  const blocked = f.other.store.commitConsolidationRun({ path: f.otherPath,
    run: { kind: "manual", sessionId: f.otherPath.sessionId, createdAt: "now" }, operations: [operation] });
  expect(blocked.ok).toBe(false);
  if (!blocked.ok) expect(blocked.problems.join(" ")).toContain("Dreamer");
  expect(f.store.listKnowledgeRevisions()).toHaveLength(before);
  held.release.release();
  const finished = await running;
  expect(finished.outcome, JSON.stringify(finished)).toBe("success");
  const accepted = f.other.store.commitConsolidationRun({ path: f.otherPath,
    run: { kind: "manual", sessionId: f.otherPath.sessionId, createdAt: "now" }, operations: [{ ...operation, baseCommit: f.store.currentCommit(f.item.knowledgeId, f.path)[0]!.id }] });
  expect(accepted.ok, JSON.stringify(accepted)).toBe(true);
});
