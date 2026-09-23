import { expect, onTestFinished, test, vi } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { join } from "node:path";
import { spawn } from "node:child_process";
import { performance } from "node:perf_hooks";
import { Store } from "../../src/core/store/index.ts";
import { resolveCcHostConfig } from "../../src/hosts/cc/config.ts";
import { recordSessionStart } from "../../src/hosts/cc/binding.ts";
import { CcImporter } from "../../src/hosts/cc/importer.ts";

// 70: production-scale (30k-record) measurements for the cooperative-import ticket. Each `test`
// prints one JSON line the report tables (worst wait, phase timings, lookup counts) are built from;
// "five consecutive single-file runs" (the wait-time acceptance item) means running this file five
// separate times (`npx vitest run tests/hosts/cc-70-performance.test.ts`), reported per run — a
// single in-process loop would not reproduce five independent process starts.

const at = "2026-01-01T00:00:00.000Z";
const line = (value: unknown) => JSON.stringify(value) + "\n";
function records(pairs: number) {
  return Array.from({ length: pairs }, (_, i) => [
    { uuid: `u${i}`, parentUuid: i ? `a${i - 1}` : null, type: "user", timestamp: at,
      promptId: `p${i}`, promptSource: "sdk", message: { role: "user", content: `question ${i}` } },
    { uuid: `a${i}`, parentUuid: `u${i}`, type: "assistant", timestamp: at,
      message: { role: "assistant", content: [{ type: "text", text: `answer ${i}` }] } },
  ]).flat();
}

