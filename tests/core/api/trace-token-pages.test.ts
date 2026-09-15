import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { sourceSeededMemory } from "../../source-fixture.ts";
import { drainTrace, tracePage, wholeTrace } from "../../trace-pages.ts";
import { finish, listingLine, renderTrace, tokens } from "../../../src/core/render/index.ts";
import * as rendering from "../../../src/core/render/index.ts";

const time = "2026-09-11T00:00:00Z";
let memory: ReturnType<typeof sourceSeededMemory>;
beforeEach(() => { memory = sourceSeededMemory(":memory:", async () => { throw new Error("no model calls"); }); });
afterEach(() => memory.close());
function corpus() {
  const store = memory.store;
  const projectId = store.createProject({ name: "pagination", declaredBy: "mark" }).id;
  const sessionId = store.createSession({ host: "fake", projectId, startedAt: time, firstReplyAt: time, enrollmentChoice: true }).id;
  const turn = store.appendTurn({ sessionId, kind: "turn", userPrompt: "USER-ONLY", assistantText: "ASSISTANT-ONLY", startedAt: time });
  const script = '中文😀𠮷 é👨‍👩‍👧‍👦 \\"\n\t\\uD83D\\uDE00 </script> '.repeat(600) + "SCRIPT-END";
  const result = "RESULT-START " + "🧪数据 abc123 ".repeat(900) + " RESULT-END\r\n\n";
  store.appendToolCall({ turnId: turn.id, name: "bash", input: JSON.stringify({ command: script }), result, status: "success" });
  store.appendToolCall({ turnId: turn.id, name: "read", input: '{"path":"OTHER-CALL"}', result: "OTHER-RESULT", status: "success" });
  return { sessionId, turn, script, result };
}
function rendered(turnId: number, full = true, part?: "user" | "assistant" | `t${number}`, branch?: string) {
  const turn = memory.store.getTurn(turnId)!;
  return finish(renderTrace(turn, memory.store.listSourceEntries(turn.sessionId, turnId, full ? undefined : branch), memory.config.render, { full, part }));
}

test("omission receipts expand only the exact source call, including its result", () => {
  const { turn, script, result } = corpus();
  const preview = wholeTrace(memory, `T${turn.id}`);
  const instructions = [...preview.matchAll(/expand: trace\(([^\n]+)\)/g)].map(m => JSON.parse(m[1]!));
  expect(instructions).toEqual([3, 4].map(ordinal => ({ address: `T${turn.id}#E${ordinal}@call-1`,
    itemBudget: null, toolCallBudget: null, toolResultBudget: null })));
  const expanded = instructions.map(instruction => wholeTrace(memory, instruction.address, instruction)).join("\n");
  expect(expanded).toBe(rendered(turn.id, true, "t1"));
  expect(expanded).toContain(`command=${JSON.stringify(script)}`);
  expect(expanded).toContain(result);
  for (const absent of ["USER-ONLY", "ASSISTANT-ONLY", "OTHER-CALL", "OTHER-RESULT", "omitted calls", "characters truncated"]) expect(expanded).not.toContain(absent);
});

test.each([1, 2, 100])("full source and assembled trace are lossless within both budgets, cap=%s", cap => {
  const { turn } = corpus();
  for (const part of [undefined, "t1", "user", "assistant"] as const) {
    const address = `T${turn.id}${part ? `#${part}` : ""}`;
    const result = drainTrace(memory, memory.trace(address, { full: true, cap }), { cap });
    expect(result.joined).toBe(rendered(turn.id, true, part));
    if (!part || part === "t1") expect(result.pages).toBeGreaterThan(3);
  }
});

test("mixed and repeated addresses have one cursor stream, without nested cursors or dropped tails", () => {
  const { turn } = corpus();
  const address = `T${turn.id}#t1,T${turn.id}#assistant,T${turn.id}#t1`;
  const first = memory.trace(address, { full: true });
  const result = drainTrace(memory, first);
  expect(result.joined).toBe([rendered(turn.id, true, "t1"), rendered(turn.id, true, "assistant"), rendered(turn.id, true, "t1")].join("\n"));
  expect(result.joined).not.toContain("cursor=");
});

