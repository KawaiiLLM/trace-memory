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
  const timeout = deferred<void>();
  const host = { plugin: { root: "/isolated/plugin" }, session: { id: async () => session },
    fs: { read: vi.fn(async () => JSON.stringify({ writeResponseTimeoutMs: 100 })) },
    clock: { sleep: vi.fn((_ms: number, _options: { signal: AbortSignal }) => timeout.promise) },
    process: { run }, command: { register: async () => undefined }, ui: { status, log } };
  await handlers.get("session.start")!(host, {}, async () => undefined);
  const startupCalls = run.mock.calls.map(([argv]) => argv);
  run.mockClear();
  const result = { turnId: "turn-one", index: 0, answer: "firstsecond", toolUses: [], stopReason: "end_turn",
    usage: { input_tokens: 10, output_tokens: 20, cache_read_input_tokens: 0, cache_creation_input_tokens: 0, model: "claude-sonnet-4-6" } };
  const chunks = [{ kind: "text", index: 0, text: "first" }, { kind: "text", index: 0, text: "second" },
    { kind: "stop", stopReason: result.stopReason, usage: result.usage }];
  const next = vi.fn(async function* () { yield* chunks; return result; });
  return { handlers, host, run, next, status, log, startupCalls, chunks, result,
    timeout, setSession: (id: string) => { session = id; } };
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
    f.run.mockResolvedValueOnce({ exitCode: 1, stdout: "", stderr: "binding mismatch" });
    const next = vi.fn(async () => "native completion");
    expect(await f.handlers.get("turn.complete")!(f.host, { turnId: "t1", reason: "aborted" }, next)).toBe("native completion");
    expect(f.log).toHaveBeenCalledWith(expect.stringContaining("this turn memory check failed: Error: Trace Memory turn-end check: binding mismatch"));
    expect(failure).toHaveBeenCalledWith(expect.stringContaining("binding mismatch"));
    expect(f.run).toHaveBeenCalledTimes(1);
    expect(f.run.mock.calls[0]![0]).toContain("hook-turn");
    expect(JSON.parse(f.run.mock.calls[0]![1]!.stdin)).toEqual({ session_id: "first", turnId: "t1", reason: "aborted" });
    expect(next).toHaveBeenCalledOnce();
  } finally { failure.mockRestore(); }
});

