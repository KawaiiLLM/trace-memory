import { TraceMemory } from "../../src/core/api/index.ts";
import { fixtureTitle, legacyFacts } from "./seed.ts";

/** A memory with one session and a `create(label, words, score)` builder for knowledge items that carry a classify score
 * (null: unscored), for tests of score-ordered injection (144 stage 4 §7). Registered memories are closed by `closeInjectionFixtures`. */
const memories: ReturnType<typeof TraceMemory>[] = [];
export const closeInjectionFixtures = (): void => { for (const memory of memories.splice(0)) memory.close(); };

export function injectionFixture() {
  const memory = TraceMemory(":memory:", async () => { throw new Error("offline"); }, { writing: { bodyWords: 1_000_000 } });
  memories.push(memory);
  const project = memory.store.createProject({ name: "order", declaredBy: "mark" });
  const session = memory.store.createSession({ host: "test", projectId: project.id, enrollmentChoice: true, startedAt: "now", firstReplyAt: "now" });
  const turn = memory.store.appendTurn({ sessionId: session.id, kind: "turn", userPrompt: "evidence", startedAt: "now" });
  const entry = memory.appendEntry({ sessionId: session.id, turnId: turn.id, nativeLineage: "fixture", nativeId: "e", role: "user", text: "evidence", raw: "evidence", calls: [] });
  memory.selectEntries(session.id, "main", [entry.id]);
  const noted = legacyFacts(memory.store, { kind: "manual", sessionId: session.id, createdAt: "now" }, [{
    sources: [{ entry, address: `T${turn.id}#user` }], category: "decision", actor: "user", text: "evidence", createdAt: "now" }]);
  const target = { sessionId: session.id, branch: "main", headTurnId: turn.id };
  let sequence = 0;
  /** A knowledge item of about `size` words, with a classify score (null: unscored). */
  const create = (label: string, size: number, score: number | null) => {
    const text = `${label} ` + "word ".repeat(size);
    const result = memory.store.commitConsolidationRun({ path: target, run: { kind: "manual", sessionId: session.id, branch: "main", createdAt: "now" }, operations: [{
      op: "create", title: fixtureTitle(label), handle: `$${++sequence}`, author: "test", text, category: "constraint", scope: "project",
      supports: [noted.facts[0]!.id], topics: [], reason: "order fixture", createdAt: "now" }] });
    if (!result.ok) throw new Error(result.problems.join("; "));
    const done = result.committed[0]!;
    memory.store.db.prepare("UPDATE knowledge SET score = ? WHERE id = ?").run(score, done.knowledgeId);
    return done;
  };
  return { memory, session, target, create };
}