test.each([false, true])("pending text, later named material and occurrences freeze before branch/profile changes, full=%s", full => {
  const { sessionId, turn } = corpus();
  const originalIds = memory.store.listSourceEntries(sessionId, turn.id).map(e => e.id);
  memory.selectEntries(sessionId, "main", originalIds);
  const expected = rendered(turn.id, full, undefined, "main");
  const options = { sessionId, branch: "main", full, cap: 1 };
  const first = memory.trace(`T${turn.id},T${turn.id}`, options);
  const result = drainTrace(memory, first, options, page => {
    if (page !== 1) return;
    expect(memory.store.db.isTransaction).toBe(false);
    const later = memory.appendEntry({ sessionId, turnId: turn.id, nativeLineage: "fixture", nativeId: "later-result", role: "toolResult", text: "", raw: "{}",
      calls: [{ ordinal: 1, callId: "call-1", name: "bash", result: "UNREAD-LATER-RESULT", status: "success" }] });
    memory.selectEntries(sessionId, "main", [originalIds[0]!, later.id]);
    memory.config.render.toolInputTokens = 1000;
    memory.config.render.toolResultTokens = 1000;
  });
  expect(result.joined).toBe([expected, expected].join("\n"));
  expect(result.joined).not.toContain("UNREAD-LATER-RESULT");
});

test("session listing freezes its Turn set before new Turns arrive", () => {
  const { sessionId, turn } = corpus();
  const expected = listingLine(rendered(turn.id, false));
  const first = memory.trace(`S${sessionId}`);
  memory.store.appendTurn({ sessionId, parentTurnId: turn.id, kind: "turn", userPrompt: "UNREAD-NEW-TURN", startedAt: time });
  expect(drainTrace(memory, first).joined).toBe(expected);
});

test("token-limited intervals render only one lookahead and freeze relations and membership", () => {
  const { sessionId, turn } = corpus();
  const commit = (text: string, negate?: { target: string; strength: "strong" }[]) => memory.store.commitNotingRun({
    run: { kind: "manual", sessionId, branch: "main", createdAt: time },
    facts: [{ turnId: turn.id, category: "observation", actor: "user", text, source: [`T${turn.id}#user`], createdAt: time, negate }],
  });
  for (let i = 0; i < 100; i++) expect(commit(`fact-${i} ${"事实😀".repeat(2000)}`).ok).toBe(true);
  const reads = vi.spyOn(memory.store, "getFact");
  const first = memory.trace("F1-F1000000000");
  expect(reads.mock.calls.length).toBe(1);
  reads.mockRestore();
  expect(commit("UNREAD-NEW-FACT", [{ target: "F100", strength: "strong" }]).ok).toBe(true);
  const all = drainTrace(memory, first).joined;
  expect(all).not.toContain("UNREAD-NEW-FACT");
  expect(all).not.toContain("inbound negate");
  for (let i = 1; i <= 100; i++) expect(all.split(`[F${i}]`)).toHaveLength(2);
  expect(wholeTrace(memory, "F100")).toContain("inbound negate F101 strong");
});

test("rejected continuations do not consume trace cursors or loosen frozen budgets", () => {
  const { sessionId, turn } = corpus();
  const options = { full: true, sessionId, maxTokens: 256 };
  const first = memory.trace(`T${turn.id}#t1`, options), cursor = tracePage(first).cursor!;
  for (const maxTokens of [0, 1, -1, 1.5, Infinity, NaN, 257, null, "256"]) {
    expect(() => memory.trace(`cursor=${cursor}`, { sessionId, maxTokens: maxTokens as number })).toThrow(/maxTokens/);
  }
  expect(() => memory.search("", "raw", { sessionId, cursor })).toThrow(/search cannot continue a trace cursor/);
  expect(() => memory.trace(`cursor=${cursor}`, { sessionId, cap: 0 })).toThrow(/cap/);
  expect(() => memory.trace(`T${turn.id},cursor=${cursor}`, { sessionId })).toThrow(/alone/);
  expect(() => memory.trace(`cursor=${cursor}`, { sessionId: sessionId + 1 })).toThrow(/unknown or expired/);
  expect(drainTrace(memory, first, options).joined).toBe(rendered(turn.id, true, "t1"));
});

