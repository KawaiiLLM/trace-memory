import { expect, test, vi } from "vitest";
import { host, reply, notingFact, type Reply } from "./test-host.ts";
import { Store } from "../../../src/core/store/index.ts";
import { fact, knowledge, scoreAll } from "../../support/seed.ts";

// Ticket 20c — compaction at the host boundary. Core decides between the custom replacement and the
// native delegation over its own frozen snapshot (core/api/read.test.ts); this file pins what the Pi
// adapter does with it.

const long = (word: string) => `${word} ` + "word ".repeat(200);
const quiet = { "noting.triggerTokens": 1_000_000_000 };
const eager = { "noting.triggerTokens": 30 };
const lastRun = (h: ReturnType<typeof host>) => h.memory.store.listRuns(1).at(-1)!;
const response = (h: ReturnType<typeof host>) => JSON.parse(lastRun(h).response!);
/** A Noter that always fails leaves its entries pending, which is the state compact escalates over
 * and the state the post-compaction admission rule is about. */
const failing = (h: ReturnType<typeof host>) => h.provider(async () => ({ ...reply(""), stopReason: "error" as const, errorMessage: "leave pending" }));
const work = async (h: ReturnType<typeof host>, text: string) => { await h.prompt("next main turn"); await h.answer(text); await h.drain(); };

test("20c scenario 10, as 30 left it: the host hands Pi the bounded summary under one Raw title and names it in its own diagnostics", async () => {
  const h = host(quiet);
  try {
    // 25c/30: pending Raw is held up to `render.episodicBlockTokens` (20,000) and one entry view is
    // worth at most `render.entryTokens` (2,000), so three such prompts are three cut views.
    for (const head of ["HEAD", "SECOND", "THIRD"]) {
      await h.prompt(`${head} ` + "word ".repeat(12_000) + " TAIL");
      await h.answer();
    }
    const block = await h.emit("session_before_compact", { preparation: { tokensBefore: 100_000 } });
    // One view, one title: the tier-2 block title went with the tier (30), and every prompt is present.
    expect(block.compaction.summary).toContain("\nRaw:\n");
    expect(block.compaction.summary).not.toContain("tier-2 entry views");
    for (const head of ["HEAD", "SECOND", "THIRD"]) expect(block.compaction.summary).toContain(head);
    expect(block.compaction.summary).toMatch(/\[\.\.\. \d+ characters truncated\]/);
    expect(block.compaction.summary).not.toContain("[entry ["); // no native identity in the model-facing text
    expect(block.compaction.firstKeptEntryId).toBe("");
    expect(h.notices.at(-1)).toContain("compaction preparing bounded entry views");
    const entry = h.compaction(block.compaction.summary);
    await h.emit("session_compact", { compactionEntry: entry, fromExtension: true });
    await h.commands.get("trace").handler("", h.ctx);
    expect(h.notices.at(-1)).toContain("Compaction: bounded entry views");
    expect(h.requests).toEqual([]); // the plugin's own rendering calls no model
  } finally { await h.dispose(); }
});

test("133 R1: pending Raw overflow delegates without a delivery or an extra Noter; the next Noter observes the native boundary", async () => {
  const h = host({ ...eager, "noting.batchTokens": 300, "dreaming.triggerKnowledge": 1,
    "compaction.factsTokens": 50, "compaction.rawTokens": 600, "compaction.temporaryTokens": 1 });
  try {
    h.memory.setKnowledgeBase(0);
    failing(h);
    for (let i = 0; i < 20; i++) { await h.prompt(`tiny ${i} ` + "word ".repeat(250)); await h.answer(); await h.drain(); }
    await h.commands.get("trace").handler("on", h.ctx); await h.drain();
    const runsBefore = h.memory.store.listRuns(1).length;
    const pendingBefore = h.memory.pendingEntries(1, "main", 1).map(e => e.id);
    expect(pendingBefore.length).toBeGreaterThan(0);
    const deliveries = vi.spyOn(Store.prototype, "recordKnowledgeDelivery");
    expect(await h.emit("session_before_compact", { preparation: { tokensBefore: 100_000 } })).toBeUndefined();
    expect(deliveries).not.toHaveBeenCalled();
    const entry = h.compaction("native summary");
    expect(entry).not.toHaveProperty("details.traceMemory");
    await h.emit("session_compact", { compactionEntry: entry });
    expect(h.notices.some(n => n.includes("compaction omitted"))).toBe(false);
    expect(h.memory.store.listRuns(1)).toHaveLength(runsBefore);
    expect(h.memory.pendingEntries(1, "main", 1).map(e => e.id)).toEqual(pendingBefore);
    await work(h, long("more"));
    expect(lastRun(h).mode).toBe("subagent");
  } finally { vi.restoreAllMocks(); await h.dispose(); }
});

