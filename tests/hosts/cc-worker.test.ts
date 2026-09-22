import { afterEach, expect, test, vi } from "vitest";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { TraceMemory, toolDefinitions, type ConsolidationAgentInput, type NotingAgentInput, type RunAgentResult, type TaskTarget, type ToolDefinition } from "../../src/core/api/index.ts";
import { resolveCcHostConfig, CC_CONTEXT_HEADROOM } from "../../src/hosts/cc/config.ts";
import { CcAgentWorker, CcResponseOrigins, type CcAgentTask } from "../../src/hosts/cc/worker.ts";
import { CC_MAX_RESULT_CHARS } from "../../src/hosts/cc/tools.ts";
import { CcTaskScheduler } from "../../src/hosts/cc/scheduler.ts";

const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });

function workerConfig(directory: string, claudeExecutable = "/opt/homebrew/bin/claude") {
  return resolveCcHostConfig({ dbPath: join(directory, "memory.sqlite"), stateDir: join(directory, "state"),
    notingModel: "claude-sonnet-4-5", notingThinking: "medium",
    consolidationModel: "claude-sonnet-4-5", consolidationThinking: "medium",
    "dreaming.model": "claude-sonnet-4-5", "dreaming.thinking": "medium",
    worker: { claudeExecutable, claudeVersion: "2.1.257", contextWindows: { "claude-sonnet-4-5": 200_000 },
      cwd: directory, responseOriginTimeoutMs: 20 } });
}

function phaseWorkerConfig(directory: string) {
  return resolveCcHostConfig({ dbPath: join(directory, "memory.sqlite"), stateDir: join(directory, "state"),
    notingModel: "sonnet", notingThinking: "low", consolidationModel: "opus-c", consolidationThinking: "high",
    "dreaming.model": "opus-d", "dreaming.thinking": "max", worker: { claudeExecutable: "/opt/homebrew/bin/claude",
      claudeVersion: "2.1.257", contextWindows: { sonnet: 120_000, "opus-c": 220_000, "opus-d": 320_000 }, cwd: directory } });
}

function assistant(id: string, toolIds: string[]) {
  return { type: "assistant", message: { id, content: toolIds.map(toolId => ({ type: "tool_use", id: toolId, name: "note", input: {} })) } } as any;
}

function originTask(signal?: AbortSignal) {
  const acknowledgeRequest = vi.fn();
  return { task: { acknowledgeRequest, signal } as unknown as NotingAgentInput, acknowledgeRequest };
}

test("production worker serves original schemas and raw arguments, publishes the result bound, and maps origins and usage", async () => {
  const directory = mkdtempSync(join(tmpdir(), "tm-cc-worker-real-")); dirs.push(directory);
  const executable = join(directory, "claude");
  writeFileSync(executable, "#!/bin/sh\necho '2.1.257 (Claude Code)'\n"); chmodSync(executable, 0o700);
  const conditional = { type: "object", properties: { cursor: { type: "string" }, pageBudget: { type: "integer", default: 2000 } },
    if: { required: ["cursor"] }, then: { not: { required: ["pageBudget"] } }, additionalProperties: false };
  const seen: unknown[] = [], listed: unknown[] = [], optionsSeen: Record<string, unknown>[] = [];
  const definition: ToolDefinition = { name: "trace", description: "read", parameters: conditional,
    execute: input => { seen.push(structuredClone(input)); return "x".repeat(CC_MAX_RESULT_CHARS); } };
  const fakeQuery = ((request: { options: Record<string, any> }) => {
    optionsSeen.push(request.options);
    const stream = (async function* () {
      const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
      await request.options.mcpServers.trace_memory.instance.connect(serverTransport);
      const client = new Client({ name: "worker-test", version: "1" }); await client.connect(clientTransport);
      listed.push(await client.listTools());
      yield { type: "system", subtype: "init", claude_code_version: "2.1.257", cwd: directory,
        tools: ["mcp__trace_memory__trace"], plugins: [], skills: [], slash_commands: [],
        mcp_servers: [{ name: "trace_memory", status: "connected" }] };
      yield assistant("response-raw", ["call-raw"]);
      await client.callTool({ name: "trace", arguments: { cursor: "opaque-K" }, _meta: { "claudecode/toolUseId": "call-raw" } });
      yield { type: "result", subtype: "success", is_error: false, result: "done", errors: [], num_turns: 1,
        usage: { input_tokens: 11, output_tokens: 7, cache_read_input_tokens: 5, cache_creation_input_tokens: 3 },
        modelUsage: {}, total_cost_usd: 0.125 };
      await client.close();
    })() as any;
    stream.supportedModels = async () => [{ value: "claude-sonnet-4-5", supportedEffortLevels: ["medium"] }];
    return stream;
  }) as any;
  const acknowledgeRequest = vi.fn();
  const task = { kind: "noting", text: "material", prompt: "instructions", tools: [definition], acknowledgeRequest } as unknown as CcAgentTask;
  const result = await new CcAgentWorker(workerConfig(directory, executable), { query: fakeQuery }).run(task, 2);
  expect(result.outcome).toBe("success");
  expect(result.usage).toEqual({ input: 11, output: 7, cacheRead: 5, cacheWrite: 3, cost: { total: 0.125 } });
  expect(seen).toEqual([{ cursor: "opaque-K" }]);
  expect(acknowledgeRequest).toHaveBeenCalledTimes(1);
  expect((listed[0] as any).tools[0]).toMatchObject({ inputSchema: conditional,
    _meta: { "anthropic/maxResultSizeChars": CC_MAX_RESULT_CHARS } });
  expect(optionsSeen[0]).toMatchObject({ settingSources: [], plugins: [], tools: [], strictMcpConfig: true });
  expect(optionsSeen[0]).not.toHaveProperty("hooks");
});

test("simultaneous phase workers keep model and thinking selection isolated", async () => {
  const directory = mkdtempSync(join(tmpdir(), "tm-cc-worker-phases-")); dirs.push(directory);
  const executable = join(directory, "claude");
  writeFileSync(executable, "#!/bin/sh\necho '2.1.257 (Claude Code)'\n"); chmodSync(executable, 0o700);
  const config = resolveCcHostConfig({ dbPath: join(directory, "memory.sqlite"), stateDir: join(directory, "state"),
    notingModel: "sonnet", notingThinking: "low", consolidationModel: "opus-c", consolidationThinking: "high",
    "dreaming.model": "opus-d", "dreaming.thinking": "max", worker: { claudeExecutable: executable,
      claudeVersion: "2.1.257", contextWindows: { sonnet: 120_000, "opus-c": 220_000, "opus-d": 320_000 }, cwd: directory } });
  const observed: { model: string; effort: string }[] = [];
  let arrivals = 0, release!: () => void; const barrier = new Promise<void>(resolve => { release = resolve; });
  const fakeQuery = ((request: { options: Record<string, any> }) => {
    const model = request.options.model as string, effort = request.options.extraArgs.effort as string;
    observed.push({ model, effort }); if (++arrivals === 3) release();
    const stream = (async function* () {
      await barrier;
      yield { type: "system", subtype: "init", session_id: model, claude_code_version: "2.1.257", cwd: directory,
        tools: [], plugins: [], skills: [], slash_commands: [], mcp_servers: [{ name: "trace_memory", status: "connected" }] };
      yield { type: "result", subtype: "success", session_id: model, is_error: false, result: "done", errors: [],
        usage: { input_tokens: 0, output_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 }, total_cost_usd: 0 };
    })() as any;
    stream.supportedModels = async () => [{ value: model, supportedEffortLevels: [effort] }];
    return stream;
  }) as any;
  const worker = new CcAgentWorker(config, { query: fakeQuery });
  const task = (kind: "noting" | "consolidation" | "dreaming", model: string, thinking: string) => ({ kind, model,
    subagentThinkingLevel: thinking, text: "material", prompt: "instructions", tools: [], acknowledgeRequest: vi.fn(),
    ...(kind === "dreaming" ? { reportRounds: vi.fn(), passEnd: vi.fn(() => undefined) } : {}) }) as unknown as CcAgentTask;
  const results = await Promise.all([
    worker.run(task("noting", "sonnet", "low"), 0),
    worker.run(task("consolidation", "opus-c", "high"), 0),
    worker.run(task("dreaming", "opus-d", "max"), 0),
  ]);
  expect(results.map(result => result.thinking)).toEqual([
    { requested: "low", effective: "low" }, { requested: "high", effective: "high" }, { requested: "max", effective: "max" },
  ]);
  expect(new Set(observed.map(value => `${value.model}/${value.effort}`))).toEqual(new Set(["sonnet/low", "opus-c/high", "opus-d/max"]));
});

