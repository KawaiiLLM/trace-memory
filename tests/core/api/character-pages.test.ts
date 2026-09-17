import { afterEach, beforeEach, expect, test } from "vitest";
import { sourceSeededMemory } from "../../source-fixture.ts";
import { tracePage } from "../../trace-pages.ts";

const time = "2026-09-17T00:00:00Z";
let memory: ReturnType<typeof sourceSeededMemory>;
beforeEach(() => { memory = sourceSeededMemory(":memory:", async () => { throw new Error("no model calls"); }); });
afterEach(() => memory.close());

let serial = 0;
function raw(text: string) {
  const projectId = memory.store.createProject({ name: `character-pages-${++serial}`, declaredBy: "marker" }).id;
  const sessionId = memory.store.createSession({ host: "fake", projectId, startedAt: time, firstReplyAt: time, enrollmentChoice: true }).id;
  const turn = memory.store.appendTurn({ sessionId, kind: "turn", userPrompt: text, startedAt: time });
  return { sessionId, turn, expected: `[T${turn.id}#E1@text] user: ${text}` };
}

function drain(first: string, options: Parameters<typeof memory.trace>[1]) {
  let page = first, joined = "", fragment = false;
  const pages: string[] = [];
  for (;;) {
    const parsed = tracePage(page);
    pages.push(page);
    joined += joined && !fragment ? `\n${parsed.body}` : parsed.body;
    fragment = parsed.fragment;
    if (!parsed.cursor) return { joined, pages };
    page = memory.trace(`cursor=${parsed.cursor}`, options);
  }
}

test("optional character ceiling paginates final strings losslessly while omission preserves Pi behavior", () => {
  const f = raw(`BEGIN${" ".repeat(600_000)}END`);
  const common = { full: true, pageBudget: 8_000, sessionId: f.sessionId } as const;
  const unbounded = memory.trace(`T${f.turn.id}#E1`, common);
  expect(unbounded).not.toContain("cursor=");
  expect(unbounded).toBe(f.expected);

  const options = { ...common, maxChars: 500_000 };
  const result = drain(memory.trace(`T${f.turn.id}#E1`, options), options);
  expect(result.joined).toBe(f.expected);
  expect(result.pages.length).toBe(2);
  expect(result.pages.every(page => page.length <= 500_000)).toBe(true);
  expect(result.pages.every(page => !page.includes("page limited by"))).toBe(true);
});

test("character ceiling counts UTF-16 code units, receipts and frozen continuation options", () => {
  const f = raw(`BEGIN${"😀".repeat(800)}END`);
  const options = { full: true, pageBudget: 8_000, maxChars: 500, sessionId: f.sessionId };
  const first = memory.trace(`T${f.turn.id}#E1`, options), cursor = tracePage(first).cursor!;
  expect(first.length).toBeLessThanOrEqual(500);
  expect(first).not.toContain("page limited by");
  expect([...tracePage(first).body].some(point => point.length === 1 && /[\uD800-\uDFFF]/.test(point))).toBe(false);
  expect(() => memory.trace(`cursor=${cursor}`, { sessionId: f.sessionId, maxChars: 501 })).toThrow("cursor maxChars is frozen");
  const result = drain(first, { sessionId: f.sessionId });
  expect(result.joined).toBe(f.expected);
  expect(result.pages.every(page => page.length <= 500)).toBe(true);
});

test("mixed continuations stay lossless within both ceilings without naming the split cause", () => {
  const f = raw(`${" ".repeat(600_000)}${"abc123".repeat(20_000)}`);
  const options = { full: true, pageBudget: 8_000, maxChars: 500_000, sessionId: f.sessionId };
  const result = drain(memory.trace(`T${f.turn.id}#E1`, options), options);
  expect(result.joined).toBe(f.expected);
  expect(result.pages.length).toBeGreaterThan(2);
  expect(result.pages.every(page => page.length <= 500_000 && !page.includes("page limited by"))).toBe(true);
});
