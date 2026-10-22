import { afterEach, expect, test, vi } from "vitest";
import { host as createHost, reply, notingFact, dreamerFiles, type Reply } from "./test-host.ts";
import { piSession, say, type Body } from "./native-fixture.ts";
import { TraceMemory } from "../../../src/core/api/index.ts";
import { Store } from "../../../src/core/store/index.ts";
import extension from "../../../src/hosts/pi/index.ts";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { entry, knowledge, session } from "../../support/seed.ts";

const disposers: (() => Promise<void>)[] = [];
afterEach(async () => { for (const dispose of disposers.splice(0)) await dispose(); });
function host(...args: Parameters<typeof createHost>) {
  const h = createHost(...args); disposers.push(h.dispose); return h;
}
/** A Noter-written constraint over one fact: only Noter changes make a Dreamer run due (stage 4 §2.2). */
function seedKnowledge(h: ReturnType<typeof host>) {
  const tools = h.memory.tools({ kind: "manual", sessionId: 1, branch: "main", currentTurnId: 1 });
  const receipt = JSON.parse(tools.find(t => t.name === "note")!.execute({ title: "Package choice", sources: "[T1#E1] Use pnpm" }));
  expect(receipt.factIds).toHaveLength(1);
  knowledge(h.memory.store, { sessionId: 1, branch: "main", headTurnId: 1 }, "session", "constraint", receipt.factIds, "Use pnpm", { operation: { title: "Fixture title" } });
}
test.each(["session_start", "enable"] as const)(
  "%s imports check Noting without waiting for another native entry", async boundary => {
    const h = host({ "noting.triggerTokens": 30 });
    if (boundary !== "session_start") await h.emit("session_start");
    if (boundary === "enable") await h.commands.get("trace")!.handler("off", h.ctx);
    h.persist({ role: "user", content: "word ".repeat(400), timestamp: 1 }, "import-user");
    h.persist(reply("imported answer"), "import-answer");
    if (boundary === "enable") await h.commands.get("trace")!.handler("on", h.ctx);
    else await h.emit(boundary);
    await h.drain();
    const entries = h.memory.store.listSourceEntries(1), newest = entries.at(-1)!;
    expect(h.memory.store.listRuns(1).map(run => [run.kind, run.outcome])).toEqual([["noting", "success"], ["noting", "success"]]); // one batch: its write and verify runs
    expect(h.memory.store.listRuns(1)[0]!.origin).toEqual({ sessionId: 1, entryIds: [newest.id] });
    expect(entries.every(entry => h.memory.store.entryNoted(entry.id))).toBe(true);
    await h.emit("tool_execution_start"); await h.drain();
    expect(h.memory.store.listRuns(1)).toHaveLength(2); // no further batch
  });

test("one import spanning multiple turns admits work at its newest entry", async () => {
  const h = host({ "noting.triggerTokens": 30 });
  await h.emit("session_start");
  for (const name of ["first", "second"]) {
    h.persist({ role: "user", content: `${name} ${"word ".repeat(400)}`, timestamp: 1 });
    h.persist(reply(`${name} answer`));
  }
  await h.emit("tool_execution_start"); await h.drain();
  const entries = h.memory.store.listSourceEntries(1), newest = entries.at(-1)!;
  expect(h.memory.store.listRuns(1).map(run => [run.kind, run.outcome])).toEqual([["noting", "success"], ["noting", "success"]]); // one batch: its write and verify runs
  expect(h.memory.store.listRuns(1)[0]).toMatchObject({
    rangeTo: `S1/T${newest.turnId}`, origin: { sessionId: 1, entryIds: [newest.id] } });
  expect(entries.every(entry => h.memory.store.entryNoted(entry.id))).toBe(true);
  await h.emit("tool_execution_start"); await h.drain();
  expect(h.memory.store.listRuns(1)).toHaveLength(2); // no further batch
});

