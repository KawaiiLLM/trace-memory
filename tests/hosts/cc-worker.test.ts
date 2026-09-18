import { afterEach, expect, test, vi } from "vitest";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { TraceMemory, toolDefinitions, type NotingAgentInput, type RunAgentResult, type ToolDefinition } from "../../src/core/api/index.ts";
import { resolveCcHostConfig, CC_CONTEXT_HEADROOM } from "../../src/hosts/cc/config.ts";
import { CcAgentWorker, CcResponseOrigins, type CcAgentTask } from "../../src/hosts/cc/worker.ts";
import { CC_MAX_RESULT_CHARS } from "../../src/hosts/cc/tools.ts";
import { CcTaskScheduler } from "../../src/hosts/cc/scheduler.ts";

const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });

function workerConfig(directory: string, claudeExecutable = "/opt/homebrew/bin/claude") {
  return resolveCcHostConfig({ dbPath: join(directory, "memory.sqlite"), stateDir: join(directory, "state"),
    worker: { claudeExecutable, claudeVersion: "2.1.257", model: "claude-sonnet-4-5",
      effort: "medium", contextWindow: 200_000, cwd: directory, responseOriginTimeoutMs: 20 } });
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
  expect(config.worker?.contextWindow).toBe(200_000);
  expect(config.worker?.responseOriginTimeoutMs).toBe(20);
  expect(config.worker!.contextWindow - CC_CONTEXT_HEADROOM).toBe(190_000);
  expect(() => resolveCcHostConfig({ dbPath: join(directory, "a"), stateDir: join(directory, "b"), worker: {
    claudeExecutable: "/opt/homebrew/bin/claude", claudeVersion: "2.1.257", model: "m", effort: "medium",
    contextWindow: CC_CONTEXT_HEADROOM, cwd: directory } })).toThrow("must exceed");
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
  const starts: string[] = [], releases = new Map<string, () => void>();
  const runner = async (raw: unknown): Promise<RunAgentResult> => {
    const task = raw as { kind: string };
    starts.push(task.kind);
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
  const diagnostics: string[] = [];
  const config = workerConfig(directory), scheduler = new CcTaskScheduler(memory, config.worker,
    { inputTokens: 190_000, prefixTokens: 0 }, message => diagnostics.push(message));
  const reconcile = { state: "ready" as const, coreSessionId: session.id, branch: "main", headTurnId: seed.turn.id,
    selectedEntryIds: seed.ids, appendedEntryIds: [seed.entry.id], problems: [], snapshot: {} as any };
  scheduler.trigger(reconcile);
  scheduler.trigger(reconcile);
  await tick();
  expect(new Set(starts)).toEqual(new Set(["noting", "consolidation"]));
  expect(starts).toHaveLength(2);
  expect(new Set(scheduler.running())).toEqual(new Set(["noting", "consolidation"]));
  releases.get("noting")!(); releases.get("consolidation")!();
  await scheduler.settle();
  await tick();
  expect(starts).toHaveLength(2);
  expect(diagnostics).toEqual(expect.arrayContaining([
    expect.stringContaining("noting worker failure"), expect.stringContaining("consolidation worker failure")]));
  expect(memory.pendingEntries(session.id, "main", seed.turn.id)).toHaveLength(1);
  memory.close();
});

test("scheduler reserves a distinct Dreaming slot without completion-driven draining", async () => {
  const directory = mkdtempSync(join(tmpdir(), "tm-cc-scheduler-dreaming-")); dirs.push(directory);
  const starts: string[] = [], releases = new Map<string, () => void>();
  const phase = (name: string) => async () => {
    starts.push(name); await new Promise<void>(resolve => releases.set(name, resolve));
    return { outcome: "failure", runId: 1, problems: ["synthetic"] };
  };
  const memory = { config: { closedSessionScope: "project" }, taskEligibility: () => ({ due: true }),
    store: { enabled: () => true, closedTasks: () => [] }, noting: phase("noting"), consolidate: phase("consolidation"), dream: phase("dreaming") } as any;
  const config = workerConfig(directory), scheduler = new CcTaskScheduler(memory, config.worker,
    { inputTokens: 190_000, prefixTokens: 0 }, () => {});
  const reconcile = { state: "ready" as const, coreSessionId: 1, branch: "main", headTurnId: 1,
    selectedEntryIds: [1], appendedEntryIds: [1], problems: [], snapshot: {} as any };
  scheduler.trigger(reconcile); scheduler.trigger(reconcile); await tick();
  expect(new Set(starts)).toEqual(new Set(["noting", "consolidation", "dreaming"]));
  expect(new Set(scheduler.running())).toEqual(new Set(["noting", "consolidation", "dreaming"]));
  for (const release of releases.values()) release();
  await scheduler.settle(); await tick();
  expect(starts).toHaveLength(3);
});

test("scheduler diagnoses resolved bounced and successful-but-problemed results", async () => {
  const diagnostics: string[] = [];
  const memory = { config: { closedSessionScope: "project" }, taskEligibility: () => ({ due: true }), store: { enabled: () => true, closedTasks: () => [] },
    noting: async () => ({ outcome: "bounced", runId: 7, problems: ["candidate rejected"] }),
    consolidate: async () => ({ outcome: "success", runId: 8, diagnostics: [], committed: [], problems: ["post-commit warning"] }) } as any;
  const directory = mkdtempSync(join(tmpdir(), "tm-cc-diagnostics-")); dirs.push(directory);
  const config = workerConfig(directory), scheduler = new CcTaskScheduler(memory, config.worker,
    { inputTokens: 190_000, prefixTokens: 0 }, message => diagnostics.push(message));
  scheduler.trigger({ state: "ready", coreSessionId: 1, branch: "main", headTurnId: 1,
    selectedEntryIds: [1], appendedEntryIds: [1], problems: [], snapshot: {} as any });
  await scheduler.settle();
  expect(diagnostics).toEqual(expect.arrayContaining([
    "noting worker bounced for S1 R7: candidate rejected",
    "consolidation worker success for S1 R8: post-commit warning"]));
});

test("scheduler borrows an eligible closed target only at an executor entry-completion opportunity", async () => {
  const directory = mkdtempSync(join(tmpdir(), "tm-cc-borrow-")); dirs.push(directory);
  const targets: number[] = [];
  const memory = TraceMemory(join(directory, "memory.sqlite"), async raw => {
    const task = raw as NotingAgentInput; targets.push(task.sessionId);
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
  const config = workerConfig(directory), scheduler = new CcTaskScheduler(memory, config.worker,
    { inputTokens: 190_000, prefixTokens: 0 }, () => {});
  scheduler.trigger({ state: "ready", coreSessionId: executor.id, branch: "main", headTurnId: own.turn.id,
    selectedEntryIds: own.ids, appendedEntryIds: [], problems: [], snapshot: {} as any });
  await tick(); expect(targets).toEqual([]);
  scheduler.trigger({ state: "ready", coreSessionId: executor.id, branch: "main", headTurnId: own.turn.id,
    selectedEntryIds: own.ids, appendedEntryIds: [own.entry.id], problems: [], snapshot: {} as any });
  await scheduler.settle(); await tick();
  expect(targets).toEqual([closed.id]);
  expect(memory.pendingEntries(closed.id, "main", tail.turn.id)).toEqual([]);
  memory.close();
});
