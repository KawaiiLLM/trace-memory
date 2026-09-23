// Ticket 69 "Pi foreground stalls": Noting is evaluated on every ingested entry, exactly as before;
// Consolidation and Dreaming are evaluated only while a per-phase "armed" flag says something that
// could change their answer may have happened since they were last checked (a committed run, a
// restore/branch switch, enabling memory, or a knowledge-budget change) — never merely because an
// entry arrived. A completion checkpoint re-checks the armed phases immediately, without waiting for
// the next entry.
import { afterEach, expect, test, vi } from "vitest";
import { host as createHost, reply, notingFact, consolidationReply, type Reply } from "./test-host.ts";
import * as api from "../../../src/core/api/index.ts";

const disposers: (() => Promise<void>)[] = [];
afterEach(async () => { for (const dispose of disposers.splice(0)) await dispose(); });
function host(...args: Parameters<typeof createHost>) {
  const h = createHost(...args);
  disposers.push(h.dispose);
  return h;
}

/** The only handle a test has on `taskEligibility`: the extension holds its own `TraceMemory`
 * instance in a closure, never exposed directly, so this wraps the exported factory itself. Every
 * instance it constructs (this test's host and the observer test-host.ts builds alongside it) gets
 * its returned `taskEligibility` wrapped to count calls by phase. */
function spyEligibility() {
  const calls: string[] = [];
  const original = api.TraceMemory;
  const spy = vi.spyOn(api, "TraceMemory").mockImplementation((...args: Parameters<typeof api.TraceMemory>) => {
    const instance = original(...args);
    const inner = instance.taskEligibility;
    instance.taskEligibility = ((phase, target) => { calls.push(phase); return inner(phase, target); }) as typeof inner;
    return instance;
  });
  return { calls, restore: () => spy.mockRestore() };
}
const quiet = { "noting.triggerTokens": 1_000_000_000, "consolidation.triggerTokens": 1_000_000_000, "dreaming.triggerTokens": 1_000_000_000 };

test("ticket 69: an ingested entry with nothing armed evaluates Noting only (spy on taskEligibility)", async () => {
  const eligibility = spyEligibility();
  try {
    const h = host(quiet);
    await h.turn(); // nothing due yet: this disarms Consolidation and Dreaming
    const before = h.memory.store.listSourceEntries(1).length;
    eligibility.calls.length = 0;
    await h.turn(); // more ingested entries, still nothing armed
    expect(h.memory.store.listSourceEntries(1).length).toBeGreaterThan(before); // entries really were ingested
    expect(eligibility.calls.filter(p => p === "consolidation")).toEqual([]);
    expect(eligibility.calls.filter(p => p === "dreaming")).toEqual([]);
    expect(eligibility.calls.filter(p => p === "noting").length).toBeGreaterThan(0);
  } finally { eligibility.restore(); }
});

test("ticket 69: a due-but-busy Consolidation retries at the next entry once its slot frees, as today", async () => {
  const h = host({ "noting.triggerTokens": 1_000_000_000, "consolidation.triggerTokens": 1 });
  await h.turn();
  const committed = h.memory.store.commitNotingRun({ run: { kind: "noting", sessionId: 1, branch: "main", createdAt: "t" },
    facts: [{ turnId: 1, category: "observation", actor: "user", text: "seed", source: ["T1#user"], createdAt: "t" }] });
  if (!committed.ok) throw new Error(committed.problems.join("; "));
  await h.emit("session_tree"); // arm Consolidation for this fact, seeded through the observer connection
  let releaseFirst: ((reply: Reply) => void) | undefined;
  h.provider(async () => new Promise<Reply>(resolve => { releaseFirst = resolve; }));
  h.persist(reply("first entry")); await h.emit("agent_end"); await vi.waitFor(() => expect(releaseFirst).toBeDefined());
  expect(h.memory.store.getClaim(1, "consolidation")?.borrowed).toBe(false); // admitted, now busy
  // A further entry while the slot is busy is skipped, not queued or duplicated (`slots.has` guard).
  h.persist(reply("second entry, while busy")); await h.emit("agent_end"); await new Promise(r => setImmediate(r));
  expect(h.memory.store.listRuns(1).filter(r => r.kind === "consolidation")).toHaveLength(0); // still in flight, no run recorded yet
  releaseFirst!(consolidationReply());
  await h.drain();
  expect(h.memory.store.listRuns(1).filter(r => r.kind === "consolidation")).toHaveLength(1); // the busy opportunity was not lost, just deferred
});