test("an import after mid-turn compaction checks the selected head, not the entry's owning Turn", async () => {
  const h = host({ "noting.triggerTokens": 100 });
  await h.turn();
  const block = await h.emit("session_before_compact", { preparation: { tokensBefore: 9000 } });
  const compaction = h.compaction(block.compaction.summary);
  await h.emit("session_compact", { compactionEntry: compaction });
  const head = h.memory.store.listTurns(1).at(-1)!.id;
  h.persist(reply("word ".repeat(400)), "after-compaction");
  await h.emit("tool_execution_start"); await h.drain();
  const newest = h.memory.store.listSourceEntries(1).at(-1)!;
  expect(newest.turnId).not.toBe(head);
  const batch = expect.objectContaining({ kind: "noting", outcome: "success", rangeTo: `S1/T${newest.turnId}`,
    origin: { sessionId: 1, entryIds: [newest.id] } });
  expect(h.memory.store.listRuns(1)).toEqual([batch, batch]); // the write run and the verify run
});

test.each(["session_start", "session_tree"] as const)("%s with fully imported history launches nothing even when Noting is due", async boundary => {
  const h = host({ "noting.triggerTokens": 1 });
  await h.emit("session_start");
  h.persist({ role: "user", content: "pending selected evidence", timestamp: 1 });
  h.persist(reply("pending reply"));
  await h.emit("session_tree"); await h.drain(); // Navigation imports without checking.
  expect(h.memory.store.listRuns(1)).toEqual([]);
  const entries = h.memory.store.listSourceEntries(1);
  h.memory.config.noting.triggerTokens = 1;
  expect(h.memory.taskEligibility("noting", { sessionId: 1, branch: "main", headTurnId: 1 }).due).toBe(true);
  await h.emit(boundary); await h.drain();
  expect(h.memory.store.listSourceEntries(1)).toEqual(entries);
  expect(h.memory.store.listRuns(1)).toEqual([]);
  expect(h.requests).toEqual([]);
});

test("a tool-heavy turn admits Noting at its first due entry and Dreaming after a knowledge commit", async () => {
  const h = host({ "noting.triggerTokens": 300, "dreaming.triggerOperations": 1 });
  h.provider(async c => {
    if (c.systemPrompt?.startsWith("# Dreamer") || c.systemPrompt?.startsWith("# Classifying")) return dreamerFiles(c) ?? reply("Done");
    return notingFact(c, "## create\ntitle: Fixture title\ncategory: constraint\nscope: session\ntopics: \nsupports: f1\nreason: Package choice\n\nUse pnpm\n");
  });
  await h.prompt("short");
  await h.emit("message_end", { message: reply("short") });
  await h.emit("tool_execution_start");
  await h.drain();
  expect(h.requests).toHaveLength(0);
  h.persist(reply("word ".repeat(400)));
  await h.emit("tool_execution_start"); await h.drain();
  expect(h.memory.store.listRuns(1).map(r => [r.kind, r.outcome])).toEqual([["noting", "success"], ["noting", "success"]]); // one batch: its write and verify runs
  h.persist(reply("next entry"));
  await h.emit("tool_execution_start"); await h.drain();
  // One Dreamer run is a run for each task: curate's batch, verify with nothing to check, and the scoring pass.
  expect(h.memory.store.listRuns(1).filter(r => r.kind === "dreaming").map(r => [JSON.parse(r.response!).task, r.outcome])).toEqual([["curate", "success"], ["verify", "success"], ["classify", "success"]]);
});

