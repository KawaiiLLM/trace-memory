import { afterEach, expect, test, vi } from "vitest";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { resolveCcHostConfig } from "../../src/hosts/cc/config.ts";
import { editedCcConfig, saveCcConfig } from "../../src/hosts/cc/menu-config.ts";
import { readCcMenu } from "../../src/hosts/cc/menu.ts";
import { bindingPath, readBinding, recordSessionStart } from "../../src/hosts/cc/binding.ts";
import { executorSettings, executorSnapshot, startControlServer } from "../../src/hosts/cc/control.ts";
import { TraceMemory } from "../../src/core/api/index.ts";
import { runCcCommand } from "../../src/hosts/cc/index.ts";
import { CcImporter } from "../../src/hosts/cc/importer.ts";
import { CcTaskScheduler } from "../../src/hosts/cc/scheduler.ts";
import { readCcRuns } from "../../src/hosts/cc/menu.ts";
import { Store } from "../../src/core/store/index.ts";

const dirs: string[] = [];
afterEach(() => { for (const directory of dirs.splice(0)) rmSync(directory, { recursive: true, force: true }); });
const setup = () => {
  const dir = mkdtempSync(join(tmpdir(), "cc82-backend-")); dirs.push(dir);
  const path = join(dir, "cc.config.json"), session = "cc82-current";
  const worker = { claudeExecutable: "/usr/bin/false", cwd: dir,
    contextWindows: { "claude-sonnet-5": 200_000, "claude-opus-5-5": 250_000 } };
  const input = { dbPath: join(dir, "memory.sqlite"), stateDir: join(dir, "state"), worker,
    notingModel: "claude-sonnet-5", notingThinking: "high", consolidationModel: "claude-sonnet-5",
    consolidationThinking: "high", "dreaming.model": "claude-opus-5-5", "dreaming.thinking": "high", closedSessionScope: "project" as const };
  const text = ` {\n  "dbPath": ${JSON.stringify(input.dbPath)},\n  "stateDir": ${JSON.stringify(input.stateDir)},\n  "custom": { "unrelated": [1, 2] },\n  "worker": {\n    "claudeExecutable": "/usr/bin/false",\n    "claudeVersion": "2.1.280",\n    "cwd": ${JSON.stringify(dir)},\n    "contextWindows": {\n      "claude-sonnet-5": 200000,\n      "claude-opus-5-5": 250000\n    }\n  },\n  "notingModel": "claude-sonnet-5",\n  "notingThinking": "high",\n  "consolidationModel": "claude-sonnet-5",\n  "consolidationThinking": "high",\n  "dreaming.model": "claude-opus-5-5",\n  "dreaming.thinking": "high",\n  "closedSessionScope": "project"\n}\n`;
  writeFileSync(path, text);
  const config = resolveCcHostConfig(input);
  return { dir, path, session, text, config };
};

 test("settings edit preserves unrelated formatting and enforces model capacity and CC-only choices", () => {
  const f = setup();
  const thinking = editedCcConfig(f.text, "noting.thinking", "medium");
  expect(thinking).toBe(f.text.replace('"notingThinking": "high"', '"notingThinking": "medium"'));
  const mode = editedCcConfig(f.text, "noting.mode", "fork");
  expect(resolveCcHostConfig(JSON.parse(mode)).coreConfig.noting.forkModeDefault).toBe(true);
  expect(resolveCcHostConfig(JSON.parse(editedCcConfig(mode, "noting.mode", "subagent"))).coreConfig.noting.forkModeDefault).toBe(false);
  expect(() => editedCcConfig(f.text, "noting.mode", "inherit")).toThrow("must be fork or subagent");
  const added = editedCcConfig(f.text, "dreaming.model", "claude-new", "180000");
  expect(added).toContain('"custom": { "unrelated": [1, 2] }');
  expect(added).toContain('"claude-opus-5-5": 250000');
  expect(added).toContain('"claude-new": 180000');
  expect(added).toContain('"claudeExecutable": "/usr/bin/false",\n    "claudeVersion"');
  expect(() => editedCcConfig(f.text, "dreaming.model", "claude-new")).toThrow("requires a context capacity");
  expect(() => editedCcConfig(f.text, "noting.thinking", "inherit")).toThrow("thinking must be");
  expect(() => editedCcConfig(f.text, "noting.model", "follow foreground")).toThrow("explicit model");
  expect(() => editedCcConfig(f.text, "noting.model", "claude-sonnet-5", "200000")).toThrow("already exists");
  saveCcConfig(f.path, f.text, thinking);
  expect(readFileSync(f.path, "utf8")).toBe(thinking);
  expect(() => saveCcConfig(f.path, f.text, added)).toThrow("changed before save");
});

