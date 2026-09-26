import { expect, test, vi } from "vitest";
import { host, reply } from "./test-host.ts";
import { checkpointReadiness } from "../../../src/hosts/pi/native.ts";
// The native cases exercise fork checkpoint readiness; the ordinary host case runs fresh.
import { noteAndMemory, forkFixture as fixture, noteBatch, say, submitted, toolResults, worker, type Body } from "./native-fixture.ts";
import { hydrate } from "../../source-fixture.ts";

// 19c "Entry readiness and fallback": the scheduling thresholds keep their own authority (17b), and a
// due task launches only when its chosen native checkpoint is persisted, reopenable and free of an
// assistant tool-call group whose results are missing. Waiting starts nothing and advances nothing.

const long = "word ".repeat(400);
const notingRuns = (h: ReturnType<typeof host>) => h.memory.store.listRuns(1).filter(r => r.kind === "noting");

test("19c 2026-09-08: a message completion before persistence launches nothing; the next safe boundary launches once with a real entry id", async () => {
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
    // Persistence, then the next safe boundary. No provider request was ever captured for this
    // session (`before_provider_request` is never emitted in this test) and none is needed.
    const persisted = h.persist(completed);
    expect(notingRuns(h)).toEqual([]);
    await h.emit("message_start", { message: reply("") });
    await h.drain();
    const runs = notingRuns(h);
    expect(runs).toHaveLength(1);
    const audited = JSON.parse(runs[0]!.response!).entryAudit.entries as { nativeId: string }[];
    expect(audited.map(e => e.nativeId)).toContain(persisted.id); // the real entry id, not a synthesized one
    // Later boundaries are not new triggers: the same task is not launched a second time.
    await h.emit("agent_settled"); await h.emit("agent_end"); await h.drain();
    expect(notingRuns(h)).toHaveLength(1);
  } finally { await h.dispose(); }
});

test("64c: persisted assistant and tool-result entries each grant one mid-turn scheduling opportunity", async () => {
  const h = host({ "noting.forkModeDefault": false, "noting.triggerTokens": 10_000,
    "render.toolResultTokens": 1_000 });
  try {
    await h.prompt("Run a long tool sequence");
    const calls = Array.from({ length: 12 }, (_value, index) => ({ type: "toolCall" as const,
      id: `long-${index}`, name: "bash", arguments: { command: `step ${index}` } }));
    const assistant = { ...reply("Working."), content: [{ type: "text" as const, text: "Working." }, ...calls] };
    await h.emit("message_end", { message: assistant });
    expect(hydrate(h.memory.store.listSourceEntries(1), h.memory.store).map(entry => entry.role)).toEqual(["user"]);

    // Pi has persisted the assistant by tool preflight. The first hook ingests it; a duplicate hook
    // sees the same leaf and grants no duplicate opportunity.
    await h.emit("tool_execution_start", { toolCallId: calls[0]!.id, toolName: "bash", args: calls[0]!.arguments });
    await h.emit("tool_execution_start", { toolCallId: calls[0]!.id, toolName: "bash", args: calls[0]!.arguments });
    expect(hydrate(h.memory.store.listSourceEntries(1), h.memory.store).map(entry => entry.role)).toEqual(["user", "assistant"]);

    // Each result is persisted by Pi's final message lifecycle and reconciled before the next model
    // turn. Twelve bounded result views cross the real 10k Noter threshold before agent_end.
    for (const call of calls) await h.emit("tool_result", { toolCallId: call.id, toolName: "bash", input: call.arguments,
      content: [{ type: "text", text: `${call.id} ${"word ".repeat(6_000)}` }], details: {}, isError: false });
    const run = await vi.waitFor(() => { const values = notingRuns(h); expect(values).toHaveLength(1); return values[0]!; }, { timeout: 5000 });
    expect(run.origin?.entryIds.at(-1)).toBeLessThanOrEqual(hydrate(h.memory.store.listSourceEntries(1), h.memory.store).at(-1)!.id);
    expect(h.memory.store.listRuns(1).filter(value => value.kind === "noting")).toHaveLength(1);
    await h.emit("message_start", { message: reply("") });
    await h.emit("agent_end");
    await h.drain();
    expect(notingRuns(h)).toHaveLength(1); // duplicate lifecycle hooks and worker completion do not drain
  } finally { await h.dispose(); }
});

