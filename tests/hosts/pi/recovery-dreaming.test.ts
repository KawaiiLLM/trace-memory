import { expect, test, vi } from "vitest";
import { host, reply, type Reply } from "./test-host.ts";

const compact = (h: ReturnType<typeof host>, signal?: AbortSignal) =>
  h.emit("session_before_compact", { preparation: { tokensBefore: 100000 }, signal }) as Promise<any>;
const call = (id: string, name: string, args: Record<string, unknown>): Reply => ({ ...reply(""), stopReason: "toolUse", content: [{ type: "toolCall", id, name, arguments: args }] });
async function seeded(trigger = 5000, overflow = 50) {
  const h = host({ "noting.triggerTokens": 10000, "consolidation.triggerTokens": 5000,
    "dreaming.triggerTokens": trigger, "render.knowledgeBlockTokens": 100,
    "compaction.factsTokens": 10000, "compaction.rawTokens": 10000, "compaction.overflowTokens": overflow });
  await h.turn();
  const s = h.memory.store;
  const f = s.commitNotingRun({ run: { kind: "manual", sessionId: 1, createdAt: "seed" }, facts: [{ turnId: 1, source: ["T1#user"], actor: "user", category: "decision", text: "Keep this rule", createdAt: "seed" }] });
  if (!f.ok) throw Error(f.problems.join());
  const c = s.commitConsolidationRun({ run: { kind: "manual", sessionId: 1, createdAt: "seed" }, operations: [{ op: "create", handle: "$1", author: "test", text: "rule ".repeat(6000), category: "constraint", scope: "project", supports: [f.facts[0]!.id], topics: [], reason: "evidence", createdAt: "seed" }] });
  if (!c.ok) throw Error(c.problems.join());
  return { h, s, item: c.committed[0]! };
}
const workers = (h: ReturnType<typeof host>) => h.memory.store.listRuns(1).filter(r => r.createdAt !== "seed");

test.each([5000, 10000])("28: recovery launches a phase only at its own threshold — window overflow is not eligibility (%s)", async trigger => {
  const { h, item } = await seeded(trigger);
  try {
    h.provider(async c => {
      expect(c.systemPrompt).toContain("# Dreamer");
      return call("archive", "memory", { operations: [{ op: "archive", id: `K${item.knowledgeId}@${item.commit}`, supports: [], reason: "Deliberate retirement to meet the hard budget" }], skipped: [] });
    });
    const result = await compact(h);
    expect(workers(h).map(r => r.kind)).toEqual(trigger === 5000 ? ["dreaming"] : []);
    if (trigger === 5000) expect(result.compaction.summary).toBeTruthy();
    else { expect(result).toBeUndefined(); expect(h.notices.at(-1)).toContain("native delegation"); }
  } finally { await h.dispose(); }
});

test("32f: required excess covered by shared allowance launches zero workers", async () => {
  const { h } = await seeded(5000, 10000);
  try { expect((await compact(h)).compaction.summary).toContain("rule"); expect(h.requests).toEqual([]); }
  finally { await h.dispose(); }
});

test("32f: Dreamer partial failure is remeasured; a fitting archive keeps its diagnostic", async () => {
  const { h, item, s } = await seeded();
  try {
    let requests = 0;
    h.provider(async () => ++requests === 1
      ? call("archive", "memory", { operations: [{ op: "archive", id: `K${item.knowledgeId}@${item.commit}`, supports: [], reason: "Retire under budget pressure" }], skipped: [] })
      : { ...reply(""), stopReason: "error", errorMessage: "terminal recovery failure" }, { autoStop: false });
    const result = await compact(h);
    expect(result.compaction.summary).toContain("maintenance not completed");
    expect(workers(h)).toMatchObject([{ kind: "dreaming", outcome: "failure" }]);
    expect(s.isKnowledgeProcessed(s.listKnowledgeRevisions().at(-1)!.id)).toBe(false);
    expect(h.notices.join("\n")).toContain("terminal recovery failure");
  } finally { await h.dispose(); }
});

test.each([false, true])("28: a third failure inside recovery takes the native failure route, never an empty custom success (%s)", async cancel => {
  const { h, s } = await seeded();
  try {
    h.provider(async () => ({ ...reply(""), stopReason: "error", errorMessage: "failed Dreamer" }));
    await compact(h); await compact(h);
    const controller = new AbortController();
    const notify = h.ctx.ui.notify.bind(h.ctx.ui);
    vi.spyOn(h.ctx.ui, "notify").mockImplementation((message, level) => { notify(message, level); if (cancel && message.includes("off after three failures")) controller.abort(); });
    expect(await compact(h, controller.signal)).toEqual(cancel ? { cancel: true } : undefined);
    expect(s.enabled(1)).toBe(false);
    expect(s.taskFailures(1)).toMatchObject([{ count: 3 }]);
    if (!cancel) expect(h.notices.at(-1)).toContain("native delegation");
  } finally { vi.restoreAllMocks(); await h.dispose(); }
});