test("busy entries queue nothing; the next entry after publication admits the next batch", async () => {
  const h = host({ "noting.triggerTokens": 30, "dreaming.triggerOperations": 1e9 });
  let release!: (value: Reply) => void;
  let first = true;
  let initial!: Parameters<typeof notingFact>[0];
  h.provider(async c => first ? (first = false, initial = c, new Promise<Reply>(resolve => { release = resolve; })) : notingFact(c));
  await h.prompt("word ".repeat(600)); await h.answer();
  await vi.waitFor(() => expect(h.requests).toHaveLength(1));
  await h.prompt("word ".repeat(600)); await h.answer();
  expect(h.requests).toHaveLength(1);
  release(notingFact(initial)); await h.drain();
  const runs = h.memory.store.listRuns(1).filter(r => r.kind === "noting");
  expect(runs).toHaveLength(2); // write and verify
  expect(runs.map(r => r.outcome)).toEqual(["success", "success"]);
  expect(h.memory.store.listFactsByRun(runs[1]!.id)).toHaveLength(1); // the verify run publishes
  expect(h.memory.store.pendingEntryIds(1, "main", 2).length).toBeGreaterThan(0);
  await h.emit("agent_settled"); await h.drain(); // duplicate terminal signal is not a new turn
  expect(h.memory.store.listRuns(1).filter(r => r.kind === "noting")).toHaveLength(2);
  h.persist(reply("next entry in the same turn")); await h.emit("tool_execution_start"); await h.drain();
  expect(h.memory.store.listRuns(1).filter(r => r.kind === "noting")).toHaveLength(4); // the second batch's two runs
});

test("failed Noting retries at later entry ends and disables memory after three failures", async () => {
  const h = host({ "noting.triggerTokens": 30 });
  h.provider(async () => reply("Incomplete Noter."));
  await h.prompt("word ".repeat(400)); await h.answer(); await h.drain();
  expect(h.memory.store.listRuns(1).filter(r => r.kind === "noting").map(r => r.outcome)).toEqual(["failure"]);
  const count = h.requests.length;
  await h.emit("agent_settled"); await h.drain();
  expect(h.requests).toHaveLength(count);
  h.persist(reply("next entry")); await h.emit("tool_execution_start"); await h.drain();
  expect(h.memory.store.listRuns(1).filter(r => r.kind === "noting").map(r => r.outcome)).toEqual(["failure", "failure"]);
  h.persist(reply("third entry")); await h.emit("tool_execution_start"); await h.drain();
  expect(h.memory.store.listRuns(1).filter(r => r.kind === "noting").map(r => r.outcome)).toEqual(["failure", "failure", "failure"]);
  expect(h.memory.store.enabled(1)).toBe(false);
});

test.each(["aborted", "error"] as const)("%s assistant entries admit without waiting for settlement", async outcome => {
  const h = host({ "noting.triggerTokens": 30 });
  await h.prompt("word ".repeat(400));
  await h.emit("message_end", { message: { ...reply("partial"), stopReason: outcome } });
  await h.emit("agent_end"); await h.drain();
  expect(h.memory.store.listRuns(1).filter(r => r.kind === "noting")).toHaveLength(2);
});

test("stop after an empty borrowed candidate fences the next borrowed launch", async () => {
  const h = host({ "noting.triggerTokens": 1e9 });
  await h.prompt(); await h.emit("message_end", { message: reply("Done.") });
  await h.emit("agent_end"); await h.drain();
  const store = h.memory.store;
  const targets = ["empty", "pending"].map(name => {
    const owner = session(store, store.getSession(1)!.projectId, name);
    const turn = store.appendTurn({ sessionId: owner.id, kind: "turn", startedAt: "2026-09-29", userPrompt: name });
    const source = entry(store, owner.id, turn.id, name, "user");
    h.memory.selectEntries(owner.id, "main", [source.id]); store.closeSession(owner.id);
    return { owner, turn, source };
  });
  const original = Store.prototype.closedTasks;
  const closedTasks = vi.spyOn(Store.prototype, "closedTasks").mockImplementation(function (this: Store, ...args) {
    const candidates = original.apply(this, args);
    const first = targets[0]!;
    expect(store.commitNotingRun({ run: { kind: "noting", sessionId: first.owner.id, branch: "main", createdAt: "2026-09-29" },
      facts: [], entryIds: [first.source.id] }).ok).toBe(true);
    queueMicrotask(() => { void h.commands.get("trace")!.handler("stop", h.ctx); });
    return candidates;
  });
  try {
    await h.emit("agent_settled"); await h.drain();
    const pending = targets[1]!;
    expect(store.listRuns(pending.owner.id).filter(run => run.kind === "noting")).toEqual([]);
    expect(h.requests).toEqual([]);
    expect(h.memory.pendingEntries(pending.owner.id, "main", pending.turn.id).map(e => e.id)).toEqual([pending.source.id]);
  } finally { closedTasks.mockRestore(); }
});

