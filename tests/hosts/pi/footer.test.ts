// Ticket 24a "Footer counts and indicator" (parent 24, sections "Footer counts and cost" and
// "Indicator semantics"). The enabled footer is
//
//     🧠 <indicator> notes: <pending entries>-><applicable facts> memory: <unconsolidated facts>-><current knowledge> cost: $<session cumulative>
//
// and the off footer is the compact `🧠 ○ off`. These cases pin what each number means on a
// synthetic branch, that work stays pending until its business commit, that the indicator is Pi
// theme roles in the ruled precedence while the routine text stays dim, and — 22a's own contract,
// kept — that a refresh costs a
// status refresh: no Raw payload, one path membership, no run audit body, no model request.
import { afterEach, expect, test } from "vitest";
import { host as createHost, reply, notingFact, consolidationReply, type Reply } from "./test-host.ts";
import { countPathBuilds, countRunBodies, countSourceReads } from "../../perf/fixture.ts";

const disposers: (() => Promise<void>)[] = [];
afterEach(async () => { for (const dispose of disposers.splice(0)) await dispose(); });
function host(...args: Parameters<typeof createHost>) {
  const h = createHost(...args);
  disposers.push(h.dispose);
  return h;
}
type Host = ReturnType<typeof host>;
const quiet = { "noting.triggerTokens": 1_000_000_000, "consolidation.triggerTokens": 1_000_000_000 };
const time = "2026-09-09T00:00:00Z";

const raw = (h: Host) => h.statuses.get("trace-memory") ?? "";
/** The footer as its reader sees it: the theme role of the indicator, the glyph, and the five values
 * as text — so an unknown `?` is distinguishable from a counted `0`. */
const footer = (h: Host) => {
  const status = raw(h);
  const parsed = /^🧠 (?:<(\w+)>)?([●○])(?:<\/\w+>)? (?:<dim>)?notes: (\S+)->(\S+) memory: (\S+)->(\S+) cost: \$(\S+?)(?:<\/dim>)?$/.exec(status);
  if (!parsed) throw new Error(`unreadable footer: ${status}`);
  return { status, role: parsed[1], glyph: parsed[2]!, entries: parsed[3]!, facts: parsed[4]!,
    unconsolidated: parsed[5]!, knowledge: parsed[6]!, cost: parsed[7]! };
};
/** The same four numbers, enumerated independently of `progress` through the 22a/22b primitives the
 * footer claims to equal — `consolidationBatch` rebuilds its own path membership, so this is not the
 * production query with different arguments. */
const enumerated = (h: Host, branch = "main") => {
  const head = h.memory.store.knowledgePath(1, branch).headTurnId!;
  return { entries: String(h.memory.pendingEntries(1, branch, head).length),
    facts: String(h.memory.store.listBranchFacts(1, branch, head).length),
    unconsolidated: String(h.memory.store.consolidationBatch(1, branch, head).length),
    knowledge: String(h.memory.store.listCurrentKnowledge(h.memory.store.knowledgePath(1, branch, head)).length),
    cost: h.memory.spend(1).cost.toFixed(2) };
};
/** An existing refresh point, not a new one: `agent_end` is the boundary at which this turn's
 * evidence became importable. */
const refresh = (h: Host) => h.emit("agent_end");

/** Facts on the current branch, written without a model and without taking any entry, so the pending
 * entry count is untouched and a per-fact rebuild would be visible. */
function facts(h: Host, count = 3) {
  const committed = h.memory.store.commitNotingRun({ run: { kind: "noting", sessionId: 1, branch: "main", createdAt: time },
    facts: Array.from({ length: count }, (_, i) => ({ turnId: 1, category: "observation" as const, actor: "user" as const,
      text: `footer fact ${i}`, source: ["T1#user"], createdAt: time })) });
  if (!committed.ok) throw new Error(committed.problems.join("; "));
  return committed.facts;
}
/** One synthetic run with an observed usage, charged to `sessionId` and executed by `executor`. */
function priced(h: Host, sessionId: number, executorSessionId: number, cost: number) {
  const committed = h.memory.store.commitNotingRun({ run: { kind: "noting", sessionId, executorSessionId, branch: "main", createdAt: time,
    response: JSON.stringify({ usage: { input: 10, output: 5, cacheRead: 0, cacheWrite: 0, cost: { total: cost } } }) }, facts: [] });
  if (!committed.ok) throw new Error(committed.problems.join("; "));
}