test("menu is navigable without an executor but does not label saved worker file values effective", async () => {
  const f = setup(), transcriptPath = join(f.dir, "native.jsonl");
  await recordSessionStart(f.config, { hook_event_name: "SessionStart", session_id: f.session,
    transcript_path: transcriptPath, source: "startup" }, null);
  const before = readBinding(f.config, f.session)!;
  const menu = readCcMenu(f.config, f.session);
  expect(menu.menu.actions.enabled).toBe(false);
  expect(menu.menu.pending.noting.tokens).toBeNull();
  expect(menu.settings.workers[0]).toMatchObject({ mode: "subagent", model: "unavailable",
    sources: { mode: "effective configuration unavailable", model: "effective configuration unavailable" } });
  expect(menu.menu.notices).toContain("Running executor configuration unavailable");
  expect(menu.context.presence).toBe("unavailable");
  expect(readBinding(f.config, f.session)).toEqual(before);
  await expect(runCcCommand(["cli", "--config", f.path, "--session", f.session, "runs", "--json", "0"]))
    .rejects.toThrow("positive safe integer");
  await expect(runCcCommand(["cli", "--config", f.path, "--session", f.session, "runs", "--json", "1.5"]))
    .rejects.toThrow("positive safe integer");
  expect(readCcMenu(f.config, f.session, undefined, 100).runs).toEqual([]);
});

test("runs uses the requested count beyond 20 with no silent limit", async () => {
  const f = setup();
  await recordSessionStart(f.config, { hook_event_name: "SessionStart", session_id: f.session,
    transcript_path: join(f.dir, "native.jsonl"), source: "startup" }, null);
  const store = new Store(f.config.dbPath);
  const project = store.createProject({ name: "test-project", declaredBy: "mark" });
  const core = store.createSession({ host: `cc:${f.session}`, projectId: project.id,
    startedAt: "2026-01-01T00:00:00.000Z", firstReplyAt: "2026-01-01T00:00:00.000Z", enrollmentChoice: true });
  const binding = readBinding(f.config, f.session)!;
  writeFileSync(bindingPath(f.config, f.session), `${JSON.stringify({ ...binding, projectId: project.id, coreSessionId: core.id })}\n`);
  try {
    for (let i = 0; i < 30; i++) store.db.prepare("INSERT INTO runs (kind, session_id, outcome, created_at) VALUES ('noting', ?, 'success', ?)")
      .run(core.id, "2026-01-01T00:00:00.000Z");
    const runs = readCcRuns(f.config, f.session, 27);
    expect(runs).toHaveLength(27);
    expect(runs[0]!.id).toBe(30);
    expect(runs.at(-1)!.id).toBe(4);
    expect(readCcRuns(f.config, f.session, 50)).toHaveLength(30);
  } finally { store.close(); }
});

test("a session reopened after /clear keeps its menu, runs and settings (63: the parent lineage continues)", async () => {
  const f = setup(), transcriptPath = join(f.dir, "native.jsonl"), child = "cc82-child";
  await recordSessionStart(f.config, { hook_event_name: "SessionStart", session_id: f.session,
    transcript_path: transcriptPath, source: "startup" }, null);
  await recordSessionStart(f.config, { hook_event_name: "SessionStart", session_id: child,
    transcript_path: join(f.dir, "child.jsonl"), source: "clear" }, null);
  const old = readBinding(f.config, f.session)!;
  writeFileSync(bindingPath(f.config, f.session), `${JSON.stringify({ ...old,
    clearedInto: { nativeSessionId: child, at: new Date().toISOString() } })}\n`);
  // The user resumes the pre-clear session: its lineage is live again, and the marker is history.
  await recordSessionStart(f.config, { hook_event_name: "SessionStart", session_id: f.session,
    transcript_path: transcriptPath, source: "resume" }, null);
  expect(readBinding(f.config, f.session)!.clearedInto?.nativeSessionId).toBe(child);
  expect(readCcMenu(f.config, f.session).menu.header.project).toBe("unavailable");
  expect(readCcRuns(f.config, f.session, 5)).toEqual([]);
  expect(readCcMenu(f.config, child).menu.header.project).toBe("unavailable");
  let output = "";
  const stdout = vi.spyOn(process.stdout, "write").mockImplementation(chunk => { output += String(chunk); return true; });
  try { await runCcCommand(["cli", "--config", f.path, "--session", f.session, "setting", "closedSessionScope", "off"]); }
  finally { stdout.mockRestore(); }
  expect(JSON.parse(output)).toMatchObject({ saved: true, applied: false });
});

