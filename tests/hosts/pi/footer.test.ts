// Ticket 24a "Footer counts and indicator" (parent 24, sections "Footer counts and cost" and
// "Indicator semantics"). The enabled footer is
//
//     🧠 <indicator> notes: <pending entries>-><applicable facts> memory: <changed current Knowledge>/<current Knowledge> cost: $<today, every session>
//
// The off footer is the compact `🧠 ○ off`. These
// cases pin what each number means on a synthetic branch, that work stays pending until its business
// commit, that the indicator is one Pi theme role per running phase (51) while routine text stays dim,
// and that a refresh loads no Raw, rendered Knowledge or run audit body and builds one path snapshot.
import { afterEach, expect, test, vi } from "vitest";
import { host as createHost, reply, notingFact, noteHeld, type Reply } from "./test-host.ts";
import { readHandle } from "../../read-handle-fixture.ts";
import { createDreamerTrigger } from "../../admitted-dreamer-scenario.ts";
import { countPathBuilds, countRunBodies, countSourceReads } from "../../perf/fixture.ts";
import * as rendering from "../../../src/core/render/index.ts";
import { Store } from "../../../src/core/store/index.ts";
import { fact, knowledge, knowledgeBatch, legacyFacts } from "../../support/seed.ts";

const disposers: (() => Promise<void>)[] = [];
afterEach(async () => { for (const dispose of disposers.splice(0)) await dispose(); });
function host(...args: Parameters<typeof createHost>) {
  const h = createHost(...args);
  disposers.push(h.dispose);
  return h;
}
type Host = ReturnType<typeof host>;
const quiet = { "noting.triggerTokens": 1_000_000_000 };
const time = "2026-09-09T00:00:00Z";

const raw = (h: Host) => h.statuses.get("trace-memory") ?? "";
/** The footer as its reader sees it: theme role, glyph and count strings, preserving unknown `?`. */
const footer = (h: Host) => {
  const status = raw(h);
  const parsed = /^🧠 (?:<(\w+)>)?([●○])(?:<\/\w+>)? (?:<dim>)?notes: (\S+)->(\S+) memory: (\S+)\/(\S+) cost: \$(\S+?)(?:<\/dim>)?$/.exec(status);
  if (!parsed) throw new Error(`unreadable footer: ${status}`);
  return { status, role: parsed[1], glyph: parsed[2]!, entries: parsed[3]!, facts: parsed[4]!,
    changedKnowledge: parsed[5]!, knowledge: parsed[6]!, cost: parsed[7]! };
};
/** Independently enumerate the same selected units; exact processed state is checked per version only
 * in this test oracle, while production uses one bounded lookup. */
const enumerated = (h: Host, branch = "main") => {
  const head = h.memory.store.knowledgePath(1, branch).headTurnId!;
  const knowledge = h.memory.store.currentKnowledge(h.memory.store.knowledgePath(1, branch, head));
  const processed = h.memory.store.processedCurrentVersions(knowledge);
  return { entries: String(h.memory.pendingEntries(1, branch, head).length),
    facts: String(h.memory.store.listBranchFacts(1, branch, head).length),
    changedKnowledge: String(knowledge.length - processed.size), knowledge: String(knowledge.length),
    cost: h.memory.spendSince(midnight()).toFixed(2) };
};
/** An existing refresh point, not a new one: `agent_end` is the boundary at which this turn's
 * evidence became importable. */
const refresh = (h: Host) => h.emit("agent_end");

/** Facts on the current branch, written without a model and without taking any entry, so the pending
 * entry count is untouched and a per-fact rebuild would be visible. */
