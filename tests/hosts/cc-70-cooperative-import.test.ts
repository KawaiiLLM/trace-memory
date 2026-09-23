import { afterEach, expect, test, vi } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createConnection } from "node:net";
import { resolveCcHostConfig } from "../../src/hosts/cc/config.ts";
import { readBinding, recordSessionStart, type CcExecutorBinding } from "../../src/hosts/cc/binding.ts";
import { CcCoordinator } from "../../src/hosts/cc/lifecycle.ts";
import { CcImporter } from "../../src/hosts/cc/importer.ts";
import { handleCcHook } from "../../src/hosts/cc/index.ts";
import { publishNativeSession } from "../../src/hosts/cc/native-session.ts";
import { Store } from "../../src/core/store/index.ts";
import type { CcNativeRecord } from "../../src/hosts/cc/transcript.ts";

// 70: cooperative import — the scan pauses between per-record transactions (43a stays: one
// transaction per record, none open when a record's visit begins) so other writers make progress
// and the importing executor's own event loop stays responsive. These tests use small tuned
// slice/pause constants (real setTimeout pauses, not fake timers) so a fixture of a few hundred
// records reliably produces several real pauses inside a fast test, instead of waiting out a
// production-scale (30k-record) scan; tests/hosts/cc-70-cooperative-import-perf.test.ts covers the
// production constants and the wait-time/phase/CPU-profile acceptance criteria at that scale.

const dirs: string[] = [];
afterEach(() => { vi.unstubAllEnvs(); for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });
const sleep = (milliseconds: number) => new Promise(resolve => setTimeout(resolve, milliseconds));
const at = (second: number) => `2026-03-01T00:${String(Math.floor(second / 60)).padStart(2, "0")}:${String(second % 60).padStart(2, "0")}.000Z`;
const line = (value: unknown) => `${JSON.stringify(value)}\n`;
const sdkPrompt = (promptId: string) => ({ promptId, promptSource: "sdk", userType: "external" });

function records(pairs: number): CcNativeRecord[] {
  const values: CcNativeRecord[] = [];
  let parent: string | null = null;
  for (let index = 0; index < pairs; index++) {
    const user = `u${index}`, assistant = `a${index}`;
    values.push({ uuid: user, parentUuid: parent, type: "user", timestamp: at(index * 2), ...sdkPrompt(`p${index}`),
      message: { role: "user", content: `question ${index}` } });
    values.push({ uuid: assistant, parentUuid: user, type: "assistant", timestamp: at(index * 2 + 1),
      message: { role: "assistant", content: [{ type: "text", text: `answer ${index}` }] } });
    parent = assistant;
  }
  return values;
}

// Small enough to run fast, large enough that at sliceMs=0/pauseMs=10 the scan holds the binding
// lock across on the order of a hundred real pauses (~1s wall time) — plenty of window for a
// concurrently sent control request to land mid-ingest without racing exact timing.
const PAIRS = 60;
const TUNING = { sliceMs: 0, pauseMs: 10 };

function fixture(label: string) {
  const dir = mkdtempSync(join(tmpdir(), `tm-cc-70-${label}-`)); dirs.push(dir);
  const stateDir = mkdtempSync("/tmp/tmcc-70-"); dirs.push(stateDir);
  const transcriptPath = join(dir, "native.jsonl"), nativeSessionId = `native-${label}`;
  const config = resolveCcHostConfig({ dbPath: join(dir, "memory.sqlite"), stateDir, baseline: "2025-01-01T00:00:00.000Z",
    pollIntervalMs: 100_000, finalSyncTimeoutMs: 300, finalSyncStablePolls: 2 });
  const values = records(PAIRS);
  writeFileSync(transcriptPath, values.map(line).join(""));
  return { dir, transcriptPath, nativeSessionId, config, values,
    write: (extra: CcNativeRecord[]) => writeFileSync(transcriptPath, [...values, ...extra].map(line).join("")) };
}

const directControl = (executor: CcExecutorBinding, verb: unknown): Promise<any> =>
  new Promise((resolveReply, reject) => {
    const socket = createConnection(executor.socketPath); let output = "";
    socket.setEncoding("utf8");
    socket.on("connect", () => socket.write(`${JSON.stringify({ verb, token: executor.token })}\n`));
    socket.on("data", chunk => output += chunk);
    socket.on("end", () => { try { resolveReply(JSON.parse(output)); } catch (error) { reject(error); } });
    socket.on("error", reject);
  });

