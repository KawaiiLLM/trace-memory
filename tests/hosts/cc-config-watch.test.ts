import { afterEach, expect, test, vi } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { spawn, type ChildProcess } from "node:child_process";

const provider = vi.hoisted(() => {
  const calls: { model: string; thinking: string; task: any; release: () => void }[] = [];
  return { calls };
});
vi.mock("../../src/hosts/cc/worker.ts", () => ({
  createCcRunAgent: (config: any) => async (task: any) => {
    await new Promise<void>(resolveCall => provider.calls.push({ model: config.worker.phases[task.kind].model,
      thinking: config.worker.phases[task.kind].thinking, task, release: resolveCall }));
    task.tools.find((tool: any) => tool.name === "note")!.execute({ facts: [] });
    task.tools.find((tool: any) => tool.name === "memory")!.execute({ operations: [], skipped: [] });
    return { outcome: "success", output: "mock provider completed", request: { mock: true } };
  },
}));
import { resolveCcHostConfig } from "../../src/hosts/cc/config.ts";
import { recordSessionStart } from "../../src/hosts/cc/binding.ts";
import { executorSettings } from "../../src/hosts/cc/control.ts";
import { CcCoordinator } from "../../src/hosts/cc/lifecycle.ts";
import { editedCcConfig, saveCcConfig } from "../../src/hosts/cc/menu-config.ts";
import { readFileSync } from "node:fs";

const dirs: string[] = [], children: ChildProcess[] = [];
afterEach(() => {
  for (const call of provider.calls) call.release();
  provider.calls.length = 0;
  for (const child of children.splice(0)) child.kill("SIGKILL");
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});
const until = async (condition: () => boolean | Promise<boolean>, what: string, limit = 5_000) => {
  const started = Date.now();
  while (!(await condition())) {
    if (Date.now() - started > limit) throw new Error(`timed out waiting for ${what}`);
    await new Promise(r => setTimeout(r, 20));
  }
};
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

const base = (dir: string) => ({ dbPath: join(dir, "memory.sqlite"), stateDir: join(dir, "state"),
  baseline: "2025-01-01T00:00:00.000Z", pollIntervalMs: 100_000, finalSyncTimeoutMs: 100, finalSyncStablePolls: 1,
  "noting.triggerTokens": 1, notingModel: "claude-sonnet-5", notingThinking: "high",
  "dreaming.model": "claude-sonnet-5", "dreaming.thinking": "high",
  worker: { claudeExecutable: "/usr/bin/false", cwd: dir, contextWindows: { "claude-sonnet-5": 200_000 } } });
const transcriptOf = (dir: string, name: string) => {
  const path = join(dir, `${name}.jsonl`);
  const records = [
    { uuid: "u1", parentUuid: null, type: "user", promptId: "p1", promptSource: "typed", userType: "external",
      timestamp: "2026-01-01T00:00:00.000Z", message: { role: "user", content: "first request" } },
    { uuid: "a1", parentUuid: "u1", type: "assistant", timestamp: "2026-01-01T00:00:01.000Z",
      message: { role: "assistant", content: [{ type: "text", text: "first answer" }] } },
  ];
  writeFileSync(path, [...records, { type: "last-prompt", leafUuid: "a1" }].map(record => `${JSON.stringify(record)}\n`).join(""));
  return path;
};
/** What the Settings menu does on save: an atomic temp-file-and-rename write. */
const saveThinking = (path: string, value: string) => {
  const original = readFileSync(path, "utf8");
  saveCcConfig(path, original, editedCcConfig(original, "noting.thinking", value));
};
async function session(dir: string, path: string, native: string, diagnostics: string[] = []) {
  const config = resolveCcHostConfig(JSON.parse(readFileSync(path, "utf8")));
  await recordSessionStart(config, { hook_event_name: "SessionStart", session_id: native,
    transcript_path: transcriptOf(dir, native), source: "startup" }, "2026-01-01T00:00:00.000Z");
  const coordinator = new CcCoordinator(config, native, message => diagnostics.push(message), undefined, undefined, path);
  await coordinator.start();
  return { config, coordinator, effective: async () => await executorSettings(config, native) as typeof config };
}