function facts(h: Host, count = 3) {
  const store = h.memory.store;
  const source = store.sourcePath(1, "main", 1).find(value => store.getSourceEntry(value.id)?.role === "user")!;
  // A single noting run is essential here: later assertions distinguish run count from fact count.
  return legacyFacts(store, { kind: "noting", sessionId: 1, branch: "main", createdAt: time },
    Array.from({ length: count }, (_, i) => ({ sources: [{ entry: source, address: `T1#E${source.entryOrdinal}` }],
      category: "observation" as const, actor: "user" as const, text: `footer fact ${i}`, createdAt: time }))).facts;
}
function processPool(h: Host, pool: string, createdAt = time, response?: string) {
  const store = h.memory.store, current = store.knowledgePath(1, "main");
  const path = { sessionId: 1, branch: "main", headTurnId: current.headTurnId! };
  const claim = store.acquireClaim(path, "dreaming", "footer-test");
  if (!claim) throw new Error("dreaming claim unavailable");
  const range = store.retainKnowledgePoolRange(path, pool, claim);
  const executionId = store.beginExecution({ sessionId: 1, phase: "dreaming", head: range.anchor, origin: range.origin });
  const run = store.bindDreamingRun({ kind: "dreaming", sessionId: 1, branch: "main", dreamingRangeId: range.id,
    executionId, claim, createdAt, response });
  store.completeKnowledgePoolRange(run, "success");
  store.releaseClaim(claim);
}
/** Local midnight as the UTC instant the footer compares `runs.created_at` against (51). */
const midnight = (now = new Date()) => new Date(now.getFullYear(), now.getMonth(), now.getDate()).toISOString();
/** One synthetic run with an observed usage, charged to `sessionId` and executed by `executor`. */
function priced(h: Host, sessionId: number, executorSessionId: number, cost: number, createdAt = time) {
  const committed = h.memory.store.commitNotingRun({ run: { kind: "noting", sessionId, executorSessionId, branch: "main", createdAt,
    response: JSON.stringify({ usage: { input: 10, output: 5, cacheRead: 0, cacheWrite: 0, cost: { total: cost } } }) }, facts: [] });
  if (!committed.ok) throw new Error(committed.problems.join("; "));
}

test("footer reports pending Raw, applicable facts, changed Knowledge, and historical C spend", async () => {
  const h = host(quiet);
  await h.turn(); // one Turn, two source entries, nothing noted and nothing extracted
  expect(footer(h)).toMatchObject({ ...enumerated(h), glyph: "○", role: "dim" });
  expect(footer(h)).toMatchObject({ glyph: "○", role: "dim", entries: "2", facts: "0", changedKnowledge: "0", knowledge: "0", cost: "0.00" });

  const written = facts(h, 3);
  await refresh(h);
  expect(footer(h)).toMatchObject({ entries: "2", facts: "3", changedKnowledge: "0", knowledge: "0", cost: "0.00" }); // committed facts are immediately eligible
  expect(footer(h)).toMatchObject(enumerated(h));

  // Knowledge cites a fact without hiding the fact.
  knowledge(h.memory.store, h.memory.store.knowledgePath(1, "main", 1), "session", "constraint",
    [written[0]!.id], "Use pnpm, never npm", { run: { kind: "manual", createdAt: time } });
  await refresh(h);
  expect(footer(h)).toMatchObject({ entries: "2", facts: "3", changedKnowledge: "1", knowledge: "1", cost: "0.00" });
  processPool(h, `session:${h.memory.store.getSession(1)!.id}`);
  await refresh(h);
  // R1FINAL does not falsely protect an untouched input when a synthetic run commits no output.
  expect(footer(h)).toMatchObject({ entries: "2", facts: "3", changedKnowledge: "1", knowledge: "1", cost: "0.00" });

  // N's Raw progress is independent of D's Knowledge processing and historical fact rows.
  const noted = h.memory.store.commitNotingRun({ run: { kind: "noting", sessionId: 1, branch: "main", createdAt: time },
    facts: [], entryIds: h.memory.store.sourcePath(1, "main", 1).map(e => e.id) });
  expect(noted.ok).toBe(true);
  await refresh(h);
  expect(footer(h)).toMatchObject({ entries: "0", facts: "3", changedKnowledge: "1", knowledge: "1", cost: "0.00" });
  expect(footer(h)).toMatchObject(enumerated(h));

  // 51: the footer's cost is today's spend across the whole database — another session's run made
  // after local midnight counts, this session's run made before it does not — while `spend(session)`
  // keeps each session's cumulative figure for Current session.
  const today = new Date(new Date(midnight()).getTime() + 60_000).toISOString();
  const yesterday = new Date(new Date(midnight()).getTime() - 60_000).toISOString();
  priced(h, 1, 2, 0.12, yesterday);
  const borrowed = h.memory.store.createSession({ host: "pi:other", startedAt: time, firstReplyAt: time, projectId: 1, enrollmentChoice: true });
  priced(h, borrowed.id, 1, 9.99, today);
  priced(h, 1, 1, 0.25, today);
  h.memory.store.recordRun({ kind: "consolidation", sessionId: 1, branch: "main", outcome: "success", createdAt: today,
    response: JSON.stringify({ usage: { input: 2, output: 1, cacheRead: 0, cacheWrite: 0, cost: { total: 0.33 } } }) });
  await refresh(h);
  expect(footer(h)).toMatchObject({ ...enumerated(h), cost: "10.57" });
  expect(h.memory.spend(1)).toMatchObject({ cost: 0.70, costs: { noting: 0.37, consolidation: 0.33, dreaming: 0, manual: 0 }, runs: { noting: 4, consolidation: 1 } });
  expect(h.memory.spend(borrowed.id).cost).toBe(9.99);
  // Current session carries the composition; headless `/trace` prints the same body. Create real
  // pending work, then finish it through the current pool facade with observed Dreamer usage.
  knowledge(h.memory.store, h.memory.store.knowledgePath(1, "main", 1), "session", "constraint",
    [written[0]!.id], "priced Dreamer item", { run: { kind: "manual", createdAt: today }, operation: { createdAt: today } });
  processPool(h, "session:1", today,
    JSON.stringify({ usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, cost: { total: 0.5 } } }));
  await h.commands.get("trace")!.handler("", h.ctx);
  const panel = h.notices.at(-1)!;
  expect(panel).toContain("Spend   session $1.20");
  expect(panel).toMatch(/Noting 4 runs \$0\.37 · Consolidation 1 run \$0\.33/);
  expect(panel).toMatch(/Dreaming \d+ runs \$0\.50/);
  expect(panel).toContain("today   $11.07");
  expect(h.requests).toEqual([]); // nothing here called a model
});