function entryCount(dbPath: string): number {
  const store = new Store(dbPath);
  try { return (store.db.prepare("SELECT count(*) AS n FROM source_entries").get() as { n: number }).n; }
  finally { store.close(); }
}

test("a failure injected after a real pause leaves the offset unadvanced; the next wake-up completes without duplicating committed records", async () => {
  const f = fixture("failure-after-pause");
  const binding = await recordSessionStart(f.config, { hook_event_name: "SessionStart", session_id: f.nativeSessionId,
    transcript_path: f.transcriptPath }, at(0));
  const importer = new CcImporter(f.config, binding);
  const internal = (importer as unknown as { projection: { transcript: { scanCooperative: Function } } }).projection.transcript;
  const original = internal.scanCooperative.bind(internal);
  let visits = 0;
  internal.scanCooperative = (path: string, visit: Function, options?: unknown) => original(path, (...args: unknown[]) => {
    visits += 1;
    if (visits === 5) throw new Error("synthetic failure injected after a real pause");
    return visit(...args);
  }, options);
  try {
    await expect(importer.reconcile(undefined, TUNING)).rejects.toThrow("synthetic failure injected after a real pause");
    // 4 records committed (visits 1-4) before the 5th's synthetic throw; a pause preceded every visit
    // at sliceMs 0, so the failure landed after a real pause with no transaction open.
    const partial = entryCount(f.config.dbPath);
    expect(partial).toBeGreaterThan(0);
    expect(partial).toBeLessThan(PAIRS * 2);
    internal.scanCooperative = original; // undo the injected failure for the retry
    const resumed = await importer.reconcile();
    expect(resumed.state).toBe("ready");
    expect(resumed.selectedEntryIds).toHaveLength(PAIRS * 2);
    expect(entryCount(f.config.dbPath)).toBe(PAIRS * 2);
    const store = importer.memory.store;
    const duplicates = store.db.prepare(
      "SELECT native_id, count(*) AS n FROM source_entries GROUP BY native_id HAVING n > 1").all();
    expect(duplicates).toEqual([]);
  } finally { importer.close(); }
});

test("off aborts the scan at its next real-pause resume, then persists and acknowledges; nothing imports after the acknowledgement", async () => {
  const f = fixture("off-mid-ingest");
  await recordSessionStart(f.config, { hook_event_name: "SessionStart", session_id: f.nativeSessionId,
    transcript_path: f.transcriptPath }, at(0));
  const diagnostics: string[] = [];
  const coordinator = new CcCoordinator(f.config, f.nativeSessionId, message => diagnostics.push(message), TUNING);
  try {
    const starting = coordinator.start();
    await sleep(30); // well inside the ~600ms+ scan window at 120 records * 10ms pauses
    const executor = readBinding(f.config, f.nativeSessionId)!.executor!;
    const before = entryCount(f.config.dbPath);
    // The raw control socket, not the `controlSession` operator helper: that helper's own two
    // binding-lock reads would otherwise queue behind the running scan's lock before ever reaching
    // the abort, which is exactly the starvation this ticket removes for every *other* writer.
    const reply = await directControl(executor, "off");
    expect(reply).toMatchObject({ ok: true, verb: "off" });
    await starting; // the aborted startup reconcile settles (as null) promptly after the ack
    expect(diagnostics.some(message => message.includes('"startup-cancelled"'))).toBe(true);
    const afterAck = entryCount(f.config.dbPath);
    await sleep(50);
    // Nothing imports after the acknowledgement: enrollment is off and no reconcile is queued.
    expect(entryCount(f.config.dbPath)).toBe(afterAck);
    expect(afterAck).toBeLessThan(PAIRS * 2); // aborted mid-scan, not a completed import
    expect(afterAck).toBeGreaterThanOrEqual(before);
    expect(readBinding(f.config, f.nativeSessionId)!.enrollment.choice).toBe(false);
  } finally { await coordinator.shutdown("test"); }
});

test("stop during ingest does not abort the scan; the import finishes", async () => {
  const f = fixture("stop-mid-ingest");
  await recordSessionStart(f.config, { hook_event_name: "SessionStart", session_id: f.nativeSessionId,
    transcript_path: f.transcriptPath }, at(0));
  const coordinator = new CcCoordinator(f.config, f.nativeSessionId, () => {}, TUNING);
  try {
    const starting = coordinator.start();
    await sleep(30);
    const executor = readBinding(f.config, f.nativeSessionId)!.executor!;
    const midScan = entryCount(f.config.dbPath);
    const reply = await directControl(executor, "stop");
    expect(reply).toMatchObject({ ok: true, verb: "stop" });
    await starting;
    // The control round trip for "stop" completed while the scan was still importing (the executor
    // stayed responsive); the import itself was not aborted and reached every record.
    expect(midScan).toBeLessThan(PAIRS * 2);
    expect(entryCount(f.config.dbPath)).toBe(PAIRS * 2);
  } finally { await coordinator.shutdown("test"); }
});

