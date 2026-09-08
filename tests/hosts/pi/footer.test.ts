// 22a: the footer's reading is the user ruling of 2026-09-07 — applicable current knowledge / facts
// on this branch, and this session's cumulative spend — and refreshing it must cost a status refresh,
// not a walk of the history. These cases pin the displayed numbers against the enumeration they claim
// to be, and pin that a disabled session's callbacks refresh the same footer without loading a single
// Raw payload or rebuilding the path once per fact.
import { afterEach, expect, test } from "vitest";
import { host as createHost } from "./test-host.ts";
import { countPathBuilds, countSourceReads } from "../../perf/fixture.ts";

const disposers: (() => Promise<void>)[] = [];
afterEach(async () => { for (const dispose of disposers.splice(0)) await dispose(); });
function host(...args: Parameters<typeof createHost>) {
  const h = createHost(...args);
  disposers.push(h.dispose);
  return h;
}
const footer = (h: ReturnType<typeof host>) => {
  const status = h.statuses.get("trace-memory") ?? "";
  const parsed = /trace-memory( Disabled)? (\d+)\/(\d+) \$(\d+\.\d{2})$/.exec(status);
  if (!parsed) throw new Error(`unreadable footer: ${status}`);
  return { status, disabled: !!parsed[1], knowledge: Number(parsed[2]), facts: Number(parsed[3]), cost: Number(parsed[4]) };
};

/** Six facts on the current branch, written without a model, so a per-fact rebuild is visible. */
function facts(h: ReturnType<typeof host>, count = 6) {
  const entries = h.memory.store.sourcePath(1, "main", 1);
  const user = entries.find(e => e.role === "user")!;
  const committed = h.memory.store.commitNotingRun({ run: { kind: "noting", sessionId: 1, branch: "main", createdAt: "2026-09-09T00:00:00Z" },
    facts: Array.from({ length: count }, (_, i) => ({ turnId: 1, category: "observation" as const, actor: "user" as const,
      text: `footer fact ${i}`, source: ["T1#user"], createdAt: "2026-09-09T00:00:00Z", entryIds: [user.id] })) });
  if (!committed.ok) throw new Error(committed.problems.join("; "));
  return committed.facts;
}

test("22a: the footer shows the counts the enumeration returns, enabled and disabled alike", async () => {
  const h = host();
  await h.turn();
  facts(h);
  await h.emit("session_start"); // an enabled session refreshes the footer on restore and at run transitions
  const enabled = footer(h);
  expect(enabled.disabled).toBe(false);
  expect(enabled.facts).toBe(h.memory.store.listBranchFacts(1, "main", 1).length);
  expect(enabled.knowledge).toBe(h.memory.store.listCurrentKnowledge({ sessionId: 1, headTurnId: 1 }).length);
  expect(enabled.cost).toBe(Number(h.memory.spend(1).cost.toFixed(2)));
  await h.commands.get("trace")!.handler("disable", h.ctx);
  const disabled = footer(h);
  expect(disabled.disabled).toBe(true);
  expect(disabled.facts).toBe(h.memory.store.listBranchFacts(1, "main", 1).length);
  expect(disabled.knowledge).toBe(h.memory.store.listCurrentKnowledge({ sessionId: 1, headTurnId: 1 }).length);
  expect(h.requests).toEqual([]);
});

test("22a: a disabled session's callbacks refresh the footer without reading history or rebuilding the path per fact", async () => {
  const h = host();
  await h.turn();
  facts(h);
  await h.commands.get("trace")!.handler("disable", h.ctx);
  const turns = h.memory.store.listTurns(1).length;
  const reads = countSourceReads(), builds = countPathBuilds();
  try {
    for (const [event, payload] of [["session_start", {}], ["before_agent_start", { prompt: "hi", systemPrompt: "host" }],
      ["before_provider_request", { payload: { messages: [] } }]] as const) {
      reads.reset(); builds.reset();
      await h.emit(event, payload);
      expect(reads.reads(), `${event} loaded Raw payloads`).toBe(0); // no Raw payload is read to display a count
      expect(builds.builds(), `${event} path builds`).toBeLessThanOrEqual(4); // one membership per counted set, never one per fact
    }
  } finally { reads.restore(); builds.restore(); }
  expect(footer(h).disabled).toBe(true);
  expect(h.requests).toEqual([]); // no model dispatch
  expect(h.memory.store.listTurns(1).length).toBe(turns); // no source reconciliation, all data kept
  expect(h.memory.store.listSessionFacts(1)).toHaveLength(6);
});