test("24a: notes is entries-to-note over applicable facts, memory is facts-to-consolidate over current knowledge, cost is this session's cumulative spend", async () => {
  const h = host(quiet);
  await h.turn(); // one Turn, two source entries, nothing noted and nothing extracted
  expect(footer(h)).toMatchObject({ ...enumerated(h), glyph: "○", role: "dim" });
  expect(raw(h)).toBe("🧠 <dim>○</dim> <dim>notes: 2->0 memory: 0->0 cost: $0.00</dim>");

  const written = facts(h, 3);
  await refresh(h);
  expect(raw(h)).toBe("🧠 <dim>○</dim> <dim>notes: 2->3 memory: 3->0 cost: $0.00</dim>"); // committed facts are immediately eligible
  expect(footer(h)).toMatchObject(enumerated(h));

  // Knowledge cites a fact; citing is not consolidating, so the left number does not move.
  const knowledge = h.memory.tools({ kind: "manual", sessionId: 1, branch: "main", currentTurnId: 1 })[3]!
    .execute({ operations: [{ op: "create", topics: [], reason: "Initial admission of this conclusion.", text: "Use pnpm, never npm",
      category: "constraint", scope: "session", supports: [`F${written[0]!.id}`] }], skipped: [] });
  expect(knowledge).not.toContain("rejected:");
  await refresh(h);
  expect(raw(h)).toBe("🧠 <dim>○</dim> <dim>notes: 2->3 memory: 3->1 cost: $0.00</dim>");

  // A Consolidation commit takes two of the three facts; a Noting commit takes both entries.
  const taken = h.memory.store.commitConsolidationRun({ run: { kind: "consolidation", sessionId: 1, branch: "main", createdAt: time },
    operations: [], consolidated: [written[0]!.id, written[1]!.id] });
  expect(taken.ok).toBe(true);
  const noted = h.memory.store.commitNotingRun({ run: { kind: "noting", sessionId: 1, branch: "main", createdAt: time },
    facts: [], entryIds: h.memory.store.sourcePath(1, "main", 1).map(e => e.id) });
  expect(noted.ok).toBe(true);
  await refresh(h);
  expect(raw(h)).toBe("🧠 <dim>○</dim> <dim>notes: 0->3 memory: 1->1 cost: $0.00</dim>");
  expect(footer(h)).toMatchObject(enumerated(h));

  // Cost is the session's cumulative run spend: work another executor performed for this session
  // counts; this executor's borrowed work for another session is charged to that session, not here.
  priced(h, 1, 2, 0.12);
  const borrowed = h.memory.store.createSession({ host: "pi:other", startedAt: time, firstReplyAt: time, projectId: 1, enrollmentChoice: true });
  priced(h, borrowed.id, 1, 9.99);
  await refresh(h);
  expect(footer(h)).toMatchObject({ ...enumerated(h), cost: "0.12" });
  expect(h.memory.spend(borrowed.id).cost).toBe(9.99);
  expect(h.requests).toEqual([]); // nothing here called a model
});

