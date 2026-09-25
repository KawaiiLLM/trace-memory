// Run only under the approved suite lock: node --experimental-transform-types tests/perf/ticket-87.ts <task-local-output-dir>
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { performance } from "node:perf_hooks";
import { TraceMemory } from "../../src/core/api/index.ts";

const output = process.argv[2];
if (!output) throw new Error("task-local output directory is required");
mkdirSync(output, { recursive: true });
const time = "2026-09-25T00:00:00Z";
const median = (samples: number[]) => [...samples].sort((a, b) => a - b)[Math.floor(samples.length / 2)]!;
const results: Record<string, Record<string, number>> = {};

for (const length of [1_000, 20_000]) {
  const memory = TraceMemory(join(output, `path-${length}.db`), async () => { throw new Error("no model calls in benchmark"); });
  try {
    const store = memory.store;
    const projectId = store.createProject({ name: `bench-${length}`, declaredBy: "mark" }).id;
    const sessionId = store.createSession({ host: `bench-${length}`, projectId, enrollmentChoice: true,
      startedAt: time, firstReplyAt: time }).id;
    let parent: number | null = null;
    const entries: number[] = [];
    const add = () => {
      const turn = store.appendTurn({ sessionId, parentTurnId: parent, kind: "turn", userPrompt: "same", startedAt: time });
      const entry = store.appendSourceEntry({ sessionId, turnId: turn.id, nativeLineage: "benchmark",
        nativeId: `e-${turn.id}`, role: "user", text: "same", raw: "same", calls: [] });
      parent = turn.id;
      return { turn, entry };
    };
    for (let i = 0; i < length; i++) entries.push(add().entry.id);
    store.publishSourcePath(sessionId, "main", entries, parent!, "L");
    const noted = store.commitNotingRun({ run: { kind: "noting", sessionId, createdAt: time }, entryIds: entries, facts: [] });
    if (!noted.ok) throw new Error(noted.problems.join("; "));
    const samples = new Map<string, number[]>();
    const timed = (name: string, action: () => unknown) => {
      const start = performance.now(); action();
      if (!samples.has(name)) samples.set(name, []);
      samples.get(name)!.push(performance.now() - start);
    };
    const target = () => ({ sessionId, branch: "main", headTurnId: parent! });
    memory.injection(target()); memory.progress(sessionId, "main", parent); store.pathSnapshot(target());
    store.pendingEntryState(sessionId, "main", parent!);
    for (let i = 0; i < 60; i++) {
      const { turn, entry } = add();
      const state = store.sourcePathState(sessionId, "main")!;
      timed("append", () => store.appendSourcePath(sessionId, "main", state, [entry.id], turn.id, "L"));
      timed("notingDue", () => memory.taskEligibility("noting", target()));
      timed("pending", () => store.pendingEntryState(sessionId, "main", parent!));
      timed("pathSnapshot", () => store.pathSnapshot(target()));
      timed("triggerOrigin", () => store.triggerOrigin(target(), entry.id));
      timed("injection", () => memory.injection(target()));
      timed("footer", () => memory.progress(sessionId, "main", parent));
    }
    results[length] = Object.fromEntries([...samples].map(([name, values]) => [name, median(values.slice(10))]));
  } finally { memory.close(); }
}
const ratios = Object.fromEntries(Object.keys(results["1000"]!).map(name =>
  [name, results["20000"]![name]! / results["1000"]![name]!]));
const withinThreshold = Object.fromEntries(Object.entries(ratios).map(([name, ratio]) => [name, ratio <= 1.5]));
const report = { results, ratios, threshold: 1.5, withinThreshold };
writeFileSync(join(output, "ticket-87-results.json"), JSON.stringify(report, null, 2));
console.log(JSON.stringify(report, null, 2));
if (Object.values(withinThreshold).some(pass => !pass)) process.exitCode = 1;
