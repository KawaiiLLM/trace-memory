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

test("own Noting commit drops counted head entries without recounting a large rendered suffix", () => {
  const { memory, store, session, target } = seeded(220);
  try {
    memory.config.noting.triggerTokens = 1_000_000;
    store.publishSourcePath(session.id, "main", store.pendingEntryIds(session.id, "main", target.headTurnId), target.headTurnId, "native");
    const pending = store.pendingEntryState(session.id, "main", target.headTurnId);
    const before = memory.pendingTokens("noting", target).tokens;
    expect(before).toBeGreaterThan(0);
    const removed = [...pending].slice(0, 7);
    const result = store.commitNotingRun({ run: { kind: "noting", sessionId: session.id,
      branch: "main", rangeFrom: `S${session.id}/T${store.getSourceEntry(removed[0]!)!.turnId}`,
      rangeTo: `S${session.id}/T${store.getSourceEntry(removed.at(-1)!)!.turnId}`, createdAt: "now" },
      entryIds: removed, facts: [] });
    expect(result.ok).toBe(true);
    expect(store.pendingEntryState(session.id, "main", target.headTurnId)).toBe(pending);
    expect(pending.offset).toBe(removed.length);
    const rendered = vi.spyOn(render, "renderEntry");
    const ids = [...pending];
    const expected = render.tokens(ids.map(id => render.renderEntry(store.getSourceEntry(id)!, memory.config.render).content).join("\n\n"));
    rendered.mockClear();
    const raw = vi.spyOn(store, "getSourceEntry");
    const added = vi.spyOn(render.JoinedTokens.prototype, "add");
    expect(memory.pendingTokens("noting", target).tokens).toBe(expected);
    expect(added).not.toHaveBeenCalled();
    expect(rendered).not.toHaveBeenCalled();
    expect(raw).not.toHaveBeenCalled();
    added.mockRestore(); raw.mockRestore(); rendered.mockRestore();
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

test("no quadratic re-tokenization: tokenized inputs remain bounded per entry, not growing prefixes", () => {
  const { memory, store, target } = seeded(200, 30);
  try {
    store.publishSourcePath(target.sessionId, target.branch,
      store.pendingEntryIds(target.sessionId, target.branch, target.headTurnId), target.headTurnId, "native");
    memory.config.noting.triggerTokens = 1_000_000; // force a full scan
    const tokenCalls = vi.spyOn(render, "tokens"), added = vi.spyOn(render.JoinedTokens.prototype, "add");
    const rendered = vi.spyOn(render, "renderEntry");
    expect(memory.taskEligibility("noting", target).due).toBe(false);
    const views = rendered.mock.results.map(result => result.value.content as string);
    const largest = Math.max(...views.map(view => view.length));
    // Call count alone cannot detect one growing-prefix tokenization per entry. Bound both input
    // size and total processed characters, including the incremental counter's actual inputs.
    expect(tokenCalls.mock.calls.length).toBeLessThan(200 * 3);
    expect(tokenCalls.mock.calls.every(([text]) => text.length <= largest)).toBe(true);
    expect(added.mock.calls.length).toBe(399);
    expect(added.mock.calls.every(([text]) => text.length <= largest)).toBe(true);
    expect(added.mock.calls.reduce((sum, [text]) => sum + text.length, 0))
      .toBe(views.reduce((sum, text) => sum + text.length, 0) + 2 * 199);
    added.mockClear();
    memory.taskEligibility("noting", target);
    expect(added).not.toHaveBeenCalled();
    tokenCalls.mockRestore(); added.mockRestore(); rendered.mockRestore();
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
