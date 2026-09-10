// Ticket 31 "One-shot knowledge supplement on project change and memory re-enable" (parent 29): the
// initial knowledge injection (29d) and the supplement are one selection with two triggers. These
// cases pin the trigger set, what repeats, the budget, and — the part an implementation could
// silently get wrong — that a generation is completed by the persistence of its own message.
import { expect, test } from "vitest";
import { host } from "./test-host.ts";
import { fixture } from "./native-fixture.ts";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { budgetKnowledge } from "../../../src/core/render/index.ts";
import { finish, knowledgeBlock } from "../../../src/core/api/index.ts";

const time = "2026-09-06T00:00:00Z";
type Host = ReturnType<typeof host>;

/** One committed fact on session 1's first turn, to support the knowledge below. */
const fact = (h: Host, text: string) => {
  const recorded = h.memory.store.commitNotingRun({ run: { kind: "noting", sessionId: 1, createdAt: time },
    facts: [{ turnId: 1, category: "decision", actor: "user", text, source: ["T1#user"], createdAt: time }] });
  if (!recorded.ok) throw new Error(recorded.problems.join("; "));
  return recorded.facts[0]!.id;
};
/** One `create` per text, in the given scope, committed as one Consolidation run. */
const create = (h: Host, supports: number, scope: "project" | "global", ...texts: string[]) => {
  const commit = h.memory.store.commitConsolidationRun({ run: { kind: "consolidation", sessionId: 1, createdAt: time },
    operations: texts.map((text, i) => ({ op: "create" as const, topics: [], reason: "Initial admission of this conclusion." as const,
      handle: `$c${Date.now()}${i}`, author: "fixture", text, category: "constraint" as const, scope, supports: [supports], createdAt: time })) });
  expect(commit.ok).toBe(true);
};
/** A new revision of one knowledge item, committed by a Consolidator of another session in the same
 * project. That is the only way this commit can happen while *this* session's memory is off: the store
 * refuses a write for a disabled session, and a peer's worker is not disabled by our switch. */
const reviseFromPeer = (h: Host, knowledgeId: number, baseCommit: number, text: string) => {
  const store = h.memory.store;
  const peer = store.createSession({ enrollmentChoice: true, host: "peer", projectId: store.getSession(1)!.projectId, startedAt: time, firstReplyAt: time });
  const turn = store.appendTurn({ sessionId: peer.id, kind: "turn", startedAt: time, userPrompt: "peer" });
  const recorded = store.commitNotingRun({ run: { kind: "noting", sessionId: peer.id, createdAt: time },
    facts: [{ turnId: turn.id, category: "decision", actor: "user", text, source: [`T${turn.id}#user`], createdAt: time }] });
  if (!recorded.ok) throw new Error(recorded.problems.join("; "));
  const commit = store.commitConsolidationRun({ run: { kind: "consolidation", sessionId: peer.id, createdAt: time },
    operations: [{ op: "update", topics: [], reason: "Substantive correction of the recorded conclusion.",
      knowledgeId, baseCommit, text, category: "constraint", scope: "project", supports: [recorded.facts[0]!.id], createdAt: time }] });
  expect(commit.ok).toBe(true);
};
const command = (h: Host, line: string) => h.commands.get("trace")!.handler(line, h.ctx);
const carrierOf = (message: any) => message.details.traceMemory as { generation?: number; supplied: { knowledgeCommitIds: number[] } };
/** A prompt whose message Pi persisted, followed by a reply and a settle. */
const served = async (h: Host, prompt: string) => {
  const message = (await h.prompt(prompt))?.message;
  await h.answer(); await h.emit("agent_settled"); await h.drain();
  return message;
};

/** A live session whose first prompt injected the initial block, with one visible project constraint. */
async function seeded(config: Record<string, unknown> = {}) {
  const h = host(config);
  await h.prompt(); await h.answer(); // allocates session 1 and turn 1; the empty store injects nothing
  const f = fact(h, "用 pnpm");
  create(h, f, "project", "项目用 pnpm。");
  const initial = await served(h, "second");
  expect(initial.content).toContain("项目用 pnpm。");
  return { h, fact: f };
}