test("scheduler captures worker settings separately for each admission", async () => {
  const f = setup(), transcriptPath = join(f.dir, "native.jsonl");
  await recordSessionStart(f.config, { hook_event_name: "SessionStart", session_id: f.session,
    transcript_path: transcriptPath, source: "startup" }, null);
  const importer = new CcImporter(f.config, readBinding(f.config, f.session)!);
  try {
    const scheduler = new CcTaskScheduler(importer.memory, f.config.worker, () => {});
    const access = scheduler as unknown as { common(phase: "noting", target: { sessionId: number; branch: string; headTurnId: number },
      borrowed: boolean, automatic: boolean): { model: string; subagentThinkingLevel: string } };
    const target = { sessionId: 1, branch: "main", headTurnId: 1 };
    const admitted = access.common("noting", target, false, true);
    const next = resolveCcHostConfig({ ...JSON.parse(f.text), notingModel: "claude-opus-5-5", notingThinking: "medium" });
    importer.applyWorker(next); scheduler.applyWorker(next.worker);
    const later = access.common("noting", target, false, true);
    expect(admitted).toMatchObject({ model: "claude-sonnet-5", subagentThinkingLevel: "high" });
    expect(later).toMatchObject({ model: "claude-opus-5-5", subagentThinkingLevel: "medium" });
  } finally { importer.close(); }
});

test("authenticated control reports actual applied snapshot, and failed apply leaves it intact", async () => {
  const f = setup(), transcriptPath = join(f.dir, "native.jsonl");
  await recordSessionStart(f.config, { hook_event_name: "SessionStart", session_id: f.session,
    transcript_path: transcriptPath, source: "startup" }, null);
  const memory = TraceMemory(f.config.dbPath, async () => ({ outcome: "failure", output: "unused" }), f.config.coreConfig);
  let effective = f.config, applications = 0, catchupActions = 0, snapshotReads = 0;
  const server = await startControlServer(f.config, readBinding(f.config, f.session)!, memory, undefined, undefined, {
    catchup: async () => { catchupActions++; return { state: "failed", entriesDone: 0, entriesTotal: 0, factsDone: 0, factsTotal: 0 }; },
    beforeCancel: () => {}, holdImport: () => () => {}, effectiveConfig: () => effective,
    catchupSnapshot: () => { snapshotReads++; return { state: "waiting", phase: "noting",
      entriesDone: 2, entriesTotal: 5, factsDone: 1, factsTotal: 3 }; },
    applyConfig: next => { applications++; effective = next; },
  });
  try {
    const snapshot = await executorSnapshot(f.config, f.session);
    expect(snapshot.config.worker?.phases.noting.thinking).toBe("high");
    expect(readCcMenu(f.config, f.session, snapshot.config, 10, snapshot.catchup).menu.notices)
      .toContain("Catchup: waiting for noting (2/5 entries)");
    expect(snapshotReads).toBe(1);
    expect(catchupActions).toBe(0);
    const edited = editedCcConfig(f.text, "noting.thinking", "medium");
    saveCcConfig(f.path, f.text, edited);
    await expect(executorSettings(f.config, f.session, { path: f.path, expected: f.text })).rejects.toThrow("changed before executor apply");
    expect(applications).toBe(0);
    expect((await executorSettings(f.config, f.session) as typeof f.config).worker?.phases.noting.thinking).toBe("high");
    const savedConfig = resolveCcHostConfig(JSON.parse(edited));
    const beforeApply = readCcMenu(savedConfig, f.session, effective);
    expect(beforeApply.settings.workers[0]).toMatchObject({ thinking: "high",
      sources: { thinking: "saved file differs from running executor" } });
    expect(beforeApply.menu.notices).toContain("Saved file settings differ from running executor");
    await executorSettings(f.config, f.session, { path: f.path, expected: edited });
    expect(applications).toBe(1);
    expect((await executorSettings(f.config, f.session) as typeof f.config).worker?.phases.noting.thinking).toBe("medium");
  } finally { await server.close(); memory.store.close(); }
});