test("24a/92: N stays pending through staging, only normal termination moves queues, and failure after staging advances nothing", async () => {
  const h = host({ "noting.triggerTokens": 30, "dreaming.triggerTokens": 1_000_000_000 });
  let release!: (value: Reply) => void;
  h.provider(async () => new Promise(resolve => { release = resolve; }));
  await h.prompt(); await h.answer(); await h.emit("agent_settled"); await h.drain();
  const admitted = footer(h);
  expect(admitted).toMatchObject({ glyph: "●", role: "accent", entries: "2", facts: "0" }); // admitted, not done
  expect(admitted.status).toMatch(/^🧠 <accent>●<\/accent> <dim>notes: .*<\/dim>$/);
  expect(admitted).toMatchObject(enumerated(h));

  h.provider(async c => notingFact(c));
  release(notingFact(h.conversations[0]!)); await h.drain();
  // Held facts and knowledge become visible together only after normal N termination.
  expect(footer(h)).toMatchObject({ glyph: "○", role: "dim", entries: "0", facts: "1", changedKnowledge: "0", knowledge: "0", cost: "0.00" });

  // A run that fails before its commit advances nothing at all.
  h.provider(async () => { throw new Error("offline"); });
  await h.turn(); await h.drain();
  const failed = footer(h);
  expect(failed.role).toBe("dim"); // 51: a failure is reported by the notify, not by the indicator
  expect(failed.status).toMatch(/^🧠 <dim>○<\/dim> <dim>notes: .*<\/dim>$/);
  expect(failed).toMatchObject(enumerated(h));
  expect(Number(failed.entries)).toBeGreaterThan(0); // the new turn's entries stayed pending
  expect(failed.facts).toBe("1");

  // A provider failure after staging publishes no new work; the earlier successful batch survives.
  const pendingBefore = Number(footer(h).entries);
  h.provider(async c => noteHeld(c) ? { ...reply(""), stopReason: "error", errorMessage: "stream reset after staging" } : notingFact(c), { autoStop: false });
  // 29d: no trailing extra reply here. Without the retired delivery pause a small trailing entry no
  // longer joins the previous batch, and would start a further run this case is not about.
  await h.turn(); await h.drain();
  const after = footer(h);
  expect(after.role).toBe("dim"); // the notify carries failure; the idle indicator stays dim (51)
  expect(after.status).toMatch(/^🧠 <dim>○<\/dim> <dim>notes: .*<\/dim>$/);
  expect(Number(after.entries)).toBeGreaterThanOrEqual(pendingBefore);
  expect(Number(after.facts)).toBe(1);
  expect(after).toMatchObject(enumerated(h));
  expect(h.memory.store.listRuns(1).at(-1)!.outcome).toBe("failure");
});

