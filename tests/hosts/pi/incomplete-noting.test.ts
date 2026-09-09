// Ticket 26 amendment 5, implemented by 26a: the incomplete-Noting guard. The host counts
// consecutive incomplete Noting runs per memory session, keyed by the oldest frozen entry of the
// batch, and pauses that session's automatic Noting on the second one. The count is process-local
// like the cache-miss count, is not `forkSuppression`, has no column and no setting, and is cleared
// by `/trace catchup` or a session reopen. Counting rule, verbatim from the amendment: only an
// incomplete run increments; a successful, empty or bounced submission for that head resets the
// count to zero; a provider failure, a cancellation, a dropped admission or a capacity wait leaves
// the count unchanged.
import { expect, test, vi } from "vitest";
import { NOTING_INCOMPLETE } from "../../../src/core/api/index.ts";
import { host, reply, emptyNoteReply, type Reply } from "./test-host.ts";
import { call, fixture, say, submitted, worker } from "./native-fixture.ts";

type Host = ReturnType<typeof host>;
const at = "2026-09-09T00:00:00.000Z";
const config = { "noting.forkModeDefault": false, "noting.triggerTokens": 20, "consolidation.triggerTokens": 1_000_000_000 };
const command = (h: Host, args: string) => h.commands.get("trace").handler(args, h.ctx);
const notingRuns = (h: Host) => h.memory.store.listRuns(1).filter(r => r.kind === "noting");
const paused = (h: Host) => h.notices.filter(n => n.includes("automatic Noting paused"));
/** One eligible completion: new pending evidence, then the ordinary opportunity that admits work. */
const tick = async (h: Host, text = "eligible completion " + "word ".repeat(40)) => {
  h.persist(reply(text)); await h.emit("agent_end"); await h.drain();
};
/** A Noting worker that answers in prose and submits nothing: an incomplete run (26a). */
const silent = (h: Host) => h.provider(async () => reply("Nothing to note."));
/** A worker held at the wire, then cancelled by `/trace stop`: a cancellation, not an incomplete run. */
const cancelled = async (h: Host) => {
  const held: ((value: Reply) => void)[] = [];
  h.provider(async () => new Promise<Reply>(resolve => { held.push(resolve); }), { ignoreAbort: false });
  await tick(h);
  expect(held.length).toBeGreaterThan(0); // the run really reached the wire before it was cancelled
  await command(h, "stop");
  await h.drain();
};
const head = (h: Host) => h.memory.pendingEntries(1, "main", h.memory.store.listTurns(1).at(-1)!.id)[0]!.id;

test("26a amendment 5: two consecutive incomplete runs for the same head pause this session's automatic Noting, disclosed once and in the footer", async () => {
  const h = host(config);
  try {
    silent(h);
    await h.turn();
    const first = head(h);
    expect(notingRuns(h)).toHaveLength(1);
    expect(notingRuns(h)[0]!.outcome).toBe("failure"); // incomplete, and nothing advanced
    expect(paused(h)).toEqual([]); // one incomplete run pauses nothing
    // The tail grows but the head entry does not move: the same batch, so the count continues.
    await tick(h);
    expect(notingRuns(h)).toHaveLength(2);
    expect(head(h)).toBe(first);
    expect(paused(h)).toHaveLength(1); // exactly one notification
    expect(h.statuses.get("trace-memory")).toContain("noting: paused");
    await command(h, "");
    expect(h.notices.at(-1)).toContain("Noting: automatic runs paused after 2 consecutive runs ended without calling note");
    expect(h.notices.at(-1)).toContain(`batch head E${first}`);
    // Paused: later opportunities admit no automatic Noting, and no further notification is made.
    await tick(h); await tick(h);
    expect(notingRuns(h)).toHaveLength(2);
    expect(paused(h)).toHaveLength(1);
    expect(h.memory.pendingEntries(1, "main", h.memory.store.listTurns(1).at(-1)!.id).length).toBeGreaterThan(0);
    // It is not the fork latch, and it is in no database column.
    expect(h.memory.store.forkSuppression(1)).toBeNull();
  } finally { await h.dispose(); }
}, 20000);

test("26a amendment 5: a submission resets the count, and a run for a different head starts a new one", async () => {
  const h = host(config);
  try {
    silent(h);
    await h.turn();
    expect(notingRuns(h)).toHaveLength(1);
    const first = head(h);
    // An explicit empty submission for the same head: a completed batch, so the count is zero again.
    h.provider(async () => emptyNoteReply());
    await tick(h);
    expect(notingRuns(h).at(-1)!.outcome).toBe("success");
    expect(h.memory.pendingEntries(1, "main", h.memory.store.listTurns(1).at(-1)!.id)).toEqual([]);
    // Two more incomplete runs are needed to pause, and their head is a new one.
    silent(h);
    await tick(h);
    const second = head(h);
    expect(second).not.toBe(first);
    expect(paused(h)).toEqual([]);
    // The head alone decides, with no submission in between: another writer processes this batch, so
    // the next incomplete run has a different head and starts its own count instead of pausing.
    const processed = h.memory.pendingEntries(1, "main", h.memory.store.listTurns(1).at(-1)!.id).map(e => e.id);
    expect(h.memory.store.commitNotingRun({ run: { kind: "noting", sessionId: 1, branch: "main", createdAt: at }, facts: [], entryIds: processed }).ok).toBe(true);
    await tick(h);
    const third = head(h);
    expect(third).not.toBe(second);
    expect(paused(h)).toEqual([]);
    // The second incomplete run of that new head is the one that pauses.
    await tick(h);
    expect(head(h)).toBe(third);
    expect(paused(h)).toHaveLength(1);
  } finally { await h.dispose(); }
}, 20000);