test("41 repair: trace accepts repeated effective defaults and freezes the configured entry profile", () => {
  const { sessionId, turn } = corpus();
  const first = memory.trace(`T${turn.id}`, { sessionId, cap: 1 });
  const cursor = tracePage(first).cursor!;
  const repeated = { sessionId, cap: 1, pageBudget: 2000, itemBudget: memory.config.render.entryTokens,
    toolCallBudget: memory.config.render.toolInputTokens, toolResultBudget: memory.config.render.toolResultTokens };
  expect(memory.trace(`cursor=${cursor}`, repeated)).not.toContain("unknown or expired cursor");

  const changed = memory.trace(`T${turn.id}`, { sessionId, cap: 1 }), changedCursor = tracePage(changed).cursor!;
  expect(() => memory.trace(`cursor=${changedCursor}`, { sessionId, full: true })).toThrow("cursor itemBudget is frozen");
  expect(() => memory.trace(`cursor=${changedCursor}`, { ...repeated, itemBudget: repeated.itemBudget + 1 })).toThrow("cursor itemBudget is frozen");
  expect(memory.trace(`cursor=${changedCursor}`, repeated)).not.toContain("unknown or expired cursor");

  const unbounded = memory.trace(`T${turn.id}#t1`, { sessionId, full: true, pageBudget: null });
  expect(unbounded).not.toContain("cursor=");
  expect(unbounded).toBe(rendered(turn.id, true, "t1"));
});

test.each([
  { direction: "three null ceilings to full:true", first: { itemBudget: null, toolCallBudget: null, toolResultBudget: null }, second: { full: true } },
  { direction: "full:true to three null ceilings", first: { full: true }, second: { itemBudget: null, toolCallBudget: null, toolResultBudget: null } },
])("raw Turn pagination treats $direction as one effective profile", ({ first, second }) => {
  const { sessionId, turn } = corpus();
  let page = memory.trace(`T${turn.id}`, { ...first, sessionId, pageBudget: 256 });
  let joined = "", separator = "", pages = 0;
  for (;;) {
    const parsed = tracePage(page);
    joined += separator + parsed.body;
    pages++;
    if (!parsed.cursor) break;
    separator = parsed.fragment ? "" : "\n";
    if (pages === 1) {
      expect(() => memory.trace(`cursor=${parsed.cursor}`, { sessionId, itemBudget: 64 })).toThrow("cursor itemBudget is frozen");
      expect(() => memory.trace(`cursor=${parsed.cursor}`, { sessionId, pageBudget: 257 })).toThrow("cursor pageBudget is frozen");
      expect(() => memory.trace(`cursor=${parsed.cursor}`, { sessionId, cap: 99 })).toThrow("cursor cap is frozen");
      page = memory.trace(`cursor=${parsed.cursor}`, { ...second, sessionId, pageBudget: 256 });
    } else {
      // Once equivalence is established, every frozen option can be omitted.
      page = memory.trace(`cursor=${parsed.cursor}`, { sessionId });
    }
  }
  expect(pages).toBeGreaterThan(2);
  expect(joined).toBe(rendered(turn.id));
});

test.each(["facade", "tool"])("%s preserves explicit-cursor address compatibility and priority", entry => {
  const { sessionId, turn } = corpus();
  const address = `T${turn.id}#t1`;
  const trace = memory.tools({ kind: "manual", sessionId, currentTurnId: turn.id, branch: "main" }).find(t => t.name === "trace")!;
  const read = (address: string, cursor?: string) => entry === "facade"
    ? memory.trace(address, { sessionId, full: true, cursor }) : trace.execute({ address, full: true, cursor });
  let page = read(address), joined = "", fragment = false, pages = 0;
  const placeholders = [address, "unused placeholder", "", "K1,T1", "cursor=bogus"];
  for (;;) {
    expect(page).not.toContain("rejected:");
    const parsed = tracePage(page);
    joined += joined && !fragment ? `\n${parsed.body}` : parsed.body;
    fragment = parsed.fragment;
    if (!parsed.cursor) break;
    expect(trace.execute({ cursor: parsed.cursor })).toContain("rejected: address must be a string");
    // Explicit options.cursor retains priority over a standalone address cursor.
    page = read(placeholders[pages++ % placeholders.length]!, parsed.cursor);
    expect(pages).toBeLessThan(100);
  }
  expect(pages).toBeGreaterThanOrEqual(placeholders.length);
  expect(joined).toBe(rendered(turn.id, true, "t1"));
});

