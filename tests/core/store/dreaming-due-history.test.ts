import { expect, test, vi } from "vitest";
import { performance } from "node:perf_hooks";
import { TraceMemory } from "../../../src/core/api/index.ts";
import { knowledgeBatch } from "../../support/seed.ts";

const at = "2026-09-28T00:00:00Z";
const median = (samples: number[]) => [...samples].sort((a, b) => a - b)[Math.floor(samples.length / 2)]!;

/** The Dreamer's due check over the same current knowledge (about 30k tokens, the overflow window
 * where the check repeats at every opportunity) beside `archived` processed archived identities. */
function measure(archived: number) {
  const memory = TraceMemory(":memory:", vi.fn());
  const store = memory.store;
  try {
    const project = store.createProject({ name: "history", declaredBy: "mark" });
    const session = store.createSession({ host: "test", projectId: project.id, enrollmentChoice: true, startedAt: at, firstReplyAt: at });
    const turn = store.appendTurn({ sessionId: session.id, kind: "turn", userPrompt: "evidence", startedAt: at });
    const entry = store.appendSourceEntry({ sessionId: session.id, turnId: turn.id, nativeLineage: "native", nativeId: "evidence",
      role: "user", text: "evidence", raw: "{}", calls: [] });
    store.selectSourcePath(session.id, "main", [entry.id]);
    const path = { sessionId: session.id, branch: "main", headTurnId: turn.id };
    const noted = store.commitNotingRun({ run: { kind: "manual", sessionId: session.id, createdAt: at }, facts: [{ turnId: turn.id,
      entryIds: [entry.id], text: "evidence", category: "decision", actor: "user", source: [`T${turn.id}#user`], createdAt: at }] });
    if (!noted.ok) throw new Error(noted.problems.join("; "));
    const item = (text: string) => ({ scope: "project" as const, category: "constraint" as const, supports: [noted.facts[0]!.id],
      text: `${text} ${"word ".repeat(120)}` });
    const pool = `project:${project.id}`;
    const processed = (commits: readonly { commit: number }[]) => store.transaction(() => {
      const run = store.recordRun({ kind: "dreaming", sessionId: session.id, branch: "main", outcome: "success", createdAt: at });
      const insert = store.db.prepare("INSERT INTO knowledge_processed(pool,revision_id,run_id) VALUES (?,?,?)");
      for (const { commit } of commits) insert.run(pool, commit, run.id);
    });
    for (let from = 0; from < archived; from += 500) {
      const made = knowledgeBatch(store, path, Array.from({ length: Math.min(500, archived - from) }, (_, i) => item(`old ${from + i}`))).committed;
      const archives = store.commitConsolidationRun({ path, run: { kind: "manual", sessionId: session.id, createdAt: at },
        operations: made.map(value => ({ op: "archive" as const, kind: "budget" as const, knowledgeId: value.knowledgeId, baseCommit: value.commit,
          supports: [noted.facts[0]!.id], reason: "retired", createdAt: at })) });
      if (!archives.ok) throw new Error(archives.problems.join("; "));
      processed([...made, ...archives.committed]);
    }
    processed(knowledgeBatch(store, path, Array.from({ length: 240 }, (_, i) => item(`current ${i}`))).committed);
    knowledgeBatch(store, path, Array.from({ length: 5 }, (_, i) => item(`pending ${i}`)));
    const size = store.poolSizes(path).reduce((sum, value) => sum + value.tokens, 0);
    memory.taskEligibility("dreaming", path);
    const samples: number[] = [];
    for (let i = 0; i < 40; i++) {
      const start = performance.now();
      memory.taskEligibility("dreaming", path);
      samples.push(performance.now() - start);
    }
    return { size, due: median(samples.slice(5)) };
  } finally { memory.close(); }
}

test("104: the Dreamer's due check stays within 1.5x as archived history grows from 100 to 3,000 identities", () => {
  const short = measure(100), long = measure(3_000);
  console.info(JSON.stringify({ fixture: "104 due check over archived history", short, long }));
  // Same current bodies; only their K addresses differ in length.
  expect(Math.abs(long.size - short.size) / short.size).toBeLessThan(0.02);
  expect(short.size).toBeGreaterThan(25_000);
  expect(long.due / short.due, JSON.stringify({ short, long })).toBeLessThanOrEqual(1.5);
}, 120_000);