test("26a amendment 5: a cancellation neither increments nor resets — incomplete, cancelled, incomplete pauses; cancelled, cancelled never does", async () => {
  const two = host(config);
  try {
    await two.turn(); // its own first run submits the explicit empty batch, so nothing is pending yet
    await cancelled(two);
    await cancelled(two);
    expect(two.memory.store.listRuns(1).filter(r => r.outcome === "cancelled").length).toBeGreaterThan(0);
    expect(paused(two)).toEqual([]); // two ordinary cancellations say nothing about the model
    expect(two.statuses.get("trace-memory")).not.toContain("noting: paused");
  } finally { await two.dispose(); }
  const h = host(config);
  try {
    silent(h);
    await h.turn();
    expect(paused(h)).toEqual([]);
    await cancelled(h); // leaves the count where it was
    silent(h);
    await tick(h);
    expect(paused(h)).toHaveLength(1); // the second incomplete run of the same head still pauses
  } finally { await h.dispose(); }
}, 30000);

test("26a amendment 5: a provider failure between two incomplete runs neither increments nor resets the count", async () => {
  const h = host(config);
  try {
    silent(h);
    await h.turn();
    expect(paused(h)).toEqual([]);
    h.provider(async () => ({ ...reply(""), stopReason: "error" as const, errorMessage: "provider exploded" }));
    await tick(h);
    const failed = notingRuns(h).at(-1)!;
    expect(failed.outcome).toBe("failure");
    expect(JSON.parse(failed.response!).problems).not.toEqual([NOTING_INCOMPLETE]); // a provider failure, not an incomplete run
    expect(paused(h)).toEqual([]);
    silent(h);
    await tick(h);
    expect(paused(h)).toHaveLength(1); // the count survived the failure: this is the second incomplete run
  } finally { await h.dispose(); }
}, 20000);

test("26a amendment 5: while paused, Consolidation, manual writes and reads run, and catchup or a reopen clears the pause", async () => {
  const h = host({ ...config, "consolidation.triggerTokens": 1 });
  try {
    silent(h);
    await h.turn(); await tick(h);
    expect(paused(h)).toHaveLength(1);
    const notings = notingRuns(h).length;
    // A manual write still commits through the host's own façade binding, and a read still answers.
    const manual = h.memory.tools({ kind: "manual", sessionId: 1, branch: "main", currentTurnId: 1 });
    expect(manual.find(t => t.name === "note")!.execute({ facts: [
      { category: "observation", actor: "user", text: "Manual claim while paused", source: ["T1#user"] }] })).toContain("ok: F1");
    expect(manual.find(t => t.name === "trace")!.execute({ address: "F1" })).toContain("Manual claim while paused");
    // Consolidation is admitted normally: only this session's automatic Noting is paused.
    h.provider(async c => c.systemPrompt?.startsWith("# Noting") ? reply("Nothing to note.")
      : { ...reply(""), stopReason: "toolUse", content: [{ type: "toolCall", id: "memory-1", name: "memory",
          arguments: { operations: [], skipped: [{ fact: "F1", because: "Not durable." }] } }] });
    await tick(h);
    await vi.waitFor(() => expect(h.memory.store.listRuns(1).some(r => r.kind === "consolidation" && r.response)).toBe(true), { timeout: 5000 });
    expect(notingRuns(h)).toHaveLength(notings); // still paused while the other phase worked
    // `/trace catchup` clears it: the explicit drain is the user's own instruction to continue, and
    // it clears the pause itself — here the drain finds nothing pending, because another writer took
    // the batch, so no run of its own could have reset the count.
    const processed = h.memory.pendingEntries(1, "main", h.memory.store.listTurns(1).at(-1)!.id).map(e => e.id);
    expect(h.memory.store.commitNotingRun({ run: { kind: "noting", sessionId: 1, branch: "main", createdAt: at }, facts: [], entryIds: processed }).ok).toBe(true);
    h.provider(async () => emptyNoteReply());
    await command(h, "catchup");
    expect(h.notices.at(-1)).toContain("nothing pending");
    await h.drain();
    expect(h.statuses.get("trace-memory")).not.toContain("noting: paused");
    await command(h, "");
    expect(h.notices.filter(n => n.includes("Noting: automatic runs paused"))).toEqual([]);
    expect(notingRuns(h).length).toBeGreaterThan(notings);
  } finally { await h.dispose(); }
}, 30000);

