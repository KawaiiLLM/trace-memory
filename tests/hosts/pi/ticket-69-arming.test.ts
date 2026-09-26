// N is evaluated per ingested entry; D is armed by a commit/restore/configuration change.
import { afterEach, expect, test, vi } from "vitest";
import { host as createHost, reply, notingFact, type Reply } from "./test-host.ts";
import * as api from "../../../src/core/api/index.ts";

const disposers: (() => Promise<void>)[] = [];
afterEach(async () => { for (const dispose of disposers.splice(0)) await dispose(); });
function host(...args: Parameters<typeof createHost>) {
  const h = createHost(...args); disposers.push(h.dispose); return h;
}
function spyEligibility() {
  const calls: string[] = [], original = api.TraceMemory;
  const spy = vi.spyOn(api, "TraceMemory").mockImplementation((...args: Parameters<typeof api.TraceMemory>) => {
    const instance = original(...args), inner = instance.taskEligibility;
    instance.taskEligibility = (phase, target) => { calls.push(phase); return inner(phase, target); };
    return instance;
  });
  return { calls, restore: () => spy.mockRestore() };
}
const quiet = { "noting.triggerTokens": 1e9, "dreaming.triggerTokens": 1e9 };
const skip = (): Reply => ({ ...reply(""), stopReason: "toolUse", content: [{ type: "toolCall", id: "m1", name: "memory",
  arguments: { operations: [], skipped: [{ knowledge: "K1@v1", because: "Reviewed unchanged" }] } }] });
function seed(h: ReturnType<typeof host>) {
  const tools = h.memory.tools({ kind: "manual", sessionId: 1, branch: "main", currentTurnId: 1 });
  expect(tools.find(t => t.name === "note")!.execute({ facts: [{ text: "Use pnpm", source: ["T1#E1"] }] })).toContain("ok: F1");
  expect(tools.find(t => t.name === "memory")!.execute({ operations: [{ op: "create", text: "Use pnpm", category: "constraint",
    scope: "session", supports: ["F1"], topics: [], reason: "Rule" }], skipped: [] })).not.toContain("rejected:");
}

test("69: an ingested entry with nothing armed evaluates N only", async () => {
  const eligibility = spyEligibility();
  try {
    const h = host(quiet); await h.turn();
    const before = h.memory.store.listSourceEntries(1).length;
    eligibility.calls.length = 0; await h.turn();
    expect(h.memory.store.listSourceEntries(1).length).toBeGreaterThan(before);
    expect(eligibility.calls.filter(p => p === "dreaming")).toEqual([]);
    expect(eligibility.calls.filter(p => p === "noting").length).toBeGreaterThan(0);
    expect(eligibility.calls).not.toContain("consolidation");
  } finally { eligibility.restore(); }
});

test("69: busy D is not duplicated by a new entry; release settles the one owned run", async () => {
  const h = host({ "noting.triggerTokens": 1e9, "dreaming.triggerTokens": 1 });
  await h.turn(); seed(h); await h.emit("session_tree");
  let release: ((value: Reply) => void) | undefined;
  h.provider(async () => new Promise<Reply>(resolve => { release = resolve; }));
  h.persist(reply("first entry")); await h.emit("agent_end"); await vi.waitFor(() => expect(release).toBeDefined());
  expect(h.memory.store.getClaim(1, "dreaming")?.borrowed).toBe(false);
  h.persist(reply("second entry while busy")); await h.emit("agent_end");
  expect(h.requests).toHaveLength(1);
  release!(skip()); await h.drain();
  expect(h.memory.store.listRuns(1).filter(r => r.kind === "dreaming")).toHaveLength(1);
});

test("92: successful joint N publication admits due D before another ingested entry", async () => {
  const h = host({ "noting.triggerTokens": 30, "dreaming.triggerTokens": 1 });
  h.provider(async c => {
    if (c.systemPrompt?.startsWith("# Dreamer")) {
      if (c.messages.some(m => m.role === "toolResult")) throw new Error("Dreamer must end after its one successful skip; unexpected continuation");
      return skip();
    }
    const value = notingFact(c);
    for (const part of value.content) if (part.type === "toolCall" && part.name === "memory") part.arguments = {
      operations: [{ op: "create", text: "Use pnpm", category: "constraint", scope: "session", topics: [], supports: ["$1"], reason: "Rule" }], skipped: [],
    };
    return value;
  });
  await h.turn();
  expect(h.memory.store.listSessionFacts(1).length).toBeGreaterThan(0);
  expect(h.memory.store.listKnowledgeRevisions().length).toBeGreaterThan(0);
  expect(h.memory.store.listRuns(1).some(r => r.kind === "dreaming" && r.outcome === "success")).toBe(true);
  expect(h.memory.store.listRuns(1).some(r => r.kind === "consolidation")).toBe(false);
});

test("69: restore re-arms D but does not itself grant an extraction opportunity", async () => {
  const h = host({ "noting.triggerTokens": 1e9, "dreaming.triggerTokens": 1 });
  await h.turn(); seed(h); await h.emit("session_tree");
  expect(h.requests).toHaveLength(0);
  h.provider(async () => skip());
  h.persist(reply("new entry")); await h.emit("agent_end"); await h.drain();
  expect(h.memory.store.listRuns(1).some(r => r.kind === "dreaming" && r.outcome === "success")).toBe(true);
});

test("69: raw ingestion alone changes neither historical unconsolidated facts nor due pools", async () => {
  const h = host(quiet); await h.turn();
  const path = h.memory.store.knowledgePath(1, "main");
  const before = { facts: h.memory.store.consolidationBatch(1, "main").map(f => f.id), pools: h.memory.store.duePools(path).map(p => p.pool) };
  await h.turn(); await h.turn();
  expect({ facts: h.memory.store.consolidationBatch(1, "main").map(f => f.id), pools: h.memory.store.duePools(path).map(p => p.pool) }).toEqual(before);
});

for (const action of ["stop", "off", "path"] as const) test(`72: ${action} fences a busy N's late D checkpoint`,  async () => {
  const eligibility = spyEligibility();
  try {
    const h = host({ "noting.triggerTokens": 30, "dreaming.triggerTokens": 1 });
    let release = () => {};
    const held = new Promise<void>(resolve => { release = resolve; });
    h.provider(async c => { await held; return notingFact(c); }, { ignoreAbort: true });
    await h.turn(); await vi.waitFor(() => expect(h.requests).toHaveLength(1));
    expect(h.memory.store.getClaim(1, "noting")).not.toBeNull();
    if (action === "path") {
      h.entries.length = 0; h.allEntries.length = 0;
      h.ctx.sessionManager.getSessionId = () => "other-native-session";
      await h.emit("session_tree");
    } else {
      await h.commands.get("trace").handler(action, h.ctx);
      if (action === "off") await h.commands.get("trace").handler("on", h.ctx);
    }
    eligibility.calls.length = 0; release(); await h.drain();
    // Ordinary work retains its original target across navigation; only stop/off cancels it.
    // The navigation contract here is the completion checkpoint fence, not catchup cancellation.
    expect(h.memory.store.listSessionFacts(1)).toHaveLength(action === "path" ? 1 : 0);
    expect(h.memory.store.listRuns(1).some(r => r.kind === "dreaming")).toBe(false);
    expect(eligibility.calls).not.toContain("dreaming");
    if (action === "path") {
      eligibility.calls.length = 0;
      h.provider(async c => notingFact(c)); await h.turn();
      expect(eligibility.calls).toContain("dreaming");
    }
  } finally { eligibility.restore(); }
});
