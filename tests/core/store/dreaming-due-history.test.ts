import { expect, test, vi } from "vitest";
import { performance } from "node:perf_hooks";
import { TraceMemory } from "../../../src/core/api/index.ts";
import { entry as seedEntry, knowledgeBatch, legacyFact } from "../../support/seed.ts";
import { commitNoterKnowledge } from "../../noting-knowledge-fixture.ts";

const at = "2026-09-28T00:00:00Z";
const median = (samples: number[]) => [...samples].sort((a, b) => a - b)[Math.floor(samples.length / 2)]!;

/** The Dreamer's due check (the Noter-changed trigger, 144 stage 4) over the same current knowledge beside `archived` processed
 * archived identities. `currentProcessed` sizes the current pool: 240 items (about 35k tokens, where the check repeats at every
 * opportunity) or 40 (about 6.5k), the ticket's two ruled scenarios. */
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
        operations: made.map(value => ({ op: "archive" as const, kind: "invalid" as const, text: "Withdrawn: the user retired this and nothing replaces it, per the cited fact.", knowledgeId: value.knowledgeId, baseCommit: value.commit,
          supports: [fact.id], reason: "retired", createdAt: at })) });
      if (!archives.ok) throw new Error(archives.problems.join("; "));
      processed([...made, ...archives.committed]);
    }
    processed(knowledgeBatch(store, path, Array.from({ length: currentProcessed }, (_, i) => item(`current ${i}`))).committed);
    knowledgeBatch(store, path, Array.from({ length: 5 }, (_, i) => item(`pending ${i}`)));
    // `due` goes through the scheduler's eligibility; `changes` is the Store's rule directly.
    const time = (check: () => unknown) => {
      check();
      const samples: number[] = [];
      for (let i = 0; i < 40; i++) {
        const start = performance.now();
        check();
        samples.push(performance.now() - start);
      }
      return median(samples.slice(5));
    };
    return { due: time(() => memory.taskEligibility("dreaming", path)), changes: time(() => store.dreamingDue(path)) };
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
  withinRuledBound(short, long);
  withinRuledBound({ due: short.changes }, { due: long.changes });
}, 120_000);

test("104: the Dreamer's due check stays within the ruled bound as archived history grows from 100 to 3,000 identities, with little current knowledge", () => {
  const short = measure(100, 40), long = measure(3_000, 40);
  console.info(JSON.stringify({ fixture: "104 due check over archived history (little current knowledge)", short, long }));
  withinRuledBound(short, long);
  withinRuledBound({ due: short.changes }, { due: long.changes });
}, 120_000);

/** Stage 4 (144): one live item rewritten by the Noter `rewrites` times after its last coverage. The current version is
 * a Noter revision, so the walk stops there however long the history behind it is. Depth stops short of the ticket's
 * 3,000: the Store's lineage resolution (`effectiveRevisions`) recurses once per version of one identity and overflows
 * the stack near 1,900, for every reader, so a longer chain cannot be built. */
function measureRewrites(rewrites: number) {
  const memory = TraceMemory(":memory:", vi.fn());
  const store = memory.store;
  try {
    const project = store.createProject({ name: "rewrites", declaredBy: "mark" });
    const session = store.createSession({ host: "test", projectId: project.id, enrollmentChoice: true, startedAt: at, firstReplyAt: at });
    const turn = store.appendTurn({ sessionId: session.id, kind: "turn", userPrompt: "evidence", startedAt: at });
    const sourceEntry = seedEntry(store, session.id, turn.id, "evidence", "user", "evidence");
    store.selectSourcePath(session.id, "main", [sourceEntry.id]);
    const path = { sessionId: session.id, branch: "main", headTurnId: turn.id };
    const fact = legacyFact(store, path, [{ entry: sourceEntry, address: `T${turn.id}#user` }], "evidence", "decision");
    const created = knowledgeBatch(store, path, [{ scope: "project", category: "constraint", supports: [fact.id], text: `rule ${"word ".repeat(120)}` }]).committed[0]!;
    const run = store.recordRun({ kind: "dreaming", sessionId: session.id, branch: "main", outcome: "success", createdAt: at });
    store.db.prepare("INSERT INTO knowledge_processed(pool,revision_id,run_id) VALUES (?,?,?)").run(`project:${project.id}`, created.commit, run.id);
    let base = created.commit;
    for (let i = 0; i < rewrites; i++) {
      const result = commitNoterKnowledge(store, { path, run: { sessionId: session.id, branch: "main", createdAt: at }, operations: [{ op: "update",
        knowledgeId: created.knowledgeId, baseCommit: base, text: `rule ${i} ${"word ".repeat(120)}`, category: "constraint", scope: "project",
        supports: [fact.id], topics: [], reason: "rewrite", createdAt: at }] });
      if (!result.ok) throw new Error(result.problems.join("; "));
      base = result.committed[0]!.commit;
    }
    store.dreamingDue(path);
    const samples: number[] = [];
    for (let i = 0; i < 40; i++) {
      const start = performance.now();
      store.dreamingDue(path);
      samples.push(performance.now() - start);
    }
    return { due: median(samples.slice(5)) };
  } finally { memory.close(); }
}

test("144 stage 4: the change trigger stays within the ruled bound as one live item is rewritten by the Noter from 100 to 1,500 times after coverage", () => {
  const short = measureRewrites(100), long = measureRewrites(1_500);
  console.info(JSON.stringify({ fixture: "144 change trigger over Noter rewrites", short, long }));
  withinRuledBound(short, long);
}, 120_000);
