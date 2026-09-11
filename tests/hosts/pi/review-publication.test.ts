import { expect, test, vi } from "vitest";
import { host } from "./test-host.ts";

async function seeded(overflow = 50) {
  const h = host({ "noting.triggerTokens": 1e9, "consolidation.triggerTokens": 1e9,
    "dreaming.triggerTokens": 10000, "render.knowledgeBlockTokens": 100,
    "compaction.factsTokens": 10000, "compaction.rawTokens": 10000, "compaction.overflowTokens": overflow });
  await h.turn();
  const s = h.memory.store;
  const f = s.commitNotingRun({ run: { kind: "manual", sessionId: 1, createdAt: "seed" }, facts: [{ turnId: 1, source: ["T1#user"], actor: "user", category: "decision", text: "Keep this rule", createdAt: "seed" }] });
  if (!f.ok) throw Error(f.problems.join());
  const c = s.commitConsolidationRun({ run: { kind: "manual", sessionId: 1, createdAt: "seed" }, operations: [{ op: "create", handle: "$1", author: "test", text: "rule ".repeat(6000), category: "constraint", scope: "project", supports: [f.facts[0]!.id], topics: [], reason: "evidence", createdAt: "seed" }] });
  if (!c.ok) throw Error(c.problems.join());
  return { h, s, item: c.committed[0]! };
}
const before = (h: ReturnType<typeof host>, signal?: AbortSignal) =>
  h.emit("session_before_compact", { preparation: { tokensBefore: 100000 }, signal }) as Promise<any>;
// Explicit persistence then success event: before_compact alone never means Pi saved anything.
async function saved(h: ReturnType<typeof host>, result: any, summary = result?.compaction?.summary ?? "native summary", eventEntry?: any) {
  const entry = h.compaction(summary, { details: result?.compaction?.details ?? { readFiles: [], modifiedFiles: [] } });
  await h.emit("session_compact", { compactionEntry: eventEntry ?? entry, fromExtension: !!result?.compaction, reason: "manual", willRetry: false });
  return entry;
}
const status = async (h: ReturnType<typeof host>) => { await h.commands.get("trace").handler("", h.ctx); return h.notices.at(-1)!; };

test.each(["native→custom", "custom→native"] as const)("32f review: %s reports only the actual saved result", async direction => {
  const { h, s, item } = await seeded(direction === "custom→native" ? 10000 : 50);
  try {
    let changed = false;
    const notify = h.ctx.ui.notify.bind(h.ctx.ui);
    vi.spyOn(h.ctx.ui, "notify").mockImplementation((message, level) => {
      notify(message, level);
      if (changed || !/compaction (used|preparing)/.test(message)) return;
      changed = true;
      if (direction === "native→custom") {
        const run = s.recordRun({ kind: "dreaming", sessionId: 1, outcome: "success", createdAt: "external" });
        s.completeDreaming(run.id, [item.commit], [item.commit]);
      } else {
        const update = s.commitConsolidationRun({ run: { kind: "manual", sessionId: 1, createdAt: "external" }, operations: [{ op: "update", knowledgeId: item.knowledgeId, baseCommit: item.commit, text: "external ".repeat(12000), category: "constraint", scope: "project", supports: [1], topics: [], reason: "external", createdAt: "external" }] });
        expect(update.ok).toBe(true);
      }
    });
    const result = await before(h);
    expect(changed).toBe(true);
    expect(!!result?.compaction).toBe(direction === "native→custom");
    expect(h.requests).toHaveLength(0);
    expect.soft(h.notices.some(n => n.includes("compaction used"))).toBe(false);
    expect.soft(await status(h)).not.toContain("Compaction:");
    const entry = await saved(h, result);
    expect(!!(entry.details as any)?.traceMemory).toBe(direction === "native→custom");
    const expected = direction === "native→custom" ? "bounded entry views" : "native delegation";
    expect(h.notices.at(-1)).toContain(`compaction used ${expected}`);
    expect(await status(h)).toContain(`Compaction: ${expected}`);
  } finally { vi.restoreAllMocks(); await h.dispose(); }
});

test.each(["cancel", "project", "head"] as const)("32f review: preparing callback %s is checked before return", async change => {
  const { h, s } = await seeded(10000);
  try {
    const controller = new AbortController();
    let changed = false;
    const notify = h.ctx.ui.notify.bind(h.ctx.ui);
    vi.spyOn(h.ctx.ui, "notify").mockImplementation((message, level) => {
      notify(message, level);
      if (changed || !/compaction (used|preparing)/.test(message)) return;
      changed = true;
      if (change === "cancel") controller.abort();
      else if (change === "project") s.declareProject(1, "other-project", "mark");
      else {
        h.entries.length = h.entries.findIndex(e => e.customType === "trace-memory");
        void h.emit("session_tree", {}); // restore is synchronous, before the callback returns
      }
    });
    const result = await before(h, controller.signal);
    expect(changed).toBe(true);
    expect(result).toEqual(change === "cancel" ? { cancel: true } : undefined);
    expect(h.notices.some(n => n.includes("compaction used"))).toBe(false);
    if (change === "cancel") {
      await h.emit("session_compact_failed", { aborted: true, reason: "manual", willRetry: false, fromExtension: false });
      expect(await status(h)).not.toContain("Compaction:");
    }
  } finally { vi.restoreAllMocks(); await h.dispose(); }
});

test.each([true, false])("32f review: failure/abort (%s) preserves last successful compaction", async aborted => {
  const { h } = await seeded(10000);
  try {
    await saved(h, await before(h));
    const previous = (await status(h)).split("\n").find(n => n.startsWith("Compaction:"));
    h.notices.length = 0;
    await before(h);
    await h.emit("session_compact_failed", { aborted, errorMessage: aborted ? undefined : "native provider failed", reason: "manual", willRetry: false, fromExtension: false });
    expect(h.notices.some(n => n.includes("compaction used"))).toBe(false);
    expect(h.notices.at(-1)).toContain(aborted ? "cancelled" : "native provider failed");
    expect((await status(h)).split("\n").find(n => n.startsWith("Compaction:"))).toBe(previous);
  } finally { await h.dispose(); }
});

test("32f review: duplicate summary event cannot select an older custom carrier", async () => {
  const { h } = await seeded(10000);
  try {
    const custom = await before(h);
    const old = await saved(h, custom);
    // Pi 0.85.1 incorrectly finds the first equal-summary entry for the event; actual append wins.
    const actual = await saved(h, undefined, old.summary, old);
    expect(actual.id).not.toBe(old.id);
    expect(h.notices.at(-1)).toContain("compaction used native delegation");
    expect(await status(h)).toContain("Compaction: native delegation");
  } finally { await h.dispose(); }
});
