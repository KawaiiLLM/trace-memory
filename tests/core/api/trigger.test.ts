import { expect, test } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { TraceMemory, renderEntry, tokens, type NotingAgentInput } from "../../../src/core/api/index.ts";
import { countSourceReads } from "../../perf/fixture.ts";

// Ticket 22b, "Trigger accounting": the Noting trigger decides that its threshold is reached without
// rendering the whole backlog. The representation is unchanged — one joined string, the batch's own
// separator — so these cases compare the answer against the whole-backlog estimate it replaces, and
// the cost against the size of the backlog.

const BLOCK = "\n\n";
const directories: string[] = [];
const memories: ReturnType<typeof TraceMemory>[] = [];
const target = { sessionId: 1, branch: "main", headTurnId: 0 };
/** A session whose pending backlog is `turns` prompt/reply pairs, and a facade over it per threshold. */
const backlog = (turns: number) => {
  const dir = mkdtempSync(join(tmpdir(), "trace-memory-trigger-"));
  directories.push(dir);
  const dbPath = join(dir, "trace.db");
  const facade = (trigger: number, agent?: Parameters<typeof TraceMemory>[1]) => {
    const memory = TraceMemory(dbPath, agent ?? (async () => { throw new Error("the trigger must not call a model"); }), { noting: { triggerTokens: trigger } });
    memories.push(memory);
    return memory;
  };
  const memory = facade(10_000);
  const store = memory.store;
  const head = store.transaction(() => {
    const projectId = store.createProject({ name: "trigger", declaredBy: "marker" }).id;
    const sessionId = store.createSession({ enrollmentChoice: true, host: "pi:trigger", startedAt: "t", firstReplyAt: "t", projectId }).id;
    let parent: number | null = null, last = 0;
    for (let t = 1; t <= turns; t++) {
      // 23c: the entry view lost its header line, so each entry is smaller; the fixture keeps a
      // backlog comfortably over the 10,000-token default threshold.
      const prompt = `question ${t} ${"word ".repeat(50)}`, answer = `answer ${t} ${"word ".repeat(50)}`;
      const turn = store.appendTurn({ sessionId, parentTurnId: parent, kind: "turn", startedAt: "t", userPrompt: prompt, assistantText: answer });
      for (const [role, text] of [["user", prompt], ["assistant", answer]] as const) {
        store.appendSourceEntry({ sessionId, nativeLineage: "trigger", nativeId: `${role}-${t}`, turnId: turn.id, role, text,
          raw: JSON.stringify({ role, text }), calls: [] });
      }
      parent = turn.id; last = turn.id;
    }
    store.selectSourcePath(sessionId, "main", store.listSourceEntries(sessionId).map(e => e.id));
    return last;
  });
  return { memory, store, facade, head, target: { ...target, headTurnId: head } };
};
const cleanup = () => { for (const m of memories.splice(0)) m.close(); for (const d of directories.splice(0)) rmSync(d, { recursive: true, force: true }); };

test("22b: the trigger fires at the boundary the whole-backlog estimate fired at, and stops there", () => {
  const counter = countSourceReads();
  try {
    const own = backlog(120);
    const views = own.store.pendingEntries(1, "main", own.head).map(e => renderEntry(e, own.memory.config.render).content);
    const whole = tokens(views.join(BLOCK));
    // The entry at which the joined estimate first reaches 10,000 tokens: a known boundary, not a count.
    const crossing = views.findIndex((_view, i) => tokens(views.slice(0, i + 1).join(BLOCK)) >= 10_000);
    expect(crossing).toBeGreaterThan(0); // the fixture crosses inside its own backlog
    expect(whole).toBeGreaterThan(10_000);
    const due = (trigger: number) => {
      counter.reset();
      const answer = own.facade(trigger).taskEligibility("noting", own.target, "subagent").due;
      return { answer, reads: counter.reads() };
    };
    expect(due(10_000).answer).toBe(true);
    expect(due(whole).answer).toBe(true); // the whole backlog exactly reaches it
    expect(due(whole + 1).answer).toBe(false); // and one token more is reached by nothing
    // Exactly the entries the joined prefix needed, and not one more.
    expect(due(tokens(views.slice(0, crossing + 1).join(BLOCK))).reads).toBe(crossing + 1);
    expect(due(tokens(views.slice(0, crossing).join(BLOCK))).reads).toBe(crossing);
    expect(due(whole + 1).reads).toBe(views.length); // an unreachable threshold still reads everything, once
  } finally { counter.restore(); cleanup(); }
});

test("22b: the trigger costs the threshold, not the backlog", () => {
  const counter = countSourceReads();
  try {
    const small = backlog(100), large = backlog(1_000);
    expect(small.store.pendingEntries(1, "main", small.head)).toHaveLength(200);
    expect(large.store.pendingEntries(1, "main", large.head)).toHaveLength(2_000);
    counter.reset();
    expect(small.memory.taskEligibility("noting", small.target, "subagent").due).toBe(true);
    const cheap = counter.reads();
    counter.reset();
    expect(large.memory.taskEligibility("noting", large.target, "subagent").due).toBe(true);
    // Ten times the backlog, the same evidence read: the threshold decides how far the check goes.
    expect(counter.reads()).toBe(cheap);
    expect(cheap).toBeLessThan(200);
  } finally { counter.restore(); cleanup(); }
});

test("22b: stopping at the threshold does not change what the batch selects", async () => {
  try {
    const own = backlog(400);
    const frozen = async (trigger: number) => {
      let entries: { id: number }[] = [];
      const runner = own.facade(trigger, async raw => {
        entries = (raw as NotingAgentInput).material.entries;
        return { outcome: "failure", output: "leave the batch pending", request: {} };
      });
      await runner.noting({ ...own.target, mode: "subagent" });
      return entries.map(e => e.id);
    };
    const atThreshold = await frozen(10_000);
    expect(atThreshold.length).toBeGreaterThan(0);
    expect(await frozen(1)).toEqual(atThreshold); // the batch ceiling selects the batch, not the trigger
  } finally { cleanup(); }
});