test("133 R1: pending Raw overflow goes native even when its omission receipt cannot fit", async () => {
  const h = host({ ...quiet, "compaction.factsTokens": 1, "compaction.rawTokens": 1,
    "compaction.temporaryTokens": 1 });
  try {
    h.memory.setKnowledgeBase(0);
    await h.prompt(long("PENDING")); await h.answer();
    const pending = h.memory.pendingEntries(1, "main", 1).map(e => e.id);
    expect(pending.length).toBeGreaterThan(0);
    const deliveries = vi.spyOn(Store.prototype, "recordKnowledgeDelivery");
    expect(await h.emit("session_before_compact", { preparation: { tokensBefore: 100_000 } })).toBeUndefined();
    expect(deliveries).not.toHaveBeenCalled();
    await h.emit("session_compact", { compactionEntry: h.compaction("native summary") });
    expect(h.notices.some(n => n.includes("compaction omitted"))).toBe(false);
    expect(h.memory.pendingEntries(1, "main", 1).map(e => e.id)).toEqual(pending);
    expect(h.requests).toEqual([]);
  } finally { vi.restoreAllMocks(); await h.dispose(); }
});

test.each(["compaction preparing", "compaction Knowledge was not recorded"])(
  "133 R1: pending Raw arriving during %s is checked again before publication", async notification => {
    const h = host({ ...quiet, "compaction.rawTokens": 300, "compaction.temporaryTokens": 1 });
    let imported: Promise<unknown> | undefined;
    try {
      await h.prompt("small pending entry"); await h.answer();
      const deliveries = vi.spyOn(Store.prototype, "recordKnowledgeDelivery");
      if (notification.includes("Knowledge")) deliveries.mockImplementationOnce(() => { throw new Error("injected delivery failure"); });
      const notify = h.ctx.ui.notify.bind(h.ctx.ui);
      h.ctx.ui.notify = ((message, level) => {
        notify(message, level);
        if (!message.includes(notification)) return;
        // The next completed native assistant message arrives while the host notification runs.
        // Its real import boundary extends the current Turn; no source/progress rows are fabricated.
        h.persist(reply(`NEW_PENDING ${"word ".repeat(12_000)}`));
        imported = h.emit("agent_end");
      }) as typeof h.ctx.ui.notify;
      expect(await h.emit("session_before_compact", { preparation: { tokensBefore: 100_000 } })).toBeUndefined();
      await imported;
      expect(deliveries).toHaveBeenCalledTimes(notification.includes("Knowledge") ? 1 : 0);
      const entry = h.compaction("native summary");
      expect(entry).not.toHaveProperty("details.traceMemory");
      await h.emit("session_compact", { compactionEntry: entry });
      expect(h.notices.some(message => message.includes("compaction omitted"))).toBe(false);
      expect(h.memory.store.listRuns(1)).toEqual([]);
      expect(h.memory.pendingEntries(1, "main", 1).some(source => h.memory.store.getSourceEntry(source.id)!.text.includes("NEW_PENDING"))).toBe(true);
    } finally { vi.restoreAllMocks(); await h.dispose(); }
  },
);

test("133 R1: cancelling a pending-Raw overflow does not start native compaction", async () => {
  const h = host({ ...quiet, "compaction.rawTokens": 1, "compaction.temporaryTokens": 1 });
  try {
    await h.prompt(long("PENDING")); await h.answer();
    const controller = new AbortController();
    const notify = h.ctx.ui.notify.bind(h.ctx.ui);
    h.ctx.ui.notify = ((message, level) => {
      notify(message, level);
      if (message.includes("compaction preparing")) controller.abort();
    }) as typeof h.ctx.ui.notify;
    expect(await h.emit("session_before_compact", { preparation: { tokensBefore: 100_000 }, signal: controller.signal })).toEqual({ cancel: true });
    expect(h.entries.some(entry => entry.type === "compaction")).toBe(false);
    expect(h.requests).toEqual([]);
    expect(h.notices.some(message => message.includes("compaction omitted"))).toBe(false);
  } finally { await h.dispose(); }
});

