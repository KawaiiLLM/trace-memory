// 79 acceptance: "Raw reads bounded by the budget." Existing coverage (rulings.test.ts) only
// statement-captures a 60-entry path. These tests use a long path and a large backlog (thousands of
// source entries, most of them pending) and count, per consumer: rows hydrated (Store.getSourceEntry
// calls -- the one place a Raw payload row is joined and parsed, tests/perf/fixture.ts's own
// "audit's source reads" counter), against the total backlog size and against what the consumer
// finally emits. In every consumer this ticket bounds, a candidate is hydrated one at a time
// immediately before it is rendered (`renderEntry`/`view` called on the same object the hydration
// just produced, inside the same loop iteration) -- so "rows hydrated" and "renders attempted" are
// the same count by construction here; both are reported below rather than assumed equal.
import { mkdtempSync, copyFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, expect, test } from "vitest";
import { generate, countSourceReads, type Fixture } from "../../perf/fixture.ts";
import { Store } from "../../../src/core/store/index.ts";
import { TraceMemory, type TaskTarget } from "../../../src/core/api/index.ts";
import { notingPending } from "../../../src/core/noting/index.ts";

let dir: string, basePath: string, base: Fixture;

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), "trace-memory-79-budget-"));
  basePath = join(dir, "base.db");
  // Thousands of source entries on one long path, tool-heavy (default 20,000 Raw chars per result),
  // matching the ticket's evidence shape (source_entries rows averaging kilobytes of content/blocks).
  base = generate(basePath, { entries: 3_000, facts: 40, resultChars: 2_000 });
}, 60_000);

afterAll(() => rmSync(dir, { recursive: true, force: true }));

/** A private copy of the base fixture with every entry pending -- the "large backlog" the ticket's
 * evidence table measured on S134 (7,374 pending entries). Copy -> mutate -> hand back a path; the
 * caller is responsible for deleting it (mirrors tests/perf/run.ts's own copy-per-scenario pattern). */
function backlogCopy(name: string): string {
  const copy = join(dir, name);
  rmSync(copy, { force: true });
  copyFileSync(basePath, copy);
  const store = new Store(copy);
  store.db.prepare("DELETE FROM noted_entries").run();
  store.close();
  return copy;
}

const target = (): TaskTarget => ({ sessionId: base.sessionId, branch: base.branch, headTurnId: base.headTurnId });

test("79 item 2: compact's Raw span hydrates a bounded prefix, not the whole path or backlog", () => {
  const copy = backlogCopy("compact.db");
  const memory = TraceMemory(copy, async () => { throw new Error("no model in this test"); },
    { compaction: { rawTokens: 5_000, factsTokens: 100, sharedAllowanceTokens: 100 } });
  const counter = countSourceReads();
  try {
    const pendingTotal = memory.pendingEntries(base.sessionId, base.branch, base.headTurnId).length;
    expect(pendingTotal).toBeGreaterThan(2_000); // this is the "large backlog" case, not the 60-entry one
    counter.reset();
    const result = memory.compact(base.sessionId, base.branch, base.headTurnId, []);
    const hydrated = counter.reads(); // == renders attempted: view(entry) runs once per hydrated candidate, same loop iteration
    if ("native" in result) throw new Error(result.reason);
    const emitted = result.supplied.entries.length;
    expect(emitted).toBeGreaterThan(0);
    expect(hydrated).toBeGreaterThan(0);
    // Bounded by the 5,000-token Raw budget, not by the 3,000+ entry path/backlog: at most a small
    // multiple of what the budget can hold, and nothing close to the full path.
    expect(hydrated).toBeLessThan(base.entryCount / 10);
    expect(hydrated).toBeLessThan(100);
    expect(emitted).toBeLessThanOrEqual(hydrated); // never emits an entry it did not hydrate+render
    expect(result.truncated?.raw?.entries).toBeGreaterThan(0); // most of the backlog stayed unread, not just unrendered
  } finally { memory.close(); counter.restore(); rmSync(copy, { force: true }); }
});

