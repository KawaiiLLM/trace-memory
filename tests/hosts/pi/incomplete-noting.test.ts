// 32c supersedes the 26a pause. These regressions retain its admission, cancellation,
// native-child and session-isolation scenarios under the persisted three-failure rule.
import { expect, test, vi } from "vitest";
import type { JsonObject } from "@earendil-works/pi-ai";
import { NOTING_INCOMPLETE } from "../../../src/core/api/index.ts";
import { host, reply, emptyNote, type Reply } from "./test-host.ts";
import { noteAndMemory, fixture, say, submitted, worker } from "./native-fixture.ts";

type Host = ReturnType<typeof host>;
const at = "2026-09-09T00:00:00.000Z";
const config = { "noting.forkModeDefault": false, "noting.triggerTokens": 30 };
const command = (h: Host, args: string) => h.commands.get("trace").handler(args, h.ctx);
const notingRuns = (h: Host) => h.memory.store.listRuns(1).filter(r => r.kind === "noting");
const disabled = (h: Host) => h.notices.filter(n => n.includes("off after three failures"));
const tick = async (h: Host, text = "eligible completion " + "word ".repeat(40)) => {
  await h.prompt(text); await h.answer(); await h.drain();
};
const silent = (h: Host) => h.provider(async () => reply("Nothing to note."));
const cancelled = async (h: Host) => {
  const held: ((value: Reply) => void)[] = [];
  h.provider(async () => new Promise<Reply>(resolve => { held.push(resolve); }), { ignoreAbort: false });
  await tick(h);
  expect(held.length).toBeGreaterThan(0);
  await command(h, "stop"); await h.drain();
};
const head = (h: Host) => h.memory.pendingEntries(1, "main", h.memory.store.listTurns(1).at(-1)!.id)[0]!.id;

test.each(["note", "memory"] as const)("92: an explicit %s-only worker ends without publishing or advancing Raw", async name => {
  const h = host(config);
  try {
    let requests = 0;
    h.provider(async c => {
      if (++requests > 2) throw new Error("single-tool failure script repeated a request");
      if (c.messages.some(message => message.role === "toolResult")) return reply("Done.");
      const arguments_: JsonObject = name === "note"
        ? { facts: [{ title: "Package choice", sources: [{ address: "T1#E1", text: "User prefers pnpm" }] }] } : { operations: [], skipped: [] };
      return { ...reply(""), stopReason: "toolUse", content: [{ type: "toolCall", id: `only-${name}`, name, arguments: arguments_ }] };
    }, { autoStop: false });
    await h.turn();
    expect(requests).toBe(2);
    const run = notingRuns(h)[0]!;
    expect(run.outcome).toBe("failure");
    expect(JSON.parse(run.response!).problems).toEqual([NOTING_INCOMPLETE]);
    expect(h.memory.store.listSessionFacts(1)).toEqual([]);
    expect(h.memory.store.currentKnowledge()).toEqual([]);
    expect(h.memory.pendingEntries(1, "main", 1)).toHaveLength(2);
  } finally { await h.dispose(); }
});

test("32c replaces 26a: three incomplete runs with a growing tail disable memory once and show the off footer", async () => {
  const h = host(config);
  try {
    silent(h); await h.turn(); const first = head(h);
    await tick(h);
    expect(notingRuns(h)).toHaveLength(2);
    expect(disabled(h)).toEqual([]);
    expect(h.memory.store.enabled(1)).toBe(true);
    await tick(h);
    expect(head(h)).toBe(first);
    expect(notingRuns(h).map(r => r.outcome)).toEqual(["failure", "failure", "failure"]);
    expect(disabled(h)).toHaveLength(1);
    expect(disabled(h)[0]).toContain("R1, R2, R3");
    expect(disabled(h)[0]).toContain("/trace on");
    expect(h.statuses.get("trace-memory")).toContain("off");
    await tick(h); await tick(h);
    expect(notingRuns(h)).toHaveLength(3);
    expect(disabled(h)).toHaveLength(1);
    expect(h.memory.store.forkSuppression(1)).toBeNull();
  } finally { await h.dispose(); }
}, 20000);

test("32c replaces 26a: a successful submission resets its key; a successfully processed head gives the next task a new key", async () => {
  const h = host(config);
  try {
    silent(h); await h.turn(); const first = head(h);
    h.provider(async c => emptyNote(c) ?? reply("Done.")); await tick(h);
    expect(notingRuns(h).at(-1)!.outcome).toBe("success");
    expect(h.memory.store.db.prepare("SELECT count FROM task_failures WHERE head = ?").get(first)?.count).toBe(0);
    silent(h); await tick(h); const second = head(h);
    expect(second).not.toBe(first);
    const processed = h.memory.pendingEntries(1, "main", h.memory.store.listTurns(1).at(-1)!.id).map(e => e.id);
    expect(h.memory.store.commitNotingRun({ run: { kind: "noting", sessionId: 1, branch: "main", createdAt: at }, facts: [], entryIds: processed }).ok).toBe(true);
    await tick(h); const third = head(h);
    expect(third).not.toBe(second);
    await tick(h); expect(disabled(h)).toEqual([]);
    await tick(h); expect(disabled(h)).toHaveLength(1);
  } finally { await h.dispose(); }
}, 20000);

test("32c replaces 26a: cancellation neither increments nor resets the incomplete streak", async () => {
  const h = host(config);
  try {
    await h.turn(); await cancelled(h); await cancelled(h);
    expect(disabled(h)).toEqual([]);
    silent(h); await tick(h);
    await cancelled(h);
    silent(h); await tick(h);
    expect(disabled(h)).toEqual([]);
    await tick(h); expect(disabled(h)).toHaveLength(1);
  } finally { await h.dispose(); }
}, 30000);