test("31: one knowledge supplement after a project change or re-enable, never a running delivery", async () => {
  const { h, fact: f } = await seeded();
  try {
    // A background commit alone triggers nothing: 29d's rule is unchanged for everything but the two
    // commands, so the ordinary prompt after it carries no material at all.
    create(h, f, "project", "项目用 vitest。");
    expect((await h.prompt("ordinary"))?.message).toBeUndefined();
    await h.answer(); await h.emit("agent_settled"); await h.drain();
    // A branch switch is not a trigger either — it moves position, it does not request anything.
    await h.emit("session_tree");
    expect((await h.prompt("after the switch"))?.message).toBeUndefined();
    await h.answer(); await h.emit("agent_settled"); await h.drain();
    // The `on` command is. One prompt carries the delta, and every prompt after it carries nothing:
    // this is one shot, not a delivery loop that keeps draining what workers commit.
    await command(h, "on");
    const supplement = await served(h, "after on");
    expect(supplement.content).toContain("项目用 vitest。");
    expect(supplement.content).not.toContain("项目用 pnpm。"); // visible at the same commit: never repeated
    expect(carrierOf(supplement).generation).toBe(1);
    create(h, f, "project", "项目用 tsc。");
    expect((await h.prompt("later"))?.message).toBeUndefined();
  } finally { await h.dispose(); }
});

test.each([10_000, 20_000])("31 / 32a one path: initial and supplement produce identical text at the same configured budget (%i)", async budget => {
  const h = host({ "render.knowledgeBlockTokens": budget });
  try {
    await h.prompt(); await h.answer();
    const f = fact(h, "用 pnpm");
    create(h, f, "project", ...Array.from({ length: 12 }, (_, i) => `Rule ${i}: ` + "word ".repeat(1_900)));
    // The 29d layout, recomputed here from the applicable set alone: no visible view, no subtraction,
    // no status line. The initial trigger only ever fires on a context with no knowledge commits, so
    // this is what the one selection must still produce.
    const active = budgetKnowledge(h.memory.store.listVisibleKnowledge(1, h.memory.store.getSession(1)!.projectId),
      budget);
    const expected = finish({ content: knowledgeBlock({ knowledge: active.groups, receipts: [] }), receipts: active.receipts });
    const injected = (await h.emit("before_agent_start", { prompt: "second", systemPrompt: "host" }))?.message;
    expect(injected.content).toBe(expected);
    expect(carrierOf(injected).supplied.knowledgeCommitIds).toEqual(active.commits);
    expect(carrierOf(injected).generation).toBeUndefined(); // the initial trigger serves no generation
    expect(active.receipts.length).toBeGreaterThan(0); // both configured caps bind
    // The first hand-over is not persisted, so both triggers see exactly the same visible set.
    await command(h, "on");
    const supplement = (await h.emit("before_agent_start", { prompt: "supplement", systemPrompt: "host" }))?.message;
    expect(supplement.content).toBe(injected.content);
    expect(carrierOf(supplement).supplied.knowledgeCommitIds).toEqual(active.commits);
    expect(carrierOf(supplement).generation).toBe(1);
  } finally { await h.dispose(); }
});

test("31 project command: the next prompt carries the new project's knowledge by commit, and nothing already visible", async () => {
  const { h, fact: f } = await seeded();
  try {
    const store = h.memory.store;
    const b = store.createProject({ name: "beta", declaredBy: "mark" });
    const peer = store.createSession({ enrollmentChoice: true, host: "peer", projectId: b.id, startedAt: time, firstReplyAt: time });
    const turn = store.appendTurn({ sessionId: peer.id, kind: "turn", startedAt: time, userPrompt: "beta" });
    const recorded = store.commitNotingRun({ run: { kind: "noting", sessionId: peer.id, createdAt: time },
      facts: [{ turnId: turn.id, category: "decision", actor: "user", text: "beta", source: [`T${turn.id}#user`], createdAt: time }] });
    if (!recorded.ok) throw new Error("seed");
    const seededCommit = store.commitConsolidationRun({ run: { kind: "consolidation", sessionId: peer.id, createdAt: time },
      operations: [{ op: "create", topics: [], reason: "Initial admission of this conclusion.", handle: "$b1", author: "peer",
        text: "beta 项目规则", category: "constraint", scope: "project", supports: [recorded.facts[0]!.id], createdAt: time }] });
    expect(seededCommit.ok).toBe(true);
    // 项目用 pnpm。 was created before any declaration, so it moves with the session's own project into
    // beta and stays visible at the same commit; only beta's own knowledge is new here.
    await command(h, "project beta");
    const message = (await h.prompt("after project"))?.message;
    expect(message.content).toContain("beta 项目规则");
    expect(message.content).not.toContain("项目用 pnpm。");
    expect(carrierOf(message).supplied.knowledgeCommitIds).toEqual([2]);
    expect(carrierOf(message).generation).toBe(1);
  } finally { await h.dispose(); }
});

