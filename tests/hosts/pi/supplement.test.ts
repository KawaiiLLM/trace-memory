// Ticket 34c: foreground Knowledge delivery through the real Pi fake-host publication seam.
import { expect, test, vi } from "vitest";
import { host } from "./test-host.ts";
import { fixture } from "./native-fixture.ts";
import { knowledgeBatch, legacyFacts } from "../../support/seed.ts";
import { Store } from "../../../src/core/store/index.ts";

const time = "2026-09-12T00:00:00Z";
type Host = ReturnType<typeof host>;

const fact = (h: Host, text: string) => {
  const store = h.memory.store;
  const user = store.sourcePath(1, "main", 1).find(entry => store.getSourceEntry(entry.id)?.role === "user")!;
  return legacyFacts(store, { kind: "noting", sessionId: 1, createdAt: time },
    [{ sources: [{ entry: user, address: `T1#E${user.entryOrdinal}` }], category: "decision", actor: "user",
      text, createdAt: time }]).facts[0]!.id;
};
const create = (h: Host, support: number, scope: "project" | "global", ...texts: string[]) => {
  return knowledgeBatch(h.memory.store, h.memory.store.knowledgePath(1, "main", 1),
    texts.map(text => ({ author: "fixture", text, category: "constraint", scope, supports: [support],
      topics: [], reason: "record conclusion", createdAt: time })), { kind: "manual", createdAt: time }).committed;
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
    const user = store.appendSourceEntry({ sessionId: peer.id, turnId: turn.id, nativeLineage: "peer",
      nativeId: "other-user", role: "user", text: "other", raw: "other", calls: [] });
    const evidence = legacyFacts(store, { kind: "noting", sessionId: peer.id, createdAt: time },
      [{ sources: [{ entry: user, address: `T${turn.id}#E${user.entryOrdinal}` }], category: "decision",
        actor: "user", text: "other", createdAt: time }]).facts[0]!;
    knowledgeBatch(store, store.knowledgePath(peer.id, "main", turn.id),
      [{ author: "peer", text: "Other project rule.", category: "constraint", scope: "project",
        supports: [evidence.id], topics: [], reason: "other", createdAt: time }], { kind: "manual", createdAt: time });
    await command(h, "project other");
    expect((await served(h, "new project")).content).toContain("Other project rule.");
  } finally { await h.dispose(); }
});