test("24a: an in-flight batch is still pending, a failed run advances nothing, a commit moves both queues and a post-commit failure restores nothing", async () => {
  const h = host({ "noting.triggerTokens": 20, "consolidation.triggerTokens": 1_000_000_000 });
  let release!: (value: Reply) => void;
  h.provider(async () => new Promise(resolve => { release = resolve; }));
  await h.prompt(); await h.answer(); await h.emit("agent_settled"); await h.drain();
  const admitted = footer(h);
  expect(admitted).toMatchObject({ glyph: "●", role: "accent", entries: "2", facts: "0" }); // admitted, not done
  expect(admitted.status).toMatch(/^🧠 <accent>●<\/accent> <dim>notes: .*<\/dim>$/);
  expect(admitted).toMatchObject(enumerated(h));

  release(notingFact(h.conversations[0]!)); await h.drain();
  // The business commit is what moves both queues: the entries are noted and the fact is now pending
  // for Consolidation. Noting decreasing one queue while increasing the other is the ordinary case.
  expect(raw(h)).toBe("🧠 <dim>○</dim> <dim>notes: 0->1 memory: 1->0 cost: $0.00</dim>");

  // A run that fails before its commit advances nothing at all.
  h.provider(async () => { throw new Error("offline"); });
  await h.turn(); await h.answer("next completed source"); await h.drain();
  const failed = footer(h);
  expect(failed.role).toBe("error");
  expect(failed.status).toMatch(/^🧠 <error>●<\/error> <dim>notes: .*<\/dim>$/);
  expect(failed).toMatchObject(enumerated(h));
  expect(Number(failed.entries)).toBeGreaterThan(0); // the new turn's entries stayed pending
  expect(failed.facts).toBe("1");

  // A provider failure after the commit keeps the progress: it is a problem on a success, and the
  // committed work is not restored to the pending queue.
  const pendingBefore = Number(footer(h).entries);
  h.provider(async c => c.messages.some(m => m.role === "toolResult") ? { ...reply(""), stopReason: "error", errorMessage: "stream reset after commit" } : notingFact(c), { autoStop: false });
  // 29d: no trailing extra reply here. Without the retired delivery pause a small trailing entry no
  // longer joins the previous batch, and would start a further run this case is not about.
  await h.turn(); await h.drain();
  const after = footer(h);
  expect(after.role).toBe("warning"); // committed with problems
  expect(after.status).toMatch(/^🧠 <warning>●<\/warning> <dim>notes: .*<\/dim>$/);
  expect(Number(after.entries)).toBeLessThan(pendingBefore);
  expect(Number(after.facts)).toBeGreaterThan(1);
  expect(after).toMatchObject(enumerated(h));
  expect(h.memory.store.listRuns(1).at(-1)!.outcome).toBe("success");
});

test("24a: a cancelled batch advances nothing, and another connection's commits appear at the next refresh", async () => {
  const h = host({ "noting.triggerTokens": 20, "consolidation.triggerTokens": 1_000_000_000 });
  h.provider(async () => new Promise(() => {}), { ignoreAbort: false }); // never answers
  await h.prompt(); await h.answer(); await h.emit("agent_settled"); await h.drain();
  const running = footer(h);
  expect(running.role).toBe("accent");
  await h.commands.get("trace")!.handler("stop", h.ctx);
  await h.drain();
  expect(footer(h)).toMatchObject({ entries: running.entries, facts: running.facts, unconsolidated: running.unconsolidated });
  expect(h.memory.store.listSessionFacts(1)).toEqual([]);

  // A second connection (the test's own observer façade) commits; the next refresh shows it, because
  // every refresh re-reads and nothing is cached between them.
  const before = footer(h).facts;
  facts(h, 2);
  expect(footer(h).facts).toBe(before); // no refresh has happened yet
  await refresh(h);
  expect(footer(h)).toMatchObject({ facts: "2", unconsolidated: "2" });
});