test("24a: a cancelled batch advances nothing, and another connection's commits appear at the next refresh", async () => {
  const h = host({ "noting.triggerTokens": 30, "dreaming.triggerTokens": 1_000_000_000 });
  h.provider(async () => new Promise(() => {}), { ignoreAbort: false }); // never answers
  await h.prompt(); await h.answer(); await h.emit("agent_settled"); await h.drain();
  const running = footer(h);
  expect(running.role).toBe("accent");
  await h.commands.get("trace")!.handler("stop", h.ctx);
  await h.drain();
  expect(footer(h)).toMatchObject({ entries: running.entries, facts: running.facts, changedKnowledge: running.changedKnowledge });
  expect(h.memory.store.listSessionFacts(1)).toEqual([]);

  // A second connection (the test's own observer façade) commits; the next refresh shows it, because
  // every refresh re-reads and nothing is cached between them.
  const before = footer(h).facts;
  facts(h, 2);
  expect(footer(h).facts).toBe(before); // no refresh has happened yet
  await refresh(h);
  expect(footer(h)).toMatchObject({ facts: "2", changedKnowledge: "0" });
});

test("24a: the counts follow the selected branch, so a sibling entry of the same Turn is neither noted, counted nor applicable here", async () => {
  const h = host(quiet);
  await h.prompt("Investigate"); await h.answer("Shared interim observation.");
  h.persist({ ...reply(""), content: [{ type: "toolCall", id: "shared", name: "bash", arguments: { command: "inspect common" } }] });
  await h.emit("agent_end");
  const common = [...h.entries];
  const write = (branch: string) => h.memory.tools({ kind: "manual", sessionId: 1, branch, currentTurnId: 1 });
  const source = (ordinal: number) => h.memory.store.sourcePath(1, "main", 1)
    .find(value => value.entryOrdinal === ordinal)!;
  fact(h.memory, h.memory.store.knowledgePath(1, "main", 1), "Alpha rule",
    [{ entry: h.memory.store.getSourceEntry(source(1).id)!, text: "Use alpha everywhere" }]);
  expect(write("main")[3]!.execute({ operations: [{ op: "create", topics: [], text: "ALPHA_IS_THE_RULE", category: "constraint", scope: "session",
    supports: ["F1"], reason: "Admitted from the shared ancestry." }], skipped: [] })).not.toContain("rejected:");
  // A withdrawal bound to a sibling entry of the same Turn: only main holds it.
  h.persist({ ...reply(""), content: [{ type: "toolCall", id: "withdraw", name: "bash", arguments: { command: "alpha withdrawn" } }] });
  await h.emit("agent_end");
  fact(h.memory, h.memory.store.knowledgePath(1, "main", 1), "Alpha withdrawn",
    [{ entry: h.memory.store.getSourceEntry(source(4).id)!, text: "Pi agent reports alpha withdrawn" }]);
  const handle = readHandle(write("main"), "K1");
  expect(write("main")[3]!.execute({ operations: [{ op: "archive", id: handle, supports: ["F2"], reason: "The rule was withdrawn on this path." }], skipped: [] })).not.toContain("rejected:");
  await refresh(h);
  const onMain = footer(h);
  expect(onMain).toMatchObject({ ...enumerated(h), facts: "2", knowledge: "0" }); // archived here

  h.entries.splice(0, h.entries.length, ...common);
  await h.emit("session_tree");
  const branch = (h.entries.filter(e => e.type === "custom").at(-1) as { data: { branch: string } }).data.branch;
  expect(branch).not.toBe("main");
  const sibling = footer(h);
  // The sibling's withdrawal fact and its archive belong to main's occurrence of T1, so this path
  // counts one fact and keeps the rule current. Counting the Turn instead of the branch's own
  // entries would report main's second fact and main's archive here.
  expect(sibling).toMatchObject({ ...enumerated(h, branch), facts: "1", knowledge: "1" });
  expect(h.requests).toEqual([]);
});

