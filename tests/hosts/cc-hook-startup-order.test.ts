import { beforeAll, expect, test, vi } from "vitest";
import { build } from "esbuild";
import { resolve } from "node:path";

let moduleUrl: string;
beforeAll(async () => {
  const bundle = await build({ entryPoints: [resolve("plugin/hooks/index.tsx")], bundle: true, write: false,
    format: "esm", platform: "neutral", jsx: "transform", jsxFactory: "jsx" });
  moduleUrl = `data:text/javascript;base64,${Buffer.from(bundle.outputFiles[0]!.contents).toString("base64")}`;
});

async function fixture() {
  // Each instance isolates the real module's state; no native process runs in this fixture.
  const { register } = await import(`${moduleUrl}#${Math.random()}`);
  const handlers = new Map<string, (host: any, event: any, next: any) => any>();
  register((name: string, ...args: any[]) => handlers.set(name, args.at(-1)));
  let session = "first";
  const run = vi.fn(async (_argv: string[], _options?: { stdin: string }) => ({ exitCode: 0, stdout: "", stderr: "" }));
  const status = vi.fn(), log = vi.fn();
  const host = { plugin: { root: "/isolated/plugin" }, session: { id: async () => session },
    process: { run }, command: { register: async () => undefined }, ui: { status, log } };
  await handlers.get("session.start")!(host, {}, async () => undefined);
  const startupCalls = run.mock.calls.map(([argv]) => argv);
  run.mockClear();
  const chunks = [{ type: "text_delta", text: "first" }, { type: "text_delta", text: "second" }];
  const result = { stop_reason: "end_turn" };
  const next = vi.fn(async function* () { yield* chunks; return result; });
  return { handlers, host, run, next, status, log, startupCalls, chunks, result,
    setSession: (id: string) => { session = id; } };
}

async function collect(stream: AsyncGenerator<unknown, unknown>) {
  const chunks: unknown[] = [];
  for (;;) {
    const item = await stream.next();
    if (item.done) return { chunks, result: item.value };
    chunks.push(item.value);
  }
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(done => { resolve = done; });
  return { promise, resolve };
}

const step = { turnId: "turn-one", options: {} };

test("streaming model request waits for registration and preserves chunks and final result", async () => {
  const f = await fixture();
  expect(f.startupCalls).not.toContainEqual(expect.arrayContaining(["hook-capable"]));
  const pending = deferred<{ exitCode: number; stdout: string; stderr: string }>();
  const order: string[] = [];
  f.run.mockImplementation(async (argv: string[]) => {
    if (argv.includes("hook-capable")) { order.push("registration started"); return pending.promise; }
    throw new Error("unexpected process");
  });
  f.next.mockImplementation(async function* () {
    order.push("model request");
    yield* f.chunks;
    return f.result;
  });
  const handler = f.handlers.get("turn.step")!;
  // Claude Code's native loader rejects a Promise-returning handler for this streaming event.
  expect(handler.constructor.name).toBe("AsyncGeneratorFunction");
  const handling = collect(handler(f.host, step, f.next));
  await vi.waitFor(() => expect(order).toEqual(["registration started"]));
  expect(f.next).not.toHaveBeenCalled();
  pending.resolve({ exitCode: 0, stdout: "", stderr: "" });
  const received = await handling;
  expect(received.chunks).toHaveLength(f.chunks.length);
  received.chunks.forEach((chunk, index) => expect(chunk).toBe(f.chunks[index]));
  expect(received.result).toBe(f.result);
  expect(order).toEqual(["registration started", "model request"]);
  expect(JSON.parse(f.run.mock.calls[0]![1]!.stdin)).toEqual({ session_id: "first" });
});

test("subagent stream passes through; clear and resume use the fresh live native identity", async () => {
  const f = await fixture();
  const handle = f.handlers.get("turn.step")!;
  const child = await collect(handle(f.host, { ...step, agentId: "child" }, f.next));
  expect(child.chunks).toEqual(f.chunks);
  expect(child.result).toBe(f.result);
  expect(f.run).not.toHaveBeenCalled();
  for (const id of ["first", "first", "after-clear", "after-resume", "after-resume"]) {
    f.setSession(id);
    await collect(handle(f.host, step, f.next));
  }
  await f.handlers.get("session.start")!(f.host, {}, async () => undefined);
  await collect(handle(f.host, step, f.next));
  // One registration per session: a later step in the same session spawns no process until session.start.
  expect(f.run.mock.calls.map(([, options]) => JSON.parse(options!.stdin).session_id))
    .toEqual(["first", "after-clear", "after-resume", "after-resume"]);
});