test("26a amendment 5: a session reopen clears the pause and automatic Noting is admitted again", async () => {
  const h = host(config);
  try {
    silent(h);
    await h.turn(); await tick(h);
    expect(paused(h)).toHaveLength(1);
    const notings = notingRuns(h).length;
    await h.emit("session_start"); // the reopen boundary, exactly where the cache-miss count clears
    expect(h.statuses.get("trace-memory")).not.toContain("noting: paused");
    h.provider(async () => emptyNoteReply());
    await tick(h);
    expect(notingRuns(h).length).toBeGreaterThan(notings);
    expect(notingRuns(h).at(-1)!.outcome).toBe("success");
  } finally { await h.dispose(); }
}, 20000);

test("26a amendment 5: the guard holds for real native children — two incomplete fork runs pause the session", async () => {
  const f = await fixture();
  try {
    // A real Pi child that answers in prose and never submits: incomplete, twice, on the same head.
    f.script(body => !worker(body) ? say("好的。") : say("Nothing to note."));
    await f.turn();
    await vi.waitFor(() => expect(f.h.memory.store.listRuns(1).filter(r => r.kind === "noting" && r.response)).toHaveLength(1), { timeout: 5000 });
    expect(f.h.notices.filter(n => n.includes("automatic Noting paused"))).toEqual([]);
    await f.turn("second question " + "word ".repeat(400));
    await vi.waitFor(() => expect(f.h.memory.store.listRuns(1).filter(r => r.kind === "noting" && r.response)).toHaveLength(2), { timeout: 5000 });
    await vi.waitFor(() => expect(f.h.notices.filter(n => n.includes("automatic Noting paused"))).toHaveLength(1), { timeout: 5000 });
    const runs = f.h.memory.store.listRuns(1).filter(r => r.kind === "noting");
    expect(runs.map(r => r.outcome)).toEqual(["failure", "failure"]);
    expect(f.h.statuses.get("trace-memory")).toContain("noting: paused");
    // Paused: a third opportunity admits nothing for this session, and the entries stay pending.
    await f.turn("third question " + "word ".repeat(400));
    expect(f.h.memory.store.listRuns(1).filter(r => r.kind === "noting")).toHaveLength(2);
    expect(f.h.memory.pendingEntries(1, "main", f.h.memory.store.listTurns(1).at(-1)!.id).length).toBeGreaterThan(0);
    // A submission after the pause is cleared completes the batch normally.
    f.script(body => !worker(body) ? say("好的。") : submitted(body) ? say("Done.") : call("t1", "note", { facts: [] }));
    await f.h.emit("session_start");
    await f.turn("fourth question " + "word ".repeat(400));
    await vi.waitFor(() => expect(f.h.memory.store.listRuns(1).filter(r => r.kind === "noting" && r.outcome === "success")).toHaveLength(1), { timeout: 5000 });
    expect(f.h.memory.pendingEntries(1, "main", f.h.memory.store.listTurns(1).at(-1)!.id)).toEqual([]);
  } finally { await f.dispose(); }
}, 40000);

test("26a amendment 5: the pause is per memory session — a paused executor still borrows another session's closed tail", async () => {
  const h = host(config);
  try {
    silent(h);
    await h.turn(); await tick(h);
    expect(paused(h)).toHaveLength(1); // this executor's own session is paused
    const ownRuns = notingRuns(h).length;
    // Another session's closed tail, discoverable by this executor through the ordinary scope rule.
    const session = h.memory.store.createSession({ host: "target-host", projectId: h.memory.store.getSession(1)!.projectId, startedAt: at, firstReplyAt: at, enrollmentChoice: true });
    const turn = h.memory.store.appendTurn({ sessionId: session.id, kind: "turn", userPrompt: "Target evidence", startedAt: at });
    const entry = h.memory.appendEntry({ sessionId: session.id, turnId: turn.id, nativeId: "borrowed", nativeLineage: "target", role: "user", text: "Target evidence", raw: "Target evidence", calls: [] });
    h.memory.selectEntries(session.id, "main", [entry.id]);
    h.memory.store.closeSession(session.id);
    h.provider(async () => emptyNoteReply());
    await tick(h);
    // The borrowed target is noted; the paused session's own entries are still untouched.
    expect(h.memory.store.listRuns(session.id).filter(r => r.kind === "noting")).toHaveLength(1);
    expect(h.memory.pendingEntries(session.id, "main", turn.id)).toEqual([]);
    expect(notingRuns(h)).toHaveLength(ownRuns);
    expect(h.memory.pendingEntries(1, "main", h.memory.store.listTurns(1).at(-1)!.id).length).toBeGreaterThan(0);
  } finally { await h.dispose(); }
}, 30000);
