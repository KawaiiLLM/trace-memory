import { afterEach, expect, test, vi } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

const provider = vi.hoisted(() => {
  const calls: { model: string; thinking: string; task: any; release: () => void }[] = [];
  return { calls };
});
vi.mock("../../src/hosts/cc/worker.ts", () => ({
  createCcRunAgent: (config: any) => async (task: any) => {
    await new Promise<void>(resolve => provider.calls.push({ model: config.worker.phases[task.kind].model,
      thinking: config.worker.phases[task.kind].thinking, task, release: resolve }));
    expect(task.kind).toBe("noting");
    task.tools.find((tool: any) => tool.name === "note")!.execute({ facts: [] });
    task.tools.find((tool: any) => tool.name === "memory")!.execute({ operations: [], skipped: [] });
    return { outcome: "success", output: "mock provider completed", request: { mock: true } };
  },
}));
import { resolveCcHostConfig } from "../../src/hosts/cc/config.ts";
import { readBinding, recordSessionStart } from "../../src/hosts/cc/binding.ts";
import { executorSettings } from "../../src/hosts/cc/control.ts";
import { CcCoordinator } from "../../src/hosts/cc/lifecycle.ts";
import { runCcCommand } from "../../src/hosts/cc/index.ts";
import { readCcMenu } from "../../src/hosts/cc/menu.ts";

const dirs: string[] = [];
afterEach(() => { for (const call of provider.calls) call.release(); provider.calls.length = 0;
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });
const tick = async (condition: () => boolean) => {
  for (let i = 0; i < 100 && !condition(); i++) await new Promise(resolve => setTimeout(resolve, 10));
  expect(condition()).toBe(true);
};

test("CLI apply leaves held provider on old settings and next admission takes new settings without edit-triggered launch", async () => {
  const dir = mkdtempSync(join(tmpdir(), "cc82-hot-")); dirs.push(dir);
  const path = join(dir, "cc.config.json"), transcript = join(dir, "native.jsonl"), native = "cc82-hot";
  const base = { dbPath: join(dir, "memory.sqlite"), stateDir: join(dir, "state"),
    baseline: "2025-01-01T00:00:00.000Z", pollIntervalMs: 100_000, finalSyncTimeoutMs: 100,
    finalSyncStablePolls: 1, "noting.triggerTokens": 1, "consolidation.triggerTokens": 50_000,
    notingModel: "claude-sonnet-5", notingThinking: "high", consolidationModel: "claude-sonnet-5",
    consolidationThinking: "high", "dreaming.model": "claude-sonnet-5", "dreaming.thinking": "high",
    worker: { claudeExecutable: "/usr/bin/false", claudeVersion: "2.1.280", cwd: dir,
      contextWindows: { "claude-sonnet-5": 200_000 } } };
  writeFileSync(path, `${JSON.stringify(base, null, 2)}\n`);
  const config = resolveCcHostConfig(base);
  const records = [
    { uuid: "u1", parentUuid: null, type: "user", promptId: "p1", promptSource: "typed", userType: "external",
      timestamp: "2026-01-01T00:00:00.000Z", message: { role: "user", content: "first request" } },
    { uuid: "a1", parentUuid: "u1", type: "assistant", timestamp: "2026-01-01T00:00:01.000Z",
      message: { role: "assistant", content: [{ type: "text", text: "first answer" }] } },
  ];
  const publish = () => writeFileSync(transcript, [...records, { type: "last-prompt", leafUuid: records.at(-1)!.uuid }]
    .map(record => `${JSON.stringify(record)}\n`).join(""));
  publish();
  await recordSessionStart(config, { hook_event_name: "SessionStart", session_id: native,
    transcript_path: transcript, source: "startup" }, "2026-01-01T00:00:00.000Z");
  const coordinator = new CcCoordinator(config, native, () => {});
  try {
    await coordinator.start();
    await tick(() => provider.calls.length === 1);
    expect(provider.calls[0]).toMatchObject({ model: "claude-sonnet-5", thinking: "high" });
    const output: string[] = [], write = process.stdout.write.bind(process.stdout);
    const spy = vi.spyOn(process.stdout, "write").mockImplementation((data: string | Uint8Array) => { output.push(String(data)); return true; });
    try { await runCcCommand(["cli", "--config", path, "--session", native, "setting", "noting.thinking", "medium"]); }
    finally { spy.mockRestore(); void write; }
    expect(JSON.parse(output.at(-1)!)).toMatchObject({ saved: true, applied: true });
    expect(provider.calls).toHaveLength(1); // The setting edit itself is never an opportunity.
    const effective = await executorSettings(config, native) as typeof config;
    expect(effective.worker!.phases.noting.thinking).toBe("medium");
    expect(provider.calls[0]!.thinking).toBe("high");
    // A hand-edited trigger cannot be applied by the phase-settings control seam. Save succeeds,
    // but the live executor must still report the old settings rather than claiming the whole file.
    const manuallyChanged = { ...base, notingThinking: "medium", "noting.triggerTokens": 2 };
    writeFileSync(path, `${JSON.stringify(manuallyChanged, null, 2)}\n`);
    const rejected: string[] = [];
    const rejectSpy = vi.spyOn(process.stdout, "write").mockImplementation((data: string | Uint8Array) => { rejected.push(String(data)); return true; });
    try { await runCcCommand(["cli", "--config", path, "--session", native, "setting", "noting.thinking", "low"]); }
    finally { rejectSpy.mockRestore(); }
    expect(JSON.parse(rejected.at(-1)!)).toMatchObject({ saved: true, applied: false });
    expect(JSON.parse(rejected.at(-1)!).diagnostic).toContain("noting.triggerTokens");
    expect((await executorSettings(config, native) as typeof config).worker!.phases.noting.thinking).toBe("medium");
    expect(provider.calls).toHaveLength(1);
    const core = readBinding(config, native)!.coreSessionId!;
    const menu = readCcMenu(resolveCcHostConfig({ ...manuallyChanged, notingThinking: "low" }), native, effective);
    expect(menu.settings.workers[0]!.sources?.thinking).toBe("saved file differs from running executor");
    expect(menu.menu.header.session).toBe(`S${core}`);
    provider.calls[0]!.release();
    await tick(() => (coordinator as unknown as { scheduler: { running(): string[] } }).scheduler.running().length === 0);
    records.push({ uuid: "u2", parentUuid: "a1", type: "user", promptId: "p2", promptSource: "typed", userType: "external",
      timestamp: "2026-01-01T00:00:02.000Z", message: { role: "user", content: "second request" } } as any);
    records.push({ uuid: "a2", parentUuid: "u2", type: "assistant", timestamp: "2026-01-01T00:00:03.000Z",
      message: { role: "assistant", content: [{ type: "text", text: "second answer" }] } } as any);
    publish(); await coordinator.requestReconcile("new completed entry");
    await tick(() => provider.calls.length === 2);
    expect(provider.calls[1]).toMatchObject({ model: "claude-sonnet-5", thinking: "medium" });
    provider.calls[1]!.release();
  } finally { for (const call of provider.calls) call.release(); await coordinator.shutdown("test done"); }
});
