// 22c: an explicit read does the work the caller asked for. A full internal Turn renderer obtains
// its native occurrences once and reuses them across its tool ordinals. Nothing here changes what the
// reads print.
import { afterEach, beforeEach, expect, test } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { sourceSeededMemory, memoryFiles } from "../../source-fixture.ts";
import { countSourceReads } from "../../perf/fixture.ts";
import { curateNow, versionRef } from "../../support/dreamer.ts";
import { block } from "../../support/workspace.ts";

const time = "2026-09-09T00:00:00Z";

let dir: string, dbPath: string, memory: ReturnType<typeof sourceSeededMemory>;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "trace-memory-22c-"));
  dbPath = join(dir, "trace.db");
  memory = sourceSeededMemory(dbPath, async () => { throw new Error("these cases call no model"); });
});
afterEach(() => { memory.close(); rmSync(dir, { recursive: true, force: true }); });

/** A session of `turns` Turns; the middle one carries `calls` tool calls and a second native result
 * occurrence of its first call — the shape a full trace must render as two entries (23c: the
 * `multiple results` merge is gone; each native occurrence is its own entry, as the assembled read
 * already showed it). */
function conversation(turns: number, calls: number) {
  const store = memory.store;
  const projectId = store.createProject({ name: `p${turns}x${calls}`, declaredBy: "marker" }).id;
  const session = store.createSession({ enrollmentChoice: true, host: "fake", startedAt: time, firstReplyAt: time, projectId });
  let parent: number | null = null, heavy = 0;
  for (let i = 0; i < turns; i++) {
    const turn = store.appendTurn({ sessionId: session.id, parentTurnId: parent, kind: "turn", userPrompt: `prompt ${i}`, startedAt: time });
    const many = i === Math.floor(turns / 2);
    for (let n = 0; n < (many ? calls : 1); n++) {
      store.appendToolCall({ turnId: turn.id, name: "read", input: `{"n":${n}}`, result: `result ${i}.${n}`, status: "success" });
    }
    store.updateTurn(turn.id, { assistantText: `answer ${i}`, endedAt: time });
    if (many) {
      heavy = turn.id;
      const first = store.listToolCalls(turn.id)[0]!;
      const calls = [{ ordinal: first.ordinal, name: first.name, callId: `call-${first.id}`, result: "the second occurrence", status: "success" }];
      memory.appendEntry({ sessionId: session.id, nativeLineage: "fixture", nativeId: `retry-${turn.id}`, turnId: turn.id,
        role: "toolResult", text: "", raw: JSON.stringify({ role: "toolResult", text: "", calls }), calls });
    }
    parent = turn.id;
  }
  return { sessionId: session.id, heavy, headTurnId: parent! };
}

test("22c: a full trace obtains the Turn's occurrences once, whatever the session's length", () => {
  const short = conversation(6, 12), long = conversation(24, 12);
  const counter = countSourceReads();
  const reads = (session: typeof short) => {
    counter.reset();
    const text = memory.trace(`T${session.heavy}`, { full: true });
    return { reads: counter.reads(), text };
  };
  try {
    const a = reads(short), b = reads(long);
    // The Turn's own entries decide the cost: four times the session is the same read count.
    expect(b.reads).toBe(a.reads);
    const entries = memory.store.listSourceEntries(long.sessionId).filter(e => e.turnId === long.heavy).length;
    expect(a.reads).toBeLessThanOrEqual(entries);
    // Ordinal 1 has two native result occurrences; the selected call renders both, in entry order.
    expect(b.text).toContain(`[T${long.heavy}#E3@observation] read success: result 12.0`);
    expect(b.text.indexOf("result 12.0")).toBeGreaterThan(-1);
    expect(b.text.indexOf("the second occurrence")).toBeGreaterThan(b.text.indexOf("result 12.0"));
    // Whole-entry full includes every call and result; no call is selected or silently sealed.
    for (let ordinal = 2; ordinal <= 12; ordinal++) expect(b.text).toContain(`#E${ordinal * 2}@assistant`);
    expect(b.text).toContain("result 12.11");
    // 23b assembles the read without `full` from the same Turn-scoped occurrences, at the same cost,
    // and shows each of them in entry order instead of merging them into one call's evidence.
    counter.reset();
    const assembled = memory.trace(`T${long.heavy}`);
    expect(counter.reads()).toBe(a.reads);
    expect(assembled.indexOf("result 12.0")).toBeGreaterThan(-1);
    expect(assembled.indexOf("the second occurrence")).toBeGreaterThan(assembled.indexOf("result 12.0"));
    // Each call is readable by its own entry, without a call selector or sibling result.
    for (let ordinal = 1; ordinal <= 12; ordinal++) {
      counter.reset();
      expect(memory.trace(`T${long.heavy}#E${ordinal * 2}`, { full: true })).toContain(`#E${ordinal * 2}@assistant] read(`);
      expect(counter.reads()).toBeLessThanOrEqual(a.reads);
    }
  } finally { counter.restore(); }
});