test("worker rejects runtime metadata that does not support the selected phase thinking", async () => {
  const directory = mkdtempSync(join(tmpdir(), "tm-cc-worker-metadata-")); dirs.push(directory);
  const executable = join(directory, "claude");
  writeFileSync(executable, "#!/bin/sh\necho '2.1.257 (Claude Code)'\n"); chmodSync(executable, 0o700);
  const fakeQuery = (() => {
    const stream = (async function* () {
      yield { type: "system", subtype: "init", claude_code_version: "2.1.257", cwd: directory,
        tools: [], plugins: [], skills: [], slash_commands: [], mcp_servers: [{ name: "trace_memory", status: "connected" }] };
    })() as any;
    stream.supportedModels = async () => [{ value: "claude-sonnet-4-5", supportedEffortLevels: ["low"] }];
    return stream;
  }) as any;
  const task = { kind: "noting", model: "claude-sonnet-4-5", subagentThinkingLevel: "medium", text: "material",
    prompt: "instructions", tools: [], acknowledgeRequest: vi.fn() } as unknown as CcAgentTask;
  await expect(new CcAgentWorker(workerConfig(directory, executable), { query: fakeQuery }).run(task, 0))
    .resolves.toMatchObject({ outcome: "failure", output: expect.stringContaining("effort medium is not supported") });
});

test("Dreamer uses one streaming child for one repair, accepts stable repeated init, and aggregates pass usage", async () => {
  const directory = mkdtempSync(join(tmpdir(), "tm-cc-worker-dreamer-")); dirs.push(directory);
  const executable = join(directory, "claude");
  writeFileSync(executable, "#!/bin/sh\necho '2.1.257 (Claude Code)'\n"); chmodSync(executable, 0o700);
  const prompts: any[] = [], passEnd = vi.fn().mockReturnValueOnce("repair receipt").mockReturnValueOnce(undefined);
  const fakeQuery = ((request: { prompt: AsyncIterable<any>; options: Record<string, any> }) => {
    const stream = (async function* () {
      const input = request.prompt[Symbol.asyncIterator]();
      prompts.push((await input.next()).value);
      const init = { type: "system", subtype: "init", session_id: "native-child", messaging_socket_path: "/tmp/one.sock",
        claude_code_version: "2.1.257", cwd: directory, tools: [], plugins: [], skills: [], slash_commands: [],
        mcp_servers: [{ name: "trace_memory", status: "connected" }] };
      yield init;
      yield { type: "result", subtype: "success", session_id: "native-child", is_error: false, result: "first", errors: [], num_turns: 1,
        usage: { input_tokens: 11, output_tokens: 7, cache_read_input_tokens: 5, cache_creation_input_tokens: 3 },
        modelUsage: {}, total_cost_usd: 0.125 };
      prompts.push((await input.next()).value);
      yield { ...init };
      yield { type: "result", subtype: "success", session_id: "native-child", is_error: false, result: "final", errors: [], num_turns: 1,
        usage: { input_tokens: 13, output_tokens: 9, cache_read_input_tokens: 6, cache_creation_input_tokens: 4 },
        modelUsage: {}, total_cost_usd: 0.25 };
    })() as any;
    stream.supportedModels = async () => [{ value: "claude-sonnet-4-5", supportedEffortLevels: ["medium"] }];
    return stream;
  }) as any;
  const task = { kind: "dreaming", text: "frozen material", prompt: "instructions", tools: [], acknowledgeRequest: vi.fn(),
    reportRounds: vi.fn(), passEnd } as unknown as CcAgentTask;
  const result = await new CcAgentWorker(workerConfig(directory, executable), { query: fakeQuery }).run(task, 50);
  expect(result).toMatchObject({ outcome: "success", output: "final",
    usage: { input: 24, output: 16, cacheRead: 11, cacheWrite: 7, cost: { total: 0.25 } } });
  expect(passEnd).toHaveBeenCalledTimes(2);
  expect(prompts.map(value => ({ text: value.message.content[0].text, synthetic: value.isSynthetic ?? false })))
    .toEqual([{ text: "frozen material", synthetic: false }, { text: "repair receipt", synthetic: true }]);
});

test("Dreamer rejects an unsolicited second pass and does not call passEnd twice", async () => {
  const directory = mkdtempSync(join(tmpdir(), "tm-cc-worker-unsolicited-")); dirs.push(directory);
  const executable = join(directory, "claude");
  writeFileSync(executable, "#!/bin/sh\necho '2.1.257 (Claude Code)'\n"); chmodSync(executable, 0o700);
  const passEnd = vi.fn(() => undefined);
  const fakeQuery = ((request: { prompt: AsyncIterable<any> }) => {
    const stream = (async function* () {
      await request.prompt[Symbol.asyncIterator]().next();
      yield { type: "system", subtype: "init", session_id: "one", messaging_socket_path: "/tmp/one.sock",
        claude_code_version: "2.1.257", cwd: directory, tools: [], plugins: [], skills: [], slash_commands: [],
        mcp_servers: [{ name: "trace_memory", status: "connected" }] };
      for (const result of ["first", "unsolicited"]) yield { type: "result", subtype: "success", session_id: "one",
        is_error: false, result, errors: [], usage: { input_tokens: 1, output_tokens: 1,
          cache_read_input_tokens: 0, cache_creation_input_tokens: 0 }, total_cost_usd: 0.1 };
    })() as any;
    stream.supportedModels = async () => [{ value: "claude-sonnet-4-5", supportedEffortLevels: ["medium"] }];
    return stream;
  }) as any;
  const task = { kind: "dreaming", text: "material", prompt: "instructions", tools: [], acknowledgeRequest: vi.fn(),
    reportRounds: vi.fn(), passEnd } as unknown as CcAgentTask;
  await expect(new CcAgentWorker(workerConfig(directory, executable), { query: fakeQuery }).run(task, 50))
    .resolves.toMatchObject({ outcome: "failure", output: expect.stringContaining("after its authorized final pass") });
  expect(passEnd).toHaveBeenCalledTimes(1);
});

test("Dreamer fails when a requested repair pass never completes", async () => {
  const directory = mkdtempSync(join(tmpdir(), "tm-cc-worker-missing-repair-")); dirs.push(directory);
  const executable = join(directory, "claude");
  writeFileSync(executable, "#!/bin/sh\necho '2.1.257 (Claude Code)'\n"); chmodSync(executable, 0o700);
  const fakeQuery = ((request: { prompt: AsyncIterable<any> }) => {
    const stream = (async function* () {
      await request.prompt[Symbol.asyncIterator]().next();
      yield { type: "system", subtype: "init", session_id: "one", messaging_socket_path: "/tmp/one.sock",
        claude_code_version: "2.1.257", cwd: directory, tools: [], plugins: [], skills: [], slash_commands: [],
        mcp_servers: [{ name: "trace_memory", status: "connected" }] };
      yield { type: "result", subtype: "success", session_id: "one", is_error: false, result: "first", errors: [],
        usage: { input_tokens: 1, output_tokens: 1, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 }, total_cost_usd: 0.1 };
      await request.prompt[Symbol.asyncIterator]().next();
    })() as any;
    stream.supportedModels = async () => [{ value: "claude-sonnet-4-5", supportedEffortLevels: ["medium"] }];
    return stream;
  }) as any;
  const task = { kind: "dreaming", text: "material", prompt: "instructions", tools: [], acknowledgeRequest: vi.fn(),
    reportRounds: vi.fn(), passEnd: vi.fn(() => "repair") } as unknown as CcAgentTask;
  await expect(new CcAgentWorker(workerConfig(directory, executable), { query: fakeQuery }).run(task, 50))
    .resolves.toMatchObject({ outcome: "failure", output: expect.stringContaining("before completing") });
});

test("Dreamer does not issue a repair after a failed native pass", async () => {
  const directory = mkdtempSync(join(tmpdir(), "tm-cc-worker-dreamer-identity-")); dirs.push(directory);
  const executable = join(directory, "claude");
  writeFileSync(executable, "#!/bin/sh\necho '2.1.257 (Claude Code)'\n"); chmodSync(executable, 0o700);
  const passEnd = vi.fn(() => "must not run");
  const fakeQuery = ((request: { prompt: AsyncIterable<any> }) => {
    const stream = (async function* () {
      const input = request.prompt[Symbol.asyncIterator](); await input.next();
      yield { type: "system", subtype: "init", session_id: "one", messaging_socket_path: "/tmp/one.sock",
        claude_code_version: "2.1.257", cwd: directory, tools: [], plugins: [], skills: [], slash_commands: [],
        mcp_servers: [{ name: "trace_memory", status: "connected" }] };
      yield { type: "result", subtype: "error_during_execution", session_id: "one", is_error: true, errors: ["provider failed"],
        usage: { input_tokens: 1, output_tokens: 1, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 }, total_cost_usd: 0.1 };
    })() as any;
    stream.supportedModels = async () => [{ value: "claude-sonnet-4-5", supportedEffortLevels: ["medium"] }];
    return stream;
  }) as any;
  const task = { kind: "dreaming", text: "material", prompt: "instructions", tools: [], acknowledgeRequest: vi.fn(),
    reportRounds: vi.fn(), passEnd } as unknown as CcAgentTask;
  expect(await new CcAgentWorker(workerConfig(directory, executable), { query: fakeQuery }).run(task, 50))
    .toMatchObject({ outcome: "failure", output: "provider failed" });
  expect(passEnd).not.toHaveBeenCalled();
});