test("24a: off is the compact line, imports nothing and calls no model; enabled work below its trigger is idle, not a warning", async () => {
  const h = host({ "noting.triggerTokens": 1_000_000_000 });
  await h.turn();
  facts(h, 2);
  await refresh(h);
  const enabled = footer(h);
  expect(enabled).toMatchObject({ glyph: "○", role: "dim" }); // a nonzero queue below its trigger is idle
  expect(Number(enabled.entries)).toBeGreaterThan(0);
  expect(enabled.facts).toBe("2");

  await h.commands.get("trace")!.handler("off", h.ctx);
  expect(raw(h)).toBe("🧠 <dim>○ off</dim>");
  const turns = h.memory.store.listTurns(1).length, entries = h.memory.store.listSourceEntries(1).length;
  h.persist({ role: "user", content: "spoken while off", timestamp: 2 });
  h.persist(reply("answered while off"));
  const reads = countSourceReads(), builds = countPathBuilds(), bodies = countRunBodies();
  try {
    for (const [event, payload] of [["session_start", {}], ["before_agent_start", { prompt: "hi", systemPrompt: "host" }],
      ["before_provider_request", { payload: { messages: [] } }], ["agent_end", {}], ["agent_settled", {}]] as const) {
      reads.reset(); builds.reset(); bodies.reset();
      await h.emit(event, payload);
      expect(raw(h), event).toBe("🧠 <dim>○ off</dim>");
      expect(reads.reads(), `${event} loaded Raw payloads`).toBe(0);
      expect(builds.builds(), `${event} path builds`).toBe(0); // the off line counts nothing at all
      expect(bodies.chars(), `${event} loaded run audit bodies`).toBe(0);
    }
  } finally { reads.restore(); builds.restore(); bodies.restore(); }
  expect(h.memory.store.listTurns(1).length).toBe(turns); // the paused interval is not imported for a count
  expect(h.memory.store.listSourceEntries(1).length).toBe(entries);
  expect(h.requests).toEqual([]);

  // Enabling again imports the paused interval through the ordinary path, and the counts say so.
  await h.commands.get("trace")!.handler("on", h.ctx);
  expect(Number(footer(h).entries)).toBeGreaterThan(Number(enabled.entries));
});

test("an enabled refresh uses one path snapshot and one bounded processed-version lookup without Raw, rendering or run audit work", async () => {
  const h = host(quiet);
  await h.turn();
  const written = facts(h, 6);
  knowledgeBatch(h.memory.store, h.memory.store.knowledgePath(1, "main", 1),
    written.map((item, i) => ({ scope: "session", category: "understanding", supports: [item.id],
      text: `current ${i}`, author: "test", topics: [], reason: "test", createdAt: time })),
    { kind: "manual", createdAt: time });
  const reads = countSourceReads(), builds = countPathBuilds(), bodies = countRunBodies();
  const rendered = vi.spyOn(rendering, "renderKnowledge"), processed = vi.spyOn(Store.prototype, "processedCurrentVersions");
  const snapshot = vi.spyOn(h.memory.store, "pathSnapshot");
  try {
    reads.reset(); builds.reset(); bodies.reset();
    await refresh(h);
    expect(reads.reads()).toBe(0);
    expect(snapshot.mock.calls.length).toBeLessThanOrEqual(1);
    expect(builds.builds()).toBe(0); // cached ancestry, no full path walk
    expect(bodies.chars()).toBe(0);
    expect(rendered).not.toHaveBeenCalled();
    expect(processed).toHaveBeenCalledTimes(1);
    expect(processed.mock.calls[0]![0]).toHaveLength(6);
  } finally {
    reads.restore(); builds.restore(); bodies.restore(); rendered.mockRestore(); processed.mockRestore(); snapshot.mockRestore();
  }
  expect(footer(h)).toMatchObject(enumerated(h));
});

