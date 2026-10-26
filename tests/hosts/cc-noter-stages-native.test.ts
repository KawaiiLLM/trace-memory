// Native four-stage acceptance: real CC executable, network fence and file hooks; only model replies are scripted.
import { afterEach, expect, test } from "vitest";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { sourceSeededMemory } from "../source-fixture.ts";
import { ccWorkspaceRoot, resolveCcHostConfig } from "../../src/hosts/cc/config.ts";
import { CcAgentWorker, type CcAgentTask } from "../../src/hosts/cc/worker.ts";
import { ccWorkerToolNames } from "../../src/hosts/cc/tool-names.ts";
import { factsFile, knowledgeFile, withVerdicts } from "../support/noter.ts";
import { fencedClaudeVersion, createFencedClaudeExecutable, fenceToolsAvailable, preflightNetworkFence } from "./cc-native-fence.ts";
import { startLoopbackAnthropic, type LoopbackTurn } from "./cc-native-loopback.ts";

const executable = process.env.TM_NATIVE_CLAUDE_EXECUTABLE ?? "/opt/homebrew/bin/claude";
const dirs: string[] = [];
function directory() { const dir = realpathSync(mkdtempSync(join(tmpdir(), "tm-noter-native-"))); dirs.push(dir); return dir; }
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });
const opts = { DISABLE_AUTOUPDATER: "1", DISABLE_TELEMETRY: "1", DISABLE_ERROR_REPORTING: "1",
  CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1", CLAUDE_CODE_DISABLE_FEEDBACK_SURVEY: "1",
  CLAUDE_CODE_DISABLE_AUTO_MEMORY: "1", CLAUDE_CODE_DISABLE_OFFICIAL_MARKETPLACE_AUTOINSTALL: "1" };
let uses = 0;
const use = (name: string, input: unknown): LoopbackTurn => ({ blocks: [{ type: "tool_use", id: `toolu_${++uses}`, name, input }], stopReason: "tool_use" });
const finish = (): LoopbackTurn => ({ blocks: [{ type: "text", text: "finished" }], stopReason: "end_turn" });
const GOOD = [{ title: "Episode one", objects: ["pnpm"], sources: "[T1#E1] Use pnpm" }];