test("31 A→B→A: the return leg supplies nothing when the first block was complete", async () => {
  const { h } = await seeded();
  try {
    const store = h.memory.store;
    // One named project per leg, each with knowledge of its own committed by a peer session.
    const seedProject = (name: string, text: string) => {
      const project = store.createProject({ name, declaredBy: "mark" });
      const peer = store.createSession({ enrollmentChoice: true, host: "peer", projectId: project.id, startedAt: time, firstReplyAt: time });
      const turn = store.appendTurn({ sessionId: peer.id, kind: "turn", startedAt: time, userPrompt: name });
      const recorded = store.commitNotingRun({ run: { kind: "noting", sessionId: peer.id, createdAt: time },
        facts: [{ turnId: turn.id, category: "decision", actor: "user", text, source: [`T${turn.id}#user`], createdAt: time }] });
      if (!recorded.ok) throw new Error(recorded.problems.join("; "));
      const commit = store.commitConsolidationRun({ run: { kind: "consolidation", sessionId: peer.id, createdAt: time },
        operations: [{ op: "create", topics: [], reason: "Initial admission of this conclusion.", handle: "$p1", author: "peer",
          text, category: "constraint", scope: "project", supports: [recorded.facts[0]!.id], createdAt: time }] });
      expect(commit.ok).toBe(true);
    };
    seedProject("alpha", "alpha 规则");
    seedProject("beta", "beta 规则");
    await command(h, "project alpha");
    expect((await served(h, "in alpha")).content).toContain("alpha 规则");
    await command(h, "project beta");
    expect((await served(h, "in beta")).content).toContain("beta 规则");
    // Back in alpha: every applicable commit is visible at the same version, so the delta is empty and
    // the generation completes with no message. Nothing about the round trip repeats a block.
    await command(h, "project alpha");
    expect((await h.prompt("back in alpha"))?.message).toBeUndefined();
  } finally { await h.dispose(); }
});

test("31 on command: a revision committed while memory was off arrives with the status line of the visible predecessor", async () => {
  const { h, fact: f } = await seeded();
  try {
    await command(h, "off");
    reviseFromPeer(h, 1, 1, "项目用 pnpm 与 vitest。");
    await command(h, "on");
    const supplement = await served(h, "after on");
    expect(supplement.content).toContain("[K1@2]");
    expect(supplement.content).toContain("K1@1 is superseded by K1@2 above");
    expect(carrierOf(supplement).supplied.knowledgeCommitIds).toEqual([2]);
    // `on` while already on, with everything visible: the delta is empty, so no message is sent and
    // the generation is completed anyway — a commit made afterwards is not carried by it.
    await command(h, "on");
    expect((await h.prompt("on while on"))?.message).toBeUndefined();
    await h.answer(); await h.emit("agent_settled"); await h.drain();
    create(h, f, "project", "项目用 tsc。");
    expect((await h.prompt("after the completed generation"))?.message).toBeUndefined();
  } finally { await h.dispose(); }
});

test("31 not triggered: a rewind to before the first injection re-injects through the initial condition alone", async () => {
  const { h } = await seeded();
  try {
    const at = h.entries.findIndex(e => e.type === "custom_message"); // the injected message itself
    h.entries.splice(at, h.entries.length - at); // the leaf is now the entry before it
    await h.emit("session_tree");
    // No command ran, so no generation is open; the selected context simply holds no injection any
    // more, which is 29d's own condition and is satisfied on its own.
    const again = (await h.prompt("rewound"))?.message;
    expect(again.content).toContain("项目用 pnpm。");
    expect(carrierOf(again).generation).toBeUndefined();
  } finally { await h.dispose(); }
});

test("31 final state: off before the next prompt injects nothing and keeps the generation open; on again supplies once", async () => {
  const { h, fact: f } = await seeded();
  try {
    create(h, f, "project", "项目用 vitest。");
    await command(h, "on");  // generation 1
    await command(h, "off"); // no prompt ran in between
    expect((await h.prompt("while off"))?.message).toBeUndefined();
    await command(h, "on");  // generation 2; the final state is what the next prompt is served from
    const supplement = await served(h, "back on");
    expect(supplement.content).toContain("项目用 vitest。");
    expect(carrierOf(supplement).generation).toBe(2);
    expect((await h.prompt("after"))?.message).toBeUndefined(); // processed once, by the final state
  } finally { await h.dispose(); }
});

test("31 budget: an over-budget delta is cut with a receipt, and the following prompt carries nothing though the turn never settled", async () => {
  // A cap that holds one item and its omission receipt: the initial block carries the first constraint
  // and names the rest, so the omitted ones are candidates again at the next trigger.
  const h = host({ "render.knowledgeBlockTokens": 60 });
  try {
    await h.prompt(); await h.answer();
    const f = fact(h, "用 pnpm");
    create(h, f, "project", "AAAA", "BBBB", "CCCC");
    const initial = (await h.prompt("second"))?.message;
    expect(initial.content).toContain("omitted");
    const carriedFirst = carrierOf(initial).supplied.knowledgeCommitIds;
    expect(carriedFirst).toEqual([1]);
    // No reply, no settle: the message is persisted, and that alone is what a later trigger subtracts
    // against. A→B→A's return leg supplies exactly the remainder the budget cut, never a repeat.
    await command(h, "on");
    const supplement = (await h.prompt("after on"))?.message;
    expect(carrierOf(supplement).supplied.knowledgeCommitIds).toEqual([2, 3]);
    expect(supplement.content).not.toContain("AAAA"); // the commit the first block carried is not repeated
    // 31 "Completion": this message is persisted, so its generation is complete even though the turn
    // never settled. The remainder the budget omitted is not re-supplied for it.
    expect((await h.prompt("next"))?.message).toBeUndefined();
  } finally { await h.dispose(); }
});

