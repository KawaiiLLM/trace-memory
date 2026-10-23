// Ticket 144, Stage 3: the two-task Noter on the real, pinned Claude Code executable, under the network fence against a scripted
// loopback model. What is real: the SDK worker, the PreToolUse file hooks, native Write/Read/Edit under `--restricted`, the stop
// check and each step's one repair, the hand-off between the tasks and publication. What is scripted: the model's replies.
// Set TM144_EVIDENCE to a directory to keep each variant's requests and the native transcripts of both tasks.
import { afterAll, afterEach, expect, test } from "vitest";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { sourceSeededMemory } from "../source-fixture.ts";
import { Store } from "../../src/core/store/index.ts";
import { ccWorkspaceRoot, resolveCcHostConfig } from "../../src/hosts/cc/config.ts";
import { CcAgentWorker, type CcAgentTask } from "../../src/hosts/cc/worker.ts";
import { ccWorkerToolNames } from "../../src/hosts/cc/tool-names.ts";
import { factsFile, knowledgeFile } from "../support/noter.ts";
import { fencedClaudeVersion, createFencedClaudeExecutable, fenceToolsAvailable, preflightNetworkFence } from "./cc-native-fence.ts";
import { startLoopbackAnthropic, type LoopbackTurn } from "./cc-native-loopback.ts";

const executable = process.env.TM_NATIVE_CLAUDE_EXECUTABLE ?? "/opt/homebrew/bin/claude";
const available = fenceToolsAvailable(executable);
const dirs: string[] = [];
function directory() { const dir = realpathSync(mkdtempSync(join(tmpdir(), "tm144-native-"))); dirs.push(dir); return dir; }
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });
afterAll(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });

const opts = { DISABLE_AUTOUPDATER: "1", DISABLE_TELEMETRY: "1", DISABLE_ERROR_REPORTING: "1",
  CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1", CLAUDE_CODE_DISABLE_FEEDBACK_SURVEY: "1",
  CLAUDE_CODE_DISABLE_AUTO_MEMORY: "1", CLAUDE_CODE_DISABLE_OFFICIAL_MARKETPLACE_AUTOINSTALL: "1" };
function config(cwd: string, claudeExecutable: string) {
  mkdirSync(join(cwd, "database"), { recursive: true });
  return resolveCcHostConfig({ dbPath: join(cwd, "database", "memory.sqlite"), stateDir: join(cwd, "state"),
  notingModel: "sonnet", notingThinking: "medium", "dreaming.model": "sonnet", "dreaming.thinking": "medium",
  worker: { claudeExecutable, contextWindows: { sonnet: 200_000 }, cwd } }); }

interface Files { facts: string; knowledge: string }
type Step = (files: Files, cwd: string) => LoopbackTurn;
let uses = 0; // a tool use id is unique within the conversation
const use = (_kind: number, name: string, input: unknown): LoopbackTurn => ({ blocks: [{ type: "tool_use", id: `toolu_${++uses}`, name, input }], stopReason: "tool_use" });
const finish: Step = () => ({ blocks: [{ type: "text", text: "finished" }], stopReason: "end_turn" });
const check: Step = () => use(1, ccWorkerToolNames.check, {});
const write = (which: keyof Files, content: string): Step => files => use(2, "Write", { file_path: files[which], content });
const edit = (which: keyof Files, from: string, to: string): Step => files => use(3, "Edit", { file_path: files[which], old_string: from, new_string: to });
const read = (which: keyof Files): Step => files => use(4, "Read", { file_path: files[which] });
const outside: Step = (_files, cwd) => use(5, "Write", { file_path: join(cwd, "outside.txt"), content: "escape" });

const GOOD = [{ title: "Episode one", sources: "[T2#E1] Episode one" }, { title: "Episode two", sources: "[T2#E2] Episode two" }];
const BAD = [{ title: "Episode one", sources: "[T2#E99] Episode one" }];
const variants = ["published", "none", "corrected-at-stop", "unfixed"] as const;

