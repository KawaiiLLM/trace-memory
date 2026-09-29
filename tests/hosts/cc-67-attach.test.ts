import { afterEach, expect, test, vi } from "vitest";
import { existsSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { resolveCcHostConfig } from "../../src/hosts/cc/config.ts";
import { readBinding, recordSessionStart, updateBinding, withCcBindingLock } from "../../src/hosts/cc/binding.ts";
import { CcCoordinator } from "../../src/hosts/cc/lifecycle.ts";
import { CcImporter } from "../../src/hosts/cc/importer.ts";

const dirs: string[] = [];
afterEach(() => { vi.restoreAllMocks(); for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });
async function fixture() {
  const dir = mkdtempSync(join(tmpdir(), "tm67-attach-")); dirs.push(dir);
  const nativeSessionId = "attach", transcriptPath = join(dir, "native.jsonl");
  const config = resolveCcHostConfig({ dbPath: join(dir, "memory.sqlite"), stateDir: join(dir, "s"),
    baseline: "2025-01-01T00:00:00Z", pollIntervalMs: 60_000, finalSyncTimeoutMs: 100, finalSyncStablePolls: 2 });
  writeFileSync(transcriptPath, [
    { uuid: "u", parentUuid: null, type: "user", timestamp: "2026-01-01T00:00:00Z", promptId: "p", promptSource: "sdk",
      message: { role: "user", content: "question" } },
    { uuid: "a", parentUuid: "u", type: "assistant", timestamp: "2026-01-01T00:00:01Z",
      message: { role: "assistant", content: [{ type: "text", text: "answer" }] } },
  ].map(value => JSON.stringify(value) + "\n").join(""));
  await recordSessionStart(config, { hook_event_name: "SessionStart", session_id: nativeSessionId, transcript_path: transcriptPath }, "2026-01-01T00:00:00Z");
  const diagnostics: string[] = [];
  const coordinator = new CcCoordinator(config, nativeSessionId, message => diagnostics.push(message));
  return { dir, config, nativeSessionId, coordinator, diagnostics };
}

test("failed initial reconcile disposes all resources even when facade close throws after closing Store", async () => {
  const f = await fixture();
  let failedImporter: CcImporter | undefined, socket: string | undefined;
  const reconcile = CcImporter.prototype.reconcile, close = CcImporter.prototype.close;
  const injected = vi.spyOn(CcImporter.prototype, "reconcile").mockImplementationOnce(async function (this: CcImporter) {
    failedImporter = this; socket = readBinding(f.config, f.nativeSessionId)!.executor!.socketPath;
    throw new Error("original binding failure");
  });
  vi.spyOn(CcImporter.prototype, "close").mockImplementationOnce(function (this: CcImporter) {
    close.call(this); throw new Error("cleanup after Store close");
  });
  try {
    expect(await f.coordinator.requestReconcile("startup")).toBeNull();
    expect(failedImporter!.memory.store.closed).toBe(true);
    expect(existsSync(socket!)).toBe(false);
    expect(readBinding(f.config, f.nativeSessionId)!.executor).toBeNull();
    expect(f.diagnostics.some(value => value.includes("startup-complete"))).toBe(false);
    expect(f.diagnostics.at(-1)).toContain("original binding failure");
    expect(f.diagnostics.some(value => value.includes("cleanup after Store close"))).toBe(true);
    injected.mockImplementation(reconcile);
    const resumed = await f.coordinator.requestReconcile("stat wake-up");
    expect(resumed?.state).toBe("ready");
    expect(f.diagnostics.filter(value => value.includes("startup-complete"))).toHaveLength(1);
    expect(f.diagnostics.some(value => value.includes("database is not open"))).toBe(false);
    expect(readBinding(f.config, f.nativeSessionId)!.executor!.executorId).not.toBe(failedImporter!.memory.executorId);
  } finally { await f.coordinator.shutdown("test"); }
});

test("failed attach preserves a competing executor and removes only its own socket", async () => {
  const f = await fixture();
  const competitor = { executorId: "other", pid: process.pid, token: "other-token", socketPath: join(f.dir, "other.sock"),
    startedAt: "2026-01-01T00:00:00Z" };
  writeFileSync(competitor.socketPath, "owned by competitor");
  await updateBinding(f.config, f.nativeSessionId, current => ({ ...current!, executor: competitor }));
  try {
    expect(await f.coordinator.requestReconcile("startup")).toBeNull();
    expect(readBinding(f.config, f.nativeSessionId)!.executor).toEqual(competitor);
    expect(existsSync(competitor.socketPath)).toBe(true);
    const sockets = join(f.config.stateDir, "control");
    if (existsSync(sockets)) expect(readdirSync(sockets)).toEqual([]);
    expect(f.diagnostics.some(value => value.includes("startup-complete"))).toBe(false);
    // The next ordinary wake uses a new attachment after the competing owner leaves.
    await updateBinding(f.config, f.nativeSessionId, current => ({ ...current!, executor: null }));
    expect((await f.coordinator.requestReconcile("binding watch"))?.state).toBe("ready");
  } finally { await f.coordinator.shutdown("test"); }
});

test("binding-lock timeout discards attachment and next existing wake can attach", async () => {
  const f = await fixture();
  let release!: () => void, acquired!: () => void;
  const ready = new Promise<void>(resolve => { acquired = resolve; });
  const held = withCcBindingLock(f.config, f.nativeSessionId, async () => {
    acquired(); await new Promise<void>(resolve => { release = resolve; });
  });
  await ready;
  try {
    expect(await f.coordinator.requestReconcile("startup", false, Date.now() + 20)).toBeNull();
    expect(f.diagnostics.at(-1)).toContain("timed out waiting for CC binding lock");
    expect(f.diagnostics.some(value => value.includes("startup-complete"))).toBe(false);
    expect(readBinding(f.config, f.nativeSessionId)!.executor).toBeNull();
    release(); await held;
    expect((await f.coordinator.requestReconcile("stat wake-up"))?.state).toBe("ready");
  } finally { release(); await held; await f.coordinator.shutdown("test"); }
});

test("Store-open failure does not publish readiness and a later wake creates fresh resources", async () => {
  const f = await fixture();
  writeFileSync(f.config.dbPath, "not a SQLite database");
  try {
    expect(await f.coordinator.requestReconcile("startup")).toBeNull();
    expect(f.diagnostics.some(value => value.includes("startup-complete"))).toBe(false);
    expect(readBinding(f.config, f.nativeSessionId)!.executor).toBeNull();
    rmSync(f.config.dbPath);
    expect((await f.coordinator.requestReconcile("stat wake-up"))?.state).toBe("ready");
    expect(f.diagnostics.filter(value => value.includes("startup-complete"))).toHaveLength(1);
  } finally { await f.coordinator.shutdown("test"); }
});