/** `knowledge` commits, each with `revisions` commits on this path: one create and its updates, so
 * every commit but the last of a chain is historical. All of them match one literal query. */
function knowledgeCorpus(knowledge: number, revisions: number) {
  const store = memory.store, { sessionId, headTurnId } = conversation(3, 1);
  const path = { sessionId, branch: "main", headTurnId };
  store.selectSourcePath(sessionId, "main", store.listSourceEntries(sessionId).map(e => e.id));
  const entries = store.listSourceEntries(sessionId);
  const cited = store.hydrateSourceEntries(entries.map(e => e.id)).find(e => e.turnId === headTurnId && e.role === "user")!;
  const noted = store.commitNotingRun({ run: { kind: "noting", sessionId, branch: "main", createdAt: time },
    facts: [{ turnId: headTurnId, category: "observation", actor: "user", text: "evidence", source: [`T${headTurnId}#user`], entryIds: [cited.id], createdAt: time }],
    entryIds: entries.map(e => e.id) });
  if (!noted.ok) throw new Error(noted.problems.join("; "));
  const supports = [noted.facts[0]!.id];
  const tips: { knowledgeId: number; commit: number }[] = [];
  for (let i = 0; i < knowledge; i++) {
    const run = { kind: "manual" as const, sessionId, branch: "main", createdAt: time };
    const created = store.commitConsolidationRun({ path, run, operations: [{ op: "create", title: "Fixture title", handle: `h${i}`, author: "fake",
      text: `SEARCHNEEDLE conclusion ${i}`, category: "understanding", scope: "session", supports, reason: "corpus", topics: [], createdAt: time }] });
    if (!created.ok) throw new Error(created.problems.join("; "));
    tips.push({ knowledgeId: created.committed[0]!.knowledgeId, commit: created.committed[0]!.commit });
  }
  // One round of updates per revision: a curate file holds one record per item.
  for (let j = 1; j < revisions; j++) {
    curateNow(memory, path, tips.map((tip, i) => block(`update ${versionRef(store, tip.knowledgeId, tip.commit)}`, { reason: "corpus" },
      `SEARCHNEEDLE conclusion ${i} revision ${j}`)).join("\n"));
    for (const tip of tips) tip.commit = store.currentCommit(tip.knowledgeId, path)[0]!.id;
  }
  return { sessionId, headTurnId, path, supports, tips, query: "SEARCHNEEDLE" };
}

test("a continuation nobody comes back for is dropped: sixteen are outstanding at once, the oldest expires", async () => {
  const corpus = knowledgeCorpus(4, 3);
  const options = { sessionId: corpus.sessionId, headTurnId: corpus.headTurnId, cap: 1 };
  const targets = corpus.tips.map(tip => `K${tip.knowledgeId}`).join(",");
  const cursorOf = (page: string) => /cursor=(\S+)/.exec(page)![1]!;
  // Asking for page one and never asking for page two is ordinary use, so a remainder is a cache
  // entry with a bound, not an obligation held for the process's lifetime.
  const abandoned = cursorOf(memory.trace(targets, options));
  let newest = abandoned;
  for (let i = 0; i < 16; i++) newest = cursorOf(memory.trace(targets, options));
  // The sixteen newest remainders are all still answerable; the seventeenth-oldest is gone, and it
  // is gone through the failure contract an unknown cursor already had.
  expect(memory.trace(`cursor=${newest}`, options)).toContain("[K");
  expect(() => memory.trace(`cursor=${abandoned}`, options)).toThrow("unknown or expired cursor");
});