test("24a: the counts follow the selected branch, so a sibling entry of the same Turn is neither noted, counted nor applicable here", async () => {
  const h = host(quiet);
  await h.prompt("Investigate"); await h.answer("Shared interim observation.");
  h.persist({ ...reply(""), content: [{ type: "toolCall", id: "shared", name: "bash", arguments: { command: "inspect common" } }] });
  await h.emit("agent_end");
  const common = [...h.entries];
  const write = (branch: string) => h.memory.tools({ kind: "manual", sessionId: 1, branch, currentTurnId: 1 });
  expect(write("main")[2]!.execute({ facts: [{ category: "decision", actor: "user", text: "Use alpha everywhere", source: ["T1#user"] }] })).not.toContain("rejected:");
  expect(write("main")[3]!.execute({ operations: [{ op: "create", topics: [], text: "ALPHA_IS_THE_RULE", category: "constraint", scope: "session",
    supports: ["F1"], reason: "Admitted from the shared ancestry." }], skipped: [] })).not.toContain("rejected:");
  // A withdrawal bound to a sibling entry of the same Turn: only main holds it.
  h.persist({ ...reply(""), content: [{ type: "toolCall", id: "withdraw", name: "bash", arguments: { command: "alpha withdrawn" } }] });
  await h.emit("agent_end");
  expect(write("main")[2]!.execute({ facts: [{ category: "decision", actor: "user", text: "Alpha is withdrawn", source: ["T1#t2"] }] })).not.toContain("rejected:");
  write("main")[0]!.execute({ address: "K1@1" });
  expect(write("main")[3]!.execute({ operations: [{ op: "archive", id: "K1@1", supports: ["F2"], reason: "The user withdrew the rule on this path." }], skipped: [] })).not.toContain("rejected:");
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
  expect(Number(enabled.unconsolidated)).toBeGreaterThan(0);

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

test("24a: an enabled refresh reads one path membership, no Raw payload and no run audit body", async () => {
  const h = host(quiet);
  await h.turn();
  facts(h, 6);
  const reads = countSourceReads(), builds = countPathBuilds(), bodies = countRunBodies();
  try {
    reads.reset(); builds.reset(); bodies.reset();
    await refresh(h);
    expect(reads.reads()).toBe(0); // no Raw payload is loaded to display a count
    expect(builds.builds()).toBe(1); // one membership for all four counts, never one per fact
    expect(bodies.chars()).toBe(0); // spend projects usage in SQL; no request or response body is read
  } finally { reads.restore(); builds.restore(); bodies.restore(); }
  expect(footer(h)).toMatchObject(enumerated(h));
});

test("24a: without an allocated memory identity the counts are unknown, not zero, and status says which condition it is", async () => {
  const h = host(quiet);
  h.setHeaderTimestamp("2099-01-01T00:00:00.000Z");
  await h.emit("session_start");
  expect(h.memory.store.getSession(1)).toBeNull();
  expect(raw(h)).toBe("🧠 <dim>○</dim> <dim>notes: ?->? memory: ?->? cost: $?</dim>");
  await h.commands.get("trace")!.handler("", h.ctx);
  expect(h.notices.at(-1)).toContain("Session: None (no assistant reply)");
  expect(h.notices.at(-1)).toContain("Unknown / 1,000,000,000 (no session)");

  // With an identity and nothing imported yet, the same details carry real zeros — a different
  // condition, and still not a claim that no native history exists.
  await h.turn();
  expect(h.memory.store.getSession(1)).not.toBeNull();
  await h.commands.get("trace")!.handler("", h.ctx);
  expect(h.notices.at(-1)).toContain("Session: S1");
  expect(h.notices.at(-1)).toContain("Consolidation: [..........] 0 / 1,000,000,000 (0.0%)");
  expect(h.notices.at(-1)).not.toContain("(no session)");
  expect(h.requests).toEqual([]);
});

test("24a: the indicator is theme roles in the ruled precedence, Noting wins over Consolidation, and no colour support prints the same line unpainted", async () => {
  const h = host({ "noting.triggerTokens": 1, "consolidation.triggerTokens": 1, "noting.forkModeDefault": false });
  h.provider(async c => c.systemPrompt!.includes("### Second-round user message") ? consolidationReply() : notingFact(c));
  await h.turn(); // F1 recorded; idle again
  expect(footer(h)).toMatchObject({ glyph: "○", role: "dim" });

  // Both phases due at the same boundary, both held at the wire: Noting has display priority.
  let held = 0;
  h.provider(async () => new Promise(() => { held++; }));
  await h.prompt("second"); await h.answer(); await h.emit("agent_settled"); await h.drain();
  expect(held).toBe(2); // a Noting and a Consolidation request are both in flight
  expect(footer(h)).toMatchObject({ glyph: "●", role: "accent" });

  // Off wins over everything, including work still in flight.
  await h.commands.get("trace")!.handler("off", h.ctx);
  expect(raw(h)).toBe("🧠 <dim>○ off</dim>");
  await h.commands.get("trace")!.handler("on", h.ctx);

  // Pi's native fallback: no theme support, the same line without colour.
  delete (h.ctx.ui as { theme?: unknown }).theme;
  await refresh(h);
  expect(raw(h)).toMatch(/^🧠 [●○] notes: \d+->\d+ memory: \d+->\d+ cost: \$\d+\.\d{2}$/);
  await h.commands.get("trace")!.handler("off", h.ctx);
  expect(raw(h)).toBe("🧠 ○ off");
});
