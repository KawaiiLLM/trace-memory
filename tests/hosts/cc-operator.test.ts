import { afterEach, expect, test, vi } from "vitest";
import fs, { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { resolveCcHostConfig } from "../../src/hosts/cc/config.ts";
import { bindingPath, readBinding, recordSessionStart } from "../../src/hosts/cc/binding.ts";
import { CcImporter } from "../../src/hosts/cc/importer.ts";
import { declareCcProject, operateCcSession } from "../../src/hosts/cc/operator.ts";
import { handleCcHook, runCcCommand } from "../../src/hosts/cc/index.ts";
import { Store } from "../../src/core/store/index.ts";

import { fact, knowledge } from "../support/seed.ts";
const dirs: string[] = [];
afterEach(() => { for (const directory of dirs.splice(0)) rmSync(directory, { recursive: true, force: true }); });

function fixture(label: string) {
  const directory = mkdtempSync(join(tmpdir(), `tm-cc-operator-${label}-`)); dirs.push(directory);
  const transcriptPath = join(directory, "native.jsonl"), nativeSessionId = `operator-${label}`;
  const config = resolveCcHostConfig({ dbPath: join(directory, "memory.sqlite"), stateDir: join(directory, "state"),
    baseline: "2025-01-01T00:00:00.000Z" });
  return { directory, transcriptPath, nativeSessionId, config };
}

const hook = (nativeSessionId: string, transcriptPath: string) => ({ hook_event_name: "SessionStart" as const,
  session_id: nativeSessionId, transcript_path: transcriptPath, source: "startup" as const });

test.each(["catchup", "dream", "stop"])("CLI rejects trailing arguments for %s", async command => {
  const f = fixture(`args-${command}`), configPath = join(f.directory, "cc.config.json");
  writeFileSync(configPath, JSON.stringify({ dbPath: f.config.dbPath, stateDir: f.config.stateDir,
    baseline: "2025-01-01T00:00:00.000Z" }));
  await expect(runCcCommand(["cli", "--config", configPath, "--session", f.nativeSessionId, command, "garbage"]))
    .rejects.toThrow(`CC operator command ${command} accepts no arguments`);
});

test("operator on enrolls only and off persists without a live executor", async () => {
  const f = fixture("enrollment");
  await recordSessionStart(f.config, hook(f.nativeSessionId, f.transcriptPath), null);
  expect(await operateCcSession(f.config, f.nativeSessionId, "on")).toMatchObject({ command: "on", coreSessionId: null, enrollment: "enabled" });
  expect(readBinding(f.config, f.nativeSessionId)?.enrollment.choice).toBe(true);
  expect(await operateCcSession(f.config, f.nativeSessionId, "off")).toMatchObject({ command: "off",
    control: { state: "not-running", enrollmentChanged: true } });
  expect(readBinding(f.config, f.nativeSessionId)?.enrollment.choice).toBe(false);
});

test("operator project synchronizes the binding and lets resume and the live importer continue", async () => {
  const f = fixture("project");
  await recordSessionStart(f.config, hook(f.nativeSessionId, f.transcriptPath), "2026-01-01T00:00:00.000Z");
  await expect(declareCcProject(f.config, f.nativeSessionId, "shared")).rejects.toThrow("no persisted selected source path");
  writeFileSync(f.transcriptPath, [
    { uuid: "u1", parentUuid: null, type: "user", timestamp: "2026-01-01T00:00:00.000Z", promptId: "p1", promptSource: "typed", userType: "external", message: { role: "user", content: "question" } },
    { uuid: "a1", parentUuid: "u1", type: "assistant", timestamp: "2026-01-01T00:00:01.000Z", message: { role: "assistant", content: [{ type: "text", text: "answer" }] } },
    { type: "last-prompt", leafUuid: "a1" },
  ].map(value => `${JSON.stringify(value)}\n`).join(""));
  const importer = new CcImporter(f.config, readBinding(f.config, f.nativeSessionId)!);
  try { expect((await importer.reconcile()).state).toBe("ready"); } finally { importer.close(); }
  await expect(declareCcProject(f.config, f.nativeSessionId, "shared"))
    .resolves.toMatchObject({ command: "project", result: expect.stringContaining("shared") });
  const binding = readBinding(f.config, f.nativeSessionId)!;
  const store = new Store(f.config.dbPath);
  try { expect(binding.projectId).toBe(store.getSession(binding.coreSessionId!)?.projectId); }
  finally { store.close(); }
  await expect(handleCcHook(f.config, { ...hook(f.nativeSessionId, f.transcriptPath), source: "resume" })).resolves.toBeNull();
  const continued = new CcImporter(f.config, binding);
  try { expect((await continued.reconcile()).state).toBe("ready"); } finally { continued.close(); }
});

test("project restores the prior binding when directory fsync fails after publication", async () => {
  const f = fixture("project-fsync-failure");
  await recordSessionStart(f.config, hook(f.nativeSessionId, f.transcriptPath), "2026-01-01T00:00:00.000Z");
  writeFileSync(f.transcriptPath, [
    { uuid: "u1", parentUuid: null, type: "user", timestamp: "2026-01-01T00:00:00.000Z", promptId: "p1", promptSource: "typed", userType: "external", message: { role: "user", content: "question" } },
    { uuid: "a1", parentUuid: "u1", type: "assistant", timestamp: "2026-01-01T00:00:01.000Z", message: { role: "assistant", content: [{ type: "text", text: "answer" }] } },
  ].map(value => `${JSON.stringify(value)}\n`).join(""));
  const importer = new CcImporter(f.config, readBinding(f.config, f.nativeSessionId)!);
  try { await importer.reconcile(); } finally { importer.close(); }
  const before = readBinding(f.config, f.nativeSessionId)!;
  const originalFsync = fs.fsyncSync; let calls = 0;
  fs.fsyncSync = descriptor => {
    calls++;
    if (calls === 2) throw new Error("injected directory fsync failure after rename");
    return originalFsync(descriptor);
  };
  syncBuiltinESMExports();
  try {
    await expect(declareCcProject(f.config, f.nativeSessionId, "shared"))
      .rejects.toThrow("injected directory fsync failure after rename");
  } finally {
    fs.fsyncSync = originalFsync;
    syncBuiltinESMExports();
  }
  const after = readBinding(f.config, f.nativeSessionId)!;
  const store = new Store(f.config.dbPath);
  try {
    expect(after.projectId).toBe(before.projectId);
    expect(store.getSession(before.coreSessionId!)?.projectId).toBe(before.projectId);
  } finally { store.close(); }
  expect(calls).toBeGreaterThanOrEqual(4);
});

test.each(["on", "off", "stop", "catchup"] as const)("operator %s rejects a foreign database before mutation or control", async command => {
  const f = fixture(`wrong-db-${command}`);
  await recordSessionStart(f.config, hook(f.nativeSessionId, f.transcriptPath), null);
  const foreign = resolveCcHostConfig({ ...f.config, dbPath: join(f.directory, "foreign.sqlite") });
  const store = new Store(foreign.dbPath);
  const project = store.createProject({ name: "foreign", declaredBy: "mark" });
  const victim = store.createSession({ host: "victim", projectId: project.id, startedAt: "now", firstReplyAt: "now", enrollmentChoice: false });
  try {
    await expect(operateCcSession(foreign, f.nativeSessionId, command)).rejects.toThrow("configured database");
    expect(store.enabled(victim.id)).toBe(false);
  } finally { store.close(); }
});

test("operator rejects a foreign core identity without mutating that session", async () => {
  const f = fixture("wrong-core");
  await recordSessionStart(f.config, hook(f.nativeSessionId, f.transcriptPath), null);
  const store = new Store(f.config.dbPath);
  const project = store.createProject({ name: "foreign", declaredBy: "mark" });
  const victim = store.createSession({ host: "victim", projectId: project.id, startedAt: "now", firstReplyAt: "now", enrollmentChoice: false });
  const binding = readBinding(f.config, f.nativeSessionId)!;
  writeFileSync(bindingPath(f.config, f.nativeSessionId), `${JSON.stringify({ ...binding, coreSessionId: victim.id, projectId: project.id }, null, 2)}\n`);
  try {
    for (const command of ["on", "off", "stop", "catchup"] as const)
      await expect(operateCcSession(f.config, f.nativeSessionId, command)).rejects.toThrow("authoritative core session");
    expect(store.enabled(victim.id)).toBe(false);
  } finally { store.close(); }
});

test("full-check dry-run CLI inventories the bound project without creating an execution", async () => {
  const f = fixture("full-check-preview"), configPath = join(f.directory, "cc.config.json");
  writeFileSync(configPath, JSON.stringify({ dbPath: f.config.dbPath, stateDir: f.config.stateDir }));
  await recordSessionStart(f.config, hook(f.nativeSessionId, f.transcriptPath), "2026-01-01T00:00:00.000Z");
  writeFileSync(f.transcriptPath, [
    { uuid: "u1", parentUuid: null, type: "user", timestamp: "2026-01-01T00:00:00.000Z", promptId: "p1", promptSource: "typed", userType: "external", message: { role: "user", content: "Keep the project rule." } },
    { uuid: "a1", parentUuid: "u1", type: "assistant", timestamp: "2026-01-01T00:00:01.000Z", message: { role: "assistant", content: [{ type: "text", text: "Recorded." }] } },
  ].map(value => `${JSON.stringify(value)}\n`).join(""));
  const importer = new CcImporter(f.config, readBinding(f.config, f.nativeSessionId)!);
  try {
    const projected = await importer.reconcile();
    const path = { sessionId: projected.coreSessionId!, branch: projected.branch, headTurnId: projected.headTurnId! };
    const store = importer.memory.store;
    const entry = store.getSourceEntry(store.sourcePath(path.sessionId, path.branch, path.headTurnId)[0]!.id)!;
    const support = fact(importer.memory, path, "Project rule", [{ entry, text: "Keep the project rule." }]);
    const item = knowledge(store, path, "project", "constraint", [support.id], "Keep the project rule.", { operation: { title: "Project rule" } });
    const before = store.listRuns(path.sessionId).map(run => run.id);
    let output = "";
    const stdout = vi.spyOn(process.stdout, "write").mockImplementation(chunk => { output += String(chunk); return true; });
    try { await runCcCommand(["cli", "--config", configPath, "--session", f.nativeSessionId, "full-check", "--dry-run"]); }
    finally { stdout.mockRestore(); }
    const report = JSON.parse(output);
    expect(report).toMatchObject({ project: { id: store.getSession(path.sessionId)!.projectId }, count: 1, groups: null, decisions: [], modelCalls: 0 });
    expect(report.items).toEqual([`K${item.knowledgeId}@v1 [constraint] Project rule`]);
    expect(report.estimateUsd.curate).toBe(0.17);
    expect(store.listRuns(path.sessionId).map(run => run.id)).toEqual(before);
    expect(store.db.prepare("SELECT count(*) AS count FROM task_executions").get()!.count).toBe(0);
  } finally { importer.close(); }
});