test.each([64, 80, 96, 128])("tiny shared budget %s advances losslessly with Unicode and escapes", maxTokens => {
  const { turn } = corpus();
  const options = { full: true, maxTokens };
  let first: string;
  try { first = memory.trace(`T${turn.id}#t1`, options); }
  catch (error) { expect(String(error)).toMatch(/maxTokens is too small/); return; }
  expect(drainTrace(memory, first, options).joined).toBe(rendered(turn.id, true, "t1"));
});

test.each(["😀", "𠮷", "👨‍👩‍👧‍👦", "é", "\\\\uD83D\\\\uDE00", "\\\\\\\"\\\\n", "abc123"])("page probes preserve script classification and escaped bytes: %s", unit => {
  const { sessionId, turn } = corpus();
  const text = unit.repeat(2000);
  const t = memory.store.appendTurn({ sessionId, parentTurnId: turn.id, kind: "turn", userPrompt: text, startedAt: time });
  const options = { full: true, maxTokens: 128 };
  expect(drainTrace(memory, memory.trace(`T${t.id}#user`, options), options).joined).toBe(`[T${t.id}#E1@text] user: ${text}`);
});

test.each(["K1", "K1@1", "F1-F1,K1@1,T1#t1"])("token-paged %s grants its exact knowledge handle only on the last page", address => {
  const { sessionId, turn } = corpus();
  const run = { kind: "manual" as const, sessionId, branch: "main", createdAt: time };
  const noted = memory.store.commitNotingRun({ run, facts: [{ turnId: turn.id, category: "observation", actor: "user", text: "evidence",
    source: [`T${turn.id}#user`], createdAt: time }] });
  expect(noted.ok).toBe(true);
  const created = memory.store.commitConsolidationRun({ run, operations: [{ op: "create", handle: "h1", author: "fake", text: "知识😀".repeat(4000),
    category: "mechanism", scope: "session", supports: [1], reason: "test", topics: [], createdAt: time }] });
  expect(created.ok).toBe(true);
  const tools = memory.tools({ kind: "manual", sessionId, currentTurnId: turn.id, branch: "main" });
  const trace = tools.find(t => t.name === "trace")!, search = tools.find(t => t.name === "search")!, write = tools.find(t => t.name === "memory")!;
  const edit = () => JSON.parse(write.execute({ operations: [{ op: "update", id: "K1@1", text: "updated", category: "mechanism", scope: "session",
    supports: ["F1"], reason: "test", topics: [] }], skipped: [] }));
  const expected = wholeTrace(memory, address, { full: true, sessionId, branch: "main", headTurnId: turn.id });
  let page = trace.execute({ address, full: true }), pages = 0, joined = "", fragment = false;
  for (;;) {
    expect(page).not.toContain("rejected:");
    expect(tokens(page)).toBeLessThanOrEqual(2000);
    const parsed = tracePage(page), cursor = parsed.cursor;
    joined += joined && !fragment ? `\n${parsed.body}` : parsed.body;
    fragment = parsed.fragment;
    if (!cursor) break;
    // Exercise every pending position, including the continuation that completes the K read.
    // Both entry points must refuse before consuming the real cursor or delivering a handle.
    for (const invalid of ["K1,cursor=bogus", `cursor=${cursor},K1`, " K1 , cursor=bogus "]) {
      expect(() => memory.trace(invalid, { sessionId, cursor })).toThrow(/continue a cursor alone/);
      expect(trace.execute({ address: invalid, cursor })).toContain("rejected: continue a cursor alone");
      expect(edit().results[0]).toContain("knowledge was not read");
    }
    expect(edit().results[0]).toContain("knowledge was not read");
    expect(search.execute({ query: "", cursor })).toContain("search cannot continue a trace cursor");
    expect(edit().results[0]).toContain("knowledge was not read");
    page = trace.execute({ address: `cursor=${cursor}` });
    expect(++pages).toBeLessThan(100);
  }
  expect(pages).toBeGreaterThan(3);
  expect(joined).toBe(expected);
  expect(edit().committed[0]).toMatchObject({ knowledgeId: 1, commit: 2 });
});

