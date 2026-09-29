import { afterEach, expect, test, vi } from "vitest";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resolveCcHostConfig } from "../../src/hosts/cc/config.ts";
import { readBinding, recordSessionStart } from "../../src/hosts/cc/binding.ts";
import { CcCoordinator } from "../../src/hosts/cc/lifecycle.ts";
import { handleCcHook } from "../../src/hosts/cc/index.ts";
import { assignedNativeSession, followNativeSession, nativeSessionPath, processAncestors, publishNativeSession,
  type CcNativeSessionRecord } from "../../src/hosts/cc/native-session.ts";
import type { CcNativeRecord } from "../../src/hosts/cc/transcript.ts";

// 65: the SessionStart Hook's session id is authoritative; an executor started with another
// `CLAUDE_CODE_SESSION_ID` (the interactive `claude -r` picker) follows the Hook's before attaching.

const dirs: string[] = [];
afterEach(() => { vi.unstubAllEnvs(); for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });
const now = "2026-01-01T00:00:00.000Z";
const sleep = (milliseconds: number) => new Promise(resolve => setTimeout(resolve, milliseconds));
function fixture(label: string) {
  const dir = mkdtempSync(join(tmpdir(), `tm-cc-native-${label}-`)); dirs.push(dir);
  const transcriptPath = join(dir, "native.jsonl");
  // Control sockets live under stateDir: keep it short enough for a Unix-domain path.
  const stateDir = mkdtempSync(join(tmpdir(), "tmcc-n-")); dirs.push(stateDir);
  const config = resolveCcHostConfig({ dbPath: join(dir, "memory.sqlite"), stateDir, baseline: "2025-01-01T00:00:00.000Z",
    pollIntervalMs: 10, finalSyncTimeoutMs: 300, finalSyncStablePolls: 2 });
  const records: CcNativeRecord[] = [
    { uuid: "u1", parentUuid: null, type: "user", timestamp: now, promptId: "p1", promptSource: "sdk", userType: "external", message: { role: "user", content: "question" } },
    { uuid: "a1", parentUuid: "u1", type: "assistant", timestamp: "2026-01-01T00:00:01.000Z", message: { role: "assistant", content: [{ type: "text", text: "answer" }] } },
    { type: "last-prompt", leafUuid: "a1" },
  ];
  writeFileSync(transcriptPath, records.map(record => `${JSON.stringify(record)}\n`).join(""));
  const hook = (session_id: string, source: "startup" | "resume" = "resume") => ({ hook_event_name: "SessionStart" as const, session_id, transcript_path: transcriptPath, source });
  return { dir, config, transcriptPath, hook };
}
const until = async (condition: () => boolean, timeoutMs = 3_000) => {
  const deadline = Date.now() + timeoutMs;
  while (!condition()) { if (Date.now() > deadline) throw new Error("condition not met in time"); await sleep(10); }
};

test("the Hook publishes the native process's session and the closest live ancestor's record is the assignment", () => {
  const f = fixture("publish");
  expect(publishNativeSession(f.config, f.hook("chosen"), null)).toBeNull();
  expect(existsSync(join(f.config.stateDir, "native-sessions"))).toBe(false);
  const published = publishNativeSession(f.config, f.hook("chosen"), 424242)!;
  expect(published).toMatchObject({ version: 1, pid: 424242, nativeSessionId: "chosen", transcriptPath: f.transcriptPath, source: "resume" });
  expect(existsSync(nativeSessionPath(f.config, 424242))).toBe(true);
  // A dead pid has no start time on either side: matched on pid alone.
  expect(assignedNativeSession(f.config, [{ pid: 424242, startedAt: null }])?.nativeSessionId).toBe("chosen");
  // The record's start time disagrees with the live process: a reused pid, ignored.
  writeFileSync(nativeSessionPath(f.config, 424242), JSON.stringify({ ...published, startedAt: "Mon Jan  1 00:00:00 2026" }));
  expect(assignedNativeSession(f.config, [{ pid: 424242, startedAt: "Tue Jan  2 00:00:00 2026" }])).toBeNull();
  expect(assignedNativeSession(f.config, [{ pid: 424242, startedAt: "Mon Jan  1 00:00:00 2026" }])?.nativeSessionId).toBe("chosen");
  // Closest ancestor first: a wrapper between executor and Claude Code has no record, its parent has.
  publishNativeSession(f.config, f.hook("outer"), 424243);
  expect(assignedNativeSession(f.config, [{ pid: 424241, startedAt: null }, { pid: 424243, startedAt: null }, { pid: 424242, startedAt: null }])?.nativeSessionId).toBe("outer");
  const ancestors = processAncestors(3, pid => pid === 100 ? 50 : pid === 50 ? 1 : null, 100);
  expect(ancestors.map(ancestor => ancestor.pid)).toEqual([100, 50]);
});