test("installed Pi SDK settles a cancelled turn once and checks again on the next prompt", async () => {
  const dir = mkdtempSync(join(tmpdir(), "trace-memory-turn-end-"));
  const dbPath = join(dir, "trace.db");
  const events: string[] = [];
  const f = await piSession({ extensions: [extension, pi => {
    pi.on("agent_end", () => { events.push("agent_end"); });
    pi.on("agent_settled", () => { events.push("agent_settled"); });
  }], env: { TRACE_MEMORY_CONFIG: JSON.stringify({ dbPath, "noting.triggerTokens": 30,
    "dreaming.triggerOperations": 1e9 }) },
    prepare: ({ agentDir }) => writeFileSync(join(agentDir, "trace-memory-baseline.json"), JSON.stringify("2000-01-01T00:00:00.000Z")) });
  const observer = TraceMemory(dbPath, async () => { throw Error("observer never runs"); });
  try {
    let release!: () => void;
    f.script(async (body: Body, signal) => {
      if (JSON.stringify(body).includes("Noting (facts and knowledge)")) return say("No durable material.");
      if (JSON.stringify(body).includes("hold the provider")) {
        await new Promise<void>(resolve => { release = resolve; signal?.addEventListener("abort", () => resolve(), { once: true }); });
        if (signal?.aborted) throw new DOMException("aborted", "AbortError");
      }
      return say("Done.");
    });
    await f.session.prompt("seed " + "word ".repeat(400));
    await vi.waitFor(() => expect(observer.store.listRuns(1).filter(r => r.kind === "noting")).toHaveLength(1));
    const earlier = events.length;
    const pending = f.session.prompt("hold the provider " + "word ".repeat(400));
    await vi.waitFor(() => expect(typeof release).toBe("function")); // review traffic is not the held main provider
    await f.session.abort();
    release();
    await pending.catch(() => {}); // SDK may reject an aborted prompt; the terminal event is authoritative.
    await vi.waitFor(() => expect(events.slice(earlier).filter(e => e === "agent_settled")).toHaveLength(1));
    await vi.waitFor(() => expect(observer.store.listRuns(1).filter(r => r.kind === "noting")).toHaveLength(2));
    const prior = events.length;
    f.script(body => JSON.stringify(body).includes("Noting (facts and knowledge)") ? say("No durable material.") : say("Resumed."));
    await f.session.prompt("next main turn");
    await vi.waitFor(() => expect(observer.store.listRuns(1).filter(r => r.kind === "noting")).toHaveLength(3));
    expect(events.slice(prior).filter(e => e === "agent_settled")).toHaveLength(1);
  } finally { f.dispose(); observer.close(); rmSync(dir, { recursive: true, force: true }); }
}, 30_000);

test("Raw entry ends reuse a not-due Dreaming result; restore re-arms the next entry", async () => {
  const h = host({ "noting.triggerTokens": 1e9, "dreaming.triggerOperations": 1 });
  const due = vi.spyOn(Store.prototype, "dreamingDue");
  try {
    await h.turn();
    const initial = due.mock.calls.length;
    for (let i = 0; i < 3; i++) {
      h.persist(reply(`entry ${i}`)); await h.emit("tool_execution_start"); await h.drain();
    }
    expect(due).toHaveBeenCalledTimes(initial);
    seedKnowledge(h); await h.emit("session_tree");
    h.provider(async c => dreamerFiles(c) ?? reply("Done"));
    expect(h.requests).toHaveLength(0);
    h.persist(reply("next entry")); await h.emit("tool_execution_start"); await h.drain();
    expect(h.memory.store.listRuns(1).filter(r => r.kind === "dreaming").map(r => r.outcome)).toEqual(["success", "success", "success"]); // curate, verify, classify
  } finally { due.mockRestore(); }
});