test("an atomic-rename save reaches the executor's next admitted task; the running task keeps its level", async () => {
  const dir = mkdtempSync(join(tmpdir(), "cc-cfgw-")); dirs.push(dir);
  const path = join(dir, "cc.config.json");
  writeFileSync(path, `${JSON.stringify(base(dir), null, 2)}\n`);
  const { coordinator, effective } = await session(dir, path, "cfgw-one");
  try {
    await coordinator.turnEnd("first-answer", "answer", new AbortController().signal);
    await until(() => provider.calls.length === 1, "first task");
    expect(provider.calls[0]).toMatchObject({ thinking: "high" });
    saveThinking(path, "medium"); // no apply request: only the file changes
    await until(async () => (await effective()).worker!.phases.noting.thinking === "medium", "the watcher's apply");
    expect(provider.calls).toHaveLength(1);
    expect(provider.calls[0]!.thinking).toBe("high");
    provider.calls[0]!.release();
    await until(() => (coordinator as unknown as { scheduler: { running(): string[] } }).scheduler.running().length === 0, "first task end");
    const transcript = join(dir, "cfgw-one.jsonl");
    const lines = readFileSync(transcript, "utf8").trimEnd().split("\n").filter(line => !line.includes("last-prompt"));
    const more = [
      { uuid: "u2", parentUuid: "a1", type: "user", promptId: "p2", promptSource: "typed", userType: "external",
        timestamp: "2026-01-01T00:00:02.000Z", message: { role: "user", content: "second request" } },
      { uuid: "a2", parentUuid: "u2", type: "assistant", timestamp: "2026-01-01T00:00:03.000Z",
        message: { role: "assistant", content: [{ type: "text", text: "second answer" }] } },
      { type: "last-prompt", leafUuid: "a2" }];
    writeFileSync(transcript, [...lines, ...more.map(record => JSON.stringify(record))].map(line => `${line}\n`).join(""));
    await coordinator.requestReconcile("new completed entry");
    await coordinator.turnEnd("second-answer", "answer", new AbortController().signal);
    await until(() => provider.calls.length === 2, "second task");
    expect(provider.calls[1]).toMatchObject({ thinking: "medium" });
  } finally { for (const call of provider.calls) call.release(); await coordinator.shutdown("test done"); }
});

test("a change to a key that cannot change live is refused once with a restart notice and applies nothing", async () => {
  const dir = mkdtempSync(join(tmpdir(), "cc-cfgw-")); dirs.push(dir);
  const path = join(dir, "cc.config.json");
  writeFileSync(path, `${JSON.stringify(base(dir), null, 2)}\n`);
  const diagnostics: string[] = [];
  const { coordinator, effective } = await session(dir, path, "cfgw-two", diagnostics);
  try {
    // One file edit changes a live key (thinking) together with a non-live one (trigger): neither applies.
    const edit = { ...base(dir), notingThinking: "low", "noting.triggerTokens": 2 };
    writeFileSync(path, `${JSON.stringify(edit)}\n`);
    await until(() => diagnostics.some(message => message.includes("noting.triggerTokens")), "the restart notice");
    await sleep(200);
    expect((await effective()).worker!.phases.noting.thinking).toBe("high");
    expect((await effective())["coreConfig"].noting.triggerTokens).toBe(1);
    // The same refused content saved again does not repeat the notice.
    writeFileSync(path, `${JSON.stringify(edit, null, 2)}\n`);
    await sleep(300);
    const notices = diagnostics.filter(message => message.includes("noting.triggerTokens"));
    expect(notices).toHaveLength(1);
    expect(notices[0]).toContain("restart");
  } finally { await coordinator.shutdown("test done"); }
});