test("ticket 69: a Noting completion that crosses Consolidation's trigger admits it immediately, before any further entry", async () => {
  const h = host({ "noting.triggerTokens": 30, "consolidation.triggerTokens": 1 });
  h.provider(async c => c.systemPrompt?.includes("You are the Consolidator:") ? consolidationReply(c) : notingFact(c));
  await h.turn(); // one Noting run commits a fact; nothing else ingests a further entry after it
  expect(h.conversations.some(c => c.systemPrompt?.includes("You are the Consolidator:"))).toBe(true);
  expect(h.memory.store.listSessionFacts(1).length).toBeGreaterThan(0);
  expect(h.memory.store.listRuns(1).some(r => r.kind === "consolidation" && r.outcome === "success")).toBe(true);
});

test("ticket 69: a Consolidation completion that makes a pool due admits Dreaming likewise, before any further entry", async () => {
  const h = host({ "noting.triggerTokens": 30, "consolidation.triggerTokens": 1, "dreaming.triggerTokens": 1 });
  h.provider(async c => {
    if (c.systemPrompt?.includes("You are the Consolidator:")) {
      const facts = [...new Set(c.messages.map(m => String(m.content)).join("\n").match(/\bF[1-9]\d*\b/g) ?? [])];
      return { ...reply(""), stopReason: "toolUse", content: [{ type: "toolCall", id: "m1", name: "memory", arguments: {
        operations: [{ op: "create", topics: [], reason: "Admit supported conclusion", text: "Use pnpm, never npm",
          category: "constraint", scope: "session", supports: facts }], skipped: [] } }] };
    }
    if (c.systemPrompt?.includes("# Dreamer")) return { ...reply(""), stopReason: "toolUse", content: [{ type: "toolCall", id: "d1", name: "memory",
      arguments: { operations: [], skipped: [{ knowledge: "K1@1", because: "reviewed; retain" }] } }] };
    return notingFact(c);
  });
  await h.turn();
  expect(h.conversations.some(c => c.systemPrompt?.startsWith("# Dreamer"))).toBe(true);
  expect(h.memory.store.listKnowledgeRevisions().length).toBeGreaterThan(0);
  expect(h.memory.store.listRuns(1).some(r => r.kind === "dreaming")).toBe(true);
});

test("ticket 69: a branch switch (restore) re-checks Consolidation and Dreaming at the next opportunity", async () => {
  const h = host({ "noting.triggerTokens": 1_000_000_000, "consolidation.triggerTokens": 1 });
  await h.turn(); // disarms Consolidation: nothing pending yet
  const committed = h.memory.store.commitNotingRun({ run: { kind: "noting", sessionId: 1, branch: "main", createdAt: "t" },
    facts: [{ turnId: 1, category: "observation", actor: "user", text: "seed", source: ["T1#user"], createdAt: "t" }] });
  if (!committed.ok) throw new Error(committed.problems.join("; "));
  // The fact above was committed through the observer connection, so restore — not the ordinary entry
  // path — is what this test pins as the re-arming event (session_tree: a branch switch).
  await h.emit("session_tree");
  h.provider(async c => consolidationReply(c));
  h.persist(reply("word ".repeat(20))); await h.emit("agent_end"); await h.drain();
  expect(h.memory.store.listRuns(1).some(r => r.kind === "consolidation")).toBe(true);
});

