import { beforeAll, expect, test, vi } from "vitest";
import { build } from "esbuild";
import { resolve } from "node:path";

let compact: (host: any, event: any, next: any) => Promise<any>;
beforeAll(async () => {
  const output = await build({ entryPoints: [resolve("plugin/hooks/index.tsx")], bundle: true, write: false,
    format: "esm", platform: "neutral", jsx: "transform", jsxFactory: "jsx" });
  const { register } = await import(`data:text/javascript;base64,${Buffer.from(output.outputFiles[0]!.contents).toString("base64")}`);
  register((name: string, ...args: any[]) => { if (name === "session.compact") compact = args.at(-1); });
});
const original = { messages: [{ role: "assistant", text: "summary", handle: { native: 1 } }], tokensBefore: 50 };
const slice = { hookSpecificOutput: { additionalContext: "knowledge" } };
const output = { exitCode: 0, stdout: JSON.stringify({ slices: [slice, ...Array(23).fill(null)] }) };
function fixture() {
  const controller = new AbortController();
  const id = vi.fn(async () => "session-A");
  const run = vi.fn(async () => output);
  const next = vi.fn(async () => original) as any;
  next.signal = controller.signal;
  const host = { session: { id }, process: { run }, plugin: { root: "/plugin" } };
  return { host, id, run, next, controller };
}
const event = { trigger: "manual", messages: [] };
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(r => { resolve = r; });
  return { promise, resolve };
}

test("native next rejection is unchanged and next is called once", async () => {
  const f = fixture(), failure = new Error("native failure");
  f.next.mockRejectedValue(failure);
  await expect(compact(f.host, event, f.next)).rejects.toBe(failure);
  expect(f.next).toHaveBeenCalledExactlyOnceWith(event);
  expect(f.run).not.toHaveBeenCalled();
});

test("cancellation after native next preserves original result", async () => {
  const f = fixture();
  f.next.mockImplementation(async () => { f.controller.abort(); return original; });
  expect(await compact(f.host, event, f.next)).toBe(original);
  expect(f.run).not.toHaveBeenCalled();
});

test.each(["process failure", "malformed output"])("%s preserves exact native result", async kind => {
  const f = fixture();
  f.run.mockImplementation(async () => kind === "process failure" ? { exitCode: 1, stdout: "", stderr: "failed" } : { exitCode: 0, stdout: "{" });
  expect(await compact(f.host, event, f.next)).toBe(original);
  expect(f.next).toHaveBeenCalledOnce();
});

test("native session switch during process rejects appended carrier", async () => {
  const f = fixture(), pending = deferred<typeof output>();
  f.run.mockReturnValue(pending.promise);
  const result = compact(f.host, event, f.next);
  await vi.waitFor(() => expect(f.run).toHaveBeenCalledOnce());
  f.id.mockResolvedValue("session-B"); pending.resolve(output);
  expect(await result).toBe(original);
});

test("cancellation during process rejects appended carrier", async () => {
  const f = fixture(), pending = deferred<typeof output>();
  f.run.mockReturnValue(pending.promise);
  const result = compact(f.host, event, f.next);
  await vi.waitFor(() => expect(f.run).toHaveBeenCalledOnce());
  f.controller.abort(); pending.resolve(output);
  expect(await result).toBe(original);
});

test("cancellation during final asynchronous identity check rejects appended carrier", async () => {
  const f = fixture(), pending = deferred<string>();
  f.id.mockResolvedValueOnce("session-A").mockResolvedValueOnce("session-A").mockReturnValueOnce(pending.promise);
  const result = compact(f.host, event, f.next);
  await vi.waitFor(() => expect(f.id).toHaveBeenCalledTimes(3));
  f.controller.abort(); pending.resolve("session-A");
  expect(await result).toBe(original);
});

test("valid delta appends once and retains original native handle", async () => {
  const f = fixture();
  const result = await compact(f.host, event, f.next);
  expect(result.messages[0]).toBe(original.messages[0]);
  expect(result.messages[1]).toEqual({ role: "user", text: "knowledge", toolUses: [] });
  expect(result.tokensBefore).toBe(50);
  expect(f.run).toHaveBeenCalledOnce();
});

test.each([{ trigger: "precompute" }, { trigger: "plugin" }, { trigger: "manual", agentId: "agent" }])(
  "$trigger/$agentId does not append", async e => {
    const f = fixture();
    expect(await compact(f.host, { ...event, ...e }, f.next)).toBe(original);
    expect(f.run).not.toHaveBeenCalled();
  });

test("native skip does not append", async () => {
  const f = fixture(), skipped = { skip: "native skip" };
  f.next.mockResolvedValue(skipped);
  expect(await compact(f.host, event, f.next)).toBe(skipped);
  expect(f.run).not.toHaveBeenCalled();
});