test("34c/92 archive state has a persisted body-free receipt without a write tag", async () => {
  const { h, support } = await seeded();
  try {
    const archived = h.memory.store.commitConsolidationRun({ path: { sessionId: 1, branch: "main", headTurnId: 1 },
      run: { kind: "manual", sessionId: 1, branch: "main", createdAt: time }, operations: [{ op: "archive", kind: "budget", knowledgeId: 1,
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

// 97: Pi records each publication at emission and reads its delivered state from the per-node records.
const owner = (h: Host) => `pi:${h.ctx.sessionManager.getSessionId()}`;
const deliveredAt = (h: Host) => h.memory.store.deliveredKnowledge({ owner: owner(h), sessionId: 1, branch: "main",
  headTurnId: h.memory.store.listTurns(1).filter(turn => turn.kind === "turn").at(-1)!.id });
const compact = async (h: Host) => {
  const result = await h.emit("session_before_compact", { preparation: { tokensBefore: 100 } });
  h.compaction(result.compaction.summary);
  await h.emit("session_compact");
  return result.compaction;
};

test("97 a compaction's supplement restarts the delivered set; rewinding before it restores the earlier records", async () => {
  const { h, support } = await seeded();
  try {
    const before = [...h.entries];
    const [later] = create(h, support, "project", "Created before compaction.");
    const summary = await compact(h);
    expect(summary.summary).toContain("Created before compaction.");
    expect(summary.details.traceMemory.prompt).toMatch(/^[0-9a-f-]{36}$/);
    // The supplement is the compaction node's delivery: nothing is missing after it.
    expect((await h.prompt("after compaction"))?.message).toBeUndefined();
    // Back before the compaction, its supplement is not on the path; the earlier delivery is.
    h.entries.splice(0, h.entries.length, ...before);
    await h.emit("session_tree");
    const rewound = (await h.prompt("rewound"))?.message;
    expect(rewound.content).toContain("Created before compaction.");
    expect(rewound.content).not.toContain("Use pnpm.");
    expect(carrier(rewound).supplied.knowledgeCommitIds).toEqual([later!.commit]);
  } finally { await h.dispose(); }
});

test("97 a supplement whose delivery cannot be recorded is not published: the compaction leaves its Knowledge out", async () => {
  const { h, support } = await seeded();
  try {
    create(h, support, "project", "Created before compaction.");
    // The extension's own Store records; the host's observer Store is another instance.
    const record = vi.spyOn(Store.prototype, "recordKnowledgeDelivery").mockImplementationOnce(() => { throw new Error("injected record failure"); });
    const result = (await h.emit("session_before_compact", { preparation: { tokensBefore: 100 } })).compaction;
    expect(result.summary).not.toContain("Created before compaction.");
    expect(result.summary).not.toContain("Use pnpm.");
    expect(result.details.traceMemory.prompt).toBeUndefined();
    expect(result.details.traceMemory.supplied.knowledgeCommitIds).toEqual([]);
    h.compaction(result.summary);
    await h.emit("session_compact");
    // Nothing was claimed, so the next prompt delivers what the compaction left out.
    const next = await served(h, "after compaction");
    expect(next.content).toContain("Created before compaction.");
    expect(next.content).toContain("Use pnpm.");
    expect(record).toHaveBeenCalledTimes(2);
  } finally { vi.restoreAllMocks(); await h.dispose(); }
});

test("97 a native compaction restarts the set empty; a compaction Pi never appends records nothing on the path", async () => {
  const { h } = await seeded();
  try {
    // Pi's own compaction carries none of ours: it is a node whose delivery is empty.
    h.compaction("native summary");
    await h.emit("session_compact");
    expect((await served(h, "after native compaction")).content).toContain("Use pnpm.");
    const delivered = deliveredAt(h);
    expect(delivered.knowledgeCommitIds.size).toBe(1);
    // The supplement is recorded at emission, but no compaction entry and no session_compact follow.
    await h.emit("session_before_compact", { preparation: { tokensBefore: 100 } });
    expect(deliveredAt(h)).toEqual(delivered);
    expect((await h.prompt("after cancelled compaction"))?.message).toBeUndefined();
  } finally { await h.dispose(); }
});

test("97 transition: carriers from before 97 are not read; one delivery within budget, then nothing while unchanged", async () => {
  const h = host({ "noting.triggerTokens": 1e9, "compaction.sharedAllowanceTokens": 1 });
  try {
    await h.prompt(); await h.answer();
    const support = fact(h, "use pnpm");
    const created = create(h, support, "project", ...["First", "Second", "Third"].map(name =>
      `${name} rule. ${Array.from({ length: 60 }, (_, i) => `${name.toLowerCase()}${i}`).join(" ")}`));
    // A pre-97 carrier claims every version; it names no delivery record.
    h.persist({ role: "custom", customType: "trace-memory", content: "legacy", display: false, details: { traceMemory: {
      db: h.dbPath, session: 1, pi: h.ctx.sessionManager.getSessionId(),
      supplied: { entries: [], factIds: [], knowledgeCommitIds: created.map(item => item.commit) } } } });
    for (const field of ["global", "project", "session"] as const) h.memory.store.setKnowledgeBudget(field, field === "project" ? 300 : 0);
    const first = await served(h, "first after deployment");
    const ids = carrier(first).supplied.knowledgeCommitIds;
    expect(ids.length).toBeGreaterThan(0);
    expect(ids.length).toBeLessThan(3);
    expect((await h.prompt("unchanged"))?.message).toBeUndefined();
  } finally { await h.dispose(); }
});
