import { expect, test, vi } from "vitest";
import { performance } from "node:perf_hooks";
import { writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { TraceMemory } from "../../../src/core/api/index.ts";

const at = "2026-09-23T00:00:00Z";
const median = (samples: number[]) => [...samples].sort((a, b) => a - b)[Math.floor(samples.length / 2)]!;

function measure(historyLength: number) {
  const memory = TraceMemory(":memory:", vi.fn());
  const store = memory.store;
  try {
    const project = store.createProject({ name: "perf", declaredBy: "mark" });
    const session = store.createSession({ host: "test", projectId: project.id,
      enrollmentChoice: true, startedAt: at, firstReplyAt: at });
    let head: number | null = null;
    const ids: number[] = [];
    const add = (name: string) => {
      const turn = store.appendTurn({ sessionId: session.id, parentTurnId: head, kind: "turn",
        userPrompt: name, startedAt: at });
      head = turn.id;
      return store.appendSourceEntry({ sessionId: session.id, turnId: turn.id,
        nativeLineage: "native", nativeId: name, role: "user", text: "fixed body " + "word ".repeat(8),
        raw: "{}", calls: [] });
    };
    for (let i = 0; i < historyLength; i++) ids.push(add(`history-${i}`).id);
    const pathHead = head!;
    // Future Turn entries are already processed on another path before this measured path selects
    // them. This keeps exactly three pending entries throughout every sample without a Noting
    // commit (which would invalidate the warm cache) between measured appends.
    const future = Array.from({ length: 55 }, (_, i) => add(`sample-${i}`));
    store.publishSourcePath(session.id, "main", ids, pathHead, "native");
    const run = store.recordRun({ kind: "noting", sessionId: session.id, branch: "main",
      outcome: "success", createdAt: at });
    store.transaction(() => {
      const noted = store.db.prepare("INSERT INTO noted_entries(entry_id,run_id) VALUES (?,?)");
      for (const id of [...ids.slice(0, -3), ...future.map(entry => entry.id)]) noted.run(id, run.id);
    });
    const target = { sessionId: session.id, branch: "main", headTurnId: pathHead };
    memory.config.noting.triggerTokens = 1;
    // Cold rebuild is intentionally separate from the warm samples; pending stays exactly three.
    const coldStart = performance.now();
    expect(memory.taskEligibility("noting", target).due).toBe(true);
    const cold = performance.now() - coldStart;
    const measurements = { append: [] as number[], due: [] as number[], pending: [] as number[] };
    const statementCounts: number[] = [];
    for (let i = 0; i < 55; i++) {
      const entry = future[i]!;
      const old = store.sourcePathState(session.id, "main")!;
      const spy = vi.spyOn(store.db, "prepare");
      const start = performance.now();
      store.transaction(() => store.appendSourcePath(session.id, "main", old, [entry.id], entry.turnId, "native"));
      measurements.append.push(performance.now() - start);
      const queries = spy.mock.calls.map(([sql]) => sql);
      spy.mockRestore();
      statementCounts.push(queries.length);
      expect(queries.some(sql => /SELECT p\.position, p\.entry_id, e\.id AS owned_id/.test(sql))).toBe(false);
      expect(queries.find(sql => sql.includes("SELECT id, turn_id FROM source_entries")))
        .toContain("NOT INDEXED");
      target.headTurnId = entry.turnId;
      const dueStart = performance.now();
      expect(memory.taskEligibility("noting", target).due).toBe(true);
      measurements.due.push(performance.now() - dueStart);
      const pendingStart = performance.now();
      expect(store.pendingEntryIds(session.id, "main", entry.turnId)).toHaveLength(3);
      measurements.pending.push(performance.now() - pendingStart);
    }
    return { cold, medians: Object.fromEntries(Object.entries(measurements)
      .map(([name, samples]) => [name, median(samples.slice(5))])) as Record<keyof typeof measurements, number>,
      statements: Math.max(...statementCounts) };
  } finally { memory.close(); }
}

test("80: steady append, due and pending reads stay bounded across 1k and 20k separate Turns", () => {
  const short = measure(1_000), long = measure(20_000);
  writeFileSync(join(tmpdir(), "tm-80-core-performance-evidence.json"),
    JSON.stringify({ short, long }, null, 2));
  for (const operation of ["append", "due", "pending"] as const)
    expect(long.medians[operation] / short.medians[operation]).toBeLessThanOrEqual(1.5);
  expect(long.statements).toBeLessThanOrEqual(short.statements + 2);
}, 180_000);
