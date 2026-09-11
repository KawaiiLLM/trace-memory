import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { sourceSeededMemory } from "../../source-fixture.ts";
import { listingLine, tokens } from "../../../src/core/render/index.ts";
import { wholeTrace } from "../../trace-pages.ts";

const time = "2026-09-10T00:00:00Z";
let memory: ReturnType<typeof sourceSeededMemory>;
beforeEach(() => { memory = sourceSeededMemory(":memory:", async () => { throw new Error("no model calls"); }); });
afterEach(() => { memory.close(); });
const cursorOf = (text: string) => /cursor=(\S+)/.exec(text)?.[1];
const body = (text: string) => text.slice(0, text.lastIndexOf("\n\nReceipts:"));
const split = (text: string) => text.includes("\nHit continues on next page; concatenate without a newline.\n");
const traceWhole = (address: string) => wholeTrace(memory, address);
function corpus(texts: string[]) {
  const store = memory.store;
  const projectId = store.createProject({ name: "test", declaredBy: "mark" }).id;
  const sessionId = store.createSession({ host: "fake", projectId, startedAt: time, firstReplyAt: time, enrollmentChoice: true }).id;
  let parentTurnId: number | null = null;
  const turns = texts.map(text => {
    const turn = store.appendTurn({ sessionId, parentTurnId, kind: "turn", userPrompt: `needle ${text}`, startedAt: time });
    parentTurnId = turn.id;
    return turn;
  });
  return { sessionId, turns };
}
function drain(first: string, budget: number, sessionId?: number, cap = 100) {
  let page = first, joined = "", separator = "", pages = 0;
  const seen = new Set<string>();
  while (true) {
    expect(tokens(page)).toBeLessThanOrEqual(budget);
    expect([...body(page)].some(point => point.length === 1 && /[\uD800-\uDFFF]/.test(point))).toBe(false);
    expect(body(page).split("\n").length).toBeLessThanOrEqual(cap);
    joined += separator + body(page);
    separator = split(page) ? "" : "\n";
    const cursor = cursorOf(page);
    if (!cursor) break;
    expect(seen.has(cursor)).toBe(false); seen.add(cursor);
    expect(++pages).toBeLessThan(1000);
    // Exercise the shared trace route too: it must retain the SEARCH budget and footer.
    page = pages % 2 ? memory.trace(`cursor=${cursor}`, { sessionId }) : memory.search("ignored", "all", { cursor, sessionId });
  }
  return { joined, pages: pages + 1 };
}

test.each([undefined, 256, 777, 2000])("Chinese long Raw hit is lossless across pages, budget %s", maxTokens => {
  const { turns } = corpus(["中文😀𠮷资料 abc123 。".repeat(1800) + "UNIQUE-END"]);
  const whole = listingLine(traceWhole(`T${turns[0]!.id}`));
  const first = memory.search("needle", "raw", { maxTokens });
  const result = drain(first, maxTokens ?? 2000);
  expect(result.pages).toBeGreaterThan(1);
  expect(result.joined).toBe(whole);
  expect(result.joined).toContain("UNIQUE-END");
});

test.each([1, 2, 100])("multiple hits and fragments preserve order with cap %s", cap => {
  const { sessionId, turns } = corpus(["short", "中文😀".repeat(4000), "short second", "末尾𠮷".repeat(2000)]);
  const expected = turns.map(t => listingLine(traceWhole(`T${t.id}`))).join("\n");
  const result = drain(memory.search("needle", "raw", { sessionId, cap, maxTokens: 320 }), 320, sessionId, cap);
  expect(result.joined).toBe(expected);
});

test("default multi-hit pages and explicit identical continuation budgets stay bounded", () => {
  const { turns } = corpus(Array.from({ length: 40 }, (_, i) => `${i} ${"中文😀".repeat(900)}`));
  const first = memory.search("needle", "raw");
  const cursor = cursorOf(first)!;
  const second = memory.search("", "raw", { cursor, maxTokens: 2000 });
  const rest = drain(second, 2000);
  expect(tokens(first)).toBeLessThanOrEqual(2000);
  expect(body(first) + (split(first) ? "" : "\n") + rest.joined).toBe(turns.map(t => listingLine(traceWhole(`T${t.id}`))).join("\n"));
  expect(tokens(memory.search("absent", "all"))).toBeLessThanOrEqual(2000);
});