for (const variant of variants)
  test(`real CC two-task Noter: ${variant}`, async () => {
    const cwd = directory(), home = directory(), configDir = directory();
    let settings!: ReturnType<typeof config>;
    let memory!: ReturnType<typeof sourceSeededMemory>;
    let session!: { id: number };
    let path!: { sessionId: number; branch: string; headTurnId: number };
    let entries!: { id: number }[];
    let beforeKnowledge!: ReturnType<Store["currentKnowledge"]>;
    const requests: unknown[] = [], logs: string[] = [], checkpoints: Record<number, () => void> = {};
    let files: Files = { facts: "", knowledge: "" }, checkpointError: unknown, checkpointsRun = 0;
    const knowledge = () => knowledgeFile(memory, { files: null, op: "create", title: "Fixture title", text: "Claude Code notes the two episodes", category: "understanding",
      scope: "session", topics: [], supports: ["$1", "$2"], reason: "Both episodes" });
    // One request per entry. Each task has two steps: the stop after the facts file brings step 2 (a new request), the stop after
    // the knowledge file ends the task; a failing stop brings the step's one repair (a new request too).
    const steps: Step[] = variant === "published" ? [check, outside, write("facts", factsFile(GOOD)), finish, (f, c) => write("knowledge", knowledge())(f, c), finish,
      check, read("facts"), edit("facts", "title: Episode two", "title: Episode two, verified"), finish, finish]
      : variant === "none" ? [check, write("facts", factsFile()), finish, write("knowledge", knowledgeFile(undefined as never)), finish, check, finish, finish]
      : variant === "corrected-at-stop" ? [check, write("facts", factsFile(BAD)), finish,
        edit("facts", "T2#E99", "T2#E1"), finish, write("knowledge", "## none\n"), finish, check, finish, finish]
      : [check, write("facts", factsFile(BAD)), finish, finish];
    // A task has written nothing to the database before its verify task ends: the hand-off is the only thing that exists between them.
    const unpublished = (handoff: number) => () => {
      const reader = new Store(settings.dbPath);
      try {
        expect(reader.listSessionFacts(session.id)).toHaveLength(0);
        expect(reader.currentKnowledge(path)).toEqual(beforeKnowledge);
        expect(entries.every(e => !reader.entryNoted(e.id))).toBe(true);
        expect((reader.db.prepare("SELECT count(*) AS n FROM task_handoffs").get() as { n: number }).n).toBe(handoff);
      } finally { reader.close(); }
    };
    if (variant === "published") { checkpoints[6] = unpublished(1); checkpoints[10] = unpublished(1); }
    const loopback = await startLoopbackAnthropic((_turns, body) => {
      const index = requests.length;
      requests.push(body);
      const found = /File: (\S+facts\.md)/.exec(JSON.stringify(body)); // the first check result names the facts file; the knowledge file sits beside it
      if (found) files = { facts: found[1]!, knowledge: found[1]!.replace(/facts\.md$/, "knowledge.md") };
      try { checkpoints[index]?.(); if (checkpoints[index]) checkpointsRun++; } catch (error) { checkpointError = error; }
      return (steps[index] ?? finish)(files, cwd);
    });
    if (!available) throw new Error("native CC acceptance requires the installed CLI and sandbox-exec");
    const fence = createFencedClaudeExecutable(join(cwd, "fence"), executable, [Number(new URL(loopback.url).port)], cwd);
    await preflightNetworkFence(fence.profilePath, [Number(new URL(loopback.url).port)], cwd);
    await fencedClaudeVersion(fence.wrapperPath, cwd);
    settings = config(cwd, fence.wrapperPath);
    memory = sourceSeededMemory(settings.dbPath, async raw => {
      const result = await new CcAgentWorker(settings, { environment: {
        PATH: process.env.PATH, HOME: home, CLAUDE_CONFIG_DIR: configDir, TMPDIR: cwd, CLAUDE_CODE_TMPDIR: cwd,
        ANTHROPIC_BASE_URL: loopback.url, ANTHROPIC_API_KEY: "sk-ant-local-only", CLAUDE_CODE_MAX_RETRIES: "0", ...opts,
      } }).run(raw as CcAgentTask, 0);
      if (result.nativeLog) logs.push(result.nativeLog);
      return result;
    });
    const project = memory.store.createProject({ name: "native-noter-two-tasks", declaredBy: "mark" });
    session = memory.store.createSession({ projectId: project.id, host: "cc:native", enrollmentChoice: true, startedAt: "now", firstReplyAt: "now" });
    const first = memory.store.appendTurn({ sessionId: session.id, kind: "turn", userPrompt: "User established an earlier rule", assistantText: "Claude Code recorded the rule", startedAt: "now" });
    const second = memory.store.appendTurn({ sessionId: session.id, parentTurnId: first.id, kind: "turn", userPrompt: "New discussion", assistantText: "Claude Code considered it", startedAt: "later" });
    path = { sessionId: session.id, branch: "main", headTurnId: second.id };
    entries = memory.store.sourcePath(session.id, "main", second.id).filter(e => e.turnId === second.id);
    beforeKnowledge = memory.store.currentKnowledge(path);
    try {
      const outcome = await memory.noting({ ...path, model: "sonnet", toolNames: ccWorkerToolNames, workspaceRoot: ccWorkspaceRoot(cwd) });
      const transcripts = logs.map(log => readFileSync(log, "utf8"));
      if (process.env.TM144_EVIDENCE) {
        mkdirSync(process.env.TM144_EVIDENCE, { recursive: true });
        writeFileSync(join(process.env.TM144_EVIDENCE, `cc-${variant}.requests.json`), JSON.stringify(requests, null, 2) + "\n");
        transcripts.forEach((text, i) => writeFileSync(join(process.env.TM144_EVIDENCE!, `cc-${variant}.task${i + 1}.jsonl`), text));
        writeFileSync(join(process.env.TM144_EVIDENCE, `cc-${variant}.outcome.json`), JSON.stringify(outcome, null, 2) + "\n");
      }
      expect(checkpointError).toBeUndefined();
      expect(checkpointsRun).toBe(Object.keys(checkpoints).length);
      expect(requests, JSON.stringify(outcome)).toHaveLength(steps.length);
      const runs = memory.store.listRuns(session.id);
      const succeeded = variant !== "unfixed";
      expect(outcome.outcome, JSON.stringify(outcome)).toBe(succeeded ? "success" : "failure");
      for (const entry of entries) expect(memory.store.entryNoted(entry.id), `entry ${entry.id} processed in ${variant}`).toBe(succeeded);
      expect(memory.store.db.prepare("SELECT count(*) AS n FROM task_handoffs").get()).toEqual({ n: 0 });
      expect(existsSync(join(cwd, "outside.txt"))).toBe(false);
      if (!succeeded) {
        expect(runs.map(run => run.outcome)).toEqual(["failure"]); // task 1 failed its second stop check; task 2 never ran
        expect(JSON.stringify(outcome)).toContain("T2#E99");
        expect(memory.store.listSessionFacts(session.id)).toEqual([]);
        return;
      }
      expect(runs.map(run => [run.outcome, JSON.parse(run.response!).task])).toEqual([["success", "write"], ["success", "verify"]]);
      expect(logs).toHaveLength(2);
      for (const text of transcripts) expect(text).toContain(ccWorkerToolNames.check);
      if (variant === "published") {
        expect(transcripts[0]).toContain("this task may use only its two workspace files"); // Write outside the workspace is denied by the hook
        // Both tasks open with the same bytes (system prompt, tool definitions, task text), so task 2 reads task 1's cached prefix.
        const [one, two] = [requests[0], requests[6]] as [{ system: unknown; tools: unknown; messages: unknown[] }, { system: unknown; tools: unknown; messages: unknown[] }];
        expect(JSON.stringify(two.system)).toBe(JSON.stringify(one.system));
        expect(JSON.stringify(two.tools)).toBe(JSON.stringify(one.tools));
        expect(JSON.stringify(two.messages[0])).toBe(JSON.stringify(one.messages[0]));
        const facts = memory.store.listSessionFacts(session.id);
        expect(facts.map(f => f.title).sort()).toEqual(["Episode one", "Episode two, verified"]); // task 2's Edit is what is published
        const current = memory.store.currentKnowledge(path);
        expect(current).toHaveLength(1);
        expect([...current[0]!.revision.supports].sort()).toEqual(facts.map(f => f.id).sort());
      } else {
        if (variant === "corrected-at-stop") {
          expect(JSON.stringify(requests)).toContain("Your files do not pass the check");
          expect(memory.store.listSessionFacts(session.id).map(f => f.source)).toEqual([["T2#E1"]]);
        } else expect(memory.store.listSessionFacts(session.id)).toEqual([]);
        expect(memory.store.currentKnowledge(path)).toEqual(beforeKnowledge);
      }
    } finally { memory.close(); await loopback.close(); }
  }, 120_000);