test("32c replaces 26a: provider failure between incomplete runs counts as one final business failure", async () => {
  const h = host(config);
  try {
    silent(h); await h.turn();
    h.provider(async () => ({ ...reply(""), stopReason: "error" as const, errorMessage: "provider exploded" }));
    await tick(h);
    expect(JSON.parse(notingRuns(h).at(-1)!.response!).problems).not.toEqual([NOTING_INCOMPLETE]);
    expect(disabled(h)).toEqual([]);
    silent(h); await tick(h);
    expect(disabled(h)).toHaveLength(1);
  } finally { await h.dispose(); }
}, 20000);

test("32c replaces 26a: off preserves committed facts and reads, blocks both phases and catchup, and only explicit on resets", async () => {
  const h = host(config);
  try {
    silent(h); await h.turn();
    const tools = h.memory.tools({ kind: "manual", sessionId: 1, branch: "main", currentTurnId: 1 });
    expect(tools.find(t => t.name === "note")!.execute({ facts: [
      { title: "Retained claim", sources: [{ address: "T1#E1", text: "Retained claim" }] }] })).toContain("ok: F1");
    await tick(h); await tick(h);
    expect(disabled(h)).toHaveLength(1);
    expect(tools.find(t => t.name === "trace")!.execute({ address: "F1" })).toContain("Retained claim");
    const count = h.memory.store.listRuns(1).length;
    await expect(command(h, "catchup")).rejects.toThrow("Disabled"); await h.drain();
    expect(h.memory.store.enabled(1)).toBe(false);
    expect(h.memory.store.listRuns(1)).toHaveLength(count);
    const target = { sessionId: 1, branch: "main", headTurnId: h.memory.store.listTurns(1).at(-1)!.id };
    expect(h.memory.taskEligibility("noting", target).due).toBe(false);
    expect(h.memory.taskEligibility("dreaming", target).due).toBe(false);
    await command(h, "on");
    expect(h.memory.store.db.prepare("SELECT * FROM task_failures").all()).toEqual([]);
    h.provider(async c => emptyNote(c) ?? reply("Done.")); await tick(h);
    expect(notingRuns(h).at(-1)!.outcome).toBe("success");
  } finally { await h.dispose(); }
}, 30000);

test("32c replaces 26a: reopening resets neither an enabled streak nor disabled enrollment", async () => {
  const h = host(config);
  try {
    silent(h); await h.turn(); await tick(h);
    await h.emit("session_start");
    await tick(h); expect(disabled(h)).toHaveLength(1);
    const count = notingRuns(h).length;
    await h.emit("session_start"); await tick(h);
    expect(h.memory.store.enabled(1)).toBe(false);
    expect(notingRuns(h)).toHaveLength(count);
    await command(h, "on"); h.provider(async c => emptyNote(c) ?? reply("Done.")); await tick(h);
    expect(notingRuns(h).at(-1)!.outcome).toBe("success");
  } finally { await h.dispose(); }
}, 20000);

test("32c replaces 26a: real native fork children disable on the third incomplete execution, not the second", async () => {
  const f = await fixture();
  try {
    f.script(body => !worker(body) ? say("好的。") : say("Nothing to note."));
    for (let i = 1; i <= 3; i++) {
      await f.turn(`question ${i} ` + "word ".repeat(400));
      await vi.waitFor(() => expect(f.h.memory.store.listRuns(1).filter(r => r.kind === "noting" && r.response)).toHaveLength(i), { timeout: 5000 });
      if (i < 3) expect(f.h.memory.store.enabled(1)).toBe(true);
    }
    await vi.waitFor(() => expect(disabled(f.h)).toHaveLength(1), { timeout: 5000 });
    expect(f.h.statuses.get("trace-memory")).toContain("off");
    await f.turn("disabled opportunity " + "word ".repeat(400));
    expect(notingRuns(f.h)).toHaveLength(3);
    await command(f.h, "on");
    f.script(body => !worker(body) ? say("好的。") : submitted(body) ? say("Done.") : noteAndMemory("t1", { facts: [] }));
    await f.turn("enabled opportunity " + "word ".repeat(400));
    await vi.waitFor(() => expect(notingRuns(f.h).filter(r => r.outcome === "success")).toHaveLength(1), { timeout: 5000 });
  } finally { await f.dispose(); }
}, 40000);

test("32c replaces 26a: a disabled executor cannot borrow another enabled session's closed tail", async () => {
  const h = host(config);
  try {
    silent(h); await h.turn(); await tick(h); await tick(h);
    expect(disabled(h)).toHaveLength(1);
    const session = h.memory.store.createSession({ host: "target-host", projectId: h.memory.store.getSession(1)!.projectId, startedAt: at, firstReplyAt: at, enrollmentChoice: true });
    const turn = h.memory.store.appendTurn({ sessionId: session.id, kind: "turn", userPrompt: "Target evidence", startedAt: at });
    const entry = h.memory.appendEntry({ sessionId: session.id, turnId: turn.id, nativeId: "borrowed", nativeLineage: "target", role: "user", text: "Target evidence", raw: "Target evidence", calls: [] });
    h.memory.selectEntries(session.id, "main", [entry.id]); h.memory.store.closeSession(session.id);
    await tick(h);
    expect(h.memory.store.listRuns(session.id)).toEqual([]);
    expect(h.memory.store.enabled(session.id)).toBe(true);
    expect(h.memory.pendingEntries(session.id, "main", turn.id)).toHaveLength(1);
  } finally { await h.dispose(); }
}, 30000);
