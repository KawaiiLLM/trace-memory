import { beforeAll, expect, test, vi } from "vitest";
import { build } from "esbuild";
import { resolve } from "node:path";

let moduleUrl: string;
beforeAll(async () => {
  const bundle = await build({ entryPoints: [resolve("plugin/hooks/index.tsx")], bundle: true, write: false,
    format: "esm", platform: "neutral", jsx: "transform", jsxFactory: "jsx" });
  moduleUrl = `data:text/javascript;base64,${Buffer.from(bundle.outputFiles[0]!.contents).toString("base64")}`;
});

async function fixture(version = "2.1.280") {
  // Each instance isolates the real module's version guard; no native process runs in this fixture.
  const { register } = await import(`${moduleUrl}#${Math.random()}`);
  const handlers = new Map<string, (host: any, event: any, next: any) => any>();
  register((name: string, ...args: any[]) => handlers.set(name, args.at(-1)));
  let session = "first";
  const run = vi.fn(async (argv: string[], _options?: { stdin: string }) =>
    argv.includes("--version") ? { exitCode: 0, stdout: `${version} (Claude Code)`, stderr: "" }
      : { exitCode: 0, stdout: "", stderr: "" });
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
  // The pinned native loader rejects a Promise-returning handler for this streaming event.
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
  for (const id of ["first", "after-clear", "after-resume"]) {
    f.setSession(id);
    await collect(handle(f.host, step, f.next));
  }
  expect(f.run.mock.calls.map(([, options]) => JSON.parse(options!.stdin).session_id))
    .toEqual(["first", "after-clear", "after-resume"]);
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

test("version refusal stays visible without altering the model stream", async () => {
  const f = await fixture("2.1.277");
  expect(f.status).toHaveBeenCalledWith(expect.stringContaining("version mismatch"));
  const received = await collect(f.handlers.get("turn.step")!(f.host, step, f.next));
  expect(received.chunks).toEqual(f.chunks);
  expect(received.result).toBe(f.result);
  expect(f.run.mock.calls.some(([argv]) => argv.includes("hook-capable"))).toBe(false);
  expect(f.next).toHaveBeenCalledExactlyOnceWith(step);
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
    expect(f.log).toHaveBeenCalledExactlyOnceWith(expect.stringContaining("this turn memory check failed: Error: binding mismatch"));
    expect(failure).toHaveBeenCalledWith(expect.stringContaining("binding mismatch"));
    expect(f.run).toHaveBeenCalledTimes(1);
    expect(f.run.mock.calls[0]![0]).toContain("hook-turn");
    expect(JSON.parse(f.run.mock.calls[0]![1]!.stdin)).toEqual({ session_id: "first", turnId: "t1", reason: "aborted" });
    expect(next).toHaveBeenCalledOnce();
  } finally { failure.mockRestore(); }
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
