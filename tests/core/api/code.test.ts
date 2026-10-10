// Ticket 136: the sandbox that runs `search`'s `code`, and the result it prints. Runaway scripts run
// inside the QuickJS VM under its deadline, never as host code.
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, test } from "vitest";
import { sourceSeededMemory } from "../../source-fixture.ts";
import { CODE_DEADLINE_MS, CODE_MEMORY_BYTES, CODE_OUTPUT_TOKENS, capOutput, formatCodeResult, runCode } from "../../../src/core/api/code.ts";
import { tokens } from "../../../src/core/render/index.ts";

let memory: ReturnType<typeof sourceSeededMemory>, directory: string;
beforeEach(() => {
  memory = sourceSeededMemory(":memory:", async () => { throw new Error("no model calls"); });
  directory = mkdtempSync(join(tmpdir(), "tm-code-"));
  const store = memory.store, project = store.createProject({ name: "code", declaredBy: "mark" });
  const session = store.createSession({ enrollmentChoice: true, host: "fake", projectId: project.id, startedAt: "2026-10-01T00:00:00Z", firstReplyAt: "2026-10-01T00:00:01Z" });
  store.appendTurn({ sessionId: session.id, kind: "turn", userPrompt: "alpha beta gamma", assistantText: "alpha reply", startedAt: "2026-10-01T00:01:00Z" });
});
afterEach(() => { memory.close(); rmSync(directory, { recursive: true, force: true }); });

const spill = (text: string) => { const path = join(directory, `spill-${existsSync(join(directory, "spill-1.txt")) ? 2 : 1}.txt`); writeFileSync(path, text); return path; };
const run = (code: string, options: { topk?: number } = {}) =>
  Promise.resolve(memory.search("alpha", "raw", { ...options, code, spill })) as Promise<string>;
const host = { items: [{ layer: "raw", n: 1 }, { layer: "facts", n: 2, lazy: ["text"] }], field: (index: number, name: string) => `${name} of ${index}`, render: (index: number) => `rendered ${index}` };

test("limits are the ruled ones: 10 s, 256 MB, 10,000 tokens", () => {
  expect([CODE_DEADLINE_MS, CODE_MEMORY_BYTES, CODE_OUTPUT_TOKENS]).toEqual([10_000, 256 * 1024 * 1024, 10_000]);
});

test("hits, text, console, return and render print in Pi's layout", async () => {
  const out = await run("text(hits.map(h => h.role)); console.log('seen', hits.length); return render(hits[0]);");
  expect(out).toMatch(/^Script completed\nWall time \d+\.\d seconds\nOutput:\n/);
  expect(out).toContain("==> text 1/2 <==\n[\"user\",\"assistant\"]");
  expect(out).toContain("==> text 2/2 <==\n[S1/T1#E1@user] ");
  expect(out).toContain("<console_output>\nseen 2\n</console_output>");
  const single = await run("return hits.length");
  expect(single.endsWith("Output:\n2")).toBe(true); // one text item carries no numbering
});

test("hits holds at most topk items, and the search's own order", async () => {
  expect((await run("return hits.length", { topk: 1 })).endsWith("Output:\n1")).toBe(true);
  expect((await run("return hits.map(h => h.entry).join()", { topk: 5 })).endsWith("Output:\n1,2")).toBe(true);
});

test("a script that throws fails, keeps its partial output and says where", async () => {
  const out = await run("text('partial'); console.log('before'); null.x");
  expect(out).toMatch(/^Script failed\n/);
  expect(out).toContain("partial");
  expect(out).toContain("<console_output>\nbefore\n</console_output>");
  expect(out).toMatch(/Script error:\nTypeError: .*null[\s\S]*search-code\.js:1/);
  expect(await run("syntax error (")).toMatch(/^Script failed[\s\S]*SyntaxError/);
  expect(await run("exit(); text('never')")).toMatch(/^Script completed/);
});

test("the sandbox has no Node API, timers, file system, network or modules", async () => {
  const out = await run("return ['require', 'process', 'fetch', 'setTimeout', 'setInterval', 'Buffer', 'std', 'os', 'import'].map(name => name + ':' + typeof globalThis[name]).join()");
  expect(out.endsWith("Output:\nrequire:undefined,process:undefined,fetch:undefined,setTimeout:undefined,setInterval:undefined,Buffer:undefined,std:undefined,os:undefined,import:undefined")).toBe(true);
  expect(await run("const m = await import('fs'); return typeof m")).toMatch(/^Script failed/);
  // A promise nothing can resolve fails at once, since no timer or I/O exists to resume it.
  expect(await run("await new Promise(() => {})")).toContain("can never settle");
});

test("built-ins are frozen, and a script cannot reach the host through them", async () => {
  const out = await run("'use strict'; const attempts = []; for (const f of [() => { Array.prototype.push = 1; }, () => { Object.prototype.polluted = 1; }, () => { JSON.stringify = null; }, () => { globalThis.text = null; }]) { try { f(); attempts.push('changed'); } catch (e) { attempts.push('refused'); } } return attempts.join() + ' ' + Object.isFrozen(Array.prototype) + Object.isFrozen(hits[0])");
  expect(out.endsWith("Output:\nrefused,refused,refused,refused truetrue")).toBe(true);
  // Nothing a script does to its own realm is visible to the next call or to the host.
  expect(({} as Record<string, unknown>).polluted).toBeUndefined();
  expect((await run("return typeof Object.prototype.polluted")).endsWith("Output:\nundefined")).toBe(true);
  // The error subclass idiom still works with frozen built-ins.
  expect((await run("class Mine extends Error { constructor(m) { super(m); this.name = 'Mine'; } } try { throw new Mine('x'); } catch (e) { return e.name + ':' + e.message; }")).endsWith("Output:\nMine:x")).toBe(true);
});