test("refused registration or changed session never enters the model request", async () => {
  const f = await fixture();
  const handle = f.handlers.get("turn.step")!;
  f.run.mockResolvedValueOnce({ exitCode: 1, stdout: "", stderr: "binding mismatch" });
  await expect(collect(handle(f.host, step, f.next))).rejects.toThrow("binding mismatch");
  expect(f.next).not.toHaveBeenCalled();
  f.run.mockImplementationOnce(async () => { f.setSession("different"); return { exitCode: 0, stdout: "", stderr: "" }; });
  await expect(collect(handle(f.host, step, f.next))).rejects.toThrow("native session changed");
  expect(f.next).not.toHaveBeenCalled();
});

test("downstream stream failure propagates unchanged after emitted chunks", async () => {
  const f = await fixture();
  const failure = new Error("model stream failed");
  f.next.mockImplementation(async function* () { yield f.chunks[0]!; throw failure; });
  const stream = f.handlers.get("turn.step")!(f.host, step, f.next) as AsyncGenerator;
  expect(await stream.next()).toEqual({ done: false, value: f.chunks[0] });
  await expect(stream.next()).rejects.toBe(failure);
});

test("failed main turn-end RPC is logged in the foreground without a second check", async () => {
  const f = await fixture();
  const failure = vi.spyOn(console, "error").mockImplementation(() => undefined);
  try {
    f.run.mockResolvedValueOnce({ exitCode: 1, stdout: "", stderr: "source observation unavailable" })
      .mockResolvedValueOnce({ exitCode: 1, stdout: "", stderr: "binding mismatch" });
    const next = vi.fn(async () => "native completion");
    expect(await f.handlers.get("turn.complete")!(f.host, { turnId: "t1", reason: "aborted" }, next)).toBe("native completion");
    expect(f.log).toHaveBeenCalledWith(expect.stringContaining("CC fork source read failed"));
    expect(f.log).toHaveBeenCalledWith(expect.stringContaining("this turn memory check failed: Error: Trace Memory turn-end check: binding mismatch"));
    expect(failure).toHaveBeenCalledWith(expect.stringContaining("binding mismatch"));
    expect(f.run).toHaveBeenCalledTimes(2);
    expect(f.run.mock.calls[0]![0]).toContain("hook-sources");
    expect(f.run.mock.calls[1]![0]).toContain("hook-turn");
    expect(JSON.parse(f.run.mock.calls[1]![1]!.stdin)).toEqual({ session_id: "first", turnId: "t1", reason: "aborted",
      observation: { failed: "CC fork source read failed: Error: source observation unavailable" } });
    expect(next).toHaveBeenCalledOnce();
  } finally { failure.mockRestore(); }
});

test("source read failure differs from absent Raw, unavailable usage and changed native session", async () => {
  for (const scenario of ["corrupt", "absent", "usage", "changed"] as const) {
    const f = await fixture();
    const seen: any[] = [];
    const source = { sessionId: 1, branch: "main", headTurnId: 1, tailId: 1,
      selected: [{ nativeId: "original", kind: "user", afterBoundary: true,
        record: { message: { content: "original text" } } }] };
    Object.assign(f.host.session, { messages: async () => [], usage: async () => ({ context: { breakdown:
      scenario === "usage" ? null : { model: "opus", maxTokens: 200000, totalTokens: 100 } } }) });
    f.run.mockImplementation(async (argv: string[], options?: { stdin: string }) => {
      if (argv.includes("hook-sources")) return scenario === "corrupt"
        ? { exitCode: 1, stdout: "", stderr: "indexed JSON is invalid" }
        : { exitCode: 0, stdout: JSON.stringify(source), stderr: "" };
      const request = JSON.parse(options!.stdin); seen.push(request.observation);
      return { exitCode: 0, stdout: "null", stderr: "" };
    });
    if (scenario === "changed") {
      const session = f.host.session as typeof f.host.session & { messages: () => Promise<unknown> };
      const original = session.messages;
      session.messages = async () => { f.setSession("after-clear"); return original(); };
    }
    await f.handlers.get("turn.complete")!(f.host, { turnId: "t", reason: "answer" }, async () => undefined);
    expect(seen).toHaveLength(1);
    if (scenario === "corrupt") expect(seen[0].failed).toContain("indexed JSON is invalid");
    else if (scenario === "absent") { expect(seen[0].raw).toEqual([]); expect(seen[0].failed).toBeUndefined(); }
    else expect(seen[0].refused).toContain(scenario === "usage" ? "usage is unavailable" : "native session changed");
  }
});

