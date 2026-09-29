import { afterEach, expect, test, vi } from "vitest";
import { host as createHost, reply, notingFact, type Reply } from "./test-host.ts";
import { piSession, say, type Body } from "./native-fixture.ts";
import { TraceMemory } from "../../../src/core/api/index.ts";
import { Store } from "../../../src/core/store/index.ts";
import extension from "../../../src/hosts/pi/index.ts";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

const disposers: (() => Promise<void>)[] = [];
afterEach(async () => { for (const dispose of disposers.splice(0)) await dispose(); });
function host(...args: Parameters<typeof createHost>) {
  const h = createHost(...args); disposers.push(h.dispose); return h;
}
function seedKnowledge(h: ReturnType<typeof host>) {
  const tools = h.memory.tools({ kind: "manual", sessionId: 1, branch: "main", currentTurnId: 1 });
  expect(tools.find(t => t.name === "note")!.execute({ facts: [{ title: "Package choice", sources: [{ address: "T1#E1", text: "Use pnpm" }] }] })).toContain("ok: F1");
  expect(tools.find(t => t.name === "memory")!.execute({ operations: [{ op: "create", text: "Use pnpm", category: "constraint",
    scope: "session", supports: ["F1"], topics: [], reason: "Rule" }], skipped: [] })).not.toContain("rejected:");
}
const skip = (): Reply => ({ ...reply(""), stopReason: "toolUse", content: [{ type: "toolCall", id: "m1", name: "memory",
  arguments: { operations: [], skipped: [{ knowledge: "K1@v1", because: "Reviewed unchanged" }] } }] });

test("a tool-heavy main turn launches neither phase until its final settlement", async () => {
  const h = host({ "noting.triggerTokens": 30, "noting.forkModeDefault": false, "dreaming.triggerTokens": 1 });
  h.provider(async c => c.systemPrompt?.startsWith("# Dreamer") ? skip() : notingFact(c));
  await h.prompt();
  await h.emit("message_end", { message: { ...reply(""), stopReason: "toolUse", content: [{ type: "toolCall", id: "c1", name: "bash", arguments: { command: "true" } }] } });
  await h.emit("tool_result", { toolCallId: "c1", toolName: "bash", content: [{ type: "text", text: "ok" }] });
  await h.emit("agent_end"); // intermediate loop: retry/compaction may continue
  expect(h.requests).toHaveLength(0);
  await h.emit("message_end", { message: reply("Done.") });
  await h.emit("agent_end");
  seedKnowledge(h);
  expect(h.requests).toHaveLength(0);
  await h.emit("before_provider_request", { payload: { messages: [] } });
  expect(h.requests).toHaveLength(0);
  await h.emit("agent_settled"); await h.drain();
  const runs = h.memory.store.listRuns(1);
  expect(runs.filter(r => r.kind === "noting")).toHaveLength(1);
  expect(runs.filter(r => r.kind === "dreaming")).toHaveLength(1);
  await h.drain();
  expect(h.memory.store.listRuns(1)).toHaveLength(runs.length);
});

test("busy phase is skipped; successful publication does not chain until a later turn", async () => {
  const h = host({ "noting.triggerTokens": 30, "noting.forkModeDefault": false, "dreaming.triggerTokens": 1e9 });
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
  expect(runs).toHaveLength(1);
  expect(runs[0]!.outcome).toBe("success");
  expect(h.memory.store.listFactsByRun(runs[0]!.id)).toHaveLength(1);
  expect(h.memory.store.pendingEntryIds(1, "main", 2).length).toBeGreaterThan(0);
  await h.emit("agent_settled"); await h.drain(); // duplicate terminal signal is not a new turn
  expect(h.memory.store.listRuns(1).filter(r => r.kind === "noting")).toHaveLength(1);
  await h.prompt("new main turn"); await h.answer(); await h.drain();
  expect(h.memory.store.listRuns(1).filter(r => r.kind === "noting")).toHaveLength(2);
});

test("failed Noting waits for a later main turn before retry", async () => {
  const h = host({ "noting.triggerTokens": 30, "noting.forkModeDefault": false });
  h.provider(async () => reply("Incomplete Noter."));
  await h.prompt("word ".repeat(400)); await h.answer(); await h.drain();
  expect(h.memory.store.listRuns(1).filter(r => r.kind === "noting").map(r => r.outcome)).toEqual(["failure"]);
  const count = h.requests.length;
  await h.emit("agent_settled"); await h.drain();
  expect(h.requests).toHaveLength(count);
  await h.prompt("next turn"); await h.answer(); await h.drain();
  expect(h.memory.store.listRuns(1).filter(r => r.kind === "noting").map(r => r.outcome)).toEqual(["failure", "failure"]);
});