test.each([128, 400, 2000])("non-monotone intact Unicode lines take one page when they fit: %s emoji", count => {
  const { sessionId, turn } = corpus();
  const text = `needle ${"😀".repeat(count)}a`;
  const t = memory.store.appendTurn({ sessionId, parentTurnId: turn.id, kind: "turn", userPrompt: text, startedAt: time });
  expect(tokens("😀".repeat(128))).toBe(143);
  expect(tokens("😀".repeat(128) + "a")).toBe(37);
  const expected = `[T${t.id}#E1@text] user: ${text}`;
  expect(memory.trace(`T${t.id}#user`, { full: true, maxTokens: Math.max(128, tokens(expected)) })).toBe(expected);
  const search = memory.search("needle", "raw", { maxTokens: 8000 });
  expect(search).not.toContain("cursor=");
  expect(memory.search("needle", "raw", { maxTokens: Math.max(128, tokens(search)) })).toBe(search);
});

test("named multi-address values freeze under the transaction, but rendering and estimation never run there", () => {
  const { sessionId, turn } = corpus();
  const store = memory.store;
  const run = { kind: "manual" as const, sessionId, branch: "main", createdAt: time };
  expect(store.commitNotingRun({ run, facts: [{ turnId: turn.id, category: "observation", actor: "user", text: "original fact",
    source: [`T${turn.id}#user`], createdAt: time }] }).ok).toBe(true);
  expect(store.commitConsolidationRun({ run, operations: [{ op: "create", handle: "h1", author: "fake", text: "original knowledge",
    category: "mechanism", scope: "project", supports: [1], reason: "test", topics: [], createdAt: time }] }).ok).toBe(true);
  const address = `T${turn.id},S${sessionId},pagination,F1,K1,F1-F1`;
  const expected = wholeTrace(memory, address);
  const spies = (["renderTrace", "renderFact", "renderKnowledge", "renderKnowledgeTrace", "tokens"] as const).map(name => {
    const original = rendering[name];
    return vi.spyOn(rendering, name).mockImplementation(((...args: never[]) => {
      expect(store.db.isTransaction, name).toBe(false);
      return (original as Function)(...args);
    }) as never);
  });
  const transaction = store.transaction.bind(store);
  let changed = false;
  const snapshot = vi.spyOn(store, "transaction").mockImplementation(body => {
    const value = transaction(body);
    if (!changed) {
      changed = true;
      store.mark(1, "flagged", time);
      store.appendTurn({ sessionId, parentTurnId: turn.id, kind: "turn", userPrompt: "NEW-TURN", startedAt: time });
      memory.appendEntry({ sessionId, turnId: turn.id, nativeLineage: "fixture", nativeId: "new-after-freeze", role: "toolResult", text: "", raw: "{}",
        calls: [{ ordinal: 1, callId: "call-1", name: "bash", result: "NEW-RESULT", status: "success" }] });
      expect(store.commitNotingRun({ run, facts: [{ turnId: turn.id, category: "observation", actor: "user", text: "NEW-NEGATION",
        source: [`T${turn.id}#user`], negate: [{ target: "F1", strength: "strong" }], createdAt: time }] }).ok).toBe(true);
      memory.config.render.toolInputTokens = 1000;
      memory.config.render.toolResultTokens = 1000;
    }
    return value;
  });
  try {
    expect(wholeTrace(memory, address, { cap: 1 })).toBe(expected);
    expect(changed).toBe(true);
    for (const spy of spies) expect(spy).toHaveBeenCalled();
  } finally { snapshot.mockRestore(); for (const spy of spies) spy.mockRestore(); }
});

test("large lines are priced whole once, then only page-sized prefixes on continuation", () => {
  const { turn } = corpus();
  const read = (size: number) => {
    const text = "abc123 中文😀 ".repeat(size);
    const t = memory.store.appendTurn({ sessionId: turn.sessionId, parentTurnId: turn.id, kind: "turn", userPrompt: text, startedAt: time });
    const original = String.prototype.split;
    let measured = 0, first = "";
    String.prototype.split = function (this: string, separator: any, limit?: number) {
      if (separator instanceof RegExp) measured += this.length;
      return original.call(this, separator, limit);
    } as typeof original;
    let initial = 0;
    try {
      first = memory.trace(`T${t.id}#user`, { full: true });
      initial = measured;
      measured = 0;
      const cursor = tracePage(first).cursor!;
      first = memory.trace(`cursor=${cursor}`);
    } finally { String.prototype.split = original; }
    expect(tokens(first)).toBeLessThanOrEqual(2000);
    expect(initial).toBeLessThan(text.length * 2 + 100_000);
    return measured;
  };
  expect(read(100_000)).toBeLessThan(read(1000) * 2);
});
