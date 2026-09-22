import { afterEach, expect, test } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { TraceMemory, type DreamingAgentInput, type RunAgentResult } from "../../../src/core/api/index.ts";

const memories: ReturnType<typeof TraceMemory>[] = [], dirs: string[] = [];
afterEach(() => { for (const memory of memories.splice(0)) memory.close(); for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });
const success = { outcome: "success", request: { exact: "offline request" }, output: "reviewed" } as const;
class Barrier { release!: () => void; readonly wait = new Promise<void>(resolve => { this.release = resolve; }); }

function fixture() {
  const dir = mkdtempSync(join(tmpdir(), "dreamer-seat-")); dirs.push(dir);
  const db = join(dir, "memory.sqlite");
  let agent: (task: DreamingAgentInput) => Promise<RunAgentResult> = async () => success;
  const memory = TraceMemory(db, raw => agent(raw as DreamingAgentInput)); memories.push(memory);
  const store = memory.store, project = store.createProject({ name: "shared", declaredBy: "mark" });
  const session = store.createSession({ host: "offline", projectId: project.id, enrollmentChoice: true, startedAt: "now", firstReplyAt: "now" });
  const turn = store.appendTurn({ sessionId: session.id, kind: "turn", userPrompt: "rule", startedAt: "now" });
  const entry = memory.appendEntry({ sessionId: session.id, turnId: turn.id, nativeLineage: "fixture", nativeId: "root", role: "user", text: "rule", raw: "rule", calls: [] });
  memory.selectEntries(session.id, "main", [entry.id]);
  const target = { sessionId: session.id, branch: "main", headTurnId: turn.id, triggerEntryId: entry.id };
  const facts = store.commitNotingRun({ run: { kind: "manual", sessionId: session.id, createdAt: "now" }, facts: [{
    turnId: turn.id, entryIds: [entry.id], text: "rule", category: "decision", actor: "user", source: [`T${turn.id}#E1`], createdAt: "now",
  }] });
  if (!facts.ok) throw new Error(facts.problems.join("; "));
  const content = { text: "rule", category: "constraint" as const, scope: "project" as const, supports: [facts.facts[0]!.id], topics: [], reason: "evidence", createdAt: "now" };
  const created = store.commitConsolidationRun({ run: { kind: "manual", sessionId: session.id, createdAt: "now" }, operations: [{ op: "create", handle: "$1", author: "test", ...content }] });
  if (!created.ok) throw new Error(created.problems.join("; "));
  const item = created.committed[0]!, pool = `project:${project.id}`;
  store.setKnowledgeBudget("project", Math.max(1, store.pendingPoolWeight(pool, target) * 2));

  const other = TraceMemory(db, async () => { throw new Error("occupied seat must prevent provider launch"); }); memories.push(other);
  const otherSession = other.store.createSession({ host: "offline", projectId: project.id, enrollmentChoice: true, startedAt: "now", firstReplyAt: "now" });
  const otherTurn = other.store.appendTurn({ sessionId: otherSession.id, kind: "turn", userPrompt: "other", startedAt: "now" });
  const otherEntry = other.appendEntry({ sessionId: otherSession.id, turnId: otherTurn.id, nativeLineage: "fixture", nativeId: "other", role: "user", text: "other", raw: "other", calls: [] });
  other.selectEntries(otherSession.id, "main", [otherEntry.id]);
  const otherPath = { sessionId: otherSession.id, branch: "main", headTurnId: otherTurn.id, triggerEntryId: otherEntry.id };
  return { memory, store, other, target, otherPath, item, content, pool, setAgent: (next: typeof agent) => { agent = next; } };
}

test("64c another target waits while the database-wide Dreamer seat is occupied", async () => {
  const f = fixture(), admitted = new Barrier(), release = new Barrier();
  f.setAgent(async task => { task.acknowledgeRequest(); admitted.release(); await release.wait; return success; });
  const running = f.memory.dream(f.target);
  await admitted.wait;
  expect((await f.other.dream(f.otherPath)).outcome).toBe("dropped");
  expect(f.store.db.prepare("SELECT * FROM knowledge_processed").all()).toEqual([]);
  release.release();
  expect((await running).outcome).toBe("success");
  expect(f.store.db.prepare("SELECT pool, revision_id FROM knowledge_processed").all()).toEqual([
    { pool: f.pool, revision_id: f.item.commit },
  ]);
  expect(f.store.openDreamingRange(f.target.sessionId, f.target.branch)).toBeNull();
});

test("64c external maintenance is atomically refused by the live seat and succeeds only after release", async () => {
  const f = fixture(), admitted = new Barrier(), release = new Barrier();
  f.setAgent(async task => { task.acknowledgeRequest(); admitted.release(); await release.wait; return success; });
  const running = f.memory.dream(f.target);
  await admitted.wait;
  const operation = { op: "archive" as const, knowledgeId: f.item.knowledgeId, baseCommit: f.item.commit,
    supports: f.content.supports, reason: "external archive", createdAt: "now" };
  const before = f.store.listKnowledgeRevisions().length;
  const blocked = f.other.store.commitConsolidationRun({ path: f.otherPath,
    run: { kind: "manual", sessionId: f.otherPath.sessionId, createdAt: "now" }, operations: [operation] });
  expect(blocked.ok).toBe(false);
  if (!blocked.ok) expect(blocked.problems.join(" ")).toContain("Dreamer");
  expect(f.store.listKnowledgeRevisions()).toHaveLength(before);
  release.release();
  expect((await running).outcome).toBe("success");
  const accepted = f.other.store.commitConsolidationRun({ path: f.otherPath,
    run: { kind: "manual", sessionId: f.otherPath.sessionId, createdAt: "now" }, operations: [operation] });
  expect(accepted.ok).toBe(true);
});
