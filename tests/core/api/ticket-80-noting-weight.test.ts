// Ticket 80 item 1 "Noting's pending weight, without re-rendering": a rendered entry view is
// immutable and cached once per process, the running joined total is tokenized incrementally (never
// re-scanning the whole growing prefix), and the early stop is kept exactly — a due check renders
// only up to the entry that crosses the threshold, never the rest of the backlog.
import { expect, test, vi } from "vitest";
import * as render from "../../../src/core/render/index.ts";
import { sourceSeededMemory } from "../../source-fixture.ts";

function seeded(entries: number, wordsPerEntry = 40) {
  const memory = sourceSeededMemory(":memory:", vi.fn());
  const store = memory.store, project = store.createProject({ name: "A", declaredBy: "mark" });
  const session = store.createSession({ host: "test", enrollmentChoice: true, projectId: project.id, startedAt: "now", firstReplyAt: "now" });
  let parentTurnId: number | undefined;
  let turn!: ReturnType<typeof store.appendTurn>;
  for (let i = 0; i < entries; i++) {
    turn = store.appendTurn({ sessionId: session.id, parentTurnId, kind: "turn",
      userPrompt: `entry ${i} ` + "word ".repeat(wordsPerEntry), startedAt: "now" });
    parentTurnId = turn.id;
  }
  const target = { sessionId: session.id, branch: "main", headTurnId: turn.id };
  return { memory, store, session, target };
}

test("a repeated due check renders only entries it has not counted before", () => {
  const { memory, target } = seeded(60);
  try {
    memory.config.noting.triggerTokens = 1_000_000; // never due: force a full scan every call
    const rendered = vi.spyOn(render, "renderEntry");
    expect(memory.taskEligibility("noting", target).due).toBe(false);
    const first = rendered.mock.calls.length;
    expect(first).toBeGreaterThan(0);
    rendered.mockClear();
    expect(memory.taskEligibility("noting", target).due).toBe(false);
    expect(rendered).not.toHaveBeenCalled(); // every entry already cached
    rendered.mockClear();
    expect(memory.pendingTokens("noting", target).tokens).toBeGreaterThan(0);
    expect(rendered).not.toHaveBeenCalled(); // pendingTokens reuses the same cache
    rendered.mockRestore();
  } finally { memory.close(); }
});

test("noting an entry drops its cached view, so a later re-render (if it were ever pending again) is not stale", () => {
  const { memory, store, session, target } = seeded(3);
  try {
    memory.config.noting.triggerTokens = 1_000_000;
    expect(memory.taskEligibility("noting", target).due).toBe(false); // populates the cache
    const pending = store.pendingEntryIds(session.id, "main", target.headTurnId);
    const noted = store.commitNotingRun({ run: { kind: "manual", sessionId: session.id, createdAt: "now" }, entryIds: [pending[0]!],
      facts: [{ turnId: store.getSourceEntry(pending[0]!)!.turnId, entryIds: [pending[0]!], category: "observation",
        actor: "user", text: "a fact", source: [`T${store.getSourceEntry(pending[0]!)!.turnId}#E1`], createdAt: "now" }] });
    if (!noted.ok) throw new Error(noted.problems.join("; "));
    const rendered = vi.spyOn(render, "renderEntry");
    expect(memory.pendingTokens("noting", target).tokens).toBeGreaterThan(0);
    // Only the still-pending entries render; the noted one is gone from the cache and from the answer.
    expect(rendered.mock.calls.map(call => call[0].id)).not.toContain(pending[0]);
    rendered.mockRestore();
  } finally { memory.close(); }
});

test("early stop: a cold due check against a large backlog renders only up to the crossing entry", () => {
  const { memory, target } = seeded(400, 60);
  try {
    memory.config.noting.triggerTokens = 500; // small, crossed well before the whole backlog
    const rendered = vi.spyOn(render, "renderEntry");
    expect(memory.taskEligibility("noting", target).due).toBe(true);
    expect(rendered.mock.calls.length).toBeLessThan(20); // nowhere near the full 400-entry backlog
    expect(rendered.mock.calls.length).toBeGreaterThan(0);
    rendered.mockRestore();
  } finally { memory.close(); }
});

test("no quadratic re-tokenization: tokens() is called at most once per rendered/joined piece, not per growing prefix", () => {
  const { memory, target } = seeded(200, 30);
  try {
    memory.config.noting.triggerTokens = 1_000_000; // force a full scan
    const tokenCalls = vi.spyOn(render, "tokens");
    expect(memory.taskEligibility("noting", target).due).toBe(false);
    // A quadratic retokenization of the growing joined string would call tokens() once per entry with
    // an argument whose length grows every time (O(n) calls each O(n) work). Bound the call count by a
    // small multiple of the entry count instead of letting it explode with backlog size.
    expect(tokenCalls.mock.calls.length).toBeLessThan(200 * 3);
    tokenCalls.mockRestore();
  } finally { memory.close(); }
});

test("pendingTokens(\"noting\") matches tokens(joined) exactly, cache or no cache", () => {
  const { memory, target } = seeded(25);
  try {
    const before = memory.pendingTokens("noting", target).tokens;
    // Repeat reads (cache warm) give the identical answer.
    expect(memory.pendingTokens("noting", target).tokens).toBe(before);
    expect(memory.taskEligibility("noting", { ...target, headTurnId: target.headTurnId }).due)
      .toBe(before! >= memory.config.noting.triggerTokens);
  } finally { memory.close(); }
});