test("Dreamer rejects a repeated init from a different native child", async () => {
  const directory = mkdtempSync(join(tmpdir(), "tm-cc-worker-dreamer-init-")); dirs.push(directory);
  const executable = join(directory, "claude");
  writeFileSync(executable, "#!/bin/sh\necho '2.1.257 (Claude Code)'\n"); chmodSync(executable, 0o700);
  const fakeQuery = ((request: { prompt: AsyncIterable<any> }) => {
    const stream = (async function* () {
      const input = request.prompt[Symbol.asyncIterator](); await input.next();
      const init = { type: "system", subtype: "init", session_id: "one", messaging_socket_path: "/tmp/one.sock",
        claude_code_version: "2.1.257", cwd: directory, tools: [], plugins: [], skills: [], slash_commands: [],
        mcp_servers: [{ name: "trace_memory", status: "connected" }] };
      yield init;
      yield { type: "result", subtype: "success", session_id: "one", is_error: false, result: "first", errors: [],
        usage: { input_tokens: 1, output_tokens: 1, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 }, total_cost_usd: 0.1 };
      await input.next();
      yield { ...init, session_id: "two" };
    })() as any;
    stream.supportedModels = async () => [{ value: "claude-sonnet-4-5", supportedEffortLevels: ["medium"] }];
    return stream;
  }) as any;
  const task = { kind: "dreaming", text: "material", prompt: "instructions", tools: [], acknowledgeRequest: vi.fn(),
    reportRounds: vi.fn(), passEnd: vi.fn(() => "repair") } as unknown as CcAgentTask;
  expect(await new CcAgentWorker(workerConfig(directory, executable), { query: fakeQuery }).run(task, 50))
    .toMatchObject({ outcome: "failure", output: expect.stringContaining("different native session") });
});