test("64c: Pi does not borrow a due closed-session Dreamer target", async () => {
  const h = host({ "noting.triggerTokens": 1_000_000, "consolidation.triggerTokens": 1_000_000 });
  try {
    await h.turn();
    const store = h.memory.store, projectId = store.getSession(1)!.projectId;
    const closed = store.createSession({ host: "closed-dreamer", projectId, enrollmentChoice: true,
      startedAt: "now", firstReplyAt: "now" });
    const turn = store.appendTurn({ sessionId: closed.id, kind: "turn", userPrompt: "closed evidence", startedAt: "now" });
    const entry = h.memory.appendEntry({ sessionId: closed.id, turnId: turn.id, nativeLineage: "closed", nativeId: "closed-entry",
      role: "user", text: "closed evidence", raw: "closed evidence", calls: [] });
    h.memory.selectEntries(closed.id, "main", [entry.id]);
    const noted = store.commitNotingRun({ run: { kind: "manual", sessionId: closed.id, createdAt: "now" }, entryIds: [entry.id],
      facts: [{ turnId: turn.id, source: [`T${turn.id}#user`], actor: "user", category: "decision", text: "closed rule", createdAt: "now" }] });
    if (!noted.ok) throw new Error(noted.problems.join("; "));
    const created = store.commitConsolidationRun({ run: { kind: "manual", sessionId: closed.id, createdAt: "now" }, operations: [{ op: "create",
      handle: "$closed", author: "test", text: "closed ".repeat(1_000), category: "constraint", scope: "session",
      supports: [noted.facts[0]!.id], topics: [], reason: "closed session test", createdAt: "now" }] });
    if (!created.ok) throw new Error(created.problems.join("; "));
    store.closeSession(closed.id);
    expect(h.memory.taskEligibility("dreaming", { sessionId: closed.id, branch: "main", headTurnId: turn.id })).toEqual({ due: true });

    await h.prompt("one executor opportunity");
    await h.answer("completed");
    await h.drain();
    expect(h.conversations.some(conversation => conversation.systemPrompt?.includes("You are the Consolidator:"))).toBe(true);
    expect(h.conversations.some(conversation => conversation.systemPrompt?.startsWith("# Dreamer"))).toBe(false);
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
    // A boundary inside the same foreground Turn: no agent_settled, no second parent request.
    await f.h.emit("message_start", { message: { role: "user", content: "next", timestamp: 1 } });
    const run = await vi.waitFor(() => { const r = f.h.memory.store.listRuns(1)[0]; expect(r?.response).toBeTruthy(); return r!; }, { timeout: 5000 });
    expect(run.mode).toBe("fork");
    expect(JSON.parse(run.response!).verification.passed).toBe(true);
    expect(f.sent.filter(body => !worker(body))).toHaveLength(1); // one parent request, and it was the captured one
    expect(f.h.memory.store.listRuns(1)).toHaveLength(1);
  } finally { await f.dispose(); }
});