test("24a: without an allocated memory identity the counts are unknown, not zero, and status says which condition it is", async () => {
  const h = host(quiet);
  h.setHeaderTimestamp("2099-01-01T00:00:00.000Z");
  await h.emit("session_start");
  expect(h.memory.store.getSession(1)).toBeNull();
  expect(footer(h)).toMatchObject({ glyph: "○", role: "dim", entries: "?", facts: "?", changedKnowledge: "?", knowledge: "?", cost: "0.00" }); // today's database-wide spend remains readable
  await h.commands.get("trace")!.handler("", h.ctx);
  expect(h.notices.at(-1)).toContain("Trace Memory · No session");
  expect(h.notices.at(-1)).toContain("Noting        Unknown / Unknown");

  // With an identity and nothing imported yet, the same details carry real zeros — a different
  // condition, and still not a claim that no native history exists.
  await h.turn();
  expect(h.memory.store.getSession(1)).not.toBeNull();
  await h.commands.get("trace")!.handler("", h.ctx);
  expect(h.notices.at(-1)).toContain("Trace Memory · S1");
  expect(h.notices.at(-1)).not.toContain("Consolidation ░");
  expect(h.notices.at(-1)).not.toContain("No session");
  expect(h.requests).toEqual([]);
});

test("24a/51: concurrent N and D indicator prefers N; off and no-theme fallback", async () => {
  const h = host({ "noting.triggerTokens": 1_000, "noting.forkModeDefault": false });
  await h.turn();
  expect(footer(h)).toMatchObject({ glyph: "○", role: "dim" });
  const source = h.memory.store.sourcePath(1, "main", 1).find(value => value.entryOrdinal === 1)!;
  fact(h.memory, h.memory.store.knowledgePath(1, "main", 1), "Package manager choice",
    [{ entry: h.memory.store.getSourceEntry(source.id)!, text: "User chose pnpm" }]);
  const priorRequests = h.requests.length;
  const due = createDreamerTrigger(h.memory, { sessionId: 1, branch: "main", headTurnId: 1 }, 1, 1);
  expect(h.memory.taskEligibility("dreaming", { sessionId: 1, branch: "main", headTurnId: 1 })).toEqual({ due: true });

  // Both phases hold their own real wire requests; D must not be a stand-in for retired C.
  h.provider(async () => new Promise<Reply>(() => {}));
  await h.prompt("second"); await h.answer(); await h.emit("agent_settled"); await h.drain();
  await vi.waitFor(() => expect(h.requests).toHaveLength(priorRequests + 1));
  expect(footer(h)).toMatchObject({ glyph: "●", role: "customMessageLabel" });
  h.persist(reply("word ".repeat(15_000))); await refresh(h); await h.drain();
  await vi.waitFor(() => expect(h.requests).toHaveLength(priorRequests + 2));
  expect(h.memory.store.getClaim(1, "dreaming")).not.toBeNull();
  expect(h.memory.store.getClaim(1, "noting")).not.toBeNull();
  expect(h.conversations.some(c => c.systemPrompt?.startsWith("# Dreamer") && String(c.messages[0]!.content).includes(`K${due.knowledgeId}@v1`))).toBe(true);
  expect(footer(h)).toMatchObject({ glyph: "●", role: "accent" });
  const requests = h.requests.length;
  await refresh(h); await h.emit("agent_settled"); await h.drain();
  expect(h.requests).toHaveLength(requests); // duplicate opportunity neither clears nor readmits either phase
  expect(footer(h)).toMatchObject({ glyph: "●", role: "accent" });

  await h.commands.get("trace")!.handler("off", h.ctx);
  expect(raw(h)).toBe("🧠 <dim>○ off</dim>");
  await h.commands.get("trace")!.handler("on", h.ctx);
  delete (h.ctx.ui as { theme?: unknown }).theme;
  await refresh(h);
  expect(raw(h)).toMatch(/^🧠 [●○] notes: \d+->\d+ memory: \d+\/\d+ cost: \$\d+\.\d{2}$/);
  await h.commands.get("trace")!.handler("off", h.ctx);
  expect(raw(h)).toBe("🧠 ○ off");
});