test.each(["aborted", "error"] as const)("%s main turn checks at its final settlement", async outcome => {
  const h = host({ "noting.triggerTokens": 30, "noting.forkModeDefault": false });
  await h.prompt("word ".repeat(400));
  await h.emit("message_end", { message: { ...reply("partial"), stopReason: outcome } });
  await h.emit("agent_end");
  expect(h.requests).toHaveLength(0);
  await h.emit("agent_settled"); await h.drain();
  expect(h.memory.store.listRuns(1).filter(r => r.kind === "noting")).toHaveLength(1);
});

test("stop after an empty own candidate must not admit a stale borrowed candidate", async () => {
  const h = host({ "noting.triggerTokens": 30, "noting.forkModeDefault": false });
  let closedTasks: ReturnType<typeof vi.spyOn> | undefined;
  let pendingEntries: ReturnType<typeof vi.spyOn> | undefined;
  try {
    await h.prompt("word ".repeat(400));
    await h.emit("message_end", { message: reply("Done.") });
    const store = h.memory.store;
    const target = store.createSession({ host: "closed-target", projectId: store.getSession(1)!.projectId,
      startedAt: "2026-09-29", firstReplyAt: "2026-09-29", enrollmentChoice: true });
    const turn = store.appendTurn({ sessionId: target.id, kind: "turn", startedAt: "2026-09-29", userPrompt: "borrowed" });
    const source = h.memory.appendEntry({ sessionId: target.id, turnId: turn.id, nativeId: "borrowed", nativeLineage: "target",
      role: "user", text: "borrowed", raw: "borrowed", calls: [] });
    h.memory.selectEntries(target.id, "main", [source.id]);
    store.closeSession(target.id);
    const originals = { closed: Store.prototype.closedTasks, pending: Store.prototype.pendingEntries };
    let emptied = false, stopped = false;
    closedTasks = vi.spyOn(Store.prototype, "closedTasks").mockImplementation(function (this: Store, ...args) {
      const candidates = originals.closed.apply(this, args);
      if (!emptied) {
        emptied = true;
        const own = store.listSourceEntries(1).map(e => e.id);
        expect(store.commitNotingRun({ run: { kind: "noting", sessionId: 1, branch: "main", createdAt: "2026-09-29" }, facts: [], entryIds: own }).ok).toBe(true);
      }
      return candidates;
    });
    pendingEntries = vi.spyOn(Store.prototype, "pendingEntries").mockImplementation(function (this: Store, ...args) {
      const entries = originals.pending.apply(this, args);
      if (emptied && args[0] === 1 && !entries.length && !stopped) {
        stopped = true;
        queueMicrotask(() => { void h.commands.get("trace")!.handler("stop", h.ctx); });
      }
      return entries;
    });
    await h.emit("agent_settled"); await h.drain();
    expect(emptied).toBe(true);
    expect(stopped).toBe(true);
    expect(store.listRuns(target.id).filter(run => run.kind === "noting"), JSON.stringify(store.listRuns(target.id))).toHaveLength(0);
    expect(h.requests).toHaveLength(0);
    expect(h.memory.pendingEntries(target.id, "main", turn.id)).toHaveLength(1);
  } finally { pendingEntries?.mockRestore(); closedTasks?.mockRestore(); await h.dispose(); }
});

test("installed Pi SDK settles a cancelled turn once and checks again on the next prompt", async () => {
  const dir = mkdtempSync(join(tmpdir(), "trace-memory-turn-end-"));
  const dbPath = join(dir, "trace.db");
  const events: string[] = [];
  const f = await piSession({ extensions: [extension, pi => {
    pi.on("agent_end", () => { events.push("agent_end"); });
    pi.on("agent_settled", () => { events.push("agent_settled"); });
  }], env: { TRACE_MEMORY_CONFIG: JSON.stringify({ dbPath, "noting.triggerTokens": 30,
    "noting.forkModeDefault": false, "dreaming.triggerTokens": 1e9 }) },
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
    await vi.waitFor(() => expect(f.sent.length).toBeGreaterThan(2));
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

test("restore and ingestion alone do not launch a due Dreamer", async () => {
  const h = host({ "noting.triggerTokens": 1e9, "dreaming.triggerTokens": 1 });
  await h.turn(); seedKnowledge(h); await h.emit("session_tree");
  h.provider(async () => skip());
  await h.prompt(); await h.emit("message_end", { message: reply("Done.") }); await h.emit("agent_end");
  expect(h.requests).toHaveLength(0);
  await h.emit("agent_settled"); await h.drain();
  expect(h.memory.store.listRuns(1).filter(r => r.kind === "dreaming")).toHaveLength(1);
});