test("an executor started with the picker's id adopts the Hook's id and attaches to that binding", async () => {
  const f = fixture("adopt");
  await recordSessionStart(f.config, f.hook("chosen"), now);
  const diagnostics: string[] = [];
  const coordinator = new CcCoordinator(f.config, "fresh-picker-id", message => diagnostics.push(message));
  const adopted: string[] = [];
  const follower = followNativeSession(f.config, [{ pid: 515151, startedAt: null }], record => {
    if (!coordinator.adoptNativeSessionId(record.nativeSessionId)) adopted.push(`refused:${record.nativeSessionId}`);
    else adopted.push(record.nativeSessionId);
  }, message => diagnostics.push(message), 10);
  try {
    await coordinator.start();
    await sleep(50);
    expect(coordinator.nativeSessionId).toBe("fresh-picker-id");
    expect(readBinding(f.config, "fresh-picker-id")).toBeNull();
    expect(readBinding(f.config, "chosen")!.executor).toBeNull();
    // The Hook fires once the user picks the session: the executor follows and attaches.
    publishNativeSession(f.config, f.hook("chosen"), 515151);
    await until(() => readBinding(f.config, "chosen")?.executor !== null);
    expect(coordinator.nativeSessionId).toBe("chosen");
    expect(adopted).toEqual(["chosen"]);
    expect(readBinding(f.config, "chosen")!.executor!.pid).toBe(process.pid);
    expect(diagnostics.some(message => message.includes("session-id-adopted") && message.includes("fresh-picker-id"))).toBe(true);
    // After attach a differing assignment is refused: following it is `retargetTo` (102).
    publishNativeSession(f.config, f.hook("cleared", "startup"), 515151);
    await until(() => adopted.length === 2);
    expect(adopted[1]).toBe("refused:cleared");
    expect(coordinator.nativeSessionId).toBe("chosen");
    expect(readBinding(f.config, "cleared")).toBeNull();
  } finally { follower.stop(); await coordinator.shutdown("test"); }
});

test("an assignment already published before start is adopted before the first reconcile", async () => {
  const f = fixture("early");
  await recordSessionStart(f.config, f.hook("chosen", "startup"), now);
  publishNativeSession(f.config, f.hook("chosen", "startup"), 616161);
  const diagnostics: string[] = [];
  const coordinator = new CcCoordinator(f.config, "env-id", m => diagnostics.push(m));
  const follower = followNativeSession(f.config, [{ pid: 616161, startedAt: null }], record => { coordinator.adoptNativeSessionId(record.nativeSessionId); }, m => diagnostics.push(m), 10);
  try {
    expect(coordinator.nativeSessionId).toBe("chosen");
    await coordinator.start();
    expect(readBinding(f.config, "chosen")!.executor!.pid).toBe(process.pid);
  } finally { follower.stop(); await coordinator.shutdown("test"); }
});

test("handleCcHook publishes under CLAUDE_PID and skips the publish without it", async () => {
  const f = fixture("hook");
  vi.stubEnv("CLAUDE_PID", "");
  const quiet = vi.spyOn(console, "error").mockImplementation(() => {});
  try {
    await handleCcHook(f.config, f.hook("chosen", "startup"));
    expect(existsSync(join(f.config.stateDir, "native-sessions"))).toBe(false);
    expect(quiet.mock.calls.some(call => String(call[0]).includes("CLAUDE_PID is not set"))).toBe(true);
    vi.stubEnv("CLAUDE_PID", "717171");
    await handleCcHook(f.config, f.hook("chosen"));
    const record = JSON.parse(require("node:fs").readFileSync(nativeSessionPath(f.config, 717171), "utf8")) as CcNativeSessionRecord;
    expect(record).toMatchObject({ pid: 717171, nativeSessionId: "chosen", source: "resume" });
  } finally { quiet.mockRestore(); }
});
