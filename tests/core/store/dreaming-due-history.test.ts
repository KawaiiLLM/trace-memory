import { expect, test, vi } from "vitest";
import { performance } from "node:perf_hooks";
import { TraceMemory } from "../../../src/core/api/index.ts";
import { entry as seedEntry, knowledgeBatch, legacyFact } from "../../support/seed.ts";

const at = "2026-09-28T00:00:00Z";
const median = (samples: number[]) => [...samples].sort((a, b) => a - b)[Math.floor(samples.length / 2)]!;

/** The Dreamer's due check over the same current knowledge beside `archived` processed archived
 * identities. `currentProcessed` sizes the current pool: 240 items give the overflow window (about
 * 35k tokens, where the check repeats at every opportunity); 40 give little current knowledge
 * (about 6.5k), the ticket's second ruled scenario. */
function measure(archived: number, currentProcessed: number) {
  const memory = TraceMemory(":memory:", vi.fn());
  const store = memory.store;
  try {
    const project = store.createProject({ name: "history", declaredBy: "mark" });
    const session = store.createSession({ host: "test", projectId: project.id, enrollmentChoice: true, startedAt: at, firstReplyAt: at });
    const turn = store.appendTurn({ sessionId: session.id, kind: "turn", userPrompt: "evidence", startedAt: at });
    const sourceEntry = seedEntry(store, session.id, turn.id, "evidence", "user", "evidence");
    store.selectSourcePath(session.id, "main", [sourceEntry.id]);
    const path = { sessionId: session.id, branch: "main", headTurnId: turn.id };
    const fact = legacyFact(store, path, [{ entry: sourceEntry, address: `T${turn.id}#user` }], "evidence", "decision");
    const item = (text: string) => ({ scope: "project" as const, category: "constraint" as const, supports: [fact.id],
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
          supports: [fact.id], reason: "retired", createdAt: at })) });
      if (!archives.ok) throw new Error(archives.problems.join("; "));
      processed([...made, ...archives.committed]);
    }
    processed(knowledgeBatch(store, path, Array.from({ length: currentProcessed }, (_, i) => item(`current ${i}`))).committed);
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

/** 104 requirement 9 (ruled option A): as archived history grows from 100 to 3,000 identities, cost
 * may grow by at most 1.5x or by at most 2 ms, whichever allows more. */
function withinRuledBound(short: { due: number }, long: { due: number }) {
  const ratio = long.due / short.due, diffMs = long.due - short.due;
  expect(ratio <= 1.5 || diffMs <= 2, JSON.stringify({ short, long, ratio, diffMs })).toBe(true);
}

test("104: the Dreamer's due check stays within the ruled bound as archived history grows from 100 to 3,000 identities, at overflow scale", () => {
  const short = measure(100, 240), long = measure(3_000, 240);
  console.info(JSON.stringify({ fixture: "104 due check over archived history (overflow scale)", short, long }));
  // Same current bodies; only their K addresses differ in length.
  expect(Math.abs(long.size - short.size) / short.size).toBeLessThan(0.02);
  expect(short.size).toBeGreaterThan(25_000);
  withinRuledBound(short, long);
}, 120_000);

test("104: the Dreamer's due check stays within the ruled bound as archived history grows from 100 to 3,000 identities, with little current knowledge", () => {
  const short = measure(100, 40), long = measure(3_000, 40);
  console.info(JSON.stringify({ fixture: "104 due check over archived history (little current knowledge)", short, long }));
  // Same current bodies; only their K addresses differ in length.
  expect(Math.abs(long.size - short.size) / short.size).toBeLessThan(0.02);
  expect(short.size).toBeLessThan(10_000);
  withinRuledBound(short, long);
}, 120_000);
