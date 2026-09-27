import { expect, test, vi } from "vitest";
import { host, reply } from "./test-host.ts";
import { legacyFact } from "../../support/seed.ts";

async function seeded(sharedAllowance = 50) {
  const h = host({ "noting.triggerTokens": 1e9,
    "compaction.factsTokens": 10000, "compaction.rawTokens": 10000 });
  h.memory.setKnowledgeBudget("global", 0);
  h.memory.setKnowledgeBudget("project", 0);
  h.memory.setKnowledgeBudget("session", 0);
  // Restore real persisted history without an automatic admission, rather than hiding seed requests.
  h.persist({ role: "user", content: "Keep this rule", timestamp: 1 });
  h.persist(reply("Recorded."));
  await h.emit("session_start");
  expect(h.requests).toEqual([]);
  const s = h.memory.store;
  const path = s.knowledgePath(1, "main", 1);
  const user = s.sourcePath(1, "main", 1).find(value => s.getSourceEntry(value.id)?.role === "user")!;
  const evidence = legacyFact(s, path, [{ entry: s.getSourceEntry(user.id)!, address: `T1#E${user.entryOrdinal}` }], "Keep this rule", "decision");
  const c = s.commitConsolidationRun({ run: { kind: "manual", sessionId: 1, createdAt: "seed" }, operations: [{ op: "create", handle: "$1", author: "test", text: "rule ".repeat(6000), category: "constraint", scope: "project", supports: [evidence.id], topics: [], reason: "evidence", createdAt: "seed" }] });
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
test.each(["budget", "new knowledge"] as const)("64c: publication reprices %s without requiring optional knowledge", async change => {
  const { h, s } = await seeded(change === "new knowledge" ? 10_000 : 50);
  try {
    let changed = false;
    const notify = h.ctx.ui.notify.bind(h.ctx.ui);
    vi.spyOn(h.ctx.ui, "notify").mockImplementation((message, level) => {
      notify(message, level);
      if (changed || !/compaction (used|preparing)/.test(message)) return;
      changed = true;
      if (change === "budget") {
        h.memory.setKnowledgeBudget("project", 7_000);
      } else {
        // New same-pool versions arrive during preparation. Each manually written item stays below
        // the 1,000-token limit, while their aggregate exceeds the shared delivery allowance.
        const create = s.commitConsolidationRun({ run: { kind: "manual", sessionId: 1, createdAt: "external" },
          operations: Array.from({ length: 40 }, (_, index) => ({ op: "create" as const, handle: `$external${index}`,
            author: "consolidation", text: `external-${index} `.repeat(300), category: "constraint" as const,
            scope: "project" as const, supports: [1], topics: [], reason: "external concurrent create", createdAt: "external" })) });
        expect(create.ok, JSON.stringify(create)).toBe(true);
      }
    });
    const result = await before(h);
    expect(changed).toBe(true);
    expect(!!result?.compaction).toBe(true); // pending knowledge never makes the custom material incomplete
    if (change === "budget") expect(result.compaction.summary).toContain("rule ".repeat(6_000));
    else {
      expect(result.compaction.summary).toContain("external-39 ".repeat(10)); // newer optional Knowledge is kept
      expect(result.compaction.summary).toMatch(/omitted \d+ constraint knowledge; expand: K\d+/);
      expect(result.compaction.summary).toContain("more up to K1"); // omission range includes K2
      expect(result.compaction.summary).not.toContain("[K2@2]");
      expect(result.compaction.summary).not.toContain("external-0 ".repeat(300));
    }
    expect(s.listRuns(1).filter(run => run.kind === "dreaming")).toEqual([]);
    expect(h.requests).toHaveLength(0);
    expect.soft(h.notices.some(n => n.includes("compaction used"))).toBe(false);
    expect.soft(await status(h)).not.toContain("Compaction:");
    const entry = await saved(h, result);
    expect(!!(entry.details as any)?.traceMemory).toBe(true);
    const expected = "bounded entry views";
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
      else if (change === "project") {
        const otherProject = s.createProject({ name: "other-project", declaredBy: "mark" });
        s.mergeProject(s.getSession(1)!.projectId, otherProject.id);
      }
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