test("an infinite loop is killed at the 10 s deadline and reported as failed", async () => {
  const started = performance.now();
  const out = await run("let n = 0; for (;;) { n++; }");
  const elapsed = performance.now() - started;
  expect(out).toMatch(/^Script failed\n/);
  expect(out).toContain("Script timed out after 10 seconds");
  expect(elapsed).toBeGreaterThanOrEqual(9_900);
  expect(elapsed).toBeLessThan(15_000);
}, 30_000);

test("the host's event loop keeps running while a script spins until its deadline", async () => {
  // The sandbox is a worker thread: a script that never yields must not stop a host timer (the host's own UI, heartbeat or other tool calls).
  const gaps: number[] = [];
  let last = performance.now();
  const timer = setInterval(() => { const now = performance.now(); gaps.push(now - last); last = now; }, 10);
  try {
    const out = await runCode("for (;;) {}", { items: [], field: () => null, render: () => "" }, { deadlineMs: 1_500 });
    expect(out.error).toContain("timed out");
  } finally { clearInterval(timer); }
  expect(gaps.length).toBeGreaterThan(60); // about 150 ticks in 1.5 s
  expect(Math.max(...gaps)).toBeLessThan(300); // an in-process loop would show one gap of about 1,500 ms
});

test("the engine stack is Pi's 512 KiB: recursion goes about twice as deep as with 256 KiB, then throws", async () => {
  const out = await runCode("let depth = 0; function f() { depth++; f(); } try { f(); } catch (e) { return e.name + ' ' + depth; }", { items: [], field: () => null, render: () => "" });
  const [name, depth] = out.items[0]!.text.split(" ");
  expect(name).toBe("RangeError");
  expect(Number(depth)).toBeGreaterThan(1_500); // about 1,100 at 256 KiB, about 2,200 at 512 KiB
  // Native recursion in a built-in ends the same way, never in a crash of the host.
  const deep = await runCode("let a = []; for (let i = 0; i < 100000; i++) a = [a]; try { return JSON.stringify(a).length; } catch (e) { return e.name; }", { items: [], field: () => null, render: () => "" });
  expect(deep.error ?? deep.items[0]!.text).toMatch(/RangeError|call stack/);
});

test("the deadline also ends loops a try/catch, a regex or an async chain would hide", async () => {
  const limits = { deadlineMs: 400 };
  for (const code of ["for (;;) { try { for (;;) {} } catch (e) {} }", "/(a+)+$/.test('a'.repeat(80) + 'b')",
    "for (;;) await 0;", "[1, 2, 3].sort(() => { for (;;) {} })"]) {
    const started = performance.now();
    const out = await runCode(code, { items: [], field: () => null, render: () => "" }, limits);
    expect(out.ok, code).toBe(false);
    expect(out.error, code).toContain("timed out");
    expect(performance.now() - started, code).toBeLessThan(5_000);
  }
});

test("allocation past 256 MB fails inside the script, and the host survives", async () => {
  const before = process.memoryUsage().rss;
  const out = await run("const kept = []; for (;;) kept.push('x'.repeat(1 << 20));");
  expect(out).toMatch(/^Script failed\n/);
  expect(out).toMatch(/out of memory/);
  expect(process.memoryUsage().rss - before).toBeLessThan(900 * 1024 * 1024);
  // Runaway recursion is a catchable RangeError, not a crash of the engine.
  expect(await run("function f() { return f() + 1 } try { f() } catch (e) { return e.name }")).toMatch(/Output:\nRangeError$/);
}, 30_000);

test("output past 10,000 tokens keeps its start and end and names a file holding all of it", async () => {
  const out = await run("text('HEAD ' + 'word '.repeat(60000) + ' TAIL')");
  expect(out).toMatch(/^Script completed/);
  expect(out).toContain("Warning: truncated output");
  expect(out).toContain("HEAD word"); expect(out).toMatch(/word {2}TAIL\n\n\[Full output: /);
  expect(out).toContain("tokens truncated");
  expect(tokens(out)).toBeLessThanOrEqual(CODE_OUTPUT_TOKENS + 200);
  const path = /\[Full output: (.+)\]/.exec(out)![1]!;
  const saved = readFileSync(path, "utf8");
  expect(saved.startsWith("HEAD word")).toBe(true); expect(saved.endsWith(" TAIL")).toBe(true);
  expect(saved.length).toBeGreaterThan(300_000);
  // The default print is capped the same way; a host with no render directory says the rest is not saved.
  const plain = capOutput("line\n".repeat(80_000));
  expect(plain).toContain("[The full output is not saved");
  expect(tokens(plain)).toBeLessThanOrEqual(CODE_OUTPUT_TOKENS + 200);
  expect(capOutput("short")).toBe("short");
});

test("a field read inside the script crosses the VM boundary only on first access", async () => {
  const reads: string[] = [];
  const out = await runCode("const a = hits[1].text, b = hits[1].text; return hits[0].n + a + b", { ...host, field: (i, name) => { reads.push(`${i}.${name}`); return `${name}!`; } });
  expect(out.items.map(i => i.text)).toEqual(["1text!text!"]);
  expect(reads).toEqual(["1.text"]);
  expect(formatCodeResult({ ...out, wallMs: 1234 })).toMatch(/^Script completed\nWall time 1\.2 seconds\nOutput:\n1text!text!$/);
});