test("production worker forwards only the isolated operational and session environment", async () => {
  const directory = mkdtempSync(join(tmpdir(), "tm-cc-worker-env-")); dirs.push(directory);
  const executable = join(directory, "claude");
  writeFileSync(executable, "#!/bin/sh\necho '2.1.257 (Claude Code)'\n"); chmodSync(executable, 0o700);
  const operational = ["HOME", "PATH", "TMPDIR", "TMP", "TEMP", "LANG", "TZ", "SHELL", "USER", "LOGNAME",
    "XDG_CACHE_HOME", "XDG_CONFIG_HOME", "SSL_CERT_FILE", "SSL_CERT_DIR", "CURL_CA_BUNDLE", "REQUESTS_CA_BUNDLE", "LC_CUSTOM"];
  const session = ["ANTHROPIC_AUTH_TOKEN", "ANTHROPIC_API_KEY", "CLAUDE_CODE_OAUTH_TOKEN", "ANTHROPIC_BASE_URL",
    "ANTHROPIC_CUSTOM_HEADERS", "NODE_EXTRA_CA_CERTS", "ANTHROPIC_DEFAULT_OPUS_MODEL", "ANTHROPIC_DEFAULT_SONNET_MODEL",
    "ANTHROPIC_DEFAULT_HAIKU_MODEL", "http_proxy", "HTTP_PROXY", "https_proxy", "HTTPS_PROXY", "all_proxy", "ALL_PROXY",
    "no_proxy", "NO_PROXY", "NODE_USE_ENV_PROXY", "CLAUDE_CODE_PROXY_RESOLVES_HOSTS", "CLAUDE_CONFIG_DIR"];
  const excluded = ["CLAUDE_CODE_SESSION_ID", "CLAUDE_CODE_CHILD_SESSION", "CLAUDE_CODE_MESSAGING_PORT",
    "CLAUDE_CODE_BRIDGE_SESSION_ID", "CLAUDE_CODE_ENTRYPOINT", "CLAUDE_CODE_MAX_CONTEXT_TOKENS", "UNRELATED_SECRET"];
  const source = Object.fromEntries([...operational, ...session, ...excluded].map(key => [key, `dummy-${key}`]));
  source.DISABLE_AUTOUPDATER = "0";
  let environment: NodeJS.ProcessEnv | undefined;
  const fakeQuery = ((request: { options: Record<string, any> }) => {
    environment = request.options.env;
    const stream = (async function* () {
      yield { type: "system", subtype: "init", claude_code_version: "2.1.257", cwd: directory,
        tools: [], plugins: [], skills: [], slash_commands: [], mcp_servers: [{ name: "trace_memory", status: "connected" }] };
      yield { type: "result", subtype: "success", is_error: false, result: "done", errors: [], num_turns: 0,
        usage: { input_tokens: 0, output_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
        modelUsage: {}, total_cost_usd: 0 };
    })() as any;
    stream.supportedModels = async () => [{ value: "claude-sonnet-4-5", supportedEffortLevels: ["medium"] }];
    return stream;
  }) as any;
  const task = { kind: "noting", text: "material", prompt: "instructions", tools: [], acknowledgeRequest: vi.fn() } as unknown as CcAgentTask;
  expect((await new CcAgentWorker(workerConfig(directory, executable), { environment: source, query: fakeQuery }).run(task, 0)).outcome).toBe("success");
  for (const key of [...operational, ...session]) expect(environment?.[key]).toBe(`dummy-${key}`);
  for (const key of excluded) expect(environment).not.toHaveProperty(key);
  expect(environment).toMatchObject({ DISABLE_AUTOUPDATER: "1", DISABLE_TELEMETRY: "1", DISABLE_ERROR_REPORTING: "1",
    CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1", CLAUDE_CODE_DISABLE_FEEDBACK_SURVEY: "1", CLAUDE_CODE_DISABLE_AUTO_MEMORY: "1" });
});

const usageCounters = ["input_tokens", "output_tokens", "cache_read_input_tokens", "cache_creation_input_tokens"] as const;
const invalidUsageCases = usageCounters.flatMap(counter => ([
  [`missing ${counter}`, counter, undefined], [`non-numeric ${counter}`, counter, "unknown"],
] as const));
test.each(invalidUsageCases)("production worker preserves unknown usage for %s", async (_label, invalid, value) => {
  const directory = mkdtempSync(join(tmpdir(), "tm-cc-worker-usage-")); dirs.push(directory);
  const executable = join(directory, "claude");
  writeFileSync(executable, "#!/bin/sh\necho '2.1.257 (Claude Code)'\n"); chmodSync(executable, 0o700);
  const usage: Record<string, unknown> = { input_tokens: 1, output_tokens: 2, cache_read_input_tokens: 3, cache_creation_input_tokens: 4 };
  if (value === undefined) delete usage[invalid]; else usage[invalid] = value;
  const fakeQuery = (() => {
    const stream = (async function* () {
      yield { type: "system", subtype: "init", claude_code_version: "2.1.257", cwd: directory,
        tools: [], plugins: [], skills: [], slash_commands: [], mcp_servers: [{ name: "trace_memory", status: "connected" }] };
      yield { type: "result", subtype: "success", is_error: false, result: "done", errors: [], num_turns: 0,
        usage, modelUsage: {}, total_cost_usd: 0.5 };
    })() as any;
    stream.supportedModels = async () => [{ value: "claude-sonnet-4-5", supportedEffortLevels: ["medium"] }];
    return stream;
  }) as any;
  const task = { kind: "noting", text: "material", prompt: "instructions", tools: [], acknowledgeRequest: vi.fn() } as unknown as CcAgentTask;
  const result = await new CcAgentWorker(workerConfig(directory, executable), { query: fakeQuery }).run(task, 0);
  expect(result.outcome).toBe("success");
  expect(result.usage).toBeUndefined();
});

test("production worker preserves legitimate all-zero usage", async () => {
  const directory = mkdtempSync(join(tmpdir(), "tm-cc-worker-zero-")); dirs.push(directory);
  const executable = join(directory, "claude");
  writeFileSync(executable, "#!/bin/sh\necho '2.1.257 (Claude Code)'\n"); chmodSync(executable, 0o700);
  const fakeQuery = (() => {
    const stream = (async function* () {
      yield { type: "system", subtype: "init", claude_code_version: "2.1.257", cwd: directory,
        tools: [], plugins: [], skills: [], slash_commands: [], mcp_servers: [{ name: "trace_memory", status: "connected" }] };
      yield { type: "result", subtype: "success", is_error: false, result: "done", errors: [], num_turns: 0,
        usage: { input_tokens: 0, output_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
        modelUsage: {}, total_cost_usd: 0 };
    })() as any;
    stream.supportedModels = async () => [{ value: "claude-sonnet-4-5", supportedEffortLevels: ["medium"] }];
    return stream;
  }) as any;
  const task = { kind: "noting", text: "material", prompt: "instructions", tools: [], acknowledgeRequest: vi.fn() } as unknown as CcAgentTask;
  const result = await new CcAgentWorker(workerConfig(directory, executable), { query: fakeQuery }).run(task, 0);
  expect(result.usage).toEqual({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: { total: 0 } });
});

test("production MCP preserves non-default trace and search cursors through real core bindings and accounts usage", async () => {
  const directory = mkdtempSync(join(tmpdir(), "tm-cc-worker-core-")); dirs.push(directory);
  const executable = join(directory, "claude");
  writeFileSync(executable, "#!/bin/sh\necho '2.1.257 (Claude Code)'\n"); chmodSync(executable, 0o700);
  const schemas: unknown[] = [], rawInputs: Record<string, unknown>[] = [];
  const text = `needle ${"word ".repeat(1200)}`;
  const fakeQuery = ((request: { options: Record<string, any> }) => {
    const stream = (async function* () {
      const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
      await request.options.mcpServers.trace_memory.instance.connect(serverTransport);
      const client = new Client({ name: "core-worker-test", version: "1" }); await client.connect(clientTransport);
      schemas.push(await client.listTools());
      const names = (schemas[0] as any).tools.map((value: { name: string }) => `mcp__trace_memory__${value.name}`);
      yield { type: "system", subtype: "init", claude_code_version: "2.1.257", cwd: directory,
        tools: names, plugins: [], skills: [], slash_commands: [], mcp_servers: [{ name: "trace_memory", status: "connected" }] };
      const call = async (response: string, id: string, name: string, input: Record<string, unknown>) => {
        rawInputs.push(structuredClone(input));
        const result = await client.callTool({ name, arguments: input, _meta: { "claudecode/toolUseId": id } });
        return (result.content as { type: string; text: string }[])[0]!.text;
      };
      let id = 0;
      yield assistant(`trace-${++id}`, [`trace-${id}`]);
      let page = await call(`trace-${id}`, `trace-${id}`, "trace", { address: "T1@user", pageBudget: 64 });
      expect(page).toContain("cursor=");
      while (/cursor=(\S+)/.exec(page)?.[1]) {
        const cursor = /cursor=(\S+)/.exec(page)![1];
        yield assistant(`trace-${++id}`, [`trace-${id}`]);
        page = await call(`trace-${id}`, `trace-${id}`, "trace", { address: "T1@user", cursor });
      }
      yield assistant(`search-${++id}`, [`search-${id}`]);
      page = await call(`search-${id}`, `search-${id}`, "search", { query: "needle", layer: "raw", maxTokens: 256 });
      expect(page).toContain("cursor=");
      while (/cursor=(\S+)/.exec(page)?.[1]) {
        const cursor = /cursor=(\S+)/.exec(page)![1];
        yield assistant(`search-${++id}`, [`search-${id}`]);
        page = await call(`search-${id}`, `search-${id}`, "search", { cursor });
      }
      yield assistant(`note-${++id}`, [`note-${id}`]);
      await call(`note-${id}`, `note-${id}`, "note", { facts: [] });
      yield { type: "result", subtype: "success", is_error: false, result: "done", errors: [], num_turns: id,
        usage: { input_tokens: 11, output_tokens: 7, cache_read_input_tokens: 5, cache_creation_input_tokens: 3 },
        modelUsage: {}, total_cost_usd: 0.125 };
      await client.close();
    })() as any;
    stream.supportedModels = async () => [{ value: "claude-sonnet-4-5", supportedEffortLevels: ["medium"] }];
    return stream;
  }) as any;
  let memory: ReturnType<typeof TraceMemory>;
  const prepared = new CcAgentWorker(workerConfig(directory, executable), { query: fakeQuery });
  memory = TraceMemory(join(directory, "memory.sqlite"), task => prepared.run(task as CcAgentTask, 0),
    { noting: { triggerTokens: 1 } });
  const project = memory.store.createProject({ name: "core", declaredBy: "mark" });
  const session = memory.store.createSession({ host: "cc:test", projectId: project.id, startedAt: "now", firstReplyAt: "now", enrollmentChoice: true });
  const target = append(memory, session.id, "source", text);
  const result = await memory.noting({ sessionId: session.id, branch: "main", headTurnId: target.turn.id,
    triggerEntryId: target.entry.id, mode: "subagent", model: "claude-sonnet-4-5", maxReadChars: CC_MAX_RESULT_CHARS });
  if (result.outcome !== "success") throw new Error(JSON.stringify(result));
  const listed = (schemas[0] as any).tools;
  for (const name of ["trace", "search"]) expect(listed.find((value: any) => value.name === name).inputSchema)
    .toEqual(toolDefinitions.find(value => value.name === name)!.parameters);
  const continuations = rawInputs.filter(input => typeof input.cursor === "string");
  expect(continuations.length).toBeGreaterThanOrEqual(2);
  expect(continuations.every(input => !("pageBudget" in input) && !("maxTokens" in input))).toBe(true);
  expect(memory.spend(session.id)).toMatchObject({ input: 11, output: 7, cacheRead: 5, cacheWrite: 3, cost: 0.125 });
  expect(memory.trace(`R${result.runId}`, { full: true })).toContain("cost $0.1250");
  memory.close();
});

test.each([false, true])("production MCP Consolidation commits its first valid batch (invalid first=%s) and records native audit unavailability", async invalidFirst => {
  const directory = mkdtempSync(join(tmpdir(), "tm-cc-worker-consolidation-")); dirs.push(directory);
  const executable = join(directory, "claude");
  writeFileSync(executable, "#!/bin/sh\necho '2.1.257 (Claude Code)'\n"); chmodSync(executable, 0o700);
  const receipts: string[] = [];
  const valid = { operations: [{ op: "create", text: "Durable CC conclusion", category: "reference", scope: "project",
    topics: ["cc"], supports: ["F1"], reason: "New durable conclusion." }], skipped: [] };
  const fakeQuery = ((request: { options: Record<string, any> }) => {
    const stream = (async function* () {
      const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
      await request.options.mcpServers.trace_memory.instance.connect(serverTransport);
      const client = new Client({ name: "consolidation-worker-test", version: "1" }); await client.connect(clientTransport);
      const listed = await client.listTools();
      const memorySchema = (listed.tools.find(tool => tool.name === "memory") as any).inputSchema.properties.operations.items;
      expect(memorySchema.properties.op.enum).toEqual(["create"]);
      expect(memorySchema.properties).not.toHaveProperty("id");
      expect(memorySchema.properties).not.toHaveProperty("absorb");
      yield { type: "system", subtype: "init", claude_code_version: "2.1.257", cwd: directory,
        tools: listed.tools.map(tool => `mcp__trace_memory__${tool.name}`), plugins: [], skills: [], slash_commands: [],
        mcp_servers: [{ name: "trace_memory", status: "connected" }] };
      let ordinal = 0;
      const submit = async function* (arguments_: Record<string, unknown>) {
        const id = `memory-${++ordinal}`;
        yield assistant(id, [id]);
        const result = await client.callTool({ name: "memory", arguments: arguments_, _meta: { "claudecode/toolUseId": id } });
        receipts.push((result.content as { type: string; text: string }[])[0]!.text);
      };
      if (invalidFirst) yield* submit({ operations: [{ ...valid.operations[0], id: "K1@1" }], skipped: [] });
      yield* submit(valid);
      yield { type: "result", subtype: "success", is_error: false, result: "done", errors: [], num_turns: ordinal,
        usage: { input_tokens: 1, output_tokens: 1, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
        modelUsage: {}, total_cost_usd: 0 };
      await client.close();
    })() as any;
    stream.supportedModels = async () => [{ value: "claude-sonnet-4-5", supportedEffortLevels: ["medium"] }];
    return stream;
  }) as any;
  const worker = new CcAgentWorker(workerConfig(directory, executable), { query: fakeQuery });
  const memory = TraceMemory(join(directory, "memory.sqlite"), task => worker.run(task as CcAgentTask, 2),
    { consolidation: { triggerTokens: 1 } });
  const project = memory.store.createProject({ name: "core", declaredBy: "mark" });
  const session = memory.store.createSession({ host: "cc:test", projectId: project.id, startedAt: "now", firstReplyAt: "now", enrollmentChoice: true });
  const target = append(memory, session.id, "source", "Durable CC evidence");
  const noted = memory.store.commitNotingRun({ run: { kind: "noting", sessionId: session.id, branch: "main", createdAt: "now" },
    entryIds: [target.entry.id], facts: [{ turnId: target.turn.id, category: "observation", actor: "user", text: "Durable CC evidence",
      source: [`T${target.turn.id}#user`], createdAt: "now" }] });
  if (!noted.ok) throw new Error(noted.problems.join("; "));
  const result = await memory.consolidate({ sessionId: session.id, branch: "main", headTurnId: target.turn.id,
    triggerEntryId: target.entry.id, mode: "subagent", model: "claude-sonnet-4-5" });
  if (result.outcome !== "success") throw new Error(JSON.stringify(result));
  expect(memory.store.currentKnowledge()).toHaveLength(1);
  if (invalidFirst) expect(receipts[0]).toContain("rejected:");
  expect(receipts.at(-1)).toContain('"committed"');
  const run = memory.store.getRun((result as { runId: number }).runId)!;
  expect(run.request).toBeNull();
  expect(JSON.parse(run.response!).audit).toEqual({ available: false,
    reason: "Claude Agent SDK 0.1.77 does not expose the exact provider request body" });
  memory.close();
});

test("production worker reports launch failure and cancellation without invoking the provider transport", async () => {
  const directory = mkdtempSync(join(tmpdir(), "tm-cc-worker-stop-")); dirs.push(directory);
  const executable = join(directory, "claude");
  writeFileSync(executable, "#!/bin/sh\necho '2.1.256 (Claude Code)'\n"); chmodSync(executable, 0o700);
  const runQuery = vi.fn() as any;
  const base = { kind: "noting", text: "material", prompt: "instructions", tools: [], acknowledgeRequest: vi.fn() } as unknown as CcAgentTask;
  const failed = await new CcAgentWorker(workerConfig(directory, executable), { query: runQuery }).run(base, 0);
  expect(failed).toMatchObject({ outcome: "failure", output: expect.stringContaining("expected Claude Code 2.1.257") });
  expect(runQuery).not.toHaveBeenCalled();

  writeFileSync(executable, "#!/bin/sh\necho '2.1.257 (Claude Code)'\n");
  const controller = new AbortController(); controller.abort(new DOMException("test stop", "AbortError"));
  const cancelled = await new CcAgentWorker(workerConfig(directory, executable), { query: runQuery })
    .run({ ...base, signal: controller.signal } as CcAgentTask, 0);
  expect(cancelled.outcome).toBe("cancelled");
  expect(runQuery).not.toHaveBeenCalled();
});

test("production protocol aborts remain failures while external cancellation stays cancelled and outside the failure streak", async () => {
  const directory = mkdtempSync(join(tmpdir(), "tm-cc-worker-protocol-")); dirs.push(directory);
  const executable = join(directory, "claude");
  writeFileSync(executable, "#!/bin/sh\necho '2.1.257 (Claude Code)'\n"); chmodSync(executable, 0o700);
  let mode: "cancel" | "protocol" = "cancel";
  let releaseStarted!: () => void;
  const started = new Promise<void>(resolve => { releaseStarted = resolve; });
  const fakeQuery = ((request: { options: Record<string, any> }) => {
    const nativeSignal = request.options.abortController.signal as AbortSignal;
    const stream = (async function* () {
      let client: Client | undefined;
      try {
        yield { type: "system", subtype: "init", claude_code_version: "2.1.257", cwd: directory,
          tools: request.options.allowedTools, plugins: [], skills: [], slash_commands: [],
          mcp_servers: [{ name: "trace_memory", status: "connected" }] };
        if (mode === "cancel") {
          releaseStarted();
          await new Promise<void>((_resolve, reject) => nativeSignal.addEventListener("abort", () =>
            reject(new DOMException("Claude Code process aborted by user", "AbortError")), { once: true }));
        }
        const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
        await request.options.mcpServers.trace_memory.instance.connect(serverTransport);
        client = new Client({ name: "protocol-worker-test", version: "1" }); await client.connect(clientTransport);
        try { await client.callTool({ name: "note", arguments: { facts: [] } }); } catch {}
        expect(nativeSignal.aborted).toBe(true);
        throw new DOMException("Claude Code process aborted by user", "AbortError");
      } finally { await client?.close(); }
    })() as any;
    stream.supportedModels = async () => [{ value: "claude-sonnet-4-5", supportedEffortLevels: ["medium"] }];
    return stream;
  }) as any;
  const prepared = new CcAgentWorker(workerConfig(directory, executable), { query: fakeQuery });
  const memory = TraceMemory(join(directory, "memory.sqlite"), task => prepared.run(task as CcAgentTask, 0),
    { noting: { triggerTokens: 1 } });
  const project = memory.store.createProject({ name: "protocol", declaredBy: "mark" });
  const session = memory.store.createSession({ host: "cc:protocol", projectId: project.id,
    startedAt: "now", firstReplyAt: "now", enrollmentChoice: true });
  const tail = append(memory, session.id, "protocol", "Pending source material for the protocol failure test.");
  const target = { sessionId: session.id, branch: "main", headTurnId: tail.turn.id,
    triggerEntryId: tail.entry.id, mode: "subagent" as const, model: "claude-sonnet-4-5" };

  const controller = new AbortController();
  const cancellation = memory.noting({ ...target, signal: controller.signal });
  await started; controller.abort(new DOMException("external stop", "AbortError"));
  expect(await cancellation).toMatchObject({ outcome: "cancelled" });
  expect(memory.store.taskFailures(session.id)).toEqual([]);

  mode = "protocol";
  const direct = await prepared.run({ kind: "noting", text: "material", prompt: "instructions",
    tools: [{ name: "note", description: "commit", parameters: { type: "object" }, execute: () => "done" }],
    acknowledgeRequest: vi.fn() } as unknown as CcAgentTask, 0);
  expect(direct).toMatchObject({ outcome: "failure", output: expect.stringContaining("missing claudecode/toolUseId") });
  for (let attempt = 1; attempt <= 3; attempt++) {
    const result = await memory.noting(target);
    expect(result.outcome).toBe("failure");
    expect(memory.store.taskFailures(session.id)).toMatchObject([{ phase: "noting", count: attempt }]);
    expect(Boolean(result.automaticOff)).toBe(attempt === 3);
  }
  expect(memory.store.enabled(session.id)).toBe(false);
  memory.close();
});

test("production worker propagates mid-run cancellation and finalizes its transport iterator", async () => {
  const directory = mkdtempSync(join(tmpdir(), "tm-cc-worker-cancel-")); dirs.push(directory);
  const executable = join(directory, "claude");
  writeFileSync(executable, "#!/bin/sh\necho '2.1.257 (Claude Code)'\n"); chmodSync(executable, 0o700);
  let releaseStarted!: () => void, finalized = false, nativeSignal: AbortSignal | undefined;
  const started = new Promise<void>(resolve => { releaseStarted = resolve; });
  const fakeQuery = ((request: { options: Record<string, any> }) => {
    nativeSignal = request.options.abortController.signal;
    const stream = (async function* () {
      try {
        yield { type: "system", subtype: "init", claude_code_version: "2.1.257", cwd: directory,
          tools: [], plugins: [], skills: [], slash_commands: [], mcp_servers: [{ name: "trace_memory", status: "connected" }] };
        releaseStarted();
        await new Promise<void>((_resolve, reject) => nativeSignal!.addEventListener("abort", () => reject(nativeSignal!.reason), { once: true }));
      } finally { finalized = true; }
    })() as any;
    stream.supportedModels = async () => [{ value: "claude-sonnet-4-5", supportedEffortLevels: ["medium"] }];
    return stream;
  }) as any;
  const controller = new AbortController();
  const task = { kind: "noting", text: "material", prompt: "instructions", tools: [], acknowledgeRequest: vi.fn(), signal: controller.signal } as unknown as CcAgentTask;
  const running = new CcAgentWorker(workerConfig(directory, executable), { query: fakeQuery }).run(task, 0);
  await started; controller.abort(new DOMException("stop", "AbortError"));
  await expect(running).resolves.toMatchObject({ outcome: "cancelled" });
  expect(nativeSignal?.aborted).toBe(true);
  expect(finalized).toBe(true);
});

test("CC worker config requires explicit finite capacity and resolves no guessed default", () => {
  const directory = mkdtempSync(join(tmpdir(), "tm-cc-worker-config-")); dirs.push(directory);
  const config = workerConfig(directory);
  expect(config.worker?.phases.noting.capacity.inputTokens).toBe(190_000);
  expect(config.worker?.responseOriginTimeoutMs).toBe(20);
  expect(config.worker?.phases.consolidation.capacity.inputTokens).toBe(190_000);
  expect(() => resolveCcHostConfig({ dbPath: join(directory, "a"), stateDir: join(directory, "b"), notingModel: "m", notingThinking: "medium", consolidationModel: "m", consolidationThinking: "medium",
    "dreaming.model": "m", "dreaming.thinking": "medium", worker: {
    claudeExecutable: "/opt/homebrew/bin/claude", claudeVersion: "2.1.257",
    contextWindows: { m: CC_CONTEXT_HEADROOM }, cwd: directory } })).toThrow("must exceed");
});

test("response correlation acknowledges one underlying response before releasing all matching handlers", async () => {
  const { task, acknowledgeRequest } = originTask();
  const failures: Error[] = [], origins = new CcResponseOrigins(task, 100, 0, error => failures.push(error));
  const first = origins.origin({ _meta: { "claudecode/toolUseId": "call-a" } });
  const second = origins.origin({ _meta: { "claudecode/toolUseId": "call-b" } });
  origins.observe(assistant("response-1", ["call-a"]));
  await expect(first).resolves.toBe("response-1");
  origins.observe(assistant("response-1", ["call-b"]));
  await expect(second).resolves.toBe("response-1");
  expect(acknowledgeRequest).toHaveBeenCalledTimes(1);
  expect(origins.rounds()).toBe(1);
  expect(failures).toEqual([]);
  origins.close();
});

test("response correlation enforces timeout, round limit, ambiguity and cancellation", async () => {
  const timeout = originTask(), timed = new CcResponseOrigins(timeout.task, 5, 0, () => {});
  await expect(timed.origin({ _meta: { "claudecode/toolUseId": "never" } })).rejects.toThrow("timed out");

  const limited = originTask(), rounds = new CcResponseOrigins(limited.task, 100, 1, () => {});
  rounds.observe(assistant("round-1", ["one"]));
  expect(() => rounds.observe(assistant("round-2", ["two"]))).toThrow("exceeded 1 tool rounds");

  const ambiguousTask = originTask(), ambiguous = new CcResponseOrigins(ambiguousTask.task, 100, 0, () => {});
  ambiguous.observe(assistant("origin-1", ["shared"]));
  expect(() => ambiguous.observe(assistant("origin-2", ["shared"]))).toThrow("ambiguous");
});

test("response correlation rejects missing, duplicate and cancelled origins", async () => {
  const first = originTask(), failures: Error[] = [];
  const origins = new CcResponseOrigins(first.task, 100, 0, error => failures.push(error));
  await expect(origins.origin({})).rejects.toThrow("missing claudecode/toolUseId");
  expect(failures).toHaveLength(1);

  const second = originTask(), duplicate = new CcResponseOrigins(second.task, 100, 0, () => {});
  duplicate.observe(assistant("one", ["same"]));
  await expect(duplicate.origin({ _meta: { "claudecode/toolUseId": "same" } })).resolves.toBe("one");
  await expect(duplicate.origin({ _meta: { "claudecode/toolUseId": "same" } })).rejects.toThrow("handled more than once");

  const controller = new AbortController(), third = originTask(controller.signal);
  const cancelled = new CcResponseOrigins(third.task, 1_000, 0, () => {});
  const waiting = cancelled.origin({ _meta: { "claudecode/toolUseId": "later" } });
  controller.abort();
  await expect(waiting).rejects.toThrow("cancelled");
});

function append(memory: ReturnType<typeof TraceMemory>, sessionId: number, nativeId: string, text: string) {
  const turns = memory.store.listTurns(sessionId), turn = memory.store.appendTurn({ sessionId,
    parentTurnId: turns.at(-1)?.id ?? null, kind: "turn", userPrompt: text, startedAt: new Date(1_700_000_000_000 + turns.length).toISOString() });
  const entry = memory.appendEntry({ sessionId, turnId: turn.id, nativeLineage: "worker-test", nativeId,
    role: "user", text, raw: text, calls: [] });
  const ids = memory.store.listSourceEntries(sessionId).map(value => value.id);
  memory.selectEntries(sessionId, "main", ids);
  return { turn, entry, ids };
}

const tick = () => new Promise(resolve => setTimeout(resolve, 0));

test("scheduler reserves independent N/C slots and worker completion does not drain another batch", async () => {
  const directory = mkdtempSync(join(tmpdir(), "tm-cc-scheduler-")); dirs.push(directory);
  const starts: string[] = [], admissions: Record<string, unknown>[] = [], releases = new Map<string, () => void>();
  const runner = async (raw: unknown): Promise<RunAgentResult> => {
    const task = raw as { kind: string } & Record<string, unknown>;
    starts.push(task.kind); admissions.push(task);
    await new Promise<void>(resolve => releases.set(task.kind, resolve));
    return { outcome: "failure", output: "synthetic failure", audit: { available: false, reason: "test" } };
  };
  const memory = TraceMemory(join(directory, "memory.sqlite"), runner,
    { noting: { triggerTokens: 1 }, consolidation: { triggerTokens: 1 } });
  const project = memory.store.createProject({ name: "scheduler", declaredBy: "mark" });
  const session = memory.store.createSession({ host: "cc:scheduler", projectId: project.id,
    startedAt: "2026-01-01T00:00:00Z", firstReplyAt: "2026-01-01T00:00:01Z", enrollmentChoice: true });
  const seed = append(memory, session.id, "seed", "A pending raw source.");
  const manual = memory.tools({ kind: "manual", sessionId: session.id, branch: "main", currentTurnId: seed.turn.id });
  manual.find(value => value.name === "note")!.execute({ facts: [{ category: "observation", actor: "user",
    text: "A separate pending fact.", source: [`T${seed.turn.id}#user`] }] });
  const diagnostics: string[] = [], notingAdmission = vi.spyOn(memory, "noting"), consolidationAdmission = vi.spyOn(memory, "consolidate");
  const config = phaseWorkerConfig(directory), scheduler = new CcTaskScheduler(memory, config.worker, message => diagnostics.push(message));
  const reconcile = { state: "ready" as const, coreSessionId: session.id, branch: "main", headTurnId: seed.turn.id,
    selectedEntryIds: seed.ids, appendedEntryIds: [seed.entry.id], problems: [], snapshot: {} as any };
  scheduler.reconcile(reconcile);
  scheduler.reconcile(reconcile);
  await tick();
  expect(new Set(starts)).toEqual(new Set(["noting", "consolidation"]));
  expect(starts).toHaveLength(2);
  expect(new Set(scheduler.running())).toEqual(new Set(["noting", "consolidation"]));
  expect(notingAdmission.mock.calls[0]?.[0]).toMatchObject({ capacity: { inputTokens: 110_000, prefixTokens: 0 } });
  expect(consolidationAdmission.mock.calls[0]?.[0]).toMatchObject({ capacity: { inputTokens: 210_000, prefixTokens: 0 } });
  expect(admissions.map(task => ({ kind: task.kind, model: task.model, thinking: task.subagentThinkingLevel })))
    .toEqual(expect.arrayContaining([
      { kind: "noting", model: "sonnet", thinking: "low" },
      { kind: "consolidation", model: "opus-c", thinking: "high" },
    ]));
  releases.get("noting")!(); releases.get("consolidation")!();
  await scheduler.settle();
  await tick();
  expect(starts).toHaveLength(2);
  expect(diagnostics).toEqual(expect.arrayContaining([
    expect.stringContaining("noting worker failure"), expect.stringContaining("consolidation worker failure")]));
  expect(memory.pendingEntries(session.id, "main", seed.turn.id)).toHaveLength(1);
  memory.close();
});

test("manual catchup reports missing worker, disabled enrollment, and unavailable persisted path", () => {
  const directory = mkdtempSync(join(tmpdir(), "tm-cc-catchup-preflight-")); dirs.push(directory);
  const memory = { store: { enabled: () => true }, pendingEntries: () => [] } as any;
  const ready = { state: "ready" as const, coreSessionId: 1, branch: "main", headTurnId: 1,
    selectedEntryIds: [1], appendedEntryIds: [], problems: [], snapshot: {} as any };
  const missing = new CcTaskScheduler(memory, undefined, () => {});
  expect(missing.startCatchup(ready)).toMatchObject({ state: "failed", diagnostic: expect.stringContaining("not configured") });
  const config = workerConfig(directory), configured = new CcTaskScheduler(memory, config.worker, () => {});
  expect(configured.startCatchup({ ...ready, state: "disabled" })).toMatchObject({ state: "failed", diagnostic: expect.stringContaining("disabled") });
  expect(configured.startCatchup({ ...ready, state: "unavailable", coreSessionId: null, headTurnId: null,
    selectedEntryIds: [], problems: ["native transcript is unavailable"] })).toMatchObject({ state: "failed",
      diagnostic: "native transcript is unavailable" });
});

test("manual catchup drains bounded Noting but leaves below-threshold facts and later input pending", async () => {
  const directory = mkdtempSync(join(tmpdir(), "tm-cc-catchup-")); dirs.push(directory);
  const phases: string[] = [], admissions: { kind: string; model: string; thinking?: string }[] = [];
  const memory = TraceMemory(join(directory, "memory.sqlite"), async raw => {
    const input = raw as NotingAgentInput | ConsolidationAgentInput; phases.push(input.kind);
    admissions.push({ kind: input.kind, model: input.model, thinking: input.subagentThinkingLevel });
    if (input.kind === "noting") {
      const facts = input.material.entries.map((entry, index) => ({ category: "observation" as const, actor: "user" as const,
        text: `Observed catchup item ${entry.id}.`, source: [entry.view.match(/\[T\d+#E\d+/)![0].slice(1)] }));
      const note = input.tools.find(tool => tool.name === "note")!, batch = { facts };
      const feedback = input.reviewFeedback(note.execute(batch));
      if (feedback) { input.reportRequest({ exact: true }); note.execute(batch); }
    } else {
      const batch = { operations: [], skipped: input.range.facts.map(fact => ({ fact: `F${fact.id}`, because: "Synthetic test fact." })) };
      const write = input.tools.find(tool => tool.name === "memory")!;
      write.execute(batch);
    }
    return { outcome: "success", output: "done", audit: { available: false, reason: "test" } };
  }, { noting: { triggerTokens: 1_000_000, batchTokens: 20 }, consolidation: { triggerTokens: 1_000_000, batchTokens: 10_000 } });
  const project = memory.store.createProject({ name: "catchup", declaredBy: "mark" });
  const session = memory.store.createSession({ host: "cc:catchup", projectId: project.id, startedAt: "2026-01-01T00:00:00Z",
    firstReplyAt: "2026-01-01T00:00:01Z", enrollmentChoice: true });
  const first = append(memory, session.id, "c1", "first catchup source with enough text for one bounded batch");
  const second = append(memory, session.id, "c2", "second catchup source with enough text for another bounded batch");
  const notingAdmission = vi.spyOn(memory, "noting"), consolidationAdmission = vi.spyOn(memory, "consolidate");
  const config = phaseWorkerConfig(directory), scheduler = new CcTaskScheduler(memory, config.worker, () => {});
  const projection = { state: "ready" as const, coreSessionId: session.id, branch: "main", headTurnId: second.turn.id,
    selectedEntryIds: second.ids, appendedEntryIds: [], problems: [], snapshot: {} as any };
  expect(scheduler.startCatchup(projection).state).toBe("running");
  const late = append(memory, session.id, "late", "late input must remain outside the frozen catchup boundary");
  for (let i = 0; i < 100 && scheduler.catchupStatus().state !== "completed"; i++) await tick();
  expect(scheduler.catchupStatus()).toMatchObject({ state: "completed", entriesDone: 2, entriesTotal: 2, factsDone: 0, factsTotal: 2 });
  expect(phases.filter(phase => phase === "noting")).toHaveLength(2);
  expect(phases.filter(phase => phase === "consolidation")).toHaveLength(0);
  expect(admissions).toEqual(expect.arrayContaining([
    { kind: "noting", model: "sonnet", thinking: "low" },
  ]));
  expect(notingAdmission.mock.calls.every(call => call[0].capacity?.inputTokens === 110_000)).toBe(true);
  expect(consolidationAdmission).not.toHaveBeenCalled();
  expect(phases).not.toContain("dreaming");
  expect(memory.pendingEntries(session.id, "main", late.turn.id).map(entry => entry.id)).toEqual([late.entry.id]);
  expect(scheduler.startCatchup({ ...projection, headTurnId: late.turn.id, selectedEntryIds: late.ids }))
    .toMatchObject({ state: "running", entriesTotal: 1 });
  scheduler.stopCatchup(); memory.cancelTasks();
  expect(scheduler.catchupStatus().state).toBe("stopped");
  memory.close();
});

test("manual catchup reports waiting on a foreign claim and resumes only on a later opportunity", async () => {
  const calls: string[] = []; let foreign = true, pending = true;
  const memory = { executorId: "ours", config: { closedSessionScope: "project" },
    pendingEntries: () => pending ? [{ id: 1 }] : [],
    store: { enabled: () => true, consolidationBatch: () => [], closedTasks: () => [],
      getClaim: () => foreign ? ({ executorId: "foreign", expiresAt: Date.now() + 60_000 }) : null },
    noting: async () => { calls.push("noting"); pending = false; return { outcome: "success", facts: [] }; },
    consolidate: async () => ({ outcome: "success" }), dream: async () => ({ outcome: "success" }),
    taskEligibility: () => ({ due: false }) } as any;
  const directory = mkdtempSync(join(tmpdir(), "tm-cc-catchup-wait-")); dirs.push(directory);
  const config = workerConfig(directory), scheduler = new CcTaskScheduler(memory, config.worker, () => {});
  const projection = { state: "ready" as const, coreSessionId: 1, branch: "main", headTurnId: 1,
    selectedEntryIds: [1], appendedEntryIds: [], problems: [], snapshot: {} as any };
  expect(scheduler.startCatchup(projection)).toMatchObject({ state: "waiting", phase: "noting" });
  for (let i = 0; i < 10; i++) scheduler.reconcile(projection);
  expect(calls).toEqual([]);
  foreign = false; scheduler.reconcile(projection, false); await tick();
  expect(calls).toEqual(["noting"]);
  expect(scheduler.catchupStatus().state).toBe("completed");
  pending = true; scheduler.startCatchup(projection);
  const ticket = scheduler.catchupTicket();
  scheduler.stopCatchup();
  expect(scheduler.startCatchup(projection, ticket)).toMatchObject({ state: "failed", diagnostic: "catchup was cancelled before admission" });
  expect(calls).toEqual(["noting"]);
});

test("stop preserves a partial Noting commit without forcing its below-threshold C tail on restart", async () => {
  const directory = mkdtempSync(join(tmpdir(), "tm-cc-catchup-resume-")); dirs.push(directory);
  let noted!: () => void; const committed = new Promise<void>(resolve => { noted = resolve; });
  const memory = TraceMemory(join(directory, "memory.sqlite"), async raw => {
    const input = raw as NotingAgentInput | ConsolidationAgentInput;
    if (input.kind === "noting") {
      const source = input.material.entries[0]!.view.match(/\[T\d+#E\d+/)![0].slice(1);
      input.tools.find(tool => tool.name === "note")!.execute({ facts: [{ category: "observation", actor: "user",
        text: "A committed fact survives stop.", source: [source] }] });
      noted();
      await new Promise<void>(resolve => input.signal!.addEventListener("abort", () => resolve(), { once: true }));
      return { outcome: "cancelled", output: "stopped", audit: { available: false, reason: "test" } };
    }
    const write = input.tools.find(tool => tool.name === "memory")!;
    const batch = { operations: [], skipped: input.range.facts.map(fact => ({ fact: `F${fact.id}`, because: "Synthetic test fact." })) };
    write.execute(batch);
    return { outcome: "success", output: "done", audit: { available: false, reason: "test" } };
  }, { noting: { triggerTokens: 1_000_000 }, consolidation: { triggerTokens: 1_000_000 } });
  const project = memory.store.createProject({ name: "resume", declaredBy: "mark" });
  const session = memory.store.createSession({ host: "cc:resume", projectId: project.id, startedAt: "2026-01-01T00:00:00Z",
    firstReplyAt: "2026-01-01T00:00:01Z", enrollmentChoice: true });
  const source = append(memory, session.id, "resume", "source whose fact commits before cancellation");
  const config = workerConfig(directory), scheduler = new CcTaskScheduler(memory, config.worker, () => {});
  const projection = { state: "ready" as const, coreSessionId: session.id, branch: "main", headTurnId: source.turn.id,
    selectedEntryIds: source.ids, appendedEntryIds: [], problems: [], snapshot: {} as any };
  scheduler.startCatchup(projection); await committed;
  scheduler.stopCatchup(); memory.cancelTasks();
  for (let i = 0; i < 20 && scheduler.running().length; i++) await tick();
  expect(memory.pendingEntries(session.id, "main", source.turn.id)).toEqual([]);
  expect(memory.store.consolidationBatch(session.id, "main", source.turn.id)).toHaveLength(1);
  expect(scheduler.catchupStatus().state).toBe("stopped");
  scheduler.startCatchup(projection);
  for (let i = 0; i < 50 && scheduler.catchupStatus().state !== "completed"; i++) await tick();
  expect(scheduler.catchupStatus()).toMatchObject({ state: "completed", entriesTotal: 0, factsTotal: 1, factsDone: 0 });
  memory.close();
});

test("manual catchup fences pre-admission cancellation, concurrent status, dropped retries, and observed path changes", async () => {
  const calls: string[] = []; let dropped = true, pending = true, cancelled = 0;
  const memory = { executorId: "ours", config: { closedSessionScope: "project" },
    pendingEntries: () => pending ? [{ id: 1 }] : [],
    cancelTasks: () => { cancelled++; return []; },
    store: { enabled: () => true, consolidationBatch: () => [], closedTasks: () => [], getClaim: () => null },
    noting: async () => { calls.push("noting"); if (!dropped) pending = false; return { outcome: dropped ? "dropped" : "success", facts: [] }; },
    consolidate: async () => ({ outcome: "success" }), dream: async () => ({ outcome: "success" }),
    taskEligibility: () => ({ due: false }) } as any;
  const directory = mkdtempSync(join(tmpdir(), "tm-cc-catchup-races-")); dirs.push(directory);
  const config = workerConfig(directory), scheduler = new CcTaskScheduler(memory, config.worker, () => {});
  const projection = { state: "ready" as const, coreSessionId: 1, branch: "main", headTurnId: 1,
    selectedEntryIds: [1], appendedEntryIds: [], problems: [], snapshot: {} as any };

  const sharedTicket = scheduler.catchupTicket();
  expect(scheduler.startCatchup(projection, sharedTicket).state).toBe("running");
  expect(scheduler.startCatchup(projection, sharedTicket).state).toBe("running");
  scheduler.stopCatchup(); memory.cancelTasks(); await tick();
  expect(calls).toEqual([]);

  dropped = true;
  scheduler.startCatchup(projection); await tick(); await tick();
  expect(calls).toEqual(["noting"]);
  await tick(); expect(calls).toHaveLength(1);
  dropped = false;
  scheduler.reconcile(projection, false); await tick();
  expect(calls).toHaveLength(2);

  pending = true;
  scheduler.startCatchup(projection);
  scheduler.reconcile({ ...projection, branch: "other" }, false);
  expect(scheduler.catchupStatus()).toMatchObject({ state: "stopped", diagnostic: "selected branch changed" });
  expect(cancelled).toBe(2);
});

test("stop before the reservation microtask fences all ordinary phases and later triggers remain usable", async () => {
  const directory = mkdtempSync(join(tmpdir(), "tm-cc-ordinary-stop-race-")); dirs.push(directory);
  const calls: string[] = [];
  const result = (phase: string) => async () => { calls.push(phase); return { outcome: "success" }; };
  const memory = { executorId: "ours", config: { closedSessionScope: "project" },
    taskEligibility: () => ({ due: true }), cancelTasks: vi.fn(() => []),
    store: { enabled: () => true, closedTasks: () => [], getSourceEntry: (id: number) => ({ id, turnId: 1 }) },
    noting: result("noting"), consolidate: result("consolidation"), dream: result("dreaming") } as any;
  const config = workerConfig(directory), scheduler = new CcTaskScheduler(memory, config.worker, () => {});
  const projection = { state: "ready" as const, coreSessionId: 1, branch: "main", headTurnId: 1,
    selectedEntryIds: [1], appendedEntryIds: [1], problems: [], snapshot: {} as any };
  scheduler.reconcile(projection);
  scheduler.stopCatchup(); memory.cancelTasks(false);
  await tick(); await tick();
  expect(calls).toEqual([]);
  expect(scheduler.running()).toEqual([]);

  scheduler.reconcile(projection);
  await scheduler.settle(); await tick();
  expect(new Set(calls)).toEqual(new Set(["noting", "consolidation", "dreaming"]));
});

test("scheduler reserves a distinct Dreaming slot without completion-driven draining", async () => {
  const directory = mkdtempSync(join(tmpdir(), "tm-cc-scheduler-dreaming-")); dirs.push(directory);
  const starts: string[] = [], admissions: Record<string, unknown>[] = [], releases = new Map<string, () => void>();
  const phase = (name: string) => async (input: Record<string, unknown>) => {
    starts.push(name); admissions.push({ ...input, kind: name }); await new Promise<void>(resolve => releases.set(name, resolve));
    return { outcome: "failure", runId: 1, problems: ["synthetic"] };
  };
  const memory = { config: { closedSessionScope: "project" }, taskEligibility: () => ({ due: true }),
    store: { enabled: () => true, closedTasks: () => [], getSourceEntry: (id: number) => ({ id, turnId: 1 }) },
    noting: phase("noting"), consolidate: phase("consolidation"), dream: phase("dreaming") } as any;
  const config = phaseWorkerConfig(directory), scheduler = new CcTaskScheduler(memory, config.worker, () => {});
  const reconcile = { state: "ready" as const, coreSessionId: 1, branch: "main", headTurnId: 1,
    selectedEntryIds: [1], appendedEntryIds: [1], problems: [], snapshot: {} as any };
  scheduler.reconcile(reconcile); scheduler.reconcile(reconcile); await tick();
  expect(new Set(starts)).toEqual(new Set(["noting", "consolidation", "dreaming"]));
  expect(new Set(scheduler.running())).toEqual(new Set(["noting", "consolidation", "dreaming"]));
  expect(admissions.find(value => value.kind === "dreaming")).toMatchObject({ model: "opus-d",
    thinkingLevel: "max", subagentThinkingLevel: "max", capacity: { inputTokens: 310_000, prefixTokens: 0 } });
  for (const release of releases.values()) release();
  await scheduler.settle(); await tick();
  expect(starts).toHaveLength(3);
});

test("scheduler diagnoses resolved bounced and successful-but-problemed results", async () => {
  const diagnostics: string[] = [];
  const memory = { config: { closedSessionScope: "project" }, taskEligibility: () => ({ due: true }),
    store: { enabled: () => true, closedTasks: () => [], getSourceEntry: (id: number) => ({ id, turnId: 1 }) },
    noting: async () => ({ outcome: "bounced", runId: 7, problems: ["candidate rejected"] }),
    consolidate: async () => ({ outcome: "success", runId: 8, diagnostics: [], committed: [], problems: ["post-commit warning"] }) } as any;
  const directory = mkdtempSync(join(tmpdir(), "tm-cc-diagnostics-")); dirs.push(directory);
  const config = workerConfig(directory), scheduler = new CcTaskScheduler(memory, config.worker, message => diagnostics.push(message));
  scheduler.reconcile({ state: "ready", coreSessionId: 1, branch: "main", headTurnId: 1,
    selectedEntryIds: [1], appendedEntryIds: [1], problems: [], snapshot: {} as any });
  await scheduler.settle();
  expect(diagnostics).toEqual(expect.arrayContaining([
    "noting worker bounced for S1 R7: candidate rejected",
    "consolidation worker success for S1 R8: post-commit warning"]));
});

test("scheduler checks each newly imported foreground entry with its own persisted trigger", async () => {
  const directory = mkdtempSync(join(tmpdir(), "tm-cc-entry-opportunities-")); dirs.push(directory);
  const eligibility: { phase: string; triggerEntryId?: number; headTurnId: number }[] = [], started: { phase: string; triggerEntryId?: number }[] = [];
  const run = (phase: string) => async (target: TaskTarget) => { started.push({ phase, triggerEntryId: target.triggerEntryId }); return { outcome: "success" }; };
  const memory = { config: { closedSessionScope: "project" },
    taskEligibility: (phase: string, target: TaskTarget) => { eligibility.push({ phase, triggerEntryId: target.triggerEntryId, headTurnId: target.headTurnId });
      return { due: target.triggerEntryId === 2 }; },
    store: { enabled: () => true, closedTasks: () => [], getSourceEntry: (id: number) => ({ id, turnId: id === 1 ? 10 : 11 }) },
    noting: run("noting"), consolidate: run("consolidation"), dream: run("dreaming") } as any;
  const config = workerConfig(directory), scheduler = new CcTaskScheduler(memory, config.worker, () => {});
  scheduler.reconcile({ state: "ready", coreSessionId: 1, branch: "main", headTurnId: 11,
    selectedEntryIds: [1, 2], appendedEntryIds: [1, 2, 99], problems: [], snapshot: {} as any });
  await scheduler.settle();
  expect(eligibility.filter(value => value.phase === "noting").map(value => [value.triggerEntryId, value.headTurnId]))
    .toEqual([[1, 10], [2, 11]]);
  expect(new Set(started.map(value => `${value.phase}:${value.triggerEntryId}`)))
    .toEqual(new Set(["noting:2", "consolidation:2", "dreaming:2"]));
  // A normal unchanged importer projection carries no appended entries and grants no second chance.
  scheduler.reconcile({ state: "ready", coreSessionId: 1, branch: "main", headTurnId: 11,
    selectedEntryIds: [1, 2], appendedEntryIds: [], problems: [], snapshot: {} as any });
  await tick();
  expect(started).toHaveLength(3);
});

test("scheduler borrows closed Noting and Consolidation work but never a closed Dreamer target", async () => {
  const directory = mkdtempSync(join(tmpdir(), "tm-cc-no-dreamer-borrow-")); dirs.push(directory);
  const queried: string[] = [], started: string[] = [];
  const memory = { config: { closedSessionScope: "project" }, taskEligibility: () => ({ due: false }),
    store: { enabled: () => true, getSourceEntry: (id: number) => ({ id, turnId: 1 }),
      closedTasks: (phase: string) => { queried.push(phase); return [{ sessionId: 2, branch: "closed", headTurnId: 2, triggerEntryId: 20 }]; } },
    noting: async () => { started.push("noting"); return { outcome: "success" }; },
    consolidate: async () => { started.push("consolidation"); return { outcome: "success" }; },
    dream: async () => { started.push("dreaming"); return { outcome: "success" }; } } as any;
  const config = workerConfig(directory), scheduler = new CcTaskScheduler(memory, config.worker, () => {});
  scheduler.reconcile({ state: "ready", coreSessionId: 1, branch: "main", headTurnId: 1,
    selectedEntryIds: [1], appendedEntryIds: [1], problems: [], snapshot: {} as any });
  await scheduler.settle();
  expect(queried).toEqual(["noting", "consolidation"]);
  expect(new Set(started)).toEqual(new Set(["noting", "consolidation"]));
});

test("scheduler borrows an eligible closed target only at an executor entry-completion opportunity", async () => {
  const directory = mkdtempSync(join(tmpdir(), "tm-cc-borrow-")); dirs.push(directory);
  const targets: number[] = [], admissions: NotingAgentInput[] = [];
  const memory = TraceMemory(join(directory, "memory.sqlite"), async raw => {
    const task = raw as NotingAgentInput; targets.push(task.sessionId); admissions.push(task);
    task.tools.find(value => value.name === "note")!.execute({ facts: [] });
    return { outcome: "success", output: "done", audit: { available: false, reason: "test" } };
  }, { noting: { triggerTokens: 20 }, closedSessionScope: "project" });
  const project = memory.store.createProject({ name: "borrow", declaredBy: "mark" });
  const executor = memory.store.createSession({ host: "cc:executor", projectId: project.id, startedAt: "2026-01-01T00:00:00Z",
    firstReplyAt: "2026-01-01T00:00:01Z", enrollmentChoice: true });
  const own = append(memory, executor.id, "own", "short");
  const closed = memory.store.createSession({ host: "cc:closed", projectId: project.id, startedAt: "2026-01-01T00:00:00Z",
    firstReplyAt: "2026-01-01T00:00:01Z", enrollmentChoice: true });
  const tail = append(memory, closed.id, "closed", "A sufficiently long closed-session source that crosses the configured trigger threshold.");
  memory.store.closeSession(closed.id);
  const notingAdmission = vi.spyOn(memory, "noting");
  const config = phaseWorkerConfig(directory), scheduler = new CcTaskScheduler(memory, config.worker, () => {});
  scheduler.reconcile({ state: "ready", coreSessionId: executor.id, branch: "main", headTurnId: own.turn.id,
    selectedEntryIds: own.ids, appendedEntryIds: [], problems: [], snapshot: {} as any });
  await tick(); expect(targets).toEqual([]);
  scheduler.reconcile({ state: "ready", coreSessionId: executor.id, branch: "main", headTurnId: own.turn.id,
    selectedEntryIds: own.ids, appendedEntryIds: [own.entry.id], problems: [], snapshot: {} as any });
  await scheduler.settle(); await tick();
  expect(targets).toEqual([closed.id]);
  expect(notingAdmission.mock.calls[0]?.[0]).toMatchObject({ borrowed: true,
    capacity: { inputTokens: 110_000, prefixTokens: 0 } });
  expect(admissions[0]).toMatchObject({ model: "sonnet", thinkingLevel: "low", subagentThinkingLevel: "low" });
  expect(memory.pendingEntries(closed.id, "main", tail.turn.id)).toEqual([]);
  memory.close();
});