test("an invalid or half-written file keeps the configuration, is reported only if it stays invalid, and recovers on the next valid write", async () => {
  const dir = mkdtempSync(join(tmpdir(), "cc-cfgw-")); dirs.push(dir);
  const path = join(dir, "cc.config.json");
  writeFileSync(path, `${JSON.stringify(base(dir), null, 2)}\n`);
  const diagnostics: string[] = [];
  const { coordinator, effective } = await session(dir, path, "cfgw-three", diagnostics);
  const invalid = () => diagnostics.filter(message => message.includes("is invalid"));
  try {
    // Half-written, then completed within the settle time: nothing is reported, the change applies.
    writeFileSync(path, `{ "dbPath": `);
    await sleep(150);
    writeFileSync(path, `${JSON.stringify({ ...base(dir), notingThinking: "low" }, null, 2)}\n`);
    await until(async () => (await effective()).worker!.phases.noting.thinking === "low", "the completed write");
    await sleep(1_300);
    expect(invalid()).toHaveLength(0);
    // Truncated and left so: the configuration stays, and the file is reported once.
    writeFileSync(path, `{ "dbPath": `);
    await until(() => invalid().length === 1, "the invalid-file report", 3_000);
    expect((await effective()).worker!.phases.noting.thinking).toBe("low");
    writeFileSync(path, `{ "dbPath": 1 `);
    await sleep(1_300);
    expect(invalid().length).toBeLessThanOrEqual(2); // a different parse failure is a different report, never a flood
    // The next valid write is read again.
    writeFileSync(path, `${JSON.stringify({ ...base(dir), notingThinking: "medium" }, null, 2)}\n`);
    await until(async () => (await effective()).worker!.phases.noting.thinking === "medium", "recovery");
  } finally { await coordinator.shutdown("test done"); }
});

test("a save from one session reaches a second executor process with no notification to it", async () => {
  const dir = mkdtempSync(join(tmpdir(), "cc-cfgw-")); dirs.push(dir);
  const path = join(dir, "cc.config.json");
  writeFileSync(path, `${JSON.stringify(base(dir), null, 2)}\n`);
  const config = resolveCcHostConfig(JSON.parse(readFileSync(path, "utf8")));
  const ids = ["cfgw-a", "cfgw-b"];
  const spawnExecutor = async (native: string) => {
    await recordSessionStart(config, { hook_event_name: "SessionStart", session_id: native,
      transcript_path: transcriptOf(dir, native), source: "startup" }, "2026-01-01T00:00:00.000Z");
    const child = spawn(process.execPath, [resolve("tests/hosts/cc-binding-child.ts"), "executor"], { cwd: resolve("."),
      env: { ...process.env, CLAUDE_PID: String(process.pid),
        CC_BINDING_CHILD_INPUT: JSON.stringify({ config, nativeSessionId: native, worker: "executor", configPath: path }) },
      stdio: ["ignore", "ignore", "inherit", "ipc"] });
    children.push(child);
    await new Promise<void>((done, fail) => {
      child.on("message", (m: any) => { if (m.type === "ready") done(); if (m.type === "rejected") fail(new Error(m.error)); });
      child.on("exit", code => fail(new Error(`executor child exited ${code}`)));
    });
    return child;
  };
  const [a, b] = [await spawnExecutor(ids[0]!), await spawnExecutor(ids[1]!)];
  expect(a.pid).not.toBe(b.pid);
  const mode = async (native: string) => (await executorSettings(config, native) as typeof config).coreConfig.noting.forkModeDefault;
  expect([await mode(ids[0]!), await mode(ids[1]!)]).toEqual([false, false]);
  // Session A saves; nothing is sent to either executor.
  const original = readFileSync(path, "utf8");
  saveCcConfig(path, original, editedCcConfig(original, "noting.mode", "fork"));
  await until(async () => (await mode(ids[0]!)) && (await mode(ids[1]!)), "both executors to follow the file");
  for (const child of [a, b]) { child.send("stop"); }
});