test("79 item 2: the Noting freeze hydrates only its own oldest-first batch, not the whole pending set", () => {
  const copy = backlogCopy("noting-freeze.db");
  const memory = TraceMemory(copy, async () => { throw new Error("no model in this test"); },
    { noting: { batchTokens: 3_000 } });
  const counter = countSourceReads();
  try {
    const pendingTotal = memory.pendingEntries(base.sessionId, base.branch, base.headTurnId).length;
    counter.reset();
    const entries = memory.notingBatch(target());
    const hydrated = counter.reads();
    expect(entries.length).toBeGreaterThan(0);
    expect(entries.length).toBeLessThan(pendingTotal); // did not take the whole backlog
    expect(hydrated).toBeGreaterThanOrEqual(entries.length); // hydrated at least what it kept
    expect(hydrated).toBeLessThan(pendingTotal / 5); // and nothing close to the whole backlog
    expect(hydrated).toBeLessThan(150);
  } finally { memory.close(); counter.restore(); rmSync(copy, { force: true }); }
});

test("79 item 2: the branchSummary carry hydrates only its newest-suffix budget, not the whole pending set", () => {
  const copy = backlogCopy("branch-summary.db");
  const memory = TraceMemory(copy, async () => { throw new Error("no model in this test"); },
    { render: { episodicBlockTokens: 4_000 } });
  const counter = countSourceReads();
  try {
    const pendingTotal = memory.pendingEntries(base.sessionId, base.branch, base.headTurnId).length;
    counter.reset();
    const summary = memory.branchSummary(base.sessionId, base.branch, base.headTurnId);
    const hydrated = counter.reads();
    expect(summary.length).toBeGreaterThan(0);
    expect(summary).toContain("earlier pending entries omitted from the carry budget");
    expect(hydrated).toBeGreaterThan(0);
    expect(hydrated).toBeLessThan(pendingTotal / 5);
    expect(hydrated).toBeLessThan(100);
  } finally { memory.close(); counter.restore(); rmSync(copy, { force: true }); }
});

test("79 item 2: the Noting due check hydrates only up to the entry that reaches the trigger threshold", () => {
  const copy = backlogCopy("noting-due.db");
  const memory = TraceMemory(copy, async () => { throw new Error("no model in this test"); },
    { noting: { triggerTokens: 500 } }); // small: reached long before the ~3,000-entry backlog is exhausted
  const counter = countSourceReads();
  try {
    const pendingTotal = memory.pendingEntries(base.sessionId, base.branch, base.headTurnId).length;
    counter.reset();
    const eligibility = memory.taskEligibility("noting", target());
    const hydrated = counter.reads();
    expect(eligibility.due).toBe(true);
    expect(hydrated).toBeGreaterThan(0);
    expect(hydrated).toBeLessThan(pendingTotal / 10); // stopped at threshold, not at the end of the backlog
    expect(hydrated).toBeLessThan(50);
  } finally { memory.close(); counter.restore(); rmSync(copy, { force: true }); }
});

test("79 item 2: the Noting due check with an impossibly high threshold still hydrates the whole set only once, never past it", () => {
  // A dedicated, deliberately small fixture (not the 3,000-entry/20 KB-Raw backlog): this case prices
  // the entire pending set (the never-due upper bound the ticket allows), and the cumulative join
  // `notingViews` sizes against is quadratic in the rendered text it has priced so far, so pricing it
  // at the large-backlog fixture's realistic content size would only be restating that same allowance
  // at a slower wall-clock, not testing anything the bounded cases above do not already cover.
  const copy = join(dir, "noting-due-all.db");
  rmSync(copy, { force: true });
  const memory = TraceMemory(copy, async () => { throw new Error("no model in this test"); },
    { noting: { triggerTokens: 1_000_000_000 } });
  try {
    const project = memory.store.createProject({ name: "due-all", declaredBy: "mark" });
    const session = memory.store.createSession({ enrollmentChoice: true, host: "fixture", projectId: project.id, startedAt: "t", firstReplyAt: "t" });
    let parent: number | null = null;
    const ids: number[] = [];
    for (let i = 0; i < 300; i++) {
      const turn = memory.store.appendTurn({ sessionId: session.id, parentTurnId: parent, kind: "turn", startedAt: "t", userPrompt: `q${i}` });
      const entry = memory.appendEntry({ sessionId: session.id, nativeLineage: "fx", nativeId: `m${i}`, turnId: turn.id,
        role: "user", text: `entry ${i} ${"word ".repeat(20)}`, raw: `raw ${i}`, calls: [] });
      ids.push(entry.id); parent = turn.id;
    }
    memory.selectEntries(session.id, "main", ids);
    const t = { sessionId: session.id, branch: "main", headTurnId: parent! };
    const pendingTotal = memory.pendingEntries(t.sessionId, t.branch, t.headTurnId).length;
    const counter = countSourceReads();
    counter.reset();
    const eligibility = memory.taskEligibility("noting", t);
    const hydrated = counter.reads();
    counter.restore();
    expect(eligibility.due).toBe(false); // never reached; the whole backlog was priced once
    expect(hydrated).toBe(pendingTotal); // metadata traversal (not Raw's own budget) may grow with the path -- ticket's own caveat
  } finally { memory.close(); rmSync(copy, { force: true }); }
});

