import { expect, test, vi } from "vitest";
import { legacyFacts } from "../../support/seed.ts";
import { host, reply } from "./test-host.ts";
import { checkpointReadiness } from "../../../src/hosts/pi/native.ts";
// The native cases exercise fork checkpoint readiness; the ordinary host case runs fresh.
import { noteAndMemory, stableForkFixture as fixture, noteBatch, say, toolResults, worker } from "./native-fixture.ts";
import { hydrate } from "../../source-fixture.ts";

// A requested fork requires a persisted, reopenable checkpoint with no unanswered tool calls.
// Readiness refusal uses the existing fresh fallback; no task waits for a later hook.

const long = "word ".repeat(400);
const notingRuns = (h: ReturnType<typeof host>) => h.memory.store.listRuns(1).filter(r => r.kind === "noting");

test("19c 2026-09-08: a message completion before persistence launches nothing; settlement imports a real entry id", async () => {
  // Runner-independent: Pi's message-completion callback precedes persistence, and 17a reconciles
  // persisted entries only, so no runner ever sees an entry that is not in the session file yet.
  const h = host({ "noting.forkModeDefault": false, "noting.triggerTokens": 30 });
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
    expect(runs).toHaveLength(1);
    const audited = JSON.parse(runs[0]!.response!).entryAudit.entries as { nativeId: string }[];
    expect(audited.map(e => e.nativeId)).toContain(persisted.id); // the real entry id, not a synthesized one
    // Later boundaries are not new triggers: the same task is not launched a second time.
    await h.emit("agent_settled"); await h.emit("agent_end"); await h.drain();
    expect(notingRuns(h)).toHaveLength(1);
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
    const created = store.commitConsolidationRun({ run: { kind: "manual", sessionId: closed.id, createdAt: "now" }, operations: [{ op: "create",
      handle: "$closed", author: "test", text: "closed ".repeat(5_500), category: "constraint", scope: "session", // 104: summed pending reaches 5k
      supports: [noted.facts[0]!.id], topics: [], reason: "closed session test", createdAt: "now" }] });
    if (!created.ok) throw new Error(created.problems.join("; "));
    store.closeSession(closed.id);
    h.memory.config.dreaming.triggerTokens = 5_000;
    expect(h.memory.taskEligibility("dreaming", { sessionId: closed.id, branch: "main", headTurnId: turn.id })).toEqual({ due: true });

    await h.prompt("one executor opportunity");
    await h.answer("completed");
    await h.drain();
    expect(h.conversations.some(conversation => conversation.systemPrompt?.startsWith("# Dreamer"))).toBe(false);
    expect(h.memory.store.listRuns(closed.id).filter(run => run.kind === "consolidation")).toEqual([]);
    expect(store.listRuns(closed.id).filter(run => run.kind === "dreaming")).toEqual([]);
  } finally { await h.dispose(); }
});

test("19c 2026-09-08: a fork launches from the persisted checkpoint on the existing capture, without a further provider request", async () => {
  // "No capture dependency", read with gate 1: the fork's first body is still verified against the
  // latest captured parent request, so a capture must exist — but the launch never waits for a NEW
  // one. Here the only requests in the process are the parent's own turn and the child's.
  const f = await fixture();
  try {
    f.script(body => !worker(body) ? say("好的。") : toolResults(body) ? say("Done.") : noteAndMemory("t1", noteBatch));
    await f.h.emit("before_agent_start", { prompt: "用 pnpm，不要 npm" });
    await f.parent.prompt("用 pnpm，不要 npm");
    await f.h.emit("before_provider_request", { payload: f.sent[0] }); // the parent's one capture
    // No second parent request; the persisted final answer is this turn's checkpoint.
    await f.h.emit("agent_settled");
    const run = await vi.waitFor(() => { const r = f.h.memory.store.listRuns(1)[0]; expect(r?.response).toBeTruthy(); return r!; }, { timeout: 5000 });
    expect(run.mode).toBe("fork");
    expect(JSON.parse(run.response!).verification.passed).toBe(true);
    expect(f.sent.filter(body => !worker(body))).toHaveLength(1); // one parent request, and it was the captured one
    expect(f.h.memory.store.listRuns(1)).toHaveLength(1);
  } finally { await f.dispose(); }
});

test("19c 2026-09-08: the readiness probe rejects an unpersisted checkpoint and an unreadable parent file without creating anything", async () => {
  const f = await fixture();
  try {
    f.script(() => say("好的。"));
    await f.turn();
    expect(checkpointReadiness(f.original.file, f.manager().getLeafId()!)).toBeUndefined();
    expect(checkpointReadiness(f.original.file, "entry-that-was-never-written")).toContain("not persisted");
    expect(checkpointReadiness(`${f.h.dir}/absent.jsonl`, "e0")).toBeTruthy();
    expect(f.h.memory.store.listRuns(1).every(r => r.mode === "fork")).toBe(true);
  } finally { await f.dispose(); }
});
