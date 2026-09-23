import { afterEach, expect, test } from "vitest";
import { host, reply } from "./test-host.ts";
import { countSourceReads } from "../../perf/fixture.ts";

// Ticket 22b, hotspot families 1 and 2: reconciliation costs what the evidence is, not what the
// session already holds. A tool result finds its call without rereading the entries before it, and an
// ancestry that has already been reconciled is not read again at every callback — while every entry
// the walk does check keeps its content-identity check.

const hosts: ReturnType<typeof host>[] = [];
const setup = (config: Record<string, unknown> = {}) => { const h = host(config); hosts.push(h); return h; };
afterEach(async () => { for (const h of hosts.splice(0)) await h.dispose(); });
const command = (h: ReturnType<typeof host>, args: string) => (h.commands.get("trace") as { handler(args: string, ctx: unknown): Promise<void> }).handler(args, h.ctx);
const head = (h: ReturnType<typeof host>) => (h.entries.filter(e => e.customType === "trace-memory").at(-1) as { data: { head: number } }).data.head;
const quiet = { "noting.triggerTokens": 1_000_000_000 };

/** `turns` native prompt/reply/tool-result triples, persisted but not yet reconciled. Every Turn uses
 * the same tool call id, so matching a result cannot be decided by the identifier alone. */
const persistTurns = (h: ReturnType<typeof host>, turns: number, from = 0) => {
  for (let t = from + 1; t <= from + turns; t++) {
    h.persist({ role: "user", content: `question ${t}`, timestamp: t });
    h.persist({ ...reply(""), content: [{ type: "text", text: `answer ${t}` }, { type: "toolCall", id: "shared-call", name: "bash", arguments: { command: `run ${t}` } }] });
    h.persist({ role: "toolResult", toolCallId: "shared-call", toolName: "bash", content: [{ type: "text", text: `result ${t}` }], isError: false, timestamp: t });
  }
};
/** Warm-up: the imported history is taken by a Noting run, so an ordinary boundary is the ordinary
 * case and not a due trigger. No model is involved — this is the store's own commit. */
const noteAll = (h: ReturnType<typeof host>) => {
  const entryIds = h.memory.pendingEntries(1, "main", head(h)).map(e => e.id);
  const committed = h.memory.store.commitNotingRun({ run: { kind: "noting", sessionId: 1, branch: "main",
    rangeFrom: "S1/T1", rangeTo: `S1/T${head(h)}`, createdAt: "warm-up" }, facts: [], entryIds });
  if (!committed.ok) throw new Error(committed.problems.join("; "));
};

test("22b: a tool result finds its call without rereading the entries before it", async () => {
  const counter = countSourceReads();
  try {
    const imported = async (turns: number) => {
      const h = setup(quiet);
      h.setHeaderTimestamp("2000-01-01T00:00:00Z");
      await h.emit("session_start");
      persistTurns(h, turns);
      counter.reset();
      await command(h, "on");
      const store = h.memory.store;
      return { h, reads: counter.reads(), entries: store.listSourceEntries(1).length,
        calls: store.listTurns(1).flatMap(t => store.listToolCalls(t.id)) };
    };
    const small = await imported(10), large = await imported(40);
    expect(large.h.notices.filter(n => n.includes("missing native history"))).toEqual([]); // every result found its call
    expect(large.entries).toBe(120);
    // Each Turn's own result completed that Turn's own call, although every call id is the same.
    expect(large.calls.map(c => [c.status, JSON.parse(c.result!).content[0].text]))
      .toEqual(Array.from({ length: 40 }, (_unused, i) => ["success", `result ${i + 1}`]));
    expect(large.reads).toBeLessThanOrEqual(2 * large.entries); // linear in the entries, not in their squares
    expect(large.reads / small.reads).toBeLessThan(small.entries === 0 ? 1 : 5); // four times the history, four times the work
  } finally { counter.restore(); }
});

test("22b: an ordinary boundary costs what is new, not what the session already holds", async () => {
  const counter = countSourceReads();
  try {
    const h = setup();
    h.setHeaderTimestamp("2000-01-01T00:00:00Z");
    await h.emit("session_start");
    persistTurns(h, 30);
    await command(h, "on");
    noteAll(h);
    const exchange = async () => {
      h.persist({ role: "user", content: "one short follow-up", timestamp: 1 });
      h.persist(reply("a short answer"));
      counter.reset();
      await h.emit("agent_end");
      const reads = counter.reads();
      noteAll(h);
      return reads;
    };
    const short = await exchange();
    expect(short).toBeLessThan(10); // the two new entries and the pending check, not the history
    persistTurns(h, 30, 30); // double the retained history
    await h.emit("agent_end");
    noteAll(h);
    expect(h.memory.store.listSourceEntries(1).length).toBeGreaterThan(180);
    expect(await exchange()).toBe(short); // twice the history, the same fixed exchange, the same cost
    counter.reset();
    for (let update = 0; update < 50; update++) await h.emit("message_update", { message: reply(`delta ${update}`) });
    expect(counter.reads()).toBe(0); // an unchanged persisted leaf resumes nothing
    expect(h.requests).toEqual([]);
  } finally { counter.restore(); }
});