test("79 item 2: the claim's pending check hydrates nothing on a large backlog", () => {
  const copy = backlogCopy("claim.db");
  const store = new Store(copy);
  const counter = countSourceReads();
  try {
    expect(store.pendingEntries(base.sessionId, base.branch, base.headTurnId).length).toBeGreaterThan(2_000);
    counter.reset();
    const claim = store.acquireClaim(target(), "noting", "executor-79-test");
    expect(claim).not.toBeNull();
    expect(counter.reads()).toBe(0);
  } finally { store.close(); counter.restore(); rmSync(copy, { force: true }); }
});

test("79 item 2: admission's boundary check (notingPending) hydrates nothing on a large backlog", () => {
  const copy = backlogCopy("boundary.db");
  const store = new Store(copy);
  const counter = countSourceReads();
  try {
    const all = store.pendingEntries(base.sessionId, base.branch, base.headTurnId);
    expect(all.length).toBeGreaterThan(2_000);
    counter.reset();
    // No `pendingAll` supplied: this is the same call admission makes inside index.ts's `execute`,
    // reading this exact session/branch/head's pending set itself before filtering by the boundary.
    const { pending } = notingPending(store, { ...target(), boundary: { maxEntryId: all[Math.floor(all.length / 2)]!.id } });
    expect(pending.length).toBeGreaterThan(0);
    expect(pending.length).toBeLessThan(all.length);
    expect(counter.reads()).toBe(0);
  } finally { store.close(); counter.restore(); rmSync(copy, { force: true }); }
});

test("79 item 2: the closed-session scan hydrates nothing across multiple closed sessions with large backlogs", () => {
  const copy = join(dir, "closed-scan.db");
  rmSync(copy, { force: true });
  const store = new Store(copy);
  const counter = countSourceReads();
  try {
    const project = store.createProject({ name: "closed-scan", declaredBy: "mark" });
    const executor = store.createSession({ enrollmentChoice: true, host: "fixture", projectId: project.id, startedAt: "t", firstReplyAt: "t" });
    for (let s = 0; s < 3; s++) {
      const closed = store.createSession({ enrollmentChoice: true, host: "fixture", projectId: project.id, startedAt: "t", firstReplyAt: "t" });
      let parent: number | null = null, last = 0;
      const ids: number[] = [];
      for (let i = 0; i < 800; i++) { // several thousand pending rows across three closed sessions
        const turn = store.appendTurn({ sessionId: closed.id, parentTurnId: parent, kind: "turn", startedAt: "t", userPrompt: `q${i}` });
        const entry = store.appendSourceEntry({ sessionId: closed.id, nativeLineage: "fx", nativeId: `m${i}`, turnId: turn.id,
          role: "user", text: `entry ${i} ${"word ".repeat(50)}`, raw: `raw ${i}`, calls: [] });
        ids.push(entry.id); parent = turn.id; last = turn.id;
      }
      store.selectSourcePath(closed.id, "main", ids);
      store.closeSession(closed.id);
      void last;
    }
    counter.reset();
    const targets = store.closedTasks("noting", executor.id, "project");
    expect(targets.length).toBe(3);
    expect(counter.reads()).toBe(0);
  } finally { store.close(); counter.restore(); rmSync(copy, { force: true }); }
}, 20_000); // 2,400 synchronous inserts across 3 sessions; comfortably under 1 s unloaded, but the
// suite lock guarantees exclusivity, not an idle machine -- widened past vitest's 5 s default so a
// contended host doesn't flake here.

test("79 item 1 at scale: sourcePath, pendingEntries and listSourceEntries hydrate nothing on a thousands-entry path", () => {
  const copy = backlogCopy("list-scale.db");
  const store = new Store(copy);
  const counter = countSourceReads();
  try {
    counter.reset();
    expect(store.sourcePath(base.sessionId, base.branch, base.headTurnId).length).toBeGreaterThan(2_000);
    expect(store.pendingEntries(base.sessionId, base.branch, base.headTurnId).length).toBeGreaterThan(2_000);
    expect(store.listSourceEntries(base.sessionId).length).toBeGreaterThan(2_000);
    expect(counter.reads()).toBe(0);
  } finally { store.close(); counter.restore(); rmSync(copy, { force: true }); }
});