test("note and memory are denied to subagents and pass for the main session", async () => {
  const f = await fixture();
  const next = vi.fn(async () => "native dispatch");
  const call = f.handlers.get("tool.call")!;
  for (const suffix of ["note", "memory"]) {
    const tool = `mcp__plugin_trace-memory_traceMemory__${suffix}`;
    expect(await call(f.host, { tool, agentId: "agent", tool_use_id: "any" }, next))
      .toEqual({ deny: "Trace Memory: note and memory are not available to subagents" });
    expect(await call(f.host, { tool, tool_use_id: "manual" }, next)).toBe("native dispatch");
  }
  expect(f.run).not.toHaveBeenCalled();
  expect(f.handlers.has("tool.check")).toBe(false);
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

interface HookFixture {
  host: unknown;
  handlers: Map<string, Function>;
  result: { stopReason: string; usage: unknown };
}

async function pendingResponse(f: HookFixture, ids: string[], turnId = "turn-one") {
  const tail = deferred<void>(), controller = new AbortController();
  const result = { ...f.result, turnId, answer: "", stopReason: "tool_use",
    toolUses: ids.map(() => ({ name: "mcp__traceMemory__note", input: {} })) };
  const next = Object.assign(async function* () {
    for (const id of ids) yield { kind: "tool", id, name: "mcp__traceMemory__note" };
    await tail.promise;
    yield { kind: "stop", stopReason: result.stopReason, usage: result.usage };
    return result;
  }, { signal: controller.signal });
  const stream = f.handlers.get("turn.step")!(f.host, { ...step, turnId }, next) as AsyncGenerator;
  for (const id of ids) expect((await stream.next()).value.id).toBe(id);
  return { stream, tail, controller };
}

function writeCall(f: HookFixture, id: string, signal = new AbortController().signal,
  tool = "mcp__traceMemory__note") {
  const event = { tool, tool_use_id: id, title: id };
  const next = Object.assign(vi.fn(async (e: unknown) => ({ native: e })), { signal });
  const result = f.handlers.get("tool.call")!(f.host, event, next);
  return { event, next, result };
}

test("parallel foreground writes wait for their own response and preserve native permission dispatch", async () => {
  const f = await fixture();
  const response = await pendingResponse(f, ["note", "memory"]);
  const first = writeCall(f, "note"), second = writeCall(f, "memory", undefined, "mcp__plugin_trace-memory_traceMemory__memory");
  await vi.waitFor(() => expect(f.host.clock.sleep).toHaveBeenCalledTimes(2));
  expect(first.next).not.toHaveBeenCalled();
  expect(second.next).not.toHaveBeenCalled();
  response.tail.resolve();
  await collect(response.stream);
  expect(await first.result).toEqual({ native: first.event });
  expect(await second.result).toEqual({ native: second.event });
  expect(first.next.mock.calls[0]![0]).toBe(first.event);
  // A call dispatched after response completion never starts a timeout.
  expect(await writeCall(f, "note").result).toEqual({ native: first.event });
  expect(f.host.clock.sleep.mock.calls.every(([, options]) => options.signal.aborted)).toBe(true);
});

test("overlapping sessions and steps cannot release each other's writes", async () => {
  const f = await fixture();
  const first = await pendingResponse(f, ["one"]);
  const one = writeCall(f, "one");
  const second = await pendingResponse(f, ["two"], "turn-two");
  const two = writeCall(f, "two");
  f.setSession("other");
  const other = await pendingResponse(f, ["one"], "turn-other");
  const otherCall = writeCall(f, "one");
  f.setSession("first");
  second.tail.resolve();
  await collect(second.stream);
  await two.result;
  expect(one.next).not.toHaveBeenCalled();
  expect(otherCall.next).not.toHaveBeenCalled();
  first.tail.resolve(); await collect(first.stream); await one.result;
  expect(otherCall.next).not.toHaveBeenCalled();
  f.setSession("other");
  other.tail.resolve(); await collect(other.stream); await otherCall.result;
  expect(one.next).toHaveBeenCalledOnce();
  expect(two.next).toHaveBeenCalledOnce();
  expect(otherCall.next).toHaveBeenCalledOnce();
});

test("ordinary tools and another server's writes keep eager native dispatch", async () => {
  const f = await fixture(), response = await pendingResponse(f, ["own-write"]);
  for (const tool of ["mcp__traceMemory__search", "mcp__other__note", "Bash"]) {
    const call = writeCall(f, "other-tool", undefined, tool);
    expect(await call.result).toEqual({ native: call.event });
  }
  expect(f.host.clock.sleep).not.toHaveBeenCalled();
  response.tail.resolve(); await collect(response.stream);
});

test("call cancellation releases only that waiter without dispatching a write", async () => {
  const f = await fixture(), response = await pendingResponse(f, ["cancel", "keep"]);
  const abort = new AbortController(), cancelled = writeCall(f, "cancel", abort.signal), kept = writeCall(f, "keep");
  abort.abort();
  expect(await cancelled.result).toHaveProperty("deny");
  expect(cancelled.next).not.toHaveBeenCalled();
  expect(kept.next).not.toHaveBeenCalled();
  response.tail.resolve(); await collect(response.stream); await kept.result;
  expect(kept.next).toHaveBeenCalledOnce();
});

test("a new native session cancels an old response wait without dispatch", async () => {
  const f = await fixture(), response = await pendingResponse(f, ["old-session"]);
  const call = writeCall(f, "old-session");
  await vi.waitFor(() => expect(f.host.clock.sleep).toHaveBeenCalledOnce());
  f.setSession("after-clear");
  await f.handlers.get("session.start")!(f.host, {}, async () => undefined);
  expect(await call.result).toHaveProperty("deny");
  expect(call.next).not.toHaveBeenCalled();
  response.tail.resolve(); await collect(response.stream);
});

test("turn interruption releases waiting writes even while the response stream is stalled", async () => {
  const f = await fixture(), response = await pendingResponse(f, ["cancel"]);
  const call = writeCall(f, "cancel");
  response.controller.abort();
  expect(await call.result).toHaveProperty("deny");
  expect(call.next).not.toHaveBeenCalled();
  response.tail.resolve(); await collect(response.stream);
});

test("failed and abandoned response streams release writes without executing them", async () => {
  for (const fails of [true, false]) {
    const f = await fixture(), tail = deferred<void>();
    const next = Object.assign(async function* () {
      yield { kind: "tool", id: "failed", name: "mcp__traceMemory__memory" };
      await tail.promise;
      throw new Error("provider failed");
    }, { signal: new AbortController().signal });
    const stream = f.handlers.get("turn.step")!(f.host, step, next) as AsyncGenerator;
    await stream.next();
    const call = writeCall(f, "failed");
    if (fails) { tail.resolve(); await expect(stream.next()).rejects.toThrow("provider failed"); }
    else await stream.return(undefined);
    expect(await call.result).toHaveProperty("deny");
    expect(call.next).not.toHaveBeenCalled();
  }
});

test.each([null, undefined])("a completed iterator with stopReason %s cancels a waiting write", async (stopReason) => {
  const f = await fixture(), tail = deferred<void>(), controller = new AbortController();
  const result = { ...f.result, stopReason };
  const next = Object.assign(async function* () {
    yield { kind: "tool", id: "failed", name: "mcp__traceMemory__note" };
    await tail.promise;
    return result;
  }, { signal: controller.signal });
  const stream = f.handlers.get("turn.step")!(f.host, step, next) as AsyncGenerator;
  await stream.next();
  const call = writeCall(f, "failed");
  await vi.waitFor(() => expect(f.host.clock.sleep).toHaveBeenCalledOnce());
  tail.resolve();
  expect(await collect(stream)).toEqual({ chunks: [], result });
  expect(controller.signal.aborted).toBe(false);
  expect(await call.result).toHaveProperty("deny");
  expect(call.next).not.toHaveBeenCalled();
});

test("a failed tail normalized to tool_use without a terminal stop cancels its writes", async () => {
  const f = await fixture(), tail = deferred<void>(), controller = new AbortController();
  // Native 2.1.293 finalizes partial responses with tool_use, even without a final provider frame.
  const result = { ...f.result, answer: "", stopReason: "tool_use",
    toolUses: [{ name: "mcp__traceMemory__memory", input: {} }], usage: { ...f.result.usage, output_tokens: 0 } };
  const next = Object.assign(async function* () {
    yield { kind: "tool", id: "failed-tail", name: "mcp__traceMemory__memory" };
    await tail.promise;
    return result;
  }, { signal: controller.signal });
  const stream = f.handlers.get("turn.step")!(f.host, step, next) as AsyncGenerator;
  await stream.next();
  const call = writeCall(f, "failed-tail", undefined, "mcp__traceMemory__memory");
  await vi.waitFor(() => expect(f.host.clock.sleep).toHaveBeenCalledOnce());
  tail.resolve();
  expect(await collect(stream)).toEqual({ chunks: [], result });
  expect(controller.signal.aborted).toBe(false);
  expect(await call.result).toHaveProperty("deny");
  expect(call.next).not.toHaveBeenCalled();
  // Late dispatch must not bypass the failed response either.
  const late = writeCall(f, "failed-tail", undefined, "mcp__traceMemory__memory");
  expect(await late.result).toHaveProperty("deny");
  expect(late.next).not.toHaveBeenCalled();
});

test("the response wait bound forwards the original call to native binding while a response is stalled", async () => {
  const f = await fixture(), response = await pendingResponse(f, ["bounded"]);
  const call = writeCall(f, "bounded");
  await vi.waitFor(() => expect(f.host.clock.sleep).toHaveBeenCalledWith(100, expect.anything()));
  f.timeout.resolve();
  expect(await call.result).toEqual({ native: call.event });
  expect(call.next.mock.calls[0]![0]).toBe(call.event);
  response.tail.resolve(); await collect(response.stream);
});