test("133: a live task alone does not turn genuinely empty Pi memory into a custom delivery", async () => {
  const h = host(quiet);
  const key = Symbol.for("@gotgenes/pi-subagents:service");
  const registry = globalThis as Record<symbol, unknown>, previous = registry[key];
  registry[key] = { listAgents: () => [{ id: "running", type: "Explore", description: "Still working", status: "running" }] };
  try {
    await h.emit("session_start"); // no reply, source, fact or knowledge has been created
    const deliveries = vi.spyOn(Store.prototype, "recordKnowledgeDelivery");
    expect(await h.emit("session_before_compact", { preparation: { tokensBefore: 100_000 } })).toBeUndefined();
    expect(deliveries).not.toHaveBeenCalled();
    expect(h.notices.some(n => n.includes("compaction omitted"))).toBe(false);
    expect(h.memory.store.listSessions()).toEqual([]);
  } finally {
    if (previous === undefined) delete registry[key]; else registry[key] = previous;
    vi.restoreAllMocks(); await h.dispose();
  }
});

test("133 R1: an under-budget replacement survives a failed Knowledge delivery without claiming its body", async () => {
  const h = host(quiet);
  try {
    await h.prompt("establish session"); await h.answer();
    const path = h.memory.store.knowledgePath(1, "main", 1);
    const source = h.memory.store.getSourceEntry(h.memory.store.sourcePath(1, "main", 1)[0]!.id)!;
    const support = fact(h.memory, path, "Session established", [{ entry: source, text: "establish session" }]);
    const created = knowledge(h.memory.store, path, "project", "constraint", [support.id], "KNOWLEDGE_BEFORE_FAILED_DELIVERY");
    const pending = h.memory.pendingEntries(1, "main", 1).map(e => e.id);
    expect(pending.length).toBeGreaterThan(0);
    const deliveries = vi.spyOn(Store.prototype, "recordKnowledgeDelivery").mockImplementationOnce(() => { throw new Error("injected delivery failure"); });
    const result = await h.emit("session_before_compact", { preparation: { tokensBefore: 100_000 } });
    expect(deliveries).toHaveBeenCalledTimes(1);
    expect(deliveries.mock.calls[0]![1][0]!.knowledgeCommitIds).toContain(created.commit);
    expect(result.compaction.summary).toContain("establish session");
    expect(result.compaction.summary).not.toContain("KNOWLEDGE_BEFORE_FAILED_DELIVERY");
    expect(result.compaction.details.traceMemory.supplied.knowledgeCommitIds).toEqual([]);
    expect(result.compaction.details.traceMemory.prompt).toBeUndefined();
    await h.emit("session_compact", { compactionEntry: h.compaction(result.compaction.summary) });
    expect(h.notices.some(n => n.includes("compaction omitted"))).toBe(false);
    expect(h.memory.pendingEntries(1, "main", 1).map(e => e.id)).toEqual(pending);
    const next = await h.prompt("after compaction");
    expect(next.message.content).toContain("KNOWLEDGE_BEFORE_FAILED_DELIVERY");
    expect(deliveries).toHaveBeenCalledTimes(2);
  } finally { vi.restoreAllMocks(); await h.dispose(); }
});

test("133 R1: native fallback leaves Knowledge recovery at the next ordinary prompt", async () => {
  const h = host({ ...quiet, "compaction.rawTokens": 1, "compaction.temporaryTokens": 1 });
  try {
    await h.prompt("establish support"); await h.answer();
    const path = h.memory.store.knowledgePath(1, "main", 1);
    const source = h.memory.store.sourcePath(1, "main", 1).map(entry => h.memory.store.getSourceEntry(entry.id)!).find(entry => entry.role === "user")!;
    const support = fact(h.memory, path, "Support", [{ entry: source, text: "establish support" }]);
    const created = knowledge(h.memory.store, path, "project", "constraint", [support.id], "RECOVER_AFTER_NATIVE");
    scoreAll(h.memory.store); // the Knowledge base carries scored items; the temporary allowance here is 1
    expect((await h.prompt("deliver before compaction")).message.content).toContain("RECOVER_AFTER_NATIVE");
    await h.answer();
    const runs = h.memory.store.listRuns(1).length;
    expect(await h.emit("session_before_compact", { preparation: { tokensBefore: 100_000 } })).toBeUndefined();
    const entry = h.compaction("native summary");
    expect(entry).not.toHaveProperty("details.traceMemory");
    await h.emit("session_compact", { compactionEntry: entry });
    expect(h.memory.store.listRuns(1)).toHaveLength(runs);
    expect(h.notices.some(notice => notice.includes("compaction omitted"))).toBe(false);
    const recovered = (await h.prompt("after native compaction")).message;
    expect(recovered.content).toContain("RECOVER_AFTER_NATIVE");
    expect(recovered.details.traceMemory.supplied.knowledgeCommitIds).toEqual([created.commit]);
    await h.answer();
    expect((await h.prompt("already recovered"))?.message).toBeUndefined();
  } finally { await h.dispose(); }
});

