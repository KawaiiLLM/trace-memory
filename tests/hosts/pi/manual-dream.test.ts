// 146 §18: `/trace dream` on Pi. One Dreaming run now, whatever the Noter-operation count says, through the one admission path with
// `manual: true`. Like `/trace catchup` it answers at once; the refusal or the outcome arrives through the status line and a notification.
import { expect, test, vi } from "vitest";
import { host, reply, dreamerFiles, notingFact, type Reply } from "./test-host.ts";
import { fact, knowledge } from "../../support/seed.ts";

const command = (h: ReturnType<typeof host>, args: string) => h.commands.get("trace").handler(args, h.ctx);
const dreaming = (c: { systemPrompt?: string }) => c.systemPrompt?.startsWith("# Dreamer") || c.systemPrompt?.startsWith("# Classifying");
const settle = async (h: ReturnType<typeof host>) => { for (let i = 0; i < 30; i++) await h.drain(); };
const fail = (message: string): Reply => ({ ...reply(""), stopReason: "error", errorMessage: message });
/** A Noter-written constraint over F1: only Noter changes make a Dreamer due; the trigger is set out of reach below. */
function seed(h: ReturnType<typeof host>) {
  const path = h.memory.store.knowledgePath(1, "main", 1);
  const source = h.memory.store.sourcePath(1, "main", 1).map(entry => h.memory.store.getSourceEntry(entry.id)!).find(entry => entry.turnId === 1 && entry.entryOrdinal === 1)!;
  fact(h.memory, path, "Keep conclusion", [{ entry: source, text: "Keep this conclusion." }]);
  knowledge(h.memory.store, path, "project", "constraint", [1], "Rule " + "word ".repeat(120), { operation: { title: "Fixture title" } });
}
const dreamExecutions = (h: ReturnType<typeof host>) => h.memory.store.db.prepare(
  "SELECT outcome FROM task_executions WHERE session_id = 1 AND phase = 'dreaming' ORDER BY rowid").all().map(row => row.outcome);
const retain = (c: Parameters<typeof dreamerFiles>[0]): Reply => dreamerFiles(c) ?? reply("Done");

test("a manual dream answers at once and runs below the trigger; the status reads running, then completed", async () => {
  const h = host({ "noting.triggerTokens": 1e9, "dreaming.triggerKnowledge": 1e9 });
  let release = () => {};
  const held = new Promise<void>(resolve => { release = resolve; });
  try {
    await h.turn(); seed(h);
    h.provider(async c => { if (!dreaming(c)) return notingFact(c); await held; return retain(c); });
    expect(h.memory.taskEligibility("dreaming", { sessionId: 1, branch: "main", headTurnId: 1 })).toEqual({ due: false });
    await command(h, "dream"); // returns without waiting for the held provider
    expect(h.notices.at(-1)).toBe("Dream: starting");
    await command(h, ""); expect(h.notices.at(-1)).toContain("Dream: running");
    release(); await settle(h);
    expect(dreamExecutions(h)).toEqual(["success"]);
    await command(h, ""); expect(h.notices.at(-1)).toContain("Dream: completed");
  } finally { release(); await h.dispose(); }
}, 30000);

test("a refusal reaches the status line with its reason and creates no execution", async () => {
  const h = host({ "noting.triggerTokens": 1e9, "dreaming.triggerKnowledge": 1e9 });
  let release = () => {};
  const held = new Promise<void>(resolve => { release = resolve; });
  try {
    await h.turn(); seed(h);
    h.provider(async c => { if (!dreaming(c)) return notingFact(c); await held; return retain(c); });
    const other = h.memory.store.createSession({ projectId: h.memory.store.getSession(1)!.projectId, host: "pi:other", enrollmentChoice: true, startedAt: "now", firstReplyAt: "now" });
    h.memory.store.db.prepare("INSERT INTO task_claims (session_id, phase, executor_id, token, expires_at, borrowed, reserved) VALUES (?, 'dreaming', 'other', 't', ?, 0, 0)")
      .run(other.id, Date.now() + 60_000);
    await command(h, "dream"); await settle(h);
    await command(h, ""); expect(h.notices.at(-1)).toContain(`Dream: failed — session S${other.id} holds the Dreamer seat`);
    expect(dreamExecutions(h)).toEqual([]);
    h.memory.store.db.prepare("DELETE FROM task_claims WHERE session_id = ?").run(other.id);
    await command(h, "dream"); await vi.waitFor(() => expect(h.memory.store.getClaim(1, "dreaming")).not.toBeNull());
    await command(h, "dream"); // the slot is taken: no core call
    expect(h.notices.at(-1)).toContain("Dream: running");
    release(); await settle(h);
    expect(dreamExecutions(h)).toEqual(["success"]);
  } finally { release(); await h.dispose(); }
}, 30000);