test("19c 2026-09-08: a checkpoint with an unanswered tool call defers the launch; the completed group launches it once", async () => {
  const f = await fixture();
  try {
    let unanswered = "";
    // No facts in either batch: a noting delivery would pause the next inherited-context task on
    // 17b's own rule, which is not what this test is about.
    // 26a: an empty batch is submitted explicitly, and still creates no delivery.
    f.script(body => !worker(body) ? say("好的。") : submitted(body) ? say("Done.") : noteAndMemory("t1", { facts: [] }));
    await f.turn();
    await vi.waitFor(() => expect(notingRuns(f.h)).toHaveLength(1), { timeout: 5000 });
    // New foreground activity that ends inside an assistant tool-call group: due, but not a safe
    // boundary. The tool result is the foreground's to produce; a worker must never invent it.
    f.manager().appendMessage({ role: "user", content: long, timestamp: 1 } as never);
    unanswered = f.manager().appendMessage({ role: "assistant", api: "openai-completions", provider: "fake", model: "test", stopReason: "toolUse",
      content: [{ type: "toolCall", id: "tc9", name: "read", arguments: { path: "/etc/hosts" } }], timestamp: 1 } as never);
    expect(unanswered).toBeTruthy();
    await f.h.emit("message_start", { message: reply("") });
    await f.h.drain();
    const head = () => f.h.memory.store.listTurns(1).at(-1)!.id;
    expect(checkpointReadiness(f.original.file, f.manager().getLeafId()!)).toContain("tc9");
    expect(notingRuns(f.h)).toHaveLength(1); // deferred: no second task, no claim, no progress
    const pendingAtWait = f.h.memory.pendingEntries(1, "main", head()).map(e => e.id);
    expect(pendingAtWait.length).toBeGreaterThan(0);
    // The foreground completes the group: the same due task now launches, once, as a fork.
    f.manager().appendMessage({ role: "toolResult", toolCallId: "tc9", toolName: "read", isError: false,
      content: [{ type: "text", text: "ok" }], details: {}, timestamp: 1 } as never);
    expect(checkpointReadiness(f.original.file, f.manager().getLeafId()!)).toBeUndefined();
    await f.h.emit("message_start", { message: reply("") });
    const second = await vi.waitFor(() => { const runs = notingRuns(f.h); expect(runs).toHaveLength(2); expect(runs[1]!.response).toBeTruthy(); return runs[1]!; }, { timeout: 5000 });
    expect(second.mode).toBe("fork"); // the deferral did not cost the task its inherited context
    expect(JSON.parse(second.response!).fallbackReason).toBeUndefined();
    expect(f.h.memory.pendingEntries(1, "main", head())).toEqual([]);
  } finally { await f.dispose(); }
}, 20000);

test("19c 2026-09-08: a tree switch before the launch does not substitute the new branch's history for the waiting task", async () => {
  const f = await fixture();
  try {
    f.script(body => !worker(body) ? say("好的。")
      : toolResults(body) ? say("Done.") : say("Nothing to note."));
    await f.turn();
    await vi.waitFor(() => expect(notingRuns(f.h)).toHaveLength(1), { timeout: 5000 });
    const beforeSwitch = f.h.memory.store.listRuns(1)[0]!.branch;
    // Due work whose checkpoint is not a safe boundary yet: it waits.
    f.manager().appendMessage({ role: "user", content: long, timestamp: 1 } as never);
    const waiting = f.manager().appendMessage({ role: "assistant", api: "openai-completions", provider: "fake", model: "test", stopReason: "toolUse",
      content: [{ type: "toolCall", id: "tc9", name: "read", arguments: { path: "/etc/hosts" } }], timestamp: 1 } as never);
    await f.h.emit("message_start", { message: reply("") });
    await f.h.drain();
    expect(notingRuns(f.h)).toHaveLength(1);
    // The user switches the tree. The waiting launch context is invalidated, not retargeted: the
    // capture belongs to the old position and the memory branch identity changes with the switch.
    f.manager().branch(f.manager().getBranch()[1]!.id);
    await f.h.emit("session_tree", {}); // 17b: the switch itself launches nothing
    await f.h.drain();
    expect(notingRuns(f.h)).toHaveLength(1);
    // Work continues on the new position. Its own entries are its own task.
    f.manager().appendMessage({ role: "user", content: long + " elsewhere", timestamp: 1 } as never);
    f.manager().appendMessage({ ...reply("a different answer"), timestamp: 1 } as never);
    await f.h.emit("message_start", { message: reply("") });
    const second = await vi.waitFor(() => { const runs = notingRuns(f.h); expect(runs).toHaveLength(2); expect(runs[1]!.response).toBeTruthy(); return runs[1]!; }, { timeout: 5000 });
    expect(second.branch).not.toBe(beforeSwitch); // a different memory branch: not the waiting task
    expect(second.mode).toBe("subagent"); // no capture for this branch, so no inherited context
    const response = JSON.parse(second.response!);
    expect(response.requestedMode).toBe("fork");
    expect(response.fallbackReason).toContain("No current-branch provider payload captured");
    // The waiting task's own entries are neither covered nor advanced by this run.
    expect((response.entryAudit.entries as { nativeId: string }[]).map(e => e.nativeId)).not.toContain(waiting);
    expect(hydrate(f.h.memory.pendingEntries(1, beforeSwitch!, 2), f.h.memory.store).length).toBeGreaterThan(0);
  } finally { await f.dispose(); }
}, 20000);

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
