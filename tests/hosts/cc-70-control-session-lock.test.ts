import { afterEach, expect, test } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resolveCcHostConfig } from "../../src/hosts/cc/config.ts";
import { readBinding, recordSessionStart } from "../../src/hosts/cc/binding.ts";
import { controlSession } from "../../src/hosts/cc/control.ts";
import { CcCoordinator } from "../../src/hosts/cc/lifecycle.ts";
import { Store } from "../../src/core/store/index.ts";
import type { CcNativeRecord } from "../../src/hosts/cc/transcript.ts";

// 70 finding 1 — the real operator path (controlSession) must not wait for the whole cooperative
// scan before it even sends `off`/`stop` over the control socket. Unlike
// tests/hosts/cc-70-cooperative-import.test.ts (which connects to the control socket directly, on
// purpose, to isolate the executor-side abort plumbing from this bug), these tests drive the real
// entry point a CLI operator uses.

const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });
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

// Same tuning as tests/hosts/cc-70-cooperative-import.test.ts: a hundred real pauses (~1s wall time)
// while the scan holds the binding lock, plenty of window for a concurrently sent control request.
const PAIRS = 60;
const TUNING = { sliceMs: 0, pauseMs: 10 };

function fixture(label: string) {
  const dir = mkdtempSync(join(tmpdir(), `tm-cc-70-ctrl-${label}-`)); dirs.push(dir);
  const stateDir = mkdtempSync(join(tmpdir(), "tmcc-70-ctrl-")); dirs.push(stateDir);
  const transcriptPath = join(dir, "native.jsonl"), nativeSessionId = `native-${label}`;
  const config = resolveCcHostConfig({ dbPath: join(dir, "memory.sqlite"), stateDir, baseline: "2025-01-01T00:00:00.000Z",
    pollIntervalMs: 100_000, finalSyncTimeoutMs: 300, finalSyncStablePolls: 2 });
  writeFileSync(transcriptPath, records(PAIRS).map(line).join(""));
  return { dir, transcriptPath, nativeSessionId, config };
}

function entryCount(dbPath: string): number {
  const store = new Store(dbPath);
  try { return (store.db.prepare("SELECT count(*) AS n FROM source_entries").get() as { n: number }).n; }
  finally { store.close(); }
}

test("controlSession off is acknowledged promptly while a cooperative import holds the binding lock", async () => {
  const f = fixture("off");
  await recordSessionStart(f.config, { hook_event_name: "SessionStart", session_id: f.nativeSessionId,
    transcript_path: f.transcriptPath }, at(0));
  const coordinator = new CcCoordinator(f.config, f.nativeSessionId, () => {}, TUNING);
  try {
    const starting = coordinator.start();
    await sleep(30); // well inside the ~600ms+ scan window at 120 records * 10ms pauses
    const before = entryCount(f.config.dbPath);
    const startedAt = Date.now();
    const result = await controlSession(f.config, f.nativeSessionId, "off");
    const elapsed = Date.now() - startedAt;
    expect(result.state).toBe("acknowledged");
    // A full unaborted scan of this fixture takes well over half a second; a prompt ack proves
    // controlSession did not wait behind the scan's binding lock hold before even sending `off`.
    expect(elapsed).toBeLessThan(400);
    await starting;
    const afterAck = entryCount(f.config.dbPath);
    await sleep(50);
    expect(entryCount(f.config.dbPath)).toBe(afterAck); // nothing imports after the acknowledgement
    expect(afterAck).toBeLessThan(PAIRS * 2); // aborted mid-scan, not a completed import
    expect(afterAck).toBeGreaterThanOrEqual(before);
    expect(readBinding(f.config, f.nativeSessionId)!.enrollment.choice).toBe(false);
  } finally { await coordinator.shutdown("test"); }
});

test("controlSession stop is acknowledged promptly while the import finishes", async () => {
  const f = fixture("stop");
  await recordSessionStart(f.config, { hook_event_name: "SessionStart", session_id: f.nativeSessionId,
    transcript_path: f.transcriptPath }, at(0));
  const coordinator = new CcCoordinator(f.config, f.nativeSessionId, () => {}, TUNING);
  try {
    const starting = coordinator.start();
    await sleep(30);
    const midScan = entryCount(f.config.dbPath);
    const startedAt = Date.now();
    const result = await controlSession(f.config, f.nativeSessionId, "stop");
    const elapsed = Date.now() - startedAt;
    expect(result.state).toBe("acknowledged");
    expect(elapsed).toBeLessThan(400);
    await starting;
    // stop does not abort ingestion: the scan reached every record despite the control round trip.
    expect(midScan).toBeLessThan(PAIRS * 2);
    expect(entryCount(f.config.dbPath)).toBe(PAIRS * 2);
  } finally { await coordinator.shutdown("test"); }
});
