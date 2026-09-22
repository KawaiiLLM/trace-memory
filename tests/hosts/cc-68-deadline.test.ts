import { afterEach, expect, test, vi } from "vitest";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { TraceMemory, type DreamingAgentInput, type NotingAgentInput } from "../../src/core/api/index.ts";
import { resolveCcHostConfig } from "../../src/hosts/cc/config.ts";
import { CcAgentWorker, type CcAgentTask } from "../../src/hosts/cc/worker.ts";

const dirs: string[] = [];
afterEach(() => {
  vi.useRealTimers();
  for (const directory of dirs.splice(0)) rmSync(directory, { recursive: true, force: true });
});

function seed(memory: ReturnType<typeof TraceMemory>) {
  const store = memory.store;
  const project = store.createProject({ name: "cc-deadline", declaredBy: "mark" });
  const session = store.createSession({ host: "cc:deadline", enrollmentChoice: true, projectId: project.id,
    startedAt: "now", firstReplyAt: "now" });
  const turn = store.appendTurn({ sessionId: session.id, kind: "turn", userPrompt: "rule", startedAt: "now" });
  const entry = memory.appendEntry({ sessionId: session.id, turnId: turn.id, nativeLineage: "deadline", nativeId: "root",
    role: "user", text: "rule", raw: "{}", calls: [] });
  memory.selectEntries(session.id, "main", [entry.id]);
  const noted = store.commitNotingRun({ run: { kind: "manual", sessionId: session.id, createdAt: "now" }, facts: [{
    turnId: turn.id, entryIds: [entry.id], category: "decision", actor: "user", text: "rule",
    source: [`T${turn.id}#E1`], createdAt: "now",
  }] });
  if (!noted.ok) throw new Error(noted.problems.join("; "));
  const created = store.commitConsolidationRun({ run: { kind: "manual", sessionId: session.id, createdAt: "now" }, operations: [{
    op: "create", handle: "$deadline", author: "fixture", text: "timed knowledge", category: "constraint", scope: "project",
    supports: [noted.facts[0]!.id], topics: [], reason: "fixture", createdAt: "now",
  }] });
  if (!created.ok) throw new Error(created.problems.join("; "));
  return { session, target: { sessionId: session.id, branch: "main", headTurnId: turn.id, triggerEntryId: entry.id } };
}

function init(directory: string, tools: string[], sessionId: string) {
  return { type: "system", subtype: "init", session_id: sessionId, messaging_socket_path: `/tmp/${sessionId}.sock`,
    claude_code_version: "2.1.257", cwd: directory, tools, plugins: [], skills: [], slash_commands: [],
    mcp_servers: [{ name: "trace_memory", status: "connected" }] };
}

test("shared Dreamer deadline terminates an actual CC adapter run and leaves the worker reusable", async () => {
  const directory = mkdtempSync(join(tmpdir(), "tm-cc-deadline-")); dirs.push(directory);
  const executable = join(directory, "claude");
  writeFileSync(executable, "#!/bin/sh\necho '2.1.257 (Claude Code)'\n"); chmodSync(executable, 0o700);
  const config = resolveCcHostConfig({ dbPath: join(directory, "memory.sqlite"), stateDir: join(directory, "state"),
    notingModel: "sonnet", notingThinking: "medium", consolidationModel: "sonnet", consolidationThinking: "medium",
    "dreaming.model": "sonnet", "dreaming.thinking": "medium", "dreaming.triggerTokens": 1, "dreaming.timeoutMs": 1_000,
    worker: { claudeExecutable: executable, claudeVersion: "2.1.257", contextWindows: { sonnet: 200_000 }, cwd: directory } });

  let calls = 0, deadlineRun = true, releaseStarted!: () => void, releaseLate!: () => void, releaseFirst!: () => void;
  const started = new Promise<void>(resolve => { releaseStarted = resolve; });
  const lateFinished = new Promise<void>(resolve => { releaseLate = resolve; });
  const firstSettled = new Promise<void>(resolve => { releaseFirst = resolve; });
  let lateText = "", lateRejected = false, firstFinalized = false;
  const fakeQuery = ((request: { options: Record<string, any> }) => {
    const invocation = ++calls;
    const stream = (async function* () {
      if (!deadlineRun) {
        yield init(directory, request.options.allowedTools, `healthy-${invocation}`);
        yield { type: "result", subtype: "success", session_id: `healthy-${invocation}`, is_error: false,
          result: "healthy", errors: [], usage: { input_tokens: 1, output_tokens: 1,
            cache_read_input_tokens: 0, cache_creation_input_tokens: 0 }, total_cost_usd: 0 };
        return;
      }
      let client: Client | undefined;
      try {
        const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
        await request.options.mcpServers.trace_memory.instance.connect(serverTransport);
        client = new Client({ name: "deadline-test", version: "1" }); await client.connect(clientTransport);
        yield init(directory, request.options.allowedTools, "timed-child");
        yield { type: "assistant", session_id: "timed-child", message: { id: "tool-round", content: [{
          type: "tool_use", id: "late-memory", name: "memory", input: { operations: [], skipped: [] },
        }], usage: { input_tokens: 2, output_tokens: 1, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 } } };
        releaseStarted();
        const signal = request.options.abortController.signal as AbortSignal;
        await new Promise<void>(resolve => signal.addEventListener("abort", () => resolve(), { once: true }));
        try {
          const late = await client.callTool({ name: "memory", arguments: { operations: [], skipped: [] },
            _meta: { "claudecode/toolUseId": "late-memory" } });
          lateText = (late.content as { type: string; text: string }[])[0]?.text ?? "";
        } catch (error) {
          lateRejected = true; lateText = error instanceof Error ? error.message : String(error);
        } finally { releaseLate(); }
        throw signal.reason;
      } finally {
        firstFinalized = true;
        await client?.close(); releaseFirst();
      }
    })() as any;
    stream.supportedModels = async () => [{ value: "sonnet", supportedEffortLevels: ["medium"] }];
    return stream;
  }) as any;

  const worker = new CcAgentWorker(config, { query: fakeQuery });
  const providerRequest = { host: "cc-deadline-test" };
  const memory = TraceMemory(":memory:", raw => {
    const task = raw as CcAgentTask; task.reportRequest(providerRequest); task.reportProgress?.({ request: providerRequest });
    return worker.run(task, 0);
  }, config.coreConfig);
  const { session, target } = seed(memory);
  deadlineRun = true;
  try {
    const running = memory.dream({ ...target, model: "sonnet", subagentThinkingLevel: "medium" });
    await started;
    const result = await running;
    expect(result).toMatchObject({ outcome: "failure", problems: [expect.stringContaining("Dreaming wall-clock limit exceeded (1000 ms)")] });
    expect(memory.store.getClaim(session.id, "dreaming")).toBeNull();
    await lateFinished;
    expect(lateRejected).toBe(true);
    expect(lateText).toMatch(/abort|cancelled|finished/i);
    await firstSettled;
    expect(firstFinalized).toBe(true);

    deadlineRun = false;
    const nextTask = { kind: "noting", text: "next", prompt: "next", tools: [], acknowledgeRequest: vi.fn() } as unknown as NotingAgentInput;
    const next = await worker.run(nextTask, 0);
    expect(next).toMatchObject({ outcome: "success", output: "healthy" });
    expect(calls).toBe(2);
  } finally { memory.close(); }
});