test("31 completion is persistence: a turn that aborts before the entry is saved supplies again, and a command in flight opens a new generation", async () => {
  const { h, fact: f } = await seeded();
  try {
    create(h, f, "project", "项目用 vitest。");
    await command(h, "on"); // generation 1
    // `before_agent_start` alone: the handler returned a message, and Pi never persisted it (the turn
    // aborted before the prompt was sent). Returning it is not completion.
    const handed = await h.emit("before_agent_start", { prompt: "aborted", systemPrompt: "host" });
    expect(handed.message.content).toContain("项目用 vitest。");
    expect(carrierOf(handed.message).generation).toBe(1);
    const retried = (await h.prompt("retried"))?.message;
    expect(retried.content).toContain("项目用 vitest。");
    expect(carrierOf(retried).generation).toBe(1); // the same generation, supplied again
    // That message IS persisted. A command issued while its turn is still in flight opens generation
    // 2, which the generation-1 carrier can never consume.
    create(h, f, "project", "项目用 tsc。");
    await command(h, "on");
    const next = (await h.prompt("in flight"))?.message;
    expect(next.content).toContain("项目用 tsc。");
    expect(next.content).not.toContain("项目用 vitest。");
    expect(carrierOf(next).generation).toBe(2);
  } finally { await h.dispose(); }
});


test.each(["on", "project tree-project"])("31 pending %s survives tree selection and reopen without importing sibling visibility", async line => {
  const { h, fact: f } = await seeded();
  try {
    const selected = [...h.entries];
    create(h, f, "project", "New knowledge after the initial block.");
    await command(h, line);
    h.entries.splice(0, h.entries.length, ...selected);
    await h.emit("session_tree");
    // Reopening the same persisted session must not erase the pending command either.
    await h.emit("session_start");
    const handed = await h.emit("before_agent_start", { prompt: "not saved", systemPrompt: "host" });
    expect(carrierOf(handed.message).generation).toBe(1);
    h.entries.splice(0, h.entries.length, ...selected);
    await h.emit("session_tree");
    const persisted = (await h.prompt("saved"))?.message;
    expect(persisted.content).toContain("New knowledge after the initial block.");
    expect(carrierOf(persisted).generation).toBe(1);
    // The persisted sibling message consumes intent, not visibility. Rewinding does not create a
    // new command, nor does its invisible content leak into the selected path's view.
    h.entries.splice(0, h.entries.length, ...selected);
    await h.emit("session_tree");
    expect((await h.prompt("no new command"))?.message).toBeUndefined();
    await command(h, "on");
    const next = (await h.prompt("new command"))?.message;
    expect(carrierOf(next).generation).toBe(2);
    expect(next.content).toContain("New knowledge after the initial block.");
  } finally { await h.dispose(); }
});


test("31 native session: command survives branch rewind and only its persisted carrier completes it", async () => {
  const f = await fixture({ "noting.triggerTokens": 1e9, "consolidation.triggerTokens": 1e9 });
  try {
    await f.turn();
    const support = fact(f.h, "Native support");
    create(f.h, support, "project", "Native initial knowledge");
    await f.turn("initial injection");
    const selected = f.manager().getLeafId()!;
    create(f.h, support, "project", "Native pending supplement");
    await command(f.h, "on");
    f.manager().branch(selected);
    await f.h.emit("session_tree");
    const handed = await f.h.emit("before_agent_start", { prompt: "pending" });
    expect(handed.message.content).toContain("Native pending supplement");
    expect(carrierOf(handed.message).generation).toBe(1);
    const message = handed.message;
    const persisted = f.manager().appendCustomMessageEntry(message.customType, message.content, message.display, message.details);
    const reopened = SessionManager.open(f.manager().getSessionFile()!);
    expect(reopened.getEntry(persisted)).toMatchObject({ type: "custom_message",
      details: { traceMemory: { generation: 1, supplied: { knowledgeCommitIds: [2] } } } });
    f.manager().branch(selected);
    await f.h.emit("session_tree");
    expect((await f.h.emit("before_agent_start", { prompt: "already completed" }))?.message).toBeUndefined();
  } finally { await f.dispose(); }
});
