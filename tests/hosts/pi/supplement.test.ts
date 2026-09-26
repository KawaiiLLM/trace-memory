// Ticket 34c: foreground Knowledge delivery through the real Pi fake-host publication seam.
import { expect, test } from "vitest";
import { host } from "./test-host.ts";
import { fixture } from "./native-fixture.ts";

const time = "2026-09-12T00:00:00Z";
type Host = ReturnType<typeof host>;

const fact = (h: Host, text: string) => {
  const recorded = h.memory.store.commitNotingRun({ run: { kind: "noting", sessionId: 1, createdAt: time },
    facts: [{ turnId: 1, category: "decision", actor: "user", text, source: ["T1#user"], createdAt: time }] });
  if (!recorded.ok) throw new Error(recorded.problems.join("; "));
  return recorded.facts[0]!.id;
};
const create = (h: Host, support: number, scope: "project" | "global", ...texts: string[]) => {
  const result = h.memory.store.commitConsolidationRun({ run: { kind: "manual", sessionId: 1, createdAt: time },
    operations: texts.map((text, index) => ({ op: "create" as const, handle: `$k${Date.now()}${index}`, author: "fixture", text,
      category: "constraint" as const, scope, supports: [support], topics: [], reason: "record conclusion", createdAt: time })) });
  if (!result.ok) throw new Error(result.problems.join("; "));
  return result.committed;
};
const command = (h: Host, line: string) => h.commands.get("trace")!.handler(line, h.ctx);
const carrier = (message: any) => message.details.traceMemory as { supplied: { knowledgeCommitIds: number[]; knowledgeStates?: unknown[] } };
const served = async (h: Host, prompt: string) => {
  const message = (await h.prompt(prompt))?.message;
  await h.answer(); await h.emit("agent_settled"); await h.drain();
  return message;
};
async function seeded(config: Record<string, unknown> = {}) {
  const h = host({ "noting.triggerTokens": 1e9, ...config });
  await h.prompt(); await h.answer();
  const support = fact(h, "use pnpm");
  create(h, support, "project", "Use pnpm.");
  const initial = await served(h, "initial delivery");
  expect(initial.content).toContain("Use pnpm.");
  return { h, support, initial };
}

test("34c ordinary prompts deliver newly missing Knowledge and saved exact carriers make checks idempotent", async () => {
  const { h, support } = await seeded();
  try {
    const [next] = create(h, support, "project", "Run vitest.");
    const delivered = await served(h, "ordinary prompt");
    expect(delivered.content).toContain("Run vitest.");
    expect(delivered.content).not.toContain("Use pnpm.");
    expect(carrier(delivered).supplied.knowledgeCommitIds).toEqual([next!.commit]);
    expect((carrier(delivered) as any).generation).toBeUndefined();
    expect((await h.prompt("unchanged"))?.message).toBeUndefined();
    await command(h, "on");
    expect((await h.prompt("already on"))?.message).toBeUndefined();
  } finally { await h.dispose(); }
});

test("34c an offered, failed or cancelled publication consumes nothing; a saved message needs no settled turn", async () => {
  const { h, support } = await seeded();
  try {
    create(h, support, "project", "Persist me exactly.");
    const offered = await h.emit("before_agent_start", { prompt: "aborted" });
    expect(offered.message.content).toContain("Persist me exactly.");
    const saved = (await h.prompt("retry"))?.message;
    expect(saved.content).toBe(offered.message.content);
    // The fake host persisted the custom message, but no assistant reply or settle is required.
    expect((await h.prompt("after persisted offer"))?.message).toBeUndefined();
  } finally { await h.dispose(); }
});

test("34c off pauses delivery; re-enable and project assignment only change the next predicate inputs", async () => {
  const { h, support } = await seeded();
  try {
    create(h, support, "project", "Created while off.");
    await command(h, "off");
    expect((await h.prompt("off"))?.message).toBeUndefined();
    await command(h, "on");
    expect((await served(h, "enabled")).content).toContain("Created while off.");

    const store = h.memory.store;
    const project = store.createProject({ name: "other", declaredBy: "mark" });
    const peer = store.createSession({ enrollmentChoice: true, host: "peer", projectId: project.id, startedAt: time, firstReplyAt: time });
    const turn = store.appendTurn({ sessionId: peer.id, kind: "turn", userPrompt: "other", startedAt: time });
    const noted = store.commitNotingRun({ run: { kind: "noting", sessionId: peer.id, createdAt: time }, facts: [
      { turnId: turn.id, category: "decision", actor: "user", text: "other", source: [`T${turn.id}#user`], createdAt: time }] });
    if (!noted.ok) throw new Error(noted.problems.join());
    const committed = store.commitConsolidationRun({ run: { kind: "manual", sessionId: peer.id, createdAt: time }, operations: [
      { op: "create", handle: "$other", author: "peer", text: "Other project rule.", category: "constraint", scope: "project",
        supports: [noted.facts[0]!.id], topics: [], reason: "other", createdAt: time }] });
    expect(committed.ok).toBe(true);
    await command(h, "project other");
    expect((await served(h, "new project")).content).toContain("Other project rule.");
  } finally { await h.dispose(); }
});