test("whole hits defer without fragments, and formatting never walks the remaining corpus", () => {
  const { turns } = corpus(Array.from({ length: 40 }, (_, i) => `${i} ${"中文".repeat(120)}`));
  const reads = vi.spyOn(memory.store, "getSourceEntry");
  const first = memory.search("needle", "raw", { maxTokens: 400 });
  expect(split(first)).toBe(false);
  expect(body(first)).toBe(listingLine(traceWhole(`T${turns[0]!.id}`)));
  // At most one lookahead hit, plus the expected-value trace above.
  expect(reads.mock.calls.length).toBeLessThanOrEqual(3);
  reads.mockRestore();
  expect(drain(first, 400).joined).toBe(turns.map(t => listingLine(traceWhole(`T${t.id}`))).join("\n"));
});

test("invalid budgets and cap do not consume a valid cursor; budgets cannot change via trace", () => {
  const { sessionId } = corpus(["中文😀".repeat(3000)]);
  const first = memory.search("needle", "raw", { sessionId, maxTokens: 300 });
  const cursor = cursorOf(first)!;
  for (const maxTokens of [0, -1, 1.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1, null, "300", 1, 301]) {
    expect(() => memory.search("", "raw", { sessionId, cursor, maxTokens: maxTokens as number })).toThrow(/maxTokens/);
  }
  expect(() => memory.trace(`cursor=${cursor}`, { sessionId, maxTokens: 10000 })).toThrow(/frozen/);
  expect(() => memory.trace(`K1,cursor=${cursor}`, { sessionId })).toThrow(/alone/);
  expect(() => memory.search("", "raw", { sessionId, cursor, cap: 0 })).toThrow(/cap/);
  expect(() => memory.search("", "bogus" as never, { sessionId, cursor })).toThrow("invalid search scope");
  expect(() => memory.search("", "raw", { sessionId: sessionId + 1, cursor })).toThrow(/unknown or expired/);
  expect(drain(first, 300, sessionId).pages).toBeGreaterThan(1);
  for (const maxTokens of [0, -1, 1.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1, null, "300", 1]) {
    expect(() => memory.search("needle", "raw", { maxTokens: maxTokens as number })).toThrow(/maxTokens/);
  }
});

test("pending text and deferred profile/entry membership remain frozen", () => {
  const { sessionId, turns } = corpus(["中文😀".repeat(2500), "second"]);
  memory.store.appendToolCall({ turnId: turns[1]!.id, name: "read", input: "{}", result: "工具结果".repeat(4000), status: "success" });
  const whole = turns.map(t => listingLine(traceWhole(`T${t.id}`))).join("\n");
  const first = memory.search("needle", "raw", { sessionId, maxTokens: 350 });
  memory.config.render.entryTokens = 200;
  memory.config.render.toolResultTokens = 100;
  memory.store.updateTurn(turns[1]!.id, { assistantText: "ADDED-AFTER-QUERY" });
  corpus(["NEW-HIT"]);
  expect(drain(first, 350, sessionId).joined).toBe(whole);
});

test.each([64, 80, 96, 128])("tiny budget %s either rejects explicitly or keeps advancing", maxTokens => {
  const { turns } = corpus(["中文😀𠮷 ".repeat(80)]);
  let first: string;
  try { first = memory.search("needle", "raw", { maxTokens }); }
  catch (error) { expect(String(error)).toMatch(/maxTokens is too small/); return; }
  expect(drain(first, maxTokens).joined).toBe(listingLine(traceWhole(`T${turns[0]!.id}`)));
});

test("model-facing schema and execution expose only search's token budget", () => {
  const { sessionId, turns } = corpus(["中文😀".repeat(2000)]);
  const [trace, search] = memory.tools({ kind: "manual", sessionId, branch: "main", currentTurnId: turns[0]!.id });
  expect(search!.parameters.properties).toHaveProperty("maxTokens", { type: "integer", minimum: 1, maximum: Number.MAX_SAFE_INTEGER, default: 2000 });
  expect(trace!.parameters.properties).not.toHaveProperty("maxTokens");
  const first = search!.execute({ query: "needle", layer: "raw", maxTokens: 256 });
  expect(tokens(first)).toBeLessThanOrEqual(256);
  const cursor = cursorOf(first)!;
  expect(search!.execute({ query: "", cursor, maxTokens: 0 })).toContain("rejected:");
  expect(search!.execute({ query: "", cursor, maxTokens: 256 })).not.toContain("rejected:");
});

test("trace and search continuations retain the same default token budget", () => {
  const { sessionId, turns } = corpus(["中文".repeat(4000), "second"]);
  expect(tokens(memory.trace(`T${turns[0]!.id}`))).toBeLessThanOrEqual(2000);
  const first = memory.trace(`S${sessionId}`, { cap: 1 });
  const cursor = cursorOf(first)!;
  const next = memory.search("", "raw", { cursor });
  expect(tokens(next)).toBeLessThanOrEqual(2000);
  expect(() => memory.trace(`cursor=${cursor}`)).toThrow(/unknown or expired/);
});