test("a failed manual dream counts once toward the streak, and the command is refused while memory is off", async () => {
  const h = host({ "noting.triggerTokens": 1e9, "dreaming.triggerKnowledge": 1e9 });
  try {
    await h.turn(); seed(h);
    h.provider(async c => dreaming(c) ? fail("manual D terminal failure") : notingFact(c));
    await command(h, "dream"); await settle(h);
    expect(dreamExecutions(h)).toEqual(["failure"]);
    await command(h, ""); expect(h.notices.at(-1)).toContain("Dream: failed");
    expect(h.memory.store.taskFailures(1).find(row => row.phase === "dreaming")?.count).toBe(1);
    await command(h, "off");
    await expect(command(h, "dream")).rejects.toThrow("/trace on");
  } finally { await h.dispose(); }
}, 30000);

test("a provider that never answers leaves the command answered; /trace stop ends the run as stopped", async () => {
  const h = host({ "noting.triggerTokens": 1e9, "dreaming.triggerKnowledge": 1e9 });
  try {
    await h.turn(); seed(h);
    h.provider(async c => dreaming(c) ? new Promise<Reply>(() => {}) : notingFact(c));
    await command(h, "dream");
    await command(h, ""); expect(h.notices.at(-1)).toContain("Dream: running");
    await command(h, "stop"); await settle(h);
    expect(dreamExecutions(h)).toEqual(["cancelled"]);
    await command(h, ""); expect(h.notices.at(-1)).toContain("Dream: stopped");
  } finally { await h.dispose(); }
}, 30000);

test("a manual dream that fails during an active drain ends the drain", async () => {
  const h = host({ "noting.triggerTokens": 1e9, "dreaming.triggerKnowledge": 1e9 });
  let releaseN = () => {};
  const heldN = new Promise<void>(resolve => { releaseN = resolve; });
  let nCalls = 0;
  try {
    await h.turn(); seed(h); await h.turn();
    h.provider(async c => { if (dreaming(c)) return fail("manual D terminal failure"); if (++nCalls === 1) await heldN; return notingFact(c); });
    await command(h, "catchup"); await vi.waitFor(() => expect(nCalls).toBe(1));
    await command(h, "dream"); await vi.waitFor(() => expect(dreamExecutions(h)).toEqual(["failure"]));
    await command(h, ""); expect(h.notices.at(-1)).toContain("Catchup: failed");
    releaseN(); await settle(h);
    expect(dreamExecutions(h)).toEqual(["failure"]);
  } finally { releaseN(); await h.dispose(); }
}, 30000);

const catchupLine = (h: ReturnType<typeof host>) => h.notices.at(-1)!.match(/Catchup: .*/)?.[0];

// A Noter run still in flight when a Dreaming failure ended the drain settles its own execution and slot, but not the drain (Q18).
test.each(["fails", "is cancelled"] as const)("a manual dream fails first, then the drain's Noter %s: the drain keeps Dreaming's diagnostic", async late => {
  const h = host({ "noting.triggerTokens": 1e9, "dreaming.triggerKnowledge": 1e9 });
  let releaseN = () => {};
  const heldN = new Promise<void>(resolve => { releaseN = resolve; });
  let nCalls = 0;
  try {
    await h.turn(); seed(h); await h.turn();
    h.provider(async c => {
      if (dreaming(c)) return fail("manual D terminal failure");
      if (++nCalls === 1) { if (late === "fails") { await heldN; return fail("late N failure"); } return new Promise<Reply>(() => {}); }
      return notingFact(c);
    });
    await command(h, "catchup"); await vi.waitFor(() => expect(nCalls).toBe(1));
    await command(h, "dream"); await vi.waitFor(() => expect(dreamExecutions(h)).toEqual(["failure"]));
    await command(h, ""); const ended = catchupLine(h); expect(ended).toMatch(/Catchup: failed — .*manual D terminal failure/);
    if (late === "fails") releaseN(); else await command(h, "stop");
    await settle(h);
    await command(h, ""); expect(catchupLine(h)).toBe(ended); // same outcome and diagnostic, not "stopped" or the Noter's
    expect(h.memory.store.db.prepare("SELECT outcome FROM task_executions WHERE session_id = 1 AND phase = 'noting'").all().map(r => r.outcome))
      .toEqual([late === "fails" ? "failure" : "cancelled"]); // the late run settled its own execution and no retry started
    expect(h.memory.store.getClaim(1, "noting")).toBeNull(); // its slot is released
  } finally { releaseN(); await h.dispose(); }
}, 30000);