test("32f: compatible Dreamer waiters share one execution; cancelling a wait leaves its owner alive", async () => {
  const { h, s } = await seeded();
  let release!: () => void;
  const held = new Promise<void>(resolve => { release = resolve; });
  try {
    h.provider(async () => { await held; return { ...reply(""), stopReason: "error", errorMessage: "shared failure" }; });
    const owner = compact(h);
    await vi.waitFor(() => expect(h.requests).toHaveLength(1));
    const controller = new AbortController();
    const cancelled = compact(h, controller.signal), waiter = compact(h);
    await vi.waitFor(() => expect(h.notices.filter(n => n.includes("waiting for the running Dreamer"))).toHaveLength(2));
    controller.abort();
    expect(await cancelled).toEqual({ cancel: true });
    expect(s.getClaim(1, "dreaming")).not.toBeNull();
    release();
    expect(await owner).toBeUndefined(); expect(await waiter).toBeUndefined();
    expect(workers(h)).toMatchObject([{ kind: "dreaming", outcome: "failure" }]);
    expect(s.taskFailures(1)).toMatchObject([{ count: 1 }]);
  } finally { release(); await h.dispose(); }
});

test("32f: cancelling owned Dreamer after an edit preserves it without certification or native fallback", async () => {
  const { h, item, s } = await seeded();
  const controller = new AbortController();
  try {
    let requests = 0;
    h.provider(async () => {
      if (++requests === 1) return call("archive", "memory", { operations: [{ op: "archive", id: `K${item.knowledgeId}@${item.commit}`, supports: [], reason: "Retire deliberately" }], skipped: [] });
      setTimeout(() => controller.abort(), 0);
      return new Promise<Reply>(() => {});
    }, { autoStop: false });
    expect(await compact(h, controller.signal)).toEqual({ cancel: true });
    expect(workers(h)).toMatchObject([{ kind: "dreaming", outcome: "cancelled" }]);
    expect(s.listKnowledgeRevisions().at(-1)!.op).toBe("archive");
    expect(s.isKnowledgeProcessed(s.listKnowledgeRevisions().at(-1)!.id)).toBe(false);
    expect(s.taskFailures(1).every(f => f.count === 0)).toBe(true);
    expect(h.notices.some(n => n.includes("compaction used"))).toBe(false);
  } finally { await h.dispose(); }
});

test.each(["knowledge", "project", "cancel"] as const)("32f: final coherent recheck rejects a changed %s after the earlier fit", async change => {
  const { h, s, item } = await seeded(5000, 10000);
  try {
    const controller = new AbortController();
    let changed = false;
    const notify = h.ctx.ui.notify.bind(h.ctx.ui);
    vi.spyOn(h.ctx.ui, "notify").mockImplementation((message, level) => {
      notify(message, level);
      if (changed || !message.includes("compaction used bounded")) return;
      changed = true;
      if (change === "cancel") controller.abort();
      else if (change === "project") s.declareProject(1, "changed-project", "mark");
      else {
        const updated = s.commitConsolidationRun({ run: { kind: "manual", sessionId: 1, createdAt: "external" }, operations: [{ op: "update", knowledgeId: item.knowledgeId, baseCommit: item.commit, text: "external ".repeat(12000), category: "constraint", scope: "project", supports: [1], topics: [], reason: "external change after fit", createdAt: "external" }] });
        expect(updated.ok).toBe(true);
      }
    });
    expect(await compact(h, controller.signal)).toEqual(change === "cancel" ? { cancel: true } : undefined);
    expect(changed).toBe(true); expect(h.requests).toHaveLength(0);
    if (change !== "cancel") expect(h.notices.at(-1)).toContain("native delegation");
  } finally { vi.restoreAllMocks(); await h.dispose(); }
});

test("32f: 50 tool rounds and one repair consume only one Dreamer recovery allowance", async () => {
  const { h, s, item } = await seeded();
  try {
    let requests = 0;
    h.provider(async () => {
      if (++requests === 1) {
        const outside = s.commitConsolidationRun({ run: { kind: "manual", sessionId: 1, createdAt: "seed" }, operations: [{ op: "create", handle: "$2", author: "test", text: "outside ".repeat(4500), category: "constraint", scope: "project", supports: [1], topics: [], reason: "outside the frozen family", createdAt: "seed" }] });
        if (!outside.ok) throw Error(outside.problems.join());
        const run = s.recordRun({ kind: "dreaming", sessionId: 1, outcome: "success", createdAt: "seed" });
        s.completeDreaming(run.id, [outside.committed[0]!.commit], [outside.committed[0]!.commit]);
        return reply("First pass complete"); // host must check, and send exactly one repair
      }
      return call(`read-${requests}`, "trace", { address: `K${item.knowledgeId}` });
    }, { autoStop: false });
    expect(await compact(h)).toBeUndefined();
    expect(requests).toBe(51);
    expect(workers(h)).toHaveLength(1);
    const run = workers(h)[0]!, audit = JSON.parse(run.response!);
    expect(run.outcome).toBe("failure"); expect(audit.rounds).toBe(50); expect(audit.repaired).toBe(true);
    expect(s.taskFailures(1)).toMatchObject([{ count: 1 }]);
  } finally { await h.dispose(); }
});