test("fork listener spawn failure fences the exact registered agent before an unconfirmed physical stop", async () => {
  const f = await fixture();
  const callbacks: (() => Promise<void>)[] = [], verbs: string[] = [];
  Object.assign(f.host, { clock: { after: (_ms: number, callback: () => Promise<void>) => callbacks.push(callback) },
    agent: { spawn: async () => ({ agentId: "native-agent" }), list: async () => [{ id: "native-agent", type: "fork", status: "running" }] },
    tool: { call: async () => ({ result: { task_id: "native-agent", message: "stop failed" } }) } });
  (f.host.process as any).spawn = () => { throw new Error("helper launch failed"); };
  f.run.mockImplementation(async (argv: string[], options?: { stdin: string }) => {
    if (argv.includes("hook-sources")) return { exitCode: 0, stdout: "null", stderr: "" };
    if (argv.includes("hook-turn")) return { exitCode: 0, stdout: JSON.stringify({ turnId: "t", prompt: "run" }), stderr: "" };
    const input = JSON.parse(options!.stdin); verbs.push(input.verb);
    return { exitCode: 0, stdout: JSON.stringify({ allowed: true }), stderr: "" };
  });
  const stderr = vi.spyOn(console, "error").mockImplementation(() => undefined);
  try {
    await f.handlers.get("turn.complete")!(f.host, { turnId: "t", reason: "answer" }, async () => undefined);
    expect(callbacks).toHaveLength(1);
    await callbacks[0]!();
    expect(verbs).toEqual(["fork-register", "fork-disconnect"]);
    expect(stderr).toHaveBeenCalledWith(expect.stringContaining("physical stop unknown"));
  } finally { stderr.mockRestore(); }
});

test("native plugin MCP name routes only registered fork note and memory calls", async () => {
  const f = await fixture();
  const next = vi.fn(async () => "native dispatch");
  f.run.mockImplementation(async (argv: string[], options?: { stdin: string }) => {
    expect(argv).toContain("hook-fork");
    const input = JSON.parse(options!.stdin);
    expect(input.session_id).toBe("first");
    return { exitCode: 0, stdout: JSON.stringify({ allowed: input.callId === "registered" }), stderr: "" };
  });
  const call = f.handlers.get("tool.call")!;
  const check = f.handlers.get("tool.check")!;
  for (const suffix of ["note", "memory"]) {
    const tool = `mcp__plugin_trace-memory_traceMemory__${suffix}`;
    expect(await call(f.host, { tool, agentId: "agent", tool_use_id: "registered" }, next)).toBe("native dispatch");
    expect(await check(f.host, { tool, tool_use_id: "registered" }, next)).toEqual({ decision: "allow" });
    expect(await call(f.host, { tool, agentId: "agent", tool_use_id: "unknown" }, next))
      .toEqual({ deny: "CC Noter fork identity is not registered for this call" });
    expect(await check(f.host, { tool, tool_use_id: "unknown" }, next)).toBe("native dispatch");
    expect(await call(f.host, { tool, tool_use_id: "manual" }, next)).toBe("native dispatch");
  }
  expect(f.run).toHaveBeenCalledTimes(8);
});

test("consumer cancellation closes the delegated model stream", async () => {
  const f = await fixture();
  const closed = vi.fn();
  f.next.mockImplementation(async function* () {
    try { yield* f.chunks; return f.result; }
    finally { closed(); }
  });
  const stream = f.handlers.get("turn.step")!(f.host, step, f.next) as AsyncGenerator;
  expect((await stream.next()).done).toBe(false);
  await stream.return(undefined);
  expect(closed).toHaveBeenCalledOnce();
});