test("30k-record bootstrap: writer wait during ingest, per-phase timing, and lookup counts", async () => {
  const dir = mkdtempSync("/tmp/tm70-perf-");
  const transcriptPath = join(dir, "native.jsonl"), nativeSessionId = "performance";
  const config = resolveCcHostConfig({ dbPath: join(dir, "memory.sqlite"), stateDir: join(dir, "s"), baseline: "2025-01-01T00:00:00Z" });
  writeFileSync(transcriptPath, records(15_000).map(line).join(""));
  const binding = await recordSessionStart(config, { hook_event_name: "SessionStart", session_id: nativeSessionId, transcript_path: transcriptPath }, at);
  const importer = new CcImporter(config, binding);

  // Lookup-count and wall-time instrumentation, apples-to-apples with the ticket's baseline CPU
  // profile table (measured the same way, by call category, on ff48611): getTurn (owner check +
  // assistant-text append, collapsed to one call by this ticket), findSourceEntry/getSourceEntry
  // (ingest's own duplicate check + appendSourceEntry's internal one, collapsed via the `known`
  // passthrough), and enrollment/enabled (memoized per transaction).
  const store = importer.memory.store;
  const counts = { getTurn: 0, findSourceEntry: 0, getSourceEntry: 0, enrollment: 0, beginCommitMs: 0, writesMs: 0 };
  const originalGetTurn = store.getTurn.bind(store);
  vi.spyOn(store, "getTurn").mockImplementation((...args) => { counts.getTurn++; return originalGetTurn(...args); });
  const originalFindSourceEntry = store.findSourceEntry.bind(store);
  vi.spyOn(store, "findSourceEntry").mockImplementation((...args) => { counts.findSourceEntry++; return originalFindSourceEntry(...args); });
  const originalGetSourceEntry = store.getSourceEntry.bind(store);
  vi.spyOn(store, "getSourceEntry").mockImplementation((...args) => { counts.getSourceEntry++; return originalGetSourceEntry(...args); });
  const originalEnrollment = store.enrollment.bind(store);
  vi.spyOn(store, "enrollment").mockImplementation((...args) => { counts.enrollment++; return originalEnrollment(...args); });
  let pathPublishMs = 0;
  const originalPublishSourcePath = store.publishSourcePath.bind(store);
  vi.spyOn(store, "publishSourcePath").mockImplementation((...args) => {
    const before = performance.now(); try { return originalPublishSourcePath(...args); } finally { pathPublishMs += performance.now() - before; }
  });
  const exec = store.db.exec.bind(store.db);
  let beginAt: number | undefined;
  store.db.exec = ((sql: string) => {
    const before = performance.now();
    try { return exec(sql); }
    finally {
      if (sql === "BEGIN IMMEDIATE") beginAt = performance.now();
      else if ((sql === "COMMIT" || sql === "ROLLBACK") && beginAt !== undefined) { counts.beginCommitMs += performance.now() - before; beginAt = undefined; }
    }
  }) as typeof store.db.exec;

  const writer = spawn(process.execPath, [resolve("tests/hosts/cc-67-writer.mjs"), config.dbPath, "8"],
    { stdio: ["ignore", "ignore", "inherit", "ipc"] });
  // A failed assertion before the normal stop must not leave the writer running after the test.
  onTestFinished(() => { if (writer.exitCode === null) writer.kill(); });
  const finished = new Promise<any>((resolveDone, reject) => {
    writer.on("message", (message: any) => { if (message.type === "done") resolveDone(message); });
    writer.on("error", reject);
  });
  await new Promise<void>((resolveReady, reject) => {
    writer.on("message", (message: any) => { if (message.type === "ready") resolveReady(); });
    writer.once("error", reject);
  });

  const phases: Record<string, { wallMs: number; longestGapMs: number }> = {};
  let readMs = 0, indexMs = 0, ingestStart = 0, longestIngestGap = 0;
  const readStart = performance.now();
  const started = performance.now();
  const result = await importer.reconcile(undefined, {
    onPhase: (phase, ms) => { if (phase === "read") readMs = ms; else if (phase === "index") { indexMs = ms; ingestStart = performance.now(); } },
    onIngestGap: ms => { longestIngestGap = Math.max(longestIngestGap, ms); },
  });
  // publishSourcePath runs after the cooperative scan loop returns but before reconcile() resolves;
  // pull its own measured time back out of the ingest span so the two phases do not overlap.
  const ingestMs = performance.now() - ingestStart - pathPublishMs;
  const totalMs = performance.now() - started;
  expect(result.state).toBe("ready");
  expect(result.appendedEntryIds).toHaveLength(30_000);
  phases.read = { wallMs: readMs, longestGapMs: 0 };
  phases["parse/index/sort"] = { wallMs: indexMs, longestGapMs: 0 };
  phases.ingest = { wallMs: ingestMs, longestGapMs: longestIngestGap };
  phases["path publish"] = { wallMs: pathPublishMs, longestGapMs: pathPublishMs };
  // The heartbeat bound gated for the ingest phase only: the longest gap stays near the slice
  // length (40 ms), not the whole multi-second scan.
  expect(longestIngestGap).toBeLessThan(100);
  // Lookups removed by the dedup fixes stay removed: getTurn 165,000 -> 105,000 (appendTurn's and
  // updateTurn's own before/after reads are untouched; bindNativeTurn's, appendSourceEntry's and
  // ingest's owner-check/assistant-text-append's duplicate-within-one-call reads are gone).
  // findSourceEntry+getSourceEntry 90,000 -> 60,000 (appendSourceEntry's internal duplicate check is
  // skipped when the importer already knows the answer). enrollment 60,000 -> 30,003 (memoized once
  // per transaction instead of once per write method's own check).
  expect(counts.getTurn).toBe(105_000);
  // 74 answers the importer's known-entry check from the digest index (findKnownSourceEntry), so
  // the full-row lookups halve from 70's 60,000; only the post-append row read remains.
  expect(counts.findSourceEntry + counts.getSourceEntry).toBe(30_000);
  expect(counts.enrollment).toBe(30_003);

  if (writer.connected) writer.send("stop", () => {});
  const writerResult = await finished;
  importer.close();
  rmSync(dir, { recursive: true, force: true });

  console.log(JSON.stringify({ fixture: "70 bootstrap 30k", totalMs, phases, readMs, indexMs, ingestMs,
    counts, writerWorstWaitDuringIngestMs: writerResult.maxMs, writerWrites: writerResult.writes,
    writerError: writerResult.error }));
  expect(writerResult.error).toBeUndefined();
  // The wait-time acceptance gate ("under 1 s in five consecutive runs of the single file", ticket
  // 70) is measured by running this file alone five times in a row (reported in the ticket's
  // implementation report), where it holds with a wide margin (measured 139-467 ms). Embedded in the
  // full suite (`npm test -- --maxWorkers=2`), unrelated test files' own CPU load shares this
  // machine and can push the writer's wait higher (observed up to ~1.15 s); this in-suite bound
  // stays a loose regression gate — still a large improvement on the pre-70 baseline (4.8-5.15 s, or
  // `database is locked`) — rather than re-asserting the tighter isolated-run number here.
  expect(writerResult.maxMs).toBeLessThan(3_000);
}, 60_000);