test.each([
  "<task-notification", "<system-reminder", "<command-", "Caveat", "[Request interrupted",
  "Another Claude session", "<local-command", "<skill", "This session is being continued",
])("133: Pi compaction excludes synthetic earlier user words beginning with %s", async prefix => {
  const h = host({ "noting.triggerTokens": 1, "compaction.rawTokens": 1 });
  try {
    await h.prompt(`${prefix} EXCLUDED_HISTORICAL_WORDS`); await h.answer(); await h.drain();
    await h.prompt("HUMAN_HISTORICAL_WORDS"); await h.answer(); await h.drain();
    await h.commands.get("trace")!.handler("catchup", h.ctx); await h.drain();
    expect(h.memory.store.listRuns(1).filter(run => run.kind === "noting").every(run => run.outcome === "success")).toBe(true);
    const head = h.memory.store.listTurns(1).at(-1)!.id;
    expect(h.memory.pendingEntries(1, "main", head)).toEqual([]);
    const result = await h.emit("session_before_compact", { preparation: { tokensBefore: 100_000 } });
    expect(result.compaction.summary).toContain("Earlier user messages:");
    expect(result.compaction.summary).toContain("HUMAN_HISTORICAL_WORDS");
    expect(result.compaction.summary).not.toContain("EXCLUDED_HISTORICAL_WORDS");
  } finally { await h.dispose(); }
});

test("20c 2026-09-08 scenario 12: compact neither waits for nor launches a Noter, a concurrent commit survives it, and no summary re-enters the source queue", async () => {
  const h = host({ ...eager });
  try {
    // Only the first request of a batch is held open; the batch's other requests answer at once.
    const releases: ((value: Reply) => void)[] = [];
    let holding = true;
    h.provider(async conversation => { if (!holding) return notingFact(conversation); holding = false; return new Promise<Reply>(resolve => releases.push(resolve)); });
    await h.prompt(long("HEAD")); await h.answer(); await h.emit("agent_settled"); await h.drain();
    expect(h.requests).toHaveLength(1); // one Noter in flight, its reply held open
    const block = await h.emit("session_before_compact", { preparation: { tokensBefore: 1_000 } });
    expect(h.requests).toHaveLength(1); // compact started nothing and waited for nothing
    expect(block.compaction.summary).toContain("HEAD");
    // The held Noter now commits. A business commit that wins concurrently survives the snapshot,
    // which may therefore contain Raw that is recorded just afterwards; that duplication is harmless.
    await vi.waitFor(() => expect(releases).toHaveLength(1), { timeout: 5000 });
    releases[0]!(notingFact(h.conversations[0]!));
    await h.drain();
    holding = true; // the next batch is the one held below
    await vi.waitFor(() => expect(h.memory.store.listSessionFacts(1)).toHaveLength(1), { timeout: 5000 });
    expect(lastRun(h).outcome).toBe("success");
    // Progress came from the Noter and only from it: exactly the entries it froze are now recorded.
    const noted = new Set((JSON.parse(lastRun(h).response!).entryAudit.entries as { id: number }[]).map(e => e.id));
    expect(noted.size).toBeGreaterThan(0);
    expect(h.memory.pendingEntries(1, "main", 1).some(e => noted.has(e.id))).toBe(false);
    // A newly persisted main entry is an entry-end opportunity, even when first observed by compact.
    // Import it explicitly here so the compaction itself still observes an unchanged leaf.
    h.persist(reply(long("DUE")));
    await h.emit("agent_end"); await h.drain();
    const requests = h.requests.length;
    await h.emit("session_before_compact", { preparation: { tokensBefore: 1_000 } });
    await h.drain();
    expect(h.requests).toHaveLength(requests);
    expect(h.memory.store.listRuns(1).filter(r => r.kind === "noting")).toHaveLength(4); // first batch only
    // The summary is the plugin's own message: it becomes no source entry, no fact and no receipt.
    const sources = h.memory.store.listSourceEntries(1).length;
    await h.emit("session_compact", { compactionEntry: h.compaction(block.compaction.summary), fromExtension: true });
    expect(h.memory.store.listSourceEntries(1)).toHaveLength(sources);
    const compactionTurn = h.memory.store.listTurns(1).at(-1)!;
    expect(compactionTurn.kind).toBe("compaction");
    expect(h.memory.store.listSourceEntries(1).some(e => e.turnId === compactionTurn.id)).toBe(false);
    expect(h.memory.pendingEntries(1, "main", compactionTurn.id).some(e => e.turnId === compactionTurn.id)).toBe(false);
  } finally { await h.dispose(); }
});
