import { expect, test } from "vitest";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { workspaceBatch, type WorkspaceBatch } from "../support/workspace.ts";
import { clusteredItems, decisionText } from "../support/dreamer.ts";
import { CcAgentWorker, type CcAgentTask } from "../../src/hosts/cc/worker.ts";
import { resolveCcHostConfig } from "../../src/hosts/cc/config.ts";
import { ccWorkerToolNames } from "../../src/hosts/cc/tool-names.ts";
import { createFencedClaudeExecutable, fencedClaudeVersion, preflightNetworkFence } from "./cc-native-fence.ts";
import { startLoopbackAnthropic, type LoopbackTurn } from "./cc-native-loopback.ts";
import { fullCheckDryRun } from "../../src/core/dreaming/clustering.ts";

test("native fenced CC full check persists clusters and resumes after the first group commits", async () => {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "tm-full-check-")));
  let task!: CcAgentTask, at = 0, uses = 0, interrupt = true;
  let workerTail = Promise.resolve();
  const tasks: string[] = [], models: string[] = [], logs: string[] = [];
  const finish = (): LoopbackTurn => ({ blocks: [{ type: "text", text: "Done." }], stopReason: "end_turn" });
  const use = (name: string, input: unknown): LoopbackTurn => ({ blocks: [{ type: "tool_use", id: `toolu_${++uses}`, name, input }], stopReason: "tool_use" });
  const file = (name: string) => join(task.workspace!.dir, name);
  const write = (name: string, content: string) => use("Write", { file_path: file(name), content });
  const loopback = await startLoopbackAnthropic((_turns, body) => {
    if (body && typeof body === "object" && "model" in body) models.push(String(body.model));
    const clustering = task.kind === "dreaming" && task.task === "clustering";
    const notes = task.kind === "dreaming" && task.task === "notes";
    const group2 = task.workspace!.dir.endsWith("group-2"), bad = interrupt && group2;
    const steps = notes ? [() => use(ccWorkerToolNames.check, {}), () => write("notes.md", "No repository applies."), finish]
      : clustering ? [() => use(ccWorkerToolNames.check, {}), () => use("Read", { file_path: file("items.md") }), () => {
        const items = readFileSync(file("items.md"), "utf8").trim().split("\n").map(line => line.split(" ")[0]);
        return write("groups.md", clusteredItems(items as string[], 1));
      }, finish]
      : [() => use(ccWorkerToolNames.check, {}), () => use("Read", { file_path: file("group.md") }),
        () => write("decisions.md", decisionText(readFileSync(file("decisions.md"), "utf8"))),
        () => write("changes.md", bad ? "## bogus\n" : "## none\n"), finish,
        ...(bad ? [finish] : [() => {
          const input = readFileSync(file("scoring.md"), "utf8");
          expect(input).toContain("None available");
          return write("scores.md", [...input.matchAll(/^K\d+$/gm)].map(match => `${match[0]} 64`).join("\n"));
        }, finish, finish])];
    return (steps[at++] ?? finish)();
  });
  let fixture: WorkspaceBatch | undefined;
  try {
    const executable = process.env.TM_NATIVE_CLAUDE_EXECUTABLE ?? "/opt/homebrew/bin/claude";
    const port = Number(new URL(loopback.url).port);
    const fence = createFencedClaudeExecutable(join(dir, "fence"), executable, [port], dir);
    await preflightNetworkFence(fence.profilePath, [port], dir);
    const version = await fencedClaudeVersion(fence.wrapperPath, dir);
    mkdirSync(join(dir, "database"));
    const config = resolveCcHostConfig({ dbPath: join(dir, "database", "memory.sqlite"), stateDir: join(dir, "state"), notingModel: "sonnet", notingThinking: "medium",
      "dreaming.model": "sonnet", "dreaming.thinking": "medium", worker: { claudeExecutable: fence.wrapperPath, cwd: dir, contextWindows: { sonnet: 200_000, haiku: 200_000 } } });
    fixture = workspaceBatch({ dbPath: config.dbPath, agent: async raw => {
      const previous = workerTail, done = Promise.withResolvers<void>();
      workerTail = done.promise;
      await previous;
      try {
      task = raw as CcAgentTask; at = 0; tasks.push(task.kind === "dreaming" ? task.task : "noting");
      const result = await new CcAgentWorker(config, { environment: { PATH: process.env.PATH, HOME: join(dir, "home"), CLAUDE_CONFIG_DIR: join(dir, "claude"),
        TMPDIR: dir, CLAUDE_CODE_TMPDIR: dir, ANTHROPIC_BASE_URL: loopback.url, ANTHROPIC_API_KEY: "sk-ant-local-only", CLAUDE_CODE_MAX_RETRIES: "0",
        DISABLE_AUTOUPDATER: "1", DISABLE_TELEMETRY: "1", DISABLE_ERROR_REPORTING: "1", CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1",
        CLAUDE_CODE_DISABLE_AUTO_MEMORY: "1", CLAUDE_CODE_DISABLE_OFFICIAL_MARKETPLACE_AUTOINSTALL: "1" } }).run(task, 0);
      if (result.nativeLog) logs.push(result.nativeLog);
      return result;
      } finally { done.resolve(); }
    } });
    const { memory, store, session, path } = fixture;
    store.db.prepare("UPDATE sessions SET host='cc:native' WHERE id=?").run(session.id);
    memory.config.dreaming.groupItems = 1; memory.config.dreaming.parallelGroups = 1;
    const items = [fixture.item("First rule"), fixture.item("Second rule")];
    const target = { ...path, branch: "main", headTurnId: path.headTurnId!, model: "sonnet", toolNames: ccWorkerToolNames, workspaceRoot: join(dir, "workspaces"), manual: true, fullCheck: true };
    const first = await memory.dream(target);
    expect(first, JSON.stringify(first)).toMatchObject({ outcome: "failure" });
    expect(store.handoff(session.id, "dreaming")!.detail!.groups!.map(group => !!group.run)).toEqual([true, false]);
    expect(items.map(item => store.getKnowledge(item.knowledgeId)!.score)).toEqual([64, null]);
    interrupt = false;
    const second = await memory.dream(target);
    expect(second, JSON.stringify(second)).toMatchObject({ outcome: "success" });
    expect(items.map(item => store.getKnowledge(item.knowledgeId)!.score)).toEqual([64, 64]);
    expect(tasks.filter(task => task === "clustering")).toHaveLength(1);
    expect(models.some(model => /haiku/.test(model))).toBe(true);
    expect(fullCheckDryRun(store, path).decisions).toHaveLength(2);
    expect(logs).toHaveLength(5);
    console.log(JSON.stringify({ host: "CC", version, tasks, scores: items.map(item => store.getKnowledge(item.knowledgeId)!.score), first, second }));
  } finally { fixture?.memory.close(); await loopback.close(); rmSync(dir, { recursive: true, force: true }); }
}, 120_000);