test("ticket 69: ingesting entries is shown, not assumed, to leave consolidationBatch and duePools unchanged", async () => {
  const h = host(quiet);
  await h.turn();
  const path = h.memory.store.knowledgePath(1, "main");
  const before = { batch: h.memory.store.consolidationBatch(1, "main").map(f => f.id), pools: h.memory.store.duePools(path).map(p => p.pool) };
  await h.turn(); await h.turn();
  const after = { batch: h.memory.store.consolidationBatch(1, "main").map(f => f.id), pools: h.memory.store.duePools(path).map(p => p.pool) };
  expect(after).toEqual(before);
});

// Ticket 72: Pi's completion checkpoint (line ~1046) is gated only on `settled` and the progress
// signal, with no epoch of the finished task and no exclusion of a `cancelled` outcome — so a task
// admitted before a stop, an off, or a branch switch can still use a late completion (partial commit
// included) to launch Consolidation/Dreaming from a path this executor should treat as abandoned.
async function armedAndBusy(h: ReturnType<typeof host>) {
  await h.turn(); // nothing due yet: disarms Consolidation
  const committed = h.memory.store.commitNotingRun({ run: { kind: "noting", sessionId: 1, branch: "main", createdAt: "t" },
    facts: [{ turnId: 1, category: "observation", actor: "user", text: "seed", source: ["T1#user"], createdAt: "t" }] });
  if (!committed.ok) throw new Error(committed.problems.join("; "));
  await h.emit("session_tree"); // arm Consolidation for this fact, seeded through the observer connection
  let releaseFirst: ((reply: Reply) => void) | undefined;
  h.provider(async () => new Promise<Reply>(resolve => { releaseFirst = resolve; }));
  h.persist(reply("first entry")); await h.emit("agent_end"); await vi.waitFor(() => expect(releaseFirst).toBeDefined());
  expect(h.memory.store.getClaim(1, "consolidation")?.borrowed).toBe(false); // admitted, now busy
  return releaseFirst!;
}

test("ticket 72: a stop during a busy Consolidation fences its late completion from launching Dreaming", async () => {
  const h = host({ "noting.triggerTokens": 1_000_000_000, "consolidation.triggerTokens": 1, "dreaming.triggerTokens": 1 });
  const release = await armedAndBusy(h);
  await h.commands.get("trace").handler("stop", h.ctx); // stop while Consolidation is in flight
  release(consolidationReply()); // resolves with a commit despite the stop
  await h.drain();
  expect(h.memory.store.listRuns(1).some(r => r.kind === "dreaming")).toBe(false); // the late completion must not launch D
});

test("ticket 72: off during a busy Consolidation fences its late completion from launching Dreaming", async () => {
  const h = host({ "noting.triggerTokens": 1_000_000_000, "consolidation.triggerTokens": 1, "dreaming.triggerTokens": 1 });
  const release = await armedAndBusy(h);
  await h.commands.get("trace").handler("off", h.ctx); // disable while Consolidation is in flight
  await h.commands.get("trace").handler("on", h.ctx); // re-enable immediately: the completion still lands after `off`
  release(consolidationReply());
  await h.drain();
  expect(h.memory.store.listRuns(1).some(r => r.kind === "dreaming")).toBe(false);
});

test("ticket 72: a branch switch during a busy Consolidation fences its late completion, and a later legitimate opportunity evaluates the new path", async () => {
  const eligibility = spyEligibility();
  try {
    const h = host({ "noting.triggerTokens": 1_000_000_000, "consolidation.triggerTokens": 1, "dreaming.triggerTokens": 1 });
    const release = await armedAndBusy(h);
    await h.emit("session_tree"); // a restore (branch switch) while Consolidation is in flight
    eligibility.calls.length = 0;
    release(consolidationReply());
    await h.drain();
    expect(h.memory.store.listRuns(1).some(r => r.kind === "dreaming")).toBe(false); // the stale completion must not launch D
    expect(eligibility.calls).not.toContain("dreaming"); // the fenced checkpoint never even re-armed and re-checked it
    // A later, genuinely new opportunity (an ordinary ingested entry) still re-checks Dreaming on the
    // now-current path: the restore already armed it, so the entry's own opportunity evaluates it.
    eligibility.calls.length = 0;
    await h.turn();
    expect(eligibility.calls).toContain("dreaming");
  } finally { eligibility.restore(); }
});