test("34c/92 archive state has a persisted body-free receipt without a write tag", async () => {
  const { h, support } = await seeded();
  try {
    const archived = h.memory.store.commitConsolidationRun({ path: { sessionId: 1, branch: "main", headTurnId: 1 },
      run: { kind: "manual", sessionId: 1, branch: "main", createdAt: time }, operations: [{ op: "archive", knowledgeId: 1,
        baseCommit: 1, supports: [support], reason: "withdraw", createdAt: time }] });
    if (!archived.ok) throw new Error(archived.problems.join());
    const notice = await served(h, "archive notice");
    expect(notice.content).toContain("K1@v1 is archived");
    expect(notice.content).not.toMatch(/K1#[a-z]+/);
    expect(carrier(notice).supplied.knowledgeCommitIds).toEqual([]);
    expect(carrier(notice).supplied.knowledgeStates).toEqual([{ fromCommit: 1, toCommits: [2] }]);
    expect((await h.prompt("archive unchanged"))?.message).toBeUndefined();
    // A state/history address is not a tagged base; there is no complete-read ledger.
    await expect(h.tools.get("memory")!.execute("call", { operations: [{ op: "update", id: "K1@v2", text: "illegal",
      category: "constraint", scope: "project", supports: [`F${support}`], topics: [], reason: "no handle" }], skipped: [] }, null, null, h.ctx))
      .rejects.toThrow("supply an exact K#tag");
  } finally { await h.dispose(); }
});

test("34c opaque native summaries and wrong-bound carriers establish no coverage", async () => {
  const { h, support } = await seeded();
  try {
    const [created] = create(h, support, "project", "Still missing after opaque text.");
    h.compaction(`Summary claims [K${created!.knowledgeId}@${created!.commit}] and F${support}.`);
    const afterSummary = await h.emit("before_agent_start", { prompt: "after native compact" });
    expect(afterSummary.message.content).toContain("Still missing after opaque text.");

    const wrong = structuredClone(afterSummary.message);
    wrong.details.traceMemory.db = "/another/database";
    h.persist({ role: "custom", ...wrong });
    expect((await h.emit("before_agent_start", { prompt: "wrong binding" })).message.content).toContain("Still missing after opaque text.");
  } finally { await h.dispose(); }
});

test("34c tree rewind and return recompute retained carrier coverage", async () => {
  const { h, support } = await seeded();
  try {
    const before = [...h.entries];
    create(h, support, "project", "Branch-only delivery.");
    await served(h, "branch delivery");
    const branch = [...h.entries];
    h.entries.splice(0, h.entries.length, ...before);
    await h.emit("session_tree");
    expect((await h.prompt("rewound"))?.message.content).toContain("Branch-only delivery.");
    h.entries.splice(0, h.entries.length, ...branch);
    await h.emit("session_tree");
    expect((await h.prompt("returned"))?.message).toBeUndefined();
  } finally { await h.dispose(); }
});

test("34c publication revalidation rejects a retargeted offer without persisting coverage", async () => {
  const { h, support } = await seeded();
  try {
    create(h, support, "project", "Do not publish on wrong leaf.");
    const original = h.ctx.sessionManager.getLeafId.bind(h.ctx.sessionManager);
    let reads = 0;
    (h.ctx.sessionManager as any).getLeafId = () => (++reads === 2 ? "retargeted" : original());
    expect((await h.emit("before_agent_start", { prompt: "race" }))?.message).toBeUndefined();
    (h.ctx.sessionManager as any).getLeafId = original;
    expect((await h.prompt("retry intended path"))?.message.content).toContain("Do not publish on wrong leaf.");
  } finally { await h.dispose(); }
});

test("34c real native-session carrier survives reopen and ordinary prompt checks need no command generation", async () => {
  const f = await fixture({ "noting.triggerTokens": 1e9, "consolidation.triggerTokens": 1e9 });
  try {
    await f.turn();
    const support = fact(f.h, "native support");
    create(f.h, support, "project", "Native Knowledge body.");
    await f.turn("publish body");
    const selected = f.manager().getLeafId()!;
    f.manager().branch(selected);
    await f.h.emit("session_tree");
    expect((await f.h.emit("before_agent_start", { prompt: "already visible" }))?.message).toBeUndefined();
  } finally { await f.dispose(); }
});
