import { expect, test, vi } from "vitest";
import { knowledge, legacyFacts } from "../../support/seed.ts";
import { host, reply } from "./test-host.ts";
import { hydrate } from "../../source-fixture.ts";

// Pi's message-completion callback precedes persistence: no task is launched from an unpersisted entry.

const long = "word ".repeat(400);
const notingRuns = (h: ReturnType<typeof host>) => h.memory.store.listRuns(1).filter(r => r.kind === "noting");

test("19c 2026-09-08: a message completion before persistence launches nothing; settlement imports a real entry id", async () => {
  // Runner-independent: Pi's message-completion callback precedes persistence, and 17a reconciles
  // persisted entries only, so no runner ever sees an entry that is not in the session file yet.
  const h = host({ "noting.triggerTokens": 30 });
  try {
    await h.prompt("Persist first"); // short: the user entry alone is below the trigger
    const completed = reply("done. " + long);
    // The completion callback alone, exactly as Pi fires it: the entry is not in the file yet.
    await h.hooks.get("message_end")!({ message: completed }, h.ctx);
    expect(hydrate(h.memory.pendingEntries(1, "main", 1), h.memory.store).map(e => e.role)).toEqual(["user"]);
    expect(notingRuns(h)).toEqual([]);
    expect(h.conversations).toEqual([]); // and nothing was sent to any model
    // The next authoritative boundary observes persistence and grants the entry opportunity.
    const persisted = h.persist(completed);
    expect(notingRuns(h)).toEqual([]);
    await h.emit("agent_end"); await h.emit("agent_settled"); await h.drain();
    const runs = notingRuns(h);
    expect(runs).toHaveLength(2); // the batch's write and verify runs
    const audited = JSON.parse(runs[0]!.response!).entryAudit.entries as { nativeId: string }[];
    expect(audited.map(e => e.nativeId)).toContain(persisted.id); // the real entry id, not a synthesized one
    // Later boundaries are not new triggers: the same task is not launched a second time.
    await h.emit("agent_settled"); await h.emit("agent_end"); await h.drain();
    expect(notingRuns(h)).toHaveLength(2);
  } finally { await h.dispose(); }
});

test("64c: Pi does not borrow a due closed-session Dreamer target", async () => {
  const h = host({ "noting.triggerTokens": 1_000_000 });
  try {
    await h.turn();
    const store = h.memory.store, projectId = store.getSession(1)!.projectId;
    const closed = store.createSession({ host: "closed-dreamer", projectId, enrollmentChoice: true,
      startedAt: "now", firstReplyAt: "now" });
    const turn = store.appendTurn({ sessionId: closed.id, kind: "turn", userPrompt: "closed evidence", startedAt: "now" });
    const entry = h.memory.appendEntry({ sessionId: closed.id, turnId: turn.id, nativeLineage: "closed", nativeId: "closed-entry",
      role: "user", text: "closed evidence", raw: "closed evidence", calls: [] });
    h.memory.selectEntries(closed.id, "main", [entry.id]);
    const noted = legacyFacts(store, { kind: "manual", sessionId: closed.id, createdAt: "now" },
      [{ sources: [{ entry, address: `T${turn.id}#E${entry.entryOrdinal}` }], actor: "user", category: "decision",
        text: "closed rule", createdAt: "now" }], [entry.id]);
    // A Noter-written item makes the closed session's Dreamer due (2026-10-22).
    knowledge(store, { sessionId: closed.id, branch: "main", headTurnId: turn.id }, "session", "constraint", [noted.facts[0]!.id], "closed rule", { operation: { title: "Fixture title" } });
    store.closeSession(closed.id);
    h.memory.config.dreaming.triggerOperations = 1;
    expect(h.memory.taskEligibility("dreaming", { sessionId: closed.id, branch: "main", headTurnId: turn.id })).toEqual({ due: true });

    await h.prompt("one executor opportunity");
    await h.answer("completed");
    await h.drain();
    expect(h.conversations.some(conversation => conversation.systemPrompt?.startsWith("# Dreamer"))).toBe(false);
    expect(h.memory.store.listRuns(closed.id).filter(run => run.kind === "consolidation")).toEqual([]);
    expect(store.listRuns(closed.id).filter(run => run.kind === "dreaming")).toEqual([]);
  } finally { await h.dispose(); }
});