for (const variant of ["published", "corrected-at-stop", "unfixed"] as const) test(`real CC four-stage Noter: ${variant}`, async () => {
  const cwd = directory(), home = directory(), configDir = directory();
  let memory!: ReturnType<typeof sourceSeededMemory>;
  let workspace = { facts: "", knowledge: "", dir: "" };
  const requests: unknown[] = [], logs: string[] = [], firsts: number[] = [];
  const check = () => use(ccWorkerToolNames.check, {});
  const writeFacts = (bad = false) => use("Write", { file_path: workspace.facts, content: factsFile(GOOD).replace("T1#E1", bad ? "T1#E99" : "T1#E1") });
  const writeCheckedFacts = () => use("Write", { file_path: workspace.facts, content: withVerdicts(factsFile([{ ...GOOD[0]!, title: "Episode one, verified" }])) });
  const knowledge = () => knowledgeFile(memory, { files: null, op: "create", title: "Package manager", text: "Use pnpm", category: "constraint", scope: "session", topics: [], supports: ["$1"], reason: "User ruling" });
  const steps = variant === "unfixed" ? [check, () => writeFacts(true), finish, finish] : [
    check, () => use("Write", { file_path: join(cwd, "outside.txt"), content: "escape" }), () => writeFacts(variant === "corrected-at-stop"), finish,
    ...(variant === "corrected-at-stop" ? [() => use("Edit", { file_path: workspace.facts, old_string: "T1#E99", new_string: "T1#E1" }), finish] : []),
    check, () => use("Read", { file_path: join(workspace.dir, "related-facts.md") }), writeCheckedFacts, finish,
    check, () => use("Write", { file_path: workspace.knowledge, content: knowledge() }), finish,
    check, () => use("Read", { file_path: join(workspace.dir, "related-knowledge.md") }), () => use("Write", { file_path: workspace.knowledge, content: withVerdicts(knowledge()) }), finish,
  ];
  const loopback = await startLoopbackAnthropic((_turns, body) => { const at = requests.length; requests.push(body); return (steps[at] ?? finish)(); });
  if (!fenceToolsAvailable(executable)) throw new Error("native CC acceptance requires the installed CLI and sandbox-exec");
  const port = Number(new URL(loopback.url).port);
  const fence = createFencedClaudeExecutable(join(cwd, "fence"), executable, [port], cwd);
  await preflightNetworkFence(fence.profilePath, [port], cwd);
  await fencedClaudeVersion(fence.wrapperPath, cwd);
  mkdirSync(join(cwd, "database"));
  const settings = resolveCcHostConfig({ dbPath: join(cwd, "database", "memory.sqlite"), stateDir: join(cwd, "state"),
    notingModel: "sonnet", notingThinking: "medium", "dreaming.model": "sonnet", "dreaming.thinking": "medium",
    worker: { claudeExecutable: fence.wrapperPath, contextWindows: { sonnet: 200_000 }, cwd } });
  memory = sourceSeededMemory(settings.dbPath, async raw => {
    const task = raw as CcAgentTask;
    if (task.kind !== "noting") throw new Error("unexpected Dreamer");
    workspace = task.workspace; firsts.push(requests.length);
    expect(memory.store.listSessionFacts(1).map(fact => fact.title)).toEqual(task.task.endsWith("knowledge") ? ["Episode one, verified"] : []);
    expect(memory.store.currentKnowledge()).toEqual([]);
    const result = await new CcAgentWorker(settings, { environment: { PATH: process.env.PATH, HOME: home, CLAUDE_CONFIG_DIR: configDir,
      TMPDIR: cwd, CLAUDE_CODE_TMPDIR: cwd, ANTHROPIC_BASE_URL: loopback.url, ANTHROPIC_API_KEY: "sk-ant-local-only", CLAUDE_CODE_MAX_RETRIES: "0", ...opts } }).run(task, 0);
    if (result.nativeLog) logs.push(result.nativeLog);
    return result;
  });
  const project = memory.store.createProject({ name: "native-noter-stages", declaredBy: "mark" });
  const session = memory.store.createSession({ projectId: project.id, host: "cc:native", enrollmentChoice: true, startedAt: "now", firstReplyAt: "now" });
  const turn = memory.store.appendTurn({ sessionId: session.id, kind: "turn", userPrompt: "Use pnpm", assistantText: "Claude Code recorded the rule", startedAt: "now" });
  try {
    const outcome = await memory.noting({ sessionId: session.id, branch: "main", headTurnId: turn.id, model: "sonnet", toolNames: ccWorkerToolNames, workspaceRoot: ccWorkspaceRoot(cwd) });
    expect(outcome.outcome, JSON.stringify(outcome)).toBe(variant === "unfixed" ? "failure" : "success");
    expect(requests).toHaveLength(steps.length);
    expect(existsSync(join(cwd, "outside.txt"))).toBe(false);
    const runs = memory.store.listRuns(session.id);
    expect(runs.map(run => JSON.parse(run.response!).task)).toEqual(variant === "unfixed" ? ["extract-facts"] : ["extract-facts", "check-facts", "write-knowledge", "check-knowledge"]);
    expect(logs).toHaveLength(variant === "unfixed" ? 1 : 4);
    for (const log of logs) expect(readFileSync(log, "utf8")).toContain(ccWorkerToolNames.check);
    if (variant !== "unfixed") {
      const bodies = firsts.map(at => requests[at] as { system: unknown; tools: unknown; messages: unknown[] });
      for (const body of bodies.slice(1)) expect([body.system, body.tools, body.messages[0]]).toEqual([bodies[0]!.system, bodies[0]!.tools, bodies[0]!.messages[0]]);
      expect(memory.store.listSessionFacts(1).map(fact => fact.title)).toEqual(["Episode one, verified"]);
      expect(memory.store.currentKnowledge().map(item => item.revision.text)).toEqual(["Use pnpm"]);
      expect(runs.map(run => JSON.parse(run.response!).budget.steps)).toEqual([variant === "published" ? 4 : 6, 4, 3, 4]);
    } else expect(memory.store.listSessionFacts(1)).toEqual([]);
    if (process.env.TM155_EVIDENCE) {
      mkdirSync(process.env.TM155_EVIDENCE, { recursive: true });
      writeFileSync(join(process.env.TM155_EVIDENCE, `cc-${variant}.json`), JSON.stringify({ outcome, requests, runs }, null, 2));
      logs.forEach((log, at) => writeFileSync(join(process.env.TM155_EVIDENCE!, `cc-${variant}-${at + 1}.jsonl`), readFileSync(log, "utf8")));
    }
  } finally { memory.close(); await loopback.close(); }
}, 120_000);