test("22b: a persisted message changed under a known identity is still reported when it is checked", async () => {
  const h = setup(quiet);
  await h.prompt("Question"); await h.answer("Answer"); await h.emit("agent_settled");
  const stored = h.memory.store.listSourceEntries(1).find(e => e.role === "assistant")!;
  const native = h.entries.find(e => e.type === "message" && e.message.role === "assistant") as { message: { content: unknown } };
  native.message.content = [{ type: "text", text: "silently changed" }];
  await h.emit("session_start"); // restoration rebuilds, so the entry is checked again
  expect(h.notices.some(n => n.includes(`missing native history: entry ${(native as unknown as { id: string }).id} changed after persistence`))).toBe(true);
  expect(h.memory.store.getSourceEntry(stored.id)!.raw).toBe(stored.raw); // and the original Raw is kept
});

test("74: a persisted assistant whose native role changed still offers its calls to a later result", async () => {
  // Review 2026-09-23: a digest mismatch is only reported, so the walk goes on, and it must decide by
  // the persisted role as 22b did — the native message's new role would drop the call map.
  const h = setup(quiet);
  await h.prompt("Question");
  h.persist({ ...reply(""), content: [{ type: "toolCall", id: "call-original", name: "bash", arguments: { command: "echo original" } }] });
  await h.emit("agent_end");
  const native = h.entries.find(e => e.type === "message" && e.message.role === "assistant") as unknown as { id: string; message: unknown };
  native.message = { role: "user", content: "modified native role", timestamp: 1 };
  await h.emit("session_start");
  h.persist({ role: "toolResult", toolCallId: "call-original", toolName: "bash", content: [{ type: "text", text: "result" }], isError: false, timestamp: 2 });
  await h.emit("agent_end");
  expect(h.notices.some(n => n.includes(`entry ${native.id} changed after persistence`))).toBe(true);
  expect(h.notices.some(n => n.includes("tool call call-original"))).toBe(false);
  expect(h.memory.store.listSourceEntries(1).map(e => e.role)).toContain("toolResult");
});

test("22b: tree navigation and a foreign lineage rebuild the reconciled ancestry", async () => {
  const h = setup(quiet);
  h.setHeaderTimestamp("2000-01-01T00:00:00Z");
  await h.emit("session_start");
  persistTurns(h, 2);
  await command(h, "on");
  const common = [...h.entries]; // the ancestry as it stands after two Turns
  persistTurns(h, 1, 2);
  await h.emit("agent_end");
  const all = h.memory.store.sourcePath(1, "main", head(h)).map(e => e.id);
  expect(all).toHaveLength(9);
  expect(h.memory.store.db.prepare("SELECT branch, head_turn_id FROM session_lineage_cursors WHERE session_id = 1 AND lineage = 'pi-test'").get())
    .toEqual({ branch: "main", head_turn_id: head(h) });
  h.entries.splice(0, h.entries.length, ...common); // navigate back to an earlier point of the tree
  await h.emit("session_tree");
  const branch = (h.entries.filter(e => e.customType === "trace-memory").at(-1) as { data: { branch: string } }).data.branch;
  expect(branch).not.toBe("main");
  expect(h.memory.store.sourcePath(1, branch, head(h)).map(e => e.id)).toEqual(all.slice(0, 6));
  expect(h.memory.store.db.prepare("SELECT branch, head_turn_id FROM session_lineage_cursors WHERE session_id = 1 AND lineage = 'pi-test'").get())
    .toEqual({ branch, head_turn_id: head(h) });
  // A new result on the shorter ancestry matches that ancestry's call, and reports nothing missing.
  persistTurns(h, 1, 2);
  await h.emit("agent_end");
  expect(h.notices.filter(n => n.includes("missing native history"))).toEqual([]);
  const calls = h.memory.store.listTurns(1).flatMap(t => h.memory.store.listToolCalls(t.id));
  expect(calls.map(c => JSON.parse(c.result!).content[0].text)).toEqual(["result 1", "result 2", "result 3", "result 3"]);
  expect(h.memory.store.sourcePath(1, branch, head(h))).toHaveLength(9);
  expect(h.memory.store.db.prepare("SELECT branch, head_turn_id FROM session_lineage_cursors WHERE session_id = 1 AND lineage = 'pi-test'").get())
    .toEqual({ branch, head_turn_id: head(h) });
});