test("executor shutdown aborts a scan running across a real pause instead of waiting behind it", async () => {
  const f = fixture("shutdown-mid-ingest");
  await recordSessionStart(f.config, { hook_event_name: "SessionStart", session_id: f.nativeSessionId,
    transcript_path: f.transcriptPath }, at(0));
  const diagnostics: string[] = [];
  const coordinator = new CcCoordinator(f.config, f.nativeSessionId, message => diagnostics.push(message), TUNING);
  const starting = coordinator.start();
  await sleep(30);
  const startupStillRunning = entryCount(f.config.dbPath) < PAIRS * 2;
  const result = await coordinator.shutdown("test shutdown");
  await starting;
  // Shutdown aborted the startup scan (observed as a cancelled reconcile, not a natural completion)
  // instead of waiting for it behind the binding lock across every remaining cooperative pause.
  expect(startupStillRunning).toBe(true);
  expect(diagnostics.some(message => message.includes('"startup-cancelled"'))).toBe(true);
  expect(result.confirmed).toBe(false); // the transcript never finished importing before shutdown
});

test("a selected-path retarget aborts a scan running across a real pause instead of waiting behind it", async () => {
  const dir = mkdtempSync(join(tmpdir(), "tm-cc-70-retarget-")); dirs.push(dir);
  const stateDir = mkdtempSync("/tmp/tmcc-70-retarget-"); dirs.push(stateDir);
  const config = resolveCcHostConfig({ dbPath: join(dir, "memory.sqlite"), stateDir, baseline: "2025-01-01T00:00:00.000Z",
    pollIntervalMs: 100_000, finalSyncTimeoutMs: 300, finalSyncStablePolls: 2 });
  const parentId = "retarget-parent", childId = "retarget-child";
  const parentPath = join(dir, "parent.jsonl"), childPath = join(dir, "child.jsonl");
  const seed = records(1); // small: the initial startup and the clear Hook's own resync stay fast
  writeFileSync(parentPath, seed.map(line).join(""));
  writeFileSync(childPath, "");
  vi.stubEnv("CLAUDE_PID", "90099");
  const parentInput = { hook_event_name: "SessionStart" as const, session_id: parentId, transcript_path: parentPath };
  await recordSessionStart(config, parentInput, at(0));
  publishNativeSession(config, parentInput, 90099);
  const diagnostics: string[] = [];
  const coordinator = new CcCoordinator(config, parentId, message => diagnostics.push(message), TUNING);
  try {
    await coordinator.start(); // small seed transcript: allocates the core session and finishes fast
    // clearedFrom is only assigned once the parent has an allocated core session (ccHandleClear's
    // non-provisional branch), which requires the seed import above to have run first.
    await handleCcHook(config, { hook_event_name: "SessionStart", source: "clear", session_id: childId, transcript_path: childPath });
    const beforeGrow = entryCount(config.dbPath);
    // Grow the parent transcript well past the seed and start a fresh (tuned, pausing) reconcile of
    // it — this is the scan retargetTo must abort instead of waiting behind.
    writeFileSync(parentPath, [...seed, ...records(PAIRS).slice(2)].map(line).join(""));
    const growing = coordinator.requestReconcile("grown parent transcript");
    await sleep(30); // well inside the growing scan's real-pause window
    const stillGrowing = entryCount(config.dbPath) < PAIRS * 2;
    const retargeted = await coordinator.retargetTo(childId);
    await growing;
    expect(stillGrowing).toBe(true);
    expect(entryCount(config.dbPath)).toBeGreaterThanOrEqual(beforeGrow);
    expect(retargeted).toBe(true);
    expect(coordinator.nativeSessionId).toBe(childId);
    // The growing parent scan was aborted (observed as a cancelled reconcile), not waited out, before
    // the retarget itself ran.
    expect(diagnostics.some(message => message.includes('"startup-cancelled"') && message.includes("grown parent transcript"))).toBe(true);
  } finally { await coordinator.shutdown("test"); }
});
